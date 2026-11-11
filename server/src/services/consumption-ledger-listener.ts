// ConsumptionLedgerListener —— 消费管家闭环（Task 16 场景B）
//
// 链路：工具执行成功 → HookBus "tool.executed" 事件 → 本监听器：
//   1. 消费类工具（payment.* / meituan.* / shopping.order.place）
//      → finance-deep 自动入账（金额/分类按工具类型映射/来源工具/时间）
//   2. 入账后检测：预算 warning（80%）/ exceeded（100%）分级提醒
//      （getBudgetStatus level）+ 异常消费检测（≥ 近30天同分类均值 3 倍且 ≥ ¥100）
//      → onBudgetAlert / onAnomalyAlert 回调（装配层接 ProactivityHub，life_reminder kind）
//   3. 每日扫描（定时触发 runDailyScan）：全 actor 预算检查
//      + 每月 1 日生成上月消费月报（确定性数据拼接 + 单次 LLM 总结）
//      → onMonthlyReport 回调（monthly_report kind）
//
// 设计约束：不依赖 ProactivityHub 具体类型（回调注入，如 InterestWatcher.onHit）；
// 入账/报告失败静默日志，绝不影响工具执行主链路。
import type { HookBus, HookEvent } from "./hooks/index.js";
import type {
  FinanceCategory,
  FinanceDeepService,
  SpendingAnalysis,
} from "./finance-deep-service.js";

/** 消费类工具判定（正则；仅这些工具成功后入账，查询/取消类不重复入账） */
const CONSUMPTION_TOOL_RE =
  /^(payment\.create_order|meituan\.create_order|shopping\.order\.place|ride_hailing\.book|home_service\.book|restaurant\.book)$/;

/** 消费管家依赖（装配层注入，全部可 mock） */
export interface ConsumptionLedgerListenerDeps {
  financeDeepService: FinanceDeepService;
  /** 预算超支提醒回调（装配层接 ProactivityHub speak，life_reminder kind） */
  onBudgetAlert?: (actorId: string, message: string) => void;
  /** 异常消费提醒回调（装配层接 ProactivityHub speak，life_reminder kind） */
  onAnomalyAlert?: (actorId: string, message: string) => void;
  /** 月度报告生成完成回调（装配层接 ProactivityHub speak，monthly_report kind） */
  onMonthlyReport?: (actorId: string, reportText: string) => void;
  /**
   * 单次 LLM 总结函数（月报措辞；externalChat.streamCompletion 的薄包装，
   * 与 ProactivityHub llmComplete 同模式）。未注入时月报退化为确定性拼接文本。
   */
  llmComplete?: (prompt: string) => Promise<string>;
  /**
   * 订阅盘点服务（P0 财务管家）：月报末尾追加订阅盘点段
   * （确认订阅/月成本/低使用率名单/疑似候选）。未注入时跳过。
   * 结构化最小接口，便于测试 mock。
   */
  subscriptionAudit?: { buildAuditSummary(actorId: string): Promise<string> };
  /** 测试注入时钟 */
  now?: () => Date;
}

/** 异常检测阈值：≥ 近 30 天同分类均值 3 倍且 ≥ ¥100 */
const ANOMALY_MULTIPLIER = 3;
const MIN_ANOMALY_AMOUNT = 100;

/** 判断工具是否消费类（装配层据此过滤 tool.executed 事件发布） */
export function isConsumptionTool(toolName: string): boolean {
  return CONSUMPTION_TOOL_RE.test(toolName);
}

/**
 * 工具事件 payload 摘要化：长字符串截断（如支付二维码 dataURL）、
 * 大数组/对象裁剪，保留金额/订单号/描述等短字段原样——消费入账
 * 监听器可直接从摘要化后的 payload 提取入账字段。
 */
export function summarizeToolPayload(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return value.length > 160 ? `${value.slice(0, 160)}...` : value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 10).map((item) => summarizeToolPayload(item, depth + 1));
  }
  if (value && typeof value === "object" && depth < 4) {
    const out: Record<string, unknown> = {};
    for (const [k, item] of Object.entries(value as Record<string, unknown>).slice(0, 20)) {
      out[k] = summarizeToolPayload(item, depth + 1);
    }
    return out;
  }
  return value;
}

