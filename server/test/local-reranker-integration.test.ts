import assert from "node:assert/strict";
import test from "node:test";

import { resolveLocalRerankerModelDir } from "../src/tools/tool-search/local-reranker/local-reranker-engine.js";

test("真实本地交叉编码器：端点、鉴权、推理与语义排序", { skip: !resolveLocalRerankerModelDir() }, async () => {
  process.env.AGENT_NEURAL_RERANK_ENABLED = "on";
  process.env.AGENT_LOCAL_RERANKER_DISABLED = "0";
  process.env.AGENT_NEURAL_RERANK_TIMEOUT_MS = "5000";
  const { resetToolSearchConfigForTests } = await import("../src/tools/tool-search/env.js");
  resetToolSearchConfigForTests();
  const { warmLocalReranker, getLocalRerankerEndpoint } = await import(
    "../src/tools/tool-search/local-reranker/local-reranker-endpoint.js"
  );
  const { neuralRerank } = await import("../src/tools/tool-search/neural-sidecar.js");

  assert.equal(await warmLocalReranker(30_000), true);
  const endpoint = getLocalRerankerEndpoint();
  assert.ok(endpoint);
  const unauthorized = await fetch(`${endpoint.baseUrl}/rerank`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "外头冷不冷", documents: ["天气"] }),
  });
  assert.equal(unauthorized.status, 401);

  const result = await neuralRerank("外头冷不冷", [
    "weather.get_local 查询用户所在地的天气、气温与降雨预报",
    "calendar 创建或查询日程、会议、待办和定时提醒",
    "world.link 给好友发消息、回复好友消息或管理好友申请",
  ]);
  assert.ok(result);
  assert.equal(result.model, "bge-reranker-base");
  assert.equal(result.scores.length, 3);
  assert.ok(result.scores.every(Number.isFinite));
  assert.ok(result.scores[0]! > result.scores[1]!);
  assert.ok(result.scores[0]! > result.scores[2]!);
});
