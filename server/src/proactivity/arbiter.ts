// 仲裁层（唯一决策口）：效用评估（声明了 utility 的提案）→ 保质期 → 负反馈抑制
// → 分层预算 → 在场择时。
// 纯规则零 LLM（LLM 只出现在 speak 话术生成与可选竞争仲裁），确定可测。
import { deriveNotifyValue, evaluateActionUtility, isUtilityEvalEnabled, type ActionUtilityResult } from "./action-utility.js";
import type { ArbitrationDecision, ProactiveProposal, PresenceState } from "./pipeline-types.js";

export type GovernorVerdict = { allowed: boolean; reason: string };

export type ArbiterContext = {
  now: number;
  presence: PresenceState;
  /** 对话进行中：active 且 90s 内有交互（非 interruptible 提案短延迟，不打断） */
  inConversation: boolean;
  isSuppressed: (actorId: string, kind: string, text: string) => { suppressed: boolean; reason: string };
  /** 社交层预算查询（FrequencyGovernor.canTrigger 薄包装；must 层不查） */
  socialCanTrigger: (actorId: string, kind: string, importance: "high" | "medium" | "low") => GovernorVerdict;
};

/** 对话进行中的判定窗口 */
export const IN_CONVERSATION_WINDOW_MS = 90_000;
/** 对话中被打断提案的短延迟 */
export const CONVERSATION_DEFER_MS = 90_000;
/** 投递竞态重试间隔（仲裁时在线、发送时已全部掉线 → 待发区保留稍后重试，重连即达） */
export const DELIVERY_RETRY_MS = 30_000;


export function arbitrate(p: ProactiveProposal, ctx: ArbiterContext): ArbitrationDecision {
  // 效用评估（方案 A/B，仲裁链最前面）：声明了 utility 的提案先过三分支判定。
  //   silence → verdict=silenced（与 suppressed 区分：效用评估后主动选择不动作）；
  //   ask_first / execute_silently → 记入 reasonChain 继续走后续仲裁
  //   （ask_first 的提案以确认请求文案投递；execute_silently 的通知类提案投递即执行）。
  // 未声明 utility 的提案不评估——既有触发源仲裁行为完全不变。
  let utilityResult: ActionUtilityResult | undefined;
  if (p.utility && isUtilityEvalEnabled()) {
    utilityResult = evaluateActionUtility({
      kind: p.kind,
      title: p.title,
      risk: p.utility.risk,
      authorization: p.utility.authorization,
      value: p.utility.value ?? deriveNotifyValue(p.importance),
    });
    if (utilityResult.branch === "silence") {
      return {
        proposal: p,
        verdict: "silenced",
        reasonChain: [`action_utility_silence:${utilityResult.reason}`],
        utility: utilityResult,
      };
    }
  }
  const chain: string[] = [];
  if (utilityResult) chain.push(`action_utility:${utilityResult.branch}:${utilityResult.reason}`);
  if (p.expiresAt !== undefined && p.expiresAt < ctx.now) {
    return { proposal: p, verdict: "expired", reasonChain: [...chain, "expired"], utility: utilityResult };
  }
  const suppression = ctx.isSuppressed(p.actorId, p.kind, `${p.title} ${p.summary}`);
  if (suppression.suppressed) {
    return {
      proposal: p,
      verdict: "suppressed",
      reasonChain: [...chain, `negative_feedback:${suppression.reason}`],
      utility: utilityResult,
    };
  }
  // 未到「最早可发时刻」（§3.4 触点排槽把这条语义用到了极致：候选排进 20:00 的槽，
  // deliverAfter 就是槽位窗口起点）。此前这层判据只由 flushDue 的过滤承担，提交路径
  // 少了一环——排到未来的槽会在提交那一刻直接弹出，触点计划当场形同虚设。
  // 放在抑制判定之后：用户明确说过的「别再提这类」不必等到槽位时间才丢弃。
  if (p.deliverAfter !== undefined && p.deliverAfter > ctx.now) {
    return {
      proposal: p,
      verdict: "deferred",
      reasonChain: [...chain, `wait_until:${new Date(p.deliverAfter).toISOString()}`],
      deliverAfter: p.deliverAfter,
      utility: utilityResult,
    };
  }
  // 分层频控：must 层（用户点名要的事）绕过社交预算，不占社交配额
  if (p.tier === "social") {
    const importance = (p.importance === "critical" ? "high" : p.importance) as "high" | "medium" | "low";
    const verdict = ctx.socialCanTrigger(p.actorId, p.kind, importance);
    if (!verdict.allowed) {
      return {
        proposal: p,
        verdict: "throttled",
        reasonChain: [...chain, `frequency_governor:${verdict.reason}`],
        utility: utilityResult,
      };
    }
  } else {
    chain.push("tier=must_bypass_social_budget");
  }
  // 在场择时：两端都不在线 → 挂起待重连（不落离线信箱；任一设备重连后 flush 立即直推）。
  // 对话中且不打断 → 短延迟（本轮对话结束再发，仅 social 层；must 层是用户点名要的事，即时直推）。
  // critical 默认允许打断。
  if (ctx.presence === "offline") {
    return {
      proposal: p,
      verdict: "deferred",
      reasonChain: [...chain, "offline_wait_reconnect"],
      deliverAfter: p.deliverAfter,
      utility: utilityResult,
    };
  }
  const interruptible = p.interruptible ?? p.importance === "critical";
  if (ctx.inConversation && p.tier !== "must" && !interruptible) {
    return {
      proposal: p,
      verdict: "deferred",
      reasonChain: [...chain, "in_conversation_defer_90s"],
      deliverAfter: ctx.now + CONVERSATION_DEFER_MS,
      utility: utilityResult,
    };
  }
  return { proposal: p, verdict: "delivered", reasonChain: [...chain, "deliver_now"], utility: utilityResult };
}
