/**
 * 主动性链路 live E2E（2026-10-20）：「agent 主动给用户发消息」三条真实链路验证。
 *
 * 真实组件：完整生产装配（或 attach 已运行的生产 server）+ ProactivePipeline
 * 统一管道 + arbiter 管道层仲裁 + ProactiveDeliveryService WS fan-out +
 * OutcomeStore outcome 落库 + wsConnectionRegistry 重连补投。
 *
 * 脚本扮演「手机端」：WS 连接 + session.init 绑定 actor，然后：
 *   链路① 在线秒达：GET /api/proactivity/selftest?fire=1（must 层直达管道）
 *         → WS 收到 agent.proactive_message（带 deliveryId）
 *         → POST /api/proactivity/outcome 回传 accepted → diagnostics 确认落库；
 *   链路② 离线重连补达：断开 WS → fire（设备离线）→ 断言 verdict=deferred
 *         + offline_wait_reconnect（挂起待重连）→ 重连 → flushDue 补投到达；
 *   链路③ outcome 落库：两链路的 outcome 均经 HTTP 回传并在 diagnostics 可见。
 *
 * 注意：
 *  - selftest 的 dedupKey 含分钟（selftest:<minute>），两条链路必须跨分钟触发，
 *    脚本自动等待到下一分钟边界；
 *  - 静默时段（默认 23-7）离线提案会 defer 到早上（quiet_hours 优先于 offline
 *    判定），链路②在该时段自动跳过并标注 skip 原因；
 *  - attach 模式下若用户其他设备仍在线，链路②的「离线」前提不成立，同样 skip。
 *
 * 运行：
 *   npx tsx scripts/e2e-proactivity-live.ts                    （内嵌沙箱，零 LLM 零外网）
 *   PA_E2E_ATTACH=1 PA_E2E_PORT=3100 PA_E2E_ACTOR=local_user \
 *     npx tsx scripts/e2e-proactivity-live.ts                  （attach 已运行的生产 server）
 */
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

// ① cwd 仍在 server/ 时先加载 env（.env + .env.local，模块加载时自动执行）
await import("../src/config/load-server-env.js");

const PORT = Number(process.env.PA_E2E_PORT ?? 3102);
const ACTOR = process.env.PA_E2E_ACTOR ?? "local_user";
const ATTACH = process.env.PA_E2E_ATTACH === "1";
// 沙箱模式：关闭静默时段（START=END → isQuietHour 恒 false）。凌晨跑脚本时
// 离线提案会被 quiet_hours defer 到明早（静默判定先于 offline 判定），
// 链路②的重连补达就没法在本次会话验证了。仅覆盖内嵌 server 的进程 env；
// attach 模式不动——生产 server 的静默配置以它自己的启动 env 为准。
if (!ATTACH) {
  process.env.PROACTIVITY_QUIET_START = "0";
  process.env.PROACTIVITY_QUIET_END = "0";
}
const { isQuietHourNow } = await import("../src/proactivity/quiet-hours.js");

const HTTP_BASE = `http://127.0.0.1:${PORT}`;
const sandbox = mkdtempSync(join(tmpdir(), "pa-e2e-proactivity-"));
mkdirSync(join(sandbox, "data"), { recursive: true });
const log = (line: string): void => console.log(`[e2e-proactivity] ${line}`);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

if (ATTACH) {
  log(`attach 模式：连接 ws://127.0.0.1:${PORT}/ws（actor=${ACTOR}，不内嵌服务端）`);
} else {
  log(`沙箱模式：静默时段已关闭（PROACTIVITY_QUIET_START=END=0）`);
  process.chdir(sandbox);
  log(`沙箱数据目录: ${sandbox}`);
  const { createAppServices } = await import("../src/bootstrap/create-app-services.js");
  const services = await createAppServices();
  await services.app.listen({ port: PORT, host: "127.0.0.1" });
  log(`服务端已监听 http://127.0.0.1:${PORT}`);
}

// ── WS 客户端（可反复连接/断开，模拟设备上下线）──
let proactiveFrames: Array<Record<string, unknown>> = [];
let ws: WebSocket | null = null;

