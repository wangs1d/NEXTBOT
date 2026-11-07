/**
 * OpenAI 兼容 Embedding API（`/v1/embeddings`），可用于 Qdrant 向量写入。
 *
 * 内置共享设施（供 hybrid 召回 / forgotten 补捞 / 知识缺口等所有调用方复用）：
 * - 进程内 TTL 缓存：同一轮里预筛、hybrid、forgotten 常对同一 query 重复嵌入，
 *   缓存（key = model + 文本 hash）直接消除这部分重复 API 调用；
 * - 并发去重：同 key 在飞请求共享同一个 Promise，不重复打 API；
 * - 批量接口：一次 API 往返嵌入多条输入（ingest 分块、多子意图场景）。
 */

import { createHash } from "node:crypto";

import { isPlaceholderApiKey } from "../config/api-key-validator.js";
import { getLocalEmbeddingEndpoint } from "../agentic-memory/local-embedding/local-embedding-endpoint.js";

export type EmbeddingEndpoint = {
  baseUrl: string;
  apiKey: string;
  model: string;
};

/** 缓存条目上限（约 1000 × 1536 floats ≈ 12MB，防止长驻进程无界增长） */
const EMBEDDING_CACHE_MAX_ENTRIES = 1000;
const EMBEDDING_CACHE_TTL_MS = 30 * 60 * 1000;

const embeddingCache = new Map<string, { vector: number[]; ts: number }>();
const embeddingInflight = new Map<string, Promise<number[]>>();

function cacheKey(model: string, text: string): string {
  return `${model}:${createHash("sha256").update(text).digest("hex")}`;
}

function cacheGet(key: string): number[] | null {
  const hit = embeddingCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > EMBEDDING_CACHE_TTL_MS) {
    embeddingCache.delete(key);
    return null;
  }
  return hit.vector;
}

function cacheSet(key: string, vector: number[]): void {
  // 简单防膨胀：超限时按插入序淘汰最旧的一半
  if (embeddingCache.size >= EMBEDDING_CACHE_MAX_ENTRIES) {
    let drop = Math.ceil(embeddingCache.size / 2);
    for (const k of embeddingCache.keys()) {
      if (drop-- <= 0) break;
      embeddingCache.delete(k);
    }
  }
  embeddingCache.set(key, { vector, ts: Date.now() });
}

/**
 * 全链路统一的嵌入模型解析：AGENT_EMBEDDING_MODEL → OPENAI_EMBEDDINGS_MODEL → 默认。
 * 此前 humanLike / forgotten 用 OPENAI_EMBEDDINGS_MODEL、hybrid / Mem0 用
 * AGENT_EMBEDDING_MODEL，两个变量分治导致通道间模型可能不一致（预筛阈值与
 * 通道分数不可比）；统一后任一变量对所有通道生效。
 */
export function resolveEmbeddingModel(): string {
  return (
    process.env.AGENT_EMBEDDING_MODEL?.trim() ||
    process.env.OPENAI_EMBEDDINGS_MODEL?.trim() ||
    "text-embedding-3-small"
  );
}

/**
 * 解析当前可用的 Embedding 端点（OpenAI 兼容 /v1/embeddings）。
 *
 * 本地内置向量引擎【优先】（2026-11-04 调整）：手机端部署在云端，远端 Embedding
 * 供应商依赖外部账户状态（SiliconFlow 余额耗尽 402 曾让长期记忆召回全链路瘫痪，
 * 且免费额度说停就停），不再作为首选。本地引擎零外部依赖、随进程常驻；向量集合
 * 按模型打标（resolveAgenticMemoryCollectionName），本地/远端各占各的向量空间，
 * 切换互不污染。远端（AGENT_EMBEDDING_BASE_URL → OPENAI_EMBEDDINGS_URL）仅在
 * 本地引擎不可用（未就绪/被 AGENT_LOCAL_EMBEDDING_DISABLED 关闭/宿主崩溃）时兜底。
 *
 * 刻意【不】拿 OPENAI_BASE_URL 兜底：对话网关未必提供 /embeddings（真链踩过：
 * 通用网关/embeddings 连接失败），误信会产出运行期才炸的假端点；确有嵌入能力
 * 的端点请显式配 OPENAI_EMBEDDINGS_URL。
 */
