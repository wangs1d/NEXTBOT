// Agent Brain Center — 记忆皮层（海马体）
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import type {
  MemoryConsolidationStats,
  MemoryDomainKind,
  MemoryItem,
  MemoryItemKind,
  MemoryMedia,
  MemoryRecallItem,
  MemoryRecallResult,
  PersonalityCore,
  PredictedAssociation,
  SchemaMatchResult,
  SchemaNode,
  SalienceDecision,
  InferenceClue,
  InferenceResult,
} from "./types.js";
import type { RelationshipGraphService } from "../services/relationship-graph-service.js";
import type { LifeModelStore } from "../agentic-memory/life-model-store.js";
import type { MemoryAssociativeGraph } from "./memory-cognitive/memory-associative-graph.js";
import type { MemoryMetacognitionBridge } from "./memory-cognitive/memory-metacognition-bridge.js";
import type { MemoryForgettingController } from "./memory-cognitive/memory-forgetting-controller.js";
import type { MemorySchemaFormation } from "./memory-cognitive/memory-schema-formation.js";
import type { MemorySalienceFilter } from "./memory-cognitive/memory-salience-filter.js";
import type { MemoryInferenceEngine } from "./memory-cognitive/memory-inference-engine.js";
import type { EmotionState } from "./memory-cognitive/memory-inference-emotion-modulator.js";
import type {
  LearningFeedback,
  LearningSnapshot,
  MemoryExperienceLearningLoop,
} from "./memory-cognitive/memory-experience-learning-loop.js";
import {
  arbitrateMemories,
  fuseRankLists,
  loadArbitratorConfigFromEnv,
  shouldShortCircuitAgentic,
  type ChannelRecallResult,
  type MemoryArbitratorConfig,
} from "./memory-arbitrator.js";
import { rerankTexts } from "../agentic-memory/reranker.js";
import {
  getMemoryRerankerCandidates,
  getMemoryRerankerMinScore,
  getMemoryRerankerMode,
} from "../agentic-memory/env.js";
import { semanticFingerprint } from "../services/memory-record-utils.js";
import {
  MemoryStrengthModel,
  type MemoryFeedbackInput,
} from "./memory-strength-model.js";
import type { MemoryAssociationSynthesizer } from "./memory-cognitive/memory-association-synthesizer.js";
import {
  SessionEpitomeStore,
  type SessionEpitomeEntries,
  type SessionEpitomeSnapshot,
} from "../services/session-epitome.js";
import { RecallAnchorStore, type RecallAnchorRecord } from "../services/recall-anchor-store.js";
import { isEphemeralActorId, warnEphemeralActorMemoryBlocked } from "../agent/actor-id.js";
import type { AgenticMemoryCandidate } from "../agentic-memory/retrieval.js";
import { MemoryInventory } from "./memory-inventory.js";
import type {
  ImplicitFeedbackSignal,
  RecalledMemoryLite,
} from "./memory-implicit-feedback.js";

// ============================================================
// 子系统外观接口（最小化，只声明 MemoryCortex 用到的方法）
// ============================================================

// 短期任务条目外观
interface ShortTermTaskLike {
  taskId: string;
  title: string;
  status: "active" | "paused" | "completed";
  contextSummary: string;
  createdAt: string;
  updatedAt: string;
}

// 短期会话记忆外观
interface ShortTermConversationMemoryLike {
  activeTopic: string | null;
  currentMission: string | null;
  carryForward: string[];
  preferences: string[];
  facts: string[];
  openLoops: string[];
  agentCommitments: string[];
  lastUpdated: string;
}

// 短期记忆网关外观接口（ShortTermMemoryGatewayService 子集）
interface ShortTermMemoryLike {
  syncTaskForTurn(sessionId: string, input: string): {
    task: ShortTermTaskLike;
    resumed: boolean;
  };
  getTaskState(sessionId: string): {
    activeTaskId: string | null;
    tasks: ShortTermTaskLike[];
    conversationMemory?: ShortTermConversationMemoryLike;
  };
}

// Mem0 agentic 记忆外观（AgenticMemoryRuntime 子集）
interface AgenticMemoryLike {
  ingest: {
    ingestText(
      actorId: string,
      sourceId: string,
      text: string,
      opts?: { highSignal?: boolean; context?: "main" | "notes" },
    ): Promise<void>;
  };
  retrieval: {
    buildRecall(actorId: string, queryText: string): Promise<string>;
    buildCrossContextRecall(actorId: string, queryText: string): Promise<string>;
    searchStructured(
      actorId: string,
      queryText: string,
      opts?: { context?: "main" | "notes" | "any" },
    ): Promise<AgenticMemoryCandidate[]>;
  };
}

// 记忆桥接外观（P0-1/P1-7）：结构兼容 MemoryBridgeService 即可
interface MemoryBridgeLike {
  writeUnified(
    actorId: string,
    sourceId: string,
    text: string,
    opts: { context: "main" | "notes"; highSignal: boolean },
  ): Promise<unknown>;
  searchFused(
    actorId: string,
    query: string,
    opts?: { context?: "main" | "notes" | "any"; topK?: number },
  ): Promise<
    Array<{
      content: string;
      fusedScore: number;
      channels: string[];
      mem0Score?: number;
      graphNodeId?: string;
      timestamp?: string;
    }>
  >;
}

// 海马体（HumanLikeMemoryService）外观接口
interface HumanLikeMemoryLike {
  ingest(
    actorId: string,
    text: string,
    source: string,
    opts?: {
      context?: "main" | "notes";
      domain?: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<unknown>;
  buildRecall(
    actorId: string,
    query: string,
    opts?: {
      source?: string;
      context?: "main" | "notes";
      explicitDomain?: string;
      crossDomain?: boolean;
      limit?: number;
      detailLevel?: "summary" | "detail" | "source";
    },
  ): Promise<{
    domainId: string;
    mode: "single_domain" | "cross_domain";
    recalledNodeIds: string[];
    confidence: number;
    text: string;
  }>;
  /**
   * 可选：用户反馈回灌到记忆节点（更新 userFeedbackScore）。
   * 由 MemoryCortex.recordMemoryFeedback 在记录反馈时调用，
   * 修复 userFeedbackScore 固定为 1 的问题（此前无任何更新路径）。
   */
  applyUserFeedback?(actorId: string, summary: string, score: number): void;
  /**
   * 可选：按记忆内容反查图节点 ID（联想种子语义化用）。
   * recall 结果的 MemoryRecallItem 不携带 nodeId，联想扩散 spread 需要真实
   * 节点 ID 才能在图上命中；此方法按 content 前缀/包含匹配返回节点 ID。
   */
  findNodeIdsByContent?(actorId: string, contents: string[], maxPerContent?: number): string[];
  /**
   * 可选：按节点 ID 批量取摘要（联想扩散结果 → 当轮召回候选）。
   * spread 返回激活节点 ID 列表，召回侧需要内容才能并入候选池。
   */
  getNodeSummariesByIds?(
    actorId: string,
    nodeIds: string[],
    max?: number,
  ): Array<{ id: string; summary: string }>;
  /**
   * 可选：查询给定节点中处于可再唤醒状态（downranked/cold）的节点 ID。
   * 召回命中褪色记忆时，MemoryCortex 据此触发 ForgettingController.reawakenAndStrengthen
   * （遗忘反弹：deletionStage 回退一级 + frequencyScore 反弹）。
   */
  findReawakenableNodeIds?(actorId: string, nodeIds: string[]): string[];
}

// 叙事记忆睡眠巩固报告外观
interface NarrativeSleepReport {
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
  stageReports: Array<{ stage: string; changed: number; notes: string[] }>;
}

// 叙事记忆端口外观接口（NarrativeMemoryPort 子集）
interface NarrativeMemoryLike {
  ingest(
    actorId: string,
    text: string,
    source: string,
    opts?: { highSignal?: boolean; context?: "main" | "notes" },
  ): Promise<void>;
  buildNarrativeRecall(actorId: string, query: string): Promise<string>;
  buildCrossContextRecall(actorId: string, query: string): Promise<string>;
  runSleepConsolidation(actorIds: string[]): Promise<NarrativeSleepReport[]>;
}

// KV 摘要记忆外观（AgentMemorySyncService 子集）
interface KvSummaryLike {
  getSnapshot(
    actorId: string,
    keys?: string[],
  ): { revision: number; entries: Record<string, unknown> };
  /** 可选：写入单个 KV 条目（用于 personality_core 等结构化特质的持久化） */
  setEntry?(actorId: string, key: string, value: unknown): void;
}

// 记忆管理器外观（MemoryManagerService 子集）
interface MemoryManagerLike {
  consolidateNow(actorId: string): Promise<{
    entriesMerged: number;
    entriesRemoved: number;
    rememberedCount: number;
    fadedCount: number;
  }>;
  /**
   * 把命中的 forgotten 行移回 memory_summary（forgotten 自动恢复）。
   * 当 recall 命中 memory_summary_forgotten 中的行且判定与当前 query 相关时调用。
   * 实现内部用 applyPatch 原子读写，避免并发覆盖。
   */
  restoreForgottenLines?(actorId: string, lines: string[]): Promise<void>;
  /**
   * 语义化 forgotten 召回（方案 A）：
   * 用 embedding 计算 query 与 forgotten 行的 cosine 相似度，> 阈值视为命中；
   * embedding 无命中时降级到 LLM 批量语义判断。
   * 返回与 query 语义相关的 forgotten 行（用于补充主召回 + 自动恢复）。
   */
  recallForgottenSemantic?(actorId: string, query: string): Promise<string[]>;
}

// 夜间调度器外观（NightlyMemoryTaskService 子集）
interface NightlySchedulerLike {
  forceRunNightTasks(): Promise<{
    consolidated: boolean;
    archived: boolean;
    synced: boolean;
    error?: string;
  }>;
}

/**
 * SynapseBus 的最小化外观接口（结构兼容真实 SynapseBus 即可）。
 * 仅声明 MemoryCortex 用到的 fire + 可选 subscribeType 能力。
 */
interface SynapseBusLike {
  fire(
    type: string,
    data: Record<string, unknown>,
    opts?: { actorId?: string; source?: string },
  ): unknown;
  subscribeType?(
    type: string,
    handler: (event: {
      data: Record<string, unknown>;
      actorId?: string;
      source?: string;
    }) => void | Promise<void>,
  ): () => void;
}

// ============================================================
// 域推断 helper
// ============================================================

/**
 * 解析 agentic 检索首行的 freshness 标记（「刚刚」/「Nh前」/「Nd前」）为 ISO 时间戳。
 * 让记忆携带真实发生时间（估算值），供仲裁器做时间衰减打分、注入层做相对时间标注。
 */
function parseFreshnessToIso(firstLine: string, now = Date.now()): string | null {
  if (/刚刚/.test(firstLine)) return new Date(now).toISOString();
  const h = firstLine.match(/(\d+(?:\.\d+)?)h前/);
  if (h) return new Date(now - parseFloat(h[1]) * 3_600_000).toISOString();
  const d = firstLine.match(/(\d+(?:\.\d+)?)d前/);
  if (d) return new Date(now - parseFloat(d[1]) * 86_400_000).toISOString();
  return null;
}

/** 根据 MemoryItemKind 推断默认记忆域 */
function inferDomain(kind: MemoryItemKind): MemoryDomainKind {
  switch (kind) {
    case "task":
      return "working";
    case "event":
      return "episodic";
    case "knowledge":
      return "semantic";
    case "procedure":
      return "procedural";
    case "fact":
      return "semantic";
    case "commitment":
      return "episodic";
    case "experience":
      return "episodic";
    case "preference":
      return "emotional";
  }
}

// ============================================================
// MemoryCortex
// ============================================================

/** 单条 MemoryRecallItem.text 的最大字符数，超出则截断并追加省略标记 */
const MAX_RECALL_ITEM_TEXT_LENGTH = 800;

/** 数值 clamp 到 [0, 1]，用于反馈回灌与反馈调整后的分数归一。 */
function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/**
 * 从写入 metadata 中提取图式场景标签（图式形成接线的取数口）：
 * - metadata.sceneTags: string[]（优先）
 * - metadata.sceneTag: string
 * 均缺省时返回空数组（该条记忆不参与图式抽取——宁缺毋滥，不做猜测式打标）。
 */
function extractSceneTagsFromMetadata(
  metadata: Record<string, unknown> | undefined,
): string[] {
  if (!metadata) return [];
  const raw = metadata.sceneTags ?? metadata.sceneTag;
  const list = Array.isArray(raw) ? raw : [raw];
  return list
    .filter((t): t is string => typeof t === "string")
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && t.length <= 32)
    .slice(0, 4);
}

/** 多模态媒体存储根目录（相对于 server 工作目录） */
const MEMORY_MEDIA_ROOT = resolve(process.cwd(), ".memory-media");

/** 根据 media.kind + mime 推断文件扩展名 */
function inferMediaExt(media: MemoryMedia): string {
  const mime = media.mime.toLowerCase();
  if (media.kind === "image") {
    if (mime.includes("png")) return "png";
    if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg";
    if (mime.includes("webp")) return "webp";
    if (mime.includes("gif")) return "gif";
    return "img";
  }
  if (media.kind === "audio") {
    if (mime.includes("wav")) return "wav";
    if (mime.includes("mp3")) return "mp3";
    if (mime.includes("ogg")) return "ogg";
    if (mime.includes("webm")) return "webm";
    return "audio";
  }
  if (media.kind === "video") {
    if (mime.includes("mp4")) return "mp4";
    if (mime.includes("webm")) return "webm";
    return "video";
  }
  return "bin";
}

/**
 * 持久化多模态媒体到本地文件系统。
 * 路径：.memory-media/<actorId>/<sha256>.<ext>
 * 返回 storageId（文件名，不含路径），供召回时拉取。
 * 写入失败时返回 null（不阻塞记忆主流程，降级为纯文本记忆）。
 */
function persistMediaBlob(actorId: string, media: MemoryMedia): string | null {
  if (!media.blob || media.blob.length === 0) return null;
  try {
    const dir = join(MEMORY_MEDIA_ROOT, actorId);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const hash = createHash("sha256").update(media.blob).digest("hex").slice(0, 32);
    const ext = inferMediaExt(media);
    const filename = `${hash}.${ext}`;
    const filepath = join(dir, filename);
    if (!existsSync(filepath)) {
      writeFileSync(filepath, media.blob);
    }
    return filename;
  } catch (err) {
    console.log(`[MemoryCortex] persistMediaBlob 失败（降级纯文本）: ${err}`);
    return null;
  }
}

/**
 * 默认人格内核 —— 未设置人格时使用，不阻塞启动。
 * 防漂移：人格特质不随单次对话漂移，仅可通过 setPersonalityCore 显式更新。
 */
export const DEFAULT_PERSONALITY_CORE: PersonalityCore = {
  values: ["真诚", "帮助他人", "持续成长"],
  speech_style: { tone: "温和", formality: "适中", humor: "适度" },
  beliefs: ["技术应服务于人"],
  quirks: ["偶尔用比喻解释复杂概念"],
};

/** KV 持久化 key 前缀：personality_core_${actorId} */
function personalityCoreKey(actorId: string): string {
  return `personality_core_${actorId}`;
}

/** 判断未知值是否为合法 PersonalityCore，用于从 KV 反序列化时校验 */
function isPersonalityCore(v: unknown): v is PersonalityCore {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  const ss = o.speech_style as Record<string, unknown> | undefined;
  return (
    Array.isArray(o.values) && o.values.every((x): x is string => typeof x === "string") &&
    Boolean(ss) && typeof ss === "object" &&
    typeof ss?.tone === "string" &&
    typeof ss?.formality === "string" &&
    typeof ss?.humor === "string" &&
    Array.isArray(o.beliefs) && o.beliefs.every((x): x is string => typeof x === "string") &&
    Array.isArray(o.quirks) && o.quirks.every((x): x is string => typeof x === "string")
  );
}

/**
 * 记忆皮层（海马体）—— 大脑中心记忆子系统外观。
 *
 * 持有短期 / agentic / 海马体 / 叙事四类记忆服务的可选引用，
 * 对外提供统一的 remember / recall / recallCrossDomain / consolidate 入口。
 * 任一子系统缺失时方法优雅降级。所有方法直接调用底层记忆服务，
 * 不走 LLM prompt 路线。
 */
export class MemoryCortex {
  private shortTerm: ShortTermMemoryLike | null = null;
  private agentic: AgenticMemoryLike | null = null;
  private humanLike: HumanLikeMemoryLike | null = null;
  private narrative: NarrativeMemoryLike | null = null;
  private bridge: MemoryBridgeLike | null = null;
  private kvSummary: KvSummaryLike | null = null;
  private memoryManager: MemoryManagerLike | null = null;
  private nightlyScheduler: NightlySchedulerLike | null = null;
  private synapseBus: SynapseBusLike | null = null;
  private started = false;
  // personality 域：结构化人格内核缓存（KV 持久化，防漂移）
  private personalityCache = new Map<string, PersonalityCore>();
  // relationship 域：关系图谱服务（Phase 1.2，里程碑/轨迹/共同经历）
  private relationshipGraph: RelationshipGraphService | null = null;
  /** 用户生活模型（实体/关系/轨迹）——第 ④ 层建模，作为 lifeModel 召回通道 */
  private lifeModelStore: LifeModelStore | null = null;
  // ---- 记忆认知架构升级（Phase 3）：子组件 ---------------------------
  private associativeGraph: MemoryAssociativeGraph | null = null;
  private metacognitionBridge: MemoryMetacognitionBridge | null = null;
  private forgettingController: MemoryForgettingController | null = null;
  private schemaFormation: MemorySchemaFormation | null = null;
  private salienceFilter: MemorySalienceFilter | null = null;
  private experienceLearningLoop: MemoryExperienceLearningLoop | null = null;
  // ---- 记忆认知架构升级（推理引擎）：多线索交叉推理 -----------------------
  private inferenceEngine: MemoryInferenceEngine | null = null;
  // ---- 记忆联想性增强：LLM 合成跨记忆新关联（异步，不阻塞 recall）----
  private associationSynthesizer: MemoryAssociationSynthesizer | null = null;
  /** 联想合成冷却（per-actor）：合成是异步 LLM 调用且结论回灌记忆图，无冷却会自我增殖烧 token */
  private associationSynthLastRun = new Map<string, number>();
  // ---- 三层记忆通道统一仲裁（agentic / humanLike / narrative / kvSummary）----
  // 改造前：降级链串行 fallback，同一时刻只用一条通道，分数丢失、无法跨通道融合。
  // 改造后：agentic 充足时短路；不足时并行多通道，交 arbitrateMemories 归一化+去重+重排。
  private arbitratorConfig: MemoryArbitratorConfig = loadArbitratorConfigFromEnv();
  // ---- 记忆相关性在线反馈回灌（Phase：相关性优化）----
  // 用户反馈（显式 API / 隐式纠正信号）按语义指纹持久化到 KV，
  // 召回时对命中条目做加成/惩罚调整排序。懒加载：首次 recall/record 时初始化。
  private strengthModel: MemoryStrengthModel | null = null;
  // ---- 跨会话开放环路（Phase：连续性优化）----
  // 每轮 cognize 提取 open loops / 承诺 / 偏好，KV 持久化，
  // 新会话开场注入【上一会话待办】，解决"换会话跳转/失忆"。
  private epitomeStore: SessionEpitomeStore | null = null;
  // ---- open loop 完成监听（ProactivityHub 接线）----
  // 用户待办被检测为已完成时回调（actorId, loopText），
  // 由装配层注入 hub.onUserLoopCompleted 触发"待办完成恭喜"。
  private epitomeLoopClosedListener: ((actorId: string, loopText: string) => void) | null = null;
  // ---- 引用锚点诊断（Phase：连续性优化）----
  // 记录每轮 recall 注入的记忆锚点（KV 持久化），配合反馈/开放环路提供连续性诊断。
  private anchorStore: RecallAnchorStore | null = null;
  // ---- 记忆目录（元认知：知道自己记住了什么）----
  // 从 kvSummary 统计记忆规模/时间分布/高频主题，生成自然语言目录摘要。
  private memoryInventory: MemoryInventory | null = null;
  // ---- 写入时在线关联分析的节流（actorId → 上次触发时间）----
  // remember 每轮都调用，但 LLM 关联分析按最小间隔节流（默认 45s），
  // 高频写入（如感官事件流）不会打爆 LLM。
  private readonly writeAssociationAt = new Map<string, number>();
  private writeAssociationMinIntervalMs = MemoryCortex.loadWriteAssociationIntervalMs();