function connectDevice(): Promise<void> {
  return new Promise((resolve, reject) => {
    proactiveFrames = [];
    ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    ws.once("open", () => resolve());
    ws.once("error", reject);
    ws.on("message", (raw) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(String(raw)) as Record<string, unknown>;
      } catch {
        return;
      }
      const type = String(msg.type ?? "");
      if (type === "agent.proactive_message") {
        proactiveFrames.push((msg.payload ?? {}) as Record<string, unknown>);
        log(`★ 收到 agent.proactive_message：title=${(msg.payload as Record<string, unknown>)?.title} deliveryId=${(msg.payload as Record<string, unknown>)?.deliveryId}`);
      } else if (type.includes("error") || type.includes("Error")) {
        log(`✘ 错误帧 ${type}: ${JSON.stringify(msg.payload).slice(0, 200)}`);
      } else {
        log(`[帧] ${type}`);
      }
    });
  });
}

function sendSessionInit(): void {
  ws?.send(JSON.stringify({
    type: "session.init",
    payload: { sessionId: ACTOR, userId: ACTOR, deviceId: "e2e-proactivity" },
  }));
}

function closeDevice(): Promise<void> {
  return new Promise((resolve) => {
    if (!ws || ws.readyState === WebSocket.CLOSED) return resolve();
    ws.once("close", () => resolve());
    ws.close();
  });
}

async function httpJson<T>(method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> {
  const res = await fetch(`${HTTP_BASE}${path}`, {
    method,
    ...(body !== undefined ? {
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    } : {}),
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json()) as T;
  return { status: res.status, json };
}

/** 等主动消息帧到达；timeout 内没到返回 null */
async function waitForProactive(timeoutMs: number): Promise<Record<string, unknown> | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frame = proactiveFrames[proactiveFrames.length - 1];
    if (frame) return frame;
    await sleep(200);
  }
  return null;
}

/** selftest 的 dedupKey 含分钟：等跨到下一分钟再触发下一条，避免 merged 去重 */
async function waitNextMinute(): Promise<void> {
  const msIntoMinute = Date.now() % 60_000;
  const wait = 60_000 - msIntoMinute + 2_000;
  log(`等待跨分钟（${Math.round(wait / 1000)}s）规避 selftest dedupKey 碰撞…`);
  await sleep(wait);
}

// ── 链路① 在线秒达 ──
log(`── 链路① 在线秒达（actor=${ACTOR}）──`);
await connectDevice();
sendSessionInit();
await sleep(1_500); // 等 session.init 处理完（连接绑定 actor + presence 上线）

const fire1 = await httpJson<Record<string, unknown>>("GET", "/api/proactivity/selftest?fire=1");
log(`selftest?fire=1 → ${JSON.stringify((fire1.json as { delivery?: unknown }).delivery)}`);
const delivery1 = (fire1.json as { delivery?: { verdict?: string; reasonChain?: string[] } }).delivery;
const actorFired = (fire1.json as { actorId?: string }).actorId;

const frame1 = await waitForProactive(10_000);
const deliveryId1 = String(frame1?.deliveryId ?? "");
log(`链路① 收帧 deliveryId=${deliveryId1}`);

let outcome1Ok = false;
let outcome1InDiag = false;
if (deliveryId1) {
  const outcome1 = await httpJson<Record<string, unknown>>("POST", "/api/proactivity/outcome", {
    deliveryId: deliveryId1,
    outcome: "accepted",
  });
  outcome1Ok = outcome1.status === 200 && (outcome1.json as { ok?: boolean }).ok === true;
  log(`outcome 回传 → HTTP ${outcome1.status} ${JSON.stringify(outcome1.json)}`);
  await sleep(500);
  const diag = await httpJson<Record<string, unknown>>("GET", "/api/proactivity/diagnostics");
  const outcomes = (diag.json as { recentOutcomes?: Array<Record<string, unknown>> }).recentOutcomes ?? [];
  outcome1InDiag = outcomes.some((o) => o.deliveryId === deliveryId1 && o.outcome === "accepted");
  log(`diagnostics.recentOutcomes 命中=${outcome1InDiag}（共 ${outcomes.length} 条）`);
}

// ── 链路② 离线重连补达 ──
log(`── 链路② 离线重连补达 ──`);
await closeDevice();
await sleep(1_500); // 等 presence.markDisconnected 生效
await waitNextMinute();

const fire2 = await httpJson<Record<string, unknown>>("GET", "/api/proactivity/selftest?fire=1");
const delivery2 = (fire2.json as { delivery?: { verdict?: string; reasonChain?: string[] } }).delivery;
const verdict2 = delivery2?.verdict ?? "";
const reason2 = (delivery2?.reasonChain ?? []).join(";");
log(`离线 fire → verdict=${verdict2} reason=${reason2}`);

