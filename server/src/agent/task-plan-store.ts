/**
 * TaskPlanStore —— 会话级任务计划（三层尺度的中间层，2026-10-19）。
 *
 * 与 GoalBoard 的分工（docs/goal-hybrid-architecture.md §2）：
 *  - TaskPlan：单次多步任务，会话内可跨轮续跑，完成即归档 —— 本模块
 *  - Goal：跨会话的长期目标，带预算 / 进度 / 主动推进 —— proactivity/goal-board
 *
 * **结构复用、存储分离**：两者共用同一套「步骤 + 状态机 + plan_step 事件」语义，
 * 但 TaskPlan 绝不写进 goals.json——短任务会冲爆长期台账，而 goals.json 是
 * 每轮注入的数据源（混进琐事会让注入失去意义）。
 *
 * 存储：`data/session-plans/<sanitizedSessionId>.json`，重启可恢复（多步任务
 * 常横跨多轮，进程重启不能丢）。7 天自动归档清理。
 *
 * 事件：写入/状态变更即广播，由 chat-user-message 的轮次作用域订阅并转成
 * `plan_step` 执行事件——复用已有管道（chat-user-message.ts:1372 → turn_state.dart:302），
 * 不新增 UI 协议。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type TaskPlanStepStatus =
  | "pending"
  | "running"
  | "done"
  | "failed"
  | "skipped"
  | "awaiting_confirm";

/**
 * 完成判定方式（handoff 收回通道）：
 *  - user_confirm：用户点「我已完成」（唯一允许自动置 done 的默认档）
 *  - probe       ：客观事实探测（订单接口/日历事件/文件存在等确定性查询）
 *
 * 行为间接证据（切回 App、位置变化）**不在此列**——它只能触发提醒，不能判定完成。
 */
export type TaskPlanHandoffCheckMode = "user_confirm" | "probe";

export interface TaskPlanHandoffAction {
  id: string;
  label: string;
  /** 深链（打开对应 App / 网页），可选 */
  url?: string;
}

/**
 * 执行权移交载荷（2026-10-19 handoff）。
 *
 * 为什么不是「确认框」：`awaiting_confirm` 只说明「这步要人」，但不说要人做什么、
 * 去哪做、凭什么算做完。缺了这三件事，恢复只能靠模型下一轮猜——所以把交接说明
 * 随步骤一起持久化。
 */
export interface TaskPlanHandoff {
  /** 一句人话：要用户做什么（"在美团点一份麻辣烫送到公司"） */
  instruction: string;
  /** 给前端的按钮（打开 App / 我已完成） */
  actions?: TaskPlanHandoffAction[];
  checkMode: TaskPlanHandoffCheckMode;
  /** checkMode=probe 时的确定性探测（工具名 + 参数），由续跑 tick 轮询 */
  probe?: { tool: string; args?: Record<string, unknown>; expect?: string };
  /** 幂等键：同一外部动作续跑时不允许第二次真实执行 */
  idempotencyKey?: string;
  /** 进入等待的时刻（超时收敛用） */
  since: number;
  /** 已提醒次数（同一 handoff 只打扰有限次） */
  remindCount: number;
  lastRemindAt?: number;
}

export interface TaskPlanStep {
  id: string;
  title: string;
  status: TaskPlanStepStatus;
  /** 结果 / 失败原因 / 跳过理由 */
  note?: string;
  /** 仅 status=awaiting_confirm 时有值 */
  handoff?: TaskPlanHandoff;
  updatedAt: number;
}

export interface TaskPlan {
  planId: string;
  sessionId: string;
  actorId: string;
  /** 任务一句话（"订下周去三亚的行程"） */
  goal: string;
  steps: TaskPlanStep[];
  createdAt: number;
  updatedAt: number;
}

export type TaskPlanEventType = "write" | "status" | "replan" | "clear";

export interface TaskPlanEvent {
  type: TaskPlanEventType;
  sessionId: string;
  plan: TaskPlan;
  /** status 事件携带变化的那一步 */
  step?: TaskPlanStep;
  /** replan 原因 */
  reason?: string;
}

