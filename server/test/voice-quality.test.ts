/**
 * 叫醒语音质量门禁回归（2026-11-09）。
 *
 * 钉死三件事：
 *  1. 坏 mp3（错误 JSON / 全零占位 / 截断）绝不通过，24kHz 只降级告警不拒绝；
 *  2. 端侧本地模型「过响 + 发闷」的 WAV 经增强后，响度对齐云端且 3k+ 能量达标；
 *  3. 真实样本（data/tts_samples 存在时）云端 44.1kHz 合格、24kHz 旧音色被标记。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  enhancePcm,
  inspectMp3,
  inspectPcm,
  inspectWav,
  readWav,
  VOICE_QUALITY_GATE,
  type PcmAudio,
} from "../src/services/alarm-clock/voice-quality.js";

const G = VOICE_QUALITY_GATE;

function makeMp3(frameCount: number, sampleRate: 44100 | 24000 = 44100): Buffer {
  const mpeg2 = sampleRate === 24000;
  const frameLen = mpeg2 ? 192 : 417;
  const parts: Buffer[] = [Buffer.from("ID3\x03\x00\x00\x00\x00\x00\x00", "latin1")];
  let seed = 0x9e37_79b9;
  for (let f = 0; f < frameCount; f++) {
    const frame = Buffer.alloc(frameLen);
    frame[0] = 0xff;
    frame[1] = mpeg2 ? 0xf3 : 0xfb;
    frame[2] = mpeg2 ? 0x84 : 0x90;
    frame[3] = 0x00;
    for (let i = 4; i < frameLen; i++) {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      frame[i] = (seed >>> 16) & 0xff;
    }
    parts.push(frame);
  }
  return Buffer.concat(parts);
}

function makeWav(samples: Float64Array, sampleRate: number): Buffer {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    data.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  const head = Buffer.alloc(44);
  head.write("RIFF", 0, "latin1");
  head.writeUInt32LE(36 + data.length, 4);
  head.write("WAVEfmt ", 8, "latin1");
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(sampleRate, 24);
  head.writeUInt32LE(sampleRate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write("data", 36, "latin1");
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

/** 模拟本地 Piper 输出：22050Hz、音节间隙、起音脉冲、响度偏高（峰均比接近真实语音）。 */
function localLikeAudio(): PcmAudio {
  const sr = 22050;
  const n = sr * 4;
  const s = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const phase = t % 0.36;
    const voiced = phase < 0.28 ? 1 : 0; // 音节间静音，保证静音段底噪可测
    let v = voiced * (
      0.24 * Math.sin(2 * Math.PI * 180 * t) +
      0.10 * Math.sin(2 * Math.PI * 360 * t) +
      0.030 * Math.sin(2 * Math.PI * 4200 * t)
    );
    if (phase < 0.006 && t > 0.2 && t < 3.8) {
      // 音节起音脉冲：制造真实语音的峰值/峰均比，而不是稳态正弦
      v += 0.55 * Math.sin(Math.PI * phase / 0.006) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 3300 * t));
    }
    s[i] = t < 0.15 || t > 3.85 ? 0 : v; // 首尾真实静音，用于验证裁剪
  }
  let sq = 0;
  for (let i = 0; i < n; i++) sq += s[i] * s[i];
  const scale = 0.13 / Math.sqrt(sq / n); // 对齐本地模型实测 RMS
  for (let i = 0; i < n; i++) s[i] *= scale;
  return { samples: s, sampleRate: sr };
}

