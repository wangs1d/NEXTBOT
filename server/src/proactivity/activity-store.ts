// 代办足迹台账：Agent 主动代办与盯梢告知结果的唯一落库点
// （右侧面板「代办足迹」卡数据源）。
//
// 定位（2026-09-16 明确）：「可回溯的代办账本」而非通知流——通知实时性由对话流
// （proactive_pipeline fan-out 弹窗）承担，本台账只回答两类问题：
//   1. 执行类条目：「助手替我办的事办得怎么样了」（订牛奶/缴水电费/改日程…），
//      由 POST /agent/activities 在办完后上报，status 走
//      pending（进行中）→ done/failed（完结）；
//   2. 告知类条目：「助手替我盯到了什么」（日程变动等入站信号），投递成功后由
//      delivery 层自动落库，status=changed + statusLabel=「已告知」——它记录的
//      是「我告诉过你」而非「我办完了」，后续 Agent 真正代办（用户在对话中确认）
//      时由 POST /agent/activities 另行落一条执行类条目，两条构成「盯到 → 办完」的弧线。
// actorId 归一：一律按基础 actor（裸 id）归属，渠道 scoped 会话在触发器侧已剥回。
//
// 写入方：
//  1. ProactiveDeliveryService 投递成功后，kind 以 "action." 开头的提案自动落库（告知类）；
//  2. POST /agent/activities（执行类，可携带结构化 detail）。
// 持久化：单 JSON 文件（persist-file 原子替换），每个 actor 最多保留 MAX_PER_ACTOR 条。
import { readJson, writeJson } from "./persist-file.js";

export type AgentActivityStatus = "pending" | "done" | "failed" | "changed";

export type AgentActivity = {
  id: string;
  actorId: string;
  /** 动作类型：action.purchase / action.payment / action.schedule / ... */
  kind: string;
  /** 展示分类（由 kind 推导）：purchase / payment / schedule / generic，客户端据此选图标 */
  category: string;
  title: string;
  summary: string;
  status: AgentActivityStatus;
  /** 状态文案（配送中 / 已完成 / 已改期...）；缺省时客户端按 status 推导 */
  statusLabel?: string;
  /** 详情键值对（商品 / 金额 / 渠道...），点击条目的详情浮层展示 */
  detail?: Record<string, string>;
  createdAt: number;
  readAt: number | null;
  /** 指纹键：与提案 dedupKey 对齐，避免重连重投导致重复记录 */
  dedupKey?: string;
};

export type RecordActivityInput = {
  actorId: string;
  kind: string;
  title: string;
  summary: string;
  status?: AgentActivityStatus;
  statusLabel?: string;
  detail?: Record<string, string>;
  dedupKey?: string;
};

const MAX_PER_ACTOR = 200;
/** 同一 dedupKey 在该窗口内不重复记录（重连重投保护） */
const DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000;

export class AgentActivityStore {
  private activities: AgentActivity[];
  private seq = 0;
  /**
   * 新条目钩子（装配层注入：向该 actor 的在线设备推 agent.activity_new，驱动
     客户端足迹卡即时刷新，替代 1 分钟轮询的滞后）。异常由调用方兜底，不落库主链路。
   */
  onRecord?: (activity: AgentActivity) => void;

  constructor(private readonly filePath: string) {
    this.activities = readJson<AgentActivity[]>(filePath, []);
  }

  private persist(): void {
    writeJson(this.filePath, this.activities);
  }

  /** 由动作类提案推导展示分类：action.payment -> payment */
  static categoryOf(kind: string): string {
    const rest = kind.startsWith("action.") ? kind.slice("action.".length) : kind;
    const head = rest.split(/[._-]/)[0]?.trim().toLowerCase() ?? "";
    return head.length > 0 ? head : "generic";
  }

  /** 未显式给 status 时按 kind 推导：schedule_change 类是「已调整」而非「已完成」 */
  static statusFromKind(kind: string): AgentActivityStatus {
    if (/(change|reschedule|cancel|delay)/i.test(kind)) return "changed";
    if (/fail|error/i.test(kind)) return "failed";
    if (/pending|progress|shipping|deliver/i.test(kind)) return "pending";
    return "done";
  }

  /**
   * 告知类（change/cancel/delay）自动落库时没有「代办完成」语义——默认状态文案
   * 用「已告知」而非客户端兜底的「已调整」，向用户如实传达「我盯到了并告诉了你，
   * 还没替你改」。调用方显式传 status/statusLabel（工具链执行类上报）时不覆盖。
   */
  static defaultStatusLabel(kind: string, status?: AgentActivityStatus): string | undefined {
    if (status !== undefined) return undefined;
    return AgentActivityStore.statusFromKind(kind) === "changed" ? "已告知" : undefined;
  }

  record(input: RecordActivityInput): AgentActivity | null {
    if (input.dedupKey) {
      const cutoff = Date.now() - DEDUP_WINDOW_MS;
      const dup = this.activities.some(
        (a) =>
          a.dedupKey === input.dedupKey &&
          a.actorId === input.actorId &&
          a.createdAt > cutoff,
      );
      if (dup) return null;
    }
    const status = input.status ?? AgentActivityStore.statusFromKind(input.kind);
    const autoLabel = AgentActivityStore.defaultStatusLabel(input.kind, input.status);
    const activity: AgentActivity = {
      id: `act_${Date.now().toString(36)}_${(this.seq++).toString(36)}`,
      actorId: input.actorId,
      kind: input.kind,
      category: AgentActivityStore.categoryOf(input.kind),
      title: input.title,
      summary: input.summary,
      status,
      ...(input.statusLabel || autoLabel ? { statusLabel: input.statusLabel ?? autoLabel } : {}),
      ...(input.detail && Object.keys(input.detail).length > 0
        ? { detail: input.detail }
        : {}),
      createdAt: Date.now(),
      readAt: null,
      ...(input.dedupKey ? { dedupKey: input.dedupKey } : {}),
    };
    this.activities.push(activity);
    this.trim();
    this.persist();
    try {
      this.onRecord?.(activity);
    } catch {
      /* 实时推送失败不影响落库 */
    }
    return activity;
  }

  /** 每个 actor 只保留最近 MAX_PER_ACTOR 条（原地裁剪，旧的先丢） */
  private trim(): void {
    const byActor = new Map<string, number>();
    for (let i = this.activities.length - 1; i >= 0; i--) {
      const actor = this.activities[i]!.actorId;
      const count = (byActor.get(actor) ?? 0) + 1;
      byActor.set(actor, count);
      if (count > MAX_PER_ACTOR) this.activities.splice(i, 1);
    }
  }

  list(actorId?: string, limit?: number): AgentActivity[] {
    const filtered = actorId
      ? this.activities.filter((a) => a.actorId === actorId)
      : this.activities;
    const sorted = [...filtered].sort((a, b) => b.createdAt - a.createdAt);
    return limit && limit > 0 ? sorted.slice(0, limit) : sorted;
  }

  unreadCount(actorId?: string): number {
    return this.list(actorId).filter((a) => a.readAt == null).length;
  }

  /** 批量置已读；ids 缺省时全量标记。返回实际标记条数。 */
  markRead(actorId: string | undefined, ids?: string[]): number {
    const now = Date.now();
    let marked = 0;
    for (const activity of this.activities) {
      if (actorId && activity.actorId !== actorId) continue;
      if (activity.readAt != null) continue;
      if (ids && !ids.includes(activity.id)) continue;
      activity.readAt = now;
      marked++;
    }
    if (marked > 0) this.persist();
    return marked;
  }
}
