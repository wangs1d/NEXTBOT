// 主动触达漏斗（2026-11-23 需求 §12.2 看板）
//
// 回答一个问题：一条主动消息从「想到」到「用户真动了」，是在哪一级掉下去的、
// 因为什么掉。纯聚合，不新增任何打点——三段既有留痕就够：
//   候选/入 slot/决策  ← ProposalStore 的仲裁裁决（含被挡下的 verdict 与 reasonChain）
//   送达/展示/操作     ← outcome-store 投递账本（每条 = 一次真送达）
//   挡下原因           ← 裁决 verdict + SilenceLog 里管道之外（hub/准入闸）的沉默
//
// 已知口径边界（读结果的人必须知道）：
//   1. 裁决留痕是环形缓冲（默认 200 条），高频装机上 30 天窗口可能不满；
//   2. outcome-store 每个 deliveryId 只留最后状态，`ignored` 是「送达 - 有接触」的差值，
//      不是系统单独结算出来的事件；
//   3. 触点维度只在送达之后成立——候选阶段还没有触点，按 kind 分组才有全链路。
import type { OutcomeRecord } from "./outcome-store.js";
import type { ArbitrationDecision } from "./pipeline-types.js";
import type { SilenceLogEntry } from "./silence-log.js";

export const FUNNEL_STAGES = ["candidate", "slotted", "delivered", "opened", "acted"] as const;
export type FunnelStage = (typeof FUNNEL_STAGES)[number];
export type FunnelCounts = Record<FunnelStage, number>;

/** 用户有过任何接触（展示/点开/表态）——「送达但没人看」就是 delivered - opened */
const OPENED: ReadonlySet<string> = new Set([
  "viewed",
  "accepted",
  "replied",
  "snoozed",
  "dismissed",
]);
/** 有效动作：北极星分子（需求 §12.2「被打开、被操作或被回复」） */
const ACTED: ReadonlySet<string> = new Set(["accepted", "replied", "snoozed"]);
/** 排进了待发队列或当轮就投——都算「过了闸门」，与后面被挡下相对 */
const SLOTTED_VERDICTS: ReadonlySet<string> = new Set(["delivered", "deferred"]);

function emptyCounts(): FunnelCounts {
  return { candidate: 0, slotted: 0, delivered: 0, opened: 0, acted: 0 };
}

export type FunnelBucket = FunnelCounts & {
  key: string;
  /** 掉队原因 → 次数（verdict 与被挡规则前缀） */
  dropReasons: Record<string, number>;
};

function bucket(key: string): FunnelBucket {
  return { ...emptyCounts(), key, dropReasons: {} };
}

function addDrop(b: FunnelBucket, reason: string): void {
  b.dropReasons[reason] = (b.dropReasons[reason] ?? 0) + 1;
}

/** "net_utility_negative(U=-0.4)" → "net_utility_negative"（带参数的规则按前缀归并） */
function rulePrefix(reason: string | undefined): string {
  const s = (reason ?? "").trim();
  if (!s) return "unknown";
  return s.split("(")[0].split(":")[0].trim() || "unknown";
}

