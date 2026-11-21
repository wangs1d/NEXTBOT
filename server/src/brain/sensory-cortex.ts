// Agent Brain Center —— 感官皮层（SensoryCortex）
//
// 职责：脑内感官皮层聚合（语言），封装「说（语言组织）」感知通道，
// 并提供多模态融合帧 buildSensoryFrame 供其他皮层消费。
// 语音识别（ASR）已从产品中移除：入站音频的理解由 realtime 语音引擎在云端完成。
// 桌面视觉（截屏 + VLM 描述）已随 desktop-visual 执行体一并移除。
//
// 与 BodyCenter 器官的分工：
//   - BrainCenter.SensoryCortex（本类）= 脑内感官皮层，做语义理解（文本→话术）
//   - BodyCenter.Eye/Ear = 身体感觉器官，做硬件采集（拍照、收音频）
//   - 协作通路：BodyCenter 器官发布 body.* 信号到 BodyBus，
//     SensoryCortex 通过 attachBodyBus 订阅这些信号填充 SensoryFrame；决策后通过 BodyGateway 下行控制器官
//
// 设计原则：
//   1. 所有方法直接调用底层服务，不让 LLM 决定要不要感知（不走 prompt 路线）。
//   2. 子系统缺失时方法优雅降级（返回带 error 的空结果），与 BrainCenter 风格一致。
//   3. *Like 接口仅声明 SensoryCortex 实际用到的方法，结构兼容即可。
import type {
  AudioBufferRef,
  EmotionVector,
  SensoryFrame,
  SensorySpeakResult,
  UserActivityState,
} from "./types.js";

// ---- 子系统最小化外观接口（结构兼容真实服务即可）----------------------

/** 音频格式联合（与 AudioBufferRef.format 一致）。 */
type AudioFormat = "mp3" | "wav" | "pcm" | "ogg";

/**
 * 语音对话子系统（VoiceDialogueService）的最小化结构接口。
 * 提供 TTS（synthesizeSpeech），LLM 为可选。
 */
interface VoiceDialogueLike {
  synthesizeSpeech(
    text: string,
    opts?: { voiceId?: string },
  ): Promise<{
    data: Buffer | unknown;
    format: AudioFormat;
    sampleRate?: number;
    channels?: number;
  }>;
  chatCompletion?(
    messages: { role: "system" | "user" | "assistant"; content: string }[],
    opts?: Record<string, unknown>,
  ): Promise<string>;
}

/**
 * 语音能力子系统（VoiceCapabilityService）的最小化结构接口。
 * 作为 voiceDialogue 缺失时的 TTS 兜底合成路径（返回 base64 mp3）。
 */
interface VoiceCapabilityLike {
  synthesize?(
    text: string,
  ): Promise<
    | { ok: true; format: "mp3"; base64: string; provider?: string }
    | { ok: false; reason: string }
  >;
}

/**
 * SynapseBus 的最小化外观接口（结构兼容真实 SynapseBus 即可）。
 * 仅声明 SensoryCortex 用到的 fire 能力；subscribeType 为可选，
 * 供需要订阅事件的其他皮层使用。
 */
interface SynapseBusLike {
  fire(
    type: string,
    data: Record<string, unknown>,
    opts?: { actorId?: string; source?: string },
  ): unknown;
  subscribeType?(
    type: string,
    handler: (event: {
      data: Record<string, unknown>;
      actorId?: string;
      source?: string;
    }) => void | Promise<void>,
  ): () => void;
}

// ---- SensoryCortex ----------------------------------------------------

/**
 * 感官皮层：统一封装听 / 说 两条感知通道。
 *
 * 任一子系统缺失时方法优雅降级（返回带 error 的空结果），
 * 不抛异常阻断调用方。所有感知调用均为直连底层服务，不经 LLM 决策。
 */
export class SensoryCortex {
  private voiceDialogue: VoiceDialogueLike | null = null;
  private voiceCapability: VoiceCapabilityLike | null = null;
  private synapseBus: SynapseBusLike | null = null;
  private started = false;

  // 累计调用计数（含失败调用，反映感官使用频次）
  private totalSpeak = 0;

  // ---- 子系统注册 -------------------------------------------------------

  registerVoiceDialogue(svc: VoiceDialogueLike): void {
    this.voiceDialogue = svc;
    console.log("[SensoryCortex] 已注册 VoiceDialogue");
  }

  registerVoiceCapability(svc: VoiceCapabilityLike): void {
    this.voiceCapability = svc;
    console.log("[SensoryCortex] 已注册 VoiceCapability");
  }

