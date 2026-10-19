// 目标板与预执行（GoalBoard + ReadyTray）—— 五层主动性架构 L4 的落地。
//
// 三类目标：
//  - track：跟踪型（盯某件事直到状态变化）—— commitment-board / interest-watch
//    等现有服务保持独立，本板负责跨类型的统一台账与生命周期
//  - preexec：预执行型（后台把"用户接下来大概率要的东西"提前备好）——
//    完成后进 ReadyTray，经 goal 信号流 → goal_ready 评估器 → 仲裁挑时机投递。
//    这是"用户还没开口，东西已经在了"的哇时刻来源。
//  - plan：计划推进型（2026-09-24，对标 Muse 大目标模式）——长期目标拆步、
//    逐步派后台任务推进、随生活变化重排。步骤状态机在 GoalPlanner
//    （proactivity/goal-planner.ts），本板只管台账与生命周期。
//
// 旗舰预执行场景：
//  1. 晨间简报 —— 见 evaluators/morning_brief（数据全本地，即时拼接）
//  2. 会前准备包 —— 本模块 maybeStartMeetingPrep：会议前 20-40min 后台
//     召回相关记忆/待办，备好材料包（异步，完成后进托盘）
//  3. 承诺守约链 —— 见 evaluators/commitment_chain（ask_first 代催，管道确认回流）
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type GoalStatus = "watching" | "preparing" | "ready" | "done" | "expired";

export type GoalRecord = {
  goalId: string;
  actorId: string;
  /** track=盯一件事；preexec=后台提前备一件事；plan=长期目标拆步推进 */
  kind: "track" | "preexec" | "plan";
  /** 场景类型（morning_brief / meeting_prep / commitment_chain / custom） */
  type: string;
  title: string;
  status: GoalStatus;
  createdAt: number;
  readyAt?: number;
  /** ReadyTray 里的就绪载荷（投递正文等） */
  payload?: Record<string, unknown>;
  /** 保质期：ready 后未投递到该时刻作废 */
  expiresAt?: number;
  /** 进度心跳序号（plan 步骤级进展用；feeder fingerprint 带上它防被去重吞掉） */
  rev?: number;

  // ── 验收 / 预算 / 退避（2026-10-19，docs/goal-hybrid-architecture.md §3）──

  /**
   * 达成判据（一句话，用户能听懂、verifier 能判）。
   * 有它才会走语义终审；没有则用「步骤都有结果」的确定性近似。
   */
  successCriteria?: string;
  /** 验收结论；null/缺省 = 未验收 */
  verdict?: "met" | "partial" | "failed" | null;
  verdictNote?: string;
  verifiedAt?: number;

  /** 尝试与退避：连续失败 ≥2 冻结自动推进（转"卡住了"开口） */
  attempts?: {
    count: number;
    lastAt: number;
    failStreak: number;
    lastFailReason?: string;
  };

  /** 目标级预算：防单个 goal 吃掉全局日额度 */
  budget?: { dailySteps: number; spentToday: number; dayKey: string };

  /** 下次可推进时刻（退避算出的确定性闸门） */
  nextEligibleAt?: number;
  /** 显著度 0-1：夜间内省按它排序，决定要不要提、要不要继续推 */
  salience?: number;
  /** 最近一次夜间内省处理的时刻（同类建议冷却内不再重复开口） */
  introspectedAt?: number;
};

/** 目标级日预算默认值（plan 型；track/preexec 不派任务，不消耗） */
export const DEFAULT_GOAL_DAILY_STEPS = 6;
/** 退避档位：0 次失败 10min、1 次 2h、≥2 冻结（返回 Infinity） */
export function backoffMsForFailStreak(failStreak: number, now: number): number {
  if (failStreak <= 0) return now + 10 * 60_000;
  if (failStreak === 1) return now + 2 * 3600_000;
  return Number.POSITIVE_INFINITY;
}

