// ReachDecisionService —— 期望效用决策层的运行时包装。
//
// 把纯决策引擎 evaluateReach 与两个既有事实源接起来：
//   - arbiter-v2.interruptCost → 上下文成本（不重复实现传感器）
//   - OutcomeStore                          → outcome 反馈的 pos/neg 计数 → Beta 后验 p
//
// 服务本身无定时器、无 IO 写、无 LLM；decide() 是"算一次"的同步调用。
// 这样语音条工具、语音通话、未来的主动消息通道都能在发送前问一句"该不该说、用哪个通道"。
import {
  evaluateReach,
  estimateAcceptance,
  reachValueFromImportance,
  // 诊断配置快照（调参唯一事实源，避免接口里复制魔数）
  BATCH_MIN_UTILITY,
  BURST_BREAKER,
  CHANNEL_POLICY,
  CONTEXT_COST_DIVISOR,
  CONTEXT_COST_WEIGHT,
  DEFER_CONTEXT_COST,
  DEFAULT_BENEFICIARY,
  DEFAULT_URGENCY,
  IMPORTANCE_STAKES,
  PRIOR_ALPHA,
  PRIOR_BETA,
  RELATIONSHIP_WEIGHT,
  SOCIAL_DEFAULT_RELATIONSHIP,
  VALUE_MODULATORS,
} from "./reach-decision.js";
import {
  getReachDecisionStats,
  listReachDecisions,
  recordReachDecision,
  toReachDecisionLogEntry,
} from "./reach-decision-log.js";
import type { ReachDecisionLogQuery, ReachDecisionLogEntry } from "./reach-decision-log.js";
import type {
  ReachChannel,
  ReachContext,
  ReachDecision,
  ReachDecisionInput,
  ReachValue,
} from "./reach-decision.js";
import type { ProactiveImportance } from "./pipeline-types.js";

/** 反馈信号映射：OutcomeStore 的 outcome 字符串 → 正/负样本。 */
const POSITIVE_OUTCOMES = new Set(["accepted", "replied", "snoozed"]);
const NEGATIVE_OUTCOMES = new Set(["dismissed", "ignored"]);

export type ReachOutcomeCounts = { positive: number; negative: number };

export type ReachDecisionServiceDeps = {
  /**
   * 读某 (actor, kind) 的反馈计数（来自 OutcomeStore）。未注入 = 用均匀先验 p=0.5。
   * 只统计已决策 outcome（accepted/replied/snoozed 正、dismissed/ignored 负），
   * delivered/viewed 不计入——与 OutcomeStore.acceptanceRate 同口径。
   */
  feedback?: (actorId: string, kind: string) => ReachOutcomeCounts;
  /**
   * 采样某 actor 的上下文成本（arbiter-v2.interruptCost 的 0-10 原值）。
   * 未注入 = 0（无打扰）。bootstrap 注入 arbiter.snapshot + interruptCost。
   */
  contextCost?: (actorId: string) => number;
  /** 近 30min 主动投递次数（突发熔断）。未注入 = 0。 */
  recentBurst?: (actorId: string) => number;
  /** 用户是否在线。未注入 = true。 */
  online?: (actorId: string) => boolean;
  nowFn?: () => Date;
};

/**  voiced 通道的决策调用参数（触发源只需给语义量，不必构造完整输入）。 */
export type ReachAsk = {
  actorId: string;
  kind: string;
  importance: ProactiveImportance;
  tier?: "must" | "social";
  explicit?: boolean;
  requestedChannel?: ReachChannel;
  /** 语音工具显式选通道时置 true：跳过 admission 门槛，仍受守卫约束 */
  respectRequestedChannel?: boolean;
  /** 价值维度；缺省由 importance 派生（social 层自动补默认关系价值） */
  value?: ReachValue;
  /** 紧急加成（有 deadline 且临近时传 0-1）；覆盖 value.urgency */
  urgency?: number;
  /** 受益方；覆盖 value.beneficiary */
  beneficiary?: number;
  /**
   * 关系价值（0-1），覆盖默认推导。
   * 社交型主动（打招呼/接话/关心）传高值；纯事务类保持缺省。
   * 不传时：tier=social 取 SOCIAL_DEFAULT_RELATIONSHIP，其余取 0。
   */
  relationship?: number;
};

export class ReachDecisionService {
  /** 近 30min 已放行的语音类投递时间戳（按 actor）。
   *  arbiter.recentBurst 只统计 proactivePipeline 的投递，voice.* 工具直发不计入；
   *  这里单独记账并并入 recentBurst，才能让突发熔断真的管住"语音条连发"。 */
  private readonly voiceSends = new Map<string, number[]>();
  private static readonly VOICE_BURST_WINDOW_MS = 30 * 60 * 1000;

  constructor(private readonly deps: ReachDecisionServiceDeps = {}) {}

  /** 记录一次已成功发送的语音（由 voice.* 工具在合成推送成功后调用）。 */
  recordVoiceDelivery(actorId: string, now: number = this.nowMs()): void {
    const arr = this.voiceSends.get(actorId) ?? [];
    arr.push(now);
    this.voiceSends.set(actorId, arr);
  }

  private nowMs(): number {
    return this.deps.nowFn?.().getTime() ?? Date.now();
  }