  // ---- 子系统注册 ----------------------------------------------------------

  registerShortTerm(svc: ShortTermMemoryLike): void {
    this.shortTerm = svc;
    console.log("[MemoryCortex] 已注册 ShortTermMemory");
  }

  registerAgentic(svc: AgenticMemoryLike): void {
    this.agentic = svc;
    console.log("[MemoryCortex] 已注册 AgenticMemory");
  }

  /**
   * 注册记忆桥接（P0-1/P1-7）：写入 fallback 走 bridge.writeUnified（带 linkage，
   * 不再产生遗忘同步扫不到的旁路记忆）；召回用 searchFused 单次融合
   * （Mem0 × 认知图 RRF），替代原先两路各自检索再仲裁的双重融合。
   */
  registerBridge(svc: MemoryBridgeLike): void {
    this.bridge = svc;
    console.log("[MemoryCortex] 已注册 MemoryBridge");
  }

  registerHumanLike(svc: HumanLikeMemoryLike): void {
    this.humanLike = svc;
    console.log("[MemoryCortex] 已注册 HumanLikeMemory");
  }

  registerNarrative(svc: NarrativeMemoryLike): void {
    this.narrative = svc;
    console.log("[MemoryCortex] 已注册 NarrativeMemory");
  }

  registerKvSummary(s: KvSummaryLike): void {
    this.kvSummary = s;
    console.log("[MemoryCortex] 已注册 KvSummary");
  }

  registerMemoryManager(svc: MemoryManagerLike): void {
    this.memoryManager = svc;
    console.log("[MemoryCortex] 已注册 MemoryManager");
  }

  registerNightlyScheduler(svc: NightlySchedulerLike): void {
    this.nightlyScheduler = svc;
    console.log("[MemoryCortex] 已注册 NightlyScheduler");
  }

  /** 注册关系图谱服务（Phase 1.2）：用于 relationship 域 recall 与里程碑记录 */
  registerRelationshipGraph(svc: RelationshipGraphService): void {
    this.relationshipGraph = svc;
    console.log("[MemoryCortex] 已注册 RelationshipGraph");
  }

  /**
   * 注册用户生活模型（Life Model）存储：作为 lifeModel 召回通道并入仲裁，
   * 命中用户问句里的人/关系/宠物实体。未注册时该通道跳过（零开销）。
   */
  registerLifeModelStore(svc: LifeModelStore | null): void {
    this.lifeModelStore = svc;
    console.log(`[MemoryCortex] 已注册 LifeModelStore（${svc ? "启用" : "停用"}）`);
  }

  /**
   * lifeModel 通道召回：用户问句命中的实体（人/宠物/组织）及其与用户的关系边，
   * 构造为召回条目（确定性建模，非语义检索）。命中不了则返回空（零开销）。
   */
  private buildLifeModelRecallItems(actorId: string, query: string): MemoryRecallItem[] {
    const store = this.lifeModelStore;
    const q = query?.trim();
    if (!store || !q) return [];
    try {
      const entities = store.matchEntitiesInText(actorId, q).slice(0, 4);
      if (entities.length === 0) return [];
      const selfId = store.findEntityByName(actorId, "我")?.id ?? null;
      const edges = store.getEdges(actorId).filter((e) => e.kind !== "self_agent");
      const items: MemoryRecallItem[] = [];
      for (const ent of entities) {
        const edge =
          (selfId ? edges.find((x) => x.fromEntityId === selfId && x.toEntityId === ent.id) : null) ??
          edges.find((x) => x.toEntityId === ent.id) ??
          null;
        const rel = edge ? `（关系：${edge.subKind ?? edge.kind}）` : "";
        items.push({
          content: `生活模型：${ent.canonicalName}${rel}${ent.aliases.length ? `，也叫${ent.aliases.join("/")}` : ""}`,
          domain: "semantic" as MemoryDomainKind,
          source: "life_model",
          importance: ent.kind === "pet" || edge ? "high" : "medium",
          score: 0.68,
          timestamp: ent.lastSeenAt,
        });
      }
      return items;
    } catch (err) {
      console.log(`[MemoryCortex] lifeModel recall failed: ${err}`);
      return [];
    }
  }

  // ---- 记忆认知架构升级（Phase 3）：7 个子组件注册 ------------------------

  registerAssociativeGraph(svc: MemoryAssociativeGraph): void {
    this.associativeGraph = svc;
    console.log("[MemoryCortex] 已注册 MemoryAssociativeGraph");
  }

  registerMetacognitionBridge(svc: MemoryMetacognitionBridge): void {
    this.metacognitionBridge = svc;
    console.log("[MemoryCortex] 已注册 MemoryMetacognitionBridge");
  }

  registerForgettingController(svc: MemoryForgettingController): void {
    this.forgettingController = svc;
    console.log("[MemoryCortex] 已注册 MemoryForgettingController");
  }

  registerSchemaFormation(svc: MemorySchemaFormation): void {
    this.schemaFormation = svc;
    console.log("[MemoryCortex] 已注册 MemorySchemaFormation");
  }

  registerSalienceFilter(svc: MemorySalienceFilter): void {
    this.salienceFilter = svc;
    console.log("[MemoryCortex] 已注册 MemorySalienceFilter");
  }

  registerExperienceLearningLoop(svc: MemoryExperienceLearningLoop): void {
    this.experienceLearningLoop = svc;
    console.log("[MemoryCortex] 已注册 MemoryExperienceLearningLoop");
  }

  /** 注册推理引擎（多线索交叉推理） */
  registerInferenceEngine(svc: MemoryInferenceEngine): void {
    this.inferenceEngine = svc;
    console.log("[MemoryCortex] 已注册 MemoryInferenceEngine（推理引擎）");
  }

  /** 注册 LLM 记忆联想合成器（跨记忆新关联）。未启用时 recall 跳过联想触发。 */
  registerAssociationSynthesizer(svc: MemoryAssociationSynthesizer | null): void {
    this.associationSynthesizer = svc;
    console.log("[MemoryCortex] 已注册 MemoryAssociationSynthesizer（联想合成器）");
  }

  /** 注册记忆目录（元认知层：统计 + 自然语言目录摘要）。 */
  registerMemoryInventory(inventory: MemoryInventory | null): void {
    this.memoryInventory = inventory;
    console.log("[MemoryCortex] 已注册 MemoryInventory（记忆目录）");
  }

