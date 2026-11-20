import type { QueryConstraints } from "../retrieval-intent.js";
import type { HybridRetrievedResource } from "../retrieval/hybrid-retrieval.js";
import { tokenize } from "../bm25.js";

export type RerankInput = {
  raw_query: string;
  agent_context_hash: string;
  previous_tool_result?: unknown;
  query_constraints: QueryConstraints;
  candidates: HybridRetrievedResource[];
  blacklist_resource_ids?: string[];
  /** 意图路由命中的域/能力（限定业务加成的生效范围） */
  intent_domains?: string[];
  intent_capabilities?: string[];
};

export type LlmReranker = (
  input: Omit<RerankInput, "candidates"> & {
    candidates: HybridRetrievedResource[];
  },
) => Promise<string[]>;

export type RerankingPipelineOptions = {
  llmReranker?: LlmReranker;
};

export type RerankResult = {
  candidates: HybridRetrievedResource[];
  rule_filtered_count: number;
  llm_seen_count: number;
};

/**
 * 三阶段重排管线，与 Python router reranking.py 一比一对齐（2026-09-11 移植收口）：
 *   1. 规则过滤：黑名单 / 状态 / 只读约束（写关键词命中 name+description+tags 即剔除）
 *   2. Cross-Encoder：token 级 Jaccard(query, name+description+capability+tags)
 *      与现有 final_score 各占 0.5（此前是组件加权 remix，未做词面交叉）
 *   3. 业务规则层（Python 版内联的 "LLM business" 模拟）：只读请求偏好 query/get/search
 *      能力 +0.1，base_score 偏置 (base-0.5)*0.2，clamp [0,1]。可选外部 LlmReranker
 *      （神经重排）仍在其后生效，失败回退业务规则序。
 *
 * 有意偏离（记录在 docs/in-process-tool-search.md）：Python 版对
 * latency_ms > max_latency_ms 的候选直接剔除——原型默认预算仅 200ms，会误杀几乎所有
 * 联网/浏览器工具；这里改为软惩罚（-0.08）保留召回。
 */
export class ToolRerankingPipeline {
  private readonly llmReranker: LlmReranker | undefined;

  constructor(options?: RerankingPipelineOptions) {
    this.llmReranker = options?.llmReranker;
  }

  async rerank(input: RerankInput): Promise<RerankResult> {
    const blacklist = new Set(input.blacklist_resource_ids ?? []);
    const rulePassed = input.candidates.filter((candidate) =>
      passesRules(candidate, input.query_constraints, blacklist),
    );

    const queryTokens = setOfTokenize(input.raw_query);
    const crossEncoded = rulePassed
      .map((candidate) => ({
        ...candidate,
        final_score: crossEncoderScore(candidate, input.raw_query, queryTokens),
      }))
      .map((candidate) => ({
        ...candidate,
        final_score: businessScore(candidate, input.query_constraints, input.intent_capabilities),
      }))
      .sort((a, b) => b.final_score - a.final_score);

    const topForLlm = crossEncoded.slice(0, 10);
    // 采信门禁：词面通道还有信号（head 任一候选 keyword_score > 0）就不进外部
    // 重排——词面+校准已调优的查询上交叉编码接管是负收益（2026-09-12 A/B 实测：
    // 无条件接管 golden top-1 19/20→15/16）。词面全失效（纯改写 query）才交给
    // 神经重排；llm_seen_count=0 让调用方 boost 照常排序，基线路径零扰动。
    const lexicalDead =
      this.llmReranker && topForLlm.every((c) => (c.components?.keyword_score ?? 0) <= 0);
    if (!this.llmReranker || !lexicalDead || topForLlm.length <= 1) {
      return {
        candidates: crossEncoded,
        rule_filtered_count: input.candidates.length - rulePassed.length,
        llm_seen_count: 0,
      };
    }

    try {
      const orderedIds = await this.llmReranker({
        raw_query: input.raw_query,
        agent_context_hash: input.agent_context_hash,
        previous_tool_result: input.previous_tool_result,
        query_constraints: input.query_constraints,
        candidates: topForLlm,
        blacklist_resource_ids: input.blacklist_resource_ids,
      });      const rank = new Map(orderedIds.map((id, idx) => [id, idx]));
      const rerankedTop = [...topForLlm].sort((a, b) => {
        const ra = rank.get(a.resource.level1.resource_id) ?? Number.MAX_SAFE_INTEGER;
        const rb = rank.get(b.resource.level1.resource_id) ?? Number.MAX_SAFE_INTEGER;
        return ra - rb;
      });
      const rest = crossEncoded.slice(10);
      return {
        candidates: [...rerankedTop, ...rest],
        rule_filtered_count: input.candidates.length - rulePassed.length,
        llm_seen_count: topForLlm.length,
      };
    } catch (e) {
      console.warn("[tool-search:rerank] LLM reranker failed, using cross-encoder order", e);
      return {
        candidates: crossEncoded,
        rule_filtered_count: input.candidates.length - rulePassed.length,
        llm_seen_count: 0,
      };
    }
  }
}

