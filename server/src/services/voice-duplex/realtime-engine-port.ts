/**
 * 端到端实时语音引擎「端口」——全双工语音的厂商中立边界。
 *
 * 为什么要有这层：
 *   `/ws/voice-duplex` 的会话层（RealtimeDuplexSession）只关心「把一段用户输入
 *   （文本或 16k PCM）喂进去，拿回助手语音 + 转录，且音频可边生成边下发」。
 *   这段语义与「引擎是谁」无关——MiniMax 云端、本地实时模型、或未来换的其它
 *   云端，能力相同。把这段语义固化成端口后：
 *
 *     - 会话层只 import 本文件，不 import 任何厂商 SDK；
 *     - 装配层（VoiceDuplexService / bootstrap）只按端口注册引擎，
 *       换实现 = 换/加一个 RealtimeVoiceEngine 实现，上层一行不动；
 *     - 引擎差异（采样率、上行分片、是否逐块流式 TTS）全部由
 *       RealtimeEngineDescriptor 声明，会话层据此驱动协议，零硬编码常量。
 *
 * 现有实现：engines/minimax-realtime-engine.ts（MiniMax 云端）。
 * 接本地引擎：实现本文件的 RealtimeVoiceEngine，在 bootstrap 里塞进
 * VoiceDuplexService 的 realtimeEngines 数组即可，无需改会话层与协议。
 */

/**
 * 引擎能力描述：会话层据此决定分块参数与协议回执，不再硬编码厂商常量。
 */
export interface RealtimeEngineDescriptor {
  /** 引擎实现名（回给客户端 session.ready.engine，仅作展示/统计用，勿用于分支） */
  readonly name: string;
  /** 助手输出音频采样率（Hz）：tts.chunk 的 sampleRate */
  readonly outputSampleRate: number;
  /** 期望的上行音频采样率（Hz），本地麦克风/VAD 按此采集 */
  readonly inputSampleRate: number;
  /** 上行单帧字节数（引擎接受的 append 分片大小） */
  readonly inputChunkBytes: number;
  /** 上行分片间最小节流（ms），0 = 尽快推完 */
  readonly inputChunkDelayMs: number;
  /** 是否逐块流式下发 TTS（true = 帧内 tts.start / tts.chunk* / tts.end） */
  readonly streamingTts: boolean;
}

/** 一轮对话的输入：文本（直接喂）或整段 16kHz PCM（引擎内 commit）二选一。 */
export interface RealtimeTurnInput {
  text?: string;
  pcm16k?: Buffer;
}

/**
 * 回合内的流式增量回调（边生成边消费）。
 *
 * 提供 onAudioChunk 时，本回合**不再聚合完整音频**（返回结果的 audio 为空
 * Buffer）——音频交给回调即时下发，省掉一份整轮副本的内存。
 * 需要完整音频的调用方不要传 onAudioChunk。
 */
export interface RealtimeTurnStreamHandlers {
  /** 收到一段助手语音（裸 PCM，采样率见 descriptor.outputSampleRate），seq 从 1 递增 */
  onAudioChunk?: (chunk: Buffer, seq: number) => void;
  /** 收到一段助手转录增量 */
  onTranscriptDelta?: (text: string) => void;
}

/** 一轮回合的产出。 */
export interface RealtimeTurnResult {
  /** 助手回复语音，裸 PCM16 单声道（采样率见 descriptor.outputSampleRate） */
  audio: Buffer;
  transcript: string;
  /** 引擎对我们输入音频的 ASR 结果（若下发） */
  asrText: string | null;
  /** 从回合开始到首段音频的毫秒数（未产生音频则 null） */
  firstAudioMs: number | null;
  totalMs: number;
}

/** 打开一条会话时的可选项（音色/人设/采样温度/输出上限）。 */
export interface RealtimeEngineOpenOptions {
  voiceId?: string;
  instructions?: string;
  temperature?: number;
  /** 部分引擎要求字符串类型（如 MiniMax），非法会被整体拒绝 */
  maxResponseOutputTokens?: string;
}

/**
 * 一条跨轮次复用的实时会话（连接）——引擎内部产物，会话层只看到这个面。
 *
 * 语义约定：
 *   - 同一时刻至多一轮 turn（调用方负责排队/拒绝）；
 *   - 连接死亡后实现自行标记，下一轮懒重连；
 *   - close() 幂等，且不得抛异常。
 */
export interface RealtimeEngineSession {
  /** 连接当前是否存活 */
  readonly alive: boolean;
  /**
   * 跑一轮回合。传 handlers.onAudioChunk 即进入流式模式：音频边到边交回调，
   * 返回值不再聚合（audio 为空 Buffer）。超时/出错应 reject，并自行丢弃连接。
   */
  turn(
    input: RealtimeTurnInput,
    timeoutMs?: number,
    handlers?: RealtimeTurnStreamHandlers,
  ): Promise<RealtimeTurnResult>;
  close(): void;
}

/**
 * 引擎端口：装配层通过它判可用性、开会话。
 *
 * 实现约定：isEnabled() 必须无副作用（装配层每次建会话都会调它），
 * 且不可抛异常——不可用就返回 false，由上层回退 pipeline 引擎。
 */
export interface RealtimeVoiceEngine {
  readonly descriptor: RealtimeEngineDescriptor;
  /** 引擎当前是否可用（已配置且未被禁用） */
  isEnabled(): boolean;
  /** 打开一条跨轮次复用的会话（不建立底层连接，懒连） */
  openSession(options?: RealtimeEngineOpenOptions): RealtimeEngineSession;
}
