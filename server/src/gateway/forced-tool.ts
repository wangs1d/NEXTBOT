import { isExplicitPhoneCallRequest } from "../agent/phone-call-intent.js";
import { isActionableTaskRequest, isInjectionAnsweredQuery, turnNeedsToolFloor } from "../agent/task-intent.js";

/**
 * 办事信号供给（2026-10-22 架构定稿：不预测，只验证）。
 *
 * 请求层不再做任何 tool_choice 预判——原 resolveForcedToolChoice（电话/位置
 * 指定门 + 祈使扳机）已整体退役，所有轮次一律 tool_choice="auto" 交模型自决。
 * 确定性信号全部降级为**出口对账闸的授权**：模型先走，服务端只看事实（本轮
 * 到底调没调对应工具、有没有宣称办过），违约才打回一次 required 续波。误判
 * 代价从「不可逆的强制动作」变成「一次可逆的 round trip」，「该调就调」的
 * 保证不变——保证从「事前强迫」移到「事后对账」。
 *
 * 撤销事前强制的依据（2026-10-22 用户拍板，与前沿实践对齐）：
 *   - Anthropic / OpenAI 的 agent 实践中 tool_choice="required" 只用于「下一
 *     轮必须是结构化抽取」的封闭场景，从不用输入侧词表猜轮次类型；可靠性靠
 *     工具描述（何时用/何时不用）+ 模型自决 + 事后校验器（guardrail/validator）。
 *   - 输入侧正则强制是词表打地鼠（「独立开发」事故即其放大机制）。
 *
 * 2026-10-11 口径（时间问题不强制查工具）：时间/日期/身份由【当前时间】块注入，
 * 设计上不走工具（见 isInjectionAnsweredQuery）。位置没有注入权威源，必须真调工具。
 */

const DIRECT_LOCATION_RE = /我.*在哪|当前位置|所在城市|where am i/i;

/** 电话请求的否定式（「别/不用…打电话」）——不是动作请求，不得触发出口对账。 */
const PHONE_CALL_NEGATION_RE = /(?:别|不要|不用|甭|勿|无需).{0,8}(?:打|拨|回|call).{0,8}(?:电话|phone)/i;

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
 * 办事信号（确定性，**只作授权不作强制**）：
 *   - 出口对账闸：命中后允许在「零成功工具 + 宣称未兑现」时打回 required 续波；
 *   - agent-core 的 useExplicitPlanner：允许任务轮升级到显式「计划→执行」
 *     （误判只多一次规划调用，可逆）。
 *
 * 不再驱动请求层 tool_choice（2026-10-22 退役）。
 */
export function needsToolChoiceRequired(userText: string): boolean {
  if (CONFIRMATION_QUESTION_RE.test(userText.trim())) return false;
  if (isActionableTaskRequest(userText)) return true;
  return REMINDER_REQUEST_RE.test(userText.trim());
}

/**
 * 出口对账闸的「怀疑信号」：命中只授权出口闸在「零实质成功工具 + 宣称办过」
 * 时续波一次。组成：提醒/闹钟句式 ∪ turnNeedsToolFloor 宽网（天气/余额/日程/
 * 发消息…），排除注入可答的单一查询（时间/日期/身份——答案在【当前时间】块里，
 * 设计上不走工具）。
 */
export function turnSuggestsToolNeed(userText: string): boolean {
  const t = (userText ?? "").trim();
  if (!t) return false;
  if (needsToolChoiceRequired(t)) return true;
  if (isInjectionAnsweredQuery(t)) return false;
  return turnNeedsToolFloor(t);
}

/**
 * 显式外部动作识别（出口对账闸专用，替代原事前指定门）：用户消息里明确要求
 * 打电话 / 报位置时返回对应工具名。原实现是在请求层强制 tool_choice 指定该
 * 工具（事前不信任模型）；现在模型先自决，本判定只用于出口对账——服务端发现
 * 整轮没有该工具的执行记录时，打回一次 required 续波并指名工具。保证等价
 * （显式请求最终必执行），误判面为零（词面极窄），代价只是失败场景多一 round trip。
 */
export function resolveExplicitActionTool(userText: string): string | null {
  const t = (userText ?? "").trim();
  // 否定句（「别给我打电话」「不用打电话」）不是请求——不能因词面含「打电话」
  // 就在出口把模型正确的沉默打回成强制外呼。
  if (PHONE_CALL_NEGATION_RE.test(t)) return null;
  if (isExplicitPhoneCallRequest(t)) return "phone.call_user";
  if (DIRECT_LOCATION_RE.test(t)) return "clock.get_user_location";
  return null;
}
