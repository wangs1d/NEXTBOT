import test from "node:test";
import assert from "node:assert/strict";

/**
 * 语音双工会话引擎选择回归（ASR pipeline 引擎下线后）：
 * 本地三段式 pipeline 会话（duplex-session.ts）已随 ASR 一起删除——VoiceDuplexService
 * 不再依赖 voiceDialogueService/providerName，createSession 只在注册的 realtime
 * 引擎里择优；所有引擎都不 isEnabled 时返回 null，attach() 据此回
 * error(实时语音引擎不可用) 并以 1013 / no_realtime_engine 关闭连接。
 * 不再有「打字+TTS 兜底」这条路。
 *
 * 覆盖：
 *   (a) 注册可用 realtime 引擎 → session.start 建 realtime 会话，
 *       session.ready.engineKind=realtime（含 minimaxRealtime 便捷入口与
 *       realtimeEngines 端口注册两条路，名称均原样透传）；
 *   (b) 无可用引擎（空注册 / isEnabled=false / MINIMAX_REALTIME_DUPLEX_DISABLED=1）
 *       → error 帧 + close 1013 / no_realtime_engine。
 *
 * 运行：node --import tsx --test test/voice-duplex-fallback.test.ts
 */

import {
  VoiceDuplexService,
  type DuplexSocketLike,
} from "../src/services/voice-duplex/voice-duplex-service.js";
import type { DuplexServerMessage } from "../src/services/voice-duplex/protocol.js";

/** 假 MiniMaxRealtimeService：isEnabled 可控，其余任意方法调用记录到 calls（Proxy 兜底）。 */
function fakeRealtime(enabled: boolean, calls: string[]) {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "isEnabled")
          return () => {
            calls.push("service.isEnabled");
            return enabled;
          };
        if (typeof prop === "symbol") return undefined;
        return (..._args: unknown[]) => {
          calls.push(String(prop));
          return undefined;
        };
      },
    },
  ) as unknown as ConstructorParameters<typeof VoiceDuplexService>[0]["minimaxRealtime"];
}

/** 假 realtime 引擎（RealtimeVoiceEngine 端口实现）：isEnabled 可控，descriptor.name 透传。 */
function fakeEngine(name: string, enabled: boolean) {
  return {
    descriptor: {
      name,
      inputSampleRate: 16000,
      outputSampleRate: 24000,
      inputChunkBytes: 3200,
      inputChunkDelayMs: 0,
      streamingTts: true,
    },
    isEnabled: () => enabled,
    openSession: () => ({
      alive: false,
      turn: async () => ({
        audio: Buffer.alloc(0),
        transcript: "",
        asrText: null,
        firstAudioMs: null,
        totalMs: 0,
      }),
      close: () => {},
    }),
  };
}

/**
 * 假 duplex WS socket：实现 DuplexSocketLike，记录出站帧与 close(code, reason)。
 * 通过 emit() 注入客户端帧，走 attach 注册的 message 回调。
 */
class FakeSocket implements DuplexSocketLike {
  sent: DuplexServerMessage[] = [];
  closeInfo: { code: number; reason: string } | null = null;

  private messageCbs: Array<(data: unknown) => void> = [];
  private closeCbs: Array<() => void> = [];
  private errorCbs: Array<(err: Error) => void> = [];

  send(data: string): void {
    this.sent.push(JSON.parse(data) as DuplexServerMessage);
  }
  close(code = 1000, reason = ""): void {
    this.closeInfo = { code, reason };
    for (const cb of this.closeCbs) cb();
  }
  on(event: "message", cb: (data: unknown) => void): void;
  on(event: "close", cb: () => void): void;
  on(event: "error", cb: (err: Error) => void): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, cb: (...args: any[]) => void): void {
    if (event === "message") this.messageCbs.push(cb as (data: unknown) => void);
    else if (event === "close") this.closeCbs.push(cb as () => void);
    else if (event === "error") this.errorCbs.push(cb as (err: Error) => void);
  }

  emit(msg: Record<string, unknown>): void {
    const raw = JSON.stringify(msg);
    for (const cb of this.messageCbs) cb(raw);
  }

  findByType<K extends DuplexServerMessage["type"]>(
    type: K,
  ): Extract<DuplexServerMessage, { type: K }> | undefined {
    return this.sent.find((m) => m.type === type) as
      | Extract<DuplexServerMessage, { type: K }>
      | undefined;
  }
}

// ────────────────────────────────────────────────────────────
// (a) 有可用 realtime 引擎 → 建 realtime 会话
// ────────────────────────────────────────────────────────────

