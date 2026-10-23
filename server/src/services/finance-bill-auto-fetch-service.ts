/**
 * 财务账单后台自动拉取服务（FinanceBillAutoFetchService）——"系统后台自动获取财务数据"。
 *
 * 定位：把财务入账从「用户手动粘贴账单」升级为「每日定时用用户登录态自动拉取」。
 * 数据通道与既有五条入账入口并列（见 finance-ingest-service.ts 头注释），不替代它们：
 *   - 支付宝：Playwright 带用户 Cookie 查交易明细 JSON 接口（本服务的生产 fetcher）
 *   - 微信支付：无网页版钱包，服务端无法代查——实时入账走既有的微信桥「微信支付」
 *     服务通知通道（wechat-payment-notice.ts，零 LLM）；拉历史账单仍需用户在
 *     微信内导出发送，属产品边界，如实告知而非假装支持。
 *
 * 幂等：拉到的交易沿用 finance-bill-file-parser 的确定性 id 方案
 * （`alipay:<交易号>`），与账本已有 id 比对去重后仅入新增——同一天重复跑、
 * 或 Cookie 过期重试，都不会重复记账。
 *
 * 调度（2026-09-18 起双模式）：
 *   - 准实时模式（FINANCE_BILL_AUTO_FETCH_INTERVAL_MIN>0，默认关）：每 N 分钟
 *     （下限 10，防支付宝风控）拉一次增量，幂等去重保证重复拉不重复记账；
 *   - 每日定点模式（默认）：到 FINANCE_BILL_AUTO_FETCH_HOUR（默认 21 点）且当日
 *     未同步过 → 执行。
 * 每次状态落盘 data/finance-bill-auto-fetch/state.json（原子写），重启不重复拉。
 * 注意：真正秒~分钟级的"实时"主力是交易提醒邮件通道（邮件盯梢 → 财务 LLM 抽取，
 * 见装配层接线）——浏览器轮询受风控约束做不到秒级，如实分工而不是硬凑。
 *
 * 诚实失败约定：Cookie 未导入 / 未授权 agentAllowed / 登录态失效 / 接口改版
 * 解析不出数据，都如实返回错误并记录在 status()，绝不编造"已同步"。
 */
import { getDataDir } from "../config/data-dir.js";
import { join } from "node:path";

import { readJson, writeJson } from "../proactivity/persist-file.js";
import type { BillTransaction } from "./finance-bill-file-parser.js";

/** 一次拉取的产出（生产 fetcher 来自支付宝交易明细接口）。 */
export type BillFetchOutcome =
  | { ok: true; transactions: BillTransaction[]; note?: string }
  | { ok: false; error: string; retryable?: boolean };

/** 账单拉取器：注入点（测试用假实现，生产为 Playwright 支付宝 fetcher）。 */
export type BillFetcher = (actorId: string, days: number) => Promise<BillFetchOutcome>;

/** Cookie 会话库最小面（BrowserSessionService 满足；测试可注入桩）。 */
export type BillSessionStore = {
  getCookiesForAgent(
    actorId: string,
    siteId: "alipay",
  ): Promise<Array<{ name: string; value: string; domain?: string }>>;
};

/** 财务账本最小面（FinanceDeepService 满足）。 */
export type BillLedger = {
  importTransactions(actorId: string, items: BillTransaction[]): Promise<number>;
  getTransactions(
    actorId: string,
    from?: string,
    to?: string,
    category?: undefined,
    limit?: number,
  ): Array<{ id: string; date: string; amount: number; type: "income" | "expense" }>;
};

export interface FinanceBillAutoFetchConfig {
  enabled: boolean;
  /**
   * 轮询间隔（分钟）。> 0 时进入准实时模式（每 N 分钟拉一次增量，下限 10——
   * 更高频率对支付宝登录态的风控不友好）；= 0 时退回每日定点模式（hour 字段）。
   */
  intervalMin: number;
  /** 每日执行时刻（0-23 小时；仅 intervalMin=0 的定点模式使用）。 */
  hour: number;
  /** 拉取窗口天数：覆盖跨天边界与失败补拉，默认 3。 */
  days: number;
  /** 目标 actor 列表（私人管家单主人场景，通常一个）。 */
  actors: string[];
}

