/**
 * Embedding 端点解析优先级单测（2026-11-04 本地引擎升为首选）。
 *
 * 背景：手机端部署在云端，远端 Embedding 供应商（SiliconFlow）账户余额耗尽 402
 * 曾导致长期记忆召回全链路瘫痪。端点解析必须满足：
 *  1. 本地内置引擎就绪 → 永远首选（远端配置了也不走）；
 *  2. 本地不可用（未就绪/被禁用）→ 远端显式配置兜底；
 *  3. 两者都不可用 → null（消费方按既有降级路径禁用向量化）。
 *
 * 跑法：node --import tsx --test test/embedding-endpoint-priority.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";

import { resolveEmbeddingEndpoint } from "../src/services/openai-embedding-client.js";
import {
  ensureLocalEmbeddingEndpoint,
  getLocalEmbeddingEndpoint,
} from "../src/agentic-memory/local-embedding/local-embedding-endpoint.js";
import {
  resolveLocalEmbeddingModelDir,
  isLocalEmbeddingDisabled,
} from "../src/agentic-memory/local-embedding/local-embedding-engine.js";

/** 保存/恢复测试涉及的环境变量，避免污染同进程后续用例 */
const ENV_KEYS = [
  "AGENT_EMBEDDING_BASE_URL",
  "AGENT_EMBEDDING_API_KEY",
  "OPENAI_EMBEDDINGS_URL",
  "OPENAI_API_KEY",
] as const;
const savedEnv = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));

function setRemoteEnv() {
  process.env.AGENT_EMBEDDING_BASE_URL = "https://remote.example/v1";
  process.env.AGENT_EMBEDDING_API_KEY = "sk-test-valid-key-000000";
}

test("本地未就绪 + 远端显式配置 → 远端兜底", () => {
  savedEnv.forEach((v, k) => delete process.env[k]);
  setRemoteEnv();
  const ep = resolveEmbeddingEndpoint();
  assert.ok(ep, "远端显式配置应可解析出端点");
  assert.equal(ep!.baseUrl, "https://remote.example/v1");
});

test("本地未就绪 + 无远端配置 → null（向量化禁用降级）", () => {
  savedEnv.forEach((v, k) => delete process.env[k]);
  assert.equal(resolveEmbeddingEndpoint(), null);
});

test(
  "本地引擎就绪 → 永远首选（远端配置了也不走）",
  { skip: (resolveLocalEmbeddingModelDir() === null || isLocalEmbeddingDisabled()) && "模型资产缺失" },
  async () => {
    savedEnv.forEach((v, k) => delete process.env[k]);
    setRemoteEnv();

    assert.equal(getLocalEmbeddingEndpoint(), null, "前提：本地端点尚未拉起");
    const local = await ensureLocalEmbeddingEndpoint();
    assert.ok(local, "本地端点应启动成功");

    const ep = resolveEmbeddingEndpoint();
    assert.ok(ep);
    assert.equal(ep!.baseUrl, local!.baseUrl, "本地就绪必须优先于远端配置");
    assert.equal(ep!.model, local!.model, "模型名应取本地引擎（bge-small-zh-v1.5）");
    assert.equal(ep!.model, "bge-small-zh-v1.5");
  },
);

test.after?.(() => {
  savedEnv.forEach((v, k) => {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  });
});