  /** 写入时在线关联分析的最小间隔（节流，防止高频写入打爆 LLM）。 */
  private static loadWriteAssociationIntervalMs(): number {
    const raw = process.env.MEMORY_WRITE_ASSOCIATION_INTERVAL_MS;
    const n = raw ? parseFloat(raw) : NaN;
    return Number.isFinite(n) && n >= 0 ? n : 45_000;
  }

  /**
   * 隐式反馈批量回灌入口：把 ImplicitFeedbackDetector 检测出的信号
   * 翻译成 MemoryFeedbackInput 交给反馈存储（KV 持久化 + humanLike 节点回灌）。
   * 弱负反馈用减半 delta（相对纠正信号更温和）。
   */
  recordImplicitFeedbacks(actorId: string, signals: ImplicitFeedbackSignal[]): void {
    if (!signals || signals.length === 0) return;
    for (const sig of signals.slice(0, 5)) {
      this.recordMemoryFeedback({
        actorId,
        content: sig.memoryContent,
        outcome: sig.signal === "positive" ? "relevant" : "irrelevant",
        // weak_negative 折半强度：-0.25 → -0.125
        ...(sig.signal === "weak_negative" ? { delta: -0.125 } : {}),
      });
    }
  }

  /** 记忆目录摘要（元认知 prompt 注入用；无记忆时返回空串）。 */
  async getInventorySummary(actorId: string): Promise<string> {
    if (!this.memoryInventory) return "";
    try {
      const report = await this.memoryInventory.getReport(actorId);
      return report.summary;
    } catch {
      return "";
    }
  }

  /**
   * 图式形成调度（记忆建立联系，2026-10-22 接线）：
   * 新记忆写入成功后，若 metadata 携带 sceneTags/sceneTag，则异步尝试对每个
   * sceneTag 抽取"公共步骤序列"图式（同场景经历 ≥3 条时 LCS 抽取，纯算法零 LLM）。
   *
   * 不节流：extractSchema 未达 minInstances 时零成本返回 null（一次内存数组过滤），
   * 真正的抽取只在达标写入后发生；节流反而会吞掉"第 3 条达标写入"的抽取时机。
   * 夜审/测试可走 extractSchemaNow 同步触发。
   */
  private scheduleSchemaFormation(
    actorId: string,
    metadata: Record<string, unknown> | undefined,
  ): void {
    if (!this.schemaFormation) return;
    const sceneTags = extractSceneTagsFromMetadata(metadata);
    if (sceneTags.length === 0) return;
    for (const sceneTag of sceneTags) {
      void this.schemaFormation.extractSchema(actorId, sceneTag).catch(() => {
        /* 图式抽取失败静默降级 */
      });
    }
  }

  /**
   * 同步抽取指定 actor 指定场景的图式（公开出口）：
   * 夜间巩固（consolidate）/ 测试 / 手动诊断使用；未注册 schemaFormation 返回 null。
   */
  async extractSchemaNow(actorId: string, sceneTag: string): Promise<SchemaNode | null> {
    if (!this.schemaFormation) return null;
    try {
      return await this.schemaFormation.extractSchema(actorId, sceneTag);
    } catch (err) {
      console.log(`[MemoryCortex] extractSchemaNow 失败: ${err}`);
      return null;
    }
  }

  /**
   * 图式提示附加（「被问起时想得起」的联想面）：query 命中已抽取图式时，
   * 在召回结果上附加 schemaHint——告诉上层"这类事情通常的步骤/预期"，
   * 仅建议不强制（刻板印象警告随 hint 透出）。未注册/无匹配时原样返回。
   */
  private attachSchemaHint(actorId: string, query: string, result: MemoryRecallResult): MemoryRecallResult {
    if (!this.schemaFormation || result.schemaHint) return result;
    try {
      // 中文 query 无分词边界：sceneTag 直接做子串命中（「去餐厅吃饭」→「餐厅」），
      // 命中后以 sceneTag 通道匹配（基础分 0.6），比 keywords overlap 可靠。
      const schemas = this.schemaFormation.getAllSchemas(actorId);
      const sceneTag = schemas.find((s) => s.sceneTag && query.includes(s.sceneTag))?.sceneTag;
      const matched = this.schemaFormation.matchSchema({
        sceneTag,
        summary: query,
        keywords: query.toLowerCase().split(/[\s,，。.、;；!！?？]+/).filter(Boolean),
        actorId,
      });
      if (!matched) return result;
      return {
        ...result,
        schemaHint: {
          name: matched.schema.name,
          steps: matched.schema.steps,
          matchScore: matched.matchScore,
          hasStereotypeWarning: matched.hasStereotypeWarning,
        },
      };
    } catch {
      return result;
    }
  }

  /**
   * 遗忘梯度衰减分（「该忘的退得掉」读侧，2026-10-22 接线）：
   * recency（72h 半衰期，与检索层一致）与 importance 各占 50%。
   * 得分 < 0.5 的召回条目按 ForgettingController.compactRecallText 梯度截断——
   * 褪色的记忆以残缺形式被想起，而不是要么完整要么消失。
   * 容量治理（真删除）仍由 lifecycle TTL 两阶段遗忘承担，二者分工明确。
   */
  private applyForgettingGradient(items: MemoryRecallItem[]): MemoryRecallItem[] {
    if (!this.forgettingController) return items;
    const nowMs = Date.now();
    return items.map((item) => {
      if (typeof item.content !== "string" || item.content.length < 12) return item;
      const importanceFactor =
        item.importance === "critical" ? 1.0
        : item.importance === "high" ? 0.8
        : item.importance === "medium" ? 0.5
        : 0.2;
      let recencyFactor = 0.5; // 无时间戳按半新处理（保守，不轻易截断）
      if (item.timestamp) {
        const ts = Date.parse(item.timestamp);
        if (Number.isFinite(ts)) {
          const ageHours = Math.max(0, (nowMs - ts) / 3_600_000);
          recencyFactor = Math.pow(2, -ageHours / 72);
        }
      }
      const score = 0.5 * recencyFactor + 0.5 * importanceFactor;
      if (score >= 0.5) return item;
      const faded = this.forgettingController!.compactRecallText(item.content, score);
      return faded === item.content ? item : { ...item, content: faded };
    });
  }

  /**
   * 写入时在线关联分析（P0-2）：新记忆落库后，立即检索与之相关的旧记忆，
   * 让 LLM 合成"新记忆 × 旧记忆"的跨时空关联，高置信结论回灌 humanLike 图。
   *
   * 与 recall 时的 triggerAssociationSynthesis 互补：
   *   - recall 时：对"本次召回的多条记忆"做关联（消费侧联想）；
   *   - 写入时：对"新记忆与历史记忆"做关联（生产侧联想）——像人一样
   *     "刚发生的事让我想起了以前的事"，新知识即时挂接到已有知识网。
   *
   * 节流：按 actor 最小间隔（默认 45s，env MEMORY_WRITE_ASSOCIATION_INTERVAL_MS），
   * 高频写入（感官事件流）不会打爆 LLM；失败静默降级。
   */
  private triggerWriteTimeAssociation(actorId: string, newContent: string): void {
    const synthesizer = this.associationSynthesizer;
    if (!synthesizer || !synthesizer.enabled) return;
    const content = newContent.trim();
    if (content.length < 8) return; // 太短的写入（如纯符号）不值得分析

    const last = this.writeAssociationAt.get(actorId) ?? 0;
    const now = Date.now();
    if (now - last < this.writeAssociationMinIntervalMs) return;
    this.writeAssociationAt.set(actorId, now);

    void (async () => {
      try {
        // 检索与新记忆相关的旧记忆（优先 agentic 混合检索）
        let relatedText: string | null = null;
        if (this.agentic) {
          relatedText = await this.safeRecall(() =>
            this.agentic!.retrieval.buildRecall(actorId, content),
          );
        }
        const relatedItems = this.parseRecallTextToItems(relatedText ?? "", "agentic")
          .slice(0, 4)
          .map((it) => ({ content: it.content, score: it.score }));
        if (relatedItems.length < 1) return; // 没有旧记忆可关联（冷启动）

        // 新记忆放在首位参与合成
        const inputs = [{ content, score: 1 }, ...relatedItems];
        const associations = await synthesizer.synthesize(inputs, content);
        if (associations.length === 0 || !this.humanLike) return;
        for (const assoc of associations) {
          try {
            void this.humanLike.ingest(actorId, assoc.conclusion, "write_association", {
              domain: "semantic",
              metadata: {
                associated: true,
                associationConfidence: assoc.confidence,
                associationReasoning: assoc.reasoning,
                writeTimeAssociation: true,
              },
            }).catch(() => {
              /* 回灌失败静默降级 */
            });
          } catch {
            /* 单条回灌失败不影响其余 */
          }
        }
        console.log(
          `[MemoryCortex] 写入时关联分析完成: ${actorId} (新记忆关联 ${relatedItems.length} 条旧记忆, 合成 ${associations.length} 条联想)`,
        );
      } catch {
        /* 写入时关联失败静默降级 */
      }
    })();
  }

  /** 从召回记忆中异步合成跨记忆关联，高置信结论回灌 humanLike 记忆图。 */
  private triggerAssociationSynthesis(
    actorId: string,
    items: MemoryRecallItem[],
    query: string,
  ): void {
    const synthesizer = this.associationSynthesizer;
    if (!synthesizer || !synthesizer.enabled || items.length < 2) return;
    const cooldownRaw = Number(process.env.MEMORY_ASSOCIATION_SYNTH_COOLDOWN_MS);
    const cooldownMs =
      Number.isFinite(cooldownRaw) && cooldownRaw >= 0 ? cooldownRaw : 5 * 60_000;
    const lastRun = this.associationSynthLastRun.get(actorId) ?? 0;
    if (Date.now() - lastRun < cooldownMs) return;
    this.associationSynthLastRun.set(actorId, Date.now());
    // 只取前 5 条参与合成（限制 prompt 规模）
    const inputs = items
      .slice(0, 5)
      .map((it) => ({ content: it.content, score: it.score }));
    void synthesizer
      .synthesize(inputs, query)
      .then((associations) => {
        if (associations.length === 0 || !this.humanLike) return;
        for (const assoc of associations) {
          try {
            // 以「联想推测」身份回灌 humanLike 记忆图，后续轮次可被召回
            void this.humanLike.ingest(actorId, assoc.conclusion, "association", {
              domain: "semantic",
              metadata: {
                associated: true,
                associationConfidence: assoc.confidence,
                associationReasoning: assoc.reasoning,
              },
            }).catch(() => {
              /* 回灌失败静默降级 */
            });
          } catch {
            /* 单条回灌失败不影响其余 */
          }
        }
      })
      .catch(() => {
        /* 联想合成失败静默降级（不阻塞 recall） */
      });
  }

  /**
   * 从多条线索推理出新结论。
   *
   * 委托 MemoryInferenceEngine.inferFromClues；未注册时返回空结果。
   * 不调 LLM——推理是规则匹配 + 模板拼接的纯算法结果。
   *
   * @param actorId 关联 actor
   * @param clues 线索列表
   * @param emotion 情绪状态（可选，传给 emotionModulator 做情感调制）
   */
  async inferFromClues(
    actorId: string,
    clues: InferenceClue[],
    emotion?: EmotionState | null,
  ): Promise<InferenceResult> {
    const empty: InferenceResult = {
      inferences: [],
      combinedConfidence: 0,
      inferredAt: new Date().toISOString(),
    };
    if (!this.inferenceEngine) return empty;
    try {
      return await this.inferenceEngine.inferFromClues(actorId, clues, emotion);
    } catch (err) {
      console.log(`[MemoryCortex] inferFromClues 失败: ${err}`);
      return empty;
    }
  }

  /**
   * 触发规则自学习（4 项仿人推理能力扩展）。
   *
   * 委托 MemoryInferenceEngine.autoLearn；未注册推理引擎时返回空。
   * 扫描记忆图，挖掘频繁共现的关键词对，自动生成新规则并注册到引擎。
   */
  async autoLearn(actorId?: string): Promise<unknown[]> {
    if (!this.inferenceEngine) return [];
    try {
      return await this.inferenceEngine.autoLearn(actorId);
    } catch (err) {
      console.log(`[MemoryCortex] autoLearn 失败: ${err}`);
      return [];
    }
  }

  /** 获取已学习的规则（未注册推理引擎时返回空） */
  getLearnedRules(): unknown[] {
    if (!this.inferenceEngine) return [];
    return this.inferenceEngine.getLearnedRules();
  }

  /** 获取已迁移的规则（未注册推理引擎时返回空） */
  getMigratedRules(): unknown[] {
    if (!this.inferenceEngine) return [];
    return this.inferenceEngine.getMigratedRules();
  }

  /**
   * 注册突触总线。
   *
   * 注册后自动订阅 sensory.listen 事件：每当感官皮层识别到用户语音，
   * 即把识别文本作为 event 类记忆异步写入（不阻塞事件循环）。
   * fire 失败、remember 失败均静默降级，不影响事件分发链。
   */
  registerSynapseBus(svc: SynapseBusLike): void {
    this.synapseBus = svc;
    console.log("[MemoryCortex] 已注册 SynapseBus");
    // 订阅 sensory.listen 事件 → 自动记忆感知到的用户语音
    if (typeof svc.subscribeType === "function") {
      svc.subscribeType("sensory.listen", (event) => {
        try {
          const text = event.data?.text;
          if (typeof text === "string" && text.length > 0) {
            const actorId =
              (typeof event.data?.actorId === "string" && event.data.actorId) ||
              (typeof event.actorId === "string" && event.actorId) ||
              "unknown";
            // 异步 remember，不阻塞事件循环
            void this.remember(actorId, {
              actorId,
              kind: "event",
              content: text,
              timestamp: new Date().toISOString(),
            }).catch(() => {
              /* 静默 */
            });
          }
        } catch {
          /* 订阅回调异常不传播 */
        }
      });
      console.log("[MemoryCortex] 已订阅 sensory.listen → 自动记忆");
    }
  }