/** Python reranking.py 的写关键词表（name+description+tags 连接后做子串命中）。 */
const WRITE_KEYWORDS = [
  "delete",
  "remove",
  "write",
  "send",
  "create",
  "update",
  "transfer",
  "pay",
  "删除",
  "发送",
  "创建",
  "更新",
  "转账",
  "支付",
];

function passesRules(
  candidate: HybridRetrievedResource,
  constraints: QueryConstraints,
  blacklist: Set<string>,
): boolean {
  const record = candidate.resource;
  if (blacklist.has(record.level1.resource_id)) return false;
  if (record.level1.status !== "online") return false;
  if (constraints.read_only && isLikelyWriteResource(candidate)) return false;
  return true;
}

function crossEncoderScore(
  candidate: HybridRetrievedResource,
  query: string,
  queryTokens: Set<string>,
): number {
  // 第二层：token 级 Jaccard 模拟 cross-encoder（与 Python reranking.py:57-75 一致）
  const level1 = candidate.resource.level1;
  const docText = [level1.name, level1.description, ...level1.capability, ...level1.tags].join(" ");
  const docTokens = setOfTokenize(docText);
  let intersection = 0;
  for (const token of queryTokens) {
    if (docTokens.has(token)) intersection += 1;
  }
  const union = new Set([...queryTokens, ...docTokens]).size;
  const jaccard = union > 0 ? intersection / union : 0;
  const score = 0.5 * candidate.final_score + 0.5 * jaccard;
  return round4(Math.max(0, Math.min(1, score)));
}

/** 意图动作 → 同义动作族（与 adaptive-catalog normalizeActionAliases 同源）：检出
 * 写动词放开的查询（「提醒我开会」=schedule/create），创建动作族候选应在同分的
 * 删除/列举候选之前——2026-09-12 golden 实证：create_from_text 与 delete_task
 * 同分 0.491，靠数组序定名次导致 top-3 漂移。 */
const ACTION_FAMILY: Record<string, string> = {
  schedule: "create",
  plan: "create",
  add: "create",
  set: "create",
  fetch: "query",
  read: "query",
  list: "query",
  inspect: "query",
  dial: "call",
  dispatch: "call",
};

function businessScore(
  candidate: HybridRetrievedResource,
  constraints: QueryConstraints,
  intentCapabilities?: string[],
): number {
  // 第三层：业务规则（与 Python reranking.py:77-98 一致：只读请求偏好
  // query/search/get 能力 +0.1，base_score 偏置 (base-0.5)*0.2）。
  // 有意偏离：超时预算软惩罚替代 Python 的硬剔除（见类注释）。
  const record = candidate.resource;
  let bonus = 0;
  if (constraints.read_only) {
    const caps = record.level1.capability.join(" ").toLowerCase();
    if (["query", "search", "get"].some((k) => caps.includes(k))) bonus += 0.1;
  }
  // 意图动作对齐：意图能力（含其同义族）与候选能力后缀相交 +0.05——只对
  // 「检出写意图/动作明确」的查询生效，幅度小于词面分量，不扰动其他排序。
  if (intentCapabilities?.length) {
    const wanted = new Set<string>();
    for (const cap of intentCapabilities) {
      const suffix = cap.split(".")[1]?.toLowerCase();
      if (suffix) {
        wanted.add(suffix);
        const family = ACTION_FAMILY[suffix];
        if (family) wanted.add(family);
      }
    }
    if (wanted.size > 0) {
      const hit = record.level1.capability.some((cap) =>
        wanted.has(cap.split(".")[1]?.toLowerCase() ?? ""),
      );
      if (hit) bonus += 0.05;
    }
  }
  bonus += (record.level1.base_score - 0.5) * 0.2;
  if (record.level1.latency_ms > constraints.max_latency_ms) bonus -= 0.08;
  return round4(Math.max(0, Math.min(1, candidate.final_score + bonus)));
}

/**
 * 写资源判定（read_only 过滤用）。
 * Python 原型扫 name+description+tags 全文——但描述常含「查询已创建的日程」这类
 * 引用写动作的措辞，会把 calendar.list_tasks 误判为写工具。这里收窄到
 * name + capability（结构化信号）：calendar.list_tasks 的能力是 list/query，
 * calendar.create 的能力是 create——语义精确，误杀为零。
 */
function isLikelyWriteResource(candidate: HybridRetrievedResource): boolean {
  const level1 = candidate.resource.level1;
  const text = `${level1.name} ${level1.capability.join(" ")}`.toLowerCase();
  return WRITE_KEYWORDS.some((kw) => text.includes(kw));
}

function setOfTokenize(text: string): Set<string> {
  return new Set(tokenize(text));
}

function round4(n: number): number {
  return Math.round(Math.max(0, Math.min(1, n)) * 10_000) / 10_000;
}
