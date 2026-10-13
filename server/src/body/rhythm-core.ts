// Agent Body Center — RhythmCore（节律感知核心）
//
// 感知归 body：检测用户活动节律（连续工作时长 / 深夜活跃次数），
// 越过阈值时发布 body.rhythm.overwork_detected 信号。
// ProactivityHub（主动性模块）订阅该信号后做过劳干预（放音乐 + 排休息日程 + 说话）。
//
// ── 自适应基线（非硬编码阈值） ──
// 阈值从该用户自己的行为中学习，而非固定常量：
//  - 连续工作阈值 = 该用户历史工作段中位时长 × 1.4（clamp 2.5-6h）：
//    常干 5h 长活的人 3h 不算过劳；习惯 1h 短session 的人 2.5h 就值得关怀
//  - 深夜窗口起点 = 该用户习惯就寝时刻 + 1h（clamp 22:00-02:00）：
//    习惯 1 点睡的人 23:30 活动是常态不是异常
//  - 样本不足（<5）时用默认值引导；env 显式设置 = 手动覆盖（学习让位）
//
// 解耦设计：本模块不 import 任何 brain 服务；外部（装配层）通过 noteActivity
// 把桌面 presence / awareness busy 状态 / 对话活动喂进来。订阅 BodyBus 的
// device_change / device_switch 作为补充活跃标记。
//
// 与 HomeostasisCore 对称：纯感知聚合服务，tools=[]，act() 恒 ok=false。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { BodyBus } from "./body-bus.js";
import type {
  BodyAction,
  BodyActionResult,
  BodyModuleLike,
  BodyModuleSnapshot,
  BodySenseQuery,
  BodySenseResult,
} from "./types.js";

