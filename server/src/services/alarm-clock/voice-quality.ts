/**
 * 叫醒语音质量门禁（2026-11-09）。
 *
 * 目标：任何进入闹钟的音频都必须是「可听清、不削波、不发闷、不静音」的，
 * 且坏音频绝不能被当成成功结果缓存进 voiceClips / 落盘到端侧——否则到点只会
 * 响系统铃或播一片静音，用户却以为 agent 会说话。
 *
 * 主检查线：云端 mp3 —— TTS 网关返回的字节流做帧结构检查
 * （采样率/码率/时长/负载有效性），因为服务端不解码 mp3，无法测波形；
 * 不合格就换下一个 provider，不允许落盘。
 * 另有 PCM 门禁（inspectPcm / enhancePcm）作为离线分析与回归工具，
 * `scripts/voice-quality.py` 与之同源；端侧 ONNX 语音模型已移除，
 * 端侧只保留落盘前的 mp3 帧结构门禁与播放前文件头校验。
 *
 * 实测基线（data/tts_samples/）：
 *   diana 44.1k  peak .716 rms .0703 3k+ .0189  → 云端合格基准
 *   anna  24k    peak .224 rms .0284            → 电平过低，推音量就「沙哑」
 */
import { Buffer } from "node:buffer";

export const VOICE_QUALITY_GATE = {
  // PCM 波形门槛
  minPeak: 0.20,
  maxPeak: 0.95,
  minRms: 0.030,
  maxRms: 0.140,
  maxClipRatio: 0.001,
  maxDcOffset: 0.02,
  maxNoiseFloor: 0.003,
  minActiveRatio: 0.30,
  maxActiveRatio: 0.95,
  minHighBandRatio: 0.008,
  minDurationS: 0.60,
  maxDurationS: 40.0,
  // 增强参数（端侧与离线工具同源）
  targetRms: 0.070, // 与云端 diana 的 -23dBFS 对齐
  targetPeak: 0.89,
  minGain: 0.25,
  maxGain: 4.0,
  shelfK: 0.60, // 高频补偿强度：实测把最差样本 3k+ 从 .0053 抬到 .0090
  shelfAlpha: 0.22,
  // mp3 结构门槛（无法解码时的替代判据）
  mp3MinBytes: 1024,
  mp3MinFrames: 8,
  mp3MinSampleRate: 32000, // 拒绝 24k/16k 电话音质（anna 事故）
  mp3MinBitrateKbps: 48,
  mp3MinDurationS: 0.5,
  mp3MaxDurationS: 30,
  mp3MinSecPerChar: 0.12, // 中文约 4 字/秒，这里留足余量只挡截断音频
  mp3MaxExpectedS: 8,
  mp3MinPayloadNonZero: 0.15,
  mp3MinDistinctBytes: 24,
  mp3MaxZeroFrameRatio: 0.4,
} as const;

export interface VoiceQualityVerdict {
  /** ok=false 表示致命缺陷，音频绝不能落盘；degraded 表示可用但音质低于基线（只告警）。 */
  ok: boolean;
  degraded: boolean;
  score: number;
  reasons: string[];
  warnings: string[];
  metrics: Record<string, number>;
}

const G = VOICE_QUALITY_GATE;

function verdict(
  metrics: Record<string, number>,
  reasons: string[],
  warnings: string[] = [],
): VoiceQualityVerdict {
  return {
    ok: reasons.length === 0,
    degraded: warnings.length > 0,
    score: Math.max(0, 100 - reasons.length * 15 - warnings.length * 5),
    reasons,
    warnings,
    metrics,
  };
}

// ─────────────────────────── MP3 帧结构 ───────────────────────────

const MPEG1_L3_BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const MPEG2_L3_BITRATES = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
const SAMPLE_RATES: Record<number, number[]> = {
  3: [44100, 48000, 32000], // MPEG1
  2: [22050, 24000, 16000], // MPEG2
  0: [11025, 12000, 8000], // MPEG2.5
};

interface Mp3Frame {
  next: number;
  sampleRate: number;
  bitrateKbps: number;
  samplesPerFrame: number;
}

