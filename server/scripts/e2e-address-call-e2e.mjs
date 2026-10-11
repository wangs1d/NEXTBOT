/**
 * 「你叫我什么？」串台修复 E2E（2026-10-10 词表退役的活体验证）。
 *
 * 背景（2026-10-09 事故）：AMBIGUOUS_FOLLOWUP_RE 缺 ^ 锚把这句话误判成追问轮
 * → 追问锚点注入锚到上一条旅游回复 → 模型回扣方案A/B/C + 手写行程检测误触发
 * 强制规划（10-30s 卡顿）。修复后：路由 understanding 全标记正确、零注入零补跑。
 *
 * 用法：node scripts/e2e-address-call-e2e.mjs [wsUrl]
 *   wsUrl 缺省 ws://127.0.0.1:3000/ws
 *
 * 通过标准（fresh 测试账号，无任何称呼记忆）：
 *   TURN_STARTED      本轮被服务端受理
 *   NO_TRAVEL_ECHO    回复不含旅游串台词（方案A/漂流/周末游/行程等）
 *   ON_TOPIC          回复围绕「称呼」本身（我/你/叫/名字/称呼/管家等）
 *   NO_PLANNING       本轮未触发 travel.plan-itinerary（强制补跑已死）
 *
 * FINAL_TEXT 全文打印供人工确认：是答称呼、反问称呼还是自报家门。
 */

import WebSocket from "ws";

const WS_URL = process.argv[2] ?? "ws://127.0.0.1:3000/ws";
const USER_ID = `e2e-call-${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "")}`;
const TIMEOUT_MS = 90_000;
const QUIET_MS = 25_000;

let turnStarted = false;
let finalText = "";
let toolCalls = new Set();
let chatError = "";
let doneCount = 0;
let quietTimer = null;

function finish() {
  clearTimeout(timer);
  clearTimeout(quietTimer);
  const verdictOk = verdict();
  try { ws.close(); } catch { /* 已关 */ }
  process.exit(verdictOk ? 0 : 2);
}

function armQuietTimer() {
  clearTimeout(quietTimer);
  quietTimer = setTimeout(finish, QUIET_MS);
}

function verdict() {
  const travelEcho = /方案\s*[ABC]|漂流|周末游|兴义|行程卡|出行方案|一日游|两日游|三日游/.test(finalText);
  const onTopic = /称呼|叫你|叫我|怎么叫|名字|称呼你|称呼我|私人管家|管家|private.?butler|想让我|你希望|怎么称呼/.test(finalText);
  const noPlanning = !/travel\.plan-itinerary/i.test([...toolCalls].join(","));
  const pass = turnStarted && !travelEcho && onTopic && noPlanning && !chatError;
  console.log("\n===== E2E 结果 =====");
  console.log(`TURN_STARTED   : ${turnStarted}`);
  console.log(`NO_TRAVEL_ECHO : ${!travelEcho}${travelEcho ? "（出现旅游串台词！）" : ""}`);
  console.log(`ON_TOPIC       : ${onTopic}`);
  console.log(`NO_PLANNING    : ${noPlanning}（tools: ${[...toolCalls].join(", ") || "-"}）`);
  console.log(`CHAT_ERROR     : ${chatError || "-"}`);
  console.log(`FINAL_TEXT     : ${finalText.slice(0, 400).replace(/\s+/g, " ")}`);
  console.log(`账号: ${USER_ID}`);
  console.log(pass ? "E2E_PASS：称呼提问零串台、零强制规划" : "E2E_FAIL");
  return pass;
}

const ws = new WebSocket(WS_URL);
const timer = setTimeout(() => {
  console.log("E2E_TIMEOUT（90s 内未收口）");
  verdict();
  process.exit(2);
}, TIMEOUT_MS);

ws.on("open", () => {
  console.log(`WS 已连接: ${WS_URL}，测试账号 ${USER_ID}`);
  ws.send(JSON.stringify({
    type: "session.init",
    payload: {
      sessionId: USER_ID,
      deviceId: "e2e-call-sim",
      userAlias: "owner",
      platform: "android",
      userId: USER_ID,
    },
  }));
  setTimeout(() => {
    ws.send(JSON.stringify({
      type: "chat.user_message",
      payload: {
        sessionId: USER_ID,
        messageId: `e2e-${Date.now()}`,
        text: "你叫我什么？",
        timestamp: new Date().toISOString(),
        agentAccessMode: "full",
        userId: USER_ID,
      },
    }));
    console.log("已发送「你叫我什么？」，等待 agent…");
    armQuietTimer();
  }, 1500);
});

ws.on("message", (raw) => {
  let msg;
  try { msg = JSON.parse(raw.toString()); } catch { return; }
  const type = msg?.type ?? "";
  if (type === "chat.turn_started") { turnStarted = true; armQuietTimer(); }
  if (type === "chat.tool_call") {
    const name = msg?.payload?.name ?? msg?.payload?.toolName ?? "";
    if (name) toolCalls.add(name);
  }
  if (type === "chat.stream_reset") { finalText = ""; }
  if (type === "chat.assistant_done") {
    doneCount += 1;
    const text = msg?.payload?.text ?? msg?.payload?.finalText ?? msg?.payload?.message ?? "";
    if (text && (!finalText || text.length > finalText.length)) finalText = text;
    armQuietTimer();
  }
  if (type === "chat.error") {
    chatError = msg?.payload?.message ?? "unknown";
    finish();
  }
});

ws.on("error", (e) => {
  console.log(`WS 错误: ${e.message}`);
  process.exit(2);
});