  // ---- 生命周期 ------------------------------------------------------------

  /** 启动记忆皮层：子系统由外部初始化后注入，这里只翻转 started 标志 */
  async start(): Promise<void> {
    if (this.started) {
      console.log("[MemoryCortex] 已启动，跳过重复 start");
      return;
    }
    console.log("[MemoryCortex] 正在启动...");
    this.started = true;
    console.log("[MemoryCortex] 启动完成");
  }

  /** 停止记忆皮层 */
  async stop(): Promise<void> {
    if (!this.started) {
      console.log("[MemoryCortex] 未启动，跳过 stop");
      return;
    }
    console.log("[MemoryCortex] 正在停止...");
    this.started = false;
    console.log("[MemoryCortex] 已停止");
  }

  // ---- 核心方法 ------------------------------------------------------------

  /**
   * 写入记忆。
   *
   * - 根据 item.domain（缺省时按 kind 推断）决定写入哪个域；
   * - 工作记忆且带 sessionId → 写短期记忆；
   * - importance=high/critical 或非工作记忆 → 写长期记忆（优先 narrative，fallback agentic）。
   * 不调用 LLM。
   */
  async remember(actorId: string, item: MemoryItem): Promise<void> {
    // 匿名身份治理：无稳定身份的写入只允许会话内短期记忆，禁止进入长期记忆共享桶（防串台）
    if (isEphemeralActorId(actorId) && (item.importance === "high" || item.importance === "critical" || (item.domain ?? inferDomain(item.kind)) !== "working")) {
      warnEphemeralActorMemoryBlocked(actorId, "长期记忆写入");
      return;
    }

    // ---- salience 统一闸门重构：降级为打分输入，不再独立否决 ----
    // 原实现 salience filter 有独立否决权（reject 直接丢弃 / decay 仅写短期），
    // 与 service 侧 decideMemoryWrite（带 LLM 复判的决策引擎）形成两套互不知情的
    // 写入标准，同一 item 在高信号路径会被两道闸门先后裁决。
    // 现在 salience 只产出分数：写入 metadata 供诊断/调参，低分条目下调写入信号档位
    // （走低信号缓冲路径），是否落库统一由 decideMemoryWrite 裁量
    // （reject 不落库 / decay 保留并由 TTL 遗忘机制回收）。
    let salienceScore: number | undefined;
    let salienceDowngraded = false;
    if (this.salienceFilter) {
      try {
        const salience = this.salienceFilter.evaluateSalience(item);
        salienceScore = salience.score;
        if (!salience.accept || salience.degraded) {
          salienceDowngraded = true;
          console.log(
            `[MemoryCortex] salience ${salience.accept ? "低分降级" : "拒绝降档"} (score=${salience.score}) → 低信号档位，最终由 decideMemoryWrite 裁量`,
          );
          // 降级条目仍进体验学习环观察（原 decay 路径行为保留）
          try {
            this.experienceLearningLoop?.observeMemoryItem(actorId, item);
          } catch {
            /* learning loop failure is non-blocking */
          }
        }
      } catch (err) {
        console.log(`[MemoryCortex] salience filter 异常（按正常信号处理）: ${err}`);
      }
    }

    const domain = item.domain ?? inferDomain(item.kind);
    const importance = item.importance ?? "medium";
    const sourceId = item.source ?? "system";
    // salience 低分条目下调为低信号档位（进低信号缓冲，由 decideMemoryWrite 最终裁量）
    const highSignal =
      !salienceDowngraded && (importance === "high" || importance === "critical");

    // 多模态记忆预处理：若携带 media.blob，先持久化到本地文件系统，
    // 在 metadata 中记录 mediaRef（storageId + kind + mime + caption）。
    // 写入失败降级为纯文本记忆（不阻塞主流程）。
    let effectiveContent = item.content;
    let effectiveMetadata = item.metadata;
    if (item.media?.blob && item.media.blob.length > 0) {
      const storageId = persistMediaBlob(actorId, item.media);
      if (storageId) {
        effectiveMetadata = {
          ...(item.metadata ?? {}),
          mediaRef: {
            storageId,
            kind: item.media.kind,
            mime: item.media.mime,
            caption: item.media.caption ?? item.content.slice(0, 100),
            origin: item.media.origin ?? "unknown",
          },
        };
        // content 补充占位符，让召回时 LLM 知道有图但当前不能直接看
        const placeholder = `[${item.media.kind === "image" ? "图片" : item.media.kind === "audio" ? "音频" : "视频"}：${item.media.caption ?? item.content.slice(0, 60)}]`;
        effectiveContent = item.content ? `${item.content}\n${placeholder}` : placeholder;
      }
    }

    // salience 分数入 metadata：检索/仲裁层可读，诊断与调参有据可查
    if (salienceScore !== undefined) {
      effectiveMetadata = { ...(effectiveMetadata ?? {}), memorySalienceScore: salienceScore };
    }

    // 降级条目沿用原 decay 路径的短期记忆同步（working 域由下方统一处理，避免重复）
    if (salienceDowngraded && item.sessionId && this.shortTerm && domain !== "working") {
      try {
        this.shortTerm.syncTaskForTurn(item.sessionId, item.content);
      } catch {
        /* 静默 */
      }
    }

    try {
      this.experienceLearningLoop?.observeMemoryItem(actorId, {
        ...item,
        actorId,
        domain,
        content: effectiveContent,
        metadata: effectiveMetadata,
      });
    } catch {
      /* learning loop failure is non-blocking */
    }

    // 写短期记忆：工作记忆且带 sessionId
    if (domain === "working" && item.sessionId && this.shortTerm) {
      try {
        this.shortTerm.syncTaskForTurn(item.sessionId, effectiveContent);
      } catch (err) {
        console.log(`[MemoryCortex] shortTerm.syncTaskForTurn 失败: ${err}`);
      }
    }

    // 写长期记忆：高信号或非工作记忆
    const shouldPersistLongTerm = highSignal || domain !== "working";
    if (!shouldPersistLongTerm) return;

    // 优先 narrative（其内部会同时写 humanLike + agentic）
    if (this.narrative) {
      try {
        await this.narrative.ingest(actorId, effectiveContent, sourceId, {
          highSignal,
          context: "main",
        });
        try {
          this.synapseBus?.fire(
            "memory.remember",
            { actorId, kind: item.kind, domain: domain ?? "unknown", hasMedia: !!item.media },
            { actorId, source: "memory" },
          );
        } catch {
          /* fire 失败不影响主流程 */
        }
        // 写入时在线关联分析（P0-2）：新记忆 × 相关旧记忆 → LLM 合成联想
        this.triggerWriteTimeAssociation(actorId, effectiveContent);
        // 图式形成（记忆建立联系）：同 sceneTag 经验达标后异步抽取公共步骤
        this.scheduleSchemaFormation(actorId, effectiveMetadata);
        // 记忆目录缓存失效（新增记忆后目录统计需要刷新）
        this.memoryInventory?.invalidate(actorId);
        return;
      } catch (err) {
        console.log(`[MemoryCortex] narrative.ingest 失败: ${err}`);
      }
    }

    // Fallback：bridge 统一写入（P0-1 旁路收拢——认知图 + Mem0 + linkage 一次完成；
    // 此前直写 agentic 的记忆没有 linkage，遗忘同步永远扫不到，成为僵尸记忆）
    if (this.bridge) {
      try {
        await this.bridge.writeUnified(actorId, sourceId, effectiveContent, {
          context: "main",
          highSignal,
        });
        try {
          this.synapseBus?.fire(
            "memory.remember",
            { actorId, kind: item.kind, domain: domain ?? "unknown", hasMedia: !!item.media },
            { actorId, source: "memory" },
          );
        } catch {
          /* fire 失败不影响主流程 */
        }
        this.triggerWriteTimeAssociation(actorId, effectiveContent);
        this.scheduleSchemaFormation(actorId, effectiveMetadata);
        this.memoryInventory?.invalidate(actorId);
        return;
      } catch (err) {
        console.log(`[MemoryCortex] bridge.writeUnified 失败: ${err}`);
      }
    }

    // Fallback：直接写 agentic（无 bridge 时的旧行为）
    if (this.agentic) {
      try {
        await this.agentic.ingest.ingestText(actorId, sourceId, effectiveContent, {
          highSignal,
          context: "main",
        });
        try {
          this.synapseBus?.fire(
            "memory.remember",
            { actorId, kind: item.kind, domain: domain ?? "unknown", hasMedia: !!item.media },
            { actorId, source: "memory" },
          );
        } catch {
          /* fire 失败不影响主流程 */
        }
        // 写入时在线关联分析（同 narrative 路径）
        this.triggerWriteTimeAssociation(actorId, effectiveContent);
        this.scheduleSchemaFormation(actorId, effectiveMetadata);
        this.memoryInventory?.invalidate(actorId);
      } catch (err) {
        console.log(`[MemoryCortex] agentic.ingest.ingestText 失败: ${err}`);
      }
    }
  }

