import { mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { writeJsonAtomic } from "../storage/atomic-json.js";
import { aggregateByWeekday } from "./dimensions/overtime-model.js";
import { daypartOfDayKey, daypartOfWeekday, medianOrNull } from "./dimensions/grouping.js";

import type { RhythmProfile } from "./types.js";

/** 旧版落盘数据兼容：从 recentDays 重新派生按星期聚合值 */
const aggregateOvertime = aggregateByWeekday;

/**
 * 节律画像存储：每 actor 一个 JSON 文件（data/rhythm_profiles/{actorId}.json），
 * writeJsonAtomic 原子落盘。文件名做安全转义，防 actorId 带路径分隔符。
 */
export class RhythmProfileStore {
  private readonly cache = new Map<string, RhythmProfile>();

  constructor(private readonly dir: string) {}

  async load(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    let entries: string[] = [];
    try {
      entries = await readdir(this.dir);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw err;
      return;
    }
    for ( const name of entries) {
      if (!name.endsWith(".json")) continue;
      const actorId = unescapeActorId(name.slice(0, -".json".length));
      try {
        const raw = await readFile(join(this.dir, name), "utf8");
        const profile = normalizeProfile(JSON.parse(raw));
        if (profile) this.cache.set(profile.actorId, profile);
      } catch (error) {
        console.error(`[RhythmProfileStore] load ${name} failed:`, error);
      }
    }
  }

  get(actorId: string): RhythmProfile | null {
    return this.cache.get(actorId) ?? null;
  }

  /** 读取或初始化画像（不落盘，落盘由 save 负责） */
  ensure(actorId: string, now = new Date()): RhythmProfile {
    const existing = this.cache.get(actorId);
    if (existing) return existing;
    const fresh = normalizeProfile({
      schemaVersion: 1,
      actorId,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      lastAnalyzedDay: null,
      dimensions: {},
      reminderSlots: {},
      lastCandidateAt: {},
      insights: [],
    })!;
    this.cache.set(actorId, fresh);
    return fresh;
  }

  async save(profile: RhythmProfile): Promise<void> {
    this.cache.set(profile.actorId, profile);
    await writeJsonAtomic(join(this.dir, `${escapeActorId(profile.actorId)}.json`), profile);
  }

  listActorIds(): string[] {
    return [...this.cache.keys()];
  }
}

function escapeActorId(actorId: string): string {
  return actorId.replace(/[^a-zA-Z0-9._-]/g, "_") || "unknown";
}

function unescapeActorId(name: string): string {
  return name;
}

/** 宽松归一化：磁盘旧版本/半损坏数据不致命，缺的字段补默认值 */
export function normalizeProfile(raw: unknown): RhythmProfile | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const actorId = typeof o.actorId === "string" ? o.actorId : "";
  if (!actorId) return null;
  const dims = (o.dimensions ?? {}) as Record<string, Record<string, unknown>>;
  const nowIso = new Date().toISOString();
  return {
    schemaVersion: 1,
    actorId,
    createdAt: typeof o.createdAt === "string" ? o.createdAt : nowIso,
    updatedAt: typeof o.updatedAt === "string" ? o.updatedAt : nowIso,
    lastAnalyzedDay: typeof o.lastAnalyzedDay === "string" ? o.lastAnalyzedDay : null,
    dimensions: {
      sleep: normalizeSleep(dims.sleep),
      wake: normalizeWake(dims.wake),
      commute: normalizeCommute(dims.commute),
      focus: normalizeFocus(dims.focus),
      overtime: normalizeOvertime(dims.overtime),
      receptivity: normalizeReceptivity(dims.receptivity),
    },
    reminderSlots: normalizeSlots(o.reminderSlots),
    lastCandidateAt:
      o.lastCandidateAt && typeof o.lastCandidateAt === "object"
        ? (o.lastCandidateAt as RhythmProfile["lastCandidateAt"])
        : {},
    insights: Array.isArray(o.insights) ? (o.insights as RhythmProfile["insights"]).slice(-20) : [],
  };
}

function normalizeSleep(v: Record<string, unknown> | undefined): RhythmProfile["dimensions"]["sleep"] {
  const samples = Array.isArray(v?.samples)
    ? (v!.samples as RhythmProfile["dimensions"]["sleep"]["samples"]).filter(
        (s) => s && typeof s.date === "string" && Number.isFinite(s.startHour) && Number.isFinite(s.endHour),
      )
    : [];
  const base: RhythmProfile["dimensions"]["sleep"] = {
    samples,
    windowStartHour: Number.isFinite(v?.windowStartHour) ? (v!.windowStartHour as number) : null,
    windowEndHour: Number.isFinite(v?.windowEndHour) ? (v!.windowEndHour as number) : null,
    sampleCount: samples.length,
    trendMinutes: Number.isFinite(v?.trendMinutes) ? (v!.trendMinutes as number) : 0,
    byDaypart: emptySplit(() => ({ windowStartHour: null, windowEndHour: null, sampleCount: 0 })),
    phoneSampleRatio: Number.isFinite(v?.phoneSampleRatio) ? (v!.phoneSampleRatio as number) : 0,
  };
  // 分组读数是派生值，磁盘上有就沿用、没有就按样本重算（旧版本文件不丢分组口径）
  return recomputeSleepSplit(base);
}