export function resolveEmbeddingEndpoint(): EmbeddingEndpoint | null {
  // 本地内置引擎优先：模型/维度/鉴权自成一体，与远端配置解耦
  const local = getLocalEmbeddingEndpoint();
  if (local) return { baseUrl: local.baseUrl, apiKey: local.apiKey, model: local.model };

  const apiKey =
    process.env.AGENT_EMBEDDING_API_KEY?.trim() ||
    process.env.OPENAI_API_KEY?.trim() ||
    "";
  const model = resolveEmbeddingModel();

  const validKey = apiKey && !isPlaceholderApiKey(apiKey);
  const explicit = process.env.AGENT_EMBEDDING_BASE_URL?.trim();
  if (explicit && validKey) {
    return { baseUrl: explicit.replace(/\/+$/, ""), apiKey, model };
  }

  const embeddingsUrl = process.env.OPENAI_EMBEDDINGS_URL?.trim();
  if (embeddingsUrl && validKey) {
    return { baseUrl: embeddingsUrl.replace(/\/+$/, ""), apiKey, model };
  }

  return null;
}

async function requestEmbeddings(
  endpoint: string,
  apiKey: string,
  model: string,
  inputs: string[],
  timeoutMs: number,
): Promise<number[][]> {
  const r = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: inputs.map((t) => t.slice(0, 32_000)),
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`embeddings HTTP ${r.status}: ${txt.slice(0, 400)}`);
  }
  const data = (await r.json()) as {
    data?: Array<{ index?: number; embedding?: number[] }>;
  };
  const rows = data.data ?? [];
  if (rows.length !== inputs.length || rows.some((x) => !x.embedding?.length)) {
    throw new Error("embeddings: response count/dimension mismatch");
  }
  // 兼容不保证按输入序返回的服务端：有 index 按 index 归位，否则按返回序
  const out: number[][] = new Array(inputs.length);
  const hasIndex = rows.every((x) => typeof x.index === "number");
  rows.forEach((row, i) => {
    const idx = hasIndex ? row.index! : i;
    out[idx] = row.embedding!;
  });
  return out;
}

async function embedThroughCache(
  model: string,
  inputs: string[],
  doFetch: (inputs: string[]) => Promise<number[][]>,
): Promise<number[]> {
  const key = cacheKey(model, inputs[0]!);
  const cached = cacheGet(key);
  if (cached) return cached;

  const inflight = embeddingInflight.get(key);
  if (inflight) return inflight;

  const p = doFetch(inputs)
    .then((vectors) => {
      const vec = vectors[0]!;
      cacheSet(key, vec);
      return vec;
    })
    .finally(() => {
      embeddingInflight.delete(key);
    });
  embeddingInflight.set(key, p);
  return p;
}