  /**
   * 单域召回。
   *
   * 根据 opts.domain 路由：
   * - working → 短期记忆（按 sessionId 索引；recall 入参无 sessionId，返回空）
   * - narrative → narrative.buildNarrativeRecall
   * - episodic / semantic / procedural / emotional → 优先海马体，fallback agentic.retrieval
   * - 默认（未指定 domain）：降级链 agentic → narrative → kvSummary
   */
  async recall(
    actorId: string,
    query: string,
    opts?: {
      domain?: MemoryDomainKind;
      limit?: number;
      sessionId?: string;
      /** 是否包含 sensitivity=restricted 的受限记忆，默认 false（restricted 不进 prompt 路径） */
      includeRestricted?: boolean;
      /**
       * 多意图并行召回（P2-2）：RecallQueryExpander 拆分出的子 query 列表
       * （含主 query）。默认路径会并行检索各通道，合并去重后统一仲裁，
       * 避免"A 和 B 对比"类 query 的 embedding 被两个主题平均稀释。
       */
      subQueries?: string[];
    },
  ): Promise<MemoryRecallResult> {
    const domain = opts?.domain;
    const now = new Date().toISOString();

    try {
      this.synapseBus?.fire(
        "memory.recall",
        { actorId, query, domain: opts?.domain ?? "default" },
        { actorId, source: "memory" },
      );
    } catch {
      /* fire 失败不影响主流程 */
    }

    // 工作记忆 → 短期记忆（需 sessionId 索引）
    if (domain === "working") {
      const sessionId = opts?.sessionId ?? actorId; // 无 sessionId 时用 actorId 兜底
      if (!this.shortTerm) {
        console.log("[MemoryCortex] recall(working): ShortTermMemory 未注册，返回空");
      } else {
        try {
          const taskState = this.shortTerm.getTaskState(sessionId);
          const items: Array<{ content: string; domain: MemoryDomainKind; timestamp?: string; score?: number }> = [];
          // 活跃任务上下文
          if (taskState.activeTaskId) {
            const active = taskState.tasks.find((t) => t.taskId === taskState.activeTaskId);
            if (active) {
              items.push({
                content: `当前任务: ${active.title}（${active.contextSummary}）`,
                domain: "working",
                timestamp: active.updatedAt,
              });
            }
          }
          // 会话记忆（主题/使命/待办等）
          const conv = taskState.conversationMemory;
          if (conv) {
            if (conv.activeTopic) items.push({ content: `当前话题: ${conv.activeTopic}`, domain: "working" });
            if (conv.currentMission) items.push({ content: `当前使命: ${conv.currentMission}`, domain: "working" });
            for (const loop of conv.openLoops.slice(0, 3)) {
              items.push({ content: `待办: ${loop}`, domain: "working" });
            }
          }
          return {
            actorId,
            query,
            items: await this.finalizeRecallItems(actorId, query, items, opts),
            domain: "working",
            mode: "single_domain",
            recalledAt: now,
          };
        } catch (err) {
          console.log(`[MemoryCortex] recall(working) 失败: ${err}`);
        }
      }
      return {
        actorId,
        query,
        items: [],
        domain: "working",
        mode: "single_domain",
        recalledAt: now,
      };
    }

    // 匿名身份治理：工作记忆（按 sessionId 隔离）已放行，其余长期记忆通道全部拦截——
    // anonymous 共享桶里的历史数据本身就是跨请求串台源，读取与写入一并禁止。
    if (isEphemeralActorId(actorId)) {
      warnEphemeralActorMemoryBlocked(actorId, "长期记忆读取");
      return {
        actorId,
        query,
        items: [],
        domain: "semantic",
        mode: "single_domain",
        recalledAt: now,
      };
    }

    // 叙事记忆 → narrative.buildNarrativeRecall
    if (domain === "narrative") {
      const text = this.narrative
        ? (await this.safeRecall(() => this.narrative!.buildNarrativeRecall(actorId, query))) ?? ""
        : "";
      return {
        actorId,
        query,
        items: await this.finalizeRecallItems(
          actorId,
          query,
          this.textToRecallItems(text, "narrative"),
          opts,
        ),
        domain: "narrative",
        mode: "single_domain",
        recalledAt: now,
      };
    }

    // 关系记忆 → RelationshipGraphService（Phase 1.2）
    if (domain === "relationship") {
      if (this.relationshipGraph) {
        const summary = await this.safeRecall(() =>
          this.relationshipGraph!.getRelationshipSummary(actorId),
        );
        return {
          actorId,
          query,
          items: await this.finalizeRecallItems(
            actorId,
            query,
            summary ? this.textToRecallItems(summary, "relationship") : [],
            opts,
          ),
          domain: "relationship",
          mode: "single_domain",
          recalledAt: now,
        };
      }
      return {
        actorId,
        query,
        items: [],
        domain: "relationship",
        mode: "single_domain",
        recalledAt: now,
      };
    }

    // episodic / semantic / procedural / emotional → bridge 融合 > 海马体 > agentic
    if (domain) {
      // P1-7：bridge 存在时单次融合召回（Mem0 × 认知图 RRF + 跨通道去重），
      // 不再对两路各自检索后由仲裁器做重复融合
      if (this.bridge) {
        const fused =
          (await this.safeRecall(() =>
            this.bridge!.searchFused(actorId, query, { context: "main", topK: opts?.limit }),
          )) ?? [];
        this.triggerReawakenForFadedHits(actorId, {
          recalledNodeIds: fused.map((f) => f.graphNodeId).filter((v): v is string => Boolean(v)),
        });
        return {
          actorId,
          query,
          items: await this.finalizeRecallItems(
            actorId,
            query,
            this.fusedCandidatesToItems(fused, domain),
            opts,
          ),
          domain,
          mode: "single_domain",
          recalledAt: now,
        };
      }
      if (this.humanLike) {
        const result = await this.safeRecall(() =>
          this.humanLike!.buildRecall(actorId, query, {
            context: "main",
            crossDomain: false,
            detailLevel: "summary",
            limit: opts?.limit,
          }),
        );
        this.triggerReawakenForFadedHits(actorId, result);
        return {
          actorId,
          query,
          items: await this.finalizeRecallItems(
            actorId,
            query,
            this.humanLikeResultToItems(result, domain),
            opts,
          ),
          domain,
          mode: "single_domain",
          recalledAt: now,
        };
      }
      if (this.agentic) {
        const candidates =
          (await this.safeRecall(() =>
            this.agentic!.retrieval.searchStructured(actorId, query),
          )) ?? [];
        return {
          actorId,
          query,
          items: await this.finalizeRecallItems(
            actorId,
            query,
            this.agenticCandidatesToItems(candidates, domain),
            opts,
          ),
          domain,
          mode: "single_domain",
          recalledAt: now,
        };
      }
      // 既无 humanLike 也无 agentic：返回空
      return {
        actorId,
        query,
        items: [],
        domain,
        mode: "single_domain",
        recalledAt: now,
      };
    }

    // 默认（未指定 domain）：agentic 主通道 + 多通道并行仲裁
    // 改造前：降级链 agentic → narrative → kvSummary（同一时刻只用一条通道，分数丢失、无法跨通道融合）
    // 改造后：agentic 充足且高分时短路返回（低延迟）；不足时并行 narrative + kvSummary，
    //         三通道结果交 MemoryArbitrator 做归一化 + 跨通道指纹去重 + 综合重排。
    let mergedItems: MemoryRecallItem[] = [];
    /** 仲裁阶段已应用强度加成时为 true（finalize 收尾跳过二次强度重排） */
    let strengthBoostApplied = false;

    /**
     * 多意图（subQuery）并行召回的跨列表 RRF 融合（P2-3）：
     * 同一记忆被多个子查询 rank 命中时按共识上浮（cap 0.35），替代旧的
     * 「同内容取最高分」合并——后者感知不到跨子查询的 rank 一致性。
     * 输出分数保持 0-1 语义（短路判断与仲裁归一化的输入依赖它）。
     */
    const fuseSubQueryLists = (lists: MemoryRecallItem[][]): MemoryRecallItem[] =>
      fuseRankLists(lists, {
        keyOf: (item) => (typeof item.content === "string" ? item.content.trim().slice(0, 64) : ""),
        scoreOf: (item) => item.score ?? 0,
      }).map((e) => ({ ...e.item, score: Number(e.consensusScore.toFixed(4)) }));

    // 1) agentic 主通道：结构化召回（带原始时间戳，时间衰减统一交仲裁器按 domain τ 施加）。
    //    此前走「格式化文本 → 正则解析」往返，时间戳粒度退化且检索层多扣一次全局半衰期。
    //    P2-2 多意图并行召回：subQueries 存在时对每个子 query 并行检索，
    //    fuseRankLists 做 RRF 共识融合，单一 query 时保持原逻辑（单列表融合=恒等）。
    let agenticItems: MemoryRecallItem[] = [];
    if (this.bridge) {
      // P1-7 统一召回：bridge 融合（Mem0×认知图×FTS RRF + 跨通道去重）作为单一候选源。
      // 此前 agentic 通道查 Mem0、narrative 通道再取一遍融合文本，同源内容双重计入。
      const subQueries = (opts?.subQueries ?? [query])
        .map((q) => (q ?? "").trim())
        .filter((q) => q.length > 0 && q !== query)
        .slice(0, 3);
      const allQueries = [query, ...subQueries];
      const candidateLists = await Promise.all(
        allQueries.map((q) =>
          this.safeRecall(() => this.bridge!.searchFused(actorId, q, { context: "main" })),
        ),
      );
      agenticItems = fuseSubQueryLists(
        candidateLists.map((candidates) => this.fusedCandidatesToItems(candidates ?? [])),
      );
    } else if (this.agentic) {
      const subQueries = (opts?.subQueries ?? [query])
        .map((q) => (q ?? "").trim())
        .filter((q) => q.length > 0 && q !== query)
        .slice(0, 3);
      const allQueries = [query, ...subQueries];
      const candidateLists = await Promise.all(
        allQueries.map((q) =>
          this.safeRecall(() => this.agentic!.retrieval.searchStructured(actorId, q)),
        ),
      );
      agenticItems = fuseSubQueryLists(
        candidateLists.map((candidates) => this.agenticCandidatesToItems(candidates ?? [])),
      );
    }

    // 2) 短路判断：仅在显式禁用仲裁时保留旧低延迟路径。
    // agentic 即使高分也可能缺少叙事/KV/图关联佐证；默认进入仲裁，提高连续召回准确率。
    const shortCircuit =
      !this.arbitratorConfig.enabled &&
      shouldShortCircuitAgentic(agenticItems, { minCount: 3, minTopScore: 0.6 });

    // 3) 统一收集候选通道：agentic 主通道 + narrative / kvSummary / association /
    //    relationship / experienceLearning / forgotten。
    //    此前 relationship / experienceLearning / forgotten 挂在仲裁之后直接「拼接」，
    //    绕过了归一化、跨通道指纹去重、domain 配额与 minScore 阈值（读侧未收敛）；
    //    现统一作为通道交仲裁器融合，读侧与写侧一样收敛到单一出口。
    const channels: ChannelRecallResult[] = [];
    if (agenticItems.length > 0) {
      channels.push({ channel: "agentic", items: agenticItems });
    }

    // 生活模型通道（第 ④ 层建模）：用户问句命中的人/宠物/组织实体及其关系边。
    // 确定性建模来源，与其余通道同走仲裁（归一化/去重/配权重排），不新增旁路。
    const lifeModelItems = this.buildLifeModelRecallItems(actorId, query);
    if (lifeModelItems.length > 0) {
      channels.push({ channel: "lifeModel", items: lifeModelItems });
    }

    // forgotten 仅在主通道稀疏（<3 条）时主动补（语义检索归档），避免每轮扫归档。
    const sparseMainRecall = agenticItems.length < 3;
    const learningPromise = (async (): Promise<MemoryRecallItem[]> => {
      if (!this.experienceLearningLoop) return [];
      try {
        return this.experienceLearningLoop.recallLearningContext(
          actorId,
          query,
          Math.max(1, Math.min(3, opts?.limit ?? 3)),
        );
      } catch (err) {
        console.log(`[MemoryCortex] experienceLearningLoop recall failed: ${err}`);
        return [];
      }
    })();

    const [narrativeText, kvSummaryText, associationItems, relSummary, learningItems, forgottenHits] =
      await Promise.all([
        // bridge 存在时 narrative 文本与融合候选同源（Mem0+图），跳过避免重复计入
        this.narrative && !this.bridge
          ? this.safeRecall(() => this.narrative!.buildNarrativeRecall(actorId, query))
          : Promise.resolve<string | null>(null),
        this.kvSummary ? this.safeKvSnapshot(actorId) : Promise.resolve<string | null>(null),
        this.buildAssociationRecallItems(actorId, query),
        // relationship：与 query 无关的环境性关系摘要（单条通道 → 归一化保留原始分，
        // 不会被 min-max 抬升），统一纳入仲裁参与去重/配额/阈值。
        this.relationshipGraph
          ? this.safeRecall(() => this.relationshipGraph!.getRelationshipSummary(actorId))
          : Promise.resolve<string | null>(null),
        learningPromise,
        sparseMainRecall && this.kvSummary && this.memoryManager?.recallForgottenSemantic
          ? this.safeRecall(() => this.memoryManager!.recallForgottenSemantic!(actorId, query))
          : Promise.resolve<string[] | null>(null),
      ]);

    if (narrativeText) {
      const narrativeItems = this.parseRecallTextToItems(narrativeText, "narrative");
      if (narrativeItems.length > 0) {
        channels.push({ channel: "narrative", items: narrativeItems });
      }
    }

    if (kvSummaryText) {
      // P0 修复：不再用召回时刻冒充记忆发生时间（旧实现 timestamp: now 是假时间元数据）；
      // kvSummary 通道无逐条时间，留空让仲裁器走"无时间信息"折中路径。
      channels.push({
        channel: "kvSummary",
        items: [
          {
            content: kvSummaryText,
            domain: "semantic" as MemoryDomainKind,
            source: "kv_summary",
            score: 0.5,
          },
        ],
      });
    }

    if (associationItems.length > 0) {
      channels.push({ channel: "association", items: associationItems });
    }

    if (relSummary) {
      const relItems = this.textToRecallItems(relSummary, "relationship").slice(0, 2);
      if (relItems.length > 0) {
        channels.push({ channel: "relationship", items: relItems });
      }
    }

    if (learningItems.length > 0) {
      channels.push({ channel: "experienceLearning", items: learningItems });
    }

    if (forgottenHits && forgottenHits.length > 0) {
      // 命中即异步恢复（把行从 forgotten 移回 memory_summary），不阻塞当前 recall
      void this.memoryManager?.restoreForgottenLines?.(actorId, forgottenHits).catch(() => {});
      const forgottenItems = this.textToRecallItems(forgottenHits.join("\n"), "semantic");
      if (forgottenItems.length > 0) {
        channels.push({ channel: "forgotten", items: forgottenItems });
      }
    }

    if (shortCircuit) {
      // 仲裁关闭（MEMORY_ARBITRATOR_ENABLED=0 的降级模式）：各通道直接拼接，
      // 不做归一化/跨通道去重/配额（与关闭仲裁的旧行为一致）。
      mergedItems = channels.flatMap((ch) => ch.items);
    } else if (channels.length > 0) {
      // 4) 统一仲裁：通道内归一化 + 跨通道指纹去重 + 通道权重综合重排
      //    （传入原始 query 供防串台一致性调制；时间衰减按条目 timestamp 计算）
      // 强度模型作为一等因子参与统一排序：原实现在仲裁后由 finalizeRecallItems
      // 二次按强度重排，会破坏仲裁器的 domain 配额多样性保证（两次排序互相覆盖）。
      const strengthBoost = this.buildStrengthBoostMap(actorId, channels);
      mergedItems = arbitrateMemories(channels, this.arbitratorConfig, { query, strengthBoost });
      strengthBoostApplied = strengthBoost !== undefined;

      // 5) 仲裁降级：仲裁无结果但 agentic 有结果时回退（保护可用性）
      if (mergedItems.length === 0 && agenticItems.length > 0) {
        mergedItems = agenticItems;
      }
    }

    // （relationship / experienceLearning / forgotten 三段「仲裁后直接拼接」的旁路已移除：
    //   三条通道现作为 ChannelRecallResult 在上方统一并入 arbitrateMemories。）

    // ---- 联想扩散并入当轮仲裁（当轮关联）----
    // 旧实现 spread 是 fire-and-forget，扩散结果只影响未来轮次，本轮"提到 A 想起 B"缺失。
    // 现在 await（内存图遍历，无 LLM，延迟可控），把扩散命中的 2 度节点作为
    // 联想候选并入 mergedItems，一起走敏感过滤/反馈加成/去重/限长与引用锚点记录。
    // P0-3 语义化联想种子：用 humanLike.findNodeIdsByContent 反查真实节点 ID；
    // 反查不可用（无真实种子）时直接跳过，不做无副作用的假 ID 扩散。
    // 扩散后的探索触发（知识缺口）保持 fire-and-forget。
    // recall 命中 downranked/cold 节点的再唤醒反弹由 triggerReawakenForFadedHits
    // 在 buildRecall 返回后触发（遗忘控制器 Phase 2 接线）；BrainStem 45s 心跳 →
    // forgettingController.continuousScore 负责反方向的衰减/剪枝（见 Phase 4 装配）。
    if (this.associativeGraph && this.humanLike && mergedItems.length > 0) {
      try {
        const seedNodeIds =
          this.humanLike.findNodeIdsByContent?.(
            actorId,
            mergedItems.slice(0, 3).map((it) => it.content),
            1,
          ) ?? [];
        if (seedNodeIds.length > 0) {
          const spreadResult = await this.associativeGraph.spread(actorId, seedNodeIds);
          void this.associativeGraph
            .triggerExplorationIfNeeded(actorId, spreadResult, query)
            .catch(() => {
              /* 静默 */
            });

          const activated = spreadResult.activatedNodes
            .filter((n) => !seedNodeIds.includes(n.nodeId) && n.activationValue > 0)
            .sort((a, b) => b.activationValue - a.activationValue)
            .slice(0, 2);
          const summaries =
            this.humanLike.getNodeSummariesByIds?.(
              actorId,
              activated.map((n) => n.nodeId),
              2,
            ) ?? [];
          const activationById = new Map(activated.map((n) => [n.nodeId, n.activationValue]));
          const existing = new Set(mergedItems.map((it) => (it.content ?? "").trim()));
          for (const s of summaries) {
            const content = `联想记忆: ${s.summary}`;
            if (!s.summary || existing.has(content)) continue;
            existing.add(content);
            mergedItems.push({
              content,
              domain: "semantic",
              source: "association",
              score: clamp01(0.3 + 0.2 * (activationById.get(s.id) ?? 0)),
            });
          }
        }
      } catch (err) {
        console.log(`[MemoryCortex] 联想扩散并入当轮召回失败（忽略）: ${err}`);
      }
    }

    // 统一召回收尾：敏感过滤 → 反馈加成/惩罚重排 → 去重限长，
    // 并异步触发记忆联想合成 + 引用锚点记录（与分域召回共用同一收尾，见 finalizeRecallItems）。
    // 仲裁路径已把强度并入统一排序，此处跳过二次强度重排，避免破坏 domain 配额。
    const feedbackAdjustedItems = await this.finalizeRecallItems(actorId, query, mergedItems, {
      ...opts,
      skipStrengthBoost: strengthBoostApplied,
    });

    const finalResult: MemoryRecallResult = {
      actorId,
      query,
      items: feedbackAdjustedItems,
      domain: "semantic",
      mode: "single_domain",
      recalledAt: now,
    };

    // ---- 推理引擎：recall 命中 ≥ 2 条时异步触发多线索交叉推理 ----
    // 把召回的前 3 条记忆作为"memory_recalled"线索喂给推理引擎，
    // 若能匹配规则则生成新结论（不阻塞主召回，失败静默降级）。
    if (this.inferenceEngine && finalResult.items.length >= 2) {
      const clues: InferenceClue[] = finalResult.items
        .slice(0, 3)
        .map((it) => ({ text: it.content, source: "memory_recalled" as const }));
      void this.inferenceEngine.inferFromClues(actorId, clues).catch(() => {
        /* 静默 */
      });
    }

    // 图式提示（记忆建立联系）：query 命中已抽取图式时附加背景联想（仅建议）
    return this.attachSchemaHint(actorId, query, finalResult);
  }

