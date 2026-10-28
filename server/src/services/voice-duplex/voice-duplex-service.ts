import { RealtimeDuplexSession } from "./realtime-duplex-session.js";
import type { MiniMaxRealtimeService } from "../voice-dialogue/minimax-realtime-service.js";
import type { RealtimeVoiceEngine } from "./realtime-engine-port.js";
import { MiniMaxRealtimeEngine } from "./engines/minimax-realtime-engine.js";
import { parseClientMessage, type DuplexServerMessage } from "./protocol.js";
import { getVoiceprintService } from "../voice/voiceprint-service.js";

/**
 * 全双工实时语音 —— 会话管理 + WS 接入层（抽象层主体）。
 *
 * 职责：
 *   - 一条 WS 连接 = 一个会话（连接关闭即销毁）
 *   - 引擎选择：按注册的 RealtimeVoiceEngine 端口逐个判可用，命中即用端到端
 *     实时引擎（会话层 RealtimeDuplexSession）；识别与合成都在引擎侧完成。
 *     没有可用引擎时拒绝会话，不再回退本地 pipeline。
 *
 * 换本地/云端引擎 = 换 realtimeEngines 里的端口实现，本服务与协议层零改动。
 *
 * 客户端只需实现 protocol.ts 的 JSON 帧协议（参考
 * client/flutter_app/lib/core/services/voice_duplex_service.dart）。
 */

/** 最小 socket 面（fastify-websocket 的 ws socket 结构兼容）。 */
export interface DuplexSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "message", cb: (data: unknown) => void): void;
  on(event: "close", cb: () => void): void;
  on(event: "error", cb: (err: Error) => void): void;
}

export interface VoiceDuplexServiceDeps {
  /** 会话默认 system prompt（管家口语化短回复风格） */
  systemPrompt?: string;
  maxSessions?: number;
  /**
   * 端到端实时语音引擎注册表（端口实现）。按数组顺序取第一个 isEnabled() 的
   * 引擎；都不满足时拒绝会话（识别与合成均由引擎侧提供）。
   *
   * 接入本地引擎 / 换云端：实现 RealtimeVoiceEngine 端口后塞进这个数组即可，
   * 本服务与协议层、客户端均无需改动。
   */
  realtimeEngines?: RealtimeVoiceEngine[];
  /**
   * MiniMax 云端实时语音的便捷入口，等价于
   * `realtimeEngines: [new MiniMaxRealtimeEngine(minimaxRealtime)]`。
   * 引擎的可用性（含 MINIMAX_REALTIME_DUPLEX_DISABLED 杀开关）由适配器内部判定。
   *
   * @deprecated 新接线请用 realtimeEngines，本字段仅为既有调用方兼容保留。
   */
  minimaxRealtime?: MiniMaxRealtimeService;
  /**
   * 通话上下文注入：session.start 携带 sessionId=callId 时调用，
   * 返回该通电话的场景人设（来电汇报/用户来电），并入 realtime instructions。
   */
  callVoiceContext?: (callId: string) => string | null;
}

const DEFAULT_SYSTEM_PROMPT =
  "你是用户的私人管家，正在与用户进行实时语音对话。要求：回复口语化、简短（通常一两句话）、直接给出行动和结论，不要列表和标题；听不懂就简短追问。";

/** 引擎会话类型（当前仅 realtime 一种）。 */
type AnyDuplexSession = RealtimeDuplexSession;

export class VoiceDuplexService {
  private readonly sessions = new Map<DuplexSocketLike, AnyDuplexSession>();

  constructor(private readonly deps: VoiceDuplexServiceDeps) {}

  get sessionCount(): number {
    return this.sessions.size;
  }

