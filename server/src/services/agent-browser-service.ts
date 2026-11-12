/**
 * Agent 通用网页操作服务（有状态会话池）。
 *
 * 执行层已上收到通用浏览器层：客户端在线时**优先在用户可见的内置浏览器**
 * （WebView2 over CDP）里操作（登录态即用户本人、全程可见可接管），不可用时
 * 回退服务端无头 Chromium + 已授权 Cookie。会话（sessionId → Page）绑定 actorId，
 * 支持 open / click / type / scroll / screenshot / extract_text / wait_for / close。
 *
 * 人工接管对齐主流 Browser Agent：只在 human-required（登录墙 / 验证码）时停一次，
 * 页面留在可见浏览器里，用户回执后由 Plan 续跑；普通失败/空结果不交人。
 *
 * 观察回路对齐主流「行动+观察合一 / 错误+状态一起回喂」（browser-use 同款）：
 * open/click/type/wait_for 的回执统一附带当前页面的紧凑可交互元素表
 * （pageState.interactive）——成功时模型直接从中选 ref 继续下一步（省一轮
 * extract_text）；失败时错误与新状态一起回喂，一步完成自纠正（换 ref 而不是盲试）。
 *
 * 安全护栏（不依赖 agentAccessMode，沙箱下也可用）：
 *   1. 任意 https URL 允许 open（http 仅限 localhost），所有操作走审计日志
 *   2. 对 browser-session-sites 白名单内站点，自动注入用户已授权的 Cookie（无头路径）
 *   3. 会话绑定 actorId，跨用户隔离；sessionId 不可预测（randomUUID）
 *   4. 会话 TTL（默认 10 分钟）+ LRU 上限（默认 8 个），超时/超量自动清理
 *   5. Playwright 动态加载，未安装时优雅降级并返回明确错误
 */
import { randomUUID } from "crypto";

import type { Browser, BrowserContext, Page } from "playwright";

import { resolveActorId } from "../agent/actor-id.js";
import type { AuditService } from "./audit-service.js";
import type { BrowserSessionService } from "./browser-session-service.js";
import { BROWSER_SESSION_SITES, resolveSiteIdFromUrl, type BrowserSessionSiteId } from "./browser-session-sites.js";
import {
  BrowserRuntime,
  loadPlaywright,
  toPlaywrightCookies,
  type BrowserPageLease,
} from "./browser-runtime/browser-runtime.js";
import {
  detectHumanRequired,
  type HumanRequiredDetection,
  type HumanRequirementReason,
} from "./browser-runtime/human-gate.js";
import type { QrAssistService } from "./qr-assist-service.js";
import type { ToolContext } from "../tools/tool-registry.js";

// ─── 环境变量 ──────────────────────────────────────────────────────────────

/** 会话空闲 TTL（毫秒），默认 10 分钟。 */
function getSessionTtlMs(): number {
  const v = Number.parseInt(process.env.AGENT_BROWSER_SESSION_TTL_MS ?? "600000", 10);
  return Number.isFinite(v) && v > 0 ? v : 600_000;
}

/** 最大并发会话数，默认 8。 */
function getMaxSessions(): number {
  const v = Number.parseInt(process.env.AGENT_BROWSER_MAX_SESSIONS ?? "8", 10);
  return Number.isFinite(v) && v > 0 ? v : 8;
}

/** 页面导航超时（毫秒），默认 30 秒。 */
function getNavTimeoutMs(): number {
  const v = Number.parseInt(process.env.AGENT_BROWSER_NAV_TIMEOUT_MS ?? "30000", 10);
  return Number.isFinite(v) && v > 0 ? v : 30_000;
}

/** 单次操作（click/type 等）超时（毫秒），默认 15 秒。 */
function getActionTimeoutMs(): number {
  const v = Number.parseInt(process.env.AGENT_BROWSER_ACTION_TIMEOUT_MS ?? "15000", 10);
  return Number.isFinite(v) && v > 0 ? v : 15_000;
}

// ─── 常量 ──────────────────────────────────────────────────────────────────

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const DEFAULT_VIEWPORT = { width: 1280, height: 720 } as const;

/** extract_text 返回的文本截断上限（字符）。 */
const TEXT_BUDGET = 4000;

/** extract_text 附带的 ariaSnapshot 紧凑元素行数上限（每行 ~10 token）。 */
const INTERACTIVE_BUDGET = 300;

/**
 * open/click/type/wait_for 回执附带的页面快照行数上限。
 * 主流 Browser Agent（browser-use 等）的「行动+观察合一」：动作回执直接带新页面
 * 的可交互元素表，模型一步完成观察与下一步决策，省一整轮 LLM 往返。
 * 动作回执比 extract_text 紧（120 行 ≈ 1.2k token）。
 */
const ACTION_SNAPSHOT_BUDGET = 120;

/** 动作后页面状态捕获总超时（毫秒）——best-effort，绝不拖慢动作回执。 */
const ACTION_STATE_CAPTURE_MS = 2500;

/** screenshot base64 截断上限（字符），避免 tool loop token 膨胀。 */
const SCREENSHOT_BASE64_BUDGET = 2000;

// ─── 类型 ──────────────────────────────────────────────────────────────────

