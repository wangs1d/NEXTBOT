/**
 * 维度统计的共用小件（PRD §7.3「周末 / 工作日分组」+「手机样本优先」）。
 *
 * 为什么单独一个文件：sleep / wake / commute 三个模型器都要做同一件事
 * ——按工作日/周末分桶取中位数、同一天的样本按数据来源定谁说了算。
 * 复制三份「看着差不多」的中位数就会长出三套口径，正撞 §7.1 的红线。
 */

/** 作息分组：工作日 / 周末（周六周日）。分组只是"读法"，不是新维度。 */
export type RhythmDaypart = "weekday" | "weekend";

export const DAYPARTS: readonly RhythmDaypart[] = ["weekday", "weekend"] as const;

export function daypartOfWeekday(weekday: number): RhythmDaypart {
  return weekday === 0 || weekday === 6 ? "weekend" : "weekday";
}

/** 日期键（YYYY-MM-DD）→ 分组；正午取样避开时区偏移串日（与 sleep 样本同口径） */
export function daypartOfDayKey(dateKey: string): RhythmDaypart {
  const d = new Date(`${dateKey}T12:00:00`);
  return daypartOfWeekday(d.getDay());
}

export function emptyDaypart<T>(make: () => T): Record<RhythmDaypart, T> {
  return { weekday: make(), weekend: make() };
}

/** 中位数；空集合返回 null（区别于 time-utils.median 的"空返回 0"——作息没数据不能编一个 0 点） */
export function medianOrNull(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2 : sorted[mid] ?? 0;
}

/** 保留 3 位小数（十进制小时的分钟精度约 0.017，3 位足够且不放大 JSON） */
export function round3(n: number | null): number | null {
  return n === null || !Number.isFinite(n) ? null : Math.round(n * 1000) / 1000;
}

/**
 * 样本来源优先级（§7.3「手机样本优先」+ §7.4「问卷值置信度低于统计值」）。
 * 数字越大越硬。未登记的来源按桌面观察（1）处理：新数据源接进来不会
 * 静默压过手机直报，要压就得在这里显式表态。
 */
export const SOURCE_PRIORITY: Record<string, number> = {
  "phone-usage": 3,
  "presence-footprint": 2,
  "sleep-window": 1,
  "desktop-activity": 1,
  "interaction-signal": 1,
  // 自述/问卷（§7.4 的三个问题，未来写进 schedule-habit 自述口）：最软
  "self-report": 0,
  survey: 0,
};

export function priorityOf(source: string | null | undefined): number {
  if (!source) return 1;
  return SOURCE_PRIORITY[source] ?? 1;
}

/** 自述样本单独能给出的置信度上限：低于触点计划冷启动闸（0.5），统计到位前不切统计钟 */
export const SELF_REPORT_CONFIDENCE_CAP = 0.4;

/**
 * 同一天两条样本谁作数：高优先级源覆盖低优先级源，同优先级后来者覆盖。
 * `incomingIndex` 只用于同级仲裁时的可读性（数组顺序即采集顺序）。
 */
export function sampleWins(opts: {
  incomingSource: string | null | undefined;
  existingSource: string | null | undefined;
}): boolean {
  return priorityOf(opts.incomingSource) >= priorityOf(opts.existingSource);
}

/**
 * 置信度按来源封顶：一组样本里只要有过一条非自述观察，就按真实统计给分；
 * 全是自述（问卷/对话说的）才压到 SELF_REPORT_CONFIDENCE_CAP。
 */
export function capConfidenceBySource(confidence: number, sources: Array<string | null | undefined>): number {
  if (sources.length === 0) return 0;
  const hasObserved = sources.some((s) => priorityOf(s) >= 1);
  if (hasObserved) return confidence;
  return Math.min(confidence, SELF_REPORT_CONFIDENCE_CAP);
}
