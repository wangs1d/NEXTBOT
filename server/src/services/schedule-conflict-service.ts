/**
 * 日程冲突检测与空闲时段查询（阶段 2/3 程序层能力）。
 *
 * 职责划分（对齐项目约束：程序层确定性检测，LLM 只负责向用户转述与让用户选择）：
 *   - findConflicts：纯区间算术。候选事件（带 durationMinutes）与会话内其他
 *     itinerary 事件在扫描窗口内的展开区间求交；周期任务复用
 *     schedule-recurrence-expand 展开，cron 任务只按 nextRunAt 单点参与。
 *   - findFreeSlots：把 busy 区间从「每日可用时段」中求补，返回前 N 个空闲槽，
 *     供「自动协调冲突」给出改期建议。
 *
 * 保守策略：
 *   - 零时长任务（时间点提醒）不作为冲突候选（提醒之间可共存，不打断用户）；
 *     但零时长点落在有时长的事件区间内会报冲突（overlapMinutes=0）。
 *   - trivia 分类（喝水/睡觉等节律琐事）既不产生冲突也不参与 busy 占用。
 *   - 单点任务在空闲计算中按 15 分钟占用（避免建议时段紧贴提醒点）。
 */

import {
  expandTaskOccurrenceTimes,
} from "./schedule-recurrence-expand.js";
import {
  isTriviaTask,
  taskEndMs,
  type ScheduleTaskRecord,
  type ScheduleTaskService,
} from "./schedule-task-service.js";

/** 扫描窗口上限：周期任务最多向后展开 7 天。 */
const DEFAULT_HORIZON_DAYS = 7;
/** 空闲计算中零时长任务的占用分钟数。 */
const POINT_TASK_BLOCK_MINUTES = 15;
/** 单次返回的冲突/空闲槽上限（控制回给 LLM 的 token 量）。 */
const MAX_RESULTS = 5;
/** 回溯窗口：捕获「开始早于候选、但延续进候选区间」的既有事件（覆盖最长时长）。 */
const CONFLICT_LOOKBACK_MS = 8 * 86_400_000;

export type ConflictInterval = {
  startMs: number;
  endMs: number;
};

export type ScheduleConflict = {
  taskId: string;
  title: string;
  /** 冲突发生的这一次实例起点（ISO UTC） */
  occurrenceStartAt: string;
  occurrenceEndAt: string;
  overlapMinutes: number;
  recurrence: ScheduleTaskRecord["recurrence"];
};

export type FindConflictsInput = {
  sessionId: string;
  /** 候选事件起点（ISO UTC） */
  runAt: string;
  /** 候选事件时长（分钟）；<=0 或缺省 = 时间点，不参与冲突判定 */
  durationMinutes?: number;
  /** 更新场景下排除自身 */
  excludeTaskId?: string;
  /** 扫描窗口（天），默认 7 */
  horizonDays?: number;
  /** 候选为 trivia 时调用方应直接跳过检测；此处再兜底一次 */
  category?: ScheduleTaskRecord["category"];
};

export type FreeSlot = {
  startAt: string;
  endAt: string;
  durationMinutes: number;
};

export type FindFreeSlotsInput = {
  sessionId: string;
  /** 需求时长（分钟） */
  durationMinutes: number;
  /** 范围起点（ISO），默认 now */
  from?: string;
  /** 范围终点（ISO），默认 from + 3 天 */
  to?: string;
  /** 每日可用时段（本地时区，"HH:MM"），默认 09:00–21:00 */
  dailyWindow?: { start: string; end: string };
  /** 用户时区（空闲窗口按此时区展开），默认 Asia/Shanghai */
  timezone?: string;
  excludeTaskId?: string;
  limit?: number;
};

function parseClockMinute(clock: string, fallback: number): number {
  const m = clock.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return fallback;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isInteger(h) || !Number.isInteger(min) || h > 23 || min > 59) return fallback;
  return h * 60 + min;
}

