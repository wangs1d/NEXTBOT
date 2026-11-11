/**
 * tool_discover 神经召回集成测试（N1/N2/N3 在线验收，2026-09-11）。
 *
 * 与 golden 回归的分工：
 *   - tool-discover-golden-recall.test.ts：神经通道全关，锁确定性基线；
 *   - 本文件：sidecar 在线时才跑（不可达自动 skip），验收「语义通道开着」的
 *     质量——重点覆盖 golden 之外的零词面重叠改写表达（BM25/别名够不着的长尾）。
 *
 * 运行方式：先启动 sidecar（见 neural-retrieval-sidecar/main.py），再跑
 *   npx tsx --test test/tool-discover-neural-recall.test.ts
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PA_DATA_DIR = mkdtempSync(join(tmpdir(), "tool-neural-"));
process.env.AGENT_TOKENJUICE_ENABLED = "0";
process.env.AGENT_TOOL_SEARCH_BACKEND = "adaptive";
process.env.AGENT_TOOL_SEARCH_ENABLED = "on";
// 神经通道全开（sidecar 提供向量；rerank/intent 走默认 auto）
process.env.AGENT_TOOL_SEARCH_EMBEDDING = "auto";
process.env.AGENT_TOOL_EMBEDDING_PROVIDER = "local";

const { probeNeuralSidecar } = await import("../src/tools/tool-search/neural-sidecar.js");
const sidecarUp = await probeNeuralSidecar(1_000);

/**
 * 改写表达黄金集：与期望工具的 name/description/别名几乎没有 token 重叠，
 * 词面通道（BM25/trigram/lexical boost）天然够不着——这正是 N1 语义召回
 * 要兑现的增量。topK 放宽到 3：神经通道的验收标准是「进入候选面」，
 * 排序精度由 golden 主集 + N2 重排共同保障。
 */
const NEURAL_GOLDEN: Array<{ query: string; expect: string[]; topK?: number }> = [
  { query: "外头冷不冷", expect: ["weather.get_local"], topK: 3 },
  { query: "我现在在哪儿", expect: ["clock.get_user_location"], topK: 3 },
  { query: "帮我定个明早七点的闹钟", expect: ["calendar"], topK: 3 },
  { query: "客厅有点暗", expect: ["smart_home"], topK: 3 },
];

type DiscoverMatch = { name: string; routing?: { confidence?: number } };

async function main(): Promise<void> {
  if (!sidecarUp) {
    test("neural sidecar 不可达：跳过神经召回测试（降级路径由 golden 覆盖）", { skip: true }, () => {});
    return;
  }

  const { getBuiltinAgentChatTools } = await import(
    "../src/external-model/openai-compatible-tool-loop.js"
  );
  const { prepareToolsWithToolSearch, executeToolSearchBridge } = await import(
    "../src/tools/tool-search/index.js"
  );
  const { ensureToolEmbeddings, invalidateEmbeddingCache } = await import(
    "../src/tools/tool-search/tool-embedding.js"
  );

  // ── 准备：显式把全目录工具向量经 sidecar 算齐 ──
  invalidateEmbeddingCache();
  const first = prepareToolsWithToolSearch([], getBuiltinAgentChatTools());
  const stats = await ensureToolEmbeddings(
    first.deferredCatalog.entries.map((e) => ({
      registryName: e.registryName,
      searchText: e.embeddingInput || e.searchText,
    })),
  );
  assert.ok(
    stats.computed + stats.reused >= 60,
    `sidecar 应补全绝大多数工具向量（computed=${stats.computed} reused=${stats.reused} failed=${stats.failed}）`,
  );

  // embedding 落盘后 builtAt 变化 → 新 catalog 对象换签名 → 索引带上真向量重建
  const prepared = prepareToolsWithToolSearch([], getBuiltinAgentChatTools());
  const catalog = prepared.deferredCatalog;
  assert.ok(catalog.embeddingIndex.size >= 60, "embedding 索引应已灌入 sidecar 向量");

  async function discover(query: string, limit = 5): Promise<DiscoverMatch[]> {
    const res = await executeToolSearchBridge("tool_discover", { query, limit }, catalog);
    assert.equal(res.ok, true, `tool_discover 应成功：${query}`);
    return (res.result as { matches?: DiscoverMatch[] }).matches ?? [];
  }

  test("N1 通电检查：query embedding 命中 sidecar（首查返回非空向量）", async () => {
    const { getQueryEmbedding } = await import("../src/tools/tool-search/tool-embedding.js");
    const vec = await getQueryEmbedding("外头冷不冷");
    assert.ok(vec && vec.length > 0, "sidecar 在线时 query embedding 不应为 null");
  });

  for (const c of NEURAL_GOLDEN) {
    const k = c.topK ?? 1;
    test(`neural@top${k}: 「${c.query}」→ ${c.expect.join(" | ")}`, async () => {
      const matches = await discover(c.query);
      const names = matches.map((m) => m.name);
      const hit = names.slice(0, k).some((n) => c.expect.includes(n));
      assert.ok(
        hit,
        `期望前 ${k} 名含 [${c.expect.join(", ")}]，实际：${names.slice(0, 5).join(" > ") || "(空)"}`,
      );
    });
  }

  test("neural 汇总：改写集 top-3 命中率不低于 2/3（语义通道有效性下限）", async () => {
    let hit = 0;
    for (const c of NEURAL_GOLDEN) {
      const names = (await discover(c.query)).map((m) => m.name);
      if (names.slice(0, 3).some((n) => c.expect.includes(n))) hit += 1;
    }
    assert.ok(
      hit >= Math.ceil((NEURAL_GOLDEN.length * 2) / 3),
      `top-3 命中 ${hit}/${NEURAL_GOLDEN.length}，低于语义通道有效性下限`,
    );
  });
}

await main();
