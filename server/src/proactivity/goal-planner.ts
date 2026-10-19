/**
 * GoalPlanner —— 计划推进型目标（2026-09-24，对标 Muse「大目标 → 计划 → 自主推进 →
 * 动态调整」的本地落地，五层主动性架构 L4 的第三类目标）。
 *
 * 与 track（盯一件事）/ preexec（备一件事）互补：plan = 拆成步骤的长期目标，
 * 每步派后台任务面执行（agentCore.dispatchBackgroundTask），TaskHub 终态回调
 * 自动推进下一步；全部完成 → GoalBoard.markReady 进 ReadyTray，经 goal_ready
 * 评估器挑时机投递「计划完成」摘要。
 *
 * 敏感动作边界（security/sensitive-action 定轴）：步骤描述命中外部副作用词
 * （下单/支付/代发/外呼…）时不自动派发，转 awaiting_confirm 等用户点头——
 * agent 自主推进到外部世界的门口必须停下（Muse 的"需要批准时回来找你" +
 * Shopify 默认 handoff 同构）。确认后经 advance({confirmExternal:true}) 放行。
 *
 * 动态调整 = replan：替换尚未完成的步骤（已完成/失败步保留存档），生活变化
 * （出差/生病/改主意）后模型在对话中调 goal.plan.replan 重排。
 */
import type { GoalBoard, GoalRecord } from "./goal-board.js";
import { verifyDeterministic } from "./goal-verifier.js";
import { buildStepsFromTemplate, formatTemplatePreferences, matchGoalTemplate } from "./goal-templates.js";
import { classifyTextSensitivity, type ActionSensitivity } from "../security/sensitive-action.js";
import type { TaskHub } from "../task-plane/task-hub.js";

export type PlanStepStatus = "todo" | "doing" | "awaiting_confirm" | "done" | "failed" | "skipped";

export interface PlanStep {
  id: string;
  title: string;
  status: PlanStepStatus;
  /** 敏感分级（创建时按标题判定；external 步骤不自动派发） */
  sensitivity: ActionSensitivity;
  /** 轻步骤标记（总结/整理/回顾类：派发走小预算快车道省 token，2026-10-01） */
  light?: boolean;
  /** doing 状态时关联的后台任务 id（TaskHub 终态回调推进的钥匙） */
  taskId?: string;
  /** 结果/原因备注（完成摘要、失败原因、重排原因都落这里） */
  note?: string;
  /**
   * 依赖的步骤 id（2026-10-19 占位）。
   * **线性调度不读它**——生活事务的依赖复杂度撑不起 DAG 调度器/环检测/局部重算。
   * 留字段是为了将来真有并行分支时不必改数据形态。
   */
  dependsOn?: string[];
  updatedAt: number;
}

interface PlanPayload {
  steps?: PlanStep[];
  /** 最近一次 replan 的原因 */
  lastReplanReason?: string;
  /** plan 建立时的会话（结果投递归属） */
  sessionId?: string;
  /** 命中的模板 id（成本报告按模板归因：哪类目标达成率高） */
  templateId?: string;
  /**
   * 模板带来的操作偏好（结果形态，如"先给结论、细节折叠"）。落载荷并随
   * goal.plan.list/create 输出给模型，让同类目标第二次的产出直接对上口径。
   */
  preferences?: string;
}

export interface GoalPlannerDeps {
  goalBoard: GoalBoard;
  /**
   * 后台任务派发（bootstrap 晚绑定 agentCore.dispatchBackgroundTask；
   * LLM 未启用/预算超限时返回 null——步骤如实停在 todo，不假装推进）。
   */
  launchTask?: (input: { actorId: string; sessionId?: string; goal: string; note?: string; light?: boolean }) => string | null;
  /**
   * 步骤事件落代办足迹台账（可选注入）：awaiting_confirm / failed / 计划完成
   * 三类事件主动告知用户，复用 AgentActivityStore + activity_new 推送。
   */
  recordActivity?: (input: {
    actorId: string;
    title: string;
    summary: string;
    status?: "pending" | "done" | "failed";
  }) => void;
}

export type AdvanceOutcome =
  | { ok: true; action: "dispatched"; step: PlanStep; remaining: number }
  | { ok: true; action: "awaiting_confirm"; step: PlanStep; reason: string }
  | { ok: true; action: "blocked"; step: PlanStep; reason: string }
  | { ok: true; action: "already_doing"; step: PlanStep }
  | { ok: true; action: "finished"; summary: string }
  | { ok: false; error: string };

