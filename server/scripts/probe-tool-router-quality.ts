/**
 * tool-router 检索质量基线/验收探针（2026-10-01 检索架构优化前后对比用）。
 *
 * 生产同源通道：executeToolSearchBridge("tool_discover") → searchAdaptiveAgentPath
 * → adaptiveSearchDeferredTools（与 LLM 实际调回完全同一条管线）。
 *
 * 环境钉死为 golden 测试同款确定性配置（embedding sidecar off → 词面主导），
 * 保证改前/改后对比的是评分核心而非环境波动。
 *
 * 指标：
 *   - top1 / top3 命中率（golden 21 条，与 test/tool-discover-golden-recall.test.ts 同源）
 *   - 单 query 平均/最大检索延迟（ms）
 *   - discover 结果载荷体积（JSON 字符，p50/max）+ 超 800 字符压缩截断风险条数
 *
 * 用法：npx tsx scripts/probe-tool-router-quality.ts [--tag=before]
 */
import "dotenv/config";
import { loadServerEnv } from "../src/config/load-server-env.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// 与 golden 测试同款钉死：词面确定性，排除 sidecar/网络波动
process.env.AGENT_TOOL_SEARCH_ENABLED = "on";
process.env.AGENT_TOOL_EMBEDDING_PROVIDER = "openai";
process.env.AGENT_NEURAL_SIDECAR_URL = "http://127.0.0.1:1";
process.env.AGENT_NEURAL_EMBED_ENABLED = "off";
process.env.AGENT_NEURAL_RERANK_ENABLED = "off";
process.env.AGENT_NEURAL_INTENT_ENABLED = "off";

loadServerEnv();

const scriptDir = dirname(fileURLToPath(import.meta.url));
const tag = process.argv.find((a) => a.startsWith("--tag="))?.slice(6) ?? "run";

const { getBuiltinAgentChatTools } = await import("../src/external-model/openai-compatible-tool-loop.js");
const { prepareToolsWithToolSearch, executeToolSearchBridge } = await import("../src/tools/tool-search/index.js");

type GoldenCase = { query: string; expect: string[]; topK?: number };

const GOLDEN: GoldenCase[] = [
  { query: "北京今天天气怎么样", expect: ["weather.get_local"] },
  { query: "找几张猫的照片", expect: ["search_images", "search_images_batch"] },
  { query: "我在哪个城市", expect: ["clock.get_user_location"] },
  { query: "现在几点了", expect: ["clock.get_current_time"] },
  { query: "今天有什么热搜", expect: ["hot_rankings"] },
  { query: "我钱包还有多少钱", expect: ["wallet.get_balance"] },
  { query: "找个教做红烧肉的视频", expect: ["search_videos"] },
  { query: "打开抖音", expect: ["desktop.open"] },
  { query: "打开网易云 播放影月", expect: ["desktop.open"] },
  { query: "比特币现在什么价", expect: ["search_web", "internet.research", "deep_search", "internet.live_check"], topK: 3 },
  { query: "帮我搜一下刘浩存最近的消息", expect: ["search_web", "internet.research", "deep_search"], topK: 3 },
  { query: "读一下这个网页 https://example.com 说了什么", expect: ["fetch_web", "info.inspect_webpage"], topK: 3 },
  { query: "明天早上九点提醒我开会", expect: ["reminder.plan", "calendar.create_from_text", "calendar.create_task"], topK: 3 },
  { query: "我有哪些日程", expect: ["calendar.list_tasks"], topK: 3 },
  { query: "取消明天那个提醒", expect: ["calendar.delete_task", "calendar.list_tasks"], topK: 3 },
  { query: "记住我妈生日是5月20号", expect: ["care.set_important_date"], topK: 3 },
  { query: "到家的时候提醒我拿快递", expect: ["geofence.create"], topK: 3 },
  { query: "每天提醒我喝水", expect: ["care.rhythm_reminder", "reminder.plan"], topK: 3 },
  { query: "看一下门口摄像头", expect: ["vision.see_device", "vision.list_cameras"], topK: 3 },
  { query: "我答应过你什么", expect: ["commitment.list"], topK: 3 },
];

const COMPACT_BUDGET = 800; // tool_discover 的 LLM 视图预算（tokenjuice compactor 同源）

async function main() {
  const prepared = prepareToolsWithToolSearch([], getBuiltinAgentChatTools());
  const catalog = prepared.deferredCatalog;

  let top1 = 0;
  let top3 = 0;
  const latencies: number[] = [];
  const payloadSizes: number[] = [];
  const rows: Array<Record<string, unknown>> = [];
  for (const c of GOLDEN) {
    const t0 = Date.now();
    const bridge = await executeToolSearchBridge("tool_discover", { query: c.query, limit: 5 }, catalog);
    const ms = Date.now() - t0;
    latencies.push(ms);
    const result = bridge.result as { matches?: Array<{ name: string }>; count?: number };
    const names = (result.matches ?? []).map((m) => m.name);
    const payloadChars = JSON.stringify(bridge.result).length;
    payloadSizes.push(payloadChars);
    const hit1 = Boolean(names[0] && c.expect.includes(names[0]));
    const hit3 = names.slice(0, 3).some((n) => c.expect.includes(n));
    if (hit1) top1 += 1;
    if (hit3) top3 += 1;
    rows.push({
      query: c.query,
      top1: names[0] ?? null,
      top1Hit: hit1,
      top3Hit: hit3,
      latencyMs: ms,
      payloadChars,
      overBudget: payloadChars > COMPACT_BUDGET,
      top5: names.slice(0, 5),
    });
  }

  const sortedLat = [...latencies].sort((a, b) => a - b);
  const sortedPayload = [...payloadSizes].sort((a, b) => a - b);
  const summary = {
    tag,
    goldenCount: GOLDEN.length,
    catalogSize: catalog.entries.length,
    top1Rate: Math.round((top1 / GOLDEN.length) * 100),
    top3Rate: Math.round((top3 / GOLDEN.length) * 100),
    latencyMs: {
      avg: Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length),
      p50: sortedLat[Math.floor(sortedLat.length / 2)],
      max: sortedLat[sortedLat.length - 1],
    },
    payloadChars: {
      p50: sortedPayload[Math.floor(sortedPayload.length / 2)],
      max: sortedPayload[sortedPayload.length - 1],
      overBudgetCount: payloadSizes.filter((s) => s > COMPACT_BUDGET).length,
    },
    rows,
  };

  const outDir = join(scriptDir, "results");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `tool-router-quality-${tag}-${Date.now()}.json`);
  writeFileSync(outPath, JSON.stringify(summary, null, 2), "utf8");
  console.log(
    `[tool-router-quality:${tag}] top1=${summary.top1Rate}% top3=${summary.top3Rate}% ` +
      `latency avg=${summary.latencyMs.avg}ms p50=${summary.latencyMs.p50}ms max=${summary.latencyMs.max}ms | ` +
      `payload p50=${summary.payloadChars.p50} max=${summary.payloadChars.max} over800=${summary.payloadChars.overBudgetCount}/${GOLDEN.length}`,
  );
  for (const r of rows) {
    if (!r.top1Hit) console.log(`  miss top1: ${r.query} → ${r.top1} (期望 ${GOLDEN.find((g) => g.query === r.query)?.expect.join("/")})`);
  }
  console.log(`明细 → ${outPath}`);
}

main().catch((err) => {
  console.error("[tool-router-quality] 探针异常:", err);
  process.exit(2);
});
