import type { ChatCompletionTool } from "openai/resources/chat/completions";

import { Bm25Index, buildToolSearchText, buildCharacterTrigrams } from "./bm25.js";
import { negativeMatch } from "./retrieval/hybrid-retrieval.js";
import { getToolSearchConfig } from "./env.js";
import { getToolIntentMetadata } from "./intent-metadata.js";
import { ToolEmbeddingIndex } from "./tool-embedding-index.js";
import {
  buildEmbeddingViews,
  ensureToolEmbeddings,
  getToolEmbeddingsForCatalog,
  isEmbeddingSearchEnabled,
  type ToolEmbeddingViewInput,
} from "./tool-embedding.js";


function isFunctionTool(tool: ChatCompletionTool): tool is ChatCompletionTool & {
  type: "function";
  function: { name: string; description?: string; parameters?: unknown };
} {
  return tool.type === "function" && Boolean(tool.function?.name);
}

export type DeferredToolEntry = {
  registryName: string;
  tool: ChatCompletionTool;
  searchText: string;
  parameterNames: string[];
  requiredParameters: string[];
  searchAliases: string[];
  negativeAliases: string[];
  examples: string[];
  negativeExamples: string[];
  /** 预先构建的字符 trigram 集合，避免每次 search 都重算 */
  trigramSet: Set<string>;
  /** 定义视图文本，保留给诊断与旧脚本；正式召回使用 embeddingViews。 */
  embeddingInput: string;
  embeddingViews: ToolEmbeddingViewInput[];
};

/** 单轮对话内复用 BM25 索引与名称查找表，避免每次 tool_search 全量重建。 */
export type DeferredToolCatalog = {
  entries: DeferredToolEntry[];
  index: Bm25Index;
  byName: Map<string, DeferredToolEntry>;
  byApiName: Map<string, DeferredToolEntry>;
  /**
   * Embedding 向量索引（可能为空：API 未启用 / 无 key / 首次构建时 cache 全 miss）。
   * 即使为空 catalog 仍然可用——search 会自动降级为纯 BM25 召回。
   */
  embeddingIndex: ToolEmbeddingIndex;
  /**
   * catalog 构建时是否已尝试为所有 entry 算 embedding。
   * false 表示后台还有 in-flight 补全任务，第二次 search 时会更大。
   */
  embeddingReady: boolean;
};

export type DeferredToolSearchMatch = {
  name: string;
  description: string;
  score: number;
  parameterNames: string[];
  requiredParameters: string[];
  parameters?: Record<string, unknown>;
};

function extractParameterSummary(parameters: unknown): {
  parameterNames: string[];
  requiredParameters: string[];
} {
  if (!parameters || typeof parameters !== "object") {
    return { parameterNames: [], requiredParameters: [] };
  }
  const schema = parameters as { properties?: Record<string, unknown>; required?: unknown };
  const parameterNames =
    schema.properties && typeof schema.properties === "object"
      ? Object.keys(schema.properties)
      : [];
  const requiredParameters = Array.isArray(schema.required)
    ? schema.required.filter((r): r is string => typeof r === "string")
    : [];
  return { parameterNames, requiredParameters };
}