/** 把任务展开为扫描窗口内的占用区间（含候选自身以外的所有 active itinerary 任务）。 */
function expandBusyIntervals(
  task: ScheduleTaskRecord,
  fromMs: number,
  toMs: number,
): ConflictInterval[] {
  const duration = task.durationMinutes ?? 0;
  if (task.recurrence === "cron") {
    // cron 任务无法廉价展开：只按下一次触发点参与（零时长则不构成区间冲突）
    if (!task.nextRunAt || duration <= 0) return [];
    const s = new Date(task.nextRunAt).getTime();
    const e = taskEndMs(s, duration);
    if (e >= fromMs && s <= toMs) return [{ startMs: s, endMs: e }];
    return [];
  }
  const occurrences = expandTaskOccurrenceTimes(task, fromMs, toMs);
  return occurrences.map((s) => ({ startMs: s, endMs: taskEndMs(s, duration) }));
}

function overlapMinutes(a: ConflictInterval, b: ConflictInterval): number {
  const start = Math.max(a.startMs, b.startMs);
  const end = Math.min(a.endMs, b.endMs);
  return Math.floor((end - start) / 60_000);
}

/** 区间是否相交：正长度相交，或零时长点严格落入正区间。 */
function intervalsConflict(a: ConflictInterval, b: ConflictInterval): boolean {
  const aZero = a.endMs <= a.startMs;
  const bZero = b.endMs <= b.startMs;
  if (aZero && bZero) return false;
  if (aZero) return b.startMs < a.startMs && a.startMs < b.endMs;
  if (bZero) return a.startMs < b.startMs && b.startMs < a.endMs;
  return a.startMs < b.endMs && b.startMs < a.endMs;
}

function taskDisplayTitle(task: ScheduleTaskRecord): string {
  return (
    task.reminderMessage?.trim() ||
    task.title?.trim() ||
    task.shortTitle?.trim() ||
    task.description
  );
}

export class ScheduleConflictService {
  constructor(private readonly tasks: ScheduleTaskService) {}

  /** 候选事件与既有日程的冲突列表（按冲突时刻升序，最多 5 条）。 */
  findConflicts(input: FindConflictsInput): ScheduleConflict[] {
    const duration = input.durationMinutes ?? 0;
    if (duration <= 0) return [];
    if (input.category === "trivia") return [];
    const candidateStart = new Date(input.runAt).getTime();
    if (!Number.isFinite(candidateStart)) return [];
    const horizonMs = Math.min(Math.max(input.horizonDays ?? DEFAULT_HORIZON_DAYS, 1), 30) * 86_400_000;
    const candidate = this.candidateIntervals(input, candidateStart, horizonMs);
    if (candidate.length === 0) return [];

    const windowStart = candidateStart - CONFLICT_LOOKBACK_MS;
    const windowEnd = candidateStart + horizonMs;
    const conflicts: ScheduleConflict[] = [];
    const seenTaskIds = new Set<string>();

    for (const task of this.tasks.listTasksBySession(input.sessionId, {
      from: new Date(windowStart - 31 * 86_400_000).toISOString(),
      to: new Date(windowEnd).toISOString(),
    })) {
      if (task.taskId === input.excludeTaskId) continue;
      if (task.status !== "active") continue;
      if (isTriviaTask(task)) continue;
      const busy = expandBusyIntervals(task, windowStart, windowEnd);
      if (busy.length === 0) continue;
      for (const c of candidate) {
        for (const b of busy) {
          if (!intervalsConflict(c, b)) continue;
          if (seenTaskIds.has(task.taskId)) continue;
          seenTaskIds.add(task.taskId);
          conflicts.push({
            taskId: task.taskId,
            title: taskDisplayTitle(task),
            occurrenceStartAt: new Date(b.startMs).toISOString(),
            occurrenceEndAt: new Date(b.endMs).toISOString(),
            overlapMinutes: Math.max(overlapMinutes(c, b), 0),
            recurrence: task.recurrence,
          });
          break;
        }
      }
      if (conflicts.length >= MAX_RESULTS) break;
    }
    return conflicts
      .sort((a, b) => a.occurrenceStartAt.localeCompare(b.occurrenceStartAt))
      .slice(0, MAX_RESULTS);
  }

  /** 周期候选（daily/weekly/…）逐实例检测；单次候选只有一个区间。 */
  private candidateIntervals(
    input: FindConflictsInput,
    candidateStart: number,
    _horizonMs: number,
  ): ConflictInterval[] {
    const duration = input.durationMinutes ?? 0;
    // 仅按首个实例检测：create 路径的周期冲突以第一次重叠提示即可，
    // 逐实例展开会让「每天 9 点」这类候选对每个既有日程都报冲突（误报风暴）。
    return [{ startMs: candidateStart, endMs: taskEndMs(candidateStart, duration) }];
  }

