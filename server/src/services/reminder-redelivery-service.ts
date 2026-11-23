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
  /** 已升级过系统推送的时刻（推送「受理」≠「送达」——条目仍保留待重连落流补投） */
  pushedAt?: number;
};

/**
 * 提醒类消息的稳定 messageId（2026-11-23）：与触发身份（taskId+runAt）绑定，
 * 与投递通道无关——推送升级 / 重连补投 / 在线直投共用同一个 id，
 * 客户端按 (sessionId, messageId) upsert 本地历史，天然幂等。
 */
export function reminderStableMessageId(taskId: string, runAt: string, preReminder: boolean): string {
  return `reminder-${taskId}:${runAt}${preReminder ? ":pre" : ""}`;
}

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
    // 2026-11-23 根修「补发没了」：先记账，再升级推送。旧实现推送受理成功即
    // return、不入队——但华为 80000000 只代表「受理」，token 失效(5)/限频(256)
    // 时消息被静默丢弃，回执是异步才回来的；结果弹窗没有、队列没有、打开 App
    // 也没有（用户实测「就算没有后台推送它都会补发的，现在也没了」）。
    // 现在：推送只是「升级尝试」，条目一律入队；手机重连时 flushForActor 落流
    // 补投（replay:true 不重复弹窗，稳定 messageId 不重复气泡）——推送真到了，
    // 补投也只是把对话流记录补齐；推送被丢了，这条就是唯一能看到的形态。
    const entry: MissedReminderEntry = {
      taskId: input.taskId,
      runAt: input.runAt,
      title: input.title,
      message: input.message,
      preReminder: input.preReminder,
      enqueuedAt: this.clock(),
    };
    list.push(entry);
    while (list.length > this.maxPerActor) {
      list.sort((a, b) => a.runAt.localeCompare(b.runAt));
      list.shift();
    }
    this.entries.set(input.actorId, list);
    this.dirty = true;
    this.flush();
    // 系统推送通道可用 → 立即升级推送（横幅先到；落流记录由重连补投兜底）
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
      if (result.ok) {
        entry.pushedAt = this.clock();
        this.dirty = true;
        this.flush();
        return "pushed";
      }
      console.log(
        `[ReminderRedelivery] 系统推送失败（已入队等重连补投）taskId=${input.taskId} reason=${result.reason ?? "unknown"}`,
      );
    }
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
          // 稳定 messageId（2026-11-23）：与在线直投/推送升级共用同一 id，
          // 客户端按 (sessionId, messageId) upsert——补投不产生重复气泡。
          messageId: reminderStableMessageId(entry.taskId, entry.runAt, entry.preReminder),
          title: entry.title || "提醒",
          text: entry.message,
          importance: "high",
          kind: "schedule_reminder",
          proposalId: `redelivery_${entry.taskId}`,
          source: "schedule",
          // 原定触发时刻（epoch ms）：客户端气泡按原时间落屏（2026-11-12 契约）
          firedAt: firedAtMs,
          // 补投语义（2026-11-23）：只落气泡、不再弹系统通知——横幅在推送
          // 升级时已经尝试过；此刻用户正打开 App 看着对话流，气泡即送达。
          replay: true,
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