function parseMp3Frame(buf: Buffer, at: number): Mp3Frame | null {
  if (at + 4 > buf.length) return null;
  const b1 = buf[at + 1];
  const b2 = buf[at + 2];
  const b3 = buf[at + 3];
  if (buf[at] !== 0xff || (b1 & 0xe0) !== 0xe0) return null;
  const versionBits = (b1 >> 3) & 0x03; // 3=MPEG1, 2=MPEG2, 0=MPEG2.5, 1=保留
  const layerBits = (b1 >> 1) & 0x03;
  if (versionBits === 1 || layerBits !== 1) return null; // 只接 Layer III
  const bitrateIndex = (b2 >> 4) & 0x0f;
  const sampleRateIndex = (b2 >> 2) & 0x03;
  if (bitrateIndex === 0 || bitrateIndex === 15 || sampleRateIndex === 3) return null;
  const rates = SAMPLE_RATES[versionBits];
  if (!rates) return null;
  const sampleRate = rates[sampleRateIndex];
  const bitrateKbps = versionBits === 3
    ? MPEG1_L3_BITRATES[bitrateIndex]
    : MPEG2_L3_BITRATES[bitrateIndex];
  const padding = (b2 >> 1) & 0x01;
  const frameLen = Math.floor(
    (versionBits === 3 ? 144 : 72) * bitrateKbps * 1000 / sampleRate,
  ) + padding;
  if (frameLen < 24 || at + frameLen > buf.length) return null;
  return {
    next: at + frameLen,
    sampleRate,
    bitrateKbps,
    samplesPerFrame: versionBits === 3 ? 1152 : 576,
  };
}

function id3End(buf: Buffer): number {
  if (buf.length < 10 || buf.subarray(0, 3).toString("latin1") !== "ID3") return 0;
  const size =
    ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) |
    ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
  const footer = (buf[5] & 0x10) !== 0 ? 10 : 0;
  return Math.min(buf.length, 10 + size + footer);
}

/**
 * 检查 mp3 是不是「一段真实、够长、采样率够高、非全零」的音频。
 * 不解码：帧头 + 帧负载统计足以挡住错误 JSON、截断流、静音占位、低采样率音源。
 */
export function inspectMp3(buf: Buffer, textLength = 0): VoiceQualityVerdict {
  const reasons: string[] = [];
  const warnings: string[] = [];
  if (!Buffer.isBuffer(buf) || buf.length < G.mp3MinBytes) {
    return verdict({ bytes: buf?.length ?? 0 }, [
      `mp3 过短 (${buf?.length ?? 0}B < ${G.mp3MinBytes}B)`,
    ]);
  }

  let at = id3End(buf);
  let frames = 0;
  let durationS = 0;
  let sampleRate = 0;
  let bitrateKbps = 0;
  let payloadBytes = 0;
  let nonZeroBytes = 0;
  let zeroFrames = 0;
  const distinct = new Set<number>();

  while (at + 4 <= buf.length) {
    const frame = parseMp3Frame(buf, at);
    if (frame) {
      frames += 1;
      durationS += frame.samplesPerFrame / frame.sampleRate;
      sampleRate = frame.sampleRate;
      bitrateKbps = frame.bitrateKbps;
      const payload = buf.subarray(at + 4, frame.next);
      let frameNonZero = 0;
      for (let i = 0; i < payload.length; i++) {
        const v = payload[i];
        if (v !== 0) frameNonZero += 1;
        if (distinct.size < 256) distinct.add(v);
      }
      payloadBytes += payload.length;
      nonZeroBytes += frameNonZero;
      if (frameNonZero === 0) zeroFrames += 1;
      at = frame.next;
    } else {
      // 允许少量垃圾字节（tag / 对齐），但连续错太多就不是 mp3
      at += 1;
    }
  }

  const nonZeroRatio = payloadBytes ? nonZeroBytes / payloadBytes : 0;
  const zeroFrameRatio = frames ? zeroFrames / frames : 1;
  const expectedS = textLength > 0
    ? Math.min(G.mp3MaxExpectedS, Math.max(G.mp3MinDurationS, textLength * G.mp3MinSecPerChar))
    : G.mp3MinDurationS;
  // 简报/语音消息可能很长，上限随文本长度放宽，避免把正常的长音频误判成异常
  const maxDurationS = Math.max(G.mp3MaxDurationS, textLength * 0.6);
  const metrics = {
    bytes: buf.length,
    frames,
    durationS: Number(durationS.toFixed(3)),
    sampleRate,
    bitrateKbps,
    nonZeroRatio: Number(nonZeroRatio.toFixed(4)),
    zeroFrameRatio: Number(zeroFrameRatio.toFixed(4)),
    distinctBytes: distinct.size,
    expectedS: Number(expectedS.toFixed(2)),
    maxDurationS: Number(maxDurationS.toFixed(2)),
  };

  if (frames < G.mp3MinFrames) reasons.push(`有效帧不足 (${frames} < ${G.mp3MinFrames})`);
  if (sampleRate > 0 && sampleRate < G.mp3MinSampleRate) {
    // 24kHz 不是坏音频，只是偏闷：网关若固定输出 24k，一律丢弃会让「叫醒没有声音」
    // 比「音质略差」更糟。降级可用 + 告警，由 TtsService 打日志暴露。
    warnings.push(`采样率偏低 (${sampleRate}Hz < ${G.mp3MinSampleRate}Hz)`);
  }
  if (bitrateKbps > 0 && bitrateKbps < G.mp3MinBitrateKbps) {
    reasons.push(`码率过低 (${bitrateKbps}kbps)`);
  }
  if (durationS < expectedS) reasons.push(`时长不足 (${durationS.toFixed(2)}s < ${expectedS.toFixed(2)}s)`);
  if (durationS > maxDurationS) reasons.push(`时长异常 (${durationS.toFixed(1)}s > ${maxDurationS.toFixed(1)}s)`);
  if (nonZeroRatio < G.mp3MinPayloadNonZero) {
    reasons.push(`帧负载近乎全零 (${nonZeroRatio.toFixed(3)})`);
  }
  if (distinct.size < G.mp3MinDistinctBytes) {
    reasons.push(`帧负载无有效变化 (distinct=${distinct.size})`);
  }
  if (zeroFrameRatio > G.mp3MaxZeroFrameRatio) {
    reasons.push(`静音帧过多 (${zeroFrameRatio.toFixed(2)})`);
  }
  return verdict(metrics, reasons, warnings);
}

