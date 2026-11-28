/**
 * 工具 embedding 召回（hybrid: BM25 + 余弦相似度 → RRF 融合）。
 *
 * 关键设计：
 *   - 工具 description 变化时才重新算 embedding（按 text hash 缓存）
 *   - 磁盘 JSON 缓存（data/tool-embeddings.json），避免服务重启后全量重算
 *   - 启动时按需懒加载：首次 searchDeferredTools 时尝试加载 cache，缺失的工具 background 预计算
 *   - provider 链（N1，docs/neural-retrieval-plan.md）：
 *       AGENT_TOOL_EMBEDDING_PROVIDER = local → 仅本地 bge，失败降级纯 BM25；
 *       auto → 本地优先，失败回落 OpenAI API；= openai → 仅远端（回滚开关）
 *   - 缓存条目与 query LRU 都带模型名：本地 bge（512 维）与远端模型隔离，
 *     读取缓存时同时校验模型和维度
 *
 * 流程：
 *   buildDeferredCatalog → 标记每个 entry 预计算状态
 *   searchDeferredTools → 若任一 entry 待 embedding → 触发后台批量补全
 *                       → 下一次 search 即可用 hybrid
 */

import { resolveDataPath } from "../../config/data-dir.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";

import type { ChatCompletionTool } from "openai/resources/chat/completions";

import {
  LOCAL_EMBEDDING_DIMS,
  LOCAL_EMBEDDING_MODEL_ID,
} from "../../agentic-memory/local-embedding/local-embedding-engine.js";
import { getLocalEmbeddingEndpoint } from "../../agentic-memory/local-embedding/local-embedding-endpoint.js";
import { fetchOpenAiCompatibleEmbedding } from "../../services/openai-embedding-client.js";
import { getToolSearchConfig } from "./env.js";
import { getToolIntentMetadata } from "./intent-metadata.js";
import { neuralEmbedTexts, neuralEmbedTextsBulk } from "./neural-sidecar.js";

export type ToolEmbeddingViewKind = "definition" | "parameters" | "exemplar";

export type ToolEmbeddingViewInput = {
  key: string;
  kind: ToolEmbeddingViewKind;
  text: string;
};

export type ToolEmbeddingView = {
  key: string;
  kind: ToolEmbeddingViewKind;
  contentHash: string;
  vector: number[];
};

export type ToolEmbeddingCacheEntry = {
  contentHash: string;
  model: string;
  views: ToolEmbeddingView[];
  updatedAt: number;
};

export type ToolEmbeddingCache = {
  schemaVersion: 2;
  entries: Record<string, ToolEmbeddingCacheEntry>;
  meta: {
    model: string;
    dimension: number;
    builtAt: number;
  };
};

const DEFAULT_CACHE_PATH = resolveDataPath("tool-embeddings-v2.json");

let _cache: ToolEmbeddingCache | null = null;
let _cacheLoaded = false;
let _pendingComputePromise: Promise<{ computed: number; reused: number; failed: number }> | null = null;

function getCachePath(): string {
  const override = getToolSearchConfig().embeddingCachePath;
  return override ? resolveDataPath(override) : DEFAULT_CACHE_PATH;
}

function getApiKey(): string | null {
  return (
    process.env.AGENT_TOOL_SEARCH_EMBEDDING_API_KEY?.trim() ||
    process.env.AGENT_EMBEDDING_API_KEY?.trim() ||
    null
  );
}

function getModel(): string {
  return getToolSearchConfig().embeddingModel;
}

/**
 * 本地 sidecar 最近一次成功返回的模型名（query 缓存键控用）。
 * 首次调用前用 env 提示值兜底——键写错最多导致一次 miss 重算，不会串味。
 */
let _lastLocalEmbedModel: string | null = null;

/** 当前 provider 链期望产出向量的模型名（决定 query LRU 的键与命中判定）。 */
function expectedQueryModel(): string {
  const cfg = getToolSearchConfig();
  if (cfg.embeddingProvider === "openai") return getModel();
  if (cfg.embeddingProvider === "local") {
    return getLocalEmbeddingEndpoint()?.model ?? LOCAL_EMBEDDING_MODEL_ID;
  }
  if (cfg.neuralEmbedEnabled !== "off") {
    return _lastLocalEmbedModel ?? getLocalEmbeddingEndpoint()?.model ?? LOCAL_EMBEDDING_MODEL_ID;
  }
  return getModel();
}

