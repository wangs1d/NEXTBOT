// ProactivityHub —— 主动性编排器（意图快路径 + 表达护栏）。
//
// 职责分工（2026-09-24 架构定稿）：
//  - 决策（何时、为何主动）：确定性规则——映射执行器（mapping-executor）读
//    世界状态板产出义务类事件；本模块承接各触发源的确定性意图（任务恭喜/
//    待办闭环/过劳干预/待办跟进），零 LLM。旧 LLM 通用路径（InitiativeEngine/
//    感知流/去抖评估）已整体拆除：token 账本实测纯烧钱零投递。
//  - 执行（三模式）：speak → 直达车道模板直投管道（或 LifeSignal 闭环兜底）；
//    act → 黑名单安全门 + 工具链执行（如过劳：放音乐+排休息提醒）。
//  - 护栏：FrequencyGovernor 频控（每日预算 + 分 kind 冷却 + 静默时段）、
//    负反馈抑制表、ask_first 挂起确认。
import type {
  ProactiveActStep,
  ProactiveBehaviorMode,
  ProactiveIntent,
} from "./proactivity-types.js";
import type { ArbitrationDecision, ProactiveProposal } from "./pipeline-types.js";
import { renderProactiveText } from "./voice-templates.js";
import { readJson, writeJson } from "./persist-file.js";
import { join } from "node:path";
import {
  deriveActValue,
  deriveRiskFromSteps,
  evaluateActionUtility,
  isUtilityEvalEnabled,
  type ActionUtilityBranch,
  type AuthorizationLevel,
} from "./action-utility.js";
import {
  CONFIRMATION_TTL_MS,
  PendingConfirmationStore,
  type PendingConfirmation,
} from "./pending-confirmation-store.js";
import { SilenceLog, type SilenceLogEntry, type SilenceSearchOptions } from "./silence-log.js";
import { FrequencyGovernor } from "./frequency-governor.js";
import {
  TemporalAdmissionGate,
  formatAdmissionEvidence,
  isTemporalAdmissionEnabled,
} from "./temporal-admission.js";
import {
  TurnAsideQueue,
  formatTurnAsidePrompt,
  isTurnAsideEnabled,
  isTurnAsideMediumEnabled,
} from "./turn-aside-queue.js";
import {
  buildConversationIntent,
} from "./triggers/conversation-triggers.js";
import {
  buildCelebrationIntent,
  buildLoopCompletedIntent,
} from "./triggers/celebration-trigger.js";
import { classifyToolRisk } from "../services/tool-risk.js";
import { semanticDedupKey } from "./dedup-key.js";
import type { InterestHit } from "./interest-watcher.js";
import {
  buildOverworkIntent,
  type OverworkRhythmPayload,
} from "./triggers/overwork-trigger.js";

/** 最小依赖接口（便于测试 mock 与模块解耦） */
export interface ProactivityHubDeps {
  /** 发布 LifeSignal（speak 模式入口，LifeSignalHubService.publish 的薄包装） */
  publishSignal: (signal: {
    actorId: string;
    kind: string;
    title: string;
    summary: string;
    importance: "low" | "medium" | "high" | "critical";
    tags: string[];
    evidence: string[];
    metadata?: Record<string, unknown>;
  }) => void;
  /** 执行工具（act 模式，ToolRegistry.execute 的薄包装） */
  executeTool: (
    tool: string,
    args: Record<string, unknown>,
    actorId: string,
  ) => Promise<{ ok: boolean; result: Record<string, unknown> }>;
  /**
   * 最近一次用户交互时间戳 ms；null=从未交互（不主动冷启动）。
   * 可选：未注入时 hub 用自身 observeConversationTurn 记录的时间兜底。
   */
  getLastInteractionAt?: (actorId: string) => number | null;
  /**
   * 用户自主性等级（AutonomySettingsStore.getLevel 的薄包装，缺省 1）：
   *   0 = 只建议（act 意图一律降级 speak，永不自动执行）
   *   1 = 标准（默认三分支语义）
   *   2 = 高效（可逆且不涉钱、不涉第三方的动作即使净效用未过阈也直接执行）
   */
  autonomyLevel?: (actorId: string) => number;
  /**
   * 持久化目录（可选）：noteInitiative 防重记忆落盘 hub-initiatives.json——
   * 重启后快车道/评估器/LLM 通用路径的跨栈去重不失效。
   */
  dataPath?: string;
  /**
   * 用户活跃事件回调（装配层可选接线：喂 body RhythmCore 做节律感知，
   * source 如 "conversation"）。fire-and-forget，不阻塞对话链路。
   */
  onUserActivity?: (actorId: string, source: string) => void;
  /**
   * 对话轮入板回调（装配层接线到 WorldBoard 会话层）：把对话原话（截断）
   * 整理进状态板——决策层不翻聊天原文，只看板上的会话层。
   */
  onConversationTurn?: (actorId: string, text: string) => void;
  /** 测试注入：自定义频控器（默认 new FrequencyGovernor()） */
  frequencyGovernor?: FrequencyGovernor;
  /**
   * 负反馈抑制表（Task 20 统一频控框架）：用户「别再提醒我这个」类负反馈的
   * 持久化抑制。注入后 hub 在频控判定前先查抑制（用户意愿优先于时间冷却）。
   */
  suppressionStore?: {
    isSuppressed: (
      actorId: string,
      kind: string,
      text?: string,
    ) => { suppressed: boolean; reason: string };
  };
  /**
   * 沉默日志（方案 B/C）：act 三分支判 silence 的留痕，与管道 silenced 共用
   * 同一实例（装配层注入）。未注入时 hub 内建内存态（测试/降级）。
   */
  silenceLog?: SilenceLog;
  /**
   * 挂起确认存储（ask_first）：装配层注入与管道共享的同一实例（落盘可重启恢复）。
   * 未注入时 hub 内建内存态。
   */
  pendingConfirmations?: PendingConfirmationStore;
  /**
   * 分级触达钩子（ReachRouter 装配）：ask_first 登记挂起确认后回调 —— 由装配层
   * 决定投递通道与升级（ Router 侧负责 chat/popup/voice 阶梯与 ack 归一）。
   */
  onPendingConfirmation?: (entry: PendingActionConfirmation) => void;
  /** 确认解析后回调（approved/executed 供触达记录同步闭合，ack 归一的一环） */
  onConfirmationResolved?: (
    entry: PendingActionConfirmation,
    approved: boolean,
    executed: boolean,
  ) => void;
  /**
   * 时效准入闸（2026-10-09）：话题级准入（年龄 + 相关性 + 静默 + 复活配额），
   * 插在负反馈抑制之后、FrequencyGovernor 之前。未注入时 hub 内建默认实例。
   */
  temporalAdmissionGate?: TemporalAdmissionGate;
  /**
   * 顺嘴搭车队列（2026-10-01 P1）：注入后 low 级 speak 不即时推送，挂起等
   * 用户下一轮对话织入回复末尾（agent-core 经 takeTurnAsideForTurn 取走）。
   * 队列拒绝（同 kind 挂起中/间隔不足）时回退原即时路径。
   */
  turnAsideQueue?: TurnAsideQueue;
  /**
   * 在场查询（2026-10-01 P0 死信闸）：缺省视为在线（保持既有测试行为）。
   * 注入后 emitSpeakSignal 在用户全设备离线时跳过——信号发了也无人接收，
   * 还会触发一次无谓的话术 LLM 调用（照发既烧钱又产生「已发送」假台账）。
   */
  presence?: { isOnline: (actorId: string) => boolean };
}