/** 从工具执行信息中提取一条入账（无法提取金额时返回 null，不入账） */
export function extractLedgerEntry(info: {
  tool: string;
  input: Record<string, unknown>;
  result: Record<string, unknown>;
}): {
  amount: number;
  type: "income" | "expense";
  category: FinanceCategory;
  merchant?: string;
  description: string;
  source: string;
} | null {
  const { tool, input, result } = info;
  const amountOf = (v: unknown): number => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };

  switch (tool) {
    case "payment.create_order": {
      // 支付下单成功：amount/description 在结果里
      const amount = amountOf(result.amount ?? input.amount);
      if (!amount) return null;
      return {
        amount,
        type: "expense",
        category: "购物",
        description: String(result.description ?? input.description ?? "扫码支付"),
        source: "payment_tool",
      };
    }
    case "meituan.create_order": {
      // 跑腿订单：入账配送总费用（totalFee 优先，缺省 deliveryFee）
      const amount = amountOf(result.totalFee ?? result.deliveryFee);
      if (!amount) return null;
      return {
        amount,
        type: "expense",
        category: "交通",
        description: `美团跑腿：${String(result.itemDescription ?? input.itemDescription ?? "代跑腿")}`,
        source: "meituan_tool",
      };
    }
    case "shopping.order.place": {
      // 两阶段下单：确认提交成功后才有金额（阶段一无金额不入账）
      const amount = amountOf(result.amount ?? result.totalAmount ?? result.price);
      if (!amount) return null;
      return {
        amount,
        type: "expense",
        category: "购物",
        merchant: result.platform ? String(result.platform) : undefined,
        description: `网购下单：${String(result.item ?? input.item ?? "商品")}`,
        source: "shopping_tool",
      };
    }
    case "ride_hailing.book": {
      // 模拟模式订单（BOOKING_MODE=mock）不入真实账本，避免污染预算与异常检测基线
      if (result.simulated === true) return null;
      // 统一预订层（方案 A）：网约车下单（阶段二成功才有金额）
      const amount = amountOf(result.amountCny);
      if (!amount) return null;
      return {
        amount,
        type: "expense",
        category: "交通",
        merchant: result.provider ? String(result.provider) : undefined,
        description: `网约车：${String(result.summary ?? input.dropoff ?? "行程")}`,
        source: "booking_tool",
      };
    }
    case "home_service.book": {
      if (result.simulated === true) return null;
      const amount = amountOf(result.amountCny);
      if (!amount) return null;
      return {
        amount,
        type: "expense",
        category: "居住",
        merchant: result.provider ? String(result.provider) : undefined,
        description: `家政预订：${String(result.summary ?? input.serviceType ?? "上门服务")}`,
        source: "booking_tool",
      };
    }
    case "restaurant.book": {
      if (result.simulated === true) return null;
      const amount = amountOf(result.amountCny);
      if (!amount) return null;
      return {
        amount,
        type: "expense",
        category: "餐饮",
        merchant: result.provider ? String(result.provider) : undefined,
        description: `餐厅预订：${String(result.summary ?? input.optionId ?? "订座")}`,
        source: "booking_tool",
      };
    }
    default:
      return null;
  }
}

/** 去重指纹（同订单/同交易不重复入账；防事件重放与重复 emit） */
function entryFingerprint(
  actorId: string,
  tool: string,
  input: Record<string, unknown>,
  result: Record<string, unknown>,
): string {
  const orderId =
    result.orderId ?? result.outTradeNo ?? result.transactionId ?? result.deliveryId ?? "";
  const amount = String(result.amount ?? result.totalFee ?? result.totalAmount ?? "");
  return `${actorId}|${tool}|${orderId}|${amount}`;
}

