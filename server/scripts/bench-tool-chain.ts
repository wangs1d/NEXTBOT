/**
 * 工具调用链路性能基准（2026-09-11 链路重构前后对比）。
 *
 * 测量项（2026-09-11 检索收口后：进程内 adaptive 是唯一管线）：
 *  A) 延迟工具检索：进程内六阶段管线（意图路由→分层路由→混合召回→top-p→图扩展→重排）。
 *  B) 工具 schema 装配：getBuiltinAgentChatTools 冷/热路径。
 *  C) 注册漂移检测单次成本。
 *  D) 截断 JSON 参数修复单次成本。
 *
 * 用法：cd server && node --import tsx scripts/bench-tool-chain.ts
 */
import type { ChatCompletionTool } from "openai/resources/chat/completions";

import { buildDeferredCatalog, type DeferredToolCatalog } from "../src/tools/tool-search/catalog.js";
import { executeToolSearchBridge } from "../src/tools/tool-search/handlers.js";
import { getToolSearchConfig } from "../src/tools/tool-search/env.js";
import { toolSearchMetrics } from "../src/tools/tool-search/observability/metrics.js";
import { getBuiltinAgentChatTools } from "../src/external-model/openai-compatible-tool-loop.js";
import { reportChatToolDrift } from "../src/tools/chat-tool-drift.js";
import { tryRepairTruncatedJsonObject } from "../src/external-model/openai-compatible-tool-loop.js";

// ---------- 合成工具目录（≈150 个，跨 8 个域） ----------
const DOMAINS = ["calendar", "weather", "web", "wallet", "phone", "desktop", "memory", "travel"];
const VERBS = ["create", "list", "search", "delete", "update", "get", "send", "sync"];

function buildSyntheticSchemas(count: number): ChatCompletionTool[] {
  const tools: ChatCompletionTool[] = [];
  let i = 0;
  while (tools.length < count) {
    const domain = DOMAINS[i % DOMAINS.length];
    const verb = VERBS[Math.floor(i / DOMAINS.length) % VERBS.length];
    const name = `${domain}.${verb}_${Math.floor(i / (DOMAINS.length * VERBS.length))}`;
    tools.push({
      type: "function",
      function: {
        name,
        description: `${verb} ${domain} 相关内容。例如：帮我${verb}一个${domain}事项、查询${domain}状态、同步${domain}数据。`,
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "查询或操作的关键词" },
            limit: { type: "number", description: "返回条数上限" },
          },
        },
      },
    });
    i += 1;
  }
  return tools;
}

const QUERIES = [
  "帮我创建一个明天上午的日程",
  "查一下今天天气怎么样",
  "搜索一下最近的新闻",
  "看看我这个月花了多少钱",
  "给张三打个电话",
  "截个屏看看屏幕上是什么",
  "我上次说过的那件事是什么",
  "把客厅的灯打开",
  "帮我记一下明天要买牛奶",
  "同步一下我的日历",
  "删除上周创建的提醒",
  "查天气预报后天降雨吗",
  "搜索附近的餐厅",
  "查一下我的钱包余额",
  "更新我的个人资料",
  "发一条消息给李四",
  "列出所有未完成的任务",
  "看看电脑上打开了什么窗口",
  "我喜欢的电影有哪些",
  "帮我设置一个半小时后的提醒",
];

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function stats(samples: number[]): { n: number; p50: number; p95: number; mean: number; max: number } {
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = samples.reduce((a, b) => a + b, 0) / Math.max(1, samples.length);
  return {
    n: samples.length,
    p50: Math.round(percentile(sorted, 50)),
    p95: Math.round(percentile(sorted, 95)),
    mean: Math.round(mean),
    max: Math.round(sorted[sorted.length - 1] ?? NaN),
  };
}

async function benchBackend(
  catalog: DeferredToolCatalog,
  rounds: number,
): Promise<{
  stats: ReturnType<typeof stats>;
  failures: number;
  warmMs: number;
  slowQueries: number;
}> {
  getToolSearchConfig();
  const latencies: number[] = [];
  let failures = 0;
  let slowQueries = 0;
  // 预热一轮单列（旧链路此处含 Python 子进程冷启动 + 目录导出/注册）
  const warmStart = Date.now();
  await executeToolSearchBridge("tool_search", { query: QUERIES[0], limit: 5 }, catalog);
  const warmMs = Date.now() - warmStart;
  for (let i = 0; i < rounds; i += 1) {
    // 每轮唯一查询：旧链路适配器带 30s 结果 TTL 缓存，重复查询会污染对比
    const query = `${QUERIES[i % QUERIES.length]}（第${i}轮）`;
    const start = performance.now();
    try {
      const result = await executeToolSearchBridge("tool_search", { query, limit: 5 }, catalog);
      if (!result.ok) failures += 1;
    } catch {
      failures += 1;
    }
    const ms = performance.now() - start;
    if (ms > 100) slowQueries += 1;
    latencies.push(ms);
  }
  return { stats: stats(latencies), failures, warmMs, slowQueries };
}