  /** 注册突触总线，使关键感知操作完成后能 fire 事件给订阅者 */
  registerSynapseBus(svc: SynapseBusLike): void {
    this.synapseBus = svc;
    console.log("[SensoryCortex] 已注册 SynapseBus");
  }

  // ---- 生命周期 ---------------------------------------------------------

  /** 启动感官皮层：当前无后台任务，仅置位并记日志。 */
  async start(): Promise<void> {
    if (this.started) {
      console.log("[SensoryCortex] 已启动，跳过重复 start");
      return;
    }
    console.log("[SensoryCortex] 正在启动...");
    this.started = true;
    console.log("[SensoryCortex] 启动完成");
  }

  /** 停止感官皮层：仅置位，不主动中断底层服务。 */
  async stop(): Promise<void> {
    if (!this.started) {
      console.log("[SensoryCortex] 未启动，跳过 stop");
      return;
    }
    console.log("[SensoryCortex] 正在停止...");
    this.started = false;
    console.log("[SensoryCortex] 已停止");
  }

  // ---- 核心方法 ---------------------------------------------------------

  /**
   * 说：委托 VoiceDialogueService.synthesizeSpeech 合成语音。
   * voiceDialogue 缺失时退回到 VoiceCapability.synthesize（base64 mp3）兜底；
   * 两者均缺失时返回 delivered=false 并带 error。
   * channel 从 opts 传入，默认 "ws"。
   */
  async speak(
    text: string,
    opts?: { voiceId?: string; channel?: string },
  ): Promise<SensorySpeakResult> {
    const now = new Date().toISOString();
    const channel = opts?.channel ?? "ws";
    this.totalSpeak += 1;

    // 主路径：voiceDialogue.synthesizeSpeech
    if (this.voiceDialogue) {
      try {
        const tts = await this.voiceDialogue.synthesizeSpeech(
          text,
          opts?.voiceId ? { voiceId: opts.voiceId } : undefined,
        );
        try {
          this.synapseBus?.fire(
            "sensory.speak",
            { channel, delivered: true, format: tts.format },
            { source: "sensory" },
          );
        } catch {
          /* fire 失败不影响主流程 */
        }
        return {
          audio: {
            data: tts.data,
            format: tts.format,
            sampleRate: tts.sampleRate,
            channels: tts.channels,
          },
          delivered: true,
          channel,
          processedAt: now,
        };
      } catch (err) {
        console.log(`[SensoryCortex] speak 合成失败: ${err}`);
        return {
          delivered: false,
          channel,
          processedAt: now,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }

    // 兜底路径：voiceCapability.synthesize（返回 base64 mp3）
    if (this.voiceCapability?.synthesize) {
      try {
        const synth = await this.voiceCapability.synthesize(text);
        if (synth.ok) {
          try {
            this.synapseBus?.fire(
              "sensory.speak",
              { channel, delivered: true, format: synth.format },
              { source: "sensory" },
            );
          } catch {
            /* fire 失败不影响主流程 */
          }
          return {
            audio: {
              data: Buffer.from(synth.base64, "base64"),
              format: synth.format,
            },
            delivered: true,
            channel,
            processedAt: now,
          };
        }
        return {
          delivered: false,
          channel,
          processedAt: now,
          error: synth.reason,
        };
      } catch (err) {
        console.log(`[SensoryCortex] speak 兜底合成失败: ${err}`);
        return {
          delivered: false,
          channel,
          processedAt: now,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }

    console.log(
      "[SensoryCortex] speak: VoiceDialogue 与 VoiceCapability 均未注册",
    );
    return {
      delivered: false,
      channel,
      processedAt: now,
      error: "VoiceDialogueService 未注册",
    };
  }

  /**
   * 组装多模态感官帧（纯函数式，不调用任何子系统）。
   * 将视觉描述 / 情绪 / 活动状态融合为统一感知帧。
   */
  buildSensoryFrame(args: {
    actorId: string;
    audioText?: string;
    visualDescription?: string;
    emotion?: EmotionVector;
    activity?: UserActivityState;
  }): SensoryFrame {
    return {
      actorId: args.actorId,
      audioText: args.audioText,
      visualDescription: args.visualDescription,
      emotion: args.emotion,
      activity: args.activity,
      capturedAt: new Date().toISOString(),
    };
  }

  // ---- 统计 -------------------------------------------------------------

  /** 返回累计的 speak 调用次数。 */
  getStats(): { totalSpeak: number } {
    return {
      totalSpeak: this.totalSpeak,
    };
  }
}
