/**
 * 错过提醒专用补投通道（2026-11-12 架构定稿，用户拍板「提醒不走主动消息管线」）。
 *
 * 背景：到点提醒的手机端离线补投此前借道主动消息管线（tier=must 提案挂起、
 * 等重连重仲裁）。问题：① 语义混用——管线本职是 AI 主动开口（后台扫描/频控/
 * 效用评估），提醒是用户点名要的必达事项，借道只用到"在场等待+重连投递"
 * 一项能力却背上退避序列/重裁决上限/发现层结算全套复杂度（实测重连后还要
 * 吃 60s~30min 退避延迟）；② 僵尸风险实证——无超时收口的挂起在 proposals.json
 * 里滞留 22 天（「该睡觉啦」），差点误投。
 *
 * 本通道只做一件事：到点时手机不在线 → 记账；手机 WS 重连 → 立即直投
 * （agent.proactive_message + firedAt 原定时刻，客户端气泡按原时间落屏，
 * 不冒充"刚刚发的"）。零频控、零退避、零仲裁。
 *
 * 结构性防误发：
 *   - dedupKey = taskId:runAt(:pre)：同一任务同一触发时刻只记一笔（幂等）；
 *   - 队列封顶：每 actor 上限 MAX_PER_ACTOR，超限丢最旧（信息已过时的极端兜底）；
 *   - 全部条目带 firedAt：不存在"无原时间、冒充新消息"的形态；
 *   - 投递成功才出队，失败（WS 断/推送失败）留在队列下次重连再试。
 */

import { readJson, writeJson } from "../proactivity/persist-file.js";

export type MissedReminderEntry = {
  taskId: string;
  /** 原定触发时刻 ISO（投递时转 epoch ms 放 payload.firedAt） */
  runAt: string;
  title: string;
  message: string;
  preReminder: boolean;
  enqueuedAt: number;
};

type PersistedShape = Record<string, MissedReminderEntry[]>;

export type ReminderRedeliveryDeps = {
  storePath: string;
  /** 手机端当前是否在线（wsConnectionRegistry.hasDeviceClass(actorId, "mobile")） */
  isMobileOnline: (actorId: string) => boolean;
  /** 定向手机端的 WS fan-out（wsConnectionRegistry.trySendToDeviceClasses） */
  trySendToDeviceClasses: (actorId: string, json: string, deviceClasses: string[]) => boolean;
  /** 手机系统推送（未配置/通道不可用 = undefined，离线一律入队等重连） */
  mobilePush?: {
    hasChannel(actorId: string): boolean;
    push(input: {
      actorId: string;
      title: string;
      body: string;
      importance: string;
      kind: string;
      deliveryId: string;
    }): Promise<{ ok: boolean; provider?: string; reason?: string }>;
  };
  maxPerActor?: number;
  now?: () => number;
};

export type EnqueueResult = "pushed" | "enqueued" | "duplicate";

export function reminderDedupKey(taskId: string, runAt: string, preReminder: boolean): string {
  return `${taskId}:${runAt}${preReminder ? ":pre" : ""}`;
}

const DEFAULT_MAX_PER_ACTOR = 50;

export class ReminderRedeliveryService {
  private readonly entries = new Map<string, MissedReminderEntry[]>();
  private dirty = false;
  private readonly maxPerActor: number;
  private readonly clock: () => number;
  private pushSeq = 0;

  constructor(private readonly deps: ReminderRedeliveryDeps) {
    this.maxPerActor = deps.maxPerActor ?? DEFAULT_MAX_PER_ACTOR;
    this.clock = deps.now ?? (() => Date.now());
    const raw = readJson<PersistedShape>(deps.storePath, {});
    for (const [actorId, list] of Object.entries(raw ?? {})) {
      if (Array.isArray(list) && list.length > 0) this.entries.set(actorId, list);
    }
  }

  flush(): void {
    if (!this.dirty) return;
    const out: PersistedShape = {};
    for (const [actorId, list] of this.entries) {
      if (list.length > 0) out[actorId] = list;
    }
    writeJson(this.deps.storePath, out);
    this.dirty = false;
  }

