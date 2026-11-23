import { shiftDayKey } from "../time-utils.js";
import type { RhythmDimension, RhythmObservation, RhythmSensor } from "../types.js";

/** 睡眠样本来源（AwarenessCortex 的最小接口，bootstrap 注入；测试可桩替） */
export type SleepSampleSource = {
  getRecentSleepWindowSamples(
    actorId: string,
    limit?: number,
  ): Array<{ date: string; startHour: number; endHour: number }>;
};

/** 入睡在晚间才算"过夜"，醒来归次日；下午的小憩醒来仍归当天 */
const OVERNIGHT_START_HOUR = 18;

/**
 * 睡眠传感器：从 AwarenessCortex 的学习样本拉取入睡/醒来窗口。
 * AwarenessCortex 依据桌面无活动 + 夜间时段判定 sleeping 会话（≥30min 计样本）。
 *
 * PRD §7.3：一条桌面样本同时喂两个维度——入睡进 sleep，醒来进 wake。
 * 引擎按 obs.dimension 分发（engine.ts collectAll），所以这里就得把两半
 * 拆成两条观察，否则新 wake 维度拿不到桌面兜底数据、手机一断供 wake 直接归零。
 * 优先级不在传感器里判：手机样本 source="phone-usage" 由模型器按来源压制本传感器。
 */
export class SleepWindowSensor implements RhythmSensor {
  readonly id = "sleep-window";
  readonly dimensions: RhythmDimension[] = ["sleep", "wake"];
  /** 睡眠样本链自检：源已绑定且 runtime 在跑时每轮应有观察；零观察=断供（2026-10-05 事故教训） */
  readonly expectsObservations = true;

  private source: SleepSampleSource | null = null;

  /** bootstrap 在 AwarenessCortex 实例化后注入（brain 关闭时保持 null，无观察产出） */
  bindSource(source: SleepSampleSource | null): void {
    this.source = source;
  }

  collect(actorId: string): RhythmObservation[] {
    if (!this.source) return [];
    const samples = this.source.getRecentSleepWindowSamples(actorId, 14);
    const obs: RhythmObservation[] = [];
    for (const sample of samples) {
      if (!sample.date) continue;
      // 样本只有日期（AwarenessCortex 按 dayKey 记录），取正午避免时区偏移串日
      obs.push({
        dimension: "sleep",
        at: `${sample.date}T12:00:00`,
        value: sample.startHour,
        value2: Number.isFinite(sample.endHour) ? sample.endHour : undefined,
        kind: "sleep_sample",
        source: this.id,
      });
      if (Number.isFinite(sample.endHour) && sample.endHour >= 0 && sample.endHour < 24) {
        obs.push({
          dimension: "wake",
          at: `${shiftDayKey(sample.date, sample.startHour >= OVERNIGHT_START_HOUR ? 1 : 0)}T12:00:00`,
          value: sample.endHour,
          kind: "wake_sample",
          source: this.id,
        });
      }
    }
    return obs;
  }
}