/** 单计划步骤上限（防把一句话拆成一百步） */
export const TASK_PLAN_MAX_STEPS = 8;
/** 归档保留天数 */
const RETENTION_DAYS = 7;

const STEP_STATUSES: readonly TaskPlanStepStatus[] = [
  "pending",
  "running",
  "done",
  "failed",
  "skipped",
  "awaiting_confirm",
];

export function isTaskPlanStepStatus(v: unknown): v is TaskPlanStepStatus {
  return typeof v === "string" && (STEP_STATUSES as readonly string[]).includes(v);
}

/**
 * 计划主键归一（2026-10-19 根修）。
 *
 * 此前三处各用各的 key——工具层 `ToolContext.sessionId`、事件订阅 `msgActor`、
 * 软提示 `audit.sessionId`——正常会话里它们未必相等（msgActor 是 userId，socket
 * 会话是 device/sessionId），后果是：计划写进去了，前端不显示；软提示以为没计划，
 * 反复催；执行守卫看不见等待步，外部动作工具没被收起。
 *
 * 权威源 = **发起本轮的那个会话键**（`ToolContext.sessionId` / prompt 注入用的
 * 同一个值），四处一律过这里。隐身会话（`incognito:`）因此天然隔离，不需要特判。
 */
export function taskPlanKey(input: {
  sessionId?: string | null;
  actorId?: string | null;
}): string {
  const sessionId = String(input.sessionId ?? "").trim();
  if (sessionId) return sessionId;
  return String(input.actorId ?? "").trim();
}

/** 未完成（还要继续做）的步：pending / running / awaiting_confirm */
export function isUnfinishedStep(step: TaskPlanStep): boolean {
  return step.status === "pending" || step.status === "running" || step.status === "awaiting_confirm";
}

/** 当前挡住推进的那一步（等待用户操作的那一步） */
export function blockingStepOf(plan: TaskPlan | null | undefined): TaskPlanStep | null {
  if (!plan) return null;
  return plan.steps.find((s) => s.status === "awaiting_confirm") ?? null;
}

/**
 * 「用户说自己做完了」的确定性判定（handoff 文字回执）。
 *
 * 为什么需要它：点击回执（卡片/胶囊）是首选通道，但用户也可能直接打字
 * 「点好了」「付了」。这类句子本身不构成证据——**只有在存在唯一等待步时才被消费**
 * （见调用方），歧义场景一律不猜。宁可让用户再点一次，也不能误判完成。
 */
const HANDOFF_DONE_RE =
  /^(?:我)?(?:已经?|都)?(?:完成|弄好|做好|点好|买好|付好|付了|点了|买了|搞定|办完|弄完)(?:了|啦|呀|哈|咯)?(?:[，,、\s]*(?:继续|接着)(?:下一步|一下|吧)?)?[。.!！~～]?$/;

export function isHandoffDoneReply(text: string): boolean {
  const t = String(text ?? "").trim();
  if (!t || t.length > 24) return false;
  return HANDOFF_DONE_RE.test(t.replace(/\s+/g, ""));
}

export type TaskPlanStoreDeps = {
  /** 数据目录（装配层传 server/data） */
  dataPath: string;
  /** 注入时钟（测试确定性） */
  nowFn?: () => number;
  log?: (message: string) => void;
};

export type TaskPlanWriteInput = {
  sessionId: string;
  actorId: string;
  goal: string;
  steps: string[];
  /**
   * 写语义（2026-10-19 根修）：
   *  - new（默认）：已有未完成计划时**拒绝**，指向 plan.replan
   *  - replace    ：显式覆盖（用户改主意「这事重新规划」时才允许）
   *
   * 旧行为是无条件覆盖——多轮任务里模型顺手再 write 一次就把已完成步骤清零、
   * 前端步骤条回退。进度是跨轮状态，覆盖必须是显式意图。
   */
  mode?: "new" | "replace";
};

type Result<T> = { ok: true } & T | { ok: false; error: string };

let seq = 0;

/**
 * 状态变更来源。
 *
 * 这是「沉默≠同意」的执行层落点：把等待步改成 done 等于替用户点头，
 * 所以只有用户回执（user）与客观证据（probe）能这么干，agent 不能自己来。
 */
