/**
 * 统一遗忘与恢复策略（Retention Policy）——**唯一事实源**。
 *
 * 背景（2026-11-13）：记忆系统此前有两套并行的遗忘机制——
 *
 *   A. KV 摘要三档（services/memory-manager-service.ts）
 *      remembered / faded / forgotten（+ forgottenArchive），
 *      恢复 = 把 forgotten 行移回 memory_summary。
 *
 *   B. 认知图五档（brain/memory-cognitive/memory-forgetting-controller.ts）
 *      deletionStage: active → downranked → cold → soft_deleted → hard_deleted，
 *      恢复 = reawakenNode（deletionStage 回退一级 + frequencyScore += 0.3）。
 *
 * 两边虽然共用同一条衰减曲线（memoryDecayFactor），但**档位定义、阈值、
 * 恢复动作各写一份**：同一段记忆在 KV 还热着、在认知图已经降档；被想起后
 * 两边的「回来方式」也不一样（KV 不刷新时间戳 → 下一次整理立刻又被遗忘；
 * 认知图加频次分 → 不容易被再次遗忘）。
 *
 * 本模块把三件事收敛成一份定义，各存储只保留「档位 ↔ 自己的字段」这一层
 * 薄适配（KV bucket / hm deletionStage）：
 *
 *   1. 衰减曲线：MEMORY_DECAY_HALF_LIFE_DAYS + memoryDecayFactor
 *   2. 档位阶梯：hot → warm → cold → archived → purged（+ 阈值）
 *   3. 恢复动作：restoreAction(tier) → { tier, boost, refreshTimestamp }
 *
 * 原则：**档位语义与存储无关**。「hot」在 KV 是 remembered、在认知图是
 * active；「cold」在 KV 是 forgotten、在认知图是 cold。存储只做映射，不
 * 自己再定义一套阈值。
 */

// ============================================================
// 1. 衰减曲线（自 memory-record-utils 迁入，成为唯一事实源）
// ============================================================

/**
 * 全局遗忘半衰期（天）。
 *
 * 此前 KV memory_summary 路径硬编码 `4 * Math.LN2`（≈2.77 天，等价旧的
 * 96 小时指数衰减时间常数），而认知图节点、读侧遗忘梯度、排序分三处都用
 * 7 天——同一套曲线两套校准。现在任何存储层的衰减都走这个常量。
 */
export const MEMORY_DECAY_HALF_LIFE_DAYS = 7;

export interface MemoryDecayInput {
  /** 距上次发生/访问的天数（>=0） */
  ageDays: number;
  /** 累计命中次数（间隔重复：越常用衰减越慢） */
  accessCount?: number;
  /** 情绪显著性 0-1（高光/至暗记忆衰减更慢） */
  emotionalSalience?: number;
}

/**
 * 人脑式遗忘曲线：
 *   base = 0.5^(ageDays / MEMORY_DECAY_HALF_LIFE_DAYS)
 *   + 访问频率加成（最多 +0.35）
 *   + 情绪加成（最多 +0.25）
 * 结果 clamp 到 0..1。
 */
export function memoryDecayFactor(input: MemoryDecayInput): number {
  const ageDays = Number.isFinite(input.ageDays) ? Math.max(0, input.ageDays) : 30;
  const base = Math.pow(0.5, ageDays / MEMORY_DECAY_HALF_LIFE_DAYS);
  const accessBoost = Math.min(0.35, Math.max(0, input.accessCount ?? 0) * 0.04);
  const emotionBoost = Math.min(0.25, Math.max(0, Math.min(1, input.emotionalSalience ?? 0) * 0.25));
  return Math.max(0, Math.min(1, base + accessBoost + emotionBoost));
}

// ============================================================
// 2. 档位阶梯
// ============================================================

/**
 * 统一档位（存储无关）。
 *
 * - hot     强保留：高频 / 高价值，进 prompt 的首选
 * - warm    淡化保留：还在，但不值钱（降序命中）
 * - cold    低价值：仍可召回，靠排序压后
 * - archived 归档：不主动召回，被命中可恢复
 * - purged  遗忘：只剩可恢复的残骸
 */
export type RetentionTier = "hot" | "warm" | "cold" | "archived" | "purged";

export const RETENTION_TIER_ORDER: readonly RetentionTier[] = [
  "hot",
  "warm",
  "cold",
  "archived",
  "purged",
];