  /** 空闲时段：每日可用窗口内挖掉 busy 区间，返回能容纳 duration 的前 N 段。 */
  findFreeSlots(input: FindFreeSlotsInput): FreeSlot[] {
    const duration = Math.max(15, Math.min(input.durationMinutes, 12 * 60));
    const tz = input.timezone?.trim() || "Asia/Shanghai";
    const now = Date.now();
    const from = input.from ? new Date(input.from).getTime() : now;
    const to = input.to
      ? new Date(input.to).getTime()
      : Math.min(from + 3 * 86_400_000, now + 30 * 86_400_000);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return [];

    const busy: ConflictInterval[] = [];
    for (const task of this.tasks.listTasksBySession(input.sessionId, {
      from: new Date(Math.min(from, now) - 31 * 86_400_000).toISOString(),
      to: new Date(to).toISOString(),
    })) {
      if (task.taskId === input.excludeTaskId) continue;
      if (task.status !== "active") continue;
      if (isTriviaTask(task)) continue;
      const durationMinutes = task.durationMinutes ?? 0;
      const effective = durationMinutes > 0 ? durationMinutes : POINT_TASK_BLOCK_MINUTES;
      for (const occ of expandBusyIntervals({ ...task, durationMinutes: effective }, from, to)) {
        busy.push(occ);
      }
    }
    busy.sort((a, b) => a.startMs - b.startMs);

    const windowStartMin = parseClockMinute(input.dailyWindow?.start ?? "09:00", 9 * 60);
    const windowEndMin = parseClockMinute(input.dailyWindow?.end ?? "21:00", 21 * 60);
    const limit = Math.max(1, Math.min(input.limit ?? MAX_RESULTS, 10));
    const slots: FreeSlot[] = [];

    // 按 tz 日历日推进：每日窗口 [09:00,21:00) 内挖掉 busy，取能容纳 duration 的空段
    const firstDay = calendarDayInTz(Math.max(from, now), tz);
    for (let guard = 0; guard < 31 && slots.length < limit; guard += 1) {
      const day = addCalendarDays(firstDay, guard);
      const winStart = Math.max(
        wallToUtc(day, windowStartMin, tz),
        Math.max(from, now),
      );
      const winEnd = Math.min(wallToUtc(day, windowEndMin, tz), to);
      if (winEnd - winStart >= duration * 60_000) {
        const dayBusy = busy.filter((b) => b.endMs > winStart && b.startMs < winEnd);
        let cursor = winStart;
        for (const b of dayBusy) {
          if (b.startMs - cursor >= duration * 60_000 && slots.length < limit) {
            slots.push(this.toSlot(cursor, b.startMs));
          }
          cursor = Math.max(cursor, b.endMs);
        }
        if (winEnd - cursor >= duration * 60_000 && slots.length < limit) {
          slots.push(this.toSlot(cursor, winEnd));
        }
      }
    }
    return slots;
  }

  private toSlot(startMs: number, endMs: number): FreeSlot {
    return {
      startAt: new Date(startMs).toISOString(),
      endAt: new Date(endMs).toISOString(),
      durationMinutes: Math.floor((endMs - startMs) / 60_000),
    };
  }
}

// --------------------------------------------------------------------------- //
// 时区工具（不依赖服务器本地时区）
// --------------------------------------------------------------------------- //

type CalendarDay = { y: number; mo: number; d: number };

/** 某瞬时所在 tz 的日历日。 */
function calendarDayInTz(instantMs: number, tz: string): CalendarDay {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(instantMs));
  const v: Record<string, number> = {};
  for (const p of parts) if (p.type !== "literal") v[p.type] = Number(p.value);
  return { y: v.year!, mo: v.month!, d: v.day! };
}

function addCalendarDays(day: CalendarDay, days: number): CalendarDay {
  const utc = new Date(Date.UTC(day.y, day.mo - 1, day.d));
  utc.setUTCDate(utc.getUTCDate() + days);
  return { y: utc.getUTCFullYear(), mo: utc.getUTCMonth() + 1, d: utc.getUTCDate() };
}