/** 本地日切（不按 UTC——「今天没提醒我」是用户意义上的今天） */
export function dayKey(ms: number): string {
  const d = new Date(ms);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

export type FunnelInput = {
  decisions: ArbitrationDecision[];
  outcomes: OutcomeRecord[];
  /** 管道之外的沉默（hub 行动级 / 准入闸）；管道自己的 silenced 已在 decisions 里 */
  silences?: SilenceLogEntry[];
  actorId?: string;
  days?: number;
  now?: number;
};

export type FunnelView = {
  ok: true;
  window: { days: number; fromMs: number; toMs: number };
  total: FunnelBucket;
  byDay: FunnelBucket[];
  byKind: FunnelBucket[];
  /** 触点维度（送达之后才有意义）：in_app / mobile_push / websocket… */
  bySlot: FunnelBucket[];
  northStar: {
    /** 窗口内人均有效主动触达（次数 ÷ 有过送达的 actor 数）；按 days=7 查即需求口径 */
    perActor: number;
    actors: number;
    effective: number;
  };
  /** 每级口径一句话说明，给读看板的人（管理后台直接渲染这段） */
  legend: Record<FunnelStage, string>;
};

const LEGEND: Record<FunnelStage, string> = {
  candidate: "进入仲裁的候选（含被挡下的）",
  slotted: "过了闸门：当轮投递或排进待发",
  delivered: "真的送达某个端（outcome 账本一条 = 一次）",
  opened: "用户有过接触：展示、点开或表态",
  acted: "有效动作：接受 / 回复 / 稍后（北极星的分子）",
};

function within(at: number | undefined, fromMs: number, now: number): boolean {
  const t = at ?? 0;
  return t >= fromMs && t <= now;
}

export function buildFunnel(input: FunnelInput): FunnelView {
  const days = Math.max(1, Math.min(90, Math.round(input.days ?? 7)));
  const now = input.now ?? Date.now();
  const fromMs = now - days * 24 * 60 * 60_000;
  const actor = input.actorId?.trim() || "";

  const byKey = (key: string, rows: Record<string, FunnelBucket>): FunnelBucket =>
    (rows[key] ??= bucket(key));
  const dayRows: Record<string, FunnelBucket> = {};
  const kindRows: Record<string, FunnelBucket> = {};
  const slotRows: Record<string, FunnelBucket> = {};
  const total = bucket("total");

  const bump = (stage: FunnelStage, day: string, kind: string, slot?: string): void => {
    total[stage] += 1;
    byKey(day, dayRows)[stage] += 1;
    byKey(kind, kindRows)[stage] += 1;
    if (slot) byKey(slot, slotRows)[stage] += 1;
  };

  // ── 候选 / 闸门 / 被挡原因 ──
  for (const d of input.decisions) {
    const at = d.proposal?.createdAt ?? 0;
    if (!within(at, fromMs, now)) continue;
    if (actor && d.proposal?.actorId !== actor) continue;
    const day = dayKey(at);
    const kind = d.proposal?.kind ?? "unknown";
    bump("candidate", day, kind);
    if (SLOTTED_VERDICTS.has(d.verdict)) {
      bump("slotted", day, kind);
      continue;
    }
    // reasonChain 是「一路为什么」的完整链，末位才是当时把门关上那条
    const reason = `${d.verdict}(${rulePrefix(d.reasonChain.at(-1))})`;
    addDrop(total, reason);
    addDrop(byKey(day, dayRows), reason);
    addDrop(byKey(kind, kindRows), reason);
  }
  // hub 行动级/准入闸沉默：候选没进管道账本，只补进「为什么没说」
  for (const s of input.silences ?? []) {
    if (s.scope === "proposal") continue;
    if (!within(s.at, fromMs, now)) continue;
    if (actor && s.actorId !== actor) continue;
    const reason = `${s.scope}(${rulePrefix(s.reason)})`;
    addDrop(total, reason);
    addDrop(byKey(dayKey(s.at), dayRows), reason);
    addDrop(byKey(s.kind || "unknown", kindRows), reason);
  }

  // ── 送达 / 接触 / 有效动作 ──
  const actorsInWindow = new Set<string>();
  let effective = 0;
  for (const o of input.outcomes) {
    const sentAt = o.createdAt ?? o.at;
    if (!within(sentAt, fromMs, now)) continue;
    if (actor && o.actorId !== actor) continue;
    const day = dayKey(sentAt);
    const kind = o.kind || "unknown";
    const slot = o.channel || "unknown";
    bump("delivered", day, kind, slot);
    if (OPENED.has(o.outcome)) bump("opened", day, kind, slot);
    if (ACTED.has(o.outcome)) {
      bump("acted", day, kind, slot);
      effective += 1;
    } else if (!OPENED.has(o.outcome)) {
      // 送达后没有任何接触 = 事实上的 ignore（系统没有单独的 ignored 结算，按差值记）
      addDrop(total, "no_contact");
      addDrop(byKey(day, dayRows), "no_contact");
      addDrop(byKey(kind, kindRows), "no_contact");
    }
    actorsInWindow.add(o.actorId);
  }
  const actors = actorsInWindow.size;
  return {
    ok: true,
    window: { days, fromMs, toMs: now },
    total,
    byDay: Object.values(dayRows).sort((a, b) => a.key.localeCompare(b.key)),
    byKind: Object.values(kindRows)
      .sort((a, b) => b.candidate - a.candidate)
      .slice(0, 30),
    bySlot: Object.values(slotRows).sort((a, b) => b.delivered - a.delivered),
    northStar: {
      perActor: actors > 0 ? Math.round((effective / actors) * 100) / 100 : 0,
      actors,
      effective,
    },
    legend: LEGEND,
  };
}
