import { EndpointDetector } from "./endpoint-detector.js";
import type { DuplexClientMessage, DuplexServerMessage, DuplexSessionConfig, DuplexSessionState } from "./protocol.js";
import type {
  RealtimeEngineSession,
  RealtimeEngineDescriptor,
  RealtimeTurnResult,
  RealtimeVoiceEngine,
} from "./realtime-engine-port.js";

/**
 * 端到端实时语音引擎的全双工语音会话（引擎无关）。
 *
 * 与 DuplexVoiceSession（pipeline 引擎）同一客户端协议，差异只在引擎：
 *   - ASR + LLM + 语音合成全部发生在实时引擎的单条会话里，会话期上下文延续
 *     （追问"刚才说了什么"能答上），服务端不存历史；
 *   - text.turn：客户端把本地识别好的文本直接喂进来（纯语音模式主路径，
 *     麦克风仍归本地唤醒/声纹/识别所有，无双消费者冲突）；
 *   - audio.chunk：整段 16kHz PCM 也支持——本地能量 VAD 断句后整句喂给引擎
 *     （部分引擎无 server_vad，必须手动 commit，由引擎实现自行处理）；
 *   - 回合输出，若引擎 descriptor.streamingTts 为真则**流式分块下发**：引擎的
 *     音频增量逐段到达即逐段下发 tts.chunk（裸 PCM + sampleRate），客户端边收
 *     边播；否则退化为整轮聚合后单块下发。
 *
 * 本类**不绑定任何厂商**：所有引擎差异（名字、采样率、上行分片、是否流式）
 * 均来自 `deps.engine.descriptor`，开会话经 `deps.engine.openSession`。
 * 换本地引擎或其它云端 = 换一个 RealtimeVoiceEngine 实现，本文件不动。
 *
 * 半双工约定：thinking/speaking 期间上行音频直接丢弃（客户端播放时不采集，
 * 扬声器不会回流进引擎上下文）；此期间收到 text.turn 回错。
 * 打断语义沿用代次（generation）：interrupt 后完成的旧回合输出整体丢弃
 * （实时引擎多无 response.cancel，服务端侧会跑完但结果不下发）。
 */

export interface RealtimeDuplexSessionDeps {
  /** 端到端实时语音引擎（端口实现：MiniMax 云端 / 本地 / 其它云端） */
  engine: RealtimeVoiceEngine;
  /** 会话人设（口语化短回复） */
  systemPrompt?: string;
  /** 端点检测静音时长（毫秒） */
  endpointSilenceMs?: number;
  /** session.start 带 sessionId=callId 时解析通话场景人设（电话实时语音） */
  callVoiceContext?: (callId: string) => string | null;
}

/**
 * 判"说完"所需的尾部静音时长（毫秒），可用 VOICE_ENDPOINT_SILENCE_MS 覆盖。
 *
 * 这段等待是用户感知延迟的第一节，且完全由我们自己决定：调得太长就迟钝，
 * 太短会在句中自然停顿时抢话。原值 700ms 偏保守，550ms 更接近对话节奏。
 */
const DEFAULT_ENDPOINT_SILENCE_MS = (() => {
  const raw = process.env.VOICE_ENDPOINT_SILENCE_MS?.trim();
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 200 && n <= 2000 ? n : 550;
})();

export class RealtimeDuplexSession {
  readonly id: string;
  /** 引擎实现名（来自 descriptor，仅作展示/日志用） */
  readonly engine: string;

  private readonly desc: RealtimeEngineDescriptor;
  private state: DuplexSessionState = "idle";
  private config: DuplexSessionConfig = { sampleRate: 16000, language: "zh" };
  private engineSession: RealtimeEngineSession | null = null;
  private generation = 0;
  private ttsSeq = 0;
  /** 通话场景人设（session.start 带 callId 时注入），空为默认助手 */
  private voiceContext: string | null = null;

  private readonly detector: EndpointDetector;
  private readonly pcmBuffers: Buffer[] = [];
  private pcmBytes = 0;

  /** 上行诊断窗口状态：累计字节、峰值 RMS、窗口起点 */
  private uplinkBytesWindow = 0;
  private uplinkPeakRmsWindow = 0;
  private uplinkWindowStart = Date.now();
  /** 非 listening 状态的持续起点（看门狗用，防状态机卡死导致上行永久丢弃） */
  private busySince: number | null = null;
  /** 本轮音频推送的预计耗时（毫秒，由 descriptor 分片参数估算） */
  private audioDispatchMs = 0;

  constructor(
    id: string,
    private readonly sink: (msg: DuplexServerMessage) => void,
    private readonly deps: RealtimeDuplexSessionDeps,
  ) {
    this.id = id;
    this.desc = deps.engine.descriptor;
    this.engine = this.desc.name;
    this.detector = new EndpointDetector({
      silenceMs: deps.endpointSilenceMs ?? DEFAULT_ENDPOINT_SILENCE_MS,
    });
  }

  getState(): DuplexSessionState {
    return this.state;
  }

  getConfig(): DuplexSessionConfig {
    return { ...this.config };
  }

