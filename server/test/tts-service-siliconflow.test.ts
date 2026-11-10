/**
 * TtsService 的 provider 链契约回归（2026-11-09）。
 *
 * 背景：server/.env 早就配好 SILICONFLOW_API_KEY / SILICONFLOW_TTS_MODEL，注释还
 * 写着「优先于 OpenAI TTS」，但旧实现只接了 MiniMax + OpenAI —— MiniMax 欠费、
 * OpenAI 回退又指向 DeepSeek LLM 网关（/audio/speech 404），结果整条语音链没有
 * 任何可用出口，语音叫醒到点只有系统铃。这里把「硅基流动作为中文首选出口」
 * 和「非音频响应必须判错」钉死，避免再退化成静音。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { TtsService } from "../src/services/tts-service.js";

const ENV_KEYS = [
  "MINIMAX_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_TTS_API_KEY",
  "OPENAI_TTS_BASE_URL",
  "SILICONFLOW_API_KEY",
  "SILICONFLOW_TTS_MODEL",
  "SILICONFLOW_TTS_VOICE",
  "SILICONFLOW_TTS_BASE_URL",
  "SILICONFLOW_TTS_SAMPLE_RATE",
  "SILICONFLOW_TTS_GAIN",
] as const;

/** 隔离 env + fetch；每个用例用新实例，避开 resolveClients 的指纹缓存。 */
function withIsolatedEnv<T>(fn: () => Promise<T>): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const k of ENV_KEYS) saved.set(k, process.env[k]);
  const savedFetch = globalThis.fetch;
  for (const k of ENV_KEYS) delete process.env[k];
  return fn().finally(() => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    globalThis.fetch = savedFetch;
  });
}

/**
 * 生成结构合法的 MPEG1 Layer3 44.1kHz/128kbps mp3 帧序列（非静音负载）。
 * 音质门禁会真解析帧头/时长/负载，旧的「ID3 + 160 个 0 字节」现在必须判为坏音频。
 */
function fakeMp3(frameCount = 60, sampleRate: 44100 | 24000 = 44100): Buffer {
  const mpeg2 = sampleRate === 24000;
  const frameLen = mpeg2 ? 192 : 417;
  const head = Buffer.from("ID3\x03\x00\x00\x00\x00\x00\x00", "latin1");
  const frames: Buffer[] = [head];
  let seed = 0x1234_5678;
  for (let f = 0; f < frameCount; f++) {
    const frame = Buffer.alloc(frameLen);
    frame[0] = 0xff;
    frame[1] = mpeg2 ? 0xf3 : 0xfb; // MPEG2 / MPEG1, Layer III, no CRC
    frame[2] = mpeg2 ? 0x84 : 0x90; // 64kbps@24k / 128kbps@44.1k
    frame[3] = 0x00;
    for (let i = 4; i < frameLen; i++) {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      frame[i] = (seed >>> 16) & 0xff;
    }
    frames.push(frame);
  }
  return Buffer.concat(frames);
}

/** 坏音频：ID3 头 + 全零负载（模拟网关把错误 JSON / 静音占位写进 mp3） */
function brokenMp3(): Buffer {
  return Buffer.concat([Buffer.from("ID3\x03\x00\x00\x00\x00\x00\x00", "latin1"), Buffer.alloc(2048, 0)]);
}

function configureSiliconFlow(): void {
  process.env.SILICONFLOW_API_KEY = "sk-test-siliconflow";
  process.env.SILICONFLOW_TTS_MODEL = "FunAudioLLM/CosyVoice2-0.5B";
  process.env.SILICONFLOW_TTS_BASE_URL = "https://tts.test.local/v1";
}

test("默认音质口径：diana 音色 + 44.1kHz mp3（anna 电平过低/底噪高会发沙）", async () => {
  await withIsolatedEnv(async () => {
    configureSiliconFlow();
    let seen: Record<string, unknown> = {};
    let seenUrl = "";
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      seenUrl = String(url);
      seen = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return new Response(fakeMp3(), {
        status: 200,
        headers: { "Content-Type": "audio/mpeg" },
      });
    }) as typeof fetch;

    const svc = new TtsService();
    assert.equal(svc.isEnabled(), true, "硅基流动应点亮 TTS 能力");
    assert.equal(svc.getProvider(), "siliconflow");

    const result = await svc.synthesizeMp3Base64("早上好，该起床啦");
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.provider, "siliconflow");
    assert.equal(result.format, "mp3");
    assert.ok(result.base64.length > 100);
    assert.equal(Buffer.from(result.base64, "base64").subarray(0, 3).toString(), "ID3");

    assert.match(seenUrl, /\/v1\/audio\/speech$/);
    assert.equal(seen.model, "FunAudioLLM/CosyVoice2-0.5B");
    assert.equal(seen.input, "早上好，该起床啦");
    assert.equal(seen.response_format, "mp3");
    // 短名 voice 必须按当前模型补成 "<model>:<speaker>"；默认 diana 电平健康
    assert.equal(seen.voice, "FunAudioLLM/CosyVoice2-0.5B:diana");
    // 默认 24kHz 偏闷；mp3 端点只接受 32000/44100
    assert.equal(seen.sample_rate, 44100);
    assert.equal("gain" in seen, false, "默认不额外推增益（避免放大底噪/削波）");
  });
});

