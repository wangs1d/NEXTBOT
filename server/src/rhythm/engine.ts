import { buildInsights } from "./insights.js";
import { RhythmProfileStore, normalizeProfile } from "./profile-store.js";
import {
  EMPTY_FOCUS_STATE,
  FocusDimensionModel,
} from "./dimensions/focus-model.js";
import {
  EMPTY_OVERTIME_STATE,
  OvertimeDimensionModel,
} from "./dimensions/overtime-model.js";
import {
  EMPTY_RECEPTIVITY_STATE,
  ReceptivityDimensionModel,
} from "./dimensions/receptivity-model.js";
import { EMPTY_SLEEP_STATE, SleepDimensionModel } from "./dimensions/sleep-model.js";
import { EMPTY_WAKE_STATE, WakeDimensionModel } from "./dimensions/wake-model.js";
import {
  CommuteDimensionModel,
  commuteMinutesOf as commuteMinutesFromState,
  EMPTY_COMMUTE_STATE,
} from "./dimensions/commute-model.js";

import type {
  RhythmConsumer,
  RhythmDimension,
  RhythmDimensionModel,
  RhythmDimensionStates,
  RhythmEngineHealth,
  RhythmInsight,
  RhythmObservation,
  RhythmProfile,
  RhythmProfileUpdate,
  RhythmSensor,
  RhythmSensorHealth,
  ReminderFeedbackOutcome,
} from "./types.js";

const FEEDBACK_VALUE: Record<ReminderFeedbackOutcome, number> = {
  accepted: 1,
  replied: 1,
  snoozed: 0.5,
  dismissed: 0,
  ignored: 0,
};
const SLOT_EWMA_ALPHA = 0.4;
const MAX_PUSH_BUFFER = 200;

export type LifeRhythmEngineOptions = {
  profileStore: RhythmProfileStore;
  /** 注入自定义模型器（测试用）；缺省注册全部内置六维度模型器 */
  dimensionModels?: RhythmDimensionModel[];
};

/**
 * 生活节律引擎中枢：节律画像的唯一所有者。
 *
 * - 传感器边界：registerSensor()，夜间批处理时拉取观察
 * - 模型层：按维度注册 RhythmDimensionModel，纯统计建模
 * - 消费方边界：subscribe()，画像变更后消费方各自落权（重排提醒 / 回填
 *   receptiveHours / 关怀 candidate / WS 通知）
 *
 * 引擎不做"现在该不该打扰"的决策，也不直接发消息。
 */
export class LifeRhythmEngine {
  private readonly sensors: RhythmSensor[] = [];
  private readonly models = new Map<RhythmDimension, RhythmDimensionModel>();
  private readonly consumers: RhythmConsumer[] = [];
  /** 在线推送的观察缓冲（recordContactOutcome），随下次 runAnalysis 消费 */
  private readonly pushedObservations = new Map<string, RhythmObservation[]>();
  private running = false;
  /** 采样链健康记账（/api/proactivity/sensors 的 rhythm 块）：0 样本空转不再无人知晓 */
  private readonly sensorHealthBook = new Map<
    string,
    {
      dimensions: RhythmDimension[];
      expectsObservations: boolean;
      collectCount: number;
      errorCount: number;
      observationCount: number;
      lastCollectAt: string | null;
      lastOkAt: string | null;
      lastErrorAt: string | null;
      lastError?: string;
    }
  >();
  private analysisRunCount = 0;
  private lastAnalysisAt: string | null = null;
  /** stalled 判定：声明应有产出的传感器连续 N 轮零观察 */
  private static readonly STALL_THRESHOLD_RUNS = 3;

  constructor(private readonly opts: LifeRhythmEngineOptions) {
    const models = opts.dimensionModels ?? [
      new SleepDimensionModel(),
      new WakeDimensionModel(),
      new CommuteDimensionModel(),
      new FocusDimensionModel(),
      new OvertimeDimensionModel(),
      new ReceptivityDimensionModel(),
    ];
    for (const model of models) {
      this.models.set(model.dimension, model as RhythmDimensionModel);
    }
  }