/** tz 在该瞬时的 UTC 偏移（ms）。 */
function tzOffsetMs(instantMs: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instantMs));
  const v: Record<string, number> = {};
  for (const p of parts) {
    if (p.type !== "literal" && p.type !== "dayPeriod") v[p.type] = Number(p.value);
  }
  const asUtc = Date.UTC(v.year!, v.month! - 1, v.day!, v.hour! % 24, v.minute!, v.second!);
  return asUtc - Math.floor(instantMs / 1000) * 1000;
}

/** tz 墙钟（日历日 + 当日分钟数）→ 真实 UTC ms（两次迭代收敛，覆盖 DST 边界）。 */
function wallToUtc(day: CalendarDay, minuteOfDay: number, tz: string): number {
  const wall = Date.UTC(day.y, day.mo - 1, day.d, 0, 0, 0) + minuteOfDay * 60_000;
  let guess = wall - tzOffsetMs(wall, tz);
  guess = wall - tzOffsetMs(guess, tz);
  return guess;
}

/**
 * 创建/改期前的冲突预检：无时长、trivia、或 forceCreate 时直接放行。
 * 返回 null = 无冲突可继续；返回对象 = 冲突工具结果（尚未创建）。
 */
export function precheckCreateConflict(
  service: ScheduleConflictService,
  args: {
    sessionId: string;
    runAt: string;
    durationMinutes?: number;
    category?: ScheduleTaskRecord["category"];
    timezone: string;
    excludeTaskId?: string;
    forceCreate?: boolean;
  },
): Record<string, unknown> | null {
  if (args.forceCreate) return null;
  if (!args.durationMinutes || args.durationMinutes <= 0) return null;
  if (args.category === "trivia") return null;
  const runAtUtc = resolveRunAtToUtcIso(args.runAt, args.timezone);
  if (!runAtUtc) return null;
  const conflicts = service.findConflicts({
    sessionId: args.sessionId,
    runAt: runAtUtc,
    durationMinutes: args.durationMinutes,
    category: args.category,
    excludeTaskId: args.excludeTaskId,
  });
  if (conflicts.length === 0) return null;
  return buildConflictToolResult(conflicts, { timezone: args.timezone });
}

/**
 * 把工具入参 runAt 归一为 UTC ISO：带显式时区（Z / ±HH:MM）直接解析；
 * 无时区的裸墙钟时间按用户时区换算（与 ScheduleTaskService.parseRunAt 语义一致）。
 */
export function resolveRunAtToUtcIso(runAt: string, timezone: string): string | null {
  const raw = runAt.trim();
  if (!raw) return null;
  const hasExplicitTz = /(?:[zZ]|[+\-]\d{2}:?\d{2})$/.test(raw);
  if (hasExplicitTz) {
    const t = new Date(raw).getTime();
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
  }
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2})(?::(\d{2}))?(?::(\d{2}))?)?$/);
  if (!m) {
    const t = new Date(raw).getTime();
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
  }
  const day: CalendarDay = { y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]) };
  const minuteOfDay = (Number(m[4] ?? 0)) * 60 + Number(m[5] ?? 0);
  const tz = timezone?.trim() || "Asia/Shanghai";
  return new Date(wallToUtc(day, minuteOfDay, tz)).toISOString();
}

/** 冲突列表 → 工具返回值（matched=false + 结构化冲突 + 处理指引，供 LLM 转述）。 */
export function buildConflictToolResult(
  conflicts: ScheduleConflict[],
  options: { timezone: string; candidateRunAtLocal?: string },
): Record<string, unknown> {
  const fmt = (iso: string) =>
    new Date(iso).toLocaleString("zh-CN", {
      timeZone: options.timezone,
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  return {
    ok: true,
    matched: false,
    conflict: true,
    hint:
      "新日程与已有日程时间冲突，尚未创建。请向用户逐条转述 conflicts（标题+时间+重叠时长），并给出选项：①改到其他空闲时段（可调 calendar 的 action=find_free_slots 拿建议）②仍然创建（用户明确坚持时带 forceCreate=true 重调）③取消。用户答复前不要声称已创建。",
    conflicts: conflicts.map((c) => ({
      taskId: c.taskId,
      title: c.title,
      time: fmt(c.occurrenceStartAt),
      endLocal: fmt(c.occurrenceEndAt),
      overlapMinutes: c.overlapMinutes,
      recurrence: c.recurrence,
    })),
  };
}