  /**
   * 向量预筛已于 v3 读路径改造中退役（每轮 embedding 调用既慢又把召回权从模型手里收走）。
   * 历史方法 semanticRecallPreScreen 已删除：长期注入现只走恒驻速览 + brain.recall 工具。
   */
  async recordLearningFeedback(feedback: LearningFeedback): Promise<LearningSnapshot | null> {
    if (!this.experienceLearningLoop) return null;
    try {
      this.experienceLearningLoop.recordFeedback(feedback);
      return this.experienceLearningLoop.getSnapshot(feedback.actorId);
    } catch (err) {
      console.log(`[MemoryCortex] recordLearningFeedback failed: ${err}`);
      return null;
    }
  }

  /**
   * 记忆相关性在线反馈回灌入口：
   * - 反馈按语义指纹记录到统一记忆强度模型（KV 持久化）；
   * - 同时回灌到 humanLike 记忆节点（更新 userFeedbackScore，修复该字段此前固定为 1 的问题）；
   * - 后续 recall 会对命中条目做加成/惩罚调整排序（见 applyFeedbackBoost）。
   */
  recordMemoryFeedback(input: MemoryFeedbackInput): void {
    const strengthModel = this.getStrengthModel();
    if (!strengthModel) return;
    try {
      const record = strengthModel.recordFeedback(input);
      // 回灌 humanLike 节点：负反馈时把 userFeedbackScore 同步到反馈分数
      if (record && this.humanLike?.applyUserFeedback) {
        try {
          this.humanLike.applyUserFeedback(input.actorId, input.content, clamp01(record.score));
        } catch {
          /* 节点回灌失败不影响反馈记录 */
        }
      }
    } catch (err) {
      console.log(`[MemoryCortex] recordMemoryFeedback failed: ${err}`);
    }
  }

  /** 读取某 actor 的反馈/强度快照（调试/统计用）。 */
  getMemoryFeedbackSnapshot(actorId: string): unknown {
    return this.getStrengthModel()?.snapshot(actorId) ?? null;
  }

  /**
   * 跨会话开放环路：记录本轮对话提取的 open loops / 承诺 / 偏好。
   * 由 brain-center 在 cognize 记忆写入阶段异步调用；KV 未注册时静默降级。
   * 本轮检测到 open loop 完成时，逐条回调 epitomeLoopClosedListener（fire-and-forget）。
   */
  updateSessionEpitome(actorId: string, entries: SessionEpitomeEntries, turnText?: string): void {
    const store = this.getEpitomeStore();
    if (!store) return;
    try {
      const { closedLoops } = store.record(actorId, entries, { turnText });
      if (closedLoops.length > 0 && this.epitomeLoopClosedListener) {
        for (const loopText of closedLoops) {
          try {
            this.epitomeLoopClosedListener(actorId, loopText);
          } catch {
            /* 监听器失败不影响主链路 */
          }
        }
      }
    } catch (err) {
      console.log(`[MemoryCortex] updateSessionEpitome failed: ${err}`);
    }
  }

  /** 注入 open loop 完成监听器（装配层：hub.onUserLoopCompleted）。 */
  setEpitomeLoopClosedListener(listener: ((actorId: string, loopText: string) => void) | null): void {
    this.epitomeLoopClosedListener = listener;
  }

  /** 读取某 actor 的跨会话开放环路快照（供新会话开场注入）。 */
  getSessionEpitome(actorId: string): SessionEpitomeSnapshot | null {
    return this.getEpitomeStore()?.get(actorId) ?? null;
  }

  /** 读取某 actor 的最近召回锚点（连续性诊断用）。 */
  getRecallAnchors(actorId: string): RecallAnchorRecord[] {
    return this.getAnchorStore()?.get(actorId) ?? [];
  }

  /**
   * 懒初始化引用锚点存储：绑定 kvSummary 作为持久化适配器。
   * kvSummary 未注册时返回 null（静默降级）。
   */
  private getAnchorStore(): RecallAnchorStore | null {
    if (!this.kvSummary) return null;
    if (!this.anchorStore) {
      this.anchorStore = new RecallAnchorStore({
        getSnapshot: (actorId, keys) => {
          try {
            return this.kvSummary!.getSnapshot(actorId, keys);
          } catch {
            return null;
          }
        },
        setEntry: (actorId, key, value) => {
          try {
            this.kvSummary!.setEntry?.(actorId, key, value);
          } catch {
            /* 持久化失败静默降级 */
          }
        },
      });
    }
    return this.anchorStore;
  }

  /**
   * 懒初始化跨会话开放环路存储：绑定 kvSummary 作为持久化适配器。
   * kvSummary 未注册时返回 null（静默降级，不影响对话主链路）。
   */
  private getEpitomeStore(): SessionEpitomeStore | null {
    if (!this.kvSummary) return null;
    if (!this.epitomeStore) {
      this.epitomeStore = new SessionEpitomeStore({
        getSnapshot: (actorId, keys) => {
          try {
            return this.kvSummary!.getSnapshot(actorId, keys);
          } catch {
            return null;
          }
        },
        setEntry: (actorId, key, value) => {
          try {
            this.kvSummary!.setEntry?.(actorId, key, value);
          } catch {
            /* 持久化失败静默降级 */
          }
        },
      });
    }
    return this.epitomeStore;
  }

  /**
   * 懒初始化统一记忆强度模型：绑定 kvSummary 作为持久化适配器。
   * kvSummary 未注册时返回 null（反馈记录、命中强化与召回加成静默降级，不影响主链路）。
   */
  private getStrengthModel(): MemoryStrengthModel | null {
    if (!this.kvSummary) return null;
    if (!this.strengthModel) {
      this.strengthModel = new MemoryStrengthModel({
        getSnapshot: (actorId, keys) => {
          try {
            return this.kvSummary!.getSnapshot(actorId, keys);
          } catch {
            return null;
          }
        },
        setEntry: (actorId, key, value) => {
          try {
            this.kvSummary!.setEntry?.(actorId, key, value);
          } catch {
            /* 持久化失败静默降级 */
          }
        },
      });
    }
    return this.strengthModel;
  }

  /**
   * 统一记忆强度加成：对召回条目按语义指纹查"反馈分 + 命中 + 遗忘曲线"
   * 算出的总倍率，调整 score 并重新排序。无调整返回原数组（保持顺序），避免无谓开销。
   */
  private applyFeedbackBoost(
    items: MemoryRecallItem[],
    actorId: string,
  ): MemoryRecallItem[] {
    if (items.length === 0) return items;
    const strengthModel = this.getStrengthModel();
    if (!strengthModel) return items;

    const boosted: Array<{ item: MemoryRecallItem; adjusted: number; changed: boolean }> = [];
    for (const item of items) {
      const content = typeof item.content === "string" ? item.content : "";
      if (!content) {
        boosted.push({ item, adjusted: item.score ?? 0.5, changed: false });
        continue;
      }
      const factor = strengthModel.boostFactor(actorId, content);
      if (factor === 1) {
        boosted.push({ item, adjusted: item.score ?? 0.5, changed: false });
        continue;
      }
      const original = item.score ?? 0.5;
      const adjusted = clamp01(original * factor);
      boosted.push({
        item: { ...item, score: adjusted },
        adjusted,
        changed: Math.abs(adjusted - original) > 0.0001,
      });
    }

    const hasAdjustment = boosted.some((b) => b.changed);
    if (!hasAdjustment) return items;

    // 按调整后分数稳定重排（同分保持原相对顺序）
    return boosted
      .map((b, idx) => ({ ...b, idx }))
      .sort((a, b) => b.adjusted - a.adjusted || a.idx - b.idx)
      .map((b) => b.item);
  }

  /**
   * 构建语义指纹 → 强度倍率映射，供仲裁器把强度模型作为一等排序因子参与统一排序。
   * 无强度模型 / 所有条目倍率均为 1 时返回 undefined（仲裁器按无加成处理）。
   * 指纹键与仲裁器内部去重键一致：semanticFingerprint(content) || content.slice(0, 48)。
   */
  private buildStrengthBoostMap(
    actorId: string,
    channels: ChannelRecallResult[],
  ): Map<string, number> | undefined {
    const strengthModel = this.getStrengthModel();
    if (!strengthModel) return undefined;

    const map = new Map<string, number>();
    for (const ch of channels) {
      for (const item of ch.items) {
        const content = typeof item.content === "string" ? item.content.trim() : "";
        if (!content) continue;
        const factor = strengthModel.boostFactor(actorId, content);
        if (factor === 1) continue;
        const fp = semanticFingerprint(content) || content.slice(0, 48);
        const prev = map.get(fp);
        if (prev === undefined || factor > prev) map.set(fp, factor);
      }
    }
    return map.size > 0 ? map : undefined;
  }

  private async buildAssociationRecallItems(
    actorId: string,
    query: string,
  ): Promise<MemoryRecallItem[]> {
    if (!this.associativeGraph) return [];
    try {
      const predicted = await this.associativeGraph.predictAssociation(actorId, query);
      const items: MemoryRecallItem[] = [];
      if (predicted.predictedOutcome.trim()) {
        items.push({
          content: `联想记忆: ${predicted.predictedOutcome.trim()}`,
          domain: "semantic",
          source: "association",
          score: clamp01(predicted.confidence || 0.45),
        });
      }
      for (const nodeId of predicted.activatedNodes.slice(0, 3)) {
        if (!nodeId) continue;
        items.push({
          content: `关联节点: ${nodeId}`,
          domain: "semantic",
          source: "association",
          score: clamp01(predicted.confidence || 0.35),
        });
      }
      return items;
    } catch (err) {
      console.log(`[MemoryCortex] association recall failed: ${err}`);
      return [];
    }
  }

  private dedupeAndLimitRecallItems(
    items: MemoryRecallItem[],
    limit: number,
  ): MemoryRecallItem[] {
    const seen = new Set<string>();
    const kept: MemoryRecallItem[] = [];
    for (const item of items) {
      const content = typeof item.content === "string" ? item.content.trim() : "";
      if (!content) continue;
      const fp = createHash("sha1").update(content.toLowerCase()).digest("hex");
      if (seen.has(fp)) continue;
      seen.add(fp);
      kept.push({ ...item, content });
      if (kept.length >= limit) break;
    }
    return kept;
  }