  registerSensor(sensor: RhythmSensor): void {
    this.sensors.push(sensor);
  }

  subscribe(consumer: RhythmConsumer): () => void {
    this.consumers.push(consumer);
    return () => {
      const idx = this.consumers.indexOf(consumer);
      if (idx >= 0) this.consumers.splice(idx, 1);
    };
  }

  getProfile(actorId: string): RhythmProfile | null {
    return this.opts.profileStore.get(actorId);
  }

  listActorIds(): string[] {
    return this.opts.profileStore.listActorIds();
  }

  /**
   * 单维度置信度（0..1）：从画像状态即时派生，与 runAnalysis 内喂给消费方的
   * confidences 同口径（同一批模型器的 confidence()，不存在第二套算法）。
   * 画像还没有该维度状态时按空状态算——模型器对空状态一律给 0。
   */
  dimensionConfidence(actorId: string, dimension: RhythmDimension): number {
    const model = this.models.get(dimension);
    if (!model) return 0;
    const profile = this.opts.profileStore.get(actorId);
    const state =
      (profile?.dimensions as Record<string, unknown> | undefined)?.[dimension] ??
      emptyDimensionStates()[dimension];
    try {
      return model.confidence(state);
    } catch {
      return 0;
    }
  }

  /**
   * 作息整体置信度（触点计划 / 时机模型的冷启动闸用，替代此前 bootstrap 里
   * 「学到就寝与起床就给 0.8」的二值伪码）。
   *
   * 权重按"这个维度学不出来对排程影响多大"给：wake 最重（早安 slot 直接用它），
   * sleep 次之（明日预览），commute 只影响出门/下班两趟。缺维度=0 分，不做
   * 归一化补偿——只有通勤学出来了、作息完全没学到，整体仍应算冷启动。
   */
  rhythmConfidence(
    actorId: string,
    weights: Partial<Record<RhythmDimension, number>> = { wake: 0.5, sleep: 0.3, commute: 0.2 },
  ): number {
    let total = 0;
    let weightSum = 0;
    for (const [dimension, weight] of Object.entries(weights)) {
      const w = Number(weight) || 0;
      if (w <= 0) continue;
      weightSum += w;
      total += w * this.dimensionConfidence(actorId, dimension as RhythmDimension);
    }
    return weightSum > 0 ? Math.round((total / weightSum) * 1000) / 1000 : 0;
  }

  /**
   * 出门 / 下班时刻（当日分钟数，PRD §7.3 的 commute 维度 → §3.4 的两个 slot）。
   * 按 date 落在工作日还是周末取该组中位数；组内样本不足退回总体中位数；
   * 两条都没有 → 两个 null，触点计划就不生成这两个 slot（宁缺勿假）。
   */
  commuteMinutesOf(
    actorId: string,
    date: Date,
  ): { leaveHome: number | null; leaveWork: number | null } {
    const state = this.opts.profileStore.get(actorId)?.dimensions?.commute;
    return commuteMinutesFromState(state, date);
  }

  // ---- 在线写入接口（无需等夜间分析）----

  /** 触达结果回灌（bootstrap 从 UserPersonalizationService.observeContactOutcome 桥接） */
  recordContactOutcome(actorId: string, outcome: ReminderFeedbackOutcome, at = new Date()): void {
    const value = FEEDBACK_VALUE[outcome];
    if (value === undefined) return;
    this.pushObservation(actorId, {
      dimension: "receptivity",
      at: at.toISOString(),
      value,
      kind: "contact_outcome",
      source: "contact-feedback",
    });
  }