/** 单计划步骤上限（防一步计划拆成一百步的滥用） */
const MAX_STEPS = 12;
/** 自动放行外部步骤的总开关（默认关：外部动作必须用户确认） */
function autoExternalEnabled(): boolean {
  return process.env.GOAL_PLAN_AUTO_EXTERNAL === "1";
}

/** 轻步骤动词：纯信息加工（无外部动作），可走小预算快车道（容许先/再/把等前导词） */
const LIGHT_STEP_RE = /^(?:先|再|然后|把|请|帮我?)?(总结|整理|梳理|回顾|复盘|草拟|起草|拟一|想一|构思|列[出个一]|盘点|归纳)/;
/** 排除词：步骤描述含外部动作/查询时不算轻步骤（宁可全额预算） */
const LIGHT_STEP_EXCLUDE_RE = /(查|搜|找|订|买|支付|下单|发|下载|打开|浏览|对比|比价|联系|预约|创建|添加|删除|修改|设置|上传|安装|调用)/;

/**
 * 轻步骤判定（确定性规则，零 LLM）：「总结一下进展」「整理成一段话」类纯
 * 加工步骤按小预算快档派发；含查询/外部动作词的一律全额预算。
 */
export function isLightStep(title: string): boolean {
  const t = String(title ?? "").trim();
  if (t.length === 0 || LIGHT_STEP_EXCLUDE_RE.test(t)) return false;
  return LIGHT_STEP_RE.test(t);
}

export class GoalPlanner {
  /** taskId → {goalId, stepId}：TaskHub 终态回调的反查索引 */
  private readonly pendingTasks = new Map<string, { goalId: string; stepId: string }>();
  private detach: (() => void) | null = null;

  constructor(private readonly deps: GoalPlannerDeps) {}

  // ─────────────────────────── 创建 / 查询 ───────────────────────────

  createPlan(input: {
    actorId: string;
    sessionId?: string;
    title: string;
    /** 有序步骤描述（一句话一步）；**留空则按模板库自动套步骤**（省一次 LLM 拆步） */
    steps?: string[];
    note?: string;
    /** 达成判据；缺省时用模板自带的 */
    successCriteria?: string;
    /** 模板 id（命中时记录，供成本报告归因） */
    templateId?: string;
  }): { ok: true; goal: GoalRecord } | { ok: false; error: string } {
    const title = String(input.title ?? "").trim();
    let rawSteps = (input.steps ?? []).map((s) => String(s ?? "").trim()).filter(Boolean);
    if (!title) return { ok: false, error: "缺少 title（目标一句话）" };

    // 模板优先（2026-10-19）：没给步骤时按同类目标套用「成功流程 + 失败规避」，
    // 这是「能力随使用变强、token 不涨」的具体落点——同类目标第二次不再调 LLM 拆步。
    let templateId = input.templateId?.trim() || undefined;
    let criteria = input.successCriteria?.trim() || undefined;
    let preferences: string | undefined;
    if (rawSteps.length === 0) {
      const tpl = matchGoalTemplate(title);
      if (tpl) {
        rawSteps = buildStepsFromTemplate(tpl, input.note);
        templateId = templateId ?? tpl.id;
        criteria = criteria ?? tpl.successCriteria;
        preferences = formatTemplatePreferences(tpl);
      }
    }
    if (rawSteps.length === 0) {
      return { ok: false, error: "至少拆出 1 个步骤（也可命中模板自动生成：出行/搬家/备考/装修/求职）" };
    }
    if (rawSteps.length > MAX_STEPS) return { ok: false, error: `步骤太多（上限 ${MAX_STEPS} 步），先拆主干` };

    const now = Date.now();
    const steps: PlanStep[] = rawSteps.map((s, i) => ({
      id: `s${i + 1}`,
      title: s.slice(0, 200),
      status: "todo",
      sensitivity: classifyTextSensitivity(s),
      light: isLightStep(s),
      updatedAt: now,
    }));

    const payload: PlanPayload = {
      steps,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(templateId ? { templateId } : {}),
      ...(preferences ? { preferences } : {}),
    };
    const goal = this.deps.goalBoard.create({
      actorId: input.actorId,
      kind: "plan",
      type: "plan",
      title: title.slice(0, 120),
      payload: payload as unknown as Record<string, unknown>,
    });
    // 达成判据落主表：有它才会在终审时要求「每一步留结果」的确定性确证
    if (criteria) {
      const rec = this.deps.goalBoard.get(goal.goalId);
      if (rec) {
        rec.successCriteria = criteria.slice(0, 200);
        rec.salience = rec.salience ?? 1;
      }
    }
    return { ok: true, goal: this.deps.goalBoard.get(goal.goalId) ?? goal };
  }

