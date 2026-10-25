import { getDataDir } from "../config/data-dir.js";
import { join } from "node:path";

import { envBool } from "../config/memory-env.js";
import { isPlaceholderApiKey } from "../config/api-key-validator.js";
// 统一嵌入模型解析：AGENT_EMBEDDING_MODEL → OPENAI_EMBEDDINGS_MODEL → 默认，
// 与 humanLike / narrative-hybrid / forgotten 等通道保持同一模型（阈值与分数才可比）。
import { resolveEmbeddingModel } from "../services/openai-embedding-client.js";

function envPositiveInt(name: string, fallback: number): number {
  const v = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

function envPositiveFloat(name: string, fallback: number): number {
  const v = Number.parseFloat(process.env[name] ?? "");
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export function isAgenticMemoryEnabled(): boolean {
  return envBool("AGENT_AGENTIC_MEMORY_ENABLED", true);
}

export function getAgenticMemoryDir(): string {
  return (
    process.env.AGENT_AGENTIC_MEMORY_DIR?.trim() ||
    join(getDataDir(), "agentic_memory")
  );
}

export function getAgenticMemoryCollection(): string {
  return process.env.AGENT_AGENTIC_MEMORY_COLLECTION?.trim() || "agentic_memories";
}

export function getAgenticMemoryTopK(): number {
  return envPositiveInt("AGENT_AGENTIC_MEMORY_TOP_K", 8);
}

export function getAgenticMemorySearchTopK(): number {
  return envPositiveInt("AGENT_AGENTIC_MEMORY_SEARCH_TOP_K", 30);
}

export function getAgenticMemoryEmbeddingModel(): string {
  return resolveEmbeddingModel();
}

/**
 * 解析可用的 Embedding 端点已统一收敛到 openai-embedding-client 的
 * resolveEmbeddingEndpoint（显式远端 → 本地内置引擎）。旧的
 * getAgenticMemoryEmbeddingBaseUrl/resolveEmbeddingApiKey 启发式已删——
 * 不要再从本文件恢复「拿 OPENAI_BASE_URL 兜底嵌入」的逻辑。
 */

/** 按模型推导 embedding 维度；AGENT_EMBEDDING_DIMENSIONS 可显式覆盖 */
export function getAgenticMemoryEmbeddingDims(model: string): number {
  const explicit = Number.parseInt(process.env.AGENT_EMBEDDING_DIMENSIONS ?? "", 10);
  if (Number.isInteger(explicit) && explicit > 0) return explicit;
  const m = model.toLowerCase();
  if (m.includes("text-embedding-3-large")) return 3072;
  if (m.includes("text-embedding-3")) return 1536;
  if (m.includes("bge-m3")) return 1024;
  if (m.includes("bge-large")) return 1024;
  if (m.includes("bge-small")) return 512;
  if (m.includes("m3e")) return 1024;
  return 1536;
}

/**
 * 记忆侧 LLM 的模型/端点解析（2026-10-21 单模型统一）：
 * 优先级 = 记忆专用覆盖 → 主聊天 provider（MiniMax）→ 旧 OPENAI_* 兼容。
 *
 * 背景：此前 Mem0/extractor/reranker 走 `OPENAI_API_KEY`（DeepSeek），
 * 主聊天走 MiniMax，等于两个模型 API 同时提供服务。统一后记忆侧调用
 * 与主聊天共用同一 provider；`AGENT_AGENTIC_MEMORY_LLM_*` 仍可单独覆盖。
 */
function activeExternalProvider(): string {
  return (process.env.EXTERNAL_MODEL_PROVIDER ?? "").trim().toLowerCase();
}

/**
 * 「provider 自有键位」映射：只有在这里登记的 provider 才**独占**自己的
 * key/endpoint（绝不回落到 OPENAI_*）。未登记的（openai / auto / failover /
 * 空）继续沿用 OPENAI_* 兼容语义——这是历史行为，改动会打断既有部署。
 *
 * 2026-10-22 新增 deepseek：此前 provider=deepseek 时记忆侧会拿 OPENAI_* 兜底，
 * 而 OPENAI_* 恰好也可能指向别家网关 → 记忆调用打到第二 provider（同一 bug
 * 曾在 minimax 上演过，见本文件下方 origin 注释）。
 */
type ProviderLlmEnv = {
  keyEnv: string;
  baseUrlEnv: string;
  modelEnv: string;
  fallbackModel: string;
  fallbackBaseUrl: string;
};

const PROVIDER_LLM_ENV: Record<string, ProviderLlmEnv> = {
  minimax: {
    keyEnv: "MINIMAX_API_KEY",
    baseUrlEnv: "MINIMAX_BASE_URL",
    modelEnv: "MINIMAX_MODEL",
    fallbackModel: "MiniMax-M3",
    fallbackBaseUrl: "https://api.minimaxi.com/v1",
  },
  deepseek: {
    keyEnv: "DEEPSEEK_API_KEY",
    baseUrlEnv: "DEEPSEEK_BASE_URL",
    modelEnv: "DEEPSEEK_MODEL",
    fallbackModel: "deepseek-flash",
    fallbackBaseUrl: "https://api.deepseek.com/v1",
  },
};

function ownProviderLlmEnv(): ProviderLlmEnv | null {
  return PROVIDER_LLM_ENV[activeExternalProvider()] ?? null;
}

export function getAgenticMemoryLlmModel(): string {
  const explicit = process.env.AGENT_AGENTIC_MEMORY_LLM_MODEL?.trim();
  if (explicit) return explicit;
  const own = ownProviderLlmEnv();
  if (own) return process.env[own.modelEnv]?.trim() || own.fallbackModel;
  return process.env.OPENAI_MODEL?.trim() || "gpt-4o-mini";
}

/**
 * 记忆侧 LLM 的 baseURL：记忆专用覆盖 → 当前 provider 的端点。
 * provider 有自有键位时**不再回落 OPENAI_BASE_URL**（server/.env 里可能残留
 * 指向第二 provider 的地址），否则 OpenAI SDK 会打到别家。
 */
export function resolveAgenticMemoryLlmBaseUrl(): string | undefined {
  const explicit = process.env.AGENT_AGENTIC_MEMORY_LLM_BASE_URL?.trim();
  if (explicit) return explicit;
  const own = ownProviderLlmEnv();
  if (own) return process.env[own.baseUrlEnv]?.trim() || own.fallbackBaseUrl;
  return process.env.OPENAI_BASE_URL?.trim();
}

export function resolveOpenAiApiKey(): string | null {
  const explicit = process.env.AGENT_AGENTIC_MEMORY_LLM_API_KEY?.trim();
  // provider 有自有键位时只认自己的 key：没有就禁用记忆侧 LLM，
  // 绝不偷偷拿 OPENAI key 去请求另一个 provider。
  const own = ownProviderLlmEnv();
  const key = explicit
    ? explicit
    : own
      ? process.env[own.keyEnv]?.trim() || null
      : process.env.OPENAI_API_KEY?.trim() ||
        process.env.AGENT_EMBEDDING_API_KEY?.trim() ||
        null;
  // 防御：占位符 key（sk-placeholder-... 等）不应被当作真 key 传给 mem0ai
  if (isPlaceholderApiKey(key)) return null;
  return key;
}

export function getAgenticMemoryCustomInstructions(): string {
  const custom = process.env.AGENT_AGENTIC_MEMORY_INSTRUCTIONS?.trim();
  if (custom) return custom;
  return [
    "从对话与事件中提取可长期保留的事实、偏好、计划与结论。",
    "保留「前因 → 行动 → 结果」因果链，标注时间、人物与主题，便于跨会话联想。",
    "允许跨主题跳跃：若新信息与旧记忆存在隐含关联（同一项目、同一人物、同一目标），应建立联系而非孤立存储。",
    "合并重复或矛盾信息，用简洁中文陈述；不确定时保留原文线索。",
  ].join("\n");
}

/** 时间衰减半衰期（小时），超期记忆的相关度按指数衰减 */
export function getTimeDecayHalfLifeHours(): number {
  return envPositiveFloat("AGENT_MEMORY_TIME_DECAY_HALF_LIFE_H", 72);
}

/** 高信号记忆的检索加权倍率 */
export function getHighSignalBoost(): number {
  return envPositiveFloat("AGENT_MEMORY_HIGH_SIGNAL_BOOST", 1.5);
}

/**
 * 重要性连续分（importance 0-1）在检索排序中的加成倍率。
 * 最终因子 = 1 + (importance - 0.5) * boost，即 importance=0.5 不增不减、
 * 高分上浮、低分下压。0 = 关闭重要性加权（仅保留 highSignal 布尔加成）。
 */
export function getMemoryImportanceBoost(): number {
  return envPositiveFloat("AGENT_MEMORY_IMPORTANCE_BOOST", 0.6);
}

/**
 * 召回强化是否参与 TTL 豁免：开启后过期判据用 max(createdAt, last_access_at)，
 * 经常被召回的记忆不再因"创建太久"被误删（use-it-or-lose-it）。
 */
export function isMemoryReinforcementEnabled(): boolean {
  return envBool("AGENT_MEMORY_REINFORCEMENT_ENABLED", true);
}

/**
 * 低信号批量整合触发阈值（条数）：memory-consolidation-service 攒够即提前 flush
 * （原 ingest 内置缓冲已删除，阈值语义迁移到统一写入者）。
 */
export function getLowSignalBufferMaxItems(): number {
  return envPositiveInt("AGENT_MEMORY_LOW_SIGNAL_BUFFER_MAX_ITEMS", 10);
}

/** 低信号批量整合触发阈值（字符数） */
export function getLowSignalBufferMaxChars(): number {
  return envPositiveInt("AGENT_MEMORY_LOW_SIGNAL_BUFFER_MAX_CHARS", 8000);
}

/** 召回压缩触发阈值（字符数），超过则调用 LLM 压缩 */
export function getRecallCompressThreshold(): number {
  return envPositiveInt("AGENT_MEMORY_RECALL_COMPRESS_THRESHOLD", 2500);
}

/**
 * 记忆常规 TTL（天），超过此天数的低重要性记忆可被清理。0=不清理。
 * 分类 TTL：temporary_context 类走 getMemoryTTLTemporaryDays（7 天），
 * stable_* 类豁免（核心事实永久），其余走本值（设计文档「常规信息 TTL=90 天」）。
 */
export function getMemoryTTLDays(): number {
  return envPositiveInt("AGENT_MEMORY_TTL_DAYS", 90);
}

/** 临时信息 TTL（天）：temporary_context 类记忆的有效期（「临时信息 TTL=7 天」）。 */
export function getMemoryTTLTemporaryDays(): number {
  return envPositiveInt("AGENT_MEMORY_TTL_TEMPORARY_DAYS", 7);
}

/**
 * 归档保留天数（两阶段遗忘）：TTL 到期/LLM 判弃的记忆先归档（召回侧过滤，
 * 可恢复），超过此天数才物理删除。0=归档后不自动物理删（仅手动清空时回收）。
 */
export function getMemoryArchiveRetentionDays(): number {
  return envPositiveInt("AGENT_MEMORY_ARCHIVE_RETENTION_DAYS", 14);
}

/** Mem0 库 LLM 定期审查开关：判断过时/矛盾/冗余，命中者归档（不直接删）。 */
export function isMemoryLlmReviewEnabled(): boolean {
  return envBool("AGENT_MEMORY_LLM_REVIEW_ENABLED", true);
}

/** LLM 审查间隔（小时） */
export function getMemoryLlmReviewIntervalHours(): number {
  return envPositiveInt("AGENT_MEMORY_LLM_REVIEW_INTERVAL_H", 24);
}

/** LLM 审查每批条数（按最久未访问优先抽取） */
export function getMemoryLlmReviewBatchSize(): number {
  return envPositiveInt("AGENT_MEMORY_LLM_REVIEW_BATCH", 40);
}

/** 生命周期清理间隔（分钟） */
export function getLifecycleIntervalMin(): number {
  return envPositiveInt("AGENT_MEMORY_LIFECYCLE_INTERVAL_MIN", 360);
}

/** 去重相似度阈值（0-1），高于此值视为重复记忆 */
export function getDedupSimilarityThreshold(): number {
  return envPositiveFloat("AGENT_MEMORY_DEDUP_SIMILARITY_THRESHOLD", 0.92);
}

/**
 * 语义去重每轮最多执行的向量检索次数（embedding API 限流阀）。
 * 存量记忆多时首轮不会一次性全扫，按游标分批消化。
 */
export function getDedupMaxChecksPerCycle(): number {
  return envPositiveInt("AGENT_MEMORY_DEDUP_MAX_CHECKS_PER_CYCLE", 50);
}

// ── 短期→长期植入评分闸门（unified-extractor 五维评分） ──

/**
 * 植入线：五维综合分 ≥ 此值的记忆才允许 remember（植入长期库）。
 * 0.45 ≈ 「明天下午开会」级别的临时事项落在线下（decay）、长期事实在线上。
 */
export function getMemoryPromoteThreshold(): number {
  return envPositiveFloat("AGENT_MEMORY_PROMOTE_THRESHOLD", 0.45);
}

/** 无用线：五维综合分 < 此值判为无用消息，一律 reject（不进任何持久层） */
export function getMemoryUselessThreshold(): number {
  return envPositiveFloat("AGENT_MEMORY_USELESS_THRESHOLD", 0.3);
}

/** remember 的持久性下限：转瞬即逝的内容（今天天气/今天心情）无论多强烈最多 decay */
export function getMemoryPersistenceFloor(): number {
  return envPositiveFloat("AGENT_MEMORY_PERSISTENCE_FLOOR", 0.4);
}

export function getSleepAgentEnabled(): boolean {
  return envBool("AGENT_MEMORY_SLEEP_AGENT_ENABLED", true);
}

// ============================================================
// 方案 A：记忆层间打通（memory-bridge）
// ============================================================

/** 桥接层开关（缺省开；关闭后 narrative 写入/召回回退旧双写行为） */
export function isMemoryBridgeEnabled(): boolean {
  return envBool("AGENT_MEMORY_BRIDGE_ENABLED", true);
}

/** 遗忘同步扫描间隔（分钟，0=关闭定时器，仅手动调用 syncForgetting） */
export function getBridgeForgetSyncIntervalMin(): number {
  const v = Number.parseInt(process.env.AGENT_MEMORY_BRIDGE_FORGET_SYNC_INTERVAL_MIN ?? "", 10);
  return Number.isFinite(v) && v >= 0 ? v : 30;
}

/** 融合召回最终保留条数 */
export function getBridgeFusedTopK(): number {
  return envPositiveInt("AGENT_MEMORY_BRIDGE_FUSED_TOP_K", 8);
}

// ============================================================
// 方案 B：语义账本（ledger）
// ============================================================

export function isAgenticLedgerEnabled(): boolean {
  return envBool("AGENT_MEMORY_LEDGER_ENABLED", true);
}

/** 账本保留策略：superseded/作废超过 N 天物理删除；0=永保留 */
export function getLedgerRetentionDays(): number {
  return envPositiveInt("AGENT_MEMORY_LEDGER_RETENTION_DAYS", 180);
}

// ============================================================
// 用户理解档案（User Understanding Store）
// ============================================================

export function isUserUnderstandingEnabled(): boolean {
  return envBool("AGENT_USER_UNDERSTANDING_ENABLED", true);
}

// ============================================================
// 结构化事实库（Structured Fact Store）
// ============================================================

export function isStructuredFactsEnabled(): boolean {
  return envBool("AGENT_STRUCTURED_FACTS_ENABLED", true);
}

// ============================================================
// 方案 D：溯源作废（provenance）
// ============================================================

export function isProvenanceEnabled(): boolean {
  return envBool("AGENT_MEMORY_PROVENANCE_ENABLED", true);
}

// ============================================================
// FTS 关键词第三路（混合检索）：SQLite FTS5 全文索引，补齐
// BM25 词面路——专名/技术栈/型号等低语义密度 query 上向量检索弱、
// 词法匹配强。空索引/关闭时无结果，对召回链路无害。
// ============================================================

export function isMemoryFtsEnabled(): boolean {
  return envBool("AGENT_MEMORY_FTS_ENABLED", true);
}

/** FTS 路进入 bridge RRF 的候选条数（rank 列表长度，与 mem0/graph 路可比即可） */
export function getMemoryFtsTopK(): number {
  return envPositiveInt("AGENT_MEMORY_FTS_TOP_K", 12);
}

// ============================================================
// 召回精排（Cross-Encoder / LLM Reranker）：对融合后的候选做
// query-memory 联合编码打分，取头部注入——粗排（向量+RRF）快但不准，
// 精排补齐语义相关性。默认 off（灰度安全）；超时/失败一律透传原序。
// ============================================================

export type MemoryRerankerMode = "off" | "llm" | "api";

/**
 * 精排档位：
 *   off = 关闭（默认，行为与旧版完全一致）；
 *   llm = 复用对话 LLM 做 listwise 相关性打分（零基建，一次调用，~300-800ms）；
 *   api = 专用 rerank 端点（bge-reranker 等，Jina/Cohere 风格 /rerank）。
 */
export function getMemoryRerankerMode(): MemoryRerankerMode {
  const raw = process.env.AGENT_MEMORY_RERANKER?.trim().toLowerCase();
  return raw === "llm" || raw === "api" ? raw : "off";
}

/** api 档端点（完整 URL，POST {model, query, documents}）；未配置时 api 档降级为 off */
export function getMemoryRerankerEndpoint(): string | null {
  return process.env.AGENT_MEMORY_RERANKER_ENDPOINT?.trim() || null;
}

export function getMemoryRerankerModel(): string {
  return process.env.AGENT_MEMORY_RERANKER_MODEL?.trim() || "bge-reranker-v2-m3";
}

/** rerank 端点 Key：优先专用 Key，其次对话 Key */
export function getMemoryRerankerApiKey(): string | null {
  const key =
    process.env.AGENT_MEMORY_RERANKER_API_KEY?.trim() ||
    process.env.OPENAI_API_KEY?.trim() ||
    null;
  if (isPlaceholderApiKey(key)) return null;
  return key;
}

/** 精排超时（毫秒）：超时/失败返回 null，调用方透传原序（降级零开销） */
export function getMemoryRerankerTimeoutMs(): number {
  return envPositiveInt("AGENT_MEMORY_RERANKER_TIMEOUT_MS", 800);
}

/** 进入精排的候选池上限（取融合排序头部；控制 LLM 档 token 成本与 api 档延迟） */
export function getMemoryRerankerCandidates(): number {
  return envPositiveInt("AGENT_MEMORY_RERANKER_CANDIDATES", 24);
}

/** relevance 低于此值的条目丢弃（精排档的「召回后验证」闸，0=不丢弃） */
export function getMemoryRerankerMinScore(): number {
  const v = Number.parseFloat(process.env.AGENT_MEMORY_RERANKER_MIN_SCORE ?? "");
  return Number.isFinite(v) && v >= 0 && v < 1 ? v : 0.15;
}
