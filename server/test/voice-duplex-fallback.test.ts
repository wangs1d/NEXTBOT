import test from "node:test";
import assert from "node:assert/strict";

/**
 * 语音双工会话引擎选择回归（2026-09-28 上线前回退演练）：
 * /ws/voice-duplex 的云端强依赖是 MiniMax realtime——MINIMAX_REALTIME_DUPLEX_DISABLED=1
 * 必须能把"已配置 realtime"的服务强制切回本地 pipeline 引擎（ASR+LLM+TTS），
 * 云端语音挂掉时打字+TTS 链路仍活着。此前该分支零测试覆盖。
 *
 * 直接断言 createSession（private，测试经 as any 调用）的引擎选择结果，
 * 不依赖消息流细节。
 *
 * 运行：npx tsx --test test/voice-duplex-fallback.test.ts
 */

const { VoiceDuplexService } = await import(
  "../src/services/voice-duplex/voice-duplex-service.js"
);
const { DuplexVoiceSession } = await import("../src/services/voice-duplex/duplex-session.js");
const { RealtimeDuplexSession } = await import("../src/services/voice-duplex/realtime-duplex-session.js");

/** fake realtime：isEnabled 可控，其余任意方法调用记录到 calls（Proxy 兜底）。 */
function fakeRealtime(enabled: boolean, calls: string[]) {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "isEnabled") return () => enabled;
        if (typeof prop === "symbol") return undefined;
        return (..._args: unknown[]) => {
          calls.push(prop);
          return undefined;
        };
      },
    },
  ) as unknown as ConstructorParameters<typeof VoiceDuplexService>[0]["minimaxRealtime"];
}

function buildService(minimaxEnabled: boolean | null) {
  const calls: string[] = [];
  const deps = {
    voiceDialogueService: {
      getProvider: () => ({
        asr: {},
        tts: {},
        llm: { chat: async () => "hi" },
      }),
    },
    ...(minimaxEnabled === null ? {} : { minimaxRealtime: fakeRealtime(minimaxEnabled, calls) }),
  } as unknown as ConstructorParameters<typeof VoiceDuplexService>[0];
  const service = new VoiceDuplexService(deps);
  return { service, calls };
}

function pickEngine(service: VoiceDuplexService): string {
  const session = (service as unknown as {
    createSession: (sink: () => void) => { constructor: { name: string } };
  }).createSession(() => {});
  const name = session.constructor.name;
  (session as unknown as { dispose: () => void }).dispose?.();
  return name;
}

test("MINIMAX_REALTIME_DUPLEX_DISABLED=1：已配置 realtime 也强制回退 pipeline 引擎", () => {
  const prev = process.env.MINIMAX_REALTIME_DUPLEX_DISABLED;
  process.env.MINIMAX_REALTIME_DUPLEX_DISABLED = "1";
  try {
    const { service, calls } = buildService(true);
    assert.equal(pickEngine(service), DuplexVoiceSession.name);
    // 引擎选择了 pipeline，realtime 一次都不该被碰
    assert.deepEqual(calls, []);
  } finally {
    if (prev === undefined) delete process.env.MINIMAX_REALTIME_DUPLEX_DISABLED;
    else process.env.MINIMAX_REALTIME_DUPLEX_DISABLED = prev;
  }
});

test("未禁用：已配置 realtime 用端到端引擎", () => {
  const prev = process.env.MINIMAX_REALTIME_DUPLEX_DISABLED;
  delete process.env.MINIMAX_REALTIME_DUPLEX_DISABLED;
  try {
    const { service } = buildService(true);
    assert.equal(pickEngine(service), RealtimeDuplexSession.name);
  } finally {
    if (prev !== undefined) process.env.MINIMAX_REALTIME_DUPLEX_DISABLED = prev;
  }
});

test("未配置 realtime：直接走 pipeline 引擎", () => {
  const { service } = buildService(null);
  assert.equal(pickEngine(service), DuplexVoiceSession.name);
});

/**
 * 端口抽象的核心保证：任何实现 RealtimeVoiceEngine 的引擎（本地/其它云端）都能
 * 塞进 realtimeEngines 被选中，且其 descriptor.name 原样透传到会话与客户端回执，
 * 上层（本服务/协议/客户端）无需知道它是谁。
 */
test("端口注册：自定义引擎（realtimeEngines）被选中且名称透传", () => {
  const custom = {
    descriptor: {
      name: "local-realtime",
      inputSampleRate: 16000,
      outputSampleRate: 24000,
      inputChunkBytes: 3200,
      inputChunkDelayMs: 0,
      streamingTts: true,
    },
    isEnabled: () => true,
    openSession: () => ({
      alive: false,
      turn: async () => ({ audio: Buffer.alloc(0), transcript: "", asrText: null, firstAudioMs: null, totalMs: 0 }),
      close: () => {},
    }),
  };
  const service = new VoiceDuplexService({
    voiceDialogueService: { getProvider: () => ({ asr: {}, tts: {}, llm: { chat: async () => "hi" } }) },
    realtimeEngines: [custom],
  } as unknown as ConstructorParameters<typeof VoiceDuplexService>[0]);

  const session = (service as unknown as {
    createSession: (sink: () => void) => RealtimeDuplexSession;
  }).createSession(() => {});
  assert.equal(session.constructor.name, RealtimeDuplexSession.name);
  assert.equal(session.engine, "local-realtime");
  session.dispose();
});