function activeCacheIdentity(): { model: string; dimension: number | null } {
  const model = expectedQueryModel();
  if (model === LOCAL_EMBEDDING_MODEL_ID) {
    return { model, dimension: LOCAL_EMBEDDING_DIMS };
  }
  const cache = getToolEmbeddingCache();
  return {
    model,
    dimension: cache.meta.model === model ? cache.meta.dimension || null : null,
  };
}

function isActiveCacheEntry(entry: ToolEmbeddingCacheEntry): boolean {
  const active = activeCacheIdentity();
  return (
    entry.model === active.model &&
    entry.views.length > 0 &&
    entry.views.every(
      (view) =>
        view.vector.length > 0 &&
        (active.dimension === null || view.vector.length === active.dimension),
    )
  );
}

/** 工具 searchText 的内容指纹（description / aliases / examples 任何变化都会让 hash 变） */
export function hashSearchText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

export function hashEmbeddingViews(views: ToolEmbeddingViewInput[]): string {
  return hashSearchText(
    JSON.stringify(views.map((view) => [view.key, view.kind, view.text])),
  );
}

function emptyCache(): ToolEmbeddingCache {
  return {
    schemaVersion: 2,
    entries: {},
    meta: { model: expectedQueryModel(), dimension: 0, builtAt: 0 },
  };
}

function loadCacheFromDisk(): ToolEmbeddingCache {
  const path = getCachePath();
  if (!existsSync(path)) return emptyCache();
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as ToolEmbeddingCache;
    if (parsed?.schemaVersion !== 2 || !parsed.entries || !parsed.meta) return emptyCache();
    return parsed;
  } catch (error) {
    console.warn(
      "[tool-embedding] Failed to read cache, starting fresh:",
      error instanceof Error ? error.message : String(error),
    );
    return emptyCache();
  }
}

function saveCacheToDisk(cache: ToolEmbeddingCache): void {
  const path = getCachePath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(cache), "utf8");
  } catch (error) {
    console.warn(
      "[tool-embedding] Failed to write cache:",
      error instanceof Error ? error.message : String(error),
    );
  }
}

export function getToolEmbeddingCache(): ToolEmbeddingCache {
  if (!_cache) {
    _cache = loadCacheFromDisk();
    _cacheLoaded = true;
  }
  return _cache;
}

/** 检查是否启用了 embedding 召回（provider 链上任一 provider 可能可用即算启用） */
export function isEmbeddingSearchEnabled(): boolean {
  const cfg = getToolSearchConfig();
  if (cfg.embedding === "off") return false;
  if (cfg.embeddingProvider === "openai") return Boolean(getApiKey());
  if (cfg.embeddingProvider === "local") return cfg.neuralEmbedEnabled !== "off";
  return cfg.neuralEmbedEnabled !== "off" || Boolean(getApiKey());
}

/**
 * 为一组工具批量补全 embedding（懒加载入口）。
 *
 * provider 链（N1）：sidecar 批量（单请求 ≤64 条）→ OpenAI API（8 并发）→ 放弃。
 * 内部对每个工具判断：
 *   - 已有 cache 且 hash 匹配且模型与本次产出模型一致 → 跳过
 *   - 否则重算；sidecar 首批成功后，会把缓存里其他模型的旧条目也标记重算，
 *     避免 openai 1536 维与本地 512 维混存互相抵消语义通道
 *
 * 不抛错：全链失败仅记录 warning，下一次 search 仍可走纯 BM25。
 */
export type ToolEmbeddingRequest = {
  registryName: string;
  searchText?: string;
  embeddingViews?: ToolEmbeddingViewInput[];
};

type EmbeddingPlan = {
  registryName: string;
  views: ToolEmbeddingViewInput[];
  contentHash: string;
  cachedByKey: Map<string, ToolEmbeddingView>;
};