export async function fetchOpenAiCompatibleEmbedding(opts: {
  apiKey?: string;
  /** 默认 AGENT_EMBEDDING_BASE_URL → OPENAI_EMBEDDINGS_URL → 可用的 OPENAI_BASE_URL */
  baseUrl?: string;
  model?: string;
  input: string;
  /** 请求超时毫秒；默认 60s（兼容既有调用方，如 Qdrant 批量写入） */
  timeoutMs?: number;
}): Promise<{ vector: number[]; dimension: number }> {
  const ep = resolveEmbeddingEndpoint();

  // 未显式传 baseUrl 且没有可用的 Embedding 端点：直接抛错，避免拿聊天 Key 去打
  // api.openai.com 浪费时间（401 / 超时）。
  if (!opts.baseUrl && !ep) {
    throw new Error(
      "embeddings: no compatible endpoint; 可配置 AGENT_EMBEDDING_BASE_URL + AGENT_EMBEDDING_API_KEY " +
        "走远端，或检查本地内置向量引擎（AGENT_LOCAL_EMBEDDING_DISABLED / models/bge-small-zh-v1.5）",
    );
  }

  const base =
    opts.baseUrl?.replace(/\/$/, "") ??
    ep?.baseUrl ??
    process.env.OPENAI_EMBEDDINGS_URL?.replace(/\/$/, "") ??
    "https://api.openai.com/v1/embeddings";
  const apiKey = opts.apiKey ?? ep?.apiKey ?? "";
  if (!apiKey) {
    throw new Error("embeddings: no API key configured");
  }
  const model = opts.model ?? ep?.model ?? "text-embedding-3-small";

  // baseUrl 约定为"纯 base"（如 https://api.deepseek.com/v1，来自 AGENT_EMBEDDING_BASE_URL），
  // 需补 /embeddings 路径；默认值已含 /embeddings，直接跳过拼接。
  const endpoint = base.endsWith("/embeddings") ? base : `${base}/embeddings`;

  const vector = await embedThroughCache(model, [opts.input], async (inputs) => {
    return requestEmbeddings(endpoint, apiKey, model, inputs, opts.timeoutMs ?? 60_000);
  });
  return { vector, dimension: vector.length };
}

/**
 * 批量嵌入：多条输入合并为一次 API 往返；命中缓存的输入不打 API。
 * 返回向量数组与 inputs 一一对应；整个请求失败时抛错（由调用方降级）。
 */
export async function fetchOpenAiCompatibleEmbeddings(opts: {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  inputs: string[];
  timeoutMs?: number;
}): Promise<{ vectors: number[][]; dimension: number | null }> {
  const inputs = opts.inputs.map((t) => t.trim()).filter((t) => t.length > 0);
  if (inputs.length === 0) return { vectors: [], dimension: null };

  const ep = resolveEmbeddingEndpoint();
  if (!opts.baseUrl && !ep) {
    throw new Error(
      "embeddings: no compatible endpoint; 可配置 AGENT_EMBEDDING_BASE_URL + AGENT_EMBEDDING_API_KEY " +
        "走远端，或检查本地内置向量引擎（AGENT_LOCAL_EMBEDDING_DISABLED / models/bge-small-zh-v1.5）",
    );
  }
  const base =
    opts.baseUrl?.replace(/\/$/, "") ??
    ep?.baseUrl ??
    process.env.OPENAI_EMBEDDINGS_URL?.replace(/\/$/, "") ??
    "https://api.openai.com/v1/embeddings";
  const apiKey = opts.apiKey ?? ep?.apiKey ?? "";
  if (!apiKey) {
    throw new Error("embeddings: no API key configured");
  }
  const model = opts.model ?? ep?.model ?? "text-embedding-3-small";
  const endpoint = base.endsWith("/embeddings") ? base : `${base}/embeddings`;

  // 去重后只请求缺失项，结果按原输入序回填
  const unique = [...new Set(inputs)];
  const byKey = new Map<string, string>(); // cacheKey -> 原文
  const missing: string[] = [];
  for (const text of unique) {
    const key = cacheKey(model, text);
    byKey.set(key, text);
    if (!cacheGet(key)) missing.push(text);
  }

  const fetched = new Map<string, number[]>();
  if (missing.length > 0) {
    const vectors = await requestEmbeddings(
      endpoint,
      apiKey,
      model,
      missing,
      opts.timeoutMs ?? 60_000,
    );
    for (let i = 0; i < missing.length; i++) {
      const text = missing[i]!;
      const vec = vectors[i]!;
      cacheSet(cacheKey(model, text), vec);
      fetched.set(text, vec);
    }
  }

  const vectors = inputs.map((text) => {
    const key = cacheKey(model, text);
    const cached = cacheGet(key);
    if (cached) return cached;
    const direct = fetched.get(text);
    if (direct) return direct;
    throw new Error("embeddings: missing vector for input");
  });
  return { vectors, dimension: vectors[0]?.length ?? null };
}
