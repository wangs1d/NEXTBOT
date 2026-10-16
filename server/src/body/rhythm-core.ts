// Agent Body Center — RhythmCore（节律感知核心）
//
// 感知归 body：从用户活跃事件中学习作息基线——
//  - 每日最后活跃时刻 → 就寝样本（凌晨 0-5 点归属前一晚，防下午关 App 污染）
//  - learnedBedtimeHour 经 UserTimingService 统一取用口供各定时场景消费
//    （晚报推送/过劳干预曾在此取值；过劳检测/干预链路 2026-10-16 已删除，
//    本模块职责收敛为纯作息学习）。
//
// ── 自适应基线（非硬编码阈值） ──
//  - 就寝基线门槛 2 个有效夜晚（宁早勿等），滚动 14 天窗口持续跟随作息变化
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

/** 就寝基线学习门槛（个有效夜晚）：作息驱动定时提醒宁早勿等——
 *  2 个有效夜晚即跟随用户作息，不再等 5 天、更不落硬默认。 */
const BEDTIME_LEARN_MIN_SAMPLES = 2;
/** 学习样本滚动窗口 */
const SAMPLE_WINDOW = 14;
/** 凌晨终点（05:00）：当日最后活跃落在此前 → 折算为前一晚的就寝样本 */
const LATE_NIGHT_END = 5;
/** 就寝样本收录门槛：当日最后活跃须落在晚间/凌晨（19:00-次日 05:00）。
 *  下午关 App（13 点/16 点最后活跃）不是就寝，混入会把就寝基线拖早。 */
const BEDTIME_SAMPLE_MIN_HOUR = 19;

function localDateKey(now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function medianOf(nums: number[]): number {
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

type RhythmActorState = {
  dateKey: string;
  /** 最近一次活跃时刻（就寝样本 = 跨天时的 lastActiveAt） */
  lastActiveAt: number | null;
};

/** 跨天保留的学习基线（stateOf 的每日重置不影响） */
type RhythmLearned = {
  /** 每日最后活跃时刻样本（小时小数；凌晨 0-5 点折算为前一晚 24+h） */
  bedtimes: number[];
};

export class RhythmCore implements BodyModuleLike {
  readonly name = "rhythm" as const;
  readonly label = "节律感知核心（生物钟）";
  readonly tools: string[] = [];

  private readonly bodyBus: BodyBus;
  private readonly actors = new Map<string, RhythmActorState>();
  /** 跨天学习基线（就寝样本源） */
  private readonly learned = new Map<string, RhythmLearned>();
  private unsubs: Array<() => void> = [];
  private started = false;

  // ---- 状态落盘（2026-10-01 P1）：作息学习基线跨重启保留 ----
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
      if (n > 0) console.log(`[RhythmCore] 状态已恢复：${n} 用户（作息学习基线跨重启）`);
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
      l = { bedtimes: [] };
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

  /** 学习到的习惯就寝时刻（小时小数，可 >24；还没学会时返回 null——
   *  下游据此跳过定时提醒，绝不猜一个硬编码时间）。
   *  门槛 2 个有效夜晚（BEDTIME_LEARN_MIN_SAMPLES），滚动 14 天窗口持续跟随作息变化。 */
  learnedBedtimeHour(actorId: string): number | null {
    const samples = this.learnedOf(actorId).bedtimes;
    if (samples.length < BEDTIME_LEARN_MIN_SAMPLES) return null;
    return Math.round(medianOf(samples) * 10) / 10;
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
    console.log("[RhythmCore] 已启动（节律感知：作息学习）");
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
    // 停机前落盘：作息学习基线跨重启保留
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.flush();
    console.log("[RhythmCore] 已停止");
  }

  // ---- 对外喂入接口（装配层调用：presence/awareness/对话活动） ----

  /**
   * 喂入一次用户活跃事件：更新最后活跃时刻，跨天时结算就寝样本。
   * @param source 活跃来源标记（presence / busy / conversation / device_*）
   */
  noteActivity(actorId: string, source: string, now: Date = new Date()): void {
    const state = this.stateOf(actorId, now);
    state.lastActiveAt = now.getTime();
    this.schedulePersist();
  }

  private stateOf(actorId: string, now: Date): RhythmActorState {
    const dateKey = localDateKey(now);
    let state = this.actors.get(actorId);
    if (!state || state.dateKey !== dateKey) {
      // 跨天：昨日最后活跃时刻记为就寝样本（凌晨 0-5 点归属前一晚）
      if (state && state.lastActiveAt !== null) {
        const last = new Date(state.lastActiveAt);
        let h = last.getHours() + last.getMinutes() / 60;
        // 下午/傍晚就关 App 的日子不算就寝样本（污染基线 → 就寝时刻漂移）
        if (h >= BEDTIME_SAMPLE_MIN_HOUR || h < LATE_NIGHT_END) {
          if (h < LATE_NIGHT_END) h += 24;
          this.pushSample(actorId, "bedtimes", Math.min(h, 28));
        }
      }
      state = { dateKey, lastActiveAt: null };
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
        ...(learned ? { bedtimeSamples: learned.bedtimes.length } : {}),
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
        learningActors: this.learned.size,
      },
    };
  }
}
