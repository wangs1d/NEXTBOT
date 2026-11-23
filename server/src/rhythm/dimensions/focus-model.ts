import type {
  FocusDimensionState,
  FocusGroupStats,
  FocusPeakBlock,
  RhythmDaypart,
  RhythmDimensionModel,
  RhythmObservation,
} from "../types.js";
import { DAYPARTS, daypartOfWeekday, emptyDaypart } from "./grouping.js";

/** 每次分析对历史直方图做的衰减（≈一周不活跃后旧分布权重剩 ~28%） */
const DECAY_PER_RUN = 0.94;
const STRONG_INTERACTION_WEIGHT = 1;
const WEAK_INTERACTION_WEIGHT = 0.3;

function emptyGroup(): FocusGroupStats {
  return {
    hourHistogram: new Array<number>(24).fill(0),
    peakBlocks: [],
    totalWeight: 0,
  };
}

export const EMPTY_FOCUS_STATE: FocusDimensionState = {
  ...emptyGroup(),
  byDaypart: emptyDaypart<FocusGroupStats>(emptyGroup),
};

/** 一条观察给该槽贡献多少权重（手机解锁是弱交互，桌面活跃是强交互） */
function weightOf(obs: RhythmObservation): number {
  const base =
    obs.kind === "interaction" || obs.kind === "phone_unlock"
      ? WEAK_INTERACTION_WEIGHT
      : STRONG_INTERACTION_WEIGHT;
  return (obs.weight ?? 1) * base;
}

function add(group: FocusGroupStats, hour: number, weight: number): void {
  group.hourHistogram[hour] = (group.hourHistogram[hour] ?? 0) + weight;
  group.totalWeight += weight;
}

function decay(group: FocusGroupStats): FocusGroupStats {
  const out: FocusGroupStats = {
    hourHistogram: [...group.hourHistogram],
    peakBlocks: group.peakBlocks,
    totalWeight: group.totalWeight * DECAY_PER_RUN,
  };
  for (let h = 0; h < 24; h++) out.hourHistogram[h] = (out.hourHistogram[h] ?? 0) * DECAY_PER_RUN;
  return out;
}

/**
 * 专注/活跃维度模型器。
 *
 * 输入观察：kind="desktop_active"（权重 1）、"interaction" 或 "phone_unlock"
 * （弱交互，权重 0.3），value=十进制本地小时。24 槽直方图衰减累计；
 * peakBlocks 为连续高强度槽合并块。
 *
 * 分组（§7.3）：同一批观察额外按工作日/周末各记一份直方图，因为周末的活跃
 * 曲线和工作日根本不是同一天（在家补觉 + 下午活跃），混在一起会把两段峰值
 * 都抹平。总体口径保持不变，老消费方（receptive-hours-writer）不受影响。
 */
export class FocusDimensionModel implements RhythmDimensionModel<FocusDimensionState> {
  readonly dimension = "focus" as const;

  ingest(
    prev: FocusDimensionState | null,
    observations: RhythmObservation[],
  ): FocusDimensionState {
    const overall: FocusGroupStats = decay({
      hourHistogram: [...(prev?.hourHistogram ?? EMPTY_FOCUS_STATE.hourHistogram)],
      peakBlocks: prev?.peakBlocks ?? [],
      totalWeight: prev?.totalWeight ?? 0,
    });
    // 每组各自衰减自己那份历史（weekday 组不能拿 weekend 组的直方图来衰减）
    const byDaypart = emptyDaypart<FocusGroupStats>(() => emptyGroup());
    for (const part of DAYPARTS) {
      const prevGroup = prev?.byDaypart?.[part];
      byDaypart[part] = prevGroup ? decay(prevGroup) : emptyGroup();
    }

    for (const obs of observations) {
      if (!Number.isFinite(obs.value)) continue;
      const hour = Math.floor(((obs.value % 24) + 24) % 24);
      const weight = weightOf(obs);
      if (weight <= 0) continue;
      add(overall, hour, weight);
      const at = new Date(obs.at);
      const part: RhythmDaypart = Number.isNaN(at.getTime())
        ? "weekday"
        : daypartOfWeekday(at.getDay());
      add(byDaypart[part], hour, weight);
    }

    const rounded = (g: FocusGroupStats): FocusGroupStats => ({
      hourHistogram: g.hourHistogram.map((x) => Math.round(x * 1000) / 1000),
      peakBlocks: extractPeakBlocks(g.hourHistogram),
      totalWeight: Math.round(g.totalWeight * 1000) / 1000,
    });

    return {
      ...rounded(overall),
      byDaypart: {
        weekday: rounded(byDaypart.weekday),
        weekend: rounded(byDaypart.weekend),
      },
    };
  }

  /** 累计活跃权重 50 即满置信（约一周桌面+交互信号） */
  confidence(state: FocusDimensionState): number {
    return Math.min(1, state.totalWeight / 50);
  }
}

/** 连续高强度（≥ max 的 40% 且 ≥0.5）槽合并为峰值块，最多取 3 个最强 */
export function extractPeakBlocks(histogram: number[]): FocusPeakBlock[] {
  const max = Math.max(...histogram, 0);
  if (max < 0.5) return [];
  const threshold = Math.max(0.5, max * 0.4);
  const blocks: FocusPeakBlock[] = [];
  let start: number | null = null;
  for (let h = 0; h <= 24; h++) {
    const strong = h < 24 && (histogram[h] ?? 0) >= threshold;
    if (strong && start === null) {
      start = h;
    } else if (!strong && start !== null) {
      const score = avgRange(histogram, start, h) / max;
      blocks.push({ startHour: start, endHour: h, score: Math.round(score * 100) / 100 });
      start = null;
    }
  }
  // 跨午夜合并（23-1 点这种块首尾相接）
  if (blocks.length >= 2) {
    const first = blocks[0]!;
    const last = blocks[blocks.length - 1]!;
    if (first.startHour === 0 && last.endHour === 24) {
      last.endHour = first.endHour;
      blocks.shift();
    }
  }
  return blocks.sort((a, b) => b.score - a.score).slice(0, 3);
}

function avgRange(histogram: number[], from: number, to: number): number {
  let sum = 0;
  for (let h = from; h < to; h++) sum += histogram[h] ?? 0;
  return sum / Math.max(1, to - from);
}