type PendingView = ToolEmbeddingViewInput & {
  registryName: string;
  contentHash: string;
};

function normalizeEmbeddingViews(tool: ToolEmbeddingRequest): ToolEmbeddingViewInput[] {
  const source = tool.embeddingViews?.length
    ? tool.embeddingViews
    : tool.searchText
      ? [{ key: "definition", kind: "definition" as const, text: tool.searchText }]
      : [];
  const seen = new Set<string>();
  return source
    .map((view) => ({ ...view, text: view.text.trim() }))
    .filter((view) => {
      if (!view.text || seen.has(view.key)) return false;
      seen.add(view.key);
      return true;
    })
    .slice(0, 64);
}

function viewCacheKey(registryName: string, key: string): string {
  return `${registryName}\0${key}`;
}

export async function ensureToolEmbeddings(
  tools: ToolEmbeddingRequest[],
): Promise<{ computed: number; reused: number; failed: number }> {
  if (!isEmbeddingSearchEnabled() || tools.length === 0) {
    return { computed: 0, reused: 0, failed: 0 };
  }
  if (_pendingComputePromise) return _pendingComputePromise;

  const promise = (async () => {
    const cache = getToolEmbeddingCache();
    const cfg = getToolSearchConfig();
    const openaiModel = getModel();
    const useOpenai = cfg.embeddingProvider !== "local" && Boolean(getApiKey());
    const useSidecar = cfg.embeddingProvider !== "openai" && cfg.neuralEmbedEnabled !== "off";
    if (!useSidecar && !useOpenai) {
      return { computed: 0, reused: 0, failed: 0 };
    }

    const activeCache = activeCacheIdentity();
    const plans: EmbeddingPlan[] = tools.map((tool) => {
      const views = normalizeEmbeddingViews(tool);
      const existing = cache.entries[tool.registryName];
      const cachedByKey = new Map<string, ToolEmbeddingView>();
      if (existing && isActiveCacheEntry(existing)) {
        for (const view of existing.views) cachedByKey.set(view.key, view);
      }
      return {
        registryName: tool.registryName,
        views,
        contentHash: hashEmbeddingViews(views),
        cachedByKey,
      };
    });

    const pending: PendingView[] = [];
    let reused = 0;
    for (const plan of plans) {
      let missing = 0;
      for (const view of plan.views) {
        const cached = plan.cachedByKey.get(view.key);
        const contentHash = hashSearchText(view.text);
        if (cached?.contentHash === contentHash) continue;
        pending.push({ ...view, registryName: plan.registryName, contentHash });
        missing += 1;
      }
      if (missing === 0) reused += 1;
    }

    let providerModel: string | null = null;
    let resolved = new Map<string, ToolEmbeddingView>();
    let computed = 0;
    let failed = 0;
    let writtenDimension = 0;

    if (pending.length > 0 && useSidecar) {
      const local = new Map<string, ToolEmbeddingView>();
      let localModel: string | null = null;
      let localDimension = 0;
      let complete = true;
      for (let i = 0; i < pending.length; i += 64) {
        const batch = pending.slice(i, i + 64);
        const res = await neuralEmbedTextsBulk(batch.map((view) => view.text.slice(0, 8000)));
        if (!res || res.vectors.length !== batch.length || res.dim <= 0) {
          complete = false;
          break;
        }
        localModel ??= res.model;
        localDimension = res.dim;
        if (res.model !== localModel || res.dim !== localDimension) {
          complete = false;
          break;
        }
        for (let j = 0; j < batch.length; j++) {
          const view = batch[j]!;
          local.set(viewCacheKey(view.registryName, view.key), {
            key: view.key,
            kind: view.kind,
            contentHash: view.contentHash,
            vector: res.vectors[j]!,
          });
        }
      }
      if (complete && localModel) {
        providerModel = localModel;
        resolved = local;
        writtenDimension = localDimension;
        _lastLocalEmbedModel = localModel;
      }
    }

    if (pending.length > 0 && !providerModel && useOpenai) {
      _lastLocalEmbedModel = null;
      const apiKey = getApiKey()!;
      resolved = new Map();
      providerModel = openaiModel;
      const remoteViews: PendingView[] = plans.flatMap((plan) =>
        plan.views.map((view) => ({
          ...view,
          registryName: plan.registryName,
          contentHash: hashSearchText(view.text),
        })),
      );
      for (let i = 0; i < remoteViews.length; i += 8) {
        const batch = remoteViews.slice(i, i + 8);
        const results = await Promise.allSettled(
          batch.map(async (view) => {
            const { vector } = await fetchOpenAiCompatibleEmbedding({
              apiKey,
              model: openaiModel,
              input: view.text.slice(0, 8000),
            });
            return { view, vector };
          }),
        );
        for (const result of results) {
          if (result.status !== "fulfilled") continue;
          const { view, vector } = result.value;
          resolved.set(viewCacheKey(view.registryName, view.key), {
            key: view.key,
            kind: view.kind,
            contentHash: view.contentHash,
            vector,
          });
          writtenDimension ||= vector.length;
        }
      }
    }

    if (providerModel) {
      for (const plan of plans) {
        const views: ToolEmbeddingView[] = [];
        for (const view of plan.views) {
          const cached = plan.cachedByKey.get(view.key);
          const contentHash = hashSearchText(view.text);
          const reusable =
            cached?.contentHash === contentHash &&
            cache.entries[plan.registryName]?.model === providerModel
              ? cached
              : undefined;
          const next = reusable ?? resolved.get(viewCacheKey(plan.registryName, view.key));
          if (next) views.push(next);
        }
        if (views.length === 0) continue;
        const complete = views.length === plan.views.length;
        if (complete && plan.cachedByKey.size === plan.views.length) {
          continue;
        }
        cache.entries[plan.registryName] = {
          contentHash: plan.contentHash,
          model: providerModel,
          views,
          updatedAt: Date.now(),
        };
        if (complete) computed += 1;
        else failed += 1;
      }
    } else {
      failed = plans.filter((plan) =>
        plan.views.some((view) => {
          const cached = plan.cachedByKey.get(view.key);
          return cached?.contentHash !== hashSearchText(view.text);
        }),
      ).length;
    }

    if (computed > 0) {
      cache.meta = {
        model: providerModel ?? activeCache.model,
        dimension: writtenDimension || activeCache.dimension || 0,
        builtAt: Date.now(),
      };
      saveCacheToDisk(cache);
    }

    return { computed, reused, failed };
  })();

  _pendingComputePromise = promise;
  try {
    return await promise;
  } finally {
    if (_pendingComputePromise === promise) _pendingComputePromise = null;
  }
}

