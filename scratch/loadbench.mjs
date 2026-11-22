import WebSocket from "ws";

const WS_URL = process.env.WS_URL ?? "ws://127.0.0.1:3100/ws";
const N = Number(process.env.N ?? 8);
const TEXT = process.env.TEXT ?? "你好，简单回我一句就行";
const TAG = process.env.TAG ?? `load-${Date.now()}`;
const users = Array.from({ length: N }, (_, i) => `${TAG}-${i}`);
const started = Date.now();
const samples = [];

function runTurn(ws, userId) {
  return new Promise((resolve) => {
    const messageId = `m-${userId}`;
    const t0 = Date.now();
    const rec = { ack: null, first: null, done: null, chunks: 0, error: null };
    let settled = false;
    const timer = setTimeout(() => finish("timeout"), 120000);
    function finish(err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rec.error = err ?? null;
      resolve(rec);
    }
    const onMessage = (raw) => {
      let ev;
      try { ev = JSON.parse(raw.toString()); } catch { return; }
      const p = ev.payload ?? {};
      if (ev.type === "chat.message_received" && p.messageId === messageId) {
        rec.ack = Date.now() - t0;
        return;
      }
      if (ev.type === "chat.assistant_chunk" && p.traceId === messageId) {
        if (rec.first == null) rec.first = Date.now() - t0;
        rec.chunks += 1;
        return;
      }
      if (ev.type === "chat.assistant_done" && p.traceId === messageId) {
        rec.done = Date.now() - t0;
        ws.off("message", onMessage);
        finish();
        return;
      }
      if ((ev.type === "error" || ev.type === "chat.error" || ev.type === "chat.failed") &&
          (p.traceId === messageId || p.messageId === messageId)) {
        rec.error = p.error ?? p.message ?? ev.type;
        ws.off("message", onMessage);
        finish(rec.error);
      }
    };
    ws.on("message", onMessage);
    ws.send(JSON.stringify({
      type: "chat.user_message",
      payload: {
        text: TEXT,
        messageId,
        sessionId: userId,
        userId,
        timestamp: new Date().toISOString(),
      },
    }));
  });
}

const sampler = setInterval(async () => {
  try {
    const c = await fetch("http://127.0.0.1:3100/system/concurrency").then((r) => r.json());
    samples.push({
      t: Date.now() - started,
      active: c.globalTurn?.active ?? 0,
      queued: c.globalTurn?.queued ?? 0,
      max: c.globalTurn?.max ?? 0,
      rss: Math.round((c.resourcePool?.memoryBytes ?? 0) / 1048576),
      heap: Math.round((c.resourcePool?.heapUsedBytes ?? 0) / 1048576),
      tier: c.resourcePool?.tier ?? "?",
    });
  } catch {}
}, 1000);

const clients = await Promise.all(users.map((userId) => new Promise((resolve, reject) => {
  const ws = new WebSocket(WS_URL);
  const timer = setTimeout(() => reject(new Error("ws connect timeout")), 10000);
  ws.once("error", (e) => { clearTimeout(timer); reject(e); });
  ws.once("open", () => {
    ws.send(JSON.stringify({ type: "session.init", payload: { userId } }));
    setTimeout(() => { clearTimeout(timer); resolve({ ws, userId }); }, 200);
  });
})));

const results = await Promise.all(clients.map(({ ws, userId }) => runTurn(ws, userId)));
clearInterval(sampler);
for (const { ws } of clients) { try { ws.close(); } catch {} }

const done = results.map((r) => r.done).filter((x) => x != null).sort((a, b) => a - b);
const errors = results.filter((r) => r.error);
const pct = (p) => done.length ? done[Math.min(done.length - 1, Math.floor(done.length * p))] : null;
const peak = samples.reduce((a, s) => ({
  active: Math.max(a.active, s.active),
  queued: Math.max(a.queued, s.queued),
  rss: Math.max(a.rss, s.rss),
  heap: Math.max(a.heap, s.heap),
}), { active: 0, queued: 0, rss: 0, heap: 0 });

console.log(JSON.stringify({
  N,
  ok: done.length,
  failed: errors.length,
  errorKinds: errors.reduce((m, r) => { m[r.error] = (m[r.error] ?? 0) + 1; return m; }, {}),
  ackP50: pct(0.5),
  doneP50: pct(0.5),
  doneP90: pct(0.9),
  doneMax: done.at(-1) ?? null,
  peakActive: peak.active,
  peakQueued: peak.queued,
  peakRssMB: peak.rss,
  peakHeapMB: peak.heap,
  cap: samples.at(-1)?.max ?? null,
  tier: samples.at(-1)?.tier ?? null,
  wallMs: Date.now() - started,
}, null, 2));
process.exit(0);