  /**
   * 到点提醒手机不在线时记账。有系统推送通道则直接升级推送（App 被杀也能收），
   * 推送失败/无通道才入队等 WS 重连。幂等：同 taskId+runAt(+pre) 重复提交合并。
   */
  async enqueue(input: {
    actorId: string;
    taskId: string;
    runAt: string;
    title: string;
    message: string;
    preReminder: boolean;
  }): Promise<EnqueueResult> {
    const key = reminderDedupKey(input.taskId, input.runAt, input.preReminder);
    const list = this.entries.get(input.actorId) ?? [];
    if (list.some((e) => reminderDedupKey(e.taskId, e.runAt, e.preReminder) === key)) {
      return "duplicate";
    }
    // 系统推送通道可用 → 立即升级推送（成功即达，不入队）
    const push = this.deps.mobilePush;
    if (push && push.hasChannel(input.actorId)) {
      const result = await push.push({
        actorId: input.actorId,
        title: input.title || "提醒",
        body: input.message,
        importance: "high",
        kind: "schedule_reminder",
        deliveryId: `dp_${this.clock().toString(36)}_rr${this.pushSeq++}`,
      });
      if (result.ok) return "pushed";
      console.log(
        `[ReminderRedelivery] 系统推送失败（入队等重连）taskId=${input.taskId} reason=${result.reason ?? "unknown"}`,
      );
    }
    const entry: MissedReminderEntry = {
      taskId: input.taskId,
      runAt: input.runAt,
      title: input.title,
      message: input.message,
      preReminder: input.preReminder,
      enqueuedAt: this.clock(),
    };
    list.push(entry);
    // 封顶：超限丢最旧（按 runAt 升序排，丢最早的触发）
    while (list.length > this.maxPerActor) {
      list.sort((a, b) => a.runAt.localeCompare(b.runAt));
      list.shift();
    }
    this.entries.set(input.actorId, list);
    this.dirty = true;
    return "enqueued";
  }

  /**
   * 手机 WS 重连钩子入口：手机在线才投（桌面在线不构成对手机的送达，
   * 2026-10-13 语义）。逐条按原定触发时刻升序投递，成功才出队。
   * 返回投递条数。事件形态与 delivery-service 的 agent.proactive_message
   * 完全一致（含 firedAt），客户端无感知差异。
   */
  flushForActor(actorId: string): number {
    const list = this.entries.get(actorId);
    if (!list || list.length === 0) return 0;
    if (!this.deps.isMobileOnline(actorId)) return 0;
    const sorted = [...list].sort((a, b) => a.runAt.localeCompare(b.runAt));
    let delivered = 0;
    for (const entry of sorted) {
      const firedAtMs = Number.isFinite(Date.parse(entry.runAt)) ? Date.parse(entry.runAt) : this.clock();
      const payload = {
        type: "agent.proactive_message",
        payload: {
          deliveryId: `d_${this.clock().toString(36)}_rr${this.pushSeq++}`,
          title: entry.title || "提醒",
          text: entry.message,
          importance: "high",
          kind: "schedule_reminder",
          proposalId: `redelivery_${entry.taskId}`,
          source: "schedule",
          // 原定触发时刻（epoch ms）：客户端气泡按原时间落屏（2026-11-12 契约）
          firedAt: firedAtMs,
          display: "popup",
        },
      };
      if (!this.deps.trySendToDeviceClasses(actorId, JSON.stringify(payload), ["mobile"])) {
        break; // 投递中途掉线：剩余条目留在队列，下次重连再试
      }
      delivered++;
    }
    if (delivered > 0) {
      const remaining = sorted.slice(delivered);
      if (remaining.length > 0) this.entries.set(actorId, remaining);
      else this.entries.delete(actorId);
      this.dirty = true;
    }
    return delivered;
  }

  /** 诊断接口用：待补投概览 */
  stats(): { actors: number; total: number } {
    let total = 0;
    for (const list of this.entries.values()) total += list.length;
    return { actors: this.entries.size, total };
  }

  listForActor(actorId: string): MissedReminderEntry[] {
    return [...(this.entries.get(actorId) ?? [])];
  }
}