let skipOfflineChain = false;
let skipReason = "";
if (isQuietHourNow(new Date())) {
  skipOfflineChain = true;
  skipReason = "静默时段（quiet_hours 判定优先于 offline，提案 defer 到明早，重连补达无法在本会话验证）";
} else if (verdict2 === "delivered") {
  skipOfflineChain = true;
  skipReason = "fire 时仍有其他设备在线（attach 模式下用户桌面端连着），离线前提不成立";
}

let reconnectDelivered = false;
let deliveryId2 = "";
let outcome2Ok = false;
if (!skipOfflineChain) {
  const offlineDeferredOk = verdict2 === "deferred" && reason2.includes("offline_wait_reconnect");
  log(`离线挂起断言=${offlineDeferredOk ? "通过" : "失败"}（期望 deferred + offline_wait_reconnect）`);

  await connectDevice();
  sendSessionInit();
  const frame2 = await waitForProactive(15_000);
  deliveryId2 = String(frame2?.deliveryId ?? "");
  reconnectDelivered = deliveryId2.length > 0;
  log(`重连补投 deliveryId=${deliveryId2 || "(未到达)"}`);

  if (deliveryId2) {
    const outcome2 = await httpJson<Record<string, unknown>>("POST", "/api/proactivity/outcome", {
      deliveryId: deliveryId2,
      outcome: "accepted",
    });
    outcome2Ok = outcome2.status === 200 && (outcome2.json as { ok?: boolean }).ok === true;
    log(`链路② outcome 回传 → HTTP ${outcome2.status}`);
  }
  await closeDevice();
} else {
  log(`⏭ 链路②跳过：${skipReason}`);
}

// ── 断言汇总 ──
console.log("\n══════════════ 真实链路结果 ══════════════");
console.log(`selftest actorId=${actorFired}（期望 ${ACTOR}）`);
console.log(`链路① fire verdict=${delivery1?.verdict}（期望 delivered）`);
console.log(`链路① WS 收到 agent.proactive_message=${!!frame1} deliveryId=${deliveryId1 || "(无)"}`);
console.log(`链路① outcome 回传 ok=${outcome1Ok} / diagnostics 落库=${outcome1InDiag}`);
if (skipOfflineChain) {
  console.log(`链路② skipped：${skipReason}`);
} else {
  console.log(`链路② 离线挂起 verdict=${verdict2} reason=${reason2}`);
  console.log(`链路② 重连补投到达=${reconnectDelivered} deliveryId=${deliveryId2 || "(无)"}`);
  console.log(`链路② outcome 回传 ok=${outcome2Ok}`);
}

const failures: string[] = [];
if (actorFired !== ACTOR) failures.push(`selftest 投给了 ${actorFired} 而非 ${ACTOR}（attach 模式请把 PA_E2E_ACTOR 设成 primaryActor 对应值）`);
if (delivery1?.verdict !== "delivered") failures.push(`链路① fire verdict=${delivery1?.verdict}（期望 delivered，reason=${(delivery1?.reasonChain ?? []).join(";")}）`);
if (!frame1) failures.push("链路① WS 未收到 agent.proactive_message（在线秒达未发生）");
if (!deliveryId1) failures.push("链路① 帧缺 deliveryId（outcome 无法回传）");
if (!outcome1Ok) failures.push("链路① outcome 回传失败（/api/proactivity/outcome 未 ok）");
if (!outcome1InDiag) failures.push("链路① outcome 未在 diagnostics.recentOutcomes 落库");
if (!skipOfflineChain) {
  if (!(verdict2 === "deferred" && reason2.includes("offline_wait_reconnect")))
    failures.push(`链路② 离线挂起未发生：verdict=${verdict2} reason=${reason2}`);
  if (!reconnectDelivered) failures.push("链路② 重连后未补投（flushDue→deliver 链路未发生）");
  if (!outcome2Ok) failures.push("链路② outcome 回传失败");
}

console.log("\n══════════════ 断言 ══════════════");
if (failures.length === 0) {
  console.log("✔ 全部通过：在线秒达 + 离线重连补达 + outcome 落库 三条链路真实发生");
  process.exit(0);
} else {
  console.log("✘ 未通过：");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