/** 服务返回的通用结构。 */
export type AgentBrowserResult =
  | ({ ok: true } & Record<string, unknown>)
  | { ok: false; error: string; retryable?: boolean };

/** 存活的浏览器会话。 */
interface AgentBrowserSession {
  sessionId: string;
  actorId: string;
  /** 无头路径的浏览器/上下文；shared 路径为空（页面来自内置浏览器租约）。 */
  browser?: Browser;
  context?: BrowserContext;
  page: Page;
  /** shared 路径的面板租约（close 时释放；页面留痕不关闭）。 */
  lease?: BrowserPageLease;
  mode: "shared" | "headless";
  /** 命中的站点（登录页启发式 / 交接文案用）。 */
  siteId?: string;
  siteLabel?: string;
  /** 本会话已就哪个理由弹过交接（同一会话不重复打扰）。 */
  humanNotified?: HumanRequirementReason;
  /** 已推送到聊天的交接图（登录二维码/验证页截图），同一理由不重复推。 */
  humanCardPushed?: HumanRequirementReason;
  /** 模型显式 handoff 的去重（同一条指引不重复推卡）。 */
  lastHandoffInstruction?: string;
  /** 正在等用户本人处理（登录/验证）：TTL 清理跳过，避免用户还没登录会话就过期。 */
  awaitingHuman?: boolean;
  currentUrl: string;
  createdAt: number;
  lastActivityAt: number;
  closed: boolean;
}
// ─── URL 安全校验 ──────────────────────────────────────────────────────────

/**
 * 校验 URL 是否允许打开。
 * - https 任意 URL 允许
 * - http 仅允许 localhost / 127.0.0.1 / 0.0.0.0（本地开发场景）
 */
function isUrlAllowed(rawUrl: string): { ok: boolean; error?: string } {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, error: `URL 格式无效: ${rawUrl}` };
  }
  if (parsed.protocol === "https:") return { ok: true };
  if (parsed.protocol === "http:") {
    const host = parsed.hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === "::1") {
      return { ok: true };
    }
    return { ok: false, error: "http URL 仅允许 localhost；外部站点须使用 https" };
  }
  return { ok: false, error: `不支持的协议: ${parsed.protocol}（仅 http/https）` };
}

/** human-required 时给模型的固定指引（避免模型把登录/验证写成普通失败）。 */
function humanHandoffHint(reason: HumanRequirementReason, mode: "shared" | "headless"): string {
  if (mode === "shared") {
    return reason === "login"
      ? "该站点需要你本人登录：页面已在内置浏览器打开，登录后点「我已完成」我继续。"
      : "该站点需要你本人完成安全验证（滑块/验证码）：页面已停在内置浏览器里，验证后点「我已完成」我继续。";
  }
  return reason === "login"
    ? "该站点需要你本人登录：登录二维码图片卡已实时推送到用户聊天流（手机/电脑端都会直接显示），用户扫码完成后回复我继续。不要在回复正文里贴图片链接或 URL——卡片已经送达，正文只需口头提示扫码。"
    : "该站点需要完成安全验证：验证页截图卡已实时推送到用户聊天流，完成后回复我继续。不要在回复正文里贴图片链接或 URL。";
}

// ─── 服务主体 ──────────────────────────────────────────────────────────────

/**
 * Agent 虚拟浏览器服务。
 *
 * 维持有状态会话池，每个会话绑定一个 actorId，跨用户隔离。
 * 会话 TTL + LRU 上限自动清理，避免资源泄漏。
 */
