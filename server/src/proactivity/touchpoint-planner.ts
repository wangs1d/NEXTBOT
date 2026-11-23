/**
 * 每日触点计划（2026-11-23 需求 §3.4）。
 *
 * 它补的是管道缺的那一段：此前只有「现在要不要说」的即时判断（AgentPulse 每 10 分钟问一次），
 * 主动消息落在哪个时刻是随机的，用户形成不了「早上它会说今天的事、睡前它会收尾」的预期。
 * 这里把判断从「即时」改成「先计划、后时机」——每天生成几个 slot，非紧急候选排进 slot，
 * 到点由管道一次合并投递。
 *
 * 三条硬约束（都是文档 §1.3 点名的）：
 *  1. **不开新调度器**：入 slot = 把提案的 deliverAfter 推到 slot.windowStart，
 *     到点靠管道已有的 30s flush 自然触发；
 *  2. **不自己算作息**：时刻一律问 UserTimingService / 晚报调度器要，
 *     计划层只回答「今天打算在什么时候说什么」；
 *  3. **slot 是上限不是任务**：没有候选也没有社交需要就 skipped，绝不为了"完成计划"发消息。
 */
import { readJson, writeJson } from "./persist-file.js";
import type { ProactiveProposal } from "./pipeline-types.js";

export type TouchpointSlotKind =
  | "morning"
  | "leave_home"
  | "midday"
  | "leave_work"
  | "tomorrow_preview";

export type TouchpointTrigger = "time" | "first_unlock" | "geofence_exit";
export type TouchpointSlotStatus = "planned" | "open" | "sent" | "skipped" | "merged";
export type FrequencyTier = "quiet" | "normal" | "chatty";

export type TouchpointSlot = {
  /** tp:<actorId>:<date>:<kind> */
  slotId: string;
  kind: TouchpointSlotKind;
  /** 当日分钟数（本地）——计划口径用分钟，避免跨时区/夏令时把 slot 排到昨天 */
  minuteOf: number;
  windowStart: number;
  windowEnd: number;
  trigger: TouchpointTrigger;
  capacity: number;
  /** 已排进来的候选（proposal.dedupKey） */
  candidates: string[];
  status: TouchpointSlotStatus;
  basis: { source: "rhythm" | "default"; confidence: number };
  sentAt?: number;
  /** 未投递的原因（skipped / merged / no_slot），诊断漏斗要能逐级看到损耗 */
  reason?: string;
};

export type TouchpointPlan = {
  actorId: string;
  /** YYYY-MM-DD 本地 */
  date: string;
  frequencyTier: FrequencyTier;
  slots: TouchpointSlot[];
  generatedAt: number;
};

export type SlotAssignment =
  | { kind: "slot"; slot: TouchpointSlot }
  | { kind: "immediate"; reason: string }
  | { kind: "no_slot"; reason: string };

export type TouchpointPlannerDeps = {
  /** 起床后就寝前换算口（早安 / 明日预览的时刻来源） */
  timing: {
    postWakeMinutes(actorId: string, opts?: { offsetMinutes?: number; clampMinutes?: [number, number]; fallbackMinutes?: number }): number | null;
    bedtimeHour?(actorId: string): number | null;
  };
  /** 明日预览时刻（当日分钟数）：直接沿用晚报调度器的现有算法，不另立一套 */
  previewMinutesOf(actorId: string, date?: Date): number | null;
  /** 出门 / 下班时刻（§7 commute 维度）：拿不到就不生成这两个 slot */
  commuteMinutesOf?(actorId: string, date: Date): { leaveHome: number | null; leaveWork: number | null };
  /** 午间窗内 receptivity 最高的 30 分钟起点；拿不到用默认 */
  middayMinutesOf?(actorId: string, date: Date): number | null;
  /** 节律置信度：< 0.5 视为冷启动，走固定默认时刻 */
  rhythmConfidence?(actorId: string): number;
  /** 用户频率档（§3.10）：quiet 只保留早安与明日预览 */
  frequencyTierOf?(actorId: string): FrequencyTier;
  nowFn?(): number;
  /** 落盘路径（不传 = 纯内存，测试用） */
  path?: string;
};

