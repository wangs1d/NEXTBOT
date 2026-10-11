/**
 * TaskOutbox —— 任务面结果的离线投递箱（2026-09-08）。
 *
 * 缺口（本模块闭合）：后台任务（dispatchBackgroundTask）完成后经
 * wsRegistry.trySend 推送 chat.assistant_done，用户离线时 trySend 返回
 * false，事件被静默丢弃；而客户端不拉取服务端 thread 历史——离线期间
 * 完成的结果在客户端视角永久丢失。
 *
 * 契约：
 *   - 入箱：pushDone 投递失败（离线/registry 缺失）时 enqueue；
 *   - 重放：客户端重连（ws/connection session.init 注册连接后）调用
 *     replayFor，按 FIFO 原样重推 chat.assistant_done（messageId 不变，
 *     客户端幂等）；
 *   - 防泄漏：入箱 TTL（默认 24h，过期丢弃——用户一天都没上线视为放弃）
 *     + 每会话上限（默认 20 条，超限丢最旧）；
 *   - 进程内单例（与 TaskHub 同风格）：执行中任务不随进程恢复，但**结果簿**
 *     可选落盘（enablePersistence，data/task-plane/task-outbox.json）——重启前
 *     已入箱未投递的结果重连后照常补投，不再随进程消亡。
 */

import { ServerEventType } from "../protocol.js";
import { readJson, writeJson } from "../proactivity/persist-file.js";

export type TaskOutboxEntry = {
  sessionId: string;
  messageId: string;
  finalText: string;
  /** 任务面媒体卡片：照片/视频结果与 finalText 同生命周期，重放必须原样携带。 */
  mediaCards?: Array<Record<string, unknown>>;
  /** 结构化摘要卡（CONTENT_SUMMARY 通道迁移）：与 finalText 同生命周期。 */
  summaryCard?: Record<string, unknown>;
  /** 「接下来你可以」接续建议：与 finalText 同生命周期，重放原样携带（可点胶囊）。 */
  followups?: string[];
  enqueuedAt: number;
};

const ENTRY_TTL_MS = 24 * 60 * 60_000;
const MAX_PER_SESSION = 20;

export class TaskOutbox {
  private readonly entries = new Map<string, TaskOutboxEntry[]>();
  /** 可选落盘（enablePersistence）：null=纯内存（默认，测试友好） */
  private persistencePath: string | null = null;

  /**
   * 启用落盘（bootstrap 调用一次）：加载历史待投递条目（过期照常剔除），
   * 后续入箱/取空即时写盘——结果条目低频，无需防抖。
   */
  enablePersistence(path: string): void {
    this.persistencePath = path;
    const raw = readJson<Record<string, TaskOutboxEntry[]>>(path, {});
    let restored = 0;
    const now = Date.now();
    for (const [sessionId, queue] of Object.entries(raw)) {
      const alive = (queue ?? []).filter((e) => e?.messageId && now - (e.enqueuedAt ?? 0) <= ENTRY_TTL_MS);
      if (alive.length === 0) continue;
      this.entries.set(sessionId, alive);
      restored += alive.length;
    }
    if (restored > 0) {
      console.log(`[TaskOutbox] 离线结果已恢复 ${restored} 条`);
      this.persist();
    }
  }

  private persist(): void {
    if (!this.persistencePath) return;
    const out: Record<string, TaskOutboxEntry[]> = {};
    for (const [sessionId, queue] of this.entries) {
      if (queue.length > 0) out[sessionId] = queue;
    }
    writeJson(this.persistencePath, out);
  }

  /** 投递失败入箱（同 messageId 去重——同一结果只补投一次）。 */
  enqueue(
    sessionId: string,
    entry: {
      messageId: string;
      finalText: string;
      mediaCards?: Array<Record<string, unknown>>;
      summaryCard?: Record<string, unknown>;
      followups?: string[];
    },
  ): void {
    if (!sessionId || !entry.messageId || !entry.finalText) return;
    let queue = this.entries.get(sessionId);
    if (!queue) {
      queue = [];
      this.entries.set(sessionId, queue);
    }
    if (queue.some((e) => e.messageId === entry.messageId)) return;
    queue.push({
      sessionId,
      messageId: entry.messageId,
      finalText: entry.finalText,
      ...(entry.mediaCards && entry.mediaCards.length > 0 ? { mediaCards: entry.mediaCards } : {}),
      ...(entry.summaryCard ? { summaryCard: entry.summaryCard } : {}),
      ...(entry.followups && entry.followups.length > 0 ? { followups: entry.followups } : {}),
      enqueuedAt: Date.now(),
    });
    if (queue.length > MAX_PER_SESSION) queue.splice(0, queue.length - MAX_PER_SESSION);
    this.persist();
  }

  /** 取出并清空该会话的待投递条目（FIFO）。 */
  drain(sessionId: string): TaskOutboxEntry[] {
    this.pruneExpired();
    const queue = this.entries.get(sessionId);
    if (!queue || queue.length === 0) return [];
    this.entries.delete(sessionId);
    this.persist();
    return queue;
  }

  /** 待投递条数（运维/测试观测）。 */
  pendingCount(sessionId: string): number {
    this.pruneExpired();
    return this.entries.get(sessionId)?.length ?? 0;
  }

  /**
   * 重连重放：把离线期间入箱的任务面结果按 FIFO 原样重推。
   * 事件格式与 dispatchBackgroundTask.pushDone 完全一致（含 source:
   * "task_plane"），客户端按普通 assistant 消息收尾入列表。
   */
  replayFor(sessionId: string, socket: { send(data: string): void }): number {
    const batch = this.drain(sessionId);
    for (const entry of batch) {
      try {
        socket.send(
          JSON.stringify({
            type: ServerEventType.ChatAssistantDone,
            payload: {
              sessionId,
              messageId: entry.messageId,
              finalText: entry.finalText,
              toolCalls: [],
              source: "task_plane",
              ...(entry.mediaCards && entry.mediaCards.length > 0
                ? { mediaCards: entry.mediaCards }
                : {}),
              ...(entry.summaryCard ? { summaryCard: entry.summaryCard } : {}),
              ...(entry.followups && entry.followups.length > 0
                ? { followups: entry.followups }
                : {}),
            },
          }),
        );
      } catch {
        // 单条失败重新入箱，剩余批次继续（部分网络抖动不吞结果）
        this.enqueue(sessionId, {
          messageId: entry.messageId,
          finalText: entry.finalText,
          mediaCards: entry.mediaCards,
          summaryCard: entry.summaryCard,
          followups: entry.followups,
        });
      }
    }
    return batch.length;
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [sessionId, queue] of this.entries) {
      const alive = queue.filter((e) => now - e.enqueuedAt <= ENTRY_TTL_MS);
      if (alive.length === 0) this.entries.delete(sessionId);
      else if (alive.length !== queue.length) this.entries.set(sessionId, alive);
    }
  }

  /** 供运维/测试：清空全部条目。 */
  reset(): void {
    this.entries.clear();
  }
}

const globalForTaskOutbox = globalThis as unknown as { __taskPlaneOutbox?: TaskOutbox };

/** 进程级单例。 */
export function getTaskOutbox(): TaskOutbox {
  globalForTaskOutbox.__taskPlaneOutbox ??= new TaskOutbox();
  return globalForTaskOutbox.__taskPlaneOutbox;
}