/** 兼容别名：ask_first 挂起的确认条目（hub 行动级 + 管道提案级） */
export type PendingActionConfirmation = PendingConfirmation;
export { CONFIRMATION_TTL_MS };

/**
 * act 模式危险工具黑名单（正则，工具名匹配即拒绝自动执行）。
 * 通用路径不再限定白名单——LLM 自主选工具，与对话中调工具同级安全；
 * 但删除/破坏/系统级操作永不自动执行（自动化只做好事，不做不可逆的事）。
 */
const ACT_TOOL_DENY_RE =
  /delete|remove|drop|format|wipe|uninstall|shutdown|reboot|restart|run_shell|run_automation|kill/i;
/** act 单次行动计划步数上限 */
const ACT_MAX_STEPS = 5;
/** 最近主动行为记忆条数（防重复） */
const RECENT_INITIATIVES_LIMIT = 8;
/** 直达车道开关（speak 经模板直投管道，绕过 ProactionCortex 预筛；默认开） */
function readDirectLaneEnabled(): boolean {
  return process.env.PROACTIVITY_DIRECT_LANE !== "0";
}

/**
 * 触发源 → 授权档（act 三分支的授权维度输入，确定性映射）：
 *   conversation = 用户原话触发（显式）；其余既有触发源由用户配置/长期偏好驱动
 *   （隐式）；initiative 是用户显式开启的 LLM 主动性（env 开关 = 授权可逆自选
 *   动作）；未知来源一律无授权（涉第三方必 ask_first）。
 */
const SOURCE_AUTHORIZATION: Record<string, AuthorizationLevel> = {
  conversation: "explicit",
  task: "implicit",
  rhythm: "implicit",
  profile: "implicit",
  time: "implicit",
  epitome: "implicit",
  interest_watch: "implicit",
  weather: "implicit",
  finance: "implicit",
  relationship: "implicit",
  health: "implicit",
  initiative: "implicit",
};

function authorizationForSource(source: string): AuthorizationLevel {
  return SOURCE_AUTHORIZATION[source] ?? "none";
}

/** 从 media.search 结果解析第一条曲目（兼容数组 / {tracks:[]} / {result:{tracks:[]}} 结构） */
export function parseFirstTrack(
  result: Record<string, unknown> | undefined,
): { trackId: string; trackName?: string; artist?: string; durationSec?: number } | null {
  if (!result) return null;
  let tracks: unknown = result.tracks ?? result.result;
  if (tracks && typeof tracks === "object" && !Array.isArray(tracks)) {
    tracks = (tracks as Record<string, unknown>).tracks ?? tracks;
  }
  if (!Array.isArray(tracks) || tracks.length === 0) return null;
  const first = tracks[0] as Record<string, unknown>;
  const id = first?.id ?? first?.trackId ?? first?.songId;
  if (id === undefined || id === null || id === "") return null;
  return {
    trackId: String(id),
    trackName: typeof first.name === "string" ? first.name : undefined,
    artist: typeof first.artist === "string" ? first.artist : undefined,
    durationSec: typeof first.durationSec === "number" ? first.durationSec : undefined,
  };
}

export class ProactivityHub {
  private readonly governor: FrequencyGovernor;
  /** 时效准入闸（话题年龄/相关性/静默/复活配额；见 temporal-admission.ts） */
  private readonly admissionGate: TemporalAdmissionGate;
  /** 沉默日志（act 三分支 silence 留痕；与管道共享实例由装配层注入） */
  private readonly silenceLog: SilenceLog;
  /** 挂起确认存储（ask_first；与管道共享实例由装配层注入，可落盘恢复） */
  private readonly confirmations: PendingConfirmationStore;
  /** 管道级确认回调（装配层在管道构造后接线：批准 → onProposalApproved + 回执） */
  private pipelineConfirmationResolver:
    | ((entry: PendingConfirmation, approved: boolean) => Promise<{ executed: boolean } | null> | { executed: boolean } | null)
    | null = null;
  /** act 审计：最近发起的自主工具执行（安全可查，最多保留近 N 条） */
  private readonly actAudit = new Map<string, Array<{ at: number; tool: string; args: Record<string, unknown> }>>();
  private readonly ACT_AUDIT_LIMIT = 20;
  /** 已见过的 actor（主动性只对交互过的用户生效，不冷启动打扰） */
  private readonly knownActors = new Set<string>();
  /** 最近一次对话交互时刻（observeConversationTurn 维护） */
  private readonly lastInteractionAt = new Map<string, number>();
  /**
   * 近期用户原话环形窗口（话题相关度判定用；最多保留最近 5 轮）。
   * 只用于"这件事跟用户现在聊的搭不搭"，不喂任何 LLM，也不替代 WorldBoard 会话层。
   */
  private readonly recentUserTexts = new Map<string, string[]>();
  private readonly RECENT_USER_TEXTS_LIMIT = 5;
  /** 最近已发起的主动行为（防重复同类主动） */
  private readonly recentInitiatives = new Map<string, string[]>();
  /** 防重记忆落盘路径（deps.dataPath 注入时启用） */
  private initiativesPath: string | null = null;
  /**
   * 直达车道：speak/advise 不再走 LifeSignal→ProactionCortex 预筛（该预筛对
   * 自造 kind 的 value 保底分天然误杀低/中重要度信号），而是模板渲染 directText
   * 直投统一管道——deliveryId / outcome 反馈 / 去重 / 离线挂起全部继承。
   * 装配层在管道创建后经 setDirectLane 注入。
   */
  private directLane: ((p: ProactiveProposal) => ArbitrationDecision | void) | null = null;
  private readonly directLaneEnabled = readDirectLaneEnabled();
  private hubSeq = 0;
  private started = false;

