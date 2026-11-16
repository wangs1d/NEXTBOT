/**
 * 真链探针：手机端浏览器 Handoff（登录墙）图片回传端到端验证。
 *
 * 以手机客户端同款协议连 WS（platform=mobile、browserBridge=false），让 Agent
 * 用浏览器打开京东登录页（passport.jd.com 命中登录墙启发式），验证：
 *   1. tool.call agent_browser（无头浏览器真实打开）
 *   2. chat.media_ready（登录二维码/页面截图卡 → 手机端登录入口）← 核心断言
 *      —— 图片用 HTTP 真实下载回本地验图（人眼可核验）
 *   3. agent.browser.preview（悬浮窗实时画面，登录页应可见）
 *   4. chat.assistant_done（Agent 应引导用户扫码，而不是报错）
 *
 * 用法：node scratch/probe-mobile-browser-handoff.mjs [登录页URL]
 */
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";

const require = createRequire(new URL("../node_modules/main.js", import.meta.url));
const WebSocket = require("ws");

const WS_URL = process.env.WS_URL ?? "ws://127.0.0.1:3000/ws";
const HTTP_BASE = process.env.HTTP_BASE ?? "http://127.0.0.1:3000";
const TEXT = process.argv[2] ?? "用你的浏览器打开 https://passport.jd.com/new/login.aspx ，我要登录京东，到时候我自己扫码";
const SESSION_ID = `probe-mobhand-${Date.now().toString(36)}`;
const OUT_DIR = new URL("./mobhand-caps/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

const ws = new WebSocket(WS_URL);
const t0 = Date.now();
const stamp = () => `+${((Date.now() - t0) / 1000).toFixed(2)}s`;

const toolCalls = [];
const mediaCards = [];
const previewFrames = [];
let doneText = "";
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
  setTimeout(() => finish("timeout_150s"), 150_000);
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
    case "tool.result":
      console.log(`[${stamp()}] ← tool.result ${p.toolName} ok=${p.ok}${p.result?.loginQrPushed !== undefined ? ` loginQrPushed=${p.result.loginQrPushed}` : ""}`);
      break;
    case "chat.media_ready": {
      for (const card of p.cards ?? []) {
        mediaCards.push(card);
        console.log(`[${stamp()}] ← chat.media_ready card: type=${card.type} mediaType=${card.mediaType ?? "-"} title=${card.title ?? "-"}`);
        console.log(`           mediaUrl=${card.mediaUrl ?? card.thumbnailUrl}`);
        void downloadCard(card);
      }
      break;
    }
    case "agent.browser.preview": {
      previewFrames.push({ action: p.action, url: p.url, at: stamp() });
      const idx = previewFrames.length;
      try {
        writeFileSync(`${OUT_DIR}frame-${idx}-${p.action}.jpg`, Buffer.from(p.imageBase64 ?? "", "base64"));
        console.log(`[${stamp()}] ← agent.browser.preview #${idx} action=${p.action} url=${p.url}`);
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
    default:
      break;
  }
});

ws.on("close", (code) => {
  if (!finished) console.log(`[${stamp()}] WS CLOSE code=${code}（未收口）`);
});
ws.on("error", (e) => console.log(`[${stamp()}] WS ERROR ${e.message}`));

/** 把 media 卡的图片经 HTTP 真实下载回本地（手机端同款取图路径）。 */
async function downloadCard(card) {
  const url = card.mediaUrl ?? card.thumbnailUrl;
  if (!url) return;
  const full = url.startsWith("http") ? url : `${HTTP_BASE}${url}`;
  try {
    const res = await fetch(full);
    if (!res.ok) {
      console.log(`           下载失败 HTTP ${res.status} ← ${full}`);
      return;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const idx = mediaCards.length;
    const file = `${OUT_DIR}handoff-card-${idx}.jpg`;
    writeFileSync(file, buf);
    console.log(`           下载成功 ${buf.length} 字节 → ${file}`);
  } catch (e) {
    console.log(`           下载异常: ${e.message}`);
  }
}

function finish(reason) {
  if (finished) return;
  finished = true;
  console.log("\n════════════ 实测结论 ════════════");
  console.log(`结束原因: ${reason}`);
  console.log(`tool.call 序列: ${toolCalls.map((t) => `${t.name}@${t.at}`).join(" → ") || "（无）"}`);
  console.log(`chat.media_ready 卡片数: ${mediaCards.length}`);
  for (const [i, c] of mediaCards.entries()) {
    console.log(`  卡${i + 1}: title=${c.title} mediaType=${c.mediaType ?? "-"} url=${c.mediaUrl ?? c.thumbnailUrl}`);
  }
  console.log(`agent.browser.preview 帧数: ${previewFrames.length}`);
  if (doneText) {
    console.log(`最终回复（前 300 字）: ${doneText.slice(0, 300).replace(/\s+/g, " ")}`);
  }
  const pass = toolCalls.some((t) => String(t.name).includes("browser")) && mediaCards.length > 0;
  console.log(`\n判定: ${pass ? "PASS ✅ 登录墙 Handoff：图片已真实回传手机端" : "FAIL ❌ 未收到浏览器工具调用或登录图片卡"}`);
  try { ws.close(); } catch { /* ignore */ }
  setTimeout(() => process.exit(pass ? 0 : 1), 300);
}
