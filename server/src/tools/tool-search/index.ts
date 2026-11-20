import type { ChatCompletionTool } from "openai/resources/chat/completions";

import { buildToolSearchBridgeTools } from "./bridge-tools.js";
import { tokenize } from "./bm25.js";
import {
  buildDeferredCatalog,
  searchDeferredTools,
  shouldActivateToolSearch,
  type DeferredToolCatalog,
  type DeferredToolEntry,
  type DeferredToolSearchMatch,
} from "./catalog.js";
import { getToolSearchConfig } from "./env.js";
import { getToolIntentMetadata } from "./intent-metadata.js";
import { domainsForTool } from "./tool-category.js";

export type ToolSearchPreparedTurn = {
  visibleTools: ChatCompletionTool[];
  deferredCatalog: DeferredToolCatalog;
  toolSearchActive: boolean;
  coreToolCount: number;
  deferredToolCount: number;
};

function isFunctionName(tool: ChatCompletionTool): string | null {
  return tool.type === "function" && tool.function?.name ? tool.function.name : null;
}

function uniqueTools(tools: ChatCompletionTool[]): ChatCompletionTool[] {
  const seen = new Set<string>();
  const out: ChatCompletionTool[] = [];
  for (const tool of tools) {
    const name = isFunctionName(tool);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(tool);
  }
  return out;
}

/**
 * 全量 BM25 索引跨轮缓存。
 *
 * deferred 工具集每轮随 contextual 筛选结果变化（visible 变 → deferred 变），
 * 但 searchableSourceTools（通常是全量 builtin 工具）在运行时几乎不变，
 * 只有 MCP 动态注册 / self-programming 生成 skill 时才会变。
 *
 * 因此把"全量 searchable 的 BM25 索引"缓存起来，每轮只做 O(n) 的 entries 过滤
 * （过滤出 deferred 子集 + 重建 byName/byApiName 两个 Map），不再每轮重建 Bm25Index。
 *
 * 失效策略：按 searchable 工具名签名（排序后 join）做 key，签名变化即重建。
 * 重建后会覆盖旧缓存，保证 MCP / self-programming 新增工具可见。
 */
type FullCatalogCache = {
  signature: string;
  full: DeferredToolCatalog;
  createdAt: number;
};

let _fullCatalogCache: FullCatalogCache | null = null;
const FULL_CATALOG_TTL_MS = 5 * 60 * 1000; // 5 分钟 TTL，防止长期持有过期引用

/**
 * 域信号探测（2026-10-01 S2 域信号预载的判定原语）：全量 BM25 词面 top-5 领先者
 * 的域多数票，≥3 票（60% 浓度）才算强信号。实测校准：真信号 5/5~3/5（行程→
 * travel、摄像头→media）；噪声票分散在 2/5 以下（"嗯嗯好的"→voice 2、
 * "开灯"→search 2）——BM25 绝对分区分不了噪声（均在 ~0.05），浓度才行。
 * 确定性（同语料同 query 恒同结果），复用跨轮 catalog 缓存——泛化替代此前
 * travel 一域的硬编码预载。
 */
export function dominantDomainForQuery(
  query: string,
  searchableTools: ChatCompletionTool[],
): string | null {
  const top = domainVotesForQuery(query, searchableTools)[0];
  return top && top.votes >= 3 ? top.domain : null;
}

/**
 * BM25 词面命中全表（2026-10-10 族序修正）：与域投票（domainVotesForQuery）同
 * 索引同链路的命中工具与分数，按分降序。消费方（buildDomainPreloadTools 的族内
 * 排序）用「投票的证据本身」给命中域的族内工具排序，未上榜工具保持注册表序垫底。
 * 确定性：同语料同 query 恒同输出，复用跨轮 catalog 缓存。
 */
