import type { ToolHandler, ToolContext, ToolRegistry } from "../../tool-registry.js";
import { resolveActorId } from "../../../agent/actor-id.js";
import {
  getTaskPlanStore,
  isTaskPlanStepStatus,
  taskPlanKey,
  TASK_PLAN_MAX_STEPS,
  type TaskPlanHandoff,
} from "../../../agent/task-plan-store.js";
import type { GoalPlanner } from "../../../proactivity/goal-planner.js";
import { buildStepsFromTemplate, matchGoalTemplate } from "../../../proactivity/goal-templates.js";

/**
 * plan.* 工具 handler。
 *
 * 两层语义用一个入口（2026-10-19）：
 *  - scope=session（默认）→ TaskPlanStore：会话内多步、完成即归档
 *  - scope=goal          → GoalPlanner：跨会话长期目标（带预算/自主推进/验收）
 * 合并的理由：模型不用在两个近似工具间犹豫；长期目标仍走原有闭环，不复制逻辑。
 *
 * 两者都支持「不传 steps → 按模板自动生成」（省一次 LLM 拆步，同类目标越用越快）。
 */
export interface TaskPlanModuleDeps {
  /** 装配层晚绑定；未绑定时 scope=goal 如实报未装配 */
  goalPlanner?: GoalPlanner | null;
}

const NOT_READY = { ok: false, error: "任务计划能力未装配（TaskPlanStore 未初始化）" } as const;

function asStepTitles(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((s): s is string => typeof s === "string" && s.trim().length > 0).map((s) => s.trim())
    : [];
}

/** 不传步骤时的模板补全（命中 出行/搬家/备考/装修/求职） */
function stepsWithTemplate(
  title: string,
  steps: string[],
  note?: string,
): { steps: string[]; templateId?: string } {
  if (steps.length > 0) return { steps };
  const tpl = matchGoalTemplate(title);
  if (!tpl) return { steps };
  return { steps: buildStepsFromTemplate(tpl, note), templateId: tpl.id };
}

/** 计划主键：actorId 优先（与 prompt 注入、软提示、事件订阅统一走这里） */
function planKeyOf(context: ToolContext): string {
  return taskPlanKey({ actorId: resolveActorId(context), sessionId: context.sessionId });
}

export function createTaskPlanWriteHandler(deps: TaskPlanModuleDeps = {}): ToolHandler {
  return async (input: Record<string, unknown>, context: ToolContext) => {
    const goal = typeof input.goal === "string" ? input.goal.trim() : "";
    const note = typeof input.note === "string" ? input.note.trim() : undefined;
    const scope = input.scope === "goal" ? "goal" : "session";
    const mode = input.mode === "replace" ? "replace" : "new";

    if (scope === "goal") {
      const planner = deps.goalPlanner;
      if (!planner) return { ok: false, error: "长期目标能力未装配（GoalPlanner 未初始化）" };
      const result = planner.createPlan({
        actorId: resolveActorId(context),
        ...(context.sessionId ? { sessionId: context.sessionId } : {}),
        title: goal,
        steps: asStepTitles(input.steps),
        ...(note ? { note } : {}),
        ...(typeof input.successCriteria === "string" && input.successCriteria.trim()
          ? { successCriteria: input.successCriteria.trim() }
          : {}),
      });
      if (!result.ok) return result;
      return {
        ok: true,
        scope: "goal",
        goalId: result.goal.goalId,
        title: result.goal.title,
        successCriteria: result.goal.successCriteria,
        steps: planner.stepsOf(result.goal).map((s) => ({ id: s.id, title: s.title, status: s.status })),
        hint: "已立长期目标（跨会话推进、有每日预算）。向用户复述一两句即可，外部动作会先征求意见",
      };
    }

    const store = getTaskPlanStore();
    if (!store) return NOT_READY;
    const prepared = stepsWithTemplate(goal, asStepTitles(input.steps), note);
    const result = store.write({
      sessionId: context.sessionId,
      actorId: resolveActorId(context),
      goal,
      steps: prepared.steps,
      mode,
    });
    if (!result.ok) return result;
    return {
      ok: true,
      scope: "session",
      planId: result.plan.planId,
      templateId: prepared.templateId,
      progress: store.progressLine(result.plan),
      steps: result.plan.steps.map((s) => ({ id: s.id, title: s.title, status: s.status })),
      hint: "步骤已显示给用户。接下来按步骤执行，每完成一步用 plan.set_status 更新（一句话报进度即可，别播报整张表）",
    };
  };
}