test("音质旋钮可按 env 覆盖：voice / sample_rate / gain 都进请求体", async () => {
  await withIsolatedEnv(async () => {
    configureSiliconFlow();
    process.env.SILICONFLOW_TTS_VOICE = "claire";
    process.env.SILICONFLOW_TTS_SAMPLE_RATE = "32000";
    process.env.SILICONFLOW_TTS_GAIN = "6";
    let seen: Record<string, unknown> = {};
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      seen = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return new Response(fakeMp3(), {
        status: 200,
        headers: { "Content-Type": "audio/mpeg" },
      });
    }) as typeof fetch;

    const result = await new TtsService().synthesizeMp3Base64("早上好");
    assert.equal(result.ok, true);
    assert.equal(seen.voice, "FunAudioLLM/CosyVoice2-0.5B:claire");
    assert.equal(seen.sample_rate, 32000);
    assert.equal(seen.gain, 6);
  });
});

test("硅基流动返回 JSON 错误：必须判错，绝不把错误文本当音频缓存", async () => {
  await withIsolatedEnv(async () => {
    configureSiliconFlow();
    globalThis.fetch = (async () =>
      new Response('{"code":1008,"message":"insufficient balance"}', {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;

    const svc = new TtsService();
    const result = await svc.synthesizeMp3Base64("早上好");
    assert.equal(result.ok, false, "非音频响应不能算合成成功");
    if (result.ok) return;
    assert.match(result.reason, /未配置任何可用 TTS 服务|OpenAI TTS 错误/);
  });
});

test("音质门禁：44.1kHz 合格音频带 quality 报告，24kHz 只降级告警不拒绝", async () => {
  await withIsolatedEnv(async () => {
    configureSiliconFlow();
    globalThis.fetch = (async () =>
      new Response(fakeMp3(), {
        status: 200,
        headers: { "Content-Type": "audio/mpeg" },
      })) as typeof fetch;
    const good = await new TtsService().synthesizeMp3Base64("早上好，该起床啦");
    assert.equal(good.ok, true);
    if (!good.ok) return;
    assert.equal(good.quality?.degraded, false);
    assert.equal(good.quality?.score, 100);
    assert.equal(good.quality?.metrics.sampleRate, 44100);

    globalThis.fetch = (async () =>
      new Response(fakeMp3(60, 24000), {
        status: 200,
        headers: { "Content-Type": "audio/mpeg" },
      })) as typeof fetch;
    const lowSr = await new TtsService().synthesizeMp3Base64("早上好，该起床啦");
    assert.equal(lowSr.ok, true, "24kHz 不是坏音频，丢掉会让叫醒彻底没声音");
    if (!lowSr.ok) return;
    assert.equal(lowSr.quality?.degraded, true);
    assert.match(lowSr.quality?.warnings.join(" ") ?? "", /采样率偏低/);
  });
});

test("音质门禁：全零占位/截断音频必须拒绝，绝不作为成功结果缓存", async () => {
  await withIsolatedEnv(async () => {
    configureSiliconFlow();
    globalThis.fetch = (async () =>
      new Response(brokenMp3(), {
        status: 200,
        headers: { "Content-Type": "audio/mpeg" },
      })) as typeof fetch;
    const result = await new TtsService().synthesizeMp3Base64("早上好，该起床啦");
    assert.equal(result.ok, false, "坏音频不能当成 mp3 落盘（到点会播一片静音）");
  });
});

test("未配置硅基流动：保持旧口径，能力为 none 且如实报未配置", async () => {
  await withIsolatedEnv(async () => {
    const svc = new TtsService();
    assert.equal(svc.isEnabled(), false);
    assert.equal(svc.getProvider(), "none");
    const result = await svc.synthesizeMp3Base64("早上好");
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.reason, /未配置任何可用 TTS 服务/);
  });
});
