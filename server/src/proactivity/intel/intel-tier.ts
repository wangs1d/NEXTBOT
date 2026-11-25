// 情报条目的投递层级（2026-11-25 接缝 3）。
//
// 旧行为：情报链判断为「值得说」后恒以 tier=must 直投——它绕开了触点计划，
// 于是同一天里「邮件说一句、pulse 说一句、日程规则再说一句」各说各的，节奏随机。
//
// 新口径：**只有真的等不了的情报才是 must**（要用户拍板、或马上失效），其余降为
// social，进当天的触点槽与其它候选合并说。判断「值不值得说」仍归情报判断，
// 这里只管「用哪条通道说、什么时候说」——确定性层，不复用 LLM。
import type { IntelEntry } from "./intel-types.js";

/** must 的时间窗：过期时刻落在这个窗口内 = 排进触点就可能来不及 */
export const INTEL_MUST_WINDOW_MS = 4 * 60 * 60_000;

export type IntelTierDecision = {
  tier: "must" | "social";
  /** 决策原因（写进 evidence，诊断可查） */
  reason: "split_disabled" | "needs_confirm" | "expiring_soon" | "can_slot";
};

/**
 * 情报条目该走 must 还是 social。
 * `INTEL_TIER_SPLIT=0` 一键回退旧行为（全部 must 直投），便于灰度与回滚。
 */
export function intelTierFor(
  entry: Pick<IntelEntry, "judgment" | "expiresAt">,
  now: number,
  env: Record<string, string | undefined> = process.env,
): IntelTierDecision {
  if (env.INTEL_TIER_SPLIT === "0") return { tier: "must", reason: "split_disabled" };
  // 要用户回一句才算闭环的事，等触点会误事（确认类消息的价值随时间衰减最快）
  if (entry.judgment?.needsConfirm === true) return { tier: "must", reason: "needs_confirm" };
  const expiresAt = entry.expiresAt ?? entry.judgment?.expiresAt;
  if (expiresAt !== undefined && expiresAt - now <= INTEL_MUST_WINDOW_MS) {
    return { tier: "must", reason: "expiring_soon" };
  }
  return { tier: "social", reason: "can_slot" };
}