export function buildDeferredCatalog(deferredTools: ChatCompletionTool[]): DeferredToolCatalog {
  const entries: DeferredToolEntry[] = deferredTools.filter(isFunctionTool).map((tool) => {
    const fn = tool.function;
    const { parameterNames, requiredParameters } = extractParameterSummary(fn.parameters);
    const { text, aliases } = buildToolSearchText({
      name: fn.name,
      description: fn.description,
      parameters: fn.parameters,
    });
    const metadata = getToolIntentMetadata(fn.name);
    const embeddingViews = buildEmbeddingViews(tool);
    return {
      registryName: fn.name,
      tool,
      searchText: text,
      parameterNames,
      requiredParameters,
      searchAliases: aliases,
      negativeAliases: metadata.negativeAliases ?? [],
      examples: metadata.examples ?? [],
      negativeExamples: metadata.negativeExamples ?? [],
      trigramSet: buildCharacterTrigrams(text),
      embeddingInput:
        embeddingViews.find((view) => view.kind === "definition")?.text ?? "",
      embeddingViews,
    };
  });

  const byName = new Map(entries.map((e) => [e.registryName, e]));
  const byApiName = new Map(
    entries.map((e) => [e.registryName.replace(/\./g, "_"), e] as const),
  );
  const index = new Bm25Index(
    entries.map((entry) => ({ id: entry.registryName, text: entry.searchText })),
  );

  // === Embedding 索引：默认尝试从磁盘 cache 加载 ===
  // 是否启用由 env 决定（auto/on/off）+ 是否 OPENAI_API_KEY 可用
  // 小工具集（< embeddingMinTools）跳过 embedding，节省 RTT
  const cfg = getToolSearchConfig();
  const embeddingIndex = new ToolEmbeddingIndex();
  let embeddingReady = false;

  if (
    isEmbeddingSearchEnabled() &&
    entries.length >= cfg.embeddingMinTools
  ) {
    const cached = getToolEmbeddingsForCatalog(entries.map((e) => e.registryName));
    embeddingIndex.ingestMany(cached.entries());
    embeddingReady = cached.size === entries.length;

    // 缺 key 之外如果还有 entry 没缓存 → 触发后台批量补全（fire-and-forget）
    // 注意：API 失败会被 ensureToolEmbeddings 内部吞掉，下一次 build 仍会重试
    if (!embeddingReady) {
      const missing = entries
        .filter((e) => !getToolEmbeddingsForCatalog([e.registryName]).size)
        .map((e) => ({ registryName: e.registryName, embeddingViews: e.embeddingViews }));
      if (missing.length > 0) {
        void ensureToolEmbeddings(missing).then((stats) => {
          if (stats.computed > 0) {
            // 补完后把新算的 vector 灌进 catalog 的索引，下一次 searchDeferredTools 立即可用
            const refreshed = getToolEmbeddingsForCatalog(
              missing.map((m) => m.registryName),
            );
            for (const [name, vec] of refreshed.entries()) {
              embeddingIndex.ingest(name, vec);
            }
            // 向量集变化后 ANN 可能值得重建（千级以下自动跳过）
            void embeddingIndex.ensureAnn();
          }
        });
      }
    } else {
      // N4：目录规模达标时预热 ANN（hnswlib-node 可用才有实际动作）
      void embeddingIndex.ensureAnn();
    }
  }

  return {
    entries,
    index,
    byName,
    byApiName,
    embeddingIndex,
    embeddingReady,
  };
}

export function estimateToolsSchemaTokens(tools: ChatCompletionTool[]): number {
  if (tools.length === 0) return 0;
  const json = JSON.stringify(tools);
  // 中文感知估算：bytes/4 对 CJK description 低估 1.5-3 倍（中文约 0.6-1 token/字），
  // 导致 token 预算裁剪实际放进来的真实 token 远超标称。CJK 区（≥U+2E80，UTF-8
  // 3 字节）按 1.0 token/字计，其余按 4 字节/token 计。
  let cjkChars = 0;
  for (const ch of json) {
    if ((ch.codePointAt(0) ?? 0) >= 0x2e80) cjkChars++;
  }
  const otherBytes = Buffer.byteLength(json, "utf8") - cjkChars * 3;
  return Math.ceil(otherBytes / 4 + cjkChars);
}

export function shouldActivateToolSearch(
  deferredTools: ChatCompletionTool[],
  mode: ReturnType<typeof getToolSearchConfig>["enabled"],
  thresholdPct: number,
  contextTokens: number,
): boolean {
  if (deferredTools.length === 0) return false;
  if (mode === "off") return false;
  if (mode === "on") return true;

  // 小工具集（≤15 个延迟工具）：BM25 索引极小，搜索几乎零延迟，始终激活。
  // 这让对话面轻量档（≤12 工具，3-6 visible + 6-9 deferred）也能走 tool search 召回。
  if (deferredTools.length <= 15) return true;

  // 大工具集：按 token 阈值判定（延迟工具 schema token / 上下文 token ≥ 阈值）
  const deferrableTokens = estimateToolsSchemaTokens(deferredTools);
  return deferrableTokens / contextTokens >= thresholdPct / 100;
}

