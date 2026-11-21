// Agent Brain Center — BrainStem（脑干）
//
// 职责：自主节律调度。像脑干维持呼吸/心跳一样,维持 Agent 的持续感知节律。
// 不调 LLM,纯规则 + 定时器,产出合成 LifeSignal 回流 hub,触发 ProactionCortex 决策。
//
// 核心机制：
//  1. 心跳扫描（45s,unref 不阻塞进程退出）：遍历所有已知 actor,复查持续状态。
//  2. 持续状态检测（应当察觉但无显式外部信号的模式）：
//     - sustained_busy：用户持续忙碌超过 90 分钟（该提醒休息了）
//     - late_night_active：深夜仍在使用电脑
//  3. 趋势消费：读取 LifeSignalHub 的 evidenceWindow,当出现 turningPoints + 翻转时,
//     产出 trend_reversal 信号（如市场从 rising 翻转到 falling）。
//  4. 合成信号回流：以上检测命中时,以 source: "agent_inference" 发布回 hub,
//     由 LifeSignalHub 分发给 AwarenessCortex / ProactionCortex,形成"自己察觉"的闭环。
//  5. 重复抑制：同 actor 同 kind 合成信号在 30 分钟内不重复发布。
//
// 设计要点：
//  - 脑干不负责认知决策（皮层职责）,只负责"维持节律 + 察觉异常 + 回流信号"。
//  - busy 持续时间由脑干自己维护（busySince 映射）,不依赖 AwarenessCortex 的 occurredAt。
//  - 已知 actor 集合通过订阅 hub 自动累积,无需外部注册。

import type { LifeSignal, LifeSignalEvidenceWindow } from "../services/life-signal-types.js";
import type { BehaviorBaseline } from "../services/user-personalization/user-personalization-service.js";
import type {
  UserActivityKind,
  UserActivityState,
} from "./types.js";
import type { SequencePatternMiner, Pattern } from "../services/sequence-pattern-miner.js";
import { PredictiveActionSynthesizer } from "./predictive-action-synthesizer.js";

// ---- 子系统最小化接口 --------------------------------------------------

type LifeSignalSubscriber = (signal: LifeSignal) => Promise<void> | void;

/** LifeSignalHubService 的最小化结构接口（BrainStem 实际用到的方法） */
export interface BrainStemHubLike {
  subscribe(subscriber: LifeSignalSubscriber): () => void;
  recentSignals(actorId: string, limit?: number): LifeSignal[];
  getEvidenceWindow(actorId: string): LifeSignalEvidenceWindow;
  publish(signal: LifeSignal): void;
}

/** AwarenessCortex 的最小化结构接口（BrainStem 只需 observe 读当前活动状态） */
export interface BrainStemAwarenessLike {
  observe(actorId: string): UserActivityState | null;
}

/** UserPersonalizationService 的最小化结构接口（BrainStem 只需 getBehaviorBaseline 读行为基线） */
export interface BrainStemUserPersonalizationLike {
  getBehaviorBaseline(actorId: string): BehaviorBaseline;
}

/**
 * WorkingMemoryCortex 的最小化结构接口。
 * BrainStem 只需 decay(actorId) 来触发遗忘曲线。
 */
export interface BrainStemWorkingMemoryLike {
  decay(actorId: string): { decayed: number; forgotten: number };
}

/**
 * 记忆整理器最小化接口：白天 idle 时触发轻量记忆整理。
 * 仿人：人类发呆/午休时也会无意识整理近期记忆，不必等到深度睡眠。
 */
export interface BrainStemMemoryConsolidatorLike {
  tryIdleConsolidation(actorId: string): Promise<boolean>;
}

/** 行为预测结果：基于行为基线推断用户即将执行的动作 */
export type PredictedAction = {
  action: string;
  confidence: number;
  predictedTime: string;
};

// ---- 常量 --------------------------------------------------------------

/** 心跳扫描间隔（45 秒）—— idle 默认采样率。
 * 可通过 BRAIN_STEM_SWEEP_INTERVAL_MS 环境变量覆盖（毫秒，测试用）。
 * 运行时读取，便于真实场景观察测试加速。 */
function getSweepIntervalMs(): number {
  const env = process.env.BRAIN_STEM_SWEEP_INTERVAL_MS;
  const parsed = env != null ? parseInt(env, 10) : NaN;
  return Number.isFinite(parsed) && parsed >= 1000 ? parsed : 45_000;
}
const SWEEP_INTERVAL_MS = getSweepIntervalMs();
/** busy 状态下降采样间隔（90 秒）—— 用户忙碌时降低打扰 */
const BUSY_SAMPLE_MS = 90_000;
/** meeting / in_focus 状态采样间隔（120 秒）—— 会议/深度专注时适度降采样 */
const FOCUS_SAMPLE_MS = 120_000;
/** sleeping 状态深度降采样间隔（300 秒）—— 用户睡眠时大幅降低采样 */
const SLEEPING_SAMPLE_MS = 300_000;
/**
 * 持续 busy 阈值：超过该时长 → sustained_busy 信号。默认 90 分钟。
 * 可通过 BRAIN_STEM_SUSTAINED_BUSY_MS 环境变量覆盖（毫秒，测试用）。
 * 运行时读取，便于测试在 sweep 前动态调整。
 */