/** 取单个工具的定义向量（未缓存 / 计算失败时返回 null）。 */
export function getToolEmbedding(registryName: string): number[] | null {
  const cache = getToolEmbeddingCache();
  const entry = cache.entries[registryName];
  return entry && isActiveCacheEntry(entry) ? entry.views[0]?.vector ?? null : null;
}

/** 取批量工具的多视图向量，用于 catalog 与 adaptive 索引。 */
export function getToolEmbeddingsForCatalog(
  registryNames: string[],
): Map<string, number[][]> {
  const cache = getToolEmbeddingCache();
  const out = new Map<string, number[][]>();
  for (const name of registryNames) {
    const entry = cache.entries[name];
    if (entry && isActiveCacheEntry(entry)) {
      out.set(name, entry.views.map((view) => view.vector));
    }
  }
  return out;
}

/**
 * 把工具 searchText 拼成「语义搜索输入」——给 embedding 模型最有区分度的形式。
 *
 * 优先：name + description + aliases（多语言拼一起）。
 * 不重复 description 全文，避免长 description 主导向量。
 */
export function buildEmbeddingInput(tool: ChatCompletionTool): string {
  if (tool.type !== "function" || !tool.function) return "";
  const fn = tool.function;
  const parts: string[] = [];
  parts.push(`[${fn.name}]`);
  if (fn.description) parts.push(fn.description.slice(0, 1500));
  // 把 parameterNames 也带上（schema 关键词）
  const { parameterNames } = (() => {
    try {
      const params = fn.parameters as
        | { properties?: Record<string, unknown> }
        | undefined;
      const pNames = params?.properties ? Object.keys(params.properties) : [];
      return { parameterNames: pNames };
    } catch {
      return { parameterNames: [] as string[] };
    }
  })();
  if (parameterNames.length > 0) parts.push(`params: ${parameterNames.join(", ")}`);
  return parts.filter(Boolean).join("\n");
}

