// 时效准入闸（Temporal Admission Gate，2026-10-09）
//
// 定位：主动性「话题级」准入门槛，插在 ProactivityHub.route() 的负反馈抑制之后、
// FrequencyGovernor 频控之前。分工严格区分：
//   - FrequencyGovernor：管「频率」（分 kind 冷却 / 每日预算 / 静默时段）——回答"现在能不能说"；
//   - SuppressionStore：管「用户明确拒绝」——回答"用户还要不要听"；
//   - 本模块：管「话题时效与相关性」——回答"这件事现在还该不该被主动提起"。
//
// 病灶（2026-10-08/09 实证「刚才你说好饿」事故）：主动链路上缺少时效维度，
// 只要一个意图被重新派生出来（顺嘴过期升级、状态板规则重复触发），
// 无论它对应的事件发生在多久之前，都会被当成"此刻的事"讲出来。
//
// 事实层已有承诺板/目标板的状态机（fulfilled/superseded/…），缺的是
// 在**投递前**用「年龄 + 相关性」做确定性准入判定，而不是指望模型自觉。
//
// 判定阶梯（全部零 LLM、确定性）：
//   0. age ≤ deliveryWindow(kind)              → in_flight（在途投递，原行为不变）
//   1. age > staleCeiling(kind)                → stale_topic（超保质期，永不复活）
//   2. 非延迟投递源且无活跃话题                → no_active_topic
//   3. 非延迟投递源且与当前/近期话题无交集      → irrelevant_to_active_topic
//   4. 从未交互过（冷启动）                     → cold_start_no_history
//   5. 久未互动且非 high                       → long_silence_guard
//   6. 当日"复活旧话题"额度用尽                 → revival_quota_exhausted
//   否则                                        → revived_admitted（放行并计数）
//
// 关键取舍：**默认无行为变化**。只有生产者显式打了 `originAt`（事件真实发生时刻）
// 且年龄越过 deliveryWindow 时，才进入 1-6 的从严判定；未打 originAt 的意图
// 一律视为"新鲜事件"，走阶梯 0 直接放行——所以既有触发源（天气/邮件/账单/日程）
// 的行为一字不变，闸门只咬"翻旧账"。
//
// 回滚开关：PROACTIVITY_TEMPORAL_ADMISSION=0 全局关闭。

import type { ProactiveIntent } from "./proactivity-types.js";

/** 准入判定结果（可解释：reason 直接进沉默日志，支撑「你当时为什么没提」反问） */
export type AdmissionVerdict = {
  admitted: boolean;
  reason: string;
  /** 话题年龄（ms）；未打 originAt 时为 0 */
  ageMs: number;
  /** 是否属于「复活旧话题」（age 越过在途窗口） */
  revived: boolean;
};

/** 准入判定所需的对话上下文（route() 调用方提供） */
export type AdmissionContext = {
  now?: number;
  /** 本轮用户原话（本轮正在进行的对话；为空=没有活跃话题） */
  currentUserText?: string;
  /** 近期若干轮用户原话（话题窗口，用于相关度匹配） */
  recentUserTexts?: string[];
  /** 最近一次用户交互时刻；null/undefined = 从未交互 */
  lastInteractionAt?: number | null;
};

/** 分 kind 时效窗口（ms） */
type KindWindow = { delivery: number; ceiling: number };

const HOUR = 60 * 60_000;

/** 默认在途窗口：6h 内的意图仍视为"正在投递"，不做任何额外判定 */
const DEFAULT_DELIVERY_WINDOW_MS = 6 * HOUR;
/** 默认保质期上限：超过 3 天的事件不再被主动复活 */
const DEFAULT_STALE_CEILING_MS = 72 * HOUR;

/**
 * 顺嘴搭车挂起 TTL（分钟；与 turn-aside-queue 读同一 env，此处重复读取只为
 * 保证「在途窗口 ≥ 延迟投递窗口」这一结构性不变式，避免产生循环依赖）。
 */