  /**
   * 统一召回收尾：敏感过滤 → 反馈加成重排 → 精排（可选）→ 去重限长，并异步触发
   * 「记忆联想合成」与「引用锚点记录」两个后置副作用。
   *
   * 默认路径、分域路径与 recallCrossDomain 全部复用本方法，保证：
   * - 反馈在线学习（纠错/点赞/点踩加成）覆盖所有召回入口；
   * - 连续性诊断（最近注入了什么锚点）覆盖所有召回入口；
   * - LLM 跨记忆联想闭环覆盖所有召回入口；
   * - P1 精排（Cross-Encoder/LLM rerank）单点覆盖所有召回入口。
   */
  private async finalizeRecallItems(
    actorId: string,
    query: string,
    items: MemoryRecallItem[],
    opts?: { includeRestricted?: boolean; limit?: number; skipStrengthBoost?: boolean },
  ): Promise<MemoryRecallItem[]> {
    const limit = Math.max(1, opts?.limit ?? this.arbitratorConfig.topN);
    const filtered = this.filterBySensitivity(items, opts?.includeRestricted);
    // 仲裁路径（skipStrengthBoost=true）已在统一排序中应用强度因子，此处跳过，
    // 避免仲裁后二次重排；分域/短路等未走仲裁的路径仍保留强度重排。
    const boosted = opts?.skipStrengthBoost
      ? filtered
      : this.applyFeedbackBoost(filtered, actorId);
    // P1 精排：对候选做 (query, memory) 联合打分并按 relevance 重排/闸弃
    // （AGENT_MEMORY_RERANKER，默认 off）。关闭/超时/失败返回 null → 原序透传。
    const reranked = await this.rerankRecallItems(query, boosted);
    const deduped = this.dedupeAndLimitRecallItems(reranked ?? boosted, limit);
    // 遗忘梯度（该忘的退得掉）：低遗忘分条目按梯度截断——褪色的记忆以残缺形式被想起。
    // 在去重限长之后、联想合成之前应用，避免截断文本被当作合成输入污染。
    const finalItems = this.applyForgettingGradient(deduped);

    // 记忆联想性增强：命中 ≥ 2 条时异步用 LLM 合成跨记忆新关联（高置信回灌 humanLike 图）
    if (finalItems.length >= 2) {
      this.triggerAssociationSynthesis(actorId, finalItems, query);
    }

    // 引用锚点记录（记忆连续性诊断）：记录本轮注入的记忆锚点
    try {
      const anchorStore = this.getAnchorStore();
      if (anchorStore && finalItems.length > 0) {
        anchorStore.record(
          actorId,
          query,
          finalItems.map((it) => ({
            content: typeof it.content === "string" ? it.content : "",
            score: it.score,
            source: it.source,
          })),
        );
      }
    } catch {
      /* 锚点记录失败静默降级 */
    }

    // 间隔重复强化（统一强度模型）：本轮注入的条目按指纹累加计数并刷新遗忘时间，
    // 高频命中记忆后续召回加成更大、衰减更慢（越常用记得越久）。
    try {
      const strengthModel = this.getStrengthModel();
      if (strengthModel && finalItems.length > 0) {
        strengthModel.recordHits(
          actorId,
          finalItems.map((it) => (typeof it.content === "string" ? it.content : "")),
        );
      }
    } catch {
      /* 强化计数失败静默降级 */
    }

    return finalItems;
  }

  /**
   * 精排（P1，AGENT_MEMORY_RERANKER=off|llm|api）：取融合排序头部候选拼池，
   * 用 rerankTexts 做 (query, memory) 联合打分（Cross-Encoder 语义 / LLM listwise），
   * relevance 直接作为注入分重排；低于 minScore 的条目丢弃（「召回后验证」闸，
   * 挡语义分虚高但与当前问题无关的串台记忆）。
   * 任何不可用（关闭/超时/失败/单条以下）返回 null，调用方透传原序——
   * 精排是增强，绝不阻塞召回主链路。
   */
  private async rerankRecallItems(
    query: string,
    items: MemoryRecallItem[],
  ): Promise<MemoryRecallItem[] | null> {
    if (getMemoryRerankerMode() === "off" || items.length < 2 || !query.trim()) return null;
    const poolSize = Math.min(items.length, getMemoryRerankerCandidates());
    const pool = items.slice(0, poolSize);
    const rest = items.slice(poolSize);
    const scored = await rerankTexts(
      query,
      pool.map((item) => (typeof item.content === "string" ? item.content : "")),
    );
    if (!scored) return null;
    const relevanceOf = new Map(scored.map((s) => [s.index, s.relevance]));
    const minScore = getMemoryRerankerMinScore();
    const rerankedPool = pool
      .map((item, i) => ({ item, relevance: relevanceOf.get(i) ?? 0 }))
      .filter(({ relevance }) => relevance >= minScore)
      .sort((a, b) => b.relevance - a.relevance)
      .map(({ item, relevance }) => ({ ...item, score: Number(relevance.toFixed(4)) }));
    // 精排把候选全部闸弃时不强行清空（可用性保护，回退原序）
    if (rerankedPool.length === 0) return null;
    return [...rerankedPool, ...rest];
  }

  async rememberBatch(actorId: string, items: MemoryItem[]): Promise<void> {
    for (const item of items) {
      try {
        await this.remember(actorId, item);
      } catch (err) {
        console.log(`[MemoryCortex] rememberBatch item failed: ${err}`);
      }
    }
  }

  getLearningSnapshot(actorId: string): LearningSnapshot | null {
    if (!this.experienceLearningLoop) return null;
    try {
      return this.experienceLearningLoop.getSnapshot(actorId);
    } catch (err) {
      console.log(`[MemoryCortex] getLearningSnapshot failed: ${err}`);
      return null;
    }
  }

  /**
   * 跨域召回。
   *
   * 优先委托 humanLike 的 cross-domain recall（海马体多域图谱遍历）；
   * 若未注册，fallback 到 narrative.buildCrossContextRecall；
   * 再退一步：并行调多域单域 recall 合并。
   */
  async recallCrossDomain(actorId: string, query: string): Promise<MemoryRecallResult> {
    const now = new Date().toISOString();

    if (this.humanLike) {
      const result = await this.safeRecall(() =>
        this.humanLike!.buildRecall(actorId, query, {
          context: "main",
          crossDomain: true,
          detailLevel: "summary",
        }),
      );
      this.triggerReawakenForFadedHits(actorId, result);
      return {
        actorId,
        query,
        items: await this.finalizeRecallItems(
          actorId,
          query,
          this.humanLikeResultToItems(result, "episodic"),
        ),
        domain: "episodic",
        mode: "cross_domain",
        recalledAt: now,
      };
    }

    if (this.narrative) {
      const text =
        (await this.safeRecall(() =>
          this.narrative!.buildCrossContextRecall(actorId, query),
        )) ?? "";
      return {
        actorId,
        query,
        items: await this.finalizeRecallItems(
          actorId,
          query,
          this.textToRecallItems(text, "narrative"),
        ),
        domain: "narrative",
        mode: "cross_domain",
        recalledAt: now,
      };
    }

    // Fallback：并行调多个单域 recall 合并
    const domains: MemoryDomainKind[] = ["semantic", "episodic", "narrative"];
    const results = await Promise.all(
      domains.map((d) =>
        this.recall(actorId, query, { domain: d }).catch((err) => {
          console.log(`[MemoryCortex] recallCrossDomain domain=${d} 失败: ${err}`);
          return null;
        }),
      ),
    );
    const mergedItems: MemoryRecallItem[] = [];
    for (const r of results) {
      if (!r) continue;
      mergedItems.push(...r.items);
    }
    return {
      actorId,
      query,
      items: await this.finalizeRecallItems(actorId, query, mergedItems),
      domain: "semantic",
      mode: "cross_domain",
      recalledAt: now,
    };
  }

  /**
   * 记忆巩固（夜间睡眠状态机）。
   *
   * 优先委托 nightlyScheduler.forceRunNightTasks（内部整合 memoryManager.consolidateNow
   * + narrative.runSleepConsolidation + archive + sync）；未注册时 fallback 到
   * narrative.runSleepConsolidation；均未注册或空入参则返回空统计（不报错）。
   */
  async consolidate(actorIds: string[]): Promise<MemoryConsolidationStats> {
    const now = new Date().toISOString();
    const empty: MemoryConsolidationStats = {
      actorIds,
      dailyCleanupCount: 0,
      weeklyMergedCount: 0,
      monthlyAbstractedCount: 0,
      consistencyFlagCount: 0,
      knowledgePromotedCount: 0,
      compressionRate: 0,
      estimatedRecallPrecision: 0,
      plannedActions: 0,
      executedActions: 0,
      consolidatedAt: now,
    };

    if (actorIds.length === 0) {
      return empty;
    }

    // 优先委托夜间调度器（统一整合 consolidate + archive + sync）
    if (this.nightlyScheduler) {
      try {
        const result = await this.nightlyScheduler.forceRunNightTasks();
        if (result.error) {
          console.log(`[MemoryCortex] nightlyScheduler.forceRunNightTasks 错误: ${result.error}`);
        }
        return {
          actorIds,
          dailyCleanupCount: result.consolidated ? 1 : 0,
          weeklyMergedCount: result.archived ? 1 : 0,
          monthlyAbstractedCount: result.synced ? 1 : 0,
          consistencyFlagCount: 0,
          knowledgePromotedCount: 0,
          compressionRate: 0,
          estimatedRecallPrecision: 0,
          plannedActions: 0,
          executedActions: 0,
          consolidatedAt: now,
        };
      } catch (err) {
        console.log(`[MemoryCortex] nightlyScheduler.forceRunNightTasks 失败: ${err}`);
        return empty;
      }
    }

    // Fallback：委托 narrative.runSleepConsolidation
    if (!this.narrative) {
      return empty;
    }

    let reports: NarrativeSleepReport[] = [];
    try {
      reports = await this.narrative.runSleepConsolidation(actorIds);
    } catch (err) {
      console.log(`[MemoryCortex] narrative.runSleepConsolidation 失败: ${err}`);
      return empty;
    }

    // ---- 记忆认知架构升级（Phase 3）：consolidate 后置钩子 ----
    // connection pruning 钩子：对每个 actor 调用 forgettingController.pruneConnections，
    //    清除 score < 阈值节点的所有 edge（保留节点本体供历史追溯）。
    //    失败时静默降级，不阻塞 consolidate 主流程。
    if (this.forgettingController) {
      for (const aid of actorIds) {
        try {
          await this.forgettingController.pruneConnections(aid);
        } catch (err) {
          console.log(
            `[MemoryCortex] forgettingController.pruneConnections 失败 (actorId=${aid}): ${err}`,
          );
        }
      }
    }

    return this.mergeSleepReports(actorIds, reports, now);
  }

  // ---- 记忆认知架构升级（Phase 3）：6 个对外委托方法 ---------------------

  /**
   * 元记忆召回：附带来源（provenance）与置信分层（confidenceTier）。
   *
   * 委托 MetacognitionBridge.recallWithProvenance；未注册时降级到普通 recall。
   * 不调 LLM——confidenceTier 由 accessCount / correctness / verification 状态规则计算。
   */
  async recallWithProvenance(
    actorId: string,
    query: string,
    opts?: { domain?: MemoryDomainKind; limit?: number; subQueries?: string[] },
  ): Promise<MemoryRecallResult> {
    if (this.metacognitionBridge) {
      try {
        // subQueries 透传给 bridge → bridge 内部透传给 recall（多意图并行召回）
        return await this.metacognitionBridge.recallWithProvenance(actorId, query, {
          domain: opts?.domain,
          limit: opts?.limit,
          subQueries: opts?.subQueries,
        });
      } catch (err) {
        console.log(`[MemoryCortex] recallWithProvenance 失败（降级到 recall）: ${err}`);
      }
    }
    return this.recall(actorId, query, opts);
  }

  /**
   * 联想预判：基于 query 关键词找种子节点，扩散后聚合预判结果。
   *
   * 委托 AssociativeGraph.predictAssociation；未注册时返回空结果。
   * 不调 LLM——predictedOutcome 由激活节点 summary 规则拼接。
   */
  async predictAssociation(actorId: string, query: string): Promise<PredictedAssociation> {
    const empty: PredictedAssociation = {
      seedNodes: [],
      activatedNodes: [],
      predictedOutcome: "",
      confidence: 0,
      predictedAt: new Date().toISOString(),
    };
    if (!this.associativeGraph) return empty;
    try {
      return await this.associativeGraph.predictAssociation(actorId, query);
    } catch (err) {
      console.log(`[MemoryCortex] predictAssociation 失败: ${err}`);
      return empty;
    }
  }

  /**
   * 显著性评估：在写入前评估记忆的 salienceScore，返回写入决策。
   *
   * 委托 SalienceFilter.evaluateSalience；未注册时返回默认接受决策。
   * 不调 LLM——salienceScore 是 emotionValence + importance + feedback + novelty 加权。
   */
  evaluateSalience(item: MemoryItem): SalienceDecision {
    if (!this.salienceFilter) {
      return { accept: true, score: 1, reason: "no_salience_filter", degraded: false };
    }
    try {
      return this.salienceFilter.evaluateSalience(item);
    } catch (err) {
      console.log(`[MemoryCortex] evaluateSalience 失败（默认接受）: ${err}`);
      return { accept: true, score: 1, reason: "salience_eval_error", degraded: false };
    }
  }

  // ---- 人格内核（personality 域）-------------------------------------------

  /**
   * 拉取结构化人格内核（values / speech_style / beliefs / quirks）。
   *
   * - 优先返回内存缓存；
   * - 缓存未命中时从 KV 摘要记忆读取（key: `personality_core_${actorId}`）；
   * - 未设置或读取失败时返回默认人格（不阻塞启动，防漂移）。
   * 人格特质不随单次对话漂移，仅可通过 {@link setPersonalityCore} 显式更新。
   */
  getPersonalityCore(actorId: string): PersonalityCore {
    const cached = this.personalityCache.get(actorId);
    if (cached) return cached;

    if (this.kvSummary) {
      try {
        const key = personalityCoreKey(actorId);
        const { entries } = this.kvSummary.getSnapshot(actorId, [key]);
        const raw = entries[key];
        if (isPersonalityCore(raw)) {
          this.personalityCache.set(actorId, raw);
          return raw;
        }
      } catch (err) {
        console.log(`[MemoryCortex] getPersonalityCore 读取 KV 失败: ${err}`);
      }
    }

    // 默认人格（不缓存，避免误把默认值固化为「已设置」）
    return DEFAULT_PERSONALITY_CORE;
  }

