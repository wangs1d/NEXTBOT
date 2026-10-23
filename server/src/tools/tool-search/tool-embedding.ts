/**
 * 工具 embedding 召回（hybrid: BM25 + 余弦相似度 → RRF 融合）。
 *
 * 关键设计：
 *   - 工具 description 变化时才重新算 embedding（按 text hash 缓存）
 *   - 磁盘 JSON 缓存（data/tool-embeddings.json），避免服务重启后全量重算
 *   - 启动时按需懒加载：首次 searchDeferredTools 时尝试加载 cache，缺失的工具 background 预计算
 *   - provider 链（N1，docs/neural-retrieval-plan.md）：
 *       AGENT_TOOL_EMBEDDING_PROVIDER = auto/local → 本地 sidecar 优先，失败回落
 *       OpenAI API，再失败降级纯 BM25（不报错）；= openai → 跳过 sidecar（回滚开关）
 *   - 缓存条目与 query LRU 都带模型名：本地 bge（512 维）与 openai（1536 维）
 *     混存不污染，provider 切换自动重算
 *
 * 流程：
 *   buildDeferredCatalog → 标记每个 entry 预计算状态
 *   searchDeferredTools → 若任一 entry 待 embedding → 触发后台批量补全
 *                       → 下一次 search 即可用 hybrid
 */

import { getDataDir } from "../../config/data-dir.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";

import type { ChatCompletionTool } from "openai/resources/chat/completions";

import { fetchOpenAiCompatibleEmbedding } from "../../services/openai-embedding-client.js";
import { getToolSearchConfig } from "./env.js";
import { neuralEmbedTexts, neuralEmbedTextsBulk } from "./neural-sidecar.js";

/** 工具 embedding cache 项 */
export type ToolEmbeddingCacheEntry = {
  /** 工具的 searchText 内容的 SHA-256 hash（用于检测 description 变化） */
  contentHash: string;
  /** 1536 维 embedding 向量 */
  vector: number[];
  /** embedding 模型名（防止不同模型混用） */
  model: string;
  /** 写入时间戳（ms） */
  updatedAt: number;
};

export type ToolEmbeddingCache = {
  /** key = 工具 registryName */
  entries: Record<string, ToolEmbeddingCacheEntry>;
  /** cache 整体元数据 */
  meta: {
    model: string;
    dimension: number;
    builtAt: number;
  };
};

const DEFAULT_CACHE_PATH = resolve(getDataDir(), "tool-embeddings.json");

let _cache: ToolEmbeddingCache | null = null;
let _cacheLoaded = false;
let _pendingComputePromise: Promise<{ computed: number; reused: number; failed: number }> | null = null;

function getCachePath(): string {
  const override = getToolSearchConfig().embeddingCachePath;
  return override ? resolve(override) : DEFAULT_CACHE_PATH;
}

