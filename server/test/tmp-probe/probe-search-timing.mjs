import WebSocket from "ws";
const WS_URL = process.argv[2] ?? "ws://127.0.0.1:3000/ws";
const USER_ID = `probe-timing-${Date.now()}`;
const TEXT = process.argv[3] ?? "帮我搜索成龙最近的照片";
const t0 = Date.now();
const el = () => `${Date.now() - t0}ms`;
let ws;
ws = new WebSocket(WS_URL);
ws.on("open", () => {
  console.log(`[${el()}] WS open`);
  ws.send(JSON.stringify({ type: "session.init", payload: { sessionId: USER_ID, deviceId: "probe-timing", userAlias: "owner", platform: "windows", userId: USER_ID } }));
  setTimeout(() => {
    console.log(`[${el()}] send: ${TEXT}`);
    ws.send(JSON.stringify({ type: "chat.user_message", payload: { sessionId: USER_ID, messageId: `t-${Date.now()}`, text: TEXT, timestamp: new Date().toISOString(), agentAccessMode: "full", userId: USER_ID } }));
  }, 1200);
});
ws.on("message", (raw) => {
  let m; try { m = JSON.parse(raw.toString()); } catch { return; }
  const type = String(m.type ?? "");
  const p = (m.payload && typeof m.payload === "object") ? m.payload : {};
  if (type === "agent.location_request") {
    ws.send(JSON.stringify({ type: "client.location_report", payload: { jobId: p.jobId, latitude: 25.0914, longitude: 104.8952, timezone: "Asia/Shanghai", label: "兴义市" } }));
    return;
  }
  if (type === "chat.stream_delta" || type === "chat.assistant_delta" || type === "chat.message_chunk") {
    if (!globalThis.__firstDelta) { globalThis.__firstDelta = true; console.log(`[${el()}] first delta`); }
    return;
  }
  if (type === "tool.call") { console.log(`[${el()}] tool.call ${p.toolName}`); return; }
  if (type === "tool.result") { console.log(`[${el()}] tool.result ${JSON.stringify(p).slice(0, 120)}`); return; }
  if (type === "chat.agent_status") { console.log(`[${el()}] status ${JSON.stringify(p).slice(0, 100)}`); return; }
  if (type === "chat.assistant_done") {
    console.log(`[${el()}] DONE chars=${String(p.finalText ?? "").length}`);
    setTimeout(() => { ws.close(); process.exit(0); }, 500);
    return;
  }
  if (type === "chat.error") { console.log(`[${el()}] ERROR ${JSON.stringify(p).slice(0, 200)}`); }
});
setTimeout(() => { console.log("TIMEOUT"); process.exit(2); }, 120000);
