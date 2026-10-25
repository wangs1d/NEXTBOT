// ProactivityHub —— 全局频控器（FrequencyGovernor）
//
// 职责：主动性多元化后防止"频繁打扰"。三层规则：
//  1. 每 actor 每日总预算（默认 3 次，env 可调；必达类提案在管道层绕过本预算）
//  2. 分 kind 冷却（greeting/分享每天最多 1 次，关怀 8h 一次……）
//  3. 静默时段（23-7 点）：仅 importance=high 放行
//
// 与 ProactionCortex 的 disturb/repeat_suppress 是双层防线：本模块前置粗筛
// （触发源层），ProactionCortex 保留细筛（决策层），二者不冲突。
import type { FrequencyVerdict } from "./proactivity-types.js";
import * as quietHours from "./quiet-hours.js";

/** 分 kind 冷却毫秒表（env PROACTIVITY_COOLDOWN_<KIND> 可覆盖单值） */
const DEFAULT_KIND_COOLDOWN_MS: Record<string, number> = {
  greeting: 24 * 60 * 60 * 1000,        // 问候：每天最多 1 次
  interest_share: 24 * 60 * 60 * 1000,  // 分享：每天最多 1 次
  interest_alert: 4 * 60 * 60 * 1000,   // 兴趣热议推送：4h 冷却（同兴趣级去重由 InterestWatcher 指纹+间隔承担）
  care: 8 * 60 * 60 * 1000,             // 对话关怀：8h 冷却
  followup: 4 * 60 * 60 * 1000,         // 待办跟进：4h 冷却
  task_celebration: 30 * 60 * 1000,     // 恭喜：每任务一次（30min 防连发）
  overwork_care: 8 * 60 * 60 * 1000,    // 过劳干预：8h 冷却
  // ── C 端生活管家场景（Task 20 统一频控注册）──
  weather_alert: 30 * 60 * 1000,        // 恶劣天气预警：预警类需即时触达，30min 冷却防同一场雨连发
  life_reminder: 4 * 60 * 60 * 1000,    // 生活提醒（重要日子/预算超支/节律提醒等）：4h 冷却
  monthly_report: 24 * 60 * 60 * 1000,  // 月度报告（消费月报等）：每日最多 1 次
  // ── 评估器场景独立档（一个场景一个 kind，避免与生活提醒互相挤占冷却）──
  message_burst: 2 * 60 * 60 * 1000,    // 消息爆发提醒：2h 一次
  meeting_early: 4 * 60 * 60 * 1000,    // 临会预告（1h 档）：4h 冷却（与 15min 档独立）
  sleep_care: 20 * 60 * 60 * 1000,      // 深夜睡眠关怀：每晚最多一次
  // ── 位置场景（方案 D）──
  location_arrival: 6 * 60 * 60 * 1000, // 到达常去地点问候：同地点 6h 一次（别每次到家都唠叨）
  geofence_event: 30 * 60 * 1000,       // 地理围栏动作的 speak 告知：30min 兜底（围栏层自有防抖）
  // ── 旅游接驳（travel-upgrade-plan P2）──
  transfer_reminder: 60 * 60 * 1000,    // 接驳提醒：同段行程只问一次（调度器自有 sent 表，此处是兜底冷却）
  // ── agent pulse（Muse 式聚合审阅）──
  agent_pulse_price: 30 * 60 * 1000,    // pulse 降价道：用户点名盯的结果走 must 层随到随送，30min 仅作防连发兜底
};

/**
 * 未知 kind（InitiativeEngine LLM 自定义标签，如 schedule_care）的默认冷却。
 * 每日总预算仍是最终兜底——即使 LLM 每次发明新标签也不会超预算打扰。
 */
const DEFAULT_UNKNOWN_KIND_COOLDOWN_MS = 2 * 60 * 60 * 1000;

/**
 * 「每天最多一次」语义的 kind：按日历日本地日去重（而非 24h 滚动冷却）。
 * 滚动冷却下晨间问候时刻每天提前几分钟就会吞掉次日的晨报（实测：
 * d1 8:50 问候 → d2 7:50 晨报被 24h 冷却拦截）。日历日语义才符合
 * "每天最多一次"的用户预期。
 */
const DAILY_ONCE_KINDS = new Set(["greeting", "interest_share", "monthly_report", "digest"]);

// 静默时段统一收敛至 quiet-hours.ts（env PROACTIVITY_QUIET_START/END 可配；默认 23:00-7:00）

function readEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** 当前日期的本地 YYYY-MM-DD（按 actor 逐日计数用） */
function localDateKey(now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function isQuietHour(hour: number): boolean {
  return quietHours.isQuietHour(hour);
}

type ActorFrequencyState = {
  dateKey: string;
  dailyCount: number;
  /** kind → 最近一次触发时间戳 */
  kindLastAt: Map<string, number>;
};

/** 频控状态快照（重启恢复用：预算计数 + 分 kind 冷却 + 自适应调整结果） */
export type GovernorSnapshot = {
  actors: Array<{ actorId: string; dateKey: string; dailyCount: number; kindLastAt: Array<[string, number]> }>;
  cooldowns: Record<string, number>;
};

/** 自适应冷却边界（outcome 反馈调整 kind 冷却时的上下限） */
const ADAPTIVE_COOLDOWN_MAX_MS = 48 * 60 * 60 * 1000;

export class FrequencyGovernor {
  private readonly actors = new Map<string, ActorFrequencyState>();

  private readonly dailyBudget: number;
  private readonly nowFn: () => Date;
  private readonly kindCooldownMs: Record<string, number>;
  private readonly disableQuietHours: boolean;
  /** env 显式覆盖过的 kind（restore 时不落盘值覆盖 env 意图） */
  private readonly envOverriddenKinds = new Set<string>();
  /** 勿扰检查（AutonomySettingsStore.isDnd 的薄依赖；bootstrap 注入，缺省不启用） */
  private dndCheck?: (actorId: string) => boolean;

  /** 注入勿扰检查（每用户 DND 开关；传 null 清除） */
  setDndCheck(fn: ((actorId: string) => boolean) | null): void {
    this.dndCheck = fn ?? undefined;
  }

  constructor(opts?: {
    dailyBudget?: number;
    kindCooldownMs?: Record<string, number>;
    /** 测试用：不读 env */
    ignoreEnv?: boolean;
    /** 测试用：禁用静默时段（避免深夜跑测试随机失败） */
    disableQuietHours?: boolean;
    /** 测试注入：时钟源（默认真实系统时间；集成冒烟用 mock 时钟） */
    nowFn?: () => Date;
  }) {
    this.disableQuietHours = opts?.disableQuietHours === true;
    this.nowFn = opts?.nowFn ?? (() => new Date());
    // 每日预算定位为「异常熔断」而非主动性的日常约束：正常节制的责任在
    // ArbiterV2 打断成本 + 分 kind 冷却 + 反馈自适应，这里只防 LLM 抽风连发。
    this.dailyBudget = opts?.dailyBudget ?? readEnvInt("PROACTIVITY_DAILY_BUDGET", 15);
    this.kindCooldownMs = { ...DEFAULT_KIND_COOLDOWN_MS };
    for (const [kind, ms] of Object.entries(opts?.kindCooldownMs ?? {})) {
      if (typeof ms === "number" && Number.isFinite(ms)) {
        this.kindCooldownMs[kind] = ms;
      }
    }
    if (!opts?.ignoreEnv) {
      // env 覆盖单 kind 冷却：PROACTIVITY_COOLDOWN_CARE=3600000
      for (const kind of Object.keys(this.kindCooldownMs)) {
        const envName = `PROACTIVITY_COOLDOWN_${kind.toUpperCase()}`;
        if (process.env[envName] !== undefined) {
          this.kindCooldownMs[kind] = readEnvInt(envName, this.kindCooldownMs[kind]);
          this.envOverriddenKinds.add(kind);
        }
      }
    }
  }

  /**
   * 自适应冷却（outcome 反馈回灌）：负反馈冷却 ×1.5（上限 48h），正反馈向默认值回落 ×0.9。
   * 连续被忽略的话题自动沉寂、高接受率话题恢复活跃——分寸感来自真实反馈而非固定 cron。
   */
  noteOutcome(kind: string, positive: boolean): void {
    const base = DEFAULT_KIND_COOLDOWN_MS[kind] ?? DEFAULT_UNKNOWN_KIND_COOLDOWN_MS;
    const current = this.kindCooldownMs[kind] ?? DEFAULT_UNKNOWN_KIND_COOLDOWN_MS;
    const next = positive
      ? Math.max(base, Math.round(current * 0.9))
      : Math.min(Math.round(current * 1.5), ADAPTIVE_COOLDOWN_MAX_MS);
    this.kindCooldownMs[kind] = next;
  }

  /** 频控状态快照（ProactivePipeline 落盘 data/proactivity/frequency.json） */
  snapshot(): GovernorSnapshot {
    return {
      actors: [...this.actors].map(([actorId, s]) => ({
        actorId,
        dateKey: s.dateKey,
        dailyCount: s.dailyCount,
        kindLastAt: [...s.kindLastAt],
      })),
      cooldowns: { ...this.kindCooldownMs },
    };
  }

  /** 从快照恢复（env 显式覆盖的 kind 不被落盘值覆盖） */
  restore(snapshot: GovernorSnapshot): void {
    for (const a of snapshot.actors ?? []) {
      this.actors.set(a.actorId, {
        dateKey: a.dateKey,
        dailyCount: a.dailyCount,
        kindLastAt: new Map(a.kindLastAt ?? []),
      });
    }
    for (const [kind, ms] of Object.entries(snapshot.cooldowns ?? {})) {
      if (!this.envOverriddenKinds.has(kind) && Number.isFinite(ms)) this.kindCooldownMs[kind] = ms;
    }
  }

  /** 预算用量（诊断接口展示） */
  usageSnapshot(): Array<{ actorId: string; dailyCount: number; budget: number }> {
    return [...this.actors].map(([actorId, s]) => ({
      actorId,
      dailyCount: s.dailyCount,
      budget: this.dailyBudget,
    }));
  }

  private stateOf(actorId: string, now: Date): ActorFrequencyState {
    const dateKey = localDateKey(now);
    let state = this.actors.get(actorId);
    if (!state || state.dateKey !== dateKey) {
      // 新的一天：重置每日计数（kind 冷却跨天保留，避免跨零点连发）
      state = {
        dateKey,
        dailyCount: 0,
        kindLastAt: state?.kindLastAt ?? new Map(),
      };
      this.actors.set(actorId, state);
    }
    return state;
  }

  /**
   * 判定一次主动意图是否允许触发。
   * @param kind 已知 kind 用专属冷却；LLM 自定义标签用默认冷却（预算兜底）
   * @param importance 静默时段仅 high 放行（awake 且低打扰档除外）
   * @param opts.awake 用户当前活跃在设备前（管道传入）：静默时段的低/中打扰
   *   消息不算惊扰——「23 点还醒着」时的轻声一句话与「把人叫醒」是两回事；
   *   high/critical（弹窗/响铃级）不豁免，仍按静默规则把关
   */
  canTrigger(
    actorId: string,
    kind: string,
    importance: "high" | "medium" | "low",
    now: Date = this.nowFn(),
    opts?: { awake?: boolean },
  ): FrequencyVerdict {
    const state = this.stateOf(actorId, now);

    // 规则 0：用户勿扰（AutonomySettingsStore DND）——medium/low 一律沉默，
    // high 及以上放行（与静默时段的 high 豁免口径一致；紧急事不被勿扰吞掉）
    if (this.dndCheck?.(actorId) === true && importance !== "high") {
      return { allowed: false, reason: "dnd_active" };
    }

    // 规则 3：静默时段仅 high 放行（awake 时的低打扰档豁免）
    const lowKeyQuietOk = opts?.awake === true && importance !== "high";
    if (!this.disableQuietHours && isQuietHour(now.getHours()) && importance !== "high" && !lowKeyQuietOk) {
      return { allowed: false, reason: `quiet_hours(${now.getHours()}h,importance=${importance})` };
    }

    // 规则 1：每日总预算
    if (state.dailyCount >= this.dailyBudget) {
      return { allowed: false, reason: `daily_budget_exhausted(${state.dailyCount}/${this.dailyBudget})` };
    }

    // 规则 2：分 kind 冷却（未知 kind 用默认冷却，防新标签绕过）
    const lastAt = state.kindLastAt.get(kind);
    if (lastAt !== undefined) {
      // 日历日 kind：同一天已发过即拦（跨零点立刻恢复资格）
      if (DAILY_ONCE_KINDS.has(kind)) {
        if (localDateKey(new Date(lastAt)) === state.dateKey) {
          return { allowed: false, reason: `daily_once(${kind},${state.dateKey})` };
        }
      } else {
        const elapsed = now.getTime() - lastAt;
        const cooldown = this.kindCooldownMs[kind] ?? DEFAULT_UNKNOWN_KIND_COOLDOWN_MS;
        if (elapsed < cooldown) {
          return {
            allowed: false,
            reason: `kind_cooldown(${kind},${Math.round(elapsed / 60000)}m<${Math.round(cooldown / 60000)}m)`,
          };
        }
      }
    }

    return { allowed: true, reason: "ok" };
  }

  /** 记录一次已放行的触发（进入计数与冷却） */
  record(actorId: string, kind: string, now: Date = this.nowFn()): void {
    const state = this.stateOf(actorId, now);
    state.dailyCount += 1;
    state.kindLastAt.set(kind, now.getTime());
  }

  /** 测试/诊断：当日已用预算 */
  dailyCountOf(actorId: string, now: Date = this.nowFn()): number {
    return this.stateOf(actorId, now).dailyCount;
  }

  /** 每日总预算（诊断/日志用） */
  getBudget(): number {
    return this.dailyBudget;
  }
}