// ─────────────────────────── WAV / PCM ───────────────────────────

export interface PcmAudio {
  samples: Float64Array;
  sampleRate: number;
}

export function readWav(buf: Buffer): PcmAudio | null {
  if (buf.length < 44 || buf.subarray(0, 4).toString("latin1") !== "RIFF") return null;
  if (buf.subarray(8, 12).toString("latin1") !== "WAVE") return null;
  if (buf.readUInt16LE(20) !== 1) return null; // 只接 PCM
  const channels = buf.readUInt16LE(22);
  const sampleRate = buf.readUInt32LE(24);
  const bits = buf.readUInt16LE(34);
  if (channels !== 1 || bits !== 16 || sampleRate < 8000) return null;
  let at = 12;
  while (at + 8 <= buf.length) {
    const id = buf.subarray(at, at + 4).toString("latin1");
    const size = buf.readUInt32LE(at + 4);
    if (id === "data") {
      const end = Math.min(buf.length, at + 8 + size);
      const count = Math.floor((end - (at + 8)) / 2);
      const samples = new Float64Array(count);
      for (let i = 0; i < count; i++) samples[i] = buf.readInt16LE(at + 8 + i * 2) / 32768;
      return { samples, sampleRate };
    }
    at += 8 + size + (size % 2);
  }
  return null;
}

/** radix-2 FFT（迭代原地），用于 3kHz 以上能量占比——与 Python 工具同一算法口径。 */
function fftMagnitudes(re: Float64Array, im: Float64Array): Float64Array {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k];
        const ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr;
        im[i + k + len / 2] = ui - vi;
        const nextR = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nextR;
      }
    }
  }
  const mag = new Float64Array(n / 2 + 1);
  for (let i = 0; i < mag.length; i++) mag[i] = re[i] * re[i] + im[i] * im[i];
  return mag;
}

