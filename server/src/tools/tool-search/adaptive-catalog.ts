import { createHash } from "node:crypto";

import type { ChatCompletionTool } from "openai/resources/chat/completions";

import {
  describeDeferredTool,
  type DeferredToolCatalog,
  type DeferredToolEntry,
  type DeferredToolSearchMatch,
} from "./catalog.js";
import { Bm25Index, tokenize } from "./bm25.js";
import { DEFAULT_QUERY_CONSTRAINTS, type ParsedIntent, type QueryConstraints } from "./retrieval-intent.js";
import {
  getSkillDependencies,
  isRegisteredSkillChatToolName,
} from "../../skills/skill-openai-bridge.js";
import {
  type Level3McpSchema,
  type Level3Parameter,
  type Level3SkillSchema,
  type Level3ToolSchema,
  ResourceStatus,
  ResourceType,
  type ResourceRecord,
} from "./registry/models.js";
import { getToolEmbeddingCache, getToolEmbeddingsForCatalog } from "./tool-embedding.js";
import { getEntryCategoryNames, TOOL_CATEGORIES } from "./tool-category.js";
import { ToolKnowledgeGraphService } from "./knowledge-graph/neo4j-client.js";
import { ToolGraphRelation } from "./knowledge-graph/graph-relations.js";
import { ToolRegistryStore } from "./registry/store.js";
import {
  HybridRetrievalEngine,
  type HybridRetrievedResource,
} from "./retrieval/hybrid-retrieval.js";
import { AdaptiveTopPSelector } from "./top-p-selector/top-p-selector.js";
import { ToolRerankingPipeline } from "./reranking/reranking-pipeline.js";
import { firstSentence, slimJsonSchema } from "./schema-slim.js";
import { createNeuralLlmReranker } from "./reranking/neural-reranker.js";
import { sharedHistoryStore } from "./retrieval/history-score.js";
import {
  getCompiledRecallBoosts,
  getToolClassification,
} from "./classification-overrides.js";

/** 一次检索的共享路由/评分视图（顶层单份，不再每条 match 重复内联）。 */
export type AdaptiveSearchRouting = {
  intent: string;
  confidence: number;
  top_p: number;
  domain_groups: string[];
  domain_candidates: string[];
  primary_capability: string;
};

export type AdaptiveDeferredToolSearchMatch = DeferredToolSearchMatch & {
  resource_type: ResourceType;
  domain: string[];
  capability: string[];
};

export type AdaptiveSearchOptions = {
  includeSchema?: boolean;
  queryVector?: number[] | Float32Array;
  tenantId?: string;
  agentContextHash?: string;
  previousToolResult?: unknown;
  blacklistResourceIds?: string[];
};

export type AdaptiveCatalogSummary = {
  total: number;
  resource_types: Record<ResourceType, number>;
  domains: Record<string, number>;
  capabilities: Record<string, number>;
};



type AdaptiveCatalogIndex = {
  signature: string;
  recordsById: Map<string, ResourceRecord>;
  entriesById: Map<string, DeferredToolEntry>;
  bm25Index: Bm25Index; // 预构建全局 BM25 索引，复用避免每次 search 重建
  /** 负例短语表（registryName → negativeAliases+negativeExamples），喂 hybrid 评分核心 */
  negativePhrasesById: Map<string, string[]>;
  summary: AdaptiveCatalogSummary;
};

type FunctionToolDefinition = {
  name: string;
  description?: string;
  parameters?: unknown;
};

const DEFAULT_TENANT_ID = "default";
const DEFAULT_CONTEXT_HASH = "tool-search-bridge";
const INTENT_CACHE_TTL_MS = 300_000; // 意图分解缓存 5 分钟
const MAX_INDEX_CACHE = 32;
/** 路由-召回融合时并入候选集的全量词面 top-N（99 个工具下 BM25 毫秒级，取 12 足够覆盖同义簇）。 */
const GLOBAL_LEXICAL_FLOOR_N = 12;
// 神经注入点（N2/N3）：重排钩子 = sidecar /rerank（失败管线自动回退词面序）；
// 意图分类 = sidecar /classify-intent（低置信采纳，正则 fast-path 与降级路径保留）。
// env 各自一键关闭（AGENT_NEURAL_RERANK_ENABLED / AGENT_NEURAL_INTENT_ENABLED=off）。
const retrievalEngine = new HybridRetrievalEngine({ historyStore: sharedHistoryStore });
/** catalog 级挂载：最近一次检索的路由/评分视图（顶层单份，随 catalog 隔离并发）。 */
type RoutingCarrier = DeferredToolCatalog & { lastSearchRouting?: AdaptiveSearchRouting | null };

export function getAdaptiveSearchRouting(catalog: DeferredToolCatalog): AdaptiveSearchRouting | null {
  return (catalog as RoutingCarrier).lastSearchRouting ?? null;
}
const topPSelector = new AdaptiveTopPSelector();
const rerankingPipeline = new ToolRerankingPipeline({ llmReranker: createNeuralLlmReranker() });
const indexCache = new Map<string, { index: AdaptiveCatalogIndex; createdAt: number }>();
const graphServiceCache = new Map<
  string,
  Promise<{ store: ToolRegistryStore; graph: ToolKnowledgeGraphService }>
>();

// ===== 反馈学习状态（与 Python feedback.py / top_p.py 一比一收敛）=====
// Python 原型把这些状态放在 registry record 与 selector 实例上；检索进程内化后
// 与索引缓存同生命周期，收敛为模块级状态。
// 持久化（阶段优化③）：配置 AGENT_REDIS_URL 时经 feedback-state-persistence 落
// redis（fire-and-forget，失败静默），重启恢复、多实例共享；未配置时纯内存。

import { loadFeedbackState, saveFeedbackState } from "./feedback-state-persistence.js";

const TOPP_STATE_KEY = "topp-overrides";
const FAILURE_STATE_KEY = "resource-failures";

// top_p 自适应升档：检索选中的候选调用失败后抬升该意图的 top-p 阈值，
// 下一次召回扩大候选面（Python AdaptiveTopPSelector.increase_for_intent）。
const TOPP_OVERRIDE_TTL_MS = 10 * 60_000;
const TOPP_OVERRIDE_MAX = 0.99;
const TOPP_OVERRIDE_STEP = 0.02;
const topPIntentOverrides = new Map<string, { value: number; expiresAt: number }>();
const resourceFailureState = new Map<string, { consecutive: number; limitedUntil: number }>();

let feedbackStateHydrated = false;
/** 懒恢复：首次触达反馈状态时从 redis 读一次（无 redis/失败 → 空表，静默）。 */
function hydrateFeedbackStateOnce(): void {
  if (feedbackStateHydrated) return;
  feedbackStateHydrated = true;
  void loadFeedbackState<[string, { value: number; expiresAt: number }][]>(TOPP_STATE_KEY).then(
    (restored) => {
      if (!restored) return;
      const now = Date.now();
      for (const [key, entry] of restored) {
        if (entry?.expiresAt > now) topPIntentOverrides.set(key, entry);
      }
    },
  );
  void loadFeedbackState<[string, { consecutive: number; limitedUntil: number }][]>(
    FAILURE_STATE_KEY,
  ).then((restored) => {
    if (!restored) return;
    const now = Date.now();
    for (const [key, entry] of restored) {
      if (entry?.limitedUntil > now) resourceFailureState.set(key, entry);
    }
  });
}

