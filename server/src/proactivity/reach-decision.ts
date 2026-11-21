// ReachDecision —— 主动触达的期望效用决策层（通道无关）。
//
// 主流设计（Meta Muse / OpenAI Dots / Uber driver assistant / notification 系统）的共识：
//   LLM 擅长写"说什么"，不擅长决定"要不要说、什么时候说、用什么通道说"。
//   把开口决策做成确定性的期望效用计算：U = p·B − (1−p)·C。
//
// 本模块是**决策引擎**，不负责投递、不碰 TTS/WS，纯函数可单测。所有"对用户说话"的
// 通道（chat 文本气泡 / voice.message 语音条 / voice.speak 播报 / phone 来电）共用它。
//
// 三条设计不变量：
//   1. 价值挣得通道（channel price of admission）：高价值才负担得起更重的通道。
//      重通道固有打扰成本高、准入门槛高， low-value 提案自然落到 chat 或 batch。
//   2. 显式授权绕过：用户点名要的事（explicit / must / critical）不被效用闸门拦下，
//      对齐既有 must bypass 语义——点名的事必达，过期即失效。
//   3. 反馈学习 p：接受概率来自 outcome 回灌的 Beta 后验，而非拍脑袋常数。
//      被忽略得越多，同类提案越沉默；这就是主流说的"忽略是主要负样本"。
//
// 与既有模块的分工（避免重复造轮子）：
//   - arbiter-v2.interruptCost  → 上下文打断成本的唯一事实源（本模块吃它的归一化值）
//   - OutcomeStore              → outcome 落库与接受率的唯一事实源（本模块吃 pos/neg 计数）
//   - FrequencyGovernor         → 日预算/分 kind 冷却/静默（本模块不重复，只做效用层裁决）
//   - ReachRouter               → 已确认要发之后的通道升级阶梯（本模块在其之前选初始通道）
import type { ProactiveImportance } from "../proactivity/pipeline-types.js";

// ============================================================
// 通道模型
// ============================================================

/** 可触达通道（按固有打扰强度递增排列）。 */
export type ReachChannel = "chat" | "voice.message" | "voice.speak" | "phone";

export const REACH_CHANNELS: readonly ReachChannel[] = [
  "chat",
  "voice.message",
  "voice.speak",
  "phone",
] as const;

/** 每个通道的固有打扰成本（0-1）与净效用准入门槛。
 *  intrusion 进入成本项 C；admission 是 U 需越过的下限——两者共同实现"价值挣得通道"。 */
export type ChannelPolicy = { intrusion: number; admission: number };

export const CHANNEL_POLICY: Record<ReachChannel, ChannelPolicy> = {
  // 文本气泡：可扫一眼、可忽略，最轻
  chat: { intrusion: 0.05, admission: 0.0 },
  // 语音条：微信式，用户主动点开听，比文本重但可延后
  "voice.message": { intrusion: 0.18, admission: 0.12 },
  // 即时播报：直接响，占用听觉，无 UI 跳过
  "voice.speak": { intrusion: 0.32, admission: 0.26 },
  // 来电：振铃 + 占用双手/注意力，最强打扰
  phone: { intrusion: 0.58, admission: 0.45 },
};

/**
 * social 层提案的通道上限（2026-11-19）。
 *
 * 关系价值抬升后，一句「关心」在高接受率下也能把 phone 的 U 挣过 0.45——
 * 那会变成「假借关心打电话」。社交型主动只配最轻的两种通道：
 * 文字气泡，或用户自己点开才听的语音条。响铃/播报永远不用于闲聊。
 */
export const SOCIAL_CHANNEL_REACH: readonly ReachChannel[] = ["chat", "voice.message"] as const;

/** 按 tier 取允许的通道阶梯（must/未声明 = 全通道）。 */
export function allowedChannelsFor(tier: "must" | "social" | undefined): readonly ReachChannel[] {
  return tier === "social" ? SOCIAL_CHANNEL_REACH : REACH_CHANNELS;
}

