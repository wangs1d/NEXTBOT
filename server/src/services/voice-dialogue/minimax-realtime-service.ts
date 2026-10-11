import WebSocket from "ws";

import type {
  RealtimeTurnInput,
  RealtimeTurnResult,
  RealtimeTurnStreamHandlers,
} from "../voice-duplex/realtime-engine-port.js";

/**
 * 回合相关契约（输入 / 结果 / 流式回调）的权威定义在端口
 * `voice-duplex/realtime-engine-port.ts`：上层（会话层 / 装配层）依赖端口，
 * 不依赖厂商模块。此处再导出仅为兼容既有 import 路径，新代码请直接引端口。
 */
export type {
  RealtimeTurnInput,
  RealtimeTurnResult,
  RealtimeTurnStreamHandlers,
  /** @deprecated 用 RealtimeTurnStreamHandlers */
  RealtimeTurnStreamHandlers as TurnStreamHandlers,
} from "../voice-duplex/realtime-engine-port.js";

/**
 * MiniMax Realtime API（实时交互，端到端语音对话）客户端。
 *
 * 端点 wss://api.minimaxi.com/ws/v1/realtime，协议为 OpenAI Realtime 兼容：
 * - 连接后服务端先下发 session.created（默认模型 abab6.5s-chat，内置 ASR asr-01）
 * - session.update 设置音色/指令；注意 max_response_output_tokens 必须是字符串
 * - 输入 PCM16 单声道 16kHz，input_audio_buffer.append → commit → response.create
 * - 输出 PCM16 单声道 24kHz（response.audio.delta 逐段 base64），文字转录同步下发
 * - 不支持 server_vad 自动断句（下发 turn_detection 会被忽略），必须手动 commit
 *
 * 实测结论（2026-09-27）：commit→首包语音约 1.3~2.4s，整轮回复 3~5s。
 */
export const MINIMAX_REALTIME_OUTPUT_SAMPLE_RATE = 24000;
export const MINIMAX_REALTIME_INPUT_SAMPLE_RATE = 16000;

/**
 * 输入音频的推送块大小（3200B = 16kHz × 2B × 100ms）。
 */
export const REALTIME_INPUT_CHUNK_BYTES = 3200;

/**
 * 块间推送间隔（毫秒）。
 *
 * 原实现固定 sleep 20ms 来"模拟实时速率"，但音频是 VAD 断句后一次性送来的
 * 整句，这段等待会随句长线性叠加到用户感知的响应延迟上——3 秒的话白等
 * 600ms，10 秒白等 2s，纯粹是自己为难自己。
 *
 * 这里只保留"别瞬时灌爆上游"的最小节流。可用
 * MINIMAX_REALTIME_INPUT_PACE_MS 覆盖（设 0 = 尽快推完）。
 */
export const REALTIME_INPUT_CHUNK_DELAY_MS = (() => {
  const raw = process.env.MINIMAX_REALTIME_INPUT_PACE_MS?.trim();
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : 4;
})();

export interface RealtimeSocketLike {
  send(data: string): void;
  close(): void;
  onOpen(cb: () => void): void;
  onMessage(cb: (data: string) => void): void;
  onError(cb: (err: Error) => void): void;
  onClose(cb: (code: number, reason: string) => void): void;
}

export interface RealtimeSessionConfig {
  voiceId?: string;
  instructions?: string;
  temperature?: number;
  /** 服务端字段类型为 string，传数字会被整体拒绝 */
  maxResponseOutputTokens?: string;
}

