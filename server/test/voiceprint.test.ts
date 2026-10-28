/**
 * 声纹底座单测：WAV 解析 / 引擎确定性 / 存取回环 / 注册-验证-注销全链。
 *
 * 真实语音样本用 data/voiceprint_test_audio/case_*.wav（真人录音，同库样本视为
 * 同人正例）；白噪声/纯音为确定性负例（实测 cos 0.24/0.41 << 阈值）。
 * 模型资产缺失时引擎相关用例 skip。跑法：
 *   node --import tsx --test test/voiceprint.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseAudioToPcm16, cosineSimilarity } from "../src/services/voice/voiceprint-service.js";
import {
  initSpeakerEmbeddingEngine,
  resolveSpeakerModelDir,
  SPEAKER_EMBEDDING_DIMS,
} from "../src/services/voice/speaker-embedding-engine.js";
import { VoiceprintStore } from "../src/services/voice/voiceprint-store.js";
import { VoiceprintService } from "../src/services/voice/voiceprint-service.js";

function loadWavBuffer(path: string): Buffer {
  return readFileSync(path);
}

function synthPcm16(samples: number[], amp: (i: number) => number): Buffer {
  const buf = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(amp(i) * 32767))), i * 2);
  return buf;
}

const CASE_DIR = join(process.cwd(), "data", "voiceprint_test_audio");
const hasAssets = existsSync(join(CASE_DIR, "case_0.wav")) && existsSync(join(CASE_DIR, "case_1.wav"));
const hasModel = resolveSpeakerModelDir() !== null;

test("parseAudioToPcm16：WAV 头解析 + 裸 PCM16 兜底", () => {
  assert.ok(hasAssets, "缺声纹测试音频");
  const { pcm, sampleRate } = parseAudioToPcm16(loadWavBuffer(join(CASE_DIR, "case_0.wav")));
  assert.equal(sampleRate, 22050);
  assert.ok(pcm.length > 16000, "4.5s 音频应有数万样本");
  const raw = synthPcm16(new Array(1600).fill(0), () => 0.5);
  const rawParsed = parseAudioToPcm16(raw);
  assert.equal(rawParsed.sampleRate, 16000);
  assert.equal(rawParsed.pcm[0], 16384);
});

test("引擎：确定性 + 维度跟随模型（CAM++ 192）+ L2 归一", { skip: !hasModel && "模型资产缺失" }, async () => {
  const engine = await initSpeakerEmbeddingEngine();
  assert.ok(engine);
  const buf = loadWavBuffer(join(CASE_DIR, "case_0.wav"));
  const { pcm, sampleRate } = parseAudioToPcm16(buf);
  const a = await engine!.embedPcm16(pcm, sampleRate);
  const b = await engine!.embedPcm16(pcm, sampleRate);
  assert.equal(a.length, SPEAKER_EMBEDDING_DIMS);
  const norm = Math.sqrt(Array.from(a).reduce((s, v) => s + v * v, 0));
  assert.ok(Math.abs(norm - 1) < 1e-3, `模长应≈1，实际 ${norm}`);
  assert.ok(Math.abs(cosineSimilarity(a, b) - 1) < 1e-4, "同输入应得相同向量");
  // 过短音频应抛错
  await assert.rejects(() => engine!.embedPcm16(new Int16Array(1600), 16000));
});

test("存取：upsert/get/delete 回环（临时库）", () => {
  const dir = mkdtempSync(join(tmpdir(), "pai-vp-store-"));
  const store = new VoiceprintStore(join(dir, "vp.db"));
  const emb = new Float32Array(256).map((_, i) => Math.sin(i));
  store.upsert("user-a", emb, 3);
  const got = store.get("user-a");
  assert.ok(got);
  assert.equal(got!.dims, 256);
  assert.equal(got!.sampleCount, 3);
  assert.ok(Math.abs(cosineSimilarity(got!.embedding, emb) - 1) < 1e-5, "向量应无损回读");
  assert.equal(store.get("nobody"), null);
  assert.equal(store.delete("user-a"), true);
  assert.equal(store.delete("user-a"), false);
  store.close();
});

test("服务：注册→验证→令牌→注销 全链", { skip: (!hasModel || !hasAssets) && "模型/音频资产缺失" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pai-vp-svc-"));
  const service = new VoiceprintService(new VoiceprintStore(join(dir, "vp.db")));

  // 注册（真人同库两段）
  const reg = await service.register("user-a", [
    loadWavBuffer(join(CASE_DIR, "case_0.wav")),
    loadWavBuffer(join(CASE_DIR, "case_1.wav")),
  ]);
  assert.ok(reg.ok, `注册应成功: ${reg.ok ? "" : reg.error}`);
  assert.ok((reg as { usedSamples: number }).usedSamples >= 2);
  assert.equal(service.status("user-a").registered, true);

  // 验证：同库第三段（同人）→ 命中 + 令牌
  const genuine = await service.verify("user-a", loadWavBuffer(join(CASE_DIR, "case_2.wav")));
  assert.ok(genuine.ok && genuine.match, `同人应命中（score=${genuine.ok ? genuine.score : genuine.error}）`);
  const token = genuine.ok ? genuine.speakerToken : undefined;
  assert.ok(token, "命中应签发 speakerToken");
  assert.equal(service.consumeToken(token!, "user-a"), true);
  assert.equal(service.consumeToken(token!, "user-b"), false, "令牌不能跨用户消费");
  assert.equal(service.consumeToken(token!, "user-a"), false, "令牌应一次性消费");

  // 验证：白噪声 → 拒绝（确定性负例）
  const noise = synthPcm16(new Array(48000).fill(0), () => Math.random() * 2 - 1);
  const impostor = await service.verify("user-a", noise);
  assert.ok(impostor.ok);
  assert.equal(impostor.ok ? impostor.match : null, false, `噪声应被拒（score=${impostor.ok ? impostor.score : ""}）`);

  // 静音样本被跳过；纯静音注册失败
  const silence = synthPcm16(new Array(48000).fill(0), () => 0.0001);
  const badReg = await service.register("user-b", [silence, silence]);
  assert.equal(badReg.ok, false);

  // 未注册者验证报错；注销后状态翻回
  const noReg = await service.verify("user-b", loadWavBuffer(join(CASE_DIR, "case_0.wav")));
  assert.equal(noReg.ok, false);
  assert.equal(service.unregister("user-a"), true);
  assert.equal(service.status("user-a").registered, false);
});
