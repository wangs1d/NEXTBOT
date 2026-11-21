/**
 * 工具召回缺口分析（2026-10-10 L5 数据回流 · 半自动）：从线上 [turn-trace] 日志
 * 聚类「未命中 query」，生成 intent-metadata 补丁建议。
 *
 * 背景：别名补充此前全靠人工（逐个手工补），这是数据驱动的折中——离线分析
 * 已落盘的 trace，线上召回仍走词面（不引入 embedding 实时召回的延迟/成本）。
 * 这也是语义泛化（方向五）的沉淀粉:聚类产出的别名进 intent-metadata 后，
 * 线上词面通道即可命中零词面重叠的新表达。
 *
 * 运行：node --import tsx test/tool-recall-gap-analyzer.ts <trace.log> [--out patches.json]
 * （放 test/ 目录避 tsx watch 重启；日志即服务端 stdout/stderr 落盘文件）
 *
 * 「未命中」判定（与 TurnOutcomeGate 的事实口径对齐）：
 *   - 延迟目录已激活的轮，但零实质成功业务调用（只跑桥/元工具或干脆没调）
 *   - 或出现 hallucination_promoted 调用（模型直呼不可见名 = 可见集缺意图工具）
 *
 * 输出：
 *   1. 未命中轮总览（按 turnIntent / 频次）
 *   2. query 聚类（CJK bigram Jaccard ≥ 0.3 贪心并簇）
 *   3. 每簇的 BM25/先验候选工具 + intent-metadata 补丁建议（exact 规则 JSON，
 *      人工审核后合入 data/tool-intent-metadata.json 的 rules —— 半自动）
 */
process.env.AGENT_TOOL_SEARCH_ENABLED = "on";

import { readFileSync, writeFileSync } from "node:fs";
import type { ChatCompletionTool } from "openai/resources/chat/completions";

const args = process.argv.slice(2);
const logPath = args.find((a) => !a.startsWith("--"));
const outIdx = args.indexOf("--out");
const outPath = outIdx >= 0 ? args[outIdx + 1] : undefined;

if (!logPath) {
  console.error("用法: node --import tsx test/tool-recall-gap-analyzer.ts <trace.log> [--out patches.json]");
  process.exit(1);
}

interface TraceRecord {
  ts: number;
  stage: string;
  turnIntent?: string;
  visibleTools: number;
  deferredActive: boolean;
  deferredCount: number;
  recallInjectedNames?: string[];
  toolCalls: Array<{ name: string; ok: boolean; acquisition?: string; paramError?: boolean }>;
  query?: string;
}

// ── 1. 解析日志 ──

const records: TraceRecord[] = [];
for (const line of readFileSync(logPath, "utf8").split(/\r?\n/)) {
  const idx = line.indexOf("[turn-trace] ");
  if (idx < 0) continue;
  try {
    records.push(JSON.parse(line.slice(idx + "[turn-trace] ".length)) as TraceRecord);
  } catch {
    /* 半截行跳过 */
  }
}
if (records.length === 0) {
  console.error(`未在 ${logPath} 中找到 [turn-trace] 行`);
  process.exit(1);
}

// ── 2. 未命中轮判定 ──

const paramErrorByTool = new Map<string, number>();
const missTurns: TraceRecord[] = [];
let hallucinationCalls = 0;
for (const r of records) {
  for (const c of r.toolCalls ?? []) {
    if (c.paramError) paramErrorByTool.set(c.name, (paramErrorByTool.get(c.name) ?? 0) + 1);
    if (c.acquisition === "hallucination_promoted") hallucinationCalls += 1;
  }
  const businessOk = (r.toolCalls ?? []).filter((c) => c.ok && c.acquisition !== "bridge");
  const hasHallucination = (r.toolCalls ?? []).some((c) => c.acquisition === "hallucination_promoted");
  const zeroBusiness = businessOk.length === 0 && (r.deferredActive || (r.toolCalls ?? []).length > 0);
  if (zeroBusiness || hasHallucination) missTurns.push(r);
}

// ── 3. query 聚类（CJK bigram + latin token，Jaccard 贪心并簇） ──

