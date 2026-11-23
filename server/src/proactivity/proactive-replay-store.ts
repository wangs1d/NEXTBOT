/**
 * ProactiveReplayStore —— 主动消息「落流补发」缓存（2026-11-23）。
 *
 * 缺口（本模块闭合）：提醒/主动消息到点时若设备离线，走厂商推送——但推送
 * 只是横幅，**对话流里没有记录**；若当时只有桌面在线，WS 直投也只到桌面。
 * 结果：手机重新打开 App，聊天里看不到这条提醒发生过（2026-11-23 01:51
 * 「该去睡觉啦」实证：调度准点执行、推送被限频丢弃、对话流零记录）。
 * TaskOutbox 只覆盖任务面结果，不覆盖主动消息——本模块补齐这一半。
 *
 * 契约：
 *   - 入箱（两条路都记，payload 带稳定 messageId = `proactive-<deliveryId>`）：
 *       ① WS 直投成功（delivery-service.deliver 成功分支）；
 *       ② 厂商推送送达（pipeline attemptOfflinePush 成功分支）。
 *   - 补投：客户端重连（ws/connection session.init）调用 replayFor，把近 24h
 *     条目按 FIFO 原样重发 `agent.proactive_message`，并附 `replay:true`：
 *     客户端只落气泡、**不再弹系统通知**（横幅在推送时已经弹过一次）。
 *   - 幂等：messageId 稳定 → 客户端本地历史按 (sessionId, messageId) upsert
 *     （IsarLocalHistoryStore.saveMessage，两端同源），重放不产生重复气泡。
 *   - 防泄漏：TTL 24h（一天没上线视为放弃）+ 每 actor 上限 20 条（超限丢最旧）。
 *   - 不 drain：同一条消息可能要补到多台设备（桌面/手机各自重连），
 *     由 TTL 淘汰，不做「取走即删」。
 */

import { readJson, writeJson } from "./persist-file.js";

export type ProactiveReplayEntry = {
  messageId: string;
  /** 完整事件 payload（agent.proactive_message 的 payload 字段对象），原样重放 */
  payload: Record<string, unknown>;
  at: number;
};

const ENTRY_TTL_MS = 24 * 60 * 60_000;
const MAX_PER_ACTOR = 20;

export class ProactiveReplayStore {
  private readonly entries = new Map<string, ProactiveReplayEntry[]>();
  private persistencePath: string | null = null;

  /** 启用落盘（bootstrap 调用一次）：重启前入箱未补投的条目照常补投。 */
  enablePersistence(path: string): void {
    this.persistencePath = path;
    const raw = readJson<Record<string, ProactiveReplayEntry[]>>(path, {});
    let restored = 0;
    const now = Date.now();
    for (const [actorId, queue] of Object.entries(raw)) {
      const alive = (queue ?? []).filter((e) => e?.messageId && e?.payload && now - (e.at ?? 0) <= ENTRY_TTL_MS);
      if (alive.length === 0) continue;
      this.entries.set(actorId, alive);
      restored += alive.length;
    }
    if (restored > 0) {
      console.log(`[ProactiveReplay] 待补投主动消息已恢复 ${restored} 条`);
      this.persist();
    }
  }

  private persist(): void {
    if (!this.persistencePath) return;
    const out: Record<string, ProactiveReplayEntry[]> = {};
    for (const [actorId, queue] of this.entries) {
      if (queue.length > 0) out[actorId] = queue;
    }
    writeJson(this.persistencePath, out);
  }

  /** 入箱：payload 必须已带稳定 messageId；同 messageId 去重。 */
  record(actorId: string, payload: Record<string, unknown>): void {
    if (!actorId) return;
    const messageId = String(payload.messageId ?? "");
    if (!messageId) return;
    let queue = this.entries.get(actorId);
    if (!queue) {
      queue = [];
      this.entries.set(actorId, queue);
    }
    if (queue.some((e) => e.messageId === messageId)) return;
    queue.push({ messageId, payload, at: Date.now() });
    if (queue.length > MAX_PER_ACTOR) queue.splice(0, queue.length - MAX_PER_ACTOR);
    this.persist();
  }

  /**
   * 重连补投：近 24h 条目按 FIFO 原样重发（附 replay:true），**不清空**——
   * 同一条消息可能要补到多台设备，由 TTL 淘汰。
   */
  replayFor(actorId: string, socket: { send(data: string): void }): number {
    this.pruneExpired();
    const queue = this.entries.get(actorId);
    if (!queue || queue.length === 0) return 0;
    let sent = 0;
    for (const entry of queue) {
      try {
        socket.send(
          JSON.stringify({
            type: "agent.proactive_message",
            payload: { ...entry.payload, replay: true },
          }),
        );
        sent += 1;
      } catch {
        // 单条失败不影响其余（连接级异常会整体断开，下轮重连再补）
      }
    }
    return sent;
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [actorId, queue] of this.entries) {
      const alive = queue.filter((e) => now - e.at <= ENTRY_TTL_MS);
      if (alive.length === 0) this.entries.delete(actorId);
      else if (alive.length !== queue.length) this.entries.set(actorId, alive);
    }
  }

  /** 供运维/测试：清空全部条目。 */
  reset(): void {
    this.entries.clear();
    this.persist();
  }
}

const globalForProactiveReplay = globalThis as unknown as { __proactiveReplayStore?: ProactiveReplayStore };

/** 进程级单例（与 TaskOutbox 同风格）。 */
export function getProactiveReplay(): ProactiveReplayStore {
  globalForProactiveReplay.__proactiveReplayStore ??= new ProactiveReplayStore();
  return globalForProactiveReplay.__proactiveReplayStore;
}