function defaultSocketFactory(apiKey: string): () => RealtimeSocketLike {
  return () => {
    const ws = new WebSocket("wss://api.minimaxi.com/ws/v1/realtime", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    return {
      send: (data) => ws.send(data),
      close: () => ws.close(),
      onOpen: (cb) => ws.on("open", () => cb()),
      onMessage: (cb) =>
        ws.on("message", (data) => cb(data.toString("utf8"))),
      onError: (cb) => ws.on("error", (err) => cb(err)),
      onClose: (cb) => ws.on("close", (code, reason) => cb(code, reason?.toString() ?? "")),
    };
  };
}

interface ServerEvent {
  type: string;
  delta?: string;
  transcript?: string;
  error?: { type?: string; code?: number | string; message?: string };
  session?: Record<string, unknown>;
  response?: { status?: string };
}

/** 单条 realtime 会话：拿到底层 socket 后按协议事件推进。 */
export class MiniMaxRealtimeSession {
  private readonly handlers = {
    audioDelta: [] as Array<(chunk: Buffer) => void>,
    transcriptDelta: [] as Array<(text: string) => void>,
    transcriptDone: [] as Array<(text: string) => void>,
    asr: [] as Array<(text: string) => void>,
    responseDone: [] as Array<(status: string | undefined) => void>,
    error: [] as Array<(err: Error) => void>,
    close: [] as Array<(code: number, reason: string) => void>,
  };

  readonly sessionId: string | null;
  readonly defaultModel: string | null;

  /** 注册 onError 前到达的错误（如 session.update 被立刻拒绝），由 takeError 消费 */
  private firstError: Error | null = null;

  constructor(private readonly socket: RealtimeSocketLike, sessionCreated: ServerEvent) {
    this.sessionId = (sessionCreated.session?.id as string) ?? null;
    this.defaultModel = (sessionCreated.session?.model as string) ?? null;
    socket.onMessage((raw) => this.handleMessage(raw));
    socket.onClose((code, reason) => this.handlers.close.forEach((cb) => cb(code, reason)));
  }

  onAudioDelta(cb: (chunk: Buffer) => void): void {
    this.handlers.audioDelta.push(cb);
  }
  onTranscriptDelta(cb: (text: string) => void): void {
    this.handlers.transcriptDelta.push(cb);
  }
  onTranscriptDone(cb: (text: string) => void): void {
    this.handlers.transcriptDone.push(cb);
  }
  onAsr(cb: (text: string) => void): void {
    this.handlers.asr.push(cb);
  }
  onResponseDone(cb: (status: string | undefined) => void): void {
    this.handlers.responseDone.push(cb);
  }
  onError(cb: (err: Error) => void): void {
    this.handlers.error.push(cb);
  }

  /** 取走（并清除）注册 onError 回调之前到达的第一条错误。 */
  takeError(): Error | null {
    const e = this.firstError;
    this.firstError = null;
    return e;
  }
  onClose(cb: (code: number, reason: string) => void): void {
    this.handlers.close.push(cb);
  }

  updateSession(config: RealtimeSessionConfig): void {
    const session: Record<string, unknown> = {};
    if (config.voiceId) session.voice = config.voiceId;
    if (config.instructions) session.instructions = config.instructions;
    if (config.temperature != null) session.temperature = config.temperature;
    if (config.maxResponseOutputTokens != null) {
      session.max_response_output_tokens = config.maxResponseOutputTokens;
    }
    this.socket.send(JSON.stringify({ type: "session.update", session }));
  }

  /** 追加一段 PCM16 16kHz 音频（base64） */
  appendAudio(pcm: Buffer): void {
    this.socket.send(JSON.stringify({ type: "input_audio_buffer.append", audio: pcm.toString("base64") }));
  }

  /** 文本输入一条 user 消息（status:completed 是服务端硬校验，缺了整条被拒）。 */
  sendTextItem(text: string): void {
    this.socket.send(
      JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          status: "completed",
          content: [{ type: "input_text", text }],
        },
      }),
    );
  }

  commit(): void {
    this.socket.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
  }

  requestResponse(): void {
    this.socket.send(JSON.stringify({ type: "response.create" }));
  }

  close(): void {
    this.socket.close();
  }

  private handleMessage(raw: string): void {
    let evt: ServerEvent;
    try {
      evt = JSON.parse(raw) as ServerEvent;
    } catch {
      return;
    }
    switch (evt.type) {
      case "response.audio.delta":
        if (evt.delta) {
          const chunk = Buffer.from(evt.delta, "base64");
          this.handlers.audioDelta.forEach((cb) => cb(chunk));
        }
        break;
      case "response.audio_transcript.delta":
        if (evt.delta) this.handlers.transcriptDelta.forEach((cb) => cb(evt.delta ?? ""));
        break;
      case "response.audio_transcript.done":
        this.handlers.transcriptDone.forEach((cb) => cb(evt.transcript ?? ""));
        break;
      case "conversation.item.input_audio_transcription.completed":
        this.handlers.asr.forEach((cb) => cb(evt.transcript ?? ""));
        break;
      case "response.done":
        this.handlers.responseDone.forEach((cb) => cb(evt.response?.status));
        break;
      case "error": {
        const e = evt.error ?? {};
        const err = new Error(`MiniMax Realtime 错误 (${e.code}): ${e.message ?? "unknown"}`);
        this.firstError ??= err;
        this.handlers.error.forEach((cb) => cb(err));
        break;
      }
      default:
        break;
    }
  }
}

