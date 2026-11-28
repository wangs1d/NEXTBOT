export type ToolSearchEnabledMode = "auto" | "on" | "off";

export type ToolSearchEmbeddingMode = "auto" | "on" | "off";

/** 神经 embedding provider（docs/neural-retrieval-plan.md N1） */
export type ToolEmbeddingProviderMode = "auto" | "local" | "openai";

export type NeuralFeatureMode = "auto" | "on" | "off";

function parseEnabledMode(raw: string | undefined): ToolSearchEnabledMode {
  const v = raw?.trim().toLowerCase();
  if (!v || v === "auto") return "auto";
  if (v === "0" || v === "off" || v === "false" || v === "no") return "off";
  if (v === "1" || v === "on" || v === "true" || v === "yes") return "on";
  return "auto";
}

function parseEmbeddingMode(raw: string | undefined): ToolSearchEmbeddingMode {
  const v = raw?.trim().toLowerCase();
  if (!v || v === "auto") return "auto";
  if (v === "0" || v === "off" || v === "false" || v === "no") return "off";
  if (v === "1" || v === "on" || v === "true" || v === "yes") return "on";
  return "auto";
}

function parseEmbeddingProvider(raw: string | undefined): ToolEmbeddingProviderMode {
  const v = raw?.trim().toLowerCase();
  if (v === "local" || v === "sidecar") return "local";
  if (v === "openai" || v === "api") return "openai";
  return "auto";
}

function parseNeuralFeatureMode(raw: string | undefined): NeuralFeatureMode {
  const v = raw?.trim().toLowerCase();
  if (!v || v === "auto") return "auto";
  if (v === "0" || v === "off" || v === "false" || v === "no") return "off";
  if (v === "1" || v === "on" || v === "true" || v === "yes") return "on";
  return "auto";
}

let _configCache: ReturnType<typeof buildToolSearchConfig> | null = null;

/**
 * 模块级记忆化：配置是启动期 env 的纯函数，热路径（每次检索多处读取）此前每次
 * 都全量 parse env + clamp——微秒级但高频。测试需改 env 后重读时调用
 * {@link resetToolSearchConfigForTests}（golden/coverage 均在 import 前设 env，不受影响）。
 */
export function getToolSearchConfig() {
  if (!_configCache) _configCache = buildToolSearchConfig();
  return _configCache;
}

/** 单元测试重置配置缓存。 */
export function resetToolSearchConfigForTests(): void {
  _configCache = null;
}