  constructor(private readonly deps: ProactivityHubDeps) {
    this.governor = deps.frequencyGovernor ?? new FrequencyGovernor();
    this.admissionGate = deps.temporalAdmissionGate ?? new TemporalAdmissionGate();
    this.silenceLog = deps.silenceLog ?? new SilenceLog();
    this.confirmations = deps.pendingConfirmations ?? new PendingConfirmationStore();
    // 防重记忆持久化（可选 dataPath）：重启后 noteInitiative 的记录不丢，
    // 快车道/直达车道/表达层的跨栈去重不再因重启失效
    if (deps.dataPath) {
      try {
        this.initiativesPath = join(deps.dataPath, "hub-initiatives.json");
        const raw = readJson<Record<string, string[]>>(this.initiativesPath, {});
        for (const [actorId, list] of Object.entries(raw)) {
          if (Array.isArray(list) && list.length > 0) this.recentInitiatives.set(actorId, list.slice(-RECENT_INITIATIVES_LIMIT));
        }
      } catch {
        /* 恢复失败按空记忆处理 */
      }
    }
  }

  /**
   * 接线管道级确认回调（装配层在管道构造后调用）：hub 的确认解析入口对
   * origin=pipeline 的条目委托本回调（批准 → 管道 onProposalApproved + 回执）。
   */
  setPipelineConfirmationResolver(
    fn: (entry: PendingConfirmation, approved: boolean) => Promise<{ executed: boolean } | null> | { executed: boolean } | null,
  ): void {
    this.pipelineConfirmationResolver = fn;
  }

  /**
   * 接线直达车道（装配层在管道构造后调用）：speak/advise 的零 LLM 快车道。
   * 提案带 directText 模板文案进统一管道——投递带 deliveryId、outcome 反馈、
   * 去重、离线挂起、静默择时全部继承管道既有语义。
   */
  setDirectLane(fn: (p: ProactiveProposal) => ArbitrationDecision | void): void {
    this.directLane = fn;
  }

  /** 直达车道是否启用（诊断展示） */
  isDirectLaneEnabled(): boolean {
    return this.directLaneEnabled && this.directLane !== null;
  }

  /**
   * 记录一次已表达的主动（评估器/直达车道投递成功后调用）：进入防重复记忆，
   * InitiativeEngine 的 prompt 会看到"最近已主动（勿重复）"——同一事件不再
   * 被模板与 LLM 各表达一次。
   */
  noteInitiative(actorId: string, kind: string, title: string): void {
    this.rememberInitiative(actorId, `${kind}: ${title}`);
  }

  /** 最近交互时刻（仲裁层 ContextSnapshot 输入；deps 兜底 + hub 自记） */
  lastInteractionAtOf(actorId: string): number | null {
    return this.deps.getLastInteractionAt?.(actorId) ?? this.lastInteractionAt.get(actorId) ?? null;
  }

  // ---- 已知 actor 持久化（重启恢复主动性资格：否则重启后 agent 永不主动） ----

  /** 恢复已知 actor 及其最近交互时刻（ProactivePipeline 从 data/proactivity/known-actors.json 调用） */
  restoreActors(entries: Array<{ actorId: string; lastInteractionAt: number }>): void {
    for (const e of entries) {
      this.knownActors.add(e.actorId);
      this.lastInteractionAt.set(e.actorId, e.lastInteractionAt);
    }
  }

  /** 导出已知 actor 状态（落盘用） */
  exportActors(): Array<{ actorId: string; lastInteractionAt: number }> {
    return [...this.lastInteractionAt].map(([actorId, lastInteractionAt]) => ({ actorId, lastInteractionAt }));
  }

  // ---- 生命周期 ----

  start(): void {
    if (this.started) return;
    this.started = true;
    console.log(`[ProactivityHub] 已启动（每日预算=${this.governor.getBudget()}，快路径+直达车道，零 LLM 决策）`);
  }

  stop(): void {
    this.started = false;
  }

  // ---- 对外入口（各模块薄接线点，全部 fire-and-forget 不阻塞调用方） ----

  /**
   * 对话轮实时采集（agent-core 每轮接线调用）。
   * 完全后台化：对话原话经回调整理进 WorldBoard 会话层（决策不翻聊天原文），
   * followup 强线索走零 LLM 规则判（下一事件循环解耦），不进对话 prompt。
   */
  observeConversationTurn(actorId: string, text: string): void {
    this.knownActors.add(actorId);
    this.lastInteractionAt.set(actorId, Date.now());
    // 话题窗口（相关度判定用）：最近 5 轮用户原话
    const ring = this.recentUserTexts.get(actorId) ?? [];
    ring.push(text);
    if (ring.length > this.RECENT_USER_TEXTS_LIMIT) ring.splice(0, ring.length - this.RECENT_USER_TEXTS_LIMIT);
    this.recentUserTexts.set(actorId, ring);
    // 会话层入板：程序截断整理，供映射规则/诊断读取（不喂任何 LLM）
    try {
      this.deps.onConversationTurn?.(actorId, text.slice(0, 120));
    } catch {
      /* 入板失败不影响对话链路 */
    }
    // 用户活跃事件 → 装配层可选消费（如喂 RhythmCore 做节律感知）
    this.noteUserActivity(actorId, "conversation");
    // 后台零 LLM 规则判：解耦到下一事件循环（fire-and-forget），不阻塞主回复、不进 prompt。
    setImmediate(() => {
      void this.runConversationRuleJudge(actorId, text).catch((err) => {
        console.log(`[ProactivityHub] 对话规则判断失败（忽略）: ${err}`);
      });
    });
  }

