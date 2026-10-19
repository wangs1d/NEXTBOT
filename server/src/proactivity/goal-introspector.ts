/**
 * GoalIntrospector —— 目标夜间内省（2026-10-19，L3 日批档）。
 *
 * 为什么需要它：L2 步进（GoalRunner）只回答「下一步做什么」，回答不了
 * 「这个目标还需不需要存在」。后者要判断力、但**一天做一次就够**——所以放
 * 夜间批处理，一次扫完该 actor 的全部目标，成本近似为零。
 *
 * **零 LLM**：确定性规则（闲置天数 / 显著度 / 验收结论）不花 token；产出的
 * finding 由调度层（goal-nightly.ts）决定是否开口。真正需要判断力的重排建议
 * 交给模型在对话里做（replan 工具），内省只负责「把它推到台面上」。
 *
 * 唯一可选的 LLM 环节是**语义终审**（runNightlyForActor，2026-10-19）：确定性
 * 验收只能判「做没做」，判不了「办得对不对」，所以对 verdict=partial 且带
 * successCriteria 的计划每晚用注入的语义验收器复核一次（默认上限 5 个）。
 * 未注入验收器 = 全程零 LLM，行为与从前完全一致。
 *
 * 四条规则：
 *  - 验收 partial        → 建议重排（"办到一半，要不要换个走法"；同类建议冷却内只提一次）
 *  - 闲置 ≥ warnDays 且显著度低 → 问一句"这个还作数吗"（不是继续闷头推）
 *  - 闲置 ≥ expireDays   → 作废（生活变了，目标该退场）
 *  - 其余                → 只做显著度衰减（不开口）
 */
import type { GoalBoard, GoalRecord } from "./goal-board.js";
import { verifyGoal, type SemanticVerifier, type VerifyStep } from "./goal-verifier.js";

/** 闲置多少天开始问「还作数吗」 */
const DEFAULT_IDLE_WARN_DAYS = 7;
/** 闲置多少天直接作废 */
const DEFAULT_IDLE_EXPIRE_DAYS = 30;
/** 低于该显著度才算"该问了"（没衰减过的不打扰） */
const STALE_SALIENCE = 0.3;
/** 问过之后把显著度抬回该值，避免同一个目标天天问 */
const ASKED_SALIENCE = 0.5;
/** 同类建议（partial 重排）的最小间隔：防同一个目标被夜夜追问 */
const DEFAULT_RECOMMEND_COOLDOWN_MS = 3 * 86_400_000;
/** 每夜最多做几次语义终审（2026-10-19）：验收是增强，不该吃掉夜批预算 */
const DEFAULT_MAX_SEMANTIC_PER_NIGHT = 5;

export type IntrospectAction = "decay" | "ask_stale" | "suggest_replan" | "expire" | "verified_met";

export type IntrospectFinding = {
  goalId: string;
  title: string;
  kind: GoalRecord["kind"];
  idleDays: number;
  salience: number;
  action: IntrospectAction;
  /** 直接可用的开口文案（decay 不开口，故可选） */
  message?: string;
};

export type GoalIntrospectorDeps = {
  goalBoard: GoalBoard;
  nowFn?: () => number;
  idleWarnDays?: number;
  idleExpireDays?: number;
  /** 同类建议冷却（默认 3 天） */
  recommendCooldownMs?: number;
  /**
   * 语义终审（可选）：未注入 = 全程零 LLM。注入后只对带 successCriteria 的
   * partial 计划生效，且失败/判不出时维持原结论（不静默改写）。
   */
  semanticVerifier?: SemanticVerifier | null;
  /** 每夜语义终审次数上限（默认 5） */
  maxSemanticPerNight?: number;
};

function idleDaysOf(goal: GoalRecord, now: number): number {
  const last = goal.attempts?.lastAt ?? goal.readyAt ?? goal.createdAt;
  return Math.max(0, Math.floor((now - last) / 86_400_000));
}

/** 从 plan 目标载荷里读回步骤（语义终审的输入；载荷损坏时返回空 → 跳过复核） */
function planStepsOf(goal: GoalRecord): VerifyStep[] {
  const raw = (goal.payload as { steps?: unknown } | undefined)?.steps;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((s): s is Record<string, unknown> => typeof s === "object" && s !== null)
    .map((s) => ({
      title: typeof s.title === "string" ? s.title : "",
      status: typeof s.status === "string" ? s.status : "todo",
      ...(typeof s.note === "string" && s.note.trim() ? { note: s.note } : {}),
    }));
}

export class GoalIntrospector {
  private readonly nowFn: () => number;
  private readonly idleWarnDays: number;
  private readonly idleExpireDays: number;
  private readonly recommendCooldownMs: number;
  private readonly maxSemanticPerNight: number;

  constructor(private readonly deps: GoalIntrospectorDeps) {
    this.nowFn = deps.nowFn ?? Date.now;
    this.idleWarnDays = deps.idleWarnDays ?? DEFAULT_IDLE_WARN_DAYS;
    this.idleExpireDays = deps.idleExpireDays ?? DEFAULT_IDLE_EXPIRE_DAYS;
    this.recommendCooldownMs = deps.recommendCooldownMs ?? DEFAULT_RECOMMEND_COOLDOWN_MS;
    this.maxSemanticPerNight = deps.maxSemanticPerNight ?? DEFAULT_MAX_SEMANTIC_PER_NIGHT;
  }