/**
 * 档位阈值（唯一来源）。
 *
 * - hot: 1.15 —— 沿用 KV 摘要「值得记住」的门槛
 * - warm: 0.45 —— 沿用 KV 摘要「淡化但保留」的门槛
 * - cold: 0.20 —— 沿用认知图「降一档」的门槛
 * - archived: 0.10 —— 沿用认知图「剪枝连接」的门槛
 */
export const RETENTION_THRESHOLDS = {
  hot: 1.15,
  warm: 0.45,
  cold: 0.2,
  archived: 0.1,
} as const;

export type RetentionThresholds = {
  hot: number;
  warm: number;
  cold: number;
  archived: number;
};

function numEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const v = Number(raw);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/**
 * 生效阈值（可被环境变量覆盖）。
 *
 * 保留 BRAIN_MEMORY_FORGET_* 这两个历史变量名（线上已在用），但**它们的
 * 含义从「认知图专用」升级为「全局档位边界」**——KV 摘要与认知图从此共用
 * 同一组旋钮，不会再出现「一边调了、另一边没跟着调」。
 */
export function retentionThresholds(): RetentionThresholds {
  return {
    hot: numEnv("MEMORY_RETENTION_HOT_THRESHOLD", RETENTION_THRESHOLDS.hot),
    warm: numEnv("MEMORY_RETENTION_WARM_THRESHOLD", RETENTION_THRESHOLDS.warm),
    cold: numEnv("BRAIN_MEMORY_FORGET_DECAY_THRESHOLD", RETENTION_THRESHOLDS.cold),
    archived: numEnv("BRAIN_MEMORY_FORGET_PRUNE_THRESHOLD", RETENTION_THRESHOLDS.archived),
  };
}

/** 分数 → 档位。低于 archived 阈值即 purged。 */
export function tierForScore(
  score: number,
  thresholds: RetentionThresholds = retentionThresholds(),
): RetentionTier {
  const s = Number.isFinite(score) ? score : 0;
  if (s >= thresholds.hot) return "hot";
  if (s >= thresholds.warm) return "warm";
  if (s >= thresholds.cold) return "cold";
  if (s >= thresholds.archived) return "archived";
  return "purged";
}

/** 档位序号（越大越冷）。 */
export function tierRank(tier: RetentionTier): number {
  const idx = RETENTION_TIER_ORDER.indexOf(tier);
  return idx < 0 ? 0 : idx;
}

/** 降一档（遗忘方向）。已是 purged 返回 null。 */
export function lowerTier(tier: RetentionTier): RetentionTier | null {
  const idx = tierRank(tier);
  if (idx >= RETENTION_TIER_ORDER.length - 1) return null;
  return RETENTION_TIER_ORDER[idx + 1]!;
}

/** 升一档（恢复方向）。已是 hot 返回 null。 */
export function higherTier(tier: RetentionTier): RetentionTier | null {
  const idx = tierRank(tier);
  if (idx <= 0) return null;
  return RETENTION_TIER_ORDER[idx - 1]!;
}

// ============================================================
// 3. 恢复动作
// ============================================================

/** 再唤醒强度加成（远超普通 recall 的 +0.06）。 */
export const RETENTION_RESTORE_BOOST = 0.3;

export interface RetentionRestoreAction {
  /** 恢复到哪一档 */
  tier: RetentionTier;
  /** 频次/强度加成（认知图用；KV 无频次分则忽略） */
  boost: number;
  /**
   * 是否刷新「最近发生时间」。
   *
   * 这是恢复能否生效的关键：KV 摘要行的年龄取自行首 `[ISO 时间戳]`，不刷新
   * 时间戳的话，被恢复的行**下一次整理立刻又被遗忘**——恢复等于没做。
   */
  refreshTimestamp: boolean;
}

/**
 * 恢复动作（唯一来源）：被想起 → 回一档 + 加频次分 + 刷新时间。
 *
 * hot 不需要恢复（本来就在）；其余档位统一「升一档」。
 */
export function restoreAction(tier: RetentionTier): RetentionRestoreAction | null {
  const target = higherTier(tier);
  if (!target) return null;
  return { tier: target, boost: RETENTION_RESTORE_BOOST, refreshTimestamp: true };
}

// ============================================================
// 4. 存储适配（档位 ↔ 各存储自己的字段）
// ============================================================