function getSustainedBusyMs(): number {
  const env = process.env.BRAIN_STEM_SUSTAINED_BUSY_MS;
  const parsed = env != null ? parseInt(env, 10) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 90 * 60_000;
}
/** 深夜活动判定：最近桌面信号在 10 分钟内 */
const LATE_NIGHT_RECENT_MS = 10 * 60_000;
/** 同 kind 合成信号重复抑制窗口（30 分钟） */
const SUPPRESS_SAME_KIND_MS = 30 * 60_000;
/** recentSignals 拉取条数 */
const SWEEP_SIGNAL_LIMIT = 50;

// ---- 注意力焦点（Step 4 扩展：事件驱动 + 注意力调度）---------------------

/**
 * 注意力焦点类型：根据当前任务调整感知采样率。
 * 替代纯定时器轮询，让 Agent 能像人一样根据当前任务调整感知焦点
 * （如等快递时频繁看手机，会议中减少打扰）。
 */
export type AttentionFocus =
  | "default"             // 默认：45s 采样
  | "waiting_delivery"     // 等快递：30s 采样（提高感知频率）
  | "waiting_message"      // 等消息：60s 采样
  | "in_meeting"           // 会议中：300s 采样（不打扰）
  | "in_focus_work"        // 深度工作：180s 采样
  | "waiting_payment"      // 等待付款确认：15s 采样（高频感知）
  | "idle_check";          // 空闲检查：90s 采样（降低感知频率）

/** 注意力焦点 → 采样间隔（ms） */
const ATTENTION_FOCUS_INTERVAL: Record<AttentionFocus, number> = {
  default: SWEEP_INTERVAL_MS,
  waiting_delivery: 30_000,
  waiting_message: 60_000,
  in_meeting: 300_000,
  in_focus_work: 180_000,
  waiting_payment: 15_000,
  idle_check: 90_000,
};

/**
 * 事件触发类型：异常事件触发即时扫描，不等下次心跳。
 * 替代纯 45s 心跳轮询，让 Agent 能像人一样被异常事件触发感知。
 */
export type BrainStemEventName =
  | "transaction_completed"        // 交易完成
  | "mood_shift"                   // 情绪突变
  | "desktop_app_focus_changed"    // 应用切换
  | "schedule_task_due"            // 日程到期
  | "user_idle_too_long"           // 用户长时间空闲
  | "user_back_from_away"          // 用户从离开状态回来
  | "external_trigger";            // 外部触发（如测试/手动）

type EventTriggerHandler = (actorId?: string) => void;

// ---- BrainStem ---------------------------------------------------------

/**
 * 脑干：自主节律调度层。
 *
 * 维持 Agent 的持续感知节律,不依赖外部信号触发——像脑干维持呼吸一样,
 * 周期性扫描用户状态与信号趋势,察觉"应当被发现但无显式信号"的模式,
 * 产出合成 LifeSignal 回流 hub,让 Agent 具备自发的持续感知能力。
 */
export class BrainStem {
  private hub: BrainStemHubLike | null = null;
  private awareness: BrainStemAwarenessLike | null = null;
  private userPersonalizationService: BrainStemUserPersonalizationLike | null = null;
  /** 工作记忆引用，用于定期 decay */
  private workingMemory: BrainStemWorkingMemoryLike | null = null;
  /** decay 调度计数器：每 5 次 sweepOnce（约 5×45s=3.75min）触发一次 decay */
  private decaySweepCounter = 0;
  /** decay 触发间隔（sweep 次数） */
  private static readonly DECAY_EVERY_N_SWEEPS = 5;
  /** decay 累计统计 */
  private decayStats = { triggered: 0, totalDecayed: 0, totalForgotten: 0 };
  /** 记忆整理器引用，白天 idle 时触发轻量整理 */
  private memoryConsolidator: BrainStemMemoryConsolidatorLike | null = null;
  /** 记忆整理调度计数器 */
  private idleMemSweepCounter = 0;
  /** 记忆整理触发间隔（sweep 次数，≈ 5 分钟） */
  private static readonly DMN_CHECK_EVERY_N_SWEEPS = 7;
  /** 记忆整理累计统计 */
  private idleMemStats = { triggered: 0, skipped: 0, failed: 0 };
  private unsubscribe: (() => void) | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;
  private started = false;
  /** 当前心跳采样间隔（ms）—— 由 adjustSampleRate 按用户活动状态动态调整 */
  private currentSampleInterval: number = SWEEP_INTERVAL_MS;

  /** 已知 actor 集合（通过订阅 hub 自动累积） */
  private readonly knownActors = new Set<string>();
  /** actor → busy 状态开始时间戳（ms）;非 busy 时清除 */
  private readonly busySince = new Map<string, number>();
  /** "actorId:kind" → 上次合成信号时间戳（ms）;用于重复抑制 */
  private readonly lastSyntheticAt = new Map<string, number>();
  /** "actorId:action" → 上次预测时间戳（ms）;用于预测信号按动作去重（30 分钟） */
  private readonly lastPredictionTime = new Map<string, number>();
  /** 统计：累计发出的合成信号数 */
  private syntheticEmitted = 0;
  /** 最近一次扫描时间 */
  private lastSweepAt: string | null = null;

  // Phase 3：序列模式挖掘 + 预测合成
  private sequencePatternMiner: SequencePatternMiner | null = null;
  private readonly predictiveSynthesizer = new PredictiveActionSynthesizer();
  /** actor → 上次序列预测时间戳（ms），用于重复抑制（30 分钟） */
  private readonly lastSequencePredictionTime = new Map<string, number>();
  /** actor → 上次模式挖掘时间戳（ms），10 分钟挖掘一次 */
  private readonly lastMiningTime = new Map<string, number>();
  /** actor → 缓存的挖掘结果 */
  private cachedPatterns = new Map<string, Pattern[]>();