function tokenizeQuery(q: string): Set<string> {
  const tokens = new Set<string>();
  const cjk = q.match(/[\u4e00-\u9fa5]+/g) ?? [];
  for (const run of cjk) {
    if (run.length === 1) {
      tokens.add(run);
      continue;
    }
    for (let i = 0; i < run.length - 1; i++) tokens.add(run.slice(i, i + 2));
  }
  for (const w of q.toLowerCase().match(/[a-z_][a-z0-9_.]{2,}/g) ?? []) tokens.add(w);
  return tokens;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter / (a.size + b.size - inter);
}

// 同 query 去重计频（重复未命中 = 高价值信号）
const queryFreq = new Map<string, { freq: number; intents: Set<string>; stages: Set<string> }>();
for (const r of missTurns) {
  const q = (r.query ?? "").trim();
  if (!q) continue;
  const key = q.replace(/\s+/g, " ");
  const agg = queryFreq.get(key) ?? { freq: 0, intents: new Set<string>(), stages: new Set<string>() };
  agg.freq += 1;
  if (r.turnIntent) agg.intents.add(r.turnIntent);
  agg.stages.add(r.stage);
  queryFreq.set(key, agg);
}

const JACCARD_THRESHOLD = 0.3;
const clusters: Array<{ members: Array<{ q: string; freq: number }>; centroid: Set<string> }> = [];
const sortedQueries = [...queryFreq.entries()].sort((a, b) => b[1].freq - a[1].freq);
for (const [q, agg] of sortedQueries) {
  const tokens = tokenizeQuery(q);
  let matched = false;
  for (const cluster of clusters) {
    if (jaccard(tokens, cluster.centroid) >= JACCARD_THRESHOLD) {
      cluster.members.push({ q, freq: agg.freq });
      // 质心随成员缓慢演化（频次加权过于复杂，取均值近似）
      for (const t of tokens) cluster.centroid.add(t);
      matched = true;
      break;
    }
  }
  if (!matched) clusters.push({ members: [{ q, freq: agg.freq }], centroid: new Set(tokens) });
}
clusters.sort((a, b) => {
  const fa = a.members.reduce((n, m) => n + m.freq, 0);
  const fb = b.members.reduce((n, m) => n + m.freq, 0);
  return fb - fa;
});

// ── 4. 候选工具 + 补丁建议 ──

const { getBuiltinAgentChatTools } = await import(
  "../src/external-model/openai-compatible-tool-loop.js"
);
const { topToolMatchesForQuery, priorDirectMatchesForQuery } = await import(
  "../src/tools/tool-search/index.js"
);
const { MEDIA_MUSIC_CHAT_TOOLS } = await import(
  "../src/tools/capability-modules/media-music/chat-tools.js"
);

function fn(name: string, description: string): ChatCompletionTool {
  return {
    type: "function",
    function: { name, description, parameters: { type: "object", properties: {} } },
  };
}
const corpus: ChatCompletionTool[] = [...getBuiltinAgentChatTools(), ...MEDIA_MUSIC_CHAT_TOOLS];
const TRAVEL_DESCRIPTIONS: Record<string, string> = {
  "travel.plan-itinerary":
    "生成旅游行程规划：根据用户的目的地、天数与偏好生成完整结构化行程，按天拆分景点/酒店/餐厅。",
  "travel.search-poi": "搜索目的地景点/酒店/餐厅三类 POI（含名称/评分/地址/坐标）。",
  "travel.destination-info": "目的地实用信息：签证、货币、时差、插座、小费、最佳季节。",
  "travel.compute-route": "路线计算：两地之间交通方式与耗时（驾车/高铁/飞行）。",
  "travel.get-itinerary": "读取已生成的行程：按天返回行程明细。",
  "travel.edit-itinerary": "编辑已有行程：添加/删除/替换条目或修改时间字段。",
};
for (const [n, description] of Object.entries(TRAVEL_DESCRIPTIONS)) corpus.push(fn(n, description));