function persistTopPOverrides(): void {
  saveFeedbackState(TOPP_STATE_KEY, [...topPIntentOverrides.entries()]);
}

function persistResourceFailures(): void {
  saveFeedbackState(FAILURE_STATE_KEY, [...resourceFailureState.entries()]);
}

function topPIntentKey(intent: ParsedIntent): string {
  return `${intent.domain_candidates[0] ?? "misc"}::${intent.primary_capability}`;
}

function getTopPOverride(intent: ParsedIntent): number | null {
  const entry = topPIntentOverrides.get(topPIntentKey(intent));
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    topPIntentOverrides.delete(topPIntentKey(intent));
    return null;
  }
  return entry.value;
}

// rate_limited 翻转：连续 3 次失败后资源在路由/召回中被旁路 60s（Python
// feedback.py 的 status=rate_limited），成功即复位。
const RATE_LIMIT_FAILURE_THRESHOLD = 3;
const RATE_LIMIT_COOLDOWN_MS = 60_000;
// （resourceFailureState 声明在上方反馈状态块，与 top-p 表共享持久化）

/** 记录一次资源反馈（工具真实执行成功/失败后调用，驱动 rate_limited 翻转）。 */
export function recordAdaptiveResourceFeedback(resourceId: string, success: boolean): void {
  hydrateFeedbackStateOnce();
  if (success) {
    if (resourceFailureState.delete(resourceId)) persistResourceFailures();
    return;
  }
  const state = resourceFailureState.get(resourceId) ?? { consecutive: 0, limitedUntil: 0 };
  state.consecutive += 1;
  if (state.consecutive >= RATE_LIMIT_FAILURE_THRESHOLD) {
    state.limitedUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
    state.consecutive = 0;
    console.warn(`[tool-search:adaptive] ${resourceId} 连续失败 ${RATE_LIMIT_FAILURE_THRESHOLD} 次，旁路 ${RATE_LIMIT_COOLDOWN_MS}ms`);
  }
  resourceFailureState.set(resourceId, state);
  persistResourceFailures();
}

function isResourceRateLimited(resourceId: string): boolean {
  const state = resourceFailureState.get(resourceId);
  if (!state) return false;
  if (state.limitedUntil > Date.now()) return true;
  if (state.limitedUntil > 0) resourceFailureState.delete(resourceId);
  return false;
}

/**
 * 失败反馈驱动的 top-p 升档入口：传入召回时的 query，复用意图缓存解析意图
 * （零额外 LLM 成本），将该意图的 top-p 抬升一个步长（0.99 封顶）。
 */
export async function reinforceAdaptiveTopPForQuery(query: string): Promise<void> {
  hydrateFeedbackStateOnce();
  const trimmed = query.trim();
  if (!trimmed) return;
  const intent = tryFastPathIntent(trimmed);
  if (!intent) return;
  const key = topPIntentKey(intent);
  const base = topPForIntent(intent);
  const prev = topPIntentOverrides.get(key);
  const current = prev && prev.expiresAt > Date.now() ? prev.value : base;
  topPIntentOverrides.set(key, {
    value: Math.min(TOPP_OVERRIDE_MAX, current + TOPP_OVERRIDE_STEP),
    expiresAt: Date.now() + TOPP_OVERRIDE_TTL_MS,
  });
  persistTopPOverrides();
}

/**
 * 图边使用强化：资源被真实调用后，增强其 similar_to 边权重（与 Python
 * knowledge_graph.record_edge_usage + feedback._boost_similar_edges 对齐），
 * 让「与好工具相似的候选」在后续图扩展中排序更高。
 */
export async function reinforceAdaptiveGraphEdges(
  catalog: DeferredToolCatalog,
  resourceId: string,
  delta = 0.05,
): Promise<void> {
  try {
    const index = getOrCreateAdaptiveCatalogIndex(catalog);
    if (!index.recordsById.has(resourceId)) return;
    const { store } = await getOrCreateGraphService(index);
    const edges = await store.queryGraphEdges({
      source_resource_id: resourceId,
      relation_type: ToolGraphRelation.SimilarTo,
      limit: 50,
    });
    for (const edge of edges) {
      await store.upsertGraphEdge({
        source_resource_id: edge.source_resource_id,
        relation_type: edge.relation_type,
        target_resource_id: edge.target_resource_id,
        weight: Math.min(1, edge.weight + delta),
      });
    }
  } catch (e) {
    console.warn("[tool-search:adaptive] reinforceAdaptiveGraphEdges failed (ignored)", e);
  }
}

