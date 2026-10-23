/**
 * 任务面 → 对话面的 WS 广播出口（2026-09-08 前后台分工对话改造）。
 *
 * 职责：把 TaskHub 的生命周期变更（submit/state/progress）以
 * `chat.task_update` 推给客户端，供对话流内渲染轻量「任务回执」——
 * 无缝对话形态：回执原地更新状态，用户随时继续聊天，不打断任务。
 *
 * 回退开关：AGENT_TASK_PLANE_WS_EVENTS_ENABLED=0 时全部广播为无操作，
 * 客户端收不到事件即不渲染回执，行为与旧版完全一致（任务结果仍经
 * chat.assistant_done 落进对话流）。开关逐次广播时读取，改 env + 重启即回退。
 *
 * 分层：本模块只依赖 ClientPushPort 抽象端口（runtime 侧不持有 socket）；
 * 连接建立/重连场景由 ws/connection.ts 直接用 buildTaskUpdateEnvelope
 * 向新 socket 补发活跃任务快照。
 */

import { ServerEventType } from "@nextbot/agent-protocol";
import type { ChatTaskUpdatePayload } from "@nextbot/agent-protocol";
import type { ClientPushPort } from "../ports/client-push-port.js";
import type { TaskPlaneRecord } from "./task-hub.js";

/** 回退开关：显式 =0 时关闭（默认开启）。 */
export function isTaskPlaneWsEventsEnabled(): boolean {
  return process.env.AGENT_TASK_PLANE_WS_EVENTS_ENABLED !== "0";
}

/** 构造一条 chat.task_update 信封 JSON 文本（幂等全量快照，客户端可安全去重）。 */
export function buildTaskUpdateEnvelope(record: TaskPlaneRecord): string {
  const payload: ChatTaskUpdatePayload = {
    sessionId: record.sessionId,
    taskId: record.taskId,
    state: record.state,
    goal: record.goal,
    ...(record.progressLine ? { progressLine: record.progressLine } : {}),
    ...(record.replyAnchorId ? { replyAnchorId: record.replyAnchorId } : {}),
    startedAt: record.startedAt,
    elapsedMs: Math.max(0, Date.now() - record.startedAt),
  };
  return JSON.stringify({ type: ServerEventType.ChatTaskUpdate, payload });
}

/**
 * 经 push 端口向该会话全部在线设备广播任务变更；端口缺失/关闭开关/静默任务时为无操作。
 * quiet（2026-09-09）：原地同步执行的轻任务不出「任务回执」，只记账不广播。
 */
export function broadcastTaskUpdate(
  registry: Pick<ClientPushPort, "trySend"> | null | undefined,
  record: TaskPlaneRecord,
): void {
  if (!registry || !isTaskPlaneWsEventsEnabled() || record.quiet) return;
  try {
    registry.trySend(record.sessionId, buildTaskUpdateEnvelope(record));
  } catch {
    /* 广播失败不影响任务执行 */
  }
}