function getApiKey(): string | null {
  return (
    process.env.AGENT_TOOL_SEARCH_EMBEDDING_API_KEY?.trim() ||
    process.env.OPENAI_API_KEY?.trim() ||
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
  return _lastLocalEmbedModel ?? cfg.neuralEmbedModel;
}

/** 工具 searchText 的内容指纹（description / aliases / examples 任何变化都会让 hash 变） */
export function hashSearchText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function loadCacheFromDisk(): ToolEmbeddingCache {
  const path = getCachePath();
  if (!existsSync(path)) {
    return { entries: {}, meta: { model: getModel(), dimension: 0, builtAt: 0 } };
  }
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as ToolEmbeddingCache;
    if (!parsed?.entries || !parsed?.meta) {
      return { entries: {}, meta: { model: getModel(), dimension: 0, builtAt: 0 } };
    }
    return parsed;
  } catch (error) {
    console.warn(
      "[tool-embedding] Failed to read cache, starting fresh:",
      error instanceof Error ? error.message : String(error),
    );
    return { entries: {}, meta: { model: getModel(), dimension: 0, builtAt: 0 } };
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
  // provider=openai 维持旧语义（必须有 key）；local/auto 视 sidecar 为可用候选，
  // sidecar 实际不可用时由 provider 链内部熔断降级，不在这里做网络探测。
  if (cfg.embeddingProvider === "openai") return Boolean(getApiKey());
  return true;
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
export async function ensureToolEmbeddings(
  tools: Array<{ registryName: string; searchText: string }>,
): Promise<{ computed: number; reused: number; failed: number }> {
  if (!isEmbeddingSearchEnabled() || tools.length === 0) {
    return { computed: 0, reused: 0, failed: 0 };
  }
  if (_pendingComputePromise) {
    await _pendingComputePromise;
  }

  _pendingComputePromise = (async () => {
    const cache = getToolEmbeddingCache();
    const cfg = getToolSearchConfig();
    const openaiModel = getModel();
    const useOpenai = Boolean(getApiKey());
    const useSidecar = cfg.embeddingProvider !== "openai" && cfg.neuralEmbedEnabled !== "off";
    if (!useSidecar && !useOpenai) {
      return { computed: 0, reused: 0, failed: 0 };
    }

    let computed = 0;
    let reused = 0;
    let failed = 0;

    // 找出需要重算的（没有 cache / hash 不匹配 / 模型与两个在用 provider 都不符）
    const eligibleModels = new Set<string>([openaiModel]);
    if (_lastLocalEmbedModel) eligibleModels.add(_lastLocalEmbedModel);
    const toCompute: typeof tools = [];
    for (const t of tools) {
      const h = hashSearchText(t.searchText);
      const existing = cache.entries[t.registryName];
      if (
        existing &&
        existing.contentHash === h &&
        eligibleModels.has(existing.model)
      ) {
        reused += 1;
        continue;
      }
      toCompute.push(t);
    }
    if (toCompute.length === 0) {
      return { computed, reused, failed };
    }

    const writeEntries = (
      entries: Array<{ registryName: string; contentHash: string; vector: number[]; model: string }>,
    ): void => {
      for (const e of entries) {
        cache.entries[e.registryName] = {
          contentHash: e.contentHash,
          vector: e.vector,
          model: e.model,
          updatedAt: Date.now(),
        };
        computed += 1;
      }
    };

    // ── provider 1：本地 sidecar（批量补全用独立的秒级预算，含冷启动懒加载）──
    const remaining: typeof tools = [...toCompute];
    if (useSidecar) {
      const res = await neuralEmbedTextsBulk(
        toCompute.map((t) => t.searchText.slice(0, 8000)),
      );
      if (res && res.vectors.length === toCompute.length && res.dim > 0) {
        _lastLocalEmbedModel = res.model;
        writeEntries(
          toCompute.map((t, i) => ({
            registryName: t.registryName,
            contentHash: hashSearchText(t.searchText),
            vector: res.vectors[i]!,
            model: res.model,
          })),
        );
        remaining.length = 0;
        // sidecar 已确认是本环境的产出模型：缓存里其它模型的条目视为过期，
        // 让下一次 ensure 重算（维度混存会让余弦通道静默归零）
        for (const t of tools) {
          const existing = cache.entries[t.registryName];
          if (existing && existing.model !== res.model) {
            existing.contentHash = "";
          }
        }
      }
    }

    // ── provider 2：OpenAI 兼容 API（批量 8 并发）──
    if (remaining.length > 0 && useOpenai) {
      const apiKey = getApiKey()!;
      const CONCURRENCY = 8;
      for (let i = 0; i < remaining.length; i += CONCURRENCY) {
        const batch = remaining.slice(i, i + CONCURRENCY);
        const results = await Promise.allSettled(
          batch.map(async (t) => {
            const h = hashSearchText(t.searchText);
            const { vector } = await fetchOpenAiCompatibleEmbedding({
              apiKey,
              model: openaiModel,
              input: t.searchText.slice(0, 8000),
            });
            return { registryName: t.registryName, contentHash: h, vector, model: openaiModel };
          }),
        );
        const fulfilled = [];
        for (const r of results) {
          if (r.status === "fulfilled") fulfilled.push(r.value);
          else failed += 1;
        }
        writeEntries(fulfilled);
      }
    } else if (remaining.length > 0) {
      failed += remaining.length;
    }

    if (computed > 0) {
      // 更新 meta
      const dim = Object.values(cache.entries)[0]?.vector.length ?? 0;
      cache.meta = { model: _lastLocalEmbedModel ?? openaiModel, dimension: dim, builtAt: Date.now() };
      saveCacheToDisk(cache);
    }

    return { computed, reused, failed };
  })();

  const result = await _pendingComputePromise;
  _pendingComputePromise = null;
  return result;
}

/** 取单个工具的 embedding（可能为 null，未缓存 / 计算失败） */
export function getToolEmbedding(registryName: string): number[] | null {
  const cache = getToolEmbeddingCache();
  return cache.entries[registryName]?.vector ?? null;
}

/** 取批量 embedding（用于构建 catalog 时建索引） */
export function getToolEmbeddingsForCatalog(
  registryNames: string[],
): Map<string, number[]> {
  const cache = getToolEmbeddingCache();
  const out = new Map<string, number[]>();
  for (const name of registryNames) {
    const v = cache.entries[name]?.vector;
    if (v) out.set(name, v);
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
    } finally {
      _queryVectorInflight.delete(inflightKey);
    }
  })();

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