export function inspectPcm(audio: PcmAudio): VoiceQualityVerdict {
  const { samples, sampleRate } = audio;
  const n = samples.length;
  const reasons: string[] = [];
  if (n === 0 || sampleRate <= 0) {
    return verdict({ durationS: 0 }, ["空音频"]);
  }
  const durationS = n / sampleRate;
  let peak = 0;
  let sumSq = 0;
  let sum = 0;
  let clipped = 0;
  for (let i = 0; i < n; i++) {
    const v = samples[i];
    const a = Math.abs(v);
    if (a > peak) peak = a;
    sumSq += v * v;
    sum += v;
    if (a >= 0.999) clipped += 1;
  }
  const rms = Math.sqrt(sumSq / n);
  const dc = sum / n;
  const win = Math.max(1, Math.floor(sampleRate * 0.02));
  const frameCount = Math.floor(n / win);
  const frameRms = new Float64Array(frameCount);
  for (let f = 0; f < frameCount; f++) {
    let s = 0;
    for (let i = f * win; i < (f + 1) * win; i++) s += samples[i] * samples[i];
    frameRms[f] = Math.sqrt(s / win);
  }
  const sorted = Array.from(frameRms).sort((a, b) => a - b);
  const noiseFloor = sorted.length ? sorted[Math.floor(sorted.length * 0.05)] : 0;
  const activeThreshold = Math.max(peak * 0.02, noiseFloor * 3, 1e-5);
  let active = 0;
  for (let f = 0; f < frameCount; f++) if (frameRms[f] > activeThreshold) active += 1;
  const activeRatio = frameCount ? active / frameCount : 0;

  // 频谱：最多取前 8 秒，补到 2 的幂，Hann 窗
  const use = Math.min(n, sampleRate * 8);
  let fftN = 1;
  while (fftN * 2 <= use) fftN *= 2;
  const re = new Float64Array(fftN);
  const im = new Float64Array(fftN);
  for (let i = 0; i < fftN; i++) {
    re[i] = samples[i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (fftN - 1)));
  }
  const mag = fftMagnitudes(re, im);
  let total = 0;
  let high = 0;
  let weighted = 0;
  for (let i = 0; i < mag.length; i++) {
    const hz = i * sampleRate / fftN;
    total += mag[i];
    weighted += mag[i] * hz;
    if (hz >= 3000) high += mag[i];
  }
  const highBandRatio = total > 0 ? high / total : 0;
  const centroidHz = total > 0 ? weighted / total : 0;
  const metrics = {
    durationS: Number(durationS.toFixed(3)),
    sampleRate,
    peak: Number(peak.toFixed(4)),
    rms: Number(rms.toFixed(4)),
    clipRatio: Number((clipped / n).toFixed(5)),
    dcOffset: Number(dc.toFixed(5)),
    noiseFloor: Number(noiseFloor.toFixed(5)),
    activeRatio: Number(activeRatio.toFixed(3)),
    highBandRatio: Number(highBandRatio.toFixed(5)),
    centroidHz: Number(centroidHz.toFixed(1)),
  };

  if (peak < G.minPeak) reasons.push(`peak=${peak.toFixed(3)} < ${G.minPeak}（电平过低）`);
  if (peak > G.maxPeak) reasons.push(`peak=${peak.toFixed(3)} > ${G.maxPeak}（削波风险）`);
  if (rms < G.minRms) reasons.push(`rms=${rms.toFixed(4)} < ${G.minRms}（几乎静音）`);
  if (rms > G.maxRms) reasons.push(`rms=${rms.toFixed(4)} > ${G.maxRms}（过响）`);
  if (clipped / n > G.maxClipRatio) reasons.push(`clip=${(clipped / n).toFixed(4)} 超限`);
  if (Math.abs(dc) > G.maxDcOffset) reasons.push(`dc=${dc.toFixed(4)} 超限`);
  if (noiseFloor > G.maxNoiseFloor) reasons.push(`底噪=${noiseFloor.toFixed(4)} 超限（沙哑）`);
  if (activeRatio < G.minActiveRatio || activeRatio > G.maxActiveRatio) {
    reasons.push(`activeRatio=${activeRatio.toFixed(3)} 越界（静音或持续噪声）`);
  }
  if (highBandRatio < G.minHighBandRatio) {
    reasons.push(`3k+ 能量=${highBandRatio.toFixed(5)} < ${G.minHighBandRatio}（发闷）`);
  }
  if (durationS < G.minDurationS || durationS > G.maxDurationS) {
    reasons.push(`时长=${durationS.toFixed(2)}s 越界`);
  }
  return verdict(metrics, reasons);
}

export function inspectWav(buf: Buffer): VoiceQualityVerdict {
  const audio = readWav(buf);
  if (!audio) return verdict({ bytes: buf.length }, ["不是 16-bit 单声道 PCM WAV"]);
  return inspectPcm(audio);
}