// ============================================================
// 价值 / 成本 / 输出
// ============================================================

/** 价值维度（0-1）。对齐主流 value = stakes × urgency × beneficiary 的可解释加权。 */
export type ReachValue = {
  /** 事关大小：由 importance 映射，或触发源显式声明 */
  stakes: number;
  /** 时效：临近截止=1，无截止=基线 0.4，过期趋 0 */
  urgency?: number;
  /** 受益方：用户=1，平台=0.5，混合=0.75；平台单方面受益要打折 */
  beneficiary?: number;
  /**
   * 关系价值（0-1）：这句话让关系更近，而不是信息更重要。
   *
   * 为什么需要它：旧模型只有 stakes，而社交型主动（打招呼 / 接上次的话 / 单纯
   * 关心一句）的信息量天然低——low importance → stakes=0.2 → B≈0.12，被忽略
   * 一两次后 p 掉到 0.3，U 直接转负被 drop。这类消息的价值不在「信息增量」，
   * 在「存在感和关系维护」，必须单独计价，否则社交型主动永远站在悬崖边。
   *
   * 缺省 0（不改变既有调用方的排序）。
   */
  relationship?: number;
};

/** 上下文快照（由 arbiter-v2 采样后归一化注入，本模块不自己读传感器）。 */
export type ReachContext = {
  /** arbiter-v2.interruptCost 的原始 0-10 成本，本模块 /10 归一化 */
  contextCost: number;
  /** 用户当前是否在线（离线不发，交管道挂起） */
  online?: boolean;
  /** 近 30min 已主动投递次数（突发熔断） */
  recentBurst?: number;
};

export type ReachDecisionAction = "send_now" | "defer" | "batch" | "drop";

export type ReachDecisionInput = {
  actorId: string;
  kind: string;
  importance: ProactiveImportance;
  tier?: "must" | "social";
  /** 用户显式点名要这次触达（如"发条语音给我"）——绕过效用闸门 */
  explicit?: boolean;
  /** 调用方请求的通道；显式时用它，非显式时作为偏好（若负担得起） */
  requestedChannel?: ReachChannel;
  /**
   * 调用方（voice.* 工具）已明确选定语音通道来"怎么说这句话"。
   * true 时跳过"价值挣得通道"的 admission 扫描，直接评估请求通道：
   *   - 净效用 U > 0 → 放行该通道
   *   - U <= 0 → drop（负反馈仍能压住）
   * 所有守卫（离线/高上下文成本/突发熔断）**依旧生效**——
   * 这正是"用同一套算法防止语音条用得太频繁"的落点。
   */
  respectRequestedChannel?: boolean;
  value: ReachValue;
  context: ReachContext;
  /** 接受概率；缺省用 Beta(1,1) 先验 0.5。服务层用反馈后验覆盖 */
  acceptance?: number;
  now?: Date;
};

/** 单个通道的效用明细（诊断接口展示"为什么选它"）。 */
export type ChannelUtility = {
  channel: ReachChannel;
  cost: number;
  utility: number;
  admitted: boolean;
};

export type ReachDecision = {
  action: ReachDecisionAction;
  /** send_now/defer 时选中的通道；batch/drop 为 null */
  channel: ReachChannel | null;
  /** 选中通道的净效用；drop 时为最大通道效用 */
  utility: number;
  /** 接受概率（诊断） */
  p: number;
  /** 价值分（诊断） */
  value: number;
  /** 成本分（诊断） */
  cost: number;
  reason: string;
  perChannel: ChannelUtility[];
};

// ============================================================
// 权重与阈值（集中定义，测试与调参唯一事实源）
// ============================================================

/**
 * 价值调制系数：urgency / beneficiary 是 stakes 的**乘性调制**，不是加性加分。
 * 根因：加性模型下 beneficiary 默认 1.0 会给任何提案白送 +0.2 底分——
 * 一个 stakes=0 的提案仍拿到 B=0.32，永远降不到 drop，负反馈抑制失效。
 * 乘性模型下 B 由 stakes 主导，调制因子只在 [base, base+span] 内缩放。
 */
