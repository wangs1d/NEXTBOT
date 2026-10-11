/**
 * 全双工实时语音抽象层 公共出口。
 */

export type {
  DuplexSessionState,
  DuplexSessionConfig,
  DuplexClientMessage,
  DuplexServerMessage,
} from "./protocol.js";
export { parseClientMessage } from "./protocol.js";
export { EndpointDetector, pcmToWav, type EndpointEvent } from "./endpoint-detector.js";
export { DuplexVoiceSession, type DuplexSessionDeps } from "./duplex-session.js";
export {
  VoiceDuplexService,
  type VoiceDuplexServiceDeps,
  type DuplexSocketLike,
} from "./voice-duplex-service.js";

// ── 端到端实时语音引擎端口（本地/云端换实现只依赖这一层）──
export type {
  RealtimeVoiceEngine,
  RealtimeEngineSession,
  RealtimeEngineDescriptor,
  RealtimeEngineOpenOptions,
  RealtimeTurnInput,
  RealtimeTurnResult,
  RealtimeTurnStreamHandlers,
} from "./realtime-engine-port.js";
export { RealtimeDuplexSession, type RealtimeDuplexSessionDeps } from "./realtime-duplex-session.js";
export { MiniMaxRealtimeEngine, MINIMAX_ENGINE_NAME } from "./engines/minimax-realtime-engine.js";
