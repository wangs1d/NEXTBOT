import type {
  ReceptivityDimensionState,
  RhythmDaypart,
  RhythmDimensionModel,
  RhythmObservation,
} from "../types.js";
import { daypartOfWeekday, emptyDaypart } from "./grouping.js";

const EWMA_ALPHA = 0.25;
/** 位置移动观察的（更低）更新步长：不是真实触达反馈，只作弱负信号 */
const MOVEMENT_ALPHA = 0.15;
/** 屏幕占用观察（开会/写代码/玩游戏等强勿扰状态）的弱负步长：同移动，弱于真实反馈 */
const SCREEN_BUSY_ALPHA = 0.15;

function zeros24(): number[] {
  return new Array<number>(24).fill(0);
}

export const EMPTY_RECEPTIVITY_STATE: ReceptivityDimensionState = {
  byHour: zeros24(),
  byWeekday: new Array<number>(7).fill(0),
  attempts: 0,
  byDaypartHour: emptyDaypart<number[]>(zeros24),
};

/** 某分组的 24 槽接受度曲线；该组全空时回退总体曲线（消费方不必各自判空） */
export function receptivityHourCurve(
  state: ReceptivityDimensionState | undefined | null,
  part: RhythmDaypart,
): number[] {
  const grouped = state?.byDaypartHour?.[part];
  if (grouped && grouped.some((x) => x > 0)) return grouped;
  return state?.byHour ?? EMPTY_RECEPTIVITY_STATE.byHour;
}

/**
 * 触达接受度维度模型器。
 *
 * 数据不来自 collect 传感器，而是引擎在线 push（recordContactOutcome ←
 * UserPersonalizationService.observeContactOutcome 回调）。每次主动触达的
 * 结果更新对应小时/星期的接受度 EWMA：accepted/replied=1，dismissed/ignored=0，
 * snoozed=0.5（用户没拒绝但时机不对）。
 *
 * 位置扩展（方案 D）：location 传感器产出的 kind="location_movement" 观察
 * （value=0 移动中）以更低步长把对应时段的接受度拉向 0——通勤/外出时
 * 主动消息大概率被忽略。只消费移动负信号：静止（value=1）不贡献，
 * 避免高频位置上报虚增接受度；attempts 也只计真实触达反馈（置信度口径不变）。
 *
 * 屏幕状态扩展：screen-focus / phone-usage 传感器的 kind="screen_busy" 观察
 * （开会/写代码/游戏/通话…占用时段，value=0）以同等的弱负步长拉低对应小时
 * ——主动感知不只「几点听得进话」，还有「什么状态下听得进话」。
 *
 * 分组扩展（§7.3「各维度按工作日、周末分开统计」）：同一批观察额外按
 * 工作日/周末各记一条小时曲线——周六 10 点答得最快，不能用它决定工作日的
 * 午间触点。attempts 仍只数真实反馈一次，分组不重复计数。
 */
export class ReceptivityDimensionModel implements RhythmDimensionModel<ReceptivityDimensionState> {
  readonly dimension = "receptivity" as const;

  ingest(
    prev: ReceptivityDimensionState | null,
    observations: RhythmObservation[],
  ): ReceptivityDimensionState {
    const byHour = [...(prev?.byHour ?? EMPTY_RECEPTIVITY_STATE.byHour)];
    const byWeekday = [...(prev?.byWeekday ?? EMPTY_RECEPTIVITY_STATE.byWeekday)];
    const prevSplit = prev?.byDaypartHour ?? EMPTY_RECEPTIVITY_STATE.byDaypartHour;
    const byDaypartHour: ReceptivityDimensionState["byDaypartHour"] = {
      weekday: [...(prevSplit.weekday ?? zeros24())],
      weekend: [...(prevSplit.weekend ?? zeros24())],
    };
    let attempts = prev?.attempts ?? 0;

    /** 三种信号的落槽写法收在一处：总体小时 + 星期 + 工作日/周末分组 */
    const apply = (
      kind: "movement" | "busy" | "outcome",
      hour: number,
      weekday: number,
      part: RhythmDaypart,
      value: number,
    ): void => {
      if (kind === "outcome") {
        byHour[hour] = (byHour[hour] ?? 0) * (1 - EWMA_ALPHA) + value * EWMA_ALPHA;
        byWeekday[weekday] = (byWeekday[weekday] ?? 0) * (1 - EWMA_ALPHA) + value * EWMA_ALPHA;
        byDaypartHour[part][hour] =
          (byDaypartHour[part][hour] ?? 0) * (1 - EWMA_ALPHA) + value * EWMA_ALPHA;
        attempts += 1;
        return;
      }
      const alpha = kind === "movement" ? MOVEMENT_ALPHA : SCREEN_BUSY_ALPHA;
      byHour[hour] = (byHour[hour] ?? 0) * (1 - alpha);
      byWeekday[weekday] = (byWeekday[weekday] ?? 0) * (1 - alpha);
      byDaypartHour[part][hour] = (byDaypartHour[part][hour] ?? 0) * (1 - alpha);
    };

    for (const obs of observations) {
      if (!Number.isFinite(obs.value)) continue;
      const at = new Date(obs.at);
      if (Number.isNaN(at.getTime())) continue;
      const hour = at.getHours();
      const weekday = at.getDay();
      const part = daypartOfWeekday(weekday);

      if (obs.kind === "location_movement") {
        if (obs.value >= 0.5) continue; // 静止不贡献（位置传感器实际只产 value=0）
        apply("movement", hour, weekday, part, 0);
        continue;
      }

      if (obs.kind === "screen_busy") {
        // 弱负信号把该小时拉向 0；普通状态不产出观察，不虚增接受度
        if (obs.value >= 0.5) continue;
        apply("busy", hour, weekday, part, 0);
        continue;
      }

      if (obs.kind !== "contact_outcome") continue;
      apply("outcome", hour, weekday, part, obs.value); // 0 / 0.5 / 1
    }

    const round = (arr: number[]): number[] => arr.map((x) => Math.round(x * 1000) / 1000);
    return {
      byHour: round(byHour),
      byWeekday: round(byWeekday),
      attempts,
      byDaypartHour: {
        weekday: round(byDaypartHour.weekday),
        weekend: round(byDaypartHour.weekend),
      },
    };
  }

  /** ≥12 次触达反馈即满置信 */
  confidence(state: ReceptivityDimensionState): number {
    return Math.min(1, state.attempts / 12);
  }
}
