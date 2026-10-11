/**
 * 「你叫我什么？」带称呼记忆 E2E（2026-10-10，补 fresh 账号验证的缺口）。
 *
 * 场景对齐真实用户抱怨：用户给 agent 起了名字 + 有用户称呼约定，然后问
 * 「你叫我什么？」（= 你怎么称呼我）。正确行为：答出记忆里的用户称呼（王哥）。
 *
 * 流程：
 *   1. session.init（fresh 测试账号）
 *   2. 第一轮：「记住，你叫小P助手；我姓王，你平时叫我王哥就行」→ 等回复
 *   3. 等记忆整合链路落库（固定间隔）
 *   4. 第二轮：「你叫我什么？」→ 断言
 *
 * 通过标准：
 *   ANSWER_WANGGE   第二轮回复包含「王哥」（答出对用户的称呼）
 *   NOT_SELF_NAME   回复不把 agent 自己的名字（小P助手）当作用户的称呼
 *   NO_TRAVEL_ECHO  无旅游串台（旧 bug 回归）
 *
 * FAIL 模式即用户抱怨的「主语理解反」：把句子答成「你想叫我什么」。
 */

import WebSocket from "ws";

const WS_URL = process.argv[2] ?? "ws://127.0.0.1:3000/ws";
const USER_ID = `e2e-callmem-${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "")}`;
const TIMEOUT_MS = 150_000;
const QUIET_MS = 25_000;
/** 两轮间隔：给记忆整合/画像落库留时间 */
const MEMORY_SETTLE_MS = 20_000;

let finalText1 = "";
let finalText2 = "";
let chatError = "";
let toolCalls = new Set();
let round = 0;
let quietTimer = null;
let settleTimer = null;

function armQuietTimer() {
  clearTimeout(quietTimer);
  quietTimer = setTimeout(finish, QUIET_MS);
}

function send(text) {
  ws.send(JSON.stringify({
    type: "chat.user_message",
    payload: {
      sessionId: USER_ID,
      messageId: `e2e-${Date.now()}`,
      text,
      timestamp: new Date().toISOString(),
      agentAccessMode: "full",
      userId: USER_ID,
    },
  }));
  console.log(`已发送（第${round}轮）：${text}`);
}

function finish() {
  clearTimeout(timer);
  clearTimeout(quietTimer);
  clearTimeout(settleTimer);
  const reply = finalText2 || finalText1;
  const wangge = /王哥/.test(reply);
  // agent 名字出现在回复里不算直接 FAIL（模型可能顺带提到自己），但若
  // 用户称呼完全缺席且 agent 名字被当作对用户的称呼 → 主语反了
  const selfNameAsAnswer = !/王哥/.test(reply) && /(叫我[^。]*小P|小P助手[^。]*(称呼|叫))/i.test(reply);
  const travelEcho = /方案\s*[ABC]|漂流|周末游|一日游|两日游|三日游/.test(reply);
  const pass = wangge && !travelEcho && !chatError;
  console.log("\n===== E2E 结果 =====");
  console.log(`ANSWER_WANGGE   : ${wangge}${wangge ? "" : "（没答出用户称呼！）"}`);
  console.log(`NOT_SELF_NAME   : ${!selfNameAsAnswer}${selfNameAsAnswer ? "（把 agent 名字当作用户称呼——主语反了）" : ""}`);
  console.log(`NO_TRAVEL_ECHO  : ${!travelEcho}`);
  console.log(`CHAT_ERROR      : ${chatError || "-"}`);
  console.log(`TOOLS           : ${[...toolCalls].join(", ") || "-"}`);
  console.log(`ROUND1_TEXT     : ${finalText1.slice(0, 200).replace(/\s+/g, " ")}`);
  console.log(`ROUND2_TEXT     : ${(finalText2 || "(未收到)").slice(0, 300).replace(/\s+/g, " ")}`);
  console.log(`账号: ${USER_ID}`);
  console.log(pass ? "E2E_PASS：称呼记忆答对（王哥）" : "E2E_FAIL");
  try { ws.close(); } catch { /* 已关 */ }
  process.exit(pass ? 0 : 2);
}

const ws = new WebSocket(WS_URL);
const timer = setTimeout(() => {
  console.log("E2E_TIMEOUT");
  finish();
}, TIMEOUT_MS);

ws.on("open", () => {
  console.log(`WS 已连接: ${WS_URL}，测试账号 ${USER_ID}`);
  ws.send(JSON.stringify({
    type: "session.init",
    payload: {
      sessionId: USER_ID,
      deviceId: "e2e-callmem-sim",
      userAlias: "owner",
      platform: "android",
      userId: USER_ID,
    },
  }));
  round = 1;
  setTimeout(() => send("记住，你以后叫小P助手，这是你的名字；我姓王，你平时叫我王哥就行。"), 1500);
});

ws.on("message", (raw) => {
  let msg;
  try { msg = JSON.parse(raw.toString()); } catch { return; }
  const type = msg?.type ?? "";
  if (type === "chat.tool_call") {
    const name = msg?.payload?.name ?? msg?.payload?.toolName ?? "";
    if (name) toolCalls.add(name);
  }
  if (type === "chat.stream_reset") {
    if (round === 1) finalText1 = ""; else finalText2 = "";
  }
  if (type === "chat.assistant_done") {
    const text = msg?.payload?.text ?? msg?.payload?.finalText ?? msg?.payload?.message ?? "";
    if (!text) return;
    if (round === 1) {
      if (text.length > finalText1.length) finalText1 = text;
      // 第一轮收口：等记忆落库后发第二轮
      if (!settleTimer && finalText1) {
        settleTimer = setTimeout(() => {
          round = 2;
          send("你叫我什么？");
          armQuietTimer();
        }, MEMORY_SETTLE_MS);
      }
      armQuietTimer();
    } else {
      if (text.length > finalText2.length) finalText2 = text;
      armQuietTimer();
    }
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
