import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, readdir, stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import { join } from "node:path";

/**
 * 深度财务能力域 service。
 *
 * 与 wallet-tools / life-tools 区分：
 *   - wallet.* 维护「钱包余额 + 转账流水」(单条即时操作)
 *   - budget.calculate / shopping.suggest 仅做一次性粗略估算
 *   - finance.* 维护「按用户视角的完整账本 + 预算执行 + 对账 + 报告」
 *
 * 存储模型：每个 actor 一个独立目录 `data/finance/{actorId}/`，下含：
 *   - `transactions.json`  完整交易账本（导入 + 单条补录）
 *   - `budgets.json`        预算配置
 *   - `reports/`            导出报告落盘目录
 *
 * 持久化模式参考 {@link HealthFitnessService}：内存态 + 防抖落盘，
 * 启动时 `load()` 全部 actor，关停 / 1s 静默后 `flush()` 落盘。
 */

/** 支持的财务分类。 */
export type FinanceCategory =
  | "餐饮"
  | "交通"
  | "购物"
  | "娱乐"
  | "医疗"
  | "教育"
  | "居住"
  | "工资"
  | "其他";

/** 全部支持的财务分类。 */
export const FINANCE_CATEGORIES: FinanceCategory[] = [
  "餐饮", "交通", "购物", "娱乐", "医疗", "教育", "居住", "工资", "其他",
];

/** 单条交易记录。 */
export interface FinanceTransaction {
  /** 记录 ID（uuid） */
  id: string;
  /** ISO 8601 日期（YYYY-MM-DD 或完整时间戳） */
  date: string;
  /** 金额（正数） */
  amount: number;
  /** 类型：income 收入 / expense 支出 */
  type: "income" | "expense";
  /** 分类：餐饮 / 交通 / 购物 / 娱乐 / 医疗 / 教育 / 居住 / 工资 / 其他 */
  category: FinanceCategory;
  /** 商户名（可选） */
  merchant?: string;
  /** 描述（可选） */
  description?: string;
  /** 数据来源（可选）：manual / import / wallet_sync 等 */
  source?: string;
}

/** 预算配置。 */
export interface FinanceBudget {
  /** 预算 ID（uuid） */
  id: string;
  /** 分类：餐饮 / 交通 / 购物 / ...（"其他" 通常不设预算） */
  category: FinanceCategory;
  /** 预算金额 */
  amount: number;
  /** 周期：monthly / yearly */
  period: "monthly" | "yearly";
  /** 起始日期 ISO 8601 */
  startDate: string;
  /** 结束日期 ISO 8601（可选，无则永久） */
  endDate?: string;
  /** 创建时间 */
  createdAt: string;
}

/** 单个 actor 的存储结构。 */
interface FinanceStore {
  transactions: FinanceTransaction[];
  budgets: FinanceBudget[];
}

/** 消费分析结果。 */
export interface SpendingAnalysis {
  /** 起始时间 ISO 8601 */
  from: string;
  /** 结束时间 ISO 8601 */
  to: string;
  /** 总支出 */
  totalExpense: number;
  /** 总收入 */
  totalIncome: number;
  /** 净额 = income - expense */
  net: number;
  /** 交易条数 */
  count: number;
  /** 按类别聚合（仅支出） */
  byCategory: Array<{
    category: FinanceCategory;
    total: number;
    count: number;
    /** 占总支出比例 0~1 */
    ratio: number;
  }>;
  /** 按月聚合（仅支出） */
  byMonth: Array<{
    month: string; // YYYY-MM
    totalExpense: number;
    totalIncome: number;
    count: number;
  }>;
  /** Top 3 支出类别 */
  topCategories: Array<{ category: FinanceCategory; total: number; ratio: number }>;
  /** 异常：单笔金额超过近 30 日均值 N 倍（默认 3 倍） */
  anomalies: Array<{
    transaction: FinanceTransaction;
    /** 触发的倍数 */
    multiplier: number;
    /** 对比的均值 */
    average: number;
  }>;
  /** 趋势：rising / falling / stable / unknown（按月对比） */
  trend: "rising" | "falling" | "stable" | "unknown";
  /** 趋势变化率（正为升） */
  trendDelta: number;
}

/** 预算执行进度。 */
export interface BudgetStatus {
  budget: FinanceBudget;
  /** 当前周期已花费 */
  spent: number;
  /** 剩余 = amount - spent（可负） */
  remaining: number;
  /** 完成率 0~1（可能 >1 表示超支） */
  progress: number;
  /** 警告级别：ok / warning / exceeded */
  level: "ok" | "warning" | "exceeded";
  /** 当前周期标识：YYYY-MM 或 YYYY */
  periodLabel: string;
}

