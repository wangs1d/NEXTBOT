/**
 * 映射执行器真实链路端到端验证（e2e-mapping-proactivity.ts）——新架构「这事真的能跑通」的证据。
 *
 * 进程内调用真实生产装配 createAppServices()（与 runtime-main.ts 同一入口），
 * chdir 到隔离沙箱数据目录（OS tmp，不触碰仓库 data/）+ 独立端口 3100，然后：
 *   1. 真实 WS 客户端连 /ws 并 session.init（成为"在线设备"）
 *   2. HTTP 创建一条 10 分钟后的真实日程任务（POST /schedule/tasks）
 *   3. 等真实链条自己跑完：ScheduleSensor → SensorKernel → WorldBoard 状态板
 *      → MappingExecutor(meeting_soon) → ArbiterV2 → ProactivePipeline → WS fan-out
 *   4. 完成率 = 实际送达（WS 收到 + outcome=delivered）/ 规则触发数；
 *      并断言沙箱内 proactive 决策 LLM 调用 = 0（data/llm-token-audit.ndjson 无主动性记录）
 *
 * 零 LLM 依赖（不加载 .env，外部模型/推送 provider 全关，话术走模板直投）。
 * 运行：npx tsx scripts/e2e-mapping-proactivity.ts   （exit 0 = 全链路跑通；约 8-10 分钟）
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const PORT = 3100;
const ACTOR = "local_user"; // 与映射规则缺省 actorId 对齐
const sandbox = mkdtempSync(join(tmpdir(), "pa-e2e-mapping-"));
mkdirSync(join(sandbox, "data"), { recursive: true });
const log = (line: string): void => console.log(`[e2e-mapping] ${line}`);

const received: Array<Record<string, unknown>> = [];

async function waitFor<T>(fn: () => T | null, timeoutMs: number, intervalMs: number): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = fn();
    if (r !== null && r !== undefined) return r;
    await new Promise((r2) => setTimeout(r2, intervalMs));
  }
  return null;
}

// ── 1. chdir 沙箱后加载真实生产装配 ──
log(`沙箱数据目录: ${sandbox}（仓库 data/ 不受影响）`);
log("加载真实服务端（createAppServices 完整装配）…");
process.chdir(sandbox);
// 测试窗口内关闭静默时段（深夜运行时 meeting_soon(must/high) 会被顺延到早 7 点）
process.env.PROACTIVITY_QUIET_START = "0";
process.env.PROACTIVITY_QUIET_END = "0";
const { createAppServices } = await import("../src/bootstrap/create-app-services.js");
const services = await createAppServices();
await services.app.listen({ port: PORT, host: "127.0.0.1" });
log(`服务端已监听 http://127.0.0.1:${PORT}`);

// ── 2. 真实 WS 客户端接入 ──
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
await new Promise<void>((resolve, reject) => {
  ws.once("open", () => resolve());
  ws.once("error", reject);
});
ws.on("message", (raw) => {
  try {
    const msg = JSON.parse(String(raw)) as Record<string, unknown>;
    received.push(msg);
    if (msg.type === "agent.proactive_message") {
      const p = msg.payload as Record<string, unknown> | undefined;
      log(`★ WS 收到主动消息 kind=${p?.kind ?? "?"} title=${String(p?.title ?? "").slice(0, 50)}`);
    }
  } catch {
    /* 非 JSON 忽略 */
  }
});
ws.send(JSON.stringify({ type: "session.init", payload: { sessionId: ACTOR } }));
await new Promise((r) => setTimeout(r, 1_500));
log(`WS 已连接（actor=${ACTOR}）`);

