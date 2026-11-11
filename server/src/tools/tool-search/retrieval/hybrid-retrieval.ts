import { Bm25Index, tokenize } from "../bm25.js";
import { cosineSimilarity } from "../tool-embedding-index.js";
import type { ResourceRecord } from "../registry/models.js";
import { HistoryScoreStore, type ResourceHistoryScore } from "./history-score.js";

export type HybridScoreComponents = {
  embedding_score: number;
  keyword_score: number;
  history_success_score: number;
  latency_score: number;
  failure_penalty: number;
  base_score: number;
  /** 意图域与候选域的重合度（Python retrieval.py 的 domain_match，1:1 移植） */
  domain_match: number;
  /** 意图能力与候选能力的重合度（Python retrieval.py 的 capability_match） */
  capability_match: number;
  /** 负例命中度（0~1）：声明的 negativeAliases/negativeExamples 被_query 命中的短语数归一 */
  negative_match: number;
};

export type HybridRetrievedResource = {
  resource: ResourceRecord;
  final_score: number;
  components: HybridScoreComponents;
};

/**
 * BM25 别名扩展条目（与 bm25.ts 的 SearchAliasEntry 结构一致）：
 * 携带工具的中文/多语言 searchAliases 与预计算 trigramSet，让关键词通道
 * 具备同义词扩展 + 字符级模糊匹配能力——这是中文口语表达能否命中的关键信号。
 */
export type HybridAliasEntry = {
  registryName: string;
  searchAliases?: string[];
  trigramSet?: Set<string>;
};

export type HybridRetrievalInput = {
  query: string;
  candidates: ResourceRecord[];
  queryVector?: number[] | Float32Array;
  limit?: number;
  prebuiltIndex?: Bm25Index; // 预构建 BM25 索引，复用避免每次新建
  /** 传给 BM25 的别名条目（缺省则退化为纯词面匹配，中文召回明显变差） */
  aliasEntries?: HybridAliasEntry[];
  /** 意图解析出的候选域（驱动 domain_match 打分，来自分层路由结果） */
  intentDomains?: string[];
  /** 意图解析出的候选能力（驱动 capability_match 打分） */
  intentCapabilities?: string[];
  /**
   * 负例短语表（resource_id → negativeAliases+negativeExamples）。声明的负例
   * 是"该工具经常被错误召回的 query 表达"，作为一价评分分量参与最终排序——
   * 此前负例只被 legacy 通道消费、adaptive 主通道从不读（死数据），干扰工具
   * （calendar.find_free_slots 抢"取消提醒/到家提醒"）长期霸榜的机制根源。
   */
  negativePhrasesById?: Map<string, string[]>;
};

export type HybridRetrievalWeights = {
  embedding: number;
  keyword: number;
  history: number;
  latency: number;
  failure: number;
  domain: number;
  capability: number;
  /** 负例惩罚权重（不参与正数归一，与 failure 同为直接减项） */
  negative: number;
};

export type HybridRetrievalOptions = {
  historyStore?: HistoryScoreStore;
};

/**
 * Phase-3 Hybrid Retrieval Engine.
 *
 * final_score =
 *   embedding*w1 + keyword*w2 + history_success*w3 + latency*w4 - failure_penalty*w5
 *
 * 所有分量都归一到 0~1；调用方必须传入分层路由后的 candidates。
 */
export class HybridRetrievalEngine {
  private readonly historyStore: HistoryScoreStore;

  constructor(options?: HybridRetrievalOptions) {
    this.historyStore = options?.historyStore ?? new HistoryScoreStore();
  }

