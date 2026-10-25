import { randomUUID } from "node:crypto";

import {
  buildPersonaMoodBlock,
  buildPersonaStaticBlock,
  resolvePersonaMood,
  resolveRelationshipTier,
} from "../agent/persona-core.js";
import { getSoulOverlay } from "../agent/soul-store.js";
import { buildVoiceBaselineBlock } from "../agent/chat-voice-baseline.js";
import { TurnBudget } from "../agent/turn-budget.js";
import { normalizeSentence, sentenceSet, stripSentencesAlreadySaid } from "../utils/text.js";
import type { WorldService } from "@nextbot/agent-world";
import type { ComputeQuotaService } from "./compute-quota-service.js";
import type { AgentMemorySyncService } from "./agent-memory-sync-service.js";
import type { ToolMediaCard, ToolRegistry } from "../tools/tool-registry.js";
import type { VirtualPhoneService } from "./virtual-phone-service.js";
import type { ScheduleTaskService } from "./schedule-task-service.js";
import type { DesktopBridgeCoordinator } from "./desktop-bridge-coordinator.js";
import { isLocalDesktopVisualEnabledFromEnv } from "./desktop-visual-subprocess.js";
import type { PhoneBridgeCoordinator } from "./phone-bridge-coordinator.js";
import type { LocationCoordinator } from "./location-coordinator.js";
import type { LocationHistoryService } from "./location-history-service.js";
import { getAgentRuntimeConfig } from "../agent/agent-runtime-config.js";
import { seedIdentityMarkdown } from "../agent/identity-markdown-seeder.js";
import { isActorDisabled } from "./user-disable-gate.js";

/**
 * 位置证据门去重表（2026-10-19）：同一 actor 在同一位置文本上只尝试一次计划确认，
 * 避免每轮都查一次计划表。位置变了（真的移动了）才会重新判定。
 */
const planLocationLastAttempt = new Map<string, string>();

/**
 * 本模式职责人格（chat/task 双面差异化 persona）。
 *
 * 设计动机：对话面与任务面是同一套基座人格的两个"脑"，但职责不同——由 agent-core
 * 依据路由 mode 在 system prompt 中注入各自【本模式职责】块，让同一人格各有侧重：
 * - CHAT_PLANE_ROLE_GUIDANCE：偏对话流畅与活人感。负责闲聊、节奏衔接、轻量直答；
 * - TASK_PLANE_ROLE_GUIDANCE：偏逻辑推理与工具调用。负责后台任务、多步收敛、
 *   产出可复述的事实结论。
 * 对应「每轮只一个脑主导」：chat 对话面直答；task 任务面用工具办。
 */
// 2026-09-23：三个车道指导语迁至 agent/lane-role-guidance.ts（内容在该模块演进），
// 此处保留引用；迁出原因见该模块头注（评测台架需与生产共享同一份源字符串）。
export { CHAT_PLANE_ROLE_GUIDANCE, TASK_PLANE_ROLE_GUIDANCE, FOREGROUND_ROLE_GUIDANCE } from "../agent/lane-role-guidance.js";
import { CHAT_PLANE_ROLE_GUIDANCE, TASK_PLANE_ROLE_GUIDANCE, FOREGROUND_ROLE_GUIDANCE } from "../agent/lane-role-guidance.js";

/**
 * 前台小工具集白名单（2026-09-06 P0 修复，原生 function calling）。
 *
 * 契约：前台可见工具为提醒/日程直写（reminder.plan + calendar.create_from_text，
 * 2026-09-08：简单写操作对话面当场办成，不派后台、不出任务回执）+
 * task.dispatch（派后台）+ search_web（快查），以 explicit profile 注入
 * （chatToolsBuiltin 即最终可见集，无延迟目录、无 contextual 筛选）。
 * schema 常驻换来"写动作/派发/查证走 API 结构化 tool_calls 通道"——替代依赖
 * 模型自觉遵守的 [dispatch:...] 文本协议。
 * 注册表侧 task.dispatch 的 launch 回调由 bootstrap 晚绑定（create-app-services）。
 */
let _foregroundToolWhitelist: ChatCompletionTool[] | null = null;
const FOREGROUND_INLINE_TOOL_NAMES = new Set([
  "reminder.plan",
  "calendar.create_from_text",
]);
/**
 * 日历/提醒创建类工具（2026-09-24）：本轮任一成功返回 → 该轮按「办妥确认轮」
 * 执法回复风格闸（不吃结构豁免），堵"订阅确认写成五段导购"的废话出口。
 */
/** 确认轮工具集（WS 层同源消费：分泡轮说话算话裁决的确认轮例外，见 bubble-tracker.ts） */
export const CALENDAR_CONFIRM_TOOLS = new Set([
  "reminder.plan",
  "calendar.create_from_text",
  "calendar.create_task",
]);
function getForegroundChatToolWhitelist(userText?: string): ChatCompletionTool[] {
  const base = (() => {
    if (_foregroundToolWhitelist) return _foregroundToolWhitelist;
    const searchWeb = getBuiltinAgentChatTools().find(
      (tool) => tool.type === "function" && tool.function?.name === "search_web",
    );
    const inlineWriteTools = getBuiltinAgentChatTools().filter(
      (tool) =>
        tool.type === "function" && tool.function && FOREGROUND_INLINE_TOOL_NAMES.has(tool.function.name),
    );
    _foregroundToolWhitelist = [
      ...inlineWriteTools,
      TASK_DISPATCH_TOOL_DEFINITION,
      ...(searchWeb ? [searchWeb] : []),
    ];
    return _foregroundToolWhitelist;
  })();
  // 能力域关键词确定性注入（2026-09-19）：轻量模型不会主动 tool_discover，
  // 用户提到「经期/SOS/紧急联系人」等话题时把对应能力域 schema 并入本轮白名单，
  // 否则女性关怀等新域在话面上不可达（见 selectForegroundCapabilityToolAdditions 注释）。
  const additions = selectForegroundCapabilityToolAdditions(userText);
  if (additions.length === 0) return base;
  const known = new Set(
    base.map((tool) => (tool.type === "function" ? tool.function.name : undefined)),
  );
  return [
    ...base,
    ...additions.filter(
      (tool) => tool.type === "function" && !known.has(tool.function.name),
    ),
  ];
}

/**
 * fast 对话模式的单次输出 token 上限。
 * 默认关闭（不传 max_tokens）：fast 也承担复杂任务完成后的对外汇报，需保留足够的表述空间；
 * 如需重新限制，显式设 FAST_MAX_OUTPUT_TOKENS 为正整数即可（0 表示关闭）。
 */