export type TaskPlanStatusBy = "agent" | "user" | "probe";

export type TaskPlanSetStatusOpts = {
  by?: TaskPlanStatusBy;
  /** status=awaiting_confirm 时必填：交接说明（做什么 / 怎么算完成） */
  handoff?: Omit<TaskPlanHandoff, "since" | "remindCount">;
};

export class TaskPlanStore {
  private readonly plans = new Map<string, TaskPlan>();
  private readonly dir: string;
  private readonly nowFn: () => number;
  private readonly log: (m: string) => void;
  private readonly listeners = new Map<string, (ev: TaskPlanEvent) => void>();

  constructor(deps: TaskPlanStoreDeps) {
    this.dir = join(deps.dataPath, "session-plans");
    this.nowFn = deps.nowFn ?? Date.now;
    this.log = deps.log ?? ((m) => console.log(`[TaskPlan] ${m}`));
    this.prune();
  }

  // ─────────────────────────── 读写 ───────────────────────────

  write(input: TaskPlanWriteInput): Result<{ plan: TaskPlan }> {
    const planKey = taskPlanKey({ actorId: input.actorId, sessionId: input.sessionId });
    if (!planKey) return { ok: false, error: "缺少 actorId/sessionId" };
    const goal = String(input.goal ?? "").trim();
    if (!goal) return { ok: false, error: "缺少 goal（任务一句话）" };
    const titles = (input.steps ?? [])
      .map((s) => String(s ?? "").trim())
      .filter(Boolean);
    if (titles.length === 0) return { ok: false, error: "至少写 1 个步骤" };
    if (titles.length > TASK_PLAN_MAX_STEPS) {
      return { ok: false, error: `步骤太多（上限 ${TASK_PLAN_MAX_STEPS} 步），先写主干` };
    }

    // 覆盖守卫：未完成的计划不能被顺手重写（进度清零 = 用户眼里任务倒退）
    const existing = this.plans.get(planKey);
    if (existing && (input.mode ?? "new") !== "replace") {
      const unfinished = existing.steps.filter(isUnfinishedStep);
      if (unfinished.length > 0) {
        return {
          ok: false,
          error:
            `本会话已有未完成的计划（${this.progressLine(existing)}）。` +
            "要改步骤用 plan.replan（保留已完成）；确实要重新规划，传 mode=replace。",
        };
      }
    }

    const now = this.nowFn();
    const plan: TaskPlan = {
      planId: existing?.planId ?? `tp_${now.toString(36)}_${(seq++).toString(36)}`,
      sessionId: planKey,
      actorId: input.actorId || existing?.actorId || planKey,
      goal: goal.slice(0, 200),
      steps: titles.map((title, i) => ({
        id: `s${i + 1}`,
        title: title.slice(0, 200),
        status: "pending" as const,
        updatedAt: now,
      })),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.plans.set(planKey, plan);
    this.persist(plan);
    this.emit({ type: "write", sessionId: planKey, plan });
    return { ok: true, plan };
  }

  setStatus(
    sessionId: string,
    stepId: string,
    status: TaskPlanStepStatus,
    note?: string,
    opts: TaskPlanSetStatusOpts = {},
  ): Result<{ plan: TaskPlan; step: TaskPlanStep; nextStep: TaskPlanStep | null }> {
    const plan = this.plans.get(sessionId);
    if (!plan) return { ok: false, error: "当前会话没有计划（先用 plan.write 写步骤）" };
    const step = plan.steps.find((s) => s.id === stepId);
    if (!step) return { ok: false, error: `步骤不存在：${stepId}` };
    const by: TaskPlanStatusBy = opts.by ?? "agent";
    const from = step.status;

    // 交接说明：进入等待必须有「做什么」，否则恢复时只能靠模型猜
    if (status === "awaiting_confirm") {
      const handoff = opts.handoff ?? step.handoff;
      if (!handoff?.instruction || !handoff.instruction.trim()) {
        return {
          ok: false,
          error: "置 awaiting_confirm 时要带 handoff.instruction（一句人话：要用户在哪儿做什么）",
        };
      }
      step.handoff = {
        ...handoff,
        instruction: handoff.instruction.trim().slice(0, 300),
        checkMode: handoff.checkMode === "probe" ? "probe" : "user_confirm",
        since: step.handoff?.since ?? this.nowFn(),
        remindCount: step.handoff?.remindCount ?? 0,
      };
    }

    // 权限闸：从等待态离开到「已完成/继续做」只有用户回执或客观证据能触发
    if (from === "awaiting_confirm" && by === "agent" && (status === "done" || status === "pending" || status === "running")) {
      return {
        ok: false,
        error:
          "这一步在等用户操作，agent 不能自己放行（沉默≠同意）。" +
          "用户完成后再推进；用户不做就置 skipped/failed。",
      };
    }

    step.status = status;
    if (note !== undefined) step.note = String(note).slice(0, 300);
    // 离开等待态即清载荷（避免陈旧交接说明在后续轮里被当成当前任务）
    if (from === "awaiting_confirm" && status !== "awaiting_confirm") {
      step.handoff = undefined;
    }
    step.updatedAt = this.nowFn();
    plan.updatedAt = step.updatedAt;
    this.persist(plan);
    this.emit({ type: "status", sessionId, plan, step });
    return { ok: true, plan, step, nextStep: this.nextTodoStep(plan) };
  }

  /**
   * 收回执行权（2026-10-19 handoff 恢复通道）。
   *
   * 只接受「用户回执」与「客观探测」两种证据——这是把 waiting 步置 done 的
   * 唯一入口，模型工具走不到这里（plan.set_status 带 by=agent 会被上一条闸拒绝）。
   *
   * 返回 nextStep 供续跑：调用方据此起一轮受控续跑（只做下一步，不重播全表）。
   */
  resume(
    sessionId: string,
    stepId: string,
    evidence: { by: "user" | "probe"; note?: string },
  ): Result<{ plan: TaskPlan; step: TaskPlanStep; nextStep: TaskPlanStep | null }> {
    const plan = this.plans.get(sessionId);
    if (!plan) return { ok: false, error: "当前会话没有计划" };
    const step = plan.steps.find((s) => s.id === stepId);
    if (!step) return { ok: false, error: `步骤不存在：${stepId}` };
    if (step.status !== "awaiting_confirm") {
      return { ok: false, error: `这一步不在等待态（当前 ${step.status}），无需收回` };
    }
    return this.setStatus(sessionId, stepId, "done", evidence.note ?? (evidence.by === "probe" ? "已通过事实探测确认完成" : "用户确认已完成"), {
      by: evidence.by,
    });
  }

  /** 下一步待办（跳过已完成/失败/跳过步）；没有则 null */
  nextTodoStep(plan: TaskPlan): TaskPlanStep | null {
    return plan.steps.find((s) => s.status === "pending") ?? null;
  }

  /** 当前挡住推进的等待步（没有则 null） */
  blockingStep(sessionId: string): TaskPlanStep | null {
    return blockingStepOf(this.plans.get(sessionId));
  }

  /** 只重排未完成步骤，已完成/失败/跳过保留存档 */
  replan(sessionId: string, steps: string[], reason?: string): Result<{ plan: TaskPlan }> {
    const plan = this.plans.get(sessionId);
    if (!plan) return { ok: false, error: "当前会话没有计划" };
    const titles = (steps ?? []).map((s) => String(s ?? "").trim()).filter(Boolean);
    if (titles.length === 0) return { ok: false, error: "新步骤列表为空" };
    if (titles.length > TASK_PLAN_MAX_STEPS) {
      return { ok: false, error: `步骤太多（上限 ${TASK_PLAN_MAX_STEPS} 步）` };
    }
    const now = this.nowFn();
    const archived = plan.steps.filter((s) => s.status === "done" || s.status === "failed" || s.status === "skipped");
    const running = plan.steps.find((s) => s.status === "running" || s.status === "awaiting_confirm");
    plan.steps = [
      ...archived,
      ...(running ? [{ ...running }] : []),
      ...titles.map((title, i) => ({
        id: `r${now.toString(36)}_${i + 1}`,
        title: title.slice(0, 200),
        status: "pending" as const,
        updatedAt: now,
      })),
    ];
    plan.updatedAt = now;
    this.persist(plan);
    this.emit({ type: "replan", sessionId, plan, ...(reason ? { reason: String(reason).slice(0, 200) } : {}) });
    return { ok: true, plan };
  }

  get(sessionId: string): TaskPlan | null {
    return this.plans.get(sessionId) ?? null;
  }

  /** 全部在内存里的计划（探测轮询用；已归档的不在内存） */
  listAll(): TaskPlan[] {
    return [...this.plans.values()];
  }

  /** 清空（任务已收尾 / 用户改主意） */
  clear(sessionId: string): boolean {
    const plan = this.plans.get(sessionId);
    if (!plan) return false;
    this.plans.delete(sessionId);
    try {
      const file = this.fileOf(sessionId);
      if (existsSync(file)) unlinkSync(file);
    } catch {
      /* 删文件失败忽略：内存已清，下次启动会被 prune 掉 */
    }
    this.emit({ type: "clear", sessionId, plan });
    return true;
  }

  // ─────────────────────────── 展示 ───────────────────────────

  /** 进度一行：`2/5 步，当前「比价酒店」` */
  progressLine(plan: TaskPlan): string {
    const steps = plan.steps;
    const done = steps.filter((s) => s.status === "done" || s.status === "skipped").length;
    const doing = steps.find((s) => s.status === "running" || s.status === "awaiting_confirm");
    const head = `${done}/${steps.length} 步`;
    if (doing) return `${head}，当前「${doing.title}」${doing.status === "awaiting_confirm" ? "（等确认）" : ""}`;
    if (steps.length > 0 && done === steps.length) return `${head}，已完成`;
    return head;
  }

  /**
   * prompt 注入块（≤400 tok）：只在有 plan 时返回。
   * 会话级 plan 通常几轮内归档，完整步骤比摘要更有用——模型要接着做下一步，
   * 半步摘要反而会丢上下文。
   */
  buildPromptBlock(sessionId: string): string | undefined {
    const plan = this.plans.get(sessionId);
    if (!plan || plan.steps.length === 0) return undefined;
    const done = plan.steps.filter((s) => s.status === "done" || s.status === "skipped").length;
    if (done === plan.steps.length) return undefined; // 已完成的不再占上下文
    const lines = plan.steps.map((s, i) => {
      const mark =
        s.status === "done" ? "✓" : s.status === "failed" ? "✗" : s.status === "skipped" ? "—" : s.status === "running" ? "→" : s.status === "awaiting_confirm" ? "!" : "·";
      const note = s.note ? `（${s.note}）` : "";
      const handoff = s.status === "awaiting_confirm" && s.handoff ? `【等你操作：${s.handoff.instruction}】` : "";
      return `${mark} ${i + 1}. ${s.title}${note}${handoff}`;
    });
    const blocking = blockingStepOf(plan);
    return [
      "【当前任务步骤】",
      `（会话内计划，不是长期目标；按进度继续做，改步骤用 plan.replan，单步状态用 plan.set_status）`,
      `任务：${plan.goal}`,
      ...lines,
      ...(blocking
        ? [
            `⏸ 第「${blocking.title}」步在等用户自己操作，外部动作类工具本轮已收起：` +
              "不要自己下单/支付/发送/代操作，也不要重复催促；用户回执后系统会继续。" +
              "用户明确不做了，用 plan.set_status 把它置 skipped 再继续后面的步骤。",
          ]
        : []),
      "需要用户自己动手的步：plan.set_status 置 awaiting_confirm（带 handoff.instruction 说清要他在哪儿做什么），" +
        "并在回复末尾用 [NEXT_UP_START] … [NEXT_UP_END] 给他一行可点的「我已完成，继续下一步」" +
        "——他点一下系统就把该步置 done 并让你继续。",
    ].join("\n");
  }

  // ─────────────────────────── 事件 ───────────────────────────

  subscribe(listener: (ev: TaskPlanEvent) => void): () => void {
    this.listeners.set("*", listener);
    return () => {
      if (this.listeners.get("*") === listener) this.listeners.delete("*");
    };
  }

  /**
   * 按会话订阅（对话轮使用）。
   *
   * 同一 session 只保留一个监听者——轮次结束若因异常没退订，下一轮会直接覆盖，
   * 永远不会累积成空转监听器。这比依赖 finally 更稳（对话轮那条调用链很长，
   * 异常路径不止一处）。
   */
  subscribeSession(sessionId: string, listener: (ev: TaskPlanEvent) => void): () => void {
    this.listeners.set(sessionId, listener);
    return () => {
      if (this.listeners.get(sessionId) === listener) this.listeners.delete(sessionId);
    };
  }

  private emit(ev: TaskPlanEvent): void {
    const targets = [this.listeners.get(ev.sessionId), this.listeners.get("*")];
    for (const listener of targets) {
      if (!listener) continue;
      try {
        listener(ev);
      } catch (err) {
        this.log(`事件监听器异常（忽略）：${err}`);
      }
    }
  }

  // ─────────────────────────── 持久化 ───────────────────────────

  private fileOf(sessionId: string): string {
    const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
    return join(this.dir, `${safe}.json`);
  }

  private persist(plan: TaskPlan): void {
    try {
      if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
      writeFileSync(this.fileOf(plan.sessionId), JSON.stringify(plan, null, 1));
    } catch (err) {
      this.log(`落盘失败（忽略）：${err}`);
    }
  }

  /** 启动/构造时加载存量并清理过期文件 */
  private prune(): void {
    try {
      if (!existsSync(this.dir)) return;
      const cutoff = this.nowFn() - RETENTION_DAYS * 24 * 3600_000;
      for (const name of readdirSync(this.dir)) {
        if (!name.endsWith(".json")) continue;
        const file = join(this.dir, name);
        try {
          const plan = JSON.parse(readFileSync(file, "utf8")) as TaskPlan;
          if (!plan?.sessionId || !Array.isArray(plan.steps)) {
            unlinkSync(file);
            continue;
          }
          if ((plan.updatedAt ?? 0) < cutoff) {
            unlinkSync(file);
            continue;
          }
          this.plans.set(plan.sessionId, plan);
        } catch {
          try {
            unlinkSync(file);
          } catch {
            /* ignore */
          }
        }
      }
    } catch (err) {
      this.log(`存量加载失败（忽略）：${err}`);
    }
  }

  /** 测试/停机用 */
  reset(): void {
    this.plans.clear();
    this.listeners.clear();
  }
}

const globalForTaskPlan = globalThis as unknown as { __taskPlanStore?: TaskPlanStore };

/**
 * 进程级单例（与 getTaskHub 同款）。
 *
 * 首次调用需要 dataPath——由 bootstrap 先调 `initTaskPlanStore({dataPath})`，
 * 之后工具层 `getTaskPlanStore()` 直接取。未初始化时返回 null，工具如实报未装配，
 * 不会静默失败。
 */
export function initTaskPlanStore(deps: TaskPlanStoreDeps): TaskPlanStore {
  globalForTaskPlan.__taskPlanStore ??= new TaskPlanStore(deps);
  return globalForTaskPlan.__taskPlanStore;
}

export function getTaskPlanStore(): TaskPlanStore | null {
  return globalForTaskPlan.__taskPlanStore ?? null;
}

/**
 * 当前挡路的等待步（工具面收缩 / 执行守卫的唯一查询入口）。
 *
 * 注意传的是**计划主键**（见 taskPlanKey）。工具层拿不到 actorId 时用
 * `taskPlanKey({ sessionId })` 兜底——主通道下它与 actorId 相等。
 */
export function currentBlockingStep(sessionKey: string | undefined): TaskPlanStep | null {
  const key = String(sessionKey ?? "").trim();
  if (!key) return null;
  try {
    return getTaskPlanStore()?.blockingStep(key) ?? null;
  } catch {
    return null;
  }
}

/** 测试用：替换/清空单例 */
export function __setTaskPlanStoreForTest(store: TaskPlanStore | undefined): void {
  globalForTaskPlan.__taskPlanStore = store;
}
