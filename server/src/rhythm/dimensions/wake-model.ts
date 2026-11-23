import type {
  RhythmDaypart,
  RhythmDimensionModel,
  RhythmObservation,
  WakeDimensionState,
  WakeSample,
  WakeTimeStats,
} from "../types.js";
import { median } from "../time-utils.js";
import {
  DAYPARTS,
  capConfidenceBySource,
  daypartOfDayKey,
  emptyDaypart,
  round3,
  sampleWins,
} from "./grouping.js";

/** 3 周：分组后每组每类日至少要能落 2-3 条，14 天不够分 */
const MAX_SAMPLES = 21;
/** 少于 3 个早晨样本不给中位数（与 sleep 同口径，宁缺勿假） */
const MIN_WAKE_SAMPLES = 3;
const PHONE_SOURCE = "phone-usage";

export const EMPTY_WAKE_STATE: WakeDimensionState = {
  samples: [],
  wakeHour: null,
  sampleCount: 0,
  trendMinutes: 0,
  byDaypart: emptyDaypart<WakeTimeStats>(() => ({ wakeHour: null, sampleCount: 0 })),
  phoneSampleRatio: 0,
};

function statsOf(samples: WakeSample[]): WakeTimeStats {
  // 起床时刻全落在清晨到上午，不需要跨午夜修正；唯一例外是通宵后 22 点才起，
  // 那是离群值，交给中位数吸收，不做 +24（否则 7 点与 22 点会被拉成 14.5 点的假中位）
  return {
    wakeHour:
      samples.length >= MIN_WAKE_SAMPLES ? round3(median(samples.map((s) => s.hour))) : null,
    sampleCount: samples.length,
  };
}

/**
 * 起床维度模型器（PRD §7.3「新维度 wake，从 sleep 中拆出」）。
 *
 * 为什么要拆：sleep 的 windowEndHour 与入睡共用一个样本集，周末"晚睡 + 补觉"
 * 会把工作日的起床时刻拖后 1 小时以上，而早安 slot 要的恰恰是"工作日几点起"。
 *
 * 输入观察：kind="wake_sample"，value=起床十进制小时，at=起床当天。
 * 手机桶（phone-usage）与桌面睡眠窗（sleep-window）两条链都由传感器直报这种
 * 观察，引擎按 dimension 分发，本模型器不必再去 sleep 维度里捞一半样本。
 * 同一天去重按来源优先级：手机 > 桌面 > 自述（见 grouping.ts）。
 */
export class WakeDimensionModel implements RhythmDimensionModel<WakeDimensionState> {
  readonly dimension = "wake" as const;

  ingest(
    prev: WakeDimensionState | null,
    observations: RhythmObservation[],
  ): WakeDimensionState {
    const byDate = new Map<string, WakeSample>();
    for (const sample of prev?.samples ?? []) {
      byDate.set(sample.date, { ...sample });
    }
    for (const obs of observations) {
      if (obs.kind !== "wake_sample" || !Number.isFinite(obs.value)) continue;
      const date = obs.at.slice(0, 10);
      if (!date) continue;
      const hour = obs.value;
      if (hour < 0 || hour >= 24) continue;
      const existing = byDate.get(date);
      if (existing && !sampleWins({ incomingSource: obs.source, existingSource: existing.source })) {
        continue;
      }
      byDate.set(date, { date, hour, source: obs.source });
    }

    const samples = [...byDate.values()]
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(-MAX_SAMPLES);

    const overall = statsOf(samples);
    const byDaypart = emptyDaypart<WakeTimeStats>(() => ({ wakeHour: null, sampleCount: 0 }));
    for (const part of DAYPARTS as readonly RhythmDaypart[]) {
      byDaypart[part] = statsOf(samples.filter((s) => daypartOfDayKey(s.date) === part));
    }

    const hours = samples.map((s) => s.hour);
    const recent = hours.slice(-3);
    const prior = hours.slice(0, Math.max(0, hours.length - 3));
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

  /**
   * 7 个早晨样本即满置信（§7.6 验收：手机用户连续 5 天 wake 置信度 ≥0.6，
   * 5/7≈0.71 达标）。纯自述（问卷）样本压到 0.4 以下——统计没长出来之前，
   * 自述值只作为"知道有这么个时刻"的占位，不足以驱动触点切统计钟（§7.4）。
   */
  confidence(state: WakeDimensionState): number {
    if (state.sampleCount < MIN_WAKE_SAMPLES) return 0;
    return capConfidenceBySource(
      Math.min(1, state.sampleCount / 7),
      state.samples.map((s) => s.source),
    );
  }
}
