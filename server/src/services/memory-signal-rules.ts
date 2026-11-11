/**
 * 记忆信号规则统一出口（P1-1）。
 *
 * 此前「会话状态槽」（STM gateway）与「当日日志派生」（daily-journal）各持一份
 * fact/prefer/commit 正则，已经出现漂移：`我叫X` / `我在X工作` 在 journal 记为
 * fact，但 STM 的会话事实槽不记。规则散落意味着同一句话在不同层有不同判定，
 * 下游（夜间固化 / 召回）拿到的标签也不一致。
 *
 * 本模块是这些规则的唯一源头：新增/调整句式只改这里。
 * 注意：STM 的「助手未来承诺」判定（带疑问排除）语义更严格，服务的是会话
 * 挂起栈而不是日志标签，保留在 STM 内部，不复用这里的宽松版本。
 */

/** 用户事实陈述（身份/职业/居住/计划等确定性信息） */
export const USER_FACT_RE =
  /我是|我在做|我最近在|我的项目|我正在|我计划|我住在|我需要|我叫|我在.*工作/i;

/** 用户偏好陈述（喜好/讨厌/习惯/禁忌/纪念日） */
export const USER_PREFERENCE_RE =
  /喜欢|讨厌|偏好|习惯|不要|别|禁忌|生日|纪念日|remember|prefer/i;

/** 助手承诺话术（日志层宽松标签：入库后按低一档重要性正常淡出） */
const ASSISTANT_COMMITMENT_RE =
  /我会|我将|已经帮你|已为你|稍后|接下来|我帮你|i will|i'll/i;

export type MemorySentenceRole = "fact" | "prefer" | "commit";

/**
 * 单句记忆角色判定（journal 派生行 / STM 事实台账共用）。
 * 顺序有意为之：事实优先于偏好（「我住在杭州」同时命中「在」类偏好词时以事实为准）。
 */
export function classifyMemorySentence(
  sentence: string,
  speaker: "user" | "assistant",
): MemorySentenceRole | null {
  if (!sentence) return null;
  if (speaker === "user") {
    if (USER_FACT_RE.test(sentence)) return "fact";
    if (USER_PREFERENCE_RE.test(sentence)) return "prefer";
    return null;
  }
  return ASSISTANT_COMMITMENT_RE.test(sentence) ? "commit" : null;
}