/** 簇内共享的 3-6 字 CJK 片段（补丁别名候选；排除通用寒暄/指代） */
const GENERIC_FRAGMENTS = new Set([
  "帮我", "一下", "看看", "什么", "怎么", "可以", "请问", "谢谢", "然后", "还有",
  "这个", "那个", "我想", "就是", "现在", "今天", "明天", "有没有", "帮忙",
]);
function sharedFragments(queries: string[]): string[] {
  const count = new Map<string, number>();
  for (const q of queries) {
    const frags = new Set<string>();
    for (const run of q.match(/[\u4e00-\u9fa5]{2,}/g) ?? []) {
      for (let len = Math.min(6, run.length); len >= 3; len--) {
        for (let i = 0; i + len <= run.length; i++) {
          const frag = run.slice(i, i + len);
          if (!GENERIC_FRAGMENTS.has(frag)) frags.add(frag);
        }
      }
    }
    for (const f of frags) count.set(f, (count.get(f) ?? 0) + 1);
  }
  const minMembers = Math.max(2, Math.ceil(queries.length / 2));
  return [...count.entries()]
    .filter(([, n]) => n >= minMembers)
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, 4)
    .map(([f]) => f);
}

interface PatchSuggestion {
  tool: string;
  clusterSize: number;
  totalFreq: number;
  queries: string[];
  suggestedAliases: string[];
}

const suggestions: PatchSuggestion[] = [];
console.log("=== 工具召回缺口分析（L5 数据回流 · 半自动） ===");
console.log(`日志: ${logPath}`);
console.log(`trace 轮数: ${records.length}，未命中轮: ${missTurns.length}，幻觉直呼调用: ${hallucinationCalls}`);
const paramTotal = [...paramErrorByTool.values()].reduce((a, b) => a + b, 0);
if (paramTotal > 0) {
  console.log(`\n## 参数级失败重灾区（paramError 按工具聚合，共 ${paramTotal} 次）`);
  for (const [name, n] of [...paramErrorByTool.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`- ${name}: ${n} 次 → 修 schema 描述/字段说明`);
  }
}
console.log(`\n## 未命中 query 聚类（共 ${clusters.length} 簇，只列 ≥2 簇内频次 ≥2 的）`);
for (const cluster of clusters) {
  const totalFreq = cluster.members.reduce((n, m) => n + m.freq, 0);
  if (cluster.members.length < 2 && totalFreq < 2) continue;
  const representative = cluster.members[0].q;
  const candidates = [
    ...priorDirectMatchesForQuery(representative, corpus, 2).map((m) => `${m.name}(先验${m.bonus})`),
    ...topToolMatchesForQuery(representative, corpus, 3).map((m) => `${m.name}(${m.score.toFixed(3)})`),
  ];
  console.log(`\n### 簇（${cluster.members.length} 个 query / 累计 ${totalFreq} 轮）`);
  for (const m of cluster.members.slice(0, 8)) console.log(`- [${m.freq}x] ${m.q}`);
  console.log(`  候选工具: ${candidates.join(", ") || "∅（无词面候选，需人工判断意图域）"}`);
  const aliases = sharedFragments(cluster.members.map((m) => m.q));
  const topTool = topToolMatchesForQuery(representative, corpus, 1)[0]?.name;
  if (topTool && aliases.length > 0) {
    suggestions.push({
      tool: topTool,
      clusterSize: cluster.members.length,
      totalFreq,
      queries: cluster.members.slice(0, 8).map((m) => m.q),
      suggestedAliases: aliases,
    });
  }
}

if (suggestions.length > 0) {
  const patch = {
    _comment: "半自动生成的 intent-metadata 补丁建议（人工审核后合入 rules；别名=簇内共享 CJK 片段）",
    suggestions: suggestions.map((s) => ({
      exact: s.tool,
      metadata: { aliases: s.suggestedAliases, examples: s.queries.slice(0, 3) },
      _evidence: { clusterSize: s.clusterSize, totalFreq: s.totalFreq },
    })),
  };
  console.log("\n## intent-metadata 补丁建议（人工审核后合入 data/tool-intent-metadata.json）");
  console.log(JSON.stringify(patch, null, 2));
  if (outPath) {
    writeFileSync(outPath, JSON.stringify(patch, null, 2), "utf8");
    console.log(`\n补丁已写入 ${outPath}`);
  }
}
