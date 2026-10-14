/**
 * 真链探针：天气轮「答案留存」端到端验证（2026-10-13 根修配套）。
 *
 * 用法：node scripts/probe-weather-turn.mjs ["提问文本"]
 *
 * 以客户端同款协议连 WS，发一条天气提问，把全链路事件原样记录：
 *   - chat.assistant_chunk（用户实际看到的流式打字内容）
 *   - chat.stream_reset / chat.agent_status（工具执行状态）
 *   - chat.assistant_done（finalText + finalTextReplacesStream + blocks 卡片）
 * 自动应答 agent.location_request（兴义坐标），让 weather.get_local 拿到真实定位。
 *
 * 契约断言（根修后应为）：
 *   1. 流式 chunk 里只有「先一句话」确认语（或空），天气数值/正文不得流出；
 *   2. done.finalText 携带天气卡（[AGENT_RESULT_CARD_START] / blocks 含 weather 卡）；
 *   3. done.finalTextReplacesStream = true（整段替换语义）。
 */
import { createRequire } from "node:module";

const require = createRequire(new URL("../node_modules/main.js", import.meta.url));
const WebSocket = require("ws");

const WS_URL = process.env.WS_URL ?? "ws://127.0.0.1:3000/ws";
const TEXT = process.argv[2] ?? "现在天气怎么样？";
const SESSION_ID = `probe-weather-${Date.now().toString(36)}`;

const ws = new WebSocket(WS_URL);
const t0 = Date.now();
const stamp = () => `+${((Date.now() - t0) / 1000).toFixed(2)}s`;
let streamed = "";
let donePayload = null;
let locationAnswered = false;

ws.on("open", () => {
  console.log(`[${stamp()}] WS open → ${WS_URL}`);
  console.log(`[${stamp()}] session=${SESSION_ID}`);
  ws.send(JSON.stringify({
    type: "session.init",
    payload: { sessionId: SESSION_ID, deviceId: "probe-weather", userAlias: "probe" },
  }));
  setTimeout(() => {
    console.log(`[${stamp()}] → chat.user_message: "${TEXT}"`);
    ws.send(JSON.stringify({
      type: "chat.user_message",
      payload: {
        sessionId: SESSION_ID,
        messageId: `probe-${Date.now().toString(36)}`,
        text: TEXT,
        timestamp: new Date().toISOString(),
        agentAccessMode: "full",
      },
    }));
  }, 600);
  setTimeout(finish, 90_000);
});

ws.on("close", (code, reason) => {
  console.log(`[${stamp()}] WS CLOSE code=${code} reason=${reason.toString().slice(0, 80)}`);
});
ws.on("error", (e) => {
  console.log(`[${stamp()}] WS ERROR ${e.message}`);
});

ws.on("message", (raw) => {
  let evt;
  try { evt = JSON.parse(raw.toString()); } catch { return; }
  const type = evt.type ?? "?";
  const p = evt.payload ?? {};

  if (type === "agent.location_request" && !locationAnswered) {
    locationAnswered = true;
    console.log(`[${stamp()}] ← ${type} → 回包兴义坐标`);
    ws.send(JSON.stringify({
      type: "client.location_report",
      payload: {
        jobId: p.jobId,
        latitude: 25.0887,
        longitude: 104.9068,
        label: "贵州省黔西南布依族苗族自治州兴义市",
        timezone: "Asia/Shanghai",
      },
    }));
    return;
  }
  if (type === "chat.assistant_chunk") {
    const delta = String(p.chunk ?? p.delta ?? p.text ?? "");
    if (delta) {
      streamed += delta;
      console.log(`[${stamp()}] ← chunk(${delta.length}ch): ${JSON.stringify(delta.slice(0, 80))}`);
    }
    return;
  }
  if (type === "chat.assistant_done") {
    donePayload = p;
    console.log(`[${stamp()}] ← assistant_done 到达`);
    finish();
    return;
  }
  // 状态/工具事件打全（工具名/阶段是判定「是否卡片轮」的关键证据）
  if (type === "chat.agent_status" || type === "chat.status" || type === "chat.tool_status" || type === "chat.task_update" || type === "chat.turn_started" || type === "chat.intent_detected" || type === "chat.execution_event") {
    console.log(`[${stamp()}] ← ${type}: ${JSON.stringify(p).slice(0, 260)}`);
    return;
  }
  if (type === "chat.stream_reset") {
    console.log(`[${stamp()}] ← chat.stream_reset（撤回已流正文）`);
    return;
  }
  if (type.startsWith("agent.embodiment") || type === "chat.media_ready") return;
  console.log(`[${stamp()}] ← ${type}`);
});

function finish() {
  if (!donePayload && !streamed) return;
  console.log(`\n===== 真实回复（用户视角）=====`);
  console.log(`【流式打字出去的内容】(${streamed.length}ch):\n${streamed || "（无——零流式）"}\n`);
  if (donePayload) {
    const finalText = String(donePayload.finalText ?? "");
    const blocks = Array.isArray(donePayload.blocks) ? donePayload.blocks : [];
    const renderBlocks = Array.isArray(donePayload.renderBlocks) ? donePayload.renderBlocks : [];
    const cardBlock = blocks.find((b) => b?.type === "card") ?? null;
    const hasCardMarker = finalText.includes("[AGENT_RESULT_CARD_START]");
    const cardType = cardBlock?.cardType ?? cardBlock?.payload?.cardType ?? "";
    console.log(`【assistant_done】`);
    console.log(`  finalTextReplacesStream: ${donePayload.finalTextReplacesStream === true}`);
    console.log(`  天气卡: ${hasCardMarker || cardType ? `✔（cardType=${cardType || "（标记内嵌）"}）` : "✘ 无卡"}`);
    console.log(`  blocks: ${blocks.length} 段 / renderBlocks: ${renderBlocks.length} 段`);
    console.log(`  finalText:\n${finalText.slice(0, 900)}`);
    console.log(`\n===== 契约判定 =====`);
    const leak = /度|湿度|降水|℃|km\/h/.test(streamed);
    console.log(`1. 答案本体是否漏进流式: ${leak ? "✘ 泄漏" : "✔ 未泄漏（流式只有确认语或空）"}`);
    console.log(`2. done 携带天气卡: ${hasCardMarker || cardType ? "✔" : "✘"}`);
    console.log(`3. 整段替换语义: ${donePayload.finalTextReplacesStream === true ? "✔" : "—（无流式可替换时缺省）"}`);
  } else {
    console.log("✘ 90s 内未收到 assistant_done");
  }
  ws.close();
  process.exit(0);
}
