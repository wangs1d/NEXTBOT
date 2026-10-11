// ProactivityHub —— 对话内触发器（从 agent-core 迁移，新旧替换）
//
// 关键词种子层（零 LLM、零 token）：高精度强线索直判。
// - followup：等待结果/待办约定 → 主动承接跟进
// （语义泛化层与 care 关怀已随 2026-09-24 架构定稿拆除）
import type { ProactiveIntent } from "../proactivity-types.js";

/** 对话主动类型 */
export type ConversationProactiveHookKind = "followup";

/** 一次对话内主动钩子检测结果 */
export type ConversationProactiveHook = {
  kind: ConversationProactiveHookKind;
  importance: "high" | "medium";
  title: string;
};

// 跟进/待办类：等待结果、未完成、待会要做、约定提醒 → importance medium
//
// 收窄（2026-10-09）：原先混入「这个周末 / 下周 / 下礼拜 / 过几天 / 晚上再说 /
// 有空再说」等日常口语短语，闲聊里几乎每轮必中，把大量无承诺对象的闲聊塞进
// 顺嘴挂起栈，隔几小时又由 agent 当"待办"翻出来说（「周末的事情先不管了」被
// 反手追一句「刚才你说好饿」的事故来源之一）。改为只认**明确的等待/约定/提醒**
// 线索——必须有可承接的对象或时间锚，宁缺勿滥。
const CONV_HOOK_FOLLOWUP_RE =
  /待会|等会儿|晚点|回头再|之后提醒|别忘了|帮我记|记得.*提醒|等结果|等消息|等回复|看看.*进度|跟进一下|盯着点|留意一下/i;

/** 检测一段用户文本里是否有值得主动承接的强线索；无则返回 null（保持静默） */
export function detectConversationProactiveHook(
  text: string | undefined | null,
): ConversationProactiveHook | null {
  if (!text) return null;
  if (CONV_HOOK_FOLLOWUP_RE.test(text)) {
    return { kind: "followup", importance: "medium", title: "用户有等待跟进或待办事项，值得主动承接" };
  }
  return null;
}

/** 把对话钩子转为主动意图（stateNote 为按需感知的用户状态备注） */
export function buildConversationIntent(
  actorId: string,
  text: string,
  stateNote: string,
): ProactiveIntent | null {
  const hook = detectConversationProactiveHook(text);
  if (!hook) return null;
  return {
    actorId,
    kind: hook.kind,
    importance: hook.importance,
    title: hook.title,
    summary: `${hook.title}${stateNote ? `；${stateNote}` : ""}。用户原话：${text.trim().slice(0, 64)}`,
    mode: "speak",
    source: "conversation",
  };
}
