/**
 * 续跑探针：复用既有会话（同 sessionId），发送「我扫完了」，验证
 * Handoff 登录循环的下半段——Agent 是否在同一 actor 的浏览器会话上
 * 续跑并如实回报登录状态。
 *
 * 用法：node scratch/probe-mobile-handoff-continue.mjs <sessionId> ["文本"]
 */
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";

const require = createRequire(new URL("../node_modules/main.js", import.meta.url));
const WebSocket = require("ws");

const WS_URL = process.env.WS_URL ?? "ws://127.0.0.1:3000/ws";
const SESSION_ID = process.argv[2] ?? "";
const TEXT = process.argv[3] ?? "我扫完了二维码，确认一下登录成功没有";
if (!SESSION_ID) {
  console.error("用法: node probe-mobile-handoff-continue.mjs <sessionId> [文本]");
  process.exit(2);
}
const OUT_DIR = new URL("./mobhand-caps/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

const ws = new WebSocket(WS_URL);
const t0 = Date.now();
const stamp = () => `+${((Date.now() - t0) / 1000).toFixed(2)}s`;
const toolCalls = [];
const previewFrames = [];
let doneText = "";
let finished = false;

mkdirSync(OUT_DIR, { recursive: true });

ws.on("open", () => {
  console.log(`[${stamp()}] WS open，复用会话=${SESSION_ID}`);
  ws.send(JSON.stringify({
    type: "session.init",
    payload: {
      sessionId: SESSION_ID,
      deviceId: "probe-mobile-device",
      userAlias: "probe",
      browserBridge: false,
      platform: "mobile",
    },
  }));
  setTimeout(() => {
    console.log(`[${stamp()}] → "${TEXT}"`);
    ws.send(JSON.stringify({
      type: "chat.user_message",
      payload: {
        sessionId: SESSION_ID,
        messageId: `probe-cont-${Date.now().toString(36)}`,
        text: TEXT,
        timestamp: new Date().toISOString(),
        agentAccessMode: "full",
      },
    }));
  }, 800);
  setTimeout(() => finish("timeout_120s"), 120_000);
});

ws.on("message", (raw) => {
  let evt;
  try { evt = JSON.parse(raw.toString()); } catch { return; }
  const type = evt.type ?? "?";
  const p = evt.payload ?? {};
  switch (type) {
    case "tool.call":
      toolCalls.push(`${p.toolName}@${stamp()}`);
      console.log(`[${stamp()}] ← tool.call ${p.toolName}`);
      break;
    case "tool.result":
      console.log(`[${stamp()}] ← tool.result ${p.toolName} ok=${p.ok}`);
      break;
    case "agent.browser.preview": {
      previewFrames.push(p);
      const idx = previewFrames.length;
      try {
        writeFileSync(`${OUT_DIR}continue-frame-${idx}-${p.action}.jpg`, Buffer.from(p.imageBase64 ?? "", "base64"));
        console.log(`[${stamp()}] ← agent.browser.preview #${idx} url=${p.url}`);
      } catch { /* ignore */ }
      break;
    }
    case "chat.assistant_done":
      doneText = p.finalText ?? "";
      finish("done");
      break;
    case "chat.error":
      console.log(`[${stamp()}] ← chat.error: ${p.message}`);
      finish("chat_error");
      break;
    default: break;
  }
});

ws.on("error", (e) => console.log(`[${stamp()}] WS ERROR ${e.message}`));

function finish(reason) {
  if (finished) return;
  finished = true;
  console.log("\n════════════ 续跑结论 ════════════");
  console.log(`结束原因: ${reason}`);
  console.log(`tool.call: ${toolCalls.join(" → ") || "（无）"}`);
  console.log(`预览帧: ${previewFrames.length}`);
  if (doneText) console.log(`最终回复: ${doneText.slice(0, 400).replace(/\s+/g, " ")}`);
  try { ws.close(); } catch { /* ignore */ }
  setTimeout(() => process.exit(0), 300);
}
