/**
 * 语音端点检测（能量 VAD，零依赖）。
 *
 * 服务端对上行 16-bit PCM 做 RMS 能量检测：
 *   - 能量超过 speechThreshold 记为说话，累计语音
 *   - 说话状态下连续 silenceMs 低于阈值 → 端点（一句话说完）
 *   - 单句最长 maxUtteranceMs 强制端点（防止环境噪声把静音判爆）
 *
 * 供实时全双工会话使用：在流式引擎之外提供本地能量端点判断，
 * 用于识别「用户开始说话」与「一句话结束」的时机。
 */

export interface EndpointDetectorOptions {
  /**
   * 语音能量阈值下限（RMS，0-32767；缺省 200，见 [VOICE_VAD_SPEECH_THRESHOLD]）。
   * 实际生效值是 max(本值, 背景噪声 × 3)，见 [EndpointDetector.effectiveThreshold]。
   */
  speechThreshold?: number;
  /** 判定说完的静音时长（毫秒，缺省 700） */
  silenceMs?: number;
  /** 单句最长（毫秒，缺省 15000） */
  maxUtteranceMs?: number;
  /** 每块音频对应的毫秒数（按 chunk 实际样本数计算，不需要传） */
}

export type EndpointEvent = "idle" | "speaking" | "endpoint";

/**
 * 语音能量阈值下限（RMS，0-32767），可用环境变量 VOICE_VAD_SPEECH_THRESHOLD 覆盖。
 *
 * 为什么不能只靠这一个绝对值：麦克风增益差异极大。实测 RMS 300 的正常说话
 * （笔记本内置麦 / 离得稍远 / 系统音量不满）够不到旧默认值 350，于是每一块
 * 都被判成静音，inSpeech 永远为 false —— 一句话都断不出来，表现就是
 * 「通话接通了但说话完全没反应」。把下限压到 200，再叠加下面的相对判定。
 */
export const DEFAULT_SPEECH_THRESHOLD = (() => {
  const raw = process.env.VOICE_VAD_SPEECH_THRESHOLD?.trim();
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 && n < 32767 ? n : 200;
})();

/** 生效阈值相对背景噪声的倍数：说话能量至少要把底噪压过去这么多倍 */
const NOISE_FLOOR_RATIO = 3;
/** 底噪估计的历史窗口块数（100ms/块 ≈ 最近 10 秒） */
const NOISE_HISTORY_SIZE = 100;

export class EndpointDetector {
  private readonly threshold: number;
  private readonly silenceMs: number;
  private readonly maxUtteranceMs: number;

  private inSpeech = false;
  private silentMs = 0;
  private speechMs = 0;
  /** 最近一块音频的 RMS（16bit 原值口径），诊断用 */
  private lastRms = 0;
  /** 背景噪声历史样本（不含已判定为语音的块） */
  private readonly noiseHistory: number[] = [];
  private noiseFloor = 0;

  constructor(options: EndpointDetectorOptions = {}) {
    this.threshold = options.speechThreshold ?? DEFAULT_SPEECH_THRESHOLD;
    this.silenceMs = options.silenceMs ?? 700;
    this.maxUtteranceMs = options.maxUtteranceMs ?? 15_000;
  }

  /** 最近一块音频的 RMS（16bit 原值口径）；用于诊断「说了没反应」是采集弱还是阈值高。 */
  get rms(): number {
    return this.lastRms;
  }

  /** 当前能量阈值下限 */
  get speechThreshold(): number {
    return this.threshold;
  }

  /** 背景噪声估计（RMS） */
  get noise(): number {
    return this.noiseFloor;
  }

  /**
   * 实际生效的判定阈值 = max(下限, 背景噪声 × 3)。
   *
   * 安静房间进一步压低门槛该收的都收进来，嘈杂环境自动抬高门槛压掉误触发。
   */
  get effectiveThreshold(): number {
    return Math.max(this.threshold, Math.round(this.noiseFloor * NOISE_FLOOR_RATIO));
  }

  /**
   * 只在「没在说话」时跟踪底噪——把语音本身算进噪声历史会让估计被抬高，
   * 静默一两秒后底噪虚高、人再说话又判不过去。
   */
  private trackNoiseFloor(rms: number): void {
    this.noiseHistory.push(rms);
    if (this.noiseHistory.length > NOISE_HISTORY_SIZE) this.noiseHistory.shift();
    if (this.noiseHistory.length < 8) return; // 样本太少，先用绝对下限
    const sorted = [...this.noiseHistory].sort((a, b) => a - b);
    // 取 20 分位而非最小值：偶尔的静音块不代表底噪
    this.noiseFloor = sorted[Math.floor(sorted.length * 0.2)] ?? 0;
  }

  /**
   * 喂入一块 16-bit LE 单声道 PCM；返回本块之后的状态：
   *   speaking  — 正在说话（继续收集）
   *   endpoint  — 一句话结束（调用方应取出缓冲喂给实时引擎）
   *   idle      — 无人说话
   */
  feed(pcm: Buffer, sampleRate: number): EndpointEvent {
    const samples = pcm.length >> 1;
    if (samples === 0) return this.inSpeech ? "speaking" : "idle";
    let sumSquares = 0;
    for (let i = 0; i < samples; i++) {
      const v = pcm.readInt16LE(i * 2);
      sumSquares += v * v;
    }
    const rms = Math.sqrt(sumSquares / samples);
    this.lastRms = rms;
    const chunkMs = (samples / sampleRate) * 1000;

    const isSpeech = rms >= this.effectiveThreshold;
    if (isSpeech) {
      this.inSpeech = true;
      this.silentMs = 0;
      this.speechMs += chunkMs;
    } else {
      if (!this.inSpeech) this.trackNoiseFloor(rms);
      if (this.inSpeech) {
        this.silentMs += chunkMs;
        this.speechMs += chunkMs;
      }
    }

    if (this.inSpeech && (this.silentMs >= this.silenceMs || this.speechMs >= this.maxUtteranceMs)) {
      return "endpoint";
    }
    return this.inSpeech ? "speaking" : "idle";
  }

  /** 是否已检测到语音（用于丢弃纯噪声缓冲）。 */
  get hasSpeech(): boolean {
    return this.inSpeech;
  }

  reset(): void {
    this.inSpeech = false;
    this.silentMs = 0;
    this.speechMs = 0;
    this.lastRms = 0;
    // 底噪估计保留：它是长时统计量，逐句重置会让第一句话又要重新收敛
  }
}

/** 把裸 PCM 包装成最小 WAV 容器（整段音频上传实时引擎前用）。 */
export function pcmToWav(pcm: Buffer, sampleRate: number, channels = 1, bitsPerSample = 16): Buffer {
  const byteRate = sampleRate * channels * (bitsPerSample >> 3);
  const blockAlign = channels * (bitsPerSample >> 3);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