export async function adaptiveSearchDeferredTools(
  catalog: DeferredToolCatalog,
  query: string,
  limit: number,
  options?: AdaptiveSearchOptions,
): Promise<AdaptiveDeferredToolSearchMatch[]> {
  const trimmedQuery = query.trim();
  if (!trimmedQuery || catalog.entries.length === 0 || limit <= 0) return [];

  const index = getOrCreateAdaptiveCatalogIndex(catalog);
  const contextHash = options?.agentContextHash?.trim() || DEFAULT_CONTEXT_HASH;

  // ── 单评分器（2026-10-01 分类归一）──
  // 退役 IntentRouter 规则分解、域路由、17 类 embedding 类别路由三层——124 工具
  // 规模下全量 BM25 毫秒级，"先分类再在子集里检索"是为不存在的规模付的复杂度，
  // 且规则层判错域时正确工具根本不进候选（route-or-recall 并集补丁的根源）。
  // 新流程：全量在线候选 → hybrid 单评分（词面+embedding+历史+负例）→ boost →
  // top-p →（低置信才）图扩展+二次检索+神经重排。域先验从词面领先者自派生，
  // 置信度从词面边际自派生；fast-path 正则保留为纯性能短路（策展置信仍享短路）。
  const fastPathIntent = tryFastPathIntent(trimmedQuery);

  const candidates = allFilteredRecords(index, options?.tenantId);
  if (candidates.length === 0) return [];

  const lexicalLeaders = globalLexicalCandidates(index, catalog, trimmedQuery, GLOBAL_LEXICAL_FLOOR_N);
  const derivedDomains = majorityDomains(lexicalLeaders);
  const intent: ParsedIntent = fastPathIntent ?? {
    intent: trimmedQuery,
    domain_candidates: derivedDomains,
    primary_capability: derivedDomains[0] ? `${derivedDomains[0]}.query` : "",
    confidence: marginConfidence(lexicalLeaders),
    query_constraints: DEFAULT_QUERY_CONSTRAINTS,
    param_extract: {},
    is_compound_task: false,
    sub_intents: [],
  };

  const retrieved = await retrievalEngine.search({
    query: trimmedQuery,
    candidates,
    queryVector: options?.queryVector,
    limit: Math.min(50, Math.max(10, limit * 4)),
    prebuiltIndex: index.bm25Index,
    aliasEntries: catalog.entries,
    intentDomains: intent.domain_candidates,
    intentCapabilities: [],
    negativePhrasesById: index.negativePhrasesById,
  });
  const boosted = applyAdaptiveIntentBoost(index, retrieved, trimmedQuery);
  const topP = topPSelector.select(
    boosted.map((item) => ({ item, score: item.final_score })),
    { confidence: intent.confidence, topPOverride: getTopPOverride(intent) },
  );
  (catalog as RoutingCarrier).lastSearchRouting = {
    intent: intent.intent,
    confidence: intent.confidence,
    top_p: topP.top_p,
    domain_groups: derivedDomains,
    domain_candidates: intent.domain_candidates,
    primary_capability: intent.primary_capability,
  };

  // 高置信短路：跳过图扩展+二次检索+重排（省 40-60% discover 延迟）。
  // fast-path 策展置信（0.85-0.95）与词面边际显著（top1 一眼领先）的轮直达。
  if (intent.confidence >= 0.85) {
    return topP.selected
      .slice(0, Math.max(1, limit))
      .map((s, rank) => matchFromCandidate(catalog, index, s.item, options, rank));
  }

  const expandedRecords = await expandWithKnowledgeGraph(
    index,
    topP.selected.map((s) => s.item.resource),
    25,
  );
  const expandedRetrieved = await retrievalEngine.search({
    query: trimmedQuery,
    candidates: expandedRecords,
    queryVector: options?.queryVector,
    limit: 25,
    prebuiltIndex: index.bm25Index,
    aliasEntries: catalog.entries,
    intentDomains: intent.domain_candidates,
    intentCapabilities: [],
    negativePhrasesById: index.negativePhrasesById,
  });
  const reranked = await rerankingPipeline.rerank({
    raw_query: trimmedQuery,
    agent_context_hash: contextHash,
    previous_tool_result: options?.previousToolResult,
    query_constraints: intent.query_constraints,
    candidates: expandedRetrieved,
    blacklist_resource_ids: options?.blacklistResourceIds,
    intent_domains: intent.domain_candidates,
    intent_capabilities: [],
  });

  // llm_seen_count > 0 = 神经重排已定序：boost 只校正展示分、不再重排（否则会
  // 推翻神经顺序——2026-09-12 A/B 实证）；= 0 时维持基线行为（boost 排序）。
  const finalBoosted = applyAdaptiveIntentBoost(
    index,
    reranked.candidates,
    trimmedQuery,
    reranked.llm_seen_count === 0,
  );
  return finalBoosted
    .slice(0, Math.max(1, limit))
    .map((candidate, rank) => matchFromCandidate(catalog, index, candidate, options, rank));
}

/** 全量在线候选（online + 非限流 + 租户过滤，与原路由层出候选同口径）。 */
function allFilteredRecords(
  index: AdaptiveCatalogIndex,
  tenantId?: string,
): ResourceRecord[] {
  const out: ResourceRecord[] = [];
  for (const record of index.recordsById.values()) {
    if (passesRouteFilters(record, DEFAULT_QUERY_CONSTRAINTS, tenantId)) out.push(record);
  }
  return out;
}

/**
 * 词面领先者的域多数票（频次 ≥2，最多 4 个），作为 hybrid 的 domain 先验——
 * 替代规则分类器的 domain_candidates：先验来自"词面已经很强的工具归属哪些域"，
 * 是评分的自我修正，不再依赖英文正则判域。
 */
