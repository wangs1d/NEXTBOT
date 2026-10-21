/**
 * 对话轮工具决策黄金集评估（2026-10-21 去路由化后的精度基线）。
 *
 * 端到端走真实 WS + 真实 provider + 真实 agent-core（不是脚本内复刻），因此
 * 测到的是生产链路：统一车道、tool_choice、域预载、延迟目录、plan-execute。
 *
 * 脚本放在 test/tools/（dev-server 的 tsx watch 排除 test/**）：报告写到
 * test/tools/results/ 也不会触发服务端重启。若放在 scripts/ 下，写结果文件会
 * 让 dev server 自动重启，评估跑到一半就 ECONNREFUSED。
 *
 * 用法：
 *   node test/tools/eval-turn-accuracy.mjs
 *   node test/tools/eval-turn-accuracy.mjs --repeats=3 --only=weather_tomorrow,photo_cheng
 *   node test/tools/eval-turn-accuracy.mjs --server=ws://127.0.0.1:3000/ws --timeout=90000
 *
 * 通过标准（逐 case）：
 *   - chat 轮：零工具 + 不出现 forbidTools
 *   - tool 轮：每个 expectToolGroups 至少命中一个工具 + 不出现 forbidTools
 * 额外指标：多余工具、耗时 p50/p95、pass^k（重复 k 次全部通过）。
 */
import WebSocket from "ws";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const SERVER = argOf("server", "ws://127.0.0.1:3000/ws");
const REPEATS = Math.max(1, Number(argOf("repeats", "1")) || 1);
const TIMEOUT_MS = Math.max(10_000, Number(argOf("timeout", "90000")) || 90_000);
const ONLY = new Set(
  (argOf("only", "") || "").split(",").map((s) => s.trim()).filter(Boolean),
);
const GOLDEN_PATH = resolve(scriptDir, "..", "fixtures", "golden", "turn-accuracy.json");
const RUN_ID = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
const OUT_DIR = join(scriptDir, "results");
mkdirSync(OUT_DIR, { recursive: true });

const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8"));
const cases = golden.cases.filter((c) => ONLY.size === 0 || ONLY.has(c.id));
if (cases.length === 0) {
  console.error("没有匹配的 case");
  process.exit(2);
}

const LOCATION_FIXTURE = {
  latitude: 25.0914,
  longitude: 104.8952,
  timezone: "Asia/Shanghai",
  label: "兴义市",
};

function runOne(caseDef, repeat) {
  return new Promise((resolveRun) => {
    const actor = `eval-acc-${RUN_ID}-${caseDef.id}-${repeat}`;
    // 跨轮污染测量：preturns 是同会话预热轮（复现「上一轮查天气」的真实上下文），
    // 目标轮（caseDef.text）最后发送；工具/正文只记录目标轮。
    const preturns = Array.isArray(caseDef.preturns) ? caseDef.preturns : [];
    const sequence = [
      ...preturns.map((p) => (typeof p === "string" ? p : String(p.text ?? ""))).filter(Boolean),
      caseDef.text,
    ];
    const startedAt = Date.now();
    const tools = [];
    let finalText = "";
    let doneCount = 0;
    let errorText = "";
    let settled = false;
    let quietTimer = null;
    let hardTimer = null;
    let seqIndex = -1;
    let ws;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(quietTimer);
      clearTimeout(hardTimer);
      try { ws?.close(); } catch { /* ignore */ }
      resolveRun({
        id: caseDef.id,
        repeat,
        tools: [...new Set(tools)],
        finalText,
        errorText,
        elapsedMs: Date.now() - startedAt,
        doneCount,
      });
    };

    const sendNext = () => {
      seqIndex += 1;
      if (seqIndex >= sequence.length) {
        finish();
        return;
      }
      if (seqIndex === sequence.length - 1) {
        // 进入目标轮：丢弃预热轮的工具记录与正文，只评判目标轮
        tools.length = 0;
        finalText = "";
      }
      ws.send(JSON.stringify({
        type: "chat.user_message",
        payload: {
          sessionId: actor,
          messageId: `eval-${RUN_ID}-${caseDef.id}-${repeat}-${seqIndex}`,
          text: sequence[seqIndex],
          timestamp: new Date().toISOString(),
          agentAccessMode: "full",
          userId: actor,
        },
      }));
    };

    const armQuiet = () => {
      clearTimeout(quietTimer);
      quietTimer = setTimeout(sendNext, 1200);
    };

    hardTimer = setTimeout(() => {
      errorText ||= `timeout(${TIMEOUT_MS}ms)`;
      finish();
    }, TIMEOUT_MS * (1 + preturns.length));

    ws = new WebSocket(SERVER);
    ws.on("open", () => {
      ws.send(JSON.stringify({
        type: "session.init",
        payload: {
          sessionId: actor,
          deviceId: "eval-turn-accuracy",
          userAlias: "owner",
          platform: "windows",
          userId: actor,
        },
      }));
      setTimeout(sendNext, 1200);
    });

    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      const type = String(msg.type ?? "");
      const p = (msg.payload && typeof msg.payload === "object") ? msg.payload : {};
      if (type === "agent.location_request") {
        ws.send(JSON.stringify({
          type: "client.location_report",
          payload: { jobId: p.jobId, ...LOCATION_FIXTURE },
        }));
        return;
      }
      if (type === "tool.call") {
        const name = String(p.toolName ?? "");
        if (name && !tools.includes(name)) tools.push(name);
        return;
      }
      if (type === "chat.error") {
        errorText = String(p.message ?? "chat.error");
        return;
      }
      if (type === "chat.assistant_done") {
        doneCount += 1;
        finalText += String(p.finalText ?? "");
        armQuiet();
      }
    });

    ws.on("error", (e) => {
      errorText = `ws_error:${e.message}`;
      finish();
    });
  });
}