  /** 接入一条 WS 连接（/ws/voice-duplex 路由回调里调用）。 */
  attach(socket: DuplexSocketLike): void {
    const max = this.deps.maxSessions ?? 16;
    if (this.sessions.size >= max) {
      socket.send(JSON.stringify({ type: "error", message: "语音会话数已达上限", recoverable: false } satisfies DuplexServerMessage));
      socket.close(1013, "max_sessions");
      return;
    }

    const sink = (msg: DuplexServerMessage): void => {
      try {
        socket.send(JSON.stringify(msg));
      } catch {
        // 连接已断：忽略
      }
    };

    let session: AnyDuplexSession | null = null;
    // 声纹闸（连接级状态）：会话声明了已注册声纹的 actorId 时，必须先通过
    // 说话人验证（speaker.verify 带一次性令牌）才允许对话帧，防绕过客户端闸。
    // 未声明 actorId（如电话通话路径）或该身份未注册声纹 → 不设闸（向后兼容）。
    let speaker: { actorId: string; needsVerification: boolean; verified: boolean } | null = null;
    socket.on("message", (data: unknown) => {
      const raw = typeof data === "string" ? data : data instanceof Buffer ? data.toString("utf8") : String(data ?? "");
      const msg = parseClientMessage(raw);
      if (!msg) {
        sink({ type: "error", message: "未知消息格式（应为 JSON 协议帧）", recoverable: true });
        return;
      }
      if (msg.type === "session.start") {
        if (session) {
          session.dispose();
          this.sessions.delete(socket);
        }
        const created = this.createSession(sink, msg.systemPrompt);
        if (!created) {
          sink({
            type: "error",
            message: "实时语音引擎不可用：请配置 MINIMAX_API_KEY（或在 realtimeEngines 注册可用引擎）",
            recoverable: false,
          });
          socket.close(1013, "no_realtime_engine");
          return;
        }
        session = created;
        this.sessions.set(socket, session);
        const actorId = msg.actorId?.trim();
        speaker =
          actorId && getVoiceprintService().status(actorId).registered
            ? { actorId, needsVerification: true, verified: false }
            : null;
      }
      if (msg.type === "speaker.verify") {
        const ok = speaker !== null && getVoiceprintService().consumeToken(msg.token, speaker.actorId);
        if (speaker) speaker.verified = ok;
        if (!ok) {
          sink({ type: "error", message: "声纹验证失败：令牌无效或身份不匹配", recoverable: false });
          socket.close(4003, "speaker_unverified");
          return;
        }
        return;
      }
      if (
        speaker?.needsVerification &&
        !speaker.verified &&
        (msg.type === "text.turn" || msg.type === "audio.chunk")
      ) {
        sink({ type: "error", message: "声纹未验证：请先通过说话人验证", recoverable: false });
        socket.close(4003, "speaker_unverified");
        return;
      }
      if (session) {
        void session.handle(msg).catch((err) => {
          sink({ type: "error", message: err instanceof Error ? err.message : String(err), recoverable: true });
        });
      }
    });
    const cleanup = (): void => {
      const s = this.sessions.get(socket);
      if (s) {
        s.dispose();
        this.sessions.delete(socket);
      }
    };
    socket.on("close", cleanup);
    socket.on("error", cleanup);
  }

  private createSession(
    sink: (msg: DuplexServerMessage) => void,
    systemPromptOverride?: string,
  ): RealtimeDuplexSession | null {
    const systemPrompt = systemPromptOverride || this.deps.systemPrompt || DEFAULT_SYSTEM_PROMPT;

    // 引擎选择：按端口注册表取第一个可用引擎。MiniMax 云端只是其中一个实现，
    // 换本地/其它云端 = 换 realtimeEngines，此处逻辑不动。
    const engine = this.resolveEngines().find((e) => e.isEnabled());
    if (!engine) return null;
    return new RealtimeDuplexSession(
      `vdx_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      sink,
      { engine, systemPrompt, callVoiceContext: this.deps.callVoiceContext },
    );
  }

  /** 端口注册表：显式引擎在前，MiniMax 便捷入口兜底（同一实例只包一层）。 */
  private resolveEngines(): RealtimeVoiceEngine[] {
    const engines: RealtimeVoiceEngine[] = [...(this.deps.realtimeEngines ?? [])];
    if (this.deps.minimaxRealtime) {
      engines.push(new MiniMaxRealtimeEngine(this.deps.minimaxRealtime));
    }
    return engines;
  }

  stopAll(): void {
    for (const session of this.sessions.values()) {
      void session.stop();
    }
    this.sessions.clear();
  }
}