function majorityDomains(
  leaders: Array<{ record: ResourceRecord; score: number }>,
): string[] {
  const counts = new Map<string, number>();
  for (const { record } of leaders) {
    for (const domain of record.level1.domain) {
      counts.set(domain, (counts.get(domain) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([domain]) => domain);
}

/**
 * 词面边际置信：top1 与 top2 的归一分差映射到 0.5~0.97。词面一眼领先（边际
 * ≥0.744）才达高置信短路门槛——短路资格由检索结果自证，不再由规则分类器颁证。
 */
function marginConfidence(
  leaders: Array<{ record: ResourceRecord; score: number }>,
): number {
  const s1 = leaders[0]?.score ?? 0;
  const s2 = leaders[1]?.score ?? 0;
  if (s1 <= 0) return 0.5;
  const margin = Math.max(0, (s1 - s2) / s1);
  return Math.min(0.97, 0.5 + margin * 0.47);
}

export function summarizeAdaptiveCatalog(
  catalog: DeferredToolCatalog,
): AdaptiveCatalogSummary {
  return getOrCreateAdaptiveCatalogIndex(catalog).summary;
}

/**
 * 全量 BM25（含别名扩展）词面 top-N 领先者（带原始分）。单评分器下的双重输入：
 * 域先验多数票 + 边际置信的来源，同时其名次也是词面通道的结果基线。
 */
function globalLexicalCandidates(
  index: AdaptiveCatalogIndex,
  catalog: DeferredToolCatalog,
  query: string,
  topN: number,
): Array<{ record: ResourceRecord; score: number }> {
  if (tokenize(query).length === 0) return [];
  const hits = index.bm25Index.search(query, topN, catalog.entries);
  const out: Array<{ record: ResourceRecord; score: number }> = [];
  for (const hit of hits) {
    const record = index.recordsById.get(hit.id);
    if (record && record.level1.status === "online") out.push({ record, score: hit.score });
  }
  return out;
}

/** 按 resource_id 去重合并（保持路由候选优先顺序，词面兜底追加在后）。 */
function mergeCandidateRecords(
  primary: ResourceRecord[],
  extra: ResourceRecord[],
): ResourceRecord[] {
  if (extra.length === 0) return primary;
  const seen = new Set(primary.map((r) => r.level1.resource_id));
  const out = [...primary];
  for (const record of extra) {
    if (seen.has(record.level1.resource_id)) continue;
    seen.add(record.level1.resource_id);
    out.push(record);
  }
  return out;
}

export function loadAdaptiveCatalogSchema(
  catalog: DeferredToolCatalog,
  resourceId: string,
): Level3ToolSchema | Level3SkillSchema | Level3McpSchema | null {
  const index = getOrCreateAdaptiveCatalogIndex(catalog);
  const record = index.recordsById.get(resourceId);
  const entry = index.entriesById.get(resourceId);
  if (!record || !entry) return null;
  if (record.level1.resource_type === ResourceType.McpServer) {
    return buildMcpSchema(entry);
  }
  if (record.level1.resource_type === ResourceType.Skill) {
    return buildSkillSchema(entry);
  }
  return buildToolSchema(entry);
}

function getOrCreateAdaptiveCatalogIndex(catalog: DeferredToolCatalog): AdaptiveCatalogIndex {
  const signature = catalogSignature(catalog);
  const cached = indexCache.get(signature);
  if (cached) {
    indexCache.delete(signature);
    indexCache.set(signature, cached);
    return cached.index;
  }

  const index = buildAdaptiveCatalogIndex(catalog, signature);
  if (indexCache.size >= MAX_INDEX_CACHE) {
    const firstKey = indexCache.keys().next().value;
    if (firstKey !== undefined) indexCache.delete(firstKey);
  }
  indexCache.set(signature, { index, createdAt: Date.now() });
  return index;
}

function buildAdaptiveCatalogIndex(
  catalog: DeferredToolCatalog,
  signature: string,
): AdaptiveCatalogIndex {
  const embeddings = getToolEmbeddingsForCatalog(
    catalog.entries.map((entry) => entry.registryName),
  );
  const index: AdaptiveCatalogIndex = {
    signature,
    recordsById: new Map(),
    entriesById: new Map(),
    bm25Index: new Bm25Index([]), // 占位，下面重建
    negativePhrasesById: new Map(),
    summary: emptySummary(),
  };

  for (const entry of catalog.entries) {
    const record = resourceRecordFromEntry(entry, embeddings.get(entry.registryName));
    index.recordsById.set(record.level1.resource_id, record);
    index.entriesById.set(record.level1.resource_id, entry);
    const negatives = [...entry.negativeAliases, ...entry.negativeExamples];
    if (negatives.length > 0) index.negativePhrasesById.set(entry.registryName, negatives);
    countSummary(index.summary, record);
    const domainGroups = inferDomainGroups(record.level1.domain, record.level1.resource_type);

  }

  // 预构建全局 BM25 索引（复用，避免每次检索时重新构建）
  index.bm25Index = new Bm25Index(
    catalog.entries.map((entry) => {
      const record = index.recordsById.get(entry.registryName);
      return {
        id: entry.registryName,
        text: record ? searchableTextForRecord(record) : entry.searchText || entry.registryName,
      };
    }),
  );

  return index;
}

function searchableTextForRecord(record: ResourceRecord): string {
  return [
    record.level1.name,
    record.level1.description,
    ...record.level1.domain,
    ...record.level1.capability,
    ...record.level1.tags,
    record.level2.input_type,
    record.level2.output_type,
    ...record.level2.use_cases,
    ...record.level2.limitations,
    ...record.level2.preconditions,
  ].join(" ");
}

async function expandWithKnowledgeGraph(
  index: AdaptiveCatalogIndex,
  seedRecords: ResourceRecord[],
  limit: number,
): Promise<ResourceRecord[]> {
  // 实体图检索：走真实 ToolKnowledgeGraphService（SimilarTo/CombineWith/DependsOn/Requires 关系扩展）。
  const { graph } = await getOrCreateGraphService(index);
  const expanded = await graph.expandCandidates(seedRecords, limit);
  return expanded;
}

/** 每个 catalog 签名共享同一个实体内存图（memoryOnly store + ToolKnowledgeGraphService）。 */
function getOrCreateGraphService(
  index: AdaptiveCatalogIndex,
): Promise<{ store: ToolRegistryStore; graph: ToolKnowledgeGraphService }> {
  const cached = graphServiceCache.get(index.signature);
  if (cached) return cached;

  const created = (async () => {
    const store = new ToolRegistryStore({ memoryOnly: true });
    const graph = new ToolKnowledgeGraphService(store);
    for (const record of index.recordsById.values()) {
      await store.upsertRecord(record);
    }
    await seedGraphEdges(store, index);
    return { store, graph };
  })();

  graphServiceCache.set(index.signature, created);
  return created;
}

/** 根据 catalog 索引的真实关系灌入图边（depends_on / similar_to）。 */
async function seedGraphEdges(
  store: ToolRegistryStore,
  index: AdaptiveCatalogIndex,
): Promise<void> {
  // depends_on：显式声明的依赖（与 Python registry._assert_no_circular_dependency
  // 对齐：成环的依赖边不灌入并告警，避免图扩展在环上循环放大）
  const dependencyAdjacency = new Map<string, string[]>();
  for (const record of index.recordsById.values()) {
    dependencyAdjacency.set(
      record.level1.resource_id,
      record.level2.dependencies.filter((dep) => index.recordsById.has(dep)),
    );
  }
  const reaches = (from: string, target: string): boolean => {
    const seen = new Set<string>();
    const stack = [from];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      if (current === target) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      for (const next of dependencyAdjacency.get(current) ?? []) stack.push(next);
    }
    return false;
  };
  for (const record of index.recordsById.values()) {
    for (const dep of record.level2.dependencies) {
      if (!index.recordsById.has(dep)) continue;
      if (reaches(dep, record.level1.resource_id)) {
        console.warn(
          `[tool-search:adaptive] 依赖环检测：跳过 ${record.level1.resource_id} -> ${dep}（会闭合依赖环）`,
        );
        continue;
      }
      await store.upsertGraphEdge({
        source_resource_id: record.level1.resource_id,
        relation_type: ToolGraphRelation.DependsOn,
        target_resource_id: dep,
        weight: 1,
      });
    }
  }

  // similar_to：共享 capability 的资源互为相似（每个能力桶两两建边）
  const capabilityMembers = new Map<string, string[]>();
  for (const record of index.recordsById.values()) {
    for (const cap of record.level1.capability) {
      const members = capabilityMembers.get(cap) ?? [];
      members.push(record.level1.resource_id);
      capabilityMembers.set(cap, members);
    }
  }
  for (const members of capabilityMembers.values()) {
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        await store.upsertGraphEdge({
          source_resource_id: members[i],
          relation_type: ToolGraphRelation.SimilarTo,
          target_resource_id: members[j],
          weight: 0.6,
        });
        await store.upsertGraphEdge({
          source_resource_id: members[j],
          relation_type: ToolGraphRelation.SimilarTo,
          target_resource_id: members[i],
          weight: 0.6,
        });
      }
    }
  }

  // combine_with：同 domain 内能力互为补充（互补 capability）的资源可组合协作。
  // 例如同属 calendric domain 的「创建日程」与「查询空闲时段」可串联成完整编排。
  const domainMembers = new Map<string, string[]>();
  for (const record of index.recordsById.values()) {
    for (const domain of record.level1.domain) {
      const members = domainMembers.get(domain) ?? [];
      members.push(record.level1.resource_id);
      domainMembers.set(domain, members);
    }
  }
  for (const members of domainMembers.values()) {
    if (members.length < 2) continue;
    for (let i = 0; i < members.length; i++) {
      const capA = new Set(index.recordsById.get(members[i])?.level1.capability ?? []);
      for (let j = i + 1; j < members.length; j++) {
        const capB = new Set(index.recordsById.get(members[j])?.level1.capability ?? []);
        // 仅当两边各拥有对方没有的能力才算「互补」，避免与 similar_to 重复
        const missingFromB = [...capA].filter((c) => !capB.has(c));
        const missingFromA = [...capB].filter((c) => !capA.has(c));
        if (missingFromA.length === 0 || missingFromB.length === 0) continue;
        await store.upsertGraphEdge({
          source_resource_id: members[i],
          relation_type: ToolGraphRelation.CombineWith,
          target_resource_id: members[j],
          weight: 0.5,
        });
        await store.upsertGraphEdge({
          source_resource_id: members[j],
          relation_type: ToolGraphRelation.CombineWith,
          target_resource_id: members[i],
          weight: 0.5,
        });
      }
    }
  }
}