/** 本地日键（YYYY-MM-DD），预算跨天重置用 */
export function dayKeyOf(at: number): string {
  const d = new Date(at);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export type GoalBoardDeps = {
  dataPath: string;
  /** goal 流 feeder（内核信号）：goal 状态变化 → 评估器感知 */
  emitGoal: (goal: GoalRecord) => void;
  /** 记忆召回（会前准备包的数据源；可选） */
  recallMemory?: (query: string, limit: number) => Promise<string[]> | string[];
  nowFn?: () => number;
};

let seq = 0;

export class GoalBoard {
  private readonly goals = new Map<string, GoalRecord>();
  private readonly filePath: string;
  private readonly nowFn: () => number;

  constructor(private readonly deps: GoalBoardDeps) {
    this.filePath = join(deps.dataPath, "goals.json");
    this.nowFn = deps.nowFn ?? Date.now;
    this.load();
  }

  create(input: {
    actorId: string;
    kind: GoalRecord["kind"];
    type: string;
    title: string;
    payload?: Record<string, unknown>;
  }): GoalRecord {
    const goal: GoalRecord = {
      goalId: `g_${Date.now().toString(36)}_${(seq++).toString(36)}`,
      actorId: input.actorId,
      kind: input.kind,
      type: input.type,
      title: input.title,
      status: input.kind === "preexec" ? "preparing" : "watching",
      createdAt: this.nowFn(),
      ...(input.payload ? { payload: input.payload } : {}),
    };
    this.goals.set(goal.goalId, goal);
    this.persist();
    this.deps.emitGoal(goal);
    return goal;
  }

  markReady(goalId: string, payload: Record<string, unknown>): GoalRecord | null {
    const goal = this.goals.get(goalId);
    if (!goal || goal.status === "ready" || goal.status === "done") return goal ?? null;
    goal.status = "ready";
    goal.readyAt = this.nowFn();
    goal.payload = { ...goal.payload, ...payload };
    // ready 后 2h 未投递作废（材料过时没有价值）
    goal.expiresAt = goal.readyAt + 2 * 3600_000;
    this.persist();
    this.deps.emitGoal(goal);
    return goal;
  }

  markDone(goalId: string): void {
    const goal = this.goals.get(goalId);
    if (!goal) return;
    goal.status = "done";
    this.persist();
  }

  /** 按 id 取单条（GoalPlanner / 审计时间线用） */
  get(goalId: string): GoalRecord | null {
    return this.goals.get(goalId) ?? null;
  }

  /**
   * 进度心跳（plan 步骤级进展）：不改状态，rev+1 并补发一次 goal 信号——
   * feeder 的 fingerprint 由装配层带 rev 组成，同状态的中间进展不再被去重吞掉。
   */
  markReadyTouch(goalId: string): void {
    const goal = this.goals.get(goalId);
    if (!goal) return;
    goal.rev = (goal.rev ?? 0) + 1;
    this.persist();
    this.deps.emitGoal(goal);
  }

  // ─────────────── 尝试 / 退避 / 预算 / 验收（2026-10-19）───────────────

  /**
   * 记录一次推进尝试：成功清零 failStreak，失败累加并按档位退避。
   * `failStreak ≥ 2` 时 nextEligibleAt = Infinity（冻结自动推进，转人工开口）。
   */
  noteAttempt(goalId: string, outcome: { ok: boolean; reason?: string }): void {
    const goal = this.goals.get(goalId);
    if (!goal) return;
    const now = this.nowFn();
    const prev = goal.attempts ?? { count: 0, lastAt: now, failStreak: 0 };
    const failStreak = outcome.ok ? 0 : prev.failStreak + 1;
    goal.attempts = {
      count: prev.count + 1,
      lastAt: now,
      failStreak,
      ...(outcome.ok ? {} : { lastFailReason: (outcome.reason ?? "未知原因").slice(0, 200) }),
    };
    // 成功即清除退避（退避只针对失败）；失败按档位算下次可推进时刻
    if (outcome.ok) {
      delete goal.nextEligibleAt;
    } else {
      const next = backoffMsForFailStreak(failStreak, now);
      if (Number.isFinite(next)) goal.nextEligibleAt = next;
      else delete goal.nextEligibleAt; // 冻结：Infinity 不落盘（JSON 会变 null）
    }
    this.persist();
  }

  /** 是否到了可推进时刻（无记录=可推进） */
  isEligible(goalId: string): boolean {
    const goal = this.goals.get(goalId);
    if (!goal) return false;
    if ((goal.attempts?.failStreak ?? 0) >= 2) return false;
    return !goal.nextEligibleAt || goal.nextEligibleAt <= this.nowFn();
  }

  /**
   * 目标级日预算：还剩额度则扣一次并返回 true。
   * 跨天自动重置（dayKey 变化），防单个 goal 吃掉全局日额度。
   */
  trySpendStep(goalId: string, dailySteps = DEFAULT_GOAL_DAILY_STEPS): boolean {
    const goal = this.goals.get(goalId);
    if (!goal) return false;
    const now = this.nowFn();
    const dayKey = dayKeyOf(now);
    const budget = goal.budget && goal.budget.dayKey === dayKey
      ? goal.budget
      : { dailySteps, spentToday: 0, dayKey };
    if (budget.spentToday >= budget.dailySteps) {
      goal.budget = budget;
      this.persist();
      return false;
    }
    budget.spentToday += 1;
    goal.budget = budget;
    this.persist();
    return true;
  }

  /**
   * 写验收结论。met → 走 markReady 进 ReadyTray（挑时机投递）；
   * partial/failed → 停在 watching，由调用方决定是否开口/重排。
   */
  setVerdict(
    goalId: string,
    verdict: "met" | "partial" | "failed",
    note?: string,
    payload?: Record<string, unknown>,
  ): void {
    const goal = this.goals.get(goalId);
    if (!goal) return;
    goal.verdict = verdict;
    if (note) goal.verdictNote = note.slice(0, 300);
    goal.verifiedAt = this.nowFn();
    if (verdict === "met") {
      goal.status = "ready";
      goal.readyAt = goal.verifiedAt;
      goal.expiresAt = goal.readyAt + 2 * 3600_000;
      if (payload) goal.payload = { ...goal.payload, ...payload };
    } else if (verdict === "failed") {
      const prev = goal.attempts ?? { count: 0, lastAt: goal.verifiedAt, failStreak: 0 };
      goal.attempts = {
        count: prev.count + 1,
        lastAt: goal.verifiedAt,
        failStreak: prev.failStreak + 1,
        lastFailReason: (note ?? "验收未通过").slice(0, 200),
      };
    }
    this.persist();
    this.deps.emitGoal(goal);
  }

  /**
   * 显著度衰减（夜间内省）：长期没有动作的目标逐步降权，降到阈值以下
   * 交给内省器问一句「这个还作数吗」，而不是继续闷头推。
   * 返回衰减后的 salience（0-1）。
   */
  decaySalience(goalId: string, opts: { idleDays: number; halfLifeDays?: number }): number {
    const goal = this.goals.get(goalId);
    if (!goal) return 0;
    const halfLife = opts.halfLifeDays ?? 14;
    const base = goal.salience ?? 1;
    const factor = Math.pow(0.5, Math.max(0, opts.idleDays) / halfLife);
    const next = Math.max(0, Math.min(1, base * factor));
    goal.salience = Number(next.toFixed(3));
    this.persist();
    return goal.salience;
  }

  /** 直接设显著度（用户明确关心/完成后回写用） */
  setSalience(goalId: string, value: number): void {
    const goal = this.goals.get(goalId);
    if (!goal) return;
    goal.salience = Math.max(0, Math.min(1, value));
    this.persist();
  }

  /** 记录一次夜间内省处理（同类建议冷却用：防同一目标被夜夜追问） */
  markIntrospected(goalId: string, at = this.nowFn()): void {
    const goal = this.goals.get(goalId);
    if (!goal) return;
    goal.introspectedAt = at;
    this.persist();
  }

  /** 按 actor 取全部目标（内省/成本聚合用，含各类 kind） */
  listAll(actorId: string): GoalRecord[] {
    return this.list(actorId);
  }

  /** 移除目标（memory.forget 定向遗忘用；actorId 给出时校验归属） */
  remove(goalId: string, actorId?: string): boolean {
    const goal = this.goals.get(goalId);
    if (!goal) return false;
    if (actorId && goal.actorId !== actorId) return false;
    this.goals.delete(goalId);
    this.persist();
    return true;
  }

  /** ReadyTray：status=ready 且未过期的目标（晨间简报/心跳回顾拼接展示） */
  readyTray(): GoalRecord[] {
    const now = this.nowFn();
    const ready: GoalRecord[] = [];
    for (const goal of this.goals.values()) {
      if (goal.status === "ready" && (!goal.expiresAt || goal.expiresAt > now)) ready.push(goal);
    }
    return ready;
  }

  list(actorId?: string): GoalRecord[] {
    const all = [...this.goals.values()].sort((a, b) => b.createdAt - a.createdAt);
    return actorId ? all.filter((g) => g.actorId === actorId) : all;
  }

  stats(): { total: number; preparing: number; ready: number; done: number } {
    let preparing = 0;
    let ready = 0;
    let done = 0;
    for (const g of this.goals.values()) {
      if (g.status === "preparing" || g.status === "watching") preparing += 1;
      else if (g.status === "ready") ready += 1;
      else if (g.status === "done") done += 1;
    }
    return { total: this.goals.size, preparing, ready, done };
  }

  /**
   * 旗舰场景 2：会前准备包。下一个会议在 20-40 分钟内且该会议尚未备过 →
   * 建 preexec 目标，后台召回相关记忆/材料，完成后 markReady 进托盘。
   * 窗口下限 20min（原 25）：日程传感器 5min 轮询粒度下，15min 宽的窗口
   * 常因边界取整整轮错过（2026-09-24 E2E 实证 goal_ready 历史零触发），
   * 20min 宽保证至少 4 个采样点命中。幂等：同一 runAt 只备一次。
   */
  maybeStartMeetingPrep(actorId: string, meeting: { title: string; runAtMin: number; runAt?: number }): GoalRecord | null {
    if (meeting.runAtMin < 20 || meeting.runAtMin > 40) return null;
    const prepKey = `meeting_prep:${meeting.runAt ?? meeting.title}`;
    for (const g of this.goals.values()) {
      if (g.type === "meeting_prep" && g.payload?.prepKey === prepKey) return null;
    }
    const goal = this.create({
      actorId,
      kind: "preexec",
      type: "meeting_prep",
      title: `会前准备：${meeting.title}`,
      payload: { prepKey, meetingTitle: meeting.title },
    });
    void this.prepareMeetingMaterials(goal).catch(() => {
      /* 准备失败静默：目标停在 preparing，超时自然过期 */
    });
    return goal;
  }

  private async prepareMeetingMaterials(goal: GoalRecord): Promise<void> {
    const title = String(goal.payload?.meetingTitle ?? goal.title);
    const lines: string[] = [];
    if (this.deps.recallMemory) {
      const items = await this.deps.recallMemory(title, 3);
      for (const item of items) lines.push(item);
    }
    const body =
      lines.length > 0
        ? `关于「${title}」我翻到的上下文：${lines.join("；")}。材料都在手边，随时开工。`
        : `「${title}」的相关背景我先过了一遍，没翻到历史交互。需要补充材料就说一声。`;
    this.markReady(goal.goalId, {
      body,
      bodyKind: "meeting_prep",
      dedupFields: { title: `会前准备：${title}` },
    });
  }

  private load(): void {
    try {
      if (!existsSync(this.filePath)) return;
      const raw = JSON.parse(readFileSync(this.filePath, "utf8")) as GoalRecord[];
      for (const goal of raw) this.goals.set(goal.goalId, goal);
    } catch {
      /* 损坏文件按空板处理 */
    }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      // 只保留近 7 天的目标（台账瘦身）
      const cutoff = this.nowFn() - 7 * 24 * 3600_000;
      const list = [...this.goals.values()].filter((g) => g.createdAt > cutoff);
      writeFileSync(this.filePath, JSON.stringify(list, null, 1));
    } catch {
      /* 落盘失败忽略 */
    }
  }
}