  // ---- Step 4 扩展：事件驱动 + 注意力调度 ----

  /** actor → 当前注意力焦点（覆盖心跳间隔） */
  private readonly attentionFocus = new Map<string, AttentionFocus>();
  /** 事件名 → 处理器列表（事件驱动即时扫描） */
  private readonly eventHandlers = new Map<BrainStemEventName, EventTriggerHandler[]>();
  /** actor → 上次事件触发扫描时间戳（ms），用于事件去重（5s 内不重复触发） */
  private readonly lastEventTriggerAt = new Map<string, number>();
  /** 统计：事件触发扫描次数 */
  private eventTriggeredCount = 0;
  /** 统计：注意力焦点变更次数 */
  private attentionChangeCount = 0;

  /** 心跳回调列表：每次 sweepOnce 结束后调用，供外部子系统（如 ForgettingController）桥接 */
  private readonly heartbeatCallbacks: Array<() => void | Promise<void>> = [];

  // ---- 注册 ------------------------------------------------------------

  registerLifeSignalHub(hub: BrainStemHubLike): void {
    this.hub = hub;
    console.log("[BrainStem] 已注册 LifeSignalHub");
  }

  registerAwareness(a: BrainStemAwarenessLike): void {
    this.awareness = a;
    console.log("[BrainStem] 已注册 AwarenessCortex");
  }

  registerUserPersonalization(s: BrainStemUserPersonalizationLike): void {
    this.userPersonalizationService = s;
    console.log("[BrainStem] 已注册 UserPersonalizationService");
  }

  /**
   * 深度优化：注册 WorkingMemoryCortex，让脑干定期调度 decay()（遗忘曲线）。
   *
   * 工作记忆的遗忘机制（30min 降级 / 1h 遗忘）原本无人触发，
   * 由脑干每 5 分钟（5 × sweepOnce）调用 decay()，让工作记忆真正"会遗忘"。
   */
  registerWorkingMemory(wm: BrainStemWorkingMemoryLike): void {
    this.workingMemory = wm;
    console.log("[BrainStem] 已注册 WorkingMemoryCortex（每 5 次扫描触发 decay）");
  }

  /**
   * 注册记忆整理器：白天 idle 时触发轻量记忆整理。
   * 仿人：人类发呆/午休时也会无意识整理近期记忆，不必等到深度睡眠。
   * 与 DMN 同周期检查（每 7 次 sweepOnce ≈ 5 分钟，见 DMN_CHECK_EVERY_N_SWEEPS），仅在用户 idle 时触发。
   */
  registerMemoryConsolidator(consolidator: BrainStemMemoryConsolidatorLike): void {
    this.memoryConsolidator = consolidator;
    console.log("[BrainStem] 已注册 MemoryConsolidator（白天 idle 轻量整理）");
  }

  /**
   * 注册序列模式挖掘器（Phase 3.1）。
   *
   * 注册后 BrainStem 心跳扫描会：
   * 1. 每 10 分钟从 LifeSignalHub 历史挖掘序列模式（缓存）
   * 2. 当前事件流匹配模式前缀时，合成 predicted_action 信号
   * 3. 与现有 predictNextAction 预测源合并，去重后发布
   */
  registerSequencePatternMiner(miner: SequencePatternMiner): void {
    this.sequencePatternMiner = miner;
    console.log("[BrainStem] 已注册 SequencePatternMiner（序列模式预测）");
  }

  /**
   * 注册心跳回调：每次 sweepOnce 结束后调用。
   *
   * 供外部子系统桥接到脑干 45s 心跳节律，如：
   *   - ForgettingController.continuousScore → 连续打分 + 连接剪枝
   *
   * 回调异常不传播，不阻塞下次心跳。回调返回 Promise 时异步执行（不 await）。
   *
   * @param callback 心跳回调（无参，由回调自身决定要扫描哪些 actor）
   * @returns 取消注册函数
   */
  onHeartbeat(callback: () => void | Promise<void>): () => void {
    this.heartbeatCallbacks.push(callback);
    console.log(`[BrainStem] 已注册心跳回调（共 ${this.heartbeatCallbacks.length} 个）`);
    return () => {
      const idx = this.heartbeatCallbacks.indexOf(callback);
      if (idx >= 0) {
        this.heartbeatCallbacks.splice(idx, 1);
        console.log(`[BrainStem] 已取消心跳回调（剩余 ${this.heartbeatCallbacks.length} 个）`);
      }
    };
  }

  /**
   * 返回当前已知 actor 列表的快照（供心跳回调遍历使用）。
   *
   * 记忆认知架构升级（Phase 4）：ForgettingController.continuousScore 需要遍历所有 actor
   * 执行连续打分，但 knownActors 是私有集合。此方法返回数组副本，避免外部修改内部状态。
   */
  getKnownActors(): string[] {
    return Array.from(this.knownActors);
  }

  // ---- Step 4 扩展：事件驱动 + 注意力调度注册方法 ----------------------

