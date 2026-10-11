import {
  MINIMAX_REALTIME_INPUT_SAMPLE_RATE,
  MINIMAX_REALTIME_OUTPUT_SAMPLE_RATE,
  MiniMaxRealtimeService,
  REALTIME_INPUT_CHUNK_BYTES,
  REALTIME_INPUT_CHUNK_DELAY_MS,
} from "../../voice-dialogue/minimax-realtime-service.js";
import type {
  RealtimeEngineDescriptor,
  RealtimeEngineOpenOptions,
  RealtimeEngineSession,
  RealtimeVoiceEngine,
} from "../realtime-engine-port.js";

/** 引擎实现名（回给客户端 session.ready.engine，仅作展示/日志用）。 */
export const MINIMAX_ENGINE_NAME = "minimax-realtime";

/**
 * MiniMax 云端端到端实时语音 → 端口适配器。
 *
 * 这一层是「厂商实现」与「端口」之间唯一的粘合点：MiniMaxRealtimeService /
 * PersistentRealtimeClient 是厂商 SDK 形态，端口是上层契约，本类负责把前者
 * 适配成后者（声明能力描述、收拢杀开关、把 openPersistentClient 暴露为
 * openSession）。换本地/其它云端引擎时，新增一个同类文件即可，本类不动。
 */
export class MiniMaxRealtimeEngine implements RealtimeVoiceEngine {
  readonly descriptor: RealtimeEngineDescriptor = {
    name: MINIMAX_ENGINE_NAME,
    inputSampleRate: MINIMAX_REALTIME_INPUT_SAMPLE_RATE,
    outputSampleRate: MINIMAX_REALTIME_OUTPUT_SAMPLE_RATE,
    inputChunkBytes: REALTIME_INPUT_CHUNK_BYTES,
    inputChunkDelayMs: REALTIME_INPUT_CHUNK_DELAY_MS,
    streamingTts: true,
  };

  private readonly service: MiniMaxRealtimeService;

  constructor(service: MiniMaxRealtimeService = new MiniMaxRealtimeService()) {
    this.service = service;
  }

  /**
   * 可用性 = 已配 key 且未被 `MINIMAX_REALTIME_DUPLEX_DISABLED=1` 全局关闭。
   *
   * 杀开关放在适配器内部：云端语音挂掉时需要一键切回本地 pipeline 引擎，
   * 而上层（装配/会话）不该知道「禁用」这件事是 MiniMax 专有的——它只会看到
   * 「这个引擎报不可用」，于是自动回退。这样其它引擎天然不受该开关影响。
   */
  isEnabled(): boolean {
    if (process.env.MINIMAX_REALTIME_DUPLEX_DISABLED?.trim() === "1") return false;
    return this.service.isEnabled();
  }

  openSession(options?: RealtimeEngineOpenOptions): RealtimeEngineSession {
    // PersistentRealtimeClient 天然满足 RealtimeEngineSession（alive/turn/close）
    return this.service.openPersistentClient(options);
  }
}