export class MiniMaxRealtimeService {
  readonly name = "minimax-realtime";

  private readonly apiKey: string;
  private readonly defaultVoice: string;
  private readonly defaultInstructions: string;
  private readonly createSocket: () => RealtimeSocketLike;

  constructor(createSocket?: () => RealtimeSocketLike, env: NodeJS.ProcessEnv = process.env) {
    this.apiKey = env.MINIMAX_API_KEY?.trim() ?? "";
    this.defaultVoice = env.MINIMAX_REALTIME_VOICE?.trim() ?? env.MINIMAX_TTS_VOICE?.trim() ?? "female-shaonv";
    this.defaultInstructions =
      env.MINIMAX_REALTIME_INSTRUCTIONS?.trim() ?? "你是用户的桌面语音助手，说话简短自然口语化，每次不超过三句话。";
    this.createSocket = createSocket ?? defaultSocketFactory(this.apiKey);
  }

  isEnabled(): boolean {
    return !!this.apiKey;
  }

  /** 打开一个跨轮次复用连接的串行回合客户端（纯语音模式整段会话共用一条 realtime 连接）。 */
  openPersistentClient(config?: RealtimeSessionConfig): PersistentRealtimeClient {
    return new PersistentRealtimeClient(this, {
      voiceId: config?.voiceId ?? this.defaultVoice,
      instructions: config?.instructions ?? this.defaultInstructions,
      temperature: config?.temperature,
      maxResponseOutputTokens: config?.maxResponseOutputTokens ?? "1024",
    });
  }

  /**
   * 建立一条 realtime 会话并完成 session.update。
   * 供后续全双工语音模式复用：拿到 session 后自行驱动 append/commit 与音频回调。
   */
  async connect(config?: RealtimeSessionConfig, timeoutMs = 15000): Promise<MiniMaxRealtimeSession> {
    if (!this.isEnabled()) {
      throw new Error("MiniMax Realtime 未配置：请设置 MINIMAX_API_KEY");
    }
    const socket = this.createSocket();
    return await new Promise<MiniMaxRealtimeSession>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("MiniMax Realtime 连接超时"));
        socket.close();
      }, timeoutMs);
      socket.onError((err) => {
        clearTimeout(timer);
        reject(new Error(`MiniMax Realtime 连接失败: ${err.message}`));
      });
      socket.onMessage((raw) => {
        try {
          const evt = JSON.parse(raw) as ServerEvent;
          if (evt.type === "session.created") {
            clearTimeout(timer);
            const session = new MiniMaxRealtimeSession(socket, evt);
            session.updateSession({
              voiceId: config?.voiceId ?? this.defaultVoice,
              instructions: config?.instructions ?? this.defaultInstructions,
              temperature: config?.temperature,
              maxResponseOutputTokens: config?.maxResponseOutputTokens ?? "1024",
            });
            resolve(session);
          }
        } catch {
          // 非 JSON 帧忽略
        }
      });
      socket.onOpen(() => {
        // 等 session.created，见 onMessage
      });
    });
  }

  /**
   * 一次性对话回合：整段用户语音（PCM16 16kHz）进 → 助手语音+转录出。
   * 内部按 100ms 分片快放喂入（4x 实时），commit 后等 response.done。
   */
  async dialogueTurn(
    inputPcm16k: Buffer,
    config?: RealtimeSessionConfig,
    timeoutMs = 45000,
  ): Promise<RealtimeTurnResult> {
    const startedAt = Date.now();
    const session = await this.connect(config, timeoutMs);

    return await new Promise<RealtimeTurnResult>((resolve, reject) => {
      const audioChunks: Buffer[] = [];
      let transcript = "";
      let asrText: string | null = null;
      let firstAudioMs: number | null = null;
      let settled = false;

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          session.close();
        } catch {
          // ignore
        }
        fn();
      };

      const timer = setTimeout(() => {
        finish(() => reject(new Error(`MiniMax Realtime 回合超时（${timeoutMs}ms）`)));
      }, timeoutMs);

      session.onError((err) => finish(() => reject(err)));
      // session.update 可能在注册回调前就被服务端拒绝（如字段非法），先消费早期错误
      const earlyError = session.takeError();
      if (earlyError) {
        finish(() => reject(earlyError));
        return;
      }
      session.onAudioDelta((chunk) => {
        if (firstAudioMs == null) firstAudioMs = Date.now() - startedAt;
        audioChunks.push(chunk);
      });
      session.onTranscriptDelta((text) => {
        transcript += text;
      });
      session.onTranscriptDone((text) => {
        if (text) transcript = text;
      });
      session.onAsr((text) => {
        asrText = text;
      });
      session.onResponseDone(() => {
        finish(() =>
          resolve({
            audio: Buffer.concat(audioChunks),
            transcript,
            asrText,
            firstAudioMs,
            totalMs: Date.now() - startedAt,
          }),
        );
      });

      // 100ms 分片（3200 字节 @16kHz 16bit），20ms 间隔 ≈ 4x 实时快放
      void (async () => {
        try {
          for (let i = 0; i < inputPcm16k.length; i += 3200) {
            session.appendAudio(inputPcm16k.subarray(i, i + 3200));
            await new Promise((r) => setTimeout(r, 20));
          }
          session.commit();
          session.requestResponse();
        } catch (err) {
          finish(() => reject(err instanceof Error ? err : new Error(String(err))));
        }
      })();
    });
  }
}

