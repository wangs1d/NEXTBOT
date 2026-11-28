import { performance } from "node:perf_hooks";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadServerEnv } from "../src/config/load-server-env.js";
import { TOOL_RECALL_GOLDEN } from "./tool-recall-golden.js";

function arg(name: string, fallback: string): string {
  const inline = process.argv.find((value) => value.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1]! : fallback;
}

const rerankMode = arg("rerank", "off");
loadServerEnv();
process.env.AGENT_TOKENJUICE_ENABLED = "0";
process.env.AGENT_TOOL_SEARCH_ENABLED = "on";
process.env.AGENT_TOOL_SEARCH_EMBEDDING = "auto";
process.env.AGENT_TOOL_EMBEDDING_PROVIDER = "local";
process.env.AGENT_TOOL_SEARCH_EMBEDDING_MODEL = "bge-small-zh-v1.5";
process.env.AGENT_TOOL_SEARCH_EMBEDDING_CACHE = "tool-embeddings-bge-small-zh-v1.5-v2.json";
process.env.AGENT_LOCAL_EMBEDDING_DISABLED = "0";
process.env.AGENT_NEURAL_EMBED_MODEL = "bge-small-zh-v1.5";
process.env.AGENT_NEURAL_EMBED_ENABLED = "on";
process.env.AGENT_NEURAL_RERANK_ENABLED = rerankMode;
process.env.AGENT_LOCAL_RERANKER_DISABLED = "0";
process.env.AGENT_NEURAL_INTENT_ENABLED = "off";

const tag = arg("tag", "run");
const repeat = Math.max(2, Number(arg("repeat", "5")) || 5);
const scriptDir = dirname(fileURLToPath(import.meta.url));

type Match = { name: string; score: number };
type QualityRow = {
  id: string;
  group: string;
  query: string;
  expected: string[];
  forbidden: string[];
  forbiddenHit: boolean;
  rerankSeenCount: number;
  rerankApplied: boolean;
  rank: number | null;
  reciprocalRank: number;
  top1Hit: boolean;
  topKHit: boolean;
  topK: number;
  top5: Array<{ name: string; score: number }>;
  coldMs: number;
  hotP50Ms: number;
  hotP95Ms: number;
};

function percentile(samples: number[], p: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)]!;
}