  /** 近 30min 语音条发送次数（含突发窗口内，诊断与频控共用）。 */
  recentVoiceSends(actorId: string, now: number = this.nowMs()): number {
    const cutoff = now - ReachDecisionService.VOICE_BURST_WINDOW_MS;
    const arr = (this.voiceSends.get(actorId) ?? []).filter((t) => t >= cutoff);
    this.voiceSends.set(actorId, arr);
    return arr.length;
  }

  /** 采样并决策：问一次"该不该主动说话、用哪个通道"。 */
  decide(ask: ReachAsk, now: Date = this.deps.nowFn?.() ?? new Date()): ReachDecision {
    const counts = this.deps.feedback?.(ask.actorId, ask.kind) ?? { positive: 0, negative: 0 };
    const p = estimateAcceptance(counts.positive, counts.negative);
    // voice.* 工具直发也要计入突发熔断：arbiter 的 recentBurst 不含直发。
    const burst = Math.max(
      this.deps.recentBurst?.(ask.actorId) ?? 0,
      this.recentVoiceSends(ask.actorId, now.getTime()),
    );
    const context: ReachContext = {
      contextCost: this.deps.contextCost?.(ask.actorId) ?? 0,
      online: this.deps.online?.(ask.actorId) ?? true,
      recentBurst: burst,
    };
    // 关系价值：社交层默认给分（否则 social 提案在旧模型里永远是最低价值档），
    // 触发源可显式覆盖——比如「他刚失恋」这种关系价值极高、信息价值为零的开口。
    const relationship =
      ask.relationship ?? (ask.tier === "social" ? SOCIAL_DEFAULT_RELATIONSHIP : 0);
    const value =
      ask.value ??
      reachValueFromImportance(ask.importance, {
        ...(ask.urgency === undefined ? {} : { urgency: ask.urgency }),
        ...(ask.beneficiary === undefined ? {} : { beneficiary: ask.beneficiary }),
        ...(relationship === 0 ? {} : { relationship }),
      });
    const input: ReachDecisionInput = {
      actorId: ask.actorId,
      kind: ask.kind,
      importance: ask.importance,
      ...(ask.tier === undefined ? {} : { tier: ask.tier }),
      ...(ask.explicit === undefined ? {} : { explicit: ask.explicit }),
      ...(ask.requestedChannel === undefined ? {} : { requestedChannel: ask.requestedChannel }),
      ...(ask.respectRequestedChannel === undefined
        ? {}
        : { respectRequestedChannel: ask.respectRequestedChannel }),
      value,
      context,
      acceptance: p,
      now,
    };
    const decision = evaluateReach(input);
    // 留痕：每次决策都记一条（含被抑制的），供 /api/reach/diagnostics 回答"为什么没说"。
    // 记录失败绝不能影响决策本身——诊断是旁路。
    try {
      recordReachDecision(toReachDecisionLogEntry(ask, decision, now.getTime()));
    } catch {
      /* diagnostic logging is best-effort */
    }
    return decision;
  }

  /** 诊断：当前接受概率后验（不触发其它采样）。 */
  acceptanceOf(actorId: string, kind: string): number {
    const c = this.feedbackCountsOf(actorId, kind);
    return estimateAcceptance(c.positive, c.negative, PRIOR_ALPHA, PRIOR_BETA);
  }

  private feedbackCountsOf(actorId: string, kind: string): ReachOutcomeCounts {
    return this.deps.feedback?.(actorId, kind) ?? { positive: 0, negative: 0 };
  }

  /**
   * 诊断快照：调参配置 + 决策统计 + 最近决策（逐通道 cost/utility/admitted）。
   * actorId/kind 可选过滤；不传则返回全量最近决策（本机 admin 接口调用）。
   */
  diagnostics(opts: ReachDecisionLogQuery = {}): {
    ok: true;
    config: Record<string, unknown>;
    stats: ReturnType<typeof getReachDecisionStats>;
    feedback: { actorId?: string; kind?: string; positive: number; negative: number; p: number } | null;
    decisions: ReachDecisionLogEntry[];
  } {
    const feedback =
      opts.actorId && opts.kind
        ? (() => {
            const c = this.feedbackCountsOf(opts.actorId!, opts.kind!);
            return {
              actorId: opts.actorId,
              kind: opts.kind,
              ...c,
              p: estimateAcceptance(c.positive, c.negative, PRIOR_ALPHA, PRIOR_BETA),
            };
          })()
        : null;
    return {
      ok: true,
      config: {
        channels: CHANNEL_POLICY,
        valueModulators: VALUE_MODULATORS,
        relationship: {
          weight: RELATIONSHIP_WEIGHT,
          socialDefault: SOCIAL_DEFAULT_RELATIONSHIP,
        },
        importanceStakes: IMPORTANCE_STAKES,
        defaults: { urgency: DEFAULT_URGENCY, beneficiary: DEFAULT_BENEFICIARY },
        contextCost: { divisor: CONTEXT_COST_DIVISOR, weight: CONTEXT_COST_WEIGHT },
        thresholds: {
          deferContextCost: DEFER_CONTEXT_COST,
          burstBreaker: BURST_BREAKER,
          batchMinUtility: BATCH_MIN_UTILITY,
        },
        prior: { alpha: PRIOR_ALPHA, beta: PRIOR_BETA },
      },
      stats: getReachDecisionStats(),
      feedback,
      decisions: listReachDecisions(opts),
    };
  }
}