function applyAdaptiveIntentBoost(
  index: AdaptiveCatalogIndex,
  candidates: HybridRetrievedResource[],
  query: string,
  resort = true,
): HybridRetrievedResource[] {
  const q = query.toLowerCase();
  const qTokens = new Set(tokenize(q));
  const mapped = candidates
    .map((candidate) => {
      const id = candidate.resource.level1.resource_id;
      const entry = index.entriesById.get(id);
      // 召回校准已声明化（classification-overrides.recallBoost）：校准词条跟着
      // 工具声明走，不再堆在本函数的硬编码 switch 里
      let boost = lexicalToolBoost(id, q, qTokens, entry);
      for (const rule of getCompiledRecallBoosts(id)) {
        if (rule.regex.test(q)) boost += rule.weight;
      }
      boost = clamp(boost, -0.25, 0.45);
      if (boost === 0) return candidate;
      return {
        ...candidate,
        final_score: round4(clamp(candidate.final_score + boost, 0, 1)),
      };
    });
  if (!resort) return mapped;
  return mapped.sort((a, b) => b.final_score - a.final_score);
}

function lexicalToolBoost(
  resourceId: string,
  query: string,
  queryTokens: Set<string>,
  entry?: DeferredToolEntry,
): number {
  const nameTokens = tokenize(resourceId.replace(/[._-]+/g, " "));
  let boost = 0;
  for (const token of nameTokens) {
    if (token.length < 3) continue;
    if (queryTokens.has(token) || query.includes(token)) {
      boost += token.length >= 5 ? 0.055 : 0.025;
    }
  }
  if (entry) {
    const positives = [...entry.searchAliases, ...entry.examples];
    for (const phrase of positives) {
      const overlap = tokenize(phrase).filter((token) => queryTokens.has(token)).length;
      if (overlap > 0) boost += Math.min(0.08, overlap * 0.025);
    }
    const negatives = [...entry.negativeAliases, ...entry.negativeExamples];
    for (const phrase of negatives) {
      const overlap = tokenize(phrase).filter((token) => queryTokens.has(token)).length;
      if (overlap > 0) boost -= Math.min(0.12, overlap * 0.04);
    }
  }
  return boost;
}

const DISCOVER_WIRE_DESC_CHARS = 90;
/** includeSchema 时附瘦身参数 schema 的最大条数——top-3 覆盖 golden top3≈100% 的选择面。 */
const DISCOVER_SCHEMA_TOP_N = 3;

function matchFromCandidate(
  catalog: DeferredToolCatalog,
  index: AdaptiveCatalogIndex,
  candidate: HybridRetrievedResource,
  options?: AdaptiveSearchOptions,
  rank = 0,
): AdaptiveDeferredToolSearchMatch {
  const record = candidate.resource;
  const entry = index.entriesById.get(record.level1.resource_id);
  const match: AdaptiveDeferredToolSearchMatch = {
    name: record.level1.resource_id,
    // 线格式瘦身（2026-10-01）：与 Core 注入同口径（首句 120 字符）。检索索引
    // 仍用全文（buildToolSearchText 独立构建），只瘦"喂给 LLM 的视图"。
    description: firstSentence(record.level1.description, DISCOVER_WIRE_DESC_CHARS),
    score: Math.round(candidate.final_score * 1000) / 1000,
    parameterNames: entry?.parameterNames ?? [],
    requiredParameters: entry?.requiredParameters ?? [],
    resource_type: record.level1.resource_type,
    domain: record.level1.domain,
    capability: record.level1.capability,
  };
  if (options?.includeSchema && rank < DISCOVER_SCHEMA_TOP_N) {
    const schema = describeDeferredTool(catalog, record.level1.resource_id);
    if (schema) {
      match.parameters = (slimJsonSchema(schema.parameters) as Record<string, unknown>) ?? {
        type: "object",
        properties: {},
      };
    }
  }
  return match;
}

function resourceRecordFromEntry(
  entry: DeferredToolEntry,
  cachedEmbedding?: number[],
): ResourceRecord {
  const fn = getFunction(entry.tool);
  const name = entry.registryName;
  const description = fn?.description ?? "";
  const resourceType = inferResourceType(entry);
  const domains = inferDomains(name, resourceType);
  const capabilities = inferCapabilities(name, domains, resourceType);
  const now = new Date(0).toISOString();
  const tags = inferTags(entry, domains, resourceType);
  return {
    level1: {
      resource_id: name,
      resource_type: resourceType,
      name,
      description,
      domain: domains,
      capability: capabilities,
      tags,
      version: "1.0.0",
      status: ResourceStatus.Online,
      base_score: resourceType === ResourceType.McpServer ? 0.5 : 0.55,
      embedding: cachedEmbedding ?? hashTextToVector(entry.embeddingInput || entry.searchText, 64),
      latency_ms: inferLatencyMs(domains[0] ?? "misc", resourceType),
    },
    level2: {
      resource_id: name,
      input_type: entry.parameterNames.length ? `object:${name}Input` : "object:empty",
      output_type: "json",
      use_cases: dedupe([
        description,
        ...entry.examples,
        ...entry.searchAliases,
      ]).slice(0, 12),
      limitations: inferLimitations(resourceType),
      preconditions: inferPreconditions(resourceType),
      dependencies:
        resourceType === ResourceType.Skill ? getSkillDependencies(name) ?? [] : [],
    },
    level3_pointer: name,
    versions: [
      {
        version: "1.0.0",
        released_at: now,
        is_canary: false,
        is_active: true,
      },
    ],
    environment: "prod",
    tenant_id: DEFAULT_TENANT_ID,
    auth_level: "default",
    created_at: now,
    updated_at: now,
  };
}

function inferResourceType(entry: DeferredToolEntry): ResourceType {
  const name = entry.registryName;
  if (name.startsWith("mcp.")) return ResourceType.McpServer;
  if (isRegisteredSkillChatToolName(name)) return ResourceType.Skill;
  if (looksLikeSessionSkill(entry)) return ResourceType.Skill;
  return ResourceType.Tool;
}

/**
 * 声明时延估算表（与 Python tool-router-export.inferLatencyMs 一比一移植）。
 * 仅用于重排阶段的超时软惩罚排序信号，不代表真实执行时延。
 */
function inferLatencyMs(domain: string, resourceType: ResourceType): number {
  if (resourceType === ResourceType.McpServer) return 30;
  const map: Record<string, number> = {
    clock: 10,
    weather: 18,
    calendar: 15,
    search: 24,
    browser: 20,
    phone: 32,
    budget: 14,
    shopping: 18,
    self: 12,
    reminder: 16,
    agent: 19,
    wallet: 13,
    aip: 26,
    desktop: 27,
    world: 28,
    travel: 22,
    mcp: 30,
  };
  return map[cleanDomain(domain)] ?? 20;
}

function looksLikeSessionSkill(entry: DeferredToolEntry): boolean {
  const name = entry.registryName;
  if (name.startsWith("self.")) return false;
  if (/^(agent|aip|browser|calendar|clock|desktop|fetch|info|phone|search|shopping|wallet|weather|world)\b/.test(name)) {
    return false;
  }
  const text = `${getFunction(entry.tool)?.description ?? ""} ${entry.searchText}`.toLowerCase();
  return /\bskill\b|\bcustom capability\b|\bcommunity skill\b/.test(text);
}

