/**
 * 真机探针：常驻实例 /ws/voice-duplex MiniMax realtime 引擎双腿验证。
 *
 * 用法（server 目录下）：
 *   node --import tsx test/tmp-probe/probe-duplex-minimax.ts
 *
 * 腿 1（text.turn）：文本进 → 引擎回整轮 wav 语音 + 转录（纯语音模式主路径）。
 * 腿 2（audio.chunk）：TTS 合成一句提问作"用户开口"，16kHz PCM 喂入，
 *        端点检测自动成轮 → 回 wav。产物落 test/tmp-probe/out/。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import WebSocket from "ws";

import "../../src/config/load-server-env.js";
import { MiniMaxTTSAdapter } from "../../src/services/voice-dialogue/adapters/minimax-tts-adapter.js";
import { pcmToWav } from "../../src/services/voice-duplex/endpoint-detector.js";

const PORT = process.env.PORT?.trim() || "3000";
// 每次探针用独立 sessionId：上轮残留通话不会触发忙线门禁
const probeId = `probe-rt-${Date.now().toString(36)}`;
const URL = `ws://127.0.0.1:${PORT}/ws/voice-duplex`;
const t0 = Date.now();
const log = (m: string): void => console.log(`[+${Date.now() - t0}ms]`, m);

async function until(cond: () => boolean, ms: number, what: string): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error(`等待 ${what} 超时`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function main(): Promise<void> {
  const outDir = join(import.meta.dirname, "out");
  mkdirSync(outDir, { recursive: true });

  const ws = new WebSocket(URL);
  const messages: Array<Record<string, unknown>> = [];
  ws.on("message", (data) => {
    try {
      const m = JSON.parse(data.toString()) as Record<string, unknown>;
      m.__at = Date.now() - t0; // 到达时间戳（相对探针起点），用于量首块延迟
      messages.push(m);
    } catch {
      // ignore
    }
  });
  await new Promise<void>((resolve, reject) => {
    ws.on("open", () => resolve());
    ws.on("error", (err) => reject(err));
  });
  log(`connected ${URL}`);
  const send = (m: Record<string, unknown>): void => ws.send(JSON.stringify(m));
  const last = (type: string): Record<string, unknown> | undefined => [...messages].reverse().find((m) => m.type === type);

  // 腿 1：text.turn
  send({ type: "session.start" });
  await until(() => last("session.ready") != null, 10000, "session.ready");
  const ready = last("session.ready") as { engine?: string; engineKind?: string };
  log(`engine=${ready.engine ?? "(pipeline)"} kind=${ready.engineKind ?? "-"}`);
  if (ready.engineKind !== "realtime") {
    console.error("探针判定：FAIL（本次会话未走端到端实时引擎，检查引擎是否已配置或被 DISABLED 开关关闭）");
    process.exit(1);
  }

  let base = messages.length;
  const textSendAt = Date.now();
  send({ type: "text.turn", text: "用一两句话介绍一下你能帮我做什么" });
  await until(() => messages.slice(base).some((m) => m.type === "turn.completed"), 60000, "text.turn 完成");
  const textTurn = last("turn.completed") as { userText: string; assistantText: string };
  const chunks1 = messages.slice(base).filter((m) => m.type === "tts.chunk") as Array<{
    audio: string;
    sampleRate?: number;
    __at?: number;
  }>;
  const sr1 = chunks1[0]?.sampleRate ?? 24000;
  const audio1 = Buffer.concat(chunks1.map((c) => Buffer.from(c.audio, "base64")));
  if (audio1.length > 0) writeFileSync(join(outDir, "duplex-text-turn.wav"), pcmToWav(audio1, sr1));
  const done1 = messages.slice(base).find((m) => m.type === "turn.completed") as { __at?: number } | undefined;
  log(`腿1 text.turn：回复="${textTurn.assistantText}"`);
  log(`腿1 流式 ${chunks1.length} 块 / ${audio1.length}bytes（${(audio1.length / sr1 / 2).toFixed(2)}s）→ duplex-text-turn.wav`);
  log(
    `腿1 首块 tts.chunk @ ${chunks1[0]?.__at ?? -1}ms ←→ turn.completed @ ${done1?.__at ?? -1}ms` +
      `（差值 = 流式省掉的整轮等待）`,
  );

  // 腿 2：audio.chunk（合成提问 → 端点检测自动成轮）
  const question = "我现在提醒你，明天早上八点叫我起床。";
  const wav = await new MiniMaxTTSAdapter().synthesize(question, { sampleRate: 16000, format: "wav" });
  const pcm = wav.data.subarray(44);
  base = messages.length;
  const audioSendAt = Date.now();
  for (let i = 0; i < pcm.length; i += 3200) {
    send({ type: "audio.chunk", pcm: pcm.subarray(i, i + 3200).toString("base64") });
    await new Promise((r) => setTimeout(r, 30));
  }
  // 补 1s 静音：端点检测靠尾静音判句终（真人场景麦克风持续送环境音）
  for (let i = 0; i < 10; i++) {
    send({ type: "audio.chunk", pcm: Buffer.alloc(3200).toString("base64") });
    await new Promise((r) => setTimeout(r, 30));
  }
  await until(() => messages.slice(base).some((m) => m.type === "turn.completed"), 90000, "audio 轮完成");
  const audioTurn = last("turn.completed") as { userText: string; assistantText: string };
  const chunks2 = messages.slice(base).filter((m) => m.type === "tts.chunk") as Array<{
    audio: string;
    sampleRate?: number;
    __at?: number;
  }>;
  const sr2 = chunks2[0]?.sampleRate ?? 24000;
  const audio2 = Buffer.concat(chunks2.map((c) => Buffer.from(c.audio, "base64")));
  if (audio2.length > 0) writeFileSync(join(outDir, "duplex-audio-turn.wav"), pcmToWav(audio2, sr2));
  log(`腿2 audio：ASR听到的="${audioTurn.userText}" 回复="${audioTurn.assistantText}"`);
  log(
    `腿2 流式 ${chunks2.length} 块 / ${audio2.length}bytes（${(audio2.length / sr2 / 2).toFixed(2)}s）` +
      ` 首块 @ ${chunks2[0]?.__at ?? -1}ms（音频喂入起点 @ ${audioSendAt - t0}ms）→ duplex-audio-turn.wav`,
  );

  send({ type: "session.stop" });
  await until(() => last("session.ended") != null, 5000, "session.ended");
  ws.close();

  // 腿 3：电话实时语音——真实拨一通 user→agent 电话，duplex 带 callId 连接，
  // 验证通话上下文（"用户主动来电"人设）注入 realtime
  const claimRes = await fetch(`http://127.0.0.1:${PORT}/phone/me?sessionId=${probeId}`, { method: "POST" });
  const claimed = (await claimRes.json()) as { ok: boolean; virtualPhone?: string };
  log(`腿3 号码申领：${claimed.ok ? claimed.virtualPhone : JSON.stringify(claimed)}`);
  const dialRes = await fetch(`http://127.0.0.1:${PORT}/phone/call-my-agent`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: probeId, userMessage: "" }),
  });
  const dial = (await dialRes.json()) as { ok: boolean; callId?: string; error?: string };
  if (!dial.ok || !dial.callId) {
    console.error("腿3 拨号失败:", JSON.stringify(dial));
    process.exit(1);
  }
  log(`腿3 已拨通电话 callId=${dial.callId}（等 5s 振铃前摇）`);
  await new Promise((r) => setTimeout(r, 6000));

  ws.close();
  const ws2 = new WebSocket(URL);
  const messages2: Array<Record<string, unknown>> = [];
  ws2.on("message", (data) => {
    try {
      messages2.push(JSON.parse(data.toString()) as Record<string, unknown>);
    } catch {
      // ignore
    }
  });
  await new Promise<void>((resolve, reject) => {
    ws2.on("open", () => resolve());
    ws2.on("error", (err) => reject(err));
  });
  const send2 = (m: Record<string, unknown>): void => ws2.send(JSON.stringify(m));
  const last2 = (type: string): Record<string, unknown> | undefined =>
    [...messages2].reverse().find((m) => m.type === type);
  send2({ type: "session.start", sessionId: dial.callId });
  await until(() => last2("session.ready") != null, 10000, "腿3 session.ready");
  send2({ type: "text.turn", text: "我们现在是在打电话吗？谁打给谁？一句话回答。" });
  await until(() => last2("turn.completed") != null, 60000, "腿3 turn.completed");
  const turn3 = last2("turn.completed") as { userText: string; assistantText: string };
  log(`腿3 通话上下文应答："${turn3.assistantText}"`);
  const contextOk =
    turn3.assistantText.includes("电话") ||
    turn3.assistantText.includes("通话") ||
    turn3.assistantText.includes("来电") ||
    turn3.assistantText.includes("打给");
  send2({ type: "session.stop" });
  await until(() => last2("session.ended") != null, 5000, "腿3 session.ended");
  ws2.close();

  const pass =
    textTurn.assistantText.length > 0 &&
    audioTurn.assistantText.length > 0 &&
    audio1.length > 1000 &&
    audio2.length > 1000 &&
    contextOk;
  console.log(`\n探针判定：${pass ? "PASS" : "FAIL（contextOk=" + contextOk + "）"}`);
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error("探针异常:", e);
  process.exit(1);
});
