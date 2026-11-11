/**
 * 回执出卡判定（单一事实源，2026-11-10 答案留存闸收窄）。
 *
 * 扣流的唯一正当理由：done 会给这轮回执**确定性附卡**，卡片必须与正文
 * 同帧呈现（2026-10-13 根修的跳变根除）。因此「要不要扣流」不看
 * 「调过什么工具」，看「这份回执会不会出卡」——纯函数、零 LLM。
 *
 * 消费方（三处口径恒一，都走这一个函数）：
 *  - tool-loop answerHeld()：每波求值，此刻回执已在手；
 *  - agent-core answerStreamHeld 记账；
 *  - WS 层 directPathToolProducesCard（直跑路径补判）。
 *
 * 建卡投影与 done 阶段 attachDeterministicCards / processAssistantText
 * 同源（buildToolCard / extractMediaCards），不会出现「hold 判定说不出卡、
 * done 却出了卡」的分叉。新增确定性出卡工具只改 DETERMINISTIC_CARD_TOOLS。
 */
import { buildToolCard } from "./tool-card-registry.js";
import { extractMediaCards } from "./tool-result-processor.js";

/** 回执成功即出卡的确定性工具（媒体/图片建卡另经 extractMediaCards 判定） */
const DETERMINISTIC_CARD_TOOLS = new Set([
  "weather.get_local",
  "travel.plan-itinerary",
  "video.grab",
  "video.find",
]);

/** 这份回执在 done 阶段会不会确定性出卡。 */
export function receiptProducesCard(toolName: string, result: unknown): boolean {
  if (!toolName || !result || typeof result !== "object") return false;
  const rec = result as Record<string, unknown>;
  try {
    if (extractMediaCards(toolName, rec).length > 0) return true;
  } catch {
    /* 投影异常按不出卡处理：宁可多流式，不误扣 */
  }
  if (DETERMINISTIC_CARD_TOOLS.has(toolName)) return true;
  try {
    const payload = buildToolCard(toolName, rec);
    if (payload && payload.items.length > 0) return true;
  } catch {
    /* 同上 */
  }
  return false;
}
