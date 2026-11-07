// ── 工具执行「活人感」状态文案（原 agent/delegate-status.ts 的通用部分内联：
//     master 委派层删除后仅保留 live/tool_start 状态透传）──

type DelegateStatusPhase = "live" | "tool_start";

type DelegateStatusPayload = {
  phase: DelegateStatusPhase;
  /** 模型生成的口语化短句，直接展示给用户 */
  line: string;
  toolName: string;
};

/**
 * 从工具参数（显式 userStatusLine / statusLine 字段）提取用户可见进度句。
 * 不透传 LLM 的自然语言前言（assistantPreamble）——那是过程通报，会刷屏 status。
 */
function pickToolUserStatusLine(
  input: Record<string, unknown>,
  _assistantPreamble?: string,
): string | null {
  const fromInput = String(input.userStatusLine ?? input.statusLine ?? "").trim();
  return fromInput.length > 0 ? fromInput : null;
}

function buildLiveAgentStatusPayload(
  line: string,
  phase: DelegateStatusPhase = "live",
  toolName = "agent",
): DelegateStatusPayload {
  return { phase, line, toolName };
}
import { getAgentRuntimeConfig } from "../agent/agent-runtime-config.js";
import { buildExecutionEventPayload } from "../agent/turn-events.js";
import type { ToolExecutedInfo, ToolExecuteStartInfo } from "../external-model/types.js";
import { ServerEventType } from "../protocol.js";
import { embodimentThinking } from "../services/agent-embodiment.js";
import { isScheduleMutationToolName } from "../tools/schedule-tool-names.js";
import { formatStatusForDisplay } from "../utils/text.js";
import { renderToolStatusLine } from "./tool-status-template.js";

export type ChatToolWireContext = {
  sessionId: string;
  traceId: string;
  assistantMessageId: string;
  send: (json: string) => void;
  /**
   * 「分阶段异步对话交互 v2」可选：tool_call 起始时间表（id → epoch ms），
   * 用于在 tool_result 阶段计算 elapsedMs。
   * 若调用方未传，elapsedMs 会默认 0。
   */
  toolStartedAt?: Map<string, number>;
};

/** 同 traceId 内单调递增的 eventId 计数器（避免引入全局单例，handler 退出即丢）。 */
let executionEventSeq = 0;
function nextExecutionEventId(): string {
  executionEventSeq += 1;
  return `evt-${Date.now()}-${executionEventSeq}`;
}

/** 「分阶段异步对话交互 v2」结构化执行事件发射。
 *  与 v1 tool.call / tool.result / chat.agent_status 并行存在，
 *  由 CHAT_TURN_PANEL_V2 开关控制是否下发。
 *  客户端按 kind 区分：tool_call / tool_result / agent_start / agent_done / log。 */
function sendExecutionEvent(
  ctx: ChatToolWireContext,
  kind:
    | "tool_call"
    | "tool_result"
    | "agent_start"
    | "agent_done"
    | "log",
  body: {
    thought?: string;
    toolCall?: Parameters<typeof buildExecutionEventPayload>[0]["toolCall"];
    toolResult?: Parameters<typeof buildExecutionEventPayload>[0]["toolResult"];
    agentStart?: Parameters<typeof buildExecutionEventPayload>[0]["agentStart"];
    agentDone?: Parameters<typeof buildExecutionEventPayload>[0]["agentDone"];
    log?: string;
  },
): void {
  if (!getAgentRuntimeConfig().turnPanelV2.enabled) return;
  ctx.send(
    JSON.stringify({
      type: ServerEventType.ChatExecutionEvent,
      payload: buildExecutionEventPayload({
        sessionId: ctx.sessionId,
        traceId: ctx.traceId,
        eventId: nextExecutionEventId(),
        kind,
        ...body,
      }),
    }),
  );
}

/** 摘要化工具入参（避免把大对象塞进 WS 协议）。 */
function summarizeArgs(input: Record<string, unknown>): string {
  try {
    const json = JSON.stringify(input);
    if (!json || json === "{}") return "";
    return json.length > 200 ? `${json.slice(0, 200)}…` : json;
  } catch {
    return "";
  }
}