function asideTtlMin(): number {
  const n = Number.parseInt(process.env.PROACTIVITY_TURN_ASIDE_TTL_MIN ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : 120;
}

/**
 * 分 kind 时效窗口。delivery = 在途窗口（内=放行），ceiling = 保质期（外=永不复活）。
 * 依据：恭喜/位置问候这类体验型主动行为时效最短；待办跟进（followup）以"当天闭环"
 * 为界；兴趣热议（interest_alert）由 watcher 当场派生，放宽即可。
 *
 * ⚠️ 不变式：followup 的在途窗口必须 **不小于** 顺嘴挂起 TTL + 5min 扫描余量，
 * 否则"过期升级重投"这条合法延迟投递会被相关闸误拦（用户沉默时中优消息永远弹不出）。
 * 用 PROACTIVITY_TURN_ASIDE_TTL_MIN 调大 TTL 时，这里会自动跟随，无需手工同步。
 */
const KIND_WINDOWS: Record<string, KindWindow> = {
  task_celebration: { delivery: 1 * HOUR, ceiling: 6 * HOUR },
  followup: { delivery: Math.max(2.5 * HOUR, (asideTtlMin() + 10) * 60_000), ceiling: 24 * HOUR },
  care: { delivery: 6 * HOUR, ceiling: 24 * HOUR },
  location_arrival: { delivery: 3 * HOUR, ceiling: 12 * HOUR },
  overwork_care: { delivery: 6 * HOUR, ceiling: 24 * HOUR },
  interest_alert: { delivery: 24 * HOUR, ceiling: 72 * HOUR },
  weather_alert: { delivery: 6 * HOUR, ceiling: 24 * HOUR },
};

/**
 * 延迟投递源：这些源本身就是"用户先给出、系统延后送达"的合法在途语义
 * （顺嘴搭车过期升级、ask_first 确认超时告知），不是"翻旧账"，
 * 因此豁免相关闸（否则用户沉默时升级路径永远打不出去），但仍受保质期与配额约束。
 */
const DEFERRED_DELIVERY_SOURCES = new Set(["turn_aside_expiry", "confirmation_expiry"]);

/** 长期静默护栏：超过该时长未互动时，非 high 的"旧话题"不主动复活 */
const DEFAULT_LONG_SILENCE_MS = 12 * HOUR;
/** 每日"复活旧话题"额度（默认 1：翻旧账每天最多一次） */
const DEFAULT_REVIVAL_DAILY_CAP = 1;

/**
 * 相关度判定停用词（2-gram 噪声）：这些 bigram 在任何两段中文里都会撞上，
 * 留着会让"相关闸"形同虚设（"用户/表示/这个/一下" 之类的结构词）。
 */
const TOPIC_STOP_BIGRAMS = new Set([
  "用户", "助手", "表示", "认为", "觉得", "这个", "那个", "什么", "怎么", "可以",
  "是否", "已经", "还有", "因为", "所以", "但是", "如果", "就是", "一个", "一下",
  "我们", "他们", "自己", "没有", "不会", "不是", "时候", "现在", "今天", "明天",
  "昨天", "晚上", "早上", "中午", "事情", "问题", "需要", "希望", "想要", "可能",
]);

function readEnvInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** 时效准入闸总开关（默认开；PROACTIVITY_TEMPORAL_ADMISSION=0 回退到无闸旧行为） */
export function isTemporalAdmissionEnabled(): boolean {
  const raw = process.env.PROACTIVITY_TEMPORAL_ADMISSION?.trim().toLowerCase();
  return !(raw === "0" || raw === "false" || raw === "off");
}

/** 话题词元：CJK 2-gram + 拉丁/数字词（零依赖的轻量分词，够做粗相关度判定） */
export function topicTokens(text: string | undefined | null): Set<string> {
  const out = new Set<string>();
  if (!text) return out;
  const s = text.toLowerCase();
  for (const m of s.matchAll(/[a-z0-9][a-z0-9_.-]{1,}/g)) {
    out.add(m[0]);
  }
  const cjkRuns = s.replace(/[^\u4e00-\u9fa5]+/g, " ").split(/\s+/);
  for (const run of cjkRuns) {
    if (run.length < 2) continue;
    for (let i = 0; i + 2 <= run.length; i++) {
      const g = run.slice(i, i + 2);
      if (TOPIC_STOP_BIGRAMS.has(g)) continue;
      out.add(g);
    }
  }
  return out;
}

/** 两段文本是否有共同话题词元（任一交集即视为相关——宁可放过，不可错杀） */
export function sharesTopic(a: string, b: string): boolean {
  const ta = topicTokens(a);
  if (ta.size === 0) return false;
  const tb = topicTokens(b);
  if (tb.size === 0) return false;
  for (const t of ta) {
    if (tb.has(t)) return true;
  }
  return false;
}

function localDateKey(now: number): string {
  const d = new Date(now);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function windowOf(kind: string): KindWindow {
  return KIND_WINDOWS[kind] ?? { delivery: DEFAULT_DELIVERY_WINDOW_MS, ceiling: DEFAULT_STALE_CEILING_MS };
}

export type TemporalAdmissionGateOptions = {
  /** 测试注入时钟 */
  nowFn?: () => number;
  /** 测试用：不读 env */
  ignoreEnv?: boolean;
  /** 每日复活额度（覆盖默认 1） */
  revivalDailyCap?: number;
  /** 长期静默护栏时长（覆盖默认 12h） */
  longSilenceMs?: number;
};

export class TemporalAdmissionGate {
  private readonly nowFn: () => number;
  private readonly revivalDailyCap: number;
  private readonly longSilenceMs: number;
  /** 当日复活计数：actorId → { dateKey, count } */
  private readonly revivalCount = new Map<string, { dateKey: string; count: number }>();

  constructor(opts?: TemporalAdmissionGateOptions) {
    this.nowFn = opts?.nowFn ?? Date.now;
    const env = opts?.ignoreEnv === true;
    this.revivalDailyCap =
      opts?.revivalDailyCap ??
      (env ? DEFAULT_REVIVAL_DAILY_CAP : readEnvInt("PROACTIVITY_REVIVAL_DAILY_CAP", DEFAULT_REVIVAL_DAILY_CAP));
    this.longSilenceMs =
      opts?.longSilenceMs ??
      (env ? DEFAULT_LONG_SILENCE_MS : readEnvInt("PROACTIVITY_LONG_SILENCE_MIN", DEFAULT_LONG_SILENCE_MS / 60_000) * 60_000);
  }

  /** 当日已用复活额度（诊断/测试） */
  revivalUsed(actorId: string, now: number = this.nowFn()): number {
    const entry = this.revivalCount.get(actorId);
    if (!entry || entry.dateKey !== localDateKey(now)) return 0;
    return entry.count;
  }

  /**
   * 判定一次主动意图是否准入。纯确定性；不产生副作用（放行时才计复活额度）。
   */
  evaluate(intent: ProactiveIntent, ctx: AdmissionContext = {}): AdmissionVerdict {
    const now = ctx.now ?? this.nowFn();
    const w = windowOf(intent.kind);
    const originAt = typeof intent.originAt === "number" && Number.isFinite(intent.originAt) ? intent.originAt : now;
    const ageMs = Math.max(0, now - originAt);

    // 阶梯 0：在途窗口内——按原行为放行（未打 originAt 的意图恒落在此）
    if (ageMs <= w.delivery) {
      return { admitted: true, reason: `in_flight(${Math.round(ageMs / 60_000)}m<=${Math.round(w.delivery / 60_000)}m)`, ageMs, revived: false };
    }

    const ageH = (ageMs / HOUR).toFixed(1);
    const ceilingH = (w.ceiling / HOUR).toFixed(1);
    const deferred = DEFERRED_DELIVERY_SOURCES.has(intent.source);

    // 阶梯 1：超保质期——永远不复活（用户想接着聊会自己开口，届时是新意图）
    if (ageMs > w.ceiling) {
      return { admitted: false, reason: `stale_topic(kind=${intent.kind},${ageH}h>${ceilingH}h)`, ageMs, revived: true };
    }

    // 阶梯 2/3：相关闸（延迟投递源豁免——它们不是"翻旧账"，是被延后的合法在途）
    if (!deferred) {
      const currentTurn = (ctx.currentUserText ?? "").trim();
      if (!currentTurn) {
        return { admitted: false, reason: `no_active_topic(kind=${intent.kind},age=${ageH}h)`, ageMs, revived: true };
      }
      const candidate = `${intent.title} ${intent.summary}`;
      const related = sharesTopic(candidate, currentTurn) ||
        (ctx.recentUserTexts ?? []).some((t) => sharesTopic(candidate, t));
      if (!related) {
        return { admitted: false, reason: `irrelevant_to_active_topic(kind=${intent.kind},age=${ageH}h)`, ageMs, revived: true };
      }
    }

    // 阶梯 4：冷启动——从未交互过的用户不主动翻旧账
    if (ctx.lastInteractionAt == null) {
      return { admitted: false, reason: `cold_start_no_history(kind=${intent.kind})`, ageMs, revived: true };
    }

    // 阶梯 5：长期静默护栏——久未互动时只有 high 才允许复活旧话题
    const silenceMs = now - ctx.lastInteractionAt;
    if (silenceMs > this.longSilenceMs && intent.importance !== "high") {
      return {
        admitted: false,
        reason: `long_silence_guard(kind=${intent.kind},silence=${(silenceMs / HOUR).toFixed(1)}h>${(this.longSilenceMs / HOUR).toFixed(1)}h,importance=${intent.importance})`,
        ageMs,
        revived: true,
      };
    }

    // 阶梯 6：当日复活额度（翻旧账每天最多 N 次）
    const used = this.revivalUsed(intent.actorId, now);
    if (used >= this.revivalDailyCap) {
      return {
        admitted: false,
        reason: `revival_quota_exhausted(kind=${intent.kind},${used}/${this.revivalDailyCap})`,
        ageMs,
        revived: true,
      };
    }

    this.bumpRevival(intent.actorId, now);
    return { admitted: true, reason: `revived_admitted(kind=${intent.kind},age=${ageH}h)`, ageMs, revived: true };
  }

  private bumpRevival(actorId: string, now: number): void {
    const dateKey = localDateKey(now);
    const entry = this.revivalCount.get(actorId);
    if (!entry || entry.dateKey !== dateKey) {
      this.revivalCount.set(actorId, { dateKey, count: 1 });
      return;
    }
    entry.count += 1;
  }
}

/** 审计串：进提案 evidence，回答"为什么提了" */
export function formatAdmissionEvidence(verdict: AdmissionVerdict): string {
  return `admission=${verdict.reason}`;
}