  /**
   * 用户活跃事件（装配层接线：桌面 presence / 设备变化等）。
   * 转发装配层回调（RhythmCore 喂数据）。
   */
  noteUserActivity(actorId: string, source: string): void {
    this.knownActors.add(actorId);
    try {
      this.deps.onUserActivity?.(actorId, source);
    } catch {
      /* 活动回调失败不影响主链路 */
    }
  }

  /** 复杂任务完成（agent-task-orchestrator task_completed 接线） */
  onAgentTaskCompleted(actorId: string, goal: string): void {
    this.knownActors.add(actorId);
    // 快路径：任务完成必恭喜（确定性场景，零 LLM）
    void this.route(buildCelebrationIntent(actorId, goal)).catch((err) => {
      console.log(`[ProactivityHub] 任务恭喜触发失败（忽略）: ${err}`);
    });
  }

  /** 用户待办闭环（session-epitome 完成检测接线） */
  onUserLoopCompleted(actorId: string, loopText: string): void {
    this.knownActors.add(actorId);
    // 快路径：待办闭环必恭喜（确定性场景，零 LLM）
    void this.route(buildLoopCompletedIntent(actorId, loopText)).catch((err) => {
      console.log(`[ProactivityHub] 待办闭环恭喜失败（忽略）: ${err}`);
    });
  }

  /** body 节律信号（body.rhythm.* 订阅接线） */
  onRhythmSignal(actorId: string, kind: string, payload?: unknown): void {
    this.knownActors.add(actorId);
    if (kind !== "body.rhythm.overwork_detected") return;
    const p = payload as OverworkRhythmPayload | undefined;
    // 快路径：过劳必干预（确定性场景，零 LLM，act+speak 复合）
    void this.route(buildOverworkIntent(actorId, p)).catch((err) => {
      console.log(`[ProactivityHub] 过劳干预失败（忽略）: ${err}`);
    });
  }

  /**
   * 用户兴趣话题热议推送（InterestWatcher 后台轮询命中接线）。
   * 例：用户长期关注「刘浩存」，热搜出现她的新动态 → 主动 tell。
   * 直达车道模板直投（零 LLM；PROACTIVITY_DIRECT_LANE=0 才回退 ProactionCortex
   * 闭环），频控由 FrequencyGovernor interest_alert 冷却（4h）+ 每日预算兜底；
   * 同兴趣指纹去重在 watcher 层已完成。
   */
  onInterestAlert(actorId: string, name: string, hit: InterestHit): void {
    this.knownActors.add(actorId);
    const hotNote = hit.hot ? `（热度${hit.hot}）` : "";
    void this.route({
      actorId,
      kind: "interest_alert",
      importance: "medium",
      title: `你关注的「${name}」有新动态`,
      summary:
        `用户长期关注「${name}」。刚才发现「${hit.platform}」热榜上有 TA 的动态：` +
        `${hit.title}${hotNote}${hit.url ? `（来源：${hit.url}）` : ""}。` +
        `像朋友想起对方一直在意的东西一样，用一两句自然提起即可，分享你的看法或轻问一句，别写成资讯播报。`,
      mode: "speak",
      source: "interest_watch",
      templateData: { name, excerpt: hit.title, summary: hit.title },
    }).catch((err) => {
      console.log(`[ProactivityHub] 兴趣热议推送失败（忽略）: ${err}`);
    });
  }

  /**
   * 外部场景接线：提交一条主动意图（C 端生活管家场景通用入口）。
   * 走与内部快路径完全相同的 route()（负反馈抑制 → 频控 → speak/act/advise），
   * fire-and-forget 不阻塞调用方。供消费管家（预算超支/月报）、人情关系
   * （重要日子）、健康关怀（节律提醒）、天气预警等外部服务接入。
   */
  submitIntent(intent: ProactiveIntent): void {
    this.knownActors.add(intent.actorId);
    void this.route(intent).catch((err) => {
      console.log(`[ProactivityHub] submitIntent 失败（忽略）kind=${intent.kind}: ${err}`);
    });
  }

  /** 用户的自主性等级（AutonomySettingsStore 薄依赖；未注入/异常按标准档 1 处理） */
  private levelOf(actorId: string): number {
    try {
      const v = this.deps.autonomyLevel?.(actorId);
      return typeof v === "number" && v >= 0 && v <= 2 ? v : 1;
    } catch {
      return 1;
    }
  }

  /** 记录已发起的主动行为（防 LLM 重复同类主动） */
  private rememberInitiative(actorId: string, line: string): void {
    const list = this.recentInitiatives.get(actorId) ?? [];
    list.push(line.slice(0, 120));
    if (list.length > RECENT_INITIATIVES_LIMIT) list.shift();
    this.recentInitiatives.set(actorId, list);
    // 写穿（低频调用；文件小）：跨栈防重记忆重启不丢
    if (this.initiativesPath) {
      const out: Record<string, string[]> = {};
      for (const [actor, l] of this.recentInitiatives) out[actor] = l;
      writeJson(this.initiativesPath, out);
    }
  }

  // ---- 内部实现 ----

  /**
   * 后台零 LLM 规则判：拿到对话内容后，用纯规则（关键词）判断是否有
   * 值得主动承接的线索（followup），命中则经频控后主动 speak。
   * 不调用 LLM、不进对话 prompt，模拟人类自发性（得到信息→判断→决定→触发）。
   */
  private async runConversationRuleJudge(actorId: string, text: string): Promise<void> {
    // buildConversationIntent 内部已做钩子粗筛（零 LLM），未命中返回 null。
    const intent = buildConversationIntent(actorId, text, "");
    if (intent) await this.route(intent);
  }

