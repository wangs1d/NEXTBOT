/**
 * 声纹闸真链探针：隔离实例上打真实 WS 帧，验证 /ws/voice-duplex 的
 * 「已注册声纹身份未验证 → 拒绝对话；speaker.verify 有效令牌 → 放行；
 * 坏令牌 → 拒；未注册声纹身份 → 不设闸（电话路径向后兼容）」。
 *
 * 用法（server 目录下）：npx tsx scripts/probe-voiceprint-gate.ts
 */
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import WebSocket from "ws";

const tmp = mkdtempSync(join(tmpdir(), "pai-vp-gate-"));
const PORT = 3992;
const env: NodeJS.ProcessEnv = {
  ...process.env,
  PORT: String(PORT),
  ACCESS_AUTH_REQUIRED: "0",
  AGENT_AGENTIC_MEMORY_DIR: join(tmp, "mem"),
  AGENT_AGENTIC_MEMORY_DB: join(tmp, "mem", "agentic-memory.db"),
  VOICEPRINT_DB_PATH: join(tmp, "voiceprint.db"),
  SCHEDULE_TASKS_FILE: join(tmp, "tasks.json"),
  BETA_WHITELIST_FILE: join(tmp, "beta-wl.json"),
  BETA_WAITLIST_FILE: join(tmp, "beta-wait.json"),
};
const child = spawn("node", ["../node_modules/tsx/dist/cli.mjs", "src/index.ts"], {
  cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"],
});
const log: string[] = [];
child.stdout.on("data", (d) => log.push(d.toString()));
child.stderr.on("data", (d) => log.push(d.toString()));

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const b64 = (p: string) => readFileSync(p).toString("base64");
const CASE = "data/voiceprint_test_audio";
const ACTOR = "probe-vp-gate";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  PASS ${name}${detail ? "  " + detail : ""}`); }
  else { fail++; console.error(`  FAIL ${name}${detail ? "  " + detail : ""}`); }
};

type Wire = {
  ws: WebSocket;
  next: (pred: (m: any) => boolean, timeoutMs?: number) => Promise<any>;
  send: (o: unknown) => void;
  closed: Promise<{ code: number }>;
};
function connect(): Promise<Wire> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/voice-duplex`);
    const queue: any[] = [];
    const waiters: Array<{ pred: (m: any) => boolean; resolve: (m: any) => void; timer: NodeJS.Timeout }> = [];
    const closed = new Promise<{ code: number }>((res) => {
      ws.on("close", (code) => res({ code }));
    });
    ws.on("message", (raw) => {
      try {
        const m = JSON.parse(raw.toString());
        const idx = waiters.findIndex((w) => w.pred(m));
        if (idx >= 0) {
          const w = waiters.splice(idx, 1)[0]!;
          clearTimeout(w.timer);
          w.resolve(m);
        } else {
          queue.push(m);
        }
      } catch { /* 非 JSON */ }
    });
    ws.on("error", reject);
    ws.on("open", () => resolve({
      ws,
      send: (o) => ws.send(JSON.stringify(o)),
      next: (pred, timeoutMs = 20000) => new Promise((res2, rej2) => {
        const qi = queue.findIndex(pred);
        if (qi >= 0) { res2(queue.splice(qi, 1)[0]!); return; }
        const timer = setTimeout(() => rej2(new Error("wait frame timeout")), timeoutMs);
        waiters.push({ pred, resolve: (m) => res2(m), timer });
      }),
      closed,
    }));
  });
}

async function main() {
  for (let i = 0; i < 60; i++) {
    await wait(1000);
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/client/manifest`);
      if (r.ok) break;
    } catch { /* not ready */ }
    if (i === 59) throw new Error("server not ready");
  }
  console.log("[gate-probe] server ready");

  // 前置：注册声纹拿有效令牌
  const reg = await (await fetch(`http://127.0.0.1:${PORT}/api/voice/voiceprint/register`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ actorId: ACTOR, samples: [b64(`${CASE}/case_0.wav`), b64(`${CASE}/case_1.wav`)] }),
  })).json();
  if (!reg.ok) throw new Error("register failed: " + reg.error);
  const verify = await (await fetch(`http://127.0.0.1:${PORT}/api/voice/voiceprint/verify`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ actorId: ACTOR, audioBase64: b64(`${CASE}/case_2.wav`) }),
  })).json();
  if (!verify.ok || !verify.match || !verify.speakerToken) throw new Error("verify failed: " + JSON.stringify(verify));
  const goodToken: string = verify.speakerToken;
  console.log("[gate-probe] voiceprint ready, token issued");

  // 1) 已注册声纹 + 未验证 → text.turn 拒绝并断链
  {
    const w = await connect();
    w.send({ type: "session.start", actorId: ACTOR });
    await w.next((m) => m.type === "session.ready" || m.type === "error");
    w.send({ type: "text.turn", text: "你好" });
    const err = await w.next((m) => m.type === "error", 15000);
    check("未验证身份 text.turn 被拒", /声纹/.test(String(err.message)), err.message);
    const closed = await Promise.race([w.closed, wait(5000).then(() => null)]);
    check("连接被服务端关闭(4003)", closed !== null && closed.code === 4003, `code=${closed?.code}`);
    w.ws.terminate();
  }

  // 2) speaker.verify 好令牌 → 放行对话（text.turn 有响应）
  {
    const w = await connect();
    w.send({ type: "session.start", actorId: ACTOR });
    await w.next((m) => m.type === "session.ready" || m.type === "error");
    w.send({ type: "speaker.verify", token: goodToken });
    w.send({ type: "text.turn", text: "用一句话回复：测试通过" });
    const turn = await w.next((m) => m.type === "turn.completed" || m.type === "state" || m.type === "error", 45000);
    check("有效令牌放行对话", turn.type !== "error", `first frame=${turn.type}`);
    w.ws.terminate();
  }

  // 3) speaker.verify 坏令牌 → 拒并断链
  {
    const w = await connect();
    w.send({ type: "session.start", actorId: ACTOR });
    await w.next((m) => m.type === "session.ready" || m.type === "error");
    w.send({ type: "speaker.verify", token: "spk-deadbeef" });
    const err = await w.next((m) => m.type === "error", 15000);
    check("坏令牌被拒", /令牌无效/.test(String(err.message)), err.message);
    w.ws.terminate();
  }

  // 4) 未注册声纹身份（电话路径形态）→ 不设闸，text.turn 正常受理
  {
    const w = await connect();
    w.send({ type: "session.start", actorId: "no-voiceprint-user" });
    await w.next((m) => m.type === "session.ready" || m.type === "error");
    w.send({ type: "text.turn", text: "回复：ok" });
    const turn = await Promise.race([
      w.next((m) => m.type === "turn.completed" || m.type === "state" || m.type === "delta", 45000),
      w.next((m) => m.type === "error", 45000),
    ]);
    check("未注册声纹身份不设闸", turn.type !== "error", `first frame=${turn.type}`);
    w.ws.terminate();
  }

  console.log(`\n[gate-probe] 结果: ${pass} pass / ${fail} fail`);
  process.exitCode = fail > 0 ? 1 : 0;
}

main().catch((e) => {
  console.error("[gate-probe] 异常:", e.message);
  console.error(log.slice(-20).join(""));
  process.exitCode = 1;
}).finally(() => {
  child.kill();
});
