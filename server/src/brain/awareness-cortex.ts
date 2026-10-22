// Agent Brain Center —— 觉察皮层（AwarenessCortex）
//
// 职责：基于 LifeSignalHub / DesktopPresence / MoodInference / AnticipationEngine
// 子系统提供的信号，按纯规则（无 LLM）推断用户当前的活动状态（UserActivityState），
// 并对外提供 observe / recentActivity / onActivityChange 等查询与订阅入口。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { AnticipationCandidate, LifeSignal } from "../services/life-signal-types.js";
import type {
  BrainDecision,
  SemanticAwarenessInferrer,
  UserActivityKind,
  UserActivityState,
  UserMentalState,
} from "./types.js";

// ---- 子系统最小化接口（仅声明 AwarenessCortex 实际用到的方法）------------

/** LifeSignalHub 订阅回调签名 */
type LifeSignalSubscriber = (signal: LifeSignal) => Promise<void> | void;

/** LifeSignalHubService 的最小化结构接口 */
interface LifeSignalHubLike {
  subscribe(subscriber: LifeSignalSubscriber): () => void;
  recentSignals(actorId: string, limit?: number): LifeSignal[];
}

/**
 * DesktopPresenceSignalService 的最小化结构接口。
 *
 * 现阶段该服务仅通过 LifeSignalHub 发布 desktop_presence_* 信号，
 * AwarenessCortex 直接从 hub 中读取这些信号即可，无需直接调用其方法。
 * 保留此接口用于 registerDesktopPresence 的类型约束与未来扩展。
 */
interface DesktopPresenceLike {
  // 占位：当前无直接调用方法
}

/** MoodInferenceService 的最小化结构接口 */
interface MoodInferenceLike {
  listForSession(
    sessionId: string,
    limit?: number,
  ): Array<{
    sentimentScore: number;
    confidence: number;
    emotionTags: string[];
    source: string;
    timestamp: string;
  }>;
  todayMood(sessionId: string): {
    avgSentiment: number;
    dominantTags: string[];
    sampleCount: number;
  } | null;
}

/** AnticipationEngineService 的最小化结构接口 */
interface AnticipationLike {
  recentCandidates(actorId: string, limit?: number): AnticipationCandidate[];
}

/**
 * ScheduleTaskService 的最小化结构接口。
 * AwarenessCortex 仅用到 listTasksBySession：查询当前时间窗内的日历事件，
 * 用于识别 meeting 状态。
 */
interface ScheduleTaskLike {
  listTasksBySession(
    sessionId: string,
    range?: { from?: string; to?: string },
  ): Array<{
    status: "active" | "paused" | "completed" | "cancelled" | "failed";
    runAt: string;
    nextRunAt: string | null;
    kind: string;
    title?: string;
  }>;
}

/**
 * ProactionCortex 的最小化结构接口。
 * AwarenessCortex 仅用到 recentDecisions：判断最近是否有 speak 类决策打断，
 * 用于识别 in_focus 状态。
 */
interface ProactionLike {
  recentDecisions(actorId: string): BrainDecision[];
}

// ---- 关键词表 ----------------------------------------------------------

// 出行类关键词（中文 + 英文）
const TRAVEL_KEYWORDS = [
  "出行", "出差", "旅游", "出去玩", "走起", "出发",
  "火车", "飞机", "高铁", "打车", "机场",
  "travel", "trip", "outing", "flight", "train", "taxi", "airport",
];

// 下班 / 切换 / 解锁类关键词
const OFF_WORK_KEYWORDS = [
  "下班", "刚下班", "off_work", "off work", "leave work",
  "解锁", "刚解锁", "unlock",
  "切换应用", "switch_app", "switch app",
];

// 工作应用关键词
const WORK_APP_KEYWORDS = [
  "ide", "vscode", "intellij",
  "office", "word", "excel", "powerpoint",
  "browser", "chrome", "edge",
  "工作应用", "多tab", "多 tab", "multi-tab",
];

// 将关键词数组编译为一条 OR 正则
function buildPattern(keywords: string[]): RegExp {
  const escaped = keywords.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(escaped.join("|"), "i");
}

const TRAVEL_PATTERN = buildPattern(TRAVEL_KEYWORDS);
const OFF_WORK_PATTERN = buildPattern(OFF_WORK_KEYWORDS);
const WORK_APP_PATTERN = buildPattern(WORK_APP_KEYWORDS);

// 出行候选在 anticipation 候选里的识别正则
const TRAVEL_CANDIDATE_PATTERN =
  /(travel|outing|trip|出行|出差|旅游|出发|火车|飞机|高铁|打车|机场)/i;

// ---- 常量 --------------------------------------------------------------

const RECENT_HISTORY_LIMIT = 20;
const TRAVEL_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const SLEEP_INACTIVE_MS = 30 * 60 * 1000;
/** 单场睡眠会话上限：超过视为跨天陈旧残账（宕机/重启链/测试残留），丢弃不记 */
const SLEEP_SESSION_MAX_MS = 20 * 60 * 60 * 1000;
/** 恢复时丢弃超过该时长的挂起会话（多天前的残账永远等不到真实「睡醒」） */
const SLEEP_ONGOING_STALE_MS = 48 * 60 * 60 * 1000;
const INFERENCE_SIGNAL_SCAN = 50;
/**
 * 动态睡眠窗口学习相关常量。
 *
 * 用户要求 dreaming 时间窗口根据用户习惯决定，而非硬编码 23:00-6:00。
 * 策略：跟踪用户进入/离开 sleeping 状态的时段，积累最近 N 天的样本，
 *       用中位数计算个性化窗口起点/终点。
 */
