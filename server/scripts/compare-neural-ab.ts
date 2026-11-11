/**
 * 神经检索 A/B 对比基准（docs/neural-retrieval-plan.md §7 验收配套）。
 *
 * 同一查询集、同一目录，仅神经开关不同，分两个进程跑（注入点在 import 时定型）：
 *   关：npx tsx scripts/compare-neural-ab.ts --tag off --neural off
 *   开：npx tsx scripts/compare-neural-ab.ts --tag on  --neural on   （需 sidecar 在线）
 *
 * 输出：golden 21 条 + 零词面重叠改写集的 top-1/top-3 命中、每查询冷/热延迟、
 * 30 条合成冷查询 p50/p95——两份输出拼成前后对比表。
 */
import "dotenv/config";
import { performance } from "node:perf_hooks";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}
const TAG = arg("tag", "off");
const NEURAL = arg("neural", "off");

process.env.PA_DATA_DIR = mkdtempSync(join(tmpdir(), `pa-ab-${TAG}`));
process.env.AGENT_TOKENJUICE_ENABLED = "0";
process.env.AGENT_TOOL_SEARCH_ENABLED = "on";
process.env.AGENT_TOOL_SEARCH_BACKEND = "adaptive";

if (NEURAL === "off") {
  // 神经全关：embedding off + 注入点在 import 前钉死不可达（≈ 改造前基线）
  process.env.AGENT_TOOL_SEARCH_EMBEDDING = "off";
  process.env.AGENT_TOOL_EMBEDDING_PROVIDER = "openai";
  process.env.AGENT_NEURAL_SIDECAR_URL = "http://127.0.0.1:1";
  process.env.AGENT_NEURAL_EMBED_ENABLED = "off";
  process.env.AGENT_NEURAL_RERANK_ENABLED = "off";
  process.env.AGENT_NEURAL_INTENT_ENABLED = "off";
} else {
  process.env.AGENT_TOOL_SEARCH_EMBEDDING = "auto";
  process.env.AGENT_TOOL_EMBEDDING_PROVIDER = "local";
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

// ── 查询集 ──
// golden 21 条：与 tool-discover-golden-recall.test.ts 同源（词面友好，回归面）
const GOLDEN: Array<{ query: string; expect: string[]; topK: number }> = [
  { query: "北京今天天气怎么样", expect: ["weather.get_local"], topK: 1 },
  { query: "找几张猫的照片", expect: ["search_images", "search_images_batch"], topK: 1 },
  { query: "我在哪个城市", expect: ["clock.get_user_location"], topK: 1 },
  { query: "今天有什么热搜", expect: ["hot_rankings"], topK: 1 },
  { query: "找个教做红烧肉的视频", expect: ["search_videos"], topK: 1 },
  { query: "把客厅的灯打开", expect: ["smart_home"], topK: 1 },
  { query: "比特币现在什么价", expect: ["search_web", "deep_search"], topK: 3 },
  { query: "帮我搜一下刘浩存最近的消息", expect: ["search_web", "deep_search"], topK: 3 },
  { query: "读一下这个网页 https://example.com 说了什么", expect: ["fetch_web", "info.inspect_webpage"], topK: 3 },
  { query: "明天早上九点提醒我开会", expect: ["calendar"], topK: 3 },
  { query: "我有哪些日程", expect: ["calendar"], topK: 3 },
  { query: "取消明天那个提醒", expect: ["calendar"], topK: 3 },
  { query: "记住我妈生日是5月20号", expect: ["care.set_important_date"], topK: 3 },
  { query: "到家的时候提醒我拿快递", expect: ["geofence"], topK: 3 },
  { query: "每天提醒我喝水", expect: ["calendar"], topK: 3 },
  { query: "我答应过你什么", expect: ["commitment.list"], topK: 3 },
];
// 补第 21 条（golden 测试里第 21 条是汇总测试本身）
GOLDEN.push({ query: "找个附近的咖啡馆", expect: ["search_web", "deep_search", "map.search_nearby"], topK: 3 });

// 改写集：与期望工具的 name/description/别名几乎零 token 重叠，BM25/别名天然够不着
const PARAPHRASE: Array<{ query: string; expect: string[]; topK: number }> = [
  { query: "外头冷不冷", expect: ["weather.get_local"], topK: 3 },
  { query: "我现在在哪儿", expect: ["clock.get_user_location"], topK: 3 },
  { query: "帮我定个明早七点的闹钟", expect: ["calendar"], topK: 3 },
  { query: "客厅有点暗", expect: ["smart_home"], topK: 3 },
  { query: "下午三点记得喊我去拿快递", expect: ["calendar"], topK: 3 },
];

type Match = { name: string };

async function discover(catalog: ReturnType<typeof prepareToolsWithToolSearch>["deferredCatalog"], query: string): Promise<Match[]> {
  const res = await executeToolSearchBridge("tool_discover", { query, limit: 5 }, catalog);
  return ((res.result as { matches?: Match[] }).matches ?? []);
}

async function main(): Promise<void> {
  // ── 目录准备（ON 模式先把 sidecar 向量算齐，一次性成本不计入查询延迟）──
  invalidateEmbeddingCache();
  const p1 = prepareToolsWithToolSearch([], getBuiltinAgentChatTools());
  const embStart = performance.now();
  const stats = await ensureToolEmbeddings(
    p1.deferredCatalog.entries.map((e) => ({
      registryName: e.registryName,
      searchText: e.embeddingInput || e.searchText,
    })),
  );
  const embMs = performance.now() - embStart;
  const catalog = prepareToolsWithToolSearch([], getBuiltinAgentChatTools()).deferredCatalog;

  // ── 质量轮：golden + 改写，各查询首遇（冷）──
  const rows: Array<{ set: string; query: string; hit: boolean; top1: string; ms: number }> = [];
  let g1 = 0;
  let g3 = 0;
  for (const c of GOLDEN) {
    const t = performance.now();
    const names = (await discover(catalog, c.query)).map((m) => m.name);
    const ms = performance.now() - t;
    const hit1 = c.expect.includes(names[0] ?? "");
    const hit3 = names.slice(0, c.topK).some((n) => c.expect.includes(n));
    if (hit1) g1 += 1;
    if (hit3) g3 += 1;
    rows.push({ set: "golden", query: c.query, hit: hit3, top1: names[0] ?? "(空)", ms });
  }
  let p1hit = 0;
  let p3hit = 0;
  for (const c of PARAPHRASE) {
    const t = performance.now();
    const names = (await discover(catalog, c.query)).map((m) => m.name);
    const ms = performance.now() - t;
    const hit1 = c.expect.includes(names[0] ?? "");
    const hit3 = names.slice(0, c.topK).some((n) => c.expect.includes(n));
    if (hit1) p1hit += 1;
    if (hit3) p3hit += 1;
    rows.push({ set: "改写", query: c.query, hit: hit3, top1: names[0] ?? "(空)", ms });
  }

  // ── 热轮：同一批查询再跑一遍（LRU/路由缓存命中，测稳态延迟）──
  let warmSum = 0;
  let warmN = 0;
  for (const c of [...GOLDEN, ...PARAPHRASE]) {
    const t = performance.now();
    await discover(catalog, c.query);
    warmSum += performance.now() - t;
    warmN += 1;
  }

  // ── 合成冷查询 30 条（唯一后缀，模拟生产低重复率）──
  const QUERIES = GOLDEN.map((g) => g.query);
  const cold: number[] = [];
  for (let i = 0; i < 30; i++) {
    const q = `${QUERIES[i % QUERIES.length]} #${i}`;
    const t = performance.now();
    await discover(catalog, q);
    cold.push(performance.now() - t);
  }
  cold.sort((a, b) => a - b);
  const pct = (p: number) => cold[Math.min(cold.length - 1, Math.max(0, Math.ceil((p / 100) * cold.length) - 1))]!;

  // ── 输出 ──
  console.log(`\n########## A/B 结果 [${TAG}]（神经=${NEURAL}） ##########`);
  console.log(`目录工具数: ${catalog.entries.length} | embedding 索引: ${catalog.embeddingIndex.size} | 向量补全: computed=${stats.computed} reused=${stats.reused}${stats.computed > 0 ? `（一次性 ${(embMs / 1000).toFixed(1)}s）` : ""}`);
  console.log(`golden  top-1: ${g1}/${GOLDEN.length}  top-3: ${g3}/${GOLDEN.length}`);
  console.log(`改写集  top-1: ${p1hit}/${PARAPHRASE.length}  top-3: ${p3hit}/${PARAPHRASE.length}   ← 零词面重叠，语义通道主战场`);
  console.log(`逐查询冷延迟: p50=${pct(50).toFixed(0)}ms p95=${pct(95).toFixed(0)}ms max=${cold[cold.length - 1]!.toFixed(0)}ms（30 条唯一后缀）`);
  console.log(`同批查询热延迟（缓存命中）: 平均=${(warmSum / warmN).toFixed(0)}ms`);
  console.log("—— 明细（未命中标 ✗）——");
  for (const r of rows) {
    console.log(`${r.hit ? " " : "✗"} [${r.set}] ${r.ms.toFixed(0).padStart(4)}ms  ${r.query}  → ${r.top1}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
