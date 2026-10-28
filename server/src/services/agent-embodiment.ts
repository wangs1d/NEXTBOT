import { ServerEventType } from "../protocol.js";

/** 球形 Agent 视觉状态 — 与 agent-sphere-avatar 对齐 */
export type EmbodimentMood =
  | "idle"
  | "listening"
  | "thinking"
  | "happy"
  | "alert";

export type EmbodimentPatch = {
  mood?: EmbodimentMood;
  energy?: number;
  caption?: string | null;
  phase?: string;
  subAgentType?: string;
  subAgentDisplayName?: string;
  source?: string;
};

export type EmbodimentSender = (json: string) => void;

export function emitEmbodimentPatch(
  send: EmbodimentSender,
  sessionId: string,
  patch: EmbodimentPatch,
): void {
  send(
    JSON.stringify({
      type: ServerEventType.AgentEmbodimentPatch,
      payload: { sessionId, ...patch },
    }),
  );
}

export function embodimentListening(sessionId: string, send: EmbodimentSender): void {
  emitEmbodimentPatch(send, sessionId, {
    mood: "listening",
    energy: 0.65,
    caption: "正在聆听…",
    source: "user_message",
  });
}

export function embodimentThinking(
  sessionId: string,
  send: EmbodimentSender,
  caption: string,
  extra?: Pick<EmbodimentPatch, "phase" | "subAgentType" | "subAgentDisplayName" | "source">,
): void {
  emitEmbodimentPatch(send, sessionId, {
    mood: "thinking",
    energy: extra?.phase?.startsWith("delegate") ? 0.78 : 0.72,
    caption: caption || undefined,
    source: extra?.source ?? "agent_status",
    ...extra,
  });
}

export function embodimentHappy(sessionId: string, send: EmbodimentSender): void {
  emitEmbodimentPatch(send, sessionId, {
    mood: "happy",
    energy: 0.55,
    caption: null,
    source: "assistant_done",
  });
}

export function embodimentIdle(sessionId: string, send: EmbodimentSender): void {
  emitEmbodimentPatch(send, sessionId, {
    mood: "idle",
    energy: 0.5,
    caption: null,
    source: "idle",
  });
}

export function embodimentAlert(
  sessionId: string,
  send: EmbodimentSender,
  caption: string,
  source: string,
): void {
  emitEmbodimentPatch(send, sessionId, {
    mood: "alert",
    energy: 0.9,
    caption,
    source,
  });
}
