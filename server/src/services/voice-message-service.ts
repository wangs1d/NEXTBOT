import { getDataDir } from "../config/data-dir.js";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { TtsService } from "./tts-service.js";

/**
 * 语音消息服务：把 TTS 合成的 mp3 落盘为可重播的语音消息。
 *
 * 设计目标：
 *   1. **作为 Agent 底层能力**：与 socialFeedService 解耦，独立目录 `data/voice-messages/`。
 *   2. **可重播**：每个文件名 = `{actorId}/{msgId}.mp3`，客户端可通过 `GET /agent/voice/messages/:actorId/:msgId.mp3` 反复拉流。
 *   3. **时长**：优先使用 TtsService 逐帧解析出的真实时长（`synth.quality.metrics.durationS`）。
 *      TtsService 在合成时已调用 `inspectMp3` 解出精确时长用于音质门禁，这里不能丢弃。
 *      只有在质量报告缺失（旧的/降级 provider）时才按「实际码率」粗估。
 *      ！不要用固定 4000 B/s 粗估：Breeze 输出 mp3_44100_128（128kbps≈16000 B/s），
 *        固定 4000 B/s 会把 13 秒音频算成 54 秒——这正是「一句晚安 54 秒」的根因。
 *   4. **波形降级**：服务端不生成波形数据（避免解码 mp3），客户端可用静默 placeholder 渲染；
 *      用户端上传时由客户端采集 waveform 后随消息体一起发送。
 *
 * 文件布局：
 *   data/voice-messages/
 *     └── {actorId}/
 *         ├── {msgId}.mp3      ← agent TTS 合成的
 *         └── {msgId}.mp3      ← 用户上传的
 *
 * 清理策略：暂不做自动清理（语音消息价值高、磁盘占用小）；
 *           可后续接入定时任务清理 30 天前的文件。
 */
export class VoiceMessageService {
  private readonly rootDir: string;
  /**
   * 时长兜底粗估用的字节/秒。仅在 TtsService 没有质量报告时才会用到。
   * 已按当前主力 Breeze 输出格式 mp3_44100_128 修正为 16000 B/s（128kbps），
   * 不再是导致 4 倍虚高的 4000 B/s。若质量报告带 bitrateKbps，则优先按它计算。
   */
  private readonly fallbackBytesPerSecond = 16000;

  constructor(rootDir?: string) {
    // 默认 <server>/data/voice-messages/
    this.rootDir = resolve(rootDir ?? join(getDataDir(), "voice-messages"));
    try {
      mkdirSync(this.rootDir, { recursive: true });
    } catch {
      // 并发初始化时可能已创建
    }
  }

  /** 落盘根目录（绝对路径）。 */
  getRoot(): string {
    return this.rootDir;
  }

  /**
   * 合成 + 落盘：把文本合成为 mp3 并写入磁盘，返回可访问的 mediaUrl 与元数据。
   * TTS 失败时返回 ok=false，调用方应降级为纯文本消息。
   */
  async composeAndStore(
    text: string,
    actorId: string,
  ): Promise<
    | { ok: true; mediaUrl: string; msgId: string; durationMs: number; provider?: string }
    | { ok: false; reason: string }
  > {
    const ttsService = this.ttsService;
    if (!ttsService) return { ok: false, reason: "TtsService 未注入" };

    const synth = await ttsService.synthesizeMp3Buffer(text);
    if (!synth.ok) return synth;

    const safeActor = sanitizeActorId(actorId);
    const actorDir = join(this.rootDir, safeActor);
    mkdirSync(actorDir, { recursive: true });

    const msgId = randomUUID();
    const fileName = `${msgId}.mp3`;
    const fullPath = join(actorDir, fileName);

    // 写盘
    writeFileSync(fullPath, synth.buffer);

    // 时长口径统一：优先用逐帧解码出的真实时长，退化路径按"实际码率"估算，
    // 绝不再用固定 4000 B/s（会把 13s 音频虚报成 54s）。
    const durationMs = resolveDurationMs(synth.buffer.length, synth.quality, this.fallbackBytesPerSecond);
    const mediaUrl = `/agent/voice/messages/${safeActor}/${fileName}`;

    return {
      ok: true,
      mediaUrl,
      msgId,
      durationMs,
      provider: synth.provider,
    };
  }