interface ActiveTurn {
  audioChunks: Buffer[];
  transcript: string;
  asrText: string | null;
  firstAudioMs: number | null;
  startedAt: number;
  timer: NodeJS.Timeout;
  resolve: (r: RealtimeTurnResult) => void;
  reject: (e: Error) => void;
  /** 流式增量回调（可选） */
  onAudioChunk?: (chunk: Buffer, seq: number) => void;
  onTranscriptDelta?: (text: string) => void;
  /** 已下发的音频块计数 */
  audioSeq: number;
}

/**
 * 跨轮次复用同一条 realtime 连接的串行回合客户端。
 *
 * - 纯语音模式整段会话期共用一条连接（上下文延续：追问"刚才说了什么"能答上）；
 * - 同一时刻至多一轮回合（调用方负责排队/拒绝）；
 * - 连接死亡自动标记，下一回合 ensureSession 懒重连。
 *
 * 文本输入协议坑：item 必须带 `status: "completed"`（服务端校验，缺了整条被拒）；
 * `response.cancel` 不支持（"event type not found"），打断只能靠调用方丢弃输出。
 */
export class PersistentRealtimeClient {
  private session: MiniMaxRealtimeSession | null = null;
  private connecting: Promise<MiniMaxRealtimeSession> | null = null;
  private current: ActiveTurn | null = null;

  constructor(
    private readonly service: MiniMaxRealtimeService,
    private readonly config: RealtimeSessionConfig,
  ) {}

  get alive(): boolean {
    return this.session != null;
  }

  /**
   * 跑一轮回合。timeout 到点判失败并丢弃连接（状态可疑不复用）。
   * 传 handlers.onAudioChunk 即进入流式模式：音频边到边交回调，返回值不再聚合。
   */
  async turn(
    input: RealtimeTurnInput,
    timeoutMs = 45000,
    handlers?: RealtimeTurnStreamHandlers,
  ): Promise<RealtimeTurnResult> {
    if (this.current) {
      throw new Error("上一回合仍在进行中");
    }
    const session = await this.ensureSession();
    const startedAt = Date.now();
    return await new Promise<RealtimeTurnResult>((resolve, reject) => {
      const active: ActiveTurn = {
        audioChunks: [],
        transcript: "",
        asrText: null,
        firstAudioMs: null,
        startedAt,
        timer: setTimeout(() => {
          this.current = null;
          this.dropSession();
          reject(new Error(`MiniMax Realtime 回合超时（${timeoutMs}ms）`));
        }, timeoutMs),
        resolve,
        reject,
        onAudioChunk: handlers?.onAudioChunk,
        onTranscriptDelta: handlers?.onTranscriptDelta,
        audioSeq: 0,
      };
      this.current = active;
      void this.dispatch(session, input).catch((err: unknown) => {
        if (this.current === active) {
          this.settle(active, null, err instanceof Error ? err : new Error(String(err)));
        }
      });
    });
  }

