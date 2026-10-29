/**
 * 平台登录交接（长流程 handoff 的购物入口）。
 *
 * 登录必须用户本人完成，所以走 handoff：交出执行权、说明「在哪做 / 做完怎么算完」，
 * 用户回执后由 Plan 续跑。落点是 task-plan：写一个两步计划（登录 → 继续比价），
 * 把第一步置成 awaiting_confirm 并带 handoff.instruction。浏览器页由调用方留在登录页，
 * 这里只负责「告诉用户要做什么 + 建可恢复的等待步」。
 */
import { getTaskPlanStore, taskPlanKey } from "./task-plan-store.js";

export interface PlatformLoginHandoffInput {
  actorId: string;
  sessionId: string;
  /** 平台显示名（京东 / 拼多多） */
  platformLabel: string;
  /** 任务一句话（写进计划 goal，续跑时给模型上下文） */
  goal: string;
}

export type PlatformLoginHandoffResult =
  | { ok: true; stepId: string }
  | { ok: false; error: string };

export function requestPlatformLoginHandoff(
  input: PlatformLoginHandoffInput,
): PlatformLoginHandoffResult {
  const store = getTaskPlanStore();
  if (!store) return { ok: false, error: "任务计划未装配" };
  const sessionId = String(input.sessionId ?? "").trim();
  const actorId = String(input.actorId ?? "").trim();
  if (!sessionId && !actorId) return { ok: false, error: "缺少会话标识" };
  const key = taskPlanKey({ sessionId, actorId });

  // 已经在等用户做的别叠：同一个等待步只打扰一次
  const blocking = store.blockingStep(key);
  if (blocking) {
    return { ok: false, error: `已有等待步：${blocking.title}` };
  }

  const label = input.platformLabel || "该平台";
  const goal = String(input.goal ?? "").trim() || `登录${label}后继续`;
  const written = store.write({
    actorId: actorId || key,
    sessionId,
    goal: goal.slice(0, 200),
    steps: [`登录${label}`, "继续抓取报价"],
  });
  if (!written.ok) return { ok: false, error: written.error };

  const step = written.plan.steps[0];
  const set = store.setStatus(written.plan.sessionId, step.id, "awaiting_confirm", undefined, {
    by: "agent",
    handoff: {
      instruction:
        `在内置浏览器里登录${label}（页面已经打开），登录完回我一句“好了”，` +
        `我接着把价格抓完。`,
      actions: [{ id: "done", label: "我已完成" }],
      checkMode: "user_confirm",
    },
  });
  if (!set.ok) return { ok: false, error: set.error };
  return { ok: true, stepId: step.id };
}