function inferDomains(name: string, resourceType: ResourceType): string[] {
  // 声明优先（classification-overrides）：声明的域排在最前并参与去重，
  // 推断域保留为长尾信号——错分类从此有一处可修的声明入口
  const domains = new Set<string>(getToolClassification(name)?.domains ?? []);
  for (const inferred of getEntryCategoryNames(name, TOOL_CATEGORIES)) domains.add(inferred);
  const namespace = firstNamespace(name);

  if (name === "search_web") domains.add("search");
  if (name === "fetch_web") {
    domains.add("search");
    domains.add("browser");
  }
  if (namespace === "info") {
    domains.add("search");
    domains.add("browser");
  }
  if (resourceType === ResourceType.McpServer) {
    domains.add("mcp");
    domains.add("misc");
    const alias = name.split(".")[1];
    if (alias) domains.add(cleanDomain(alias));
  }
  if (resourceType === ResourceType.Skill) {
    domains.add("self");
    domains.add(cleanDomain(namespace));
    if (domains.size === 0) domains.add("misc");
  }
  if (domains.size === 0) domains.add(namespaceToDomain(namespace));
  return dedupe([...domains].map(cleanDomain).filter(Boolean));
}

function inferCapabilities(
  name: string,
  domains: string[],
  resourceType: ResourceType,
): string[] {
  const capabilities = new Set<string>();
  // 声明优先：声明的能力标签排最前（推断值保留为长尾，二者取并集）
  for (const declared of getToolClassification(name)?.capabilities ?? []) {
    capabilities.add(declared);
  }
  const dotParts = name.split(".").filter(Boolean);
  const leaf = dotParts[dotParts.length - 1] ?? name;
  const leafParts = leaf.split("_").filter(Boolean);
  const action = leafParts[0] ?? leaf;
  const second = dotParts[1];

  for (const domain of domains) {
    capabilities.add(`${domain}.general`);
    if (second) capabilities.add(`${domain}.${cleanCapability(second)}`);
    capabilities.add(`${domain}.${cleanCapability(leaf)}`);
    capabilities.add(`${domain}.${cleanCapability(action)}`);
    for (const normalized of normalizeActionAliases(action, leaf)) {
      capabilities.add(`${domain}.${normalized}`);
    }
  }

  if (name === "search_web") {
    capabilities.add("search.query");
    capabilities.add("search.web");
  }
  if (name === "fetch_web") {
    capabilities.add("search.fetch");
    capabilities.add("browser.navigate");
    capabilities.add("browser.read");
  }
  if (name.includes("automation")) capabilities.add("desktop.automation");
  if (name.includes("screenshot")) capabilities.add("desktop.screenshot");
  if (name.startsWith("mcp.")) capabilities.add("mcp.general");
  if (resourceType === ResourceType.Skill) capabilities.add("self.skill");

  capabilities.add(cleanCapability(name));
  return dedupe([...capabilities].filter(Boolean));
}

function normalizeActionAliases(action: string, leaf: string): string[] {
  const values = new Set<string>();
  const a = cleanCapability(action);
  const l = cleanCapability(leaf);
  if (a) values.add(a);
  if (l) values.add(l);
  if (["get", "list", "fetch", "read", "query", "inspect"].includes(a)) values.add("query");
  if (["create", "add", "schedule", "plan"].includes(a)) values.add("create");
  if (["send", "call", "dispatch", "invoke"].includes(a)) values.add("call");
  if (["run", "execute", "open"].includes(a)) values.add("execute");
  if (l.includes("call")) values.add("call");
  if (l.includes("message")) values.add("message");
  if (l.includes("balance")) {
    values.add("balance");
    values.add("query");
  }
  if (l.includes("transaction")) {
    values.add("transaction");
    values.add("query");
  }
  if (l.includes("task")) values.add("task");
  if (l.includes("skill")) values.add("skill");
  return [...values];
}

function inferTags(
  entry: DeferredToolEntry,
  domains: string[],
  resourceType: ResourceType,
): string[] {
  const fileTags = new Set<string>();
  const text = `${entry.registryName} ${entry.searchText}`.toLowerCase();
  for (const ext of ["pdf", "doc", "docx", "xls", "xlsx", "csv", "json", "txt", "md", "png", "jpg", "jpeg"]) {
    if (text.includes(ext)) fileTags.add(ext);
  }
  return dedupe([
    resourceType,
    ...domains,
    ...entry.parameterNames,
    ...entry.registryName.split(/[._-]+/),
    ...fileTags,
  ]);
}

function inferLimitations(resourceType: ResourceType): string[] {
  if (resourceType === ResourceType.McpServer) return ["remote availability and latency vary by server"];
  if (resourceType === ResourceType.Skill) return ["skill dependencies must be online before execution"];
  return [];
}

function inferPreconditions(resourceType: ResourceType): string[] {
  if (resourceType === ResourceType.McpServer) return ["MCP connection pool must be healthy"];
  if (resourceType === ResourceType.Skill) return ["skill must be enabled for the current actor"];
  return [];
}

function idsToFilteredRecords(
  index: AdaptiveCatalogIndex,
  ids: string[],
  constraints: QueryConstraints,
  tenantId?: string,
): ResourceRecord[] {
  const out: ResourceRecord[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const record = index.recordsById.get(id);
    if (!record) continue;
    if (!passesRouteFilters(record, constraints, tenantId)) continue;
    out.push(record);
  }
  return out;
}

function passesRouteFilters(
  record: ResourceRecord,
  constraints: QueryConstraints,
  tenantId?: string,
): boolean {
  if (record.level1.status !== ResourceStatus.Online) return false;
  // 连续失败触发的 rate_limited 旁路（Python feedback.py 语义，进程内收敛实现）
  if (isResourceRateLimited(record.level1.resource_id)) return false;
  if (
    tenantId &&
    tenantId !== DEFAULT_TENANT_ID &&
    record.tenant_id !== DEFAULT_TENANT_ID &&
    record.tenant_id !== tenantId
  ) {
    return false;
  }
  if (!authAllows(record.auth_level, constraints.auth_level)) return false;
  if (constraints.read_only && isLikelyWriteResource(record)) return false;
  if (
    constraints.file_type &&
    record.level1.tags.length > 0 &&
    !record.level1.tags.some((tag) => tag.toLowerCase() === constraints.file_type)
  ) {
    return false;
  }
  return true;
}

function authAllows(resourceAuth: string, requestedAuth: string): boolean {
  if (resourceAuth === "guest") return true;
  if (resourceAuth === "default") return requestedAuth !== "guest";
  return requestedAuth === "admin";
}

function isLikelyWriteResource(record: ResourceRecord): boolean {
  const name = record.level1.name.toLowerCase();
  return /(?:^|[._-])(?:accept|call|comment|create|delete|deliver|dispatch|execute|like|pay|post|purchase|reject|remove|respond|run|send|submit|transfer|update|upload|write)(?:[._-]|$)/.test(
    name,
  );
}

