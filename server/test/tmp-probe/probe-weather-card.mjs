/**
 * 天气卡取证探针：发送天气消息，完整抓取 done 载荷（finalText/blocks/mediaCards/
 * renderBlocks），并追踪流式阶段是否有图片/媒体标记混入。
 * 用法：node test/tmp-probe/probe-weather-card.mjs [wsUrl]
 */
import WebSocket from "ws";
import { appendFileSync } from "node:fs";

const WS_URL = process.argv[2] ?? "ws://127.0.0.1:3000/ws";
const USER_ID = `probe-wx-${Date.now()}`;
const TEXT = process.argv[3] ?? "今天天气怎么样";
const OUT = "test/tmp-probe/weather-done-dump.json";

let donePayload = null;
let streamChunks = [];
let tools = [];
let ws;

ws = new WebSocket(WS_URL);
ws.on("open", () => {
  console.log(`WS 已连接 ${WS_URL}，账号 ${USER_ID}`);
  ws.send(JSON.stringify({
    type: "session.init",
    payload: {
      sessionId: USER_ID,
      deviceId: "probe-weather",
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
        messageId: `probe-${Date.now()}`,
        text: TEXT,
        timestamp: new Date().toISOString(),
        agentAccessMode: "full",
        userId: USER_ID,
      },
    }));
    console.log(`>> 发送: ${TEXT}`);
  }, 1200);
});

ws.on("message", (raw) => {
  let msg;
  try { msg = JSON.parse(raw.toString()); } catch { return; }
  const type = String(msg.type ?? "");
  const p = (msg.payload && typeof msg.payload === "object") ? msg.payload : {};

  if (type === "agent.location_request") {
    ws.send(JSON.stringify({
      type: "client.location_report",
      payload: {
        jobId: p.jobId,
        latitude: 25.0914,
        longitude: 104.8952,
        timezone: "Asia/Shanghai",
        label: "兴义市",
      },
    }));
    return;
  }
  if (type === "tool.call") {
    const name = String(p.toolName ?? "");
    if (name && !tools.includes(name)) { tools.push(name); console.log(`   >> 工具: ${name}`); }
    return;
  }
  if (type === "chat.stream_delta" || type === "chat.stream") {
    const t = String(p.delta ?? p.text ?? "");
    if (t) streamChunks.push(t);
    return;
  }
  if (type === "chat.assistant_done") {
    donePayload = p;
    console.log("\n===== done 载荷 =====");
    console.log(`finalText (${String(p.finalText ?? "").length} chars):`);
    console.log(String(p.finalText ?? ""));
    if (p.blocks) console.log(`\nblocks: ${JSON.stringify(p.blocks, null, 2).slice(0, 4000)}`);
    if (p.mediaCards) console.log(`\nmediaCards: ${JSON.stringify(p.mediaCards, null, 2).slice(0, 3000)}`);
    if (p.renderBlocks) console.log(`\nrenderBlocks: ${JSON.stringify(p.renderBlocks, null, 2).slice(0, 3000)}`);
    console.log(`\n工具: ${tools.join(", ") || "-"}`);
    console.log(`流式块数: ${streamChunks.length}`);
    try {
      appendFileSync(OUT, JSON.stringify({ text: TEXT, tools, streamJoined: streamChunks.join(""), done: p }, null, 2));
      console.log(`完整载荷已落盘 ${OUT}`);
    } catch (e) { console.log(`落盘失败: ${e.message}`); }
    setTimeout(() => { try { ws.close(); } catch {} process.exit(0); }, 2000);
    return;
  }
  if (type === "chat.error") {
    console.log(`   >> chat.error: ${JSON.stringify(p).slice(0, 300)}`);
    return;
  }
});

setTimeout(() => {
  console.log("90s 超时未 done");
  console.log(`已收流式块: ${streamChunks.join("").slice(0, 500)}`);
  try { ws.close(); } catch {}
  process.exit(2);
}, 90_000);

ws.on("error", (e) => { console.error(`WS_ERROR ${e.message}`); process.exit(2); });