export const VALUE_MODULATORS = {
  /** urgencyFactor = 0.75 + 0.25·urgency；无时效(0.4)→0.85，紧急(1)→1.0 */
  urgencyBase: 0.75,
  urgencySpan: 0.25,
  /** beneficiaryFactor = 0.55 + 0.45·beneficiary；平台(0.5)→0.775，用户(1)→1.0 */
  beneficiaryBase: 0.55,
  beneficiarySpan: 0.45,
} as const;

/** importance → stakes 映射（复用 action-utility 同口径，保持一致）。 */
export const IMPORTANCE_STAKES: Record<ProactiveImportance, number> = {
  critical: 0.95,
  high: 0.7,
  medium: 0.45,
  low: 0.2,
};

/**
 * 关系价值对 stakes 的抬升系数。
 *
 * 用 max 而不是加性（加性会给任何提案白送底分，见 VALUE_MODULATORS 注释）：
 * max 只抬「下限」，不改变「信息价值主导」的排序——真正紧急的事仍然排在前面。
 * 0.75 × 0.5（social 默认关系价值）= 0.375，约等于一件 medium 事的分量：
 * 足以让一句有锚点的关心活下来，不足以挤掉临会提醒。
 */
export const RELATIONSHIP_WEIGHT = 0.75;

/** social 层提案的默认关系价值（打招呼 / 接话 / 关心这类无信息增量的开口）。 */
export const SOCIAL_DEFAULT_RELATIONSHIP = 0.5;

/** 默认时效：无 deadline 的提案按基线价值，不因"没有期限"归零。 */
export const DEFAULT_URGENCY = 0.4;
/** 默认受益方：未声明时按用户受益（助手 Products 的默认立场）。 */
export const DEFAULT_BENEFICIARY = 1.0;

/** 上下文成本归一化上限（arbiter 0-10 → 0-1）。 */
export const CONTEXT_COST_DIVISOR = 10;
/** 上下文成本在成本项中的权重（通道固有成本占剩余）。 */
export const CONTEXT_COST_WEIGHT = 0.7;

/**
 * defer 阈值：上下文成本归一化后 >= 此值 → 延后等 pause（不丢，交 arbiter 择时）。
 * 对齐 arbiter-v2 的"高成本等用户停下来"语义。
 */
export const DEFER_CONTEXT_COST = 0.58;
/** 突发熔断：30min 内主动投递超过此数 → batch（攒着，不直投）。 */
export const BURST_BREAKER = 5;
/** batch 下限：没有任何通道越准入，但最大效用仍 >= 此值 → 攒 digest 而非丢弃。 */
export const BATCH_MIN_UTILITY = 0.0;

/** Beta 后验先验（等价 Beta(α,β)）：均匀先验 → 无样本时 p=0.5。 */
export const PRIOR_ALPHA = 1;
export const PRIOR_BETA = 1;

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

export function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

// ============================================================
// 反馈学习：接受概率的 Beta 后验
// ============================================================

/**
 * 由正/负反馈计数估计接受概率 p = (pos+α)/(pos+neg+α+β)。
 * 忽略=负样本，回复/接受=正样本；delivered/viewed 不计入分母（交给 OutcomeStore 过滤）。
 */
export function estimateAcceptance(
  positive: number,
  negative: number,
  alpha = PRIOR_ALPHA,
  beta = PRIOR_BETA,
): number {
  const pos = Math.max(0, Math.floor(positive));
  const neg = Math.max(0, Math.floor(negative));
  return (pos + alpha) / (pos + neg + alpha + beta);
}

// ============================================================
// 纯决策函数（零副作用，可单测）
// ============================================================