function domainsFromQuery(query: string): string[] {
  const q = query.toLowerCase();
  const out = new Set<string>();
  const rules: Array<[RegExp, string[]]> = [
    [/\bmcp\b|\bexternal tool\b|\bintegration\b|\bserver\b/, ["mcp", "misc"]],
    [/\bweb\b|\bbrowser\b|\burl\b|\bpage\b|\bsite\b|\blink\b/, ["browser", "search"]],
    [/\bsearch\b|\bgoogle\b|\bquery\b|\bnews\b/, ["search"]],
    [/\bweather\b|\bforecast\b|\btemperature\b/, ["weather"]],
    [/\bcalendar\b|\bschedule\b|\bmeeting\b|\bremind\b|\btodo\b|\btasks?\b/, ["calendar", "reminder"]],
    [/\bphone\b|\bcall\b|\bmessage\b|\bsms\b|\bdial\b/, ["phone"]],
    [/\bwallet\b|\bbalance\b|\btransaction\b|\bpayment\b/, ["wallet"]],
    [/\bdesktop\b|\bshell\b|\bscreenshot\b|\bautomation\b|\bwindow\b/, ["desktop"]],
    [/\bskill\b|\bcapabilit(?:y|ies)\b|\bcustom\b|\btools?\b|\bcan you\b/, ["agent", "self"]],
    [/\bworld\b|\bregistry\b|\bagent\b/, ["world", "agent"]],
  ];
  for (const [pattern, domains] of rules) {
    if (!pattern.test(q)) continue;
    for (const domain of domains) out.add(domain);
  }
  return [...out];
}

function inferDomainGroups(domains: string[], resourceType: ResourceType): string[] {
  // 与 Python router registry.DOMAIN_GROUPS 一比一对齐（2026-09-11 移植收口）：
  // productivity 组补齐 travel/notes/file 三个域（此前落到 general，行程/笔记/文件
  // 类工具在域路由层丢失分组倾向）。
  const groups = new Set<string>();
  if (resourceType === ResourceType.McpServer) groups.add("integration");
  for (const domain of domains) {
    switch (cleanDomain(domain)) {
      case "search":
      case "browser":
        groups.add("information");
        break;
      case "calendar":
      case "reminder":
      case "self":
      case "travel":
      case "notes":
      case "file":
        groups.add("productivity");
        break;
      case "phone":
      case "agent":
        groups.add("communication");
        break;
      case "world":
      case "aip":
        groups.add("coordination");
        break;
      case "wallet":
      case "budget":
      case "shopping":
        groups.add("commerce");
        break;
      case "desktop":
      case "device":
      case "smart_home":
      case "vision":
        groups.add("execution");
        break;
      case "weather":
      case "clock":
        groups.add("signals");
        break;
      case "mcp":
        groups.add("integration");
        break;
      default:
        groups.add("general");
        break;
    }
  }
  if (groups.size === 0) groups.add("general");
  return [...groups];
}

function primaryCapabilityDomain(primaryCapability: string): string {
  return cleanDomain(primaryCapability.split(".")[0]);
}

function buildToolSchema(entry: DeferredToolEntry): Level3ToolSchema {
  const parameters = jsonSchemaToParameters(getFunction(entry.tool)?.parameters, entry.requiredParameters);
  return {
    resource_id: entry.registryName,
    parameters,
    required_fields: parameters.filter((p) => p.required).map((p) => p.name),
    validation_rules: {},
    timeout_ms: 30_000,
  };
}

function buildSkillSchema(entry: DeferredToolEntry): Level3SkillSchema {
  return {
    resource_id: entry.registryName,
    workflow: {
      kind: "single_skill_handler",
      entrypoint: entry.registryName,
    },
    subtools: [],
    branch_conditions: {},
    retry_policy: { max_retries: 0, backoff_ms: 250 },
    fallback_resource_id: null,
  };
}

function buildMcpSchema(entry: DeferredToolEntry): Level3McpSchema {
  const parts = entry.registryName.split(".");
  const alias = parts[1] ?? "default";
  const method = parts.slice(2).join(".") || entry.registryName;
  return {
    resource_id: entry.registryName,
    transport: "stdio",
    endpoint: `mcp://${alias}`,
    rpc_methods: [method],
    auth_config: {},
    pool_size: 4,
    heartbeat_interval_ms: 30_000,
  };
}

function jsonSchemaToParameters(
  parameters: unknown,
  requiredParameters: string[],
): Level3Parameter[] {
  const schema = parameters && typeof parameters === "object" ? parameters as JsonSchemaObject : null;
  const props = schema?.properties && typeof schema.properties === "object"
    ? schema.properties
    : {};
  const required = new Set(requiredParameters);
  const out: Level3Parameter[] = [];
  for (const [name, raw] of Object.entries(props)) {
    const property = raw && typeof raw === "object" ? raw as JsonSchemaObject : {};
    out.push({
      name,
      type: jsonTypeToParameterType(property.type),
      required: required.has(name),
      description: typeof property.description === "string" ? property.description : undefined,
      enum: Array.isArray(property.enum) ? property.enum : undefined,
    });
  }
  return out;
}

type JsonSchemaObject = {
  type?: unknown;
  properties?: Record<string, unknown>;
  required?: unknown;
  description?: unknown;
  enum?: unknown[];
};

function jsonTypeToParameterType(type: unknown): Level3Parameter["type"] {
  if (type === "number" || type === "integer") return "number";
  if (type === "boolean") return "boolean";
  if (type === "array") return "array";
  if (type === "object") return "object";
  return "string";
}

function getFunction(tool: ChatCompletionTool): FunctionToolDefinition | null {
  if (tool.type !== "function") return null;
  const maybeFunction = (tool as { function?: FunctionToolDefinition }).function;
  return maybeFunction?.name ? maybeFunction : null;
}

/**
 * Fast path：常见 query 跳过 IntentRouter（同步 regex 匹配，0 async cost）。
 * 覆盖高频查询：天气、时间、搜索、余额、日程等。
 */
