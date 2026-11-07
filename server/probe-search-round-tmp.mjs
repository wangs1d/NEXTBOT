// 临时探针：验证搜索轮真实出口（改后应有正文、无搜索结果卡、无网址/来源）
import WebSocket from "ws";

const WS_URL = process.env.WS_URL ?? "ws://127.0.0.1:3000/ws";
const ROUNDS = process.argv.slice(2);
const QUERIES = ROUNDS.length > 0 ? ROUNDS : [
  "今天有什么科技新闻",
  "帮我查一下最近新能源汽车补贴政策有什么变化",
];

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

async function runTurn(text) {
  const session = `probe-search-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const ws = await connect();
  const dones = [];
  ws.on("message", (raw) => {
    let evt;
    try { evt = JSON.parse(raw.toString()); } catch { return; }
    if (evt.type === "chat.assistant_done") dones.push(evt.payload ?? {});
  });
  ws.send(JSON.stringify({ type: "session.init", payload: { sessionId: session } }));
  await new Promise((r) => setTimeout(r, 1200));
  ws.send(JSON.stringify({
    type: "chat.user_message",
    payload: { sessionId: session, messageId: `probe-${Date.now()}`, text, timestamp: new Date().toISOString() },
  }));
  const deadline = Date.now() + 180_000;
  while (dones.length === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
  }
  ws.close();
  return dones[0] ?? {};
}

function evidence(done) {
  const finalText = String(done.finalText ?? "");
  const blocks = Array.isArray(done.blocks) ? done.blocks : [];
  const cards = [...finalText.matchAll(/\[AGENT_RESULT_CARD_START\]([\s\S]*?)\[AGENT_RESULT_CARD_END\]/g)]
    .map((m) => { try { return JSON.parse(m[1].trim()).cardType || "generic"; } catch { return "<parse-fail>"; } });
  const blockCards = blocks.filter((b) => b && b.type === "card").map((b) => b.cardType ?? "generic");
  return {
    cards: [...cards, ...blockCards],
    urls: (finalText.match(/https?:\/\/[^\s)\]"'，。]+/g) ?? []).slice(0, 5),
    mediaCards: Array.isArray(done.mediaCards) ? done.mediaCards.length : 0,
    markers: [...finalText.matchAll(/\[RENDER_(?:AS|HINT):(\w+)\]/g)].map((m) => m[1]),
    len: finalText.length,
  };
}

for (const q of QUERIES) {
  console.log(`\n================ 问：${q} ================`);
  const done = await runTurn(q);
  const ev = evidence(done);
  console.log(`卡片: [${ev.cards.join(", ") || "无"}]  | 网址: ${ev.urls.length} 处${ev.urls.length ? " -> " + ev.urls.join(" ") : ""}`);
  console.log(`mediaCards: ${ev.mediaCards} | 形态标记: [${ev.markers.join(", ") || "无"}] | 正文 ${ev.len} 字`);
  console.log("---------------- 正文 ----------------");
  console.log(String(done.finalText ?? "").trim() || "(空)");
}
process.exit(0);
