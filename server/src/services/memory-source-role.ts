/**
 * 记忆来源角色分类（root fix，2026-09 复盘）
 *
 * 背景：记忆图谱此前不区分"谁说的"——助手回复（含调侃、猜测、求证）与用户断言
 * 同权写入、同权召回。2026-09 案例中助手把"用户搜过景甜照片"脑补成"用户说老婆是
 * 景甜"，这句敷衍回复被固化成知识节点，之后每次同类提问都以最高相似度召回该旧
 * 回复，模型照着再敷衍一遍，形成自我强化的回声循环。
 *
 * 根因治理原则：
 * 1. 每条记忆写入时打上 sourceRole（用户/助手/混合/系统/工具），落 metadata.sourceRole；
 * 2. 只有用户的话（sourceRole=user）可以定义"用户事实"、触发同主题覆盖；
 * 3. 助手自己的历史发言召回时降权；其中"同一问题我上次怎么答的"回声节点直接剔除。
 *
 * 识别按文本形态（各写入链路的行格式稳定）：日志固化的 ·用户/·助手/·fact/·prefer/·commit、
 * EvolutionLoop 的 user="/reply="、fast-path 的 [用户要求记住]、整合链路的 承诺： 前缀。
 */

export type MemorySourceRole = "user" | "assistant" | "mixed" | "tool" | "system" | "unknown";

/**
 * 用户是否在明确询问「助手说过/答应过什么」。
 * 只有这类询问才允许助手发言进入召回；其余（我叫什么、我多大）一律不把助手发言
 * 当证据——否则当时的一句调侃/猜测会被当成用户事实复述。
 */
const ASSISTANT_VOICE_QUERY_RE =
  /你说过|你上次说|你之前说|你当时说|你跟我(?:说|讲)|你答应|你承诺|你回复|你怎么回答|你告诉我的|问过你/;

/** 召回意图判定：允许助手自己的历史发言作为答案来源。 */
export function isAssistantVoiceQuery(query: string): boolean {
  return ASSISTANT_VOICE_QUERY_RE.test(query ?? "");
}

const JOURNAL_USER_RE = /日志固化[^\]]*·(?:用户|fact|prefer)\]/;
const JOURNAL_ASSISTANT_RE = /日志固化[^\]]*·(?:助手|commit|Agent)\]/;
const USER_REMEMBER_RE = /\[用户要求记住\]/;
const AGENT_PROMISE_RE = /Agent 承诺\/结论|\[?承诺：/;
const TOOL_EVENT_RE = /工具调用成功|Tool interaction/i;
const TURN_ARCHIVE_RE = /^\s*(?:Turn archive|Turn \|)/;

/** 从 EvolutionLoop 行里抽取被回答的用户原话（user="…"），供回声检测比对当前 query。
 *  生产数据里该行是二次 JSON 序列化文本，引号常为转义形态（user=\"…\"），需兼容。 */
export function extractEchoQueryFromAssistantReply(text: string): string | null {
  const m = text.match(/user=\\{0,2}["']([^"'\\]{2,80})/);
  const q = m?.[1]?.trim();
  return q ? q : null;
}

export function classifyMemorySourceRole(rawText: string): MemorySourceRole {
  const text = (rawText ?? "").trim();
  if (!text) return "system";
  // dream:replay / dream:reinforce 前缀是夜间巩固的再入行为，角色看内层文本
  const stripped = text.replace(/^dream:\w+\s*\|\s*/g, "").trim();

  const hasUser = JOURNAL_USER_RE.test(stripped) || USER_REMEMBER_RE.test(stripped);
  const hasAssistant = JOURNAL_ASSISTANT_RE.test(stripped) || AGENT_PROMISE_RE.test(stripped);

  if (/EvolutionLoop:/i.test(stripped)) {
    if (/reply=\\{0,2}["']/.test(stripped)) return "assistant"; // assistantDone：内容主体是助手自己的回复
    if (/user=\\{0,2}["']/.test(stripped)) return "user";
    return "system";
  }
  if (hasUser && hasAssistant) return "mixed";
  if (hasUser) return "user";
  if (hasAssistant) return "assistant";
  if (TOOL_EVENT_RE.test(stripped)) return "tool";
  if (TURN_ARCHIVE_RE.test(stripped) || /user[:=].+agent[:=]/i.test(stripped)) return "mixed";
  return "unknown";
}
