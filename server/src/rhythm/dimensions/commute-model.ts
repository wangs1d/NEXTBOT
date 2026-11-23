import type {
  CommuteDaySample,
  CommuteDimensionState,
  CommuteLegStats,
  RhythmDaypart,
  RhythmDimensionModel,
  RhythmObservation,
} from "../types.js";
import {
  DAYPARTS,
  daypartOfDayKey,
  daypartOfWeekday,
  emptyDaypart,
  medianOrNull,
  round3,
  sampleWins,
} from "./grouping.js";

/** 保留最近 8 周的通勤日（够用且 JSON 不涨） */
const MAX_DAYS = 56;
/** 一条腿要几天样本才敢对外给值：两条是中位数的最低门槛 */
const MIN_LEG_DAYS = 2;
/** 触点计划冷启动闸之外再加一道：分组天数不足这些时退回总体中位数 */
const MIN_GROUP_DAYS = 2;

type LegKey = "leaveHomeHour" | "arriveWorkHour" | "leaveWorkHour";

const KIND_TO_LEG: Record<string, LegKey> = {
  commute_leave_home: "leaveHomeHour",
  commute_arrive_work: "arriveWorkHour",
  commute_leave_work: "leaveWorkHour",
};

export const EMPTY_COMMUTE_STATE: CommuteDimensionState = {
  days: [],
  overall: { leaveHomeHour: null, arriveWorkHour: null, leaveWorkHour: null, days: 0 },
  byDaypart: emptyDaypart<CommuteLegStats>(() => ({
    leaveHomeHour: null,
    arriveWorkHour: null,
    leaveWorkHour: null,
    days: 0,
  })),
  leaveHomeByWeekday: new Array<number | null>(7).fill(null),
};

function statsOf(days: CommuteDaySample[]): CommuteLegStats {
  const leg = (key: LegKey): number | null => {
    const values = days.map((d) => d[key]).filter((x): x is number => Number.isFinite(x));
    if (values.length < MIN_LEG_DAYS) return null;
    return round3(medianOrNull(values) ?? null);
  };
  return {
    leaveHomeHour: leg("leaveHomeHour"),
    arriveWorkHour: leg("arriveWorkHour"),
    leaveWorkHour: leg("leaveWorkHour"),
    days: days.filter(
      (d) => d.leaveHomeHour !== null || d.arriveWorkHour !== null || d.leaveWorkHour !== null,
    ).length,
  };
}

/**
 * 通勤维度模型器（PRD §7.3「新维度 commute：围栏离家、到公司、离公司时间的
 * 中位数，按星期分布」）。
 *
 * 输入观察来自 phone-usage-sensor：端上 15 分钟桶里的 placeKind（家 / 公司 /
 * 其它）发生跳变的那一个桶——离家 = home→非 home，到公司 = 非 work→work，
 * 离公司 = work→非 work。三条腿各带 kind，value=十进制本地小时，at=当日。
 *
 * 状态只有一张"按日去重的三条腿"表，中位数（总体 / 工作日 / 周末 / 逐星期）
 * 全部从它派生——档案页和触点计划读的都是这份派生值，没有第二套统计。
 */
export class CommuteDimensionModel implements RhythmDimensionModel<CommuteDimensionState> {
  readonly dimension = "commute" as const;

  ingest(
    prev: CommuteDimensionState | null,
    observations: RhythmObservation[],
  ): CommuteDimensionState {
    const byDate = new Map<string, CommuteDaySample>();
    for (const day of prev?.days ?? []) {
      byDate.set(day.date, { ...day });
    }
    for (const obs of observations) {
      const leg = obs.kind ? KIND_TO_LEG[obs.kind] : undefined;
      if (!leg || !Number.isFinite(obs.value) || obs.value < 0 || obs.value >= 24) continue;
      const date = obs.at.slice(0, 10);
      if (!date) continue;
      const existing = byDate.get(date);
      // 同日同一条腿：高优先级来源（手机直报）不被低优先级覆盖，同级取最新
      const existingLeg = existing?.[leg];
      if (
        existingLeg !== null &&
        existingLeg !== undefined &&
        !sampleWins({ incomingSource: obs.source, existingSource: existing?.source })
      ) {
        continue;
      }
      byDate.set(date, {
        date,
        weekday: new Date(`${date}T12:00:00`).getDay(),
        leaveHomeHour: existing?.leaveHomeHour ?? null,
        arriveWorkHour: existing?.arriveWorkHour ?? null,
        leaveWorkHour: existing?.leaveWorkHour ?? null,
        source: obs.source,
        [leg]: round3(obs.value),
      } as CommuteDaySample);
    }

    const days = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-MAX_DAYS);
    const byDaypart = emptyDaypart<CommuteLegStats>(() => ({
      leaveHomeHour: null,
      arriveWorkHour: null,
      leaveWorkHour: null,
      days: 0,
    }));
    for (const part of DAYPARTS as readonly RhythmDaypart[]) {
      byDaypart[part] = statsOf(days.filter((d) => daypartOfWeekday(d.weekday) === part));
    }
    const leaveHomeByWeekday: Array<number | null> = new Array<number | null>(7).fill(null);
    for (let w = 0; w < 7; w++) {
      const values = days
        .filter((d) => d.weekday === w && d.leaveHomeHour !== null)
        .map((d) => d.leaveHomeHour as number);
      leaveHomeByWeekday[w] = values.length >= MIN_LEG_DAYS ? round3(medianOrNull(values)) : null;
    }

    return { days, overall: statsOf(days), byDaypart, leaveHomeByWeekday };
  }

  /** 5 个有通勤信号的日子即满置信（通勤是每天两趟的强信号，不需要 14 天） */
  confidence(state: CommuteDimensionState): number {
    return Math.min(1, state.overall.days / 5);
  }
}

/**
 * 触点计划取数口（§3.4 的「出门 / 下班」两个 slot）：按 date 落在工作日还是
 * 周末取该组中位数，组内天数不足则退回总体中位数，两条都没有 → null
 * （planner 拿到 null 就不生成这个 slot，宁缺勿假）。
 */
export function commuteMinutesOf(
  state: CommuteDimensionState | undefined | null,
  date: Date,
): { leaveHome: number | null; leaveWork: number | null } {
  const none = { leaveHome: null, leaveWork: null };
  if (!state) return none;
  const part = daypartOfDayKey(
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`,
  );
  const group = state.byDaypart?.[part as RhythmDaypart];
  const source = (group?.days ?? 0) >= MIN_GROUP_DAYS ? group : state.overall;
  if (!source) return none;
  const asMinutes = (h: number | null | undefined): number | null =>
    h !== null && h !== undefined && Number.isFinite(h) ? Math.round(h * 60) : null;
  return { leaveHome: asMinutes(source.leaveHomeHour), leaveWork: asMinutes(source.leaveWorkHour) };
}