async function main() {
  const schemas = buildSyntheticSchemas(150);
  const catalog = buildDeferredCatalog(schemas);
  const ROUNDS = 60;

  console.log(`\n=== A) 延迟工具检索（目录 ${catalog.entries.length} 条 deferred，${ROUNDS} 查询，进程内 adaptive）===`);
  const result = await benchBackend(catalog, ROUNDS);
  {
    const s = result.stats;
    console.log(
      `  进程内六阶段管线  预热首查=${result.warmMs}ms  p50=${s.p50}ms  p95=${s.p95}ms  mean=${s.mean}ms  max=${s.max}ms  >100ms 次数=${result.slowQueries}  失败=${result.failures}/${ROUNDS}`,
    );
  }

  console.log(`\n=== B) 工具 schema 装配 getBuiltinAgentChatTools ===`);
  const coldStart = performance.now();
  const builtin = getBuiltinAgentChatTools();
  const coldMs = Math.round(performance.now() - coldStart);
  const warmStart = performance.now();
  for (let i = 0; i < 1000; i += 1) getBuiltinAgentChatTools();
  const warmAvg = Math.round((performance.now() - warmStart));
  console.log(`  冷构建=${coldMs}ms（${builtin.length} 个工具 schema）  热路径 1000 次合计=${warmAvg}ms（缓存命中）`);

  console.log(`\n=== C) 注册漂移检测单次成本 ===`);
  // 双向 diff 纯计算成本：两侧同一组名字（理想对齐状态）。
  // 真实漂移告警由 bootstrap 时的 warnOnChatToolDrift 产生（见启动日志）。
  const registryNames = builtin.map((t) =>
    t.type === "function" && t.function?.name ? t.function.name : "",
  );
  const driftStart = performance.now();
  const drift = reportChatToolDrift({ schemas: builtin, registeredToolNames: registryNames.filter(Boolean) });
  const driftMs = Math.round(performance.now() - driftStart);
  console.log(
    `  耗时=${driftMs}ms（schema ${builtin.length} 双向 diff）→ 对齐状态下漂移数 schemaOnly=${drift.schemaOnly.length}, executorOnly=${drift.executorOnly.length}`,
  );

  console.log(`\n=== D) 截断 JSON 参数修复单次成本 ===`);
  const raw = '{"query": "今天天气怎么样，适合出行吗", "city": "北京';
  const repairStart = performance.now();
  let repaired = 0;
  for (let i = 0; i < 100_000; i += 1) {
    if (tryRepairTruncatedJsonObject(raw)) repaired += 1;
  }
  const repairTotal = Math.round(performance.now() - repairStart);
  console.log(`  10 万次合计=${repairTotal}ms（平均 ${(repairTotal / 100_000).toFixed(4)}ms/次），成功修复 ${repaired}/100000`);

  // 神经通道观测（延迟归因用）：各特性 ok/timeout/fallback/breaker_skip 计数 +
  // 召回命中率。sidecar 未启动时这里应看到 breaker_skip 主导、timeout ≤ 熔断阈值。
  {
    const snap = toolSearchMetrics.snapshot();
    console.log(`
=== E) 神经通道与召回质量观测 ===`);
    for (const [feature, n] of Object.entries(snap.neural)) {
      console.log(`  neural.${feature}: ${JSON.stringify(n)}`);
    }
    const r = snap.recall;
    const pct = (v: number) => (r.samples > 0 ? Math.round((v / r.samples) * 1000) / 10 : 0);
    console.log(
      `  recall: 样本=${r.samples}  top1=${pct(r.top1)}%  top3=${pct(r.top3)}%  top5=${pct(r.top5)}%  miss=${pct(r.miss)}%`,
    );
  }

  console.log("");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    setTimeout(() => process.exit(process.exitCode ?? 0), 200).unref?.();
  });