function round(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

async function main(): Promise<void> {
  const { getBuiltinAgentChatTools } = await import(
    "../src/external-model/openai-compatible-tool-loop.js"
  );
  const search = await import("../src/tools/tool-search/index.js");
  const embedding = await import("../src/tools/tool-search/tool-embedding.js");
  const { resetToolSearchConfigForTests } = await import("../src/tools/tool-search/env.js");
  const { toolSearchMetrics } = await import("../src/tools/tool-search/observability/metrics.js");
  const { getAdaptiveSearchRouting } = await import("../src/tools/tool-search/adaptive-catalog.js");

  resetToolSearchConfigForTests();
  embedding.invalidateEmbeddingCache();
  search.invalidateFullCatalogCache();

  let embeddingWarmupMs = 0;
  const { warmLocalEmbedding } = await import("../src/agentic-memory/local-embedding/local-embedding-endpoint.js");
  const embeddingWarmupStarted = performance.now();
  if (!(await warmLocalEmbedding(30_000))) throw new Error("本地 embedding 未就绪，拒绝输出伪评测");
  embeddingWarmupMs = performance.now() - embeddingWarmupStarted;

  let rerankWarmupMs = 0;
  if (rerankMode !== "off") {
    const { warmLocalReranker } = await import("../src/tools/tool-search/local-reranker/local-reranker-endpoint.js");
    const started = performance.now();
    if (!(await warmLocalReranker(30_000))) throw new Error("本地交叉编码器未就绪，拒绝输出伪重排结果");
    rerankWarmupMs = performance.now() - started;
  }

  const tools = getBuiltinAgentChatTools();
  const buildStart = performance.now();
  const initial = search.prepareToolsWithToolSearch([], tools);
  const catalogBuildMs = performance.now() - buildStart;
  const entries = initial.deferredCatalog.entries;
  const corpus = new Set(entries.map((entry) => entry.registryName));

  const ids = new Set<string>();
  for (const testCase of TOOL_RECALL_GOLDEN) {
    if (ids.has(testCase.id)) throw new Error(`重复 golden id: ${testCase.id}`);
    ids.add(testCase.id);
    if (!testCase.expected.some((name) => corpus.has(name))) {
      throw new Error(`golden ${testCase.id} 的目标不在当前语料: ${testCase.expected.join("/")}`);
    }
  }

  const embeddingStart = performance.now();
  const embeddingStats = await embedding.ensureToolEmbeddings(
    entries.map((entry) => ({
      registryName: entry.registryName,
      embeddingViews: entry.embeddingViews,
    })),
  );
  const embeddingPrepareMs = performance.now() - embeddingStart;
  embedding.invalidateEmbeddingCache();
  search.invalidateFullCatalogCache();
  const prepared = search.prepareToolsWithToolSearch([], tools);
  const catalog = prepared.deferredCatalog;
  const cache = embedding.getToolEmbeddingCache();
  if (catalog.embeddingIndex.size === 0) {
    throw new Error("本地 embedding 未进入 adaptive 索引，拒绝输出伪基线");
  }
  if (cache.meta.model !== "bge-small-zh-v1.5" || cache.meta.dimension !== 512) {
    throw new Error(`缓存身份异常: ${cache.meta.model}/${cache.meta.dimension}`);
  }

  const rows: QualityRow[] = [];
  const allHotLatencies: number[] = [];
  const allColdLatencies: number[] = [];
  for (const testCase of TOOL_RECALL_GOLDEN) {
    const latencies: number[] = [];
    let names: string[] = [];
    let matches: Match[] = [];
    let rerankSeenCount = 0;
    let rerankApplied = false;
    for (let i = 0; i < repeat; i++) {
      const started = performance.now();
      const bridge = await search.executeToolSearchBridge(
        "tool_discover",
        { query: testCase.query, limit: Math.max(5, testCase.topK) },
        catalog,
      );
      latencies.push(performance.now() - started);
      const result = bridge.result as { matches?: Match[] };
      matches = result.matches ?? [];
      names = matches.map((match) => match.name);
      const routing = getAdaptiveSearchRouting(catalog);
      rerankSeenCount = routing?.rerank_seen_count ?? 0;
      rerankApplied = routing?.neural_applied ?? false;
    }
    const expectedRanks = testCase.expected
      .map((name) => names.indexOf(name))
      .filter((index) => index >= 0)
      .map((index) => index + 1);
    const rank = expectedRanks.length > 0 ? Math.min(...expectedRanks) : null;
    const coldMs = latencies[0]!;
    const hot = latencies.slice(1);
    allColdLatencies.push(coldMs);
    allHotLatencies.push(...hot);
    rows.push({
      id: testCase.id,
      group: testCase.group,
      query: testCase.query,
      expected: testCase.expected,
      forbidden: testCase.forbidden ?? [],
      forbiddenHit: (testCase.forbidden ?? []).some((name) => names.slice(0, testCase.topK).includes(name)),
      rerankSeenCount,
      rerankApplied,
      rank,
      reciprocalRank: rank ? 1 / rank : 0,
      top1Hit: rank === 1,
      topKHit: rank !== null && rank <= testCase.topK,
      topK: testCase.topK,
      top5: matches.slice(0, 5).map((match) => ({
        name: match.name,
        score: match.score,
      })),
      coldMs: round(coldMs, 2),
      hotP50Ms: round(percentile(hot, 50), 2),
      hotP95Ms: round(percentile(hot, 95), 2),
    });
  }

  const count = rows.length;
  const summary = {
    tag,
    measuredAt: new Date().toISOString(),
    mode: "local-bge-small-zh-v1.5-512",
    corpusSize: catalog.entries.length,
    embeddingIndexSize: catalog.embeddingIndex.size,
    embeddingModel: cache.meta.model,
    embeddingDimension: cache.meta.dimension,
    goldenCount: count,
    repeat,
    catalogBuildMs: round(catalogBuildMs, 2),
    embeddingPrepareMs: round(embeddingPrepareMs, 2),
    embeddingStats,
    embeddingWarmupMs: round(embeddingWarmupMs, 2),
    rerank: {
      enabled: rerankMode !== "off",
      warmupMs: round(rerankWarmupMs, 2),
      triggeredQueries: rows.filter((row) => row.rerankSeenCount > 0).length,
      triggerRate: round((rows.filter((row) => row.rerankSeenCount > 0).length / count) * 100, 2),
      appliedQueries: rows.filter((row) => row.rerankApplied).length,
      appliedRate: round((rows.filter((row) => row.rerankApplied).length / count) * 100, 2),
      metrics: toolSearchMetrics.snapshot().neural.rerank,
    },
    forbidden: {
      labeledQueries: rows.filter((row) => row.forbidden.length > 0).length,
      hitQueries: rows.filter((row) => row.forbiddenHit).length,
      hitRate: round((rows.filter((row) => row.forbiddenHit).length / Math.max(1, rows.filter((row) => row.forbidden.length > 0).length)) * 100, 2),
    },
    top1Rate: round((rows.filter((row) => row.top1Hit).length / count) * 100, 2),
    top3Rate: round((rows.filter((row) => row.topKHit).length / count) * 100, 2),
    mrr: round(rows.reduce((sum, row) => sum + row.reciprocalRank, 0) / count, 4),
    latencyMs: {
      coldP50: round(percentile(allColdLatencies, 50), 2),
      coldP95: round(percentile(allColdLatencies, 95), 2),
      hotP50: round(percentile(allHotLatencies, 50), 2),
      hotP95: round(percentile(allHotLatencies, 95), 2),
      hotMax: round(Math.max(...allHotLatencies), 2),
    },
    groups: Object.fromEntries(
      [...new Set(rows.map((row) => row.group))].map((group) => {
        const groupRows = rows.filter((row) => row.group === group);
        return [
          group,
          {
            count: groupRows.length,
            top1Rate: round((groupRows.filter((row) => row.top1Hit).length / groupRows.length) * 100, 2),
            top3Rate: round((groupRows.filter((row) => row.topKHit).length / groupRows.length) * 100, 2),
            mrr: round(groupRows.reduce((sum, row) => sum + row.reciprocalRank, 0) / groupRows.length, 4),
          },
        ];
      }),
    ),
    rows,
  };

  const outDir = join(scriptDir, "results");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `tool-recall-${tag}-${Date.now()}.json`);
  writeFileSync(outPath, JSON.stringify(summary, null, 2), "utf8");

  console.log(
    `[tool-recall:${tag}] corpus=${summary.corpusSize} vectors=${summary.embeddingIndexSize} ` +
      `top1=${summary.top1Rate}% top3=${summary.top3Rate}% MRR=${summary.mrr} ` +
      `forbidden=${summary.forbidden.hitRate}% rerank=${summary.rerank.triggerRate}% ` +
      `applied=${summary.rerank.appliedRate}% hot p50=${summary.latencyMs.hotP50}ms p95=${summary.latencyMs.hotP95}ms`,
  );
  for (const row of rows.filter((item) => !item.top1Hit)) {
    console.log(
      `  miss top1: ${row.query} → ${row.top5[0]?.name ?? "-"} ` +
        `(rank=${row.rank ?? "-"}, expected=${row.expected.join("/")})`,
    );
  }
  console.log(`明细 → ${outPath}`);
}

main().catch((error) => {
  console.error("[tool-recall] 评估失败:", error);
  process.exit(2);
});