/** 起床维度（§7.3 从 sleep 拆出）：样本按"起床那天"记，分组口径与 sleep 一致 */
function normalizeWake(v: Record<string, unknown> | undefined): RhythmProfile["dimensions"]["wake"] {
  const samples = Array.isArray(v?.samples)
    ? (v!.samples as RhythmProfile["dimensions"]["wake"]["samples"]).filter(
        (s) => s && typeof s.date === "string" && Number.isFinite(s.hour),
      )
    : [];
  const state: RhythmProfile["dimensions"]["wake"] = {
    samples,
    wakeHour: Number.isFinite(v?.wakeHour) ? (v!.wakeHour as number) : null,
    sampleCount: samples.length,
    trendMinutes: Number.isFinite(v?.trendMinutes) ? (v!.trendMinutes as number) : 0,
    byDaypart: emptySplit(() => ({ wakeHour: null, sampleCount: 0 })),
    phoneSampleRatio: Number.isFinite(v?.phoneSampleRatio) ? (v!.phoneSampleRatio as number) : 0,
  };
  if (state.wakeHour === null && samples.length >= 3) {
    state.wakeHour = Math.round(medianOf(samples.map((s) => s.hour)) * 1000) / 1000;
  }
  for (const part of ["weekday", "weekend"] as const) {
    const group = samples.filter((s) => daypartOfDayKey(s.date) === part);
    state.byDaypart[part] = {
      wakeHour:
        group.length >= 3 ? Math.round(medianOf(group.map((s) => s.hour)) * 1000) / 1000 : null,
      sampleCount: group.length,
    };
  }
  return state;
}

/** 通勤维度：三条腿的按日样本，分组中位数全部从 days 现算（不留第二份账） */
function normalizeCommute(v: Record<string, unknown> | undefined): RhythmProfile["dimensions"]["commute"] {
  const days = Array.isArray(v?.days)
    ? (v!.days as RhythmProfile["dimensions"]["commute"]["days"]).filter(
        (d) => d && typeof d.date === "string" && Number.isInteger(d.weekday),
      )
    : [];
  const leg = (arr: typeof days, key: "leaveHomeHour" | "arriveWorkHour" | "leaveWorkHour"): number | null => {
    const values = arr.map((d) => d[key]).filter((x): x is number => Number.isFinite(x));
    return values.length >= 2 ? Math.round(medianOf(values) * 1000) / 1000 : null;
  };
  const stats = (arr: typeof days): RhythmProfile["dimensions"]["commute"]["overall"] => ({
    leaveHomeHour: leg(arr, "leaveHomeHour"),
    arriveWorkHour: leg(arr, "arriveWorkHour"),
    leaveWorkHour: leg(arr, "leaveWorkHour"),
    days: arr.filter((d) => d.leaveHomeHour !== null || d.arriveWorkHour !== null || d.leaveWorkHour !== null)
      .length,
  });
  const leaveHomeByWeekday: Array<number | null> = new Array<number | null>(7).fill(null);
  for (let w = 0; w < 7; w++) {
    leaveHomeByWeekday[w] = leg(
      days.filter((d) => d.weekday === w),
      "leaveHomeHour",
    );
  }
  return {
    days,
    overall: stats(days),
    byDaypart: {
      weekday: stats(days.filter((d) => daypartOfWeekday(d.weekday) === "weekday")),
      weekend: stats(days.filter((d) => daypartOfWeekday(d.weekday) === "weekend")),
    },
    leaveHomeByWeekday,
  };
}

/** 中位数（分组回算用）：口径与模型器共用 grouping.medianOrNull */
function medianOf(values: number[]): number {
  return medianOrNull(values) ?? 0;
}

function emptySplit<T>(make: () => T): Record<"weekday" | "weekend", T> {
  return { weekday: make(), weekend: make() };
}

/** sleep 的分组读数重算（跨午夜修正与模型器同口径：<12 点的样本 +24 再取中位） */
function recomputeSleepSplit(
  state: RhythmProfile["dimensions"]["sleep"],
): RhythmProfile["dimensions"]["sleep"] {
  for (const part of ["weekday", "weekend"] as const) {
    const group = state.samples.filter((s) => daypartOfDayKey(s.date) === part);
    const starts = group.map((s) => s.startHour);
    const ends = group.map((s) => s.endHour);
    const adj = (h: number): number => (h < 12 ? h + 24 : h);
    state.byDaypart[part] = {
      windowStartHour:
        group.length >= 3 ? Math.round((medianOf(starts.map(adj)) % 24) * 1000) / 1000 : null,
      windowEndHour:
        group.length >= 3 ? Math.round((medianOf(ends.map(adj)) % 24) * 1000) / 1000 : null,
      sampleCount: group.length,
    };
  }
  return state;
}