export class AgentBrowserService {
  private readonly sessions = new Map<string, AgentBrowserSession>();
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly deps: {
      browserSessionService: BrowserSessionService;
      audit?: AuditService;
      /** 通用二维码推送：撞登录页时自动推二维码到聊天（best-effort）。 */
      qrAssist?: QrAssistService;
      /** 通用浏览器层：内置浏览器优先 / 无头兜底（缺省时仅走无头）。 */
      runtime?: BrowserRuntime;
      /** human-required（登录墙/验证码）→ 长流程交接（装配层接通用 handoff）。 */
      onHumanRequired?: (info: {
        actorId: string;
        /** 聊天/任务会话 id（task-plan key 用，不是浏览器 sessionId） */
        sessionId: string;
        siteLabels: string[];
        reason: HumanRequirementReason;
      }) => void;
    },
  ) {
    this.cleanupTimer = setInterval(() => this.cleanupExpired(), 60_000);
    this.cleanupTimer.unref?.();
  }

  /** 主动销毁：关闭所有存活会话。 */
  async dispose(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    for (const session of this.sessions.values()) {
      await this.closeSession(session).catch(() => {});
    }
    this.sessions.clear();
  }

  // ─── 8 个原子操作 ────────────────────────────────────────────────────────

  /** 打开 URL，返回 sessionId。内置浏览器在线时优先在用户可见面板里打开。 */
  async open(
    ctx: ToolContext,
    url: string,
    opts?: {
      viewport?: { width: number; height: number };
      waitUntil?: "load" | "domcontentloaded" | "networkidle";
      timeout?: number;
    },
  ): Promise<AgentBrowserResult> {
    const actorId = resolveActorId(ctx);
    const trimmedUrl = String(url ?? "").trim();
    if (!trimmedUrl) return { ok: false, error: "缺少 url" };

    const urlCheck = isUrlAllowed(trimmedUrl);
    if (!urlCheck.ok) return { ok: false, error: urlCheck.error! };

    const siteId = resolveSiteIdFromUrl(trimmedUrl);
    const siteLabel = siteId
      ? (BROWSER_SESSION_SITES[siteId as BrowserSessionSiteId]?.label ?? siteId)
      : (() => {
          try {
            return new URL(trimmedUrl).hostname;
          } catch {
            return "该站点";
          }
        })();

    // 1) 通用层：内置浏览器优先（登录态即用户本人，全程可见可接管）
    let lease: BrowserPageLease | null = null;
    if (this.deps.runtime?.canUseSharedBrowser(actorId)) {
      lease = await this.deps.runtime
        .tryOpenSharedPage(actorId, trimmedUrl, { waitSlotMs: 15_000 })
        .catch(() => null);
    }

    let browser: Browser | undefined;
    let context: BrowserContext | undefined;
    let page: Page | undefined;
    let cookieInjected = false;

    if (lease) {
      page = lease.page;
      page.setDefaultTimeout(getActionTimeoutMs());
    } else {
      // 2) 无头兜底：Playwright + 已授权 Cookie
      const pw = await loadPlaywright();
      if (!pw) {
        return {
          ok: false,
          error: "Playwright 未安装。请在 server 目录执行: npm install playwright && npx playwright install chromium",
          retryable: false,
        };
      }
      const { chromium } = pw;
      browser = await chromium.launch({
        headless: true,
        args: ["--disable-blink-features=AutomationControlled"],
      });
      try {
        const viewport = opts?.viewport ?? DEFAULT_VIEWPORT;
        context = await browser.newContext({
          userAgent: USER_AGENT,
          locale: "zh-CN",
          viewport: { width: viewport.width, height: viewport.height },
        });

        // 对白名单站点，尝试注入用户已授权的 Cookie
        if (siteId) {
          try {
            const cookies = await this.deps.browserSessionService.getCookiesForAgent(actorId, siteId);
            if (cookies && cookies.length > 0) {
              await context.addCookies(toPlaywrightCookies(trimmedUrl, cookies));
              cookieInjected = true;
            }
          } catch {
            // 未授权 / 未导入 Cookie —— 以未登录状态访问，不报错
          }
        }

        page = await context.newPage();
        page.setDefaultTimeout(getActionTimeoutMs());
        const timeout = opts?.timeout ?? getNavTimeoutMs();
        const waitUntil = opts?.waitUntil ?? "domcontentloaded";

        await page.goto(trimmedUrl, { waitUntil, timeout });
      } catch (e) {
        await browser.close().catch(() => {});
        const message = e instanceof Error ? e.message : String(e);
        return {
          ok: false,
          error: message.includes("Executable doesn't exist")
            ? `${message} — 请执行: npx playwright install chromium`
            : message,
          retryable: true,
        };
      }
    }

    if (!page) return { ok: false, error: "页面打开失败", retryable: true };

    const sessionId = randomUUID();
    const now = Date.now();
    const session: AgentBrowserSession = {
      sessionId,
      actorId,
      browser,
      context,
      page,
      ...(lease ? { lease } : {}),
      mode: lease ? "shared" : "headless",
      ...(siteId ? { siteId } : {}),
      siteLabel,
      currentUrl: page.url(),
      createdAt: now,
      lastActivityAt: now,
      closed: false,
    };

    // LRU 上限保护：超量时关闭最老会话
    this.enforceMaxSessions();

    this.sessions.set(sessionId, session);

    // 新标签页跟随（仅无头路径有 context；内置浏览器走同一面板页，不新开 target）
    context?.on("page", (popup) => {
      popup.setDefaultTimeout(getActionTimeoutMs());
      session.page = popup;
      session.currentUrl = popup.url();
    });

    const title = await page.title().catch(() => "");

    // 通用 handoff：命中登录墙/验证码时把登录二维码或验证页截图推给手机端聊天。
    // 两种执行模式都推；可见浏览器再额外进一次 handoff 等待（无头模式没有面板，
    // 用户处理完后回复继续即可）。
    const human: HumanRequiredDetection = await detectHumanRequired(siteId ?? "", page).catch(
      () => ({ required: false }),
    );
    let loginQrImageUrl: string | undefined;
    if (human.required && human.reason) {
      const pushed = await this.pushHumanCard(ctx, session, human.reason);
      if (human.reason === "login") loginQrImageUrl = pushed;
    }
    const humanRequired =
      human.required && human.reason && session.mode === "shared"
        ? this.notifyHuman(ctx, session, human.reason, human.evidence)
        : undefined;

    await this.audit(ctx, "open", sessionId, {
      url: trimmedUrl,
      siteId: siteId ?? undefined,
      browserMode: session.mode,
      cookieInjected,
      title,
      loginQrPushed: Boolean(loginQrImageUrl),
      humanRequired: humanRequired?.reason,
    });

    // 打开即观察（主流同款）：open 回执直接带可交互元素表，模型首步不用再 extract_text
    const pageState = await this.capturePageState(session);

    return {
      ok: true,
      sessionId,
      url: page.url(),
      title,
      browserMode: session.mode,
      cookieInjected,
      siteId: siteId ?? undefined,
      ...(pageState ? { pageState } : {}),
      // 不把图片相对路径直接给模型：模型曾把相对路径拼上页面源站编成错站
      // 绝对 URL 写进正文（正文贴图 404）。卡片本就经 chat.media_ready 实时
      // 送达客户端（按各端 httpBase 解析），模型只需知道「已推送」这个事实。
      loginQrPushed: Boolean(loginQrImageUrl),
      ...(humanRequired ? { humanRequired } : {}),
      hint: humanRequired
        ? humanHandoffHint(humanRequired.reason, session.mode)
        : human.required && human.reason
          ? humanHandoffHint(human.reason, session.mode)
          : loginQrImageUrl
            ? "该站点需要登录，登录二维码图片卡已实时推送到用户聊天流；不要在正文贴图片链接，口头提示扫码即可，用户扫码后重新执行操作。"
            : cookieInjected
              ? undefined
              : siteId
                ? `检测到 ${siteId} 站点但用户未导入/授权 Cookie，以未登录状态访问。如需登录态操作，引导用户在设置中导入 Cookie 并开启 agentAllowed。`
                : undefined,
    };
  }

  /** 点击元素。 */
  async click(
    ctx: ToolContext,
    sessionId: string,
    selector: string,
    opts?: { timeout?: number; button?: "left" | "right"; doubleClick?: boolean },
  ): Promise<AgentBrowserResult> {
    const session = this.getSessionForActor(ctx, sessionId);
    if (!session) return { ok: false, error: "会话不存在或已过期" };

    const sel = String(selector ?? "").trim();
    if (!sel) return { ok: false, error: "缺少 selector" };

    try {
      const timeout = opts?.timeout ?? getActionTimeoutMs();
      await session.page.click(sel, {
        timeout,
        button: opts?.button ?? "left",
        clickCount: opts?.doubleClick ? 2 : 1,
      });
      this.touch(session);
      await this.audit(ctx, "click", sessionId, { selector: sel, url: session.currentUrl });
      // 点击常触发跳转：先等导航稳定再取快照（best-effort，不拖垮回执）
      await this.waitForNavSettled(session);
      // 动作后检查页面是否落到登录墙/验证码（主流 Agent 的动作后 checkpoint）
      const human = await this.checkHumanAfterAction(ctx, session);
      const base: AgentBrowserResult = {
        ok: true,
        url: session.page.url(),
        selector: sel,
        ...(human ? { humanRequired: human, hint: humanHandoffHint(human.reason, session.mode) } : {}),
      };
      return await this.withPageState(base, session);
    } catch (e) {
      // 自纠正回路：错误 + 当前页面最新元素表一起回喂（browser-use 同款）
      const base: AgentBrowserResult = { ok: false, error: this.formatPlaywrightError(e), retryable: true };
      return await this.withPageState(base, session);
    }
  }

  /** 在输入框中输入文本。 */
  async type(
    ctx: ToolContext,
    sessionId: string,
    selector: string,
    text: string,
    opts?: { append?: boolean; delay?: number; clear?: boolean },
  ): Promise<AgentBrowserResult> {
    const session = this.getSessionForActor(ctx, sessionId);
    if (!session) return { ok: false, error: "会话不存在或已过期" };

    const sel = String(selector ?? "").trim();
    if (!sel) return { ok: false, error: "缺少 selector" };
    const value = String(text ?? "");
    if (value.length === 0) return { ok: false, error: "缺少 text" };

    try {
      const append = opts?.append ?? false;
      const locator = session.page.locator(sel);
      if (!append) {
        // fill 模式：替换整个输入框内容
        await locator.fill(value, { timeout: getActionTimeoutMs() });
      } else {
        // 追加模式：可选先清空，再逐字符输入
        if (opts?.clear) {
          await locator.fill("", { timeout: getActionTimeoutMs() });
        }
        await locator.pressSequentially(value, {
          delay: opts?.delay ?? 0,
          timeout: getActionTimeoutMs(),
        });
      }
      this.touch(session);
      await this.audit(ctx, "type", sessionId, {
        selector: sel,
        textLength: value.length,
        append,
      });
      await this.waitForNavSettled(session);
      const human = await this.checkHumanAfterAction(ctx, session);
      const base: AgentBrowserResult = {
        ok: true,
        selector: sel,
        textLength: value.length,
        ...(human ? { humanRequired: human, hint: humanHandoffHint(human.reason, session.mode) } : {}),
      };
      return await this.withPageState(base, session);
    } catch (e) {
      const base: AgentBrowserResult = { ok: false, error: this.formatPlaywrightError(e), retryable: true };
      return await this.withPageState(base, session);
    }
  }

  /** 滚动页面。 */
  async scroll(
    ctx: ToolContext,
    sessionId: string,
    opts?: { x?: number; y?: number; deltaY?: number; selector?: string },
  ): Promise<AgentBrowserResult> {
    const session = this.getSessionForActor(ctx, sessionId);
    if (!session) return { ok: false, error: "会话不存在或已过期" };

    try {
      if (opts?.selector) {
        // 滚动到指定元素
        await session.page.locator(opts.selector).scrollIntoViewIfNeeded({
          timeout: getActionTimeoutMs(),
        });
      } else if (typeof opts?.deltaY === "number") {
        // 相对滚动
        await session.page.mouse.wheel(0, opts.deltaY);
      } else {
        // 滚动到绝对坐标
        const x = opts?.x ?? 0;
        const y = opts?.y ?? 0;
        await session.page.evaluate(([sx, sy]) => window.scrollTo(sx, sy), [x, y] as const);
      }
      this.touch(session);
      await this.audit(ctx, "scroll", sessionId, {
        mode: opts?.selector ? "to_element" : typeof opts?.deltaY === "number" ? "delta" : "absolute",
        url: session.currentUrl,
      });
      return { ok: true, url: session.page.url() };
    } catch (e) {
      return { ok: false, error: this.formatPlaywrightError(e), retryable: true };
    }
  }

  /** 截图，返回 base64（JPEG 压缩）。 */
  async screenshot(
    ctx: ToolContext,
    sessionId: string,
    opts?: { fullPage?: boolean; selector?: string; quality?: number },
  ): Promise<AgentBrowserResult> {
    const session = this.getSessionForActor(ctx, sessionId);
    if (!session) return { ok: false, error: "会话不存在或已过期" };

    try {
      const quality = Math.min(Math.max(opts?.quality ?? 70, 20), 90);
      const buffer = opts?.selector
        ? await session.page.locator(opts.selector).screenshot({
            type: "jpeg",
            quality,
            timeout: getActionTimeoutMs(),
          })
        : await session.page.screenshot({
            type: "jpeg",
            quality,
            fullPage: opts?.fullPage ?? false,
            timeout: getActionTimeoutMs(),
          });

      this.touch(session);
      const base64 = buffer.toString("base64");
      // 截断 base64 避免工具回路 token 膨胀；完整截图可通过 vision 能力或后续文件路由获取
      const truncated = base64.length > SCREENSHOT_BASE64_BUDGET
        ? base64.slice(0, SCREENSHOT_BASE64_BUDGET) + "...[truncated]"
        : base64;

      await this.audit(ctx, "screenshot", sessionId, {
        fullPage: opts?.fullPage ?? false,
        hasSelector: Boolean(opts?.selector),
        bytes: buffer.length,
      });

      return {
        ok: true,
        imageBase64: truncated,
        truncated: base64.length > SCREENSHOT_BASE64_BUDGET,
        fullSizeBytes: buffer.length,
        format: "jpeg",
        url: session.page.url(),
        hint: base64.length > SCREENSHOT_BASE64_BUDGET
          ? "截图较大已截断，完整视觉信息建议用 extract_text 获取页面结构。"
          : undefined,
      };
    } catch (e) {
      return { ok: false, error: this.formatPlaywrightError(e), retryable: true };
    }
  }

  /**
   * 通用人工交接（Manus/Muse 式 handoff）：任务推进到「必须用户本人操作」的
   * 步骤时，把当前页面截图 + 这一步要做什么实时推到用户聊天流（手机/电脑端
   * 都会收到图片卡）。适用：扫码登录、短信验证码、支付确认、选择商品选项、
   * 授权同意等任何模型判断「该用户上了」的时刻。
   *
   * - 会话标记 awaitingHuman：TTL 清理跳过，用户慢慢操作会话不过期；
   * - 同一会话同一条指引不重复推卡（防模型循环调用刷屏）；
   * - 推送 best-effort：失败时回执 cardPushed=false，模型在正文里把要做的事说清楚。
   */
  async handoff(
    ctx: ToolContext,
    sessionId: string,
    opts: { instruction: string; title?: string },
  ): Promise<AgentBrowserResult> {
    const session = this.getSessionForActor(ctx, sessionId);
    if (!session) return { ok: false, error: "会话不存在或已过期" };

    const instruction = String(opts?.instruction ?? "").trim();
    if (!instruction) return { ok: false, error: "缺少 instruction（必须告诉用户这一步要做什么）" };

    // 去重：同一会话同一条指引不重复推（模型重试/循环时防刷屏）
    const duplicate = session.lastHandoffInstruction === instruction && session.awaitingHuman === true;
    session.lastHandoffInstruction = instruction;
    session.awaitingHuman = true;
    session.lastActivityAt = Date.now();
    // 注意不要走 touch()：它会把 awaitingHuman 重置为 false

    let cardPushed = false;
    if (!duplicate && this.deps.qrAssist) {
      const title = (opts?.title ?? "").trim() || "需要你操作";
      const imageUrl = await this.deps.qrAssist
        .pushPageCard(ctx, { title, caption: instruction }, session.page)
        .catch(() => undefined);
      cardPushed = Boolean(imageUrl);
    }

    await this.audit(ctx, "handoff", sessionId, {
      url: session.currentUrl,
      duplicate,
      cardPushed,
      instruction: instruction.slice(0, 120),
    });

    return {
      ok: true,
      url: session.page.url(),
      handedOff: true,
      duplicate,
      cardPushed,
      hint: duplicate
        ? "这条指引刚才已推送给用户，不要重复调用；等用户回复即可。"
        : cardPushed
          ? "当前页面截图和你的操作指引已实时推送到用户聊天流（手机端也会收到图片卡）。正文只需口头说明等待用户完成哪一步，不要贴图片链接；用户完成后会回复你，届时继续任务。"
          : "推送通道不可用：请在正文里清楚告诉用户需要他做什么（具体步骤），用户完成后回复你继续。",
    };
  }

  /**
   * ariaSnapshot(mode=ai) YAML → 紧凑可交互元素行（Node 侧解析，无 evaluate 闭包陷阱）。
   *
   * 输入（Playwright mode:"ai"）：
   *   - navigation [ref=e2]:
   *     - link "链接一" [ref=e3] [cursor=pointer]:
   *       - /url: /1
   *   - button "领券购买" [ref=e5]
   *
   * 输出（每行 ~10 token，供 LLM 直接阅读并把 ref 传给 click/type）：
   *   e2 navigation
   *   e3 link "链接一"
   *   e5 button "领券购买"
   *
   * 仅保留可交互角色 + heading（页面语义文本已由正文 text 覆盖）；
   * 丢弃 /url 子行与 cursor 标记；行数上限可调（动作回执用更紧的预算）。
   */
  private compactAriaSnapshot(snapshot: string, budget: number = INTERACTIVE_BUDGET): string {
    const KEEP_ROLES = new Set([
      "button", "link", "textbox", "searchbox", "checkbox", "radio", "combobox",
      "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "option", "slider",
      "switch", "img", "heading", "listbox", "treeitem", "spinbutton",
    ]);
    const DROP_MARKS = new Set(["cursor=pointer", "cursor=grab", "cursor=grabbing"]);
    const lines: string[] = [];
    for (const raw of snapshot.split("\n")) {
      // 行格式：- role "可选名称" [标记1] [标记2]:（尾冒号表示有子节点）
      const m = raw.match(/^\s*-\s+([A-Za-z][\w]*)\s*(?:"((?:[^"\\]|\\.)*)")?\s*((?:\[[^\]]+\]\s*)*):?\s*$/);
      if (!m) continue;
      const role = m[1];
      if (!KEEP_ROLES.has(role)) continue;
      const marks = (m[3] ?? "").match(/\[([^\]]+)\]/g) ?? [];
      let ref = "";
      const stateMarks: string[] = [];
      for (const mark of marks) {
        const inner = mark.slice(1, -1).trim();
        if (inner.startsWith("ref=")) ref = inner.slice(4);
        else if (!DROP_MARKS.has(inner)) stateMarks.push(inner);
      }
      const name = m[2] ? ` "${m[2]}"` : "";
      const state = stateMarks.length ? ` [${stateMarks.join("] [")}]` : "";
      lines.push(ref ? `${ref} ${role}${name}${state}` : `${role}${name}${state}`);
      if (lines.length >= budget) break;
    }
    return lines.join("\n");
  }

  /** 提取页面文本，可附带可交互元素列表。 */
  async extractText(
    ctx: ToolContext,
    sessionId: string,
    selector?: string,
    opts?: { includeInteractive?: boolean },
  ): Promise<AgentBrowserResult> {
    const session = this.getSessionForActor(ctx, sessionId);
    if (!session) return { ok: false, error: "会话不存在或已过期" };

    try {
      const includeInteractive = opts?.includeInteractive ?? true;
      const text = selector
        ? await session.page.locator(selector).innerText({ timeout: getActionTimeoutMs() })
        : await session.page.evaluate(() => document.body?.innerText ?? "");

      const trimmed = text.replace(/\s+/g, " ").trim().slice(0, TEXT_BUDGET);

      let interactive: string | undefined;
      if (includeInteractive) {
        try {
          const snapshot = await session.page.locator("body").ariaSnapshot({ mode: "ai" });
          interactive = this.compactAriaSnapshot(snapshot);
        } catch (e) {
          console.error("[agent_browser] ariaSnapshot 失败:", e instanceof Error ? e.message.slice(0, 200) : e);
          interactive = undefined;
        }
      }

      this.touch(session);
      const interactiveCount = interactive ? interactive.split("\n").length : 0;
      await this.audit(ctx, "extract_text", sessionId, {
        hasSelector: Boolean(selector),
        textLength: trimmed.length,
        interactiveCount,
      });

      return {
        ok: true,
        url: session.page.url(),
        title: await session.page.title().catch(() => ""),
        text: trimmed,
        truncated: text.length > TEXT_BUDGET,
        interactive,
        interactiveCount,
      };
    } catch (e) {
      return { ok: false, error: this.formatPlaywrightError(e), retryable: true };
    }
  }

  /** 等待元素出现。 */
  async waitFor(
    ctx: ToolContext,
    sessionId: string,
    selector: string,
    timeout?: number,
  ): Promise<AgentBrowserResult> {
    const session = this.getSessionForActor(ctx, sessionId);
    if (!session) return { ok: false, error: "会话不存在或已过期" };

    const sel = String(selector ?? "").trim();
    if (!sel) return { ok: false, error: "缺少 selector" };

    try {
      const waitTimeout = Math.min(timeout ?? getActionTimeoutMs(), 60_000);
      await session.page.waitForSelector(sel, { state: "visible", timeout: waitTimeout });
      this.touch(session);
      await this.audit(ctx, "wait_for", sessionId, { selector: sel, timeout: waitTimeout });
      const base: AgentBrowserResult = { ok: true, selector: sel, url: session.page.url() };
      return await this.withPageState(base, session);
    } catch (e) {
      // 等不到元素时把当前页面元素表一并回喂：模型能看到「实际在页面上的是什么」
      const base: AgentBrowserResult = { ok: false, error: this.formatPlaywrightError(e), retryable: true };
      return await this.withPageState(base, session);
    }
  }

  /** 关闭会话。 */
  async close(ctx: ToolContext, sessionId: string): Promise<AgentBrowserResult> {
    const session = this.getSessionForActor(ctx, sessionId);
    if (!session) return { ok: false, error: "会话不存在或已过期" };

    await this.audit(ctx, "close", sessionId, { url: session.currentUrl });
    await this.closeSession(session);
    this.sessions.delete(sessionId);
    return { ok: true, sessionId };
  }

  // ─── 内部方法 ────────────────────────────────────────────────────────────

  /**
   * 点击/输入后的导航稳定等待（best-effort）：仅真实 Playwright page 支持
   * waitForLoadState；测试桩/特殊页面没有该方法时直接跳过。
   */
  private async waitForNavSettled(session: AgentBrowserSession): Promise<void> {
    const page = session.page as Partial<Page>;
    if (typeof page.waitForLoadState !== "function") return;
    await page.waitForLoadState("domcontentloaded", { timeout: 3000 }).catch(() => {});
  }

  /**
   * 捕获当前页面状态（主流循环的「观察」）：url + title + 紧凑可交互元素表。
   * best-effort：快照失败/超时返回 undefined，绝不阻塞或拖垮动作回执
   * （无头假页、跨域 iframe、页面跳转中都会走到这条路）。
   */
  private async capturePageState(
    session: AgentBrowserSession,
  ): Promise<{ url: string; title: string; interactive?: string } | undefined> {
    let timer: NodeJS.Timeout | undefined;
    const work = (async () => {
      const page = session.page;
      const title = await page.title().catch(() => "");
      let interactive: string | undefined;
      try {
        const snapshot = await page.locator("body").ariaSnapshot({ mode: "ai" });
        interactive = this.compactAriaSnapshot(snapshot, ACTION_SNAPSHOT_BUDGET);
      } catch {
        interactive = undefined;
      }
      return { url: page.url(), title, ...(interactive ? { interactive } : {}) };
    })();
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), ACTION_STATE_CAPTURE_MS);
      timer.unref?.();
    });
    try {
      return await Promise.race([work, timeout]);
    } catch {
      return undefined;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * 「行动+观察」合一（browser-use 同款）：open/click/type/wait_for 的回执统一
   * 附当前页面状态，模型一步完成观察与下一步决策。
   * - 成功：直接从 pageState.interactive 选 ref 继续，不用再调 extract_text；
   * - 失败（retryable）：错误 + 最新元素表一起回喂，一步完成自纠正（换 ref
   *   重试而不是盲试同一个），这是主流 agent 长程任务成功率的来源。
   */
  private async withPageState(
    result: AgentBrowserResult,
    session: AgentBrowserSession,
  ): Promise<AgentBrowserResult> {
    const state = await this.capturePageState(session);
    if (!state) return result;
    const hint = result.ok
      ? "回执已附当前页面可交互元素表（pageState.interactive）：直接从中选 ref 继续下一步，不要单独再调 extract_text。"
      : "失败原因和当前页面最新元素表一起返回了：从中挑正确的 ref 重试（页面已变化，原 ref 可能失效），不要盲目重试同一个 ref。";
    return {
      ...result,
      pageState: state,
      hint: (result as { hint?: string }).hint ?? hint,
    } as AgentBrowserResult;
  }

  /**
   * 交接图片统一推送：登录二维码 / 验证页截图都推到聊天（用户可能在手机上），
   * 同一会话同一理由只推一次。无头与可见浏览器都走这里，不再分模式。
   */
  private async pushHumanCard(
    ctx: ToolContext,
    session: AgentBrowserSession,
    reason: HumanRequirementReason,
  ): Promise<string | undefined> {
    if (!this.deps.qrAssist) return undefined;
    if (session.humanCardPushed === reason) return undefined;
    const imageUrl = await this.deps.qrAssist
      .pushPageCard(
        ctx,
        reason === "login"
          ? { title: "打开网页需要登录", caption: "登录页二维码已推给你，扫码完成后回复我继续" }
          : { title: "打开网页需要安全验证", caption: "验证页截图已推给你，完成后回复我继续" },
        session.page,
      )
      .catch(() => undefined);
    if (imageUrl) session.humanCardPushed = reason;
    return imageUrl ?? undefined;
  }

  /**
   * 命中 human-required：同一会话同一理由只弹一次（不重复打扰），
   * 经装配层建一个 task-plan 等待步（页面留在可见浏览器），用户回执后续跑。
   */
  private notifyHuman(
    ctx: ToolContext,
    session: AgentBrowserSession,
    reason: HumanRequirementReason,
    evidence?: string,
  ): { reason: HumanRequirementReason; evidence?: string } | undefined {
    if (session.mode !== "shared") return undefined;
    if (session.humanNotified === reason) return undefined;
    session.humanNotified = reason;
    session.awaitingHuman = true;
    try {
      this.deps.onHumanRequired?.({
        actorId: session.actorId,
        sessionId: ctx.sessionId,
        siteLabels: [session.siteLabel ?? "该站点"],
        reason,
      });
    } catch {
      /* 交接失败只丢增强，工具回执里的 hint 照常返回 */
    }
    return { reason, ...(evidence ? { evidence } : {}) };
  }

  /** 动作后检查（主流 Browser Agent 在每个动作后过 human checkpoint）。 */
  private async checkHumanAfterAction(
    ctx: ToolContext,
    session: AgentBrowserSession,
  ): Promise<{ reason: HumanRequirementReason; evidence?: string } | undefined> {
    const human: HumanRequiredDetection = await detectHumanRequired(session.siteId ?? "", session.page).catch(
      () => ({ required: false }),
    );
    if (!human.required || !human.reason) return undefined;
    await this.pushHumanCard(ctx, session, human.reason);
    if (session.mode === "shared") {
      return this.notifyHuman(ctx, session, human.reason, human.evidence);
    }
    return { reason: human.reason, ...(human.evidence ? { evidence: human.evidence } : {}) };
  }

  /** 获取会话并校验 actorId 归属。 */
  private getSessionForActor(ctx: ToolContext, sessionId: string): AgentBrowserSession | undefined {
    const actorId = resolveActorId(ctx);
    const session = this.sessions.get(sessionId);
    if (!session || session.closed) return undefined;
    if (session.actorId !== actorId) return undefined;
    return session;
  }

  /** 更新会话最后活动时间（LRU 排序：delete + set 移到末尾）。 */
  private touch(session: AgentBrowserSession): void {
    session.lastActivityAt = Date.now();
    session.awaitingHuman = false;
    session.currentUrl = session.page.url();
    this.sessions.delete(session.sessionId);
    this.sessions.set(session.sessionId, session);
  }

  /** LRU 上限保护：超量时关闭最老会话。 */
  private enforceMaxSessions(): void {
    const max = getMaxSessions();
    while (this.sessions.size >= max) {
      // 优先淘汰不在等用户处理的会话（正等登录/验证的会话尽量保住）
      const entries = [...this.sessions.values()];
      const victim = entries.find((s) => !s.awaitingHuman) ?? entries[0];
      if (!victim) break;
      this.closeSession(victim).catch(() => {});
      this.sessions.delete(victim.sessionId);
    }
  }

  /** 清理过期会话（TTL）。 */
  private async cleanupExpired(): Promise<void> {
    const ttl = getSessionTtlMs();
    const now = Date.now();
    const expired: string[] = [];
    for (const [id, session] of this.sessions) {
      // 等用户登录/验证的会话不按空闲过期（主流 Agent 的 handback 会话保持）
      if (session.awaitingHuman) continue;
      if (now - session.lastActivityAt > ttl) {
        expired.push(id);
      }
    }
    for (const id of expired) {
      const session = this.sessions.get(id);
      if (session) {
        await this.closeSession(session).catch(() => {});
      }
      this.sessions.delete(id);
    }
  }

  /** 关闭单个会话的浏览器资源。 */
  private async closeSession(session: AgentBrowserSession): Promise<void> {
    if (session.closed) return;
    session.closed = true;
    // 内置浏览器：只释放面板队列（页面留痕不关闭，用户还能回看）
    if (session.lease) {
      await session.lease.release().catch(() => {});
    }
    try {
      await session.context?.close();
    } catch {
      /* ignore */
    }
    try {
      await session.browser?.close();
    } catch {
      /* ignore */
    }
  }

  /** 格式化 Playwright 错误信息。 */
  private formatPlaywrightError(e: unknown): string {
    const message = e instanceof Error ? e.message : String(e);
    if (message.includes("Executable doesn't exist")) {
      return `${message} — 请执行: npx playwright install chromium`;
    }
    if (message.includes("Timeout") && message.includes("exceeded")) {
      return `操作超时: ${message}`;
    }
    if (message.includes("selector resolved to") && message.includes("no matching element")) {
      return `未找到匹配元素: ${message}`;
    }
    return message;
  }

  /** 审计日志。 */
  private async audit(
    ctx: ToolContext,
    action: string,
    sessionId: string,
    extra: Record<string, unknown>,
  ): Promise<void> {
    if (!this.deps.audit) return;
    try {
      await this.deps.audit.record({
        category: "agent_browser",
        action,
        sessionId,
        actorId: resolveActorId(ctx),
        sessionId_ctx: ctx.sessionId,
        chatUserMessageId: ctx.chatUserMessageId,
        timestamp: Date.now(),
        ...extra,
      });
    } catch {
      /* 审计失败不影响主流程 */
    }
  }
}