  // ------------------------------------------------------------------ //
  // 客户端消息入口（与 DuplexVoiceSession.handle 同一契约）
  // ------------------------------------------------------------------ //

  async handle(msg: DuplexClientMessage): Promise<void> {
    switch (msg.type) {
      case "session.start": {
        this.config = {
          sampleRate: clampInt(msg.sampleRate ?? 16000, 8000, 48000),
          language: msg.language?.trim() || "zh",
          voiceId: msg.voiceId?.trim() || undefined,
          sessionId: msg.sessionId?.trim() || undefined,
        };
        if (msg.systemPrompt?.trim()) {
          this.deps.systemPrompt = msg.systemPrompt.trim();
        }
        // 电话实时语音：sessionId=callId → 解析通话场景人设（非通话连接解析不到，用默认）
        this.voiceContext = msg.sessionId?.trim()
          ? this.deps.callVoiceContext?.(msg.sessionId.trim()) ?? null
          : null;
        this.dropEngineSession();
        this.resetListeningBuffers();
        this.setState("listening");
        this.sink({
          type: "session.ready",
          config: this.config,
          streamingAsr: false,
          engine: this.engine,
          engineKind: "realtime",
          streamingTts: this.desc.streamingTts,
        });
        return;
      }
      case "text.turn":
        void this.runTextTurn(msg.text ?? "");
        return;
      case "audio.chunk":
        this.feedAudio(msg.pcm);
        return;
      case "audio.end":
        void this.forceEndpoint();
        return;
      case "interrupt":
        this.interrupt();
        return;
      case "session.stop":
        await this.stop();
        return;
      default:
        return;
    }
  }

  // ------------------------------------------------------------------ //
  // 上行
  // ------------------------------------------------------------------ //

  feedAudio(pcmBase64: string): void {
    const pcm = Buffer.from(pcmBase64, "base64");
    if (pcm.length === 0) return;

    // 先看门控：thinking/speaking 期间的上行直接丢弃（防扬声器回流污染上下文）。
    // 这里必须给出可观测证据——否则「说了没反应」无法区分是客户端没送上来、
    // 还是被状态机丢掉了。
    if (this.state !== "listening") {
      const stuckMs = this.busySince ? Date.now() - this.busySince : 0;
      if (stuckMs > 30_000) {
        // 看门狗：回合理论上几十秒内必完成，超时说明客户端断连/回合挂起，
        // 强制回到 listening，否则本次通话的上行会被永久丢弃
        console.warn(
          `[duplex:${this.engine}:${this.id}] 状态 ${this.state} 已持续 ${stuckMs}ms，` +
            `强制回到 listening（防上行被永久丢弃）`,
        );
        this.setState("listening");
      }
      return;
    }

    this.pcmBuffers.push(pcm);
    this.pcmBytes += pcm.length;
    const event = this.detector.feed(pcm, this.config.sampleRate);

    // 诊断窗口（5s）：打印收到的字节数与峰值 RMS，直接回答「音频有没有上来、
    // 电平够不够触发 VAD」
    this.uplinkBytesWindow += pcm.length;
    if (this.detector.rms > this.uplinkPeakRmsWindow) {
      this.uplinkPeakRmsWindow = this.detector.rms;
    }
    const now = Date.now();
    if (now - this.uplinkWindowStart >= 5000) {
      const peak = Math.round(this.uplinkPeakRmsWindow);
      const threshold = this.detector.effectiveThreshold;
      const verdict =
        this.uplinkBytesWindow === 0
          ? "未收到任何上行音频（检查客户端麦克风/半双工门控）"
          : peak < threshold
            ? `峰值 ${peak} < 生效阈值 ${threshold}（下限 ${this.detector.speechThreshold} / 底噪 ${Math.round(
                this.detector.noise,
              )}×3），说话不会被识别`
            : `峰值 ${peak} ≥ 生效阈值 ${threshold}，可触发 VAD`;
      console.info(
        `[duplex:${this.engine}:${this.id}] vad probe bytes=${this.uplinkBytesWindow} ` +
          `sampleRate=${this.config.sampleRate} noise=${Math.round(this.detector.noise)} ` +
          `inSpeech=${this.detector.hasSpeech} → ${verdict}`,
      );
      this.uplinkBytesWindow = 0;
      this.uplinkPeakRmsWindow = 0;
      this.uplinkWindowStart = now;
    }

    if (event === "endpoint") {
      void this.runAudioTurn();
    }
  }

  /** audio.end / 客户端主动收句。 */
  async forceEndpoint(): Promise<void> {
    if (this.state !== "listening") return;
    await this.runAudioTurn();
  }

  interrupt(): void {
    if (this.state === "thinking" || this.state === "speaking") {
      this.generation += 1; // 在途回合完成后输出按代次丢弃
      this.setState("listening");
    }
  }

  async stop(): Promise<void> {
    this.generation += 1;
    this.dropEngineSession();
    this.setState("idle");
    this.sink({ type: "session.ended" });
  }

  dispose(): void {
    this.generation += 1;
    this.dropEngineSession();
  }

  // ------------------------------------------------------------------ //
  // 回合
  // ------------------------------------------------------------------ //