/** 对账差异。 */
export interface ReconcileDiff {
  /** 已记录但账单里没有（用户漏报 / 多余） */
  onlyInRecords: FinanceTransaction[];
  /** 账单里有但已记录没有（用户漏记） */
  onlyInExpected: FinanceTransaction[];
  /** 金额不匹配（同日期同商户但金额对不上） */
  amountMismatch: Array<{
    recorded: FinanceTransaction;
    expected: FinanceTransaction;
  }>;
  /** 已匹配上的（无差异） */
  matched: Array<{ recorded: FinanceTransaction; expected: FinanceTransaction }>;
  /** 汇总 */
  summary: {
    matched: number;
    onlyInRecords: number;
    onlyInExpected: number;
    amountMismatch: number;
  };
}

/** 报告导出结果。 */
export interface ExportReportResult {
  /** 落盘绝对路径 */
  filePath: string;
  /** 可访问的相对 URL（客户端拼接 base 后拉流） */
  fileUrl: string;
  /** 文件大小（字节） */
  size: number;
  /** 格式 */
  format: "markdown" | "csv" | "json";
}

/** 自动分类结果。 */
export interface CategorizeResult {
  category: FinanceCategory;
  /** 命中的关键词（调试用） */
  matched: string;
}

export class FinanceDeepService {
  /** 内存态：actorId → store */
  private readonly stores = new Map<string, FinanceStore>();
  /** 脏标记：actorId 集合 */
  private readonly dirty = new Set<string>();
  /** 防抖定时器 */
  private persistTimer: NodeJS.Timeout | null = null;

  /**
   * @param dataRoot 账本数据根目录
   * @param options.now 时间源注入（测试/回放用）；缺省读真实时钟。
   *   账本里所有「当前时间」（记账默认日期、预算周期归属、报表时间戳）都必须过这里：
   *   上层服务（如账单管理）注入了冻结时钟、本服务却偷读真实时钟时，
   *   会算出不同的归属周期，表现为「缴费已入账但预算 spent=0」这类时基不一致的失败。
   */
  constructor(
    private readonly dataRoot: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  // ─── 持久化 ──────────────────────────────────────────────────

  /**
   * 启动加载：扫描 `dataRoot` 下所有 actor 目录，
   * 加载每个 `{actorId}/transactions.json` 与 `budgets.json`。
   */
  async load(): Promise<void> {
    let actorDirs: string[];
    try {
      actorDirs = await readdir(this.dataRoot);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("ENOENT")) {
        console.error("[FinanceDeep] load readdir failed:", error);
      }
      return;
    }
    await Promise.all(
      actorDirs.map(async (actorId) => {
        const dir = join(this.dataRoot, actorId);
        let s: Stats | null = null;
        try {
          s = await stat(dir);
        } catch {
          s = null;
        }
        if (!s || !s.isDirectory()) return;
        const store = await this.loadActor(actorId);
        this.stores.set(actorId, store);
      }),
    );
  }

