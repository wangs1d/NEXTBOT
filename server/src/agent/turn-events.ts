/**
 * 「分阶段异步对话交互 v2」事件发射器。
 *
 * 三个事件：chat.turn_started / chat.intent_detected / chat.execution_event。
 * 与 v1 的 chat.assistant_interim / chat.agent_status 并行存在，由
 * CHAT_TURN_PANEL_V2 开关决定是否实际下发。
 *
 * 设计要点：
 *   - 纯函数 + 闭包 send 回调，不依赖 AgentCore，方便在 chat-user-message
 *     handler 顶部注入。
 *   - traceId 单调递增的 eventId 由调用方传入；本模块不维护全局计数器，
 *     避免污染 unit test。
 *   - isStale 闸门由调用方在外层判断；本模块不做轮次校验，专注于"把事件
 *     按协议打包发出去"。
 */
import { ServerEventType } from "../protocol.js";
import type {
  ChatExecutionEventPayload,
  ChatExecutionKind,
  ChatIntentDetectedPayload,
  ChatIntentMode,
  ChatPlanStep,
  ChatSubAgentPlan,
  ChatTurnStartedPayload,
} from "../protocol.js";
import type { RouteDecision } from "./task-router.js";

/** 发送回调：handler 把 WS send 闭包传进来。 */
export type TurnEventSend = (json: string) => void;

export type TurnEventEmitter = {
  emitTurnStarted(payload: ChatTurnStartedPayload): void;
  emitIntentDetected(payload: ChatIntentDetectedPayload): void;
  emitExecutionEvent(payload: ChatExecutionEventPayload): void;
};

/** 执行平面 → 协议意图模式（chat=对话面；task=任务面）。 */
function planeToIntentMode(plane: RouteDecision["plane"]): ChatIntentMode {
  return plane;
}

export function createTurnEventEmitter(opts: {
  send: TurnEventSend;
  /** 开关：默认 off，灰度期间由 env 打开 */
  enabled: boolean;
  /** 日志前缀，便于在服务端日志里 grep */
  logTag?: string;
}): TurnEventEmitter {
  const { send, enabled } = opts;
  const tag = opts.logTag ?? "[turn-v2]";

  return {
    emitTurnStarted(payload) {
      if (!enabled) return;
      send(
        JSON.stringify({
          type: ServerEventType.ChatTurnStarted,
          payload,
        }),
      );
    },
    emitIntentDetected(payload) {
      if (!enabled) return;
      send(
        JSON.stringify({
          type: ServerEventType.ChatIntentDetected,
          payload,
        }),
      );
    },
    emitExecutionEvent(payload) {
      if (!enabled) return;
      send(
        JSON.stringify({
          type: ServerEventType.ChatExecutionEvent,
          payload,
        }),
      );
    },
  };
}

/**
 * 把 RouteDecision + 可选 plan/subAgents 打包成 ChatIntentDetectedPayload。
 * chat-user-message handler 在 emitIntentDetected 之前调用一次即可。
 */
export function buildIntentDetectedPayload(opts: {
  sessionId: string;
  traceId: string;
  /** 本轮归属线程键（2026-11-12 P1 多会话并发），透传到 wire。 */
  threadId?: string;
  decision: RouteDecision;
  plan?: ChatPlanStep[];
  subAgents?: ChatSubAgentPlan[];
}): ChatIntentDetectedPayload {
  return {
    sessionId: opts.sessionId,
    traceId: opts.traceId,
    ...(opts.threadId ? { threadId: opts.threadId } : {}),
    mode: planeToIntentMode(opts.decision.plane),
    reasons: opts.decision.reasons,
    plan: opts.plan,
    subAgents: opts.subAgents,
  };
}

/** ExecutionEvent 构造器，统一填 sessionId/traceId/at，避免调用方漏填。 */
export function buildExecutionEventPayload(opts: {
  sessionId: string;
  traceId: string;
  /** 本轮归属线程键（2026-11-12 P1 多会话并发），透传到 wire。 */
  threadId?: string;
  eventId: string;
  kind: ChatExecutionKind;
  at?: number;
  thought?: string;
  toolCall?: ChatExecutionEventPayload["toolCall"];
  toolResult?: ChatExecutionEventPayload["toolResult"];
  agentStart?: ChatExecutionEventPayload["agentStart"];
  agentDone?: ChatExecutionEventPayload["agentDone"];
  planStep?: ChatExecutionEventPayload["planStep"];
  log?: string;
}): ChatExecutionEventPayload {
  return {
    sessionId: opts.sessionId,
    traceId: opts.traceId,
    ...(opts.threadId ? { threadId: opts.threadId } : {}),
    eventId: opts.eventId,
    kind: opts.kind,
    at: opts.at ?? Date.now(),
    thought: opts.thought,
    toolCall: opts.toolCall,
    toolResult: opts.toolResult,
    agentStart: opts.agentStart,
    agentDone: opts.agentDone,
    planStep: opts.planStep,
    log: opts.log,
  };
}