const SLEEP_WINDOW_SAMPLE_LIMIT = 14; // 保留最近 14 天的睡眠窗口样本
const SLEEP_WINDOW_MIN_SAMPLES = 3;   // 至少 3 个样本才开始使用学习到的窗口
/**
 * 深度专注（in_focus）触发阈值：持续 busy 超过 25 分钟且近 25 分钟无 speak 决策打断。
 */
const IN_FOCUS_THRESHOLD_MS = 25 * 60_000;
/**
 * meeting 检测时间窗：±15 分钟。当前时间在该窗口内有 active 日历事件即视为会议中。
 */
const MEETING_WINDOW_MS = 15 * 60_000;

// ---- AwarenessCortex ---------------------------------------------------

type ActivityChangeListener = (state: UserActivityState) => void | Promise<void>;

/**
 * 觉察皮层：聚合多个生命信号子系统，按规则推断用户活动状态。
 *
 * 推断为纯规则实现（无 LLM），按优先级：
 * just_off_work > going_out > busy > sleeping > idle > unknown
 */
export class AwarenessCortex {
  private hub: LifeSignalHubLike | null = null;
  private desktop: DesktopPresenceLike | null = null;
  private mood: MoodInferenceLike | null = null;
  private anticipation: AnticipationLike | null = null;
  private scheduleTask: ScheduleTaskLike | null = null;
  private proaction: ProactionLike | null = null;
  /** SemanticAwarenessInferrer（可选，注入后 observeWithMental 产出 UserMentalState） */
  private semanticInferrer: SemanticAwarenessInferrer | null = null;

  /** 最近设备状态变化事件（来自 body.skin.device_change） */
  private recentDeviceChangeEvents: Array<{ at: string; payload: unknown }> = [];
  /** 最近设备切换事件（来自 body.vestibular.device_switch） */
  private recentDeviceSwitchEvents: Array<{ at: string; payload: unknown }> = [];
  /** BodyBus 订阅取消函数（attachBodyBus 注入后设置，stop 时清理） */
  private bodyBusUnsubscribe: (() => void) | null = null;

  private unsubscribe: (() => void) | null = null;
  private started = false;

  /** 最近一次活动状态缓存 */
  private readonly latest = new Map<string, UserActivityState>();
  /** 最近 RECENT_HISTORY_LIMIT 条活动历史 */
  private readonly history = new Map<string, UserActivityState[]>();
  /** 活动变化订阅者 */
  private readonly listeners = new Set<ActivityChangeListener>();
  /**
   * 动态睡眠窗口学习：per-actorId 睡眠时段样本。
   *
   * key: actorId
   * value: 最近 SLEEP_WINDOW_SAMPLE_LIMIT 个样本（按时间顺序）
   *        date: 样本所属日期（YYYY-MM-DD）
   *        startHour: 进入 sleeping 的小时（小数表示，如 23.5 = 23:30）
   *        endHour: 离开 sleeping 的小数小时（跨天时 endHour < startHour，如 6.25 = 6:15）
   *
   * 用中位数计算个性化窗口，避免单个异常值影响。
   */
  private readonly sleepWindowSamples = new Map<
    string,
    Array<{ date: string; startHour: number; endHour: number }>
  >();
  /** 正在跟踪的 sleeping 会话：actorId → 进入 sleeping 的时间戳 */
  private readonly ongoingSleepSession = new Map<string, number>();

  // ---- 睡眠样本持久化 + 周期刷新（2026-10-01 rhythm 断供根修）--------------
  // 断供三根因：① observe() 命中缓存即短路 + 夜间桌面无活动=无信号 → 状态机
  // 永远进不了 sleeping，样本零积累；② 样本纯内存，重启清零，凑不齐
  // SLEEP_WINDOW_MIN_SAMPLES(3)；③ 样本按原始 actorId 存取，与 rhythm 侧
  // 下划线归一形式错位。修复：定时器周期重推断 + 落盘 + 归一 key。

  /** 样本落盘目录（setPersistPath 注入；null=纯内存，测试用） */
  private persistDir: string | null = null;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  /** 周期刷新定时器：无信号时段（睡眠中）也能推进状态机 */
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  static readonly REFRESH_INTERVAL_MS = 10 * 60_000;
  private static readonly PERSIST_DEBOUNCE_MS = 30_000;

  /**
   * 睡眠样本 key 归一：与 rhythm/profile-store 的文件名归一（@ → _）一致，
   * 消除「样本按原始 id 存、节律引擎按归一 id 取」的错位。
   */
  private static sleepKey(actorId: string): string {
    return actorId.replace(/[^a-zA-Z0-9._-]/g, "_") || "unknown";
  }

  /** 注入样本持久化目录并立即恢复存量（bootstrap 装配时调用一次） */
  setPersistPath(dir: string): void {
    this.persistDir = dir;
    this.restoreSleepSamples();
  }

  private get sleepSamplesPath(): string {
    return this.persistDir ? join(this.persistDir, "awareness-sleep-samples.json") : "";
  }