  /** 单个提醒任务的接受度回灌（ EWMA 在线更新，供重排消费方使用） */
  async recordReminderFeedback(
    actorId: string,
    taskId: string,
    outcome: ReminderFeedbackOutcome,
    at = new Date(),
  ): Promise<void> {
    const profile = this.opts.profileStore.ensure(actorId, at);
    const slot = profile.reminderSlots[taskId];
    if (!slot) return;
    const value = FEEDBACK_VALUE[outcome];
    slot.acceptanceEwma =
      slot.acceptanceEwma === null
        ? value
        : slot.acceptanceEwma * (1 - SLOT_EWMA_ALPHA) + value * SLOT_EWMA_ALPHA;
    slot.acceptanceEwma = Math.round(slot.acceptanceEwma * 1000) / 1000;
    slot.attempts += 1;
    profile.updatedAt = at.toISOString();
    await this.opts.profileStore.save(profile);
  }

  /** 重排消费方发现节律任务时登记槽位（originalHour 缺省取当前 hour） */
  async registerReminderSlot(
    actorId: string,
    taskId: string,
    hour: number,
    originalHour?: number,
  ): Promise<void> {
    const profile = this.opts.profileStore.ensure(actorId);
    const existing = profile.reminderSlots[taskId];
    if (existing) {
      existing.hour = hour;
    } else {
      profile.reminderSlots[taskId] = {
        taskId,
        hour,
        originalHour: originalHour ?? hour,
        acceptanceEwma: null,
        attempts: 0,
        lastAdjustedAt: null,
        lastAdjustDirection: null,
        pinnedByUser: false,
      };
    }
    await this.opts.profileStore.save(profile);
  }

  async markSlotAdjusted(
    actorId: string,
    taskId: string,
    newHour: number,
    direction: "earlier" | "later",
    at = new Date(),
  ): Promise<void> {
    const profile = this.opts.profileStore.ensure(actorId, at);
    const slot = profile.reminderSlots[taskId];
    if (!slot) return;
    slot.hour = newHour;
    slot.lastAdjustedAt = at.toISOString();
    slot.lastAdjustDirection = direction;
    await this.opts.profileStore.save(profile);
  }

  async pinReminderTask(actorId: string, taskId: string, pinned: boolean): Promise<void> {
    const profile = this.opts.profileStore.ensure(actorId);
    const slot = profile.reminderSlots[taskId];
    if (!slot) return;
    slot.pinnedByUser = pinned;
    await this.opts.profileStore.save(profile);
  }

  /** 洞察消费方（关怀 candidate）限频记账 */
  async markCandidateSent(actorId: string, dimension: RhythmDimension, at = new Date()): Promise<void> {
    const profile = this.opts.profileStore.ensure(actorId, at);
    profile.lastCandidateAt[dimension] = at.toISOString();
    await this.opts.profileStore.save(profile);
  }

  private pushObservation(actorId: string, obs: RhythmObservation): void {
    const list = this.pushedObservations.get(actorId) ?? [];
    list.push(obs);
    if (list.length > MAX_PUSH_BUFFER) list.splice(0, list.length - MAX_PUSH_BUFFER);
    this.pushedObservations.set(actorId, list);
  }

  // ---- 分析主循环 ----

