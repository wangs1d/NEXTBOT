import assert from "node:assert/strict";
import test from "node:test";

import { ToolRerankingPipeline, type LlmReranker } from "../src/tools/tool-search/reranking/reranking-pipeline.js";
import type { HybridRetrievedResource } from "../src/tools/tool-search/retrieval/hybrid-retrieval.js";
import { DEFAULT_QUERY_CONSTRAINTS } from "../src/tools/tool-search/retrieval-intent.js";

function candidate(id: string, score: number): HybridRetrievedResource {
  return {
    resource: {
      level1: {
        resource_id: id,
        resource_type: "tool",
        name: id,
        description: `${id} description`,
        domain: ["test"],
        capability: ["test.query"],
        tags: [],
        version: "1.0.0",
        status: "online",
        base_score: 0.5,
        embeddings: [],
        latency_ms: 50,
      },
      level2: {
        resource_id: id,
        input_type: "object",
        output_type: "object",
        use_cases: [],
        limitations: [],
        preconditions: [],
        dependencies: [],
      },
      level3_pointer: id,
      versions: [],
      environment: "dev",
      tenant_id: "default",
      auth_level: "default",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    },
    final_score: score,
    components: {
      embedding_score: 0,
      keyword_score: 0,
      history_success_score: 0.5,
      latency_score: 0,
      failure_penalty: 0,
      base_score: 0.5,
      domain_match: 0,
      capability_match: 0,
      negative_match: 0,
    },
  };
}

function input(candidates: HybridRetrievedResource[]) {
  return {
    raw_query: "zzzzzz",
    agent_context_hash: "test",
    query_constraints: DEFAULT_QUERY_CONSTRAINTS,
    candidates,
  };
}

test("cascade：高边际候选不调用交叉编码器", async () => {
  let calls = 0;
  const reranker: LlmReranker = async () => {
    calls += 1;
    return { orderedIds: ["b", "a", "c"] };
  };
  const result = await new ToolRerankingPipeline({ llmReranker: reranker }).rerank(
    input([candidate("a", 0.8), candidate("b", 0.3), candidate("c", 0.1)]),
  );
  assert.equal(calls, 0);
  assert.equal(result.llm_seen_count, 0);
  assert.equal(result.neural_applied, false);
  assert.deepEqual(result.candidates.map((item) => item.resource.level1.resource_id), ["a", "b", "c"]);
});

test("cascade：低边际候选按校准神经分数有界融合", async () => {
  const result = await new ToolRerankingPipeline({
    llmReranker: async () => ({
      orderedIds: ["b", "a", "c"],
      scores: { b: 4, a: 1, c: -2 },
    }),
  }).rerank(input([candidate("a", 0.5), candidate("b", 0.49), candidate("c", 0.2)]));
  assert.equal(result.llm_seen_count, 3);
  assert.equal(result.neural_applied, true);
  assert.deepEqual(result.candidates.map((item) => item.resource.level1.resource_id), ["b", "a", "c"]);
  assert.ok(result.candidates.every((item) => item.final_score >= 0 && item.final_score <= 1));
  assert.ok(result.candidates[0]!.final_score > result.candidates[1]!.final_score);
});

test("cascade：神经分数缺乏区分度时完整回退基线", async () => {
  const baseline = [candidate("a", 0.5), candidate("b", 0.49), candidate("c", 0.2)];
  const result = await new ToolRerankingPipeline({
    llmReranker: async () => ({
      orderedIds: ["b", "a", "c"],
      scores: { b: 1, a: 1.001, c: 1.002 },
    }),
  }).rerank(input(baseline));
  assert.equal(result.llm_seen_count, 3);
  assert.equal(result.neural_applied, false);
  assert.deepEqual(result.candidates.map((item) => item.resource.level1.resource_id), ["a", "b", "c"]);
});

test("cascade：重排失败或候选排列非法时不改变基线", async () => {
  for (const llmReranker of [
    async () => { throw new Error("offline"); },
    async () => ({ orderedIds: ["a", "a", "c"], scores: { a: 2, c: 1 } }),
  ] as LlmReranker[]) {
    const result = await new ToolRerankingPipeline({ llmReranker }).rerank(
      input([candidate("a", 0.5), candidate("b", 0.49), candidate("c", 0.2)]),
    );
    assert.equal(result.llm_seen_count, 3);
    assert.equal(result.neural_applied, false);
    assert.deepEqual(result.candidates.map((item) => item.resource.level1.resource_id), ["a", "b", "c"]);
  }
});

test("cascade：只读约束不会硬删除写候选", async () => {
  const result = await new ToolRerankingPipeline().rerank({
    ...input([candidate("a", 0.8), candidate("b", 0.3), candidate("c", 0.1)]),
    query_constraints: { ...DEFAULT_QUERY_CONSTRAINTS, read_only: true },
  });
  assert.equal(result.rule_filtered_count, 0);
  assert.deepEqual(result.candidates.map((item) => item.resource.level1.resource_id), ["a", "b", "c"]);
});

test("cascade：零证据查询不触发神经重排", async () => {
  let calls = 0;
  const result = await new ToolRerankingPipeline({
    llmReranker: async () => {
      calls += 1;
      return { orderedIds: ["a", "b", "c"] };
    },
  }).rerank(input([candidate("a", 0), candidate("b", 0), candidate("c", 0)]));
  assert.equal(calls, 0);
  assert.equal(result.llm_seen_count, 0);
  assert.equal(result.neural_applied, false);
});