  async search(input: HybridRetrievalInput): Promise<HybridRetrievedResource[]> {
    const candidates = input.candidates.filter((r) => r.level1.status === "online");
    if (candidates.length === 0) return [];
    const limit = Math.max(1, Math.min(100, input.limit ?? candidates.length));
    const hasQueryVector = Boolean(input.queryVector && input.queryVector.length > 0);
    const weights = weightsForQuery(input.query, hasQueryVector);
    const keywordScores = scoreKeywords(
      input.query,
      candidates,
      input.prebuiltIndex,
      input.aliasEntries,
    );

    const out: HybridRetrievedResource[] = [];
    for (const record of candidates) {
      const history = await this.historyStore.getScore(record.level1.resource_id);
      const components: HybridScoreComponents = {
        embedding_score: hasQueryVector
          ? scoreEmbedding(record, input.queryVector as number[] | Float32Array)
          : 0,
        keyword_score: keywordScores.get(record.level1.resource_id) ?? 0,
        history_success_score: applyColdStartBase(history, record.level1.base_score),
        latency_score: history.latency_score,
        failure_penalty: history.failure_penalty,
        base_score: record.level1.base_score,
        domain_match: overlapRatio(record.level1.domain, input.intentDomains),
        capability_match: overlapRatio(record.level1.capability, input.intentCapabilities),
        negative_match: negativeMatch(
          input.negativePhrasesById?.get(record.level1.resource_id),
          input.query,
        ),
      };
      const raw =
        components.embedding_score * weights.embedding +
        components.keyword_score * weights.keyword +
        components.history_success_score * weights.history +
        components.latency_score * weights.latency +
        components.domain_match * weights.domain +
        components.capability_match * weights.capability -
        components.failure_penalty * weights.failure -
        components.negative_match * weights.negative;
      out.push({
        resource: record,
        final_score: round4(clamp01(raw)),
        components,
      });
    }

    out.sort((a, b) => b.final_score - a.final_score);
    return out.slice(0, limit);
  }

  getHistoryStore(): HistoryScoreStore {
    return this.historyStore;
  }
}

/**
 * 权重档位：
 *   - 有真实 query 向量：语义通道主导（长句 0.6 / 短关键词 0.25）；
 *   - 无 query 向量：embedding 权重归零、关键词主导。
 *     此前无向量时用 hashTextToVector(query) 与工具哈希向量做 cosine——两个独立哈希的
 *     相似度是噪声，却在中文 bigram 分词把 token 数抬高后按"长句"拿 0.6 权重，
 *     直接把 weather.get_local / shopping.suggest 之类无关工具顶到 top-1。
 *     legacy 通道（catalog.ts）从来只在真实向量存在时才启用 embedding，这里对齐。
 */
export function weightsForQuery(query: string, hasQueryVector = true): HybridRetrievalWeights {
  const history = envFloat("AGENT_TOOL_SEARCH_HISTORY_WEIGHT", 0.2, 0, 1);
  const latency = envFloat("AGENT_TOOL_SEARCH_LATENCY_WEIGHT", 0.1, 0, 1);
  const failure = envFloat("AGENT_TOOL_SEARCH_FAILURE_WEIGHT", 0.2, 0, 1);
  // 域/能力匹配分量（Python retrieval.py 的 domain_match/capability_match 移植）。
  // Python 原值 0.15/0.25 是在其自身权重体系（embedding 0.3 + bm25 0.3 + …）里定的；
  // TS 通道的 keyword/embedding 分值分布更尖，等权照搬会把结构信号放大到盖过词面
  // 相关性（实测把 commitment.list 顶到「今天有什么热搜」top-1），按 TS 分布校准。
  const domain = envFloat("AGENT_TOOL_SEARCH_DOMAIN_WEIGHT", 0.06, 0, 1);
  const capability = envFloat("AGENT_TOOL_SEARCH_CAPABILITY_WEIGHT", 0.1, 0, 1);
  const negative = envFloat("AGENT_TOOL_SEARCH_NEGATIVE_WEIGHT", 0.35, 0, 1);
  if (!hasQueryVector) {
    return normalizeWeights({
      embedding: 0,
      keyword: 0.7,
      history,
      latency,
      failure,
      domain,
      capability,
      negative,
    });
  }
  const tokenCount = tokenize(query).length;
  const isShortKeyword = tokenCount <= 3;
  if (isShortKeyword) {
    return normalizeWeights({
      embedding: 0.25,
      keyword: 0.4,
      history,
      latency,
      failure,
      domain,
      capability,
      negative,
    });
  }
  return normalizeWeights({
    embedding: 0.6,
    keyword: 0.2,
    history,
    latency,
    failure,
    domain,
    capability,
    negative,
  });
}

