import type {
  RhythmDimensionModel,
  RhythmObservation,
  SleepDimensionState,
  SleepSample,
  SleepWindowStats,
} from "../types.js";
import { median } from "../time-utils.js";
import {
  DAYPARTS,
  daypartOfDayKey,
  emptyDaypart,
  round3,
  sampleWins,
} from "./grouping.js";

import type { RhythmDaypart } from "../types.js";

const MAX_SAMPLES = 14;
/** 出窗口值所需的最少样本数（与原口径一致：3 晚以下不给中位数） */
const MIN_WINDOW_SAMPLES = 3;
/** 手机直报来源 id（phone-usage-sensor）：占比统计与"这份作息是谁给的"都用它 */
const PHONE_SOURCE = "phone-usage";

export const EMPTY_SLEEP_STATE: SleepDimensionState = {
  samples: [],
  windowStartHour: null,
  windowEndHour: null,
  sampleCount: 0,
  trendMinutes: 0,
  byDaypart: emptyDaypart<SleepWindowStats>(() => ({
    windowStartHour: null,
    windowEndHour: null,
    sampleCount: 0,
  })),
  phoneSampleRatio: 0,
};

/** 一组样本 → 窗口读数（总体与分组同一把尺子，不再各写一遍中位数） */
function statsOf(samples: SleepSample[], overnight = false): SleepWindowStats {
  const startHours = samples.map((s) => s.startHour);
  const endHours = samples.map((s) => s.endHour);
  // 跨午夜修正：入睡窗口常跨 0 点（23.5 与 0.9 实际相差 1.4h 而非 22.6h）。
  // 存在 ≥18 点样本且存在 <12 点样本时，把 <12 的样本 +24 后再取中位数。
  const crossesMidnight = overnight || (startHours.some((h) => h >= 18) && startHours.some((h) => h < 12));
  const adj = (h: number): number => (crossesMidnight && h < 12 ? h + 24 : h);
  return {
    windowStartHour:
      samples.length >= MIN_WINDOW_SAMPLES ? round3(median(startHours.map(adj)) % 24) : null,
    windowEndHour:
      samples.length >= MIN_WINDOW_SAMPLES ? round3(median(endHours.map(adj)) % 24) : null,
    sampleCount: samples.length,
  };
}

/**
 * 睡眠维度模型器。
 *
 * 输入观察：kind="sleep_sample"，value=入睡十进制小时，value2=醒来小时，
 * at=样本日（当天任意时刻）。同一 date 的样本去重（夜间重复分析不叠加）。
 * 状态：最近 14 个样本 + 中位数窗口 + 近 3 样本相对之前的趋势（分钟）
 *      + 工作日/周末分组读数（§7.3）。
 *
 * 同日多样本的取舍按来源优先级（见 grouping.ts 的 SOURCE_PRIORITY）：
 * 手机直报（phone-usage）> 桌面推断（sleep-window）> 用户自述。桌面样本
 * 保留是有意为之的兜底源——手机没上报的那几天仍要有作息。
 */
export class SleepDimensionModel implements RhythmDimensionModel<SleepDimensionState> {
  readonly dimension = "sleep" as const;

  ingest(
    prev: SleepDimensionState | null,
    observations: RhythmObservation[],
  ): SleepDimensionState {
    const byDate = new Map<string, SleepSample>();
    for (const sample of prev?.samples ?? []) {
      byDate.set(sample.date, { ...sample });
    }
    for (const obs of observations) {
      if (obs.kind !== "sleep_sample" || !Number.isFinite(obs.value)) continue;
      const date = obs.at.slice(0, 10);
      if (!date) continue;
      const existing = byDate.get(date);
      // 手机样本优先：低优先级来源（含桌面推断、自述）不得覆盖高优先级样本；
      // 同优先级后来者覆盖（数据源自己更新了才重发同日样本）
      if (existing && !sampleWins({ incomingSource: obs.source, existingSource: existing.source })) {
        continue;
      }
      byDate.set(date, {
        date,
        startHour: obs.value,
        endHour: Number.isFinite(obs.value2) ? obs.value2! : (existing?.endHour ?? obs.value),
        source: obs.source,
      });
    }
    const samples = [...byDate.values()]
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(-MAX_SAMPLES);

    const overall = statsOf(samples);
    const byDaypart = emptyDaypart<SleepWindowStats>(() => ({
      windowStartHour: null,
      windowEndHour: null,
      sampleCount: 0,
    }));
    for (const part of DAYPARTS as readonly RhythmDaypart[]) {
      byDaypart[part] = statsOf(samples.filter((s) => daypartOfDayKey(s.date) === part), true);
    }

    // 跨午夜趋势：与窗口同一把 adj 尺子，否则"23 点 → 0 点"会算成提前 14 小时
    const startHours = samples.map((s) => s.startHour);
    const crosses = startHours.some((h) => h >= 18) && startHours.some((h) => h < 12);
    const adj = (h: number): number => (crosses && h < 12 ? h + 24 : h);
    const recent = startHours.slice(-3).map(adj);
    const prior = startHours.slice(0, Math.max(0, startHours.length - 3)).map(adj);
    let trendMinutes = prev?.trendMinutes ?? 0;
    if (recent.length >= 2 && prior.length >= 2) {
      trendMinutes = Math.round((median(recent) - median(prior)) * 60);
    }

    const phoneDays = samples.filter((s) => s.source === PHONE_SOURCE).length;

    return {
      samples,
      ...overall,
      trendMinutes,
      byDaypart,
      phoneSampleRatio: samples.length > 0 ? Math.round((phoneDays / samples.length) * 1000) / 1000 : 0,
    };
  }

  /** 7 个晚样本即满置信（出口 A 调整提醒的门槛） */
  confidence(state: SleepDimensionState): number {
    return Math.min(1, state.sampleCount / 7);
  }
}