const MINUTE = 60_000;
/** 冷启动默认：08:00 / 12:30 / 22:00（§3.4「冷启动用固定默认三个 slot」） */
const DEFAULT_MORNING = 8 * 60;
const DEFAULT_MIDDAY = 12 * 60 + 30;
const DEFAULT_PREVIEW = 22 * 60;
const MIDDAY_WINDOW: [number, number] = [12 * 60, 13 * 60 + 30];
/** 置信度低于此值不用统计值（与 §3.6「只问 confidence<0.5 的缺口」同口径） */
const COLD_START_CONFIDENCE = 0.5;

/**
 * 各候选类型偏好落哪个 slot（§3.4 容量与偏好）。
 * 顺序即优先级：排进第一个「还没过、还有容量」的 slot。
 * 节律关怀只进明日预览——它需要一段不被打断的时间看，白天弹出来只会招人烦。
 */
/**
 * 各候选类型偏好落哪个 slot（§3.4 容量与偏好表）。
 *
 * 键是提案的 kind（或 source）——含带点 kind 的最后一段，见 preferenceOf。
 * 顺序即优先级：排进第一个「还没过、还有容量」的槽。
 * 两条取舍：① 节律/关怀类只进明日预览——它需要一段不被打断的时间看，白天弹出来
 * 只会招人烦；② 用户要拍板的（目标确认/待处理事项）不进深夜槽，宁可排到下一趟通勤。
 */
const SLOT_PREFERENCE: Record<string, TouchpointSlotKind[]> = {
  // 早报/早安本身：只属于早间那个触点
  morning_briefing: ["morning"],
  morning_brief: ["morning"],
  alarm_wake: ["morning"],
  // 晚报正文就是「明日预览」这个触点
  evening_digest: ["tomorrow_preview"],
  monthly_report: ["tomorrow_preview"],
  // 天气：预警要赶在出门前说，天气简报跟着早报/预览
  weather_alert: ["leave_home", "midday", "leave_work"],
  weather_brief: ["morning", "tomorrow_preview"],
  location_enter: ["leave_home", "midday", "leave_work"],
  geofence_event: ["leave_home", "leave_work"],
  // 台账事务（快递/账单）：顺路型事项，午间或下班说
  parcel: ["midday", "leave_work", "morning", "tomorrow_preview"],
  bill_parcel: ["midday", "leave_work", "morning", "tomorrow_preview"],
  bill: ["midday", "leave_work", "tomorrow_preview"],
  // 承诺跟进（§3.5）：当天收尾时段问一句最合适
  commitment: ["leave_work", "tomorrow_preview", "midday"],
  followup: ["leave_work", "tomorrow_preview", "midday"],
  task_followup: ["leave_work", "tomorrow_preview", "midday"],
  ask_you: ["midday", "leave_work", "tomorrow_preview"],
  // 观察/监听/代办结果：告知类，白天为主
  watch_task_hit: ["midday", "leave_work", "tomorrow_preview"],
  price_watch_hit: ["midday", "leave_work", "tomorrow_preview"],
  message_watch: ["midday", "leave_work", "tomorrow_preview"],
  background_job: ["midday", "leave_work", "tomorrow_preview"],
  agent_task: ["midday", "leave_work", "tomorrow_preview"],
  // 需要拍板的：不进深夜槽
  goal_progress: ["midday", "leave_work"],
  goal_blocked: ["midday", "leave_work"],
  goal_confirm: ["midday", "leave_work"],
  // 节律关怀与社交：睡前那一段
  rhythm: ["tomorrow_preview"],
  sleep_boundary: ["tomorrow_preview"],
  drowsy_driving: ["tomorrow_preview"],
  mute_suggest: ["tomorrow_preview"],
  agent_pulse: ["midday", "leave_work", "tomorrow_preview"],
  interest_alert: ["midday", "leave_work", "tomorrow_preview"],
  social: ["midday", "leave_work", "leave_home", "tomorrow_preview"],
  life_reminder: ["midday", "leave_work", "tomorrow_preview"],
  default: ["midday", "leave_work", "tomorrow_preview", "morning"],
};