  /** 同类建议是否还在冷却期（冷却中只衰减、不重复开口） */
  private inCooldown(goal: GoalRecord, now: number): boolean {
    const last = goal.introspectedAt ?? 0;
    return last > 0 && now - last < this.recommendCooldownMs;
  }

  /**
   * 扫一个 actor 的全部在办目标，返回需要处理的动作。
   * 纯读 + 显著度衰减（会写盘）：不派任务、不花 token。
   */
  runForActor(actorId: string): IntrospectFinding[] {
    const now = this.nowFn();
    const findings: IntrospectFinding[] = [];
    const goals = this.deps.goalBoard
      .list(actorId)
      .filter((g) => g.status === "watching" || g.status === "preparing");

    for (const goal of goals) {
      const idleDays = idleDaysOf(goal, now);
      const salience = this.deps.goalBoard.decaySalience(goal.goalId, { idleDays });

      if (goal.verdict === "partial") {
        if (this.inCooldown(goal, now)) {
          // 已经推过一次重排建议：冷却期内不重复开口
          findings.push({ goalId: goal.goalId, title: goal.title, kind: goal.kind, idleDays, salience, action: "decay" });
          continue;
        }
        this.deps.goalBoard.markIntrospected(goal.goalId, now);
        findings.push({
          goalId: goal.goalId,
          title: goal.title,
          kind: goal.kind,
          idleDays,
          salience,
          action: "suggest_replan",
          message: `「${goal.title}」上次验收只完成了一部分（${goal.verdictNote ?? "部分步骤没办成"}），要不要换个走法？`,
        });
        continue;
      }

      if (idleDays >= this.idleExpireDays) {
        this.deps.goalBoard.markDone(goal.goalId);
        findings.push({
          goalId: goal.goalId,
          title: goal.title,
          kind: goal.kind,
          idleDays,
          salience,
          action: "expire",
          message: `「${goal.title}」已经 ${idleDays} 天没动，我先停掉；还想推进随时说。`,
        });
        continue;
      }

      if (idleDays >= this.idleWarnDays && salience < STALE_SALIENCE) {
        // 抬回显著度做去重：同一目标不会连续多天追问
        this.deps.goalBoard.setSalience(goal.goalId, ASKED_SALIENCE);
        findings.push({
          goalId: goal.goalId,
          title: goal.title,
          kind: goal.kind,
          idleDays,
          salience,
          action: "ask_stale",
          message: `「${goal.title}」搁了 ${idleDays} 天，这个还作数吗？要是不着急我就先放着。`,
        });
        continue;
      }

      findings.push({
        goalId: goal.goalId,
        title: goal.title,
        kind: goal.kind,
        idleDays,
        salience,
        action: "decay",
      });
    }
    return findings;
  }

  /**
   * 夜批入口（2026-10-19）：确定性内省 + 可选语义复核。
   *
   * 语义复核解决的问题：确定性验收把「步骤都做完了但没留下结果说明」判成
   * partial，于是计划永远卡在 partial、夜夜被建议重排。语义验收器能看出
   * 「其实办成了」（例如结果写在了别的步骤备注里/产出物里），翻案成 met 进
   * ReadyTray。判否或判不出 → 维持 partial，绝不静默改成达成。
   */
  async runNightlyForActor(actorId: string): Promise<IntrospectFinding[]> {
    const findings = this.runForActor(actorId);
    const semantic = this.deps.semanticVerifier;
    if (!semantic) return findings;

    const now = this.nowFn();
    let budget = this.maxSemanticPerNight;
    const promoted: IntrospectFinding[] = [];
    for (const goal of this.deps.goalBoard.list(actorId)) {
      if (budget <= 0) break;
      if (goal.verdict !== "partial" || !goal.successCriteria) continue;
      if (goal.status !== "watching" && goal.status !== "preparing") continue;
      const steps = planStepsOf(goal);
      if (steps.length === 0) continue;
      budget -= 1;
      const res = await verifyGoal({ title: goal.title, successCriteria: goal.successCriteria, steps }, semantic);
      if (res?.mode !== "semantic" || res.verdict !== "met") continue;
      this.deps.goalBoard.setVerdict(goal.goalId, "met", res.note, {
        body: `「${goal.title}」我复核过了：${res.note}`,
        bodyKind: "plan_done",
        dedupFields: { title: `计划完成：${goal.title}` },
      });
      this.deps.goalBoard.markIntrospected(goal.goalId, now);
      promoted.push({
        goalId: goal.goalId,
        title: goal.title,
        kind: goal.kind,
        idleDays: idleDaysOf(goal, now),
        salience: goal.salience ?? 1,
        action: "verified_met",
        message: `「${goal.title}」我复核了一遍，其实办成了：${res.note}`,
      });
    }

    if (promoted.length === 0) return findings;
    // 翻案的目标不再同时推「要不要换个走法」
    const promotedIds = new Set(promoted.map((p) => p.goalId));
    return [...findings.filter((f) => !promotedIds.has(f.goalId)), ...promoted];
  }

  /** 只取需要开口的（装配层夜间任务用） */
  actionable(actorId: string): IntrospectFinding[] {
    return this.runForActor(actorId).filter(
      (f) =>
        f.action === "ask_stale" ||
        f.action === "suggest_replan" ||
        f.action === "expire" ||
        f.action === "verified_met",
    );
  }
}
