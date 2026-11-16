/**
 * 真链探针：手机端浏览器任务 + agent.browser.preview 悬浮窗帧端到端验证。
 *
 * 以手机客户端同款协议连 WS（session.init platform=mobile、browserBridge=false），
 * 发一条「用浏览器打开网页」的请求，记录全链路事件：
 *   - tool.call / tool.result（agent_browser 动作链）
 *   - agent.browser.preview（悬浮窗预览帧，落地为 JPEG 供人眼核验）
 *   - chat.assistant_done（最终回复）
 *
 * 用法：node scratch/probe-mobile-browser-preview.mjs ["提问文本"]
 */
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";

const require = createRequire(new URL("../node_modules/main.js", import.meta.url));
const WebSocket = require("ws");

const WS_URL = process.env.WS_URL ?? "ws://127.0.0.1:3000/ws";
const TEXT = process.argv[2] ?? "用你的浏览器打开 https://example.com 看看，然后告诉我页面标题和正文大意";
const SESSION_ID = `probe-mobbr-${Date.now().toString(36)}`;
const OUT_DIR = new URL("./mobbr-frames/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

const ws = new WebSocket(WS_URL);
const t0 = Date.now();
const stamp = () => `+${((Date.now() - t0) / 1000).toFixed(2)}s`;

const toolCalls = [];
const previewFrames = [];
let doneText = "";
let doneAt = 0;
let framesAfterDone = 0;
let finished = false;

mkdirSync(OUT_DIR, { recursive: true });

ws.on("open", () => {
  console.log(`[${stamp()}] WS open → ${WS_URL}`);
  console.log(`[${stamp()}] session=${SESSION_ID} (platform=mobile, browserBridge=false)`);
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
      toolCalls.push({ name: p.toolName, at: stamp() });
      console.log(`[${stamp()}] ← tool.call ${p.toolName}`);
      break;
    case "tool.result": {
      const last = toolCalls[toolCalls.length - 1];
      console.log(`[${stamp()}] ← tool.result ${p.toolName} ok=${p.ok}`);
      if (last && p.toolName === "agent_browser" && p.result?.url) {
        console.log(`           url=${p.result.url}`);
      }
      break;
    }
    case "agent.browser.preview": {
      previewFrames.push({ action: p.action, url: p.url, at: stamp(), bytes: p.imageBase64?.length ?? 0 });
      if (doneAt > 0) framesAfterDone += 1;
      const idx = previewFrames.length;
      const file = `${OUT_DIR}frame-${idx}-${p.action}.jpg`;
      try {
        writeFileSync(file, Buffer.from(p.imageBase64 ?? "", "base64"));
        console.log(`[${stamp()}] ← agent.browser.preview #${idx} action=${p.action} url=${p.url} → ${file}`);
      } catch (e) {
        console.log(`[${stamp()}] ← agent.browser.preview #${idx} 落盘失败: ${e.message}`);
      }
      break;
    }
    case "chat.assistant_done":
      doneText = p.finalText ?? "";
      doneAt = Date.now();
      // 收口后挂 15s 观察窗：验证「回合收口 → 连续流自停」
      setTimeout(() => finish("done+15s观察"), 15_000);
      break;
    case "chat.error":
      console.log(`[${stamp()}] ← chat.error: ${p.message}`);
      finish("chat_error");
      break;
    default:
      break;
  }
});

ws.on("close", (code) => {
  if (!finished) console.log(`[${stamp()}] WS CLOSE code=${code}（未收口）`);
});
ws.on("error", (e) => console.log(`[${stamp()}] WS ERROR ${e.message}`));

function finish(reason) {
  if (finished) return;
  finished = true;
  console.log("\n════════════ 实测结论 ════════════");
  console.log(`结束原因: ${reason}`);
  console.log(`tool.call 序列: ${toolCalls.map((t) => `${t.name}@${t.at}`).join(" → ") || "（无）"}`);
  console.log(`agent.browser.preview 帧数: ${previewFrames.length}`);
  console.log(`收口后 15s 观察窗内的帧数: ${framesAfterDone}（应为 0 或 1-2 帧内自停）`);
  for (const [i, f] of previewFrames.entries()) {
    console.log(`  帧${i + 1}: action=${f.action} url=${f.url} base64=${f.bytes} 字符 @${f.at}`);
  }
  if (doneText) {
    console.log(`最终回复（前 300 字）: ${doneText.slice(0, 300).replace(/\s+/g, " ")}`);
  }
  const pass = toolCalls.some((t) => String(t.name).includes("browser")) && previewFrames.length > 0;
  console.log(`\n判定: ${pass ? "PASS ✅ 手机端链路：浏览器任务被执行且悬浮窗帧已推送" : "FAIL ❌ 未收到浏览器工具调用或预览帧"}`);
  try { ws.close(); } catch { /* ignore */ }
  setTimeout(() => process.exit(pass ? 0 : 1), 200);
}