  /** 某 actor 的全部计划（活跃在前，最近更新优先） */
  listPlans(actorId: string): GoalRecord[] {
    return this.deps.goalBoard
      .list(actorId)
      .filter((g) => g.kind === "plan")
      .sort((a, b) => {
        const aDone = a.status === "done" || a.status === "ready" ? 1 : 0;
        const bDone = b.status === "done" || b.status === "ready" ? 1 : 0;
        return aDone - bDone || lastStepAt(b) - lastStepAt(a);
      });
  }

  getPlan(goalId: string, actorId?: string): GoalRecord | null {
    const goal = this.deps.goalBoard.get(goalId);
    if (!goal || goal.kind !== "plan") return null;
    if (actorId && goal.actorId !== actorId) return null;
    return goal;
  }

  stepsOf(goal: GoalRecord): PlanStep[] {
    const steps = (goal.payload as PlanPayload | undefined)?.steps;
    return Array.isArray(steps) ? steps : [];
  }

  /** 计划进度摘要（注入对话/投递文案用） */
  progressLine(goal: GoalRecord): string {
    const steps = this.stepsOf(goal);
    const done = steps.filter((s) => s.status === "done" || s.status === "skipped").length;
    const doing = steps.find((s) => s.status === "doing" || s.status === "awaiting_confirm");
    const head = `${done}/${steps.length} 步`;
    if (doing) return `${head}，当前「${doing.title}」${doing.status === "awaiting_confirm" ? "（等你确认）" : "进行中"}`;
    if (goal.status === "ready" || goal.status === "done") return `${head}，已完成`;
    return `${head}`;
  }

  // ─────────────────────────── 推进 ───────────────────────────

  /**
   * 推进计划：从第一个可推进的步骤开始派发。外部步骤（未确认）转
   * awaiting_confirm；后台通道不可用时步骤停在 todo 并如实说明。
   */
  advance(goalId: string, actorId: string, opts: { confirmExternal?: boolean } = {}): AdvanceOutcome {
    const goal = this.getPlan(goalId, actorId);
    if (!goal) return { ok: false, error: "计划不存在" };
    if (goal.status === "done" || goal.status === "ready") {
      return { ok: false, error: "计划已完成，无需推进" };
    }
    const steps = this.stepsOf(goal);
    const doing = steps.find((s) => s.status === "doing");
    if (doing) return { ok: true, action: "already_doing", step: doing };

    // 确认放行：把 awaiting_confirm 的步骤转回 todo 再走正常推进
    if (opts.confirmExternal) {
      const awaiting = steps.filter((s) => s.status === "awaiting_confirm");
      for (const s of awaiting) {
        s.status = "todo";
        s.updatedAt = Date.now();
      }
      this.persistSteps(goal, steps);
    }

    // 本轮带 confirmExternal=true：用户已明确同意外部步骤，本轮放行不再拦
    const confirmBypass = opts.confirmExternal === true;

    const next = steps.find((s) => s.status === "todo");
    if (!next) {
      const awaiting = steps.find((s) => s.status === "awaiting_confirm");
      if (awaiting) {
        return {
          ok: true,
          action: "awaiting_confirm",
          step: awaiting,
          reason: "该步骤涉及外部操作（下单/发送/支付类），需要用户明确同意后才能执行",
        };
      }
      return this.finishPlan(goal);
    }

    if (next.sensitivity === "act_external" && !autoExternalEnabled() && !confirmBypass) {
      next.status = "awaiting_confirm";
      next.updatedAt = Date.now();
      this.persistSteps(goal, steps);
      this.deps.recordActivity?.({
        actorId: goal.actorId,
        title: `计划「${goal.title}」等你确认`,
        summary: `下一步「${next.title}」涉及外部操作，同意后我继续推进`,
        status: "pending",
      });
      return {
        ok: true,
        action: "awaiting_confirm",
        step: next,
        reason: "该步骤涉及外部操作（下单/发送/支付类），需要用户明确同意后才能执行",
      };
    }

    return this.dispatchStep(goal, steps, next);
  }