  /**
   * 注册事件触发处理器（事件驱动感知）。
   * 异常事件触发时立即扫描对应 actor，不等 45s 心跳。
   *
   * 使用场景：
   *  - 交易完成 → 即时扫描（让 Agent 能及时察觉并主动反馈）
   *  - 情绪突变 → 即时扫描（让 Agent 能及时察觉用户情绪变化）
   *  - 应用切换 → 即时扫描（让 Agent 能及时察觉用户行为变化）
   *  - 日程到期 → 即时扫描（让 Agent 能及时提醒）
   *
   * @param eventName 事件名
   * @param handler 处理器（接收可选 actorId，触发即时扫描）
   */
  registerEventTrigger(eventName: BrainStemEventName, handler: EventTriggerHandler): void {
    const handlers = this.eventHandlers.get(eventName) ?? [];
    handlers.push(handler);
    this.eventHandlers.set(eventName, handlers);
    console.log(`[BrainStem] 已注册事件触发器: ${eventName}（共 ${handlers.length} 个处理器）`);
  }

  /**
   * 设置注意力焦点（覆盖心跳间隔）。
   * 替代纯 45s 心跳轮询，让 Agent 能像人一样根据当前任务调整感知频率。
   *
   * 使用场景：
   *  - 等快递 → waiting_delivery（30s 采样，频繁看手机）
   *  - 等消息 → waiting_message（60s 采样）
   *  - 会议中 → in_meeting（300s 采样，不打扰）
   *  - 深度工作 → in_focus_work（180s 采样）
   *  - 等付款确认 → waiting_payment（15s 采样，高频感知）
   *
   * 注意力焦点由 ProactionCortex 决策时设置（如检测到用户说"等快递"→设为 waiting_delivery）。
   *
   * @param actorId 用户 id
   * @param focus 注意力焦点（default 表示恢复默认）
   */
  setAttentionFocus(actorId: string, focus: AttentionFocus): void {
    const prev = this.attentionFocus.get(actorId) ?? "default";
    this.attentionFocus.set(actorId, focus);
    this.attentionChangeCount++;
    console.log(`[BrainStem] 注意力焦点变更 actorId=${actorId}: ${prev} → ${focus}`);

    // 立即重排心跳定时器（应用新注意力焦点对应的间隔）
    if (this.started) {
      this.adjustSampleRateByAttention(actorId, focus);
    }
  }

  /** 获取当前注意力焦点 */
  getAttentionFocus(actorId: string): AttentionFocus {
    return this.attentionFocus.get(actorId) ?? "default";
  }

  /**
   * 触发事件（外部调用）。
   * 事件触发时立即扫描对应 actor，不等下次心跳。
   * 5s 内同 actor 不重复触发（去重）。
   *
   * @param eventName 事件名
   * @param actorId 用户 id（可选，未指定时扫描所有已知 actor）
   */
  triggerEvent(eventName: BrainStemEventName, actorId?: string): void {
    const handlers = this.eventHandlers.get(eventName);
    if (!handlers || handlers.length === 0) return;

    // 事件去重：5s 内同 actor 不重复触发
    const now = Date.now();
    const dedupKey = actorId ?? "__global__";
    const lastAt = this.lastEventTriggerAt.get(dedupKey) ?? 0;
    if (now - lastAt < 5_000) {
      console.log(`[BrainStem] 事件 ${eventName} 5s 内已触发过，跳过 actorId=${actorId ?? "all"}`);
      return;
    }
    this.lastEventTriggerAt.set(dedupKey, now);

    // 调用所有注册的处理器
    for (const handler of handlers) {
      try {
        handler(actorId);
      } catch (err) {
        console.error(`[BrainStem] 事件处理器异常 ${eventName}:`, err);
      }
    }

    // 立即扫描对应 actor（不等下次心跳）
    if (actorId && this.knownActors.has(actorId)) {
      try {
        this.sweepActor(actorId);
        this.eventTriggeredCount++;
        console.log(`[BrainStem] 事件 ${eventName} 触发即时扫描 actorId=${actorId}`);
      } catch (err) {
        console.error(`[BrainStem] 事件触发扫描异常 ${eventName} actorId=${actorId}:`, err);
      }
    } else if (!actorId) {
      // 全局事件：扫描所有已知 actor
      for (const id of this.knownActors) {
        try {
          this.sweepActor(id);
        } catch (err) {
          console.error(`[BrainStem] 事件触发扫描异常 ${eventName} actorId=${id}:`, err);
        }
      }
      this.eventTriggeredCount++;
      console.log(`[BrainStem] 事件 ${eventName} 触发全局即时扫描`);
    }
  }