export interface FinanceBillAutoFetchDeps {
  browserSessions: BillSessionStore;
  financeDeepService: BillLedger;
  /** 可注入拉取器；缺省用 Playwright 支付宝 fetcher。 */
  fetcher?: BillFetcher;
  /** 同步完成回调（装配层接 ProactivityHub：有新增时轻提醒）。 */
  onSynced?: (
    actorId: string,
    summary: { added: number; duplicates: number; skippedRows: number; note?: string },
  ) => void;
  logger?: (level: "info" | "warn" | "error", message: string) => void;
  env?: NodeJS.ProcessEnv;
  /** 每日状态落盘路径（默认 data/finance-bill-auto-fetch/state.json，相对 cwd）。 */
  persistPath?: string;
}

interface FetchStateFile {
  version: 1;
  /** actorId → { dateKey: "YYYY-MM-DD", lastResult } */
  actors: Record<
    string,
    {
      lastRunDateKey: string;
      lastRunAt: string;
      lastOk: boolean;
      lastError?: string;
      lastAdded?: number;
    }
  >;
}

function dateKeyOf(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function readFinanceBillAutoFetchConfig(
  env: NodeJS.ProcessEnv = process.env,
): FinanceBillAutoFetchConfig {
  const actorsRaw = env.FINANCE_BILL_AUTO_FETCH_ACTORS?.trim() ?? "";
  const actors = actorsRaw
    ? actorsRaw.split(",").map((s) => s.trim()).filter(Boolean)
    : [env.MESSAGE_BRIDGE_DEFAULT_ACTOR_ID?.trim() || "default_user"];
  const intervalRaw = Number(env.FINANCE_BILL_AUTO_FETCH_INTERVAL_MIN ?? 0);
  // 准实时下限 10 分钟：个人支付宝登录态被高频无头浏览器访问容易触发风控，
  // 得不偿失——更实时的场景应走交易提醒邮件通道（秒~分钟级，见装配层邮件接线）
  const intervalMin = intervalRaw > 0 ? Math.max(10, Math.min(1440, Math.floor(intervalRaw))) : 0;
  return {
    enabled: env.FINANCE_BILL_AUTO_FETCH_ENABLED === "1",
    intervalMin,
    hour: Math.max(0, Math.min(23, Number(env.FINANCE_BILL_AUTO_FETCH_HOUR ?? 21) || 21)),
    days: Math.max(1, Math.min(31, Number(env.FINANCE_BILL_AUTO_FETCH_DAYS ?? 3) || 3)),
    actors,
  };
}

export class FinanceBillAutoFetchService {
  private readonly cfg: FinanceBillAutoFetchConfig;
  private readonly statePath: string;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly deps: FinanceBillAutoFetchDeps) {
    this.cfg = readFinanceBillAutoFetchConfig(deps.env ?? process.env);
    this.statePath =
      deps.persistPath ?? join(getDataDir(), "finance-bill-auto-fetch", "state.json");
  }

  /** 启动调度（每分钟 tick 检查到点）。未启用时 no-op（status 可查原因）。 */
  start(): void {
    if (this.timer || !this.cfg.enabled) return;
    this.timer = setInterval(() => {
      void this.runDue(new Date());
    }, 60_000);
    this.timer.unref?.();
    const modeLabel =
      this.cfg.intervalMin > 0
        ? `准实时轮询（每 ${this.cfg.intervalMin} 分钟）`
        : `每日定点（${this.cfg.hour} 点）`;
    this.deps.logger?.("info", `财务账单自动拉取已启动：${modeLabel}，actors=${this.cfg.actors.join(",")}`);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * 到点检查（每分钟 tick 调用）：
   *   - 准实时模式（intervalMin>0）：距上次运行 ≥ 间隔分钟即拉增量；
   *   - 定点模式（intervalMin=0）：命中 hour 且当日未跑过才执行。
   * 返回本次实际执行的 actor 数。
   */
  async runDue(now = new Date()): Promise<number> {
    if (!this.cfg.enabled || this.running) return 0;
    const state = this.loadState();
    const due = this.cfg.actors.filter((actorId) => {
      const row = state.actors[actorId];
      if (this.cfg.intervalMin > 0) {
        // 间隔模式：从未跑过 → 立即拉基线；跑过 → 距上次 ≥ 间隔才拉
        if (!row?.lastRunAt) return true;
        return now.getTime() - Date.parse(row.lastRunAt) >= this.cfg.intervalMin * 60_000;
      }
      // 定点模式：命中小时 且 当日未跑过
      if (now.getHours() !== this.cfg.hour) return false;
      const today = dateKeyOf(now);
      return row?.lastRunDateKey !== today;
    });
    if (due.length === 0) return 0;
    this.running = true;
    try {
      for (const actorId of due) {
        try {
          await this.runNow(actorId, now);
        } catch (e) {
          this.deps.logger?.("error", `账单自动拉取异常（${actorId}）：${e instanceof Error ? e.message : String(e)}`);
        }
      }
      return due.length;
    } finally {
      this.running = false;
    }
  }

  /**
   * 立即拉取一个 actor 的账单（调度到点调用；也供 finance.bills.sync_now 手动触发）。
   * 无论成败都更新当日状态（避免失败后同一分钟内反复重试打死上游）。
   * @param now 运行时间戳（调度器传模拟时钟，手动调用缺省真实时间——间隔语义据此记账）
   */
  async runNow(actorId: string, now = new Date()): Promise<
    | { ok: true; added: number; duplicates: number; note?: string }
    | { ok: false; error: string }
  > {
    const startedAt = now;
    // Cookie 门禁：未导入 / 未授权时如实失败（与购物域同一套双门禁语义）
    try {
      await this.deps.browserSessions.getCookiesForAgent(actorId, "alipay");
    } catch (e) {
      const error = `支付宝 Cookie 不可用：${e instanceof Error ? e.message : String(e)}`;
      this.recordRun(actorId, startedAt, false, error);
      return { ok: false, error };
    }

    const fetcher = this.deps.fetcher ?? createPlaywrightAlipayBillFetcher(this.deps.browserSessions);
    const outcome = await fetcher(actorId, this.cfg.days);
    if (!outcome.ok) {
      this.recordRun(actorId, startedAt, false, outcome.error);
      return { ok: false, error: outcome.error };
    }

    // 幂等去重（双保险）：
    //   a) id 级：确定性交易号（alipay:<tradeNo>）直接命中 → 跳过；
    //   b) 签名级：同一笔交易已被通知通道（钱迹模式）按「日+金额+方向」记过 → 跳过。
    // 没有签名级检查时，通知通道入账过的交易会被 Cookie 轮询用不同 id 再记一次（双计）。
    const windowFrom = new Date(startedAt.getTime() - (this.cfg.days + 1) * 86_400_000);
    const windowTo = new Date(startedAt.getTime() + 86_400_000);
    const existing = this.deps.financeDeepService.getTransactions(
      actorId,
      windowFrom.toISOString(),
      windowTo.toISOString(),
      undefined,
      10_000,
    );
    const existingIds = new Set(existing.map((t) => t.id));
    const existingSignatures = new Set(
      existing.map((t) => `${String(t.date).slice(0, 10)}|${t.amount}|${t.type}`),
    );
    const fresh = outcome.transactions.filter((t) => {
      if (existingIds.has(t.id)) return false;
      const signature = `${String(t.date).slice(0, 10)}|${t.amount}|${t.type}`;
      return !existingSignatures.has(signature);
    });
    const duplicates = outcome.transactions.length - fresh.length;

    const added = fresh.length > 0 ? await this.deps.financeDeepService.importTransactions(actorId, fresh) : 0;
    this.recordRun(actorId, startedAt, true, undefined, added);
    const summary = {
      added,
      duplicates,
      skippedRows: 0,
      note: outcome.note,
    };
    this.deps.onSynced?.(actorId, summary);
    return { ok: true, added, duplicates, note: outcome.note };
  }

  status(): {
    enabled: boolean;
    mode: "interval" | "daily";
    intervalMin: number;
    hour: number;
    days: number;
    actors: Array<{ actorId: string; lastRunAt?: string; lastOk?: boolean; lastError?: string; lastAdded?: number }>;
  } {
    const state = this.loadState();
    return {
      enabled: this.cfg.enabled,
      mode: this.cfg.intervalMin > 0 ? "interval" : "daily",
      intervalMin: this.cfg.intervalMin,
      hour: this.cfg.hour,
      days: this.cfg.days,
      actors: this.cfg.actors.map((actorId) => {
        const row = state.actors[actorId];
        return {
          actorId,
          lastRunAt: row?.lastRunAt,
          lastOk: row?.lastOk,
          lastError: row?.lastError,
          lastAdded: row?.lastAdded,
        };
      }),
    };
  }

  private recordRun(
    actorId: string,
    at: Date,
    ok: boolean,
    error?: string,
    added?: number,
  ): void {
    const state = this.loadState();
    state.actors[actorId] = {
      lastRunDateKey: dateKeyOf(at),
      lastRunAt: at.toISOString(),
      lastOk: ok,
      ...(error ? { lastError: error } : {}),
      ...(added != null ? { lastAdded: added } : {}),
    };
    writeJson(this.statePath, state);
  }

  private loadState(): FetchStateFile {
    const raw = readJson<Partial<FetchStateFile>>(this.statePath, {});
    return { version: 1, actors: raw.actors ?? {} };
  }
}

// ────────────────────────────────────────────────────────────────────────
// 支付宝生产 fetcher：Playwright 带用户 Cookie 查交易明细
// ────────────────────────────────────────────────────────────────────────

/** 支付宝网页交易明细页（登录态下可见；未登录会被重定向到 login）。 */
const ALIPAY_RECORD_URL = "https://consumeprod.alipay.com/record/standard.html";
/** 交易明细查询 JSON 接口（明细页自身调用的数据源，页面内 fetch 自带登录态与 Referer）。 */
const ALIPAY_TRADE_QUERY_URL = "https://mbillexprod.alipay.com/enterprise/simpleTradeOrderQuery.json";

/** 明细行 → BillTransaction（沿用 parser 的幂等键方案 alipay:<tradeNo>）。 */
function alipayRowToTransaction(row: Record<string, unknown>): BillTransaction | null {
  const tradeNo = String(row.tradeNo ?? row.outTradeNo ?? "").trim();
  if (!tradeNo) return null;
  // 交易时间：接口返回毫秒时间戳（tradeTime）或 "YYYY-MM-DD HH:mm:ss"（tradeTimeStr）
  const ts = Number(row.tradeTime);
  const date = Number.isFinite(ts) && ts > 0
    ? new Date(ts).toISOString().replace("T", " ").slice(0, 19)
    : String(row.tradeTimeStr ?? row.gmtCreate ?? "").trim();
  if (!date) return null;
  const amountRaw = String(row.amount ?? "").replace(/[¥￥,]/g, "");
  const amount = Number(amountRaw);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const direction = String(row.direction ?? row.inOutType ?? "").toLowerCase();
  // 保守入账：只有明确的收支方向才入；中性资金流动（如余额互转）跳过，与 parser 同约定
  if (direction !== "income" && direction !== "expense") return null;
  const merchant =
    String(row.counterparty ?? row.counterParty ?? row.merchantName ?? "").trim() || undefined;
  const description = String(row.goodsTitle ?? row.memo ?? "").trim() || undefined;
  // 分类统一落「其他」：账单明细行无分类信息，后续分类由 normalizeCategory 按商户/描述归并
  // （与 parser 及邮件/通知入账通道的约定一致，不在此猜分类）
  return {
    id: `alipay:${tradeNo}`,
    date,
    amount,
    type: direction === "income" ? "income" : "expense",
    category: "其他",
    ...(merchant ? { merchant } : {}),
    ...(description ? { description } : {}),
    source: "alipay",
  };
}

/**
 * 生产 fetcher：无头浏览器注入用户支付宝 Cookie → 打开明细页确认登录态 →
 * 页面内 fetch 调交易明细 JSON 接口 → 行数据确定性转换为交易。
 *
 * 诚实边界（不假装能拿到拿不到的东西）：
 *   - Cookie 失效（重定向登录页）→ 明确报"Cookie 已过期，请重新导入"
 *   - 接口改版/字段变动导致 0 行 → 报错并建议改走邮箱转发通道，不静默当成功
 */
export function createPlaywrightAlipayBillFetcher(browserSessions: BillSessionStore): BillFetcher {
  return async (actorId, days) => {
    let pw: typeof import("playwright");
    try {
      pw = await import("playwright");
    } catch {
      return {
        ok: false,
        error: "Playwright 未安装。请在 server 目录执行: npx playwright install chromium",
        retryable: false,
      };
    }
    const cookies = await browserSessions.getCookiesForAgent(actorId, "alipay");
    if (cookies.length === 0) {
      return { ok: false, error: "支付宝 Cookie 为空，请先导入", retryable: false };
    }

    const browser = await pw.chromium.launch({
      headless: true,
      args: ["--disable-blink-features=AutomationControlled"],
    });
    try {
      const context = await browser.newContext({
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
        locale: "zh-CN",
      });
      await context.addCookies(
        cookies
          .filter((c) => c.name && c.value)
          .map((c) => ({
            name: c.name,
            value: c.value,
            domain: c.domain || ".alipay.com",
            path: "/",
          })),
      );
      const page = await context.newPage();
      await page.goto(ALIPAY_RECORD_URL, { waitUntil: "domcontentloaded", timeout: 20_000 });
      if (/login/i.test(page.url())) {
        return { ok: false, error: "支付宝 Cookie 已过期（被重定向到登录页），请重新导入 Cookie", retryable: false };
      }

      // 页面内 fetch：自动携带 Cookie/Referer/CSRS token 环境与页面一致
      const rows = (await page.evaluate(
        async ({ queryUrl, days }) => {
          const fmt = (d: Date) =>
            `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} 00:00:00`;
          const end = new Date();
          const start = new Date(end.getTime() - days * 86_400_000);
          const body = new URLSearchParams({
            queryStartTime: fmt(start),
            queryEndTime: fmt(end),
            billType: "millennium",
            contentType: "json",
            pageNum: "1",
            pageSize: "200",
            sortTarget: "tradeTime",
            sortType: "0",
          });
          const res = await fetch(queryUrl, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: body.toString(),
            credentials: "include",
          });
          const data = (await res.json()) as {
            result?: { detailList?: unknown[]; hasNextPage?: boolean };
          };
          return data.result?.detailList ?? [];
        },
        { queryUrl: ALIPAY_TRADE_QUERY_URL, days },
      )) as Array<Record<string, unknown>>;

      if (!Array.isArray(rows) || rows.length === 0) {
        return {
          ok: false,
          error:
            "支付宝交易明细接口返回 0 条（可能接口字段已改版，或该时段确无交易）。" +
            "若近期有消费仍报此错，请反馈以校准接口参数；也可改用邮箱自动转发账单通道",
          retryable: true,
        };
      }
      const transactions = rows
        .map(alipayRowToTransaction)
        .filter((t): t is BillTransaction => t !== null);
      return {
        ok: true,
        transactions,
        note: `支付宝明细 ${transactions.length}/${rows.length} 条可入账（其余为中性资金流动或字段不全，已跳过）`,
      };
    } catch (e) {
      return { ok: false, error: `支付宝账单拉取失败：${e instanceof Error ? e.message : String(e)}`, retryable: true };
    } finally {
      await browser.close().catch(() => {});
    }
  };
}
