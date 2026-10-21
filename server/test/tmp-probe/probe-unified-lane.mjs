/**
 * 去路由化真机验证：同一会话连发三条消息，断言
 *   1) 闲聊「你还记得 不错不错」零搜索工具；
 *   2) 搜图「帮我搜索成龙最近的照片」真的调 search_images；
 *   3) 天气「明天天气怎么样」真的调 weather.get_local。
 * 用法：node test/tmp-probe/probe-unified-lane.mjs [wsUrl]
 */
import WebSocket from "ws";

const WS_URL = process.argv[2] ?? "ws://127.0.0.1:3000/ws";
const USER_ID = `probe-unified-${Date.now()}`;
const PER_MSG_TIMEOUT = 90_000;
const QUIET_MS = 1500;

const messages = [
  { text: "你还记得 不错不错", want: [], forbid: ["search_images", "search_web", "search_videos", "deep_search"] },
  { text: "帮我搜索成龙最近的照片", want: ["search_images"], forbid: [] },
  { text: "明天天气怎么样", want: ["weather.get_local"], forbid: [] },
];

const results = [];
let current = null;
let ws;
let doneTimer = null;

function finishTurn() {
  clearTimeout(doneTimer);
  if (!current) return;
  results.push(current);
  const idx = results.length;
  console.log(
    `\n[#${idx}] "${current.text}" tools=[${current.tools.join(", ")}] ` +
      `done=${current.doneCount} elapsed=${current.elapsedMs}ms final="${current.finalText.slice(0, 80).replace(/\s+/g, " ")}"`,
  );
  current = null;
  if (idx < messages.length) {
    setTimeout(() => sendNext(), 3000);
  } else {
    const pass =
      results[0].tools.every((t) => !messages[0].forbid.includes(t)) &&
      results[1].tools.includes("search_images") &&
      results[2].tools.includes("weather.get_local");
    console.log("\n===== 结果 =====");
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      console.log(`#${i + 1} ${r.text} → tools=${r.tools.join(",") || "-"} ${r.elapsedMs}ms`);
    }
    console.log(pass ? "UNIFIED_LANE_PASS" : "UNIFIED_LANE_FAIL");
    try { ws.close(); } catch { /* ignore */ }
    process.exit(pass ? 0 : 2);
  }
}

function sendNext() {
  const item = messages[results.length];
  current = {
    text: item.text,
    tools: [],
    doneCount: 0,
    finalText: "",
    startedAt: Date.now(),
    elapsedMs: 0,
  };
  ws.send(JSON.stringify({
    type: "chat.user_message",
    payload: {
      sessionId: USER_ID,
      messageId: `probe-${Date.now()}`,
      text: item.text,
      timestamp: new Date().toISOString(),
      agentAccessMode: "full",
      userId: USER_ID,
    },
  }));
  console.log(`\n>> 发送 #${results.length + 1}: ${item.text}`);
  clearTimeout(doneTimer);
  doneTimer = setTimeout(() => {
    console.log(`[#${results.length + 1}] 超时未 done，按已收到的事件收口`);
    if (current) {
      current.elapsedMs = Date.now() - current.startedAt;
      finishTurn();
    }
  }, PER_MSG_TIMEOUT);
}

ws = new WebSocket(WS_URL);
ws.on("open", () => {
  console.log(`WS 已连接 ${WS_URL}，账号 ${USER_ID}`);
  ws.send(JSON.stringify({
    type: "session.init",
    payload: {
      sessionId: USER_ID,
      deviceId: "probe-unified",
      userAlias: "owner",
      platform: "windows",
      userId: USER_ID,
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
  if (type === "tool.call" && current) {
    const name = String(p.toolName ?? "");
    if (name && !current.tools.includes(name)) {
      current.tools.push(name);
      console.log(`   >> 工具: ${name}`);
    }
    return;
  }
  if (type === "chat.error") {
    console.log(`   >> chat.error: ${JSON.stringify(p).slice(0, 200)}`);
    return;
  }
  if (type === "chat.assistant_done" && current) {
    current.doneCount++;
    current.finalText += String(p.finalText ?? "");
    current.elapsedMs = Date.now() - current.startedAt;
    clearTimeout(doneTimer);
    doneTimer = setTimeout(finishTurn, QUIET_MS);
  }
});

ws.on("error", (e) => {
  console.error(`WS_ERROR ${e.message}`);
  process.exit(2);
});