  /** 手工置步骤状态（模型在对话中确认结果/跳过时调用） */
  markStep(
    goalId: string,
    actorId: string,
    stepId: string,
    status: "done" | "failed" | "skipped",
    note?: string,
  ): AdvanceOutcome | { ok: false; error: string } {
    const goal = this.getPlan(goalId, actorId);
    if (!goal) return { ok: false, error: "计划不存在" };
    const steps = this.stepsOf(goal);
    const step = steps.find((s) => s.id === stepId);
    if (!step) return { ok: false, error: `步骤不存在：${stepId}` };
    if (step.taskId) this.pendingTasks.delete(step.taskId);
    step.status = status;
    step.note = note?.slice(0, 300);
    step.updatedAt = Date.now();
    this.persistSteps(goal, steps);
    if (status === "done" || status === "skipped") return this.advance(goalId, actorId);
    return { ok: true, action: "blocked", step, reason: "步骤已标记失败，计划暂停推进" };
  }

  /**
   * 写一条步骤备注而不改状态（2026-10-19）：供 GoalRunner 的按需检索把
   * 查到的结果落回该步，让随后派发的任务带着「已经查到什么」继续，不重复搜。
   * 只对仍是 todo 的步骤生效（已被推进/完成则静默跳过）。
   */
  annotateStep(goalId: string, stepId: string, note: string): boolean {
    const goal = this.deps.goalBoard.get(goalId);
    if (!goal || goal.kind !== "plan") return false;
    const steps = this.stepsOf(goal);
    const step = steps.find((s) => s.id === stepId);
    if (!step || step.status !== "todo") return false;
    step.note = note.slice(0, 300);
    step.updatedAt = Date.now();
    this.persistSteps(goal, steps);
    return true;
  }

  /**
   * 动态调整：替换未完成步骤（done/failed/skipped 保留存档），记录原因。
   * 正在做的一步若仍在新列表语义内由模型自己决定是否保留（本工具整体重排 todo 尾部）。
   */
  replan(
    goalId: string,
    actorId: string,
    newSteps: string[],
    reason?: string,
  ): { ok: true; goal: GoalRecord } | { ok: false; error: string } {
    const goal = this.getPlan(goalId, actorId);
    if (!goal) return { ok: false, error: "计划不存在" };
    if (goal.status === "done" || goal.status === "ready") return { ok: false, error: "计划已完成" };
    const cleaned = newSteps.map((s) => String(s ?? "").trim()).filter(Boolean);
    if (cleaned.length === 0) return { ok: false, error: "新步骤列表为空（放弃计划请用 abandon）" };
    if (cleaned.length > MAX_STEPS) return { ok: false, error: `步骤太多（上限 ${MAX_STEPS} 步）` };

    const steps = this.stepsOf(goal);
    const now = Date.now();
    // 正在跑的步骤不硬停（结果回来时按 taskId 反查落账，查不到原步骤则静默忽略）
    const doing = steps.find((s) => s.status === "doing");
    const archived = steps.filter((s) => s.status === "done" || s.status === "failed" || s.status === "skipped");
    const next: PlanStep[] = [
      ...archived,
      ...(doing ? [{ ...doing }] : []),
      ...cleaned.map((s, i) => ({
        id: `r${now.toString(36)}_${i + 1}`,
        title: s.slice(0, 200),
        status: "todo" as const,
        sensitivity: classifyTextSensitivity(s),
        light: isLightStep(s),
        updatedAt: now,
      })),
    ];
    const payload = goal.payload as PlanPayload;
    payload.steps = next;
    payload.lastReplanReason = (reason ?? "情况有变").slice(0, 200);
    this.deps.goalBoard.markReadyTouch(goalId); // 触发一次 goal 信号（状态不变也刷新 fingerprint）
    this.persistSteps(goal, next);
    return { ok: true, goal };
  }

  /** 放弃计划（用户改主意/目标作废） */
  abandon(goalId: string, actorId: string, reason?: string): { ok: boolean; error?: string } {
    const goal = this.getPlan(goalId, actorId);
    if (!goal) return { ok: false, error: "计划不存在" };
    for (const step of this.stepsOf(goal)) {
      if (step.taskId) this.pendingTasks.delete(step.taskId);
    }
    this.deps.goalBoard.markDone(goalId);
    this.deps.recordActivity?.({
      actorId,
      title: `计划「${goal.title}」已放弃`,
      summary: reason?.slice(0, 200) || "你确认不再推进这个计划",
      status: "done",
    });
    return { ok: true };
  }

  // ─────────────────────────── TaskHub 接线 ───────────────────────────

