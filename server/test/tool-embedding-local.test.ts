import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  LOCAL_EMBEDDING_DIMS,
  LOCAL_EMBEDDING_MODEL_ID,
} from "../src/agentic-memory/local-embedding/local-embedding-engine.js";

const ENV_KEYS = [
  "AGENT_TOOL_EMBEDDING_PROVIDER",
  "AGENT_NEURAL_EMBED_ENABLED",
  "AGENT_NEURAL_EMBED_MODEL",
  "AGENT_TOOL_SEARCH_EMBEDDING",
  "AGENT_TOOL_SEARCH_EMBEDDING_MODEL",
  "AGENT_TOOL_SEARCH_EMBEDDING_CACHE",
  "AGENT_TOOL_SEARCH_EMBEDDING_API_KEY",
  "AGENT_EMBEDDING_API_KEY",
  "AGENT_NEURAL_SIDECAR_URL",
  "AGENT_LOCAL_EMBEDDING_DISABLED",
] as const;

test("本地工具 embedding 缓存隔离与 strict local-only", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "tool-embedding-local-"));
  const originalFetch = globalThis.fetch;
  const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

  process.env.AGENT_TOOL_EMBEDDING_PROVIDER = "local";
  process.env.AGENT_NEURAL_EMBED_ENABLED = "on";
  process.env.AGENT_NEURAL_EMBED_MODEL = LOCAL_EMBEDDING_MODEL_ID;
  process.env.AGENT_TOOL_SEARCH_EMBEDDING = "auto";
  process.env.AGENT_TOOL_SEARCH_EMBEDDING_MODEL = "BAAI/bge-m3";
  process.env.AGENT_TOOL_SEARCH_EMBEDDING_API_KEY = "probe-remote-key";
  process.env.AGENT_EMBEDDING_API_KEY = "probe-remote-key";
  process.env.AGENT_NEURAL_SIDECAR_URL = "http://127.0.0.1:1";
  delete process.env.AGENT_LOCAL_EMBEDDING_DISABLED;

  try {
    const { resetToolSearchConfigForTests } = await import("../src/tools/tool-search/env.js");
    const {
      ensureToolEmbeddings,
      getQueryEmbedding,
      getToolEmbedding,
      getToolEmbeddingCache,
      getToolEmbeddingsForCatalog,
      invalidateEmbeddingCache,
    } = await import("../src/tools/tool-search/tool-embedding.js");
    const { resetNeuralBreakers } = await import("../src/tools/tool-search/neural-sidecar.js");

    await t.test("本地模式忽略远端模型和错误维度缓存", () => {
      const cachePath = join(dir, "mixed-cache.json");
      process.env.AGENT_TOOL_SEARCH_EMBEDDING_CACHE = cachePath;
      resetToolSearchConfigForTests();
      invalidateEmbeddingCache();
      writeFileSync(
        cachePath,
        JSON.stringify({
          schemaVersion: 2,
          meta: { model: "BAAI/bge-m3", dimension: 1024, builtAt: Date.now() },
          entries: {
            stale: {
              contentHash: "same",
              model: "BAAI/bge-m3",
              views: [{ key: "definition", kind: "definition", contentHash: "same", vector: Array(1024).fill(0.1) }],
              updatedAt: Date.now(),
            },
            local: {
              contentHash: "same",
              model: LOCAL_EMBEDDING_MODEL_ID,
              views: [{ key: "definition", kind: "definition", contentHash: "same", vector: Array(LOCAL_EMBEDDING_DIMS).fill(0.2) }],
              updatedAt: Date.now(),
            },
            wrongDim: {
              contentHash: "same",
              model: LOCAL_EMBEDDING_MODEL_ID,
              views: [{ key: "definition", kind: "definition", contentHash: "same", vector: Array(LOCAL_EMBEDDING_DIMS - 1).fill(0.3) }],
              updatedAt: Date.now(),
            },
          },
        }),
      );

      assert.equal(getToolEmbedding("stale"), null);
      assert.equal(getToolEmbedding("wrongDim"), null);
      assert.equal(getToolEmbedding("local")?.length, LOCAL_EMBEDDING_DIMS);
      const active = getToolEmbeddingsForCatalog(["stale", "local", "wrongDim", "missing"]);
      assert.deepEqual([...active.keys()], ["local"]);
      assert.equal(getToolEmbeddingCache().entries.stale.model, "BAAI/bge-m3");
    });

    await t.test("本地失败时不请求远端或旧 sidecar", async () => {
      process.env.AGENT_TOOL_SEARCH_EMBEDDING_CACHE = join(dir, "empty-cache.json");
      process.env.AGENT_LOCAL_EMBEDDING_DISABLED = "1";
      resetToolSearchConfigForTests();
      invalidateEmbeddingCache();
      resetNeuralBreakers();
      let fetchCalls = 0;
      globalThis.fetch = (async (..._args: Parameters<typeof fetch>) => {
        fetchCalls += 1;
        throw new Error("network must not be called in local-only mode");
      }) as typeof fetch;

      assert.equal(await getQueryEmbedding("明天天气如何"), null);
      const stats = await ensureToolEmbeddings([
        { registryName: "probe.weather", searchText: "查询城市天气和降雨" },
      ]);
      assert.deepEqual(stats, { computed: 0, reused: 0, failed: 1 });
      assert.equal(fetchCalls, 0);
    });
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of ENV_KEYS) {
      const value = originalEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