function judge(caseDef, run) {
  const expectedGroups = caseDef.expectToolGroups ?? [];
  const forbid = new Set(caseDef.forbidTools ?? []);
  const allow = new Set(caseDef.allowTools ?? []);
  const called = new Set(run.tools);
  const forbiddenHit = [...forbid].filter((t) => called.has(t));
  const expectedUnion = new Set(expectedGroups.flat());
  // 元工具（发现/加载）不参与「多余业务工具」统计，但仍计入 chat 零工具红线。
  const META_TOOLS = new Set(["tool_discover", "tool_search", "tool_describe", "agent.query_capabilities"]);
  const extraTools = run.tools.filter(
    (t) => !expectedUnion.has(t) && !allow.has(t) && !META_TOOLS.has(t),
  );

  if (expectedGroups.length === 0) {
    const unexpectedChatTools = run.tools.filter((t) => !allow.has(t));
    return {
      pass: unexpectedChatTools.length === 0 && forbiddenHit.length === 0 && !run.errorText,
      reason:
        run.errorText
          ? `error:${run.errorText}`
          : unexpectedChatTools.length > 0
            ? `chat 轮出现未允许工具: ${unexpectedChatTools.join(",")}`
            : forbiddenHit.length > 0
              ? `命中禁用工具: ${forbiddenHit.join(",")}`
              : "",
      extraTools,
      forbiddenHit,
    };
  }

  const missingGroups = expectedGroups
    .map((group, i) => (group.some((t) => called.has(t)) ? null : `#${i + 1}[${group.join("|")}]`))
    .filter(Boolean);
  return {
    pass: missingGroups.length === 0 && forbiddenHit.length === 0 && !run.errorText,
    reason:
      run.errorText
        ? `error:${run.errorText}`
        : missingGroups.length > 0
          ? `未命中期望组: ${missingGroups.join(", ")}；实际: ${run.tools.join(",") || "-"}`
          : forbiddenHit.length > 0
            ? `命中禁用工具: ${forbiddenHit.join(",")}`
            : "",
    extraTools,
    forbiddenHit,
  };
}

const pct = (n, d) => (d === 0 ? "0.0%" : `${((n / d) * 100).toFixed(1)}%`);
const percentile = (arr, p) => {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p));
  return sorted[idx];
};

const runs = [];
for (const caseDef of cases) {
  for (let r = 1; r <= REPEATS; r++) {
    const run = await runOne(caseDef, r);
    const verdict = judge(caseDef, run);
    runs.push({ caseDef, run, verdict });
    const mark = verdict.pass ? "PASS" : "FAIL";
    console.log(
      `[${mark}] ${caseDef.id} #${r} ${run.elapsedMs}ms tools=${run.tools.join(",") || "-"}` +
        (verdict.pass ? "" : `  ← ${verdict.reason}`),
    );
  }
}