/** 摘要化工具结果（取关键字段，文本超长截断）。 */
function summarizeResult(
  result: Record<string, unknown> | undefined,
): string | undefined {
  if (!result) return undefined;
  const text =
    typeof result.text === "string"
      ? result.text
      : typeof result.message === "string"
        ? result.message
        : typeof result.preview === "string"
          ? result.preview
          : "";
  if (!text) return undefined;
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

function sendAgentStatus(ctx: ChatToolWireContext, status: DelegateStatusPayload): void {
  const displayLine = formatStatusForDisplay(status.line);
  if (!displayLine) return;
  embodimentThinking(ctx.sessionId, ctx.send, displayLine, {
    phase: status.phase,
    source: "tool",
  });
  ctx.send(
    JSON.stringify({
      type: ServerEventType.ChatAgentStatus,
      payload: {
        sessionId: ctx.sessionId,
        messageId: ctx.assistantMessageId,
        traceId: ctx.traceId,
        phase: status.phase,
        line: displayLine,
        toolName: status.toolName,
      },
    }),
  );
  // v2：把 agent_status 同步下发为 execution_event(kind=log)，
  // 让 v1 自由文本链路和 v2 结构化链路并存；UI 端按开关决定渲染哪条。
  sendExecutionEvent(ctx, "log", { log: displayLine });
}

export function wireToolExecuteStart(ctx: ChatToolWireContext, info: ToolExecuteStartInfo): void {
  // 文案两条来源：模型自述（工具入参里的可选 userStatusLine）> 服务端确定性模板
  // （工具名 + 入参拼装，不依赖模型配合）。都没有就返回 null —— 客户端会退回
  // 自己的工具族映射表，不在协议层塞通用话术。
  const userStatusLine =
    pickToolUserStatusLine(info.input, info.assistantPreamble) ??
    renderToolStatusLine(info.toolName, info.input);
  if (userStatusLine) {
    embodimentThinking(ctx.sessionId, ctx.send, userStatusLine, {
      phase: "tool_start",
      source: "tool",
    });
  }
  ctx.send(
    JSON.stringify({
      type: ServerEventType.ToolCall,
      payload: {
        toolName: info.toolName,
        input: info.input,
        traceId: ctx.traceId,
        assistantPreamble: info.assistantPreamble,
        ...(userStatusLine ? { userStatusLine } : {}),
      },
    }),
  );
  // v2：结构化 tool_call 卡片
  sendExecutionEvent(ctx, "tool_call", {
    toolCall: {
      id: `${ctx.traceId}:${info.toolName}`,
      name: info.toolName,
      argsPreview: summarizeArgs(info.input),
    },
  });

  if (userStatusLine) {
    sendAgentStatus(ctx, buildLiveAgentStatusPayload(userStatusLine, "tool_start", info.toolName));
  }
}

function sendScheduleTasksChanged(ctx: ChatToolWireContext, result: Record<string, unknown>): void {
  const taskId = String(result.taskId ?? "").trim();
  if (!taskId) return;

  const actionRaw = String(result.action ?? "").trim();
  const action =
    actionRaw === "deleted" || actionRaw === "updated" || actionRaw === "created"
      ? actionRaw
      : "created";

  if (action === "deleted") {
    ctx.send(
      JSON.stringify({
        type: ServerEventType.ScheduleTasksChanged,
        payload: {
          sessionId: ctx.sessionId,
          traceId: ctx.traceId,
          action: "deleted",
          taskId,
        },
      }),
    );
    return;
  }

  const nextRunAt = String(result.nextRunAt ?? "").trim();
  if (!nextRunAt) return;
  ctx.send(
    JSON.stringify({
      type: ServerEventType.ScheduleTasksChanged,
      payload: {
        sessionId: ctx.sessionId,
        traceId: ctx.traceId,
        action,
        taskId,
        nextRunAt,
        title:
          result.reminderMessage && result.title === "AI 提醒任务"
            ? result.reminderMessage
            : result.title,
        kind: result.kind,
        reminderMessage: result.reminderMessage,
      },
    }),
  );
}

export function wireToolExecuted(ctx: ChatToolWireContext, info: ToolExecutedInfo): void {
  ctx.send(
    JSON.stringify({
      type: ServerEventType.ToolResult,
      payload: {
        toolName: info.toolName,
        ok: info.ok,
        result: info.result,
        traceId: ctx.traceId,
      },
    }),
  );
  // v2：结构化 tool_result 卡片
  const toolCallId = `${ctx.traceId}:${info.toolName}`;
  const startedAt = ctx.toolStartedAt?.get(toolCallId);
  const elapsedMs = startedAt ? Date.now() - startedAt : 0;
  if (startedAt != null) ctx.toolStartedAt?.delete(toolCallId);
  sendExecutionEvent(ctx, "tool_result", {
    toolResult: {
      id: toolCallId,
      name: info.toolName,
      preview: summarizeResult(info.result as Record<string, unknown> | undefined),
      ok: info.ok,
      elapsedMs,
    },
  });

  if (
    info.ok &&
    isScheduleMutationToolName(info.toolName) &&
    info.result.ok === true &&
    info.result.taskId
  ) {
    const normalized = info.toolName.replace(/_/g, ".");
    const action =
      normalized === "calendar.delete_task"
        ? "deleted"
        : normalized === "calendar.update_task"
          ? "updated"
          : "created";
    sendScheduleTasksChanged(ctx, {
      ...info.result,
      action,
    });
  }

}