function normalizeFocus(v: Record<string, unknown> | undefined): RhythmProfile["dimensions"]["focus"] {
  const histogram = Array.isArray(v?.hourHistogram)
    ? (v!.hourHistogram as number[]).slice(0, 24).map((x) => (Number.isFinite(x) ? x : 0))
    : [];
  while (histogram.length < 24) histogram.push(0);
  const split = (v?.byDaypart ?? {}) as Record<string, Record<string, unknown>>;
  const group = (part: "weekday" | "weekend") => {
    const g = split[part] ?? {};
    const hist = Array.isArray(g.hourHistogram)
      ? (g.hourHistogram as number[]).slice(0, 24).map((x) => (Number.isFinite(x) ? x : 0))
      : [];
    while (hist.length < 24) hist.push(0);
    return {
      hourHistogram: hist,
      peakBlocks: Array.isArray(g.peakBlocks)
        ? (g.peakBlocks as RhythmProfile["dimensions"]["focus"]["peakBlocks"])
        : [],
      totalWeight: Number(g.totalWeight) || 0,
    };
  };
  return {
    hourHistogram: histogram,
    peakBlocks: Array.isArray(v?.peakBlocks) ? (v!.peakBlocks as RhythmProfile["dimensions"]["focus"]["peakBlocks"]) : [],
    totalWeight: Number(v?.totalWeight) || 0,
    // 分组直方图是同一批观察的另一份读法：磁盘上没有就留空数组（下次分析补齐）
    byDaypart: { weekday: group("weekday"), weekend: group("weekend") },
  };
}

function normalizeOvertime(v: Record<string, unknown> | undefined): RhythmProfile["dimensions"]["overtime"] {
  const fill = (arr: unknown, len: number): number[] => {
    const src = Array.isArray(arr) ? arr : [];
    const out = src.slice(0, len).map((x) => (Number.isFinite(x) ? x : 0));
    while (out.length < len) out.push(0);
    return out;
  };
  const recentDays = Array.isArray(v?.recentDays)
    ? (v!.recentDays as RhythmProfile["dimensions"]["overtime"]["recentDays"]).filter(
        (d): d is RhythmProfile["dimensions"]["overtime"]["recentDays"][number] =>
          !!d && typeof d.date === "string" && Number.isInteger(d.weekday) && (d.late === 0 || d.late === 1),
      )
    : [];
  const aggregated = aggregateOvertime(recentDays);
  return {
    recentDays,
    ...aggregated,
    totalDays: recentDays.length,
  };
}

function normalizeReceptivity(v: Record<string, unknown> | undefined): RhythmProfile["dimensions"]["receptivity"] {
  const fill = (arr: unknown, len: number): number[] => {
    const src = Array.isArray(arr) ? arr : [];
    const out = src.slice(0, len).map((x) => (Number.isFinite(x) ? x : 0));
    while (out.length < len) out.push(0);
    return out;
  };
  return {
    byHour: fill(v?.byHour, 24),
    byWeekday: fill(v?.byWeekday, 7),
    attempts: Number(v?.attempts) || 0,
    // 工作日/周末两条曲线：旧文件没有就是全 0（下次有反馈时按分组累计）
    byDaypartHour: {
      weekday: fill((v?.byDaypartHour as Record<string, unknown> | undefined)?.weekday, 24),
      weekend: fill((v?.byDaypartHour as Record<string, unknown> | undefined)?.weekend, 24),
    },
  };
}

function normalizeSlots(v: unknown): RhythmProfile["reminderSlots"] {
  if (!v || typeof v !== "object") return {};
  const out: RhythmProfile["reminderSlots"] = {};
  for (const [taskId, slot] of Object.entries(v as Record<string, Record<string, unknown>>)) {
    if (!slot || typeof slot !== "object" || !Number.isFinite(slot.hour)) continue;
    out[taskId] = {
      taskId,
      hour: slot.hour as number,
      originalHour: Number.isFinite(slot.originalHour) ? (slot.originalHour as number) : (slot.hour as number),
      acceptanceEwma: Number.isFinite(slot.acceptanceEwma) ? (slot.acceptanceEwma as number) : null,
      attempts: Number(slot.attempts) || 0,
      lastAdjustedAt: typeof slot.lastAdjustedAt === "string" ? slot.lastAdjustedAt : null,
      lastAdjustDirection:
        slot.lastAdjustDirection === "earlier" || slot.lastAdjustDirection === "later"
          ? slot.lastAdjustDirection
          : null,
      pinnedByUser: slot.pinnedByUser === true,
    };
  }
  return out;
}