test("mp3：合格 44.1kHz 通过，24kHz 降级可用，全零/短流被拒", () => {
  const good = inspectMp3(makeMp3(120), 20);
  assert.equal(good.ok, true);
  assert.equal(good.degraded, false);
  assert.equal(good.score, 100);
  assert.equal(good.metrics.sampleRate, 44100);
  assert.ok(good.metrics.durationS > 2.4);

  const lowSr = inspectMp3(makeMp3(120, 24000), 20);
  assert.equal(lowSr.ok, true, "采样率偏低只告警，不能把音频整个丢掉");
  assert.equal(lowSr.degraded, true);
  assert.match(lowSr.warnings.join(" "), /采样率偏低/);

  const zeros = inspectMp3(Buffer.concat([
    Buffer.from("ID3\x03\x00\x00\x00\x00\x00\x00", "latin1"),
    Buffer.alloc(2048, 0),
  ]), 20);
  assert.equal(zeros.ok, false);
  assert.match(zeros.reasons.join(" "), /有效帧不足|全零/);

  assert.equal(inspectMp3(Buffer.alloc(64), 20).ok, false, "截断音频必须拒绝");
  assert.equal(inspectMp3(makeMp3(2), 20).ok, false, "帧数不足必须拒绝");
});

test("长文本简报不会被时长上限误杀", () => {
  const long = inspectMp3(makeMp3(1200), 300); // ≈31s
  assert.equal(long.ok, true, "300 字简报可以超过 30s 上限");
  assert.ok(long.metrics.maxDurationS > 30);
});

test("PCM：本地模型原始输出响度偏高，增强后响度对齐且门禁全过", () => {
  const raw = localLikeAudio();
  const before = inspectPcm(raw);
  assert.ok(before.metrics.rms > G.targetRms, "原始输出应比云端响");

  const enhanced = enhancePcm(raw);
  const after = inspectPcm(enhanced);
  assert.equal(after.ok, true, `增强后仍不合格: ${after.reasons.join("; ")}`);
  assert.ok(Math.abs(after.metrics.rms - G.targetRms) < 0.002, "响度必须对齐云端 -23dBFS");
  assert.ok(after.metrics.peak < G.maxPeak, "无削波");
  assert.ok(after.metrics.highBandRatio >= G.minHighBandRatio, "高频补偿后不再发闷");
  assert.ok(after.metrics.durationS < before.metrics.durationS, "首尾静音被裁掉");

  const wavVerdict = inspectWav(makeWav(enhanced.samples as Float64Array, enhanced.sampleRate));
  assert.equal(wavVerdict.ok, true);
  assert.equal(readWav(makeWav(enhanced.samples as Float64Array, enhanced.sampleRate))?.sampleRate, 22050);
});

test("PCM：空/非 PCM WAV 直接拒绝，不会让坏文件进入播放链路", () => {
  assert.equal(inspectWav(Buffer.alloc(100)).ok, false);
  assert.equal(inspectWav(makeWav(new Float64Array(0), 22050)).ok, false);
});

test("真实样本（存在时）：云端 44.1k 合格、24k 旧音色被标记、本地 WAV 增强后合格", () => {
  const dir = path.resolve(process.cwd(), "data/tts_samples");
  if (!fs.existsSync(dir)) return; // CI 无样本时跳过，不依赖外部资产
  const diana = path.join(dir, "diana_44k.mp3");
  if (fs.existsSync(diana)) {
    const v = inspectMp3(fs.readFileSync(diana), 20);
    assert.equal(v.ok, true, `diana 44.1k 必须合格: ${v.reasons.join("; ")}`);
    assert.equal(v.degraded, false);
  }
  const anna = path.join(dir, "current_anna_24k.mp3");
  if (fs.existsSync(anna)) {
    const v = inspectMp3(fs.readFileSync(anna), 20);
    assert.equal(v.degraded, true, "anna 24k 是音质事故对照，必须被标记");
  }
  const localWav = path.join(dir, "local_chaowen_dynamic.wav");
  if (fs.existsSync(localWav)) {
    const audio = readWav(fs.readFileSync(localWav));
    assert.ok(audio, "本地 WAV 应可读");
    const after = inspectPcm(enhancePcm(audio!));
    assert.equal(after.ok, true, `本地模型增强后必须合格: ${after.reasons.join("; ")}`);
  }
});