/** 计算价值分 B（0-1）：stakes 主导 × 时效/受益方乘性调制。 */
export function computeValue(value: ReachValue): number {
  // 关系价值只抬下限：effectiveStakes = max(信息价值, 关系价值折算)
  const effectiveStakes = Math.max(
    clamp01(value.stakes),
    RELATIONSHIP_WEIGHT * clamp01(value.relationship ?? 0),
  );
  const urgency = value.urgency === undefined ? DEFAULT_URGENCY : clamp01(value.urgency);
  const beneficiary = value.beneficiary === undefined ? DEFAULT_BENEFICIARY : clamp01(value.beneficiary);
  const m = VALUE_MODULATORS;
  const urgencyFactor = m.urgencyBase + m.urgencySpan * urgency;
  const beneficiaryFactor = m.beneficiaryBase + m.beneficiarySpan * beneficiary;
  return round3(clamp01(effectiveStakes * urgencyFactor * beneficiaryFactor));
}

/** 计算某通道的成本分 C（0-1）= 归一化上下文成本 + 通道固有打扰。 */
export function computeCost(channel: ReachChannel, context: ReachContext): number {
  const ctx = clamp01(context.contextCost / CONTEXT_COST_DIVISOR) * CONTEXT_COST_WEIGHT;
  const burst = Math.min(context.recentBurst ?? 0, BURST_BREAKER) / BURST_BREAKER;
  // 突发每级追加少量成本（与通道无关），叠加在上下文成本上
  return round3(Math.min(1, ctx + burst * 0.1 + CHANNEL_POLICY[channel].intrusion));
}

/**
 * 核心决策：U = p·B − (1−p)·C，按通道阶梯裁决。
 *
 * 规则顺序（先命中先出）：
 *   1. explicit / must / critical → 直通（用请求通道，缺省 voice.message），不拦。
 *   2. 离线 → defer（交管道挂起重投，不消耗预算）。
 *   3. 高打断成本 → defer（等 pause）。
 *   4. 突发熔断 → batch。
 *   5. 调用方已选定通道（respectRequestedChannel）且该通道 U > 0 → 直发该通道。
 *   6. 从重到轻遍历通道，第一个 U >= admission 的 → send_now + 该通道。
 *   7. 全部不过门槛但 maxU >= batch 下限 → batch。
 *   8. 其余 → drop（留痕供"上周为什么没提醒我"）。
 * （禁音时段规则已移除，2026-11-20：语音条/播报不再受深夜限制。）
 */