  private restoreSleepSamples(): void {
    if (!this.persistDir) return;
    try {
      const p = this.sleepSamplesPath;
      if (!existsSync(p)) return;
      const raw = JSON.parse(readFileSync(p, "utf8")) as {
        actors?: Record<
          string,
          { samples?: Array<{ date: string; startHour: number; endHour: number }>; ongoingSince?: number }
        >;
      };
      for (const [key, entry] of Object.entries(raw.actors ?? {})) {
        if (Array.isArray(entry.samples)) {
          this.sleepWindowSamples.set(key, entry.samples.slice(-50));
        }
        if (typeof entry.ongoingSince === "number") {
          // 超过 48h 的挂起会话是多天前的残账（runtime 长期未跑/测试 actor），
          // 真实「睡醒」永远等不来，恢复即丢弃，避免陈旧时长污染将来的样本
          if (Date.now() - entry.ongoingSince <= SLEEP_ONGOING_STALE_MS) {
            this.ongoingSleepSession.set(key, entry.ongoingSince);
          }
        }
      }
      const total = [...this.sleepWindowSamples.values()].reduce((n, s) => n + s.length, 0);
      if (total > 0) {
        console.log(`[AwarenessCortex] 睡眠样本已恢复：${total} 条 / ${this.sleepWindowSamples.size} 用户`);
      }
    } catch {
      /* 损坏文件按空处理 */
    }
  }