  /**
   * 时效准入判定（话题级）：插在负反馈抑制之后、频控之前。
   * 只在意图带了 `originAt` 且年龄越过在途窗口时从严；未打 originAt 的意图
   * （天气/邮件/账单/日程等即时事件）一律放行，既有行为不变。
   * 拦截时写沉默日志 scope=admission，支撑「你当时为什么没提这件事」的反问。
   */
  private admitIntent(intent: ProactiveIntent): { admitted: boolean; evidence?: string } {
    if (!isTemporalAdmissionEnabled()) return { admitted: true };
    const texts = this.recentUserTexts.get(intent.actorId) ?? [];
    const verdict = this.admissionGate.evaluate(intent, {
      currentUserText: texts.length > 0 ? texts[texts.length - 1] : undefined,
      recentUserTexts: texts,
      lastInteractionAt: this.lastInteractionAtOf(intent.actorId),
    });
    if (verdict.admitted) {
      // 复活旧话题（越窗）才留审计串；在途/新鲜事件不额外加噪
      return { admitted: true, evidence: verdict.revived ? formatAdmissionEvidence(verdict) : undefined };
    }
    console.log(
      `[ProactivityHub] 时效准入拦截 kind=${intent.kind} actor=${intent.actorId} reason=${verdict.reason}`,
    );
    this.silenceLog.record({
      at: Date.now(),
      actorId: intent.actorId,
      kind: intent.kind,
      title: `${intent.title}`.slice(0, 60),
      source: intent.source,
      scope: "admission",
      netUtility: 0,
      riskScore: 0,
      valueScore: 0,
      reason: verdict.reason,
    });
    return { admitted: false };
  }

  /** 快路径核心：意图 → 抑制 → 时效准入 → 频控 → 按行为模式分发 */
  private async route(intent: ProactiveIntent): Promise<void> {
    // 负反馈抑制检查（用户意愿优先于时间冷却）：kind 级或关键词级命中即放弃
    const suppression = this.deps.suppressionStore?.isSuppressed(
      intent.actorId,
      intent.kind,
      `${intent.title} ${intent.summary}`,
    );
    if (suppression?.suppressed) {
      console.log(
        `[ProactivityHub] 负反馈抑制拦截 kind=${intent.kind} actor=${intent.actorId} reason=${suppression.reason}`,
      );
      return;
    }
    // 时效准入（话题是否还该被主动提起）：年龄/相关性/静默/复活配额
    const admission = this.admitIntent(intent);
    if (!admission.admitted) return;
    const verdict = this.governor.canTrigger(intent.actorId, intent.kind, intent.importance);
    if (!verdict.allowed) {
      console.log(`[ProactivityHub] 频控拦截 kind=${intent.kind} actor=${intent.actorId} reason=${verdict.reason}`);
      return;
    }
    // 直达车道：计数移到管道投递时（verdict=delivered 才计，语义更准）；
    // 这里只做前置粗筛。旧车道保持原计数语义。
    if (!this.isDirectLaneEnabled()) {
      this.governor.record(intent.actorId, intent.kind);
    }
    this.rememberInitiative(intent.actorId, `${intent.kind}: ${intent.title}`);

    switch (intent.mode as ProactiveBehaviorMode) {
      case "speak":
      case "advise":
        // 顺嘴搭车（2026-10-01）：low 级 speak 先尝试挂起等下一轮对话织入；
        // 队列拒绝（同 kind 挂起中/间隔不足）或通道关闭时走原即时投递。
        if (this.tryDeferToTurnAside(intent)) break;
        if (this.isDirectLaneEnabled()) {
          this.submitDirectSpeak(intent, admission.evidence);
        } else {
          this.emitSpeakSignal(intent, admission.evidence);
        }
        break;
      case "act":
        // 三分支执行语义（方案 C）：效用评估 → 静默执行 / 先问 / 沉默
        await this.runActPlan({
          actorId: intent.actorId,
          kind: intent.kind,
          importance: intent.importance,
          steps: intent.actArgs ?? [],
          rationale: intent.title,
          messageHint: intent.summary,
          source: intent.source,
        });
        break;
    }
  }

  /**
   * 直达车道提交：intent → 零 LLM 模板渲染 directText → 统一管道提案。
   * 频控在管道仲裁层再查一次（socialCanTrigger），计数在真正 delivered 时发生。
   */
  private submitDirectSpeak(intent: ProactiveIntent, admissionEvidence?: string): void {
    if (!this.directLane) {
      // 车道未接线（管道未创建/测试环境）：回退旧路径
      this.emitSpeakSignal(intent, admissionEvidence);
      return;
    }
    const text = renderProactiveText(intent.kind, {
      dedupKey: `${intent.kind}:${intent.title}`.slice(0, 80),
      title: intent.title,
      ...(intent.templateData ?? {}),
    });
    const proposal: ProactiveProposal = {
      proposalId: `hub_${Date.now().toString(36)}_${(this.hubSeq++).toString(36)}`,
      actorId: intent.actorId,
      kind: intent.kind,
      tier: "social",
      importance: intent.importance,
      // 归一化去重键：同一件事换说法（LLM 文案/模板差异）不再绕过 24h 去重窗口
      dedupKey: `hub:${semanticDedupKey(intent.kind, intent.summary)}`,
      title: intent.title,
      summary: intent.summary,
      directText: text,
      evidence: [
        `source=${intent.source}`,
        "direct_lane",
        ...(admissionEvidence ? [admissionEvidence] : []),
      ],
      createdAt: Date.now(),
      source: `hub:${intent.source}`,
    };
    try {
      this.directLane(proposal);
      console.log(
        `[ProactivityHub] 直达车道提交 kind=${intent.kind} actor=${intent.actorId} text="${text.slice(0, 40)}"`,
      );
    } catch (err) {
      console.log(`[ProactivityHub] 直达车道提交失败（忽略）kind=${intent.kind}: ${err}`);
    }
  }

