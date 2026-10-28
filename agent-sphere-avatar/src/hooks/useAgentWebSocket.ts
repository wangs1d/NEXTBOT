import { useCallback, useEffect, useRef, useState } from "react";
import {
  mapProcessingIdle,
  mapUserMessageSent,
  mapWsToAgentUpdate,
  resetWsMapperState,
} from "../bridge/ws-agent-mapper";
import type { AgentState, EmbodimentInteractAction, TaskEvent } from "../types/agent";
import { DEFAULT_AGENT_STATE } from "../types/agent";

const BASE_RECONNECT_MS = 1000;
const MAX_RECONNECT_MS = 30000;
const HEARTBEAT_INTERVAL_MS = 25000;
const HEARTBEAT_TIMEOUT_MS = 10000;

function resolveWsUrl(explicit?: string): string {
  if (explicit?.trim()) return explicit.trim();
  if (typeof window !== "undefined") {
    const u = new URL("/ws", window.location.href);
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    return u.href;
  }
  return "ws://127.0.0.1:3000/ws";
}

function resolveSessionId(explicit?: string): string {
  if (explicit?.trim()) return explicit.trim();
  const key = "pai_web_session_id";
  let id = localStorage.getItem(key);
  if (!id) {
    id = `web-${Date.now().toString(36)}`;
    localStorage.setItem(key, id);
  }
  return id;
}

function reconnectDelayMs(attempt: number): number {
  const exp = Math.min(MAX_RECONNECT_MS, BASE_RECONNECT_MS * 2 ** attempt);
  return exp + Math.random() * exp * 0.2;
}

interface UseAgentWebSocketOptions {
  wsUrl?: string;
  sessionId?: string;
  enabled?: boolean;
  onConnected?: () => void;
  onDisconnected?: () => void;
}