  /** 加载单个 actor 的 transactions.json + budgets.json。 */
  private async loadActor(actorId: string): Promise<FinanceStore> {
    const dir = join(this.dataRoot, this.safeActorId(actorId));
    let transactions: FinanceTransaction[] = [];
    let budgets: FinanceBudget[] = [];
    try {
      const txRaw = await readFile(join(dir, "transactions.json"), "utf8");
      const txParsed = JSON.parse(txRaw);
      if (Array.isArray(txParsed)) transactions = this.normalizeTransactions(txParsed);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("ENOENT")) {
        console.error(`[FinanceDeep] load transactions ${actorId} failed:`, error);
      }
    }
    try {
      const bgRaw = await readFile(join(dir, "budgets.json"), "utf8");
      const bgParsed = JSON.parse(bgRaw);
      if (Array.isArray(bgParsed)) budgets = this.normalizeBudgets(bgParsed);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("ENOENT")) {
        console.error(`[FinanceDeep] load budgets ${actorId} failed:`, error);
      }
    }
    return { transactions, budgets };
  }

  /** 全量落盘脏数据。关停 / 防抖触发时调用。 */
  async flush(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (this.dirty.size === 0) return;
    const ids = Array.from(this.dirty);
    this.dirty.clear();
    await Promise.all(
      ids.map(async (actorId) => {
        const store = this.stores.get(actorId);
        if (!store) return;
        const dir = join(this.dataRoot, this.safeActorId(actorId));
        try {
          await mkdir(dir, { recursive: true });
          await writeFile(
            join(dir, "transactions.json"),
            JSON.stringify(store.transactions, null, 2),
            "utf8",
          );
          await writeFile(
            join(dir, "budgets.json"),
            JSON.stringify(store.budgets, null, 2),
            "utf8",
          );
        } catch (error) {
          console.error(`[FinanceDeep] flush ${actorId} failed:`, error);
        }
      }),
    );
  }

  // ─── 交易导入 / 查询 ─────────────────────────────────────────

  /**
   * 批量导入交易。已分类的字段直接保留，未分类（category 为空或非法）
   * 调 {@link categorize} 自动推断；仍推断不出归「其他」。
   *
   * @returns 成功条数
   */
  async importTransactions(actorId: string, items: FinanceTransaction[]): Promise<number> {
    const store = this.getStore(actorId);
    let added = 0;
    for (const item of items) {
      if (typeof item.amount !== "number" || !Number.isFinite(item.amount)) continue;
      const tx: FinanceTransaction = {
        id: typeof item.id === "string" && item.id ? item.id : this.genId(),
        date: typeof item.date === "string" && item.date ? item.date : this.now().toISOString(),
        amount: Math.abs(item.amount),
        type: item.type === "income" ? "income" : "expense",
        category: this.normalizeCategory(item.category, item.description ?? item.merchant),
        ...(typeof item.merchant === "string" && item.merchant ? { merchant: item.merchant } : {}),
        ...(typeof item.description === "string" && item.description ? { description: item.description } : {}),
        ...(typeof item.source === "string" && item.source ? { source: item.source } : {}),
      };
      store.transactions.push(tx);
      added += 1;
    }
    // 单 actor 上限 50_000 条（年度账本也不至于这么多）
    if (store.transactions.length > 50_000) {
      store.transactions.splice(0, store.transactions.length - 50_000);
    }
    if (added > 0) this.schedulePersist(actorId);
    return added;
  }

  /**
   * 全部有账本数据的 actor 列表（Task 16 消费管家：每日预算扫描遍历用）。
   */
  listActorIds(): string[] {
    return Array.from(this.stores.keys());
  }

  /** 账本数据根目录（data/finance；订阅盘点等同目录扩展数据落盘用）。 */
  getDataRoot(): string {
    return this.dataRoot;
  }

  /**
   * 查询交易（按时间段 + 类别过滤）。
   *
   * @param from 起始日期 ISO 8601（含）
   * @param to 结束日期 ISO 8601（含）
   * @param category 类别过滤（可选）
   * @param limit 返回上限（默认 1000，最新在前）
   */
  getTransactions(
    actorId: string,
    from?: string,
    to?: string,
    category?: FinanceCategory,
    limit = 1000,
  ): FinanceTransaction[] {
    const store = this.stores.get(actorId);
    if (!store) return [];
    const fromMs = from ? Date.parse(from) : -Infinity;
    const toMs = to ? Date.parse(to) : Infinity;
    const filtered = store.transactions.filter((t) => {
      if (category && t.category !== category) return false;
      const ts = Date.parse(t.date);
      if (!Number.isFinite(ts)) return false;
      return ts >= fromMs && ts <= toMs;
    });
    filtered.sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
    return filtered.slice(0, Math.max(1, Math.min(10_000, limit)));
  }

  // ─── 消费分析 ─────────────────────────────────────────────────

  /**
   * 消费分析：按类别 / 时间段聚合。
   *
   * @param groupBy 默认按类别聚合，传 `month` 时额外按月聚合
   */
  analyzeSpending(
    actorId: string,
    from?: string,
    to?: string,
    groupBy?: "category" | "month",
  ): SpendingAnalysis {
    const now = this.now().getTime();
    const fromMs = from ? Date.parse(from) : now - 30 * 86_400_000;
    const toMs = to ? Date.parse(to) : now;
    const fromIso = new Date(fromMs).toISOString();
    const toIso = new Date(toMs).toISOString();

    const txs = this.getTransactions(actorId, fromIso, toIso, undefined, 10_000);
    // 排序为升序便于按月聚合
    txs.sort((a, b) => Date.parse(a.date) - Date.parse(b.date));

    const expenses = txs.filter((t) => t.type === "expense");
    const incomes = txs.filter((t) => t.type === "income");

    const totalExpense = expenses.reduce((acc, t) => acc + t.amount, 0);
    const totalIncome = incomes.reduce((acc, t) => acc + t.amount, 0);

    // 按类别聚合（仅支出）
    const catMap = new Map<FinanceCategory, { total: number; count: number }>();
    for (const t of expenses) {
      const cur = catMap.get(t.category) ?? { total: 0, count: 0 };
      cur.total += t.amount;
      cur.count += 1;
      catMap.set(t.category, cur);
    }
    const byCategory = Array.from(catMap.entries())
      .map(([category, v]) => ({
        category,
        total: Number(v.total.toFixed(2)),
        count: v.count,
        ratio: totalExpense > 0 ? Number((v.total / totalExpense).toFixed(4)) : 0,
      }))
      .sort((a, b) => b.total - a.total);

    // 按月聚合
    const monthMap = new Map<string, { totalExpense: number; totalIncome: number; count: number }>();
    for (const t of txs) {
      const month = t.date.slice(0, 7); // YYYY-MM
      const cur = monthMap.get(month) ?? { totalExpense: 0, totalIncome: 0, count: 0 };
      if (t.type === "expense") cur.totalExpense += t.amount;
      else cur.totalIncome += t.amount;
      cur.count += 1;
      monthMap.set(month, cur);
    }
    const byMonth = Array.from(monthMap.entries())
      .map(([month, v]) => ({
        month,
        totalExpense: Number(v.totalExpense.toFixed(2)),
        totalIncome: Number(v.totalIncome.toFixed(2)),
        count: v.count,
      }))
      .sort((a, b) => (a.month < b.month ? -1 : 1));

    // Top 3 支出类别
    const topCategories = byCategory.slice(0, 3).map((c) => ({
      category: c.category,
      total: c.total,
      ratio: c.ratio,
    }));

    // 异常：单笔金额超过近 30 日均值 3 倍
    const recent30Ms = now - 30 * 86_400_000;
    const recentExpenses = expenses.filter((t) => Date.parse(t.date) >= recent30Ms);
    const recentAvg =
      recentExpenses.length > 0
        ? recentExpenses.reduce((acc, t) => acc + t.amount, 0) / recentExpenses.length
        : 0;
    const anomalies: SpendingAnalysis["anomalies"] = [];
    if (recentAvg > 0) {
      for (const t of expenses) {
        const multiplier = t.amount / recentAvg;
        if (multiplier >= 3) {
          anomalies.push({
            transaction: t,
            multiplier: Number(multiplier.toFixed(2)),
            average: Number(recentAvg.toFixed(2)),
          });
        }
      }
      // 按金额倒序，最多 10 条
      anomalies.sort((a, b) => b.transaction.amount - a.transaction.amount);
      anomalies.splice(10);
    }

    // 趋势：对比前半段月均支出 vs 后半段月均支出
    let trend: SpendingAnalysis["trend"] = "unknown";
    let trendDelta = 0;
    if (byMonth.length >= 2) {
      const mid = Math.floor(byMonth.length / 2);
      const firstHalf = byMonth.slice(0, mid);
      const secondHalf = byMonth.slice(mid);
      const avg = (arr: typeof byMonth) =>
        arr.length === 0 ? 0 : arr.reduce((acc, m) => acc + m.totalExpense, 0) / arr.length;
      const firstAvg = avg(firstHalf);
      const secondAvg = avg(secondHalf);
      trendDelta = secondAvg - firstAvg;
      const rel = firstAvg !== 0 ? Math.abs(trendDelta / firstAvg) : 0;
      if (rel < 0.05) trend = "stable";
      else if (trendDelta > 0) trend = "rising";
      else trend = "falling";
    }

    // groupBy 仅影响返回结构（不传则不返回 byMonth），保持 API 简洁
    const shouldReturnByMonth = groupBy === "month" || groupBy === undefined;

    return {
      from: fromIso,
      to: toIso,
      totalExpense: Number(totalExpense.toFixed(2)),
      totalIncome: Number(totalIncome.toFixed(2)),
      net: Number((totalIncome - totalExpense).toFixed(2)),
      count: txs.length,
      byCategory,
      byMonth: shouldReturnByMonth ? byMonth : [],
      topCategories,
      anomalies,
      trend,
      trendDelta: Number(trendDelta.toFixed(2)),
    };
  }

  // ─── 预算 ────────────────────────────────────────────────────

  /**
   * 设置预算。
   *
   * @returns 创建后的预算
   */
  setBudget(
    actorId: string,
    category: FinanceCategory,
    amount: number,
    period: "monthly" | "yearly",
    startDate?: string,
    endDate?: string,
  ): FinanceBudget {
    const store = this.getStore(actorId);
    // 同类别同周期：覆盖旧预算（保留 createdAt）
    const existingIdx = store.budgets.findIndex(
      (b) => b.category === category && b.period === period,
    );
    const nowIso = this.now().toISOString();
    const budget: FinanceBudget = {
      id: existingIdx >= 0 ? store.budgets[existingIdx].id : this.genId(),
      category,
      amount: Math.abs(amount),
      period,
      startDate: startDate ?? nowIso.slice(0, 10),
      ...(endDate ? { endDate } : {}),
      createdAt: existingIdx >= 0 ? store.budgets[existingIdx].createdAt : nowIso,
    };
    if (existingIdx >= 0) {
      store.budgets[existingIdx] = budget;
    } else {
      store.budgets.push(budget);
    }
    this.schedulePersist(actorId);
    return budget;
  }

  /**
   * 查询预算执行进度。
   *
   * @param month 形如 "2025-07"；不传则用当前月
   */
  getBudgetStatus(actorId: string, month?: string): BudgetStatus[] {
    const store = this.stores.get(actorId);
    if (!store || store.budgets.length === 0) return [];
    const periodLabel = month ?? this.now().toISOString().slice(0, 7);
    const year = periodLabel.slice(0, 4);
    const fromMs = Date.parse(`${periodLabel}-01T00:00:00`);
    // 当月最后一天
    const nextMonth = periodLabel.endsWith("-12")
      ? `${Number(periodLabel.slice(0, 4)) + 1}-01`
      : `${periodLabel.slice(0, 5)}${String(Number(periodLabel.slice(5, 7)) + 1).padStart(2, "0")}`;
    const toMs = Date.parse(`${nextMonth}-01T00:00:00`);

    return store.budgets.map((budget) => {
      let spent = 0;
      if (budget.period === "monthly") {
        // 月度预算：统计当月支出
        spent = store.transactions
          .filter((t) => {
            if (t.type !== "expense") return false;
            if (t.category !== budget.category) return false;
            const ts = Date.parse(t.date);
            return Number.isFinite(ts) && ts >= fromMs && ts < toMs;
          })
          .reduce((acc, t) => acc + t.amount, 0);
      } else {
        // 年度预算：统计当年支出
        spent = store.transactions
          .filter((t) => {
            if (t.type !== "expense") return false;
            if (t.category !== budget.category) return false;
            return t.date.slice(0, 4) === year;
          })
          .reduce((acc, t) => acc + t.amount, 0);
      }
      const remaining = budget.amount - spent;
      const progress = budget.amount > 0 ? spent / budget.amount : 0;
      let level: BudgetStatus["level"] = "ok";
      if (progress >= 1) level = "exceeded";
      else if (progress >= 0.8) level = "warning";
      return {
        budget,
        spent: Number(spent.toFixed(2)),
        remaining: Number(remaining.toFixed(2)),
        progress: Number(progress.toFixed(4)),
        level,
        periodLabel: budget.period === "monthly" ? periodLabel : year,
      };
    });
  }

  // ─── 自动对账 ────────────────────────────────────────────────

  /**
   * 自动对账：用户给的账单（expectedItems）vs 已记录交易，
   * 找出差异。
   *
   * 匹配规则（按日期 + 商户）：
   *   - 同日期同商户 + 金额一致 → matched
   *   - 同日期同商户 + 金额不一致 → amountMismatch
   *   - 已记录里有，账单里没对应 → onlyInRecords
   *   - 账单里有，已记录里没对应 → onlyInExpected
   *
   * 日期匹配容差 ±2 天（银行入账可能延迟）。
   */
  reconcile(actorId: string, expectedItems: FinanceTransaction[]): ReconcileDiff {
    const store = this.stores.get(actorId);
    const recorded = store?.transactions ?? [];

    const matched: ReconcileDiff["matched"] = [];
    const onlyInRecords: FinanceTransaction[] = [];
    const onlyInExpected: FinanceTransaction[] = [];
    const amountMismatch: ReconcileDiff["amountMismatch"] = [];

    // 标记已用过的索引，避免重复匹配
    const usedExpectedIdx = new Set<number>();
    const usedRecordedIdx = new Set<number>();

    // 第一轮：精确匹配（同日期同商户）
    recorded.forEach((rec, recIdx) => {
      if (usedRecordedIdx.has(recIdx)) return;
      for (let i = 0; i < expectedItems.length; i += 1) {
        if (usedExpectedIdx.has(i)) continue;
        const exp = expectedItems[i];
        if (this.transactionsMatch(rec, exp, true)) {
          if (Math.abs(rec.amount - exp.amount) < 0.01) {
            matched.push({ recorded: rec, expected: exp });
          } else {
            amountMismatch.push({ recorded: rec, expected: exp });
          }
          usedExpectedIdx.add(i);
          usedRecordedIdx.add(recIdx);
          break;
        }
      }
    });

    // 第二轮：模糊匹配（日期 ±2 天，商户可选）
    recorded.forEach((rec, recIdx) => {
      if (usedRecordedIdx.has(recIdx)) return;
      for (let i = 0; i < expectedItems.length; i += 1) {
        if (usedExpectedIdx.has(i)) continue;
        const exp = expectedItems[i];
        if (this.transactionsMatch(rec, exp, false)) {
          if (Math.abs(rec.amount - exp.amount) < 0.01) {
            matched.push({ recorded: rec, expected: exp });
          } else {
            amountMismatch.push({ recorded: rec, expected: exp });
          }
          usedExpectedIdx.add(i);
          usedRecordedIdx.add(recIdx);
          break;
        }
      }
    });

    // 收集未匹配项
    recorded.forEach((rec, recIdx) => {
      if (!usedRecordedIdx.has(recIdx)) onlyInRecords.push(rec);
    });
    expectedItems.forEach((exp, i) => {
      if (!usedExpectedIdx.has(i)) onlyInExpected.push(exp);
    });

    return {
      onlyInRecords,
      onlyInExpected,
      amountMismatch,
      matched,
      summary: {
        matched: matched.length,
        onlyInRecords: onlyInRecords.length,
        onlyInExpected: onlyInExpected.length,
        amountMismatch: amountMismatch.length,
      },
    };
  }

  /** 两笔交易是否匹配（同日期同商户）。strict=true 时日期必须严格相等；false 时 ±2 天。 */
  private transactionsMatch(
    a: FinanceTransaction,
    b: FinanceTransaction,
    strict: boolean,
  ): boolean {
    const aMs = Date.parse(a.date);
    const bMs = Date.parse(b.date);
    if (!Number.isFinite(aMs) || !Number.isFinite(bMs)) return false;
    const diffDays = Math.abs(aMs - bMs) / 86_400_000;
    if (strict) {
      if (diffDays > 0.5) return false;
    } else {
      if (diffDays > 2) return false;
    }
    // 商户匹配（若双方都有 merchant）
    if (a.merchant && b.merchant) {
      const an = a.merchant.toLowerCase().trim();
      const bn = b.merchant.toLowerCase().trim();
      if (an !== bn) {
        // 包含关系也算匹配（如 "星巴克(国贸店)" vs "星巴克"）
        if (!an.includes(bn) && !bn.includes(an)) return false;
      }
    }
    return true;
  }

  // ─── 自动分类 ────────────────────────────────────────────────

  /**
   * 关键词规则自动分类。
   *
   * 规则按类别分组，命中任一关键词即归类；都未命中归「其他」。
   * 大额收入（amount > 5000 且 description 命中工资类关键词）归「工资」。
   */
  categorize(description?: string, amount?: number): CategorizeResult {
    const text = (description ?? "").toLowerCase();
    for (const [category, keywords] of CATEGORY_KEYWORDS) {
      for (const kw of keywords) {
        if (text.includes(kw)) {
          // 工资类需要金额校验（避免小额被误判）
          if (category === "工资" && typeof amount === "number" && amount < 1000) {
            continue;
          }
          return { category, matched: kw };
        }
      }
    }
    return { category: "其他", matched: "" };
  }

  // ─── 报告导出 ────────────────────────────────────────────────

  /**
   * 导出财务报告（markdown / csv / json），落盘返回 fileUrl。
   *
   * @param format markdown / csv / json
   */
  async exportReport(
    actorId: string,
    from: string,
    to: string,
    format: "markdown" | "csv" | "json",
  ): Promise<ExportReportResult> {
    const analysis = this.analyzeSpending(actorId, from, to);
    const budgets = this.getBudgetStatus(actorId, from.slice(0, 7));
    const txs = this.getTransactions(actorId, from, to, undefined, 10_000);

    const safeActorId = this.safeActorId(actorId);
    const reportDir = join(this.dataRoot, safeActorId, "reports");
    await mkdir(reportDir, { recursive: true });

    const stamp = this.now().toISOString().replace(/[:.]/g, "-");
    const ext = format === "markdown" ? "md" : format;
    const fileName = `report-${stamp}.${ext}`;
    const fullPath = join(reportDir, fileName);

    let content: string;
    if (format === "json") {
      content = JSON.stringify(
        { from, to, analysis, budgets, transactions: txs },
        null,
        2,
      );
    } else if (format === "csv") {
      content = this.toCsvReport(txs, budgets, analysis);
    } else {
      content = this.toMarkdownReport(from, to, analysis, budgets, txs);
    }

    await writeFile(fullPath, content, "utf8");
    const s = await stat(fullPath);

    return {
      filePath: fullPath,
      fileUrl: `/agent/finance/${safeActorId}/${fileName}`,
      size: s.size,
      format,
    };
  }

  /** 生成 Markdown 报告。 */
  private toMarkdownReport(
    from: string,
    to: string,
    analysis: SpendingAnalysis,
    budgets: BudgetStatus[],
    txs: FinanceTransaction[],
  ): string {
    const lines: string[] = [
      `# 财务报告 ${from} ~ ${to}`,
      "",
      "## 总览",
      `- 总支出：¥${analysis.totalExpense.toFixed(2)}`,
      `- 总收入：¥${analysis.totalIncome.toFixed(2)}`,
      `- 净额：¥${analysis.net.toFixed(2)}`,
      `- 交易条数：${analysis.count}`,
      `- 趋势：${analysis.trend}（变化 ¥${analysis.trendDelta}）`,
      "",
      "## 按类别",
      "| 类别 | 总额 | 笔数 | 占比 |",
      "| --- | --- | --- | --- |",
      ...analysis.byCategory.map(
        (c) =>
          `| ${c.category} | ¥${c.total.toFixed(2)} | ${c.count} | ${(c.ratio * 100).toFixed(1)}% |`,
      ),
      "",
      "## Top 3 支出类别",
      ...analysis.topCategories.map(
        (c) => `- ${c.category}：¥${c.total.toFixed(2)}（占比 ${(c.ratio * 100).toFixed(1)}%）`,
      ),
      "",
      "## 预算执行",
      ...budgets.map(
        (b) =>
          `- ${b.budget.category}（${b.periodLabel}）：预算 ¥${b.budget.amount.toFixed(2)}，已花 ¥${b.spent.toFixed(2)}，剩余 ¥${b.remaining.toFixed(2)}（${b.level}）`,
      ),
      "",
      "## 异常交易",
      ...(analysis.anomalies.length === 0
        ? ["（无）"]
        : analysis.anomalies.map(
            (a) =>
              `- ¥${a.transaction.amount.toFixed(2)} ${a.transaction.date} ${a.transaction.description ?? ""}（${a.multiplier}x 均值 ¥${a.average}）`,
          )),
      "",
      "## 明细（最新 50 条）",
      ...txs.slice(0, 50).map(
        (t) =>
          `- ${t.date} ${t.type === "income" ? "收入" : "支出"} ¥${t.amount.toFixed(2)} [${t.category}] ${t.merchant ?? ""} ${t.description ?? ""}`.trim(),
      ),
      "",
    ];
    return lines.join("\n");
  }

  /** 生成 CSV 报告（明细 + 汇总两段）。 */
  private toCsvReport(
    txs: FinanceTransaction[],
    budgets: BudgetStatus[],
    analysis: SpendingAnalysis,
  ): string {
    const lines: string[] = [
      "# 明细",
      "date,type,amount,category,merchant,description",
      ...txs.map((t) =>
        [
          t.date,
          t.type,
          t.amount.toFixed(2),
          t.category,
          this.csvEscape(t.merchant ?? ""),
          this.csvEscape(t.description ?? ""),
        ].join(","),
      ),
      "",
      "# 类别汇总",
      "category,total,count,ratio",
      ...analysis.byCategory.map((c) =>
        [c.category, c.total.toFixed(2), c.count, (c.ratio * 100).toFixed(1) + "%"].join(","),
      ),
      "",
      "# 预算执行",
      "category,period,amount,spent,remaining,level",
      ...budgets.map((b) =>
        [
          b.budget.category,
          b.periodLabel,
          b.budget.amount.toFixed(2),
          b.spent.toFixed(2),
          b.remaining.toFixed(2),
          b.level,
        ].join(","),
      ),
    ];
    return lines.join("\n");
  }

  /** CSV 字段转义：含逗号 / 引号时用双引号包裹。 */
  private csvEscape(s: string): string {
    if (s.includes(",") || s.includes('"') || s.includes("\n")) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  }

  // ─── 内部工具 ────────────────────────────────────────────────

  private getStore(actorId: string): FinanceStore {
    let store = this.stores.get(actorId);
    if (!store) {
      store = { transactions: [], budgets: [] };
      this.stores.set(actorId, store);
    }
    return store;
  }

  /** actorId 安全化：仅保留 [a-zA-Z0-9_-]，避免路径穿越。 */
  private safeActorId(actorId: string): string {
    return actorId.replace(/[^a-zA-Z0-9_-]/g, "_") || "anonymous";
  }

  private normalizeCategory(
    category: unknown,
    description?: string,
  ): FinanceCategory {
    if (typeof category === "string" && category) {
      if ((FINANCE_CATEGORIES as readonly string[]).includes(category)) {
        return category as FinanceCategory;
      }
    }
    // 未分类 → 自动推断
    return this.categorize(description).category;
  }

  private normalizeTransactions(input: unknown[]): FinanceTransaction[] {
    return input
      .filter((item) => item && typeof item === "object")
      .map((item) => {
        const r = item as Record<string, unknown>;
        const description =
          typeof r.description === "string" ? r.description : undefined;
        const merchant = typeof r.merchant === "string" ? r.merchant : undefined;
        const category = this.normalizeCategory(r.category, description ?? merchant);
        return {
          id: typeof r.id === "string" && r.id ? r.id : this.genId(),
          date: typeof r.date === "string" && r.date ? r.date : this.now().toISOString(),
          amount: Math.abs(Number(r.amount) || 0),
          type: r.type === "income" ? ("income" as const) : ("expense" as const),
          category,
          ...(merchant ? { merchant } : {}),
          ...(description ? { description } : {}),
          ...(typeof r.source === "string" && r.source ? { source: r.source } : {}),
        };
      });
  }

  private normalizeBudgets(input: unknown[]): FinanceBudget[] {
    return input
      .filter((item) => item && typeof item === "object")
      .map((item) => {
        const r = item as Record<string, unknown>;
        const category = this.normalizeCategory(r.category);
        const period: "monthly" | "yearly" =
          r.period === "yearly" ? "yearly" : "monthly";
        return {
          id: typeof r.id === "string" && r.id ? r.id : this.genId(),
          category,
          amount: Math.abs(Number(r.amount) || 0),
          period,
          startDate:
            typeof r.startDate === "string" && r.startDate
              ? r.startDate
              : this.now().toISOString().slice(0, 10),
          ...(typeof r.endDate === "string" && r.endDate ? { endDate: r.endDate } : {}),
          createdAt:
            typeof r.createdAt === "string" && r.createdAt
              ? r.createdAt
              : this.now().toISOString(),
        };
      });
  }

  private schedulePersist(actorId: string): void {
    this.dirty.add(actorId);
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.flush();
    }, 1000);
    this.persistTimer.unref?.();
  }

  private genId(): string {
    return randomUUID();
  }
}