/** env 显式设置的连续工作阈值（小时）；未设置返回 null（走自适应学习） */
function readEnvOverworkHours(): number | null {
  const raw = process.env.RHYTHM_OVERWORK_HOURS;
  if (!raw) return null;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** 深夜活跃触发阈值（次，env RHYTHM_LATE_NIGHT_COUNT 可调，默认 3）。
 *  2026-10-12 修订：默认 2 过敏——深夜聊两句就触发全套干预（放音乐+排日程+开口），
 *  实盘三次触发两次是「活跃 2 次」误报。提到 3 次并配合 30 分钟去抖降噪。 */
function readLateNightThreshold(): number {
  const raw = process.env.RHYTHM_LATE_NIGHT_COUNT;
  if (!raw) return 3;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 3;
}

/** 触发后冷却（ms，env RHYTHM_TRIGGER_COOLDOWN_MS 可调，默认 8h） */
function readTriggerCooldownMs(): number {
  const raw = process.env.RHYTHM_TRIGGER_COOLDOWN_MS;
  if (!raw) return 8 * 60 * 60 * 1000;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 60_000 ? n : 8 * 60 * 60 * 1000;
}

/** 自适应学习前的默认引导值 */
const DEFAULT_OVERWORK_HOURS = 3;
const DEFAULT_LATE_NIGHT_START = 23;
/** 自适应约束区间（小时）：工作阈值 / 深夜窗口起点 */
const WORK_THRESHOLD_RANGE_H: [number, number] = [2.5, 6];
const LATE_NIGHT_START_RANGE_H: [number, number] = [22, 26]; // 26 = 凌晨 2 点
/** 学习样本最低数量（不足则用默认值；仅检测类阈值用） */
const MIN_SAMPLES = 5;
/** 就寝基线学习门槛（个有效夜晚）：作息驱动休息提醒宁早勿等——
 *  2 个有效夜晚即跟随用户作息，不再等 5 天、更不落 20:00 硬默认。 */
const BEDTIME_LEARN_MIN_SAMPLES = 2;
/** 学习样本滚动窗口 */
const SAMPLE_WINDOW = 14;
const LATE_NIGHT_END = 5; // 深夜终点（05:00）
/** 静默多久视为"休息了"，连续工作计时重置（30 分钟） */
const WORK_GAP_RESET_MS = 30 * 60 * 1000;
/** 记入学习样本的最短工作段（30 分钟；更短的没有节律意义） */
const MIN_SESSION_SAMPLE_MS = 30 * 60 * 1000;
/** 深夜计数去抖：同窗口内多次活跃算 1 次（30 分钟）。
 *  2026-10-12 修订：10 分钟窗口把一轮对话拆成多次「深夜活跃」，放大误触发。 */
const LATE_NIGHT_DEBOUNCE_MS = 30 * 60 * 1000;
/** 就寝样本收录门槛：当日最后活跃须落在晚间/深夜（19:00-次日 05:00）。
 *  下午关 App（13 点/16 点最后活跃）不是就寝，混入会把深夜窗口起点拖早 → 误判深夜。 */
const BEDTIME_SAMPLE_MIN_HOUR = 19;

function localDateKey(now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function medianOf(nums: number[]): number {
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

type RhythmActorState = {
  dateKey: string;
  /** 连续工作起点（ms 时间戳；null=当前不在工作段） */
  workStartAt: number | null;
  /** 最近一次活跃时刻 */
  lastActiveAt: number | null;
  /** 当日深夜活跃次数（去抖后） */
  lateNightCount: number;
  /** 最近一次深夜计数时刻（去抖用） */
  lastLateNightAt: number | null;
  /** 最近一次 overwork 触发时刻（冷却用） */
  lastTriggerAt: number | null;
};

/** 跨天保留的学习基线（stateOf 的每日重置不影响） */
type RhythmLearned = {
  /** 自然结束的工作段时长样本（ms） */
  sessionLengthsMs: number[];
  /** 每日最后活跃时刻样本（小时小数；凌晨 0-5 点折算为前一晚 24+h） */
  bedtimes: number[];
};

export class RhythmCore implements BodyModuleLike {
  readonly name = "rhythm" as const;
  readonly label = "节律感知核心（生物钟）";
  readonly tools: string[] = [];

  private readonly bodyBus: BodyBus;
  private readonly actors = new Map<string, RhythmActorState>();
  /** 跨天学习基线（自适应阈值的样本源） */
  private readonly learned = new Map<string, RhythmLearned>();
  private unsubs: Array<() => void> = [];
  private started = false;

  // ---- 状态落盘（2026-10-01 P1）：连续工作计时/深夜计数跨重启保留 ----
  // 断供根因：开发机 tsx watch 常态重启 → workStartAt 纯内存清零 → 连续工作
  // 3h 阈值永远攒不满 → 过劳干预对真实用户零触发。落盘 + 启动恢复即根修。
  private persistPath: string | null = null;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly PERSIST_DEBOUNCE_MS = 60_000;

  constructor(
    deps: { bodyBus: BodyBus },
    /** 状态落盘目录（缺省不落盘，测试用） */
    persistDir?: string,
  ) {
    this.bodyBus = deps.bodyBus;
    if (persistDir) {
      this.persistPath = join(persistDir, "rhythm-core-state.json");
      this.restore();
    }
  }

  private restore(): void {
    if (!this.persistPath || !existsSync(this.persistPath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.persistPath, "utf8")) as {
        actors?: Record<string, { state?: RhythmActorState; learned?: RhythmLearned }>;
      };
      for (const [actorId, entry] of Object.entries(raw.actors ?? {})) {
        if (entry.state) this.actors.set(actorId, entry.state);
        if (entry.learned) {
          // 2026-10-12 防污染：旧版本落盘的就寝样本混有下午关 App 的时刻
          // （13 点/16 点），恢复时按有效就寝区间 [19:00, 次日 04:00] 清洗
          entry.learned.bedtimes = (entry.learned.bedtimes ?? []).filter(
            (h) => h >= BEDTIME_SAMPLE_MIN_HOUR && h <= 28,
          );
          this.learned.set(actorId, entry.learned);
        }
      }
      const n = this.actors.size;
      if (n > 0) console.log(`[RhythmCore] 状态已恢复：${n} 用户（连续工作计时跨重启）`);
    } catch {
      /* 损坏文件按空状态处理 */
    }
  }

  private schedulePersist(): void {
    if (!this.persistPath || this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.flush();
    }, RhythmCore.PERSIST_DEBOUNCE_MS);
    if (typeof this.persistTimer.unref === "function") this.persistTimer.unref();
  }

  flush(): void {
    if (!this.persistPath) return;
    try {
      mkdirSync(dirname(this.persistPath), { recursive: true });
      const actors: Record<string, { state: RhythmActorState; learned: RhythmLearned }> = {};
      for (const [actorId, state] of this.actors) {
        actors[actorId] = { state, learned: this.learnedOf(actorId) };
      }
      writeFileSync(this.persistPath, JSON.stringify({ version: 1, actors }));
    } catch {
      /* 落盘失败不影响感知主链路 */
    }
  }

  // ---- 自适应基线 ----

  private learnedOf(actorId: string): RhythmLearned {
    let l = this.learned.get(actorId);
    if (!l) {
      l = { sessionLengthsMs: [], bedtimes: [] };
      this.learned.set(actorId, l);
    }
    return l;
  }

  private pushSample(
    actorId: string,
    key: keyof RhythmLearned,
    value: number,
  ): void {
    const l = this.learnedOf(actorId);
    const arr = l[key] as number[];
    arr.push(value);
    if (arr.length > SAMPLE_WINDOW) arr.shift();
  }

  /** 该用户的连续工作阈值（小时）：env 覆盖 > 学习中位数×1.4 > 默认 3h */
  overworkThresholdHours(actorId: string): number {
    const envHours = readEnvOverworkHours();
    if (envHours !== null) return envHours;
    const samples = this.learnedOf(actorId).sessionLengthsMs;
    if (samples.length < MIN_SAMPLES) return DEFAULT_OVERWORK_HOURS;
    const medianH = medianOf(samples) / 3_600_000;
    return clamp(medianH * 1.4, WORK_THRESHOLD_RANGE_H[0], WORK_THRESHOLD_RANGE_H[1]);
  }

  /** 该用户的深夜窗口起点（小时，可 >24 表示次日凌晨）：学习就寝时刻+1h */
  lateNightStartHour(actorId: string): number {
    const samples = this.learnedOf(actorId).bedtimes;
    if (samples.length < MIN_SAMPLES) return DEFAULT_LATE_NIGHT_START;
    const bedtime = medianOf(samples);
    return clamp(bedtime + 1, LATE_NIGHT_START_RANGE_H[0], LATE_NIGHT_START_RANGE_H[1]);
  }

  /** 学习到的习惯就寝时刻（小时小数，可 >24；还没学会时返回 null——
   *  下游据此跳过定时提醒，绝不猜一个硬编码时间）。
   *  门槛 2 个有效夜晚（BEDTIME_LEARN_MIN_SAMPLES），滚动 14 天窗口持续跟随作息变化。 */
  learnedBedtimeHour(actorId: string): number | null {
    const samples = this.learnedOf(actorId).bedtimes;
    if (samples.length < BEDTIME_LEARN_MIN_SAMPLES) return null;
    return Math.round(medianOf(samples) * 10) / 10;
  }

  /** 按该用户学习到的窗口判定深夜（起点可跨午夜折算） */
  private isLateNightAt(actorId: string, hour: number): boolean {
    const start = this.lateNightStartHour(actorId);
    if (start < 24) return hour >= start || hour < LATE_NIGHT_END;
    // 窗口起点在次日凌晨（如 01:00）：[起点-24, 05:00) 才算深夜，之前的晚睡是常态
    return hour >= start - 24 && hour < LATE_NIGHT_END;
  }

  // ---- 生命周期 ----

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    // 订阅 body 既有信号作为活跃标记（设备变化 = 人在活动）
    this.unsubs.push(
      this.bodyBus.subscribe("body.skin.device_change", (signal) => {
        if (signal.actorId) this.noteActivity(signal.actorId, "device_change");
      }),
    );
    this.unsubs.push(
      this.bodyBus.subscribe("body.vestibular.device_switch", (signal) => {
        if (signal.actorId) this.noteActivity(signal.actorId, "device_switch");
      }),
    );
    console.log("[RhythmCore] 已启动（节律感知：连续工作 / 深夜活跃）");
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    for (const unsub of this.unsubs) {
      try {
        unsub();
      } catch {
        /* ignore */
      }
    }
    this.unsubs = [];
    this.started = false;
    // 停机前落盘：连续工作计时/学习基线跨重启保留（过劳检测的前提）
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.flush();
    console.log("[RhythmCore] 已停止");
  }

  // ---- 对外喂入接口（装配层调用：presence/awareness/对话活动） ----

  /**
   * 喂入一次用户活跃事件。评估节律并在越过阈值时发布 overwork 信号。
   * @param source 活跃来源标记（presence / busy / conversation / device_*）
   */
  noteActivity(actorId: string, source: string, now: Date = new Date()): void {
    const state = this.stateOf(actorId, now);
    const nowMs = now.getTime();

    // 连续工作计时：静默超 WORK_GAP_RESET 视为休息过，重置工作段
    const gap = state.lastActiveAt !== null ? nowMs - state.lastActiveAt : Infinity;
    if (gap > WORK_GAP_RESET_MS) {
      // 工作段自然结束（休息/离开）→ 记为学习样本（该用户自己的节律基线）
      if (state.workStartAt !== null && state.lastActiveAt !== null) {
        const len = state.lastActiveAt - state.workStartAt;
        if (len >= MIN_SESSION_SAMPLE_MS) this.pushSample(actorId, "sessionLengthsMs", len);
      }
      state.workStartAt = nowMs;
    } else if (state.workStartAt === null) {
      state.workStartAt = nowMs;
    }
    state.lastActiveAt = nowMs;

    // 深夜计数（去抖：10 分钟窗口内算 1 次；窗口起点按该用户学习基线）
    if (this.isLateNightAt(actorId, now.getHours())) {
      const lastLate = state.lastLateNightAt ?? 0;
      if (nowMs - lastLate >= LATE_NIGHT_DEBOUNCE_MS) {
        state.lateNightCount += 1;
        state.lastLateNightAt = nowMs;
      }
    }

    this.evaluate(actorId, state, now);
    this.schedulePersist();
  }

  // ---- 内部：阈值评估与信号发布 ----

  private evaluate(actorId: string, state: RhythmActorState, now: Date): void {
    const nowMs = now.getTime();
    // 触发冷却（body 侧第二道防线；hub 频控是第一道）
    if (state.lastTriggerAt !== null && nowMs - state.lastTriggerAt < readTriggerCooldownMs()) {
      return;
    }

    const continuousWorkHours =
      state.workStartAt !== null ? (nowMs - state.workStartAt) / 3_600_000 : 0;
    const lateNightActiveCount = state.lateNightCount;

    // 阈值来自该用户的学习基线（样本不足时为默认值，env 显式设置则覆盖）
    const thresholdHours = this.overworkThresholdHours(actorId);
    const overwork = continuousWorkHours >= thresholdHours;
    const lateNightHit = lateNightActiveCount >= readLateNightThreshold();
    if (!overwork && !lateNightHit) return;

    state.lastTriggerAt = nowMs;
    // 触发即重置（避免同一工作段反复触发）；触发段不计入学习样本
    // （那是被干预打断的异常段，混入会抬高基线、钝化未来检测）
    if (overwork) state.workStartAt = nowMs;
    state.lateNightCount = 0;
    state.lastLateNightAt = null;

    this.bodyBus.publish({
      kind: "body.rhythm.overwork_detected",
      payload: {
        continuousWorkHours: Math.round(continuousWorkHours * 10) / 10,
        lateNightActiveCount,
        thresholdHours: Math.round(thresholdHours * 10) / 10,
        reason: overwork ? "continuous_work" : "late_night_active",
        learnedBedtimeHour: this.learnedBedtimeHour(actorId),
        detectedAt: now.toISOString(),
      },
      module: "rhythm",
      actorId,
      timestamp: now.toISOString(),
    });
    console.log(
      `[RhythmCore] 过劳信号已发布 actor=${actorId} 连续工作=${continuousWorkHours.toFixed(1)}h` +
        `（阈值=${thresholdHours.toFixed(1)}h）深夜活跃=${lateNightActiveCount}次`,
    );
  }

  private stateOf(actorId: string, now: Date): RhythmActorState {
    const dateKey = localDateKey(now);
    let state = this.actors.get(actorId);
    if (!state || state.dateKey !== dateKey) {
      // 跨天：昨日最后活跃时刻记为就寝样本（凌晨 0-5 点归属前一晚）
      if (state && state.lastActiveAt !== null) {
        const last = new Date(state.lastActiveAt);
        let h = last.getHours() + last.getMinutes() / 60;
        // 下午/傍晚就关 App 的日子不算就寝样本（污染基线 → 深夜窗口漂移）
        if (h >= BEDTIME_SAMPLE_MIN_HOUR || h < LATE_NIGHT_END) {
          if (h < LATE_NIGHT_END) h += 24;
          this.pushSample(actorId, "bedtimes", Math.min(h, 28));
        }
        // 跨天仍在工作段：按午夜截断长度记为自然结束样本
        if (state.workStartAt !== null) {
          const len = state.lastActiveAt - state.workStartAt;
          if (len >= MIN_SESSION_SAMPLE_MS) {
            this.pushSample(actorId, "sessionLengthsMs", len);
          }
        }
      }
      state = {
        dateKey,
        workStartAt: null,
        lastActiveAt: null,
        lateNightCount: 0,
        lastLateNightAt: null,
        lastTriggerAt: state?.lastTriggerAt ?? null,
      };
      this.actors.set(actorId, state);
    }
    return state;
  }

  // ---- BodyModuleLike 样板（纯感知服务） ----

  async act(_action: BodyAction): Promise<BodyActionResult> {
    return {
      ok: false,
      result: {},
      errorMessage: "RhythmCore 是纯感知模块，不支持动作执行",
    };
  }

  async sense(query: BodySenseQuery): Promise<BodySenseResult> {
    const actorId = String(query?.actorId ?? "");
    const state = actorId ? this.actors.get(actorId) : undefined;
    const learned = actorId ? this.learnedOf(actorId) : null;
    return {
      ok: true,
      module: this.name,
      data: {
        module: "rhythm",
        tracked: state !== undefined,
        ...(state
          ? {
              continuousWorkHours:
                state.workStartAt !== null
                  ? Math.round(((Date.now() - state.workStartAt) / 3_600_000) * 10) / 10
                  : 0,
              lateNightCount: state.lateNightCount,
            }
          : {}),
        ...(learned
          ? {
              adaptive: {
                overworkThresholdHours: Math.round(this.overworkThresholdHours(actorId) * 10) / 10,
                lateNightStartHour: Math.round(this.lateNightStartHour(actorId) * 10) / 10,
                sessionSamples: learned.sessionLengthsMs.length,
                bedtimeSamples: learned.bedtimes.length,
              },
            }
          : {}),
      },
    };
  }

  snapshot(): BodyModuleSnapshot {
    return {
      name: this.name,
      label: this.label,
      tools: [],
      online: this.started,
      subsystems: [],
      lastActivityAt: null,
      metadata: {
        trackedActors: this.actors.size,
        adaptiveActors: this.learned.size,
      },
    };
  }
}