export function useAgentWebSocket(
  apply: (patch: Partial<AgentState>) => void,
  options: UseAgentWebSocketOptions = {},
) {
  const { wsUrl, sessionId, enabled = true, onConnected, onDisconnected } = options;
  const [connected, setConnected] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<number | null>(null);
  const heartbeatIntervalRef = useRef<number | null>(null);
  const heartbeatTimeoutRef = useRef<number | null>(null);
  const attemptRef = useRef(0);
  const applyRef = useRef(apply);
  const sessionRef = useRef(resolveSessionId(sessionId));
  const taskEventsRef = useRef<TaskEvent[]>([]);
  applyRef.current = apply;
  sessionRef.current = resolveSessionId(sessionId);

  useEffect(() => {
    if (!enabled) {
      setConnected(false);
      setReconnecting(false);
      return;
    }

    let disposed = false;
    const sid = sessionRef.current;
    const url = resolveWsUrl(wsUrl);
    resetWsMapperState();
    taskEventsRef.current = [];
    applyRef.current({ ...DEFAULT_AGENT_STATE });
    attemptRef.current = 0;

    const clearReconnectTimer = () => {
      if (reconnectRef.current != null) {
        window.clearTimeout(reconnectRef.current);
        reconnectRef.current = null;
      }
    };

    const clearHeartbeatTimers = () => {
      if (heartbeatIntervalRef.current != null) {
        window.clearInterval(heartbeatIntervalRef.current);
        heartbeatIntervalRef.current = null;
      }
      if (heartbeatTimeoutRef.current != null) {
        window.clearTimeout(heartbeatTimeoutRef.current);
        heartbeatTimeoutRef.current = null;
      }
    };

    const scheduleReconnect = () => {
      if (disposed) return;
      clearReconnectTimer();
      setReconnecting(true);
      const delay = reconnectDelayMs(attemptRef.current);
      attemptRef.current += 1;
      reconnectRef.current = window.setTimeout(() => {
        reconnectRef.current = null;
        connect();
      }, delay);
    };

    const startHeartbeat = (ws: WebSocket) => {
      clearHeartbeatTimers();
      const sendPing = () => {
        if (wsRef.current === ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "ping" }));
        }
        if (heartbeatTimeoutRef.current != null) {
          window.clearTimeout(heartbeatTimeoutRef.current);
        }
        heartbeatTimeoutRef.current = window.setTimeout(() => {
          heartbeatTimeoutRef.current = null;
          scheduleReconnect();
        }, HEARTBEAT_TIMEOUT_MS);
      };
      sendPing();
      heartbeatIntervalRef.current = window.setInterval(sendPing, HEARTBEAT_INTERVAL_MS);
    };

    const connect = () => {
      if (disposed) return;

      const existing = wsRef.current;
      if (
        existing &&
        (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)
      ) {
        return;
      }

      if (existing) {
        existing.close();
        wsRef.current = null;
      }

      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.addEventListener("open", () => {
        if (disposed || wsRef.current !== ws) return;
        attemptRef.current = 0;
        setReconnecting(false);
        setConnected(true);
        ws.send(JSON.stringify({ type: "session.init", payload: { sessionId: sid, userId: sid } }));
        onConnected?.();
        startHeartbeat(ws);
      });

      ws.addEventListener("close", () => {
        if (disposed) return;
        if (wsRef.current === ws) wsRef.current = null;
        clearHeartbeatTimers();
        setConnected(false);
        onDisconnected?.();
        scheduleReconnect();
      });

      ws.addEventListener("error", () => {
        if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) {
          ws.close();
        }
      });

      ws.addEventListener("message", (ev) => {
        let msg: { type: string; payload?: Record<string, unknown> };
        try {
          msg = JSON.parse(String(ev.data));
        } catch {
          return;
        }

        if (msg.type === "pong") {
          if (heartbeatTimeoutRef.current != null) {
            window.clearTimeout(heartbeatTimeoutRef.current);
            heartbeatTimeoutRef.current = null;
          }
          return;
        }

        if (msg.type === "chat.user_message") {
          applyRef.current(mapUserMessageSent());
          return;
        }

        const patch = mapWsToAgentUpdate(msg);
        if (patch) {
          if (patch.taskEvents && patch.taskEvents.length > 0) {
            taskEventsRef.current = [...taskEventsRef.current, ...patch.taskEvents];
            applyRef.current({ ...patch, taskEvents: taskEventsRef.current });
          } else {
            applyRef.current(patch);
          }
          if (patch.mood === "happy") {
            window.setTimeout(() => applyRef.current(mapProcessingIdle()), 1800);
          }
        }
      });
    };

    connect();

    return () => {
      disposed = true;
      clearReconnectTimer();
      clearHeartbeatTimers();
      setReconnecting(false);
      const ws = wsRef.current;
      wsRef.current = null;
      if (ws && ws.readyState !== WebSocket.CLOSED) {
        ws.close();
      }
    };
  }, [enabled, wsUrl, sessionId, onConnected, onDisconnected]);

  const sendInteract = useCallback(
    (action: EmbodimentInteractAction, text?: string) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return false;
      const sid = sessionRef.current;
      ws.send(
        JSON.stringify({
          type: "agent.embodiment.interact",
          payload: {
            sessionId: sid,
            userId: sid,
            action,
            ...(text ? { text } : {}),
          },
        }),
      );
      if (action === "wake" || action === "chat") {
        applyRef.current(mapUserMessageSent());
      }
      return true;
    },
    [],
  );

  const sendWake = useCallback(() => sendInteract("wake"), [sendInteract]);
  const sendChat = useCallback((text: string) => sendInteract("chat", text), [sendInteract]);
  const sendFocus = useCallback(() => sendInteract("focus"), [sendInteract]);

  /**
   * 桌宠实时反应（不经过 Embodiment）— 用于"用户拖动/旋转桌宠"这种非对话交互
   * 实时向 LLM 上报上下文，期望拿到一句即兴台词。
   * 返回 true 表示消息已发送。
   */
  const sendPetReaction = useCallback(
    (payload: Record<string, unknown>) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return false;
      const sid = sessionRef.current;
      ws.send(
        JSON.stringify({
          type: "pet.reaction",
          payload: { sessionId: sid, userId: sid, ts: Date.now(), ...payload },
        }),
      );
      return true;
    },
    [],
  );

  return {
    connected,
    reconnecting,
    sessionId: sessionRef.current,
    sendInteract,
    sendWake,
    sendChat,
    sendFocus,
    sendPetReaction,
  };
};