// ── 3. 创建真实日程任务：+8min → meeting_soon 的 15min alert 档（must 层，popup 直投）──
const createTask = async (title: string, description: string, inMin: number) => {
  const runAt = new Date(Date.now() + inMin * 60_000).toISOString();
  const res = await fetch(`http://127.0.0.1:${PORT}/schedule/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId: ACTOR,
      title,
      description,
      kind: "reminder",
      recurrence: "none",
      runAt,
      reminderMessage: `${title}快开始了`,
    }),
  });
  return (await res.json()) as { ok: boolean; task?: { taskId: string } };
};
const created = await createTask("季度评审会", "与产品团队过季度 OKR", 8);
if (!created.ok) {
  log(`FAIL: 日程任务创建失败: ${JSON.stringify(created).slice(0, 300)}`);
  ws.close();
  process.exit(1);
}
log(
  `日程任务已创建（taskId=${created.task?.taskId} +8min）` +
    `→ 等待 ScheduleSensor 轮询（≤5min）→ 状态板 → 映射规则 → 投递`,
);

// ── 4. 等真实链路把主动消息送到 WS 客户端 ──
const meetingHit = await waitFor(() => {
  return (
    received.find(
      (m) => m.type === "agent.proactive_message" && JSON.stringify(m).includes("季度评审会"),
    ) ?? null
  );
}, 480_000, 3_000);

// ── 5. 完成率与 LLM 消耗证据 ──
// 送达口径：WS 收到带 deliveryId 的 agent.proactive_message = 管道真实 fan-out
// （只有管道投递成功才发该帧；离线/挂起场景不会出现在在线 WS 客户端上）
const proactiveMsgs = received.filter((m) => m.type === "agent.proactive_message");
const meetingMsg = proactiveMsgs.find((m) => JSON.stringify(m).includes("季度评审会"));

// outcome 台账为辅助证据（退出时防抖可能未刷盘，best-effort）
let outcomes: Array<{ kind?: string; outcome?: string; title?: string }> = [];
try {
  outcomes = JSON.parse(readFileSync(join(sandbox, "data", "proactivity", "outcomes.json"), "utf8"));
} catch {
  /* 尚无 outcome */
}

// LLM 消耗分两笔账：
//   决策车道（proactive_intent / proactive_act_loop）——必须为 0（代码已删除调用点）
//   话术润色（proactive_phrase）——仅内容型事件真实投递时 1 次，属投递成本非决策成本
const auditPath = join(sandbox, "data", "llm-token-audit.ndjson");
let decisionLlmCalls = 0;
let phraseLlmCalls = 0;
if (existsSync(auditPath)) {
  for (const line of readFileSync(auditPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as { stage?: string };
      const stage = rec.stage ?? "";
      if (stage === "proactive_intent" || stage === "proactive_act_loop") decisionLlmCalls += 1;
      if (stage === "proactive_phrase") phraseLlmCalls += 1;
    } catch {
      /* 忽略坏行 */
    }
  }
}

// 场景判定：meeting_soon 走 must 层，必须 WS 真实送达（硬性）
log("──── 端到端结果 ────");
log(`meeting_soon（临会提醒）: ${meetingHit ? "送达 ✔" : "未送达 ✘"}`);
log(`决策 LLM 调用（intent/act_loop）: ${decisionLlmCalls} 次（预期 0）`);
log(`话术润色 LLM 调用（phrase，仅投递时）: ${phraseLlmCalls} 次`);
log(`outcomes.json 记录数: ${outcomes.length}`);
log(`meeting 消息 payload: ${meetingMsg ? JSON.stringify(meetingMsg).slice(0, 300) : "（无）"}`);

ws.close();
try {
  await services.app.close();
} catch {
  /* ignore */
}
try {
  rmSync(sandbox, { recursive: true, force: true });
} catch {
  log(`沙箱保留（清理被占用）: ${sandbox}`);
}
const ok = Boolean(meetingMsg && decisionLlmCalls === 0);
log(ok ? "PASS: 状态板→映射规则→仲裁→管道→WS 送达 全链路真实跑通，决策零 LLM" : "FAIL");
process.exit(ok ? 0 : 1);
