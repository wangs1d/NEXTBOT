/**
 * 记忆信号（2026-10-10 语义判定层退役后收敛）。
 *
 * 职责边界（2026-10-10 重划）：「这轮在问什么、指什么」的语义判定（追问/锚定/
 * 召回意图/日程/旅行）全部由 L1 路由 LLM 与意图同体产出（RouteDecision.
 * understanding，见 task-router.ts），本文件不再保留任何对用户输入的词面猜测。
 * 原因是结构性的：词表判定是打地鼠（「你叫我什么？」因标点分支缺 ^ 锚被判成
 * 追问轮，锚点注入把整轮带偏），而每轮 L1 调用本就存在，语义判定零额外成本。
 *
 * 本文件保留的只有一类：对**已落盘文本**的事后内容扫描（Agent 承诺话术、
 * 关键钉指令、显式记忆词）——它们服务于写入候选筛选与压缩保护，扫的是
 * 确定发生过的文本，不存在「猜意图猜错带偏整轮」的失败模式。
 */

export const MEMORY_EXPLICIT_RE =
  /记住|记得|别忘了|帮我记着|记一下|不要忘记|偏好|喜欢|讨厌|不喜欢|禁忌|生日|纪念日|important|remember|prefer/i;

/**
 * 关键钉确定性触发（recap [关键钉] 区的零 LLM 兜底来源）：用户明确的「要求记住」指令。
 * 刻意比 MEMORY_EXPLICIT_RE 窄——不含回忆性的「记得」（"我记得上周说过"不是钉），
 * 也不含偏好词（"喜欢"由 LLM 关键钉挑选负责），只保留用户主动要求"别忘"的高精度指令。
 */
export const KEY_PIN_INSTRUCTION_RE =
  /记住|帮我记着|帮我记住|记一下|别忘了|不要忘记|请记住/i;

/**
 * 跨会话回忆线索：命中说明用户想衔接「更早会话/窗口外」的内容。
 * 消费方：chat-thread-store（压缩保护）等事后文本扫描场景。
 * 每轮语义门控已改由 RouteDecision.understanding.recallIntent 承担，不再用词表。
 */
export const MEMORY_RECALL_HINT_RE =
  /上次|上回|之前|先前|早些时候|说过|谈过|提过|earlier|before|last time|you said/i;

export const AGENT_COMMITMENT_RE =
  /我会|我将|已为你|已经帮你|已设置|已创建|已添加|已安排|已提醒|已经记|已记下|已记录|记上了|记下来|记好啦|帮你记住|帮你查|结论是|建议是|remember to|i will|i've set/i;

export type MemorySignalResult = {
  isHighSignal: boolean;
  reasons: string[];
  extractLines: string[];
};

function firstSentence(text: string, maxLen: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return "";
  const cut = t.split(/[。！？?!\n]/)[0]?.trim() || t;
  return cut.length > maxLen ? `${cut.slice(0, maxLen)}...` : cut;
}

/**
 * 轮次归档信号（写入候选筛选，事后扫描）。
 * @param memoryInstruction 本轮用户是否要求记住/遗忘——由 L1 路由的
 *        understanding.memoryInstruction 提供（模型判定）；缺省 false。
 * @param personalFact 本轮用户是否在陈述关于自己的事实（名字/称呼/身份/
 *        家人/住所/计划）——由 L1 路由的 understanding.personalFact 提供；
 *        缺省 false。
 *        该信号此前只喂召回闸门（recall-gate），写入侧完全收不到：用户
 *        「以后叫我王哥」被 L1 正确判为 personal_fact，却因写入闸门只认
 *        memoryInstruction / 承诺话术而不进抽取链路，称呼永远落不进结构化
 *        事实库（2026-10-09 称呼事故）。现与显式记住同轨，均为高信号。
 */
export function detectMemorySignals(
  userText: string,
  assistantText: string,
  memoryInstruction = false,
  personalFact = false,
): MemorySignalResult {
  const user = userText.trim();
  const assistant = assistantText.trim();
  const reasons: string[] = [];
  const extractLines: string[] = [];

  if (memoryInstruction) {
    reasons.push("explicit_remember");
    extractLines.push(`[用户要求记住] ${firstSentence(user, 200)}`);
  }
  if (personalFact) {
    reasons.push("personal_fact");
    extractLines.push(`[用户事实] ${firstSentence(user, 200)}`);
  }
  if (AGENT_COMMITMENT_RE.test(assistant)) {
    reasons.push("agent_commitment");
    extractLines.push(`[Agent 承诺/结论] ${firstSentence(assistant, 200)}`);
  }

  const isHighSignal =
    reasons.includes("explicit_remember") ||
    reasons.includes("personal_fact") ||
    reasons.includes("agent_commitment");

  if (isHighSignal && extractLines.length === 0) {
    extractLines.push(`用户: ${firstSentence(user, 120)} | Agent: ${firstSentence(assistant, 120)}`);
  }

  return { isHighSignal, reasons, extractLines };
}
