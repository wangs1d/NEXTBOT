import { isActionableTaskRequest } from "../agent/task-intent.js";

/**
 * 办事信号供给（2026-10-22 架构定稿：不预测，只验证）。
 *
 * 请求层不做任何 tool_choice 预判——所有轮次一律 tool_choice="auto" 交模型自决。
 * 本模块只剩一个用途：给 agent-core 的显式规划升级（useExplicitPlanner）提供
 * 「这轮像不像要办事」的确定性信号。误判代价只是一次可逆的规划调用，不会
 * 把用户拖进不可逆的强制动作。
 *
 * 2026-11-08 用户指令：出口对账闸整体删除。它曾消费本模块的怀疑信号打回
 * required 续波；闸没了，本模块的职责收窄到只此一个函数，历史分支与专用正则
 * （电话/位置显式动作识别、怀疑信号宽网）一并删除——留着就是假接口。
 */

/**
 * 短口语提醒/闹钟请求的高精度结构信号（祈使结构判定覆盖不到
 * 「明天早上9点提醒我开会」这类无「帮我」前缀、动作动词不在枚举里的句子）。
 * 仅匹配「提醒我/叫我」开头，或时间词 + 提醒/闹钟同句；确认式反问
 * （「你会提醒我吗」）明确排除。
 */
const REMINDER_REQUEST_RE =
  /^(?:记得)?(?:提醒我|叫我)|(?:明天|后天|今天|今晚|明早|每天|每晚|周[一二三四五六日天]).{0,16}(?:提醒|叫我|闹钟)/;
const CONFIRMATION_QUESTION_RE = /^(?:你|您)(?:会|能|可以|要不要|是不是)/;

/**
 * 本轮是否需要「按办事对待」：可执行任务请求 ∪ 短口语提醒/闹钟句式。
 * 确认式反问（问能力，不是下指令）返回 false。
 */
export function needsToolChoiceRequired(userText: string): boolean {
  if (CONFIRMATION_QUESTION_RE.test(userText.trim())) return false;
  if (isActionableTaskRequest(userText)) return true;
  return REMINDER_REQUEST_RE.test(userText.trim());
}