function buildParameterEmbeddingInput(tool: ChatCompletionTool): string {
  if (tool.type !== "function" || !tool.function) return "";
  const fn = tool.function;
  const schema = fn.parameters as
    | { properties?: Record<string, Record<string, unknown>> }
    | undefined;
  const properties = schema?.properties ?? {};
  const lines = Object.entries(properties)
    .slice(0, 40)
    .map(([name, value]) => {
      const description = typeof value.description === "string" ? value.description : "";
      const type = typeof value.type === "string" ? value.type : "";
      const enumValues = Array.isArray(value.enum)
        ? value.enum.map((item) => String(item)).join("|")
        : "";
      return [name, type, description, enumValues ? `enum=${enumValues}` : ""]
        .filter(Boolean)
        .join(": ");
    });
  if (lines.length === 0) return "";
  return [`[${fn.name}] parameters`, ...lines].join("\n").slice(0, 6000);
}

/** 工具的多视图语义表示：定义、参数语义、口语别名/例句独立成向量。 */
export function buildEmbeddingViews(tool: ChatCompletionTool): ToolEmbeddingViewInput[] {
  if (tool.type !== "function" || !tool.function) return [];
  const fn = tool.function;
  const metadata = getToolIntentMetadata(fn.name);
  const views: ToolEmbeddingViewInput[] = [
    { key: "definition", kind: "definition", text: buildEmbeddingInput(tool) },
  ];
  const parameters = buildParameterEmbeddingInput(tool);
  if (parameters) {
    views.push({ key: "parameters", kind: "parameters", text: parameters });
  }
  const exemplars = [...new Set([...(metadata.examples ?? []), ...(metadata.aliases ?? [])])]
    .map((text) => text.trim())
    .filter(Boolean)
    .slice(0, 24);
  for (const text of exemplars) {
    views.push({
      key: `exemplar:${hashSearchText(text)}`,
      kind: "exemplar",
      text: `[${fn.name}] ${text}`,
    });
  }
  return views;
}

/** 清空内存缓存（自我进化装载 Skill 后调用，让新工具的 embedding 重新计算） */
export function invalidateEmbeddingCache(): void {
  _cache = null;
  _cacheLoaded = false;
  _pendingComputePromise = null;
}

// === Query embedding 缓存 + 预计算 ===
// LRU 上限 128 个 query；过期 5 分钟。键带模型名——sidecar（512 维）与 openai
//（1536 维）切换 provider 时旧向量自动失效，避免维度错配让语义通道静默归零。
// 避免同一 query 重复算 embedding（LLM 多轮场景下常见）

type QueryVectorEntry = {
  vector: Float32Array;
  model: string;
  expiresAt: number;
};

const QUERY_LRU_MAX = 128;
const QUERY_TTL_MS = 5 * 60 * 1000;

const _queryVectorCache = new Map<string, QueryVectorEntry>();
const _queryVectorInflight = new Map<string, Promise<Float32Array | null>>();

function queryCacheKey(query: string, model: string): string {
  return `${model}\0${query}`;
}

function trimQueryCache(): void {
  if (_queryVectorCache.size <= QUERY_LRU_MAX) return;
  // Map 保持插入顺序，删除最早的
  const toDelete = _queryVectorCache.size - QUERY_LRU_MAX;
  let i = 0;
  for (const key of _queryVectorCache.keys()) {
    if (i >= toDelete) break;
    _queryVectorCache.delete(key);
    i++;
  }
}

/** 同步查 query embedding cache；过期、miss 或模型已切换返回 null */
export function peekQueryEmbedding(query: string): Float32Array | null {
  const entry = _queryVectorCache.get(queryCacheKey(query, expectedQueryModel()));
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    _queryVectorCache.delete(queryCacheKey(query, expectedQueryModel()));
    return null;
  }
  return entry.vector;
}

