/**
 * 确定性回执（2026-11-01 提速）：本轮工具结果已能自证「任务完成」时，直接由代码
 * 生成用户可读回执，跳过工具循环的「第二波」LLM 汇总（实测每轮省 1.6–4.4s）。
 *
 * 设计要点（对齐用户定的约束）：
 *  - **能力位而非名单**：工具通过 registerDeterministicReceipt 自报「我的结果可
 *    确定性渲染」，新工具接入时补一个 builder 即自动获得「不发第二波」，不需要改
 *    轮次策略；
 *  - **全有或全无**：本轮任意一个结果不是 ok、或工具没注册 builder、或 builder
 *    返回空 → 整体回退 LLM 汇总（绝不半截收口）；
 *  - **只在 zh 聊天面生效**：调用方用 holdAnswer="after_tool_use" 门控，任务面/
 *    子 Agent/语音轮不受影响；
 *  - 文案只取工具真实字段（summary/提醒回执），不编造、不改写。
 */

import { formatScheduleToolResultForUser } from "../tools/schedule-user-reply.js";

type ReceiptBuilder = (result: Record<string, unknown>) => string | null;

const builders = new Map<string, ReceiptBuilder>();

/** 注册/覆盖某个工具的确定性回执渲染器（新工具接入点）。 */
export function registerDeterministicReceipt(toolName: string, builder: ReceiptBuilder): void {
  builders.set(toolName, builder);
}

export function hasDeterministicReceipt(toolName: string): boolean {
  return builders.has(toolName);
}

function envDisabled(): boolean {
  const raw = process.env.AGENT_RECEIPT_SKIP_WAVE?.trim().toLowerCase();
  return raw === "0" || raw === "false" || raw === "off" || raw === "no";
}

/** 同一句反复出现时只留一次（工具回执偶尔把 summary 复用进 description）。 */
function dedupeLines(texts: string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of texts) {
    const text = raw.trim();
    if (!text) continue;
    if (seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out.join("\n\n");
}

/**
 * 本轮全部结果都能确定性收口时返回回执文本，否则 null（调用方回退 LLM 汇总）。
 */
export function buildDeterministicReceiptText(
  results: Array<{ toolName: string; ok: boolean; result: Record<string, unknown> }>,
): string | null {
  if (envDisabled() || results.length === 0) return null;
  const parts: string[] = [];
  for (const item of results) {
    if (!item.ok) return null;
    const builder = builders.get(item.toolName);
    if (!builder) return null;
    const text = builder(item.result)?.trim();
    if (!text) return null;
    parts.push(text);
  }
  return dedupeLines(parts) || null;
}

/** 天气：一句话实况 + 穿衣建议（都取自工具真实字段）。 */
function weatherReceipt(result: Record<string, unknown>): string | null {
  const summary = String(result.summary ?? result.description ?? result.text ?? "").trim();
  if (!summary) return null;
  const advice = String(result.clothingAdvice ?? "").trim();
  if (!advice || summary.includes(advice)) return summary;
  return `${summary}\n穿衣：${advice}`;
}

/** 提醒/日程：复用既有确定性回执格式化（与 WS 层同一份实现，不产生第二套口径）。 */
function scheduleReceipt(toolName: string, result: Record<string, unknown>): string | null {
  return formatScheduleToolResultForUser(toolName, result);
}

// ── 内置注册 ──
registerDeterministicReceipt("weather.get_local", weatherReceipt);
for (const name of [
  "reminder.plan",
  "calendar.create",
  "calendar.create_task",
  "calendar.create_from_text",
]) {
  registerDeterministicReceipt(name, (result) => scheduleReceipt(name, result));
}