  /**
   * 完整分析一轮：collect → ingest → insights → 持久化 → 通知消费方。
   * 幂等（观察按日/按事件去重由各模型器保证），可对同一 actor 重复调用。
   */
  async runAnalysis(actorId: string, ctx: { now?: Date; force?: boolean } = {}): Promise<RhythmProfileUpdate | null> {
    const now = ctx.now ?? new Date();
    if (this.running) return null;
    this.running = true;
    try {
      const profile = this.opts.profileStore.ensure(actorId, now);
      const since = profile.lastAnalyzedDay
        ? new Date(`${profile.lastAnalyzedDay}T00:00:00`)
        : new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

      // 1) 传感器拉取（单传感器失败不阻塞整体；健康记账防 0 样本空转无人知晓）
      const collected: RhythmObservation[] = [];
      for (const sensor of this.sensors) {
        const book = this.sensorHealthBookFor(sensor);
        book.collectCount += 1;
        book.lastCollectAt = now.toISOString();
        try {
          const observations = await sensor.collect(actorId, since);
          if (Array.isArray(observations)) {
            collected.push(...observations);
            book.observationCount += observations.length;
          }
          book.lastOkAt = now.toISOString();
        } catch (error) {
          book.errorCount += 1;
          book.lastErrorAt = now.toISOString();
          book.lastError = error instanceof Error ? error.message : String(error);
          console.error(`[RhythmEngine] sensor ${sensor.id} collect failed:`, error);
        }
      }
      this.analysisRunCount += 1;
      this.lastAnalysisAt = now.toISOString();
      // 2) 在线推送的观察一并消费
      const pushed = this.pushedObservations.get(actorId) ?? [];
      this.pushedObservations.delete(actorId);
      collected.push(...pushed);

      // 3) 按维度分组喂给模型器
      const byDimension = new Map<RhythmDimension, RhythmObservation[]>();
      for (const obs of collected) {
        if (!this.models.has(obs.dimension)) continue;
        const list = byDimension.get(obs.dimension) ?? [];
        list.push(obs);
        byDimension.set(obs.dimension, list);
      }

      const changedDimensions: RhythmDimension[] = [];
      const confidences = {} as Record<RhythmDimension, number>;
      for (const [dimension, model] of this.models) {
        const prevState = (profile.dimensions as Record<string, unknown>)[dimension] ?? null;
        const nextState = model.ingest(prevState, byDimension.get(dimension) ?? [], { now });
        (profile.dimensions as Record<string, unknown>)[dimension] = nextState;
        confidences[dimension] = model.confidence(nextState);
        if (JSON.stringify(nextState) !== JSON.stringify(prevState)) {
          changedDimensions.push(dimension);
        }
      }

      // 4) 洞察（有变化的维度才重算；保留历史洞察）
      let insights = profile.insights;
      if (changedDimensions.length > 0 || ctx.force) {
        const fresh = buildInsights(profile.dimensions, { now });
        insights = mergeInsights(profile.insights, fresh);
        profile.insights = insights;
      }

      profile.updatedAt = now.toISOString();
      profile.lastAnalyzedDay = now.toISOString().slice(0, 10);
      await this.opts.profileStore.save(profile);

      const update: RhythmProfileUpdate = {
        actorId,
        changedDimensions,
        confidences,
        insights,
        profile,
      };
      for (const consumer of this.consumers) {
        try {
          await consumer(update);
        } catch (error) {
          console.error("[RhythmEngine] consumer failed:", error);
        }
      }
      return update;
    } finally {
      this.running = false;
    }
  }

  private sensorHealthBookFor(sensor: RhythmSensor) {
    let book = this.sensorHealthBook.get(sensor.id);
    if (!book) {
      book = {
        dimensions: [...sensor.dimensions],
        expectsObservations: sensor.expectsObservations === true,
        collectCount: 0,
        errorCount: 0,
        observationCount: 0,
        lastCollectAt: null,
        lastOkAt: null,
        lastErrorAt: null,
      };
      this.sensorHealthBook.set(sensor.id, book);
    }
    return book;
  }

  /** 采样链健康快照（诊断面板用）：per-sensor 计数 + stalled 判定 */
  health(): RhythmEngineHealth {
    const sensors: RhythmSensorHealth[] = this.sensors.map((sensor) => {
      const book = this.sensorHealthBookFor(sensor);
      return {
        sensorId: sensor.id,
        dimensions: book.dimensions,
        collectCount: book.collectCount,
        errorCount: book.errorCount,
        observationCount: book.observationCount,
        lastCollectAt: book.lastCollectAt,
        lastOkAt: book.lastOkAt,
        lastErrorAt: book.lastErrorAt,
        ...(book.lastError ? { lastError: book.lastError } : {}),
        stalled:
          book.expectsObservations &&
          book.collectCount >= LifeRhythmEngine.STALL_THRESHOLD_RUNS &&
          book.observationCount === 0,
      };
    });
    return {
      analysisRunCount: this.analysisRunCount,
      lastAnalysisAt: this.lastAnalysisAt,
      enabled: this.sensors.length > 0,
      sensors,
    };
  }
}