function toUnitVector(vector: number[]): Float32Array {
  const normalized = new Float32Array(vector.length);
  let norm = 0;
  for (let i = 0; i < vector.length; i++) {
    normalized[i] = vector[i] ?? 0;
    norm += (vector[i] ?? 0) ** 2;
  }
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < vector.length; i++) normalized[i] = normalized[i]! / norm;
  }
  return normalized;
}

/**
 * 异步获取 query embedding（provider 链：sidecar → openai；命中 cache 直接返回）。
 *
 * 并发安全：同 query 的多次请求会复用同一个 in-flight promise。
 */
export async function getQueryEmbedding(query: string): Promise<Float32Array | null> {
  const cached = peekQueryEmbedding(query);
  if (cached) return cached;
  if (!isEmbeddingSearchEnabled()) return null;

  const cfg = getToolSearchConfig();
  const inflightKey = queryCacheKey(query, expectedQueryModel());
  const inflight = _queryVectorInflight.get(inflightKey);
  if (inflight) return inflight;

  const promise = (async () => {
    // provider 1：本地 sidecar（sidecar 已归一化，仍防御性归一）
    if (cfg.embeddingProvider !== "openai" && cfg.neuralEmbedEnabled !== "off") {
      const res = await neuralEmbedTexts([query.slice(0, 2000)]);
      if (res && res.vectors.length === 1 && res.dim > 0) {
        _lastLocalEmbedModel = res.model;
        const vector = toUnitVector(res.vectors[0]!);
        _queryVectorCache.set(queryCacheKey(query, res.model), {
          vector,
          model: res.model,
          expiresAt: Date.now() + QUERY_TTL_MS,
        });
        trimQueryCache();
        return vector;
      }
    }

    if (cfg.embeddingProvider === "local") return null;
    _lastLocalEmbedModel = null;

    // provider 2：OpenAI 兼容 API
    try {
      const apiKey = getApiKey();
      if (!apiKey) return null;
      const model = getModel();
      const { vector: raw } = await fetchOpenAiCompatibleEmbedding({
        apiKey,
        model,
        input: query.slice(0, 2000),
        timeoutMs: 2_000,
      });
      const vector = toUnitVector(raw);
      _queryVectorCache.set(queryCacheKey(query, model), {
        vector,
        model,
        expiresAt: Date.now() + QUERY_TTL_MS,
      });
      trimQueryCache();
      return vector;
    } catch (error) {
      console.warn(
        "[tool-embedding] query embedding failed, fall back to BM25:",
        error instanceof Error ? error.message : String(error),
      );
      return null;
    }
  })().finally(() => {
    _queryVectorInflight.delete(inflightKey);
  });

  _queryVectorInflight.set(inflightKey, promise);
  return promise;
}

/** 预热 query embedding（fire-and-forget，让后续 search 命中 cache） */
export function primeQueryEmbedding(query: string): void {
  if (peekQueryEmbedding(query)) return;
  if (!isEmbeddingSearchEnabled()) return;
  void getQueryEmbedding(query);
}

/**
 * 有界等待的 query embedding（N1 冷启动首查）：
 * 旧路径「peek miss → 后台预取、下次生效」对改写型 query 是致命的——首查永远
 * 吃不到语义通道，而改写 query 恰恰只有语义通道能救。sidecar 是本地毫秒级，
 * 首查等待是值得的（预算 = sidecar 300ms + 余量）；OpenAI 慢路径超时后转入
 * 后台继续（promise 不取消，落 LRU 供下次复用），行为与旧实现一致。
 */
export async function getQueryEmbeddingBounded(
  query: string,
  waitMs = 400,
): Promise<Float32Array | null> {
  const cached = peekQueryEmbedding(query);
  if (cached) return cached;
  if (!isEmbeddingSearchEnabled()) return null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      getQueryEmbedding(query),
      new Promise<null>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout(null), waitMs);
        timer.unref?.();
      }),
    ]);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
