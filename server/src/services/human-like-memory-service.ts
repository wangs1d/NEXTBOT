import { getDataDir } from "../config/data-dir.js";
import { watch, type FSWatcher } from "node:fs";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { writeJsonAtomic } from "../storage/atomic-json.js";
import { dirname, join } from "node:path";

import { dedupeMemoryLines, areLinesConflicting, contentTokenSet, memoryDecayFactor, normalizeMemoryLine, semanticFingerprint, tokenOverlapRatio } from "./memory-record-utils.js";
import {
  emotionalSalience,
  emotionFromMetadata,
  emotionMatchScore,
  inferEmotionFromText,
  type EmotionSignal,
} from "./emotion-memory.js";
import { fetchOpenAiCompatibleEmbedding } from "./openai-embedding-client.js";
import { GraphSqlitePersistence, resolveHumanMemoryStoreMode } from "./graph-sqlite-store.js";
import {
  classifyMemorySourceRole,
  extractEchoQueryFromAssistantReply,
  type MemorySourceRole,
} from "./memory-source-role.js";
import {
  extractRelationshipAssertion,
  isRelationshipHedgeLine,
  sharedAssertionSubject,
  type RelationshipAssertion,
  type RelationshipSubject,
} from "./memory-relationship-assertion.js";
import type { InferenceNode } from "../brain/types.js";

/** 读取节点来源角色：优先 metadata 打标，旧节点按文本形态即时分类（legacy 兼容）。 */
function resolveNodeRole(node: MemoryNodeRecord): MemorySourceRole {
  const metaRole = node.metadata?.sourceRole;
  return typeof metaRole === "string" ? (metaRole as MemorySourceRole) : classifyMemorySourceRole(node.summary);
}

/**
 * 读取节点情绪：优先 metadata.emotion（写入侧规则推断），旧节点按原文即时推断。
 * P0 情感标记统一入口——召回、情绪边、衰减都从这里取同一口径。
 */
function resolveNodeEmotion(node: MemoryNodeRecord): EmotionSignal {
  return emotionFromMetadata(node.metadata) ?? inferEmotionFromText(node.summary);
}

/** 助手角色节点在召回排序中的降权幅度：发言是行为记录，不是用户事实证据。 */
const ASSISTANT_ROLE_RECALL_PENALTY = 0.22;

/**
 * 真向量 cosine 相似度（方案 C）。
 * 维度不等在数学上无法计算，返回 0 是正确性保护，不是降级；
 * 向量空间由启动回填（backfillNodeVectors）保证与当前端点一致。
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * 异步计算文本的真 embedding（方案 C 核心）。
 * 端点解析统一交给 openai-embedding-client（本地内置引擎优先，其次远端显式配置），
 * 不在这里按 LLM key 预判——本地引擎有自己的 key，预判会把可用端点误杀。
 * 失败直接抛错，由调用方显式记录/上报；不再降级成任何“伪向量”。
 * 带 30min 缓存，避免 ingest 同一文本重复算。
 */
async function computeEmbedding(text: string): Promise<number[]> {
  // P1-8：缓存/并发去重统一走 openai-embedding-client 的 embedThroughCache
  // （此前这里还有一层本地 Map 缓存，双重缓存且跨层不共享）
  const r = await fetchOpenAiCompatibleEmbedding({ input: text, timeoutMs: 3000 });
  return r.vector;
}

/**
 * 从 vectorFingerprint 字段解析真向量。
 * 只有 JSON 序列化的向量数组才算有效；无向量节点返回 null（不参与语义分，
 * 由启动回填补齐，而不是拿文本指纹冒充向量）。
 */
function parseVectorFingerprint(fp: string): number[] | null {
  if (!fp || !fp.startsWith("[")) return null;
  try {
    const parsed = JSON.parse(fp);
    if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === "number") {
      return parsed as number[];
    }
  } catch {
    // 旧格式（非 JSON），降级到 null
  }
  return null;
}

/** 把真向量序列化为 vectorFingerprint 字段可存的字符串 */
function serializeVector(vec: number[]): string {
  return JSON.stringify(vec);
}

export type MemoryContextKind = "main" | "notes";
export type MemoryDomainLifecycle = "knowledge" | "transactional" | "temporary" | "relationship" | "procedural";
export type MemoryNodeKind = "entity" | "event" | "knowledge" | "experience" | "procedure";
export type RecallMode = "single_domain" | "cross_domain";
export type RecallDetailLevel = "summary" | "detail" | "source";
export type MemoryDeletionStage = "active" | "downranked" | "cold" | "soft_deleted" | "hard_deleted";
export type SleepAgentStage =
  | "daily_cleanup"
  | "weekly_merge"
  | "monthly_abstract"
  | "consistency_audit"
  | "promote_knowledge";

export type MemoryVersionRecord = {
  versionId: string;
  previousVersionId: string | null;
  summary: string;
  createdAt: string;
  confidence: number;
  importance: number;
  correctness: "unknown" | "confirmed" | "suspected_error" | "rejected";
};

export type MemoryNodeRecord = {
  id: string;
  actorId: string;
  domainId: string;
  parentDomainId: string | null;
  kind: MemoryNodeKind;
  source: string;
  sourceType: "chat" | "tool" | "digest" | "world" | "system";
  context: MemoryContextKind;
  summary: string;
  rawRef?: string;
  keywords: string[];
  sceneTags: string[];
  emotionTags: string[];
  entityTags: string[];
  semanticFingerprint: string;
  vectorFingerprint: string;
  timestamp: string;
  lastAccessedAt: string;
  accessCount: number;
  importance: number;
  confidence: number;
  frequencyScore: number;
  recencyScore: number;
  domainScore: number;
  userFeedbackScore: number;
  correctness: "unknown" | "confirmed" | "suspected_error" | "rejected";
  deletionStage: MemoryDeletionStage;
  isArchived: boolean;
  /**
   * 双时态（P2-1）：该事实在现实中生效的起点（ISO）。
   * 旧节点缺省按 timestamp 视为生效起点；新增节点落库即写入。
   */
  validFrom?: string;
  /**
   * 双时态（P2-1）：该事实失效的终点（ISO）。null / 缺省 = 当前仍有效。
   * 被新断言覆盖（supersede）时写入；召回只取当前有效的事实。
   */
  validTo?: string | null;
  conflictGroupId?: string;
  currentVersionId: string;
  versionIds: string[];
  metadata?: Record<string, unknown>;
};

export type MemoryEdgeRecord = {
  id: string;
  actorId: string;
  from: string;
  to: string;
  relation: "semantic" | "entity" | "temporal" | "scene" | "emotion" | "manual" | "version";
  weight: number;
  createdAt: string;
  updatedAt: string;
  decayFactor: number;
  hopCost: number;
};

export type MemoryCommunityRecord = {
  id: string;
  actorId: string;
  domainId: string;
  label: string;
  nodeIds: string[];
  createdAt: string;
  updatedAt: string;
};

export type MemoryDomainPolicy = {
  parentDomainId: string | null;
  lifecycle: MemoryDomainLifecycle;
  enabled: boolean;
  retired: boolean;
  retentionDays: number;
  recallWeight: number;
  forgettingFactor: number;
  encryptionLevel: "none" | "standard" | "high";
  coldStorageAfterDays: number;
  softDeleteAfterDays: number;
  hardDeleteAfterDays: number;
  maxCrossDomainHops: number;
};

export type HumanLikeMemoryPolicyFile = {
  version: number;
  domains: Record<string, MemoryDomainPolicy>;
  retrieval: {
    maxRecallItems: number;
    maxCrossDomainItems: number;
    maxHopCount: number;
    diversityPenalty: number;
    userNegativeFeedbackPenalty: number;
    routeCrossDomainConfidenceThreshold: number;
  };
  sleepAgent: {
    enabled: boolean;
    maxNodesPerRun: number;
    maxActionsPerRun: number;
  };
};

export type HumanLikeMemoryStoreShape = {
  version: number;
  domains: Record<string, MemoryDomainPolicy>;
  nodes: Record<string, MemoryNodeRecord>;
  edges: Record<string, MemoryEdgeRecord>;
  versions: Record<string, MemoryVersionRecord>;
  communities: Record<string, MemoryCommunityRecord>;
};

export type HumanLikeMemoryRecallOptions = {
  source?: string;
  context?: MemoryContextKind;
  explicitDomain?: string;
  crossDomain?: boolean;
  limit?: number;
  detailLevel?: RecallDetailLevel;
};

export type HumanLikeMemoryRecallResult = {
  domainId: string;
  mode: RecallMode;
  recalledNodeIds: string[];
  confidence: number;
  text: string;
};

export type HumanLikeMemorySleepReport = {
  actorId: string;
  dailyCleanupCount: number;
  weeklyMergedCount: number;
  monthlyAbstractedCount: number;
  consistencyFlagCount: number;
  knowledgePromotedCount: number;
  compressionRate: number;
  estimatedRecallPrecision: number;
  plannedActions: number;
  executedActions: number;
  /** 本轮物理清除的 hard_deleted 终态节点数（此前只打标不删，store 膨胀） */
  purgedHardDeleted?: number;
  stageReports: Array<{
    stage: SleepAgentStage;
    changed: number;
    notes: string[];
  }>;
};

type HybridRetrievalCandidate = {
  node: MemoryNodeRecord;
  structureScore: number;
  keywordScore: number;
  vectorScore: number;
  finalScore: number;
};

function overlapScore(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) return 0;
  const leftSet = new Set(left.filter(Boolean));
  const rightSet = new Set(right.filter(Boolean));
  if (leftSet.size === 0 || rightSet.size === 0) return 0;
  let overlap = 0;
  for (const item of leftSet) {
    if (rightSet.has(item)) overlap += 1;
  }
  return overlap / Math.max(leftSet.size, rightSet.size);
}

function computeSimilarity(
  left: MemoryNodeRecord,
  right: MemoryNodeRecord,
): { score: number } {
  const semanticScore =
    left.semanticFingerprint.length > 0 && left.semanticFingerprint === right.semanticFingerprint
      ? 1
      : 0;
  // vectorScore 只认真向量 cosine；没有向量的节点记 0，不拿字符串指纹冒充语义分
  const leftVec = parseVectorFingerprint(left.vectorFingerprint);
  const rightVec = parseVectorFingerprint(right.vectorFingerprint);
  const vectorScore = leftVec && rightVec ? Math.max(0, cosineSimilarity(leftVec, rightVec)) : 0;
  const keywordScore = overlapScore(left.keywords, right.keywords);
  const entityScore = overlapScore(left.entityTags, right.entityTags);
  const sceneScore = overlapScore(left.sceneTags, right.sceneTags);
  const emotionScore = overlapScore(left.emotionTags, right.emotionTags);
  const score =
    semanticScore * 0.4 +
    vectorScore * 0.22 +
    keywordScore * 0.2 +
    entityScore * 0.1 +
    sceneScore * 0.05 +
    emotionScore * 0.03;
  return { score: clamp(score, 0, 1) };
}

type SleepAction =
  | { type: "downrank"; nodeId: string; stage: SleepAgentStage; reason: string }
  | { type: "cold"; nodeId: string; stage: SleepAgentStage; reason: string }
  | { type: "soft_delete"; nodeId: string; stage: SleepAgentStage; reason: string }
  | { type: "hard_delete"; nodeId: string; stage: SleepAgentStage; reason: string }
  | { type: "merge"; nodeIds: string[]; stage: SleepAgentStage; reason: string; summary?: string }
  | { type: "promote_knowledge"; nodeIds: string[]; stage: SleepAgentStage; reason: string; summary: string }
  | { type: "mark_error"; nodeId: string; stage: SleepAgentStage; reason: string }
  | { type: "mark_conflict"; nodeIds: string[]; stage: SleepAgentStage; reason: string }
  | { type: "decay_weight"; nodeId: string; stage: SleepAgentStage; reason: string; delta: number };

const DEFAULT_POLICY: HumanLikeMemoryPolicyFile = {
  version: 2,
  domains: {
    general: {
      parentDomainId: null,
      lifecycle: "knowledge",
      enabled: true,
      retired: false,
      retentionDays: 3650,
      recallWeight: 1,
      forgettingFactor: 1,
      encryptionLevel: "none",
      coldStorageAfterDays: 120,
      softDeleteAfterDays: 365,
      hardDeleteAfterDays: 1000,
      maxCrossDomainHops: 2,
    },
    schedule: {
      parentDomainId: "general",
      lifecycle: "transactional",
      enabled: true,
      retired: false,
      retentionDays: 180,
      recallWeight: 0.9,
      forgettingFactor: 1.2,
      encryptionLevel: "standard",
      coldStorageAfterDays: 45,
      softDeleteAfterDays: 120,
      hardDeleteAfterDays: 365,
      maxCrossDomainHops: 1,
    },
    relationship: {
      parentDomainId: "general",
      lifecycle: "relationship",
      enabled: true,
      retired: false,
      retentionDays: 3650,
      recallWeight: 1.2,
      forgettingFactor: 0.8,
      encryptionLevel: "standard",
      coldStorageAfterDays: 240,
      softDeleteAfterDays: 720,
      hardDeleteAfterDays: 2000,
      maxCrossDomainHops: 3,
    },
    profile: {
      parentDomainId: "general",
      lifecycle: "knowledge",
      enabled: true,
      retired: false,
      retentionDays: 3650,
      recallWeight: 1.1,
      forgettingFactor: 0.7,
      encryptionLevel: "high",
      coldStorageAfterDays: 365,
      softDeleteAfterDays: 1000,
      hardDeleteAfterDays: 2000,
      maxCrossDomainHops: 2,
    },
    notes: {
      parentDomainId: "general",
      lifecycle: "knowledge",
      enabled: true,
      retired: false,
      retentionDays: 3650,
      recallWeight: 0.8,
      forgettingFactor: 1,
      encryptionLevel: "none",
      coldStorageAfterDays: 180,
      softDeleteAfterDays: 730,
      hardDeleteAfterDays: 1800,
      maxCrossDomainHops: 2,
    },
    temporary: {
      parentDomainId: "general",
      lifecycle: "temporary",
      enabled: true,
      retired: false,
      retentionDays: 14,
      recallWeight: 0.4,
      forgettingFactor: 1.6,
      encryptionLevel: "none",
      coldStorageAfterDays: 7,
      softDeleteAfterDays: 21,
      hardDeleteAfterDays: 45,
      maxCrossDomainHops: 1,
    },
    procedural: {
      parentDomainId: null,
      lifecycle: "procedural",
      enabled: true,
      retired: false,
      retentionDays: 3650,
      recallWeight: 1.2,
      forgettingFactor: 0.6,
      encryptionLevel: "none",
      coldStorageAfterDays: 365,
      softDeleteAfterDays: 1200,
      hardDeleteAfterDays: 2400,
      maxCrossDomainHops: 2,
    },
  },
  retrieval: {
    maxRecallItems: 8,
    maxCrossDomainItems: 5,
    maxHopCount: 3,
    diversityPenalty: 0.12,
    userNegativeFeedbackPenalty: 0.4,
    routeCrossDomainConfidenceThreshold: 0.42,
  },
  sleepAgent: {
    enabled: true,
    maxNodesPerRun: 300,
    maxActionsPerRun: 120,
  },
};