/** 新洞察并入历史（同维度同 kind 保留最新一条），上限 20 */
function mergeInsights(
  prev: RhythmProfile["insights"],
  fresh: RhythmInsight[],
): RhythmProfile["insights"] {
  const merged = new Map<string, RhythmInsight>();
  for (const insight of prev) {
    merged.set(`${insight.dimension}:${insight.kind}`, insight);
  }
  for (const insight of fresh) {
    merged.set(`${insight.dimension}:${insight.kind}`, insight);
  }
  return [...merged.values()].slice(-20);
}

/** 缺省空状态（测试与诊断用） */
export function emptyDimensionStates(): RhythmDimensionStates {
  const focus = { ...EMPTY_FOCUS_STATE, hourHistogram: [...EMPTY_FOCUS_STATE.hourHistogram], peakBlocks: [] };
  return {
    sleep: {
      ...EMPTY_SLEEP_STATE,
      samples: [],
      byDaypart: {
        weekday: { ...EMPTY_SLEEP_STATE.byDaypart.weekday },
        weekend: { ...EMPTY_SLEEP_STATE.byDaypart.weekend },
      },
    },
    wake: {
      ...EMPTY_WAKE_STATE,
      samples: [],
      byDaypart: {
        weekday: { ...EMPTY_WAKE_STATE.byDaypart.weekday },
        weekend: { ...EMPTY_WAKE_STATE.byDaypart.weekend },
      },
    },
    commute: {
      ...EMPTY_COMMUTE_STATE,
      days: [],
      overall: { ...EMPTY_COMMUTE_STATE.overall },
      byDaypart: {
        weekday: { ...EMPTY_COMMUTE_STATE.byDaypart.weekday },
        weekend: { ...EMPTY_COMMUTE_STATE.byDaypart.weekend },
      },
      leaveHomeByWeekday: [...EMPTY_COMMUTE_STATE.leaveHomeByWeekday],
    },
    focus: {
      ...focus,
      byDaypart: {
        weekday: {
          ...EMPTY_FOCUS_STATE.byDaypart.weekday,
          hourHistogram: [...EMPTY_FOCUS_STATE.byDaypart.weekday.hourHistogram],
          peakBlocks: [],
        },
        weekend: {
          ...EMPTY_FOCUS_STATE.byDaypart.weekend,
          hourHistogram: [...EMPTY_FOCUS_STATE.byDaypart.weekend.hourHistogram],
          peakBlocks: [],
        },
      },
    },
    overtime: {
      ...EMPTY_OVERTIME_STATE,
      byWeekday: [...EMPTY_OVERTIME_STATE.byWeekday],
      weekdayDays: [...EMPTY_OVERTIME_STATE.weekdayDays],
      recentDays: [],
      byDaypart: {
        weekday: { ...EMPTY_OVERTIME_STATE.byDaypart.weekday },
        weekend: { ...EMPTY_OVERTIME_STATE.byDaypart.weekend },
      },
    },
    receptivity: {
      ...EMPTY_RECEPTIVITY_STATE,
      byHour: [...EMPTY_RECEPTIVITY_STATE.byHour],
      byWeekday: [...EMPTY_RECEPTIVITY_STATE.byWeekday],
      byDaypartHour: {
        weekday: [...EMPTY_RECEPTIVITY_STATE.byDaypartHour.weekday],
        weekend: [...EMPTY_RECEPTIVITY_STATE.byDaypartHour.weekend],
      },
    },
  };
}

export { normalizeProfile };
