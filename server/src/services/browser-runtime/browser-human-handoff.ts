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
  /**
   * 自动检测配置（2026-11-02 用户拍板：handoff 不要求用户点按钮）。
   * 传入后 checkMode=probe：TaskPlanProbeRunner 按 probeGapMs 轮询探测工具，
   * 探测到「墙已清除」（expect 命中）即自动置 done 并起受控续跑——用户在
   * 前台完成登录/验证就行，不用回聊天里点任何东西。`我已完成` 按钮保留
   * 作兜底（自动检测漏网时用户仍可手动收回）。
   */
  probe?: { tool: string; args?: Record<string, unknown>; expect?: string; gapMs?: number };
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
  const autoDetect = input.probe != null;
  const instruction = autoDetect
    ? reason === "login"
      ? `已在内置浏览器打开${label}的页面并弹出登录框：请你在前台页面完成扫码或账号登录（我不会接触你的账号密码）。我会自动检测登录状态——检测到登录成功就自动继续：${continueStep}，你不需要回来点任何按钮。若等久了也可点「我已完成」提醒我。`
      : `${label}需要完成安全验证（滑块/验证码），页面已停在前台：请你在页面上完成验证。我会自动检测——验证通过就自动继续：${continueStep}，你不需要回来点任何按钮。若等久了也可点「我已完成」提醒我。`
    : reason === "login"
      ? `在内置浏览器里登录${label}（页面已经打开），登录完点「我已完成」（或回我一句“好了”），我接着继续：${continueStep}。`
      : `${label}需要你本人完成安全验证（滑块/验证码），页面已经停在那里，` +
        `验证完点「我已完成」（或回我一句“好了”），我接着继续：${continueStep}。`;
  const probe = input.probe
    ? {
        tool: input.probe.tool,
        ...(input.probe.args ? { args: input.probe.args } : {}),
        ...(input.probe.expect ? { expect: input.probe.expect } : {}),
      }
    : undefined;
  const set = store.setStatus(written.plan.sessionId, step.id, "awaiting_confirm", undefined, {
    by: "agent",
    handoff: {
      instruction,
      actions: [{ id: "done", label: "我已完成" }],
      checkMode: autoDetect ? "probe" : "user_confirm",
      ...(probe ? { probe } : {}),
      ...(input.probe?.gapMs ? { probeGapMs: input.probe.gapMs } : {}),
    },
  });
  if (!set.ok) return { ok: false, error: set.error };
  return { ok: true, stepId: step.id };
}
