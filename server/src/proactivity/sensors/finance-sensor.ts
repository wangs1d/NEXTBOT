// FinanceSensor —— FinanceDeepService → ProactiveSensor 适配器（2026-10-10 外部信源收编）。
//
// 财务账本（支付宝账单自动拉取 + 账单邮件实时入账）此前只在各自服务内消费，
// 不进统一采集层 → 无法与购物/邮件跨源关联（"这笔酒店钱对应哪封确认信"）。
// 适配器只做"账本条目 → Signal 形状"转换，业务逻辑（拉取/解析/入账）仍在原服务。
import type { ProactiveSensor, Signal } from "./types.js";

/** FinanceDeepService 的只读账本口（结构最小面） */
export interface FinanceReadPort {
  getTransactions(
    actorId: string,
    from?: string,
    to?: string,
    category?: undefined,
    limit?: number,
  ): Array<{ id: string; date: string; amount: number; type: "income" | "expense"; category?: string; merchant?: string }>;
}

export class FinanceSensor implements ProactiveSensor {
  readonly id = "finance_ledger";
  readonly stream = "finance" as const;
  /** 账本由服务侧实时入账；内核侧 5min 兜底同步进库 */
  readonly pollIntervalMs = 300_000;

  constructor(
    private readonly port: FinanceReadPort,
    private readonly actorId: () => string | null,
  ) {}

  collect(since: number): Signal[] {
    const actorId = this.actorId();
    if (!actorId) return [];
    // since 往前放宽 1 天：入账时间与交易时间可能错位（补拉窗口）
    const fromIso = new Date(since - 86_400_000).toISOString();
    const txs = this.port.getTransactions(actorId, fromIso, undefined, undefined, 200);
    return txs
      .map((t) => {
        const at = Date.parse(t.date);
        return { t, at: Number.isFinite(at) ? at : since };
      })
      .filter(({ at }) => at > since)
      .map(({ t, at }) => ({
        stream: "finance" as const,
        actorId,
        at,
        // 账本 id 稳定唯一
        fingerprint: `finance:${t.id}`,
        salience: t.amount >= 500 ? "medium" : "low",
        delta: `${t.type === "expense" ? "支出" : "收入"} ¥${t.amount.toFixed(2)}${t.merchant ? `（${t.merchant}）` : ""}`,
        payload: {
          id: t.id,
          amount: t.amount,
          type: t.type,
          category: t.category,
          merchant: t.merchant,
          // 跨源实体候选：商户名（"携程"能同时命中账单与酒店确认邮件）
          entities: [t.merchant, t.category].filter((v): v is string => !!v && v.length <= 40),
        },
      }));
  }
}