/** slot 容量：早安/预览是「一张卡 ≤3 项」，其余一次只说一件事（§3.4 表格） */
const CAPACITY: Record<TouchpointSlotKind, number> = {
  morning: 3,
  leave_home: 1,
  midday: 1,
  leave_work: 1,
  tomorrow_preview: 3,
};

function localDateKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function isWeekendDate(d: Date): boolean {
  const day = d.getDay();
  return day === 0 || day === 6;
}

/**
 * 候选归类：kind 优先、source 次之，都支持「带点命名族取最后一段」。
 * 真实提案的 kind 形如 wellness.sleep_boundary / action.bill_parcel，表里登记的是
 * 语义叶子名（sleep_boundary / bill_parcel）——否则每个新前缀都要回来补一张键。
 */
function preferenceOf(p: ProactiveProposal): TouchpointSlotKind[] {
  const candidates = [p.kind, p.source];
  for (const key of candidates) {
    const exact = SLOT_PREFERENCE[key];
    if (exact) return exact;
    const leaf = key.includes(".") ? key.split(".").pop() ?? "" : "";
    const byLeaf = leaf ? SLOT_PREFERENCE[leaf] : undefined;
    if (byLeaf) return byLeaf;
  }
  return SLOT_PREFERENCE.default!;
}

export class TouchpointPlanner {
  private readonly plans = new Map<string, TouchpointPlan>();
  /** 当天没生成 slot 的分配失败原因（诊断用，actorId:date → reason） */
  private readonly noSlotReasons = new Map<string, string>();

  constructor(private readonly deps: TouchpointPlannerDeps) {
    if (!deps.path) return;
    const raw = readJson<{ plans?: TouchpointPlan[] }>(deps.path, {});
    for (const plan of raw.plans ?? []) this.plans.set(`${plan.actorId}:${plan.date}`, plan);
  }

  private now(): number {
    return this.deps.nowFn?.() ?? Date.now();
  }

  /**
   * 取当天计划；没有就按此刻的作息生成。
   * 生成时机用「第一次被问到时」而不是夜里跑一遍：既不需要新调度器，
   * 也让当天凌晨才学到的作息能立刻反映到今天的 slot 上。
   */
  planOf(actorId: string, atMs = this.now()): TouchpointPlan {
    const date = localDateKey(atMs);
    const key = `${actorId}:${date}`;
    const hit = this.plans.get(key);
    if (hit) return hit;
    const created = this.buildPlan(actorId, atMs, date);
    this.plans.set(key, created);
    this.persist();
    return created;
  }

