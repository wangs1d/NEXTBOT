// GoalRunner —— 目标后台自主循环引擎（2026-10-10，对标 Muse「Goal 为主引擎」）。
//
// 架构差距（docs/proactivity-goal-driven-architecture.md）：我们的 plan 型目标
// **只能靠模型在对话里被动调 goal.plan.advance 才推进**——没有对话 = goal 系统
// 完全静止。GoalRunner 补上"谁在后台定期推进它"这一环：常驻 tick 扫描活跃计划，
// 复用 GoalPlanner.advance()（不新写执行逻辑），把推进结果经管道说出来。
//
// 设计纪律：
//  - **不绕预算闸**：所有派发一律走 GoalPlanner.launchTask（装配层已内嵌
//    PROACTIVITY_GOAL_DAILY_BUDGET / 轻步骤车道 / token 审计三道护栏），
//    GoalRunner 本身不做任何 token 花费决策。
//  - **零 LLM 决策**：本模块只做"该不该现在推一步"的确定性判定（间隔闸/静默时段/
//    进行中不退避/终态跳过）；真正的执行是 GoalPlanner → 后台任务面（那里才有 LLM）。
//  - **可回滚**：GOAL_RUNNER_ENABLED=0 一键关（默认开）；tick 间隔 GOAL_RUNNER_TICK_MS。
//  - **只在"值得开口"时打扰**：外部步骤转 awaiting_confirm、计划完成、阶段性进展
//    三类才产出提案；静默继续（dispatched）不打扰用户——对齐 Muse「决策点才打扰」。
import type { GoalPlanner, PlanStep } from "./goal-planner.js";
import type { GoalRecord } from "./goal-board.js";

/** GoalRunner 提交主动提案的最小形状（装配层适配成 ProactiveProposal / submitIntent） */
export type GoalRunnerProposal = {
  actorId: string;
  kind: string;
  importance: "low" | "medium" | "high";
  title: string;
  summary: string;
  /** 幂等键：同一目标同一事件只提一次 */
  dedupKey: string;
  source: string;
};

export type GoalRunnerDeps = {
  goalPlanner: GoalPlanner;
  /** 活跃 actor 枚举（复用 proactivityHub.exportActors 的活跃过滤结果） */
  listActors: () => string[];
  /** 提案出口（装配层接到管道/ProactivityHub） */
  emitProposal: (p: GoalRunnerProposal) => void;
  /** 注入时钟（测试确定性） */
  nowFn?: () => number;
  /** env 读取器（测试注入） */
  env?: Record<string, string | undefined>;
  /** 单轮最多推进的目标数（防一次 tick 派发过多任务） */
  maxPerTick?: number;
  /** 同一目标的推进最小间隔（防连推；默认 10min） */
  minIntervalMs?: number;
  /** 按 actor 读取该目标最近一次推进时刻（内存缺省由本模块维护） */
  log?: (message: string) => void;
  /**
   * 感知按需检索（方向 B，2026-10-10）：某步骤被判定需要外部信息时调用
   * （装配层接 realtime search / SourceStore 查询）。返回检索结果摘要时会被
   * 记入步骤 note 供后续步骤参考；未注入 = 不主动检索（行为回退）。
   */
  retrieveForStep?: (req: { goalId: string; stepId: string; query: string; channel: "realtime" | "source" }) =>
    | { summary: string }
    | null
    | Promise<{ summary: string } | null>;
  /** 判定某步骤是否需要检索（装配层接 GoalSignalBridge.retrievalRequestFor） */
  planRetrieval?: (goal: GoalRecord, step: PlanStep) => { query: string; channel: "realtime" | "source" } | null;
};

/** 计划型目标推进的默认最小间隔（防 5min tick 连推同一目标） */
const DEFAULT_MIN_INTERVAL_MS = 10 * 60_000;
/** 单轮最多推进的目标数 */
const DEFAULT_MAX_PER_TICK = 3;

