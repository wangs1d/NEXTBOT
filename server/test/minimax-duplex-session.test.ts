import assert from "node:assert/strict";
import test from "node:test";

import { MiniMaxRealtimeService, type RealtimeSocketLike } from "../src/services/voice-dialogue/minimax-realtime-service.js";
import { MiniMaxRealtimeEngine } from "../src/services/voice-duplex/engines/minimax-realtime-engine.js";
import { RealtimeDuplexSession } from "../src/services/voice-duplex/realtime-duplex-session.js";
import type { DuplexServerMessage } from "../src/services/voice-duplex/protocol.js";

/** 可脚本驱动的假 realtime socket（记录出站帧、手动注入服务端事件）。 */
class FakeRealtimeSocket implements RealtimeSocketLike {
  sent: Array<Record<string, unknown>> = [];
  closed = false;
  onSendHook: ((msg: Record<string, unknown>) => void) | null = null;

  private openCbs: Array<() => void> = [];
  private messageCbs: Array<(data: string) => void> = [];
  private errorCbs: Array<(err: Error) => void> = [];
  private closeCbs: Array<(code: number, reason: string) => void> = [];

  send(data: string): void {
    const msg = JSON.parse(data) as Record<string, unknown>;
    this.sent.push(msg);
    this.onSendHook?.(msg);
  }
  close(): void {
    this.closed = true;
  }
  onOpen(cb: () => void): void {
    this.openCbs.push(cb);
  }
  onMessage(cb: (data: string) => void): void {
    this.messageCbs.push(cb);
  }
  onError(cb: (err: Error) => void): void {
    this.errorCbs.push(cb);
  }
  onClose(cb: (code: number, reason: string) => void): void {
    this.closeCbs.push(cb);
  }

  emitOpen(): void {
    this.openCbs.forEach((cb) => cb());
  }
  emitServer(evt: Record<string, unknown>): void {
    const raw = JSON.stringify(evt);
    this.messageCbs.forEach((cb) => cb(raw));
  }
  emitError(err: Error): void {
    this.errorCbs.forEach((cb) => cb(err));
  }
  emitClose(): void {
    this.closeCbs.forEach((cb) => cb(1006, ""));
  }
}

const ENV = { MINIMAX_API_KEY: "test-key" } as unknown as NodeJS.ProcessEnv;

/** 16kHz 16bit 正弦 PCM，100ms 一块（复用端点检测测试的造波形法）。 */
function makeChunk(rms: number, ms = 100): Buffer {
  const sampleRate = 16000;
  const samples = Math.floor((sampleRate * ms) / 1000);
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    buf.writeInt16LE(Math.round(rms * Math.sin((i / sampleRate) * 2 * Math.PI * 440)), i * 2);
  }
  return buf;
}

interface Harness {
  sockets: FakeRealtimeSocket[];
  messages: DuplexServerMessage[];
  session: RealtimeDuplexSession;
  /** 设置出站帧脚本：作用于当前及之后创建的每一条 fake socket。 */
  setScript: (fn: (socket: FakeRealtimeSocket, msg: Record<string, unknown>) => void) => void;
}

/** 标准成功脚本：response.create 后推 delta + 可选 ASR + done。 */
function okScript(opts?: { transcript?: string; asrText?: string }) {
  return (socket: FakeRealtimeSocket, msg: Record<string, unknown>) => {
    if (msg.type !== "response.create") return;
    queueMicrotask(() => {
      socket.emitServer({ type: "response.audio.delta", delta: Buffer.from([1, 2, 3, 4]).toString("base64") });
      socket.emitServer({ type: "response.audio.delta", delta: Buffer.from([5, 6]).toString("base64") });
      if (opts?.asrText) {
        socket.emitServer({ type: "conversation.item.input_audio_transcription.completed", transcript: opts.asrText });
      }
      socket.emitServer({ type: "response.audio_transcript.done", transcript: opts?.transcript ?? "好的，记下了。" });
      socket.emitServer({ type: "response.done", response: { status: "completed" } });
    });
  };
}

/** 搭一个会话；realtime socket 懒创建（首轮 turn 时才连），脚本经工厂挂载。 */
function makeSession(): Harness {
  const sockets: FakeRealtimeSocket[] = [];
  let script: ((socket: FakeRealtimeSocket, msg: Record<string, unknown>) => void) | null = null;
  const service = new MiniMaxRealtimeService(() => {
    const s = new FakeRealtimeSocket();
    s.onSendHook = (msg) => script?.(s, msg);
    sockets.push(s);
    // 模拟服务端握手：连上即推 session.created
    queueMicrotask(() => {
      s.emitOpen();
      s.emitServer({ type: "session.created", session: { id: "rt_1", model: "abab6.5s-chat" } });
    });
    return s;
  }, ENV);
  const messages: DuplexServerMessage[] = [];
  const session = new RealtimeDuplexSession("test_1", (m) => messages.push(m), {
    engine: new MiniMaxRealtimeEngine(service),
    systemPrompt: "口语化短回复。",
  });
  return { sockets, messages, session, setScript: (fn) => { script = fn; } };
}

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("until 超时");
    await new Promise((r) => setTimeout(r, 5));
  }
}