const total = runs.length;
const passed = runs.filter((x) => x.verdict.pass).length;
const chatRuns = runs.filter((x) => (x.caseDef.expectToolGroups ?? []).length === 0);
const toolRuns = runs.filter((x) => (x.caseDef.expectToolGroups ?? []).length > 0);
const chatZero = chatRuns.filter((x) => x.run.tools.length === 0).length;
const chatSafe = chatRuns.filter((x) => x.verdict.pass).length;
const toolHit = toolRuns.filter((x) => x.verdict.pass).length;
const forbidden = runs.filter((x) => x.verdict.forbiddenHit.length > 0);
const extraRuns = runs.filter((x) => x.verdict.extraTools.length > 0);
const latencies = runs.map((x) => x.run.elapsedMs);

const perCase = new Map();
for (const item of runs) {
  const entry = perCase.get(item.caseDef.id) ?? { total: 0, pass: 0 };
  entry.total += 1;
  if (item.verdict.pass) entry.pass += 1;
  perCase.set(item.caseDef.id, entry);
}
const passAtK = [...perCase.values()].filter((e) => e.total === REPEATS && e.pass === e.total).length;

const summary = {
  runId: RUN_ID,
  server: SERVER,
  repeats: REPEATS,
  totalRuns: total,
  passRuns: passed,
  passRate: pct(passed, total),
  chatRuns: chatRuns.length,
  chatZeroToolRate: pct(chatZero, chatRuns.length),
  chatSafeRate: pct(chatSafe, chatRuns.length),
  toolRuns: toolRuns.length,
  toolGroupHitRate: pct(toolHit, toolRuns.length),
  forbiddenViolations: forbidden.length,
  runsWithExtraTools: extraRuns.length,
  latencyMs: {
    p50: percentile(latencies, 0.5),
    p95: percentile(latencies, 0.95),
    max: Math.max(...latencies),
  },
  passAtK: { k: REPEATS, cases: passAtK, totalCases: perCase.size, rate: pct(passAtK, perCase.size) },
};

const failures = runs
  .filter((x) => !x.verdict.pass)
  .map((x) => ({
    id: x.caseDef.id,
    repeat: x.run.repeat,
    text: x.caseDef.text,
    tools: x.run.tools,
    elapsedMs: x.run.elapsedMs,
    reason: x.verdict.reason,
  }));

const jsonPath = join(OUT_DIR, `turn-accuracy-${RUN_ID}.json`);
writeFileSync(
  jsonPath,
  JSON.stringify({ summary, failures, runs: runs.map((x) => ({
    id: x.caseDef.id,
    repeat: x.run.repeat,
    text: x.caseDef.text,
    tools: x.run.tools,
    extraTools: x.verdict.extraTools,
    forbiddenHit: x.verdict.forbiddenHit,
    pass: x.verdict.pass,
    reason: x.verdict.reason,
    elapsedMs: x.run.elapsedMs,
  })) }, null, 2),
  "utf8",
);

const mdLines = [
  `# 对话轮工具决策评估 ${RUN_ID}`,
  "",
  `- Server: ${SERVER}`,
  `- Repeats: ${REPEATS}`,
  `- 总通过率: **${summary.passRate}** (${passed}/${total})`,
  `- chat 轮零工具率: ${summary.chatZeroToolRate} (${chatZero}/${chatRuns.length})`,
  `- chat 轮安全率（无禁用/未允许工具）: ${summary.chatSafeRate} (${chatSafe}/${chatRuns.length})`,
  `- tool 轮期望命中率: ${summary.toolGroupHitRate} (${toolHit}/${toolRuns.length})`,
  `- 禁用工具违规: ${summary.forbiddenViolations} 次`,
  `- 出现多余工具的轮次: ${summary.runsWithExtraTools}`,
  `- 耗时 p50/p95/max: ${summary.latencyMs.p50}/${summary.latencyMs.p95}/${summary.latencyMs.max} ms`,
  `- pass^${REPEATS}: ${summary.passAtK.cases}/${summary.passAtK.totalCases} (${summary.passAtK.rate})`,
  "",
  "## 失败明细",
  "",
  ...(failures.length === 0
    ? ["无"]
    : failures.map((f) => `- \`${f.id}\` #${f.repeat}：${f.reason}（tools=${f.tools.join(",") || "-"}, ${f.elapsedMs}ms）`)),
  "",
];
const mdPath = join(OUT_DIR, `turn-accuracy-${RUN_ID}.md`);
writeFileSync(mdPath, mdLines.join("\n"), "utf8");

console.log("\n===== 汇总 =====");
console.log(JSON.stringify(summary, null, 2));
console.log(`\n报告: ${jsonPath}`);
console.log(`报告: ${mdPath}`);
process.exit(passed === total ? 0 : 1);