  /**
   * 挂接任务面终态回调（bootstrap 调一次）：doing 步骤对应任务 done → 记完成
   * 并自动推进下一步；failed/cancelled → 步骤失败、计划暂停（不静默重试，
   * 失败如实停住等用户指示——任务面 restart-recovery 的自动重跑封顶已另管）。
   * 返回退订函数（测试/停机用）。
   */
  attachTaskHub(taskHub: TaskHub): () => void {
    this.detach?.();
    const listener = (record: { taskId: string; state: string; progressLine?: string }, kind: string): void => {
      if (kind !== "state") return;
      const hit = this.pendingTasks.get(record.taskId);
      if (!hit) return;
      if (record.state === "done") {
        this.resolveStep(hit.goalId, hit.stepId, "done", record.progressLine);
      } else if (record.state === "failed" || record.state === "cancelled") {
        this.resolveStep(hit.goalId, hit.stepId, "failed", record.progressLine ?? "任务未完成");
      }
    };
    taskHub.addExtraListener(listener as Parameters<TaskHub["addExtraListener"]>[0]);
    this.detach = () => taskHub.removeExtraListener(listener as Parameters<TaskHub["addExtraListener"]>[0]);
    return this.detach;
  }

  /**
   * 重启对账（bootstrap 装配后调一次）：doing 步骤的任务台账已终态/丢失时
   * 如实落账——done 补记完成，失败/丢失标失败；仍在跑的留给终态回调。
   */
  reconcile(taskHub: TaskHub): void {
    for (const goal of this.deps.goalBoard.list()) {
      if (goal.kind !== "plan" || goal.status === "done" || goal.status === "ready") continue;
      for (const step of this.stepsOf(goal)) {
        if (step.status !== "doing" || !step.taskId) continue;
        const rec = taskHub.get(step.taskId);
        if (!rec) {
          step.status = "failed";
          step.note = "服务器重启，执行记录丢失";
          step.updatedAt = Date.now();
          this.pendingTasks.delete(step.taskId);
        } else if (rec.state === "done") {
          step.status = "done";
          step.updatedAt = Date.now();
          this.pendingTasks.delete(step.taskId);
        } else if (rec.state === "failed" || rec.state === "cancelled") {
          step.status = "failed";
          step.note = rec.progressLine ?? "任务失败";
          step.updatedAt = Date.now();
          this.pendingTasks.delete(step.taskId);
        } else {
          this.pendingTasks.set(step.taskId, { goalId: goal.goalId, stepId: step.id });
        }
      }
    }
  }

  /** 测试/停机：清空反查索引 */
  reset(): void {
    this.pendingTasks.clear();
    this.detach?.();
    this.detach = null;
  }

  // ─────────────────────────── 内部 ───────────────────────────

  private dispatchStep(goal: GoalRecord, steps: PlanStep[], step: PlanStep): AdvanceOutcome {
    const launch = this.deps.launchTask;
    if (!launch) {
      return {
        ok: true,
        action: "blocked",
        step,
        reason: "后台任务通道未就绪（LLM 未启用），步骤保持待办",
      };
    }
    // 目标级预算（2026-10-19）：防单个 goal 吃掉全局日额度。这是**成本类**阻塞，
    // GoalRunner 侧静默等次日重置，不打扰用户。
    if (!this.deps.goalBoard.trySpendStep(goal.goalId)) {
      return {
        ok: true,
        action: "blocked",
        step,
        reason: "该目标今日步数已达上限（目标级预算），明天再继续",
      };
    }
    const payload = goal.payload as PlanPayload;
    const taskId = launch({
      actorId: goal.actorId,
      ...(payload.sessionId ? { sessionId: payload.sessionId } : {}),
      goal: `【计划推进】${goal.title}｜第 ${steps.indexOf(step) + 1} 步：${step.title}`,
      ...(step.light ? { light: true } : {}),
    });
    if (!taskId) {
      return {
        ok: true,
        action: "blocked",
        step,
        reason: "后台任务通道不可用（预算超限或未就绪），步骤保持待办",
      };
    }
    step.status = "doing";
    step.taskId = taskId;
    step.updatedAt = Date.now();
    this.pendingTasks.set(taskId, { goalId: goal.goalId, stepId: step.id });
    this.persistSteps(goal, steps);
    return { ok: true, action: "dispatched", step, remaining: steps.filter((s) => s.status === "todo").length };
  }

