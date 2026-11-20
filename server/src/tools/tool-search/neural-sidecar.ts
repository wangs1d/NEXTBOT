/**
 * 神经检索 sidecar 客户端（docs/neural-retrieval-plan.md N1/N2/N3 的 TS 侧统一入口）。
 *
 * 边界军规（in-process-tool-search.md §5）在本模块的落点：
 *   - 常驻 HTTP JSON，绝不 spawn、不建长连接；
 *   - 每端点独立超时预算（embed 300ms / rerank 400ms / intent 300ms）；
 *   - 连续失败熔断（默认 2 次开闸、冷却 60s），开闸期零网络调用；
 *   - 一切失败返回 null 由调用方降级，绝不抛错阻塞检索主链路；
 *   - 模型无状态，缓存/学习状态留在 TS 侧。
 *
 * 所有对外函数都不抛错：sidecar 不可用 = 质量降级，不是故障。
 */
import { getToolSearchConfig } from "./env.js";
import { ensureLocalEmbeddingEndpoint, getLocalEmbeddingEndpoint } from "../../agentic-memory/local-embedding/local-embedding-endpoint.js";
import {
  toolSearchMetrics,
  type NeuralMetricFeature,
} from "./observability/metrics.js";

export type NeuralFeature = NeuralMetricFeature;

export type NeuralEmbedResult = {
  model: string;
  dim: number;
  vectors: number[][];
};

export type NeuralRerankResult = {
  model: string;
  /** 与 documents 等长，按传入顺序对应 */
  scores: number[];
};


/**
 * 域标签向量缓存（N3 热路径优化）：labels 是静态词表（TOOL_CATEGORIES 派生），
 * 逐请求让 sidecar 重编码 18 条文本 ≈100ms 且与 embed/rerank 抢 CPU（曾把全开
 * p95 推到 570ms）。这里按模型名缓存预编码向量，请求改传 label_vectors——
 * sidecar 每次只编码 query（~5ms）。缓存是模型派生的纯函数值，不含业务状态
 * （状态归 Node 军规不破）。
 */
const _labelVectorCache = new Map<string, Record<string, number[]>>();
const _labelVectorInflight = new Map<string, Promise<Record<string, number[]> | null>>();


/**
 * 按特性独立的熔断器：连续 threshold 次失败开闸 cooldown 毫秒，
 * 开闸期 isOpen() 为 true（调用方直接走降级，零网络成本）；任何成功复位。
 *
 * 半开并发保护（2026-09-12 优化）：冷却期满时只放行**一个**探针请求
 * （probing 标志），并发到达的其余请求直接按开闸处理——旧实现把失败计数
 * 降一档放行，高并发下一波请求同时涌向已挂的 sidecar，全部超时后又集体
 * 记失败重新开闸，形成周期性探针风暴。探针落定（成功/失败）后 probing 复位。
 */
class NeuralBreaker {
  private consecutiveFailures = 0;
  private openedAt = 0;
  private probing = false;

  constructor(
    private readonly threshold: number,
    private readonly cooldownMs: number,
  ) {}

  isOpen(now = Date.now()): boolean {
    // 探针在飞：其余请求一律按开闸处理（probing 优先于计数判断，否则放行探针
    // 后计数降档会走进 closed 分支，并发请求照样涌入）
    if (this.probing) return true;
    if (this.consecutiveFailures < this.threshold) return false;
    if (now - this.openedAt >= this.cooldownMs) {
      // 冷却期满：半开，放行单个探针
      this.probing = true;
      return false;
    }
    return true;
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.probing = false;
  }

  recordFailure(now = Date.now()): void {
    this.probing = false;
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.threshold) {
      this.openedAt = now;
      console.warn(
        `[tool-search:neural] 熔断开闸：连续失败 ${this.consecutiveFailures} 次，冷却 ${this.cooldownMs}ms`,
      );
    }
  }
}

let _breakers: Record<NeuralFeature, NeuralBreaker> | null = null;

function breakers(): Record<NeuralFeature, NeuralBreaker> {
  if (!_breakers) {
    const cfg = getToolSearchConfig();
    _breakers = {
      embed: new NeuralBreaker(cfg.neuralBreakerThreshold, cfg.neuralBreakerCooldownMs),
      rerank: new NeuralBreaker(cfg.neuralBreakerThreshold, cfg.neuralBreakerCooldownMs),
      intent: new NeuralBreaker(cfg.neuralBreakerThreshold, cfg.neuralBreakerCooldownMs),
    };
  }
  return _breakers;
}

