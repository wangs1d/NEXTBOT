import type { RhythmDimensionStates, RhythmInsight } from "./types.js";
import { formatHour } from "./time-utils.js";

/**
 * 洞察构建器（纯统计，零 LLM）。
 *
 * 从各维度状态派生人话洞察。notifiable=true 表示强度达到"值得主动关怀"
 * 的门槛（趋势 ≥45 分钟 / 加班概率 ≥0.75），是否真的发出去仍由消费方
 * 频控（3 天/维度）与现有主动决策链把关。
 */
export function buildInsights(
  dimensions: RhythmDimensionStates,
  ctx: { now: Date },
): RhythmInsight[] {
  const generatedAt = ctx.now.toISOString();
  const dayKey = ctx.now.toISOString().slice(0, 10);
  const insights: RhythmInsight[] = [];
  const push = (insight: Omit<RhythmInsight, "id" | "generatedAt">) => {
    insights.push({
      ...insight,
      id: `ins-${dayKey}-${insight.dimension}-${insights.length + 1}`,
      generatedAt,
    });
  };

  // ── 睡眠 ──
  const sleep = dimensions.sleep;
  if (sleep.sampleCount >= 5 && sleep.windowStartHour !== null) {
    if (Math.abs(sleep.trendMinutes) >= 30) {
      const later = sleep.trendMinutes > 0;
      push({
        dimension: "sleep",
        kind: "trend",
        confidence: Math.min(1, sleep.sampleCount / 7),
        text: `入睡时间比之前${later ? "晚" : "早"}了约 ${Math.abs(sleep.trendMinutes)} 分钟（近几天约 ${formatHour(sleep.windowStartHour)} 入睡）`,
        evidence: sleep.samples.slice(-6).map((s) => `${s.date} ${formatHour(s.startHour)} 入睡`),
        notifiable: Math.abs(sleep.trendMinutes) >= 45,
      });
    }
    if (sleep.windowStartHour >= 0.5 && sleep.windowStartHour <= 3) {
      push({
        dimension: "sleep",
        kind: "suggestion",
        confidence: Math.min(1, sleep.sampleCount / 7),
        text: `你最近平均 ${formatHour(sleep.windowStartHour)} 才入睡，连续晚睡会攒疲劳，可以把睡前提醒安排得早一点`,
        evidence: sleep.samples.slice(-5).map((s) => `${s.date} ${formatHour(s.startHour)} 入睡`),
        notifiable: false,
      });
    }
  }

  // ── 起床（§7.3 从睡眠拆出的维度：早安 slot 直接用它，所以单独说一句话） ──
  const wake = dimensions.wake;
  if (wake && wake.sampleCount >= 5 && wake.wakeHour !== null) {
    const weekday = wake.byDaypart?.weekday;
    const weekend = wake.byDaypart?.weekend;
    const gap =
      weekday?.wakeHour !== null && weekday?.wakeHour !== undefined && weekend?.wakeHour !== null && weekend?.wakeHour !== undefined && weekday.sampleCount >= 2 && weekend.sampleCount >= 2
        ? Math.round((weekend.wakeHour - weekday.wakeHour) * 60)
        : null;
    push({
      dimension: "wake",
      kind: "observation",
      confidence: Math.min(1, wake.sampleCount / 7),
      text:
        gap !== null && Math.abs(gap) >= 45
          ? `工作日大概 ${formatHour(weekday!.wakeHour!)} 起，周末要睡到 ${formatHour(weekend!.wakeHour!)}（差 ${Math.abs(gap)} 分钟）`
          : `你一般 ${formatHour(wake.wakeHour)} 前后起床`,
      evidence: wake.samples.slice(-5).map((s) => `${s.date} ${formatHour(s.hour)} 起`),
      notifiable: false,
    });
    if (Math.abs(wake.trendMinutes) >= 45) {
      push({
        dimension: "wake",
        kind: "trend",
        confidence: Math.min(1, wake.sampleCount / 7),
        text: `起床时间比之前${wake.trendMinutes > 0 ? "晚" : "早"}了约 ${Math.abs(wake.trendMinutes)} 分钟`,
        evidence: wake.samples.slice(-6).map((s) => `${s.date} ${formatHour(s.hour)} 起`),
        notifiable: false,
      });
    }
  }

  // ── 通勤（§7.3 新维度：出门/下班两个触点的依据） ──
  const commute = dimensions.commute;
  if (commute && commute.overall.days >= 3 && commute.overall.leaveHomeHour !== null) {
    const weekday = commute.byDaypart?.weekday;
    push({
      dimension: "commute",
      kind: "observation",
      confidence: Math.min(1, commute.overall.days / 5),
      text: `工作日差不多 ${formatHour(weekday?.leaveHomeHour ?? commute.overall.leaveHomeHour)} 出门${
        commute.overall.leaveWorkHour !== null ? `、${formatHour(commute.overall.leaveWorkHour)} 离开公司` : ""
      }`,
      evidence: commute.days
        .slice(-5)
        .map(
          (d) =>
            `${d.date} 离家${d.leaveHomeHour !== null ? ` ${formatHour(d.leaveHomeHour)}` : " —"}${
              d.leaveWorkHour !== null ? ` 离司 ${formatHour(d.leaveWorkHour)}` : ""
            }`,
        ),
      notifiable: false,
    });
  }

  // ── 加班/晚归 ──
  const overtime = dimensions.overtime;
  if (overtime.totalDays >= 6) {
    const names = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
    let worstIdx = -1;
    for (let d = 0; d < 7; d++) {
      if ((overtime.weekdayDays[d] ?? 0) < 3) continue;
      if (worstIdx < 0 || (overtime.byWeekday[d] ?? 0) > (overtime.byWeekday[worstIdx] ?? 0)) {
        worstIdx = d;
      }
    }
    if (worstIdx >= 0 && (overtime.byWeekday[worstIdx] ?? 0) >= 0.6) {
      const prob = overtime.byWeekday[worstIdx] ?? 0;
      const lateDays = overtime.recentDays.filter((b) => b.weekday === worstIdx && b.late === 1).length;
      push({
        dimension: "overtime",
        kind: "observation",
        confidence: Math.min(1, overtime.totalDays / 20),
        text: `${names[worstIdx]}最容易晚归：最近 ${overtime.weekdayDays[worstIdx]} 个${names[worstIdx]}里有 ${lateDays} 天忙到 20:30 以后`,
        evidence: overtime.recentDays
          .filter((b) => b.weekday === worstIdx)
          .slice(-5)
          .map((b) => `${b.date}${b.late ? " 晚归" : ""}`),
        notifiable: prob >= 0.75 && (overtime.weekdayDays[worstIdx] ?? 0) >= 4,
      });
    }
  }

  // ── 专注时段 ──
  const focus = dimensions.focus;
  const topBlock = focus.peakBlocks[0];
  if (topBlock && topBlock.score >= 0.6) {
    push({
      dimension: "focus",
      kind: "observation",
      confidence: Math.min(1, focus.totalWeight / 50),
      text: `${formatHour(topBlock.startHour)}-${formatHour(topBlock.endHour)} 是你的高效专注时段，重要的事建议放在这个窗口`,
      evidence: focus.peakBlocks.map(
        (b) => `${formatHour(b.startHour)}-${formatHour(b.endHour)}（强度 ${b.score}）`,
      ),
      notifiable: false,
    });
  }

  return insights.slice(0, 6);
}