  private async runTextTurn(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (this.state !== "listening") {
      this.sink({ type: "error", message: "上一轮回复还在生成中，稍候再说", recoverable: true });
      return;
    }
    const gen = ++this.generation;
    this.setState("thinking");
    await this.runTurn(trimmed, { text: trimmed }, gen);
  }

  private async runAudioTurn(): Promise<void> {
    if (this.state !== "listening") return;
    const pcm = Buffer.concat(this.pcmBuffers.splice(0, this.pcmBuffers.length));
    this.pcmBytes = 0;
    this.detector.reset();
    // 过短（<0.3s）大概率是噪声
    if (pcm.length < this.config.sampleRate * 2 * 0.3) return;
    const gen = ++this.generation;
    this.setState("thinking");
    const blocks = Math.ceil(pcm.length / this.desc.inputChunkBytes);
    this.audioDispatchMs = blocks * this.desc.inputChunkDelayMs;
    console.info(
      `[duplex:${this.engine}:${this.id}] VAD 断句 ${(pcm.length / this.config.sampleRate / 2).toFixed(2)}s 音频，` +
        `将分 ${blocks} 块推送（推送耗时约 ${this.audioDispatchMs}ms）`,
    );
    await this.runTurn("", { pcm16k: pcm }, gen);
  }

  private async runTurn(userText: string, input: { text?: string; pcm16k?: Buffer }, gen: number): Promise<void> {
    try {
      const engineSession = this.ensureEngineSession();
      // 流式：首段音频到达即开播，后续块边到边下发。
      // 首字延迟因此只等引擎首包，不再叠加"整轮生成完"那段纯等待。
      let ttsStarted = false;
      let audioBytes = 0;
      const result = await engineSession.turn(input, undefined, {
        onAudioChunk: (chunk) => {
          if (gen !== this.generation) return; // 已被打断：整轮输出丢弃
          if (!ttsStarted) {
            ttsStarted = true;
            this.setState("speaking");
            this.sink({ type: "tts.start" });
          }
          audioBytes += chunk.length;
          this.sink({
            type: "tts.chunk",
            seq: ++this.ttsSeq,
            audio: chunk.toString("base64"),
            format: "pcm",
            sampleRate: this.desc.outputSampleRate,
          });
        },
      });
      if (gen !== this.generation) return; // 已被打断：输出整体丢弃
      this.finishTurnOutput(userText, result, ttsStarted, audioBytes);
    } catch (err) {
      if (gen !== this.generation) return;
      this.sink({
        type: "error",
        message: `实时语音回合失败：${err instanceof Error ? err.message : String(err)}`,
        recoverable: true,
      });
      this.dropEngineSession(); // 连接状态可疑，下一回合懒重连
      this.setState("listening");
    }
  }

  private finishTurnOutput(userText: string, result: RealtimeTurnResult, ttsStarted: boolean, audioBytes: number): void {
    const asrText = (result.asrText ?? "").trim() || userText;
    this.sink({ type: "asr.final", text: asrText });

    const audioSec = audioBytes / this.desc.outputSampleRate / 2;
    console.info(
      `[duplex:${this.engine}:${this.id}] 回合完成：推送 ${this.audioDispatchMs}ms → 首包语音 ${result.firstAudioMs}ms ` +
        `→ 整轮 ${result.totalMs}ms（流式下发 ${audioSec.toFixed(2)}s 音频，首包即播不再等整轮）`,
    );

    if (!result.transcript.trim() && !ttsStarted) {
      this.sink({ type: "error", message: "本轮没有产生回复", recoverable: true });
      this.setState("listening");
      return;
    }

    if (ttsStarted) {
      this.sink({ type: "tts.end" });
    }
    this.sink({ type: "assistant.completed", text: result.transcript });
    this.sink({ type: "turn.completed", userText: asrText, assistantText: result.transcript });
    this.setState("listening");
  }

  // ------------------------------------------------------------------ //
  // 内部
  // ------------------------------------------------------------------ //

  private ensureEngineSession(): RealtimeEngineSession {
    this.engineSession ??= this.deps.engine.openSession({
      voiceId: this.config.voiceId,
      instructions: [this.deps.systemPrompt, this.voiceContext].filter((s) => !!s && s.trim()).join("\n\n") || undefined,
    });
    return this.engineSession;
  }

  private dropEngineSession(): void {
    if (this.engineSession) {
      try {
        this.engineSession.close();
      } catch {
        // ignore
      }
    }
    this.engineSession = null;
  }

  private resetListeningBuffers(): void {
    this.pcmBuffers.length = 0;
    this.pcmBytes = 0;
    this.detector.reset();
  }

  private setState(state: DuplexSessionState): void {
    if (this.state === state) return;
    this.state = state;
    // listening = 受理上行；其余状态的持续时长由 feedAudio 里的看门狗盯着
    this.busySince = state === "listening" ? null : Date.now();
    this.sink({ type: "state", state });
  }
}

function clampInt(v: number, min: number, max: number): number {
  const n = Math.round(Number.isFinite(v) ? v : min);
  return Math.max(min, Math.min(max, n));
}
