/**
 * tool 召回延迟基准（2026-09-06 建；2026-09-11 收口——Python tool-router 已删除，
 * 进程内 adaptive 是唯一检索管线，原场景 2/3（死服务降级/真实 primary）随之移除；
 * 同日补神经场景：sidecar 在线时对同一查询集再跑一遍「全开」基准，开/关双跑）。
 *
 * 量化 tool_discover 召回的端到端耗时，给「快速通道 2 波预算」和容量规划提供数字：
 * 冷启动（含目录/索引构建）与热查询 p50/p95。
 *
 * 用法：
 *   npx tsx scripts/eval-tool-recall.ts --repeat 50
 *   npx tsx scripts/eval-tool-recall.ts --scenario neural   # 需要 sidecar 在线，否则自动跳过
 */
import "dotenv/config";
import { performance } from "node:perf_hooks";
import { tmpdir } from "node:os";

process.env.PA_DATA_DIR = process.env.PA_DATA_DIR || join(tmpdir(), "pa-eval-tool-recall");
process.env.AGENT_TOKENJUICE_ENABLED = "0";
process.env.AGENT_TOOL_SEARCH_ENABLED = "on";
process.env.AGENT_TOOL_SEARCH_EMBEDDING = "off";

import { join } from "node:path";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}
const REPEAT = Math.max(3, Number(arg("repeat", "30")));
const SCENARIO = arg("scenario", "adaptive");

// 场景 1（adaptive）要测纯降级路径：神经注入点在模块 import 时定型，
// 必须在引入 index.js 之前把开关钉死（sidecar 在线与否都不影响本场景数字）
if (SCENARIO === "adaptive") {
  process.env.AGENT_NEURAL_SIDECAR_URL = "http://127.0.0.1:1";
  process.env.AGENT_NEURAL_EMBED_ENABLED = "off";
  process.env.AGENT_NEURAL_RERANK_ENABLED = "off";
  process.env.AGENT_NEURAL_INTENT_ENABLED = "off";
}

function pct(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}
const fmt = (ms: number) => `${ms.toFixed(1)}ms`;

async function main(): Promise<void> {
  const { getBuiltinAgentChatTools } = await import(
    "../src/external-model/openai-compatible-tool-loop.js"
  );
  const { prepareToolsWithToolSearch, executeToolSearchBridge } = await import(
    "../src/tools/tool-search/index.js"
  );
  const QUERIES = [
    "北京今天天气怎么样",
    "找几张猫的照片",
    "我在哪个城市",
    "现在几点了",
    "比特币现在什么价",
    "明天早上九点提醒我开会",
    "把客厅的灯打开",
    "看一下门口摄像头",
    "我钱包还有多少钱",
    "今天有什么热搜",
  ];

  // ── 进程内 adaptive（唯一检索管线；本场景 embedding/神经全关）──
  if (SCENARIO === "all" || SCENARIO === "adaptive") {
    const prepared = prepareToolsWithToolSearch([], getBuiltinAgentChatTools());
    const catalog = prepared.deferredCatalog;

    const t0 = performance.now();
    await executeToolSearchBridge("tool_discover", { query: QUERIES[0]!, limit: 5 }, catalog);
    const coldMs = performance.now() - t0;

    const samples: number[] = [];
    for (let i = 0; i < REPEAT; i++) {
      const q = QUERIES[i % QUERIES.length]!;
      const t = performance.now();
      await executeToolSearchBridge("tool_discover", { query: `${q} #${i}`, limit: 5 }, catalog);
      samples.push(performance.now() - t);
    }
    console.log("=== 场景 1：进程内 adaptive（降级安全路径，神经全关）===");
    console.log(
      `  工具数: ${catalog.entries.length} | 冷启动(含索引): ${fmt(coldMs)} | 热查询 ${REPEAT} 次: p50=${fmt(pct(samples, 50))} p95=${fmt(pct(samples, 95))} max=${fmt(Math.max(...samples))}`,
    );
    console.log(`  对照：快速通道预算 2 波 ≈ Flash 首 token ~500ms/波，召回 ${fmt(pct(samples, 95))} 占比 <3%`);
    console.log("");
  }

  // ── 神经全开（sidecar 在线才跑；量化 N1/N2/N3 的延迟代价）──
  if (SCENARIO === "all" || SCENARIO === "neural") {
    const { probeNeuralSidecar } = await import("../src/tools/tool-search/neural-sidecar.js");
    if (!(await probeNeuralSidecar(1_000))) {
      console.log("=== 场景 2：神经全开 —— sidecar 不可达，跳过（降级路径即场景 1）===");
      return;
    }
    // 配置读取是调用时的（getToolSearchConfig 每次现读 env），此处翻转即生效；
    // 模块级注入点（intent 神经路由 / rerank 钩子）默认 auto 已挂载，无需重启。
    process.env.AGENT_TOOL_SEARCH_EMBEDDING = "auto";
    process.env.AGENT_TOOL_EMBEDDING_PROVIDER = "local";

    const { ensureToolEmbeddings, invalidateEmbeddingCache } = await import(
      "../src/tools/tool-search/tool-embedding.js"
    );
    invalidateEmbeddingCache();
    const first = prepareToolsWithToolSearch([], getBuiltinAgentChatTools());
    const embStart = performance.now();
    const stats = await ensureToolEmbeddings(
      first.deferredCatalog.entries.map((e) => ({
        registryName: e.registryName,
        embeddingViews: e.embeddingViews,
      })),
    );
    const embMs = performance.now() - embStart;

    const prepared = prepareToolsWithToolSearch([], getBuiltinAgentChatTools());
    const catalog = prepared.deferredCatalog;

    const samples: number[] = [];
    for (let i = 0; i < REPEAT; i++) {
      const q = QUERIES[i % QUERIES.length]!;
      const t = performance.now();
      await executeToolSearchBridge("tool_discover", { query: `${q} #${i}`, limit: 5 }, catalog);
      samples.push(performance.now() - t);
    }
    console.log("=== 场景 2：神经全开（sidecar 在线：embed + rerank + intent）===");
    console.log(
      `  工具向量: computed=${stats.computed} reused=${stats.reused}（冷启动一次性 ${fmt(embMs)}，磁盘缓存后 0）`,
    );
    console.log(
      `  热查询 ${REPEAT} 次: p50=${fmt(pct(samples, 50))} p95=${fmt(pct(samples, 95))} max=${fmt(Math.max(...samples))}`,
    );
    console.log("  验收口径（方案 §1/§2）：embedding 通道冷启动 p95 < 100ms、低置信增量 < 120ms");
    console.log("");
  }

  console.log("结论模板：召回延迟预算 = 进程内 p95（上方数值）即上界——检索不再依赖任何外部服务可用性。");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