export type SearchDeferredOptions = {
  includeSchema?: boolean;
  /**
   * 查询的 embedding 向量（已归一化或未归一化均可）。
   * 提供时启用 hybrid 召回；不提供时降级为统一校准词面召回。
   */
  queryVector?: number[] | Float32Array;
};

export function searchDeferredTools(
  catalog: DeferredToolCatalog,
  query: string,
  limit: number,
  options?: SearchDeferredOptions,
): DeferredToolSearchMatch[] {
  // 2026-10-01 类别路由退役（单评分器归一）：此函数只剩 adaptive 管线异常时的
  // 纯 BM25 兜底职责——全量召回 + 正/负例先验（applyIntentPrior），一次排序。
  return searchWithinTools(catalog, query, limit, catalog.entries, options);
}

/** 兜底检索（仅 adaptive 管线异常时使用）：全量 BM25 + 意图先验（正/负例），一次排序。 */
function searchWithinTools(
  catalog: DeferredToolCatalog,
  query: string,
  limit: number,
  entries: DeferredToolEntry[],
  options?: SearchDeferredOptions,
): DeferredToolSearchMatch[] {
  void options;
  if (entries.length === 0 || limit <= 0) return [];
  const ids = new Set(entries.map((e) => e.registryName));
  const hits = catalog.index.search(query, Math.max(entries.length, limit), catalog.entries);
  const out: DeferredToolSearchMatch[] = [];
  for (const hit of hits) {
    if (!ids.has(hit.id)) continue;
    const entry = catalog.byName.get(hit.id);
    if (!entry || !isFunctionTool(entry.tool)) continue;
    out.push({
      name: entry.registryName,
      description: entry.tool.function.description ?? "",
      score: Math.round(applyIntentPrior(entry, query, hit.score) * 1000) / 1000,
      parameterNames: entry.parameterNames,
      requiredParameters: entry.requiredParameters,
    });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * 兜底通道只保留显式负例护栏；正向词面证据已由统一词面融合器评分。
 */
function applyIntentPrior(
  entry: DeferredToolEntry,
  query: string,
  baseScore: number,
): number {
  const penalty = negativeMatch(
    [...entry.negativeAliases, ...entry.negativeExamples],
    query,
  );
  return Math.max(0, baseScore - penalty * 0.35);
}

export function describeDeferredTool(
  catalog: DeferredToolCatalog,
  name: string,
): Record<string, unknown> | null {
  const resolved = resolveCatalogToolName(catalog, name);
  if (!resolved || !isFunctionTool(resolved.tool)) return null;
  const fn = resolved.tool.function;
  return {
    name: resolved.registryName,
    description: fn.description ?? "",
    parameters: fn.parameters ?? { type: "object", properties: {} },
  };
}

export function resolveCatalogToolName(
  catalog: DeferredToolCatalog,
  rawName: string,
): DeferredToolEntry | null {
  const trimmed = rawName.trim();
  if (!trimmed) return null;

  const direct = catalog.byName.get(trimmed);
  if (direct) return direct;

  const apiNormalized = trimmed.replace(/\./g, "_");
  const viaApi =
    catalog.byApiName.get(apiNormalized) ?? catalog.byName.get(apiNormalized);
  if (viaApi) return viaApi;

  // 大小写不敏感兜底：LLM 偶尔改写工具名大小写，精确未命中时做一次 O(n) 小写匹配
  const lower = trimmed.toLowerCase();
  const apiLower = apiNormalized.toLowerCase();
  for (const entry of catalog.entries) {
    const regLower = entry.registryName.toLowerCase();
    if (regLower === lower || regLower === apiLower) return entry;
    const apiEntry = entry.registryName.replace(/\./g, "_").toLowerCase();
    if (apiEntry === lower || apiEntry === apiLower) return entry;
  }
  return null;
}
