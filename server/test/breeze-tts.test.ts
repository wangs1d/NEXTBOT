import assert from "node:assert/strict";
import test from "node:test";

import { TtsService } from "../src/services/tts-service.js";

type FetchCall = { url: string; init: RequestInit };

/** 构造能被音质门禁接受的假 MP3：128kbps/44.1kHz Layer III，帧负载有变化。 */
function fakeMp3(frames = 60): Buffer {
  const frameLen = Math.floor((144 * 128_000) / 44_100); // 417B
  const chunks: Buffer[] = [];
  for (let i = 0; i < frames; i += 1) {
    const frame = Buffer.alloc(frameLen);
    frame[0] = 0xff;
    frame[1] = 0xfb; // MPEG1 Layer III, no CRC
    frame[2] = 0x90; // 128kbps, 44.1kHz
    frame[3] = 0xc4;
    for (let j = 4; j < frameLen; j += 1) frame[j] = (i * 31 + j * 7) % 251;
    chunks.push(frame);
  }
  return Buffer.concat(chunks);
}

async function withEnvAndFetch<T>(
  env: Record<string, string>,
  stub: (call: FetchCall) => Response | Promise<Response>,
  fn: () => Promise<T>,
): Promise<{ result: T; calls: FetchCall[] }> {
  const keys = [
    ...Object.keys(env),
    "BREEZE_API_KEY",
    "BREEZE_TTS_ENABLED",
    "BREEZE_TTS_BASE_URL",
    "BREEZE_TTS_VOICE",
    "BREEZE_TTS_MODEL",
    "BREEZE_TTS_OUTPUT_FORMAT",
    "BREEZE_TTS_LANGUAGE",
    "MINIMAX_API_KEY",
    "SILICONFLOW_API_KEY",
    "OPENAI_API_KEY",
    "OPENAI_TTS_API_KEY",
  ];
  const saved = new Map(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  Object.assign(process.env, env);

  const calls: FetchCall[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const call: FetchCall = { url: String(url), init: init ?? {} };
    calls.push(call);
    return await stub(call);
  }) as typeof fetch;
  try {
    return { result: await fn(), calls };
  } finally {
    globalThis.fetch = originalFetch;
    for (const k of keys) {
      const v = saved.get(k);
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const BASE_ENV = {
  BREEZE_API_KEY: "brz_test_key",
  BREEZE_TTS_VOICE: "voc_testvoice",
  BREEZE_TTS_MODEL: "breeze-tts-2",
} as Record<string, string>;

test("Breeze TTS：作为首选 provider 发起正确请求并返回 mp3", async () => {
  const audio = fakeMp3();
  const tts = new TtsService();
  const { result, calls } = await withEnvAndFetch(
    BASE_ENV,
    () => new Response(audio, { status: 200, headers: { "content-type": "audio/mpeg" } }),
    async () => {
      assert.equal(tts.getProvider(), "breeze");
      assert.equal(tts.isEnabled(), true);
      return await tts.synthesizeMp3Buffer("你好，NEXTBOT。");
    },
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.provider, "breeze");
  assert.equal(result.buffer.length, audio.length);
  assert.ok(result.quality && result.quality.score > 0);

  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    "https://api.breeze.blue/v1/text-to-speech/voc_testvoice?output_format=mp3_44100_128",
  );
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers["xi-api-key"], "brz_test_key");
  assert.equal(headers["Content-Type"], "application/json");
  const body = JSON.parse(String(calls[0].init.body));
  assert.equal(body.text, "你好，NEXTBOT。");
  assert.equal(body.model_id, "breeze-tts-2");
  assert.equal("language_code" in body, false); // 未配置时不传，让模型自动判定
});

test("Breeze TTS：BREEZE_TTS_ENABLED=0 时不发请求", async () => {
  const tts = new TtsService();
  const { result, calls } = await withEnvAndFetch(
    { ...BASE_ENV, BREEZE_TTS_ENABLED: "0" },
    () => new Response(fakeMp3(), { status: 200, headers: { "content-type": "audio/mpeg" } }),
    async () => {
      assert.notEqual(tts.getProvider(), "breeze");
      return await tts.synthesizeMp3Buffer("测试");
    },
  );

  assert.equal(result.ok, false);
  assert.equal(calls.length, 0);
});

test("Breeze TTS：非音频响应被判错而不是当成功", async () => {
  const tts = new TtsService();
  const { result, calls } = await withEnvAndFetch(
    BASE_ENV,
    () => new Response(JSON.stringify({ ok: false, detail: "quota exceeded" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    () => tts.synthesizeMp3Buffer("测试"),
  );

  assert.equal(calls.length, 1);
  assert.equal(result.ok, false);
});