test("(a) realtimeEngines 注册可用引擎：session.start 建 realtime 会话、ready.engineKind=realtime、名称透传", () => {
  const service = new VoiceDuplexService({
    realtimeEngines: [fakeEngine("local-realtime", true)],
  });
  const socket = new FakeSocket();
  service.attach(socket);
  socket.emit({ type: "session.start" });

  const ready = socket.findByType("session.ready");
  assert.ok(ready, "session.start 应触发 session.ready");
  assert.equal(ready.engineKind, "realtime");
  assert.equal(ready.engine, "local-realtime");
  assert.equal(socket.findByType("error"), undefined);
  assert.equal(socket.closeInfo, null, "会话建立成功时不应关闭");
  assert.equal(service.sessionCount, 1);
  service.stopAll();
});

test("(a') minimaxRealtime 便捷入口 + 未禁用：走 realtime 会话（engine=minimax-realtime）", () => {
  const prev = process.env.MINIMAX_REALTIME_DUPLEX_DISABLED;
  delete process.env.MINIMAX_REALTIME_DUPLEX_DISABLED;
  try {
    const calls: string[] = [];
    const service = new VoiceDuplexService({ minimaxRealtime: fakeRealtime(true, calls) });
    const socket = new FakeSocket();
    service.attach(socket);
    socket.emit({ type: "session.start" });

    const ready = socket.findByType("session.ready");
    assert.ok(ready);
    assert.equal(ready.engineKind, "realtime");
    assert.equal(ready.engine, "minimax-realtime");
    assert.ok(calls.includes("service.isEnabled"), "MiniMaxRealtimeEngine 应询问过 service.isEnabled");
    assert.equal(socket.closeInfo, null);
    assert.equal(service.sessionCount, 1);
    service.stopAll();
  } finally {
    if (prev !== undefined) process.env.MINIMAX_REALTIME_DUPLEX_DISABLED = prev;
  }
});

// ────────────────────────────────────────────────────────────
// (b) 无可用引擎 → error 帧 + close 1013 / no_realtime_engine
// ────────────────────────────────────────────────────────────

test("(b) 空注册：无 realtime 引擎 → error(实时语音引擎不可用) + close 1013/no_realtime_engine", () => {
  const service = new VoiceDuplexService({});
  const socket = new FakeSocket();
  service.attach(socket);
  socket.emit({ type: "session.start" });

  const err = socket.findByType("error");
  assert.ok(err, "无可用引擎时应回 error 帧");
  assert.match(err.message, /实时语音引擎不可用/);
  assert.equal(err.recoverable, false);
  assert.equal(socket.findByType("session.ready"), undefined, "无引擎时不应有 session.ready");
  assert.ok(socket.closeInfo);
  assert.equal(socket.closeInfo.code, 1013);
  assert.equal(socket.closeInfo.reason, "no_realtime_engine");
  assert.equal(service.sessionCount, 0);
});

test("(b') realtimeEngines 全部 isEnabled=false：同样回 error + close 1013（不再有本地 pipeline 兜底）", () => {
  const service = new VoiceDuplexService({
    realtimeEngines: [fakeEngine("local-realtime", false)],
  });
  const socket = new FakeSocket();
  service.attach(socket);
  socket.emit({ type: "session.start" });

  const err = socket.findByType("error");
  assert.ok(err);
  assert.match(err.message, /实时语音引擎不可用/);
  assert.equal(err.recoverable, false);
  assert.ok(socket.closeInfo);
  assert.equal(socket.closeInfo.code, 1013);
  assert.equal(socket.closeInfo.reason, "no_realtime_engine");
});

test("(b'') MINIMAX_REALTIME_DUPLEX_DISABLED=1：已配置 realtime 也被强制不可用 → error + close 1013", () => {
  const prev = process.env.MINIMAX_REALTIME_DUPLEX_DISABLED;
  process.env.MINIMAX_REALTIME_DUPLEX_DISABLED = "1";
  try {
    const calls: string[] = [];
    const service = new VoiceDuplexService({ minimaxRealtime: fakeRealtime(true, calls) });
    const socket = new FakeSocket();
    service.attach(socket);
    socket.emit({ type: "session.start" });

    const err = socket.findByType("error");
    assert.ok(err);
    assert.match(err.message, /实时语音引擎不可用/);
    assert.equal(err.recoverable, false);
    assert.equal(socket.findByType("session.ready"), undefined);
    assert.ok(socket.closeInfo);
    assert.equal(socket.closeInfo.code, 1013);
    assert.equal(socket.closeInfo.reason, "no_realtime_engine");
    // 杀开关命中即拒会话：MiniMaxRealtimeEngine 短路返回 false，从未询问 service.isEnabled
    assert.equal(calls.includes("service.isEnabled"), false);
  } finally {
    if (prev === undefined) delete process.env.MINIMAX_REALTIME_DUPLEX_DISABLED;
    else process.env.MINIMAX_REALTIME_DUPLEX_DISABLED = prev;
  }
});