export class GoalRunner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly nowFn: () => number;
  private readonly env: Record<string, string | undefined>;
  /** goalId → 最近一次推进尝试时刻（间隔闸） */
  private readonly lastAdvanceAt = new Map<string, number>();
  /** goalId → 已汇报过的里程碑（防重复汇报同一进展） */
  private readonly reportedMilestones = new Map<string, number>();
  private readonly maxPerTick: number;
  private readonly minIntervalMs: number;
  private readonly log: (m: string) => void;

  constructor(private readonly deps: GoalRunnerDeps) {
    this.nowFn = deps.nowFn ?? Date.now;
    this.env = deps.env ?? process.env;
    this.maxPerTick = deps.maxPerTick ?? DEFAULT_MAX_PER_TICK;
    this.minIntervalMs = deps.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    this.log = deps.log ?? ((m) => console.log(`[GoalRunner] ${m}`));
  }

  /** 总开关（GOAL_RUNNER_ENABLED=0 关；缺省开） */
  enabled(): boolean {
    return this.env.GOAL_RUNNER_ENABLED !== "0";
  }

  private tickIntervalMs(): number {
    const raw = Number.parseInt(this.env.GOAL_RUNNER_TICK_MS ?? "", 10);
    return Number.isFinite(raw) && raw >= 30_000 ? raw : 5 * 60_000;
  }

  start(): void {
    if (this.timer) return;
    if (!this.enabled()) {
      this.log("未启用（GOAL_RUNNER_ENABLED=0），目标不自驱推进");
      return;
    }
    this.timer = setInterval(() => {
      try {
        this.tick();
      } catch (err) {
        this.log(`tick 失败（忽略）: ${err}`);
      }
    }, this.tickIntervalMs());
    if (typeof this.timer.unref === "function") this.timer.unref();
    this.log(`已启动（tick ${this.tickIntervalMs() / 1000}s，后台推进活跃计划）`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * 单轮扫描：对每个活跃 actor 的活跃计划，尝试推进。
   * 返回本轮动作统计（诊断/测试断言用）。
   */
  tick(): { scanned: number; advanced: number; proposals: number } {
    if (!this.enabled()) return { scanned: 0, advanced: 0, proposals: 0 };
    const now = this.nowFn();
    let advanced = 0;
    let proposals = 0;
    let scanned = 0;

    for (const actorId of this.deps.listActors()) {
      const plans = this.deps.goalPlanner
        .listPlans(actorId)
        .filter((g) => g.status !== "done" && g.status !== "expired" && g.status !== "ready");
      for (const goal of plans) {
        if (advanced >= this.maxPerTick) return { scanned, advanced, proposals };
        scanned += 1;
        const r = this.advanceOne(goal, actorId, now);
        if (r.advanced) advanced += 1;
        if (r.proposed) proposals += 1;
      }
    }
    return { scanned, advanced, proposals };
  }

  /** 推进单个计划：间隔闸 → 按需检索 → advance() → 按结果决定要不要开口 */
  private advanceOne(goal: GoalRecord, actorId: string, now: number): { advanced: boolean; proposed: boolean } {
    const last = this.lastAdvanceAt.get(goal.goalId) ?? 0;
    if (now - last < this.minIntervalMs) return { advanced: false, proposed: false };
    this.lastAdvanceAt.set(goal.goalId, now);

    // 方向 B（目标 → 感知）：派发前判定下一步是否需要外部信息，需要则先检索
    // （fire-and-forget，结果异步写进步骤 note 供该步任务参考；不阻塞推进）
    this.maybeRetrieveForNextStep(goal, actorId);

    const outcome = this.deps.goalPlanner.advance(goal.goalId, actorId);
    if (!outcome.ok) return { advanced: false, proposed: false };

    switch (outcome.action) {
      case "dispatched":
        // 静默继续（对齐 Muse「不需要拍板就静默推进」）——不打扰用户
        this.log(`已推进「${goal.title}」步骤「${outcome.step.title}」（剩余 ${outcome.remaining}）`);
        return { advanced: true, proposed: false };
      case "awaiting_confirm":
        // 外部步骤卡口：需要用户拍板 → 开口（决策点才打扰）
        this.deps.emitProposal({
          actorId,
          kind: "goal_confirm",
          importance: "medium",
          title: `计划「${goal.title}」等你确认`,
          summary: `下一步「${outcome.step.title}」涉及外部操作，你点头我就继续。`,
          dedupKey: `goal_runner:confirm:${goal.goalId}:${outcome.step.id}`,
          source: "goal_runner",
        });
        return { advanced: false, proposed: true };
      case "finished":
        // 计划完成：汇报
        this.deps.emitProposal({
          actorId,
          kind: "goal_progress",
          importance: "medium",
          title: `计划「${goal.title}」已完成`,
          summary: outcome.summary,
          dedupKey: `goal_runner:finished:${goal.goalId}`,
          source: "goal_runner",
        });
        return { advanced: true, proposed: true };
      case "blocked":
        // 派发通道不可用/预算超限：如实记日志，不打扰（避免把成本问题变成噪音）
        this.log(`「${goal.title}」步骤「${outcome.step.title}」暂无法推进：${outcome.reason}`);
        return { advanced: false, proposed: false };
      case "already_doing":
        return { advanced: false, proposed: false };
      default:
        return { advanced: false, proposed: false };
    }
  }

  /**
   * 方向 B：若下一步需要检索，发起检索并把结果写回步骤 note。
   * fire-and-forget：失败只记日志，不影响推进（检索是增强，不是前置依赖）。
   */
  private maybeRetrieveForNextStep(goal: GoalRecord, actorId: string): void {
    const { planRetrieval, retrieveForStep } = this.deps;
    if (!planRetrieval || !retrieveForStep) return;
    const steps = this.deps.goalPlanner.stepsOf(goal);
    const next = steps.find((s) => s.status === "todo");
    if (!next) return;
    const req = planRetrieval(goal, next);
    if (!req) return;
    void Promise.resolve(retrieveForStep({ goalId: goal.goalId, stepId: next.id, query: req.query, channel: req.channel }))
      .then((res) => {
        if (res?.summary) this.log(`已为「${goal.title}」第「${next.title}」步检索：${res.summary.slice(0, 80)}`);
      })
      .catch((err) => this.log(`步骤检索失败（忽略）：${err}`));
    void actorId;
  }

  /**
   * 阶段性进展汇报（每完成 N 步一次）。
   * 由装配层在步骤完成事件里调用，或 tick 内按 progressLine 变化触发。
   */
  maybeReportProgress(goalId: string, actorId: string): boolean {
    const goal = this.deps.goalPlanner.getPlan(goalId, actorId);
    if (!goal) return false;
    const steps: PlanStep[] = this.deps.goalPlanner.stepsOf(goal);
    const done = steps.filter((s) => s.status === "done" || s.status === "skipped").length;
    // 每完成 2 步汇报一次（且不重复同一里程碑）
    const milestone = Math.floor(done / 2) * 2;
    if (milestone === 0) return false;
    if ((this.reportedMilestones.get(goalId) ?? 0) >= milestone) return false;
    this.reportedMilestones.set(goalId, milestone);
    this.deps.emitProposal({
      actorId,
      kind: "goal_progress",
      importance: "low",
      title: `计划「${goal.title}」进展`,
      summary: `已完成 ${done}/${steps.length} 步，我继续盯着。`,
      dedupKey: `goal_runner:progress:${goalId}:${milestone}`,
      source: "goal_runner",
    });
    return true;
  }

  /** 诊断快照（/api/proactivity/goals/runner） */
  status(): {
    enabled: boolean;
    tickMs: number;
    tracked: number;
    recentAdvances: Array<{ goalId: string; at: number }>;
  } {
    return {
      enabled: this.enabled(),
      tickMs: this.tickIntervalMs(),
      tracked: this.lastAdvanceAt.size,
      recentAdvances: [...this.lastAdvanceAt.entries()]
        .map(([goalId, at]) => ({ goalId, at }))
        .sort((a, b) => b.at - a.at)
        .slice(0, 20),
    };
  }
}

/** skill 工具 goal.runner.status 的文本渲染（诊断面） */
export function renderGoalRunnerStatus(runner: GoalRunner): string {
  const s = runner.status();
  if (!s.enabled) return "目标自驱循环：已关闭（GOAL_RUNNER_ENABLED=0）。";
  return `目标自驱循环：运行中（每 ${Math.round(s.tickMs / 1000)}s 扫描，当前跟踪 ${s.tracked} 个目标）。`;
}