/**
 * 关键词分类规则：[类别, 关键词数组]。
 *
 * 关键词全部小写匹配（描述文本会被 toLowerCase 后再 includes）。
 * 顺序很重要：靠前的优先级高（餐饮 > 交通 > 购物 > ...）。
 */
const CATEGORY_KEYWORDS: ReadonlyArray<readonly [FinanceCategory, readonly string[]]> = [
  [
    "餐饮",
    [
      "餐", "饭", "食", "外卖", "美团", "饿了么", "麦当劳", "肯德基", "星巴克",
      "咖啡", "奶茶", "火锅", "烧烤", "早餐", "午餐", "晚餐", "夜宵", "零食",
      "饮料", "奶茶", "果汁", "酒", "bar", "cafe", "coffee", "food", "meal",
      "restaurant", "dining", "breakfast", "lunch", "dinner", "snack", "drink",
      "starbucks", "mcdonald", "kfc",
    ],
  ],
  [
    "交通",
    [
      "打车", "出租", "滴滴", "高铁", "火车", "地铁", "公交", "加油", "停车",
      "过路费", "机票", "航班", "航空", "滴滴", "哈啰", "摩拜", "单车",
      "taxi", "uber", "didi", "subway", "metro", "bus", "train", "flight",
      "airline", "fuel", "gas", "parking", "transport", "ticket",
    ],
  ],
  [
    "购物",
    [
      "淘宝", "天猫", "京东", "拼多多", "苏宁", "唯品会", "超市", "便利店",
      "7-11", "全家", "罗森", "商品", "购买", "下单", "shopping", "taobao",
      "jd", "amazon", "store", "supermarket", "online", "order", "ecommerce",
    ],
  ],
  [
    "娱乐",
    [
      "电影", "ktv", "k歌", "游戏", "演唱会", "音乐会", "景点", "门票", "游乐园",
      "迪士尼", "movie", "cinema", "game", "concert", "ticket", "entertainment",
      "spotify", "netflix", "video", "streaming",
    ],
  ],
  [
    "医疗",
    [
      "医院", "药店", "诊所", "挂号", "体检", "药", "doctor", "hospital",
      "pharmacy", "medical", "clinic", "health", "medicine", "dental",
    ],
  ],
  [
    "教育",
    [
      "书店", "课程", "学费", "培训", "学校", "大学", "考研", "网课", "得到",
      "coursera", "udemy", "book", "course", "tuition", "education", "school",
      "training", "learning",
    ],
  ],
  [
    "居住",
    [
      "房租", "水电", "物业", "燃气", "电费", "水费", "网费", "宽带", "房贷",
      "rent", "utility", "utilities", "mortgage", "property", "electricity",
      "water", "gas", "internet", "broadband",
    ],
  ],
  [
    "工资",
    [
      "工资", "薪水", "薪资", "发薪", "奖金", "salary", "payroll", "wage",
      "bonus", "income", "paycheck",
    ],
  ],
];
