/**
 * Token 优化 A/B 采集器（2026-10-20，临时探针）。
 *
 * 逐场景在临时沙箱内跑 e2e-weather-card-live（真实 LLM + 完整装配），
 * 保留 20s 宽限等后台旁路审计落盘，然后聚合 data/llm-token-audit.ndjson：
 *   - 各 stage 的调用次数 / 估算 tokens / API 真值 tokens / cache 命中
 *   - 旁路审计归属（actorId / sessionId 是否补齐）
 * 输出紧凑表 + JSON（results/token-ab-<phase>.json）。
 *
 * 用法：node tmp-probe/token-ab-runner.mjs <after|before>
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const serverDir = join(here, "..");
const phase = process.argv[2] ?? "after";

const SCENARIOS = [
  { key: "S1-chat", q: "你好，今天心情怎么样？" },
  { key: "S2-weather", q: "帮我查一下明天北京的天气，穿什么合适？" },
  { key: "S3-memory", q: "记住：我老婆叫刘浩存，我生日是3月5日，我住在兴义市" },
  { key: "S4-reminder", q: "明天下午3点提醒我开会" },
  { key: "S5-plan", q: "帮我规划一个杭州三日游的行程" },
];

const records = [];
let idx = 0;
for (const s of SCENARIOS) {
  idx += 1;
  const actor = `tko-${phase}-${idx}`;
  const port = 3150 + idx;
  const out = spawnSync(
    "npx",
    ["tsx", "scripts/e2e-weather-card-live.ts", s.q],
    {
      cwd: serverDir,
      shell: true,
      encoding: "utf8",
      env: {
        ...process.env,
        PA_E2E_PORT: String(port),
        PA_E2E_ACTOR: actor,
        PA_E2E_GRACE_MS: "20000",
      },
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  const stdout = `${out.stdout ?? ""}\n${out.stderr ?? ""}`;
  const m = stdout.match(/沙箱数据目录:\s*(.+)/);
  if (!m) {
    console.log(`[${s.key}] 未能定位沙箱目录（结果: exit=${out.status}）`);
    records.push({ scenario: s.key, ok: false });
    continue;
  }
  const sandbox = m[1].trim();
  const auditPath = join(sandbox, "data", "llm-token-audit.ndjson");
  const list = existsSync(auditPath)
    ? readFileSync(auditPath, "utf8").split("\n").filter(Boolean).map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean)
    : [];
  records.push({ scenario: s.key, actor, port, ok: true, count: list.length, records: list });
  console.log(`[${s.key}] actor=${actor} 记录数=${list.length}`);
}

// ── 聚合 ──
const byStage = new Map();
let totalCalls = 0, totalEstIn = 0, totalEstOut = 0, totalApiIn = 0, totalApiOut = 0;
let attributed = 0, unattributed = 0;
const unattributedStages = new Set();
for (const r of records) {
  if (!r.ok) continue;
  for (const x of r.records) {
    totalCalls += 1;
    totalEstIn += x.inputTokens ?? 0;
    totalEstOut += x.outputTokens ?? 0;
    const hasApi = typeof x.apiPromptTokens === "number" || typeof x.apiCompletionTokens === "number";
    totalApiIn += x.apiPromptTokens ?? 0;
    totalApiOut += x.apiCompletionTokens ?? 0;
    // 归属统计只针对旁路（估算）记录：主链路本就带 sessionId
    if (x.actorId || x.sessionId) attributed += 1;
    else { unattributed += 1; unattributedStages.add(x.stage); }
    const a = byStage.get(x.stage) ?? { calls: 0, estIn: 0, estOut: 0, apiIn: 0, apiOut: 0, cache: 0, attr: 0, unattr: 0 };
    a.calls += 1; a.estIn += x.inputTokens ?? 0; a.estOut += x.outputTokens ?? 0;
    a.apiIn += x.apiPromptTokens ?? 0; a.apiOut += x.apiCompletionTokens ?? 0;
    a.cache += x.promptCacheHitTokens ?? 0;
    if (x.actorId || x.sessionId) a.attr += 1; else a.unattr += 1;
    byStage.set(x.stage, a);
  }
}

console.log("\n═══ stage 聚合（" + phase + "）═══");
console.log("stage".padEnd(26) + "calls".padStart(6) + "estIn".padStart(9) + "estOut".padStart(8) + "apiIn".padStart(8) + "apiOut".padStart(8) + "cache".padStart(8) + "attr".padStart(6) + "unattr".padStart(7));
for (const [stage, a] of [...byStage.entries()].sort((x, y) => (y[1].apiIn + y[1].estIn) - (x[1].apiIn + x[1].estIn))) {
  console.log(
    stage.padEnd(26) + String(a.calls).padStart(6) + String(a.estIn).padStart(9) + String(a.estOut).padStart(8) +
    String(a.apiIn).padStart(8) + String(a.apiOut).padStart(8) + String(a.cache).padStart(8) +
    String(a.attr).padStart(6) + String(a.unattr).padStart(7),
  );
}
console.log("-".repeat(85));
console.log(`TOTAL calls=${totalCalls} estIn=${totalEstIn} estOut=${totalEstOut} apiIn=${totalApiIn} apiOut=${totalApiOut}`);
console.log(`归属: 有 actorId/sessionId=${attributed}  无归属=${unattributed}  无归属stage=${[...unattributedStages].join(",") || "(none)"}`);

const resultsDir = join(serverDir, "results");
if (!existsSync(resultsDir)) mkdirSync(resultsDir, { recursive: true });
writeFileSync(
  join(resultsDir, `token-ab-${phase}.json`),
  JSON.stringify({ phase, generatedAt: new Date().toISOString(), totals: { totalCalls, totalEstIn, totalEstOut, totalApiIn, totalApiOut, attributed, unattributed }, byStage: Object.fromEntries(byStage), records }, null, 2),
  "utf8",
);
console.log(`\n已写出 results/token-ab-${phase}.json`);
