/**
 * 行程状态热层快照（纯规则，无 LLM）。
 *
 * 分层架构（详见 travel-plan-store.ts 头注释）：
 *   - 完整行程明细落盘（travel-plan-store），永远不进对话上下文；
 *   - 本模块只在模型判定本轮在问行程/旅行（L1 路由 understanding.travel_query）
 *     时，往 system prompt 注入一行轻量状态（目的地/日期/planId），
 *     让 Agent「知道用户要去哪」而不携带任何明细；
 *   - 追问明细由 travel.get-itinerary 工具按需回查。
 *
 * 注入门控由调用方（prompt-context-builder）按 understanding 裁决——
 * 原 TRAVEL_RECALL_RE 关键词词表已退役（词面命中 ≠ 本轮在问行程）。
 */
import { travelPlanStore } from "../skills/travel-planning/travel-plan-store.js";

/**
 * 构建行程状态快照（≤5 行 + 使用提示）。
 * 无任何已存行程时返回 undefined（不注入空块）。
 */
export function buildTravelStatePrompt(userText?: string): string | undefined {
  const plans = travelPlanStore.listSummaries(5);
  if (plans.length === 0) return undefined;
  const lines = plans.map((p) =>
    `${p.destination || p.title}｜${p.startDate && p.endDate ? `${p.startDate}~${p.endDate.slice(5)}` : p.startDate || "日期未定"}｜${p.dayCount}天${p.totalCost ? `｜预算约¥${Math.round(p.totalCost)}` : ""}｜${p.planId}`,
  );
  return [
    `TRIP|count=${plans.length}`,
    ...lines,
    "（以上是用户已生成的行程回执；明细不在对话里，追问细节或调整安排时调用 travel.get-itinerary 按 planId/day 回查）",
  ].join("\n");
}