function chatLaneMaxOutputTokens(): number | undefined {
  const raw = process.env.FAST_MAX_OUTPUT_TOKENS?.trim();
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * chat 车道工具波预算（2026-09-19 静态双车道）：静态 Core 直调 1 波 + 结果回写
 * 收尾 1 波 + 延迟目录可达性（tool_discover→schema 转正 或 tool_request 转正）各留
 * 余量。旧 maxRounds=2 是 disableToolSearch（零目录）下的配平值，目录可达后必须
 * ≥3，否则"发现→执行"两波必断头。env: AGENT_CHAT_LANE_MAX_ROUNDS（1-4）。
 */
function chatLaneMaxRounds(): number {
  const raw = process.env.AGENT_CHAT_LANE_MAX_ROUNDS?.trim();
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(n) && n >= 1 && n <= 4 ? n : 3;
}

import type { AgentReply } from "../agent/types.js";
import { PromptContextBuilder } from "../agent/prompt-context-builder.js";
import type { SkillManager } from "../skills/index.js";
import type { MoodInferenceService } from "./mood-inference-service.js";
import type { ClientPushPort } from "../ports/client-push-port.js";
import type { LifeSignalHubService } from "./life-signal-hub-service.js";
import { ServerEventType } from "../protocol.js";
import type {
  PersonalizationPromptSlice,
  UserPersonalizationService,
} from "./user-personalization/user-personalization-service.js";
import {
  type TaskExecutionPlan,
  planExecuteSessionId,
  runPlanExecuteLoop,
  shouldPlanExecute,
} from "../agent/plan-execute-loop.js";
import type {
  AgentStreamOptions,
  ChatToolExecutionContext,
  ChatUserTurn,
  ExternalChatProvider,
  StreamDeltaHandler,
  ToolExecutedInfo,
  ToolExecuteStartInfo,
  ToolLoopAfterBatchInfo,
  VisionFrame,
} from "../external-model/types.js";
import type { ActorModelBindingStore } from "../external-model/actor-model-bindings.js";
import {
  isApologyStyleFallback,
  FALLBACK_TEXT_BACKGROUND_FAILED,
  buildTaskFailureNotice,
} from "../external-model/fallback-texts.js";
import {
  buildDomainPreloadTools,
  buildLaneCoreTools,
  buildTaskLaneRouterFirstLightTools,
  dedupeToolsByName,
  isStaticToolArchEnabled,
  isTaskLaneRouterFirst,
  isToolRecallEnabled,

  toolsMatchingCapabilityBeam,
} from "../external-model/lane-tool-sets.js";
import { getPromotedToolNames } from "../tools/tool-search/tool-promotion.js";
import { toolsInDomain } from "../tools/tool-search/tool-category.js";
import {
  getBuiltinAgentChatTools,
  isSubstantiveToolExecution,
  selectForegroundCapabilityToolAdditions,
} from "../external-model/openai-compatible-tool-loop.js";
import { isVoiceMode } from "../proactivity/voice-mode-state.js";
import { describeMemoryAge, semanticFingerprint } from "./memory-record-utils.js";

/** 记忆 domain → 注入 prompt 时的中文类型标签（分类显性化，P4）。 */
const MEMORY_DOMAIN_LABELS: Record<string, string> = {
  episodic: "事件",
  semantic: "事实",
  procedural: "技能",
  emotional: "情绪",
  narrative: "经历",
  relationship: "关系",
  world: "状态",
  personality: "特质",
};
import type { NarrativeMemoryPort } from "./narrative-memory-port.js";
import type { ShortTermMemoryGatewayService } from "./short-term-memory-gateway.js";
import { getDailyJournalService } from "./daily-journal-service.js";
import { resolveUserLocationPrompt } from "../services/user-location-service.js";
import type { ClientLocationWire } from "../types/client-location.js";
import { type LlmExecutionMode, type RouteDecision, buildUnifiedLaneDecision } from "../agent/task-router.js";
import {
  isForegroundDispatchMode,
  isForegroundTagProtocolEnabled,
} from "../agent/task-router.js";
import { TASK_DISPATCH_TOOL_DEFINITION } from "../tools/task-dispatch-tool.js";
import {
  isSessionBudgetExceeded,
  isDailyBudgetExceeded,
} from "./llm-budget-guard.js";
import {
  TASK_CANCEL_TOOL_DEFINITION,
  TASK_STATUS_TOOL_DEFINITION,
} from "../tools/task-plane-tools.js";
import { PERCEPTION_OVERVIEW_TOOL_DEFINITION } from "../tools/perception-tools.js";
import { extractContentSummaryCard } from "./content-summary-service.js";
import {
  allImageCardsHaveCaption,
  attachTravelItineraryCard,
  attachVideoMediaMarker,
  buildCaptionedRenderBlocks,
  buildInterleavedRenderBlocks,
  isFlatImageGallery,
  dedupMediaCards,
  extractMediaCards,
  resolveVideoMediaSource,
  stripResidualRenderDeclarations,
  trimMediaCardsByTopic,
  type MediaCardItem,
} from "./tool-result-processor.js";
import { captionMediaCards, isImageCaptionEnabled } from "./image-caption-service.js";
import { normalizeReplyCardLayout, buildReplyBlocks, extractNextUpSuggestions } from "./reply-envelope.js";
import { attachTravelBriefCard, resolveTravelReceipt } from "./deterministic-card-chain.js";
import { TASK_PLANE_FALLBACK_BUDGET } from "../agent/intent-router.js";
import { isActionableTaskRequest } from "../agent/task-intent.js";
import { isDirectCurrentTimeQuestion, isMediaOnlyRequest, type TravelPlanRequest } from "../agent/realtime-search-query.js";
import { needsToolChoiceRequired } from "../gateway/forced-tool.js";
import { buildCurrentTimePrompt } from "../agent/prompt-builder.js";
import {
  isExplicitNoWebRequest,
  filterWebSearchTools,
  filterTextSearchTools,
  filterMediaModalityTools,
  NO_WEB_TURN_NOTE,
} from "../agent/web-search-consent.js";
import { recordBackgroundOutcome } from "./task-plane-metrics.js";
import {
  DispatchTagStreamFilter,
  parseDispatchTags,
  stripDispatchTags,
} from "../agent/dispatch-tag.js";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { TaskTier, buildModelOverrideOpts } from "../config/model-routing.js";
import type { BrainCenter } from "../brain/index.js";
import type { EmotionVector, MemoryRecallItem } from "../brain/types.js";
import { parseAgentAccessMode, type AgentAccessMode } from "../agent/agent-access-mode.js";
import { TurnLifecycle } from "../agent/turn-lifecycle.js";
import { resolvePrimaryChatSessionId, isNotesChatSessionId } from "../agent/master-chat-session.js";
import { getChatThreadStore } from "../external-model/chat-thread-store.js";
import { stripInternalControlTags, ToolIntentWithoutToolsError } from "../external-model/stream-chat-helpers.js";
import { AgentTaskOrchestrator } from "./agent-task-orchestrator.js";
import type { AgentTaskOrchestratorDeps, RunTaskOptions } from "./agent-task-orchestrator.js";
import { getAgentTaskStore } from "./agent-task-store.js";
import { getRuntimeKernel } from "../agent/runtime-kernel.js";
import { getTaskHub } from "../task-plane/task-hub.js";
import { getTaskOutbox } from "../task-plane/task-outbox.js";
import { broadcastTaskUpdate } from "../task-plane/task-events.js";
import { backgroundTaskLimiter } from "./concurrency-limiter.js";
import { ToolContextFactory } from "../agent/execution/tool-context-factory.js";
import { getToolCallGuard } from "./tool-call-guard.js";
import { TurnFinalizer } from "../agent/execution/turn-finalizer.js";
import { ToolPolicyResolver } from "../agent/execution/tool-policy-resolver.js";
import {
  appendLearningDecisionGuidance,
  appendRecentConversationHistory,
  appendWorkingMemorySummary,
  recallItemsToNarrative,
} from "../agent/execution/narrative-recall-composer.js";

export type { AgentReply } from "../agent/types.js";

// P0 时间窗口查询感知的词表加料（TIME_WINDOW_WORD_RE / EVENT_INQUIRY_RE /
// META_CONVERSATION_RECALL_RE / enrichMemoryRecallQuery）已随词表判定退役
// （2026-10-10）：召回触发由 understanding 闸单点承担，检索 query 回归用户
// 原文——recall-gate 原则「禁止加料，加料是召回串台的根因」。

export type HandleUserMessageOptions = {
  onAssistantDelta?: StreamDeltaHandler;
  onExternalToolExecuteStart?: (info: ToolExecuteStartInfo) => void;
  onExternalToolExecuted?: (info: ToolExecutedInfo) => void;
  onToolLoopAfterBatch?: (info: ToolLoopAfterBatchInfo) => void;
  onBackgroundAssistantDelta?: (info: { messageId: string; delta: string; source: string }) => void;
  onBackgroundAssistantDone?: (info: { messageId: string; finalText: string; source: string }) => void;
  /**
   * 工具执行中途向聊天流推送媒体卡片（如购物登录/支付二维码）。
   * WS 聊天主路径装配（chat.media_ready 挂到当前流式回复）；程序化调用方缺省为空。
   */
  pushMediaCards?: (cards: ToolMediaCard[]) => void;
  chatUserMessageId?: string;
  userId?: string;
  clientIp?: string;
  clientLocation?: ClientLocationWire;
  /**
   * 发送消息的设备类别（2026-10-07）：desktop | mobile。WS 层从连接注册表取
   * （session.init 自报 platform），注入【运行环境】块让模型感知手机/电脑——
   * 手机端回复要短、不引导桌面操作；缺省不注入（程序化调用方/旧客户端）。
   */
  deviceClass?: "desktop" | "mobile";
  visionFrames?: VisionFrame[];
  onAgentPhaseStatus?: (line: string) => void;
  /** plan_execute 计划生成后回调（v2 分阶段对话交互） */
  onPlanReady?: (plan: { goal: string; steps: { id: string; intent: string; successCriteria?: string; suggestedTools?: string[] }[] }) => void;
  interruptedContext?: string;
  /** 默认沙箱；`full` 时允许高权限工具 */
  agentAccessMode?: AgentAccessMode;
  /** 为 true 时禁用 fast_chat 捷径（工具/记忆/人设与 App 对齐） */
  preferFullPipeline?: boolean;
  /** 当前会话 sessionId；用于区分主会话 vs 笔记会话的记忆上下文。 */
  sessionId?: string;
  /**
   * 中断信号:用户发新消息时,调用方 abort 此 signal,
   * agent-core 透传到 provider.streamCompletion,真正中断进行中的 LLM HTTP 流式请求。
   */
  signal?: AbortSignal;
  /**
   * 外层(WS 层)已计算的路由决策。传入时 agent-core 复用，同轮不重复调语义路由（缓存兜底）。
   * 允许传未决 Promise：agent-core 与记忆认知（cognize）并行等待，路由 LLM 调用
   * 不再阻塞 cognize 启动（未传时 agent-core 内部自行调用，向后兼容）。
   */
  routeDecision?: RouteDecision | Promise<RouteDecision>;
  /**
   * 任务面异步收尾（2026-09-08，仅 WS 对话路径开启）：plane=task 时派发后台任务后
   * 本轮立即结束（reply.taskDispatched=true、text 为空），对话窗马上回到空闲态——
   * 发送按钮不再在任务整个执行期间停在「工作态」；任务结果由后台完成后以
   * source=task_plane 的独立消息回灌。未开启时保持旧行为（本轮等待任务完成并
   * 交付结果文本），agent 中继/HTTP/link 等程序化调用方不受影响。
   */
  taskPlaneAsync?: boolean;
};

type ShortTermTurnContext = {
  activeTaskId?: string;
  resumedTask: boolean;
};

export class AgentCore {
  private readonly promptContextBuilder: PromptContextBuilder;
  private readonly turnLifecycle: TurnLifecycle;
  private readonly toolContextFactory: ToolContextFactory;
  private readonly turnFinalizer: TurnFinalizer;
  private readonly toolPolicyResolver: ToolPolicyResolver;
  private readonly agentTaskOrchestrator: AgentTaskOrchestrator | null = null;
  /**
   * 按 actor 的用户自有模型绑定仓（云端连接版 BYOK，bootstrap 注入）：
   * 用户对话轮优先走 actor 绑定的自有 provider，无绑定回落运营方 externalChat。
   */
  private actorModelBindings: ActorModelBindingStore | null = null;
  private desktopBridgeCoordinator: DesktopBridgeCoordinator | null = null;
  private phoneBridgeCoordinator: PhoneBridgeCoordinator | null = null;
  private locationCoordinator: LocationCoordinator | null = null;
  private locationHistory: LocationHistoryService | null = null;
  /** prompt 按要 GPS 的上次尝试时间（失败冷却用，per-actor）。 */
  private promptLocationLastAttemptAt = new Map<string, number>();
  /** 常去地点文本的进程内缓存（DBSCAN 全量扫 7 天样本，不必每轮重算）。 */
  private frequentPlacesCache = new Map<string, { text: string | undefined; at: number }>();
  private moodInferenceService: MoodInferenceService | null = null;
  private wsRegistry: ClientPushPort | null = null;
  private lifeSignalHubService: LifeSignalHubService | null = null;
  /** BrainCenter 引用：可用时走 cognize() 端到端认知入口替代认知层切片 */
  private brainCenter: BrainCenter | null = null;
  /** 主动性模块（ProactivityHub）：对话轮观察等主动触发的统一入口 */
  private proactivityHub: import("../proactivity/proactivity-hub.js").ProactivityHub | null = null;
  constructor(
    private readonly toolRegistry: ToolRegistry,
    private readonly externalChat: ExternalChatProvider | null = null,
    private readonly computeQuotaService: ComputeQuotaService | null = null,
    private readonly agentMemorySyncService: AgentMemorySyncService | null = null,
    private readonly userPersonalizationService: UserPersonalizationService | null = null,
    private readonly worldService: WorldService | null = null,
    private readonly skillManager: SkillManager | null = null,
    private readonly narrativeMemory: NarrativeMemoryPort | null = null,
    private readonly virtualPhoneService: VirtualPhoneService | null = null,
    private readonly scheduleTaskService: ScheduleTaskService | null = null,
    private readonly shortTermMemoryGateway: ShortTermMemoryGatewayService | null = null,
    moodInferenceService: MoodInferenceService | null = null,
    lifeSignalHubService: LifeSignalHubService | null = null,
  ) {
    this.moodInferenceService = moodInferenceService;
    this.lifeSignalHubService = lifeSignalHubService;
    this.promptContextBuilder = new PromptContextBuilder({
      agentMemorySyncService: this.agentMemorySyncService,
      worldService: this.worldService,
      skillManager: this.skillManager,
      virtualPhoneService: this.virtualPhoneService,
      scheduleTaskService: this.scheduleTaskService,
      shortTermMemoryGateway: this.shortTermMemoryGateway,
    });
    this.turnLifecycle = new TurnLifecycle({
      narrativeMemory: this.narrativeMemory,
      computeQuotaService: this.computeQuotaService,
      userPersonalizationService: this.userPersonalizationService,
      agentMemorySyncService: this.agentMemorySyncService,
      shortTermMemoryGateway: this.shortTermMemoryGateway,
      // 画像聚合器经 brainCenter 惰性取（构造序：turnLifecycle 先于 brainCenter 赋值）
      getUserProfileAggregator: () => this.brainCenter?.getUserProfileAggregator() ?? null,
    });
    this.toolContextFactory = new ToolContextFactory({
      toolRegistry: this.toolRegistry,
      getBrainCenter: () => this.brainCenter,
      // 敏感工具（金额/不可逆）守卫：TTL 内同参成功幂等回放 + 审计落盘
      toolCallGuard: getToolCallGuard(),
    });
    this.toolPolicyResolver = new ToolPolicyResolver({
      getBrainCenter: () => this.brainCenter,
    });
    this.turnFinalizer = new TurnFinalizer({
      provider: this.externalChat,
      turnLifecycle: this.turnLifecycle,
      shortTermMemoryGateway: this.shortTermMemoryGateway,
      getBrainCenter: () => this.brainCenter,
    });

    // 初始化状态机编排器(桌面自动化任务,外部状态机驱动 LLM 多轮调用)
    if (this.externalChat && this.toolRegistry) {
      const orchestratorDeps: AgentTaskOrchestratorDeps = {
        provider: this.externalChat,
        toolRegistry: this.toolRegistry,
      };
      this.agentTaskOrchestrator = new AgentTaskOrchestrator(orchestratorDeps);
      // 2026-09-05 双面架构：LoopOrchestrator（React/PlanExecute 双策略 + LLM 进展评估）
      // 已删除。任务面唯一引擎 = 工具循环（波内一次性规划 + 并行工具 + 出口自检续波），
      // 显式 plan 调用仅在 AGENT_PLAN_EXECUTE_LOOP 开启时叠加（见 runStandardLlmPath）。
    }
  }

  /** 在 bootstrap 注册桌面桥接后注入，用于按轮检测电脑是否在线。 */
  setDesktopBridgeCoordinator(coordinator: DesktopBridgeCoordinator): void {
    this.desktopBridgeCoordinator = coordinator;
  }

  /** 注入按 actor 的用户自有模型绑定仓（云端连接版 BYOK；bootstrap 装配）。 */
  setActorModelBindings(store: ActorModelBindingStore): void {
    this.actorModelBindings = store;
  }

  /**
   * 该 actor 本轮应使用的对话 provider：绑定了用户自有模型（BYOK）则用之，
   * 否则回落全局 externalChat（运营方配置）。仅用户轮调用点使用；
   * TurnFinalizer / AgentTaskOrchestrator 等旁路保持运营方 provider。
   */
  private chatProviderFor(actorId: string): ExternalChatProvider | null {
    const byok = this.actorModelBindings?.get(actorId) ?? null;
    if (byok && byok.isEnabled()) return byok;
    return this.externalChat;
  }

  /** 在 bootstrap 注册手机桥接后注入，用于按轮检测手机是否在线。 */
  setPhoneBridgeCoordinator(coordinator: PhoneBridgeCoordinator): void {
    this.phoneBridgeCoordinator = coordinator;
  }

  /** 在 bootstrap 注册位置协调器后注入：Agent 需要位置时按需向客户端请求实时 GPS。 */
  setLocationCoordinator(coordinator: LocationCoordinator): void {
    this.locationCoordinator = coordinator;
  }

  /** 在 bootstrap 注册位置历史后注入：常去地点背景由 DBSCAN 纯算法挖掘（零 LLM）。 */
  setLocationHistory(service: LocationHistoryService | null): void {
    this.locationHistory = service;
  }

  /** 在 bootstrap 注册情绪感知后注入，用于按轮分析用户消息情绪。 */
  setMoodInferenceService(service: MoodInferenceService | null): void {
    this.moodInferenceService = service;
  }

  /** 在 bootstrap 注册 WS 连接注册表后注入，用于将情绪事件推送给客户端。 */
  setWsRegistry(registry: ClientPushPort | null): void {
    this.wsRegistry = registry;
    // 任务面回执广播（2026-09-08）：TaskHub 生命周期变更 → chat.task_update。
    // 监听器随 registry 生命周期注入/清除；开关关闭时 broadcastTaskUpdate 自行短路。
    getTaskHub().setChangeListener(
      registry
        ? (record) => broadcastTaskUpdate(registry, record)
        : null,
    );
  }

  /** 在 bootstrap 注册 LifeSignalHub 后注入，用于在情绪推理后发布 mood 信号。 */
  setLifeSignalHubService(service: LifeSignalHubService | null): void {
    this.lifeSignalHubService = service;
  }

  /**
   * 注入 BrainCenter。可用时 handleUserMessage 走 cognize() 端到端认知入口，
   * 替代原切片式 moodInference + buildShortTermTurnContext（意图路由已退役）。
   * BRAIN_CENTER_ENABLED=0 时 brainCenter 为 null，降级到原切片路径。
   */
  setBrainCenter(brain: BrainCenter | null): void {
    this.brainCenter = brain;
    if (brain) {
      brain.registerRuntimeKernel(getRuntimeKernel());
    }
  }

  /**
   * 推送 MoodInferred WS 事件 + 发布 mood LifeSignal。
   * 统一 cognize 路径（用 EmotionVector 映射）和降级路径（用 MoodInference 结果）的副作用。
   */
  private emitMoodInferred(
    sessionId: string,
    mood: {
      sentimentScore: number;
      confidence: number;
      emotionTags: string[];
      agentNote: string;
      timestamp: string;
    },
  ): void {
    const registry = this.wsRegistry;
    const lifeSignalHub = this.lifeSignalHubService;
    const payload = {
      type: ServerEventType.MoodInferred,
      payload: {
        sessionId,
        sentimentScore: mood.sentimentScore,
        confidence: mood.confidence,
        emotionTags: mood.emotionTags,
        agentNote: mood.agentNote,
        timestamp: mood.timestamp,
      },
    };
    try {
      registry?.trySend(sessionId, JSON.stringify(payload));
    } catch {
      // 静默失败，不影响主流程
    }
    try {
      lifeSignalHub?.publish({
        id: `mood-${mood.timestamp}-${Date.now()}`,
        actorId: sessionId,
        source: "agent_inference",
        kind: "mood",
        title: mood.sentimentScore < -0.2 ? "情绪偏低" : "情绪积极",
        summary: mood.emotionTags.length > 0
          ? `检测到情绪：${mood.emotionTags.join("、")}`
          : "情绪状态变化",
        tags: mood.emotionTags,
        importance: mood.sentimentScore < -0.5 ? "high" : "medium",
        evidence: [mood.agentNote ?? "对话情感分析"],
        metrics: {
          sentimentScore: mood.sentimentScore,
          confidence: mood.confidence,
        },
        metadata: { mood },
        occurredAt: mood.timestamp,
      });
    } catch {
      // 静默失败，不影响主流程
    }
  }

  private desktopBridgeOnlineFor(actorId: string): boolean {
    return this.desktopBridgeCoordinator?.hasExecutor(actorId) ?? false;
  }

  private phoneBridgeOnlineFor(actorId: string): boolean {
    return this.phoneBridgeCoordinator?.hasExecutor(actorId) ?? false;
  }

  private streamAccessFields(
    actorId: string,
    opts?: HandleUserMessageOptions,
  ): { agentAccessMode: AgentAccessMode; desktopBridgeOnline: boolean; phoneBridgeOnline: boolean } {
    return {
      agentAccessMode: parseAgentAccessMode(opts?.agentAccessMode),
      desktopBridgeOnline: this.desktopBridgeOnlineFor(actorId),
      phoneBridgeOnline: this.phoneBridgeOnlineFor(actorId),
    };
  }

  private buildShortTermTurnContext(sessionId: string, text: string): ShortTermTurnContext {
    if (!this.shortTermMemoryGateway || text.length < 8) {
      return {
        resumedTask: false,
      };
    }

    const sync = this.shortTermMemoryGateway.syncTaskForTurn(sessionId, text);
    return {
      activeTaskId: sync.task.taskId,
      resumedTask: sync.resumed,
    };
  }

  /**
   * 对话面（chat 车道）的轻量子孙：不激活任务（避免闲聊污染任务栈）。
   * 记忆架构重构后不再构造召回 query（原 buildRecallQuery 拼接链已删除——
   * 任务/偏好/openLoops 加料是召回串台根因）；长期检索由 recall-gate 门控，
   * query 只用用户原文。
   */
  private buildChatLaneShortTermTurnContext(_sessionId: string, _text: string): ShortTermTurnContext {
    return {
      resumedTask: false,
    };
  }

  /**
   * 路由用最近用户消息（短追问任务意图继承，2026-08-29）：
   * "娱乐圈的""新鲜的"这类短追问需沿用上一轮 complex 的任务意图。
   * 只取纯文本 user 消息、过滤掉与当前消息相同的重复条目；
   * 拉取失败返回 undefined，路由退化为无上下文判定。
   */
  private getRecentUserTurnsForRouting(
    actorId: string,
    sessionId: string | undefined,
    currentText: string,
  ): string[] | undefined {
    try {
      const chatSessionId =
        sessionId && isNotesChatSessionId(sessionId)
          ? sessionId
          : resolvePrimaryChatSessionId(actorId, getAgentRuntimeConfig().masterDelegation.enabled);
      const current = currentText.trim();
      return getChatThreadStore()
        .thread(chatSessionId, "")
        .filter(
          (m) =>
            m.role === "user" &&
            typeof m.content === "string" &&
            m.content.trim() &&
            m.content.trim() !== current,
        )
        .slice(-4)
        .map((m) => (m.content as string).trim());
    } catch {
      return undefined;
    }
  }

  /**
   * WS 层决策入口（2026-10-21 去路由化）：不再调用意图路由 LLM，直接返回
   * 统一车道决策。WS 层只把它用于分泡/面板事件，不阻塞主回复。
   * 计划续跑等确定性 task 决策由 WS 层自行构造后直接传给 generateReply。
   */
  async routeTurnForWs(
    _sessionId: string,
    _text: string,
    _recentUserTurns: string[] = [],
    _entityContextLines: string[] = [],
    _dialogStateLines: string[] = [],
  ): Promise<import("../agent/task-router.js").RouteDecision> {
    return buildUnifiedLaneDecision();
  }

  /** 注入主动性模块（对话内主动触发等能力的统一入口） */
  setProactivityHub(hub: import("../proactivity/proactivity-hub.js").ProactivityHub | null): void {
    this.proactivityHub = hub;
    // 复杂任务完成恭喜接线：编排器持有同一 hub
    this.agentTaskOrchestrator?.setProactivityHub(hub);
    // 顺嘴搭车通道（2026-10-01）：hub 的挂起 low 意图经 prompt builder 织入
    // 对话面回复末尾；取走即交付（每轮至多一条，频控/TTL 在队列内）
    this.promptContextBuilder.setTurnAsideProvider(
      hub ? (actorId: string) => hub.takeTurnAsideForTurn(actorId) : null,
    );
  }

  /**
   * 注入当下状态拉取器（WorldBoard.current 格式化，bootstrap 接线）。
   * 每轮对话面注入【当下状态】块：屏幕焦点/在线状态，顺嘴的 grounded 依据。
   */
  setCurrentStateProvider(fn: ((actorId: string) => string | null) | null): void {
    this.promptContextBuilder.setCurrentStateProvider(fn);
  }

  /**
   * 注入用户兴趣列表拉取器（InterestWatcher 接线）。
   * 转发到 PromptContextBuilder，每轮注入【用户兴趣关注列表】块，
   * 让 agent 知道用户长期关注什么 + 提醒用 interest.manage 工具维护。
   */
  setInterestListProvider(
    fn: ((actorId: string) => string | null) | null,
  ): void {
    this.promptContextBuilder.setInterestListProvider(fn);
  }

  /**
   * 注入在办目标拉取器（GoalBoard 接线，bootstrap 装配）。
   *
   * 每轮对话面注入【在办目标】块（仅活跃前 3 条，一行一个）：让 agent 知道
   * 「我正在替用户办这件事」——用户问「那事怎么样了」时直接读台账，不必靠
   * 记忆模糊召回。无活跃目标时零注入。
   */
  setActiveGoalsProvider(
    fn: ((actorId: string) => string | null) | null,
  ): void {
    this.promptContextBuilder.setActiveGoalsProvider(fn);
  }

  /**
   * 判定当前轮是否"真正切换了话题"（STM 解析为 topic_switch，无任务延续/无指代）。
   * 命中时抑制长期记忆注入，避免旧话题/跨会话记忆串台。
   */
  // v3 退役：isTopicSwitchTurn 曾是长期记忆注入的第三道闸（STM 焦点=topic_switch 即杀），
  // 实测把白名单命中轮次也压掉（换措辞召回注入率 1/10 的元凶）。情节记忆不再无邀请
  // 推送后该判定失去意义；防串台由「画像常驻 + 工具拉取 + 窄线索兜底」结构性承担。

  async handleUserMessage(
    actorId: string,
    text: string,
    opts?: HandleUserMessageOptions,
  ): Promise<AgentReply> {
    // 管理员禁用门：被禁用主体拒绝对话（跨进程读账号文件，mtime 缓存）。
    if (await isActorDisabled(actorId)) {
      throw new Error("该账号已被管理员禁用，如有疑问请联系部署者");
    }

    const sessionId = opts?.sessionId ?? actorId;

    // 身份/记忆 Markdown 文档懒种子：每个 actor 每进程只做一次（启动种子已覆盖老 actor），
    // 在构建 prompt 前确保 SOUL/USER/MEMORY.md 已写入 KV，让本轮回复即可感知。
    if (this.agentMemorySyncService) {
      try {
        await seedIdentityMarkdown(this.agentMemorySyncService, actorId);
      } catch (e) {
        console.error(`[AgentCore] 身份/记忆懒种子失败(${actorId}):`, e);
      }
    }

    // 用户开口即打断小脑：清空该 actor 的 defer 队列 + 设 60s 抑制窗口，
    // 让"用户开口时 Agent 不抢话"从注释变成可执行逻辑。
    // 小脑未注册时（BRAIN_NEURO_ENABLED=0）interruptProactive 为空操作。
    this.brainCenter?.interruptProactive(actorId);

    // === 对话认知入口 ===
    // 2026-10-21 去路由化：入口层不再有「意图理解/平面判定」LLM 调用。
    // 普通轮固定统一车道（buildUnifiedLaneDecision），工具常驻可见，
    // 「这轮办不办事」由主模型原生 tool_calls 决定；task 车道只剩计划续跑
    // 与模型主动 task.dispatch 两类确定性入口。
    // BrainCenter 可用时走 cognize 端到端认知入口（仅提供记忆/情绪/画像上下文），
    // 不可用时（BRAIN_CENTER_ENABLED=0）降级到原切片路径。
    let route: RouteDecision;
    let shortTermTurn: ShortTermTurnContext;
    /** 轻量路径不产出初步响应；needsToolLoop 恒为 true 强制走 streamCompletion/工具循环 */
    let cognitiveResponse = "";
    /** 是否走工具循环：恒为 true（当前主链路统一经 streamCompletion 生成回复） */
    let cognitiveNeedsToolLoop = true;
    /** cognize 阶段 1 已召回的记忆条目；非空时 standard path 复用，避免重复 MemoryCortex.recall */
    let cognitiveRecallItems: MemoryRecallItem[] | undefined;
    /** 工作记忆摘要（注入 streamCompletion 的 prompt） */
    let cognitiveWorkingMemorySummary = "";
    /** cognize 阶段 1 情绪向量（透出给 runStandardLlmPath → promptContext.memory.emotionState） */
    let cognitiveEmotion: import("../brain/types.js").EmotionVector | null = null;
    /** 深度优化：用户画像（来自 OnlineLearningCortex），注入 prompt 让 LLM 感知用户偏好/习惯/否定模式 */
    let cognitiveUserPattern: {
      topics: string[];
      preferredToolDomain?: string;
      negativeFeedbackCount: number;
      learningActive?: boolean;
    } | undefined;
    /** 深度优化：工具规划链（来自 ToolPlanningCortex），约束 LLM 工具选择顺序和范围 */
    let cognitiveToolPlan: import("../brain/tool-planning-cortex.js").ToolPlan | undefined;
    // 阶段计时（2026-09-28 延迟诊断配套，见下方 routed 分支内赋值与 preMain 汇总日志）
    let turnT0 = 0;
    let turnRouteDone = 0;
    let turnCognizeDone = 0;
    // ctxTiming：上下文装配成员级计时（>100ms 才打，定位冷会话装配黑洞）
    const ctxTiming = <T,>(label: string, p: Promise<T>): Promise<T> => {
      const s = Date.now();
      return p.then(
        (v) => {
          if (Date.now() - s > 100) {
            // eslint-disable-next-line no-console
            console.info(`[ctx-timing] ${label} ${Date.now() - s}ms`);
          }
          return v;
        },
        (e) => {
          // eslint-disable-next-line no-console
          console.info(`[ctx-timing] ${label} FAILED ${Date.now() - s}ms`);
          throw e;
        },
      );
    };

    // 去路由化（2026-10-21）：投机前置搜索整体退役。它此前对任何 ≥6 字符的
    // 消息无条件发起（含「你还记得 不错不错」这类闲聊），白烧 2~6s 并把无关
    // 网页条目灌进上下文。检索改由模型按需调用 search_* 工具完成；
    // 显式禁网轮仍由 isExplicitNoWebRequest 剥工具。
    const webSearchForbidden = isExplicitNoWebRequest(text);

    if (this.brainCenter && text?.trim()) {
      // 阶段计时（2026-09-28 延迟诊断配套）：t0 → 路由就绪 → cognize 就绪 →
      // 上下文装配完 → 主调用派发（绝对时间戳跨日志行关联）。声明在外层供
      // preMain 汇总日志读取（brainCenter 缺席的降级路径保持 0）。
      turnT0 = Date.now();
      // 去路由化（2026-10-21）：前置意图路由退役。普通轮固定统一车道，
      // 「要不要用工具」交给主模型原生 tool_calls；只有计划续跑等显式传入的
      // 确定性决策（opts.routeDecision）仍可为 task 面。
      route = opts?.routeDecision
        ? await opts.routeDecision
        : buildUnifiedLaneDecision();
      const cognizePromise = this.brainCenter
        .cognize({
          actorId,
          text,
          sessionId,
        })
        .catch((err): import("../brain/types.js").CognitiveResult | null => {
          console.log(
            `[AgentCore] BrainCenter.cognize 失败，降级使用轻量记忆路径：${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          return null;
        });
      turnRouteDone = Date.now();

      // 异步情绪推断（不阻塞主流程/工具执行）：路由层退役后不再有随行
      // auxAnalysis，直接走 ingestRouteAux 内部的独立 analyzeMessage 回退。
      if (this.moodInferenceService) {
        const inferenceService = this.moodInferenceService;
        void inferenceService
          .ingestRouteAux(sessionId, text, undefined)
          .then((inference) => {
            if (!inference) return;
            this.emitMoodInferred(sessionId, {
              sentimentScore: inference.sentimentScore,
              confidence: inference.confidence,
              emotionTags: inference.emotionTags,
              agentNote: inference.agentNote ?? "对话情感分析",
              timestamp: inference.timestamp,
            });
          })
          .catch(() => {
            // 静默失败，不影响主流程
          });
      }

      // 去路由化后 rule/brain 分类仅保留为诊断日志，不再参与门控。
      const light = this.brainCenter.routeLight(text);
      const shouldGoTaskPlane = route.plane === "task";

      let brainCognition: import("../brain/types.js").CognitiveResult | null = null;
      // cognize 护栏（2026-10-21 去路由化提速）：前置路由门删除后，主回复前
      // 唯一的大并行等待就是它。外部依赖抖动时不得楔死整轮，默认 1200ms，
      // 超时按既有降级路径先行（AGENT_COGNIZE_TIMEOUT_MS 可调）。
      const cognizeGuardMs = (() => {
        const n = Number.parseInt(process.env.AGENT_COGNIZE_TIMEOUT_MS ?? "", 10);
        return Number.isFinite(n) && n > 0 ? n : 1200;
      })();
      brainCognition = await Promise.race([
        cognizePromise,
        new Promise<null>((resolve) =>
          setTimeout(() => {
            // eslint-disable-next-line no-console
            console.warn(
              `[turn-timing] cognize 护栏超时（${cognizeGuardMs}ms），主回复降级先行`,
            );
            resolve(null);
          }, cognizeGuardMs),
        ),
      ]);
      turnCognizeDone = Date.now();

      // 对话内推入后台感知底座：完全后台化——只采集对话内容，由 ProactivityHub
      // 后台零 LLM 规则判决定是否主动 speak/act，不进入对话 prompt，不阻塞主回复。
      this.proactivityHub?.observeConversationTurn(actorId, text);

      route = {
        ...route,
        reasons: [
          ...route.reasons,
          `rule=${light.mode}@${light.confidence.toFixed(2)}`,
          ...(brainCognition ? [`brain=${brainCognition.route.mode}:${brainCognition.rationale}`] : []),
          ...(shouldGoTaskPlane ? ["task_plane_background_executor"] : []),
        ],
        segmentable: shouldGoTaskPlane ? false : route.segmentable,
      };
      shortTermTurn = this.buildChatLaneShortTermTurnContext(sessionId, text);
      cognitiveResponse = brainCognition?.response ?? "";
      cognitiveNeedsToolLoop = true; // 强制走 streamCompletion/工具循环
      cognitiveRecallItems = brainCognition?.recallItems;
      cognitiveWorkingMemorySummary = brainCognition?.workingMemorySummary ?? "";
      cognitiveEmotion = brainCognition?.emotion ?? null;
      cognitiveUserPattern = this.brainCenter?.getOnlineLearningCortex()?.getProfile(actorId) ?? undefined;
      cognitiveToolPlan = brainCognition?.toolPlan;
    } else {
      // === 降级：原切片路径（BRAIN_CENTER_ENABLED=0 时）===
      // 异步情绪推断（不阻塞主流程）+ WS 推送 MoodInferred + lifeSignalHub.publish
      if (this.moodInferenceService && text?.trim()) {
        const inferenceService = this.moodInferenceService;
        void inferenceService.analyzeMessage(sessionId, text).then((inference) => {
          if (!inference) return;
          this.emitMoodInferred(sessionId, {
            sentimentScore: inference.sentimentScore,
            confidence: inference.confidence,
            emotionTags: inference.emotionTags,
            agentNote: inference.agentNote ?? "对话情感分析",
            timestamp: inference.timestamp,
          });
        }).catch(() => {
          // 静默失败，不影响主流程
        });
      }
      route = opts?.routeDecision
        ? await opts.routeDecision
        : buildUnifiedLaneDecision();
      shortTermTurn = this.buildChatLaneShortTermTurnContext(sessionId, text);
    }

    const perfStartTime = Date.now();

    if (!this.chatProviderFor(actorId)?.isEnabled()) {
      const available = this.toolRegistry.list().join(", ");
      const fallback = `已收到：${text}。当前可用工具：${available}`;
      this.turnLifecycle.finalizeTurn({
        actorId,
        userText: text,
        assistantText: fallback,
        sessionId,
      });
      return { text: fallback };
    }

    // cognize 已产出最终响应且无需工具循环 → 直接返回（跳过 streamCompletion/工具循环）
    // 仅 fast_chat/direct_llm 模式适用；master/plan/state_machine 路径需走执行层
    //
    // ⚠️ Apology/空内容检测：cognize LLM 偶尔会自己生成 "抱歉，我无法..." 这种 apology
    // 风格回复（尤其信息不足时），或返回空串。直接返回会让用户看到 fallback 风格回复，
    // 而非真正的对话内容。命中时强制走 streamCompletion 重建回复，让主 LLM 用完整上下文
    // （含 narrativeRecall/personalization）重新组织语言。
    if (
      cognitiveResponse &&
      cognitiveResponse.trim() &&
      !cognitiveNeedsToolLoop &&
      !isApologyStyleFallback(cognitiveResponse) &&
      (route.plane === "chat")
    ) {
      // 2026-10-13 根修：prose 改写全部退役——模型文本即权威，人格风格由
      // system 的【人格·静态】+【人格·状态】+【语感基准】承担（与本路径
      // 消费的 thread 同源），出口不再做任何润色。此分支当前为死代码
      // （cognitiveNeedsToolLoop 恒 true，默认引擎 response 恒空），保留
      // 结构供未来产出 response 的认知引擎使用。
      this.turnLifecycle.finalizeTurn({
        actorId,
        userText: text,
        assistantText: cognitiveResponse,
        sessionId,
      });
      // 流式分片：cognize response 一次性返回，不分片
      opts?.onAssistantDelta?.(cognitiveResponse);
      return { text: cognitiveResponse, streamedChunks: false };
    }
    // cognize 返回 apology 或空内容 → 记日志，让流程继续走 streamCompletion 重建回复
    if (cognitiveResponse && isApologyStyleFallback(cognitiveResponse)) {
      console.log(
        `[AgentCore] cognize 返回 apology 风格回复，降级走 streamCompletion 重建：` +
          `"${cognitiveResponse.slice(0, 80)}" route=${route.plane}`,
      );
    }

    // 性能监控：前置准备阶段
    const prepStartTime = Date.now();

    // 2026-09-05：userLocation / 常去地点改为每轮无条件注入（对话面同样注入）。
    // 旧的两道闸门（fast 跳过、userIsStatingData 跳过）撤销——反问 bug 的根因是注入
    // 文案没禁止反问，已在 resolveUserLocationPrompt 措辞层根治；再跳过注入只会让
    // LLM 失去位置背景、反过来向用户问"你在哪"。

    // 2026-07-29 修复 C1：计算当前 thread store 中实际消息数（不含 system），
    // 用于判断 narrativeRecall 末尾的 [最近对话] 块是否与 msgs 重复。
    // 12 条 ≈ 6 轮 user/assistant 配对；超过此值说明 LLM 已能从 msgs 看到最近对话。
    // 失败时返回 -1（关闭 dedup 判定，保持原行为）。
    const threadMessageCount = this.peekThreadMessageCount(actorId, sessionId);

    // 2026-07-29 修复 D：fast_chat 也注入 narrativeRecall（复用 cognize 召回结果），
    // 解决追问被误判 fast_chat 时 LLM 只有 thread messages、缺乏长期记忆/工作记忆导致答非所问。
    // （原"跳过 userLocation"已于 2026-09-05 撤销，对话面同样注入位置/常去地点背景。）
    //
    // 2026-08-11 修复 E（思路 A）：工作记忆摘要 + 最近对话回顾不再拼入 narrativeRecall，
    // 而是作为独立字段透传给 PromptContextBuilder，作为独立块注入 system prompt。
    // 原实现把它们拼到 narrativeRecall 末尾，被 formatNarrativeRecallPrompt 的 slice(0,4)
    // 当作召回条目丢弃、块结构被拍平、hint 被正则误杀 → agent 看到的上下文跳转、不能针对当前话回复。
    // 话题切换门控：用户真正切换话题（无任务延续/无指代，STM 解析为 topic_switch）时，
    // 抑制长期记忆召回，避免把旧话题/跨会话记忆注入当前新话题（串台根治）。
    // 仅抑制长期记忆（narrativeRecall），当前会话的【最近对话回顾】/STM 上下文仍正常注入。
    //
    // v3 记忆架构读路径（2026-10-22 管道拆除）：长期记忆进上下文只走两条有意路径——
    //   1. 画像层速览常驻（结构化事实块无条件注入，prompt-context-builder）；
    //   2. brain.recall 工具按需检索（chat 车道常驻，模型自主决定何时查记忆）。
    // 原 recallGate / suppressNarrativeRecall / semanticRecallHit 三个恒定门控变量
    // （v3 起即硬编码 trigger:false / true / false）连同下游恒空分支已删除：
    //   - narrativeRecall / recentConversationHistory：恒 undefined（主循环不再生产，
    //     跨会话衔接交给恒驻速览与 brain.recall 工具）；
    //   - journal 当日检索：从未随门控运行过（恒空），整段拆除。
    // 系统不擅自注入旧记忆；话题级防串台由「画像常驻 + 工具拉取」结构性承担。

    const [narrativeRecall, workingMemorySummary, recentConversationHistory, userLocation, personalization, frequentPlaces] =
      route.plane === "chat"
      ? await Promise.all([
          // 对话面记忆注入（v3）：主循环恒 undefined；cognize 召回结果经
          // appendLearningDecisionGuidance 走 belief 提示，长期检索走 brain.recall 工具
          Promise.resolve(undefined) as Promise<string | undefined>,
          // 工作记忆摘要独立透传（不再拼入 narrativeRecall）
          Promise.resolve(cognitiveWorkingMemorySummary || undefined),
          // 跨会话待办衔接块（v3 起恒 undefined，见上注释）
          Promise.resolve(undefined) as Promise<string | undefined>,
          // 2026-09-05：对话面也注入位置背景（纯缓存/按需 RPC，零 LLM）
          ctxTiming("userLocation", this.resolveUserLocationForPrompt(actorId, opts)),
          // 2026-09-29 画像接通对话面：chat 面注入文件画像（轻量切片零副作用；
          // 模板画像不注入）。语气不走 toneGuidance（mood/风格闸单点管）。
          ctxTiming(
            "userProfileChat",
            this.userPersonalizationService?.getProfileOnlySlice(actorId) ??
              Promise.resolve({} as PersonalizationPromptSlice),
          ),
          ctxTiming("frequentPlaces", Promise.resolve(this.resolveFrequentPlacesPrompt(actorId))),
        ])
      : await Promise.all([
          // 任务面同 v3 语义：主循环不擅自注入长期记忆
          Promise.resolve(undefined) as Promise<string | undefined>,
          Promise.resolve(cognitiveWorkingMemorySummary || undefined),
          Promise.resolve(undefined) as Promise<string | undefined>,
          // 2026-09-05：每轮无条件注入（缓存/按需 RPC，零 LLM；措辞层已禁止反问）
          this.resolveUserLocationForPrompt(actorId, opts),
          this.userPersonalizationService?.getPromptSlice(actorId, text) ?? Promise.resolve({}),
          Promise.resolve(this.resolveFrequentPlacesPrompt(actorId)),
        ]);

    // 位置证据门（2026-10-19）：本轮有定位、且定位落到某个"计划搬去 X"的目标地，
    // 才把计划转成现状。**没有位置就不动**——位置是唯一能确定性证明"他真的到了"
    // 的证据；计划到期本身不构成证据（用户可能根本没去，也没说）。
    void this.maybeConfirmPlansByLocation(actorId, userLocation);

    const enrichedNarrativeRecall = appendLearningDecisionGuidance(
      narrativeRecall,
      cognitiveRecallItems,
    );

    const prepDuration = Date.now() - prepStartTime;
    if (turnT0 > 0) {
      // eslint-disable-next-line no-console
      console.info(
        `[turn-timing] session=${sessionId?.slice(0, 24)} routeMs=${turnRouteDone - turnT0} ` +
          `cognizeExtraMs=${turnCognizeDone - turnRouteDone} ctxMs=${prepDuration} ` +
          `preMainMs=${Date.now() - turnT0} ctxDoneAt=${Date.now()}`,
      );
    }

    const access = this.streamAccessFields(actorId, opts);
    const orchestrateOpts = this.buildOrchestrateOpts(
      actorId,
      text,
      opts,
      enrichedNarrativeRecall,
      personalization,
      access,
      sessionId,
      shortTermTurn,
      workingMemorySummary,
      recentConversationHistory,
    );

    try {
      let result: AgentReply;

      // 2026-08-29 桌面自动化特判已删除：桌面任务与一切任务轮统一走
      // plan-and-execute（desktop.visual.run_task / desktop.run_preset 等工具
      // 在 complex 全量工具目录内，长链路 UI 操作由工具内部的多轮执行承担）。

if (route.plane === "task") {
        // 任务面（2026-09-08 异步收尾改造，2026-09-09 复杂度门控）：真后台派发只留给
        // 重型任务（multi-step / pro 档，budget≥3）——登记 TaskHub（对话流即出
        // 「任务回执」状态屏）后本轮立即结束，对话窗马上回到空闲态；结果由后台完成后
        // 以 source=task_plane 的独立消息回灌（dispatchBackgroundTask 内置
        // chat.task_update 生命周期广播 + 结果投递 + 离线 outbox 重放，用户中途继续
        // 对话不丢结果）。轻任务（realtime_lookup/media_retrieval，flash 档单点执行）
        // 不出回执：落到下方 launchComplexBackgroundTask 原地同步执行，结果当轮直接
        // 回复，且走正常 provider 路径、用户原话正常落 thread——修「重新找」类短指代
        // 下一轮失忆（后台 ephemeral 执行不写 user 消息，路由层读不到上一轮）。
        // 仅 WS 对话路径开启（opts.taskPlaneAsync）；agent 中继/HTTP/link 等程序化
        // 调用方保持旧行为（本轮等待任务完成并交付结果文本）。派发通道未就绪时
        // 回退原地执行，任务不被静默丢弃。
        // 重活阈值（2026-10-07 修正）：2026-09-23 预算整体 +1（realtime/media
        // 2→3、multi-step 3→4）后本闸未跟调，`budget >= 3` 恒真导致轻任务也
        // 全量进后台出回执——「简单任务当轮直接完成返回」失效。现对齐路由表：
        // 只有 pro 档（multi_step_task，budget=4）才算重活派后台；flash 档
        //（realtime_lookup/media_retrieval，budget=3）一律原地同步执行当轮回复。
        const heavyTaskPlane = route.tier === "pro" || route.budget >= 4;
        if (opts?.taskPlaneAsync && heavyTaskPlane) {
          const dispatchedTaskId = this.dispatchBackgroundTask(actorId, {
            sessionId,
            ...(opts.chatUserMessageId ? { chatUserMessageId: opts.chatUserMessageId } : {}),
            goal: text,
            source: "route_task_plane",
            // 路由派发按意图档位走完整通道：realtime/media=delegate 能力束注入
            //（search_web/search_images 直接可见），multi-step=planner。快车道桥
            // 工具两跳召回不可靠，是「任务没真办、口头编结果」的根因（2026-09-09）。
            turnPlan: { budget: route.budget, capabilities: route.capabilities, tier: route.tier },
            fullChannel: true,
            // 外部轮已装配的上下文（2026-09-09）：后台 ephemeral 执行 msgs=[] 不读
            // thread，以下块是后台执行唯一的记忆来源；route 复用外部语义路由结果，
            // 避免内层对裸 goal 重新路由（短 goal 可能被改判 chat 面而跳过工具）。
            route,
            narrativeRecall: enrichedNarrativeRecall,
            workingMemorySummary,
            recentConversationHistory,
            userLocation,
            frequentPlaces,
            personalization,
            shortTermTurn,
            orchestrateToolCtx: orchestrateOpts,
            cognitiveEmotion,
            cognitiveUserPattern,
            cognitiveToolPlan,
          });
          if (dispatchedTaskId) {
            this.turnLifecycle.finalizeTurn({
              actorId,
              userText: text,
              assistantText: "",
              sessionId,
              understanding: route.understanding,
            });
            return { text: "", streamedChunks: false, taskDispatched: true };
          }
          console.warn("[AgentCore] 任务面异步派发通道未就绪，回退原地执行任务面");
        }
        // 后台 plan-and-execute 执行，完成后结果作为本轮完整回复回灌对话。
        // 执行期间用户可继续发消息（新消息走新 turn，任务不继承外层 signal，不被中断）。
        const complexResult = await this.launchComplexBackgroundTask(actorId, text, opts, {
          narrativeRecall: enrichedNarrativeRecall,
          workingMemorySummary,
          recentConversationHistory,
          userLocation,
          frequentPlaces,
          personalization,
          orchestrateOpts,
          sessionId,
          shortTermTurn,
          cognitiveEmotion,
          cognitiveUserPattern,
          cognitiveToolPlan,
          turnPlan: { budget: route.budget, capabilities: route.capabilities, tier: route.tier },
          webSearchForbidden,
        });

// complex 任务已完成，返回最终结果
        result = {
          text: complexResult,
          streamedChunks: true,
        };
        return result;
      }

      // fast 路径：同步执行（秒回）
      const standardStartTime = Date.now();

      result = await this.runStandardLlmPath(actorId, text, "chat", opts, {
        narrativeRecall: enrichedNarrativeRecall,
        workingMemorySummary,
        recentConversationHistory,
        userLocation,
        frequentPlaces,
        personalization,
        orchestrateToolCtx: orchestrateOpts,
        sessionId,
        shortTermTurn,
        cognitiveEmotion,
        cognitiveUserPattern,
        cognitiveToolPlan,
        webSearchForbidden,
      });

      const standardDuration = Date.now() - standardStartTime;

      // 记录标准模式性能
      this.recordPerformanceMetrics('standard_llm', {
        totalDuration: Date.now() - perfStartTime,
        preparationDuration: prepDuration,
        llmDuration: standardDuration,
        textLength: text.length,
        plane: route.plane,
        hasTools: !!result.toolName,
        modelCallsConsumed: 1, // 简化统计
        success: true,
      });

      return result;
      
    } catch (err) {
      // 用户发新消息或取消导致的中断:不触发降级/emergencyRegenerate,直接返回空串。
      // 调用方(chat-user-message)通过 isStale() 门控,不会推送此空结果给用户。
      if (err instanceof Error && (err.name === "AbortError" || opts?.signal?.aborted)) {
        console.log("[AgentCore] LLM 请求被中断(用户发新消息或取消),跳过重生成");
        return { text: "", streamedChunks: false };
      }

      const errorDuration = Date.now() - perfStartTime;

      // 记录错误性能指标
      this.recordPerformanceMetrics('error', {
        totalDuration: errorDuration,
        preparationDuration: prepDuration,
        textLength: text.length,
        plane: route.plane,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });

      if (route.plane === "task") {
        console.error("[AgentCore] Master Agent orchestration failed, falling back to standard mode:", err);
        try {
          return await this.runStandardLlmPath(actorId, text, "chat", opts, {
            narrativeRecall: enrichedNarrativeRecall,
            workingMemorySummary,
            recentConversationHistory,
            userLocation,
            frequentPlaces,
            personalization,
            orchestrateToolCtx: orchestrateOpts,
            sessionId,
            shortTermTurn,
            cognitiveUserPattern,
            cognitiveToolPlan,
          });
        } catch (retryErr) {
          // 降级也失败：不再用 apology 兜底文案，尝试一次最小化 LLM 调用生成回复
          console.error("[AgentCore] direct_llm 降级也失败，尝试最小化重生成:", retryErr);
          const emergencyText = await this.emergencyRegenerate(actorId, text, opts?.onAssistantDelta);
          return { text: emergencyText, streamedChunks: false };
        }
      }
      // 非 master 模式失败：不再用 apology 兜底文案，尝试一次最小化 LLM 调用生成回复
      console.error("[AgentCore] runStandardLlmPath 失败，尝试最小化重生成:", err);
      const emergencyText = await this.emergencyRegenerate(actorId, text, opts?.onAssistantDelta);
      return { text: emergencyText, streamedChunks: false };
    }
  }

  /**
   * 性能监控记录器
   */
  private recordPerformanceMetrics(
    mode: string,
    metrics: Record<string, unknown>
  ): void {
    const logData = {
      timestamp: new Date().toISOString(),
      mode,
      ...metrics,
    };
    
    // 可选：发送到外部监控系统（如 Prometheus、Datadog 等）
    if (process.env.PERFORMANCE_MONITORING_ENABLED === '1') {
      this.sendToMonitoringSystem(logData).catch((err) => {
        // 静默处理监控上报失败
      });
    }
  }

  /**
   * 发送性能数据到外部监控系统（可扩展实现）
   */
  private async sendToMonitoringSystem(data: Record<string, unknown>): Promise<void> {
    // TODO: 集成到你的监控系统
    // 示例：
    // await fetch('https://your-monitoring-api.com/metrics', {
    //   method: 'POST',
    //   body: JSON.stringify(data),
    //   headers: { 'Content-Type': 'application/json' }
    // });
    
    // 当前仅记录到控制台，可后续扩展
    if (process.env.NODE_ENV === 'development') {
      // 开发环境可在此添加调试逻辑
    }
  }

  /**
   * 服务重启后自动恢复未完成的自主任务（状态机任务，AgentTaskOrchestrator 主循环）。
   *
   * 恢复 pending / planning / executing / verifying 的任务（从持久化的断点继续执行）；
   * 跳过 paused（用户主动暂停，保持暂停待手动恢复）和 awaiting_approval（等待人工审批，不得自动放行）。
   * 任务进度通过 WS 推送 ChatExecutionEvent（kind=task_progress）。
   *
   * @returns 恢复的任务数量
   */
  resumeAutonomousTasks(): number {
    const orchestrator = this.agentTaskOrchestrator;
    const registry = this.wsRegistry;
    if (!orchestrator) {
      console.warn("[agent-core] orchestrator 未初始化，跳过自主任务恢复");
      return 0;
    }

    const store = getAgentTaskStore();
    const runnable = store.list().filter(
      (t) =>
        t.status === "pending" ||
        t.status === "planning" ||
        t.status === "executing" ||
        t.status === "verifying",
    );
    if (runnable.length === 0) return 0;

    const options: RunTaskOptions = {
      onProgress: (event) => {
        if (!registry) return;
        try {
          registry.trySend(
            event.sessionId,
            JSON.stringify({
              type: ServerEventType.ChatExecutionEvent,
              payload: {
                kind: "task_progress",
                ...event,
              },
            }),
          );
        } catch {
          // 静默失败
        }
        // 后台任务失败时推送 fallback 文案，让用户知道任务没成功
        if (event.type === "task_failed") {
          try {
            registry.trySend(
              event.sessionId,
              JSON.stringify({
                type: ServerEventType.ChatAssistantChunk,
                payload: {
                  messageId: event.taskId,
                  delta: FALLBACK_TEXT_BACKGROUND_FAILED(),
                  source: "task_resume",
                },
              }),
            );
          } catch {
            /* ignore */
          }
        }
      },
    };

    let restored = 0;
    for (const task of runnable) {
      if (orchestrator.resumeTask(task.id, options)) {
        restored += 1;
        console.log(
          `[agent-core] 重启恢复自主任务 ${task.id} (status=${task.status}, goal=${task.goal.slice(0, 60)})`,
        );
      }
    }
    if (restored > 0) {
      console.log(`[agent-core] 共自动恢复 ${restored} 个未完成的自主任务`);
    }
    return restored;
  }

  /**
   * 外部触发器提交一个后台自主任务（地理围栏 agent_task 动作的执行面）。
   * 复用任务状态机的完整骨架：持久化 + WS 进度推送 + 完成主动告知。
   * 返回 taskId；orchestrator 未初始化（无 LLM 通道）时返回 null。
   */
  submitAutonomousTask(actorId: string, goal: string, sessionId?: string): string | null {
    const orchestrator = this.agentTaskOrchestrator;
    if (!orchestrator) {
      console.warn("[agent-core] orchestrator 未初始化，丢弃外部提交的自主任务");
      return null;
    }
    const registry = this.wsRegistry;
    const sid = sessionId?.trim() || actorId;
    const options: RunTaskOptions = {
      onProgress: (event) => {
        if (!registry) return;
        try {
          registry.trySend(
            event.sessionId,
            JSON.stringify({
              type: ServerEventType.ChatExecutionEvent,
              payload: {
                kind: "task_progress",
                ...event,
              },
            }),
          );
        } catch {
          // 静默失败
        }
      },
    };
    const taskId = orchestrator.createAndRun(
      {
        actorId,
        sessionId: sid,
        goal,
        tags: ["geofence"],
      },
      options,
    );
    console.log(`[agent-core] 外部自主任务已入队 ${taskId} (goal=${goal.slice(0, 60)})`);
    return taskId;
  }

  async runToolIfNeeded(
    actorId: string,
    reply: AgentReply,
    opts?: {
      sessionId?: string;
      chatUserMessageId?: string;
      userId?: string;
      clientIp?: string;
      clientLocation?: ClientLocationWire;
      agentAccessMode?: AgentAccessMode;
      /** 中途推卡：购物等长工具把二维码即时呈现给用户（聊天主路径装配） */
      pushMediaCards?: (cards: ToolMediaCard[]) => void;
    },
  ): Promise<{ ok: boolean; result?: Record<string, unknown> }> {
    if (!reply.toolName || !reply.toolInput) return { ok: true };
    // 工具调用前置安全检查统一由 BrainCenter + AgentTaskSafety 负责（含原 RuntimeKernel.checkToolAction 的工具名规则）
    const brainSafety = this.brainCenter?.checkSafety(
      { tool: reply.toolName, args: reply.toolInput },
      { actorId, sessionId: opts?.sessionId ?? actorId },
    );
    if (brainSafety && !brainSafety.allowed) {
      return {
        ok: false,
        result: {
          error: brainSafety.reason,
          severity: brainSafety.severity,
          blockedBy: "brain_center",
        },
      };
    }
    // Task 12 工具下沉：先尝试 BodyGateway 路由（前缀匹配 → BodyModule.act + 反射弧硬安全门），
    // 未下沉工具（hasRoute=false）走原 toolRegistry 直连路径。
    // BodyGateway 内部对未覆盖的具体工具会自动降级到 fallbackToolRegistry（仍走 toolRegistry.execute）。
    const bodyGw = this.brainCenter?.getBodyGateway();
    if (bodyGw && bodyGw.hasRoute(reply.toolName)) {
      return bodyGw.execute({
        tool: reply.toolName,
        args: reply.toolInput,
        actorId,
        source: "runToolIfNeeded",
      });
    }
    return this.toolRegistry.execute(reply.toolName, reply.toolInput, {
      sessionId: opts?.sessionId ?? actorId,
      userId: opts?.userId,
      chatUserMessageId: opts?.chatUserMessageId,
      clientIp: opts?.clientIp,
      clientLocation: opts?.clientLocation,
      agentAccessMode: opts?.agentAccessMode,
      desktopBridgeOnline: this.desktopBridgeOnlineFor(actorId),
      phoneBridgeOnline: this.phoneBridgeOnlineFor(actorId),
      // 按需位置：自主任务/日程触发的工具（如天气）缺经纬度时也能向客户端请求实时 GPS
      requestLocation: () =>
        this.locationCoordinator?.requestLocation(actorId, `tool:${reply.toolName}`) ??
        Promise.resolve(null),
      // 中途推卡：购物等长工具把二维码即时呈现给用户（聊天主路径装配）
      pushMediaCards: opts?.pushMediaCards,
    });
  }

  private isTaskLane(mode: LlmExecutionMode): boolean {
    return mode === "task";
  }

  private isChatLane(mode: LlmExecutionMode): boolean {
    return mode === "chat";
  }

  private pickToolNamespace(toolName: string): string | null {
    if (!toolName) return null;
    const dotIndex = toolName.indexOf(".");
    if (dotIndex > 0) return toolName.slice(0, dotIndex);
    const underscoreIndex = toolName.indexOf("_");
    if (underscoreIndex > 0) return toolName.slice(0, underscoreIndex);
    return toolName === "unknown" ? null : "misc";
  }

  /**
   * 把 cognize 阶段已召回的 MemoryRecallItem[] 拼接为 narrative recall 字符串（复用召回结果，替代 prepareNarrativeRecall）。
   * P0/P4：每条带「[相对时间·记忆类型]」前缀（程序化计算，杜绝 LLM 生成时间标签失真），
   * 让 LLM 清楚知道每条记忆是什么时候发生的、属于哪类记忆，回答时不会张冠李戴。
   */
  private recallItemsToNarrative(items: MemoryRecallItem[]): string | undefined {
    const lines = items
      .map((it) => {
        const content = typeof it?.content === "string" ? it.content.trim() : "";
        if (!content) return null;
        const tag = [describeMemoryAge(it.timestamp), MEMORY_DOMAIN_LABELS[it.domain]].filter(Boolean).join("·");
        return tag ? `[${tag}] ${content}` : content;
      })
      .filter((x): x is string => x !== null);
    return lines.length > 0 ? lines.join("\n") : undefined;
  }

  /** prompt 位置新鲜窗口：窗口内直接用缓存，超窗才向客户端要一次 GPS（≤1 次/窗口/actor）。 */
  private static readonly PROMPT_LOCATION_FRESH_MS = 5 * 60 * 1000;
  /** 按要 GPS 的失败冷却：客户端离线/拒绝定位时，避免每条消息都白等 6s 超时。 */
  private static readonly PROMPT_LOCATION_RETRY_MS = 10 * 60 * 1000;
  /** 常去地点缓存 TTL。 */
  private static readonly FREQUENT_PLACES_TTL_MS = 10 * 60 * 1000;

  /**
   * Prompt 阶段的位置注入（全链路零 LLM）：
   * 消息自带位置 → 新鲜缓存 →（客户端在线且未在冷却期）按需拉一次实时 GPS
   * （纯 WS RPC，6s 超时）→ 仍无则退回旧缓存并标注「定位于 N 前」。
   * 旧策略"只读缓存不请求"导致缓存一空 LLM 就反问位置，2026-09-05 改为按需补拉。
   */
  private async resolveUserLocationForPrompt(
    actorId: string,
    opts?: { clientIp?: string; clientLocation?: ClientLocationWire },
  ): Promise<string | undefined> {
    const coordinator = this.locationCoordinator;
    let location: ClientLocationWire | undefined = opts?.clientLocation;
    let observedAt = location ? Date.now() : undefined;

    if (!location && coordinator) {
      const cached = coordinator.getCachedWithTime(actorId);
      if (cached && Date.now() - cached.at <= AgentCore.PROMPT_LOCATION_FRESH_MS) {
        location = cached.payload;
        observedAt = cached.at;
      }
    }

    if (!location && coordinator?.hasSocket(actorId)) {
      const lastAttempt = this.promptLocationLastAttemptAt.get(actorId) ?? 0;
      if (Date.now() - lastAttempt >= AgentCore.PROMPT_LOCATION_RETRY_MS) {
        this.promptLocationLastAttemptAt.set(actorId, Date.now());
        // 后台补位（2026-09-28 根修）：位置只是 prompt 背景注入，绝不阻塞主回复。
        // 此前 await requestLocation——客户端不回位置包时干等满 6s requestTimeout
        //（新会话首轮必中，实测把 pre-main 拖到 7s+）。改为只发起不等待：回包
        // 由 completeFromSocket 写缓存，供下一轮注入；本轮用旧缓存或无位置。
        // 实时等待语义保留给工具路径（weather.get_local 等经 tool-context 的
        // requestLocation），那里拿不到位置可以明确兜底。
        void coordinator
          .requestLocation(actorId, "prompt:chat-context")
          .catch(() => {
            /* 超时/失败静默：缓存未更新，下一窗口重试 */
          });
      }
    }

    if (!location && coordinator) {
      const stale = coordinator.getCachedWithTime(actorId);
      if (stale) {
        location = stale.payload;
        observedAt = stale.at;
      }
    }

    const prompt = await resolveUserLocationPrompt({
      clientIp: opts?.clientIp,
      clientLocation: location,
    });
    if (!prompt || observedAt == null) return prompt;
    const ageMin = Math.floor((Date.now() - observedAt) / 60_000);
    if (ageMin < 5) return prompt;
    const ageText = ageMin < 60 ? `${ageMin} 分钟前` : `${Math.floor(ageMin / 60)} 小时前`;
    return `${prompt}（定位时间：${ageText}，非实时）`;
  }

  /**
   * 位置证据门（2026-10-19）：只有定位真的落到计划目标地，才把「计划搬去 X」
   * 转成现状。计划到期本身**不是**证据（用户可能没去、也没说），所以这条通道
   * 与 sweep 严格分离：sweep 只降级为"未确认"，这里才是唯一的自动转正入口。
   *
   * 同一位置文本只尝试一次（进程内缓存），避免每轮查库；确认失败静默。
   */
  private maybeConfirmPlansByLocation(actorId: string, userLocation: string | undefined): void {
    const loc = userLocation?.trim();
    if (!loc) return;
    // 陈旧定位不构成证据：resolveUserLocationForPrompt 对超过 5 分钟的定位会附
    // "（定位时间：X 小时前，非实时）"。拿三天前的缓存位置确认"他搬到了成都"，
    // 等于用旧证据改档案——直接跳过。
    if (loc.includes("非实时")) return;
    if (planLocationLastAttempt.get(actorId) === loc) return;
    planLocationLastAttempt.set(actorId, loc);
    void (async () => {
      try {
        const { getMemoryComponents } = await import("../agentic-memory/index.js");
        const store = getMemoryComponents().factStore;
        if (!store) return;
        const confirmed = store.confirmPlansByLocation(actorId, loc);
        if (confirmed.length > 0) {
          console.info(
            `[structured-facts] 位置证据确认计划 actor=${actorId} ` +
              confirmed.map((c) => `${c.field}=${c.value}`).join(", "),
          );
        }
      } catch {
        /* 记忆组件未装配 / 查询失败 → 忽略（不影响本轮回复） */
      }
    })();
  }

  /**
   * 常去地点背景块（零 LLM）：位置历史 DBSCAN 聚类结果直接格式化注入，
   * 进程内按 actor 缓存 10 分钟。minPoints 放宽到 3——按需模式样本稀疏
   * （每日启动/工具触发各 1 条），沿用持续模式的 20 会永远聚不出簇。
   */
  private resolveFrequentPlacesPrompt(actorId: string): string | undefined {
    const history = this.locationHistory;
    if (!history) return undefined;
    const cached = this.frequentPlacesCache.get(actorId);
    if (cached && Date.now() - cached.at <= AgentCore.FREQUENT_PLACES_TTL_MS) return cached.text;

    let text: string | undefined;
    try {
      const places = history.mineFrequentPlaces(actorId, { maxPlaces: 5, minPoints: 3 });
      if (places.length > 0) {
        const lines = places.map((p, i) => {
          const name = p.label?.trim() || `${p.latitude.toFixed(3)}, ${p.longitude.toFixed(3)}`;
          return `${i + 1}. ${name}｜到访 ${p.visitCount} 次 · 覆盖 ${p.distinctDays} 天 · 最近 ${p.lastSeenAt.slice(0, 10)}`;
        });
        text = [
          "由用户位置历史自动聚类得出（系统背景，禁止主动向用户提及或反问本块；",
          "回答「我常去哪/家/公司在哪」类问题时应以此为据，不确定时如实说明）：",
          ...lines,
        ].join("\n");
      }
    } catch {
      text = undefined;
    }
    this.frequentPlacesCache.set(actorId, { text, at: Date.now() });
    return text;
  }

  // buildRecentConversationHistoryBlock 已随 recallGate 管道拆除（2026-10-22）：
  // v3 起主循环恒不注入该块，跨会话开放环路经恒驻速览与 brain.recall 承担。

  /**
   * 2026-07-29 修复 C1 配套：窥探当前 thread store 中的非 system 消息条数。
   * - 成功：返回 user/assistant 消息总数（不含 system）
   * - 失败：返回 -1（关闭 dedup 判定，保持原追加行为）
   *
   * 调用栈：narrativeRecall 准备阶段，用于判断 [最近对话] 块是否与 msgs 重复。
   * 不修改 thread store，纯查询。
   */
  private peekThreadMessageCount(actorId: string, sessionId?: string): number {
    try {
      const chatSessionId = resolvePrimaryChatSessionId(
        actorId,
        getAgentRuntimeConfig().masterDelegation.enabled,
      );
      const threadStore = getChatThreadStore();
      const messages = threadStore.thread(chatSessionId, "");
      let count = 0;
      for (const m of messages) {
        if (m && (m.role === "user" || m.role === "assistant")) count++;
      }
      return count;
    } catch (err) {
      console.log(`[AgentCore] peekThreadMessageCount 失败（忽略，关闭 dedup）: ${err}`);
      return -1;
    }
  }

  private buildOrchestrateOpts(
    actorId: string,
    userText: string,
    opts: HandleUserMessageOptions | undefined,
    narrativeRecall: string | undefined,
    personalization: PersonalizationPromptSlice,
    access: { agentAccessMode: AgentAccessMode; desktopBridgeOnline: boolean; phoneBridgeOnline: boolean },
    sessionId: string,
    shortTermTurn: ShortTermTurnContext,
    workingMemorySummary: string | undefined,
    recentConversationHistory: string | undefined,
  ) {
    const onBatchFromCaller = opts?.onToolLoopAfterBatch;

    return {
      chatUserMessageId: opts?.chatUserMessageId,
      sessionId,
      userId: opts?.userId,
      clientIp: opts?.clientIp,
      clientLocation: opts?.clientLocation,
      agentAccessMode: access.agentAccessMode,
      desktopBridgeOnline: access.desktopBridgeOnline,
      phoneBridgeOnline: access.phoneBridgeOnline,
      toolRankingHint: this.toolPolicyResolver.resolveRankingHint(actorId),
      visionFrames: opts?.visionFrames,
      interruptedContext: opts?.interruptedContext,
      narrativeRecall,
      workingMemorySummary,
      recentConversationHistory,
      personalization,
      // v3 门控单点已随 recallGate 管道拆除（2026-10-22）：KV 长期字段注入与否
      // 由 prompt-context-builder 内的 v3 常量语义（longTermEnabled=false）决定，
      // 长期检索统一走 brain.recall 工具。
      onToolExecuteStart: opts?.onExternalToolExecuteStart,
      onAgentStatusLine: opts?.onAgentPhaseStatus,
      onToolExecuted: (info: ToolExecutedInfo) => {
        opts?.onExternalToolExecuted?.(info);
        // 失败时自我学习闭环：把工具调用结果（含失败）写入 selfLearning
        // → DMN 周期扫描时即可读到失败轨迹 → 触发 proposeEvolution 生成进化提案
        this.brainCenter?.recordToolInteraction({
          actorId,
          sessionId,
          userRequest: userText,
          attemptedTools: [info.toolName],
          success: info.ok,
          errorMessage: info.ok
            ? undefined
            : typeof info.result?.error === "string"
              ? String(info.result.error).slice(0, 200)
              : undefined,
        });
      },
      onToolLoopAfterBatch: onBatchFromCaller,
      // 记忆架构重构：thread 消息数透传给 prompt 装配层（长期快照注入门控用）
      threadMessageCount: this.peekThreadMessageCount(actorId, sessionId),
    };
  }

  /**
   * 任务面提交（2026-09-05 双面架构）：后台 plan-and-execute 执行任务，返回最终结果文本。
   *
   * 与对话面的衔接契约（TaskHub）：
   *   - 提交即登记 TaskRecord（绑定 replyAnchorId），出口事件与结果都属于任务本身，
   *     用户中途继续对话（新 turn）不会让结果丢失；
   *   - 结果非空兜底：杜绝"调用工具但结果空转"→ 前端只有进度、正文缺失的残链；
   *   - 后台执行不继承外层 signal（避免用户发新消息时中断后台任务）。
   */
  private launchComplexBackgroundTask(
    actorId: string,
    text: string,
    opts: HandleUserMessageOptions | undefined,
    ctx: {
      narrativeRecall?: string;
      workingMemorySummary?: string;
      recentConversationHistory?: string;
      userLocation?: string;
      /** 常去地点背景块（DBSCAN 纯算法挖掘，零 LLM） */
      frequentPlaces?: string;
      orchestrateOpts: ReturnType<AgentCore["buildOrchestrateOpts"]>;
      personalization: PersonalizationPromptSlice;
      sessionId: string;
      shortTermTurn: ShortTermTurnContext;
      cognitiveEmotion?: import("../brain/types.js").EmotionVector | null;
      cognitiveUserPattern?: {
        topics: string[];
        preferredToolDomain?: string;
        negativeFeedbackCount: number;
        learningActive?: boolean;
      };
      cognitiveToolPlan?: import("../brain/tool-planning-cortex.js").ToolPlan;
      /** 路由层 TurnPlan：任务面预算/能力/档位 */
      turnPlan?: { budget: number; capabilities: string[]; tier: string };
      /** 路由意图标签（透传给执行层，前置检索/误判转任务共用） */
      routeIntent?: string;
      /** 路由置信度（2026-09-23 观测补全，透传 turn-trace） */
      routeConfidence?: number;
      /**
       * realtime_lookup 轮由路由器生成的搜索词（2026-09-13 根修）：realtime 意图
       * 路由到任务面，前置检索必须随行透传到这里，再传给 runStandardLlmPath——
       * 否则「扣子式先搜后答」只存在于对话面，任务面 realtime 轮退化为模型自决
       * （可推脱不搜、凭 thread 旧回复复读）。
       */
      routeSearchQuery?: string;
      /** travel_planning 轮由路由器代码构造的行程请求参数（确定性预执行用）。 */
      routeTravelPlanRequest?: TravelPlanRequest;
      /** 投机并行搜索结果（路由无查询词的保守降级轮复用），见 handleUserMessage。 */
      specEvidence?: Promise<string | null>;
      /** 显式禁网轮（2026-09-23）：跳过证据注入、剥离联网工具、注入禁网说明。 */
      webSearchForbidden?: boolean;
    },
  ): Promise<string> {
    const onDelta = opts?.onAssistantDelta;
    // 后台执行不继承外层 signal（turn 已返回占位，避免用户发新消息时中断后台任务）
    const bgOpts: HandleUserMessageOptions | undefined = opts
      ? { ...opts, signal: undefined }
      : opts;

    // TaskHub 登记：任务面对话面接缝的唯一记录（进度摘要注入路由、结果归属任务）。
    // quiet=true（2026-09-09）：原地同步执行的任务只记账（路由摘要/取消/进度），
    // 不广播 chat.task_update「任务回执」——回执只属于真后台派发，轻任务当轮
    // 直接回复，不再出现「后台正在任务」状态屏。
    const taskHub = getTaskHub();
    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const record = taskHub.submit({
      taskId,
      sessionId: ctx.sessionId,
      ...(opts?.chatUserMessageId ? { replyAnchorId: opts.chatUserMessageId } : {}),
      goal: text,
      quiet: true,
    });
    // 提交即出一条状态行，盖住路由/brief 装配/首次规划的无反馈窗口
    opts?.onAgentPhaseStatus?.("开始处理任务…");

    // 返回 Promise，在任务面完成时 resolve 最终结果文本
    return new Promise<string>((resolve, reject) => {
      const run = async (): Promise<void> => {
        try {
          const result = await this.runStandardLlmPath(actorId, text, "task", bgOpts, {
            narrativeRecall: ctx.narrativeRecall,
            workingMemorySummary: ctx.workingMemorySummary,
            recentConversationHistory: ctx.recentConversationHistory,
            userLocation: ctx.userLocation,
            frequentPlaces: ctx.frequentPlaces,
            orchestrateToolCtx: ctx.orchestrateOpts,
            personalization: ctx.personalization ?? {},
            sessionId: ctx.sessionId,
            shortTermTurn: ctx.shortTermTurn,
            cognitiveEmotion: ctx.cognitiveEmotion,
            cognitiveUserPattern: ctx.cognitiveUserPattern,
            cognitiveToolPlan: ctx.cognitiveToolPlan,
            turnPlan: ctx.turnPlan,
            taskHubTaskId: taskId,
          });
          // 结果兜底：任务面必须产出非空最终文本
          const trimmed = (result.text ?? "").trim();
          if (trimmed) {
            taskHub.setState(taskId, "done");
            resolve(trimmed);
            return;
          }
          console.warn(`[AgentCore][task-plane] "${text}" 返回空结果，尝试应急重生成`);
          const emergencyText = await this.emergencyRegenerate(actorId, text, onDelta);
          const finalText = emergencyText.trim();
          taskHub.setState(taskId, finalText ? "done" : "failed");
          resolve(finalText);
        } catch (err) {
          taskHub.setState(taskId, "failed");
          reject(err);
        }
      };

      // 任务面在主线程并发执行（event loop 非阻塞，用户可继续对话）。
      // 旧 runComplexTaskInWorker 的 worker_threads 包装从未启用（useWorker 恒 false），已删除。
      void run().catch((err) => {
        console.error("[AgentCore] 任务面执行异常:", err);
        reject(err);
      });
    });
  }

  private async runStandardLlmPath(
    actorId: string,
    text: string,
    mode: LlmExecutionMode,
    opts: HandleUserMessageOptions | undefined,
    ctx: {
      narrativeRecall?: string;
      /** 当前工作记忆摘要（独立块注入，不再拼入 narrativeRecall） */
      workingMemorySummary?: string;
      /** 最近对话回顾（独立块注入，thread 较短时填充） */
      recentConversationHistory?: string;
      userLocation?: string;
      /** 常去地点背景块（DBSCAN 纯算法挖掘，零 LLM） */
      frequentPlaces?: string;
      /** 后台派发路径（dispatchBackgroundTask）可不传：执行层逐项可选化 */
      orchestrateToolCtx?: ReturnType<AgentCore["buildOrchestrateOpts"]>;
      personalization?: PersonalizationPromptSlice;
      sessionId: string;
      shortTermTurn?: ShortTermTurnContext;
      /**
       * r5: cognize 阶段已评估的情绪，由本函数格式化为方向化短字符串
       * 注入 promptContext.memory.emotionState。
       * 缺失（无 BrainCenter / cognize 未跑）时跳过注入。
       */
      cognitiveEmotion?: import("../brain/types.js").EmotionVector | null;
      /** 深度优化：用户画像，注入 prompt 让 LLM 感知用户偏好/习惯/否定模式 */
      cognitiveUserPattern?: {
        topics: string[];
        preferredToolDomain?: string;
        negativeFeedbackCount: number;
        learningActive?: boolean;
      };
      /** 深度优化：工具规划链（来自 ToolPlanningCortex），约束 LLM 工具选择顺序和范围 */
      cognitiveToolPlan?: import("../brain/tool-planning-cortex.js").ToolPlan;
      /** 路由层 TurnPlan：任务面预算/能力/档位（对话面不传） */
      turnPlan?: { budget: number; capabilities: string[]; tier: string };
      /** TaskHub 任务记录 id（任务面传入，用于进度摘要回写） */
      taskHubTaskId?: string;
      /**
       * token 审计 stage 覆盖（2026-10-01 goal 车道归因）：后台派发方指定时
       * 优先于 task_plane_light/full——goal 步骤任务单列 goal_plan_stage，
       * 主动性成本线在 usage 台账里可见。
       */
      auditStageOverride?: string;
      /** 路由意图标签（对话面误判转任务的自检输入） */
      routeIntent?: string;
      /** 路由置信度（2026-09-23 观测补全，透传 turn-trace） */
      routeConfidence?: number;
      /** realtime_lookup 轮由路由器生成的搜索词（前置检索用，见 runFreshEvidenceSearch）。 */
      routeSearchQuery?: string;
      /** travel_planning 轮由路由器代码构造的行程请求参数（确定性预执行用）。 */
      routeTravelPlanRequest?: TravelPlanRequest;
      /**
       * 投机并行搜索（2026-09-13）：路由判定期间已用用户原话发起的搜索 Promise。
       * 路由产出查询词时弃用（用更准的 route_query 重搜）；路由保守降级/超时
       * 无查询词时直接复用——保守降级轮不再零证据裸奔。
       */
      specEvidence?: Promise<string | null>;
      /** 显式禁网轮（2026-09-23）：跳过证据注入、剥离联网工具、注入禁网说明。 */
      webSearchForbidden?: boolean;
      /** ephemeral 执行（后台任务派发用）：不自动落 thread，由派发方显式并入 */
      ephemeralTurn?: boolean;
      /**
       * 后台派发路径的工具结果捕获（orchestrateToolCtx 缺位时的 media 卡片数据源）：
       * dispatchBackgroundTask 用它收集 search_images/search_videos 结果，随任务
       * 结果消息投递 mediaCards（否则照片任务只有文字、卡片永远到不了客户端）。
       */
      backgroundOnToolExecuted?: (info: ToolExecutedInfo) => void;
      /**
       * 快速通道（2026-09-05）：跳过 planner，可见工具 = 桥工具（tool_discover/
       * tool_call），一切业务工具由 tool router（BM25 目录）按需召回——执行侧
       * 上下文零业务 schema。默认快速起步，失败由派发方升级完整通道。
       */
      toolRecallOnly?: boolean;
      /**
       * 单轮 LLM 主路径预算（阶段2-1）：首次进入时自动创建并占用主调用槽位，
       * 升级重跑（意图升级/出口闸）经 tryUpgrade 扣减，默认上限 3 次。
       * 递归时随 {...ctx} 透传同一实例，保证整轮共享预算。
       */
      turnBudget?: TurnBudget;
    },
  ): Promise<AgentReply> {
    const provider = this.chatProviderFor(actorId)!;
    // 预算入口：外部未携带（首次进入/后台派发）则新建并登记主调用
    const turnBudget = ctx.turnBudget ?? new TurnBudget();
    if (!ctx.turnBudget) turnBudget.consumeMainPath();
    /** 本轮是否执行过任何工具（出口诚实闸的「动作」一侧证据）。 */
    let toolExecutedThisTurn = false;
    /** 任务面进度步数（task.status / 回执 progressLine 用，2026-09-19 P0-2） */
    let taskProgressSteps = 0;
    /** 本轮是否注入过前置检索证据（搜索宣称一致性闸的「已搜」一侧证据）。 */
    let evidenceInjected = false;

    /**
     * 答案留存记账（2026-10-13 根修：工具轮的答案不进流式通道）：
     * holdAnswer 置位后，工具循环对「执行过实质工具的轮次」不再直推正文，
     * 答案随返回值交 done。本标记把「循环确实留存了」如实带给 WS 层——
     * done 裁据此区分「留存答案（整段替换呈现）」与「出口重写分歧（说话算话
     * 丢弃）」，不再靠残差比例猜。语音轮不置位 holdAnswer，本标记恒 false。
     */
    let answerStreamHeld = false;
    /**
     * 本轮实际发起过的工具调用摘要（A2 升级段轨迹延续）：onToolExecuteStart 在
     * 工具真正执行前触发，含工具名 + 模型填写的参数；截断参数防长输入刷屏。
     */
    const attemptedToolCalls: string[] = [];
    const toolCtx: ChatToolExecutionContext = this.toolContextFactory.create(
      {
        actorId,
        sessionId: ctx.sessionId,
        userId: opts?.userId,
        chatUserMessageId: opts?.chatUserMessageId,
        clientIp: opts?.clientIp,
        clientLocation: opts?.clientLocation,
        userText: text,
        source: "runStandardLlmPath",
        access: {
          agentAccessMode: ctx.orchestrateToolCtx?.agentAccessMode,
          desktopBridgeOnline: ctx.orchestrateToolCtx?.desktopBridgeOnline,
          phoneBridgeOnline: ctx.orchestrateToolCtx?.phoneBridgeOnline,
// 按需位置：位置类工具（weather.get_local 等）在缺少经纬度时可向客户端请求实时 GPS。
          requestLocation: () =>
            this.locationCoordinator?.requestLocation(actorId, "tool:standard-llm-path") ??
            Promise.resolve(null),
          // 中途推卡：购物等长工具把二维码即时呈现给用户（聊天主路径装配）
          pushMediaCards: opts?.pushMediaCards,
        },
      },
      {
        onToolExecuteStart: (info) => {
          toolExecutedThisTurn = true;
          if (attemptedToolCalls.length < 12) {
            attemptedToolCalls.push(
              `${info.toolName}(${JSON.stringify(info.input ?? {}).slice(0, 120)})`,
            );
          }
          if (ctx.taskHubTaskId) {
            taskProgressSteps += 1;
            getTaskHub().setProgressThrottled(
              ctx.taskHubTaskId,
              `第${taskProgressSteps}步：正在使用 ${info.toolName}`,
            );
          }
          opts?.onExternalToolExecuteStart?.(info);
        },
        onAgentStatusLine: opts?.onAgentPhaseStatus,
        // 两个回调都要执行（2026-09-17 修复，原 `??` 二选一会导致后台捕获恒空）：
        // 任务面派发必带 orchestrateToolCtx（其 onToolExecuted 承担轨迹捕获/
        // 自我学习/外部回执），而 backgroundOnToolExecuted 是派发方收集
        // media/行程回执的数据源——二者职责不同，不能互相短路。
        onToolExecuted: (info: ToolExecutedInfo) => {
          // 答案留存记账（2026-10-13 根修）：holdAnswer="after_tool_use" 时，
          // 实质工具执行 = 工具循环已对本轮答案关闸（与循环内 answerHeld()
          // 同一判定函数 isSubstantiveToolExecution，口径恒一致）。
          if (holdAnswer === "after_tool_use" && isSubstantiveToolExecution(info.toolName)) {
            answerStreamHeld = true;
          }
          ctx.orchestrateToolCtx?.onToolExecuted?.(info);
          ctx.backgroundOnToolExecuted?.(info);
        },
      },
    );

    const onBatchFromCaller = ctx.orchestrateToolCtx?.onToolLoopAfterBatch;
    const toolExposureProfile = this.toolPolicyResolver.resolveExposureProfile(mode);
    const toolRankingHint = this.toolPolicyResolver.resolveRankingHint(actorId);
    // 2026-09-06 P0 修复：前台回归原生 function calling——task.dispatch + search_web
    // 小工具集常驻（explicit 白名单），派发/查证走 API 结构化 tool_calls 通道，
    // 由模型训练对齐保证格式，runtime 直接执行。旧 [dispatch:...] 文本标签协议
    // 依赖模型自觉遵守自创格式，"模型不写标签 = 静默零工具"（调不到工具的根因），
    // 退役为 AGENT_FOREGROUND_TAG_PROTOCOL=1 灰度回退项。
    const foregroundTagMode =
      this.isChatLane(mode) && isForegroundDispatchMode() && isForegroundTagProtocolEnabled();
    const dispatchFilter = foregroundTagMode ? new DispatchTagStreamFilter() : null;
    // chat 车道 explicit 轮可见集（2026-10-09 工具链根修）：Core 常驻 ∪ 域信号
    // 预召回。此前可见集是纯静态白名单，长尾工具（travel.* / media.* /
    // smart_home 等）藏在延迟目录，模型不知道自己看不见、不主动 discover 就
    // 手写答案（travel 手写行程 → 旅游卡缺席；profile.update / weather.get_local
    // 同款教训）。预召回与任务面 router-first 共用同一原语，把「用户这句话涉及
    // 的域」的工具确定性拉进本轮可见集；纯闲聊零工具隔离分支在其上游，不受影响。
    // 晋升常驻解析（2026-10-09 L4）：per-actor 高频成功工具（≥3 次/48h）转常驻。
    // 语料缺失（生产/测试注册表差异）自动跳过；与 Core/预载重名由下游 uniqueTools 收敛。
    const buildPromotedChatTools = (
      corpus: ChatCompletionTool[],
      excludeNames: ReadonlySet<string>,
    ): ChatCompletionTool[] => {
      if (!isToolRecallEnabled()) return [];
      const byName = new Map<string, ChatCompletionTool>();
      for (const t of corpus) {
        const name = t.type === "function" ? t.function?.name ?? "" : "";
        if (name) byName.set(name, t);
      }
      return getPromotedToolNames(actorId)
        .filter((name) => !excludeNames.has(name) && byName.has(name))
        .map((name) => byName.get(name) as ChatCompletionTool);
    };
    const buildChatLaneExplicitOpts = () => {
      const webForbidden = ctx.webSearchForbidden === true;
      // 2026-10-10 P0-1 修复（技能族在对话面集体失踪）：本函数返回的
      // chatToolsExtra 在对象展开顺序里位于 promptContextBuilder.build() 之后，
      // 直接覆盖了后者产出的 chatToolsExtra = sessionSkillTools(actorId)。
      // 技能工具（travel.* / alipay.* / merchant.* / picture.* 等全部技能族，
      // kind:"builtin"）不在 getBuiltinAgentChatTools() 静态注册表，只走
      // sessionSkillTools 通道——被覆盖后对话面既看不见、也进不了延迟目录
      // （tool_discover 语料同源），模型只剩 search_web（马尔代夫行程轮实证）。
      // 任务面语料 [...chatToolsBuiltin, ...chatToolsExtra] 不受影响，故只有
      // 对话面复现。修复：语料并集 = builtin ∪ sessionSkillTools，按名去重。
      const chatSkillTools = this.promptContextBuilder.getChatSkillTools(actorId);
      const corpusMerged = dedupeToolsByName([
        ...getBuiltinAgentChatTools(),
        ...chatSkillTools,
      ]);
      const corpusSafe = webForbidden
        ? filterWebSearchTools(corpusMerged)
        : corpusMerged;
      // 纯媒体轮（2026-10-21 根修，双车道同口径）：用户只要照片/视频时，
      // 文字检索族与另一模态整族不可见——搜图轮不再顺手搜新闻、正文不再
      // 写成「照片/视频/待验证」的盘点。
      const corpusLane = isMediaOnlyRequest(text)
        ? filterMediaModalityTools(filterTextSearchTools(corpusSafe), text)
        : corpusSafe;
      const coreTools = buildLaneCoreTools("chat", corpusLane, [
        TASK_DISPATCH_TOOL_DEFINITION,
        TASK_STATUS_TOOL_DEFINITION,
        TASK_CANCEL_TOOL_DEFINITION,
        PERCEPTION_OVERVIEW_TOOL_DEFINITION,
      ]);
      const coreFiltered = webForbidden ? filterWebSearchTools(coreTools) : coreTools;
      const coreNames = new Set(
        coreFiltered
          .map((d) => (d.type === "function" ? d.function?.name : ""))
          .filter(Boolean),
      );
      const promotedTools = buildPromotedChatTools(corpusLane, coreNames);
      return {
        toolExposureProfile: "explicit" as const,
        chatToolsBuiltin: [
          ...coreFiltered,
          ...buildDomainPreloadTools(text, corpusLane, coreNames),
          // 晋升常驻（2026-10-09 L4）：该 actor 近窗真实成功调用 ≥3 次的延迟工具
          // 直接常驻可见集——预载/top-K/两波 discover 都不需要，晋升工具已是主力。
          ...promotedTools,
        ],
        chatToolsExtra: corpusLane,
        // 会话工具面冻结（2026-10-22）：晋升阈值可能在本会话中途被跨过，而冻结
        // 之后可见集不再吸收新工具——显式声明「晋升是可增长项」，下轮进基准。
        // 不做这件事，用户刚用熟的工具会在本会话内一直隐身，只能靠请求卡转正。
        ...(promotedTools.length > 0
          ? {
              toolFaceGrowNames: promotedTools
                .map((t) => (t.type === "function" ? t.function?.name ?? "" : ""))
                .filter(Boolean),
            }
          : {}),
        toolLoop: { maxRounds: chatLaneMaxRounds() },
      };
    };
    const baseStreamOpts = this.isChatLane(mode)
      ? ({
          ...(this.promptContextBuilder.build({
            actorId,
            sessionId: ctx.sessionId,
            userText: text,
            threadMessageCount: ctx.orchestrateToolCtx?.threadMessageCount,
            narrativeRecall: ctx.narrativeRecall,
            workingMemorySummary: ctx.workingMemorySummary,
            recentConversationHistory: ctx.recentConversationHistory,
            interruptedContext: opts?.interruptedContext,
            userLocation: ctx.userLocation,
            frequentPlaces: ctx.frequentPlaces,
            deviceClass: opts?.deviceClass,
            personalization: ctx.personalization ?? {},
            userPattern: ctx.cognitiveUserPattern,
            toolPlan: ctx.cognitiveToolPlan,
            // 单一调用点在 chat 车道分支（isChatLane），plane 固定 chat：
            // 顺嘴搭车块按车道门控只进对话面
            plane: "chat",
          }) ?? {}),
          // 前台工具暴露（2026-09-19 静态双车道改造）：
          // - 静态架构（默认）：chat Core 静态常驻（感知只读 + 单步轻动作 +
          //   task.dispatch，~20 个），延迟目录保持可达（tool_discover/
          //   tool_request 转正），取代"4 工具白名单 + 能力域关键词临时注入"——
          //   同一车道恒同一可见集，行为可复现、schema 前缀缓存稳定。
          // - legacy 回退（AGENT_TOOL_ARCH=legacy）：旧 4 工具白名单 + 零目录。
          // - tagProtocol 灰度回退时保持零工具。
          // 去路由化（2026-10-21）：纯闲聊零工具隔离删除。工具常驻可见，
          // 「这轮要不要用工具」由模型原生 tool_calls 决定；推销感只靠职责块
          // 与提示词治理，不再用「看不见工具」这种结构性手段。
          ...(foregroundTagMode
            ? { toolExposureProfile: "none" as const }
            : isStaticToolArchEnabled()
              ? buildChatLaneExplicitOpts()
              : {
                  toolExposureProfile: "explicit" as const,
                  chatToolsBuiltin: getForegroundChatToolWhitelist(text),
                  disableToolSearch: true,
                  toolLoop: { maxRounds: 2 },
                }),
          maxOutputTokens: chatLaneMaxOutputTokens(),
          toolRankingHint,
        } satisfies AgentStreamOptions)
      : {
          ...(this.promptContextBuilder.build({
            actorId,
            sessionId: ctx.sessionId,
            userText: text,
            threadMessageCount: ctx.orchestrateToolCtx?.threadMessageCount,
            narrativeRecall: ctx.narrativeRecall,
            workingMemorySummary: ctx.workingMemorySummary,
            recentConversationHistory: ctx.recentConversationHistory,
            interruptedContext: opts?.interruptedContext,
            userLocation: ctx.userLocation,
            frequentPlaces: ctx.frequentPlaces,
            deviceClass: opts?.deviceClass,
            personalization: ctx.personalization ?? {},
            onToolLoopAfterBatch: onBatchFromCaller,
            userPattern: ctx.cognitiveUserPattern,
            toolPlan: ctx.cognitiveToolPlan,
          }) ?? {}),
          toolExposureProfile,
          toolRankingHint,
        };
    // ── 扣子式前置检索（2026-09-13 根修）：realtime_lookup 由程序先搜、证据注入 ──
    // 旧模式的失败链：搜不搜全靠模型自觉 → 提示词恳求 + 出口闪避闸都是缝补，
    // 实测（「刘浩存在哪」轮）模型仍可凭对话回声直答。根修对齐扣子的
    // 「搜索插件节点 → LLM 节点」结构：路由器已判定 realtime_lookup 并生成
    // search_query（结合最近对话解决指代），这里**确定性**执行一次真实搜索，
    // 把证据块注入 system 上下文——模型拿到的是已检索的事实，没有「要不要搜」
    // 的选择权。search 失败静默跳过（回退模型自决 + 出口闸兜底）。
    // 2026-09-23 两处收紧（工具自决权改造）：
    //   1) 显式禁网轮直接跳过整块（用户指令 > 架构的"必先搜"）；
    //   2) 投机证据（speculative，查询词=用户原话）只准任务面消费——对话面注入
    //      投机证据会教模型「搜索是系统的事」（误路由轮零工具直答的根源之一），
    //      且拿原话当查询词的搜索质量差，常把垃圾条目灌进闲聊 prompt。
    //      对话面只认 route_query（消解过的精确查询词）。
    // 2026-10-11 时间问题重定向（实盘探针实证）：路由把「现在几点」消解成
    // 搜索词「当前北京时间」走网页搜索，搜回来的是网页快照里爬取时刻的旧时间，
    // 模型照抄快照答了「2026-05-08 周五 17:22」（真实日期 2026-10-11，差 5 个月）。
    // 时间是确定性事实，证据源是**本地时钟**，绝不入搜索引擎。
    const directClockQuestion = isDirectCurrentTimeQuestion(text);
    // 去路由化（2026-10-21）：前置网页/投机检索整体退役，证据只剩本地时钟一条
    // （时间是确定性事实，绝不入搜索引擎）。网页与媒体检索全部交给模型按需调用
    // search_* 工具，媒体轮的证据源只有 search_images 的真实结果。
    if (!ctx.webSearchForbidden && directClockQuestion) {
      const evidence = this.buildClockEvidence(baseStreamOpts.promptContext?.memory?.currentTime);
      if (evidence) {
        const memory = (baseStreamOpts.promptContext ??= {}).memory;
        if (memory) {
          memory.webEvidence = evidence;
          evidenceInjected = true;
          console.info(`[AgentCore] 本地时钟证据已注入（source=clock_local）：${text.slice(0, 40)}`);
        }
      }
    }
    // 显式禁网轮（2026-09-23）：说明注入 + 联网工具剥离说明（工具集过滤在下方
    // chatToolsBuiltin / task Core 构建处执行），让模型知道这轮"没搜索"是用户要求。
    if (ctx.webSearchForbidden) {
      const memory = (baseStreamOpts.promptContext ??= {}).memory;
      if (memory) {
        memory.taskContext = [memory.taskContext, NO_WEB_TURN_NOTE].filter(Boolean).join("\n");
      }
      console.info(`[AgentCore] 显式禁网轮：联网工具已剥离、前置检索已跳过：${text.slice(0, 36)}`);
    }
    // 本模式职责人格注入（fast/complex 差异化，不依赖 feature flag）：
    // fast 偏对话活人感、complex 偏推理与工具，让同一人格在不同"脑"上各有侧重。
    if ((baseStreamOpts.promptContext ??= {}).memory) {
      const mem = baseStreamOpts.promptContext.memory;
      if (!mem.modeRoleGuidance) {
        // 去路由化（2026-10-21）：不再按 routeIntent 切纯闲聊职责版。工具常驻
        // 可见，职责块统一用工具纪律版；「不揽活」由该块最后一条承担，两处
        // 口径不再依赖路由猜意图。
        mem.modeRoleGuidance = this.isChatLane(mode)
          ? isForegroundDispatchMode()
            ? FOREGROUND_ROLE_GUIDANCE
            : CHAT_PLANE_ROLE_GUIDANCE
          : TASK_PLANE_ROLE_GUIDANCE;
      }
      // 风格豁免开关（2026-09-06，2026-09-11 分层化后仍沿用）：
      // 【说话方式·伙伴面】（调子菜单 few-shot/收放开关/禁句）只属于对话面；
      // 任务面（complex）交付不受限，不注入伙伴面，交付风格由
      // TASK_PLANE_ROLE_GUIDANCE 自己承担（管家底色两层车道都注入）。
      mem.replyStyleMode = this.isChatLane(mode) ? "chat" : "task";
    }
    const runtimeKernel = getRuntimeKernel(actorId);
    // r5: 注入情绪到 promptContext.memory（方向化短字符串，不堆 prompt）：
    // - emotionState: 仅当情绪显著时输出（强负/强正/高唤醒），让模型基于情绪调语气
    // 中性情绪 → 跳过（避免噪声污染 prompt）
    const memoryBeforeSanitize = baseStreamOpts.promptContext?.memory;
    const cogEmo = ctx.cognitiveEmotion;
    // 人格·终极版（2026-09-22）：静态人格块 + 单一 mood 动态块，取代旧
    // 【说话方式·管家底色/伙伴面】。tier 由个性化 rapport 换算；mood 由
    // 关系档 + 情绪向量 + 车道解析（任务面恒 serious）。
    if (memoryBeforeSanitize) {
      const personaTier = resolveRelationshipTier(ctx.personalization?.rapport);
      // 称呼从结构化事实块取（unified-extractor facts.称呼），缺省回退"用户"
      const aliasMatch = /称呼[：:]\s*([^\s，。；、|]{1,10})/.exec(
        memoryBeforeSanitize.userFacts ?? "",
      );
      // 每用户适配：个性化系统学到的调侃容忍/语气/长度倾向，静态块一行 + mood gate
      const adaptation = {
        humorTolerance: ctx.personalization?.humorTolerance,
        preferredTone: ctx.personalization?.preferredTone,
        lengthPreference: ctx.personalization?.lengthPreference,
      };
      memoryBeforeSanitize.personaStatic = buildPersonaStaticBlock({
        tier: personaTier,
        userAlias: aliasMatch?.[1],
        adaptation,
        soulOverlay: getSoulOverlay() ?? undefined,
      });
      // 【语感基准】few-shot（2026-10-06 活人感治理）：seed=sessionId 会话内字节稳定。
      // 仅 chat 车道注入——任务面交付（结论先行/充分展开）与闲聊 few-shot 相克。
      memoryBeforeSanitize.voiceBaseline = this.isChatLane(mode)
        ? buildVoiceBaselineBlock(opts?.sessionId ?? actorId)
        : undefined;
      memoryBeforeSanitize.personaMood = buildPersonaMoodBlock(
        resolvePersonaMood({
          tier: personaTier,
          valence: cogEmo?.valence,
          arousal: cogEmo?.arousal,
          isTaskPlane: !this.isChatLane(mode),
          userText: text,
          humorTolerance: ctx.personalization?.humorTolerance,
        }),
      );
    }
    if (memoryBeforeSanitize && cogEmo) {
      const v = cogEmo.valence;
      const a = cogEmo.arousal;
      if (v < -0.3 || v > 0.5 || a > 0.7) {
        const tone = v < -0.5
          ? "回复应简短温和"
          : v < -0.3
            ? "回复宜温和"
            : v > 0.5
              ? "回复可活泼些"
              : a > 0.7
                ? "回复别端着"
                : "";
        memoryBeforeSanitize.emotionState =
          `情绪：${cogEmo.label}${tone ? ` — ${tone}` : ""}`;
      }
    }
    const runtimePlan = runtimeKernel.planTurn(text, baseStreamOpts.promptContext?.memory);
    const sanitizedMemory = runtimeKernel.sanitizePromptMemory(
      baseStreamOpts.promptContext?.memory,
      runtimePlan,
    );
    const effectiveMemory = sanitizedMemory;
    const isMinimalMode = runtimeKernel.isMinimalMode();
    // 2026-09-05 模型路由：对话面 → Flash；任务面按 TurnPlan.tier——轻预算单点任务
    // （realtime/media，tier=fast）也走 Flash，仅多步/写操作（tier=complex）上 Pro。
    // 取代旧"mode=complex 一律 reasoner"的粗粒度路由（省 token）。
    const resolvedTier: TaskTier =
      mode === "chat" || ctx.turnPlan?.tier === "flash" ? TaskTier.FLASH : TaskTier.PRO;
    // ── 答案留存（2026-10-13 根修：工具轮的答案不进流式通道）──
    // 决策点在 agent-core（知道「检索发生在循环外」这一事实）+ 工具循环
    // （知道「本轮是否执行过工具」），两层合成完整契约：
    //   - 网页证据轮（前置检索已完成）→ "always"：答案从第一波就留存；
    //   - 其余轮 → "after_tool_use"：循环内执行过实质工具即留存；
    //   - 语音轮豁免（TTS 消费流式分句）。
    // 双车道统一（2026-10-13 真链实证）：天气问句被路由层判 realtime_lookup
    // → plane=task，答案同样在任务面工具循环产出并流式到对话面——只留 chat
    // 车道=漏掉用户实际命中的天气路径（真链探针 242 字全量流式反例）。任务面
    // 的过程反馈走 chat.agent_status/execution_event 结构化事件，不靠打字机。
    const holdAnswer: "after_tool_use" | undefined =
      !isVoiceMode(actorId) ? "after_tool_use" : undefined;
    const streamOpts: AgentStreamOptions = {
      ...baseStreamOpts,
      ...(effectiveMemory ? { promptContext: { memory: effectiveMemory } } : { promptContext: undefined }),
      ...(runtimePlan.promptMode === "conversation_only"
        ? {
            systemPromptOverride:
              "You are a helpful, safe assistant. Reply in the user's language. Follow the current user request and conversation context.",
          }
        : {}),
      // minimal 模式下：通过 RuntimeKernel.buildSessionSystem() 生成薄身份 system，
      // suppressRuntimeSuffixes=true 跳过身份/风格/时间戳说明后缀，
      // functionalSuffixes=true 保留功能性后缀（工具说明/主 Agent 调度/用户可见进度/访问权限）
      ...(isMinimalMode
        ? {
            systemPromptOverride: runtimeKernel.buildSessionSystem() ?? undefined,
            suppressRuntimeSuffixes: true,
            functionalSuffixes: runtimePlan.functionalSuffixes !== false,
          }
        : {}),
      // 2026-08-30 修复：对话面不允许 RuntimeKernel 把 profile 覆盖成 scoped。
      // scoped 会让 buildExtraBody 丢掉 fastProfile 标志（仅 contextual/light 注入）
      // → 工具循环里 fastProfile 的失败续波保底（失败时 maxWaves+1）整个失效、
      // maxWaves 从 1 静默变 4，且可见工具被 filterScopedTools 砍到只剩
      // pinned（提醒/搜索/照片关键词轮必然命中，恰是续波需求最高的轮次）。
      // RK 的 pinned 工具已通过下方 pinnedToolNames 合并保留，对话面无需 profile 劫持。
      toolExposureProfile: this.isChatLane(mode)
        ? baseStreamOpts.toolExposureProfile
        : (runtimePlan.toolExposureProfile ?? baseStreamOpts.toolExposureProfile),
      // 任务面能力束（2026-09-05）：路由层 TurnPlan.capabilities 透传给工具解析层，
      // delegate profile 按它裁剪注入的工具族（search/media 轻任务不再全量注入），
      // 其余工具进 BM25 延迟目录按需召回。
      ...(this.isChatLane(mode) ? {} : { toolCapabilities: ctx.turnPlan?.capabilities }),
      // 会话级任务计划主键（2026-10-19 handoff）：plan.* 用 ToolContext.sessionId 写入，
      // 工具循环内拿不到那个值——这里显式下发，保证「写 / 注入 / 软提示 / 工具面收缩 /
      // 执行守卫」五处同一把钥匙（此前各拼各的，导致计划写了不显示、软提示一直催）。
      ...(ctx.sessionId ? { planSessionKey: ctx.sessionId } : {}),
      // 答案留存（2026-10-13 根修）：透传进工具循环，provider 白名单转发，
      // 漏传 = 留存静默失效（见 AgentStreamOptions.holdAnswer 注释）。
      ...(holdAnswer ? { holdAnswer } : {}),
      // 语感治理 A（2026-10-06）：chat 车道主生成显式置位采样放开（temp 0.85 +
      // frequency_penalty 0.4，env 可调）；任务面不置位保持默认采样。
      ...(this.isChatLane(mode) ? { chatLaneSampling: true } : {}),
      turnEvidenceInjected: evidenceInjected,
      pinnedToolNames: runtimePlan.enabled
        ? [...(baseStreamOpts.pinnedToolNames ?? []), ...runtimePlan.pinnedToolNames]
        : baseStreamOpts.pinnedToolNames,
      // 任务面工具波预算（2026-09-05）：由路由层 TurnPlan 决定（realtime/media=2，
      // write/multi-step=3，词法 veto 升级=3），取代旧硬编码。对话面无工具循环，
      // 不受此配置影响。保底 1、封顶 4，防预算失控。
      ...(this.isChatLane(mode)
        ? {}
        : {
            toolLoop: {
              ...(baseStreamOpts.toolLoop ?? {}),
              maxRounds: Math.min(4, Math.max(1, ctx.turnPlan?.budget ?? 3)),
            },
          }),
      maxThreadMessages: runtimePlan.promptMode === "conversation_only"
        ? Number.parseInt(process.env.AGENT_RUNTIME_KERNEL_MAX_THREAD_MESSAGES ?? "12", 10)
        : baseStreamOpts.maxThreadMessages,
      // 透传中断信号:用户发新消息时 abort,provider 底层 fetch 真正中断 HTTP 流式
      ...(opts?.signal ? { signal: opts.signal } : {}),
      // 2026-08-02 模型路由：Fast/Complex 同用 deepseek-flash（deepseek-reasoner 已下线），
      // 差异只在思考链——PRO 档显式 disableThinking:false 放开思考（provider 对 flash
      // 未显式表态时默认下发 thinking:disabled，保快档秒回语义）。
      ...buildModelOverrideOpts(resolvedTier),
      ...(resolvedTier === TaskTier.PRO ? { disableThinking: false } : {}),
    };

    let full = "";
    let modelCallsConsumed = 1;
    // 任务面引擎选择（2026-10-21 收敛）：复杂任务走显式「计划→执行」，简单任务仍由
    // 工具循环一波内并行规划。判定 = 任务面 && requiresExplicitPlan（多步/多分句/长任务），
    // 不再对所有任务无条件加计划调用，也不再用无计划的逐步波次冒充规划。
    // 规划轮自身已收敛为「紧凑 system + 无工具 schema」（见 plan-execute-loop），
    // 不再重发整套 chat 底板；关闭开关：AGENT_PLAN_EXECUTE_LOOP=0。
    // 旧 ReactLoopStrategy / LoopOrchestrator（含每轮 LLM 进展评估）已删除。
    // 2026-10-21 执行策略分层（去路由化后的对应改造）：
    // 任务/多步动作轮走显式「计划→执行」；单步查询与闲聊仍走一波内并行
    // （等价于一步计划），不额外付一次规划调用。
    // 判据是确定性的复杂度信号（requiresExplicitPlan）+ 动作信号，不是意图路由。
    // 动作信号 = 祈使结构（isActionableTaskRequest）∪ 提醒/闹钟句式
    // （needsToolChoiceRequired）：planner 升级的误判代价只是一次规划调用
    // （可逆、慢而不错），与请求层 tool_choice 强制的不可逆误判不同，
    // 因此这里沿用宽信号，不随 2026-10-22 的事前门收窄而收窄。
    const useExplicitPlanner =
      shouldPlanExecute(text) &&
      (mode === "task" ||
        (this.isChatLane(mode) &&
          (isActionableTaskRequest(text) || needsToolChoiceRequired(text))));
    let pePlan: TaskExecutionPlan | null = null;
    let peExhausted = false;

    // 任务面工具装配（2026-10-01「一次分类，处处消费」收敛为三条确定性路径）：
    // - 轻任务束（realtime/media 等非 full 束）：路由表判出的 capabilities 直接
    //   投影为可见集全 schema——「路由判需要搜索」在结构上保证「搜索工具必然
    //   可见」，不再依赖 BM25 拿用户原话二次猜（原话弱召回=漏召→模型凭常识
    //   直答的根源），discover 波次随之从流程消失。
    // - full 束（multi_step/后台派发/保守降级）：router-first 桥 + travel 规划族
    //   保底，全量语料进 BM25 目录按需召回。
    // - AGENT_TASK_LANE=core 回滚：静态 task Core ∪ 能力束（原路径保留）。
    let execStreamOpts = streamOpts;
    // 2026-10-10 编排器协同：去掉 !useExplicitPlanner 短路——plan-execute 路径
    // 同样走任务面工具装配（runPlanExecuteLoop 拿 execStreamOpts 作
    // baseStreamOpts，计划步 suggestedTools 经 resolveSuggestedToolDefinitions
    // 转正进执行轮可见集）。此前编排器路径绕过整个可见集组装，可见集退化成
    // 「全量 builtin 直塞」，router-first/预载/晋升在编排器轮全部失活。
    if (this.isTaskLane(mode)) {
      const corpus = [
        ...(streamOpts.chatToolsBuiltin ?? getBuiltinAgentChatTools()),
        ...(streamOpts.chatToolsExtra ?? []),
      ];
      if (isStaticToolArchEnabled() && isTaskLaneRouterFirst()) {
        // 显式禁网轮（2026-09-23）：束与目录语料一并剥联网检索族，防 tool_discover
        // 把搜索工具召回回来绕过开关。
        const webForbidden = ctx.webSearchForbidden === true;
        // 媒体轮（2026-10-21 根修）：用户只索图时工具面只有媒体工具，文字检索族
        // （search_web/deep_search/fetch_web/hot_rankings/info.*）从可见集与延迟
        // 目录里一起消失——「没要求查资料」不再靠模型自觉，而是没有可查的工具。
        const mediaOnlyRound =
          ctx.routeIntent === "media_retrieval" || isMediaOnlyRequest(text);
        const corpusSafe = webForbidden
          ? filterWebSearchTools(corpus)
          : mediaOnlyRound
            ? filterMediaModalityTools(filterTextSearchTools(corpus), text)
            : corpus;
        // 轻任务束确定性注入：束轮可见集恒同集（同 intent 同投影），前缀缓存稳定。
        // schema 走瘦身（首句描述、剥字段说明，与 travel 保底同款）——束的价值在
        // 「确定性可达」不在参数手册，全 schema 会把束轮输入抬高数 k token。
        const caps = ctx.turnPlan?.capabilities ?? [];
        const lightBeam =
          caps.length > 0 && !caps.includes("full")
            ? // 2026-10-22 定稿：束投影全量 schema（架构文档 5.1.4）——束的价值
              // 在「确定性可达」，schema 瘦身省下的 token 抵不过参数错误的重试。
              toolsMatchingCapabilityBeam(corpusSafe, caps)
            : [];
        if (lightBeam.length > 0 && !isSessionBudgetExceeded(ctx.sessionId ?? undefined, actorId)) {
          execStreamOpts = {
            ...streamOpts,
            toolExposureProfile: "explicit",
            chatToolsBuiltin: lightBeam,
            chatToolsExtra: corpusSafe,
          };
        } else {
          // router-first（2026-09-23 token 优化）：可见集 = 桥工具 + 域信号预载
          // （2026-10-01 S2：词面 top-5 域多数票 ≥3 → 预载该域全族瘦身 schema，
          // travel 硬编码的泛化——所有"模型自觉会写"的域统一覆盖；2026-10-09 起
          // 与 chat 车道共用 buildDomainPreloadTools 原语），其余全量语料进 BM25
          // 目录按需召回（能力面经域卡+域拉取可达）。回滚：AGENT_TASK_LANE=core
          // （下方静态 Core 路径）。
          const domainPreload = buildDomainPreloadTools(text, corpusSafe);
          // travel 意图强制可见（2026-10-10 P1）：确定性预执行要求工具在本轮
          // 可见集内（预执行器守卫），而域预载是词面多数票——「下周去三亚」这类
          // 弱词面轮可能 miss。判出 travel_planning 后 travel 全族确定性并入，
          // 与「路由判需要 → 工具必然可见」的束投影同一条结构保证。
          const travelForcePreload =
            ctx.routeIntent === "travel_planning"
              ? // 2026-10-22 定稿：travel 强制预载全量 schema（架构文档 5.1.4）。
                toolsInDomain(corpusSafe, "travel")
              : [];
          // 轻量常驻（2026-10-10 ②）：router-first 不再是纯预载——「提醒/回复/
          // 记一下」类短口语动作的 BM25 词面召回天然弱（通词被 IDF 闸杀、强票位
          // 被长描述族占走，benchmark 三条实证 miss），轻动作/感知工具确定性
          // 常驻；与预载/晋升重名由下方去重收敛。
          const lightTools = buildTaskLaneRouterFirstLightTools(corpusSafe);
          const preloadNames = new Set(
            [...domainPreload, ...travelForcePreload, ...lightTools]
              .map((d) => (d.type === "function" ? d.function?.name : "") ?? "")
              .filter(Boolean),
          );
          // 晋升常驻（2026-10-09 L4，双车道共用）：高频成功工具进 router-first 可见集
          execStreamOpts = {
            ...streamOpts,
            toolExposureProfile: "explicit",
            chatToolsBuiltin: dedupeToolsByName([
              ...domainPreload,
              ...travelForcePreload,
              ...lightTools,
              ...buildPromotedChatTools(corpusSafe, preloadNames),
            ]),
            chatToolsExtra: corpusSafe,
          };
        }
      } else if (isStaticToolArchEnabled()) {
        // 静态双车道（2026-09-19 架构改造）：可见 = task Core（静态常驻）∪ 路由
        // 能力束投影（Tier-2 确定性增量，TurnPlan.capabilities 不变则集合不变）；
        // 其余全部进延迟目录经 tool_discover/tool_request 到达。
        const coreTools = buildLaneCoreTools("task", corpus, [
          TASK_DISPATCH_TOOL_DEFINITION,
          TASK_STATUS_TOOL_DEFINITION,
          TASK_CANCEL_TOOL_DEFINITION,
          PERCEPTION_OVERVIEW_TOOL_DEFINITION,
        ]);
        // 桌面桥明确离线且本机视觉执行体不可用时，desktop.* 是"必然执行失败的工具"
        // （见 resolve-chat-tools dropOfflineDesktopTools 同款规则），从 Core 剔除。
        const desktopOffline =
          ctx.orchestrateToolCtx?.desktopBridgeOnline === false && !isLocalDesktopVisualEnabledFromEnv();
        // 显式禁网轮（2026-09-23）：task Core 同样剥离联网检索族；延迟目录
        // 语料（corpus）一并过滤，防 tool_discover 把搜索工具召回回来绕过开关。
        const webForbidden = ctx.webSearchForbidden === true;
        const coreFiltered = (desktopOffline
          ? coreTools.filter(
              (d) => d.type !== "function" || !/^desktop\./.test(d.function?.name ?? ""),
            )
          : coreTools
        ).filter((d) => !webForbidden || filterWebSearchTools([d]).length === 0);
        const coreNames = new Set(
          coreFiltered
            .map((d) => (d.type === "function" ? d.function?.name : ""))
            .filter(Boolean),
        );
        // 预算闸门降级（2026-09-19 P1-2）：会话 token 超限时能力束不再注入
        //（纯 Core 直调，省 1.5 万+ tok/轮），主对话与 Core 工具不受影响。
        const budgetExceeded = isSessionBudgetExceeded(
          ctx.sessionId ?? undefined,
          actorId,
        );
        const beam = budgetExceeded
          ? []
          : toolsMatchingCapabilityBeam(corpus, ctx.turnPlan?.capabilities).filter(
              (d) => d.type !== "function" || !coreNames.has(d.function?.name ?? ""),
            );
        execStreamOpts = {
          ...streamOpts,
          toolExposureProfile: "explicit",
          chatToolsBuiltin: [...coreFiltered, ...beam],
          // 全量语料进延迟目录（prepareToolsWithToolSearch 会按可见集自动去重）
          chatToolsExtra: webForbidden ? filterWebSearchTools(corpus) : corpus,
        };
      } else {
        // legacy（AGENT_TOOL_ARCH=legacy 回滚档）：空可见集 + 全量目录语料，
        // prepareToolsWithToolSearch 会把全量工具视为 deferred 并自动注入
        // tool_discover 桥。per-turn LLM planner 暗门已删（2026-10-01）：
        // 每轮一次规划调用是被否决的架构，legacy 档统一桥召回语义。
        if (corpus.length > 0) {
          execStreamOpts = {
            ...streamOpts,
            toolExposureProfile: "explicit",
            chatToolsBuiltin: [],
            chatToolsExtra: corpus,
          };
        }
      }
    }

    const userTurn: ChatUserTurn = {
      text,
      ...(opts?.visionFrames?.length ? { visionFrames: opts.visionFrames } : {}),
      // 把 WS 客户端的 messageId 透传为 ChatUserTurn.clientMessageId；
      // provider 会在把 user 消息 push 进 thread 时登记到反向索引，供后续编辑/重发按 id 命中。
      ...(opts?.chatUserMessageId ? { clientMessageId: opts.chatUserMessageId } : {}),
    };

    const chatSessionId = resolvePrimaryChatSessionId(
      actorId,
      getAgentRuntimeConfig().masterDelegation.enabled,
    );

    if (useExplicitPlanner) {
      const chatKey = opts?.chatUserMessageId ?? randomUUID();
      const peSessionId = planExecuteSessionId(actorId, chatKey);

      const result = await runPlanExecuteLoop({
        provider,
        planSessionId: peSessionId,
        userText: text,
        visionFrames: opts?.visionFrames,
        onDelta: (delta) => opts?.onAssistantDelta?.(delta),
        onPhaseStatus: opts?.onAgentPhaseStatus,
        onPlanReady: opts?.onPlanReady,
        toolCtx,
        // 2026-10-10 编排器协同：任务面工具装配（router-first/轻量常驻/预载/
        // 晋升）对 plan-execute 路径同样生效，计划步 suggestedTools 才有语料
        // 可转正（此前编排器拿的是未装配的 streamOpts，绕过了整个可见集组装）。
        baseStreamOpts: execStreamOpts,
        onToolBatchForExecute: onBatchFromCaller,
      });
      full = result.finalText;
      modelCallsConsumed = Math.max(1, result.modelCalls);
      pePlan = result.plan;
      peExhausted = result.exhaustedRetries;
      provider.clearSession?.(peSessionId);
      provider.appendThreadTurn?.(chatSessionId, userTurn, full);
    } else {
      const mergedStreamOpts: AgentStreamOptions | undefined =
        execStreamOpts || onBatchFromCaller || opts || provider.id === "moonshot-kimi"
          ? {
              ...(execStreamOpts ?? {}),
              ...(onBatchFromCaller
                ? {
                    toolLoop: {
                      ...(execStreamOpts?.toolLoop ?? {}),
                      onAfterToolBatch: onBatchFromCaller,
                    },
                  }
                : {}),
              // 后台任务（dispatch 派发）以 ephemeral 执行：不自动落 thread，
              // 由 dispatchBackgroundTask 以单条任务记录显式并入（防 user 消息重复）
              ...(ctx.ephemeralTurn ? { ephemeralTurn: true } : {}),
              // B1 度量打标：任务面按档位分 stage（fast=先轻后重段1，complex=升级段/完整通道）；
              // 前台对话轮不传，由 provider 按分支落 main_chat / main_chat_tools；
              // 派发方显式指定（goal 车道归因）时优先
              ...(ctx.auditStageOverride
                ? { auditStage: ctx.auditStageOverride }
                : ctx.taskHubTaskId
                  ? {
                      auditStage:
                        ctx.turnPlan?.tier === "flash" ? "task_plane_light" : "task_plane_full",
                    }
                  : {}),
              agentAccessMode: ctx.orchestrateToolCtx?.agentAccessMode,
              desktopBridgeOnline: ctx.orchestrateToolCtx?.desktopBridgeOnline,
              phoneBridgeOnline: ctx.orchestrateToolCtx?.phoneBridgeOnline,
              ...(provider.id === "moonshot-kimi" ? { disableThinking: true } : {}),
            }
          : undefined;

      // 前台（fast）：小工具集直答/派发（原生 tool_calls；tagProtocol 灰度时零工具 + 标签）。
      // 任务面（complex，one-shot 引擎）：工具循环 + 出口自检续波。
      //
      // 工具意图升级（2026-09-11 根修）：模型在无工具轮次用 DSML 文本形式发起
      // 工具调用（如对话面轮次想调 desktop.visual.screenshot）时，provider 非工具
      // 分支提取出调用但无执行器，抛 ToolIntentWithoutToolsError。此处捕获并升级
      // 到任务面重跑同一句消息——与下方两个出口闸同构；重跑走任务面（mode=task）
      // 不再进本 catch，天然只触发一次。
      try {
        full = await provider.streamCompletion(
          chatSessionId,
          userTurn,
          (delta) => opts?.onAssistantDelta?.(dispatchFilter ? dispatchFilter.feed(delta) : delta),
          toolCtx,
          mergedStreamOpts,
        );
      } catch (err) {
        if (err instanceof ToolIntentWithoutToolsError && this.isChatLane(mode)) {
          // 阶段2-1：升级重跑纳入 TurnBudget，防止闸门叠加导致最坏耗时无上界
          if (!turnBudget.tryUpgrade("tool_intent_upgrade")) {
            throw err;
          }
          const intentNames = err.toolCalls
            .map((c) => c.name ?? "?")
            .filter(Boolean)
            .slice(0, 3)
            .join(", ");
          console.info(
            `[AgentCore] 对话面工具意图升级转任务面：${text.slice(0, 48)}` +
              (intentNames ? `（意图工具：${intentNames}）` : ""),
          );
          return this.runStandardLlmPath(actorId, text, "task", opts, {
            ...ctx,
            turnBudget,
            turnPlan: { budget: TASK_PLANE_FALLBACK_BUDGET, capabilities: ["full"], tier: "flash" },
          });
        }
        throw err;
      }

      // ── [dispatch:...] 标签出口（2026-09-05 前后台架构）──
      // 从完整回复解析派发请求 → 送后台；最终文本剥标签（流式已逐块剥离，
      // 这里对 flush 残尾与整体做兜底），保证用户可见文本与记忆/journal 无标签。
      let dispatchedViaTag = 0;
      if (dispatchFilter) {
        const tail = dispatchFilter.flush();
        if (tail && opts?.onAssistantDelta) opts.onAssistantDelta(tail);
        full = stripDispatchTags(full);
        const requests = parseDispatchTags(full);
        dispatchedViaTag = requests.length;
        for (const req of requests) {
          console.info(`[AgentCore] 前台标签派发：${req.goal.slice(0, 60)}`);
          this.dispatchBackgroundTask(actorId, {
            sessionId: ctx.sessionId,
            chatUserMessageId: opts?.chatUserMessageId,
            goal: req.note ? `${req.goal}\n（补充：${req.note}）` : req.goal,
            source: "dispatch_tag",
          });
        }
      }

    }

    const reply = await this.turnFinalizer.finish(actorId, text, full, {
      streamedChunks: true,
      modelCallsConsumed,
      planExecuteUsed: useExplicitPlanner,
      pePlan,
      peExhausted,
      messageId: opts?.chatUserMessageId,
      sessionId: opts?.sessionId,
    }, opts?.onAssistantDelta);
    if (attemptedToolCalls.length > 0) {
      reply.attemptedToolCalls = attemptedToolCalls;
    }
    // 答案留存（2026-10-13 根修）：如实告知 WS 层「答案没走流式通道」，
    // done 裁据此走整段替换（卡片+正文同帧）而非说话算话丢弃裁决。
    if (answerStreamHeld) {
      reply.answerStreamHeld = true;
    }
    return reply;
  }

  /**
   * 前置检索执行器（扣子式 search-before-LLM 的「插件节点」）。
   *
   * 用路由器生成的 search_query 走 ToolRegistry 里注册的 search_web
   * （与模型自调完全同一条生产链路：anysearch API 直出 + 兜底相关性闸门），
   * 把真实返回压缩为证据块。带硬超时：检索拖长时宁可放弃证据块
   * （回退模型自决 + 出口闸），也不阻塞对话轮。
   *
   * 返回值三态（2026-09-13）：
   *   - 证据块文本：搜到条目，注入为「本轮事实唯一依据」；
   *   - 零结果标注块：搜索真实执行了但 0 条相关——同样注入，让模型如实说
   *     「搜过、查不到」，而不是谎称「搜过了，全是旧闻」（虚构搜索见闻）；
   *   - null：检索本身失败/超时（非确定性结论），跳过注入，回退模型自决。
   */
  /**
   * 时间问题的确定性证据块（2026-10-11，零网络）：与 system 的【当前时间】块
   * 同一来源（本轮已装配的 currentTime 优先，缺失时现场构造），绝不做网页搜索
   * ——网页快照里的时间是爬取时刻的旧值（实盘实证：差 5 个月）。证据块非空
   * 还保证 realtime 出口闸的「已有证据块零工具直答」豁免照常成立。
   */
  private buildClockEvidence(currentTimeBlock?: string): string {
    const line = currentTimeBlock?.trim() || buildCurrentTimePrompt(new Date());
    return [
      "【实时证据｜本地时钟（刚刚生成，权威）】",
      /^当前时间/.test(line) ? line : `当前时间：${line}`,
      "当前时间/今天日期/星期几一律以上面为准（与 system 的【当前时间】块一致）；禁止引用任何网页快照或搜索结果里的时间。",
    ].join("\n");
  }

  private async runFreshEvidenceSearch(query: string): Promise<string | null> {
    if (!this.toolRegistry) return null;
    try {
      // 双查询并行：原词 + 时效变体（realtime 场景对「最新」敏感，搜索引擎的
      // 时效排序依赖查询词里的时间词）。合并时时效变体结果优先。
      const runSearch = (q: string) =>
        Promise.race([
          this.toolRegistry.execute("search_web", { query: q, limit: 8 }, {
            actorId: "fresh-evidence",
          } as never),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 9_000)),
        ]);
      const [base, recency] = await Promise.all([runSearch(query), runSearch(`${query} 最新`)]);
      const collect = (r: { ok: boolean; result: Record<string, unknown> } | null) =>
        r?.ok && Array.isArray((r.result as { items?: unknown[] }).items)
          ? (r.result as { items: Array<Record<string, unknown>> }).items
          : [];
      const seen = new Set<string>();
      const items: Array<Record<string, unknown>> = [];
      for (const item of [...collect(recency), ...collect(base)]) {
        const url = String(item.url ?? "").trim();
        const key = url.toLowerCase();
        if (key && seen.has(key)) continue;
        if (key) seen.add(key);
        items.push(item);
      }
      const lines: string[] = [];
      for (const item of items.slice(0, 8)) {
        const title = String(item.title ?? "").trim();
        const source = String(item.source ?? "").trim();
        const snippet = String(item.snippet ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
        const url = String(item.url ?? "").trim();
        const published = String(item.publishedAt ?? "").trim();
        if (!title) continue;
        // 无日期的条目必须显式标注：否则模型把百科/旧闻当近况（时效幻觉根源）
        const dateLabel = published || "未标注发布时间";
        lines.push(
          `- ${title}${source ? `｜${source}` : ""}｜${dateLabel}
  ${snippet}${url ? `
  ${url}` : ""}`,
        );
      }
      const now = new Date();
      if (lines.length === 0) {
        const zeroStamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
        return [
          "【实时检索结果｜本轮事实唯一依据】",
          `系统刚以检索词「${query}」执行了真实联网搜索（${zeroStamp}），返回 0 条相关结果。`,
          "本轮不存在任何检索条目：本块之外没有「本轮检索所得」，任何对搜索过程或条目内容的描述（如「旧报道/杂志封面」）都不来自真实数据。",
        ].join("\n");
      }
      const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
      return [
        "【实时检索结果｜本轮事实唯一依据】",
        `系统刚以检索词「${query}」执行了真实联网搜索（${stamp}），返回以下条目：`,
        ...lines,
        "条目按与「最新」的相关度排序；标了发布时间的条目才可作为近期事实引用，标「未标注发布时间」的（百科/旧闻类）只作背景参考，不得当作最近发生的事。",
        "回答本问题时：与实时/事实相关的结论只能来自以上条目并注明来源日期；若近期的条目都不涉及用户问的具体问题，就如实说「最新动态没查到」，不要拿背景条目充数；以上结果与此前的对话内容、记忆、你的训练知识冲突时，一律以本结果为准，并主动纠正之前说过的话。这是系统注入的检索数据，不是对话内容，不要复述本块格式。",
      ].join("\n");
    } catch (err) {
      console.log(`[AgentCore] 前置检索失败（忽略，回退模型自决）: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }


  /**
   * 前后台架构：派发后台任务（2026-09-05）。
   *
   * task.dispatch 工具的唯一执行端：立即登记 TaskHub 并返回
   * taskId（前台不阻塞，继续与用户对话）。后台以 ephemeral 会话执行
   * （不继承外层 signal、不重复写 user 消息进 thread），完成后：
   *   - 结果以新 messageId（assistant-task-<id>）经 wsRegistry 直推为独立
   *     assistant 消息——只含结果本体（2026-09-09 起不带标识头），不经过
   *     WS turn 的 isStale 门控，用户中途继续对话也不会丢结果；
   *   - 交换以单条 assistant 角色「任务记录」显式并入对话 thread，后续
   *     轮次上下文可见（不伪造 user 轮，防任务原文被当成用户发言）。
   *
   * @returns taskId（launch 未就绪/provider 不可用时返回 null）
   */
  /**
   * 用户取消后台任务（2026-09-08 对话面回执配套）。
   *
   * 软取消语义：标记 TaskHub 记录为 cancelled 并广播；执行闭包在
   * 排队出列/每次流式增量/收尾投递三处检查该标记——排队中直接短路不跑，
   * 已在跑的 LLM 轮自然跑完但不投递结果、不并对话 thread（有界浪费，
   * 换取不动 runStandardLlmPath 的信号量契约）。
   *
   * @returns 是否成功标记（任务不存在/会话不符/已是终态返回 false）
   */
  cancelBackgroundTask(actorId: string, taskId: string): boolean {
    const taskHub = getTaskHub();
    const record = taskHub.get(taskId);
    if (!record || record.sessionId !== actorId) return false;
    if (
      record.state === "done" ||
      record.state === "failed" ||
      record.state === "cancelled"
    ) {
      return false;
    }
    taskHub.setState(taskId, "cancelled");
    console.info(`[AgentCore] 后台任务已取消 ${taskId} (goal=${record.goal.slice(0, 60)})`);
    return true;
  }

  dispatchBackgroundTask(
    actorId: string,
    input: {
      sessionId?: string;
      chatUserMessageId?: string;
      goal: string;
      source?: string;
      /**
       * 路由层 TurnPlan（2026-09-09）：route_task_plane 派发传入，取代默认快车道
       * 预算，让后台执行按意图档位（realtime/media=3 flash、multi-step=4 pro）运行。
       */
      turnPlan?: { budget: number; capabilities: string[]; tier: string };
      /**
       * 完整通道起步（2026-09-09）：跳过「桥工具快车道先试」——快车道只有
       * tool_discover 桥 + Flash 档，业务工具靠 BM25 召回两跳，弱模型
       * 经常跳过直接口头编结果（照片任务不真搜的根因）。路由派发恒为 true。
       */
      fullChannel?: boolean;
      /**
       * 外部轮上下文（2026-09-09）：后台 ephemeral 执行 msgs=[] 不读 thread，
       * 以下 prompt 块是后台执行唯一的记忆来源，缺省即「失忆执行」（「重新找」
       * 看不到上一轮的根因之一）。由调用方（handleUserMessage 任务面派发）透传。
       */
      route?: RouteDecision;
      narrativeRecall?: string;
      workingMemorySummary?: string;
      recentConversationHistory?: string;
      userLocation?: string;
      frequentPlaces?: string;
      personalization?: PersonalizationPromptSlice;
      shortTermTurn?: ShortTermTurnContext;
      orchestrateToolCtx?: ReturnType<AgentCore["buildOrchestrateOpts"]>;
      cognitiveEmotion?: import("../brain/types.js").EmotionVector | null;
      cognitiveUserPattern?: {
        topics: string[];
        preferredToolDomain?: string;
        negativeFeedbackCount: number;
        learningActive?: boolean;
      };
      cognitiveToolPlan?: import("../brain/tool-planning-cortex.js").ToolPlan;
      /**
       * 自动重跑代数（2026-09-23 重启恢复）：restart-recovery 重派被打断任务时
       * 传入（上一代 +1），TaskHub 台账据此累计，达上限不再自动重跑。
       */
      restartCount?: number;
      /**
       * token 审计 stage 覆盖（2026-10-01）：goal 计划步骤传 "goal_plan_stage"
       * 单列归因（usage 台账可见主动性执行成本），缺省按任务面 light/full 分档。
       */
      auditStage?: string;
    },
  ): string | null {
    const provider = this.chatProviderFor(actorId);
    if (!provider?.isEnabled()) return null;
    // 预算闸门（2026-09-19 P1-2）：会话/单日 token 超限时拒绝新的重活派发——
    // 已在跑的任务不中断，只不再叠加。返回 null 让 task.dispatch 向用户如实说明。
    if (isSessionBudgetExceeded(input.sessionId, actorId) || isDailyBudgetExceeded(actorId)) {
      console.warn(
        `[AgentCore] 预算超限，拒绝后台任务派发 (goal=${input.goal.slice(0, 60)})`,
      );
      return null;
    }
    const sessionId = input.sessionId?.trim() || actorId;
    const taskHub = getTaskHub();
    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    taskHub.submit({
      taskId,
      sessionId,
      ...(input.chatUserMessageId ? { replyAnchorId: input.chatUserMessageId } : {}),
      goal: input.goal,
      ...(input.restartCount && input.restartCount > 0 ? { restartCount: input.restartCount } : {}),
    });
    console.info(
      `[AgentCore] 后台任务已派发 ${taskId} (source=${input.source ?? "task.dispatch"}, goal=${input.goal.slice(0, 60)})`,
    );

    const registry = this.wsRegistry;
    const messageId = `assistant-task-${taskId}`;
    /** 软取消检查：cancelled 后停止一切向对话面的投递（增量/结果/thread 并入）。 */
    const isCancelled = (): boolean =>
      getTaskHub().get(taskId)?.state === "cancelled";
    let seq = 0;
    const pushDelta = (delta: string): void => {
      if (!delta || isCancelled()) return;
      seq += 1;
      try {
        registry?.trySend(
          sessionId,
          JSON.stringify({
            type: ServerEventType.ChatAssistantChunk,
            payload: {
              sessionId,
              messageId,
              chunk: delta,
              sequence: seq,
              phase: "stream",
              source: "task_plane",
            },
          }),
        );
      } catch {
        /* 投递失败不影响任务执行 */
      }
    };
    const pushDone = (
      finalText: string,
      mediaCards: MediaCardItem[] = [],
      followups: string[] = [],
    ): void => {
      try {
        // 投递失败（用户离线：trySend false / registry 缺失）→ TaskOutbox 暂存，
        // 客户端重连（session.init）时重放——离线完成的任务结果不再静默丢失。
        // 回复信封 blocks（v2 统一序列）：与 WS 对话路径同构——媒体段按交错锚定
        // 编入 blocks，卡片与照片同一条序列下发。原先 blocks 只装 text/card，
        // 客户端优先 blocks 即丢任务结果照片；renderBlocks 一并下发，旧客户端
        // 与历史回放（blocks 不落盘）走原字段回退。
        // 结构化通道迁移（2026-10-10）：正文中的 CONTENT_SUMMARY 块摘出为
        // summaryCard 字段，文本通道不携带 JSON（与 WS 对话路径同构）。
        let summaryCard: Record<string, unknown> | undefined;
        {
          const extracted = extractContentSummaryCard(finalText);
          if (extracted.card && mediaCards.length === 0) {
            summaryCard = extracted.card;
          }
          finalText = extracted.text;
        }
        // 平铺图集无条件走 captioned 版式（2026-10-21）：照片之间只允许各自的
        // caption，正文整块放在图集前；caption 缺失也不再切段交错。
        const renderBlocks =
          mediaCards.length > 0
            ? allImageCardsHaveCaption(mediaCards) || isFlatImageGallery(mediaCards)
              ? buildCaptionedRenderBlocks(finalText, mediaCards)
              : buildInterleavedRenderBlocks(finalText, mediaCards)
            : [];
        const replyBlocks = buildReplyBlocks(finalText, renderBlocks);
        const delivered = registry?.trySend(
          sessionId,
          JSON.stringify({
            type: ServerEventType.ChatAssistantDone,
            payload: {
              sessionId,
              messageId,
              finalText,
              toolCalls: [],
              source: "task_plane",
              ...(mediaCards.length > 0 ? { mediaCards } : {}),
              ...(summaryCard ? { summaryCard } : {}),
              ...(renderBlocks.length > 0 ? { renderBlocks } : {}),
              ...(replyBlocks && replyBlocks.length > 0 ? { blocks: replyBlocks } : {}),
              // 「接下来你可以」接续建议：任务轮与对话面同权随 done 下发成
              // 可点胶囊（客户端 done 处理不区分 source，同样解析 followups）。
              ...(followups.length > 0 ? { followups } : {}),
            },
          }),
        );
        if (!delivered) {
          getTaskOutbox().enqueue(sessionId, {
            messageId,
            finalText,
            mediaCards,
            ...(summaryCard ? { summaryCard } : {}),
            ...(followups.length > 0 ? { followups } : {}),
          });
        }
      } catch {
        getTaskOutbox().enqueue(sessionId, {
          messageId,
          finalText,
          mediaCards,
          ...(followups.length > 0 ? { followups } : {}),
        });
      }
    };

    void (async () => {
      // A3 后台任务全局并发闸（2026-09-08）：超出的任务在此 FIFO 排队（acquire 无超时），
      // 防止无限并行同时打满 LLM provider 限流。排队期间 TaskHub 仍为 running，
      // 进度行注明等待槽位。
      getTaskHub().setProgress(taskId, "等待并行执行槽位");
      const releaseTaskSlot = await backgroundTaskLimiter.acquire(0);
      // 排队期间被取消：出列即短路，不再执行（已广播 cancelled 回执）
      if (isCancelled()) {
        releaseTaskSlot();
        return;
      }
      const firstAttemptStart = Date.now();
      // 外部轮上下文透传（2026-09-09）：ephemeral 执行 msgs=[] 不读 thread，记忆/
      // 召回/位置等全部依赖这些 prompt 块；两段执行（首跑 + 升级重跑）共用。
      const carriedTurnCtx = {
        ...(input.narrativeRecall ? { narrativeRecall: input.narrativeRecall } : {}),
        ...(input.workingMemorySummary ? { workingMemorySummary: input.workingMemorySummary } : {}),
        ...(input.recentConversationHistory
          ? { recentConversationHistory: input.recentConversationHistory }
          : {}),
        ...(input.userLocation ? { userLocation: input.userLocation } : {}),
        ...(input.frequentPlaces ? { frequentPlaces: input.frequentPlaces } : {}),
        ...(input.personalization ? { personalization: input.personalization } : {}),
        ...(input.shortTermTurn ? { shortTermTurn: input.shortTermTurn } : {}),
        ...(input.orchestrateToolCtx ? { orchestrateToolCtx: input.orchestrateToolCtx } : {}),
        ...(input.cognitiveEmotion ? { cognitiveEmotion: input.cognitiveEmotion } : {}),
        ...(input.cognitiveUserPattern ? { cognitiveUserPattern: input.cognitiveUserPattern } : {}),
        ...(input.cognitiveToolPlan ? { cognitiveToolPlan: input.cognitiveToolPlan } : {}),
      };
      /** 媒体结果捕获：search_images/search_videos 结果随任务结果消息投递 mediaCards。 */
      const capturedMedia: Array<{ toolName: string; result: Record<string, unknown> }> = [];
      /** 行程回执捕获：travel.plan-itinerary 执行回执，收尾时确定性附行程卡（与 WS 对话路径同构）。 */
      const capturedTravel: Array<{ toolName: string; result: Record<string, unknown> }> = [];
      try {
        // 快速通道（默认起步，2026-09-05 先轻后重）：tool router 召回执行
        //（可见集=桥工具，零业务 schema）+ Flash 档；段1 即流式（A4，2026-09-08）：
        // 产出直接推给用户（pushDone 以完整 finalText 收尾同一 messageId），升级段延续同一消息流。
        // 路由派发（fullChannel）跳过快车道：delegate 能力束直接注入业务工具，
        // 避免「Flash + 桥两跳召回」弱链路跳过工具口头编结果。
        let result = await this.runStandardLlmPath(
          actorId,
          input.goal,
          "task",
          {
            sessionId,
            ...(input.chatUserMessageId ? { chatUserMessageId: input.chatUserMessageId } : {}),
            onAssistantDelta: pushDelta,
            // 复用外部轮语义路由（2026-09-09）：内层不再对裸 goal 重新路由——
            // 省一次路由 LLM 调用，且防短 goal 被改判 chat 面而跳过工具。
            ...(input.route ? { routeDecision: input.route } : {}),
          },
          {
            sessionId,
            turnPlan:
              input.turnPlan ?? { budget: TASK_PLANE_FALLBACK_BUDGET, capabilities: ["full"], tier: "flash" },
            taskHubTaskId: taskId,
            ephemeralTurn: true,
            ...(input.auditStage ? { auditStageOverride: input.auditStage } : {}),
            // 记忆注入（2026-09-09）：ephemeral 不读 thread，上下文全靠外部轮透传。
            ...carriedTurnCtx,
            // 媒体捕获必须挂 ctx.backgroundOnToolExecuted：runStandardLlmPath 的
            // toolCtx 只接 ctx 层回调（orchestrateToolCtx / backgroundOnToolExecuted），
            // opts.onExternalToolExecuted 在后台路径不会被读取（挂错层 = 卡片恒空）。
            backgroundOnToolExecuted: (info) => {
              if (info.ok && info.result) {
                capturedMedia.push({ toolName: info.toolName, result: info.result });
                if (info.toolName === "travel.plan-itinerary") {
                  capturedTravel.push({ toolName: info.toolName, result: info.result });
                }
              }
            },
            ...(input.fullChannel ? {} : { toolRecallOnly: true }),
          },
        );
        let finalText = (result.text ?? "").trim();
        const firstAttemptedTools = result.attemptedToolCalls ?? [];
        const firstAttemptMs = Date.now() - firstAttemptStart;
        if (!finalText || isApologyStyleFallback(finalText)) {
          // 分级升级（A2，2026-09-08）：废除无差别整轮重放（旧"先轻后重"残留，
          // 与双面架构"升级重放→换路续波"原则相悖）。
          // - 段1 已真实调用过工具 → 召回是好的、败在收尾：保留桥召回（toolRecallOnly，
          //   免 planner + 免全量 schema），把已尝试的调用轨迹带入升级段 prompt，
          //   相同调用在 60s TTL 缓存内直接复用结果，不重复执行；
          // - 段1 零工具调用 → 大概率召回失败：维持完整通道（planner 显式注入）。
          const carryTrace = firstAttemptedTools.length > 0;
          if (carryTrace) {
            pushDelta("\n\n");
          }
          console.info(
            `[AgentCore] 后台任务首轮未收尾，升级重跑（${carryTrace ? "延续已执行轨迹" : "完整重规划"}）：${input.goal.slice(0, 60)}`,
          );
          const upgradedGoal = carryTrace
            ? `${input.goal}\n\n[系统备注] 此前一次快速执行已调用过：${firstAttemptedTools.slice(0, 6).join("；")}，但未产出有效回复。请在其基础上继续完成任务并给出最终回复；相同调用的结果已被缓存，可直接重发获取，不要从零重复无关步骤。`
            : input.goal;
          result = await this.runStandardLlmPath(
            actorId,
            upgradedGoal,
            "task",
            {
              sessionId,
              ...(input.chatUserMessageId ? { chatUserMessageId: input.chatUserMessageId } : {}),
              onAssistantDelta: pushDelta,
              ...(input.route ? { routeDecision: input.route } : {}),
            },
            {
              sessionId,
              turnPlan: { budget: 3, capabilities: ["full"], tier: "pro" },
              taskHubTaskId: taskId,
              ephemeralTurn: true,
              ...(input.auditStage ? { auditStageOverride: input.auditStage } : {}),
              // 升级段同样透传外部轮上下文（失忆执行会在升级段复发）。
              ...carriedTurnCtx,
              backgroundOnToolExecuted: (info) => {
                if (info.ok && info.result) {
                  capturedMedia.push({ toolName: info.toolName, result: info.result });
                  if (info.toolName === "travel.plan-itinerary") {
                    capturedTravel.push({ toolName: info.toolName, result: info.result });
                  }
                }
              },
              ...(carryTrace ? { toolRecallOnly: true } : {}),
            },
          );
          finalText = (result.text ?? "").trim();
          recordBackgroundOutcome(
            finalText ? "upgraded_ok" : "failed",
            firstAttemptMs,
            input.goal,
          );
        } else {
          recordBackgroundOutcome("direct_ok", firstAttemptMs, input.goal);
        }
        // 已取消：轮次自然跑完但一切投递/记账短路——结果不进对话、不并 thread，
        // TaskHub 终态维持 cancelled（不被 done/failed 覆盖）。
        if (isCancelled()) {
          console.info(`[AgentCore] 后台任务取消后收尾，结果不再投递 ${taskId}`);
          return;
        }
        taskHub.setState(taskId, finalText ? "done" : "failed");
        // 媒体卡片聚合：search_images/search_videos 真实执行结果转结构化卡片，
        // 随任务结果消息投递（否则照片任务只有文字描述，卡片到不了客户端）。
        let mediaCards: MediaCardItem[] = [];
        for (const mt of capturedMedia) {
          const cards = extractMediaCards(mt.toolName, mt.result);
          if (cards.length > 0) mediaCards.push(...cards);
        }
        mediaCards = trimMediaCardsByTopic(dedupMediaCards(mediaCards), {
          maxPerGroup: 4,
          maxPerSide: 2,
        });
        // 真实图片描述（Coze 式「一图一句」，2026-10-06 补接）：任务面照片轮此前
        // 只在 WS 对话面路径（chat-user-message）生成 caption，任务面收尾漏接
        // ——用户要的「每张照片一句解读」在照片任务上永远缺席（真链取证）。
        // 失败/超时静默跳过，卡片保持无 caption 走旧渲染，与对话面降级策略一致。
        if (mediaCards.length > 0 && isImageCaptionEnabled()) {
          try {
            await captionMediaCards(mediaCards, {
              voice: { userText: input.goal, replyText: finalText },
            });
          } catch (err) {
            console.info(
              `[AgentCore] 任务面图片描述生成异常（忽略，回退旧渲染）: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
        }
        // 结果不带「[后台任务·目标]」标识头（2026-09-09 产品决策）：对话面已有
        // 任务回执交代来龙去脉，结果气泡只呈现结果本体。归属仍由对话 thread 的
        // 单条「任务记录」承接（LLM 上下文可见，用户不可见）。
        if (finalText) {
          // 任务面结果不走 WS 管线的 processAssistantText（那里才做声明清洗/
          // 渲染路由），这里补齐同构的出口处理：剥模型复述的展示形态声明行
          // （[RENDER_HINT:xxx]/[RENDER_AS:xxx]，否则原样透出到用户屏幕）、
          // 附行程卡、版式归一化——与 WS 对话路径同构。
          finalText = stripResidualRenderDeclarations(finalText);
          // 「接下来你可以」接续建议剥离（2026-09-24 大理轮）：与 WS 对话面出口
          // 同构（chat-user-message extractNextUpSuggestions）。任务面收尾此前
          // 漏接这层——模型按 render 协议写在回复末尾的 [NEXT_UP_START] 块原样
          // 透出到用户屏幕并随任务记录固化进对话历史。建议句改随 done 载荷
          // 下发成可点胶囊；落库文本用剥后的 finalText，不再污染 LLM 上下文。
          // 顺序铁律：先剥 NEXT_UP 再附行程卡——模型把建议块写在回复末尾，
          // 行程卡附在它后面，若先附卡后剥离，extractNextUpSuggestions 从
          // [NEXT_UP_START] 起整段截断会把尾部行程卡一并吃掉（真机复现实证）。
          const nextUp = extractNextUpSuggestions(finalText);
          finalText = nextUp.text;
          // 行程回执裁决与 WS 对话路径同构（resolveTravelReceipt）：捕获漏拍
          // （缓存重放/升级段边缘）时按冷层近窗回捞兜底。任务面执行可能在
          // 并发闸排队，窗口放宽到 10 分钟，目标/正文点名目的地优先。
          const travelReceipt = capturedTravel[capturedTravel.length - 1];
          const resolvedTravel = resolveTravelReceipt({
            executedReceipt: travelReceipt?.result,
            goal: input.goal,
            finalText,
            fallbackWindowMs: 10 * 60 * 1000,
          });
          console.info(
            `[AgentCore] 任务面收尾附卡检查: capturedTravel=${capturedTravel.length} capturedMedia=${capturedMedia.length} tool=${travelReceipt?.toolName ?? resolvedTravel.toolName ?? "none"}`,
          );
          if (resolvedTravel.toolName && resolvedTravel.result) {
            finalText = attachTravelItineraryCard(
              finalText,
              resolvedTravel.toolName,
              resolvedTravel.result,
            );
            // 简报卡与对话面同构：把「这版按哪些假设排的」摊开 + 一键补心愿点
            finalText = attachTravelBriefCard(finalText, resolvedTravel.result);
          }
          // 视频媒体卡（2026-10-02）：video.grab/video.find 回执带可播放流时附
          // [RENDER_AS:video] 媒体标记，与 WS 对话面 attachDeterministicCards 的
          // videoResults 同构。任务面此前漏接——贴链接解析出无水印直链只能口头转述，
          // 客户端出不了内联播放器（真机复现：task_plane_light 轮解析成功但回复是纯文本直链）。
          const videoReceipt = [...capturedMedia]
            .reverse()
            .find((mt) => resolveVideoMediaSource(mt.toolName, mt.result) !== null);
          if (videoReceipt) {
            finalText = attachVideoMediaMarker(
              finalText,
              videoReceipt.toolName,
              resolveVideoMediaSource(videoReceipt.toolName, videoReceipt.result) ?? undefined,
            );
          }
          finalText = normalizeReplyCardLayout(finalText);
          // 对话 thread 以单条「任务记录」并入（ephemeral 执行不自动落 thread）。
          // 2026-09-08 改造：不再伪造 user 轮「[后台任务] <原文>」+ assistant 回复对
          // ——user 轮会让后续对话把任务原文当作用户说过的话接茬（说媒事故根因之一）。
          try {
            provider.appendTaskRecord?.(
              resolvePrimaryChatSessionId(
                actorId,
                getAgentRuntimeConfig().masterDelegation.enabled,
              ),
              input.goal,
              finalText,
            );
          } catch {
            /* thread 并入失败不影响结果投递 */
          }
          pushDone(finalText, mediaCards, nextUp.followups);
        } else {
          // 结构化失败回执（2026-09-19 P0-2）：执行跑完但没产出有效结果——
          // 带目标回显 + 下一步指引，且与成功路径同样并入对话 thread，
          // 否则对话面对「没办成」失忆，用户追问时模型只能靠回执猜。
          const notice = buildTaskFailureNotice(input.goal);
          try {
            provider.appendTaskRecord?.(
              resolvePrimaryChatSessionId(
                actorId,
                getAgentRuntimeConfig().masterDelegation.enabled,
              ),
              input.goal,
              notice,
            );
          } catch {
            /* thread 并入失败不影响结果投递 */
          }
          pushDone(notice);
        }
      } catch (err) {
        // 取消后的异常（含短路退出触发的竞态）不覆盖 cancelled 终态、不投递兜底文案
        if (!isCancelled()) {
          taskHub.setState(taskId, "failed");
          getTaskHub().setProgressThrottled(taskId, "执行失败");
          console.error("[AgentCore] 后台任务执行失败:", err);
          const notice = buildTaskFailureNotice(input.goal, err);
          try {
            provider.appendTaskRecord?.(
              resolvePrimaryChatSessionId(
                actorId,
                getAgentRuntimeConfig().masterDelegation.enabled,
              ),
              input.goal,
              notice,
            );
          } catch {
            /* thread 并入失败不影响结果投递 */
          }
          pushDone(notice);
        }
      } finally {
        releaseTaskSlot();
      }
    })();
    return taskId;
  }

  /**
   * 中断/异常轮次的最小化兜底记账（2026-09-08）。
   *
   * 背景：轮次被新消息打断或异常失败时，各执行路径的 catch 直接返回空结果，
   * turnFinalizer.finish 整体跳过——已流式送达用户的部分回复不进任何账本：
   * 短期记忆挂起栈里的原始请求无法结清（默认 TTL 6 小时，期间每轮注入 open-loops，
   * agent 会反复重问已办成的事，实测「安排好了 11:30 提醒」后仍被追问「要提前多久」）、
   * turn WAL / 当日日志缺失该轮。
   *
   * 本方法以「已送达的部分回复」完成最小化收尾：STM 挂起项结清、WAL/日志记账、
   * 高信号记忆种植。只做记账，不触发任何 LLM 调用（finish 的 regenerateEmptyReply
   * 仅在文本为空时触发，此处文本非空不会走到）。幂等安全：reconcile/入栈均为
   * 去重幂等操作，重复调用无副作用。
   *
   * @param partialAssistantText 已流式送达用户的部分回复（空串时为无操作）
   */
  settleInterruptedTurn(
    actorId: string,
    userText: string,
    partialAssistantText: string,
    meta?: { sessionId?: string; messageId?: string },
  ): void {
    const trimmed = partialAssistantText.trim();
    if (!trimmed) return;
    void this.turnFinalizer
      .finish(actorId, userText, trimmed, {
        streamedChunks: true,
        modelCallsConsumed: 1,
        planExecuteUsed: false,
        pePlan: null,
        peExhausted: false,
        ...(meta?.messageId ? { messageId: meta.messageId } : {}),
        ...(meta?.sessionId ? { sessionId: meta.sessionId } : {}),
      })
      .catch((err) => {
        console.warn("[AgentCore] 中断轮次兜底记账失败(忽略):", err);
      });
  }

  /**
   * 紧急重生成：当主流程 + 降级都失败时，用最小化 prompt 直接调 LLM 生成回复。
   * 不再用 apology 兜底文案——让 agent 真正回复内容，哪怕是简短的。
   * 返回空串（而非 apology）让上层用工具结果拼接，调用方需处理空串。
   */
  private async emergencyRegenerate(
    actorId: string,
    userText: string,
    onAssistantDelta?: (delta: string) => void,
  ): Promise<string> {
    try {
      const provider = this.chatProviderFor(actorId);
      if (!provider?.isEnabled()) return "";
      const text = await provider.streamCompletion(
        `emergency-${actorId}-${Date.now()}`,
        { text: userText },
        (delta) => onAssistantDelta?.(delta),
        undefined,
        {
          ephemeralTurn: true,
          disableThinking: true,
          maxThreadMessages: 3,
        },
      );
      return text.trim();
    } catch (err) {
      console.error("[AgentCore] emergencyRegenerate 也失败:", err);
      return "";
    }
  }


private async finishLlmTurn(
    actorId: string,
    userText: string,
    assistantText: string,
    meta: {
      streamedChunks: boolean;
      modelCallsConsumed: number;
      planExecuteUsed: boolean;
      pePlan: TaskExecutionPlan | null;
      peExhausted: boolean;
      messageId?: string;
      sessionId?: string;
    },
    onAssistantDelta?: (delta: string) => void,
  ): Promise<AgentReply> {
    const outputSafety = this.brainCenter?.checkOutputSafety(assistantText, {
      actorId,
      sessionId: meta.sessionId,
      userText,
    });
    let sanitizedOutput = outputSafety?.sanitized ?? assistantText;

    // 剥离 LLM 回显的内部信号标签前缀（根源净化已在 provider 推流咽喉完成，
    // 这里是最终兜底，双保险防标签透出）：
    //  - 话题切换标签：[话题切换，只答这个] / [Topic switched — don't revisit.]
    //  - 停止/待用户输入信号：[STOP needs a message from the user]
    // 零 token 程序层剥离，不做重生成。
    sanitizedOutput = stripInternalControlTags(sanitizedOutput);

    // 钩子 3：RuntimeKernel 后置校验（零 token，程序层拦截违规输出）
    // 全程不向 LLM 发任何约束 prompt，纯规则匹配。违规时记录日志但不阻断输出（避免循环重生成）
    const runtimeKernel = getRuntimeKernel(actorId);
    if (runtimeKernel.isMinimalMode()) {
      const postResult = runtimeKernel.postValidate(sanitizedOutput);
      if (!postResult.ok) {
        console.warn(
          `[RuntimeKernel.postValidate] 输出违规，命中 ${postResult.hitPatterns.length} 条规则：`,
          postResult.violations,
        );
        // 当前策略：仅记录日志，不重生成（避免循环 + 失败时仍要给用户回复）
        // 后续如需重生成，可在此处加 retry 逻辑
      }
    }

    const trimmed = sanitizedOutput.trim();
    if (!trimmed) {
      // 空响应修复：不再用兜底文案，而是重新调用一次 LLM 强制出文本。
      // 根因：某些轮次 LLM 只返回 tool_calls 没有文本 delta，streamCompletion 返回空字符串。
      // 重新调用（不带工具上下文）让 LLM 基于对话历史生成自然回复。
      console.warn("[AgentCore] finishLlmTurn 收到空响应，重新调用 LLM 强制出文本");
      try {
        const provider = this.chatProviderFor(actorId);
        if (provider?.isEnabled()) {
          const regenerateText = await provider.streamCompletion(
            `regen-${actorId}-${Date.now()}`,
            { text: `${userText}\n\n[系统提示：上一轮没有生成回复文本，请直接用自然语言回答用户]` },
            (delta) => onAssistantDelta?.(delta),
            undefined,
            {
              ephemeralTurn: true,
              disableThinking: true,
              maxThreadMessages: 4,
            },
          );
          const regenTrimmed = regenerateText.trim();
          if (regenTrimmed) {
            return {
              text: regenTrimmed,
              streamedChunks: meta.streamedChunks,
            };
          }
        }
      } catch (regenErr) {
        console.error("[AgentCore] 重新调用 LLM 也失败:", regenErr);
      }
      // 重新调用也失败：返回空串让上层用工具结果拼接，不用 apology 文案
      return {
        text: "",
        streamedChunks: false,
      };
    }


    const { quotaSuffix } = this.turnLifecycle.finalizeTurn({
      actorId,
      userText,
      assistantText: trimmed,
      sessionId: meta.sessionId,
      modelCallsConsumed: meta.modelCallsConsumed,
      planExecuteUsed: meta.planExecuteUsed,
      pePlan: meta.pePlan,
      peExhausted: meta.peExhausted,
      messageId: meta.messageId,
    });

    if (this.shortTermMemoryGateway && meta.sessionId) {
      this.shortTermMemoryGateway.reconcileTaskAfterTurn(meta.sessionId, userText, trimmed);
      getDailyJournalService()?.appendTurn(actorId, meta.sessionId, userText, trimmed);
    }

    return {
      text: quotaSuffix ? `${trimmed}\n\n${quotaSuffix}` : trimmed,
      streamedChunks: meta.streamedChunks,
    };
  }
}
