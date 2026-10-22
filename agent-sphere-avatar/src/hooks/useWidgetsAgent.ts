/**
 * 悬浮组件窗口专用 Agent WebSocket —— 轻量版。
 *
 * 与 useAgentWebSocket（完整对话映射）不同，这里只做两件事：
 *  1. 连接管理（心跳 + 断线重连）
 *  2. `pet.reaction` 台词请求 / `pet.reaction.ack` 关联（requestId 匹配）
 *
 * 台词一律由服务端 LLM 生成（无本地词库）；请求失败/超时返回 null，
 * 组件自行降级为功能文案，绝不本地编台词。
 */

import { useCallback, useEffect, useRef, useState } from "react";

export interface AgentLineContext {
  trigger: string;
  hour?: number;
  mood?: string;
  intensity?: number;
  region?: { v: "top" | "middle" | "bottom"; h: "left" | "center" | "right" };
  healthKind?: "sedentary" | "water" | "eye";
  stats?: {
    focusMinutes?: number;
    sessions?: number;
    streakDays?: number;
    offworkTime?: string;
  };
}

interface UseWidgetsAgentOptions {
  wsUrl?: string;
  sessionId?: string;
}

const BASE_RECONNECT_MS = 1500;
const MAX_RECONNECT_MS = 30000;
const HEARTBEAT_INTERVAL_MS = 25000;
const LINE_TIMEOUT_MS = 9000;

function resolveWsUrl(explicit?: string): string {
  if (explicit?.trim()) return explicit.trim();
  if (typeof window !== "undefined") {
    const u = new URL("/ws", window.location.href);
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    return u.href;
  }
  return "ws://127.0.0.1:3000/ws";
}

function reconnectDelayMs(attempt: number): number {
  const exp = Math.min(MAX_RECONNECT_MS, BASE_RECONNECT_MS * 2 ** attempt);
  return exp + Math.random() * exp * 0.2;
}

export function useWidgetsAgent(options: UseWidgetsAgentOptions = {}) {
  const { wsUrl, sessionId } = options;
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<number | null>(null);
  const heartbeatRef = useRef<number | null>(null);
  const attemptRef = useRef(0);
  const disposedRef = useRef(false);
  /** requestId → resolver：等待 pet.reaction.ack 的挂起请求 */
  const pendingLinesRef = useRef(new Map<string, (line: string | null) => void>());

  const resolveSessionId = useCallback((): string => {
    if (sessionId?.trim()) return sessionId.trim();
    const key = "pai_web_session_id";
    let id = localStorage.getItem(key);
    if (!id) {
      id = `web-${Date.now().toString(36)}`;
      localStorage.setItem(key, id);
    }
    return id;
  }, [sessionId]);

  useEffect(() => {
    disposedRef.current = false;

    const clearTimers = () => {
      if (reconnectRef.current != null) {
        window.clearTimeout(reconnectRef.current);
        reconnectRef.current = null;
      }
      if (heartbeatRef.current != null) {
        window.clearInterval(heartbeatRef.current);
        heartbeatRef.current = null;
      }
    };

    const scheduleReconnect = () => {
      if (disposedRef.current) return;
      const delay = reconnectDelayMs(attemptRef.current);
      attemptRef.current += 1;
      reconnectRef.current = window.setTimeout(connect, delay);
    };

    const connect = () => {
      if (disposedRef.current) return;
      const url = resolveWsUrl(wsUrl);
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.addEventListener("open", () => {
        if (disposedRef.current || wsRef.current !== ws) return;
        attemptRef.current = 0;
        setConnected(true);
        ws.send(
          JSON.stringify({
            type: "session.init",
            payload: { sessionId: resolveSessionId(), userId: resolveSessionId() },
          }),
        );
        heartbeatRef.current = window.setInterval(() => {
          if (wsRef.current === ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "ping" }));
          }
        }, HEARTBEAT_INTERVAL_MS);
      });

      ws.addEventListener("close", () => {
        if (disposedRef.current) return;
        if (wsRef.current === ws) wsRef.current = null;
        setConnected(false);
        if (heartbeatRef.current != null) {
          window.clearInterval(heartbeatRef.current);
          heartbeatRef.current = null;
        }
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
        if (msg.type !== "pet.reaction.ack") return;
        const p = msg.payload ?? {};
        const requestId = typeof p.requestId === "string" ? p.requestId : "";
        if (!requestId) return;
        const resolver = pendingLinesRef.current.get(requestId);
        if (!resolver) return;
        pendingLinesRef.current.delete(requestId);
        const text = p.ok === true ? String(p.text ?? "").trim() : "";
        resolver(text || null);
      });
    };

    connect();

    return () => {
      disposedRef.current = true;
      clearTimers();
      const ws = wsRef.current;
      wsRef.current = null;
      if (ws && ws.readyState !== WebSocket.CLOSED) ws.close();
      // 所有挂起的台词请求立即失败，避免组件悬挂在 loading 态
      for (const [, resolver] of pendingLinesRef.current) resolver(null);
      pendingLinesRef.current.clear();
    };
  }, [wsUrl, resolveSessionId]);

  /** 向 Agent 请求一句 LLM 台词；失败/超时/断线 → null */
  const requestLine = useCallback((ctx: AgentLineContext): Promise<string | null> => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.resolve(null);
    const requestId = `pl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => {
        pendingLinesRef.current.delete(requestId);
        resolve(null);
      }, LINE_TIMEOUT_MS);
      pendingLinesRef.current.set(requestId, (line) => {
        window.clearTimeout(timer);
        resolve(line);
      });
      ws.send(
        JSON.stringify({
          type: "pet.reaction",
          payload: { requestId, ts: Date.now(), ...ctx },
        }),
      );
    });
  }, []);

  return { connected, requestLine };
}