  /**
   * 根据注意力焦点调整心跳采样率。
   * 优先级：注意力焦点 > 用户活动状态 > 默认 45s。
   */
  private adjustSampleRateByAttention(actorId: string, focus: AttentionFocus): void {
    const newInterval = ATTENTION_FOCUS_INTERVAL[focus];
    if (newInterval === this.currentSampleInterval) return;
    const prev = this.currentSampleInterval;
    this.currentSampleInterval = newInterval;
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = setInterval(() => {
        void this.sweepOnce().catch((e) => {
          console.error("[BrainStem] sweep 异常:", e);
        });
      }, newInterval);
      this.sweepTimer.unref?.();
    }
    console.log(
      `[BrainStem] 注意力调整采样率 actorId=${actorId}: ${prev / 1000}s → ${newInterval / 1000}s (focus=${focus})`,
    );
  }

  // ---- 生命周期 --------------------------------------------------------

  async start(): Promise<void> {
    if (this.started) {
      console.log("[BrainStem] 已启动,跳过重复 start");
      return;
    }
    if (this.hub) {
      this.unsubscribe = this.hub.subscribe((signal) => {
        if (signal.actorId) this.knownActors.add(signal.actorId);
      });
      console.log("[BrainStem] 已订阅 LifeSignalHub（累积已知 actor）");
    } else {
      console.log("[BrainStem] LifeSignalHub 未注册,心跳仍运行但无已知 actor");
    }
    this.currentSampleInterval = SWEEP_INTERVAL_MS;
    this.sweepTimer = setInterval(() => {
      void this.sweepOnce().catch((e) => {
        console.error("[BrainStem] sweep 异常:", e);
      });
    }, this.currentSampleInterval);
    this.sweepTimer.unref?.();
    this.started = true;
    console.log("[BrainStem] 启动完成（心跳间隔 %ds）", this.currentSampleInterval / 1000);
  }

  async stop(): Promise<void> {
    if (!this.started) {
      console.log("[BrainStem] 未启动,跳过 stop");
      return;
    }
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.sweepTimer) {
      clearTimeout(this.sweepTimer);
      this.sweepTimer = null;
    }
    this.busySince.clear();
    // Step 4 扩展：清理事件驱动 + 注意力调度相关状态
    this.attentionFocus.clear();
    this.lastEventTriggerAt.clear();
    this.started = false;
    console.log("[BrainStem] 已停止");
  }

  /** Step 4 扩展：获取 BrainStem 统计（用于 snapshot） */
  getStats(): {
    syntheticEmitted: number;
    lastSweepAt: string | null;
    activeActors: number;
    eventTriggeredCount: number;
    attentionChangeCount: number;
    registeredEventTypes: BrainStemEventName[];
  } {
    return {
      syntheticEmitted: this.syntheticEmitted,
      lastSweepAt: this.lastSweepAt,
      activeActors: this.knownActors.size,
      eventTriggeredCount: this.eventTriggeredCount,
      attentionChangeCount: this.attentionChangeCount,
      registeredEventTypes: Array.from(this.eventHandlers.keys()),
    };
  }

  // ---- 心跳扫描 --------------------------------------------------------

  /** 立即触发一次全量扫描（测试/外部触发用） */
  async sweepOnce(): Promise<void> {
    this.lastSweepAt = new Date().toISOString();
    if (this.knownActors.size === 0) return;
    // 异步分片扫描：每个 actor 用 setImmediate 让出 event loop，
    // 避免 45s 心跳期间同步阻塞造成用户请求延迟尖峰（原同步 for 循环可能耗时 100-500ms）
    const actors = Array.from(this.knownActors);
    await new Promise<void>((resolve) => {
      const scheduleNext = (idx: number): void => {
        if (idx >= actors.length) {
          resolve();
          return;
        }
        const actorId = actors[idx];
        if (!actorId) {
          scheduleNext(idx + 1);
          return;
        }
        setImmediate(() => {
          try {
            this.sweepActor(actorId);
          } catch (e) {
            console.error(`[BrainStem] sweepActor ${actorId} 失败:`, e);
          }
          scheduleNext(idx + 1);
        });
      };
      scheduleNext(0);
    });
    // 感知预算：扫描结束后根据用户活动状态动态调整心跳采样率。
    this.observeAndAdjustSampleRate();

    // 深度优化：定期调度 WorkingMemoryCortex.decay()（遗忘曲线）
    // 每 N 次 sweep 触发一次，对所有 known actor 跑遗忘机制
    this.decaySweepCounter++;
    if (this.workingMemory && this.decaySweepCounter >= BrainStem.DECAY_EVERY_N_SWEEPS) {
      this.decaySweepCounter = 0;
      await new Promise<void>((resolve) => {
        const decayNext = (idx: number): void => {
          if (idx >= actors.length) {
            resolve();
            return;
          }
          const actorId = actors[idx];
          if (!actorId) {
            decayNext(idx + 1);
            return;
          }
          setImmediate(() => {
            try {
              const stats = this.workingMemory!.decay(actorId);
              this.decayStats.triggered++;
              this.decayStats.totalDecayed += stats.decayed;
              this.decayStats.totalForgotten += stats.forgotten;
              if (stats.decayed > 0 || stats.forgotten > 0) {
                console.log(
                  `[BrainStem] WorkingMemory decay actor=${actorId} decayed=${stats.decayed} forgotten=${stats.forgotten}`,
                );
              }
            } catch (e) {
              console.error(`[BrainStem] WorkingMemory decay ${actorId} 失败:`, e);
            }
            decayNext(idx + 1);
          });
        };
        decayNext(0);
      });
    }

    // 仿人记忆连续性：白天 idle 时触发轻量记忆整理
    // 与 DMN 同周期（每 7 次 sweep ≈ 5 分钟，见 DMN_CHECK_EVERY_N_SWEEPS），仅在用户 idle 且有待整理队列时触发
    // tryIdleConsolidation 内部检查队列是否为空，空则直接返回 false，不会空跑
    this.idleMemSweepCounter++;
    if (this.memoryConsolidator && this.idleMemSweepCounter >= BrainStem.DMN_CHECK_EVERY_N_SWEEPS) {
      this.idleMemSweepCounter = 0;
      for (const actorId of this.knownActors) {
        try {
          // 复用 awareness 判断用户是否 idle/sleeping
          const state = this.awareness?.observe(actorId);
          const isActive = state?.activity === "sleeping" || state?.activity === "idle";
          if (!isActive) continue;
          void this.memoryConsolidator.tryIdleConsolidation(actorId).then((triggered) => {
            if (triggered) {
              this.idleMemStats.triggered++;
              console.log(`[BrainStem] 白天 idle 记忆整理触发 actor=${actorId}`);
            } else {
              this.idleMemStats.skipped++;
            }
          }).catch((e) => {
            this.idleMemStats.failed++;
            console.error(`[BrainStem] idle 记忆整理 ${actorId} 失败:`, e);
          });
        } catch (e) {
          console.error(`[BrainStem] idle 记忆整理检查 ${actorId} 失败:`, e);
        }
      }
    }

    // 记忆认知架构升级（Phase 4）：心跳回调——供 ForgettingController.continuousScore 桥接
    // 每次 sweepOnce 结束后调用，回调异常不传播、不阻塞下次心跳。
    // 回调返回 Promise 时异步执行（fire-and-forget）。
    for (const cb of this.heartbeatCallbacks) {
      try {
        const ret = cb();
        if (ret && typeof (ret as Promise<void>).catch === "function") {
          void (ret as Promise<void>).catch((e) => {
            console.error("[BrainStem] 心跳回调异步失败:", e);
          });
        }
      } catch (e) {
        console.error("[BrainStem] 心跳回调异常:", e);
      }
    }
  }

  /** 获取 decay 统计 */
  getDecayStats(): { triggered: number; totalDecayed: number; totalForgotten: number } {
    return { ...this.decayStats };
  }

  /**
   * 扫描结束后观察用户活动状态并调整心跳采样率。
   * 优先级（Step 4 扩展）：注意力焦点 > 用户活动状态 > 默认 45s。
   * awareness 未注册或 observe 返回 null 时保持当前 interval 不变（降级安全）。
   * 与 sweepActor 内部的 awareness.observe 用法保持一致：遍历所有已知 actor。
   */
  private observeAndAdjustSampleRate(): void {
    // 优先级 1：注意力焦点（如等快递 → 30s 采样）
    let attentionActor: string | null = null;
    let attentionFocus: AttentionFocus | null = null;
    for (const actorId of this.knownActors) {
      const focus = this.attentionFocus.get(actorId);
      if (focus && focus !== "default") {
        attentionActor = actorId;
        attentionFocus = focus;
        break;
      }
    }
    if (attentionActor && attentionFocus) {
      this.adjustSampleRateByAttention(attentionActor, attentionFocus);
      return;
    }

    // 优先级 2：用户活动状态（原有逻辑）
    if (!this.awareness) return;
    // 多 actor 场景取最近一次非空状态作为采样率依据（典型场景下单 actor）。
    let latestState: UserActivityState | null = null;
    for (const actorId of this.knownActors) {
      try {
        const state = this.awareness.observe(actorId);
        if (state) latestState = state;
      } catch (e) {
        console.error(`[BrainStem] awareness.observe ${actorId} 失败:`, e);
      }
    }
    if (latestState) {
      this.adjustSampleRate(latestState.activity);
    }
  }

  /**
   * 根据用户活动状态调整心跳采样率（感知预算机制）。
   *  - busy → 90s（BUSY_SAMPLE_MS）：降采样,避免打扰
   *  - meeting / in_focus → 120s（FOCUS_SAMPLE_MS）：会议/深度专注时适度降采样
   *  - sleeping → 300s（SLEEPING_SAMPLE_MS）：深度降采样
   *  - idle / unknown / just_off_work / going_out → 45s（SWEEP_INTERVAL_MS）
   *
   * 状态对应间隔未变化时跳过重排,避免无谓的 clearInterval/setInterval。
   * 未启动或无 sweepTimer 时仅更新 currentSampleInterval,下次 start 生效。
   */
  adjustSampleRate(activityState: UserActivityKind): void {
    const newInterval =
      activityState === "busy" ? BUSY_SAMPLE_MS :
      activityState === "meeting" || activityState === "in_focus" ? FOCUS_SAMPLE_MS :
      activityState === "sleeping" ? SLEEPING_SAMPLE_MS :
      SWEEP_INTERVAL_MS;
    if (newInterval === this.currentSampleInterval) return;
    const prev = this.currentSampleInterval;
    this.currentSampleInterval = newInterval;
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = setInterval(() => {
        void this.sweepOnce().catch((e) => {
          console.error("[BrainStem] sweep 异常:", e);
        });
      }, newInterval);
      this.sweepTimer.unref?.();
    }
    console.log(
      "[BrainStem] 采样率调整: %ds -> %ds (activity=%s)",
      prev / 1000,
      newInterval / 1000,
      activityState,
    );
  }

  /** 单个 actor 的扫描：持续状态 + 深夜 + 趋势翻转 */
  private sweepActor(actorId: string): void {
    if (!this.hub) return;
    const now = Date.now();
    const signals = this.hub.recentSignals(actorId, SWEEP_SIGNAL_LIMIT);
    if (signals.length === 0) {
      this.busySince.delete(actorId);
      return;
    }

    // 1. 持续 busy 检测（自己维护 busy 开始时间,不依赖 awareness.occurredAt）
    const activity = this.awareness?.observe(actorId);
    if (activity?.activity === "busy") {
      if (!this.busySince.has(actorId)) {
        this.busySince.set(actorId, now);
      }
      const since = this.busySince.get(actorId);
      const sustainedBusyMs = getSustainedBusyMs();
      if (since !== undefined && now - since >= sustainedBusyMs) {
        const minutes = Math.round((now - since) / 60_000);
        this.emitSynthetic(actorId, {
          kind: "sustained_busy",
          title: "持续工作较久",
          summary: `用户已持续忙碌约 ${minutes} 分钟,该歇会儿了`,
          importance: "medium",
          tags: ["sustained_busy", "care", "break_reminder"],
          evidence: [`busy 状态持续 ${minutes} 分钟`, `阈值 ${sustainedBusyMs / 60_000} 分钟`],
        });
      }
    } else {
      this.busySince.delete(actorId);
    }

    // 2. 深夜活动检测（23:00-5:00 + 最近桌面信号在 10 分钟内）
    const hour = new Date().getHours();
    if (hour >= 23 || hour <= 5) {
      const recentDesktop = signals.filter(
        (s) => s.source === "desktop" || s.kind.startsWith("desktop_"),
      );
      if (recentDesktop.length > 0) {
        const lastT = Date.parse(recentDesktop[recentDesktop.length - 1].occurredAt);
        if (Number.isFinite(lastT) && now - lastT < LATE_NIGHT_RECENT_MS) {
          this.emitSynthetic(actorId, {
            kind: "late_night_active",
            title: "深夜仍在活动",
            summary: "用户深夜仍在使用电脑,留意休息",
            importance: "medium",
            tags: ["late_night", "care"],
            evidence: [`当前时段 ${hour}:00`, "最近桌面信号在 10 分钟内"],
          });
        }
      }
    }

    // 3. 趋势翻转检测（消费 evidenceWindow,这是 hub 已算出但未被消费的数据）
    try {
      const win = this.hub.getEvidenceWindow(actorId);
      if (win.turningPoints > 0 && win.reversalDirection) {
        this.emitSynthetic(actorId, {
          kind: `trend_reversal_${win.reversalDirection}`,
          title: "信号趋势翻转",
          summary: `检测到趋势翻转（${win.reversalDirection}）,转折点 ${win.turningPoints} 个`,
          importance: "high",
          tags: ["trend_reversal", win.reversalDirection],
          evidence: [
            `turningPoints=${win.turningPoints}`,
            `reversalDirection=${win.reversalDirection}`,
            `slopeScore=${win.slopeScore}`,
          ],
        });
      }
    } catch {
      // getEvidenceWindow 失败不阻塞扫描
    }

    // 4. 行为预测：基于行为基线预测用户下一步动作,命中则合成 predicted_action 信号回流。
    //    重复抑制由 predictNextAction（按 action 去重）+ emitSynthetic（按 kind 去重）共同保证。
    const prediction = this.predictNextAction(actorId);
    if (prediction) {
      const emitted = this.emitSynthetic(actorId, {
        kind: "predicted_action",
        title: "预测用户即将动作",
        summary: `预测：${prediction.action}（置信度 ${(prediction.confidence * 100).toFixed(0)}%），预计 ${prediction.predictedTime}`,
        importance: "medium",
        tags: ["predicted_action", "agent_inference"],
        evidence: [
          `action=${prediction.action}`,
          `confidence=${prediction.confidence.toFixed(2)}`,
          `predictedTime=${prediction.predictedTime}`,
        ],
        metadata: {
          action: prediction.action,
          confidence: prediction.confidence,
          predictedTime: prediction.predictedTime,
        },
      });
      if (!emitted) {
        // emitSynthetic 因 kind 级抑制未发布时,回退本次 predictNextAction 标记,允许下次重试。
        this.lastPredictionTime.delete(`${actorId}:${prediction.action}`);
      }
    }

    // Phase 3.2：基于序列模式的预测（补充 predictNextAction 未覆盖的场景）
    // 仅在 predictNextAction 未发布 predicted_action 信号时尝试序列预测，避免重复
    const sequencePrediction = this.predictBySequencePattern(actorId);
    if (sequencePrediction) {
      this.emitSynthetic(actorId, {
        kind: "predicted_action",
        title: "基于历史模式预测",
        summary: `模式预测：${sequencePrediction.action}（置信度 ${(sequencePrediction.confidence * 100).toFixed(0)}%），预计 ${sequencePrediction.predictedTime}`,
        importance: "low",
        tags: ["predicted_action", "agent_inference", "sequence_pattern"],
        evidence: [
          `action=${sequencePrediction.action}`,
          `confidence=${sequencePrediction.confidence.toFixed(2)}`,
          `predictedTime=${sequencePrediction.predictedTime}`,
          `source=sequence_pattern`,
        ],
        metadata: {
          action: sequencePrediction.action,
          confidence: sequencePrediction.confidence,
          predictedTime: sequencePrediction.predictedTime,
          source: "sequence_pattern",
        },
      });
    }
  }

  // ---- 合成信号回流 ----------------------------------------------------

  /**
   * 发布合成 LifeSignal 回流 hub。
   * 重复抑制：同 actor 同 kind 在 SUPPRESS_SAME_KIND_MS 内不重复发布。
   * 返回是否实际发布（未注册 hub 或被重复抑制时返回 false）。
   */
  private emitSynthetic(
    actorId: string,
    def: {
      kind: string;
      title: string;
      summary: string;
      importance: "low" | "medium" | "high" | "critical";
      tags: string[];
      evidence: string[];
      metadata?: Record<string, unknown>;
    },
  ): boolean {
    if (!this.hub) return false;
    const key = `${actorId}:${def.kind}`;
    const last = this.lastSyntheticAt.get(key);
    if (last !== undefined && Date.now() - last < SUPPRESS_SAME_KIND_MS) {
      return false; // 重复抑制
    }
    const signal: LifeSignal = {
      id: `brainstem:${actorId}:${def.kind}:${Date.now()}`,
      actorId,
      source: "agent_inference",
      kind: def.kind,
      title: def.title,
      summary: def.summary,
      tags: def.tags,
      importance: def.importance,
      evidence: def.evidence,
      metadata: def.metadata,
      occurredAt: new Date().toISOString(),
    };
    this.hub.publish(signal);
    this.lastSyntheticAt.set(key, Date.now());
    this.syntheticEmitted += 1;
    console.log(`[BrainStem] 合成信号回流: ${def.kind} -> ${actorId} (${def.title})`);
    return true;
  }

  // ---- 行为预测 --------------------------------------------------------

  /**
   * 基于行为基线预测用户下一步动作。
   *
   * 读取 UserPersonalizationService 的行为基线（activePeriods /
   * hourlyActivityProbability），在"预测窗口"（当前时间到未来 5 分钟）内
   * 查找高概率动作：
   *  - 当前小时最后 5 分钟（minute >= 55）且下一小时是某个活跃时段起点
   *    → 预测"进入活跃工作时段"，预测时间点为下一整点
   *  - 当前小时是某个活跃时段起点且 minute < 5
   *    → 预测"开始工作"，预测时间点为当前时间
   *
   * 重复抑制：同 actor 同 action 在 SUPPRESS_SAME_KIND_MS 内只预测一次
   * （通过 lastPredictionTime 维护，按动作去重）。
   * 数据不足（sampleCount < 7）时不预测，避免噪声。
   */
  private predictNextAction(actorId: string): PredictedAction | null {
    const baseline = this.userPersonalizationService?.getBehaviorBaseline(actorId);
    if (!baseline || baseline.sampleCount < 7) return null;
    const now = new Date();
    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();

    let action = "";
    let confidence = 0;
    let predictedTime = "";
    for (const period of baseline.activePeriods) {
      if (period.start === currentHour + 1 && currentMinute >= 55) {
        // 下一小时是活跃时段起点，当前 55+ 分钟 → 预测即将进入活跃时段
        const next = new Date(now);
        next.setHours(period.start, 0, 0, 0);
        action = "进入活跃工作时段";
        confidence = baseline.hourlyActivityProbability[period.start] ?? 0;
        predictedTime = next.toISOString();
        break;
      }
      if (period.start === currentHour && currentMinute < 5) {
        // 当前小时刚开始活跃时段（前 5 分钟）→ 预测开始工作
        action = "开始工作";
        confidence = baseline.hourlyActivityProbability[period.start] ?? 0;
        predictedTime = now.toISOString();
        break;
      }
    }
    if (!action) return null;

    // 重复抑制：同 actor 同 action 30 分钟内不重复预测
    const key = `${actorId}:${action}`;
    const last = this.lastPredictionTime.get(key);
    if (last !== undefined && Date.now() - last < SUPPRESS_SAME_KIND_MS) {
      return null;
    }
    this.lastPredictionTime.set(key, Date.now());

    return { action, confidence, predictedTime };
  }

  /**
   * Phase 3.2：基于序列模式的预测。
   *
   * 从 LifeSignalHub 历史挖掘序列模式（10 分钟缓存），
   * 若当前事件流匹配某模式前缀，合成预测。
   *
   * 重复抑制：同 actor 30 分钟内不重复预测（与 predictNextAction 独立）。
   */
  private predictBySequencePattern(actorId: string): PredictedAction | null {
    if (!this.sequencePatternMiner || !this.hub) return null;

    // 重复抑制：30 分钟内不重复
    const lastSeqPred = this.lastSequencePredictionTime.get(actorId);
    const suppressMs = 30 * 60 * 1000;
    if (lastSeqPred !== undefined && Date.now() - lastSeqPred < suppressMs) {
      return null;
    }

    // 10 分钟挖掘一次（缓存）
    const miningInterval = 10 * 60 * 1000;
    const lastMining = this.lastMiningTime.get(actorId);
    const now = Date.now();
    if (lastMining === undefined || now - lastMining > miningInterval) {
      try {
        const patterns = this.sequencePatternMiner.mine(actorId);
        this.cachedPatterns.set(actorId, patterns);
        this.lastMiningTime.set(actorId, now);
      } catch (err) {
        console.log(`[BrainStem] 序列模式挖掘失败 ${actorId}: ${err}`);
        return null;
      }
    }

    const patterns = this.cachedPatterns.get(actorId);
    if (!patterns || patterns.length === 0) return null;

    // 取最近 5 个信号作为当前事件流
    const recentSignals = this.hub.recentSignals(actorId, 5);
    if (recentSignals.length === 0) return null;

    const prediction = this.predictiveSynthesizer.predict(patterns, recentSignals);
    if (!prediction) return null;

    this.lastSequencePredictionTime.set(actorId, now);
    return prediction;
  }

  // ---- 快照 ------------------------------------------------------------

  /** 返回脑干状态快照（供 BrainCenter.snapshot 使用） */
  snapshot(): {
    lastSweepAt: string | null;
    syntheticSignalsEmitted: number;
    activeActors: number;
  } {
    return {
      lastSweepAt: this.lastSweepAt,
      syntheticSignalsEmitted: this.syntheticEmitted,
      activeActors: this.knownActors.size,
    };
  }
}