/** KV 摘要三档（memory-manager-service 的 remembered/faded/forgotten）。 */
export type KvRetentionBucket = "remembered" | "faded" | "forgotten";

/** 档位 → KV 桶位。KV 只有「在 summary 里」与「在 forgotten 里」两个落点。 */
export const KV_BUCKET_BY_TIER: Record<RetentionTier, KvRetentionBucket> = {
  hot: "remembered",
  warm: "faded",
  cold: "forgotten",
  archived: "forgotten",
  purged: "forgotten",
};

/** 遗忘侧判定结果（只关心「要不要降档 / 要不要剪枝」）。 */
export type ForgettingVerdict = "keep" | "archive" | "purge";

/**
 * 遗忘侧判定：只看两条边界（cold / archived）。
 *
 * 与 tierForScore 的区别：档位阶梯里的 hot / warm 只在**留存分桶**时用
 * （KV 的 remembered/faded），遗忘侧不关心——一条记忆只要没跌破 cold 边界，
 * 就不该被降档。
 */
export function forgettingVerdict(
  score: number,
  thresholds: RetentionThresholds = retentionThresholds(),
): ForgettingVerdict {
  const s = Number.isFinite(score) ? score : 0;
  if (s >= thresholds.cold) return "keep";
  if (s >= thresholds.archived) return "archive";
  return "purge";
}

/**
 * KV 桶位 → 档位（用于恢复时定位「这条现在算哪一档」）。
 *
 * forgotten 桶里混装了 cold/archived/purged 三档（KV 分不出来），
 * 统一按 cold 对待——恢复是「升一档」，从 cold 升到 warm 正好落回 summary。
 */
export const TIER_BY_KV_BUCKET: Record<KvRetentionBucket, RetentionTier> = {
  remembered: "hot",
  faded: "warm",
  forgotten: "cold",
};

/**
 * KV 适配：某个桶位被想起后应落到哪个桶位。
 * forgotten → faded（= 回到 summary 桶，重新参与召回与打分）。
 */
export function kvBucketAfterRestore(bucket: KvRetentionBucket): KvRetentionBucket {
  const tier = TIER_BY_KV_BUCKET[bucket];
  const action = restoreAction(tier);
  return KV_BUCKET_BY_TIER[action?.tier ?? tier];
}

/** 认知图 deletionStage（与 human-like-memory-service 的定义一致）。 */
export type MemoryDeletionStageLike =
  | "active"
  | "downranked"
  | "cold"
  | "soft_deleted"
  | "hard_deleted";

/** 档位 → 认知图 deletionStage。 */
export const HM_STAGE_BY_TIER: Record<RetentionTier, MemoryDeletionStageLike> = {
  hot: "active",
  warm: "downranked",
  cold: "cold",
  archived: "soft_deleted",
  purged: "hard_deleted",
};

/** 认知图 deletionStage → 档位。 */
export const TIER_BY_HM_STAGE: Record<MemoryDeletionStageLike, RetentionTier> = {
  active: "hot",
  downranked: "warm",
  cold: "cold",
  soft_deleted: "archived",
  hard_deleted: "purged",
};

/**
 * 认知图适配：某个 deletionStage 被想起后应落到哪个 stage。
 *
 * 与 KV 的唯一差异：hard_deleted 是终态（物理删除），不复活——节点本体
 * 已被剪除，回退到 soft_deleted 等于把删掉的东西捡回来。
 */
export function hmStageAfterRestore(stage: MemoryDeletionStageLike): MemoryDeletionStageLike {
  if (stage === "hard_deleted") return "hard_deleted";
  const tier = TIER_BY_HM_STAGE[stage];
  const action = restoreAction(tier);
  return HM_STAGE_BY_TIER[action?.tier ?? tier];
}

/**
 * KV 摘要行的时间戳刷新（恢复用）。
 *
 * 行格式：`[2026-11-05T10:00:00.000Z] [topic:phone] 正文`。
 * 恢复时把首部时间戳换成现在，否则行龄仍然是旧的，下一轮整理照旧遗忘。
 */
export function refreshMemoryLineTimestamp(line: string, nowIso: string): string {
  const m = /^(\s*)\[(\d{4}-\d{2}-\d{2}T[^\]]*)\]/.exec(line);
  if (!m) return line;
  const indent = m[1] ?? "";
  const rest = line.slice(m[0].length);
  return `${indent}[${nowIso}]${rest}`;
}
