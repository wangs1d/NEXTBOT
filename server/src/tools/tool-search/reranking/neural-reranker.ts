import type { LlmReranker } from "./reranking-pipeline.js";
import type { HybridRetrievedResource } from "../retrieval/hybrid-retrieval.js";
import { isNeuralFeatureEnabled, neuralRerank } from "../neural-sidecar.js";

const DOCUMENT_CHARS = clampEnvInt("AGENT_NEURAL_RERANK_DOC_CHARS", 450, 200, 4_000);

function clampEnvInt(name: string, fallback: number, min: number, max: number): number {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function rerankDocument(candidate: HybridRetrievedResource): string {
  const { level1, level2 } = candidate.resource;
  return [
    level1.name,
    level1.description,
    ...level2.use_cases,
    ...level1.capability,
    ...level1.tags,
    ...level2.preconditions,
  ]
    .filter(Boolean)
    .join(" ")
    .slice(0, DOCUMENT_CHARS);
}

export function createNeuralLlmReranker(): LlmReranker | undefined {
  if (!isNeuralFeatureEnabled("rerank")) return undefined;

  return async (input) => {
    const ids = input.candidates.map((candidate) => candidate.resource.level1.resource_id);
    const result = await neuralRerank(
      input.raw_query,
      input.candidates.map(rerankDocument),
    );
    if (!result) return { orderedIds: ids, applied: false };
    if (result.scores.length !== ids.length) {
      throw new Error(`neural rerank score count mismatch: ${result.scores.length} != ${ids.length}`);
    }
    const headOrder = input.candidates
      .map((candidate, index) => ({
        id: ids[index]!,
        score: result.scores[index] ?? 0,
      }))
      .sort((a, b) => b.score - a.score);
    return {
      orderedIds: headOrder.map((item) => item.id),
      scores: Object.fromEntries(headOrder.map((item) => [item.id, item.score])),
      applied: true,
    };
  };
}