  private buildPlan(actorId: string, atMs: number, date: string): TouchpointPlan {
    const day = new Date(atMs);
    const base = startOfDay(atMs);
    const tier = this.deps.frequencyTierOf?.(actorId) ?? "normal";
    const confidence = this.deps.rhythmConfidence?.(actorId) ?? 0;
    const cold = confidence < COLD_START_CONFIDENCE;
    const weekend = isWeekendDate(day);
    const slots: TouchpointSlot[] = [];
    const push = (
      kind: TouchpointSlotKind,
      minuteOf: number | null,
      trigger: TouchpointTrigger,
      basisSource: "rhythm" | "default",
    ): void => {
      if (minuteOf === null || !Number.isFinite(minuteOf)) return;
      const minute = Math.round(minuteOf);
      const start = base + minute * MINUTE;
      const windowMinutes = kind === "morning" || kind === "tomorrow_preview" ? 60 : 30;
      slots.push({
        slotId: `tp:${actorId}:${date}:${kind}`,
        kind,
        minuteOf: minute,
        windowStart: start,
        windowEnd: start + windowMinutes * MINUTE,
        trigger,
        capacity: CAPACITY[kind],
        candidates: [],
        status: "planned",
        basis: { source: basisSource, confidence: cold ? 0 : confidence },
      });
    };

    // 早安：起床 +20min（兜底 08:00），触发条件是「当天首次解锁」——人还没醒就说今天的事没有意义
    const wakeMinute = this.deps.timing.postWakeMinutes(actorId, {
      offsetMinutes: 20,
      clampMinutes: [5 * 60 + 30, 11 * 60],
      fallbackMinutes: cold ? DEFAULT_MORNING : undefined,
    });
    // 没学到起床时刻也要有早安（§3.4 三档里它是每档都留的那一个），只是如实标 basis=default
    push(
      "morning",
      wakeMinute ?? DEFAULT_MORNING,
      "first_unlock",
      wakeMinute !== null && !cold ? "rhythm" : "default",
    );

    if (tier !== "quiet") {
      const commute = this.deps.commuteMinutesOf?.(actorId, day) ?? { leaveHome: null, leaveWork: null };
      // 周末/节假日不排通勤两趟（§3.4）；没有 commute 依据也不排——宁缺勿假。
      if (!weekend) {
        push("leave_home", commute.leaveHome, "geofence_exit", "rhythm");
      }
      if (!weekend) {
        push("leave_work", commute.leaveWork, "geofence_exit", "rhythm");
      }
      const rawMidday = this.deps.middayMinutesOf?.(actorId, day) ?? DEFAULT_MIDDAY;
      const midday = Math.min(MIDDAY_WINDOW[1], Math.max(MIDDAY_WINDOW[0], rawMidday));
      push("midday", midday, "time", this.deps.middayMinutesOf ? "rhythm" : "default");
    }

    const preview = this.deps.previewMinutesOf(actorId, day) ?? (cold ? DEFAULT_PREVIEW : null);
    push("tomorrow_preview", preview, "time", cold ? "default" : "rhythm");

    slots.sort((a, b) => a.windowStart - b.windowStart);
    return { actorId, date, frequencyTier: tier, slots, generatedAt: atMs };
  }

  /**
   * 给一条候选找落点（§3.4 候选分配）。
   *
   * 即时通道三种：must 层、critical、保质期赶不上任何 slot（等下去就过期了）。
   * 其余按类型偏好排进「还没过、还有容量、且不早于它本身最早可发时刻」的最早 slot；
   * 排不进去不静默丢——返回 no_slot 并留原因，管道据此决定降级还是丢弃。
   *
   * `override` 是调用方（管道）按用户档位给的即时豁免：§3.10「多聊点」档允许 AgentPulse
   * 不等触点即时开口。豁免排在 must 之前判，否则理由链会把用户设定说成「必达」。
   */
  assign(
    actorId: string,
    proposal: ProactiveProposal,
    atMs = this.now(),
    override?: { immediate: boolean; reason: string },
  ): SlotAssignment {
    const plan = this.planOf(actorId, atMs);
    if (override?.immediate) return { kind: "immediate", reason: override.reason };
    if (proposal.tier === "must") return { kind: "immediate", reason: "tier_must" };
    if (proposal.importance === "critical") return { kind: "immediate", reason: "critical" };
    if (proposal.firedAt !== undefined) {
      // 离线补推的到点提醒：按原定时刻落屏是拍板过的语义，不能被排到别的 slot
      return { kind: "immediate", reason: "catchup_fired_at" };
    }

    const earliest = Math.max(atMs, proposal.deliverAfter ?? 0);
    const prefs = preferenceOf(proposal);
    const open = plan.slots.filter((s) => s.windowEnd > earliest && s.candidates.length < s.capacity);
    if (open.length === 0) return this.reject(actorId, plan.date, "no_open_slot");

    const chosen =
      prefs
        .map((kind) => open.find((s) => s.kind === kind && s.status !== "sent"))
        .find((s): s is TouchpointSlot => !!s) ?? null;
    if (!chosen) return this.reject(actorId, plan.date, `no_slot_for:${proposal.kind}`);

    // 保质期必须还来得及：等到 slot 才开始的消息，用户收到时已经是过期信息
    if (proposal.expiresAt !== undefined && proposal.expiresAt < chosen.windowStart) {
      const usable = open.filter((s) => s.windowStart <= proposal.expiresAt!);
      if (usable.length === 0) return this.reject(actorId, plan.date, "expires_before_slot");
      const alt = prefs.map((k) => usable.find((s) => s.kind === k)).find((s): s is TouchpointSlot => !!s);
      if (!alt) return this.reject(actorId, plan.date, "expires_before_slot");
      return this.take(alt, proposal);
    }
    return this.take(chosen, proposal);
  }