function buildToolSearchConfig() {
  return {
    // 2026-09-11：检索管线收敛为进程内 adaptive（Python tool-router 已删除）
    enabled: parseEnabledMode(process.env.AGENT_TOOL_SEARCH_ENABLED),
    thresholdPct: clampInt(process.env.AGENT_TOOL_SEARCH_THRESHOLD_PCT, 10, 0, 100),
    searchDefaultLimit: clampInt(process.env.AGENT_TOOL_SEARCH_DEFAULT_LIMIT, 5, 1, 50),
    maxSearchLimit: clampInt(process.env.AGENT_TOOL_SEARCH_MAX_LIMIT, 20, 1, 50),
    contextTokens: clampInt(process.env.AGENT_TOOL_SEARCH_CONTEXT_TOKENS, 32_000, 2_000, 2_000_000),
    /** merged 模式下 search 是否自动为 top-1 附带完整 schema（省一轮 describe） */
    discoverAutoSchemaTop1: parseBool(process.env.AGENT_TOOL_SEARCH_DISCOVER_AUTO_SCHEMA, true),
    /**
     * Embedding 召回模式（hybrid: BM25 + 余弦相似度 → RRF 融合）。
     *   - auto: 优先用磁盘缓存 + 可用 OPENAI_API_KEY 自动启用；缺失则降级纯 BM25
     *   - on: 强制启用；缺 key 报错
     *   - off: 禁用，仅用 BM25
     */
    embedding: parseEmbeddingMode(process.env.AGENT_TOOL_SEARCH_EMBEDDING),
    /** 工具 embedding 召回用的模型；缺省 text-embedding-3-small（1536 维） */
    embeddingModel: process.env.AGENT_TOOL_SEARCH_EMBEDDING_MODEL?.trim() || "text-embedding-3-small",
    /** 缓存文件路径，缺省 data/tool-embeddings.json */
    embeddingCachePath: process.env.AGENT_TOOL_SEARCH_EMBEDDING_CACHE?.trim() || "",
    /** 召回融合时 embedding ranking 的权重（0~1，剩余权重给 BM25 + 其他 ranking） */
    embeddingRankWeight: clampFloat(process.env.AGENT_TOOL_SEARCH_EMBEDDING_WEIGHT, 0.55, 0, 1),
    /** 触发 embedding 召回的最小工具数（避免小工具集上浪费 RTT） */
    embeddingMinTools: clampInt(process.env.AGENT_TOOL_SEARCH_EMBEDDING_MIN_TOOLS, 12, 1, 1000),
    /**
     * 动态筛选：绝对下限。cosine 低于此值的工具直接丢弃。
     * 0.20 ≈ 弱相关，适合宽松召回；0.30 ≈ 中等相关，适合精确召回。
     */
    embeddingDynamicFloor: clampFloat(process.env.AGENT_TOOL_SEARCH_EMBEDDING_FLOOR, 0.20, 0, 1),
    /**
     * 动态筛选：相对比例。仅保留 score >= maxScore * ratio 的结果。
     * 0.60 = 保留 top score 60% 以上的；越低越宽松。
     */
    embeddingDynamicRatio: clampFloat(process.env.AGENT_TOOL_SEARCH_EMBEDDING_RATIO, 0.60, 0, 1),
    /** 动态筛选：安全上限，防止极宽 query 候选爆炸 */
    embeddingDynamicMaxKeep: clampInt(process.env.AGENT_TOOL_SEARCH_EMBEDDING_MAX_KEEP, 30, 1, 200),

    // ===== 神经级检索（docs/neural-retrieval-plan.md，本地 sidecar 常驻 HTTP）=====

    /**
     * Embedding provider 链（N1）：
     *   - local：仅本地 BGE，失败回落 BM25；
     *   - auto：本地优先，失败回落 OpenAI API；
     *   - openai：仅远端，显式回滚开关。
     */
    embeddingProvider: parseEmbeddingProvider(process.env.AGENT_TOOL_EMBEDDING_PROVIDER),
    /** 神经 sidecar 基地址（FastAPI 常驻） */
    neuralSidecarUrl:
      (process.env.AGENT_NEURAL_SIDECAR_URL?.trim() || "http://127.0.0.1:8790").replace(/\/+$/, ""),
    /** 本地 embedding 模型名（缓存键用；以本地端点返回为准，此值仅作首查前提示） */
    neuralEmbedModel: process.env.AGENT_NEURAL_EMBED_MODEL?.trim() || "bge-small-zh-v1.5",
    /** N1/N2/N3 各自独立开关（off = 注入点直接不挂载，回滚用） */
    neuralEmbedEnabled: parseNeuralFeatureMode(process.env.AGENT_NEURAL_EMBED_ENABLED),
    neuralRerankEnabled: parseNeuralFeatureMode(process.env.AGENT_NEURAL_RERANK_ENABLED),
    /** 各端点独立超时预算；rerank 仅对歧义候选触发 */
    neuralEmbedTimeoutMs: clampInt(process.env.AGENT_NEURAL_EMBED_TIMEOUT_MS, 300, 50, 5_000),
    /**
     * 批量工具向量补全的超时预算：与查询热路径分开——单块 ≤32 条长文本，
     * 且可能是 sidecar 冷启动后第一个请求（含模型懒加载），需要秒级预算。
     */
    neuralEmbedBulkTimeoutMs: clampInt(process.env.AGENT_NEURAL_EMBED_BULK_TIMEOUT_MS, 10_000, 100, 120_000),
    /** CPU 上 6 个长候选仍有秒级长尾，2.5s 预算避免一次抖动触发熔断。 */
    neuralRerankTimeoutMs: clampInt(process.env.AGENT_NEURAL_RERANK_TIMEOUT_MS, 2_500, 50, 5_000),
    /** 熔断：连续失败 N 次开闸、冷却 M ms（沿用 router-endpoint-guard 数值经验） */
    neuralBreakerThreshold: clampInt(process.env.AGENT_NEURAL_BREAKER_THRESHOLD, 2, 1, 10),
    neuralBreakerCooldownMs: clampInt(process.env.AGENT_NEURAL_BREAKER_COOLDOWN_MS, 60_000, 1_000, 600_000),
    /**
     * ANN 索引（N4）：目录规模 ≥ 此值时 embedding 全量扫描换 HNSW（可选依赖
     * hnswlib-node，未安装/加载失败自动回落暴力扫描）。off 强制暴力、on 强制 ANN。
     */
    annMode: parseNeuralFeatureMode(process.env.AGENT_TOOL_SEARCH_ANN),
    annMinTools: clampInt(process.env.AGENT_TOOL_SEARCH_ANN_MIN_TOOLS, 2_000, 1, 1_000_000),
  };
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  const v = raw?.trim().toLowerCase();
  if (!v) return fallback;
  if (v === "0" || v === "off" || v === "false" || v === "no") return false;
  if (v === "1" || v === "on" || v === "true" || v === "yes") return true;
  return fallback;
}

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = raw ? Number.parseInt(raw, 10) : fallback;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function clampFloat(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = raw ? Number.parseFloat(raw) : fallback;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
