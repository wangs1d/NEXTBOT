import type { ToolHandler, ToolContext, ToolRegistry } from "../../tool-registry.js";
import { resolveActorId } from "../../../agent/actor-id.js";
import type { GoalPlanner } from "../../../proactivity/goal-planner.js";

/**
 * goal.plan.* 工具 handler + 注册入口。
 *
 * 执行全部经 GoalPlanner（proactivity/goal-planner.ts）：推进/外部步骤确认闸/
 * TaskHub 终态回调自动推进都在服务层闭环，handler 只做入参清洗。
 */
export interface GoalPlanningModuleDeps {
  /** 装配层晚绑定（CapabilityModuleDeps 在服务建成前构造）；未绑定时工具如实报未装配 */
  goalPlanner?: GoalPlanner | null;
}

function requirePlanner(deps: GoalPlanningModuleDeps): GoalPlanner | null {
  return deps.goalPlanner ?? null;
}

const NOT_READY = { ok: false, error: "计划推进能力未装配（GoalPlanner 未初始化）" } as const;

export function createPlanCreateHandler(deps: GoalPlanningModuleDeps): ToolHandler {
  return async (input: Record<string, unknown>, context: ToolContext) => {
    const planner = requirePlanner(deps);
    if (!planner) return NOT_READY;
    const actorId = resolveActorId(context);
    const title = typeof input.title === "string" ? input.title.trim() : "";
    const steps = Array.isArray(input.steps)
      ? input.steps.filter((s): s is string => typeof s === "string" && s.trim().length > 0)
      : [];
    const result = planner.createPlan({
      actorId,
      ...(context.sessionId ? { sessionId: context.sessionId } : {}),
      title,
      steps,
      ...(typeof input.successCriteria === "string" && input.successCriteria.trim()
        ? { successCriteria: input.successCriteria.trim() }
        : {}),
      ...(typeof input.note === "string" && input.note.trim() ? { note: input.note.trim() } : {}),
    });
    if (!result.ok) return result;
    const preferences = (result.goal.payload as { preferences?: string } | undefined)?.preferences;
    return {
      ok: true,
      goalId: result.goal.goalId,
      title: result.goal.title,
      successCriteria: result.goal.successCriteria,
      ...(preferences ? { preferences } : {}),
      steps: planner.stepsOf(result.goal).map((s) => ({ id: s.id, title: s.title, sensitivity: s.sensitivity })),
      hint: "已建档并开始推进。向用户复述拆步结果（一两句），外部操作步骤会先征求意见",
    };
  };
}

export function createPlanListHandler(deps: GoalPlanningModuleDeps): ToolHandler {
  return async (_input: Record<string, unknown>, context: ToolContext) => {
    const planner = requirePlanner(deps);
    if (!planner) return NOT_READY;
    const actorId = resolveActorId(context);
    const plans = planner.listPlans(actorId).map((g) => ({
      goalId: g.goalId,
      title: g.title,
      progress: planner.progressLine(g),
      steps: planner.stepsOf(g).map((s) => ({ id: s.id, title: s.title, status: s.status })),
      // 模板带来的结果形态偏好：产出时按这个口径给（同类目标第二次不再走 LLM 拆步）
      preferences: (g.payload as { preferences?: string } | undefined)?.preferences,
      lastReplanReason: (g.payload as { lastReplanReason?: string } | undefined)?.lastReplanReason,
    }));
    return { ok: true, count: plans.length, plans };
  };
}

export function createPlanAdvanceHandler(deps: GoalPlanningModuleDeps): ToolHandler {
  return async (input: Record<string, unknown>, context: ToolContext) => {
    const planner = requirePlanner(deps);
    if (!planner) return NOT_READY;
    const actorId = resolveActorId(context);
    const goalId = typeof input.goalId === "string" ? input.goalId.trim() : "";
    if (!goalId) return { ok: false, error: "缺少 goalId" };
    const confirmExternal = input.confirmExternal === true;
    const outcome = planner.advance(goalId, actorId, { confirmExternal });
    if (!outcome.ok) return outcome;
    return outcome;
  };
}

export function createPlanStepHandler(deps: GoalPlanningModuleDeps): ToolHandler {
  return async (input: Record<string, unknown>, context: ToolContext) => {
    const planner = requirePlanner(deps);
    if (!planner) return NOT_READY;
    const actorId = resolveActorId(context);
    const goalId = typeof input.goalId === "string" ? input.goalId.trim() : "";
    const stepId = typeof input.stepId === "string" ? input.stepId.trim() : "";
    const status = input.status === "done" || input.status === "failed" || input.status === "skipped" ? input.status : null;
    if (!goalId || !stepId || !status) {
      return { ok: false, error: "goalId/stepId/status 必填（status: done|failed|skipped）" };
    }
    return planner.markStep(
      goalId,
      actorId,
      stepId,
      status,
      typeof input.note === "string" ? input.note : undefined,
    );
  };
}

export function createPlanReplanHandler(deps: GoalPlanningModuleDeps): ToolHandler {
  return async (input: Record<string, unknown>, context: ToolContext) => {
    const planner = requirePlanner(deps);
    if (!planner) return NOT_READY;
    const actorId = resolveActorId(context);
    const goalId = typeof input.goalId === "string" ? input.goalId.trim() : "";
    const steps = Array.isArray(input.steps)
      ? input.steps.filter((s): s is string => typeof s === "string" && s.trim().length > 0)
      : [];
    if (!goalId) return { ok: false, error: "缺少 goalId" };
    const result = planner.replan(
      goalId,
      actorId,
      steps,
      typeof input.reason === "string" ? input.reason : undefined,
    );
    if (!result.ok) return result;
    return {
      ok: true,
      goalId,
      progress: planner.progressLine(result.goal),
      steps: planner.stepsOf(result.goal).map((s) => ({ id: s.id, title: s.title, status: s.status })),
    };
  };
}

export function createPlanAbandonHandler(deps: GoalPlanningModuleDeps): ToolHandler {
  return async (input: Record<string, unknown>, context: ToolContext) => {
    const planner = requirePlanner(deps);
    if (!planner) return NOT_READY;
    const actorId = resolveActorId(context);
    const goalId = typeof input.goalId === "string" ? input.goalId.trim() : "";
    if (!goalId) return { ok: false, error: "缺少 goalId" };
    const reason = typeof input.reason === "string" ? input.reason : "";
    if (!reason.trim()) return { ok: false, error: "放弃计划需要给出原因" };
    return planner.abandon(goalId, actorId, reason);
  };
}

export function registerGoalPlanningTools(registry: ToolRegistry, deps: GoalPlanningModuleDeps): void {
  registry.register("goal.plan.create", createPlanCreateHandler(deps));
  registry.register("goal.plan.list", createPlanListHandler(deps));
  registry.register("goal.plan.advance", createPlanAdvanceHandler(deps));
  registry.register("goal.plan.step", createPlanStepHandler(deps));
  registry.register("goal.plan.replan", createPlanReplanHandler(deps));
  registry.register("goal.plan.abandon", createPlanAbandonHandler(deps));
}