  private schedulePersist(): void {
    if (!this.persistDir || this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.flushSleepSamples();
    }, AwarenessCortex.PERSIST_DEBOUNCE_MS);
    if (typeof this.persistTimer.unref === "function") this.persistTimer.unref();
  }

  flushSleepSamples(): void {
    if (!this.persistDir) return;
    try {
      const actors: Record<
        string,
        { samples: unknown[]; ongoingSince?: number }
      > = {};
      const keys = new Set([...this.sleepWindowSamples.keys(), ...this.ongoingSleepSession.keys()]);
      for (const key of keys) {
        actors[key] = {
          samples: this.sleepWindowSamples.get(key) ?? [],
          ...(this.ongoingSleepSession.has(key)
            ? { ongoingSince: this.ongoingSleepSession.get(key) }
            : {}),
        };
      }
      mkdirSync(this.persistDir, { recursive: true });
      writeFileSync(this.sleepSamplesPath, JSON.stringify({ version: 1, actors }));
    } catch {
      /* 落盘失败不影响主链路 */
    }
  }

  /**
   * 周期刷新（定时器驱动）：对所有已跟踪 actor 重新推断一次并静默提交。
   * 关键价值在无信号时段——夜间桌面无活动 = hub 无信号 = handleSignal 不触发
   * = sleeping 永远进不去；定时器让状态机按墙钟推进，睡眠窗口才可被记录。
   * 纯规则推断（零 LLM 零 IO），10 分钟一拍，睡眠起点精度 ±10 分钟（样本为
   * 小时粒度，足够）。
   */
  private refreshTrackedActors(): void {
    const actorIds = new Set([...this.latest.keys(), ...this.history.keys()]);
    for (const actorId of actorIds) {
      try {
        const state = this.inferActivity(actorId);
        if (state) this.commitState(state, false);
      } catch {
        /* 单 actor 失败不影响其他 */
      }
    }
  }

  // ---- 子系统注册 -------------------------------------------------------

  registerLifeSignalHub(hub: LifeSignalHubLike): void {
    this.hub = hub;
    console.log("[AwarenessCortex] 已注册 LifeSignalHub");
  }

  registerDesktopPresence(svc: DesktopPresenceLike): void {
    this.desktop = svc;
    console.log("[AwarenessCortex] 已注册 DesktopPresenceSignalService");
  }

  registerMoodInference(svc: MoodInferenceLike): void {
    this.mood = svc;
    console.log("[AwarenessCortex] 已注册 MoodInferenceService");
  }

  registerAnticipation(svc: AnticipationLike): void {
    this.anticipation = svc;
    console.log("[AwarenessCortex] 已注册 AnticipationEngineService");
  }

  /** 注册日程任务服务，使 inferActivity 能查询当前进行中的日历事件（meeting 状态） */
  registerScheduleTask(svc: ScheduleTaskLike): void {
    this.scheduleTask = svc;
    console.log("[AwarenessCortex] 已注册 ScheduleTaskService");
  }

  /** 注册主动皮层，使 inferActivity 能查询最近 speak 决策，识别 in_focus 状态 */
  registerProaction(svc: ProactionLike): void {
    this.proaction = svc;
    console.log("[AwarenessCortex] 已注册 ProactionCortex");
  }

  /**
   * 注册语义觉察推断器（SemanticAwarenessInferrer）。
   *
   * 注册后 observeWithMental 会调用 inferrer.infer 产出 UserMentalState，
   * 让 cognize LLM 能理解"嘴上说休息但还在赶工"这种深层语义。
   * 未注册时 observeWithMental 返回 mental=unknown（保持原规则路径，向后兼容）。
   */
  registerSemanticInferrer(inferrer: SemanticAwarenessInferrer): void {
    this.semanticInferrer = inferrer;
    console.log("[AwarenessCortex] 已注册 SemanticAwarenessInferrer");
  }

  /**
   * 订阅 BodyBus 上行身体状态信号，让觉察皮层能感知身体侧的事件。
   *
   * 订阅主题：
   *  - body.homeostasis.battery_low → 触发用户活动推断（用户可能去充电了，状态变化）
   *  - body.skin.device_change → 记录最近设备状态变化事件（供 inferActivity 参考）
   *  - body.vestibular.device_switch → 记录设备切换事件
   *
   * 返回取消订阅函数（调用后移除所有 BodyBus 订阅）。
   * 此方法由 create-app-services.ts 在装配阶段调用，注入 BodyBus 引用。
   */
  attachBodyBus(bodyBus: {
    subscribe(kind: string, handler: (signal: unknown) => void | Promise<void>): () => void;
  }): () => void {
    const unsubs: Array<() => void> = [];

    // body.homeostasis.battery_low → 触发用户活动推断
    unsubs.push(
      bodyBus.subscribe("body.homeostasis.battery_low", (signal) => {
        try {
          const s = signal as { actorId?: string; payload?: Record<string, unknown> };
          if (s?.actorId) {
            // 电量低可能意味着用户去充电了，活动状态可能变化，重新推断一次
            const state = this.inferActivity(s.actorId);
            if (state) {
              this.commitState(state, true);
            }
          }
        } catch (err) {
          console.log(`[AwarenessCortex] battery_low 信号处理失败（忽略）: ${err}`);
        }
      }),
    );

    // body.skin.device_change → 记录最近设备状态变化事件
    unsubs.push(
      bodyBus.subscribe("body.skin.device_change", (signal) => {
        try {
          const s = signal as { payload?: Record<string, unknown>; timestamp?: string };
          this.recentDeviceChangeEvents.push({
            at: s?.timestamp ?? new Date().toISOString(),
            payload: s?.payload,
          });
          // 仅保留最近 20 条，避免无限增长
          if (this.recentDeviceChangeEvents.length > 20) {
            this.recentDeviceChangeEvents.shift();
          }
        } catch {
          /* ignore */
        }
      }),
    );

    // body.vestibular.device_switch → 记录设备切换事件
    unsubs.push(
      bodyBus.subscribe("body.vestibular.device_switch", (signal) => {
        try {
          const s = signal as { payload?: Record<string, unknown>; timestamp?: string };
          this.recentDeviceSwitchEvents.push({
            at: s?.timestamp ?? new Date().toISOString(),
            payload: s?.payload,
          });
          if (this.recentDeviceSwitchEvents.length > 20) {
            this.recentDeviceSwitchEvents.shift();
          }
        } catch {
          /* ignore */
        }
      }),
    );

    const unsubAll = () => {
      for (const unsub of unsubs) {
        try {
          unsub();
        } catch {
          /* ignore */
        }
      }
    };
    this.bodyBusUnsubscribe = unsubAll;
    console.log("[AwarenessCortex] 已订阅 BodyBus（battery_low / device_change / device_switch）");
    return unsubAll;
  }

  // ---- 生命周期 ---------------------------------------------------------

  async start(): Promise<void> {
    if (this.started) {
      console.log("[AwarenessCortex] 已启动，跳过重复 start");
      return;
    }
    if (this.hub) {
      this.unsubscribe = this.hub.subscribe((signal) => {
        try {
          this.handleSignal(signal);
        } catch (err) {
          console.error("[AwarenessCortex] handleSignal failed:", err);
        }
      });
      console.log("[AwarenessCortex] 已订阅 LifeSignalHub");
    } else {
      console.log("[AwarenessCortex] LifeSignalHub 未注册，跳过订阅");
    }
    // 周期刷新：无信号时段（夜间睡眠中桌面零信号）状态机也能推进——
    // 否则 sleeping 永远进不去，睡眠窗口样本永远零积累（rhythm 断供根因①）
    this.refreshTimer = setInterval(
      () => this.refreshTrackedActors(),
      AwarenessCortex.REFRESH_INTERVAL_MS,
    );
    if (typeof this.refreshTimer.unref === "function") this.refreshTimer.unref();
    this.started = true;
    console.log("[AwarenessCortex] 启动完成");
  }

  async stop(): Promise<void> {
    if (!this.started) {
      console.log("[AwarenessCortex] 未启动，跳过 stop");
      return;
    }
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    if (this.bodyBusUnsubscribe) {
      this.bodyBusUnsubscribe();
      this.bodyBusUnsubscribe = null;
    }
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    // 停机前把睡眠样本落盘（进行中的 sleeping 会话起点也带上，重启后接续计时）
    this.flushSleepSamples();
    this.latest.clear();
    this.history.clear();
    this.started = false;
    console.log("[AwarenessCortex] 已停止");
  }

  // ---- 外观方法 ---------------------------------------------------------

  /** 返回最近一次活动状态；无缓存则即时推断一次 */
  observe(actorId: string): UserActivityState | null {
    const cached = this.latest.get(actorId);
    if (cached) return cached;
    const state = this.inferActivity(actorId);
    if (state) {
      this.commitState(state, false);
    }
    return state;
  }

  /**
   * 返回活动状态 + 心智状态复合对象。
   *
   * activity 一定有值（规则推断，立即返回）；
   * mental 可能为 null（inferrer 未注册时）或 unknown 降级（inferrer 调用失败时）。
   * 调用方应 graceful 处理 mental=null 跳过注入。
   */
  async observeWithMental(
    actorId: string,
    opts?: { recentConversationHistory?: string },
  ): Promise<{ activity: UserActivityState | null; mental: UserMentalState | null }> {
    const activity = this.observe(actorId);
    if (!this.semanticInferrer || !activity) {
      return { activity, mental: null };
    }
    try {
      const mental = await this.semanticInferrer.infer(actorId, {
        recentConversationHistory: opts?.recentConversationHistory,
        recentActivity: activity,
      });
      return { activity, mental };
    } catch (err) {
      console.log(`[AwarenessCortex] semanticInferrer.infer 失败（降级 null）: ${err}`);
      return { activity, mental: null };
    }
  }

  /** 返回最近 N 条活动历史（默认 20） */
  recentActivity(actorId: string, limit = RECENT_HISTORY_LIMIT): UserActivityState[] {
    const list = this.history.get(actorId) ?? [];
    return [...list].slice(-limit);
  }

  /** 订阅活动变化，返回取消订阅函数 */
  onActivityChange(cb: ActivityChangeListener): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  // ---- 元认知置信度评估（Stage 4 Task 3）-------------------------------

  /**
   * 规则兜底置信度评估（仅 cognize LLM 失败降级时使用）。
   *
   * ⚠️ 此方法已退化为「兜底」角色：主路径由 cognize LLM 基于对话内容语义评判
   * confidence（见 brain-center.ts 阶段 2），仅在 cognize 抛异常或未注入认知引擎时
   * 才调用本方法。因此移除了原先的正则消息类型分类（CHAT_ONLY_RE/AMBIGUOUS_RE/
   * TOOL_REQUEST_RE）——那些正则无法理解对话语义，且主路径已不再依赖它。
   *
   * 兜底评分（基础 0.5，加减后 clamp 0-1）：
   *   - recall=0 → -0.15；1-2 → +0.1；3+ → +0.3
   *   - capability 无匹配 → -0.2；命中 → +0.3
   *   - 历史失败率 > 0.3 → -0.2
   */
  assessConfidence(
    query: string,
    recallResult: { items: unknown[] } | null,
    capabilities: unknown[],
  ): { score: number; reason: string } {
    const reasons: string[] = [];
    let score = 0.5;
    reasons.push("rule_fallback(base=0.5)");

    const itemCount = recallResult?.items?.length ?? 0;
    if (itemCount === 0) {
      score -= 0.15;
      reasons.push("recall=0(-0.15)");
    } else if (itemCount <= 2) {
      score += 0.1;
      reasons.push(`recall=${itemCount}(+0.1)`);
    } else {
      score += 0.3;
      reasons.push(`recall=${itemCount}(+0.3)`);
    }

    const matched = this.matchCapability(query, capabilities);
    if (matched) {
      score += 0.3;
      reasons.push(`capability_match=${matched}(+0.3)`);
    } else {
      score -= 0.2;
      reasons.push("capability_match=none(-0.2)");
    }

    const finalScore = Math.max(0, Math.min(1, score));
    return { score: finalScore, reason: reasons.join("; ") };
  }

  /**
   * 检查 query 是否命中任一 CapabilityDescriptor 的关键词。
   * 匹配字段：domain / label / description / tools 名（大小写不敏感，子串匹配）。
   * 返回首个命中的 domain；无命中返回 null。
   */
  private matchCapability(query: string, capabilities: unknown[]): string | null {
    if (typeof query !== "string" || query.length === 0) return null;
    const q = query.toLowerCase();
    for (const cap of capabilities ?? []) {
      if (!cap || typeof cap !== "object") continue;
      const c = cap as Record<string, unknown>;
      const domain = typeof c.domain === "string" ? c.domain : "";
      const label = typeof c.label === "string" ? c.label : "";
      const description = typeof c.description === "string" ? c.description : "";
      const tools = Array.isArray(c.tools)
        ? c.tools.filter((t) => typeof t === "string")
        : [];
      const candidates = [domain, label, description, ...tools]
        .filter((s) => s.length > 0)
        .map((s) => s.toLowerCase());
      for (const candidate of candidates) {
        if (candidate && q.includes(candidate)) {
          return domain || candidate;
        }
      }
    }
    return null;
  }

  // ---- 内部：信号处理 ---------------------------------------------------

  private handleSignal(signal: LifeSignal): void {
    const state = this.inferActivity(signal.actorId);
    if (!state) return;
    this.commitState(state, true);
  }

  /** 写入缓存与历史；activity 变化时通知订阅者 */
  private commitState(state: UserActivityState, notify: boolean): void {
    const prev = this.latest.get(state.actorId);
    this.latest.set(state.actorId, state);
    if (!prev || prev.activity !== state.activity) {
      this.appendHistory(state);
      // 动态睡眠窗口跟踪：记录进入/离开 sleeping 的时段
      this.trackSleepWindow(state.actorId, prev?.activity, state.activity);
      if (notify) this.notifyChange(state);
    }
  }

  /**
   * 跟踪用户的 sleeping 时段，用于动态学习个性化睡眠窗口。
   *
   * - 从其他状态进入 sleeping → 记录会话起点（已有挂起会话时不覆盖：重启恢复的
   *   会话要保留真实入睡时刻，否则样本起点漂移到重启点）
   * - 从 sleeping 切换到其他状态 → 关闭会话，写入样本。重启后 latest 状态表为空，
   *   首次提交 prev 为 undefined——此时只要磁盘恢复了挂起会话，同样视为
   *   「睡醒」关闭落账（否则重启前开始的夜晚永远等不到样本，学习链断供）
   * - 跨天会话按实际进入/离开时间记录（endHour 可小于 startHour，如 23.5→6.25）
   * - 不足 30 分钟的"短暂打盹"不记入样本（避免噪声）；超过单场上限的视为
   *   陈旧恢复残账，丢弃不记（runtime 跨多天宕机/测试残留）
   */
  private trackSleepWindow(
    actorId: string,
    prevActivity: UserActivityKind | undefined,
    nextActivity: UserActivityKind,
  ): void {
    const now = Date.now();
    const key = AwarenessCortex.sleepKey(actorId);
    if (nextActivity === "sleeping" && prevActivity !== "sleeping") {
      // 进入 sleeping：记录会话起点（保留已恢复的更早起点）
      if (!this.ongoingSleepSession.has(key)) {
        this.ongoingSleepSession.set(key, now);
        this.schedulePersist();
      }
      return;
    }
    if (nextActivity !== "sleeping" && (prevActivity === "sleeping" || (!prevActivity && this.ongoingSleepSession.has(key)))) {
      // 离开 sleeping：关闭会话，写入样本（含重启后 prev 缺失的首次提交）
      const startTs = this.ongoingSleepSession.get(key);
      this.ongoingSleepSession.delete(key);
      if (!startTs) return;
      const durationMs = now - startTs;
      // 不足 30 分钟不算睡眠样本（短暂打盹/误判）
      if (durationMs < SLEEP_INACTIVE_MS) return;
      // 超过单场上限（20h）：跨多天的陈旧残账（宕机/重启链/测试残留），丢弃
      if (durationMs > SLEEP_SESSION_MAX_MS) return;
      const startDate = new Date(startTs);
      const endDate = new Date(now);
      const dateStr = `${startDate.getFullYear()}-${String(startDate.getMonth() + 1).padStart(2, "0")}-${String(
        startDate.getDate(),
      ).padStart(2, "0")}`;
      const startHour = startDate.getHours() + startDate.getMinutes() / 60;
      const endHour = endDate.getHours() + endDate.getMinutes() / 60;
      const samples = this.sleepWindowSamples.get(key) ?? [];
      samples.push({ date: dateStr, startHour, endHour });
      // 只保留最近 SLEEP_WINDOW_SAMPLE_LIMIT 个样本
      if (samples.length > SLEEP_WINDOW_SAMPLE_LIMIT) {
        samples.splice(0, samples.length - SLEEP_WINDOW_SAMPLE_LIMIT);
      }
      this.sleepWindowSamples.set(key, samples);
      this.schedulePersist();
      console.log(
        `[AwarenessCortex] 睡眠样本记录：${dateStr} ${startHour.toFixed(1)}→${endHour.toFixed(1)}（${key}，共${samples.length}条）`,
      );
    }
  }

  /**
   * 获取学习到的个性化睡眠窗口（中位数）。
   *
   * - 样本不足（< SLEEP_WINDOW_MIN_SAMPLES）返回 null，调用方回退到默认 23-6
   * - 样本足够：取 startHour 和 endHour 的中位数
   * - 返回值：{ startHour: 23.5, endHour: 6.25, sampleCount: 5 }
   *
   * NightlyMemoryTaskService 通过此接口获取动态窗口，替换硬编码的 nightStartHour/nightEndHour
   */
  getLearnedSleepWindow(
    actorId: string,
  ): { startHour: number; endHour: number; sampleCount: number } | null {
    const samples = this.sleepWindowSamples.get(AwarenessCortex.sleepKey(actorId));
    if (!samples || samples.length < SLEEP_WINDOW_MIN_SAMPLES) return null;
    const startHours = samples.map((s) => s.startHour).sort((a, b) => a - b);
    const endHours = samples.map((s) => s.endHour).sort((a, b) => a - b);
    const median = (arr: number[]): number => {
      const mid = Math.floor(arr.length / 2);
      return arr.length % 2 === 0 ? (arr[mid - 1]! + arr[mid]!) / 2 : arr[mid]!;
    };
    return {
      startHour: median(startHours),
      endHour: median(endHours),
      sampleCount: samples.length,
    };
  }

  /**
   * 暴露最近若干个原始睡眠样本（按 dayKey 记录的入睡/醒来小时）。
   *
   * getLearnedSleepWindow 只返回中位数；LifeRhythmEngine 的睡眠模型器
   * 需要逐日样本才能算趋势与做同日去重，故新增此只读取样口。
   */
  getRecentSleepWindowSamples(
    actorId: string,
    limit = 14,
  ): Array<{ date: string; startHour: number; endHour: number }> {
    return [
      ...(this.sleepWindowSamples.get(AwarenessCortex.sleepKey(actorId)) ?? []),
    ].slice(-limit);
  }

  private appendHistory(state: UserActivityState): void {
    const list = this.history.get(state.actorId) ?? [];
    list.push(state);
    if (list.length > RECENT_HISTORY_LIMIT) {
      list.splice(0, list.length - RECENT_HISTORY_LIMIT);
    }
    this.history.set(state.actorId, list);
  }

  private notifyChange(state: UserActivityState): void {
    for (const cb of this.listeners) {
      void Promise.resolve(cb(state)).catch((err) => {
        console.error("[AwarenessCortex] onActivityChange listener failed:", err);
      });
    }
  }

  // ---- 推断规则（纯规则，无 LLM）---------------------------------------

  /**
   * 按优先级推断用户活动状态：
   * just_off_work > going_out > meeting > (in_focus | busy) > sleeping > idle > unknown
   *
   * - meeting：schedule-task-service 当前时间窗内有进行中的日历事件
   * - in_focus：工作时间持续 busy 超过 25 分钟且近 25 分钟无 speak 决策打断
   *
   * @returns 推断出的活动状态；actorId 为空时返回 null
   */
  inferActivity(actorId: string): UserActivityState | null {
    if (!actorId) return null;

    const now = new Date();
    const nowMs = now.getTime();
    const hour = now.getHours();
    const minute = now.getMinutes();
    const day = now.getDay(); // 0=周日, 6=周六
    const isWeekday = day >= 1 && day <= 5;
    const hourDecimal = hour + minute / 60;

    const signals = this.hub?.recentSignals(actorId, INFERENCE_SIGNAL_SCAN) ?? [];
    const recent24h = signals.filter((s) => {
      const t = Date.parse(s.occurredAt);
      return Number.isFinite(t) && nowMs - t <= TRAVEL_LOOKBACK_MS;
    });

    // ---- 1. just_off_work（刚下班）----
    if (isWeekday && hourDecimal >= 17.5 && hourDecimal <= 19.5) {
      const matched = recent24h.some((s) => this.signalMatches(s, OFF_WORK_PATTERN));
      if (matched) {
        return this.buildState(actorId, "just_off_work", 0.7, [
          "工作日 17:30-19:30 时间窗",
          "桌面 presence 信号含下班/解锁/切换关键词",
        ], now);
      }
    }

    // ---- 2. going_out（准备出行）----
    const travelSignal = recent24h.find((s) => this.signalMatches(s, TRAVEL_PATTERN));
    const hasTravelCandidate = this.anticipation
      ?.recentCandidates(actorId, 20)
      .some((c) => this.candidateIsTravel(c));
    if (travelSignal || hasTravelCandidate) {
      const evidence: string[] = [];
      let confidence = 0.6;
      const metadata: Record<string, unknown> = {};
      if (travelSignal) {
        evidence.push(`life signal 命中出行关键词: ${travelSignal.title}`);
        confidence = 0.7;
        this.extractTravelMetadata(travelSignal, metadata);
      }
      if (hasTravelCandidate) {
        evidence.push("anticipation engine 候选含 travel/outing 类");
        confidence = Math.min(0.8, confidence + 0.1);
      }
      return this.buildState(actorId, "going_out", confidence, evidence, now, metadata);
    }

    // ---- 3. meeting（会议中）----
    // 查询 schedule-task-service，当前时间 ±15 分钟窗口内有 active 日历事件即视为会议中。
    // 查询失败或服务未注册时降级（不阻塞后续推断）。
    if (this.scheduleTask) {
      try {
        const meetingTask = this.findActiveMeeting(actorId, nowMs);
        if (meetingTask) {
          return this.buildState(actorId, "meeting", 0.7, [
            "schedule-task-service 当前时间窗内有进行中的日历事件",
            `事件: ${meetingTask.title ?? meetingTask.kind}（runAt=${meetingTask.runAt}）`,
          ], now);
        }
      } catch {
        // 查询失败不影响后续推断
      }
    }

    // ---- 4. busy（忙碌）/ in_focus（深度专注）----
    const isWorkHour =
      (hourDecimal >= 9 && hourDecimal <= 12) ||
      (hourDecimal >= 14 && hourDecimal <= 18);
    if (isWorkHour) {
      const busySignal = signals.find((s) => this.signalMatches(s, WORK_APP_PATTERN));
      if (busySignal) {
        // in_focus 细化：持续 busy 超过 25 分钟且近 25 分钟无 speak 决策打断
        const inFocus = this.checkInFocus(actorId, signals, nowMs);
        if (inFocus.inFocus) {
          return this.buildState(actorId, "in_focus", 0.7, [
            "工作时间持续 busy 超过 25 分钟",
            "近 25 分钟无 speak 类决策打断",
            `最早 busy 信号: ${new Date(inFocus.earliestBusyMs).toISOString()}`,
            `桌面 presence 显示活跃工作应用: ${busySignal.title}`,
          ], now);
        }
        return this.buildState(actorId, "busy", 0.65, [
          "工作时间 9:00-12:00 / 14:00-18:00",
          `桌面 presence 显示活跃工作应用: ${busySignal.title}`,
        ], now);
      }
    }

    // ---- 5. sleeping（休息/睡眠）----
    if (hourDecimal >= 23 || hourDecimal <= 6) {
      const inactiveMs = this.inactiveMs(signals, nowMs);
      if (inactiveMs >= SLEEP_INACTIVE_MS) {
        return this.buildState(actorId, "sleeping", 0.8, [
          "夜间 23:00-次日 6:00",
          `桌面无活动超过 30 分钟（约 ${Math.round(inactiveMs / 60_000)} 分钟）`,
        ], now);
      }
    }

    // ---- 6. idle（空闲，默认回退）----
    const hasPresence = signals.some(
      (s) => s.source === "desktop" || s.kind.startsWith("desktop_"),
    );
    if (hasPresence) {
      return this.buildState(actorId, "idle", 0.5, [
        "桌面 presence 显示活动但非工作应用 / 非工作时间",
      ], now);
    }

    // ---- 7. unknown（所有信号都缺失）----
    return this.buildState(actorId, "unknown", 0.3, ["所有信号缺失"], now);
  }

  // ---- 辅助方法 ---------------------------------------------------------

  private buildState(
    actorId: string,
    activity: UserActivityKind,
    confidence: number,
    evidence: string[],
    now: Date,
    metadata?: Record<string, unknown>,
  ): UserActivityState {
    const state: UserActivityState = {
      actorId,
      activity,
      confidence,
      evidence,
      occurredAt: now.toISOString(),
    };
    if (metadata && Object.keys(metadata).length > 0) {
      state.metadata = metadata;
    }
    return state;
  }

  /** 判断单条 life signal 是否命中给定正则（扫描 title/summary/description/tags/kind） */
  private signalMatches(signal: LifeSignal, pattern: RegExp): boolean {
    const text = `${signal.title} ${signal.summary} ${signal.description ?? ""} ${signal.tags.join(" ")} ${signal.kind}`;
    return pattern.test(text);
  }

  /** 判断 anticipation 候选是否属于出行/外出类 */
  private candidateIsTravel(c: AnticipationCandidate): boolean {
    const text = `${c.title} ${c.rationale} ${c.suggestedAction} ${c.tags.join(" ")} ${c.category}`;
    return TRAVEL_CANDIDATE_PATTERN.test(text);
  }

  /** 从出行信号中提取 destination / time 元数据（如有） */
  private extractTravelMetadata(signal: LifeSignal, out: Record<string, unknown>): void {
    const md = signal.metadata;
    if (md && typeof md === "object") {
      if (typeof md.destination === "string") out.destination = md.destination;
      if (typeof md.time === "string") out.time = md.time;
    }
  }

  /** 计算距上一次桌面 presence 信号的毫秒数；无桌面信号返回 Infinity */
  private inactiveMs(signals: LifeSignal[], nowMs: number): number {
    const desktopSignals = signals.filter(
      (s) => s.source === "desktop" || s.kind.startsWith("desktop_"),
    );
    if (desktopSignals.length === 0) return Number.POSITIVE_INFINITY;
    let lastT = -Infinity;
    for (const s of desktopSignals) {
      const t = Date.parse(s.occurredAt);
      if (Number.isFinite(t) && t > lastT) lastT = t;
    }
    if (!Number.isFinite(lastT)) return Number.POSITIVE_INFINITY;
    return Math.max(0, nowMs - lastT);
  }

  /**
   * 查询 schedule-task-service，返回当前时间窗（±MEETING_WINDOW_MS）内的
   * 第一条 active 日历事件，无则返回 null。
   *
   * listTasksBySession 已过滤 cancelled，但可能仍含 completed（取 lastRunAt）。
   * 这里只识别尚未结束的 active 事件作为「进行中会议」。
   */
  private findActiveMeeting(actorId: string, nowMs: number): {
    title?: string;
    kind: string;
    runAt: string;
    nextRunAt: string | null;
  } | null {
    if (!this.scheduleTask) return null;
    const from = new Date(nowMs - MEETING_WINDOW_MS).toISOString();
    const to = new Date(nowMs + MEETING_WINDOW_MS).toISOString();
    const tasks = this.scheduleTask.listTasksBySession(actorId, { from, to });
    return tasks.find((t) => t.status === "active") ?? null;
  }

  /**
   * 检查 in_focus 条件：
   *  1. 找到 signals 中最早的「工作应用」信号（命中 WORK_APP_PATTERN）
   *  2. 该信号距今超过 IN_FOCUS_THRESHOLD_MS（25 分钟）
   *  3. 近 25 分钟内无 speak 类 recentDecisions（proaction 未注册或查询失败时视为无打断）
   *
   * 返回 { inFocus, earliestBusyMs }，earliestBusyMs 仅在 inFocus=true 时有意义。
   */
  private checkInFocus(
    actorId: string,
    signals: LifeSignal[],
    nowMs: number,
  ): { inFocus: boolean; earliestBusyMs: number } {
    let earliestBusyMs = Number.POSITIVE_INFINITY;
    for (const s of signals) {
      if (this.signalMatches(s, WORK_APP_PATTERN)) {
        const t = Date.parse(s.occurredAt);
        if (Number.isFinite(t) && t < earliestBusyMs) earliestBusyMs = t;
      }
    }
    if (!Number.isFinite(earliestBusyMs)) {
      return { inFocus: false, earliestBusyMs: 0 };
    }
    if (nowMs - earliestBusyMs < IN_FOCUS_THRESHOLD_MS) {
      return { inFocus: false, earliestBusyMs: 0 };
    }
    // 检查近 25 分钟内是否有 speak 类决策打断
    const cutoff = nowMs - IN_FOCUS_THRESHOLD_MS;
    const decisions = this.proaction?.recentDecisions(actorId) ?? [];
    const hasSpeak = decisions.some((d) => {
      if (d.outcome !== "speak") return false;
      const t = Date.parse(d.decidedAt);
      return Number.isFinite(t) && t >= cutoff;
    });
    if (hasSpeak) {
      return { inFocus: false, earliestBusyMs: 0 };
    }
    return { inFocus: true, earliestBusyMs };
  }
}
