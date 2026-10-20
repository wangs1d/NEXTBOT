/**
 * 记忆仲裁器（Memory Arbitrator）
 *
 * 解决三层记忆通道（agentic / humanLike / narrative / kvSummary）并行召回后的统一融合问题：
 * - 现状：MemoryCortex.recall 默认路径是降级链（agentic → narrative → kvSummary），
 *   同一时刻只有一条通道结果被使用，无法跨通道综合排序；且 agentic 的 8 条结构化记忆
 *   被拍平为单条 item，score 信息丢失。
 * - 本模块：对多通道召回结果做「通道内 score 归一化 → 跨通道指纹去重 → 通道权重 ×
 *   多通道命中加成综合重排」，输出统一排序后的 MemoryRecallItem[]。
 *
 * 设计要点：
 * 1) 通道内归一化用 min-max 映射到 [0.2, 1.0]，保留 0.2 下限避免归一化后为 0 被丢弃；
 *    score 缺失时赋默认 0.5（KV 通道无分数，靠此兜底）。
 * 2) 跨通道去重用 semanticFingerprint（来自 memory-record-utils），同指纹合并为一条，
 *    保留 score 最高者为代表，记录所有命中通道。
 * 3) 综合分数 = Σ(通道权重 × 归一化分) / Σ权重 × (1 + multiChannelBoost × (命中通道数-1))。
 *    多通道一致命中是强信号，给予加成。
 * 4) 仲裁器是无状态纯函数，可独立测试；关闭时回退为简单拼接（向后兼容）。
 */

import type { MemoryRecallItem } from "./types.js";
import {
  contentTokenSet,
  semanticFingerprint,
  tokenOverlapRatio,
} from "../services/memory-record-utils.js";

export type MemoryChannelId =
  | "agentic"
  | "humanLike"
  | "narrative"
  | "kvSummary"
  | "forgotten"
  | "relationship"
  | "association"
  | "experienceLearning"
  | "lifeModel";

/** 单个通道的召回结果（条目已带 source 与可选 score）。 */
export interface ChannelRecallResult {
  channel: MemoryChannelId;
  items: MemoryRecallItem[];
}

export interface MemoryArbitratorConfig {
  enabled: boolean;
  /** 各通道权重，缺失通道按 0.3 兜底。 */
  channelWeights: Partial<Record<MemoryChannelId, number>>;
  /** 最终返回条目数上限。 */
  topN: number;
  /** 每多命中一个通道的加成系数（0.15 = +15%）。 */
  multiChannelBoost: number;
  /** 最终分数低于此值的条目丢弃。 */
  minScoreThreshold: number;
  /** score 缺失时的默认归一化前分值。 */
  defaultScoreWhenMissing: number;
}

export const DEFAULT_ARBITRATOR_CONFIG: MemoryArbitratorConfig = {
  enabled: true,
  channelWeights: {
    agentic: 0.45,
    humanLike: 0.4,
    narrative: 0.35,
    kvSummary: 0.2,
    forgotten: 0.15,
    relationship: 0.25,
    // 联想通道权重提升（0.32 → 0.42）：联想记忆是"跨记忆新认知"的来源，
    // 语义化种子修复后 spread 命中真实节点，联想结果质量提升，值得更高权重。
    association: 0.42,
    experienceLearning: 0.3,
    // 生活模型通道（实体/关系/轨迹）：与结构化事实同为"确定性建模"来源，
    // 权重对齐 relationship（0.25）——环境性、与 query 无强词面相关。
    lifeModel: 0.25,
  },
  topN: 8,
  multiChannelBoost: 0.15,
  minScoreThreshold: 0.1,
  defaultScoreWhenMissing: 0.5,
};