export function evaluateReach(input: ReachDecisionInput): ReachDecision {
  const p = clamp01(input.acceptance ?? 0.5);
  const B = computeValue(input.value);
  const ctxNorm = clamp01(input.context.contextCost / CONTEXT_COST_DIVISOR);
  const must = input.tier === "must" || input.importance === "critical";
  // 通道阶梯按 tier 收窄：social 层不允许响铃/播报（见 SOCIAL_CHANNEL_REACH）
  const allowed = allowedChannelsFor(input.tier);

  const perChannel: ChannelUtility[] = REACH_CHANNELS.map((channel) => {
    const cost = computeCost(channel, input.context);
    const utility = round3(p * B - (1 - p) * cost);
    return {
      channel,
      cost,
      utility,
      admitted: utility >= CHANNEL_POLICY[channel].admission,
    };
  });
  const maxUtility = Math.max(...perChannel.map((c) => c.utility));
  const base = { p: round3(p), value: B, perChannel };

  // 规则 1：显式授权 / 必达 —— 绕过闸门
  if (input.explicit || must) {
    const channel = input.requestedChannel ?? (input.explicit ? "voice.message" : "chat");
    const detail = perChannel.find((c) => c.channel === channel)!;
    return {
      ...base,
      action: "send_now",
      channel,
      utility: detail.utility,
      cost: detail.cost,
      reason: input.explicit ? "explicit_request_bypass" : `must_bypass(importance=${input.importance})`,
    };
  }

  // 规则 2：离线 → 挂起（不消耗预算，交由管道重连补投）
  if (input.context.online === false) {
    return {
      ...base,
      action: "defer",
      channel: null,
      utility: maxUtility,
      cost: ctxNorm,
      reason: "offline_defer",
    };
  }

  // 规则 3：上下文成本过高 → 等 pause
  if (ctxNorm >= DEFER_CONTEXT_COST) {
    return {
      ...base,
      action: "defer",
      channel: null,
      utility: maxUtility,
      cost: ctxNorm,
      reason: `high_context_cost(${ctxNorm} >= ${DEFER_CONTEXT_COST})`,
    };
  }

  // 规则 4：突发熔断 → batch
  if ((input.context.recentBurst ?? 0) >= BURST_BREAKER) {
    return {
      ...base,
      action: "batch",
      channel: null,
      utility: maxUtility,
      cost: ctxNorm,
      reason: `burst_breaker(${input.context.recentBurst})`,
    };
  }

  // 规则 5：调用方明确选定了通道（voice.* 工具自主表达的"用语音说"）。
  // 此时不再用 admission 门槛把语音降到 chat——那会让冷启动（p=0.5）永远发不出语音。
  // 频率控制完全交给已生效的守卫（规则 2-5：离线/静默/高成本/突发）+ 反馈 p：
  //   U > 0 放行；U <= 0 沉默。负反馈越多 p 越低，U 转负自然停。
  if (input.respectRequestedChannel && input.requestedChannel && allowed.includes(input.requestedChannel)) {
    const c = perChannel.find((x) => x.channel === input.requestedChannel)!;
    if (c.utility > 0) {
      return {
        ...base,
        action: "send_now",
        channel: c.channel,
        utility: c.utility,
        cost: c.cost,
        reason: `requested_channel_positive_U(${c.channel},U=${c.utility})`,
      };
    }
    return {
      ...base,
      action: "drop",
      channel: null,
      utility: c.utility,
      cost: c.cost,
      reason: `requested_channel_negative_U(${c.channel},U=${c.utility})`,
    };
  }

  // 规则 6：从重到轻，第一个负担得起的通道（价值挣得通道；social 上限在 allowed 里）
  for (let i = REACH_CHANNELS.length - 1; i >= 0; i--) {
    const c = perChannel[i];
    if (!allowed.includes(c.channel)) continue;
    if (c.admitted) {
      return {
        ...base,
        action: "send_now",
        channel: c.channel,
        utility: c.utility,
        cost: c.cost,
        reason: `admitted(${c.channel}, U=${c.utility} >= ${CHANNEL_POLICY[c.channel].admission})`,
      };
    }
  }

  // 规则 7：不够直投但非全负 → 攒 digest（只按允许通道算，避免被 phone 的高 U 假性托底）
  const allowedMaxUtility = Math.max(
    ...perChannel.filter((c) => allowed.includes(c.channel)).map((c) => c.utility),
  );
  if (allowedMaxUtility >= BATCH_MIN_UTILITY) {
    return {
      ...base,
      action: "batch",
      channel: null,
      utility: allowedMaxUtility,
      cost: ctxNorm,
      reason: `below_admission_max_U=${allowedMaxUtility}`,
    };
  }

  // 规则 8：净效用为负 → 沉默（留痕）
  return {
    ...base,
    action: "drop",
    channel: null,
    utility: maxUtility,
    cost: ctxNorm,
    reason: `net_utility_negative(max_U=${maxUtility})`,
  };
}

/** 把 importance + 时效 + 受益方 + 关系价值 转成 ReachValue 的便捷函数（触发源常用）。 */
export function reachValueFromImportance(
  importance: ProactiveImportance,
  opts?: { urgency?: number; beneficiary?: number; stakes?: number; relationship?: number },
): ReachValue {
  return {
    stakes: opts?.stakes ?? IMPORTANCE_STAKES[importance],
    ...(opts?.urgency === undefined ? {} : { urgency: opts.urgency }),
    ...(opts?.beneficiary === undefined ? {} : { beneficiary: opts.beneficiary }),
    ...(opts?.relationship === undefined ? {} : { relationship: opts.relationship }),
  };
}
