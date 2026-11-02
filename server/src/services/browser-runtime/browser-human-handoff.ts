/**
 * 浏览器层人工交接（通用 handoff）。
 *
 * 主流 Browser Agent 的 human checkpoint：跑到登录墙/验证码这类只有用户本人能做
 * 的环节 → 停下、把页面留给用户、用户回执后同一任务续跑。落点仍是 task-plan
 * 的等待步（客户端已有「我已完成，继续下一步」按钮），所有浏览器能力共用。
 *
 * 多个站点在同一轮都需要用户时合并成**一次**交接，不逐站点各弹一条。
 */
import { getTaskPlanStore, taskPlanKey } from "../../agent/task-plan-store.js";

export interface BrowserHumanHandoffInput {
  actorId: string;
  sessionId: string;
  /** 站点/平台显示名（京东 / 携程 / 某网站） */
  siteLabels: string[];
  /** login=登录墙；captcha=安全验证（滑块/验证码） */
  reason: "login" | "captcha";
  /** 任务一句话（写进计划 goal，续跑时给模型上下文） */
  goal?: string;
  /** 第二步文案（默认「继续原来的任务」；购物等可传「继续抓取报价」） */
  continueStep?: string;
}

export type BrowserHumanHandoffResult =
  | { ok: true; stepId: string }
  | { ok: false; error: string };

export function requestBrowserHumanHandoff(
  input: BrowserHumanHandoffInput,
): BrowserHumanHandoffResult {
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

  const labels = Array.from(
    new Set((input.siteLabels ?? []).map((s) => String(s ?? "").trim()).filter(Boolean)),
  );
  const label = labels.length > 0 ? labels.join("、") : "该站点";
  const reason = input.reason === "captcha" ? "captcha" : "login";
  const goal =
    String(input.goal ?? "").trim() ||
    (reason === "login"
      ? `登录${label}后继续`
      : `完成${label}的安全验证后继续`);
  const firstStep = reason === "login" ? `登录${label}` : `完成${label}的安全验证`;
  const continueStep = String(input.continueStep ?? "").trim() || "继续原来的任务";

  const written = store.write({
    actorId: actorId || key,
    sessionId,
    goal: goal.slice(0, 200),
    steps: [firstStep, continueStep],
  });
  if (!written.ok) return { ok: false, error: written.error };

  const step = written.plan.steps[0];
  const instruction =
    reason === "login"
      ? `在内置浏览器里登录${label}（页面已经打开），登录完点「我已完成」（或回我一句“好了”），我接着继续：${continueStep}。`
      : `${label}需要你本人完成安全验证（滑块/验证码），页面已经停在那里，` +
        `验证完点「我已完成」（或回我一句“好了”），我接着继续：${continueStep}。`;
  const set = store.setStatus(written.plan.sessionId, step.id, "awaiting_confirm", undefined, {
    by: "agent",
    handoff: {
      instruction,
      actions: [{ id: "done", label: "我已完成" }],
      checkMode: "user_confirm",
    },
  });
  if (!set.ok) return { ok: false, error: set.error };
  return { ok: true, stepId: step.id };
}