const DEFAULT_STORE: HumanLikeMemoryStoreShape = {
  version: 2,
  domains: structuredClone(DEFAULT_POLICY.domains),
  nodes: {},
  edges: {},
  versions: {},
  communities: {},
};

/**
 * 向量近重复合并阈值（P1-2）：
 * 同 actor + 同域 + 同 kind 的节点，cosine ≥ 阈值且词面重叠 ≥ 下限时视为
 * 「同一事实的换说法」，合并到旧节点（保留频率/反馈信号），不再新增重复条目。
 * 词面下限取 0.85：只合并措辞微调的重述（多了“工程师/工作”等尾缀），
 * 不把自由改写或仅句式相同的不同事实当重复——"对芒果过敏" vs "对花生过敏"
 * 词面重叠约 0.73，会被挡在合并之外。
 */
const NEAR_DUPLICATE_COSINE = 0.95;
const NEAR_DUPLICATE_TOKEN_OVERLAP = 0.85;

/**
 * 召回注入字符预算（P1-3）：top-N 之外再按字符封顶，防止长记忆把 prompt 预算吃光。
 * 至少注入 1 条（否则相关性最高的长条目会被自己挤掉）。
 */
const DEFAULT_RECALL_CHAR_BUDGET = 1400;

function resolveRecallCharBudget(): number {
  const raw = Number.parseInt(process.env.AGENT_RECALL_CHAR_BUDGET ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_RECALL_CHAR_BUDGET;
}

/**
 * MMR 冗余惩罚（P1-3）：与已选条目词面高度重合的候选降权，把预算让给
 * 信息量不同的条目。只惩罚"重合度高"的部分，不改变任何候选的相关性分。
 */
const MMR_REDUNDANCE_FLOOR = 0.5;
const MMR_REDUNDANCE_WEIGHT = 0.25;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * 自动确认阈值：节点被召回次数 >= 此值时，自动从 "unknown" 升级为 "confirmed"。
 *
 * 设计意图：用户要求"agent 对有用的记忆是牢固的，不需要像人类一样有时候想不起"。
 * "有用"通过召回频次衡量 —— 3 次召回说明这条记忆确实在被反复使用，应锁定不衰减。
 * 阈值过低（1-2 次）会误锁偶发召回；过高（5+ 次）需要太多轮才生效，失去实用性。
 */
const AUTO_CONFIRM_THRESHOLD = 3;

/**
 * deletionStage 回退映射（供 reawakenNode 使用）。
 * 与 ForgettingController 中的 STAGE_ORDER 对应但反向：
 *   cold → downranked → active
 *   soft_deleted → cold
 *   active / hard_deleted 为终态，不再回退。
 */
const STAGE_REGRESS: Record<MemoryDeletionStage, MemoryDeletionStage> = {
  active: "active",
  downranked: "active",
  cold: "downranked",
  soft_deleted: "cold",
  hard_deleted: "hard_deleted",
};

function nowIso(): string {
  return new Date().toISOString();
}

function uniqueStrings(values: string[], limit = 12): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].slice(0, limit);
}

function extractKeywords(text: string): string[] {
  const zh = text.match(/[\u4e00-\u9fff]{2,8}/g) ?? [];
  const en =
    text.toLowerCase().match(/[a-z][a-z0-9_-]{2,24}/g)?.filter((token) => token.length >= 3) ?? [];
  return uniqueStrings([...zh, ...en], 14);
}

/**
 * 汉字串 token → 字符 bigram 集合（英文 token 保持原样）。
 *
 * extractKeywords 抽的是连续汉字串（"我对芒果过敏"整段），查询与事实只要
 * 断句方式不同就零重叠。bigram 化后"过敏/芒果/妻子"等词面片段可部分匹配，
 * 无需分词库即可让换说法的查询命中（见 test/memory-recall-benchmark.test.ts）。
 */
function keywordBigrams(tokens: string[]): Set<string> {
  const grams = new Set<string>();
  for (const token of tokens) {
    if (/^[\u4e00-\u9fff]+$/.test(token)) {
      if (token.length === 1) {
        grams.add(token);
      }
      for (let i = 0; i < token.length - 1; i++) {
        grams.add(token.slice(i, i + 2));
      }
    } else {
      grams.add(token);
    }
  }
  return grams;
}

/** query 与 target 关键词的 bigram 覆盖率（0-1，按较小集合归一）。 */
function bigramOverlapScore(queryTokens: string[], targetTokens: string[]): number {
  const q = keywordBigrams(queryTokens);
  const t = keywordBigrams(targetTokens);
  if (q.size === 0 || t.size === 0) return 0;
  let overlap = 0;
  for (const gram of q) {
    if (t.has(gram)) overlap += 1;
  }
  return overlap / Math.min(q.size, t.size);
}

function extractEntityTags(text: string): string[] {
  const candidates = text.match(/[\u4e00-\u9fffA-Za-z0-9_-]{2,20}/g) ?? [];
  return uniqueStrings(candidates.filter((token) => /[\u4e00-\u9fffA-Z]/.test(token[0] ?? "")), 10);
}

function extractEmotionTags(text: string): string[] {
  const tags: string[] = [];
  if (/开心|高兴|满意|喜欢|期待|兴奋/.test(text)) tags.push("positive");
  if (/难过|焦虑|担心|害怕|压力|生气|烦/.test(text)) tags.push("negative");
  if (/重要|必须|务必|提醒|风险|警告/.test(text)) tags.push("urgent");
  if (/想念|关心|陪伴|安慰|信任|晚安/.test(text)) tags.push("warm");
  return tags;
}

function inferNodeKind(text: string, source: string): MemoryNodeKind {
  const combined = `${text} ${source}`;
  if (/流程|步骤|SOP|操作|调用|复用|模板|procedure/i.test(combined)) return "procedure";
  if (/经验|规律|总结|原则|教训/.test(combined)) return "experience";
  if (/事件|发生|今天|昨天|刚刚|上次|记录/.test(combined)) return "event";
  if (/人|朋友|家人|公司|项目|地点|账号/.test(combined)) return "entity";
  return "knowledge";
}

function inferDomain(text: string, source: string, context: MemoryContextKind): string {
  if (context === "notes") return "notes";
  if (/流程|步骤|SOP|操作|调用|模板|复用|procedure/i.test(`${text} ${source}`)) return "procedural";
  if (/日程|提醒|待办|明天|下周|计划|calendar|schedule/i.test(`${text} ${source}`)) return "schedule";
  if (/喜欢|偏好|生日|身份|习惯|讨厌|画像|profile/i.test(`${text} ${source}`)) return "profile";
  if (/关系|家人|朋友|安慰|陪伴|信任|晚安/i.test(`${text} ${source}`)) return "relationship";
  if (/临时|本次|会话|稍后|temporary/i.test(`${text} ${source}`)) return "temporary";
  return "general";
}

function inferSceneTags(source: string, context: MemoryContextKind, domainId: string): string[] {
  return uniqueStrings([context, domainId, source.split(":")[0] ?? source], 8);
}

/** community 内容指纹：成员摘要集合未变化的 community 不值得再次提炼经验 */
function communityContentFingerprint(label: string, summaries: string[]): string {
  return createHash("sha1").update(`${label}|${[...summaries].sort().join("§")}`).digest("hex").slice(0, 16);
}

/** 固化行元数据前缀/时间戳等「非内容」关键词：不参与主题聚类质量闸 */
const GENERIC_META_KEYWORD_RE =
  /^(?:日志固化|日志|固化|用户|助手|fact|prefer|commit|journal|consolidate|review|\d{4}|\d{1,2}:\d{2}|\d+)$/u;

/**
 * 确定性社区 schema 提炼（零 LLM，M1-③）。
 *
 * 把一个社区里的多条碎片记忆归并为一条「主题知识」：正文取去重后的前三条
 * 摘要（保最新），并附上跨条目共有的关键词。这样图式/泛化由聚类结构本身
 * 产生，不依赖模型；同内容指纹已处理则跳过，避免重复提级。
 */
function deterministicCommunitySummary(label: string, lines: string[]): string {
  const cleaned = dedupeMemoryLines(lines, { preferLatest: true })
    .map((line) => line.replace(/^\[[^\]]+\]\s*/, "").trim())
    .filter(Boolean);
  if (cleaned.length < 2) return "";
  const common = uniqueStrings(
    cleaned.flatMap((line) => extractKeywords(line)),
    6,
  );
  const body = cleaned.slice(-3).join("；");
  return common.length > 0 ? `主题「${label}」：${body}（共性：${common.join("、")}）` : `主题「${label}」：${body}`;
}

export class HumanLikeMemoryService {
  private readonly filePath: string;
  private readonly policyFilePath: string;
  private store: HumanLikeMemoryStoreShape = structuredClone(DEFAULT_STORE);

  private policy: HumanLikeMemoryPolicyFile = structuredClone(DEFAULT_POLICY);
  private persistChain: Promise<void> = Promise.resolve();
  /** P1-9：SQLite 行级持久化（null = JSON 文件模式） */
  private graphPersist: GraphSqlitePersistence | null = null;
  private policyWatcher: FSWatcher | null = null;
  private reloadTimer: NodeJS.Timeout | null = null;
  /** 本轮计划中的 community 提炼（action.reason → 内容指纹），提升成功后标记已处理 */
  private pendingCommunityFps = new Map<string, string>();
  /** P0-C：已提升 community 指纹状态（actorId → fp → 首次提升日期），持久化到 data/ */
  private sleepCommunityState = new Map<string, Map<string, string>>();
  private sleepCommunityStateLoadPromise: Promise<void> | null = null;
  private readonly telemetry = {
    recallHits: 0,
    recallMisses: 0,
    recallEmbeddingFailures: 0,
    recallLatencyMs: [] as number[],
    writes: 0,
    writeLatencyMs: [] as number[],
    routeSingleDomain: 0,
    routeCrossDomain: 0,
  };

  constructor(filePath?: string, policyFilePath?: string) {
    this.filePath =
      filePath ?? process.env.AGENT_HUMAN_MEMORY_FILE?.trim() ?? join(getDataDir(), "human-memory.json");
    this.policyFilePath =
      policyFilePath ??
      process.env.AGENT_HUMAN_MEMORY_POLICY_FILE?.trim() ??
      join(getDataDir(), "human-memory-policy.json");
  }

  async load(): Promise<void> {
    await this.loadPolicy();
    await this.loadStore();
    this.startPolicyWatcher();
  }

  /**
   * 启动时统一向量空间（不降级、不改用关键词替身分）。
   *
   * 用当前 embedding 端点探测一次维度，把所有「缺向量」或「维度不一致」的
   * 有效节点按当前模型重算并落盘。完成后召回只使用同一空间的真向量；
   * 期间任何单个节点失败只记录错误并计入 failed，不伪造向量。
   */
  async backfillNodeVectors(): Promise<{ scanned: number; embedded: number; failed: number }> {
    const nodes = Object.values(this.store.nodes).filter(
      (node) =>
        node.deletionStage !== "soft_deleted" &&
        node.deletionStage !== "hard_deleted" &&
        node.summary.trim().length > 0,
    );
    if (nodes.length === 0) return { scanned: 0, embedded: 0, failed: 0 };

    let targetDim: number;
    try {
      const probe = await fetchOpenAiCompatibleEmbedding({ input: "向量维度探测", timeoutMs: 10_000 });
      targetDim = probe.dimension;
    } catch (err) {
      console.error("[HumanLikeMemory] 向量回填中止：embedding 端点不可用。", err);
      return { scanned: nodes.length, embedded: 0, failed: nodes.length };
    }

    const pending = nodes.filter((node) => {
      const vec = parseVectorFingerprint(node.vectorFingerprint);
      return !vec || vec.length !== targetDim;
    });
    if (pending.length === 0) return { scanned: nodes.length, embedded: 0, failed: 0 };

    let embedded = 0;
    let failed = 0;
    for (const node of pending) {
      try {
        const result = await fetchOpenAiCompatibleEmbedding({
          input: node.summary,
          timeoutMs: 10_000,
        });
        if (result.dimension !== targetDim) {
          throw new Error(`回填维度 ${result.dimension} 与目标 ${targetDim} 不一致`);
        }
        const current = this.store.nodes[node.id];
        if (!current || current.summary !== node.summary) continue;
        current.vectorFingerprint = serializeVector(result.vector);
        this.rebuildLinksForNode(current);
        embedded += 1;
      } catch (err) {
        failed += 1;
        console.error(`[HumanLikeMemory] 向量回填失败 node=${node.id}: ${err}`);
      }
    }
    if (embedded > 0) this.persistNow();
    return { scanned: nodes.length, embedded, failed };
  }