/**
 * WAV 后处理的参考实现（历史端侧本地模型实验，保留供离线分析/回归）。
 * 响度按 RMS 对齐云端，而不是按峰值——按峰值推只会更吵更闷。生产链路不再调用。
 */
export function enhancePcm(audio: PcmAudio): PcmAudio {
  const src = audio.samples;
  const n = src.length;
  if (n === 0) return audio;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += src[i];
  mean /= n;
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) y[i] = src[i] - mean;

  // 首尾静音裁剪（保留 60ms 边缘）
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(y[i]));
  const win = Math.max(1, Math.floor(audio.sampleRate * 0.02));
  const frameCount = Math.floor(n / win);
  const frameRms = new Float64Array(frameCount);
  for (let f = 0; f < frameCount; f++) {
    let s = 0;
    for (let i = f * win; i < (f + 1) * win; i++) s += y[i] * y[i];
    frameRms[f] = Math.sqrt(s / win);
  }
  const sorted = Array.from(frameRms).sort((a, b) => a - b);
  const p5 = sorted.length ? sorted[Math.floor(sorted.length * 0.05)] : 0;
  const threshold = Math.max(peak * 0.015, p5 * 3, 1e-5);
  let first = -1;
  let last = -1;
  for (let f = 0; f < frameCount; f++) {
    if (frameRms[f] > threshold) {
      if (first < 0) first = f;
      last = f;
    }
  }
  let out = y;
  if (first >= 0) {
    const start = Math.max(0, first * win - Math.floor(audio.sampleRate * 0.06));
    const end = Math.min(n, (last + 1) * win + Math.floor(audio.sampleRate * 0.06));
    out = y.slice(start, end);
  }

  // 响度归一（双向限幅）
  let p = 0;
  let sq = 0;
  for (let i = 0; i < out.length; i++) {
    p = Math.max(p, Math.abs(out[i]));
    sq += out[i] * out[i];
  }
  const rms = Math.sqrt(sq / out.length) || 1e-9;
  const gain = Math.max(G.minGain, Math.min(G.maxGain, Math.min(G.targetRms / rms, G.targetPeak / (p || 1e-9))));
  for (let i = 0; i < out.length; i++) out[i] *= gain;

  // 高频补偿：y += k * (y - lowpass(y))
  let lp = 0;
  for (let i = 0; i < out.length; i++) {
    const v = out[i];
    lp += G.shelfAlpha * (v - lp);
    out[i] = v + G.shelfK * (v - lp);
  }
  // 二次响度对齐 + 峰值保护
  let p2 = 0;
  let sq2 = 0;
  for (let i = 0; i < out.length; i++) {
    p2 = Math.max(p2, Math.abs(out[i]));
    sq2 += out[i] * out[i];
  }
  const rms2 = Math.sqrt(sq2 / out.length) || 1e-9;
  const gain2 = Math.max(0.5, Math.min(2.0, Math.min(G.targetRms / rms2, G.targetPeak / (p2 || 1e-9))));
  for (let i = 0; i < out.length; i++) out[i] *= gain2;
  let p3 = 0;
  for (let i = 0; i < out.length; i++) p3 = Math.max(p3, Math.abs(out[i]));
  if (p3 > G.targetPeak) {
    for (let i = 0; i < out.length; i++) out[i] *= G.targetPeak / p3;
  }

  // 淡入 8ms / 淡出 25ms
  const fadeIn = Math.min(Math.floor(audio.sampleRate * 0.008), Math.floor(out.length / 4));
  const fadeOut = Math.min(Math.floor(audio.sampleRate * 0.025), Math.floor(out.length / 4));
  for (let i = 0; i < fadeIn; i++) out[i] *= i / fadeIn;
  for (let i = 0; i < fadeOut; i++) out[out.length - 1 - i] *= i / fadeOut;
  for (let i = 0; i < out.length; i++) out[i] = Math.max(-1, Math.min(1, out[i]));
  return { samples: out, sampleRate: audio.sampleRate };
}

/** 统一入口：按格式分派，textLength 用于 mp3 的时长合理性判定。 */
export function inspectVoiceBuffer(
  buf: Buffer,
  format: "mp3" | "wav",
  textLength = 0,
): VoiceQualityVerdict {
  return format === "wav" ? inspectWav(buf) : inspectMp3(buf, textLength);
}
