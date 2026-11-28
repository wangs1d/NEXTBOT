import type { QueryConstraints } from "../retrieval-intent.js";
import type { HybridRetrievedResource } from "../retrieval/hybrid-retrieval.js";

export type RerankInput = {
  raw_query: string;
  agent_context_hash: string;
  previous_tool_result?: unknown;
  query_constraints: QueryConstraints;
  candidates: HybridRetrievedResource[];
  blacklist_resource_ids?: string[];
};

export type LlmRerankOutput = {
  orderedIds: string[];
  scores?: Record<string, number>;
  applied?: boolean;
};

export type LlmReranker = (
  input: Omit<RerankInput, "candidates"> & {
    candidates: HybridRetrievedResource[];
  },
) => Promise<LlmRerankOutput>;

export type RerankingPipelineOptions = {
  llmReranker?: LlmReranker;
};

export type RerankResult = {
  candidates: HybridRetrievedResource[];
  rule_filtered_count: number;
  llm_seen_count: number;
  neural_applied: boolean;
};

/** 黑名单过滤后仅对低边际头部调用交叉编码器；采信失败时完整回退基线。 */
export class ToolRerankingPipeline {
  private readonly llmReranker: LlmReranker | undefined;

  constructor(options?: RerankingPipelineOptions) {
    this.llmReranker = options?.llmReranker;
  }

  async rerank(input: RerankInput): Promise<RerankResult> {
    const blacklist = new Set(input.blacklist_resource_ids ?? []);
    const rulePassed = input.candidates.filter((candidate) =>
      passesRules(candidate, blacklist),
    );

    const scoredCandidates = [...rulePassed].sort((a, b) => b.final_score - a.final_score);
    const topForLlm = scoredCandidates.slice(0, rerankTopN());
    const baseline = {
      candidates: scoredCandidates,
      rule_filtered_count: input.candidates.length - rulePassed.length,
      llm_seen_count: 0,
      neural_applied: false,
    };
    if (!this.llmReranker || !shouldRerank(topForLlm)) return baseline;

    try {
      const output = await this.llmReranker({
        raw_query: input.raw_query,
        agent_context_hash: input.agent_context_hash,
        previous_tool_result: input.previous_tool_result,
        query_constraints: input.query_constraints,
        candidates: topForLlm,
        blacklist_resource_ids: input.blacklist_resource_ids,
      });
      const ids = topForLlm.map((candidate) => candidate.resource.level1.resource_id);
      if (output.applied === false) return baseline;
      if (
        output.orderedIds.length !== ids.length ||
        new Set(output.orderedIds).size !== ids.length ||
        ids.some((id) => !output.orderedIds.includes(id))
      ) {
        throw new Error("reranker returned an invalid candidate permutation");
      }

      const byId = new Map(topForLlm.map((candidate) => [candidate.resource.level1.resource_id, candidate] as const));
      const neuralOrder = output.orderedIds.map((id) => byId.get(id)!);
      const neuralScores = neuralOrder.map((candidate) => output.scores?.[candidate.resource.level1.resource_id]);
      const hasNeuralScores = neuralScores.every((score) => typeof score === "number" && Number.isFinite(score));
      const accepted = hasNeuralScores
        ? acceptNeuralRerank(neuralOrder, neuralScores as number[], topForLlm[0]!)
        : true;
      if (!accepted) return { ...baseline, llm_seen_count: topForLlm.length };

      const neuralWeight = envFloat("AGENT_TOOL_RERANK_NEURAL_WEIGHT", 0.65, 0.1, 0.9);
      const calibrated = hasNeuralScores ? calibrateNeuralScores(neuralScores as number[]) : [];
      const rerankedTop = hasNeuralScores
        ? neuralOrder.map((candidate, index) => ({
            ...candidate,
            final_score: round4(clamp01(
              candidate.final_score * (1 - neuralWeight) + calibrated[index]! * neuralWeight,
            )),
          }))
        : neuralOrder;
      const headIds = new Set(topForLlm.map((candidate) => candidate.resource.level1.resource_id));
      const rest = scoredCandidates.filter((candidate) => !headIds.has(candidate.resource.level1.resource_id));
      const headQueue = [...rerankedTop];
      const tailQueue = [...rest];
      while (tailQueue.length > 0 && headQueue.length > 1) {
        const tailHead = tailQueue[0]!;
        const headLast = headQueue[headQueue.length - 1]!;
        if (tailHead.final_score <= headLast.final_score) break;
        tailQueue.shift();
        headQueue.splice(headQueue.length - 1, 0, tailHead);
      }
      return {
        candidates: [...headQueue, ...tailQueue],
        rule_filtered_count: input.candidates.length - rulePassed.length,
        llm_seen_count: topForLlm.length,
        neural_applied: true,
      };
    } catch (e) {
      console.warn("[tool-search:rerank] neural reranker failed, using baseline order", e);
      return { ...baseline, llm_seen_count: topForLlm.length };
    }
  }
}

function rerankTopN(): number {
  return clampEnvInt("AGENT_NEURAL_RERANK_TOP_N", 6, 2, 20);
}

function shouldRerank(candidates: HybridRetrievedResource[]): boolean {
  if (candidates.length < 3) return false;
  const first = candidates[0]!.final_score;
  const second = candidates[1]!.final_score;
  if (first <= 0) return false;
  const margin = (first - second) / first;
  const marginThreshold = envFloat("AGENT_TOOL_RERANK_MARGIN_THRESHOLD", 0.08, 0, 0.5);
  const evidenceFloor = envFloat("AGENT_TOOL_RERANK_EVIDENCE_FLOOR", 0.12, 0, 1);
  return margin < marginThreshold || first < evidenceFloor;
}

function acceptNeuralRerank(
  neuralOrder: HybridRetrievedResource[],
  scores: number[],
  baselineLeader: HybridRetrievedResource,
): boolean {
  const best = Math.max(...scores);
  const worst = Math.min(...scores);
  const sorted = [...scores].sort((a, b) => b - a);
  const margin = best - (sorted[1] ?? best);
  const minimumSeparation = envFloat("AGENT_TOOL_RERANK_MIN_SEPARATION", 0.05, 0, 20);
  const minimumMargin = envFloat("AGENT_TOOL_RERANK_MIN_MARGIN", 0.05, 0, 20);
  if (best - worst < minimumSeparation) return false;
  const changesLeader = neuralOrder[0]!.resource.level1.resource_id !== baselineLeader.resource.level1.resource_id;
  return !changesLeader || margin >= minimumMargin;
}

function calibrateNeuralScores(scores: number[]): number[] {
  const best = Math.max(...scores);
  const worst = Math.min(...scores);
  const range = best - worst;
  if (range < 1e-6) return scores.map(() => 0.5);
  return scores.map((score) => clamp01((score - worst) / range));
}

function clampEnvInt(name: string, fallback: number, min: number, max: number): number {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function envFloat(name: string, fallback: number, min: number, max: number): number {
  const value = Number.parseFloat(process.env[name] ?? "");
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function passesRules(
  candidate: HybridRetrievedResource,
  blacklist: Set<string>,
): boolean {
  const record = candidate.resource;
  return !blacklist.has(record.level1.resource_id) && record.level1.status === "online";
}

function round4(n: number): number {
  return Math.round(Math.max(0, Math.min(1, n)) * 10_000) / 10_000;
}