/** 解析 handoff 载荷（status=awaiting_confirm 时用） */
function parseHandoff(value: unknown): Omit<TaskPlanHandoff, "since" | "remindCount"> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const instruction = typeof raw.instruction === "string" ? raw.instruction.trim() : "";
  if (!instruction) return undefined;
  const actionsRaw = Array.isArray(raw.actions) ? raw.actions : [];
  const actions = actionsRaw
    .filter((a): a is Record<string, unknown> => typeof a === "object" && a !== null)
    .map((a, i) => ({
      id: typeof a.id === "string" && a.id.trim() ? a.id.trim() : `a${i + 1}`,
      label: typeof a.label === "string" ? a.label.trim() : "",
      ...(typeof a.url === "string" && a.url.trim() ? { url: a.url.trim() } : {}),
    }))
    .filter((a) => a.label);
  const checkMode = raw.checkMode === "probe" ? "probe" as const : "user_confirm" as const;
  const probeRaw = typeof raw.probe === "object" && raw.probe !== null ? raw.probe as Record<string, unknown> : null;
  const probeTool = probeRaw && typeof probeRaw.tool === "string" ? probeRaw.tool.trim() : "";
  return {
    instruction,
    checkMode,
    ...(actions.length > 0 ? { actions } : {}),
    ...(probeTool ? {
      probe: {
        tool: probeTool,
        ...(typeof probeRaw?.args === "object" && probeRaw?.args ? { args: probeRaw.args as Record<string, unknown> } : {}),
        ...(typeof probeRaw?.expect === "string" ? { expect: probeRaw.expect } : {}),
      },
    } : {}),
    ...(typeof raw.idempotencyKey === "string" && raw.idempotencyKey.trim()
      ? { idempotencyKey: raw.idempotencyKey.trim() }
      : {}),
  };
}

export function createTaskPlanSetStatusHandler(): ToolHandler {
  return async (input: Record<string, unknown>, context: ToolContext) => {
    const store = getTaskPlanStore();
    if (!store) return NOT_READY;
    const stepId = typeof input.stepId === "string" ? input.stepId.trim() : "";
    if (!stepId) return { ok: false, error: "缺少 stepId" };
    if (!isTaskPlanStepStatus(input.status)) {
      return { ok: false, error: "status 非法（pending|running|done|failed|skipped|awaiting_confirm）" };
    }
    const handoff = parseHandoff(input.handoff);
    // 进入等待必须给交接说明，否则把错误就地讲清楚（别等用户点了才发现恢复不了）
    if (input.status === "awaiting_confirm" && !handoff) {
      return {
        ok: false,
        error:
          "置 awaiting_confirm 时必须带 handoff.instruction（一句话：要用户在哪儿做什么），" +
          '例如 {"instruction":"在美团点一份麻辣烫送到公司","actions":[{"id":"open","label":"打开美团"}]}',
      };
    }
    const result = store.setStatus(
      planKeyOf(context),
      stepId,
      input.status,
      typeof input.note === "string" ? input.note : undefined,
      { by: "agent", ...(handoff ? { handoff } : {}) },
    );
    if (!result.ok) return result;
    return {
      ok: true,
      step: { id: result.step.id, title: result.step.title, status: result.step.status },
      progress: store.progressLine(result.plan),
      ...(result.step.status === "awaiting_confirm"
        ? {
            waiting: true,
            hint: "已停下来等用户操作。不要自己再调外部动作工具；用户完成后系统会继续。",
          }
        : {}),
    };
  };
}

export function createTaskPlanReplanHandler(): ToolHandler {
  return async (input: Record<string, unknown>, context: ToolContext) => {
    const store = getTaskPlanStore();
    if (!store) return NOT_READY;
    const result = store.replan(
      planKeyOf(context),
      asStepTitles(input.steps),
      typeof input.reason === "string" ? input.reason : undefined,
    );
    if (!result.ok) return result;
    return {
      ok: true,
      progress: store.progressLine(result.plan),
      steps: result.plan.steps.map((s) => ({ id: s.id, title: s.title, status: s.status })),
    };
  };
}

export function createTaskPlanReadHandler(): ToolHandler {
  return async (_input: Record<string, unknown>, context: ToolContext) => {
    const store = getTaskPlanStore();
    if (!store) return NOT_READY;
    const key = planKeyOf(context);
    const plan = store.get(key);
    if (!plan) {
      return {
        ok: true,
        hasPlan: false,
        hint: "本会话还没有计划；若这轮是多步任务，可以先用 plan.write 记下步骤",
      };
    }
    const blocking = store.blockingStep(key);
    return {
      ok: true,
      hasPlan: true,
      planId: plan.planId,
      goal: plan.goal,
      progress: store.progressLine(plan),
      steps: plan.steps.map((s) => ({
        id: s.id,
        title: s.title,
        status: s.status,
        ...(s.note ? { note: s.note } : {}),
        ...(s.handoff ? { handoff: s.handoff } : {}),
      })),
      ...(blocking
        ? {
            blocked: true,
            blockingStepId: blocking.id,
            blockingInstruction: blocking.handoff?.instruction,
            hint: "这一步在等用户操作，不能自己放行；用户回执后系统会继续",
          }
        : {}),
    };
  };
}

export function registerTaskPlanTools(registry: ToolRegistry, deps: TaskPlanModuleDeps = {}): void {
  registry.register("plan.write", createTaskPlanWriteHandler(deps));
  registry.register("plan.set_status", createTaskPlanSetStatusHandler());
  registry.register("plan.replan", createTaskPlanReplanHandler());
  registry.register("plan.read", createTaskPlanReadHandler());
}

export { TASK_PLAN_MAX_STEPS };
