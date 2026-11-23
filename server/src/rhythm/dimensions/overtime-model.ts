import type { OvertimeDimensionState, RhythmDimensionModel, RhythmObservation } from "../types.js";
import { localDayKey } from "../time-utils.js";
import { daypartOfWeekday, emptyDaypart } from "./grouping.js";

/** 当日最后一次活跃晚于该小时（20:30）视为"晚归/加班日" */
export const LATE_DAY_HOUR = 20.5;
/** 保留的最近观察日数（约 8 周，够看出"每周几容易加班"） */
const MAX_DAYS = 56;

export const EMPTY_OVERTIME_STATE: OvertimeDimensionState = {
  recentDays: [],
  byWeekday: new Array<number>(7).fill(0),
  weekdayDays: new Array<number>(7).fill(0),
  totalDays: 0,
  byDaypart: emptyDaypart(() => ({ lateRatio: 0, days: 0 })),
};

/**
 * 加班/晚归维度模型器。
 *
 * 输入观察：kind="desktop_active"（value=十进制本地小时）。按本地日聚合出
 * 每日"最后活跃小时"，≥20.5 记为晚归位；状态保存最近 56 天的位序列，
 * 概率按星期聚合派生。按日去重保证夜间重复分析同一天不会重复计数。
 */
export class OvertimeDimensionModel implements RhythmDimensionModel<OvertimeDimensionState> {
  readonly dimension = "overtime" as const;

  ingest(
    prev: OvertimeDimensionState | null,
    observations: RhythmObservation[],
    _ctx: { now: Date },
  ): OvertimeDimensionState {
    const lastHourByDay = new Map<string, number>();
    for (const obs of observations) {
      if (obs.kind !== "desktop_active" || !Number.isFinite(obs.value)) continue;
      const dayKey = localDayKey(new Date(obs.at));
      const existing = lastHourByDay.get(dayKey) ?? -1;
      if (obs.value > existing) lastHourByDay.set(dayKey, obs.value);
    }

    const byDate = new Map<string, OvertimeDimensionState["recentDays"][number]>();
    for (const bit of prev?.recentDays ?? []) {
      byDate.set(bit.date, bit);
    }
    for (const [dayKey, lastHour] of lastHourByDay) {
      byDate.set(dayKey, {
        date: dayKey,
        weekday: new Date(`${dayKey}T12:00:00`).getDay(),
        late: lastHour >= LATE_DAY_HOUR ? 1 : 0,
      });
    }

    const recentDays = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-MAX_DAYS);
    const { byWeekday, weekdayDays, byDaypart } = aggregateByWeekday(recentDays);
    return { recentDays, byWeekday, weekdayDays, byDaypart, totalDays: recentDays.length };
  }

  /** ≥20 个活跃日即满置信 */
  confidence(state: OvertimeDimensionState): number {
    return Math.min(1, state.totalDays / 20);
  }
}

export function aggregateByWeekday(recentDays: OvertimeDimensionState["recentDays"]): {
  byWeekday: number[];
  weekdayDays: number[];
  byDaypart: OvertimeDimensionState["byDaypart"];
} {
  const byWeekday = new Array<number>(7).fill(0);
  const weekdayDays = new Array<number>(7).fill(0);
  const byDaypart = emptyDaypart(() => ({ lateRatio: 0, days: 0 }));
  for (const bit of recentDays) {
    const idx = bit.weekday;
    if (idx < 0 || idx > 6) continue;
    weekdayDays[idx] += 1;
    byWeekday[idx] += bit.late;
    const part = daypartOfWeekday(idx);
    byDaypart[part].days += 1;
    if (bit.late === 1) byDaypart[part].lateRatio += 1;
  }
  for (let d = 0; d < 7; d++) {
    byWeekday[d] = weekdayDays[d] > 0 ? Math.round((byWeekday[d]! / weekdayDays[d]!) * 1000) / 1000 : 0;
  }
  for (const part of ["weekday", "weekend"] as const) {
    const g = byDaypart[part];
    g.lateRatio = g.days > 0 ? Math.round((g.lateRatio / g.days) * 1000) / 1000 : 0;
  }
  return { byWeekday, weekdayDays, byDaypart };
}