function scoreKeywords(
  query: string,
  candidates: ResourceRecord[],
  prebuiltIndex?: Bm25Index,
  aliasEntries?: HybridAliasEntry[],
): Map<string, number> {
  // 极短 query（1-2 token）跳过 BM25：lexicalToolBoost 已覆盖 token 重叠
  if (tokenize(query).length <= 2) return new Map();

  if (prebuiltIndex) {
    const candidateIds = new Set(candidates.map((r) => r.level1.resource_id));
    // 放大 limit：全量索引里其他域的工具会挤占名额，候选集是子集时需多取再过滤
    const bm25Limit = Math.max(candidates.length * 2, 20);
    const hits = prebuiltIndex.search(query, bm25Limit, aliasEntries);
    const max = Math.max(...hits.map((h) => h.score), 0);
    const out = new Map<string, number>();
    for (const hit of hits) {
      if (!candidateIds.has(hit.id)) continue;
      out.set(hit.id, max > 0 ? clamp01(hit.score / max) : 0);
    }
    return out;
  }
  const docs = candidates.map((record) => ({
    id: record.level1.resource_id,
    text: searchableText(record),
  }));
  const index = new Bm25Index(docs);
  const hits = index.search(query, Math.max(candidates.length, 1), aliasEntries);
  const max = Math.max(...hits.map((h) => h.score), 0);
  const out = new Map<string, number>();
  for (const hit of hits) {
    out.set(hit.id, max > 0 ? clamp01(hit.score / max) : 0);
  }
  return out;
}

function scoreEmbedding(
  record: ResourceRecord,
  queryVector: number[] | Float32Array,
): number {
  const docVector = record.level1.embedding;
  if (!docVector.length || queryVector.length !== docVector.length) return 0;
  const cosine = cosineSimilarity(Array.from(queryVector), docVector);
  return clamp01((cosine + 1) / 2);
}

function searchableText(record: ResourceRecord): string {
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

function applyColdStartBase(
  history: ResourceHistoryScore,
  baseScore: number,
): number {
  if (history.sample_count === 0) return clamp01(baseScore);
  return clamp01(Math.max(history.history_success_score, baseScore * 0.35));
}

function normalizeWeights(weights: HybridRetrievalWeights): HybridRetrievalWeights {
  const positive =
    weights.embedding + weights.keyword + weights.history + weights.latency +
    weights.domain + weights.capability;
  if (positive <= 0) return weights;
  return {
    embedding: weights.embedding / positive,
    keyword: weights.keyword / positive,
    history: weights.history / positive,
    latency: weights.latency / positive,
    domain: weights.domain / positive,
    capability: weights.capability / positive,
    failure: weights.failure,
    negative: weights.negative,
  };
}

/**
 * 负例命中度：query 命中的负例短语数归一到 0~1（每条 0.5，两条封顶）。
 *
 * 命中判定（2026-11 修正）：
 *   - 整串出现：负例短语（≥2 字符）原样出现在 query 中 → 命中；
 *   - 否则要求 ≥2 个 token 重合。单 token 重合不算——中文负例短语
 *     （如 calendar.create 的「取消提醒」）包含正向核心词（「提醒」），
 *     按"任一 token 命中"会让本工具的正面例句（「明天早上九点提醒我开会」）
 *     反过来吃满负例惩罚，create 被 delete/list 反超。
 */
function negativeMatch(phrases: string[] | undefined, query: string): number {
  if (!phrases || phrases.length === 0) return 0;
  const qLower = query.trim().toLowerCase();
  const qTokens = new Set(tokenize(query));
  if (qTokens.size === 0) return 0;
  let hits = 0;
  for (const phrase of phrases) {
    const p = phrase.trim().toLowerCase();
    if (!p) continue;
    const tokens = tokenize(phrase);
    if (tokens.length === 0) continue;
    const direct = p.length >= 2 && qLower.includes(p);
    const overlap = tokens.filter((t) => qTokens.has(t)).length;
    if (direct || (tokens.length >= 2 && overlap >= 2)) hits += 1;
    if (hits >= 2) break;
  }
  return Math.min(1, hits * 0.5);
}

/** 意图集合与候选集合的重合度：|交| / |意图集|（意图集为空返回 0，不参与打分）。 */
function overlapRatio(candidateValues: string[], intentValues?: string[]): number {
  if (!intentValues || intentValues.length === 0) return 0;
  const candidateSet = new Set(candidateValues.map((v) => v.toLowerCase()));
  let hits = 0;
  for (const value of intentValues) {
    if (candidateSet.has(value.toLowerCase())) hits += 1;
  }
  return hits / intentValues.length;
}

function envFloat(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  const n = raw ? Number(raw) : fallback;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