  /**
   * 设置结构化人格内核，并持久化到 KV（key: `personality_core_${actorId}`）。
   * 写入同时更新内存缓存，确保后续 getPersonalityCore 立即返回新值。
   */
  setPersonalityCore(actorId: string, core: PersonalityCore): void {
    this.personalityCache.set(actorId, core);
    if (this.kvSummary?.setEntry) {
      try {
        this.kvSummary.setEntry(actorId, personalityCoreKey(actorId), core);
      } catch (err) {
        console.log(`[MemoryCortex] setPersonalityCore 写入 KV 失败: ${err}`);
      }
    } else {
      console.log("[MemoryCortex] setPersonalityCore: kvSummary.setEntry 未注册，仅更新内存缓存");
    }
  }

  // ---- 内部工具 ------------------------------------------------------------

  /**
   * 按 sensitivity 过滤召回条目。
   * includeRestricted=false（缺省）时剔除 sensitivity=restricted 的条目，
   * 防止受限记忆进入 prompt 路径；缺省 sensitivity 视为 "public"。
   */
  private filterBySensitivity(
    items: MemoryRecallItem[],
    includeRestricted?: boolean,
  ): MemoryRecallItem[] {
    if (includeRestricted) return items;
    return items.filter((item) => (item.sensitivity ?? "public") !== "restricted");
  }

  /** 把召回文本包装为单条 MemoryRecallItem（超长文本截断至 800 字符并追加省略标记） */
  private textToRecallItems(text: string, domain: MemoryDomainKind): MemoryRecallItem[] {
    if (!text || !text.trim()) return [];
    const clipped =
      text.length > MAX_RECALL_ITEM_TEXT_LENGTH
        ? text.slice(0, MAX_RECALL_ITEM_TEXT_LENGTH) + "…"
        : text;
    return [
      {
        content: clipped,
        domain,
      },
    ];
  }

  /**
   * 把 agentic / narrative 召回文本解析为多条带 score 的 MemoryRecallItem。
   *
   * 解决 textToRecallItems 把整段召回拍平为单条 item、score 丢失的问题：
   * - agentic 输出格式为「N. 相关度 X% · 时间 [标签]\n记忆正文」，条目间空行分隔；
   * - 解析出每条记忆的 score（X/100，clamp 到 [0,1]）与正文，各自独立成 item；
   * - 解析不到「相关度 N%」格式时（如 narrative 输出 humanLike 重构文本），回退为单条 item。
   *
   * 这样仲裁器能拿到结构化分数做跨通道归一化与重排，避免被 formatNarrativeRecallPrompt
   * 的 slice(0,4) 截断到仅剩 1-2 条记忆。
   */
  /** agentic 结构化候选 → MemoryRecallItem（保留原始时间戳与分数） */
  private agenticCandidatesToItems(
    candidates: AgenticMemoryCandidate[],
    domain: MemoryDomainKind = "semantic",
  ): MemoryRecallItem[] {
    return candidates
      .filter((c) => typeof c.content === "string" && c.content.trim())
      .map((c) => ({
        content: c.content,
        domain,
        source: c.source ?? "agentic",
        score: c.score,
        ...(c.timestamp ? { timestamp: c.timestamp } : {}),
      }));
  }

  /** bridge 融合候选 → 召回条目（分数用 Mem0 原始分，缺失时回退 RRF 融合分） */
  private fusedCandidatesToItems(
    candidates: Array<{
      content: string;
      fusedScore: number;
      channels: string[];
      mem0Score?: number;
      timestamp?: string;
    }>,
    domain: MemoryDomainKind = "semantic",
  ): MemoryRecallItem[] {
    return candidates
      .filter((c) => typeof c.content === "string" && c.content.trim())
      .map((c) => ({
        content: c.content,
        domain,
        source: c.channels.includes("both")
          ? "bridge_fused"
          : c.channels.includes("mem0")
            ? "mem0"
            : c.channels.includes("fts")
              ? "fts"
              : "graph",
        score: c.mem0Score ?? c.fusedScore,
        ...(c.timestamp ? { timestamp: c.timestamp } : {}),
      }));
  }

  private parseRecallTextToItems(text: string, source: string): MemoryRecallItem[] {
    if (!text || !text.trim()) return [];
    const trimmed = text.trim();

    // 去掉标题行（「以下为 Mem0 记忆图联想检索…」/「以下为 …」）
    const body = trimmed.replace(/^以下为[^\n]*\n/, "").trim();
    if (!body) return [];

    // 按空行分割条目块
    const blocks = body.split(/\n\s*\n/);
    const scoredItems: MemoryRecallItem[] = [];

    for (const block of blocks) {
      // 匹配「N. 相关度 X%」格式的首行
      const match = block.match(/^\s*\d+\.\s*相关度\s+(\d+(?:\.\d+)?)\s*%/);
      if (!match) continue;
      const percent = parseFloat(match[1] ?? "0");
      const score = Math.max(0, Math.min(1, percent / 100));
      const firstLine = block.split("\n")[0] ?? "";
      const occurredAt = parseFreshnessToIso(firstLine);
      // 正文 = 去掉首行（序号+相关度行）后的剩余
      const contentLines = block.split("\n").slice(1).join("\n").trim();
      if (contentLines) {
        scoredItems.push({
          content: contentLines,
          domain: "semantic",
          source,
          score,
          ...(occurredAt ? { timestamp: occurredAt } : {}),
        });
      }
    }

    // 解析成功 → 返回多条带 score 的 item
    if (scoredItems.length > 0) return scoredItems;

    // 回退：非「相关度 N%」格式（如 humanLike 重构文本），用单条 item 兜底
    return this.textToRecallItems(trimmed, "semantic").map((it) => ({ ...it, source }));
  }

  /** 把 HumanLikeMemory 召回结果映射为 MemoryRecallItem 列表 */
  private humanLikeResultToItems(
    result: { text: string; confidence: number } | null,
    domain: MemoryDomainKind,
  ): MemoryRecallItem[] {
    if (!result || !result.text) return [];
    return [
      {
        content: result.text,
        domain,
        score: result.confidence,
      },
    ];
  }

  /** 安全调用异步召回，捕获异常并返回 null */
  private async safeRecall<T>(fn: () => Promise<T>): Promise<T | null> {
    try {
      return await fn();
    } catch (err) {
      console.log(`[MemoryCortex] recall 调用失败: ${err}`);
      return null;
    }
  }

  /**
   * 再唤醒反弹（遗忘控制器 Phase 2 接线）：召回命中 downranked/cold 节点时，
   * 触发 ForgettingController.reawakenAndStrengthen —— deletionStage 回退一级 +
   * frequencyScore 反弹 + synapse memory.reawakened 事件。反复被提起的记忆会
   * 从遗忘曲线边缘爬回来，这正是"再唤醒"语义；从未命中的则继续走遗忘曲线。
   * fire-and-forget，不阻塞召回返回。
   */
  private triggerReawakenForFadedHits(
    actorId: string,
    result: { recalledNodeIds: string[] } | null,
  ): void {
    if (!this.forgettingController || !this.humanLike) return;
    if (!result || result.recalledNodeIds.length === 0) return;
    try {
      const reawakenable =
        this.humanLike.findReawakenableNodeIds?.(actorId, result.recalledNodeIds) ?? [];
      for (const nodeId of reawakenable) {
        void this.forgettingController.reawakenAndStrengthen(actorId, nodeId).catch(() => {
          /* 静默：再唤醒失败不影响召回 */
        });
      }
    } catch (err) {
      console.log(`[MemoryCortex] 再唤醒触发失败（忽略）: ${err}`);
    }
  }

  /** 安全读取 KV summary 快照，捕获异常并返回 null（用于仲裁通道并行召回） */
  private safeKvSnapshot(actorId: string): string | null {
    if (!this.kvSummary) return null;
    try {
      const snapshot = this.kvSummary.getSnapshot(actorId, ["memory_summary"]);
      const summary = snapshot.entries.memory_summary;
      if (typeof summary === "string" && summary.trim()) return summary;
      return null;
    } catch (err) {
      console.log(`[MemoryCortex] kvSummary.getSnapshot 失败: ${err}`);
      return null;
    }
  }

  /** 合并多个睡眠巩固报告为单一 MemoryConsolidationStats */
  private mergeSleepReports(
    actorIds: string[],
    reports: NarrativeSleepReport[],
    consolidatedAt: string,
  ): MemoryConsolidationStats {
    const stats: MemoryConsolidationStats = {
      actorIds,
      dailyCleanupCount: 0,
      weeklyMergedCount: 0,
      monthlyAbstractedCount: 0,
      consistencyFlagCount: 0,
      knowledgePromotedCount: 0,
      compressionRate: 0,
      estimatedRecallPrecision: 0,
      plannedActions: 0,
      executedActions: 0,
      consolidatedAt,
    };
    if (reports.length === 0) return stats;

    let precisionSum = 0;
    let compressionSum = 0;
    for (const r of reports) {
      stats.dailyCleanupCount += r.dailyCleanupCount;
      stats.weeklyMergedCount += r.weeklyMergedCount;
      stats.monthlyAbstractedCount += r.monthlyAbstractedCount;
      stats.consistencyFlagCount += r.consistencyFlagCount;
      stats.knowledgePromotedCount += r.knowledgePromotedCount;
      stats.plannedActions += r.plannedActions;
      stats.executedActions += r.executedActions;
      precisionSum += r.estimatedRecallPrecision;
      compressionSum += r.compressionRate;
    }
    stats.estimatedRecallPrecision = Number((precisionSum / reports.length).toFixed(3));
    stats.compressionRate = Number((compressionSum / reports.length).toFixed(3));
    return stats;
  }

  // ============================================================
  // 世界状态轨迹存储（P1-10：world 域）
  // ============================================================
  //
  // 在原有记忆域基础上新增 "world" 域，存储 WorldModel 的状态时间序列。
  // 与 TransitionStore（world-model-transition-store.ts）的区别：
  //   - TransitionStore：结构化 (s, a, s') 样本，供世界模型离线训练
  //   - MemoryCortex world 域：人类可读的状态摘要，供叙事/反思/DMN 使用
  //
  // 两者互补：TransitionStore 是机器学习数据，world 域是认知记忆。

  /**
   * 存储世界状态转移轨迹到 world 域。
   *
   * 把 (state, action, nextState) 转为人类可读摘要写入记忆，
   * 供 DMN 空闲时反思"刚才发生了什么"和叙事回忆使用。
   *
   * @param actorId actor id
   * @param stateBefore 动作前状态
   * @param action 执行的动作
   * @param stateAfter 动作后状态
   * @param predictionError 预测误差（可选，附在摘要中供反思）
   */
  async storeWorldStateTrajectory(
    actorId: string,
    stateBefore: import("./world-model-types.js").WorldState,
    action: import("./world-model-types.js").WorldAction,
    stateAfter: import("./world-model-types.js").WorldState,
    predictionError?: number,
  ): Promise<void> {
    try {
      const beforeSummary = this.summarizeWorldState(stateBefore);
      const afterSummary = this.summarizeWorldState(stateAfter);
      const errorTag = typeof predictionError === "number"
        ? ` [预测误差:${predictionError.toFixed(2)}]`
        : "";
      const content = `[世界状态转移]${errorTag}\n动作：${action.tool}\n动作前：${beforeSummary}\n动作后：${afterSummary}`;

      await this.remember(actorId, {
        actorId,
        content,
        kind: "event" as const,
        domain: "world",
        importance: predictionError !== undefined && predictionError > 0.6 ? "high" : "medium",
        timestamp: stateAfter.timestamp || new Date().toISOString(),
      });
    } catch (e) {
      console.log(`[MemoryCortex] storeWorldStateTrajectory 失败: ${e}`);
    }
  }

  /**
   * 召回世界状态轨迹（world 域）。
   *
   * 供 DMN 空闲时反思"最近环境发生了什么变化"使用。
   *
   * @param actorId actor id
   * @param query 查询关键词（如 "desktop" / "click"）
   * @param limit 最大返回条数（默认 5）
   */
  async recallWorldState(
    actorId: string,
    query?: string,
    limit = 5,
  ): Promise<MemoryRecallItem[]> {
    try {
      const items = await this.recall(actorId, query ?? "世界状态转移", {
        domain: "world",
        limit,
      });
      return items.items;
    } catch (e) {
      console.log(`[MemoryCortex] recallWorldState 失败: ${e}`);
      return [];
    }
  }

  /** 把 WorldState 摘要为人类可读短文本 */
  private summarizeWorldState(state: import("./world-model-types.js").WorldState): string {
    const parts: string[] = [];
    if (state.bodyState?.currentDevice) parts.push(`设备:${state.bodyState.currentDevice}`);
    if (state.taskContext) parts.push(`任务:${state.taskContext.slice(0, 60)}`);
    if (state.userActivity) parts.push(`用户:${state.userActivity.slice(0, 40)}`);
    const slotCount = state.perceptualSlots?.length ?? 0;
    if (slotCount > 0) parts.push(`感知:${slotCount}槽位`);
    return parts.length > 0 ? parts.join(" | ") : "(空)";
  }
}
