// 只读探针：验证生产 WS 身份裁决（自报邮箱应被拒，guest inst_ 应放行）。
import WebSocket from "ws";

const URL = process.env.WS_URL || "wss://api.nextbot.top/ws";

function probe(label, init) {
  return new Promise((resolve) => {
    const out = { label, messages: [], close: null, error: null };
    const ws = new WebSocket(URL);
    const timer = setTimeout(() => {
      out.error = out.error || "timeout";
      try { ws.close(); } catch {}
      finish();
    }, 9000);
    let done = false;
    function finish() {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      resolve(out);
    }
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "session.init", payload: init }));
    });
    ws.on("message", (raw) => {
      const t = raw.toString();
      out.messages.push(t.slice(0, 200));
      if (out.messages.length >= 2) finish();
    });
    ws.on("close", (code, reason) => {
      out.close = { code, reason: reason.toString().slice(0, 120) };
      finish();
    });
    ws.on("error", (e) => {
      out.error = String(e?.message || e);
      finish();
    });
  });
}

const cases = [
  ["自报账号邮箱无 token", { userId: "2378709729@qq.com", deviceId: "probe-claimed" }],
  ["设备 guest inst_", { userId: "inst_probe_identity_001", deviceId: "inst_probe_identity_001" }],
  ["占位值 session-mvp-001", { userId: "session-mvp-001", deviceId: "probe-placeholder" }],
];

for (const [label, init] of cases) {
  const r = await probe(label, init);
  console.log(`\n### ${label}`);
  console.log("  close:", JSON.stringify(r.close), "error:", r.error || "-");
  for (const m of r.messages) console.log("  msg:", m);
}