  close(): void {
    if (this.current) {
      this.settle(this.current, null, new Error("会话已关闭"));
    }
    this.dropSession();
  }

  private dropSession(): void {
    if (this.session) {
      try {
        this.session.close();
      } catch {
        // ignore
      }
    }
    this.session = null;
    this.connecting = null;
  }

  private async ensureSession(): Promise<MiniMaxRealtimeSession> {
    if (this.session) return this.session;
    this.connecting ??= this.service.connect(this.config).then((session) => {
      this.session = session;
      this.installHandlers(session);
      return session;
    });
    try {
      return await this.connecting;
    } catch (err) {
      this.connecting = null;
      throw err;
    }
  }

  private installHandlers(session: MiniMaxRealtimeSession): void {
    session.onAudioDelta((chunk) => {
      const t = this.current;
      if (!t) return;
      t.firstAudioMs ??= Date.now() - t.startedAt;
      // 流式模式：即时上交调用方下发，不再聚合整轮副本；否则照旧累积待 settle 返回
      if (t.onAudioChunk) {
        t.onAudioChunk(chunk, ++t.audioSeq);
      } else {
        t.audioChunks.push(chunk);
      }
    });
    session.onTranscriptDelta((text) => {
      const t = this.current;
      if (!t) return;
      t.transcript += text;
      t.onTranscriptDelta?.(text);
    });
    session.onTranscriptDone((text) => {
      const t = this.current;
      if (!t || !text) return;
      t.transcript = text; // done 帧是权威全文
    });
    session.onAsr((text) => {
      const t = this.current;
      if (!t || !text) return;
      t.asrText = text;
    });
    session.onResponseDone(() => {
      const t = this.current;
      if (!t) return;
      this.settle(t, {
        audio: Buffer.concat(t.audioChunks),
        transcript: t.transcript,
        asrText: t.asrText,
        firstAudioMs: t.firstAudioMs,
        totalMs: Date.now() - t.startedAt,
      });
    });
    session.onError((err) => {
      const t = this.current;
      if (t) {
        this.settle(t, null, err);
      } else {
        this.dropSession(); // 非回合期错误（如 session.update 被拒）：连接不可信
      }
    });
    session.onClose(() => {
      this.session = null;
      this.connecting = null;
      const t = this.current;
      if (t) {
        this.settle(t, null, new Error("realtime 连接已断开"));
      }
    });
  }

  private async dispatch(session: MiniMaxRealtimeSession, input: RealtimeTurnInput): Promise<void> {
    if (input.pcm16k && input.pcm16k.length > 0) {
      const pcm = input.pcm16k;
      for (let i = 0; i < pcm.length; i += REALTIME_INPUT_CHUNK_BYTES) {
        session.appendAudio(pcm.subarray(i, i + REALTIME_INPUT_CHUNK_BYTES));
        if (REALTIME_INPUT_CHUNK_DELAY_MS > 0) {
          await new Promise((r) => setTimeout(r, REALTIME_INPUT_CHUNK_DELAY_MS));
        }
      }
      session.commit();
    } else if (input.text?.trim()) {
      session.sendTextItem(input.text.trim());
    } else {
      throw new Error("回合输入为空（需要 text 或 pcm16k）");
    }
    session.requestResponse();
  }

  private settle(t: ActiveTurn, result: RealtimeTurnResult | null, error?: Error): void {
    if (this.current !== t) return;
    this.current = null;
    clearTimeout(t.timer);
    if (error) {
      // 回合失败后连接状态可疑，丢弃待下轮重连
      this.dropSession();
      t.reject(error);
    } else if (result) {
      t.resolve(result);
    }
  }
}