export function bm25HitsForQuery(
  query: string,
  searchableTools: ChatCompletionTool[],
  limit: number,
): Array<{ name: string; score: number }> {
  const trimmed = query.trim();
  if (!trimmed || limit <= 0) return [];
  const catalog = getOrCreateFullCatalog(searchableTools);
  return catalog.index
    .search(trimmed, limit, catalog.entries)
    .map((hit) => ({ name: hit.id, score: hit.score }));
}

/**
 * 域票全表（2026-10-09 L1 感知增强）：BM25 词面 top-5 按域归并的票数（降序）。
 * dominantDomainForQuery 只吐 top-1 强信号；多域意图（「去北京旅游顺便查天气」）
 * 与弱信号兜底需要完整票表——消费方（buildDomainPreloadTools）自行决定阈值。
 */
export function domainVotesForQuery(
  query: string,
  searchableTools: ChatCompletionTool[],
): Array<{ domain: string; votes: number }> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const catalog = getOrCreateFullCatalog(searchableTools);
  const hits = catalog.index.search(trimmed, 5, catalog.entries);
  const counts = new Map<string, number>();
  for (const hit of hits) {
    for (const domain of domainsForTool(hit.id)) {
      counts.set(domain, (counts.get(domain) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([domain, votes]) => ({ domain, votes }))
    .sort((a, b) => b.votes - a.votes || a.domain.localeCompare(b.domain));
}

/**
 * BM25 top-K 工具直取（2026-10-09 L1 弱信号兜底 / L3 错误即检索共用原语）。
 * 走 searchDeferredTools（BM25 + 意图先验）而非裸 RRF——意图先验命中（0.4-1.7）
 * 与噪声簇（≤0.05）的分离全靠它，裸 RRF 分不开。
 * 双闸过滤噪声（可调）：
 *   - 绝对闸 top1 ≥ minScore（默认 BM25_TOPK_MIN_SCORE=0.075，实测校准见常量注）
 *   - 相对闸 rank ≥ 0.35 × top1（防尾巴噪声工具混入）
 * 复用跨轮全量 catalog 缓存（同 dominantDomainForQuery），确定性恒同输出。
 * opts.minScore=0 用于 L3 幻觉名候选——模型直呼了具体名字，名字 token 命中
 * 本身就是证据，绝对闸会误杀（描述先验对英文名 query 无先验重叠）。
 */
export function topToolMatchesForQuery(
  query: string,
  searchableTools: ChatCompletionTool[],
  limit: number,
  excludeNames: ReadonlySet<string> = new Set(),
  opts: { minScore?: number } = {},
): Array<{ name: string; score: number }> {
  const trimmed = query.trim();
  if (!trimmed || limit <= 0) return [];
  const catalog = getOrCreateFullCatalog(searchableTools);
  const matches = searchDeferredTools(catalog, trimmed, Math.max(limit * 3, 8));
  const sorted = [...matches].sort((a, b) => b.score - a.score);
  const minScore = opts.minScore ?? BM25_TOPK_MIN_SCORE;
  const out: Array<{ name: string; score: number }> = [];
  for (const hit of sorted) {
    if (excludeNames.has(hit.name)) continue;
    if (out.length === 0 && hit.score < minScore) continue;
    if (out.length > 0 && hit.score < out[0].score * BM25_TOPK_RELATIVE_FLOOR) break;
    out.push({ name: hit.name, score: hit.score });
    if (out.length >= limit) break;
  }
  return out;
}

/** top-K 兜底绝对闸：RRF 分下限。实测校准（2026-10-09，全量语料 186 工具）：
 *  纯噪声簇（"嗯嗯好的"→voice 0.049、"找个X"→0.045-0.049）≤ ~0.05；同域二档
 *  （browser.session.list / smart_home.list_devices）≈0.08+；意图先验命中 0.4-1.7。
 *  取 0.075 = 噪声天花板之上、二档之下——宁缺勿滥，错误预载比不预载更糟。 */
const BM25_TOPK_MIN_SCORE = 0.075;
/** top-K 兜底相对闸：候选分须 ≥ top1 的 35%（RRF 序列衰减快，尾巴即噪声）。 */
const BM25_TOPK_RELATIVE_FLOOR = 0.35;

/** 先验直取绝对闸：意图证据 ≥ 此值才算命中。口径（2026-10-09 校准）：
 *  整短语包含（短语全 token 作为子串出现在 query，≥3 字）= 1.2 满分；
 *  部分重叠按 token IDF 求和 ×0.25（封顶 1.2）——通词（什么/帮我，IDF≈0）
 *  天然归零，稀有词（性价比/回家/盯）高贡献。实测：calendar.list_tasks 的
 *  「有什么安排」别名对「十一去北京玩有什么攻略」的通词泄漏 1.06 < 1.2 被闸掉，
 *  而真意图（回家模式/盯着/性价比/到家的时候）单短语整包含即满分。 */
const PRIOR_DIRECT_MIN_BONUS = 1.2;
/** 先验直取每查询上限（点信号再强也只是两个确切意图，不挤占域族面包） */
export const PRIOR_DIRECT_LIMIT = 2;

/** tokenize 结果的 entry 级缓存（元数据短语静态，catalog 重建即随 entry 失效） */
const _priorPhraseTokenCache = new WeakMap<
  DeferredToolEntry,
  Array<{ tokens: string[]; whole: string | null }>
>();

/** 短语 → [全 token 序列, 整词 token]；整词 = 短语首个 ≥3 字 CJK 连续段（整包含判定用） */
function priorPhraseTokens(entry: DeferredToolEntry): Array<{ tokens: string[]; whole: string | null }> {
  let cached = _priorPhraseTokenCache.get(entry);
  if (cached) return cached;
  const meta = getToolIntentMetadata(entry.registryName);
  const build = (phrase: string): { tokens: string[]; whole: string | null } | null => {
    const tokens = tokenize(phrase);
    if (tokens.length === 0) return null;
    const cjkRun = phrase.match(/[\u4e00-\u9fa5]{3,}/)?.[0] ?? null;
    const whole = cjkRun && tokens.includes(cjkRun) ? cjkRun : null;
    return { tokens, whole };
  };
  cached = [
    ...[...(meta.aliases ?? []), ...(meta.examples ?? [])].map(build).filter((p): p is { tokens: string[]; whole: string | null } => p !== null),
  ];
  _priorPhraseTokenCache.set(entry, cached);
  return cached;
}

/**
 * 意图先验直取（2026-10-09 L1 双通道之二）：对 query 直接扫意图元数据（别名/例句），
 * 证据分 ≥ PRIOR_DIRECT_MIN_BONUS 的工具按分降序取前 limit 个。
 *
 * 证据分口径：整短语包含（≥3 字连续段作为子串出现在 query）= 1.2 满分；部分重叠
 * 按 token IDF 求和 ×0.25 封顶 1.2；负例别名/例句同口径减分（封顶 1.5）。
 *
 * 为什么独立于 BM25 命中集：applyIntentPrior 只重排 BM25 命中——描述文本与
 * query 零词面重叠的工具连被加分的资格都没有（实测「到家的时候提醒我拿快递」
 * geofence.create raw/先验双 top-1 却被 calendar 假强域整族顶掉；「盯话题」
 * interest.manage 被 voice 族顶掉；「买什么耳机性价比高」shopping.suggest 连
 * BM25 前十都不进）。别名/例句命中本身就是意图证据，不该依赖描述词面。
 * 为什么 IDF 加权：无区分度加重叠计数会被通词击穿（「什么」出现在所有疑问句，
 * calendar.list_tasks 的「有什么安排」对任意「有什么X」query 泄漏）——IDF 让
 * 通词天然归零、意图词高贡献。噪声安全：闲聊 query 与别名零重叠 → 0。
 * 确定性：同语料同 query 恒同输出（复用跨轮 catalog 缓存）。
 */
export function priorDirectMatchesForQuery(
  query: string,
  searchableTools: ChatCompletionTool[],
  limit: number = PRIOR_DIRECT_LIMIT,
  excludeNames: ReadonlySet<string> = new Set(),
): Array<{ name: string; bonus: number }> {
  const trimmed = query.trim();
  if (!trimmed || limit <= 0) return [];
  const queryTokens = new Set(tokenize(trimmed));
  if (queryTokens.size === 0) return [];
  const catalog = getOrCreateFullCatalog(searchableTools);
  const idfOf = (t: string): number => catalog.index.idfOf(t);
  // 证据聚合：整包含命中（封顶 1 次——短语命中是饱和证据，不随条数累加）+
  // 去重 token 的 IDF 和（同一 token 跨短语重复计数会让单一通词堆过阈值，
  // 实测「提醒」在日历工具的多条例句里重复计分 → 误命中）。
  const evidence = (phrases: Array<{ tokens: string[]; whole: string | null }>): {
    wholeHit: boolean;
    idfSum: number;
  } => {
    let wholeHit = false;
    const distinct = new Set<string>();
    for (const { tokens, whole } of phrases) {
      if (whole && queryTokens.has(whole)) wholeHit = true;
      for (const t of tokens) if (queryTokens.has(t)) distinct.add(t);
    }
    return { wholeHit, idfSum: [...distinct].reduce((s, t) => s + idfOf(t), 0) };
  };
  const score = (p: { wholeHit: boolean; idfSum: number }, idfWeight: number, cap: number): number =>
    (p.wholeHit ? 1.2 : 0) + Math.min(cap, p.idfSum * idfWeight);
  const scored: Array<{ name: string; bonus: number }> = [];
  for (const entry of catalog.entries) {
    if (excludeNames.has(entry.registryName)) continue;
    const meta = getToolIntentMetadata(entry.registryName);
    if ((meta.aliases?.length ?? 0) + (meta.examples?.length ?? 0) === 0) continue;
    const pos = evidence(priorPhraseTokens(entry));
    const neg = evidence(
      [...(meta.negativeAliases ?? []), ...(meta.negativeExamples ?? [])]
        .map((p) => ({ tokens: tokenize(p), whole: p.match(/[\u4e00-\u9fa5]{3,}/)?.[0] ?? null }))
        .filter((p) => p.tokens.length > 0),
    );
    const bonus = score(pos, 0.25, 1.2) - Math.min(1.5, score(neg, 0.3, 1.2));
    if (bonus >= PRIOR_DIRECT_MIN_BONUS) {
      scored.push({ name: entry.registryName, bonus: Math.round(bonus * 1000) / 1000 });
    }
  }
  return scored
    .sort((a, b) => b.bonus - a.bonus || a.name.localeCompare(b.name))
    .slice(0, limit);
}

function computeToolsSignature(tools: ChatCompletionTool[]): string {
  const names = tools
    .map((t) => (t.type === "function" && t.function?.name ? t.function.name : ""))
    .filter(Boolean)
    .sort();
  return names.join(",");
}

/**
 * 取（或构建）全量 catalog。命中缓存时直接返回，否则重建并写入缓存。
 */
function getOrCreateFullCatalog(searchableTools: ChatCompletionTool[]): DeferredToolCatalog {
  const signature = computeToolsSignature(searchableTools);
  const now = Date.now();
  if (
    _fullCatalogCache &&
    _fullCatalogCache.signature === signature &&
    now - _fullCatalogCache.createdAt < FULL_CATALOG_TTL_MS
  ) {
    return _fullCatalogCache.full;
  }
  const full = buildDeferredCatalog(searchableTools);
  _fullCatalogCache = { signature, full, createdAt: now };
  return full;
}

/**
 * 从全量 catalog 派生 deferred catalog：复用全量 Bm25Index（IDF 基于全量更准确），
 * 只过滤 entries / byName / byApiName 为 deferred 子集。
 *
 * 搜索时 `searchDeferredTools` 用 `catalog.index.search` 返回全量 hit，
 * 再通过 `catalog.byName.get(hit.id)` 查找——visible 工具不在 byName 中，
 * 自然被 `filter((v) => v != null)` 过滤掉，不影响结果正确性。
 */
function deriveDeferredCatalog(
  full: DeferredToolCatalog,
  visibleNames: Set<string>,
): DeferredToolCatalog {
  const entries = full.entries.filter((e) => !visibleNames.has(e.registryName));
  const byName = new Map(entries.map((e) => [e.registryName, e]));
  const byApiName = new Map(
    entries.map((e) => [e.registryName.replace(/\./g, "_"), e] as const),
  );
  return {
    entries,
    index: full.index,
    byName,
    byApiName,
    embeddingIndex: full.embeddingIndex,
    embeddingReady: full.embeddingReady,
  };
}

/**
 * 核心工具库 + 延迟目录：核心工具直接暴露；其余工具 BM25 索引，经合并桥接按需加载。
 */
export function prepareToolsWithToolSearch(
  visibleCandidateTools: ChatCompletionTool[],
  searchableSourceTools: ChatCompletionTool[] = visibleCandidateTools,
): ToolSearchPreparedTurn {
  const cfg = getToolSearchConfig();
  const visibleTools = uniqueTools(visibleCandidateTools);
  const visibleNames = new Set(
    visibleTools
      .map((tool) => isFunctionName(tool))
      .filter((name): name is string => Boolean(name)),
  );
  const searchableTools = uniqueTools(searchableSourceTools);
  const deferred = searchableTools.filter((tool) => {
    const name = isFunctionName(tool);
    return Boolean(name) && !visibleNames.has(name as string);
  });

  // 复用全量 BM25 索引（跨轮缓存），每轮只过滤 entries
  const fullCatalog = getOrCreateFullCatalog(searchableTools);
  const deferredCatalog = deriveDeferredCatalog(fullCatalog, visibleNames);
  const active = shouldActivateToolSearch(
    deferred,
    cfg.enabled,
    cfg.thresholdPct,
    cfg.contextTokens,
  );

  if (!active) {
    return {
      visibleTools,
      deferredCatalog: buildDeferredCatalog([]),
      toolSearchActive: false,
      coreToolCount: visibleTools.length,
      deferredToolCount: 0,
    };
  }

  const bridgeTools = buildToolSearchBridgeTools(deferredCatalog.entries.length);
  return {
    visibleTools: uniqueTools([...visibleTools, ...bridgeTools]),
    deferredCatalog,
    toolSearchActive: true,
    coreToolCount: visibleTools.length,
    deferredToolCount: deferred.length,
  };
}

/** 测试/调试用：手动清空全量 catalog 缓存（MCP 重连等场景） */
export function invalidateFullCatalogCache(): void {
  _fullCatalogCache = null;
}

export {
  TOOL_SEARCH_BRIDGE_NAMES,
  isToolSearchBridgeName,
} from "./core-tools.js";
export {
  buildDeferredCatalog,
  estimateToolsSchemaTokens,
  type DeferredToolCatalog,
  type DeferredToolEntry,
  type DeferredToolSearchMatch,
} from "./catalog.js";
export {
  adaptiveSearchDeferredTools,
  loadAdaptiveCatalogSchema,
  summarizeAdaptiveCatalog,
  type AdaptiveCatalogSummary,
  type AdaptiveDeferredToolSearchMatch,
  type AdaptiveSearchOptions,
} from "./adaptive-catalog.js";
export { executeToolSearchBridge, type ResidentToolInfo, type ToolSearchBridgeResult } from "./handlers.js";
export * from "./registry/index.js";
export * from "./retrieval/history-score.js";
export * from "./retrieval/hybrid-retrieval.js";
export * from "./top-p-selector/top-p-selector.js";
export * from "./knowledge-graph/graph-relations.js";
export * from "./knowledge-graph/neo4j-client.js";
export * from "./lazy-loader/lazy-loader.js";
export * from "./lazy-loader/mcp-connection-pool.js";
export * from "./reranking/reranking-pipeline.js";
export * from "./observability/metrics.js";
