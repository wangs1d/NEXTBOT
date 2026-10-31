/**
 * 本地内置向量引擎（零配置记忆底座）单测。
 *
 * 模型资产（models/bge-small-zh-v1.5）缺失时整文件 skip——引擎逻辑在
 * probe-local-memory.ts 真链探针中另有一层覆盖。
 *
 * 跑法：node --import tsx --test test/local-embedding.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  initLocalEmbeddingEngine,
  resolveLocalEmbeddingModelDir,
  isLocalEmbeddingDisabled,
  LOCAL_EMBEDDING_DIMS,
} from "../src/agentic-memory/local-embedding/local-embedding-engine.js";
import {
  ensureLocalEmbeddingEndpoint,
  getLocalEmbeddingEndpoint,
} from "../src/agentic-memory/local-embedding/local-embedding-endpoint.js";

const modelDir = resolveLocalEmbeddingModelDir();
const hasModel = modelDir !== null && !isLocalEmbeddingDisabled();

test("本地引擎：装配、维度、语义方向、确定性", { skip: !hasModel && "模型资产缺失" }, async () => {
  const engine = await initLocalEmbeddingEngine();
  assert.ok(engine, "引擎应装配成功");
  assert.equal(engine!.model, "bge-small-zh-v1.5");
  assert.equal(engine!.dims, LOCAL_EMBEDDING_DIMS);

  const [apple, fruit, meeting] = await engine!.embed([
    "用户最喜欢吃的水果是苹果，每天都要吃一个。",
    "苹果是一种很好吃的水果",
    "明天下午三点开产品评审会",
  ]);
  assert.equal(apple!.length, LOCAL_EMBEDDING_DIMS);

  // 归一化：模长 ≈ 1
  const norm = Math.sqrt(apple!.reduce((s, v) => s + v * v, 0));
  assert.ok(Math.abs(norm - 1) < 1e-3, `模长应≈1，实际 ${norm}`);

  const cos = (a: number[], b: number[]) => a.reduce((s, v, i) => s + v * b[i]!, 0);
  assert.ok(cos(apple!, fruit!) > cos(apple!, meeting!) + 0.1, "相关对相似度应显著高于无关对");

  // 确定性：同输入同向量
  const again = await engine!.embed(["用户最喜欢吃的水果是苹果，每天都要吃一个。"]);
  assert.ok(Math.abs(cos(apple!, again[0]!) - 1) < 1e-5, "同输入应得到相同向量");

  // 空串：返回零向量且不崩
  const [empty] = await engine!.embed(["   "]);
  assert.equal(empty!.length, LOCAL_EMBEDDING_DIMS);
  assert.ok(empty!.every((v) => v === 0), "空串应得零向量");
});

test("本地引擎：超长文本截断不崩且维度不变", { skip: !hasModel && "模型资产缺失" }, async () => {
  const engine = await initLocalEmbeddingEngine();
  assert.ok(engine);
  const longText = "这是一段很长的记忆内容。".repeat(500); // 远超 512 token
  const [vec] = await engine!.embed([longText]);
  assert.equal(vec!.length, LOCAL_EMBEDDING_DIMS);
  assert.ok(vec!.some((v) => v !== 0), "截断后仍应有非零表示");
});

test("回环端点：OpenAI 格式 + base64 编码格式（openai-node v6 默认）", { skip: !hasModel && "模型资产缺失" }, async () => {
  process.env.AGENT_AGENTIC_MEMORY_DIR = mkdtempSync(join(tmpdir(), "pai-local-emb-test-"));
  const ep = await ensureLocalEmbeddingEndpoint();
  assert.ok(ep, "端点应启动");
  assert.equal(getLocalEmbeddingEndpoint()?.baseUrl, ep!.baseUrl);
  assert.ok(ep!.baseUrl.startsWith("http://127.0.0.1:"), "必须只绑回环");

  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${ep!.apiKey}` };

  // 端点先绑、模型后台加载：装载完成前 /embeddings 回 503，等 /health ok 再断言
  const readyDeadline = Date.now() + 30_000;
  for (;;) {
    const health = (await (await fetch(`${ep!.baseUrl}/health`)).json()) as { ok?: boolean };
    if (health.ok) break;
    if (Date.now() > readyDeadline) assert.fail("引擎在 30s 内未装载完成");
    await new Promise((r) => setTimeout(r, 100));
  }

  // float 格式（JSON 数组）
  const floatRes = await fetch(`${ep!.baseUrl}/embeddings`, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: ep!.model, input: ["苹果", "香蕉"] }),
  });
  assert.equal(floatRes.status, 200);
  const floatJson = (await floatRes.json()) as { data: Array<{ index: number; embedding: number[] }> };
  assert.equal(floatJson.data.length, 2);
  assert.deepEqual(floatJson.data.map((d) => d.index).sort(), [0, 1]);
  assert.ok(floatJson.data.every((d) => d.embedding.length === LOCAL_EMBEDDING_DIMS));

  // base64 格式：解码后与 float 一致
  const b64Res = await fetch(`${ep!.baseUrl}/embeddings`, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: ep!.model, input: ["苹果"], encoding_format: "base64" }),
  });
  const b64Json = (await b64Res.json()) as { data: Array<{ embedding: string }> };
  const raw = Buffer.from(b64Json.data[0]!.embedding, "base64");
  const decoded = Array.from(new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4));
  assert.equal(decoded.length, LOCAL_EMBEDDING_DIMS);
  const floatVec = floatJson.data[0]!.embedding;
  const maxErr = Math.max(...decoded.map((v, i) => Math.abs(v - floatVec[i]!)));
  assert.ok(maxErr < 1e-6, `base64 解码应与 float 一致，maxErr=${maxErr}`);

  // 鉴权：错 token 401；未带 token 401
  const bad = await fetch(`${ep!.baseUrl}/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer wrong" },
    body: JSON.stringify({ input: ["x"] }),
  });
  assert.equal(bad.status, 401);
  const noAuth = await fetch(`${ep!.baseUrl}/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input: ["x"] }),
  });
  assert.equal(noAuth.status, 401);

  // input 类型校验
  const badInput = await fetch(`${ep!.baseUrl}/embeddings`, {
    method: "POST",
    headers,
    body: JSON.stringify({ input: 42 }),
  });
  assert.equal(badInput.status, 400);
});
