/**
 * 重启恢复 —— 被打断任务的收口推送 + 自动重跑（2026-09-23）。
 *
 * 缺口（本模块闭合）：TaskHub 启动清扫如实把非终态任务标 failed，但清扫发生在
 * bootstrap 时刻——既无 WS 连接也无 changeListener，终态信号无法送达；客户端
 * 重连快照又只补发活跃任务（activeRecords 排除 failed），于是「N 个任务后台
 * 进行中」状态带永远等不到收口，悬挂成僵尸。且任务本身并非自败，是被重启杀掉的。
 *
 * 策略（先派发、后收口；到达顺序仍是通知在前）：
 *   1. 重派：dispatchBackgroundTask 重启执行（goal/会话/回复锚点原样透传，
 *      restartCount+1；达 MAX_TASK_AUTO_RESTARTS 放弃——两度重启都没跑完的
 *      任务重跑大概率还是死，如实告知即可）。派发先行只为让收口文案能如实
 *      分叉"已重跑/没能重跑"；任务经并发闸排队 + LLM 时延，通知实际先到。
 *   2. 收口：沿该任务原本的结果通道（messageId 仍用 assistant-task-<原 taskId>）
 *      推 chat.assistant_done——客户端凭它落一条说明消息，同时把状态带上的
 *      该任务收口（_dismissTaskReceiptForMessage 按同一 messageId 规则移除）。
 *      在线直推；离线即丢弃，不重连补投（2026-11-24 用户拍板）。
 *
 * 分层：只依赖 TaskHub 单例与注入的派发/推送端口，不持有 socket。
 */

import { ServerEventType } from "../protocol.js";
import { getTaskHub, type TaskPlaneRecord } from "./task-hub.js";

/** 自动重跑代数上限：被打断后最多自动重跑 2 次，之后只收口不再重派。 */
export const MAX_TASK_AUTO_RESTARTS = 2;

/** 派发端口（结构化最小接口，真实实现为 AgentCore.dispatchBackgroundTask）。 */
export type TaskDispatchPort = {
  dispatchBackgroundTask(
    actorId: string,
    input: {
      sessionId?: string;
      chatUserMessageId?: string;
      goal: string;
      source?: string;
      restartCount?: number;
    },
  ): string | null;
};

/** 推送端口（结构化最小接口，真实实现为 WsConnectionRegistry）。 */
export type RecoveryPushPort = {
  trySend(actorId: string, data: string): boolean;
};

export type InterruptedTaskRecoveryDeps = {
  agentCore: TaskDispatchPort | null;
  registry: RecoveryPushPort | null;
};

export type InterruptedTaskRecoveryResult = {
  /** 检查的被打断任务数（不含静默任务） */
  interrupted: number;
  /** 成功重派的任务数 */
  restarted: number;
  /** 收口通知送达（直推成功或已入箱）的任务数 */
  notified: number;
};

function pushClosureNotice(
  registry: RecoveryPushPort | null,
  sessionId: string,
  messageId: string,
  finalText: string,
): boolean {
  const frame = JSON.stringify({
    type: ServerEventType.ChatAssistantDone,
    payload: {
      sessionId,
      messageId,
      finalText,
      toolCalls: [],
      source: "task_plane",
    },
  });
  try {
    // 离线未送达即丢弃这一路（2026-11-24：重连不补投旧内容）。
    // 收口任务本身已标 failed/重派，结果不依赖这条通知的送达。
    registry?.trySend(sessionId, frame);
  } catch {
    /* 直推失败不补投 */
  }
  return true;
}

function closureText(rec: TaskPlaneRecord, restartedTaskId: string | null): string {
  const goal = rec.goal.length > 40 ? `${rec.goal.slice(0, 40)}…` : rec.goal;
  return restartedTaskId
    ? `「${goal}」这件事没跑完——服务器重启把它打断了，我已经重新开始办，好了告诉你。`
    : `「${goal}」这件事没跑完——服务器重启把它打断了，这次没能自动重跑；你说一声，我马上重新办。`;
}

/**
 * 处理启动清扫拦下的全部被打断任务：重派 + 收口推送。
 * 幂等：TaskHub.drainInterruptedOnRestore 取走即清空，重复调用为无操作。
 */
export function recoverInterruptedTasks(
  deps: InterruptedTaskRecoveryDeps,
): InterruptedTaskRecoveryResult {
  const interrupted = getTaskHub().drainInterruptedOnRestore();
  const result: InterruptedTaskRecoveryResult = { interrupted: 0, restarted: 0, notified: 0 };
  for (const rec of interrupted) {
    // 静默任务（原地同步轻任务）不广播不出箱：它的宿主对话轮随旧进程一起死了，
    // 客户端看到的是那一轮回复失败，不存在悬挂的任务状态带。
    if (rec.quiet) continue;
    result.interrupted += 1;
    const restartCount = rec.restartCount ?? 0;
    let restartedTaskId: string | null = null;
    if (restartCount < MAX_TASK_AUTO_RESTARTS) {
      try {
        restartedTaskId =
          deps.agentCore?.dispatchBackgroundTask(rec.sessionId, {
            sessionId: rec.sessionId,
            ...(rec.replyAnchorId ? { chatUserMessageId: rec.replyAnchorId } : {}),
            goal: rec.goal,
            source: "task.restart",
            restartCount: restartCount + 1,
          }) ?? null;
      } catch {
        restartedTaskId = null;
      }
    }
    if (restartedTaskId) {
      result.restarted += 1;
      console.info(
        `[TaskRecovery] 被打断任务已自动重跑 ${rec.taskId} → ${restartedTaskId} (goal=${rec.goal.slice(0, 60)})`,
      );
    }
    pushClosureNotice(
      deps.registry,
      rec.sessionId,
      `assistant-task-${rec.taskId}`,
      closureText(rec, restartedTaskId),
    );
    result.notified += 1;
  }
  return result;
}

/**
 * 装配启动恢复例程（bootstrap 末尾调用一次）：延迟 deferMs 等连接/Provider
 * 就绪后统一收口。定时器 unref，不阻塞进程退出；异常只记日志不反噬启动。
 */
export function scheduleInterruptedTaskRecovery(
  deps: InterruptedTaskRecoveryDeps,
  deferMs = 5_000,
): void {
  const timer = setTimeout(() => {
    try {
      const r = recoverInterruptedTasks(deps);
      if (r.interrupted > 0) {
        console.log(
          `[TaskRecovery] 重启恢复完成：打断 ${r.interrupted} 条，重跑 ${r.restarted} 条，收口推送 ${r.notified} 条`,
        );
      }
    } catch (err) {
      console.warn(`[TaskRecovery] 重启恢复失败（不影响服务）:`, err);
    }
  }, deferMs);
  if (typeof timer.unref === "function") timer.unref();
}