export class ConsumptionLedgerListener {
  private readonly deps: ConsumptionLedgerListenerDeps;
  /** 已入账指纹（防重；环形淘汰） */
  private readonly seenFingerprints: string[] = [];
  private readonly SEEN_LIMIT = 500;
  /** 本月已提醒的预算级别（actorId|period|category|level），防重复打扰 */
  private readonly alertedBudgetKeys = new Set<string>();
  /** 已提醒的异常消费（actorId|date|amount|category），防重复打扰 */
  private readonly alertedAnomalyKeys = new Set<string>();
  /** 每日扫描调度 */
  private scanTimer: ReturnType<typeof setInterval> | null = null;
  private lastScanDay = "";
  private started = false;
  private unsubscribe?: () => void;

  constructor(deps: ConsumptionLedgerListenerDeps) {
    this.deps = deps;
  }

  /** 订阅 HookBus 的 tool.executed 事件（装配层接线） */
  subscribe(hookBus: HookBus): void {
    this.unsubscribe?.();
    this.unsubscribe = hookBus.subscribeType("tool.executed", (event) => {
      void this.handleToolExecuted(event).catch((err) => {
        console.log(`[ConsumptionLedger] 事件处理失败（忽略）: ${err}`);
      });
    });
  }

  /** 启动每日扫描调度（每小时检查一次是否到达扫描时刻；测试可直调 runDailyScan） */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.scanTimer = setInterval(() => {
      try {
        void this.tickScan();
      } catch (err) {
        console.log(`[ConsumptionLedger] 扫描 tick 失败（忽略）: ${err}`);
      }
    }, 60 * 60 * 1000);
    if (typeof this.scanTimer.unref === "function") this.scanTimer.unref();
    console.log("[ConsumptionLedger] 消费管家监听已启动（自动入账 + 预算扫描 + 月报）");
  }

  stop(): void {
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
    this.started = false;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  // ─── 事件消费：自动入账 + 入账时预算检测 ───

  private async handleToolExecuted(event: HookEvent): Promise<void> {
    const data = event.data as {
      toolName?: string;
      args?: Record<string, unknown>;
      result?: Record<string, unknown>;
      actorId?: string;
    };
    const tool = String(data.toolName ?? "");
    if (!isConsumptionTool(tool)) return;
    const actorId = String(data.actorId ?? event.actorId ?? "");
    if (!actorId) return;

    const input = data.args ?? {};
    const result = data.result ?? {};

    // 去重：同订单指纹已入账则跳过
    const fp = entryFingerprint(actorId, tool, input, result);
    if (this.seenFingerprints.includes(fp)) return;
    this.seenFingerprints.push(fp);
    if (this.seenFingerprints.length > this.SEEN_LIMIT) {
      this.seenFingerprints.splice(0, this.seenFingerprints.length - this.SEEN_LIMIT);
    }

    const entry = extractLedgerEntry({ tool, input, result });
    if (!entry) return;

    // 自动入账（金额/分类映射/来源工具/时间）
    await this.deps.financeDeepService.importTransactions(actorId, [
      {
        id: `auto-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        date: event.timestamp ?? new Date().toISOString(),
        amount: entry.amount,
        type: entry.type,
        category: entry.category,
        ...(entry.merchant ? { merchant: entry.merchant } : {}),
        description: entry.description,
        source: entry.source,
      },
    ]);
    console.log(
      `[ConsumptionLedger] 自动入账 actor=${actorId} tool=${tool} 金额=¥${entry.amount} 分类=${entry.category}`,
    );

    // 入账后预算检测（warning/exceeded）+ 异常消费检测
    this.checkBudgetOverrun(actorId);
    this.checkAnomaly(actorId, {
      amount: entry.amount,
      category: entry.category,
      description: entry.description,
      date: event.timestamp ?? new Date().toISOString(),
    });
  }

  // ─── 预算检测（warning 80% + exceeded 100%；入账时 + 每日扫描共用） ───

  /** 检查某 actor 本月预算，warning/exceeded 且该级别未提醒过 → onBudgetAlert（单次提醒） */
  checkBudgetOverrun(actorId: string): void {
    try {
      const statuses = this.deps.financeDeepService.getBudgetStatus(actorId);
      for (const s of statuses) {
        if (s.level === "ok") continue;
        const key = `${actorId}|${s.periodLabel}|${s.budget.category}|${s.level}`;
        if (this.alertedBudgetKeys.has(key)) continue;
        this.alertedBudgetKeys.add(key);
        const message =
          s.level === "exceeded"
            ? `${s.budget.category}预算已超支：本月已花 ¥${s.spent.toFixed(2)}（预算 ¥${s.budget.amount.toFixed(2)}，` +
              `超出 ¥${(s.spent - s.budget.amount).toFixed(2)}）。最近几笔消费我已自动记账，可以帮你看看都花在哪了。`
            : `${s.budget.category}预算快用完了：本月已花 ¥${s.spent.toFixed(2)}（预算 ¥${s.budget.amount.toFixed(2)}，` +
              `还剩 ¥${s.remaining.toFixed(2)}）。接下来的消费我会帮你盯着。`;
        this.deps.onBudgetAlert?.(actorId, message);
        console.log(`[ConsumptionLedger] 预算${s.level === "exceeded" ? "超支" : "预警"}提醒 actor=${actorId} ${s.budget.category}`);
      }
    } catch (err) {
      console.log(`[ConsumptionLedger] 预算检查失败（忽略）: ${err}`);
    }
  }

  // ─── 异常消费检测（入账时增量触发；与 analyze_spending 同阈值：3 倍均值） ───

  /**
   * 入账后对该笔做增量异常检测：金额 ≥ 近 30 天同分类单笔均值 3 倍
   * 且 ≥ ¥100（避免小额均值的噪声放大）→ onAnomalyAlert（单笔单次）。
   */
  checkAnomaly(
    actorId: string,
    entry: { amount: number; category: FinanceCategory; description: string; date: string },
  ): void {
    try {
      if (entry.amount < MIN_ANOMALY_AMOUNT) return;
      const toMs = Date.parse(entry.date);
      if (!Number.isFinite(toMs)) return;
      const fromIso = new Date(toMs - 30 * 86_400_000).toISOString();
      const toIso = new Date(toMs - 1).toISOString(); // 排除本笔，只对比历史
      const prior = this.deps.financeDeepService
        .getTransactions(actorId, fromIso, toIso, entry.category, 10_000)
        .filter((t) => t.type === "expense");
      if (prior.length < 2) return; // 历史样本太少不判异常（首笔大额很常见）
      const avg = prior.reduce((acc, t) => acc + t.amount, 0) / prior.length;
      if (avg <= 0) return;
      const multiplier = entry.amount / avg;
      if (multiplier < ANOMALY_MULTIPLIER) return;
      const key = `${actorId}|${entry.date}|${entry.amount}|${entry.category}`;
      if (this.alertedAnomalyKeys.has(key)) return;
      this.alertedAnomalyKeys.add(key);
      if (this.alertedAnomalyKeys.size > 200) {
        this.alertedAnomalyKeys.delete(this.alertedAnomalyKeys.values().next().value as string);
      }
      const message =
        `刚入账一笔大额消费：${entry.description} ¥${entry.amount.toFixed(2)}，` +
        `是近 30 天「${entry.category}」平均单笔（¥${avg.toFixed(2)}）的 ${multiplier.toFixed(1)} 倍。` +
        `正常支出忽略这条即可；不认识这笔的话告诉我，我帮你查。`;
      this.deps.onAnomalyAlert?.(actorId, message);
      console.log(`[ConsumptionLedger] 异常消费提醒 actor=${actorId} ${entry.category} ¥${entry.amount.toFixed(2)}（${multiplier.toFixed(1)}x）`);
    } catch (err) {
      console.log(`[ConsumptionLedger] 异常检测失败（忽略）: ${err}`);
    }
  }

  // ─── 每日扫描 + 月报 ───

  /** 每小时 tick：到达扫描时刻（默认 9 点，env 可调）且今日未扫 → 执行 */
  private tickScan(): void {
    const now = this.deps.now?.() ?? new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    if (this.lastScanDay === today) return;
    const scanHour = Number(process.env.CONSUMPTION_SCAN_HOUR ?? 9);
    if (now.getHours() < (Number.isFinite(scanHour) ? scanHour : 9)) return;
    this.lastScanDay = today;
    void this.runDailyScan(now).catch((err) => {
      console.log(`[ConsumptionLedger] 每日扫描失败（忽略）: ${err}`);
    });
  }

  /**
   * 每日扫描：全部有账本的 actor 预算检查；
   * 每月 1 日追加生成上月消费月报（确定性数据 + 单次 LLM 总结）。
   * 测试可直调（注入 now）。
   */
  async runDailyScan(now: Date = new Date()): Promise<void> {
    const actors = this.deps.financeDeepService.listActorIds();
    for (const actorId of actors) {
      this.checkBudgetOverrun(actorId);
    }
    // 每月 1 日生成上月月报（挂在每日扫描末尾）
    if (now.getDate() === 1) {
      for (const actorId of actors) {
        try {
          await this.generateMonthlyReport(actorId, now);
        } catch (err) {
          console.log(`[ConsumptionLedger] 月报生成失败（忽略）actor=${actorId}: ${err}`);
        }
      }
    }
  }

  /**
   * 月度消费报告：确定性数据拼接（总额/分类/Top/趋势）+ 单次 LLM 总结。
   * LLM 未注入时退化为纯确定性文本（克制原则：统计零 LLM，措辞一次 LLM）。
   */
  async generateMonthlyReport(actorId: string, now: Date = new Date()): Promise<string> {
    // 上月时间范围（本地月首/月尾，转 ISO）
    const from = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const to = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);
    const analysis: SpendingAnalysis = this.deps.financeDeepService.analyzeSpending(
      actorId,
      from.toISOString(),
      to.toISOString(),
      "month",
    );
    const monthLabel = `${from.getFullYear()}-${String(from.getMonth() + 1).padStart(2, "0")}`;

    // 确定性数据拼接（无 LLM 也完整可读）
    const catLines = analysis.byCategory
      .sort((a, b) => b.total - a.total)
      .map((c) => `- ${c.category}：¥${c.total.toFixed(2)}（${c.count} 笔，占 ${(c.ratio * 100).toFixed(0)}%）`)
      .join("\n");
    const deterministic =
      `${monthLabel} 消费月报：总支出 ¥${analysis.totalExpense.toFixed(2)}（${analysis.count} 笔），` +
      `总收入 ¥${analysis.totalIncome.toFixed(2)}，净额 ¥${analysis.net.toFixed(2)}。\n` +
      `分类明细：\n${catLines || "（无支出记录）"}`;

    // 追加订阅盘点段（失败忽略，不影响月报主体）
    let auditSummary = "";
    let fullDeterministic = deterministic;
    if (this.deps.subscriptionAudit) {
      try {
        auditSummary = (await this.deps.subscriptionAudit.buildAuditSummary(actorId)).trim();
        if (auditSummary) fullDeterministic = `${deterministic}\n\n${auditSummary}`;
      } catch (err) {
        console.log(`[ConsumptionLedger] 订阅盘点段生成失败（忽略）: ${err}`);
      }
    }

    let reportText = fullDeterministic;
    // 单次 LLM 总结（可选；失败退化确定性文本）
    if (this.deps.llmComplete && analysis.count > 0) {
      try {
        const trendLabel =
          analysis.trend === "rising" ? "上升" : analysis.trend === "falling" ? "下降" : "平稳";
        const prompt =
          `你是用户的私人财务管家。基于下月上月消费数据，用 3-5 句口语化中文写一份简短月报，` +
          `像朋友聊天一样点出总支出、大头分类、值得注意的趋势（${trendLabel}），` +
          `末尾给一条具体可行的下月建议。不要罗列全部数据，数据仅供参考：\n${fullDeterministic}`;
        const llmText = (await this.deps.llmComplete(prompt))?.trim();
        if (llmText) reportText = llmText;
      } catch (err) {
        console.log(`[ConsumptionLedger] 月报 LLM 总结失败（退化为确定性文本）: ${err}`);
      }
    }

    this.deps.onMonthlyReport?.(actorId, reportText);
    console.log(`[ConsumptionLedger] ${monthLabel} 月报已生成 actor=${actorId}`);
    return reportText;
  }
}
