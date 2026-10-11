/**
 * 全双工实时语音 —— WS 协议定义。
 *
 * 传输：单条 WebSocket（/ws/voice-duplex），全部为 JSON 文本帧
 * （音频以 base64 编码，16-bit 单声道 PCM；服务端 TTS 输出 mp3 base64）。
 * 选 JSON 文本帧而非二进制分帧：实现简单、Flutter/桌面端无歧义，
 * 音频块默认 100ms（16kHz 下约 3.2KB，base64 后 ~4.3KB）开销可接受。
 *
 * 交互模型（半双工轮流 + 打断）：
 *   client                              server
 *   session.start ────────────────────▶ session.ready（进入 listening）
 *   audio.chunk* ─────────────────────▶ （VAD / 流式 ASR）
 *     │  asr.partial* ◀────────────────│
 *   audio.end 或静音端点检测 ─────────▶ asr.final → thinking
 *     │  assistant.delta* ◀────────────│ （LLM 流式）
 *     │  tts.start / tts.chunk* ◀──────│ （流式 TTS：realtime 引擎（本地/云端）
 *     │                                 │   逐段下发 pcm，收到首段即开播；
 *     │                                 │   pipeline 引擎为整轮单块 wav）
 *   （speaking 期间 audio.chunk/interrupt）▶ 打断：丢弃后续合成 → listening
 *     │  tts.end / turn.completed ◀────│
 *   session.stop ─────────────────────▶ session.ended
 */

/** 会话状态机：idle → listening → thinking → speaking（→ listening…）。 */
export type DuplexSessionState = "idle" | "listening" | "thinking" | "speaking";

export interface DuplexSessionConfig {
  /** 客户端上行音频采样率（缺省 16000） */
  sampleRate: number;
  /** ASR 语言（缺省 zh） */
  language: string;
  /** TTS 音色 */
  voiceId?: string;
  /** 会话 ID（关联主对话线程；缺省由服务端生成） */
  sessionId?: string;
}

export type DuplexClientMessage =
  | {
      type: "session.start";
      sampleRate?: number;
      language?: string;
      voiceId?: string;
      sessionId?: string;
      /** 可选会话级 system prompt 覆盖 */
      systemPrompt?: string;
      /** 声纹闸：会话归属身份；该身份已注册声纹时必须通过说话人验证才可对话 */
      actorId?: string;
      /** 声纹闸：HTTP /voiceprint/verify 命中时签发的一次性说话人令牌 */
      speakerToken?: string;
    }
  | { type: "audio.chunk"; pcm: string }
  | { type: "audio.end" }
  | { type: "text.turn"; text: string }
  | { type: "interrupt" }
  | { type: "speaker.verify"; token: string }
  | { type: "session.stop" };

export type DuplexServerMessage =
  | {
      type: "session.ready";
      config: DuplexSessionConfig;
      streamingAsr: boolean;
      /**
       * 引擎实现名（如 "minimax-realtime"、未来本地/其它云端引擎名）。
       * 仅作展示与诊断用——客户端若要分支，请用 engineKind，勿匹配具体厂商名。
       */
      engine?: string;
      /**
       * 引擎类别：pipeline=本地三段式（ASR+LLM+TTS）；realtime=端到端实时引擎
       * （MiniMax 云端 / 本地实时模型 / 其它云端均属此类）。客户端据此判定本连接
       * 是否走实时语音主路径，从而与具体厂商解耦——换引擎无需改客户端。
       */
      engineKind?: "pipeline" | "realtime";
      /**
       * 是否以流式 PCM 分块下发语音：true 时 tts.chunk 为 format="pcm" 的裸 PCM
       * 片段（采样率见 sampleRate），客户端应边收边播（原生 PCM 流式）。false/缺省
       * 时维持旧行为（整轮单块 wav）。
       */
      streamingTts?: boolean;
    }
  | { type: "state"; state: DuplexSessionState }
  | { type: "asr.partial"; text: string }
  | { type: "asr.final"; text: string }
  | { type: "assistant.delta"; text: string }
  | { type: "assistant.completed"; text: string }
  | { type: "tts.start" }
  | {
      type: "tts.chunk";
      seq: number;
      audio: string;
      format: "mp3" | "wav" | "pcm";
      /** format="pcm" 时的裸流采样率（Hz）；wav/mp3 自带采样率，缺省 */
      sampleRate?: number;
    }
  | { type: "tts.end" }
  | { type: "turn.completed"; userText: string; assistantText: string }
  | { type: "error"; message: string; recoverable: boolean }
  | { type: "session.ended" };

export function parseClientMessage(raw: string): DuplexClientMessage | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const msg = parsed as { type?: string };
    switch (msg.type) {
      case "session.start":
      case "audio.chunk":
      case "audio.end":
      case "text.turn":
      case "interrupt":
      case "speaker.verify":
      case "session.stop":
        return parsed as DuplexClientMessage;
      default:
        return null;
    }
  } catch {
    return null;
  }
}