  /**
   * 用户端上传：保存客户端录音 mp3 到磁盘，返回 mediaUrl。
   * 与 composeAndStore 共用同一目录结构与 URL 规则。
   */
  async storeUploaded(
    buffer: Buffer,
    actorId: string,
    durationMs?: number,
  ): Promise<
    | { ok: true; mediaUrl: string; msgId: string; durationMs: number }
    | { ok: false; reason: string }
  > {
    if (!buffer || buffer.length === 0) return { ok: false, reason: "empty buffer" };
    // 5MB 上限
    if (buffer.length > 5 * 1024 * 1024) return { ok: false, reason: "file too large (>5MB)" };

    const safeActor = sanitizeActorId(actorId);
    const actorDir = join(this.rootDir, safeActor);
    mkdirSync(actorDir, { recursive: true });

    const msgId = randomUUID();
    const fileName = `${msgId}.mp3`;
    const fullPath = join(actorDir, fileName);

    writeFileSync(fullPath, buffer);

    const finalDurationMs =
      durationMs ?? estimateDurationMs(buffer.length, this.fallbackBytesPerSecond);
    const mediaUrl = `/agent/voice/messages/${safeActor}/${fileName}`;

    return { ok: true, mediaUrl, msgId, durationMs: finalDurationMs };
  }

  /**
   * 拉流：返回指定文件的绝对路径（若存在）。
   * 路由层用 createReadStream 读取后 reply.send(stream)。
   */
  resolveFilePath(actorId: string, fileName: string): string | null {
    const safeActor = sanitizeActorId(actorId);
    // 严格校验文件名：UUID.mp3
    if (!/^[a-zA-Z0-9-]+\.mp3$/.test(fileName)) return null;
    const fullPath = join(this.rootDir, safeActor, fileName);
    const normalized = resolve(fullPath);
    // 防穿越：确保最终路径仍在 rootDir 下
    if (!normalized.startsWith(resolve(this.rootDir))) return null;
    if (!existsSync(normalized) || !statSync(normalized).isFile()) return null;
    return normalized;
  }

  /** 注入 TtsService（避免循环依赖，由 bootstrap 显式注入）。 */
  private _ttsService: TtsService | null = null;
  get ttsService(): TtsService | null {
    return this._ttsService;
  }
  setTtsService(tts: TtsService): void {
    this._ttsService = tts;
  }
}

/** 把 actorId 中的非法字符替换为下划线，防止目录穿越。 */
function sanitizeActorId(actorId: string): string {
  if (!actorId) return "anonymous";
  const cleaned = actorId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return cleaned || "anonymous";
}

/** TtsService 合成结果里与时长相关的子集（解耦，便于单测注入）。 */
type QualityLike = { metrics?: Record<string, number> } | undefined;

/**
 * 统一时长解析（毫秒）：
 *   1. 质量报告里的 durationS 是 inspectMp3 逐帧累加 samplesPerFrame/sampleRate 的
 *      真实时长——精度到毫秒，直接换算，杜绝码率假设带来的成倍误差；
 *   2. 无真实时长时，按质量报告给出的 bitrateKbps 推算每秒字节数；
 *   3. 都没有才用兜底常量（已按当前主力 128kbps 输出修正）。
 */
function resolveDurationMs(
  bufferLength: number,
  quality: QualityLike,
  fallbackBytesPerSecond: number,
): number {
  const metrics = quality?.metrics;
  const realSeconds = metrics?.durationS;
  if (typeof realSeconds === "number" && Number.isFinite(realSeconds) && realSeconds > 0) {
    return Math.max(1, Math.round(realSeconds * 1000));
  }
  const bitrateKbps = metrics?.bitrateKbps;
  const bytesPerSecond =
    typeof bitrateKbps === "number" && Number.isFinite(bitrateKbps) && bitrateKbps > 0
      ? (bitrateKbps * 1000) / 8
      : fallbackBytesPerSecond;
  return estimateDurationMs(bufferLength, bytesPerSecond);
}

/** 根据文件大小与估算比特率粗估时长（毫秒，仅在无逐帧时长时用）。 */
function estimateDurationMs(fileSizeBytes: number, bytesPerSecond: number): number {
  if (fileSizeBytes <= 0 || bytesPerSecond <= 0) return 0;
  const seconds = fileSizeBytes / bytesPerSecond;
  // 至少 1 秒，避免 0 时长气泡
  return Math.max(1000, Math.round(seconds * 1000));
}