  /**
   * 顺嘴搭车拦截（仅 route() 的 speak/advise 主动开口分支使用）：low 级意图
   * 挂起等下一轮对话织入回复末尾；medium 级在扩面开关开启时同样挂起
   * （2026-10-01 扩面：中优消息「先搭车、6h 没搭上再自己弹」，砍打扰不砍
   * 主动性——medium 过期由队列 onExpire 升级回正常通道，不会静默丢）。
   * 接受=true 时调用方跳过即时投递；拒绝（同 kind 挂起中/间隔不足/通道关闭）
   * 返回 false 走原路径——不静默吞消息。
   *
   * 边界：只拦「主动开口」（location_arrival/节律关怀等可延迟的轻提醒）；
   * speakFeedback 的行为反馈（act 结果/确认请求）有时效，一律即时，不走此路；
   * turn_aside_expiry 来源（过期升级重投）不得再进搭车队列（防无限回环）。
   */
  private tryDeferToTurnAside(intent: ProactiveIntent): boolean {
    if (intent.source === "turn_aside_expiry") return false;
    if (!isTurnAsideEnabled()) return false;
    if (intent.importance === "medium" ? !isTurnAsideMediumEnabled() : intent.importance !== "low") {
      return false;
    }
    if (!this.deps.turnAsideQueue?.tryEnqueue(intent)) return false;
    this.silenceLog.record({
      at: Date.now(),
      actorId: intent.actorId,
      kind: intent.kind,
      title: intent.title.slice(0, 60),
      source: intent.source,
      scope: "turn_aside",
      netUtility: 0,
      riskScore: 0,
      valueScore: 0,
      reason: "deferred_to_next_turn",
    });
    console.log(
      `[ProactivityHub] 顺嘴挂起（等下一轮对话织入）kind=${intent.kind} actor=${intent.actorId}`,
    );
    return true;
  }

  /**
   * 行为反馈型 speak（act 执行结果/确认请求）的统一出口：
   * 直达车道开启时走模板直投管道（带 deliveryId/outcome 闭环），否则回退
   * LifeSignal 路径。与 route() 的 speak/advise 分发逻辑保持一致。
   * （不走顺嘴搭车：行为反馈有时效，挂起隔轮织入会丢语义。）
   */
  private speakFeedback(intent: ProactiveIntent): void {
    if (this.isDirectLaneEnabled()) {
      this.submitDirectSpeak(intent);
    } else {
      this.emitSpeakSignal(intent);
    }
  }

  /**
   * 顺嘴搭车取货口（agent-core 每轮对话面调用，经 prompt builder 注入
   * 【顺嘴机会】块）。每轮至多一条；取走即交付，频控/TTL 在队列内。
   */
  takeTurnAsideForTurn(actorId: string): string | null {
    if (!this.deps.turnAsideQueue || !isTurnAsideEnabled()) return null;
    const item = this.deps.turnAsideQueue.takeForTurn(actorId);
    if (!item) return null;
    console.log(
      `[ProactivityHub] 顺嘴织入本轮 kind=${item.kind} actor=${actorId}`,
    );
    return formatTurnAsidePrompt(item);
  }

  /**
   * speak 模式：发布 LifeSignal → 现有 ProactionCortex 闭环接管
   */
  private emitSpeakSignal(intent: ProactiveIntent & { direct?: boolean }, admissionEvidence?: string): void {
    // 死信闸（2026-10-01 P0）：全设备离线时信号必然无人接收——跳过，
    // 省一次下游话术 LLM 调用，也不再产生「已发送」假台账。
    // （low 级已被搭车队列在 route() 拦截，到这里的多为 medium+，挂起重试
    // 语义由统一管道承担；本路径（无直达车道回退）直接放弃并留痕。）
    if (this.deps.presence && !this.deps.presence.isOnline(intent.actorId)) {
      console.log(
        `[ProactivityHub] 死信丢弃（全设备离线）kind=${intent.kind} actor=${intent.actorId}`,
      );
      return;
    }
    try {
      this.deps.publishSignal({
        actorId: intent.actorId,
        kind: intent.kind,
        title: intent.title,
        summary: intent.summary,
        importance: intent.importance,
        tags: [intent.kind, "proactivity"],
        evidence: [
          `source=${intent.source}`,
          intent.summary.slice(0, 96),
          ...(admissionEvidence ? [admissionEvidence] : []),
        ],
        metadata: {
          source: intent.source,
          proactivityKind: intent.kind,
          ...(intent.direct ? { direct: true } : {}),
        },
      });
      console.log(
        `[ProactivityHub] speak 信号已发布 kind=${intent.kind} importance=${intent.importance} actor=${intent.actorId}`,
      );
    } catch (err) {
      console.log(`[ProactivityHub] speak 信号发布失败（忽略）: ${err}`);
    }
  }

  // ─── 方案 C：三分支执行语义（execute_silently / ask_first / silence）───

