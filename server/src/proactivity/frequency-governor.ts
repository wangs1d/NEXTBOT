// ProactivityHub —— 全局频控器（FrequencyGovernor）
//
// 职责：主动性多元化后防止"频繁打扰"。两层规则：
//  1. 每 actor 每日总预算（默认 3 次，env 可调；必达类提案在管道层绕过本预算）
//  2. 分 kind 冷却（greeting/分享每天最多 1 次，关怀 8h 一次……）；跟进类大类
//     的冷却按提案身份分桶（§3.5「同一事件最多跟进 1 次」管的是这件事，不是这类话）
// （静默时段规则已移除，2026-11-20：夜间不再按时段拦截）
//
// 与 ProactionCortex 的 disturb/repeat_suppress 是双层防线：本模块前置粗筛
// （触发源层），ProactionCortex 保留细筛（决策层），二者不冲突。
import type { FrequencyVerdict } from "./proactivity-types.js";
import type { FrequencyTier } from "./touchpoint-planner.js";

/** 分 kind 冷却毫秒表（env PROACTIVITY_COOLDOWN_<KIND> 可覆盖单值） */
const DEFAULT_KIND_COOLDOWN_MS: Record<string, number> = {
  greeting: 24 * 60 * 60 * 1000,        // 问候：每天最多 1 次
  interest_share: 24 * 60 * 60 * 1000,  // 分享：每天最多 1 次
  interest_alert: 4 * 60 * 60 * 1000,   // 兴趣热议推送：4h 冷却（同兴趣级去重由 InterestWatcher 指纹+间隔承担）
  care: 8 * 60 * 60 * 1000,             // 对话关怀：8h 冷却
  followup: 4 * 60 * 60 * 1000,         // 待办跟进：4h 冷却（按事计，见 IDENTITY_SCOPED_KINDS）
  // 承诺跟进（§3.5）：冷却**按事件本身**计（同一事件最多跟进 1 次），不是按 kind 计——
  // 两件不同的事各自的跟进互不阻挡，跨事件的总量由社交日预算 + slot 容量把关。
  commitment: 12 * 60 * 60 * 1000,
  task_celebration: 30 * 60 * 1000,     // 恭喜：每任务一次（30min 防连发）
  // ── C 端生活管家场景（Task 20 统一频控注册）──
  weather_alert: 30 * 60 * 1000,        // 恶劣天气预警：预警类需即时触达，30min 冷却防同一场雨连发
  life_reminder: 4 * 60 * 60 * 1000,    // 生活提醒（重要日子/预算超支/节律提醒等）：4h 冷却
  monthly_report: 24 * 60 * 60 * 1000,  // 月度报告（消费月报等）：每日最多 1 次
  // ── 评估器场景独立档（一个场景一个 kind，避免与生活提醒互相挤占冷却）──
  meeting_early: 4 * 60 * 60 * 1000,    // 临会预告（1h 档）：4h 冷却（与 15min 档独立）
  sleep_care: 20 * 60 * 60 * 1000,      // 深夜睡眠关怀：每晚最多一次
  // ── 位置场景（方案 D）──
  location_arrival: 6 * 60 * 60 * 1000, // 到达常去地点问候：同地点 6h 一次（别每次到家都唠叨）
  geofence_event: 30 * 60 * 1000,       // 地理围栏动作的 speak 告知：30min 兜底（围栏层自有防抖）
  // ── 地点语义转换（方案 E）──
  place_home_arrival: 12 * 60 * 60 * 1000,   // 回家问候：半天一次，触发层另有冷却
  place_home_departure: 12 * 60 * 60 * 1000, // 离家询问：半天一次
  place_work_arrival: 12 * 60 * 60 * 1000,   // 到公司问候：半天一次
  place_new_city: 24 * 60 * 60 * 1000,       // 异地建议：同城一天一次
  // ── 旅游接驳（travel-upgrade-plan P2）──
  transfer_reminder: 60 * 60 * 1000,    // 接驳提醒：同段行程只问一次（调度器自有 sent 表，此处是兜底冷却）
  // ── agent pulse（主动性聚合审阅）──
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

/**
 * 冷却按「同一件事」计的 kind（2026-11-30，PRD §3.5 限制）。
 *
 * 分 kind 冷却的本意是拦住**同一件事说第二遍**，但跟进类的 kind 是个大类
 * （`commitment` 覆盖用户所有未来事件）：按 kind 记冷却，等于「今天说过一句
 * 『面试辛苦了』，下午那句『搬家最累』就不许说了」——而 §3.5 的三条限制里没有
 * 这一条：「同一事件最多跟进 1 次；用户点了『别跟进这个』，同类事件 30 天内不再
 * 跟进；计入社交日预算」。拦住 B 事件靠的是那三条（事件指纹 + 类别抑制 + 社交预算），
 * 不是靠 A 事件的冷却。跨事件的合并/顺延由 §3.4 的 slot 容量与同触点合并负责
 * （「同一 slot 内的 3 条候选合并为 1 条投递」），限流不该替计划层做决定。
 *
 * 因此这些 kind 的冷却键带上提案身份（dedupKey，跟进类形如
 * `commitment:followup:<事件指纹 id>`）：同一件事仍在冷却里，不同件事各说各的。
 * 未带身份的调用（hub 快路径、旧调用点）退回按 kind 计——保守，不改既有语义。
 */
const IDENTITY_SCOPED_KINDS = new Set(["commitment", "followup"]);

/** 冷却计数桶：身份敏感的大类按 kind#身份 分桶，其余一律按 kind */
function cooldownBucket(kind: string, identity?: string): string {
  return IDENTITY_SCOPED_KINDS.has(kind) && identity ? `${kind}#${identity}` : kind;
}

// 静默时段限制已移除（2026-11-20）：夜间接推不再按时段拦截

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

/** Actor 频控状态（逐日计数 + 分 kind 冷却） */
type ActorFrequencyState = {
  dateKey: string;
  dailyCount: number;
  /** 其中「社交类」条数（2026-11-19：与事务类分账） */
  socialCount: number;
  /** 冷却桶 → 最近一次触发时间戳（桶见 cooldownBucket：多数就是 kind，跟进类是 kind#身份） */
  kindLastAt: Map<string, number>;
};

/** 频控状态快照（重启恢复用：预算计数 + 分 kind 冷却 + 自适应调整结果） */
export type GovernorSnapshot = {
  actors: Array<{
    actorId: string;
    dateKey: string;
    dailyCount: number;
    socialCount?: number;
    /** 冷却桶 → 时刻（桶 = kind，跟进类是 `kind#dedupKey`，见 cooldownBucket） */
    kindLastAt: Array<[string, number]>;
  }>;
  cooldowns: Record<string, number>;
  /** kind → 连续被忽略次数（§3.10 降频连击，旧快照没有该字段） */
  streaks?: Record<string, number>;
};

/** 自适应冷却边界（outcome 反馈调整 kind 冷却时的上下限） */
const ADAPTIVE_COOLDOWN_MAX_MS = 48 * 60 * 60 * 1000;

/**
 * 连续忽略降频（§3.10）：同一 kind 每累计这么多次「发了没被看」追加一档 ×2 冷却。
 * 单次忽略只走 ×1.5 的温和自适应，避免一两条没看到就把某类消息彻底沉寂。
 */
const IGNORE_STREAK_TO_DOUBLE = 3;

export class FrequencyGovernor {
  private readonly actors = new Map<string, ActorFrequencyState>();

  private readonly dailyBudget: number;
  /**
   * 社交类独立日预算（2026-11-19）：招呼/接话/兴趣分享/寒暄这类「没事找话说」。
   *
   * 为什么单独分账：原来事务提醒和闲聊共用一个 15 条池子——事务多的日子闲聊被
   * 挤光（主动性消失），闲聊多的日子提醒被挤掉（更要命）。分开之后各自有上限，
   * 事务类仍受 dailyBudget 兜底，社交类永远越不过本档预算。
   * 默认 2 = §3.10「正常」档；「多聊点」×2、「只在有事时」0（见 socialBudgetOf）。
   */
  private readonly socialDailyBudget: number;
  private readonly nowFn: () => Date;
  private readonly kindCooldownMs: Record<string, number>;
  /** env 显式覆盖过的 kind（restore 时不落盘值覆盖 env 意图） */
  private readonly envOverriddenKinds = new Set<string>();
  /**
   * 连续被忽略次数（§3.10 降频）：kind → 连击数。
   * 单次忽略只 ×1.5（温和自适应），攒够 3 次再叠一档 ×2——一两条没看到不该把某类
   * 消息彻底沉寂，连着几条都不看才说明这类话他现在不想听。收到正反馈即清零。
   */
  private readonly ignoreStreak = new Map<string, number>();
  /** 频率档读取（§3.10）：社交预算随档位走；未注入 = 全员按 normal */
  private tierOf?: (actorId: string) => FrequencyTier;
  /** 勿扰检查（AutonomySettingsStore.isDnd 的薄依赖；bootstrap 注入，缺省不启用） */
  private dndCheck?: (actorId: string) => boolean;

  /** 注入频率档读取（bootstrap 接 user-preferences 的同步缓存） */
  setTierCheck(fn: ((actorId: string) => FrequencyTier) | null): void {
    this.tierOf = fn ?? undefined;
  }

  /**
   * 该用户此刻的社交日预算（§3.10 三档：只在有事时 0 / 正常 2 / 多聊点 4）。
   * opts/env 给的数是「正常档」的标定值，多聊点按 ×2 派生，只在有事时恒为 0。
   */
  socialBudgetOf(actorId: string): number {
    const tier = this.tierOf?.(actorId) ?? "normal";
    if (tier === "quiet") return 0;
    return tier === "chatty" ? this.socialDailyBudget * 2 : this.socialDailyBudget;
  }

  /** 连续忽略计数（诊断用） */
  ignoreStreakOf(kind: string): number {
    return this.ignoreStreak.get(kind) ?? 0;
  }

  /**
   * 档位功能开关（§3.10 表）：「只在有事时」关掉跟进类提问——
   * 这一档的语义是「有事直说，别没事找我」，追问和提问都属于后者。
   * 社交类不在此判定（由 socialBudgetOf=0 兜住）。
   */
  tierAllows(actorId: string, feature: "followup" | "ask_you"): boolean {
    void feature; // 两个特性在同一档上同开同关，故不看具体值
    return (this.tierOf?.(actorId) ?? "normal") !== "quiet";
  }

  /** 注入勿扰检查（每用户 DND 开关；传 null 清除） */
  setDndCheck(fn: ((actorId: string) => boolean) | null): void {
    this.dndCheck = fn ?? undefined;
  }

  constructor(opts?: {
    dailyBudget?: number;
    /** 社交类独立日预算 = 「正常」档上限（缺省 env PROACTIVITY_SOCIAL_DAILY_BUDGET，默认 2） */
    socialDailyBudget?: number;
    /** 频率档读取（§3.10）：注入 user-preferences 的同步缓存；缺省全员 normal */
    tierOf?: (actorId: string) => FrequencyTier;
    kindCooldownMs?: Record<string, number>;
    /** 测试用：不读 env */
    ignoreEnv?: boolean;
    /** 注入测试时钟（默认真实系统时间；集成冒烟用 mock 时钟） */
    nowFn?: () => Date;
  }) {
    // 禁音时段检查已移除（2026-11-20）：主动推送不再受深夜时段限制，
    // 频控只剩日预算 + 分 kind 冷却 + 勿扰开关 + 自适应反馈。
    this.nowFn = opts?.nowFn ?? (() => new Date());
    this.tierOf = opts?.tierOf;
    // 每日预算定位为「异常熔断」而非主动性的日常约束：正常节制的责任在
    // ArbiterV2 打断成本 + 分 kind 冷却 + 反馈自适应，这里只防 LLM 抽风连发。
    this.dailyBudget = opts?.dailyBudget ?? readEnvInt("PROACTIVITY_DAILY_BUDGET", 15);
    this.socialDailyBudget =
      opts?.socialDailyBudget ?? readEnvInt("PROACTIVITY_SOCIAL_DAILY_BUDGET", 2);
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
   *
   * §3.10 的降频台阶叠在温和自适应之上：同一 kind 连着 3 次「发了没被看」再 ×2 一档
   * （仍受 48h 上限约束）并清零连击，被回应一次即归零。
   */
  noteOutcome(kind: string, positive: boolean): void {
    const base = DEFAULT_KIND_COOLDOWN_MS[kind] ?? DEFAULT_UNKNOWN_KIND_COOLDOWN_MS;
    const current = this.kindCooldownMs[kind] ?? DEFAULT_UNKNOWN_KIND_COOLDOWN_MS;
    let next = positive
      ? Math.max(base, Math.round(current * 0.9))
      : Math.min(Math.round(current * 1.5), ADAPTIVE_COOLDOWN_MAX_MS);
    if (positive) {
      this.ignoreStreak.delete(kind);
    } else {
      const streak = (this.ignoreStreak.get(kind) ?? 0) + 1;
      if (streak >= IGNORE_STREAK_TO_DOUBLE) {
        next = Math.min(Math.round(next * 2), ADAPTIVE_COOLDOWN_MAX_MS);
        this.ignoreStreak.delete(kind);
        console.log(`[FrequencyGovernor] ${kind} 连续 ${IGNORE_STREAK_TO_DOUBLE} 次被忽略 → 冷却再翻倍`);
      } else {
        this.ignoreStreak.set(kind, streak);
      }
    }
    this.kindCooldownMs[kind] = next;
  }

  /** 频控状态快照（ProactivePipeline 落盘 data/proactivity/frequency.json） */
  snapshot(): GovernorSnapshot {
    return {
    actors: [...this.actors].map(([actorId, s]) => ({
      actorId,
      dateKey: s.dateKey,
      dailyCount: s.dailyCount,
      socialCount: s.socialCount,
      kindLastAt: [...s.kindLastAt],
    })),
      cooldowns: { ...this.kindCooldownMs },
      // 连击数也要跨重启保留：否则每次重启都把「他已经连着三条没看」的账清干净
      streaks: Object.fromEntries(this.ignoreStreak),
    };
  }

  /** 从快照恢复（env 显式覆盖的 kind 不被落盘值覆盖） */
  restore(snapshot: GovernorSnapshot): void {
    for (const a of snapshot.actors ?? []) {
      this.actors.set(a.actorId, {
        dateKey: a.dateKey,
        dailyCount: a.dailyCount,
        socialCount: a.socialCount ?? 0,
        kindLastAt: new Map(a.kindLastAt ?? []),
      });
    }
    for (const [kind, ms] of Object.entries(snapshot.cooldowns ?? {})) {
      if (!this.envOverriddenKinds.has(kind) && Number.isFinite(ms)) this.kindCooldownMs[kind] = ms;
    }
    for (const [kind, n] of Object.entries(snapshot.streaks ?? {})) {
      if (Number.isFinite(n) && n > 0) this.ignoreStreak.set(kind, n);
    }
  }

  /** 预算用量（诊断接口展示）；socialBudget 按该用户频率档取（§3.10） */
  usageSnapshot(): Array<{
    actorId: string;
    dailyCount: number;
    budget: number;
    socialCount: number;
    socialBudget: number;
    frequencyTier: FrequencyTier;
  }> {
    return [...this.actors].map(([actorId, s]) => ({
      actorId,
      dailyCount: s.dailyCount,
      budget: this.dailyBudget,
      socialCount: s.socialCount,
      socialBudget: this.socialBudgetOf(actorId),
      frequencyTier: this.tierOf?.(actorId) ?? "normal",
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
        socialCount: 0,
        kindLastAt: state?.kindLastAt ?? new Map(),
      };
      this.actors.set(actorId, state);
    }
    return state;
  }

  /**
   * 判定一次主动意图是否允许触发。
   * @param kind 已知 kind 用专属冷却；LLM 自定义标签用默认冷却（预算兜底）
   * @param importance 重要性（用于勿扰豁免判定）
   * @param opts.awake 用户当前活跃在设备前（管道传入）
   *   消息不算惊扰——「23 点还醒着」时的轻声一句话与「把人叫醒」是两回事；
   *   high/critical（弹窗/响铃级）不豁免，仍按静默规则把关
   * @param opts.identity 提案身份（一般传 dedupKey）：跟进类 kind 的冷却按事计，
   *   不同事件不共用冷却（§3.5，见 IDENTITY_SCOPED_KINDS）；其余 kind 忽略该参数
   */
  canTrigger(
    actorId: string,
    kind: string,
    importance: "high" | "medium" | "low",
    now: Date = this.nowFn(),
    opts?: { awake?: boolean; tier?: "must" | "social"; identity?: string },
  ): FrequencyVerdict {
    const state = this.stateOf(actorId, now);

    // 规则 0：用户勿扰（AutonomySettingsStore DND）——medium/low 一律沉默，
    // high 及以上放行（紧急事不被勿扰吞掉）
    if (this.dndCheck?.(actorId) === true && importance !== "high") {
      return { allowed: false, reason: "dnd_active" };
    }

    // 规则 1：每日总预算
    if (state.dailyCount >= this.dailyBudget) {
      return { allowed: false, reason: `daily_budget_exhausted(${state.dailyCount}/${this.dailyBudget})` };
    }

    // 规则 1b：社交类独立预算（与事务类分账，见 socialDailyBudget 注释），
    // 上限按用户频率档取（§3.10：只在有事时 0 / 正常 2 / 多聊点 4）
    if (opts?.tier === "social") {
      const budget = this.socialBudgetOf(actorId);
      if (state.socialCount >= budget) {
        return {
          allowed: false,
          reason: `social_budget_exhausted(${state.socialCount}/${budget},tier=${
            this.tierOf?.(actorId) ?? "normal"
          })`,
        };
      }
    }

    // 规则 2：分 kind 冷却（未知 kind 用默认冷却，防新标签绕过）。
    // 跟进类大类按「同一件事」分桶（cooldownBucket）：A 事件的跟进不该拦住 B 事件的
    // 跟进（§3.5 的三条限制里没有这一条），但理由串仍报 kind 名，用户侧文案与
    // explain.ts 的解析口径不变。
    const bucket = cooldownBucket(kind, opts?.identity);
    const lastAt = state.kindLastAt.get(bucket);
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

  /** 记录一次已放行的触发（进入计数与冷却；identity 同 canTrigger，决定冷却记在哪个桶） */
  record(
    actorId: string,
    kind: string,
    now: Date = this.nowFn(),
    tier?: "must" | "social",
    identity?: string,
  ): void {
    const state = this.stateOf(actorId, now);
    state.dailyCount += 1;
    if (tier === "social") state.socialCount += 1;
    state.kindLastAt.set(cooldownBucket(kind, identity), now.getTime());
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