  getPolicySnapshot(): HumanLikeMemoryPolicyFile {
    return structuredClone(this.policy);
  }

  getTelemetrySnapshot(): Record<string, unknown> {
    const average = (values: number[]): number =>
      values.length > 0 ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2)) : 0;
    const recallTotal = this.telemetry.recallHits + this.telemetry.recallMisses;
    return {
      recallHitRate: recallTotal > 0 ? Number((this.telemetry.recallHits / recallTotal).toFixed(3)) : 0,
      recallAverageLatencyMs: average(this.telemetry.recallLatencyMs),
      writeCount: this.telemetry.writes,
      writeAverageLatencyMs: average(this.telemetry.writeLatencyMs),
      routeSingleDomain: this.telemetry.routeSingleDomain,
      routeCrossDomain: this.telemetry.routeCrossDomain,
      recallEmbeddingFailures: this.telemetry.recallEmbeddingFailures,
    };
  }

  async ingest(
    actorId: string,
    text: string,
    source: string,
    opts?: { context?: MemoryContextKind; domain?: string; metadata?: Record<string, unknown> },
  ): Promise<string | null> {
    const start = Date.now();
    const summary = text.trim().replace(/\s+/g, " ");
    if (!summary || summary.length < 6) return null;

    const context = opts?.context ?? "main";
    const domainId = opts?.domain ?? inferDomain(summary, source, context);
    const domainPolicy = this.policy.domains[domainId];
    if (domainPolicy?.enabled === false || domainPolicy?.retired === true) return null;

    const kind = inferNodeKind(summary, source);
    const fingerprint = semanticFingerprint(summary) || normalizeMemoryLine(summary);
    let existing = Object.values(this.store.nodes).find(
      (node) => node.actorId === actorId && node.domainId === domainId && node.semanticFingerprint === fingerprint,
    );
    // P1-2：指纹只抓「字面/词集完全相同」的重述。换说法的同一事实靠真向量近重复合并，
    // 避免同一事实在长期库里堆成多条（每条都要单独衰减/召回/占预算）。
    // 没有可比向量时（离线/首次运行）不做嵌入调用，保持写入路径零额外延迟。
    let incomingVector: number[] | null = null;
    if (!existing) {
      incomingVector = await this.computeMergeVectorIfComparable(actorId, domainId, kind, summary);
      if (incomingVector) {
        existing = this.findNearDuplicateNode(actorId, domainId, kind, summary, incomingVector);
      }
    }

    const importance = this.computeImportance(summary, source, opts?.metadata);
    const confidence = this.computeConfidence(summary, opts?.metadata);
    // 来源角色打标（root fix）：每条记忆落库时记录谁说的，下游覆盖/召回治理都依赖它
    const sourceRole = classifyMemorySourceRole(summary);
    // 情感标记（P0 统一出入口）：外部显式传入优先，否则用共享词表推断。
    // 只在高光/至暗等有明显情绪时落 metadata，避免给每条记忆都挂噪音标签。
    const explicitEmotion = emotionFromMetadata(opts?.metadata);
    const inferredEmotion = explicitEmotion ?? inferEmotionFromText(summary);
    const hasEmotion = Math.abs(inferredEmotion.valence) >= 1 || inferredEmotion.arousal >= 0.25;
    const emotionPatch = hasEmotion
      ? {
          emotion: {
            valence: inferredEmotion.valence,
            arousal: inferredEmotion.arousal,
            tags: inferredEmotion.tags,
            confidence: inferredEmotion.confidence,
            timestamp: inferredEmotion.timestamp ?? nowIso(),
          },
        }
      : {};
    const metadata: Record<string, unknown> = {
      ...(opts?.metadata ?? {}),
      sourceRole,
      ...emotionPatch,
    };

    if (existing) {
      const versionId = this.appendVersion(existing, summary, confidence, importance);
      existing.summary = summary;
      existing.currentVersionId = versionId;
      existing.lastAccessedAt = nowIso();
      existing.accessCount += 1;
      existing.frequencyScore = clamp(existing.frequencyScore + 0.12, 0, 5);
      existing.importance = Math.max(existing.importance, importance);
      existing.confidence = Math.max(existing.confidence, confidence);
      // 自动确认：反复 re-ingest（同一记忆被多次提及）说明是用户持续关注的有用信息
      // 与 buildRecall 的自动确认机制一致，阈值 AUTO_CONFIRM_THRESHOLD
      if (
        existing.correctness === "unknown" &&
        existing.accessCount >= AUTO_CONFIRM_THRESHOLD
      ) {
        existing.correctness = "confirmed";
      }
      existing.keywords = uniqueStrings([...existing.keywords, ...extractKeywords(summary)], 14);
      existing.entityTags = uniqueStrings([...existing.entityTags, ...extractEntityTags(summary)], 12);
      existing.sceneTags = uniqueStrings([...existing.sceneTags, ...inferSceneTags(source, context, domainId)], 8);
      existing.emotionTags = uniqueStrings([...existing.emotionTags, ...extractEmotionTags(summary)], 8);
      existing.emotionTags = uniqueStrings([...existing.emotionTags, ...inferredEmotion.tags], 8);
      // P1-2：换说法合并到旧节点时留痕（可观测重复率下降，不改变语义）
      existing.metadata = {
        ...(existing.metadata ?? {}),
        mergeCount: Number(existing.metadata?.mergeCount ?? 0) + 1,
      };
      if (!existing.metadata?.sourceRole || emotionPatch.emotion) {
        existing.metadata = {
          ...(existing.metadata ?? {}),
          ...(existing.metadata?.sourceRole ? {} : { sourceRole }),
          ...emotionPatch,
        };
      }
      // 双时态（P2-1）：重新被断言 = 该事实当前有效
      existing.validTo = null;
      if (incomingVector) existing.vectorFingerprint = serializeVector(incomingVector);
      this.rebuildLinksForNode(existing);
      this.schedulePersist();
      this.recordWriteLatency(start);
      this.applyUserAssertionSupersede(actorId, summary, sourceRole, existing.id);
      // 方案 C：re-ingest 时也异步更新 embedding（summary 可能已变）；已有新向量则免重复计算
      if (!incomingVector) void this.enhanceNodeWithEmbedding(existing.id, summary);
      return existing.id;
    }

    const nodeId = `mem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const versionId = this.createVersion(summary, null, confidence, importance);
    // 方案 C：ingest 时先存 normalizeMemoryLine 作为占位，再异步计算真 embedding 覆盖
    // 无 API key 时保持 normalizeMemoryLine（向后兼容旧节点）
    this.store.nodes[nodeId] = {
      id: nodeId,
      actorId,
      domainId,
      parentDomainId: domainPolicy?.parentDomainId ?? null,
      kind,
      source,
      sourceType: this.inferSourceType(source),
      context,
      summary,
      keywords: extractKeywords(summary),
      sceneTags: inferSceneTags(source, context, domainId),
      emotionTags: uniqueStrings([...extractEmotionTags(summary), ...inferredEmotion.tags], 8),
      entityTags: extractEntityTags(summary),
      semanticFingerprint: fingerprint,
      vectorFingerprint: incomingVector ? serializeVector(incomingVector) : "",
      timestamp: nowIso(),
      // 双时态（P2-1）：初次落库即事实生效起点；validTo 为空表示当前仍有效
      validFrom: nowIso(),
      validTo: null,
      lastAccessedAt: nowIso(),
      accessCount: 0,
      importance,
      confidence,
      frequencyScore: 0,
      recencyScore: 1,
      domainScore: domainPolicy?.recallWeight ?? 1,
      userFeedbackScore: 1,
      correctness: "unknown",
      deletionStage: "active",
      isArchived: false,
      currentVersionId: versionId,
      versionIds: [versionId],
      metadata,
    };
    this.rebuildLinksForNode(this.store.nodes[nodeId]!);
    this.rebuildCommunities(actorId, domainId);
    this.schedulePersist();
    this.recordWriteLatency(start);
    this.applyUserAssertionSupersede(actorId, summary, sourceRole, nodeId);

    // 方案 C：异步计算真 embedding 覆盖 vectorFingerprint，并重建该节点边
    // 不阻塞主流程，计算完成后增强图谱语义关联质量；近重复判定已算过则直接复用
    if (!incomingVector) void this.enhanceNodeWithEmbedding(nodeId, summary);
    return nodeId;
  }

  /**
   * 近重复合并的向量通道（P1-2）：同 actor+域+kind 下没有任何可比向量时直接返回
   * null，不发起嵌入请求（离线/首次启动零额外开销）。有向量时才嵌入待写文本，
   * 结果同时复用于落库，避免「合并判定一次 + 写入又一次」的重复计算。
   */
  private async computeMergeVectorIfComparable(
    actorId: string,
    domainId: string,
    kind: MemoryNodeKind,
    summary: string,
  ): Promise<number[] | null> {
    const comparable = Object.values(this.store.nodes).some(
      (node) =>
        node.actorId === actorId &&
        node.domainId === domainId &&
        node.kind === kind &&
        node.deletionStage !== "soft_deleted" &&
        node.deletionStage !== "hard_deleted" &&
        parseVectorFingerprint(node.vectorFingerprint) !== null,
    );
    if (!comparable) return null;
    try {
      return await computeEmbedding(summary);
    } catch (err) {
      // 向量端点不可用：本轮只走指纹去重（两条是并列通道，不是伪装成向量的降级）
      console.warn(`[HumanLikeMemory] 近重复判定向量化失败，本轮仅按指纹去重: ${err}`);
      return null;
    }
  }

  /**
   * 找「同一事实换说法」的既有节点：cosine + 词面重叠双闸门，且冲突事实
   * （同 overwrite key 不同值）不合并——那属于 supersede 的职责，不能在这里
   * 被静默覆盖。
   */
  private findNearDuplicateNode(
    actorId: string,
    domainId: string,
    kind: MemoryNodeKind,
    summary: string,
    vector: number[],
  ): MemoryNodeRecord | undefined {
    const incomingTokens = contentTokenSet(summary);
    let best: { node: MemoryNodeRecord; score: number } | null = null;
    for (const node of Object.values(this.store.nodes)) {
      if (node.actorId !== actorId || node.domainId !== domainId || node.kind !== kind) continue;
      if (node.deletionStage === "soft_deleted" || node.deletionStage === "hard_deleted") continue;
      if (areLinesConflicting(node.summary, summary)) continue;
      const nodeVec = parseVectorFingerprint(node.vectorFingerprint);
      if (!nodeVec || nodeVec.length !== vector.length) continue;
      const cosine = cosineSimilarity(vector, nodeVec);
      if (cosine < NEAR_DUPLICATE_COSINE) continue;
      if (tokenOverlapRatio(incomingTokens, contentTokenSet(node.summary)) < NEAR_DUPLICATE_TOKEN_OVERLAP) {
        continue;
      }
      if (!best || cosine > best.score) best = { node, score: cosine };
    }
    return best?.node;
  }

  /**
   * 用户断言驱动的同主题覆盖（root fix）：
   * 只有标记为用户的话（sourceRole=user）可以改写"用户事实"。当用户对亲密关系主题
   * 给出明确断言（如「刘浩存才是真主 未来的老婆」）时：
   *   1. 作废同主题但值不同的旧节点（旧值不再与最新值并列注入）；
   *   2. 作废助手对同一主题的"摇摆/求证"发言（「到底哪位是正主」类回声源头）。
   * 被作废节点标记 soft_deleted（召回天然过滤）+ metadata.superseded（可审计可追溯）。
   */
  private applyUserAssertionSupersede(
    actorId: string,
    summary: string,
    role: MemorySourceRole,
    incomingId: string,
  ): void {
    if (role !== "user") return;
    const assertion = extractRelationshipAssertion(summary);
    if (!assertion) return;
    const superseded = this.supersedeByAssertion(actorId, assertion, incomingId);
    if (superseded > 0) {
      console.log(
        `[HumanLikeMemory] 用户断言覆盖：subject=${assertion.subject} value=${assertion.value} ` +
          `作废 ${superseded} 条旧记忆 (actorId=${actorId})`,
      );
    }
  }

  /** 按断言作废冲突/回声节点，返回作废数量。incomingId 传入时跳过该节点自身。 */
  private supersedeByAssertion(
    actorId: string,
    assertion: RelationshipAssertion,
    incomingId: string | null,
  ): number {
    let count = 0;
    for (const node of Object.values(this.store.nodes)) {
      if (node.actorId !== actorId || node.id === incomingId) continue;
      if (node.deletionStage === "soft_deleted" || node.deletionStage === "hard_deleted") continue;
      if (!this.shouldSupersedeForAssertion(node, assertion)) continue;
      node.deletionStage = "soft_deleted";
      // 双时态（P2-1）：旧值在失效时刻关闭有效区间，新值由 ingest 侧写入 validFrom
      node.validTo = nowIso();
      node.metadata = {
        ...(node.metadata ?? {}),
        superseded: {
          at: nowIso(),
          by: incomingId,
          subject: assertion.subject,
          value: assertion.value,
        },
      };
      count += 1;
    }
    if (count > 0) this.schedulePersist();
    return count;
  }

  private shouldSupersedeForAssertion(node: MemoryNodeRecord, assertion: RelationshipAssertion): boolean {
    // 助手对同一主题的"摇摆/求证"发言（到底哪位是正主…）：用户给出明确断言后即作废
    if (resolveNodeRole(node) === "assistant" && isRelationshipHedgeLine(node.summary)) return true;
    // 同主题、不同值的旧断言：latest-wins
    const old = extractRelationshipAssertion(node.summary);
    return !!old && old.subject === assertion.subject && !!old.value && old.value !== assertion.value;
  }

  /**
   * 数据修复入口（离线脚本用）：以给定断言为最新事实，清理该 actor 的
   * 冲突断言节点与助手回声节点。与运行时 ingest 走同一套 supersede 规则。
   */
  repairSupersedeForActor(actorId: string, assertion: RelationshipAssertion): number {
    return this.supersedeByAssertion(actorId, assertion, null);
  }

  /**
   * 方案 C：异步计算节点 summary 的真 embedding，覆盖 vectorFingerprint 并重建边。
   * 设计意图：ingest 主流程不阻塞，embedding 计算完成后增强图谱语义关联质量。
   * 失败显式记录，节点保持无向量（语义分为 0），由夜间/启动回填补齐。
   */
  private async enhanceNodeWithEmbedding(nodeId: string, summary: string): Promise<void> {
    let vec: number[];
    try {
      vec = await computeEmbedding(summary);
    } catch (err) {
      console.error(`[HumanLikeMemory] 节点向量化失败 node=${nodeId}: ${err}`);
      return;
    }
    const node = this.store.nodes[nodeId];
    if (!node || node.summary !== summary) return; // 节点已变更，避免覆盖错误
    node.vectorFingerprint = serializeVector(vec);
    // 重建该节点的边（现在用真向量 cosine 算 similarity，边权重更准）
    this.rebuildLinksForNode(node);
    this.schedulePersist();
  }

  /**
   * 用户反馈回灌：按语义指纹匹配记忆节点，更新 userFeedbackScore（0-1）。
   * 由 MemoryCortex.recordMemoryFeedback 在记录用户反馈时调用。
   * 此前 userFeedbackScore 在 ingest 时固定为 1 且无任何更新路径，
   * 导致 retrieval 打分中的反馈分量（structureScore/penalty）从未生效。
   */
  applyUserFeedback(actorId: string, summary: string, score: number): void {
    const plain = summary.trim();
    if (!plain) return;
    const fingerprint = semanticFingerprint(plain) || normalizeMemoryLine(plain);
    const clamped = Number.isFinite(score) ? Math.max(0, Math.min(1, score)) : 0;

    for (const node of Object.values(this.store.nodes)) {
      if (node.actorId !== actorId) continue;
      if (node.semanticFingerprint !== fingerprint) continue;
      node.userFeedbackScore = clamped;
      node.lastAccessedAt = nowIso();
      this.schedulePersist();
      break;
    }
  }

  async buildRecall(
    actorId: string,
    query: string,
    opts?: HumanLikeMemoryRecallOptions,
  ): Promise<HumanLikeMemoryRecallResult> {
    const start = Date.now();
    const cleanedQuery = query.trim();
    const domainId = opts?.explicitDomain ?? inferDomain(cleanedQuery, opts?.source ?? "chat", opts?.context ?? "main");
    const detailLevel = opts?.detailLevel ?? "summary";
    const limit = Math.max(1, opts?.limit ?? this.policy.retrieval.maxRecallItems);
    const mode = this.resolveRecallMode(cleanedQuery, domainId, opts?.crossDomain === true);
    if (mode === "single_domain") this.telemetry.routeSingleDomain += 1;
    else this.telemetry.routeCrossDomain += 1;

    // 方案 C：buildRecall 时算 query 的真 embedding，传给 hybridRetrieve 做真向量检索。
    // 失败不降级成伪向量：记错误并继续走词法通道（关键字分本身就是独立检索通道），
    // 问题会以 recallEmbeddingFailures 指标暴露，而不是被静默掩盖。
    let queryVec: number[] | null = null;
    try {
      queryVec = await computeEmbedding(cleanedQuery);
    } catch (err) {
      this.telemetry.recallEmbeddingFailures += 1;
      console.error(`[HumanLikeMemory] query 向量化失败，本轮语义通道为空: ${err}`);
    }

    const candidates = this.hybridRetrieve(actorId, cleanedQuery, domainId, mode, opts?.context, limit, queryVec);
    const selected = this.applyBudgetedSelection(
      this.applyDiversityControl(candidates, limit, mode === "cross_domain"),
    );
    if (selected.length === 0) {
      this.telemetry.recallMisses += 1;
      this.recordRecallLatency(start);
      return { domainId, mode, recalledNodeIds: [], confidence: 0, text: "" };
    }

    for (const item of selected) {
      item.node.lastAccessedAt = nowIso();
      item.node.accessCount += 1;
      item.node.frequencyScore = clamp(item.node.frequencyScore + 0.06, 0, 5);
      item.node.recencyScore = 1;
      // 自动确认机制：反复命中（accessCount >= AUTO_CONFIRM_THRESHOLD）的"unknown"节点
      // 自动升级为 "confirmed" —— agent 对有用的记忆是牢固的，不会像人类一样想不起
      // 阈值设为 3：3 次召回说明这条记忆确实在被反复使用，应锁定不衰减
      if (
        item.node.correctness === "unknown" &&
        item.node.accessCount >= AUTO_CONFIRM_THRESHOLD
      ) {
        item.node.correctness = "confirmed";
      }
    }
    this.schedulePersist();

    const confidence = Number(
      (
        selected.reduce((sum, item) => sum + item.finalScore, 0) /
        Math.max(selected.length, 1)
      ).toFixed(3),
    );
    this.telemetry.recallHits += 1;
    this.recordRecallLatency(start);

    return {
      domainId,
      mode,
      recalledNodeIds: selected.map((item) => item.node.id),
      confidence,
      text: this.reconstructRecall(cleanedQuery, domainId, selected.map((item) => item.node), mode, detailLevel, confidence),
    };
  }

  async runSleepCycleForActors(actorIds: string[]): Promise<HumanLikeMemorySleepReport[]> {
    const reports: HumanLikeMemorySleepReport[] = [];
    for (const actorId of actorIds) {
      reports.push(await this.runSleepCycle(actorId));
    }
    return reports;
  }

  markConflict(actorId: string, memoryIdA: string, memoryIdB: string): void {
    const a = this.store.nodes[memoryIdA];
    const b = this.store.nodes[memoryIdB];
    if (!a || !b || a.actorId !== actorId || b.actorId !== actorId) return;
    const groupId = `conflict_${Date.now().toString(36)}`;
    a.conflictGroupId = groupId;
    b.conflictGroupId = groupId;
    a.correctness = "suspected_error";
    b.correctness = "suspected_error";
    this.schedulePersist();
  }

  forgetMemory(actorId: string, memoryId: string): void {
    const node = this.store.nodes[memoryId];
    if (!node || node.actorId !== actorId) return;
    node.deletionStage = "soft_deleted";
    this.schedulePersist();
  }

  archiveDomain(actorId: string, domainId: string): void {
    for (const node of Object.values(this.store.nodes)) {
      if (node.actorId === actorId && node.domainId === domainId && node.deletionStage === "active") {
        node.deletionStage = "cold";
        node.isArchived = true;
      }
    }
    this.schedulePersist();
  }

  /**
   * 获取指定 actor 的所有节点（供 ForgettingController.continuousScore 调用）。
   * 返回节点数组的浅拷贝，避免外部修改内部状态。
   * 排除 hard_deleted 节点（已彻底删除）。
   */
  getAllNodes(actorId: string): MemoryNodeRecord[] {
    return Object.values(this.store.nodes)
      .filter((node) => node.actorId === actorId && node.deletionStage !== "hard_deleted")
      .map((node) => ({ ...node }));
  }

  /**
   * 按记忆内容反查图节点 ID（联想种子语义化用）。
   *
   * MemoryRecallItem 不携带 nodeId，而联想扩散 spread 需要真实节点 ID 才能在
   * 图上命中。此方法对每条召回内容在节点 content 里做包含匹配（双向：
   * 节点内容包含查询片段，或查询片段包含节点内容前缀），返回命中的节点 ID。
   *
   * 纯内存扫描（节点量级 < 10^4），不触发持久化；无命中返回空数组。
   */
  findNodeIdsByContent(actorId: string, contents: string[], maxPerContent = 1): string[] {
    if (!contents || contents.length === 0) return [];
    const nodes = Object.values(this.store.nodes).filter(
      (node) =>
        node.actorId === actorId &&
        node.deletionStage !== "hard_deleted" &&
        typeof node.summary === "string" &&
        node.summary.length > 0,
    );
    const result: string[] = [];
    for (const raw of contents) {
      const query = (raw ?? "").trim();
      if (!query) continue;
      // 召回文本可能是"标题: 内容"或被截断的形式，取最长可匹配片段
      const fragments = [query, ...query.split(/[:：\n]/).map((s) => s.trim()).filter((s) => s.length >= 8)]
        .sort((a, b) => b.length - a.length);
      let matched = 0;
      for (const node of nodes) {
        if (matched >= maxPerContent) break;
        const summary = node.summary;
        const hit = fragments.some(
          (frag) => frag.length >= 8 && (summary.includes(frag.slice(0, 32)) || frag.includes(summary.slice(0, 32))),
        );
        if (hit && !result.includes(node.id)) {
          result.push(node.id);
          matched++;
        }
      }
    }
    return result.slice(0, 6);
  }

  /**
   * 按节点 ID 批量取节点摘要（联想扩散结果 → 当轮召回候选用）。
   *
   * 联想扩散 spread 返回的是激活节点 ID 列表，不含内容；召回侧需要把
   * 2 度节点的内容并入候选池。仅返回 actorId 匹配且未硬删除的节点，
   * 保持传入顺序。纯内存读取，不触发持久化。
   */
  getNodeSummariesByIds(
    actorId: string,
    nodeIds: string[],
    max = 4,
  ): Array<{ id: string; summary: string }> {
    if (!nodeIds || nodeIds.length === 0) return [];
    const result: Array<{ id: string; summary: string }> = [];
    for (const nodeId of nodeIds) {
      if (result.length >= max) break;
      const node = this.store.nodes[nodeId];
      if (!node || node.actorId !== actorId || node.deletionStage === "hard_deleted") continue;
      if (typeof node.summary !== "string" || node.summary.length === 0) continue;
      result.push({ id: node.id, summary: node.summary });
    }
    return result;
  }

  /**
   * 更新节点 deletionStage（供 ForgettingController.continuousScore 调用）。
   * 写入后立即持久化到 store。
   */
  updateDeletionStage(actorId: string, nodeId: string, stage: MemoryDeletionStage): void {
    const node = this.store.nodes[nodeId];
    if (!node || node.actorId !== actorId) {
      console.log(
        `[HumanLikeMemory] updateDeletionStage 跳过：节点不存在或 actorId 不匹配 (actorId=${actorId}, nodeId=${nodeId})`,
      );
      return;
    }
    node.deletionStage = stage;
    this.schedulePersist();
  }

  /**
   * 合并写入节点 metadata（方案 A memory-bridge / 方案 D provenance 使用）：
   * 记录 Mem0 linkage（mem0Ids）与作废标记（overridden）等跨层关联信息。
   * 浅合并：同名 key 以 patch 为准；数组 key（如 mem0Ids）由调用方自行去重后传入。
   */
  attachNodeMetadata(actorId: string, nodeId: string, patch: Record<string, unknown>): boolean {
    const node = this.store.nodes[nodeId];
    if (!node || node.actorId !== actorId) return false;
    node.metadata = { ...(node.metadata ?? {}), ...patch };
    node.lastAccessedAt = nowIso();
    this.schedulePersist();
    return true;
  }

  /**
   * 查询给定节点中处于可再唤醒状态（downranked / cold）的节点 ID。
   * 供 MemoryCortex 召回后触发 ForgettingController.reawakenAndStrengthen：
   * 只有被召回命中的褪色记忆才值得反弹，其余节点维持遗忘曲线。
   */
  findReawakenableNodeIds(actorId: string, nodeIds: string[]): string[] {
    return nodeIds.filter((nodeId) => {
      const node = this.store.nodes[nodeId];
      if (!node || node.actorId !== actorId) return false;
      return node.deletionStage === "downranked" || node.deletionStage === "cold";
    });
  }

  /**
   * 节点再唤醒（供 ForgettingController.reawakenAndStrengthen 调用）。
   * - frequencyScore += 0.3（远超普通 recall 的 +0.06，体现"再唤醒反弹"）
   * - deletionStage 回退一级：cold → downranked → active
   * - lastAccessedAt 更新为当前时间
   * - 写入后立即持久化
   */
  reawakenNode(actorId: string, nodeId: string): void {
    const node = this.store.nodes[nodeId];
    if (!node || node.actorId !== actorId) {
      console.log(
        `[HumanLikeMemory] reawakenNode 跳过：节点不存在或 actorId 不匹配 (actorId=${actorId}, nodeId=${nodeId})`,
      );
      return;
    }
    node.frequencyScore = clamp(node.frequencyScore + 0.3, 0, 5);
    node.deletionStage = STAGE_REGRESS[node.deletionStage];
    node.lastAccessedAt = nowIso();
    this.schedulePersist();
  }

  /**
   * 清除节点所有 edge（供 ForgettingController.pruneConnections 调用）。
   * 保留节点本体供历史追溯，仅清除连接。
   * 写入后立即持久化。
   */
  pruneNodeEdges(actorId: string, nodeId: string): void {
    const node = this.store.nodes[nodeId];
    if (!node || node.actorId !== actorId) {
      console.log(
        `[HumanLikeMemory] pruneNodeEdges 跳过：节点不存在或 actorId 不匹配 (actorId=${actorId}, nodeId=${nodeId})`,
      );
      return;
    }
    const edgeIds = Object.keys(this.store.edges).filter((edgeId) => {
      const edge = this.store.edges[edgeId]!;
      return edge.from === nodeId || edge.to === nodeId;
    });
    for (const edgeId of edgeIds) {
      delete this.store.edges[edgeId];
    }
    console.log(`[HumanLikeMemory] pruneNodeEdges 完成：删除 ${edgeIds.length} 条边 (nodeId=${nodeId})`);
    this.schedulePersist();
  }

  /**
   * 清空指定 actor 的全部记忆（节点 + 边 + 社区 + 版本），并落盘。
   * 供“删除全部聊天记录 / 清空记忆”类功能使用。返回被移除的节点数量。
   */
  clearActorMemory(actorId: string): number {
    const nodeIds = Object.values(this.store.nodes)
      .filter((node) => node.actorId === actorId)
      .map((node) => node.id);

    for (const nodeId of nodeIds) {
      const versionIds = this.store.nodes[nodeId]?.versionIds ?? [];
      for (const versionId of versionIds) {
        delete this.store.versions[versionId];
      }
      delete this.store.nodes[nodeId];
    }

    const edgeIds = Object.values(this.store.edges)
      .filter((edge) => edge.actorId === actorId)
      .map((edge) => edge.id);
    for (const edgeId of edgeIds) {
      delete this.store.edges[edgeId];
    }

    const communityIds = Object.values(this.store.communities)
      .filter((community) => community.actorId === actorId)
      .map((community) => community.id);
    for (const communityId of communityIds) {
      delete this.store.communities[communityId];
    }

    if (nodeIds.length > 0 || edgeIds.length > 0 || communityIds.length > 0) {
      this.schedulePersist();
    }

    console.log(
      `[HumanLikeMemory] clearActorMemory 完成：删除 ${nodeIds.length} 节点 / ${edgeIds.length} 条边 / ${communityIds.length} 个社区 (actorId=${actorId})`,
    );
    return nodeIds.length;
  }

  /**
   * 获取指定 actor 的所有边（供 MemoryAssociativeGraph.spread 扩散激活调用）。
   * 返回边数组的浅拷贝，避免外部修改内部状态。
   */
  getAllEdges(actorId: string): MemoryEdgeRecord[] {
    return Object.values(this.store.edges)
      .filter((edge) => edge.actorId === actorId)
      .map((edge) => ({ ...edge }));
  }

  /**
   * 按情绪检索节点（P1 触景生情：query 情绪 → 历史同情绪记忆）。
   * 只返回与 query 情绪极性/类别匹配且情绪显著的节点，按情绪匹配度降序。
   * 不调 LLM，扫描上限 300 条（与召回候选窗口一致）。
   */
  findEmotionalNodes(
    actorId: string,
    queryEmotion: EmotionSignal | null | undefined,
    limit = 2,
  ): Array<{ id: string; summary: string; emotion: EmotionSignal; matchScore: number }> {
    if (!queryEmotion || Math.abs(queryEmotion.valence) < 3) return [];
    const candidates = Object.values(this.store.nodes)
      .filter(
        (node) =>
          node.actorId === actorId &&
          node.deletionStage !== "hard_deleted" &&
          node.deletionStage !== "soft_deleted" &&
          !node.metadata?.superseded,
      )
      .slice(-300);

    const matched = candidates
      .map((node) => {
        const emotion = resolveNodeEmotion(node);
        const matchScore = emotionMatchScore(queryEmotion, emotion);
        return { id: node.id, summary: node.summary, emotion, matchScore };
      })
      .filter((item) => item.matchScore >= 0.55 && Math.abs(item.emotion.valence) >= 3)
      .sort((a, b) => b.matchScore - a.matchScore)
      .slice(0, Math.max(1, limit));
    return matched;
  }

  /**
   * 获取指定 actor 指定 sceneTag 的所有节点（供 MemorySchemaFormation.extractSchema 调用）。
   * 排除 hard_deleted 节点。返回节点数组的浅拷贝。
   */
  getNodesBySceneTag(actorId: string, sceneTag: string): MemoryNodeRecord[] {
    return Object.values(this.store.nodes)
      .filter(
        (node) =>
          node.actorId === actorId &&
          node.deletionStage !== "hard_deleted" &&
          node.sceneTags.includes(sceneTag),
      )
      .map((node) => ({ ...node }));
  }

  /**
   * 回写推理结论为新节点（供 MemoryInferenceEngine 高置信回写调用）。
   *
   * 设计要点：
   *   - kind="knowledge"（inferred 不是有效 MemoryNodeKind，用 knowledge 兜底 + metadata.inferred=true 标记）
   *   - confidence 直接用推理结论的 confidence（> 0.6 才会回写）
   *   - keywords 包含 "推理" + 从 conclusion 自动抽取，让召回时能按 "推理" 关键词找到
   *   - 创建从触发节点到推理节点的边（若可识别）
   *   - 调度持久化（异步）
   */
  ingestInferredNode(actorId: string, node: InferenceNode): void {
    const summary = node.conclusion.trim().replace(/\s+/g, " ");
    if (!summary) return;
    const domainId = "general";
    const domainPolicy = this.policy.domains[domainId];
    if (domainPolicy?.enabled === false || domainPolicy?.retired === true) return;

    const fingerprint = semanticFingerprint(summary) || normalizeMemoryLine(summary);
    // 已存在相同 fingerprint 的节点 → 跳过（避免重复回写）
    const existing = Object.values(this.store.nodes).find(
      (n) => n.actorId === actorId && n.semanticFingerprint === fingerprint,
    );
    if (existing) {
      // 已存在 → 只更新 confidence（取较大值）+ accessCount + 1
      existing.confidence = Math.max(existing.confidence, node.confidence);
      existing.accessCount += 1;
      existing.lastAccessedAt = nowIso();
      this.schedulePersist();
      return;
    }

    const nodeId = `inf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const versionId = this.createVersion(summary, null, node.confidence, 0.6);
    const keywords = uniqueStrings(["推理", ...extractKeywords(summary)], 14);
    this.store.nodes[nodeId] = {
      id: nodeId,
      actorId,
      domainId,
      parentDomainId: domainPolicy?.parentDomainId ?? null,
      kind: "knowledge",
      source: `inference:${node.evidence.rules.join(",")}`,
      sourceType: "system",
      context: "main",
      summary,
      keywords,
      sceneTags: inferSceneTags(`inference:${node.id}`, "main", domainId),
      emotionTags: [],
      entityTags: extractEntityTags(summary),
      semanticFingerprint: fingerprint,
      vectorFingerprint: "",
      timestamp: nowIso(),
      lastAccessedAt: nowIso(),
      accessCount: 0,
      importance: 0.6,
      confidence: node.confidence,
      frequencyScore: 0,
      recencyScore: 1,
      domainScore: domainPolicy?.recallWeight ?? 1,
      userFeedbackScore: 1,
      correctness: "unknown",
      deletionStage: "active",
      isArchived: false,
      currentVersionId: versionId,
      versionIds: [versionId],
      metadata: {
        inferred: true,
        inferenceId: node.id,
        reasoningChain: node.evidence.reasoningChain,
        clueCount: node.evidence.clues.length,
      },
    };
    this.rebuildLinksForNode(this.store.nodes[nodeId]!);
    this.rebuildCommunities(actorId, domainId);
    this.schedulePersist();

    // 异步计算真 embedding 覆盖 vectorFingerprint
    void this.enhanceNodeWithEmbedding(nodeId, summary);
  }

  private async loadStore(): Promise<void> {
    // P1-9：SQLite 行级持久化（hash-diff，AGENT_HUMAN_MEMORY_STORE=json 回退旧文件）
    if (resolveHumanMemoryStoreMode() === "sqlite") {
      try {
        this.graphPersist = new GraphSqlitePersistence(this.filePath);
        const { data, hashes } = await this.graphPersist.load();
        this.store = {
          version: typeof data?.version === "number" ? data.version : DEFAULT_STORE.version,
          domains: { ...this.policy.domains, ...((data?.domains ?? {}) as HumanLikeMemoryStoreShape["domains"]) },
          nodes: (data?.nodes ?? {}) as HumanLikeMemoryStoreShape["nodes"],
          edges: (data?.edges ?? {}) as HumanLikeMemoryStoreShape["edges"],
          versions: (data?.versions ?? {}) as HumanLikeMemoryStoreShape["versions"],
          communities: (data?.communities ?? {}) as HumanLikeMemoryStoreShape["communities"],
        };
        this.graphPersist.setHashes(hashes);
        return;
      } catch (err) {
        console.warn("[HumanLikeMemory] SQLite 持久层初始化失败，回退 JSON:", err);
        this.graphPersist = null;
      }
    }
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<HumanLikeMemoryStoreShape>;
      this.store = {
        version: typeof parsed.version === "number" ? parsed.version : DEFAULT_STORE.version,
        domains: { ...this.policy.domains, ...(parsed.domains ?? {}) },
        nodes: parsed.nodes ?? {},
        edges: parsed.edges ?? {},
        versions: parsed.versions ?? {},
        communities: parsed.communities ?? {},
      };
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error
          ? String((error as NodeJS.ErrnoException).code)
          : "";
      if (code !== "ENOENT") throw error;
      this.store = structuredClone(DEFAULT_STORE);
    }
  }

  private async loadPolicy(): Promise<void> {
    try {
      const raw = await readFile(this.policyFilePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<HumanLikeMemoryPolicyFile>;
      this.policy = {
        version: typeof parsed.version === "number" ? parsed.version : DEFAULT_POLICY.version,
        domains: { ...DEFAULT_POLICY.domains, ...(parsed.domains ?? {}) },
        retrieval: { ...DEFAULT_POLICY.retrieval, ...(parsed.retrieval ?? {}) },
        sleepAgent: { ...DEFAULT_POLICY.sleepAgent, ...(parsed.sleepAgent ?? {}) },
      };
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error
          ? String((error as NodeJS.ErrnoException).code)
          : "";
      if (code !== "ENOENT") throw error;
      this.policy = structuredClone(DEFAULT_POLICY);
      await this.persistPolicy();
    }
    this.store.domains = { ...this.policy.domains, ...this.store.domains };
  }

  private startPolicyWatcher(): void {
    if (this.policyWatcher) return;
    try {
      this.policyWatcher = watch(this.policyFilePath, () => {
        if (this.reloadTimer) clearTimeout(this.reloadTimer);
        this.reloadTimer = setTimeout(() => {
          void this.loadPolicy().catch((err) => {
            console.error("[HumanLikeMemory] Failed to reload policy:", err);
          });
        }, 200);
      });
    } catch {
      this.policyWatcher = null;
    }
  }

  /**
   * 关闭服务：释放文件监听 + 定时器，并等待挂起的持久化完成。
   *
   * 测试 helper（withMemoryService）在 finally 块中调用此方法做清理；
   * 未调用时 policyWatcher 会泄漏 FSWatcher，导致测试进程不退出。
   */
  async shutdown(): Promise<void> {
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = null;
    }
    // 冲刷未到期的合并写再关库，避免最后一批记忆停留在内存
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
      this.persistNow();
    }
    if (this.policyWatcher) {
      try {
        this.policyWatcher.close();
      } catch {
        // ignore
      }
      this.policyWatcher = null;
    }
    // 等待挂起的持久化链完成，避免测试目录被 rm 时丢数据
    await this.persistChain;
    this.graphPersist?.close();
    this.graphPersist = null;
  }

  private async persistPolicy(): Promise<void> {
    await writeJsonAtomic(this.policyFilePath, this.policy);
  }

  /**
   * 持久化合并窗口（ms）：一次记忆写入会触发多次 schedulePersist，而每次落盘都要
   * 对整图做 JSON.stringify + crypto hash（实测单次约 200ms 主线程）。500ms 窗口内
   * 的连续写只落一次；shutdown 时强制冲刷，不丢数据。
   */
  private persistTimer: NodeJS.Timeout | null = null;

  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persistNow();
    }, 500);
    this.persistTimer.unref?.();
  }

  /** 立即落盘（合并窗口到期或关闭时调用）。 */
  private persistNow(): void {
    if (this.graphPersist) {
      // SQLite 行级持久化：hash-diff 只写脏行（P1-9）
      const snapshot = {
        version: this.store.version,
        domains: this.store.domains,
        nodes: this.store.nodes,
        edges: this.store.edges,
        versions: this.store.versions,
        communities: this.store.communities,
      };
      this.persistChain = this.persistChain.then(async () => {
        this.graphPersist!.save(snapshot);
      });
      return;
    }
    this.persistChain = this.persistChain.then(async () => {
      await writeJsonAtomic(this.filePath, this.store);
    });
  }

  private appendVersion(node: MemoryNodeRecord, summary: string, confidence: number, importance: number): string {
    const versionId = this.createVersion(summary, node.currentVersionId, confidence, importance);
    node.versionIds.push(versionId);
    node.versionIds = node.versionIds.slice(-20);
    return versionId;
  }

  private createVersion(
    summary: string,
    previousVersionId: string | null,
    confidence: number,
    importance: number,
  ): string {
    const versionId = `ver_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    this.store.versions[versionId] = {
      versionId,
      previousVersionId,
      summary,
      createdAt: nowIso(),
      confidence,
      importance,
      correctness: "unknown",
    };
    return versionId;
  }

  private inferSourceType(source: string): MemoryNodeRecord["sourceType"] {
    if (source.startsWith("tool:")) return "tool";
    if (source.includes("digest")) return "digest";
    if (source.startsWith("world:")) return "world";
    if (source.startsWith("system:")) return "system";
    return "chat";
  }

  private computeImportance(text: string, source: string, metadata?: Record<string, unknown>): number {
    let score = 0.4;
    if (/重要|必须|务必|提醒|风险|警告|记住|偏好|生日|禁忌|流程|SOP/i.test(`${text} ${source}`)) score += 0.35;
    if (metadata?.highSignal === true) score += 0.2;
    return clamp(score, 0.1, 1);
  }

  private computeConfidence(text: string, metadata?: Record<string, unknown>): number {
    let score = 0.55;
    if (metadata?.highSignal === true) score += 0.15;
    if (/大概|可能|也许|不确定/.test(text)) score -= 0.18;
    if (/已经|确定|必须|务必/.test(text)) score += 0.1;
    return clamp(score, 0.1, 1);
  }

  private rebuildLinksForNode(node: MemoryNodeRecord): void {
    const candidates = Object.values(this.store.nodes)
      .filter((item) => item.id !== node.id && item.actorId === node.actorId && item.deletionStage !== "hard_deleted")
      .slice(-200);

    for (const candidate of candidates) {
      const relationScore = computeSimilarity(node, candidate);
      const sameDomainThreshold = 0.24;
      const crossDomainThreshold = 0.36;
      const finalWeight =
        node.domainId === candidate.domainId
          ? relationScore.score
          : clamp(relationScore.score * ((this.policy.domains[node.domainId]?.recallWeight ?? 1) + (this.policy.domains[candidate.domainId]?.recallWeight ?? 1)) / 2, 0, 1);
      const threshold = node.domainId === candidate.domainId ? sameDomainThreshold : crossDomainThreshold;

      // 情绪边（P1 联想检索）：同情绪极性且至少一侧是高光/至暗时，额外建一条
      // relation="emotion" 的边（独立 id，不与 semantic 边互相覆盖）。
      // 让扩散激活可以沿"情绪"而不是语义走向——"下雨"→"上次雨天心情差"。
      // 该边不要求语义相似度过阈值：情绪关联本身就是弱语义关联。
      const nodeEmotion = resolveNodeEmotion(node);
      const candidateEmotion = resolveNodeEmotion(candidate);
      const emotionOverlap = overlapScore(node.emotionTags, candidate.emotionTags);
      const samePolarity = (nodeEmotion.valence >= 0) === (candidateEmotion.valence >= 0);
      const strongEmotion =
        Math.abs(nodeEmotion.valence) >= 4 || Math.abs(candidateEmotion.valence) >= 4;
      if (emotionOverlap > 0 && strongEmotion) {
        const emotionEdgeId = [
          node.actorId,
          "emotion",
          ...[node.id, candidate.id].sort(),
        ].join(":");
        this.store.edges[emotionEdgeId] = {
          id: emotionEdgeId,
          actorId: node.actorId,
          from: node.id,
          to: candidate.id,
          relation: "emotion",
          weight: clamp(0.35 + 0.4 * emotionOverlap + (samePolarity ? 0.15 : 0), 0.1, 1),
          createdAt: this.store.edges[emotionEdgeId]?.createdAt ?? nowIso(),
          updatedAt: nowIso(),
          decayFactor: 0.9,
          hopCost: 1,
        };
      }

      if (finalWeight < threshold) continue;

      const edgeId = [node.actorId, ...[node.id, candidate.id].sort()].join(":");
      this.store.edges[edgeId] = {
        id: edgeId,
        actorId: node.actorId,
        from: node.id,
        to: candidate.id,
        relation: node.domainId === candidate.domainId ? "semantic" : "entity",
        weight: finalWeight,
        createdAt: this.store.edges[edgeId]?.createdAt ?? nowIso(),
        updatedAt: nowIso(),
        decayFactor: node.domainId === candidate.domainId ? 0.98 : 0.95,
        hopCost: node.domainId === candidate.domainId ? 1 : 1.4,
      };
    }
  }

  private rebuildCommunities(actorId: string, domainId: string): void {
    const nodes = Object.values(this.store.nodes).filter(
      (node) => node.actorId === actorId && node.domainId === domainId && node.deletionStage === "active",
    );
    const buckets = new Map<string, string[]>();
    for (const node of nodes) {
      const key = node.keywords.slice(0, 2).join("|") || "misc";
      const bucket = buckets.get(key) ?? [];
      bucket.push(node.id);
      buckets.set(key, bucket);
    }

    for (const [label, nodeIds] of buckets.entries()) {
      if (nodeIds.length < 3) continue;
      const id = `${actorId}:${domainId}:${label}`;
      this.store.communities[id] = {
        id,
        actorId,
        domainId,
        label,
        nodeIds,
        createdAt: this.store.communities[id]?.createdAt ?? nowIso(),
        updatedAt: nowIso(),
      };
    }
  }

  private resolveRecallMode(query: string, domainId: string, explicitCrossDomain: boolean): RecallMode {
    if (explicitCrossDomain) return "cross_domain";
    const tokens = extractKeywords(query);
    const domainHits = Object.values(this.store.nodes).filter(
      (node) => node.domainId === domainId && node.deletionStage === "active" && tokens.some((token) => node.keywords.includes(token)),
    ).length;
    const crossHits = Object.values(this.store.nodes).filter(
      (node) => node.domainId !== domainId && node.deletionStage === "active" && tokens.some((token) => node.keywords.includes(token)),
    ).length;
    return crossHits > 0 && domainHits / Math.max(crossHits, 1) < this.policy.retrieval.routeCrossDomainConfidenceThreshold
      ? "cross_domain"
      : "single_domain";
  }

  private hybridRetrieve(
    actorId: string,
    query: string,
    domainId: string,
    mode: RecallMode,
    context: MemoryContextKind | undefined,
    limit: number,
    queryVec: number[] | null = null,
  ): HybridRetrievalCandidate[] {
    const queryKeywords = extractKeywords(query);
    const queryEntities = extractEntityTags(query);
    // P1 触景生情：query 带情绪时，同情绪的历史节点获得相关性加成（中性 query 恒为 0）。
    const queryEmotion = inferEmotionFromText(query);
    const candidates = Object.values(this.store.nodes)
      .filter((node) => {
        if (node.actorId !== actorId) return false;
        if (node.deletionStage === "hard_deleted" || node.deletionStage === "soft_deleted") return false;
        if (node.metadata?.superseded) return false; // 已被更新断言作废的旧值，召回侧兜底过滤
        // 双时态（P2-1）：有效区间已关闭的事实不参与召回（历史仍可审计，不再当成现状）
        if (node.validTo && Date.parse(node.validTo) <= Date.now()) return false;
        const policy = this.policy.domains[node.domainId];
        if (!policy || !policy.enabled || policy.retired) return false;
        if (mode === "single_domain") return node.domainId === domainId;
        return node.domainId === domainId || !policy.retired;
      })
      .map((node) => {
        // 结构分只作为“同样相关时”的排序倾向，不能压过内容相关性：
        // 原始结构分最高约 0.92，若全额计入，任意同域高重要度节点都会
        // 盖过语义真正相关的低重要度节点（实测“之前我要看谁的照片”
        // 会召回“叫我起床”）。整体缩放后最高约 0.32。
        const structureRaw =
          (node.domainId === domainId ? 0.34 : 0.08) +
          (context && node.context === context ? 0.08 : 0) +
          node.importance * 0.18 +
          node.confidence * 0.1 +
          node.frequencyScore * 0.06 +
          node.domainScore * 0.08 +
          node.userFeedbackScore * 0.08;
        const structureScore = structureRaw * 0.35;
        const keywordScore =
          bigramOverlapScore(queryKeywords, node.keywords) * 0.45 +
          queryEntities.filter((entity) => node.entityTags.includes(entity)).length * 0.12 +
          // 同主题词共现兜底：query 与记忆都谈"居住地/配偶"等同一断言主题时，
          // 即便措辞词面零重叠（"搬到上海定居了" vs "住在哪个城市"）也给出
          // 词法分，避免同主题新事实被下面的相关性下限误杀
          (sharedAssertionSubject(query, node.summary) ? 0.18 : 0) +
          // 情绪轴（P1）：情绪匹配同样构成召回理由（"下雨"→"上次雨天你说心情差"），
          // 且情绪分单独不足 0.22，不会压过词面/向量的强相关条目。
          emotionMatchScore(queryEmotion, resolveNodeEmotion(node)) * 0.22;
        // vectorScore 只认真向量 cosine；缺任一向量记 0，不拿关键词集合冒充语义分
        const nodeVec = parseVectorFingerprint(node.vectorFingerprint);
        const vectorScore =
          queryVec && nodeVec ? Math.max(0, cosineSimilarity(queryVec, nodeVec)) * 0.4 : 0;
        // 相关性下限：词面/语义零重叠的候选不入选。纯结构分（重要性/置信度等）
        // 不构成召回理由——否则任意无关查询都会拖回 top-N 噪声（串台感的
        // 检索层根源，见 test/memory-recall-benchmark.test.ts 基准 B）。
        if (keywordScore <= 0 && vectorScore <= 0) {
          return null;
        }
        // W2 新增：inactivityPenalty — 长期未命中的节点在召回排序时降权
        // 与人类记忆"经常提起就记忆犹新，不提起就逐渐淡忘"机制一致
        // 使用 lastAccessedAt 计算距今天数，配合 forgettingFactor 域差异化
        // confirmed 节点不衰减（agent 对有用记忆是牢固的，不像人类会想不起）
        const policy = this.policy.domains[node.domainId];
        const forgettingFactor = policy?.forgettingFactor ?? 1.0;
        const lastAccessedTs = node.lastAccessedAt ? Date.parse(node.lastAccessedAt) : Date.parse(node.timestamp);
        const daysSinceAccess = Math.max(0, (Date.now() - lastAccessedTs) / 86_400_000);
        // 衰减曲线：7 天内无惩罚，7-30 天线性增长到 0.3，30 天以上封顶 0.3。
        // P2 遗忘曲线：高光/至暗记忆（情绪显著度高）衰减更慢，不会因为"没再提起"
        // 就被普通事实挤掉——这与人脑"情绪事件记得更久"一致。
        const nodeEmotion = resolveNodeEmotion(node);
        const emotionResistance = 1 - emotionalSalience(nodeEmotion) * 0.6;
        const inactivityPenalty =
          node.correctness === "confirmed"
            ? 0 // confirmed 节点不衰减（agent 对有用记忆是牢固的）
            : daysSinceAccess <= 7
              ? 0
              : Math.min(0.3, (daysSinceAccess - 7) * 0.015 * forgettingFactor * emotionResistance);
        // confirmed 节点召回 boost：确保流程回复能稳定记住重要记忆
        // 设计意图：用户澄清"agent 对有用记忆是牢固的"指的是
        //   agent 在对话/流程回复中能够稳定召回这些记忆，而不是"想不起"
        //   通过 finalScore 加分让 confirmed 节点在排序中优先被选中
        const confirmedBoost = node.correctness === "confirmed" ? 0.25 : 0;
        // 来源角色治理（root fix）：助手自己的历史发言是行为记录，不是用户事实证据。
        //   - 关系主题的"摇摆/求证"发言（到底哪位是正主…）与"同一问题我上次怎么答的"
        //     回声节点直接剔除（它们正是敷衍回复自我强化的回声源头）；
        //   - 其余助手发言整体降权，不再与用户断言同权竞争。
        if (resolveNodeRole(node) === "assistant") {
          if (isRelationshipHedgeLine(node.summary)) return null;
          if (this.isEchoReplyNode(node.summary, queryKeywords, query)) return null;
        }
        const assistantPenalty = resolveNodeRole(node) === "assistant" ? ASSISTANT_ROLE_RECALL_PENALTY : 0;
        const finalScore =
          structureScore +
          keywordScore +
          vectorScore +
          confirmedBoost - // confirmed 节点召回优先（流程回复能稳定记住）
          assistantPenalty - // 助手发言降权（不是用户事实）
          inactivityPenalty - // W2 新增：未命中惩罚
          (node.correctness === "rejected" ? 0.6 : 0) -
          (node.correctness === "suspected_error" ? 0.25 : 0) -
          (node.deletionStage === "cold" ? 0.18 : 0) -
          (node.userFeedbackScore < 0.5 ? this.policy.retrieval.userNegativeFeedbackPenalty : 0);
        return { node, structureScore, keywordScore, vectorScore, finalScore };
      })
      .filter((candidate): candidate is HybridRetrievalCandidate => candidate !== null)
      .sort((a, b) => b.finalScore - a.finalScore);

    const resolved = this.dropConflictingOldAssertions(candidates);
    if (mode === "cross_domain") {
      return this.expandByHops(actorId, resolved.slice(0, limit), domainId);
    }
    return resolved.slice(0, limit * 3);
  }

  /**
   * 回声节点检测：助手 EvolutionLoop 发言内嵌了当时被回答的用户原话（user="…"）。
   * 若该原话与当前查询高度相似，说明这条节点只是"上次对同一个问题的回答"——
   * 召回它只会让模型复读旧答案（2026-09 敷衍回复回声循环的直接根源），直接剔除。
   */
  private isEchoReplyNode(summary: string, queryKeywords: string[], rawQuery: string): boolean {
    const echoQuery = extractEchoQueryFromAssistantReply(summary);
    if (!echoQuery) return false;
    const overlap = bigramOverlapScore(queryKeywords, extractKeywords(echoQuery));
    if (overlap >= 0.55) return true;
    // 无向量/关键词兜底：当前查询整体包含当时的问题（换说法的追问）
    const q = normalizeMemoryLine(rawQuery);
    const e = normalizeMemoryLine(echoQuery);
    return q.length >= 6 && e.length >= 6 && (q.includes(e) || e.includes(q));
  }

  /**
   * 同主题冲突消解（召回侧兜底）：候选里同一关系主题出现多个不同值
   * （如旧的"老婆是X"与新值并存）时，只保留最新一条，其余当轮不注入。
   * 覆盖的权威机制在写入侧 supersede，这里是 legacy 数据未修复时的最后防线。
   */
  private dropConflictingOldAssertions(candidates: HybridRetrievalCandidate[]): HybridRetrievalCandidate[] {
    const groups = new Map<RelationshipSubject, Map<string, HybridRetrievalCandidate>>();
    for (const candidate of candidates) {
      const assertion = extractRelationshipAssertion(candidate.node.summary);
      if (!assertion?.value) continue;
      const byValue = groups.get(assertion.subject) ?? new Map<string, HybridRetrievalCandidate>();
      const prev = byValue.get(assertion.value);
      if (!prev || Date.parse(prev.node.timestamp) < Date.parse(candidate.node.timestamp)) {
        byValue.set(assertion.value, candidate);
      }
      groups.set(assertion.subject, byValue);
    }
    const drop = new Set<string>();
    for (const byValue of groups.values()) {
      if (byValue.size < 2) continue;
      const sorted = [...byValue.values()].sort(
        (a, b) => Date.parse(b.node.timestamp) - Date.parse(a.node.timestamp),
      );
      for (const loser of sorted.slice(1)) drop.add(loser.node.id);
    }
    if (drop.size === 0) return candidates;
    return candidates.filter((candidate) => !drop.has(candidate.node.id));
  }

  private expandByHops(
    actorId: string,
    seeds: HybridRetrievalCandidate[],
    domainId: string,
  ): HybridRetrievalCandidate[] {
    const results = [...seeds];
    const seen = new Set(seeds.map((seed) => seed.node.id));
    let frontier = seeds.map((seed) => seed.node.id);
    const maxHops = this.policy.retrieval.maxHopCount;

    for (let hop = 1; hop <= maxHops; hop++) {
      const nextFrontier: string[] = [];
      for (const current of frontier) {
        const outgoing = Object.values(this.store.edges)
          .filter((edge) => edge.actorId === actorId && (edge.from === current || edge.to === current))
          .sort((a, b) => b.weight - a.weight)
          .slice(0, this.policy.retrieval.maxCrossDomainItems);

        for (const edge of outgoing) {
          const neighborId = edge.from === current ? edge.to : edge.from;
          if (seen.has(neighborId)) continue;
          const node = this.store.nodes[neighborId];
          if (!node || node.deletionStage === "hard_deleted" || node.deletionStage === "soft_deleted") continue;
          if (node.validTo && Date.parse(node.validTo) <= Date.now()) continue;
          seen.add(neighborId);
          nextFrontier.push(neighborId);
          results.push({
            node,
            structureScore: edge.weight * 0.2 + (node.domainId === domainId ? 0.12 : 0.06),
            keywordScore: 0,
            vectorScore: edge.weight * 0.12,
            finalScore: node.importance * 0.15 + node.confidence * 0.1 + edge.weight / hop,
          });
        }
      }
      frontier = nextFrontier;
      if (frontier.length === 0) break;
    }
    return results.sort((a, b) => b.finalScore - a.finalScore);
  }

  private applyDiversityControl(
    candidates: HybridRetrievalCandidate[],
    limit: number,
    crossDomain: boolean,
  ): HybridRetrievalCandidate[] {
    const selected: HybridRetrievalCandidate[] = [];
    const usedDomains = new Map<string, number>();
    const usedKinds = new Map<MemoryNodeKind, number>();
    const selectedTokens: Array<Set<string>> = [];

    for (const candidate of candidates) {
      const domainPenalty = (usedDomains.get(candidate.node.domainId) ?? 0) * this.policy.retrieval.diversityPenalty;
      const kindPenalty = (usedKinds.get(candidate.node.kind) ?? 0) * this.policy.retrieval.diversityPenalty;
      // MMR：与已选条目词面重合度越高，边际信息量越低
      const candidateTokens = contentTokenSet(candidate.node.summary);
      let maxOverlap = 0;
      for (const tokens of selectedTokens) {
        maxOverlap = Math.max(maxOverlap, tokenOverlapRatio(candidateTokens, tokens));
      }
      const redundancyPenalty =
        MMR_REDUNDANCE_WEIGHT * Math.max(0, maxOverlap - MMR_REDUNDANCE_FLOOR);
      if (candidate.finalScore - domainPenalty - kindPenalty - redundancyPenalty < 0.18) continue;
      selected.push(candidate);
      selectedTokens.push(candidateTokens);
      usedDomains.set(candidate.node.domainId, (usedDomains.get(candidate.node.domainId) ?? 0) + 1);
      usedKinds.set(candidate.node.kind, (usedKinds.get(candidate.node.kind) ?? 0) + 1);
      if (selected.length >= limit) break;
      if (!crossDomain && selected.length >= limit) break;
    }

    return selected;
  }

  /**
   * 统一注入预算（P1-3）：排序后的候选按字符预算截断，避免长记忆吃光 prompt。
   * 至少保留 1 条（分最高的条目不能被预算自我淘汰）。
   */
  private applyBudgetedSelection(
    selected: HybridRetrievalCandidate[],
  ): HybridRetrievalCandidate[] {
    if (selected.length === 0) return selected;
    const budget = resolveRecallCharBudget();
    const kept: HybridRetrievalCandidate[] = [];
    let used = 0;
    for (const item of selected) {
      const cost = item.node.summary.length + 48; // 序号/域/日期等行装饰
      if (kept.length > 0 && used + cost > budget) continue;
      kept.push(item);
      used += cost;
    }
    return kept;
  }

  private reconstructRecall(
    query: string,
    domainId: string,
    nodes: MemoryNodeRecord[],
    mode: RecallMode,
    detailLevel: RecallDetailLevel,
    confidence: number,
  ): string {
    const header = `记忆重构结果 | 域=${domainId} | 模式=${mode} | 置信度=${confidence}`;
    const facts = nodes.map((node, index) => {
      // 时间标签（2026-10-19 时间认知）：此前只输出 summary，模型完全不知道
      // 这些事发生在什么时候，注入后会把多年前的旧事当近况。这里用节点的
      // 记录时刻做绝对日期标注（不写"3 天前"——相对值每轮都变，且模型能自己算）。
      const base = `${index + 1}. [${node.domainId}/${node.kind}] ${node.summary}（记于 ${this.recallRecordDate(node)}）`;
      if (detailLevel === "summary") return base;
      if (detailLevel === "detail") {
        return `${base} | 重要性=${node.importance.toFixed(2)} | 置信度=${node.confidence.toFixed(2)} | 访问=${node.accessCount}`;
      }
      return `${base} | 来源=${node.source} | 版本=${node.versionIds.length} | 最后访问=${node.lastAccessedAt}`;
    });
    return [
      header,
      `当前任务: ${query.slice(0, 120)}`,
      "以下内容为按当前任务裁剪后的柔性回忆，不是原始对话回放。",
      ...facts,
    ].join("\n");
  }

  /** 召回条目的记录日期（YYYY-MM-DD）；时间戳损坏时如实标注，不猜。 */
  private recallRecordDate(node: MemoryNodeRecord): string {
    const ts = Date.parse(node.timestamp);
    if (!Number.isFinite(ts)) return "时间未知";
    const d = new Date(ts);
    const pad = (n: number): string => (n < 10 ? `0${n}` : String(n));
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  /**
   * 物理清除 hard_deleted 终态节点及其关联边：deletionStage 已是终态且所有
   * 读路径都过滤掉，此前只打标不删导致 store（JSON/SQLite）无限膨胀。
   * 社区/版本记录中的悬挂引用由既有可选链兜底，不影响召回。
   */
  private purgeHardDeletedNodes(actorId: string): number {
    const ids = Object.values(this.store.nodes)
      .filter((node) => node.actorId === actorId && node.deletionStage === "hard_deleted")
      .map((node) => node.id);
    if (ids.length === 0) return 0;
    const idSet = new Set(ids);
    for (const id of ids) delete this.store.nodes[id];
    for (const [edgeId, edge] of Object.entries(this.store.edges)) {
      if (idSet.has(edge.from) || idSet.has(edge.to)) delete this.store.edges[edgeId];
    }
    this.schedulePersist();
    return ids.length;
  }

  private async runSleepCycle(actorId: string): Promise<HumanLikeMemorySleepReport> {
    const nodes = Object.values(this.store.nodes)
      .filter((node) => node.actorId === actorId && node.deletionStage !== "hard_deleted")
      .slice(0, this.policy.sleepAgent.maxNodesPerRun);

    const report: HumanLikeMemorySleepReport = {
      actorId,
      dailyCleanupCount: 0,
      weeklyMergedCount: 0,
      monthlyAbstractedCount: 0,
      consistencyFlagCount: 0,
      knowledgePromotedCount: 0,
      compressionRate: 0,
      estimatedRecallPrecision: 0,
      plannedActions: 0,
      executedActions: 0,
      stageReports: [],
    };
    if (!this.policy.sleepAgent.enabled || nodes.length === 0) return report;

    // 睡眠巩固全确定性：社区提炼/合并/规划均不再调用 LLM（每次夜间一次的
    // 结构化 LLM 抽取由 nightly-memory-task 承担），这里只读状态用于内容去重。
    await this.loadSleepCommunityState();
    this.pendingCommunityFps.clear();

    const actions: SleepAction[] = [];
    const now = Date.now();

    for (const node of nodes) {
      const policy = this.policy.domains[node.domainId];
      if (!policy) continue;
      // W1 修复：原 ageDays 基于 node.timestamp（创建时间），5 年前创建但昨天刚被召回的节点
      // 仍会按 5 年年龄判定 cold_storage —— 这是 bug。
      // 新策略：区分 ageSinceCreated 和 ageSinceAccessed，cold/soft_delete 判定用 ageSinceAccessed
      const ageSinceCreatedDays = Math.max(0, (now - Date.parse(node.timestamp)) / 86_400_000);
      const lastAccessedTs = node.lastAccessedAt ? Date.parse(node.lastAccessedAt) : Date.parse(node.timestamp);
      const ageSinceAccessedDays = Math.max(0, (now - lastAccessedTs) / 86_400_000);

      // W1 新增：长期未命中 → 连续衰减权重（decay_weight）
      // 原策略：frequencyScore / domainScore 只增不减（召回+0.06，ingest+0.12），
      //         只有 accessCount===0 时一次性 downrank，没有连续衰减。
      // 2026-11-11：删除「accessCount===0 → downrank」——新记忆第一晚就被移出
      //         召回集合（召回只取 active），且 downranked 不再流转，等于永久失忆。
      //         新记忆必须保留观察期，价值判断交给下面的按访问时间连续衰减。
      // 新策略：距上次访问超过阈值（默认 7 天）的节点，每次 sleep cycle 衰减 frequencyScore
      //         使用 policy.forgettingFactor 调节衰减强度（0.6-1.6，域差异化）
      //         但已确认（confirmed）的高价值节点不衰减（agent 对有用记忆是牢固的）
      const INACTIVITY_DECAY_THRESHOLD_DAYS = 7;
      const INACTIVITY_DECAY_DELTA = 0.02; // 每次衰减 0.02（约 50 次 sleep cycle 后降到 0）
      if (
        ageSinceAccessedDays > INACTIVITY_DECAY_THRESHOLD_DAYS &&
        node.deletionStage === "active" &&
        node.correctness !== "confirmed" &&
        node.frequencyScore > 0.1 // 下限保护，避免衰减到 0
      ) {
        const decayDelta = INACTIVITY_DECAY_DELTA * (policy.forgettingFactor ?? 1.0);
        actions.push({
          type: "decay_weight",
          nodeId: node.id,
          stage: "daily_cleanup",
          reason: `inactivity_${ageSinceAccessedDays.toFixed(0)}d`,
          delta: decayDelta,
        });
      }

      // W1 修复：cold/soft_delete/hard_delete 判定改用 ageSinceAccessedDays
      if (ageSinceAccessedDays > policy.coldStorageAfterDays && node.deletionStage === "active" && node.accessCount <= 1) {
        actions.push({ type: "cold", nodeId: node.id, stage: "daily_cleanup", reason: "cold_storage_threshold" });
      }
      if (ageSinceAccessedDays > policy.softDeleteAfterDays && node.deletionStage === "cold" && node.correctness !== "confirmed") {
        actions.push({ type: "soft_delete", nodeId: node.id, stage: "daily_cleanup", reason: "soft_delete_threshold" });
      }
      // hard_delete 仍用 ageSinceCreatedDays（节点存在时间够久才能彻底删除）
      if (ageSinceCreatedDays > policy.hardDeleteAfterDays && node.deletionStage === "soft_deleted") {
        actions.push({ type: "hard_delete", nodeId: node.id, stage: "daily_cleanup", reason: "hard_delete_threshold" });
      }
      if (node.correctness === "suspected_error") {
        actions.push({ type: "mark_error", nodeId: node.id, stage: "consistency_audit", reason: "suspected_error" });
      }
    }

    const groupedByFingerprint = new Map<string, MemoryNodeRecord[]>();
    for (const node of nodes) {
      const key = `${node.domainId}:${node.semanticFingerprint}`;
      const bucket = groupedByFingerprint.get(key) ?? [];
      bucket.push(node);
      groupedByFingerprint.set(key, bucket);
    }
    for (const bucket of groupedByFingerprint.values()) {
      if (bucket.length >= 2) {
        actions.push({
          type: "merge",
          nodeIds: bucket.map((node) => node.id),
          stage: "weekly_merge",
          reason: "duplicate_or_fragment_cluster",
        });
      }
    }

    const communityGroups: Array<{ label: string; nodeIds: string[] }> = Object.values(
      this.store.communities,
    )
      .filter((community) => community.actorId === actorId)
      .map((community) => ({ label: community.label, nodeIds: community.nodeIds }));

    // 兜底（零 LLM 图式提炼）：关键词聚类没形成社区时，同 actor 同 domain 的
    // ≥3 个活跃节点也视为一个可提炼的主题组。否则当关键词首位分词不一致时，
    // 同一主题碎片永远无法沉淀成可追溯的主题知识节点。
    const coveredDomains = new Set(
      Object.values(this.store.communities)
        .filter((community) => community.actorId === actorId && community.nodeIds.length >= 3)
        .map((community) => community.domainId),
    );
    const domainBuckets = new Map<string, string[]>();
    for (const node of nodes) {
      if (node.actorId !== actorId || node.deletionStage !== "active") continue;
      const bucket = domainBuckets.get(node.domainId) ?? [];
      bucket.push(node.id);
      domainBuckets.set(node.domainId, bucket);
    }
    for (const [domainId, nodeIds] of domainBuckets) {
      if (nodeIds.length < 3 || coveredDomains.has(domainId)) continue;
      // 质量闸：至少要有一个关键词被 ≥3 个节点共享，才认为它们同属一个主题。
      // 否则同域里彼此无关的闲聊/助手回复会被硬凑成一条低质主题知识。
      const keywordHits = new Map<string, number>();
      for (const id of nodeIds) {
        for (const kw of new Set(this.store.nodes[id]?.keywords ?? [])) {
          if (GENERIC_META_KEYWORD_RE.test(kw)) continue;
          keywordHits.set(kw, (keywordHits.get(kw) ?? 0) + 1);
        }
      }
      if (![...keywordHits.values()].some((count) => count >= 3)) continue;
      communityGroups.push({ label: `domain:${domainId}`, nodeIds });
    }

    for (const community of communityGroups) {
      if (community.nodeIds.length >= 3) {
        const summaries = community.nodeIds
          .map((id) => this.store.nodes[id]?.summary)
          .filter((value): value is string => Boolean(value));
        // 内容未变化的 community 不再重复提炼（指纹相同即跳过）。
        const fp = communityContentFingerprint(community.label, summaries);
        if (this.sleepCommunityState.get(actorId)?.has(fp)) continue;
        // 确定性 schema/主题提炼（零 LLM）：把同社区碎片归并为一条可追溯的
        // 主题知识节点。泛化质量由「同社区多节点 + 去重 + 关键词共性」保证，
        // 不依赖模型；LLM 只用于夜间一次的结构化事实抽取。
        const schema = deterministicCommunitySummary(community.label, summaries);
        if (schema) {
          this.pendingCommunityFps.set(`community:${community.label}`, fp);
          actions.push({
            type: "promote_knowledge",
            nodeIds: community.nodeIds.slice(0, 5),
            stage: "promote_knowledge",
            reason: `community:${community.label}`,
            summary: schema,
          });
        }
      }
    }

    report.plannedActions = Math.min(actions.length, this.policy.sleepAgent.maxActionsPerRun);
    const beforeActive = nodes.filter((node) => node.deletionStage === "active").length;

    for (const action of actions.slice(0, this.policy.sleepAgent.maxActionsPerRun)) {
      if (await this.executeSleepAction(action, report)) {
        report.executedActions += 1;
      }
    }

    report.purgedHardDeleted = this.purgeHardDeletedNodes(actorId);

    const afterActive = Object.values(this.store.nodes).filter(
      (node) => node.actorId === actorId && node.deletionStage === "active",
    ).length;
    report.compressionRate = beforeActive > 0 ? Number(((beforeActive - afterActive) / beforeActive).toFixed(3)) : 0;
    report.estimatedRecallPrecision = Number(
      clamp(
        Object.values(this.store.nodes)
          .filter((node) => node.actorId === actorId)
          .reduce((sum, node) => sum + node.confidence * (node.correctness === "confirmed" ? 1.1 : node.correctness === "rejected" ? 0.2 : 1), 0) /
          Math.max(Object.values(this.store.nodes).filter((node) => node.actorId === actorId).length, 1),
        0,
        1,
      ).toFixed(3),
    );
    this.schedulePersist();
    return report;
  }

  private get sleepCommunityStatePath(): string {
    // 跟随本实例的记忆库路径，而不是全局 data 目录：测试/多实例各自独立的
    // store 不应共享「已提炼指纹」，否则同内容在另一个库会被误跳过（隔离缺陷）。
    return join(dirname(this.filePath), "sleep-agent-state.json");
  }

  private loadSleepCommunityState(): Promise<void> {
    if (this.sleepCommunityStateLoadPromise) return this.sleepCommunityStateLoadPromise;
    this.sleepCommunityStateLoadPromise = (async () => {
      try {
        const raw = await readFile(this.sleepCommunityStatePath, "utf8");
        const parsed = JSON.parse(raw) as { actors?: Record<string, [string, string][]> };
        for (const [actorId, entries] of Object.entries(parsed.actors ?? {})) {
          this.sleepCommunityState.set(actorId, new Map(entries));
        }
      } catch {
        // 首次运行/文件缺失：空状态启动
      }
    })();
    return this.sleepCommunityStateLoadPromise;
  }

  private persistSleepCommunityState(): void {
    const actors: Record<string, [string, string][]> = {};
    for (const [actorId, entries] of this.sleepCommunityState) {
      actors[actorId] = [...entries].slice(-200);
    }
    void writeJsonAtomic(this.sleepCommunityStatePath, { version: 1, actors }).catch(() => {});
  }

  private async executeSleepAction(action: SleepAction, report: HumanLikeMemorySleepReport): Promise<boolean> {
    // LLM 返回的动作可能缺字段（幻觉/截断）：既无 nodeId 也无合法 nodeIds 时直接跳过，
    // 不让坏动作崩溃整个 sleep cycle（真实 key 环境下 LLM 偶发漏字段）。
    const hasNodeId = "nodeId" in action;
    const nodeIds = "nodeIds" in action ? (action as { nodeIds?: unknown }).nodeIds : undefined;
    const hasNodeIds = Array.isArray(nodeIds);
    if (!hasNodeId && !hasNodeIds) return false;
    if (hasNodeIds && nodeIds.length === 0) return false;
    // 动作类型白名单：未知 type 此前会 fallthrough 到 bumpStageReport+return true，
    // 没执行任何操作却计入 executedActions（报告失真），现直接拒绝不计入。
    const nodeIdActionTypes: readonly string[] = [
      "downrank",
      "cold",
      "soft_delete",
      "hard_delete",
      "decay_weight",
      "mark_error",
    ];
    const nodeIdsActionTypes: readonly string[] = ["mark_conflict", "merge", "promote_knowledge"];
    if (hasNodeId && !nodeIdActionTypes.includes(action.type)) return false;
    if (hasNodeIds && !nodeIdsActionTypes.includes(action.type)) return false;
    if ("nodeId" in action) {
      const node = this.store.nodes[action.nodeId];
      if (!node) return false;
      if (action.type === "downrank") {
        node.domainScore = clamp(node.domainScore - 0.12, 0.1, 3);
        node.deletionStage = "downranked";
        report.dailyCleanupCount += 1;
      } else if (action.type === "decay_weight") {
        // W1 新增：连续衰减权重（长期未命中）
        // 不改变 deletionStage，只调整 frequencyScore / recencyScore / domainScore
        // 下限保护：frequencyScore 不低于 0.1（保留召回可能性，不彻底丢失）
        const delta = action.delta;
        node.frequencyScore = clamp(node.frequencyScore - delta, 0.1, 5);
        // recencyScore 用统一遗忘曲线（7 天半衰期 + 访问频率 + 情绪显著性），
        // 与 MemoryForgettingController / KV 摘要保持同一口径。
        const daysSinceAccess = Math.max(0, (Date.now() - Date.parse(node.lastAccessedAt || node.timestamp)) / 86_400_000);
        node.recencyScore = clamp(
          memoryDecayFactor({
            ageDays: daysSinceAccess,
            accessCount: node.accessCount,
            emotionalSalience: emotionalSalience(resolveNodeEmotion(node)),
          }),
          0,
          1,
        );
        // domainScore 轻微衰减（不影响 deletionStage）
        node.domainScore = clamp(node.domainScore - delta * 0.3, 0.1, 3);
        report.dailyCleanupCount += 1;
      } else if (action.type === "cold") {
        node.deletionStage = "cold";
        node.isArchived = true;
        report.dailyCleanupCount += 1;
      } else if (action.type === "soft_delete") {
        node.deletionStage = "soft_deleted";
        report.dailyCleanupCount += 1;
      } else if (action.type === "hard_delete") {
        node.deletionStage = "hard_deleted";
        report.dailyCleanupCount += 1;
      } else if (action.type === "mark_error") {
        node.correctness = "suspected_error";
        report.consistencyFlagCount += 1;
      }
      this.bumpStageReport(report, action.stage, action.reason);
      return true;
    }

    if (action.type === "mark_conflict") {
      if (action.nodeIds.length < 2) return false;
      const conflictId = `conflict_${Date.now().toString(36)}`;
      for (const nodeId of action.nodeIds) {
        const node = this.store.nodes[nodeId];
        if (!node) continue;
        node.conflictGroupId = conflictId;
        node.correctness = "suspected_error";
      }
      report.consistencyFlagCount += action.nodeIds.length;
      this.bumpStageReport(report, action.stage, action.reason);
      return true;
    }

    const bucket = action.nodeIds
      .map((id) => this.store.nodes[id])
      .filter((node): node is MemoryNodeRecord => Boolean(node) && node.deletionStage !== "hard_deleted");
    if (bucket.length < 2) return false;

    if (action.type === "merge") {
      // 确定性合并（零 LLM）：同指纹/碎片簇按 preferLatest 去重，取重要度最高
      // 的节点作为 keeper，其余冷存。语义合并的质量由指纹聚类保证。
      const fallback = dedupeMemoryLines(bucket.map((node) => node.summary), { preferLatest: true }).slice(-1);
      const mergedLines = action.summary ? [action.summary] : fallback;
      const keeper = bucket.sort((a, b) => b.importance - a.importance || b.confidence - a.confidence)[0]!;
      const versionId = this.appendVersion(keeper, mergedLines.join("；"), keeper.confidence, keeper.importance);
      keeper.summary = mergedLines.join("；");
      keeper.currentVersionId = versionId;
      keeper.kind = keeper.kind === "event" ? "knowledge" : keeper.kind;
      keeper.keywords = uniqueStrings([...keeper.keywords, ...extractKeywords(keeper.summary)], 14);
      for (const redundant of bucket.slice(1)) {
        redundant.deletionStage = "cold";
        redundant.isArchived = true;
      }
      report.weeklyMergedCount += bucket.length - 1;
      this.bumpStageReport(report, action.stage, action.reason);
      return true;
    }

    const nodeSummary = action.summary;
    const targetActor = bucket[0]!.actorId;
    const sourceNode = bucket[0]!;
    await this.ingest(targetActor, nodeSummary, "system:knowledge_promotion", {
      context: "main",
      domain: sourceNode.domainId === "temporary" ? "general" : sourceNode.domainId,
      metadata: { highSignal: true, promotedFromNodeIds: action.nodeIds, procedural: sourceNode.kind === "procedure" },
    });
    report.knowledgePromotedCount += 1;
    report.monthlyAbstractedCount += 1;
    // P0-C：提升成功后把 community 内容指纹标记为已处理（下次内容未变化则跳过提炼，
    // 避免 action 上限截断导致永久丢失——只在真实落库后标记）
    const communityFp = this.pendingCommunityFps.get(action.reason);
    if (communityFp) {
      let seen = this.sleepCommunityState.get(targetActor);
      if (!seen) {
        seen = new Map();
        this.sleepCommunityState.set(targetActor, seen);
      }
      seen.set(communityFp, new Date().toISOString().slice(0, 10));
      this.persistSleepCommunityState();
    }
    this.bumpStageReport(report, action.stage, action.reason);
    return true;
  }

  private bumpStageReport(
    report: HumanLikeMemorySleepReport,
    stage: SleepAgentStage,
    note: string,
  ): void {
    const existing = report.stageReports.find((item) => item.stage === stage);
    if (existing) {
      existing.changed += 1;
      if (existing.notes.length < 6) existing.notes.push(note);
      return;
    }
    report.stageReports.push({ stage, changed: 1, notes: [note] });
  }

  private recordWriteLatency(start: number): void {
    this.telemetry.writes += 1;
    this.telemetry.writeLatencyMs.push(Date.now() - start);
    this.telemetry.writeLatencyMs = this.telemetry.writeLatencyMs.slice(-200);
  }

  private recordRecallLatency(start: number): void {
    this.telemetry.recallLatencyMs.push(Date.now() - start);
    this.telemetry.recallLatencyMs = this.telemetry.recallLatencyMs.slice(-200);
  }
}

let singleton: HumanLikeMemoryService | null = null;

export function getHumanLikeMemoryService(): HumanLikeMemoryService | null {
  return singleton;
}

export async function initHumanLikeMemoryService(): Promise<HumanLikeMemoryService> {
  if (singleton) return singleton;
  const service = new HumanLikeMemoryService();
  await service.load();
  singleton = service;
  return service;
}
