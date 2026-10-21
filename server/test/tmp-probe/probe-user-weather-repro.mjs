/**
 * 用户同账号复现天气轮：以 2378709729@qq.com 发送天气消息，抓完整事件序列
 * （stream/media_ready/agent_status/done 全量），跑完自动调 delete-turn 清理。
 */
import WebSocket from "ws";

const WS_URL = "ws://127.0.0.1:3000/ws";
const USER_ID = "2378709729@qq.com";
const TEXT = "今天天气怎么样";
const events = [];
let donePayload = null;
let ws;
let sent = false;

function log(line) { console.log(line); events.push(line); }

ws = new WebSocket(WS_URL);
ws.on("open", () => {
  ws.send(JSON.stringify({
    type: "session.init",
    payload: {
      sessionId: USER_ID,
      deviceId: "probe-repro",
      userAlias: "owner",
      platform: "windows",
      userId: USER_ID,
    },
  }));
  setTimeout(() => {
    ws.send(JSON.stringify({
      type: "chat.user_message",
      payload: {
        sessionId: USER_ID,
        messageId: `probe-repro-${Date.now()}`,
        text: TEXT,
        timestamp: new Date().toISOString(),
        agentAccessMode: "full",
        userId: USER_ID,
      },
    }));
    sent = true;
    log(`>> 发送: ${TEXT}`);
  }, 1500);
});

ws.on("message", (raw) => {
  let msg;
  try { msg = JSON.parse(raw.toString()); } catch { return; }
  const type = String(msg.type ?? "");
  const p = (msg.payload && typeof msg.payload === "object") ? msg.payload : {};

  if (type === "agent.location_request") {
    ws.send(JSON.stringify({
      type: "client.location_report",
      payload: { jobId: p.jobId, latitude: 25.0914, longitude: 104.8952, timezone: "Asia/Shanghai", label: "兴义市" },
    }));
    log(`   [evt] location_request -> 应答兴义`);
    return;
  }
  if (type === "tool.call") { log(`   [evt] tool.call: ${p.toolName}`); return; }
  if (type.startsWith("chat.stream")) {
    const t = String(p.delta ?? p.text ?? "");
    log(`   [evt] ${type}: ${JSON.stringify(t).slice(0, 80)}`);
    return;
  }
  if (type === "chat.media_ready") {
    log(`   [evt] chat.media_ready: ${JSON.stringify(p).slice(0, 600)}`);
    return;
  }
  if (type === "chat.agent_status") {
    log(`   [evt] agent_status: ${p.line}`);
    return;
  }
  if (type === "chat.assistant_done") {
    donePayload = p;
    log("\n===== done 载荷 =====");
    log(`keys: ${Object.keys(p).join(", ")}`);
    log(`finalText:\n${String(p.finalText ?? "")}`);
    for (const k of ["blocks", "mediaCards", "renderBlocks", "summaryCard"]) {
      if (p[k] !== undefined) log(`\n${k}: ${JSON.stringify(p[k]).slice(0, 2500)}`);
    }
    if (p.bubbles) log(`\nbubbles: ${JSON.stringify(p.bubbles).slice(0, 800)}`);
    setTimeout(cleanup, 2500);
    return;
  }
  if (type === "chat.error") { log(`   [evt] chat.error: ${JSON.stringify(p).slice(0, 300)}`); return; }
});

async function cleanup() {
  try {
    const resp = await fetch("http://127.0.0.1:3000/api/chat-data/delete-turn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: USER_ID, text: TEXT }),
    });
    const j = await resp.json();
    log(`\n清理: delete-turn → ${JSON.stringify(j)}`);
  } catch (e) { log(`清理失败: ${e.message}`); }
  try { ws.close(); } catch {}
  process.exit(0);
}

setTimeout(() => { log("90s 超时"); cleanup(); }, 90_000);
ws.on("error", (e) => { console.error(`WS_ERROR ${e.message}`); process.exit(2); });