function tryFastPathIntent(query: string): ParsedIntent | null {
  const q = query.toLowerCase().trim();
  const ro: QueryConstraints = { max_latency_ms: 200, read_only: true, file_type: null, auth_level: "guest" };
  const rw: QueryConstraints = { max_latency_ms: 200, read_only: false, file_type: null, auth_level: "default" };

  if (/\bweather\b|\b天气\b|\bforecast\b|\b温度\b|\btemperature\b/.test(q)) {
    return { intent: "天气查询", domain_candidates: ["weather"], primary_capability: "weather.query", confidence: 0.95, query_constraints: ro, param_extract: {}, is_compound_task: false, sub_intents: [] };
  }
  // 热搜/热点：BM25 类别表对这类词弱（"热搜"不在任何 prefix/alias 强信号里），
  // 曾被路由到 clock/shopping——意图层显式收编（2026-09-11 golden 实证）
  if (/热搜|热点|热榜| trending|\btrending\b|大家都在看/.test(q)) {
    return { intent: "热搜查询", domain_candidates: ["search"], primary_capability: "search.query", confidence: 0.9, query_constraints: ro, param_extract: {}, is_compound_task: false, sub_intents: [] };
  }
  if (/\btime\b|\bdate\b|\b时间\b|\b日期\b|\bclock\b/.test(q)) {
    return { intent: "时间查询", domain_candidates: ["clock"], primary_capability: "clock.query", confidence: 0.95, query_constraints: ro, param_extract: {}, is_compound_task: false, sub_intents: [] };
  }
  if (/\bsearch\b|\b搜索\b|\b查找\b|\bfind\b|\bgoogle\b/.test(q) && !/天气|weather/.test(q)) {
    return { intent: "搜索", domain_candidates: ["search", "browser"], primary_capability: "search.query", confidence: 0.92, query_constraints: ro, param_extract: {}, is_compound_task: false, sub_intents: [] };
  }
  if (/\bcalendar\b|\bschedule\b|\bmeeting\b|\b日程\b|\b会议\b|\b日历\b/.test(q)) {
    return { intent: "日程查询", domain_candidates: ["calendar"], primary_capability: "calendar.query", confidence: 0.9, query_constraints: ro, param_extract: {}, is_compound_task: false, sub_intents: [] };
  }
  if (/\bbalance\b|\b余额\b|\bwallet\b|\b钱包\b|\b账户\b/.test(q)) {
    return { intent: "余额查询", domain_candidates: ["wallet"], primary_capability: "wallet.query", confidence: 0.92, query_constraints: ro, param_extract: {}, is_compound_task: false, sub_intents: [] };
  }
  if (/\bremind\b|\btodo\b|\btasks?\b|\b提醒\b|\b待办\b/.test(q)) {
    return { intent: "待办查询", domain_candidates: ["reminder", "calendar"], primary_capability: "reminder.query", confidence: 0.88, query_constraints: ro, param_extract: {}, is_compound_task: false, sub_intents: [] };
  }
  if (/\bphone\b|\bcall\b|\b打电话\b|\b电话\b|\b手机\b/.test(q)) {
    return { intent: "电话查询", domain_candidates: ["phone"], primary_capability: "phone.query", confidence: 0.9, query_constraints: rw, param_extract: {}, is_compound_task: false, sub_intents: [] };
  }
  if (/\bmcp\b|\bintegration\b|\b服务器\b|\bserver\b/.test(q)) {
    return { intent: "MCP 工具查询", domain_candidates: ["mcp", "misc"], primary_capability: "mcp.query", confidence: 0.85, query_constraints: ro, param_extract: {}, is_compound_task: false, sub_intents: [] };
  }
  if (/\bskill\b|\b技能\b|\bcapabilit(?:y|ies)\b|\b能力\b/.test(q)) {
    return { intent: "技能查询", domain_candidates: ["self", "agent"], primary_capability: "self.query", confidence: 0.85, query_constraints: ro, param_extract: {}, is_compound_task: false, sub_intents: [] };
  }

  return null;
}

function topPForIntent(intent: ParsedIntent): number {
  if (intent.confidence > 0.85) return 0.7;
  if (intent.confidence > 0.6) return 0.9;
  return 0.95;
}

// 目录签名按对象记忆化：deferred 目录每轮由全量目录派生（对象内容不可变），
// 同一对象内的多次取签名（索引缓存/图服务/边强化各有 key）只算一次排序+sha1。
// 每轮首次仍 O(N log N)——101 工具无感；数千工具时如成为热点，应由
// deriveDeferredCatalog 直接携带全量签名+子集指纹来增量化。
const catalogSignatureMemo = new WeakMap<DeferredToolCatalog, string>();

function catalogSignature(catalog: DeferredToolCatalog): string {
  const memoed = catalogSignatureMemo.get(catalog);
  if (memoed) return memoed;
  const hash = createHash("sha1");
  for (const entry of [...catalog.entries].sort((a, b) =>
    a.registryName.localeCompare(b.registryName),
  )) {
    hash.update(entry.registryName);
    hash.update("\0");
    hash.update(String(entry.parameterNames.length));
    hash.update("\0");
    hash.update(String(entry.requiredParameters.length));
    hash.update("\0");
  }
  // embedding 缓存指纹：后台补全的向量落盘后 builtAt/模型变化 → 新目录对象
  // 换签名 → 索引重建带上真向量。没有它，语义通道要等工具集变化或重启才生效
  //（2026-09-11 N1 落地时实证：同签名索引缓存复用会一直持有 hash 占位向量）。
  const emb = getToolEmbeddingCache();
  hash.update(`|emb:${emb.meta.model}:${emb.meta.builtAt}:${Object.keys(emb.entries).length}`);
  const signature = hash.digest("hex");
  catalogSignatureMemo.set(catalog, signature);
  return signature;
}

function hashTextToVector(text: string, dim: number): number[] {
  const out = new Array<number>(dim).fill(0);
  const tokens = text.toLowerCase().match(/[\u4e00-\u9fa5]+|[a-z0-9_.-]+/g) ?? [text];
  for (const token of tokens) {
    const hash = createHash("sha256").update(token).digest();
    for (let i = 0; i < dim; i++) {
      const byte = hash[i % hash.length] ?? 0;
      out[i] += byte / 127.5 - 1;
    }
  }
  const norm = Math.sqrt(out.reduce((sum, value) => sum + value * value, 0));
  return norm > 0 ? out.map((value) => value / norm) : out;
}

function namespaceToDomain(namespace: string): string {
  const map: Record<string, string> = {
    fetch: "search",
    search: "search",
    info: "search",
    agent: "agent",
    aip: "aip",
    browser: "browser",
    calendar: "calendar",
    clock: "clock",
    desktop: "desktop",
    phone: "phone",
    reminder: "reminder",
    shopping: "shopping",
    wallet: "wallet",
    weather: "weather",
    world: "world",
    self: "self",
    smart: "smart_home",
    device: "device",
    voice: "voice",
    vision: "vision",
  };
  return map[namespace] ?? cleanDomain(namespace || "misc");
}

function firstNamespace(name: string): string {
  if (name === "search_web") return "search";
  if (name === "fetch_web") return "fetch";
  return name.split(/[._-]/)[0]?.toLowerCase() ?? "misc";
}

function cleanDomain(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "misc";
}

function cleanCapability(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "");
}

function pushIndex(map: Map<string, string[]>, key: string, id: string): void {
  const list = map.get(key);
  if (list) {
    if (!list.includes(id)) list.push(id);
    return;
  }
  map.set(key, [id]);
}

function emptySummary(): AdaptiveCatalogSummary {
  return {
    total: 0,
    resource_types: {
      [ResourceType.Tool]: 0,
      [ResourceType.Skill]: 0,
      [ResourceType.McpServer]: 0,
    },
    domains: {},
    capabilities: {},
  };
}

function countSummary(summary: AdaptiveCatalogSummary, record: ResourceRecord): void {
  summary.total += 1;
  summary.resource_types[record.level1.resource_type] += 1;
  for (const domain of record.level1.domain) {
    summary.domains[domain] = (summary.domains[domain] ?? 0) + 1;
  }
  for (const capability of record.level1.capability) {
    summary.capabilities[capability] = (summary.capabilities[capability] ?? 0) + 1;
  }
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