  /**
   * 行动计划统一入口：先过 Action Utility 评估（零 LLM 确定性规则）再执行。
   *   execute_silently —— 可逆 + 已授权 + 高净效用：直接执行不通知（act 审计留痕）
   *   ask_first        —— 不可逆 / 高金融 / 无授权涉第三方：挂起计划，发确认请求等用户回复
   *   silence          —— 净效用为负：什么都不做，但记入沉默日志（可反问追溯）
   * PROACTIVITY_UTILITY_EVAL=0 时整体回退升级前行为：直接执行 + speak 告知。
   */
  private async runActPlan(input: {
    actorId: string;
    kind: string;
    importance: "high" | "medium" | "low";
    steps: Array<{ tool: string; args: Record<string, unknown> }>;
    rationale: string;
    messageHint: string;
    source: string;
  }): Promise<ActionUtilityBranch> {
    if (input.steps.length === 0) return "silence"; // 空计划无可执行内容

    // 自主性等级 0（只建议）：不执行、不确认，降级为 speak 说明原计划。
    // （等级语义见 AutonomySettingsStore；用户显式关掉自动执行，必须全链路生效）
    if (this.levelOf(input.actorId) === 0) {
      this.silenceLog.record({
        at: Date.now(),
        actorId: input.actorId,
        kind: input.kind,
        title: input.rationale.slice(0, 60),
        source: input.source,
        scope: "action",
        netUtility: 0,
        riskScore: 0,
        valueScore: 0,
        reason: "autonomy_level_0_advice_only",
      });
      this.speakFeedback({
        actorId: input.actorId,
        kind: input.kind,
        importance: input.importance,
        title: `建议你处理：${input.rationale.slice(0, 40)}`,
        summary: `按你的设置我只提醒不动手。计划是：${input.steps.map((s) => s.tool).join(" → ")}。${input.messageHint} 需要我执行的话，把自主性调高一档或直接让我做。`,
        mode: "speak",
        source: input.source,
      } as ProactiveIntent);
      return "silence";
    }

    // 回退开关：跳过效用评估，恢复「直接执行 + 事后告知」的升级前语义
    if (!isUtilityEvalEnabled()) {
      await this.executeActs(input.actorId, input.steps);
      this.speakFeedback({
        actorId: input.actorId,
        kind: input.kind,
        importance: input.importance,
        title: `我刚才顺手做了点事：${input.rationale.slice(0, 40)}`,
        summary: `行动计划：${input.steps.map((s) => s.tool).join(" → ")}。${input.messageHint}`,
        mode: "speak",
        source: input.source,
      } as ProactiveIntent);
      return "execute_silently";
    }

    const result = evaluateActionUtility({
      kind: input.kind,
      title: input.rationale,
      risk: deriveRiskFromSteps(input.steps),
      authorization: authorizationForSource(input.source),
      value: deriveActValue(input.importance),
    });

    // 自主性等级 2（高效）：可逆 + 不涉钱 + 不涉第三方的 ask_first 直接执行，
    // 只有金额/不可逆/第三方影响保留"先问"（用户花钱买省心，不买风险）
    if (
      result.branch === "ask_first" &&
      this.levelOf(input.actorId) === 2
    ) {
      const risk = deriveRiskFromSteps(input.steps);
      if (risk.reversible && risk.financialImpact === "none" && !risk.thirdPartyImpact) {
        await this.executeActs(input.actorId, input.steps);
        this.speakFeedback({
          actorId: input.actorId,
          kind: input.kind,
          importance: input.importance,
          title: `我顺手做了点事：${input.rationale.slice(0, 40)}`,
          summary: `已办好：${input.steps.map((s) => s.tool).join(" → ")}。${input.messageHint}`,
          mode: "speak",
          source: input.source,
        } as ProactiveIntent);
        return "execute_silently";
      }
    }

    if (result.branch === "execute_silently") {
      await this.executeActs(input.actorId, input.steps);
      console.log(
        `[ProactivityHub] act 静默执行 kind=${input.kind} tools=${input.steps.map((s) => s.tool).join(",")} netUtility=${result.netUtility}`,
      );
      // 做完轻提一句（与 InitiativeEngine「act=做完轻提一句」的约定一致）：
      // 完全无声的执行会让用户对 agent 的后台行为失去心智模型。原重要度保留
      // （频控/静默时段仍按原档把关），文案是低打扰的顺嘴一提。
      this.speakFeedback({
        actorId: input.actorId,
        kind: input.kind,
        importance: input.importance,
        title: `我顺手做了点事：${input.rationale.slice(0, 40)}`,
        summary: `已悄悄办好：${input.steps.map((s) => s.tool).join(" → ")}。${input.messageHint}`,
        mode: "speak",
        source: input.source,
      } as ProactiveIntent);
      return result.branch;
    }
    if (result.branch === "ask_first") {
      const planSummary = input.steps.map((s) => s.tool).join(" → ");
      const pending = this.confirmations.register({
        actorId: input.actorId,
        kind: input.kind,
        steps: input.steps,
        rationale: input.rationale,
        createdAt: Date.now(),
        expiresAt: Date.now() + CONFIRMATION_TTL_MS,
        origin: "hub",
      });
      // 暂停执行，确认请求即本次主动消息；回复「可以」走 resolveConfirmation 推进
      this.deps.onPendingConfirmation?.(pending);
      this.speakFeedback({
        actorId: input.actorId,
        kind: input.kind,
        importance: input.importance,
        title: `需要确认：${input.rationale.slice(0, 40)}`,
        summary:
          `我准备执行：${planSummary}。${input.messageHint} ` +
          `${result.reason.startsWith("unauthorized_third_party") ? "这件事会影响第三方，" : ""}可以吗？`,
        mode: "speak",
        source: input.source,
      } as ProactiveIntent);
      console.log(
        `[ProactivityHub] act 待确认（ask_first）kind=${input.kind} confirmId=${pending.confirmId} reason=${result.reason}`,
      );
      return result.branch;
    }
    // silence：什么都不做但记录决策（方案 B 沉默日志，支持反问追溯）
    this.silenceLog.record({
      at: Date.now(),
      actorId: input.actorId,
      kind: input.kind,
      title: input.rationale.slice(0, 60),
      source: input.source,
      scope: "action",
      netUtility: result.netUtility,
      riskScore: result.riskScore,
      valueScore: result.valueScore,
      reason: result.reason,
    });
    console.log(
      `[ProactivityHub] act 沉默 kind=${input.kind} netUtility=${result.netUtility} reason=${result.reason}`,
    );
    return result.branch;
  }

  /** 待确认条目列表（hub 行动级 + 管道提案级；对话工具/诊断接口读取，过期自动剔除） */
  listPendingConfirmations(actorId: string): PendingActionConfirmation[] {
    return this.confirmations.list(actorId);
  }

