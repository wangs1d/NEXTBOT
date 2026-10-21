/**
 * 闲聊轮真实链路验证（2026-10-21 事故回归探针）：
 * 事故句「哎呀 这不是在做独立开发吗 我要追我老婆呀」曾被 task-intent 规则 3
 * 误判成任务 → forced-tool tool_choice=required 强制调工具 → 搜明星近况。
 * 修复后断言：
 *   1) 事故句零搜索工具（纯对话回复）；
 *   2) 陈述句「今天分析了一下这个bug」零搜索工具；
 *   3) 对照组「帮我查查最新的新闻」仍真实调 search_web（真诉求不受影响）。
 * 用法：node test/tmp-probe/probe-chat-banter.mjs [wsUrl]
 */
import WebSocket from "ws";

const WS_URL = process.argv[2] ?? "ws://127.0.0.1:3000/ws";
const USER_ID = `probe-banter-${Date.now()}`;
const PER_MSG_TIMEOUT = 90_000;
const QUIET_MS = 1500;

const SEARCH_FORBID = ["search_images", "search_videos", "deep_search", "fetch_web"];
const messages = [
  { text: "哎呀 这不是在做独立开发吗 我要追我老婆呀", forbid: ["search_web", ...SEARCH_FORBID] },
  { text: "帮我查查最新的新闻", want: ["search_web", "hot_rankings", "deep_search"], forbid: [] },
  { text: "今天分析了一下这个bug，有点意思", forbid: ["search_web", ...SEARCH_FORBID] },
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
      `done=${current.doneCount} elapsed=${current.elapsedMs}ms final="${current.finalText.slice(0, 100).replace(/\s+/g, " ")}"`,
  );
  current = null;
  if (idx < messages.length) {
    setTimeout(() => sendNext(), 3000);
  } else {
    console.log("\n===== 结果 =====");
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      console.log(`#${i + 1} ${r.text} → tools=${r.tools.join(",") || "-"} ${r.elapsedMs}ms`);
    }
    const pass =
      results[0].tools.every((t) => !messages[0].forbid.includes(t)) &&
      results[1].tools.some((t) => messages[1].want.includes(t)) &&
      results[2].tools.every((t) => !messages[2].forbid.includes(t));
    console.log(pass ? "CHAT_BANTER_PASS" : "CHAT_BANTER_FAIL");
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
      messageId: `probe-banter-${Date.now()}`,
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
      deviceId: "probe-banter",
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