function parseIntEnv(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function parseFloatEnv(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** 从环境变量加载仲裁器配置（未设置时保留默认值）。 */
export function loadArbitratorConfigFromEnv(
  base: MemoryArbitratorConfig = DEFAULT_ARBITRATOR_CONFIG,
): MemoryArbitratorConfig {
  const enabledRaw = process.env.MEMORY_ARBITRATOR_ENABLED;
  const enabled =
    enabledRaw === undefined
      ? base.enabled
      : !(enabledRaw === "0" || enabledRaw.toLowerCase() === "false");

  const channelWeights = { ...base.channelWeights };
  const envKeys: MemoryChannelId[] = [
    "agentic",
    "humanLike",
    "narrative",
    "kvSummary",
    "forgotten",
    "relationship",
    "association",
    "experienceLearning",
    "lifeModel",
  ];
  for (const key of envKeys) {
    const envKey = `MEMORY_ARBITRATOR_${key.toUpperCase()}_WEIGHT`;
    const v = process.env[envKey];
    if (v) {
      const n = parseFloat(v);
      if (Number.isFinite(n)) channelWeights[key] = n;
    }
  }

  return {
    enabled,
    channelWeights,
    topN: parseIntEnv(process.env.MEMORY_ARBITRATOR_TOP_N, base.topN),
    multiChannelBoost: parseFloatEnv(
      process.env.MEMORY_ARBITRATOR_MULTI_CHANNEL_BOOST,
      base.multiChannelBoost,
    ),
    minScoreThreshold: parseFloatEnv(
      process.env.MEMORY_ARBITRATOR_MIN_SCORE,
      base.minScoreThreshold,
    ),
    defaultScoreWhenMissing: base.defaultScoreWhenMissing,
  };
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

/**
 * 通道内 score 归一化：min-max 映射到 [0.2, 1.0]。
 * - 缺失 score 赋 defaultScore。
 * - 所有分值相同（range≈0）时直接 clamp 当前分值，避免除零。
 * - 保留 0.2 下限：防止归一化后最低分为 0 而被 minScoreThreshold 丢弃。
 */
function normalizeChannelScores(
  items: MemoryRecallItem[],
  defaultScore: number,
): Array<MemoryRecallItem & { normalizedScore: number }> {
  const withRaw = items.map((it) => {
    const raw =
      typeof it.score === "number" && Number.isFinite(it.score) ? it.score : defaultScore;
    return { item: it, raw };
  });
  if (withRaw.length === 0) return [];

  const rawVals = withRaw.map((s) => s.raw);
  const min = Math.min(...rawVals);
  const max = Math.max(...rawVals);
  const range = max - min;

  return withRaw.map((s) => {
    const normalized =
      range > 0.001 ? 0.2 + 0.8 * ((s.raw - min) / range) : clamp01(s.raw);
    return { ...s.item, normalizedScore: Math.max(0.2, Math.min(1, normalized)) };
  });
}

interface MergedEntry {
  /** 代表条目（多通道命中时取 score 最高者）。 */
  representative: MemoryRecallItem;
  /** 命中的所有通道。 */
  channels: Set<MemoryChannelId>;
  /** 各通道的归一化分（取该通道内最高）。 */
  normalizedScores: Map<MemoryChannelId, number>;
  fingerprint: string;
  /** 同指纹的其余表述（P1：合并不丢内容，注入时可附注差异）。 */
  variants: string[];
}

/**
 * 跨通道去重：按 semanticFingerprint 分组，同指纹合并为一条 MergedEntry。
 * - 代表条目取归一化分最高者（保留其 content/domain/source 等元信息）。
 * - 记录所有命中通道与各自最高归一化分，供后续综合打分。
 */
function dedupeAcrossChannels(channels: ChannelRecallResult[]): MergedEntry[] {
  const byFp = new Map<string, MergedEntry>();

  for (const ch of channels) {
    const normalized = normalizeChannelScores(ch.items, 0.5);
    for (const item of normalized) {
      const content = typeof item.content === "string" ? item.content.trim() : "";
      if (!content) continue;
      const fp = semanticFingerprint(content) || content.slice(0, 48);
      const normScore = item.normalizedScore;

      const existing = byFp.get(fp);
      if (!existing) {
        byFp.set(fp, {
          representative: { ...item, score: normScore },
          channels: new Set<MemoryChannelId>([ch.channel]),
          normalizedScores: new Map([[ch.channel, normScore]]),
          fingerprint: fp,
          variants: [],
        });
      } else {
        existing.channels.add(ch.channel);
        const existingScore = existing.representative.score ?? 0;
        if (normScore > existingScore) {
          // 更新代表（保留更高分的 content，但合并 source 信息）；旧代表降级为 variant，内容不丢
          const prevContent = existing.representative.content;
          existing.representative = {
            ...item,
            score: normScore,
            source: mergeSource(existing.representative.source, ch.channel),
          };
          if (prevContent && prevContent !== item.content) existing.variants.push(prevContent);
        } else if (content !== existing.representative.content) {
          existing.variants.push(content);
        }
        // 累积该通道最高分
        const prev = existing.normalizedScores.get(ch.channel) ?? 0;
        if (normScore > prev) existing.normalizedScores.set(ch.channel, normScore);
      }
    }
  }

  return [...byFp.values()];
}

function mergeSource(existing: string | undefined, channel: MemoryChannelId): string {
  const set = new Set<string>();
  if (existing) {
    for (const part of existing.split(",")) {
      const t = part.trim();
      if (t) set.add(t);
    }
  }
  set.add(channel);
  return [...set].join(",");
}

/**
 * 时间感知融合（P0）：按 domain 区分的时间常数 τ（小时），近因因子 = exp(-age/τ)。
 * 类人记忆特性——事件/情绪记忆衰减快，事实/技能/人格衰减慢。
 */
const DOMAIN_RECENCY_TAU_HOURS: Record<string, number> = {
  working: 6,
  emotional: 48,
  episodic: 72,
  narrative: 96,
  world: 168,
  relationship: 480,
  semantic: 720,
  procedural: 2160,
  personality: 8760,
};

const DEFAULT_RECENCY_TAU_HOURS = 168;

function recencyFactor(item: MemoryRecallItem, now = Date.now()): number {
  const ts = Date.parse(item.timestamp ?? "");
  if (!Number.isFinite(ts)) return 0.85; // 无时间信息：轻微折中
  const tau = DOMAIN_RECENCY_TAU_HOURS[item.domain] ?? DEFAULT_RECENCY_TAU_HOURS;
  return Math.exp(-Math.max(0, (now - ts) / 3_600_000) / tau);
}

/** 防串台一致性（P2）：query 与记忆实词重叠过低时强降权，下限 0.3（语义分再高也压不过话题不符）。query 太短不启用（无从判断）。 */
function overlapFactor(queryTokens: Set<string> | null, item: MemoryRecallItem): number {
  if (!queryTokens || queryTokens.size < 3) return 1;
  const ratio = tokenOverlapRatio(queryTokens, contentTokenSet(item.content));
  return ratio >= 0.15 ? 1 : 0.3 + 0.7 * (ratio / 0.15);
}

/**
 * 综合打分：通道权重加权平均 × 多通道命中加成 × 近因调制 × 话题一致性调制 × 强度加成。
 * - baseScore = Σ(权重 × 归一化分) / Σ权重
 * - boost = 1 + multiChannelBoost × (命中通道数 - 1)
 * - recency 软调制（权重 0.25）：刚发生 ×1.0，久远下限 ×0.75，避免旧的重要事实被过度压制
 * - overlap 调制：聊 A 话题时 B 话题记忆（语义分高但实词零重叠）被压到最低 0.5
 * - strengthBoost：记忆强度模型（反馈 + 命中次数 + 遗忘曲线）的倍率，作为一等因子
 *   参与统一排序（原实现在仲裁后二次重排，会破坏 domain 配额的多样性保证）
 */
function computeFinalScore(
  entry: MergedEntry,
  config: MemoryArbitratorConfig,
  queryTokens: Set<string> | null,
  strengthBoost: Map<string, number> | undefined,
  now = Date.now(),
): number {
  const hitChannels = entry.channels.size;
  let weightedSum = 0;
  let weightTotal = 0;
  for (const [channel, normScore] of entry.normalizedScores) {
    const w = config.channelWeights[channel] ?? 0.3;
    weightedSum += w * normScore;
    weightTotal += w;
  }
  const baseScore = weightTotal > 0 ? weightedSum / weightTotal : 0.5;
  const boost = 1 + config.multiChannelBoost * Math.max(0, hitChannels - 1);
  const recency = 0.75 + 0.25 * recencyFactor(entry.representative, now);
  const strength = strengthBoost?.get(entry.fingerprint) ?? 1;
  return baseScore * boost * recency * overlapFactor(queryTokens, entry.representative) * strength;
}

/** 分类配额（P4）：topN 内单个 domain 的最大占比，保证注入记忆的类型多样性。 */
const DOMAIN_QUOTA: Record<string, number> = { episodic: 3, semantic: 3, procedural: 1, emotional: 1 };

/** 分类配额分配：高分优先，超配额 domain 的条目让位给其他 domain；全部配额用尽后溢出条目可补位。 */
function applyDomainQuota(scored: Array<{ item: MemoryRecallItem }>, topN: number): MemoryRecallItem[] {
  const picked: typeof scored = [];
  const overflow: typeof scored = [];
  const counts = new Map<string, number>();
  for (const s of scored) {
    const domain = s.item.domain;
    const quota = DOMAIN_QUOTA[domain];
    if (quota === undefined || (counts.get(domain) ?? 0) < quota) {
      counts.set(domain, (counts.get(domain) ?? 0) + 1);
      picked.push(s);
    } else {
      overflow.push(s);
    }
  }
  return [...picked, ...overflow].slice(0, topN).map((s) => s.item);
}

/**
 * 主仲裁入口：多通道召回结果 → 通道内归一化 → 跨通道去重 → 综合重排 → 分类配额。
 *
 * @param channels 各通道的召回结果（条目可带可不带 score）
 * @param config 仲裁配置；未传用默认配置
 * @param opts.query 本次召回的原始 query（用于防串台一致性调制；不传则跳过该因子）
 * @param opts.strengthBoost 语义指纹 → 强度倍率（记忆强度模型产出，缺省 1）。
 *        作为一等因子参与统一排序，替代仲裁后的二次重排。
 * @returns 去重 + 重排后的 MemoryRecallItem[]，每条带融合 score 与合并后的 source
 */
export function arbitrateMemories(
  channels: ChannelRecallResult[],
  config: MemoryArbitratorConfig = DEFAULT_ARBITRATOR_CONFIG,
  opts?: { query?: string; strengthBoost?: Map<string, number> },
): MemoryRecallItem[] {
  if (!config.enabled) {
    // 关闭时简单拼接所有通道（保持向后兼容），不做去重/排序
    const all: MemoryRecallItem[] = [];
    for (const ch of channels) {
      for (const it of ch.items) {
        if (it.content && it.content.trim()) all.push(it);
      }
    }
    return all.slice(0, config.topN);
  }

  const queryTokens = opts?.query ? contentTokenSet(opts.query) : null;
  const merged = dedupeAcrossChannels(channels);
  const scored = merged
    .map((entry) => {
      const finalScore = computeFinalScore(entry, config, queryTokens, opts?.strengthBoost);
      const sources = [...entry.channels].join(",");
      // tiebreaker：命中通道中的最高权重（同分时高权重通道优先，体现通道可信度）
      const maxChannelWeight = Math.max(
        ...[...entry.channels].map((ch) => config.channelWeights[ch] ?? 0.3),
      );
      return {
        item: {
          ...entry.representative,
          score: Number(finalScore.toFixed(4)),
          source: sources,
        } as MemoryRecallItem,
        finalScore,
        maxChannelWeight,
      };
    })
    .filter((s) => s.finalScore >= config.minScoreThreshold)
    .sort((a, b) => {
      // 主排序：综合分数降序
      if (Math.abs(b.finalScore - a.finalScore) > 0.0001) return b.finalScore - a.finalScore;
      // 同分 tiebreaker：高权重通道优先（agentic > narrative > kvSummary）
      return b.maxChannelWeight - a.maxChannelWeight;
    });

  return applyDomainQuota(scored, config.topN);
}

/**
 * 短路判断：agentic 主通道是否已足够充分，无需触发并行仲裁。
 * - 条目数 ≥ minCount 且 top1 score ≥ minTopScore 时短路（低延迟路径）。
 * - 用于 MemoryCortex.recall 默认路径：大多数场景 agentic 充足，避免无谓并行。
 */
export function shouldShortCircuitAgentic(
  agenticItems: MemoryRecallItem[],
  opts: { minCount: number; minTopScore: number },
): boolean {
  if (agenticItems.length < opts.minCount) return false;
  const topScore = agenticItems[0]?.score ?? 0;
  return topScore >= opts.minTopScore;
}

// ============================================================
// 子查询 rank 融合（P2-3）：多意图（subQuery）并行召回的跨列表 RRF
// ============================================================

export interface RankFusionEntry<T> {
  /** 代表条目（各列表中原始分最高者，保留其完整元信息） */
  item: T;
  /** 去重键 */
  key: string;
  /** RRF 原始分 Σ 1/(K+rank_i)——跨列表一致性信号 */
  rrf: number;
  /** 命中的列表数 */
  listsHit: number;
  /** 各列表中的最高原始分（语义分，0-1 可比） */
  bestRaw: number;
  /**
   * 共识融合分 = bestRaw × (1 + min(cap, consensus − 1))，
   * consensus = rrf × (K + bestRank)：单列表命中恒等于 1（分数不变），
   * 多列表一致命中 > 1（按共识比例上浮，cap 封顶防淹没语义分）。
   */
  consensusScore: number;
}

/**
 * 跨列表 RRF 融合：同一记忆被多个子查询命中时，rank 共识应让它浮上来——
 * 「被 2 个子意图各排第 5」优于「被 1 个子意图排第 1」，纯 max-score 合并
 * 感知不到这种一致性。
 *
 * 设计取舍：不直接用 RRF 分数作为输出分（Σ1/(60+rank) 量级 ~0.03，会破坏
 * 下游 0-1 分数语义——短路判断 minTopScore=0.6 与仲裁器 min-max 归一化的
 * 输入都依赖可比的语义分），而是把 RRF 共识作为**乘性加成**作用在最高
 * 原始分上，cap 默认 0.35：近似的分数差会被共识翻转，悬殊的语义差保留。
 *
 * @param lists 各子查询的召回结果（列表内已按分数降序；可为空列表）
 * @param opts.k RRF 常数（默认 60，与 bridge 层 RRF_K 一致）
 * @param opts.maxConsensusBoost 共识加成上限（比例，默认 0.35）
 */
export function fuseRankLists<T>(
  lists: T[][],
  opts?: {
    k?: number;
    keyOf?: (item: T) => string;
    scoreOf?: (item: T) => number;
    maxConsensusBoost?: number;
  },
): RankFusionEntry<T>[] {
  const k = opts?.k ?? 60;
  const cap = opts?.maxConsensusBoost ?? 0.35;
  const keyOf =
    opts?.keyOf ??
    ((item: T) =>
      typeof (item as { content?: unknown })?.content === "string"
        ? ((item as { content: string }).content.trim().slice(0, 64))
        : "");
  const scoreOf =
    opts?.scoreOf ??
    ((item: T) => {
      const s = (item as { score?: unknown })?.score;
      return typeof s === "number" && Number.isFinite(s) ? s : 0;
    });

  const byKey = new Map<string, { entry: RankFusionEntry<T>; bestRank: number }>();
  for (const list of lists) {
    list.forEach((item, rank0) => {
      const key = keyOf(item);
      if (!key) return;
      const rank = rank0 + 1;
      const score = scoreOf(item);
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, {
          entry: { item, key, rrf: 1 / (k + rank), listsHit: 1, bestRaw: score, consensusScore: 0 },
          bestRank: rank,
        });
      } else {
        existing.entry.rrf += 1 / (k + rank);
        existing.entry.listsHit += 1;
        if (score > existing.entry.bestRaw) {
          existing.entry.bestRaw = score;
          existing.entry.item = item;
        }
        existing.bestRank = Math.min(existing.bestRank, rank);
      }
    });
  }

  const out: RankFusionEntry<T>[] = [];
  for (const { entry, bestRank } of byKey.values()) {
    const consensus = entry.rrf * (k + bestRank);
    entry.consensusScore = Math.min(
      1,
      entry.bestRaw * (1 + Math.min(cap, Math.max(0, consensus - 1))),
    );
    out.push(entry);
  }
  return out.sort((a, b) => b.consensusScore - a.consensusScore || b.rrf - a.rrf);
}