  /**
   * 用户回复推进挂起的确认：approved=true 执行计划；false/超时作废。
   * confirmId 省略时取该 actor 最新一条（语音回复「可以」的单活跃假设）。
   *   origin=hub      → 执行工具步骤（黑名单安全门兜底）+ 结果 speak 反馈
   *   origin=pipeline → 委托 setPipelineConfirmationResolver 注入的管道回调
   */
  async resolveConfirmation(
    actorId: string,
    approved: boolean,
    confirmId?: string,
  ): Promise<{
    ok: boolean;
    executed: boolean;
    confirmId?: string;
    error?: string;
    /** 多条挂起待确认时的消歧列表（error=multiple_pending 时有值；让 LLM 反问用户批哪条） */
    pending?: Array<{ confirmId: string; rationale: string }>;
  }> {
    this.confirmations.pruneExpired();
    let entry: PendingConfirmation | undefined;
    if (confirmId) {
      const found = this.confirmations.get(confirmId);
      if (found && found.actorId === actorId) entry = found;
    } else {
      const mine = this.confirmations.list(actorId);
      if (mine.length > 1) {
        // 防误批：省略 confirmId 且有多条挂起时不再"默认批最新"——语音里随口一句
        // 「可以」可能批掉不相干的计划。返回消歧列表，由对话反问用户批哪条。
        return {
          ok: false,
          executed: false,
          error: "multiple_pending",
          pending: mine.map((c) => ({ confirmId: c.confirmId, rationale: c.rationale.slice(0, 60) })),
        };
      }
      entry = mine[mine.length - 1];
    }
    if (!entry) return { ok: false, executed: false, error: "没有待确认的行动计划" };
    this.confirmations.take(entry.confirmId);

    if (!approved) {
      this.deps.onConfirmationResolved?.(entry, false, false);
      return { ok: true, executed: false, confirmId: entry.confirmId };
    }

    if (entry.origin === "pipeline") {
      const result = await this.pipelineConfirmationResolver?.(entry, true);
      this.deps.onConfirmationResolved?.(entry, true, result?.executed ?? false);
      return { ok: true, executed: result?.executed ?? false, confirmId: entry.confirmId };
    }

    const results = await this.executeActs(actorId, entry.steps);
    this.emitConfirmationFeedback(actorId, entry, results);
    this.deps.onConfirmationResolved?.(entry, true, results.some((r) => r.ok));
    return { ok: true, executed: results.some((r) => r.ok), confirmId: entry.confirmId };
  }

  /** 确认后的执行结果反馈（用户显式参与过的动作必须闭环告知；静默分支不受影响） */
  private emitConfirmationFeedback(
    actorId: string,
    entry: PendingConfirmation,
    results: Array<{ tool: string; ok: boolean }>,
  ): void {
    const tools = entry.steps.map((s) => s.tool).join(" → ");
    const okCount = results.filter((r) => r.ok).length;
    let summary: string;
    if (results.length === 0 || okCount === 0) {
      summary = `你确认的操作（${tools}）未能执行：安全策略拦截或执行失败。`;
    } else if (okCount < results.length) {
      summary = `已按你的确认部分完成（${okCount}/${results.length}）：${tools}。失败部分我不再自动重试。`;
    } else {
      summary = `已按你的确认完成：${tools}。`;
    }
    this.speakFeedback({
      actorId,
      kind: entry.kind,
      importance: okCount === results.length ? "low" : "medium",
      title: okCount === 0 ? "确认的操作未执行" : "确认的操作已完成",
      summary,
      mode: "speak",
      source: "task",
    } as ProactiveIntent);
  }

  /** 沉默决策检索（「你上周为什么没提醒我 XX」反问链路） */
  searchSilences(opts: SilenceSearchOptions): SilenceLogEntry[] {
    return this.silenceLog.search(opts);
  }

  /**
   * act 模式：按序静默执行工具（黑名单安全门 + 步数上限，失败仅日志不抛出）。
   * 通用路径与快路径共用；LLM 自主选的工具只要不踩黑名单即可执行。
   * 返回每个已尝试步骤的结果（确认闭环据此向用户反馈；blocked=安全门拦截）。
   */
  private async executeActs(
    actorId: string,
    steps: Array<{ tool: string; args: Record<string, unknown> }>,
  ): Promise<Array<{ tool: string; ok: boolean; blocked?: boolean }>> {
    const results: Array<Record<string, unknown>> = [];
    const outcomes: Array<{ tool: string; ok: boolean; blocked?: boolean }> = [];
    for (const step of steps.slice(0, ACT_MAX_STEPS)) {
      if (ACT_TOOL_DENY_RE.test(step.tool) || classifyToolRisk(step.tool) === "irreversible") {
        console.log(`[ProactivityHub] act 步骤被安全门拦截（危险操作）: ${step.tool}`);
        outcomes.push({ tool: step.tool, ok: false, blocked: true });
        continue;
      }
      const args = this.resolveStepArgs(step as ProactiveActStep, results);
      try {
        const ret = await this.deps.executeTool(step.tool, args, actorId);
        results.push(ret?.result ?? {});
        outcomes.push({ tool: step.tool, ok: ret?.ok === true });
        console.log(
          `[ProactivityHub] act 执行 ${ret?.ok ? "成功" : "失败"} tool=${step.tool} actor=${actorId}`,
        );
        // act 审计：记录自主执行（时间/工具/参数），供安全复盘；仅内存保留近 N 条
        this.recordActAudit(actorId, step.tool, args);
        if (!ret?.ok) break; // 前置步骤失败则中断链（如 search 失败不硬播）
      } catch (err) {
        console.log(`[ProactivityHub] act 执行异常 tool=${step.tool}（忽略）: ${err}`);
        outcomes.push({ tool: step.tool, ok: false });
        break;
      }
    }
    return outcomes;
  }

  /** 记录一次自主工具执行（act 审计；内存环形保留近 N 条） */
  private recordActAudit(
    actorId: string,
    tool: string,
    args: Record<string, unknown>,
  ): void {
    const list = this.actAudit.get(actorId) ?? [];
    list.push({ at: Date.now(), tool, args });
    if (list.length > this.ACT_AUDIT_LIMIT) list.splice(0, list.length - this.ACT_AUDIT_LIMIT);
    this.actAudit.set(actorId, list);
  }

  /** 读取 act 审计（诊断/安全复盘用） */
  getActAudit(actorId: string): Array<{ at: number; tool: string; args: Record<string, unknown> }> {
    return this.actAudit.get(actorId) ?? [];
  }

  /** 解析步骤参数：fromStep 引用前序结果（media.search → media.play 链） */
  private resolveStepArgs(
    step: ProactiveActStep,
    previousResults: Array<Record<string, unknown>>,
  ): Record<string, unknown> {
    if (step.fromStep === undefined) return step.args;
    const source = previousResults[step.fromStep];
    if (step.tool === "media.play") {
      const track = parseFirstTrack(source);
      if (!track) return step.args;
      return {
        ...step.args,
        trackId: track.trackId,
        ...(track.trackName !== undefined ? { trackName: track.trackName } : {}),
        ...(track.artist !== undefined ? { artist: track.artist } : {}),
        ...(track.durationSec !== undefined ? { durationSec: track.durationSec } : {}),
      };
    }
    return step.args;
  }
}