test("duplex-minimax：session.start 回执 engine=minimax-realtime 并进入 listening", async () => {
  const h = makeSession();
  await h.session.handle({ type: "session.start" } as never);
  const ready = h.messages.find((m) => m.type === "session.ready") as Extract<DuplexServerMessage, { type: "session.ready" }>;
  assert.equal(ready.engine, "minimax-realtime");
  assert.equal(ready.streamingAsr, false);
  assert.equal(ready.streamingTts, true);
  assert.equal(h.session.getState(), "listening");
  h.session.dispose();
});

test("duplex-minimax：text.turn 全链（thinking → speaking → 流式 tts.chunk pcm → turn.completed）", async () => {
  const h = makeSession();
  await h.session.handle({ type: "session.start" } as never);
  h.setScript(okScript({ transcript: "好的，已记下明天三点的会。" }));
  h.session.handle({ type: "text.turn", text: "帮我记一下明天三点开会" } as never);

  await until(() => h.messages.some((m) => m.type === "turn.completed"));

  const types = h.messages.map((m) => m.type);
  assert.ok(types.includes("state")); // thinking + speaking
  // 流式分块：okScript 推 2 段 audio.delta → 2 块 pcm（而非整轮单块 wav）
  const chunks = h.messages.filter((m) => m.type === "tts.chunk") as Array<
    Extract<DuplexServerMessage, { type: "tts.chunk" }>
  >;
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].format, "pcm");
  assert.equal(chunks[0].sampleRate, 24000);
  assert.equal(chunks[0].seq, 1);
  assert.equal(chunks[1].seq, 2);
  assert.equal(Buffer.from(chunks[0].audio, "base64").toString("hex"), "01020304");
  assert.equal(Buffer.from(chunks[1].audio, "base64").toString("hex"), "0506");
  // tts.start 必须在首个音频块之前
  const startIdx = h.messages.findIndex((m) => m.type === "tts.start");
  const firstChunkIdx = h.messages.findIndex((m) => m.type === "tts.chunk");
  assert.ok(startIdx >= 0 && startIdx < firstChunkIdx, "tts.start 应先于首个 tts.chunk");
  const done = h.messages.find((m) => m.type === "turn.completed") as Extract<DuplexServerMessage, { type: "turn.completed" }>;
  assert.equal(done.userText, "帮我记一下明天三点开会");
  assert.equal(done.assistantText, "好的，已记下明天三点的会。");
  assert.equal(h.session.getState(), "listening");
  // 文本输入走 conversation.item.create（带 status:completed）而非 append
  const itemCreate = h.sockets[0].sent.find((m) => m.type === "conversation.item.create") as Record<string, unknown>;
  const item = itemCreate.item as Record<string, unknown>;
  assert.equal(item.status, "completed");
  assert.equal(h.sockets[0].closed, false); // 连接保持给下一轮
  h.session.dispose();
});

test("duplex-minimax：流式——首块 tts.chunk 在 response.done 之前即下发（不等整轮）", async () => {
  const h = makeSession();
  await h.session.handle({ type: "session.start" } as never);
  h.setScript((socket, msg) => {
    if (msg.type !== "response.create") return;
    // 首段音频立刻到；整轮 done 延迟 80ms —— 验证下发不被 done 阻塞
    queueMicrotask(() => {
      socket.emitServer({ type: "response.audio.delta", delta: Buffer.from([9, 9]).toString("base64") });
    });
    setTimeout(() => {
      socket.emitServer({ type: "response.audio_transcript.done", transcript: "在的。" });
      socket.emitServer({ type: "response.done", response: { status: "completed" } });
    }, 80);
  });
  h.session.handle({ type: "text.turn", text: "在吗" } as never);

  await until(() => h.messages.some((m) => m.type === "tts.chunk"));
  assert.equal(h.messages.some((m) => m.type === "turn.completed"), false, "done 未到，回合不应结束");
  assert.equal(h.session.getState(), "speaking", "首块到达即进入 speaking");

  await until(() => h.messages.some((m) => m.type === "turn.completed"));
  h.session.dispose();
});

test("duplex-minimax：回合进行中收到新 text.turn 回错且不打断", async () => {
  const h = makeSession();
  await h.session.handle({ type: "session.start" } as never);
  h.setScript(okScript());
  h.session.handle({ type: "text.turn", text: "第一句" } as never);
  h.session.handle({ type: "text.turn", text: "第二句" } as never);
  const err = h.messages.find((m) => m.type === "error") as Extract<DuplexServerMessage, { type: "error" }>;
  assert.match(err.message, /生成中/);
  assert.equal(err.recoverable, true);
  await until(() => h.messages.some((m) => m.type === "turn.completed"));
  h.session.dispose();
});

