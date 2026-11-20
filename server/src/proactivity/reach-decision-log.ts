// ReachDecisionLog —— 主动触达决策的进程内滚动留痕。
//
// 目的：回答"它刚才为什么（没）跟我说话"——每次 ReachDecisionService.decide() 都记录
// 一条含 action / channel / utility / p / value / reason / perChannel 的快照。
//
// 设计对齐 gateway-trace.ts：内存环形缓冲、零 IO、零外部依赖；本机管理端只读查询。
// 不落盘是刻意的：决策是高频、可重建的诊断数据，落盘只会制造隐私与清理负担；
// 真正需要长期留痕的"沉默"决策由 SilenceLog 单独负责。

import type {
  ReachChannel,
  ReachDecisionAction,
  ReachDecision,
  ChannelUtility,
} from "./reach-decision.js";

export type ReachDecisionLogEntry = {
  at: number;
  actorId: string;
  kind: string;
  importance: string;
  explicit: boolean;
  requestedChannel?: ReachChannel;
  action: ReachDecisionAction;
  channel: ReachChannel | null;
  utility: number;
  p: number;
  value: number;
  cost: number;
  reason: string;
  perChannel: ChannelUtility[];
};

const LOG_LIMIT = 300;
const records: ReachDecisionLogEntry[] = [];

export function recordReachDecision(entry: ReachDecisionLogEntry): void {
  records.push(entry);
  if (records.length > LOG_LIMIT) records.splice(0, records.length - LOG_LIMIT);
}

export type ReachDecisionLogQuery = {
  actorId?: string;
  kind?: string;
  action?: ReachDecisionAction;
  limit?: number;
};

/** 时间倒序（最新在前）。 */
export function listReachDecisions(query: ReachDecisionLogQuery = {}): ReachDecisionLogEntry[] {
  const { actorId, kind, action, limit = 50 } = query;
  const out: ReachDecisionLogEntry[] = [];
  for (let i = records.length - 1; i >= 0 && out.length < limit; i--) {
    const r = records[i];
    if (actorId && r.actorId !== actorId) continue;
    if (kind && r.kind !== kind) continue;
    if (action && r.action !== action) continue;
    out.push(r);
  }
  return out;
}

export function getReachDecisionStats(): {
  total: number;
  byAction: Record<string, number>;
  byChannel: Record<string, number>;
  byReason: Record<string, number>;
  avgUtility: number;
} {
  const byAction: Record<string, number> = {};
  const byChannel: Record<string, number> = {};
  const byReason: Record<string, number> = {};
  let utilitySum = 0;
  for (const r of records) {
    byAction[r.action] = (byAction[r.action] ?? 0) + 1;
    const ch = r.channel ?? "none";
    byChannel[ch] = (byChannel[ch] ?? 0) + 1;
    // reason 带具体数值参数（如 admitted(chat, U=...)），按冒号/括号前的前缀聚合
    const reasonKey = r.reason.split("(")[0];
    byReason[reasonKey] = (byReason[reasonKey] ?? 0) + 1;
    utilitySum += r.utility;
  }
  return {
    total: records.length,
    byAction,
    byChannel,
    byReason,
    avgUtility: records.length ? Math.round((utilitySum / records.length) * 1000) / 1000 : 0,
  };
}

/** 仅测试用：清空内存留痕（诊断本身不提供清空端点，避免运行时丢失证据）。 */
export function clearReachDecisionLog(): void {
  records.length = 0;
}

/** 把一次纯决策结果转成留痕条目。 */
export function toReachDecisionLogEntry(
  ask: {
    actorId: string;
    kind: string;
    importance: string;
    explicit?: boolean;
    requestedChannel?: ReachChannel;
  },
  decision: ReachDecision,
  at: number = Date.now(),
): ReachDecisionLogEntry {
  return {
    at,
    actorId: ask.actorId,
    kind: ask.kind,
    importance: ask.importance,
    explicit: ask.explicit === true,
    ...(ask.requestedChannel === undefined ? {} : { requestedChannel: ask.requestedChannel }),
    action: decision.action,
    channel: decision.channel,
    utility: decision.utility,
    p: decision.p,
    value: decision.value,
    cost: decision.cost,
    reason: decision.reason,
    perChannel: decision.perChannel,
  };
}