  private take(slot: TouchpointSlot, proposal: ProactiveProposal): SlotAssignment {
    slot.candidates.push(proposal.dedupKey);
    this.persist();
    return { kind: "slot", slot };
  }

  private reject(actorId: string, date: string, reason: string): SlotAssignment {
    this.noSlotReasons.set(`${actorId}:${date}`, reason);
    return { kind: "no_slot", reason };
  }

  /** slot 打开（到点/解锁/出围栏触发时调用） */
  markOpen(slotId: string, atMs = this.now()): TouchpointSlot | null {
    const slot = this.findSlot(slotId);
    if (!slot) return null;
    if (slot.status === "planned") slot.status = "open";
    if (slot.candidates.length === 0) slot.reason = slot.reason ?? "empty";
    void atMs;
    return slot;
  }

  /**
   * 候选从槽里退回（提案被去重丢弃 / 入队失败时由管道调用）。
   * 不退的话，槽会被幽灵候选占满容量，而空槽本该如实记成 skipped。
   */
  releaseCandidate(dedupKey: string): boolean {
    let changed = false;
    for (const plan of this.plans.values()) {
      for (const slot of plan.slots) {
        const i = slot.candidates.indexOf(dedupKey);
        if (i < 0) continue;
        slot.candidates.splice(i, 1);
        changed = true;
      }
    }
    if (changed) this.persist();
    return changed;
  }

  /**
   * 推进槽位生命周期（管道每轮 flush 顺带调一次，不另起定时器）：
   * 窗口到点开槽，窗口走完还空着就 skipped——「slot 是上限不是任务」在这一步落地。
   */
  sweep(now = this.now()): void {
    let changed = false;
    for (const plan of this.plans.values()) {
      for (const slot of plan.slots) {
        if (slot.status === "planned" && now >= slot.windowStart) {
          slot.status = "open";
          changed = true;
        }
        if (slot.status === "open" && now >= slot.windowEnd && slot.candidates.length === 0) {
          slot.status = "skipped";
          slot.reason = "empty";
          changed = true;
        }
      }
    }
    if (changed) this.persist();
  }

  /** slot 投递完成（合并投递只记一次） */
  markSent(slotId: string, atMs = this.now()): void {
    const slot = this.findSlot(slotId);
    if (!slot) return;
    slot.status = slot.candidates.length > 1 ? "merged" : "sent";
    slot.sentAt = atMs;
    this.persist();
  }

  /** slot 空转（无候选、无社交补位）——合法结果，不是失败 */
  markSkipped(slotId: string, reason: string): void {
    const slot = this.findSlot(slotId);
    if (!slot || slot.status === "sent" || slot.status === "merged") return;
    slot.status = "skipped";
    slot.reason = reason;
    this.persist();
  }

  slotOf(slotId: string): TouchpointSlot | undefined {
    return this.findSlot(slotId);
  }

  private findSlot(slotId: string): TouchpointSlot | undefined {
    for (const plan of this.plans.values()) {
      const hit = plan.slots.find((s) => s.slotId === slotId);
      if (hit) return hit;
    }
    return undefined;
  }

  /** 诊断视图（§3.4 验收第 4 条：当天 plan 与每个 slot 的去向都要看得见） */
  snapshot(actorId: string, atMs = this.now()): {
    plan: TouchpointPlan;
    dropped: string | null;
  } {
    const plan = this.planOf(actorId, atMs);
    return {
      plan,
      dropped: this.noSlotReasons.get(`${actorId}:${plan.date}`) ?? null,
    };
  }

  /**
   * 只保留今天与昨天的计划：老计划没有消费方，留着会让文件无限长。
   */
  private persist(): void {
    if (!this.deps.path) return;
    const keep = new Set<string>([
      localDateKey(this.now()),
      localDateKey(this.now() - 24 * 60 * 60_000),
    ]);
    for (const [key, plan] of this.plans) {
      if (!keep.has(plan.date)) this.plans.delete(key);
    }
    writeJson(this.deps.path, { plans: [...this.plans.values()] });
  }
}