test("duplex-minimax：audio.chunk 经端点检测自动成轮（含 ASR 文本回填）", async () => {
  const h = makeSession();
  await h.session.handle({ type: "session.start" } as never);
  h.setScript(okScript({ transcript: "已提醒。", asrText: "三点提醒我喝水" }));

  for (let i = 0; i < 4; i++) h.session.handle({ type: "audio.chunk", pcm: makeChunk(2000).toString("base64") } as never);
  // 700ms 静音触发端点
  for (let i = 0; i < 8 && h.session.getState() === "listening"; i++) {
    h.session.handle({ type: "audio.chunk", pcm: makeChunk(2).toString("base64") } as never);
  }
  await until(() => h.messages.some((m) => m.type === "turn.completed"));

  const asr = h.messages.find((m) => m.type === "asr.final") as Extract<DuplexServerMessage, { type: "asr.final" }>;
  assert.equal(asr.text, "三点提醒我喝水");
  const done = h.messages.find((m) => m.type === "turn.completed") as Extract<DuplexServerMessage, { type: "turn.completed" }>;
  assert.equal(done.userText, "三点提醒我喝水");
  // 音频输入走 append + commit
  const appends = h.sockets[0].sent.filter((m) => m.type === "input_audio_buffer.append");
  assert.ok(appends.length >= 3);
  assert.ok(h.sockets[0].sent.some((m) => m.type === "input_audio_buffer.commit"));
  h.session.dispose();
});

test("duplex-minimax：interrupt 后旧回合输出整体丢弃", async () => {
  const h = makeSession();
  await h.session.handle({ type: "session.start" } as never);
  h.setScript(okScript());
  h.session.handle({ type: "text.turn", text: "会被打断的一句话" } as never);
  h.session.handle({ type: "interrupt" } as never);
  // 在途回合的脚本事件会在微任务里跑完并结算，等一小段确保已发生
  await new Promise((r) => setTimeout(r, 120));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(h.messages.some((m) => m.type === "tts.chunk"), false);
  assert.equal(h.messages.some((m) => m.type === "turn.completed"), false);
  assert.equal(h.session.getState(), "listening");
  h.session.dispose();
});

test("duplex-minimax：realtime 出错回 error(recoverable)，下一回合自动重连", async () => {
  const h = makeSession();
  await h.session.handle({ type: "session.start" } as never);
  h.setScript((socket, msg) => {
    if (msg.type === "response.create") {
      queueMicrotask(() => socket.emitServer({ type: "error", error: { code: 1000, message: "boom" } }));
    }
  });
  h.session.handle({ type: "text.turn", text: "触发错误" } as never);
  await until(() => h.messages.some((m) => m.type === "error"));
  const err = h.messages.find((m) => m.type === "error") as Extract<DuplexServerMessage, { type: "error" }>;
  assert.match(err.message, /boom/);
  assert.equal(h.session.getState(), "listening");

  // 下一回合：换一条新连接，成功
  h.setScript(okScript());
  h.session.handle({ type: "text.turn", text: "再来一句" } as never);
  await until(() => h.messages.filter((m) => m.type === "turn.completed").length === 1);
  assert.ok(h.sockets.length >= 2); // 重连发生
  h.session.dispose();
});

test("duplex-minimax：sessionId=callId 注入通话上下文进 realtime instructions", async () => {
  const sockets: FakeRealtimeSocket[] = [];
  const service = new MiniMaxRealtimeService(() => {
    const s = new FakeRealtimeSocket();
    sockets.push(s);
    queueMicrotask(() => {
      s.emitOpen();
      s.emitServer({ type: "session.created", session: { id: "rt_1" } });
    });
    return s;
  }, ENV);
  const messages: DuplexServerMessage[] = [];
  const session = new RealtimeDuplexSession("test_1", (m) => messages.push(m), {
    engine: new MiniMaxRealtimeEngine(service),
    systemPrompt: "口语化短回复。",
    callVoiceContext: (callId) =>
      callId === "call-9" ? "你正与用户实时通话（提醒电话）。汇报内容：「明早八点的会改到九点」。" : null,
  });

  await session.handle({ type: "session.start", sessionId: "call-9" } as never);
  session.handle({ type: "text.turn", text: "几点开会？" } as never);
  await until(() => sockets.length > 0 && sockets[0].sent.some((m) => m.type === "session.update"));
  // 等 session.update 到了之后脚本接管回合
  session.dispose();
  const update = sockets[0].sent.find((m) => m.type === "session.update") as { session?: Record<string, unknown> };
  const instructions = String(update.session?.instructions ?? "");
  assert.ok(instructions.includes("口语化短回复"), "基础人设仍在");
  assert.ok(instructions.includes("明早八点的会改到九点"), "通话上下文已并入");
  assert.ok(instructions.includes("实时通话"));
});

test("duplex-minimax：session.stop 收会话（session.ended + 关闭 realtime 连接）", async () => {
  const h = makeSession();
  await h.session.handle({ type: "session.start" } as never);
  h.setScript(okScript());
  h.session.handle({ type: "text.turn", text: "先连上一轮" } as never);
  await until(() => h.messages.some((m) => m.type === "turn.completed"));
  await h.session.handle({ type: "session.stop" } as never);
  assert.equal(h.messages.some((m) => m.type === "session.ended"), true);
  assert.equal(h.session.getState(), "idle");
  assert.equal(h.sockets[0]?.closed, true);
});