  /** 步骤终态落账 + 自动推进（done）或停住（failed） */
  private resolveStep(goalId: string, stepId: string, status: "done" | "failed", note?: string): void {
    const goal = this.deps.goalBoard.get(goalId);
    if (!goal || goal.kind !== "plan") return;
    const steps = this.stepsOf(goal);
    const step = steps.find((s) => s.id === stepId);
    if (!step || (step.status !== "doing" && step.status !== "awaiting_confirm")) return;
    step.status = status;
    if (note) step.note = String(note).slice(0, 300);
    step.updatedAt = Date.now();
    this.persistSteps(goal, steps);

    if (status === "failed") {
      this.deps.recordActivity?.({
        actorId: goal.actorId,
        title: `计划「${goal.title}」第 ${steps.indexOf(step) + 1} 步没办成`,
        summary: `「${step.title}」：${step.note ?? "任务失败"}。我停在这一步，等你的指示`,
        status: "failed",
      });
      return;
    }
    // 完成即自动推进下一步（外部步骤会在 advance 里被拦下等确认）
    const outcome = this.advance(goalId, goal.actorId);
    if (outcome.ok && outcome.action === "finished") {
      this.deps.recordActivity?.({
        actorId: goal.actorId,
        title: `计划「${goal.title}」全部完成`,
        summary: outcome.summary,
        status: "done",
      });
    }
  }

  /**
   * 全部步骤终结 → 验收（2026-10-19，D3）。
   *
   * 旧判据是「所有 step.status === done」，等于把「执行成功」当「目标达成」。
   * 现在先过确定性验收（零 token）：
   *  - met     → markReady 进 ReadyTray（挑时机投递摘要）
   *  - partial → 不宣布完成，停住并说明差在哪（交人工/夜间重排）
   *  - failed  → 不宣布完成，记失败（GoalRunner 会开口告知，不静默）
   */
  private finishPlan(
    goal: GoalRecord,
  ): { ok: true; action: "finished"; summary: string } | { ok: true; action: "blocked"; step: PlanStep; reason: string } {
    const steps = this.stepsOf(goal);
    const lines = steps.map((s, i) => {
      const mark = s.status === "failed" ? "✗" : s.status === "skipped" ? "—" : "✓";
      return `${mark} ${i + 1}. ${s.title}${s.note ? `（${s.note}）` : ""}`;
    });
    const summary = `「${goal.title}」计划完成：${steps.filter((s) => s.status === "done").length} 步办成` +
      (steps.some((s) => s.status === "failed") ? `，${steps.filter((s) => s.status === "failed").length} 步没办成` : "");

    const verified = verifyDeterministic({
      title: goal.title,
      ...(goal.successCriteria ? { successCriteria: goal.successCriteria } : {}),
      steps: steps.map((s) => ({ title: s.title, status: s.status, ...(s.note ? { note: s.note } : {}) })),
    });

    if (verified && verified.verdict !== "met") {
      this.deps.goalBoard.setVerdict(goal.goalId, verified.verdict, verified.note);
      this.deps.recordActivity?.({
        actorId: goal.actorId,
        title: `计划「${goal.title}」没验收通过`,
        summary: verified.note,
        status: verified.verdict === "failed" ? "failed" : "pending",
      });
      const last = steps[steps.length - 1];
      return last
        ? { ok: true, action: "blocked", step: last, reason: `验收没通过：${verified.note}` }
        : { ok: true, action: "blocked", step: { id: "s0", title: goal.title, status: "failed", sensitivity: "act_internal", updatedAt: Date.now() }, reason: `验收没通过：${verified.note}` };
    }

    this.deps.goalBoard.setVerdict(goal.goalId, "met", verified?.note, {
      body: `${summary}\n${lines.join("\n")}`,
      bodyKind: "plan_done",
      dedupFields: { title: `计划完成：${goal.title}` },
    });
    return { ok: true, action: "finished", summary };
  }

  private persistSteps(goal: GoalRecord, steps: PlanStep[]): void {
    (goal.payload as PlanPayload).steps = steps;
    // 直接复用 GoalBoard 的落盘/信号链路：markReadyTouch 刷一次存在信号
    this.deps.goalBoard.markReadyTouch(goal.goalId);
  }
}

function lastStepAt(goal: GoalRecord): number {
  const steps = (goal.payload as PlanPayload | undefined)?.steps;
  if (!Array.isArray(steps) || steps.length === 0) return goal.createdAt;
  return Math.max(...steps.map((s) => s.updatedAt ?? 0));
}