/** 测试用：重置熔断状态。 */
export function resetNeuralBreakers(): void {
  _breakers = null;
}

/** 特性开关是否挂载（off = 注入点根本不调用，回滚开关）。 */
export function isNeuralFeatureEnabled(feature: NeuralFeature): boolean {
  const cfg = getToolSearchConfig();
  if (feature === "embed") return cfg.neuralEmbedEnabled !== "off";
  return cfg.neuralRerankEnabled !== "off";
}

function isTimedOut(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError" || /timed?out/i.test(error.message))
  );
}

/**
 * 2026-11-20 根修：此前的 embed 一律打 `cfg.neuralSidecarUrl`（默认 8790 的
 * FastAPI 侧车），但本部署根本没有那个服务——所有神经召回静默降级成纯 BM25
 * （实证：tool-embeddings.json 从未生成、日志只有「embed 调用失败」）。
 * 现改为：进程内 bge 侧车（getLocalEmbeddingEndpoint，OpenAI 兼容 /v1）优先，
 * 它有 512 维中文小模型、云端离线可用；没有才回退旧 URL。
 */
async function embedTextsOnce(texts: string[], timeoutMs: number): Promise<NeuralEmbedResult | null> {
  const localTimeout = Math.max(timeoutMs, 2_000);
  // 侧车未拉起时等它就绪（幂等；bootstrap 早期调用的预热正需要这个）
  const local = getLocalEmbeddingEndpoint() ?? (await ensureLocalEmbeddingEndpoint());
  if (local) {
    for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`${local.baseUrl.replace(/\/+$/, "")}/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(local.apiKey ? { Authorization: `Bearer ${local.apiKey}` } : {}),
        },
        body: JSON.stringify({ model: local.model, input: texts }),
        signal: AbortSignal.timeout(localTimeout),
      });
      if (!res.ok) throw new Error(`local embedding HTTP ${res.status}`);
      const json = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
      const vectors = (json.data ?? []).map((d) => d.embedding ?? []).filter((v) => v.length > 0);
      if (vectors.length !== texts.length) throw new Error(`local embedding 数量不匹配 ${vectors.length}/${texts.length}`);
      return { model: local.model, dim: vectors[0]?.length ?? 0, vectors };
    } catch (e) {
      console.info(`[tool-search:neural] 本地 bge 侧车失败（attempt ${attempt + 1}）：${e instanceof Error ? e.message : String(e)}`);
      await new Promise((r2) => setTimeout(r2, 800));
    }
    }
  }
  return null;
}
async function postJson<T>(
  path: string,
  body: unknown,
  timeoutMs: number,
): Promise<T> {
  const cfg = getToolSearchConfig();
  const res = await fetch(`${cfg.neuralSidecarUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`neural sidecar HTTP ${res.status}: ${txt.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

/** 单特性调用包装：熔断检查 + 计数 + 失败静默返回 null。 */
async function guardedCall<T>(
  feature: NeuralFeature,
  run: () => Promise<T>,
): Promise<T | null> {
  if (!isNeuralFeatureEnabled(feature)) return null;
  const breaker = breakers()[feature];
  if (breaker.isOpen()) {
    toolSearchMetrics.recordNeural(feature, "breaker_skip");
    return null;
  }
  try {
    const out = await run();
    breaker.recordSuccess();
    toolSearchMetrics.recordNeural(feature, "ok");
    return out;
  } catch (error) {
    breaker.recordFailure();
    const timedOut = isTimedOut(error);
    toolSearchMetrics.recordNeural(feature, timedOut ? "timeout" : "fallback");
    if (!timedOut) {
      console.warn(
        `[tool-search:neural] ${feature} 调用失败（已降级）:`,
        error instanceof Error ? error.message : String(error),
      );
    }
    return null;
  }
}

/** sidecar 单次 /embed 的批量上限（与 main.py 的 MAX_BATCH 对齐）。 */
const SIDECAR_MAX_BATCH = 64;

/**
 * 批量语义 embedding（N1）：供工具向量后台补全用。
 * 查询热路径请用 neuralEmbedTexts（300ms 预算）——这里用独立的秒级批量预算
 * （单块 ≤32 条长文本，且可能是 sidecar 冷启动的第一个请求，含模型懒加载）。
 */
export async function neuralEmbedTextsBulk(texts: string[]): Promise<NeuralEmbedResult | null> {
  // provider=openai（2026-11-20）：查询与工具向量必须同模型同维度——
  // 本地 bge(512) 与 SiliconFlow bge-large(1024) 不能互算余弦。走远端缓存通道。
  if (getToolSearchConfig().embeddingProvider === "openai") {
    const { fetchOpenAiCompatibleEmbeddings } = await import("../../services/openai-embedding-client.js");
    const out = await guardedCall("embed", () =>
      fetchOpenAiCompatibleEmbeddings({ inputs: texts, model: getToolSearchConfig().embeddingModel, timeoutMs: Math.max(timeoutMs, 3_000) }),
    );
    if (!out || out.vectors.length !== texts.length) return null;
    return { model: getToolSearchConfig().embeddingModel, dim: out.vectors[0]?.length ?? 0, vectors: out.vectors };
  }

  if (texts.length === 0) return { model: "", dim: 0, vectors: [] };
  const timeoutMs = getToolSearchConfig().neuralEmbedBulkTimeoutMs;
  let first: NeuralEmbedResult | null = null;
  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i += 32) {
    const chunk = texts.slice(i, i + 32);
    const part =
      (await guardedCall("embed", () => embedTextsOnce(chunk, timeoutMs))) ??
      (await guardedCall("embed", () =>
        postJson<NeuralEmbedResult>("/embed", { texts: chunk }, timeoutMs),
      ));
    if (!part) return null;
    if (!first) first = part;
    vectors.push(...part.vectors);
  }
  return first ? { ...first, vectors } : null;
}

/**
 * 批量语义 embedding（N1）。texts > 64 自动分块；任一块失败即返回 null
 * （部分成功不留半吊子向量，调用方整体走下一 provider 重来）。
 */
export async function neuralEmbedTexts(texts: string[]): Promise<NeuralEmbedResult | null> {
  // provider=openai（2026-11-20）：查询与工具向量必须同模型同维度——
  // 本地 bge(512) 与 SiliconFlow bge-large(1024) 不能互算余弦。走远端缓存通道。
  if (getToolSearchConfig().embeddingProvider === "openai") {
    const { fetchOpenAiCompatibleEmbeddings } = await import("../../services/openai-embedding-client.js");
    const out = await guardedCall("embed", () =>
      fetchOpenAiCompatibleEmbeddings({ inputs: texts, model: getToolSearchConfig().embeddingModel, timeoutMs: Math.max(timeoutMs, 3_000) }),
    );
    if (!out || out.vectors.length !== texts.length) return null;
    return { model: getToolSearchConfig().embeddingModel, dim: out.vectors[0]?.length ?? 0, vectors: out.vectors };
  }

  if (texts.length === 0) return { model: "", dim: 0, vectors: [] };
  const timeoutMs = getToolSearchConfig().neuralEmbedTimeoutMs;
  let first: NeuralEmbedResult | null = null;
  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i += SIDECAR_MAX_BATCH) {
    const chunk = texts.slice(i, i + SIDECAR_MAX_BATCH);
    const part =
      (await guardedCall("embed", () => embedTextsOnce(chunk, timeoutMs))) ??
      (await guardedCall("embed", () =>
        postJson<NeuralEmbedResult>("/embed", { texts: chunk }, timeoutMs),
      ));
    if (!part) return null;
    if (!first) first = part;
    vectors.push(...part.vectors);
  }
  return first ? { ...first, vectors } : null;
}

/** 交叉编码重排（N2）：scores 与 documents 等长、按传入顺序对应。 */
export async function neuralRerank(
  query: string,
  documents: string[],
  topK?: number,
): Promise<NeuralRerankResult | null> {
  if (documents.length === 0) return null;
  const timeoutMs = getToolSearchConfig().neuralRerankTimeoutMs;
  return guardedCall("rerank", () =>
    postJson<NeuralRerankResult>("/rerank", { query, documents, top_k: topK }, timeoutMs),
  );
}

/** 健康探测（测试/运维用）：模型已加载返回 true，不可达/未就绪返回 false。 */
export async function probeNeuralSidecar(timeoutMs = 750): Promise<boolean> {
  try {
    const cfg = getToolSearchConfig();
    const res = await fetch(`${cfg.neuralSidecarUrl}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { ok?: boolean; warm?: boolean };
    return Boolean(data.ok ?? data.warm);
  } catch {
    return false;
  }
}
