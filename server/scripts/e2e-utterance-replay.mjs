/**
 * 真机端到端回放：重复回复事故（「以后叫我王爷」）。
 *
 * 直连本机 WS（默认 ws://127.0.0.1:3000/ws），用独立 actorId 走一遍真实链路
 * （路由 → 主模型 → 工具循环 → 分段器 → 发言结算 → done），采集：
 *   - 每个 assistant chunk 的 messageId / bubbleIndex（= 客户端建条目的依据）
 *   - done 载荷的 utterance 观测字段（id / segments / collapse / collapseReason）
 *   - finalText 与 finalTextReplacesStream
 * 据此断言：本轮只有**一条发言**（utterance），过程话与结论不再各成一条消息。
 *
 * 用法：node scripts/e2e-utterance-replay.mjs ["以后叫我王爷"] [port]
 */
import WebSocket from "ws";

const TEXT = process.argv[2] || "以后叫我王爷";
const PORT = process.argv[3] || process.env.E2E_PORT || "3000";
const actor = `e2e-utterance-${Date.now()}`;
const messageId = `e2e-msg-${Date.now()}`;
const TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS ?? 180_000);

const chunks = [];
const donePayloads = [];
const otherEvents = [];
let initSent = false;
let finished = false;

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);

function log(line) {
  process.stdout.write(`${line}\n`);
}

function finish(code) {
  if (finished) return;
  finished = true;
  try {
    ws.close();
  } catch {
    /* ignore */
  }
  report();
  process.exit(code);
}

function report() {
  log("");
  log("=== 采集结果 ===");
  const byId = new Map();
  for (const c of chunks) {
    if (!byId.has(c.messageId)) byId.set(c.messageId, []);
    byId.get(c.messageId).push(c.chunk);
  }
  log(`assistant chunk 条数：${chunks.length}`);
  log(`出现过的 messageId（= 客户端消息条目数）：${byId.size}`);
  for (const [id, parts] of byId) {
    const text = parts.join("");
    const idx = chunks.find((c) => c.messageId === id)?.bubbleIndex;
    log(`  - ${id}  bubbleIndex=${idx ?? "-"}  text="${text.slice(0, 60)}"`);
  }

  for (const p of donePayloads) {
    log("");
    log("=== assistant_done ===");
    log(`  messageId        : ${p.messageId}`);
    log(`  traceId          : ${p.traceId}`);
    log(`  finalText        : "${String(p.finalText ?? "").slice(0, 80)}"`);
    log(
      `  finalTextReplaces: ${p.finalTextReplacesStream === true}`,
    );
    log(
      `  bubbles          : ${Array.isArray(p.bubbles) ? p.bubbles.map((b) => b.id).join(", ") : "(未下发)"}`,
    );
    log(`  utterance        : ${JSON.stringify(p.utterance ?? null)}`);
    log(`  toolCalls        : ${JSON.stringify(p.toolCalls ?? [])}`);
  }

  if (otherEvents.length) {
    log("");
    log(`=== 其他事件（去重计数）===`);
    const counts = new Map();
    for (const t of otherEvents) counts.set(t, (counts.get(t) ?? 0) + 1);
    for (const [t, n] of counts) log(`  ${t} × ${n}`);
  }

  // ─── 断言 ───
  log("");
  log("=== 判定 ===");
  const done = donePayloads[donePayloads.length - 1];
  if (!done) {
    log("FAIL: 未收到 assistant_done（本轮未完成）");
    return;
  }
  const utteranceSegments = done.utterance?.segments ?? 0;
  const utteranceCollapse = done.utterance?.collapse === true;
  const messageEntries = byId.size;
  const ok =
    messageEntries <= 1 ||
    (utteranceCollapse && messageEntries > 1); // 塌缩轮：客户端会删掉过程话泡，最终只剩 1 条
  log(`发言数（utterance.id 唯一）：1（协议保证，本轮 id=${done.utterance?.id ?? "-"}）`);
  log(`段落数：${utteranceSegments}，塌缩：${utteranceCollapse}（${done.utterance?.collapseReason ?? "-"}）`);
  log(`流式 messageId 数：${messageEntries}`);
  log(
    messageEntries === 1
      ? "PASS: 全轮只有一条消息条目（无重复回复）"
      : utteranceCollapse
        ? "PASS: 过程话被结论吸收，done 携带 finalTextReplacesStream + bubbles 清单 → 客户端塌缩为一条"
        : "FAIL: 多条消息条目且未塌缩 → 用户会看到重复回复",
  );
}

ws.on("open", () => {
  log(`[e2e] 已连接 ws://127.0.0.1:${PORT}/ws，actor=${actor}`);
  ws.send(
    JSON.stringify({
      type: "session.init",
      payload: {
        sessionId: actor,
        userId: actor,
        platform: "desktop",
        capabilities: {},
      },
    }),
  );
  setTimeout(sendUserMessage, 1200);
});

ws.on("message", (raw) => {
  let evt;
  try {
    evt = JSON.parse(raw.toString());
  } catch {
    return;
  }
  const type = evt.type;
  const payload = evt.payload ?? {};

  if (type === "chat.assistant_chunk") {
    if (payload.traceId !== messageId) return; // 只关心本轮
    chunks.push({
      messageId: payload.messageId,
      chunk: payload.chunk,
      bubbleIndex: payload.bubbleIndex,
      sequence: payload.sequence,
    });
    const isNew = chunks.filter((c) => c.messageId === payload.messageId).length === 1;
    if (isNew) log(`[chunk] 新消息条目 ${payload.messageId} (bubbleIndex=${payload.bubbleIndex ?? "-"})`);
    return;
  }

  if (type === "chat.assistant_done") {
    if (payload.traceId !== messageId) return;
    donePayloads.push(payload);
    log(`[done] 收到 assistant_done（finalText ${String(payload.finalText ?? "").length} 字）`);
    setTimeout(() => finish(0), 1500);
    return;
  }

  if (type === "error" || type === "chat.error") {
    log(`[error] ${JSON.stringify(payload).slice(0, 300)}`);
    otherEvents.push(type);
    return;
  }

  otherEvents.push(type);
});

/** 发送本轮用户消息（session.init 之后固定延迟，不依赖具体 ack 事件名）。 */
function sendUserMessage() {
  if (initSent) return;
  initSent = true;
  log(`[e2e] 发送用户消息："${TEXT}"（messageId=${messageId}）`);
  ws.send(
    JSON.stringify({
      type: "chat.user_message",
      payload: {
        sessionId: actor,
        userId: actor,
        messageId,
        text: TEXT,
        timestamp: new Date().toISOString(),
        contentType: "text",
      },
    }),
  );
}

ws.on("error", (err) => {
  log(`[e2e] WS 错误：${err?.message ?? err}`);
  finish(2);
});

setTimeout(() => {
  log(`[e2e] 超时（${TIMEOUT_MS}ms）`);
  finish(3);
}, TIMEOUT_MS);
