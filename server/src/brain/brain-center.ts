// Agent Brain Center — 外观类
import { randomUUID } from "node:crypto";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { getChatThreadStore } from "../external-model/chat-thread-store.js";
import { getAgentRuntimeConfig } from "../agent/agent-runtime-config.js";
import {
  isNotesChatSessionId,
  resolvePrimaryChatSessionId,
} from "../agent/master-chat-session.js";
import type {
  AudioBufferRef,
  BrainDecision,
  BrainSignalInput,
  BrainSnapshot,
  CapabilityDescriptor,
  CapabilityGapReport,
  CognitiveContext,
  CognitiveEngine,
  CognitiveInput,
  CognitiveResult,
  EmotionVector,
  EvolutionProposal,
  MemoryConsolidationStats,
  MemoryDomainKind,
  MemoryItem,
  MemoryRecallItem,
  MemoryRecallResult,
  PredictedAssociation,
  PlanResult,
  SalienceDecision,
  ReActObservation,
  SafetyCheckResult,
  SensoryFrame,
  SensoryListenResult,
  SensoryLookResult,
  SensorySpeakResult,
  SynapseEnvelope,
  SynapseMessage,
  SystemRouteDecision,
  TonePolicyResult,
  UserActivityState,
  UserMentalState,
  VisualInput,
  PersonalityCore,
  InferenceClue,
  InferenceResult,
} from "./types.js";
import type { EmotionState } from "./memory-cognitive/memory-inference-emotion-modulator.js";
import type {
  LearningFeedback,
  LearningSnapshot,
} from "./memory-cognitive/memory-experience-learning-loop.js";
import type { MemoryFeedbackInput } from "./memory-strength-model.js";
import type { SessionEpitomeEntries, SessionEpitomeSnapshot } from "../services/session-epitome.js";
import { extractEpitomeEntries, SessionEpitomeTurnGate } from "../services/session-epitome.js";
import type { RuntimeKernel, RuntimeKernelState } from "../agent/runtime-kernel.js";
import { getRuntimeKernel } from "../agent/runtime-kernel.js";
import { shouldRecallLongTerm } from "../agent/recall-gate.js";
import type { BodyGatewayLike, BodyState } from "../body/types.js";
import { isMultimodalFusionEnabled } from "./multimodal-fusion-cortex.js";

function stableLearningKey(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function summarizeLearningText(text: string, max = 180): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length <= max ? compact : `${compact.slice(0, max - 1)}…`;
}

function formatRecentConversationLine(msg: ChatCompletionMessageParam): string | null {
  const role = msg.role === "user" ? "用户" : msg.role === "assistant" ? "Agent" : null;
  if (!role) return null;
  const content = typeof msg.content === "string" ? msg.content : "[多模态消息]";
  const cleaned = content.replace(/^\[ts:[^\]]+\]\n?/, "").trim();
  return cleaned ? `${role}：${cleaned}` : null;
}

function looksLikeUserCorrection(text: string): boolean {
  return /(?:不对|不是|错了|纠正|更正|应该是|应当是|其实是|不是这样|你理解错|you are wrong|actually|correction)/i.test(
    text,
  );
}

// 能力皮层外观接口（后续 CapabilityCortex 实现可直接传入）
interface CapabilityCortexLike {
  start?(): Promise<void>;
  stop?(): Promise<void>;
  introspect(actorId: string): CapabilityDescriptor[];
  identifyGap?(scenario: string): Promise<CapabilityGapReport>;
  /**
   * 用 ToolRegistry 当前全量工具名重新填充各 domain 的 descriptor.tools。
   * 用于动态注册（MCP / self-programming）后让 list_capabilities 返回真实工具。
   * 带 TTL 节流避免短时间内重复刷新。
   */
  attachToolNames?(toolNames: string[]): void;
}

// 觉察皮层外观接口
interface AwarenessCortexLike {
  start?(): Promise<void>;
  stop?(): Promise<void>;
  observe(actorId: string): UserActivityState | null;
  /**
   * 语义觉察：返回用户活动状态 + 心智状态复合对象。
   * 供对话内主动钩子等入口按需调用（fire-on-demand），
   * 只在真正需要感知用户当下状态时取，避免每轮对话都跑浪费 token。
   */
  observeWithMental?(
    actorId: string,
    opts?: { recentConversationHistory?: string },
  ): Promise<{ activity: UserActivityState | null; mental: UserMentalState | null }>;
  /**
   * 元认知置信度评估（Stage 4 Task 3）。
   * 在 cognize 路由前调用；score < 0.4 时由 BrainCenter 强制升级到 complex。
   * 未注册（无 awareness）时 cognize 跳过该步。
   */
  assessConfidence?(
    query: string,
    recallResult: { items: unknown[] } | null,
    capabilities: unknown[],
  ): { score: number; reason: string };
}

// 主动皮层外观接口
interface ProactionCortexLike {
  start?(): Promise<void>;
  stop?(): Promise<void>;
  decide(signal: BrainSignalInput): Promise<BrainDecision>;
  recentDecisions?(actorId: string): BrainDecision[];
}

// 进化皮层外观接口
interface EvolutionCortexLike {
  start?(): Promise<void>;
  stop?(): Promise<void>;
  evolve(
    proposal: Omit<EvolutionProposal, "id" | "status" | "createdAt" | "updatedAt">,
  ): EvolutionProposal;
  listPending?(actorId?: string): EvolutionProposal[];
  /** 显式查询入口：基于规则产出能力进化提案统计 */
  proposeEvolution?(actorId: string): { proposals: number; reason: string };
  /** 真正的失败时自我学习入口：AgentCore 工具调用结束（含失败）时通过 BrainCenter 转发到此 */
  recordToolInteraction?(params: {
    sessionId: string;
    userRequest: string;
    attemptedTools: string[];
    success: boolean;
    errorMessage?: string;
    responseTime?: number;
  }): Promise<void>;
  /** 显式执行入口：外部（用户 / Agent）按 id 触发单个提案执行 */
  executeProposal?(proposalId: string): Promise<{
    ok: boolean;
    proposal: EvolutionProposal | null;
    error?: string;
  }>;
  approveByUser?(
    proposalId: string,
    sessionId?: string,
  ): Promise<{ ok: boolean; proposal: EvolutionProposal | null; error?: string }>;
  rejectByUser?(
    proposalId: string,
    reason: string | undefined,
    sessionId?: string,
  ): { ok: boolean; proposal: EvolutionProposal | null };
}

// 自我修复皮层外观接口
interface CodeRepairCortexLike {
  start?(): Promise<void>;
  stop?(): Promise<void>;
  /** 报告 bug 信号，触发自动修复 */
  reportBug?(signal: import("./types.js").BugSignal): Promise<import("./types.js").RepairProposal>;
  /** 列出修复提案（可按状态过滤） */
  listRepairs?(status?: import("./types.js").RepairStatus): import("./types.js").RepairProposal[];
  /** 查询单个修复提案 */
  getRepair?(id: string): import("./types.js").RepairProposal | null;
  /** 用户强制重试 */
  retry?(id: string): Promise<import("./types.js").RepairProposal | null>;
}

// 感官皮层外观接口
interface SensoryCortexLike {
  start?(): Promise<void>;
  stop?(): Promise<void>;
  listen(
    audio: AudioBufferRef,
    opts?: { language?: string },
  ): Promise<SensoryListenResult>;
  look(opts?: VisualInput): Promise<SensoryLookResult>;
  speak(
    text: string,
    opts?: { voiceId?: string; channel?: string },
  ): Promise<SensorySpeakResult>;
  buildSensoryFrame(args: {
    actorId: string;
    audioText?: string;
    visualDescription?: string;
    emotion?: EmotionVector;
    activity?: UserActivityState;
  }): SensoryFrame;
  getStats(): { totalListen: number; totalLook: number; totalSpeak: number };
}

// 记忆皮层外观接口
interface MemoryCortexLike {
  start?(): Promise<void>;
  stop?(): Promise<void>;
  remember(actorId: string, item: MemoryItem): Promise<void>;
  /**
   * 批量写入记忆（性能优化方案 D）。
   * 一次 IO 写入多条记忆，避免 cognize 阶段 3 多次独立 remember 调用。
   * 未实现时 BrainCenter 回退到逐条 remember。
   */
  rememberBatch?(actorId: string, items: MemoryItem[]): Promise<void>;
  recordLearningFeedback?(feedback: LearningFeedback): Promise<LearningSnapshot | null>;
  getLearningSnapshot?(actorId: string): LearningSnapshot | null;
  /**
   * 记忆相关性在线反馈回灌：记录用户对召回记忆的反馈（显式/隐式），
   * 按语义指纹持久化，后续 recall 对命中条目做加成/惩罚调整排序。
   */
  recordMemoryFeedback?(input: MemoryFeedbackInput): void;
  /** 读取某 actor 的记忆反馈快照（调试/统计用）。 */
  getMemoryFeedbackSnapshot?(actorId: string): unknown;
  /** 隐式反馈批量回灌（P1-3）：ImplicitFeedbackDetector 检测结果 → MemoryFeedbackStore。 */
  recordImplicitFeedbacks?(
    actorId: string,
    signals: Array<{ memoryContent: string; signal: "positive" | "negative" | "weak_negative"; reason: string }>,
  ): void;
  /** 记忆目录摘要（P2-1 元认知：知道自己记住了什么）。 */
  getInventorySummary?(actorId: string): Promise<string>;
  /** 跨会话开放环路：记录 open loops / 承诺 / 偏好（KV 持久化）；turnText 用于完成检测。 */
  updateSessionEpitome?(actorId: string, entries: SessionEpitomeEntries, turnText?: string): void;
  /** 读取某 actor 的跨会话开放环路快照（新会话开场注入用）。 */
  getSessionEpitome?(actorId: string): SessionEpitomeSnapshot | null;
  /** 读取某 actor 的最近召回锚点（连续性诊断用）。 */
  getRecallAnchors?(actorId: string): unknown[];
  recall(
    actorId: string,
    query: string,
    opts?: { domain?: MemoryDomainKind; limit?: number; subQueries?: string[] },
  ): Promise<MemoryRecallResult>;
  recallCrossDomain(actorId: string, query: string): Promise<MemoryRecallResult>;
  consolidate(actorIds: string[]): Promise<MemoryConsolidationStats>;
  /** 拉取结构化人格内核（personality 域），未设置时返回默认人格 */
  getPersonalityCore?(actorId: string): PersonalityCore;
  /**
   * 元记忆召回：附带来源（provenance）与置信分层（confidenceTier）。
   * 记忆认知架构升级（Phase 4）：cognize 阶段优先使用此方法，
   * 未注册 MetacognitionBridge 时降级到普通 recall。
   */
  recallWithProvenance?(
    actorId: string,
    query: string,
    opts?: { domain?: MemoryDomainKind; limit?: number; subQueries?: string[] },
  ): Promise<MemoryRecallResult>;
  /** 联想预判（委托 AssociativeGraph，未注册返回空结果） */
  predictAssociation?(actorId: string, query: string): Promise<PredictedAssociation>;
  /** 显著性评估（委托 SalienceFilter，未注册返回默认接受） */
  evaluateSalience?(item: MemoryItem): SalienceDecision;
  /** 向量预筛（recall-gate 白名单外的放行通道；未注册返回 false） */
  semanticRecallPreScreen?(actorId: string, query: string): Promise<boolean>;
  /** 多线索交叉推理（委托 InferenceEngine，未注册返回空结果） */
  inferFromClues?(
    actorId: string,
    clues: InferenceClue[],
    emotion?: EmotionState | null,
  ): Promise<InferenceResult>;
  /** 触发规则自学习（委托 RuleLearner，未注册返回空） */
  autoLearn?(actorId?: string): Promise<unknown[]>;
  /** 获取已学习规则（未注册返回空） */
  getLearnedRules?(): unknown[];
  /** 获取已迁移规则（未注册返回空） */
  getMigratedRules?(): unknown[];
}

// 突触总线外观接口
interface SynapseBusLike {
  start?(): Promise<void>;
  stop?(): Promise<void>;
  fire(
    type: string,
    data: Record<string, unknown>,
    opts?: { actorId?: string; source?: string },
  ): SynapseEnvelope;
  subscribe(
    type: string,
    handler: (msg: SynapseMessage) => void | Promise<void>,
  ): () => void;
  sendToAgent(
    targetAgentId: string,
    message: { type: string; data: Record<string, unknown> },
    opts?: { from?: string },
  ): Promise<SynapseEnvelope>;
  sendToUser(
    actorId: string,
    payload: unknown,
    opts?: { channel?: string },
  ): Promise<SynapseEnvelope>;
  getRecentMessages(limit?: number): SynapseMessage[];
  getSubscriberCount(): number;
}

// 边缘皮层外观接口
interface LimbicCortexLike {
  start?(): Promise<void>;
  stop?(): Promise<void>;
  checkSafety(
    action: { tool: string; args: Record<string, unknown> },
    ctx?: Record<string, unknown>,
  ): SafetyCheckResult;
  inferEmotion(
    actorId: string,
    signals: { text?: string; voiceTone?: unknown; faceMetrics?: unknown },
  ): Promise<EmotionVector>;
  applyTonePolicy(text: string, emotion: EmotionVector): TonePolicyResult;
  getLastEmotion(actorId: string): EmotionVector | null;
  getLastSafetyCheck(): SafetyCheckResult | null;
  /**
   * 输出安全过滤（Stage 4 Task 2）：检测 LLM 输出文本中的敏感信息并替换为 [REDACTED]。
   * 未注册（无 limbic）时 cognize / executeProactiveDecision 跳过该步（原文本透传）。
   */
  checkOutputSafety?(
    text: string,
    ctx?: Record<string, unknown>,
  ): { safe: boolean; sanitized: string; reason?: string };
}

// 规划皮层外观接口
interface PlannerCortexLike {
  start?(): Promise<void>;
  stop?(): Promise<void>;
  plan(
    goal: string,
    opts?: { actorId?: string; maxSteps?: number },
  ): Promise<PlanResult>;
  execute(plan: PlanResult, opts?: { actorId?: string }): Promise<PlanResult>;
  react(observation: ReActObservation): ReActObservation;
  delegate(
    subAgentType: string,
    task: { goal: string; input?: unknown },
    opts?: { actorId?: string },
  ): Promise<unknown>;
  routeSystem(userMessage: string, opts?: { actorId?: string }): SystemRouteDecision;
  /**
   * LLM 语义委派判断（shouldDelegate 的 LLM 化版本，async）。
   * 替代原 DELEGATE_KEYWORDS 纯关键词匹配，做语义级判断。
   * 未注入 DelegateJudge 或降级开关关闭时回退到 shouldDelegate 规则匹配。
   */
  shouldDelegateWithLLM?(
    userMessage: string,
    context?: { actorId?: string },
  ): Promise<{
    delegate: boolean;
    agentType?: string;
    reason?: string;
    confidence?: number;
  }>;
  getLastPlan(): PlanResult | null;
  getLastRoute(): SystemRouteDecision | null;
}

// 脑干外观接口（subcortical:自主节律调度——心跳扫描/趋势消费/合成信号回流）
interface BrainStemLike {
  start?(): Promise<void>;
  stop?(): Promise<void>;
  sweepOnce?(): Promise<void>;
  snapshot?(): {
    lastSweepAt: string | null;
    syntheticSignalsEmitted: number;
    activeActors: number;
  };
}

// 小脑外观接口（subcortical:时序协调——defer/复查/打断抑制）
interface CerebellumLike {
  start?(): Promise<void>;
  stop?(): Promise<void>;
  schedule(
    decision: BrainDecision,
    signal: BrainSignalInput,
    fire: () => Promise<void>,
  ): Promise<void>;
  interrupt(actorId: string): void;
  clearPending(actorId: string): void;
  snapshot?(): {
    pendingCount: number;
    interruptedCount: number;
    lastInterruptAt: string | null;
  };
}

// 多模态融合皮层外观接口（Phase 4）
interface MultimodalFusionCortexLike {
  fuse(inputs: {
    actorId: string;
    audioText?: string;
    visualDescription?: string;
    emotion?: EmotionVector;
    activity?: UserActivityState;
  }): SensoryFrame;
}

/**
 * Brain Center —— 大脑中心外观类。
 *
 * 持有十一个脑区分区的可选引用（4 个核心皮层 + 5 个神经解剖皮层 + 2 个 subcortical 分区），
 * 对外提供统一的能力自省、用户觉察、主动决策、自我进化、
 * 感官感知、记忆、突触通信、边缘安全/情绪与规划路由入口。
 * subcortical 分区：BrainStem（脑干/自主节律）+ Cerebellum（小脑/时序协调）。
 * 任一分区缺失时方法优雅降级。
 */
export class BrainCenter {
  private cap: CapabilityCortexLike | null = null;
  private awareness: AwarenessCortexLike | null = null;
  private proaction: ProactionCortexLike | null = null;
  private evolution: EvolutionCortexLike | null = null;
  /** 自我修复皮层（CodeRepairCortex）：可选注入，env BRAIN_CODE_REPAIR_ENABLED=1 时启用 */
  private codeRepair: CodeRepairCortexLike | null = null;
  private sensory: SensoryCortexLike | null = null;
  private memory: MemoryCortexLike | null = null;
  private synapse: SynapseBusLike | null = null;
  private limbic: LimbicCortexLike | null = null;
  private planner: PlannerCortexLike | null = null;
  /** 多模态融合皮层（Phase 4）：可选注入，env BRAIN_MULTIMODAL_FUSION_ENABLED=0 时禁用 */
  private multimodalFusion: MultimodalFusionCortexLike | null = null;
  /** 脑干（subcortical:自主节律调度） */
  private brainStem: BrainStemLike | null = null;
  /** 小脑（subcortical:时序协调） */
  private cerebellum: CerebellumLike | null = null;
  /** 端到端认知引擎：一次 LLM 完成理解+决策+响应（整体端到端调度的核心） */
  private cognitiveEngine: CognitiveEngine | null = null;
  /** Step 6 扩展：DecisionHub 协调层（规则驱动端到端认知，优先于 cognitiveEngine） */
  private decisionHub: import("./decision-hub.js").DecisionHub | null = null;
  /** Runtime Kernel: prompt-free stable state and deterministic turn hooks. */
  private runtimeKernel: RuntimeKernel | null = null;
  /**
   * BodyGateway 引用（大脑→身体下行网关，可选）。
   *
   * 注入后：
   *  - ActionExecutor.execute 优先委托 bodyGateway.execute（在 action-executor.ts 中实现）
   *  - cognize 阶段 1 并行调 bodyGateway.sense({ kind: "where_am_i" }) 补全身体状态
   *  - snapshot() 聚合 bodyGateway.snapshot().state 到 BrainSnapshot.bodyState
   *
   * env BODY_CENTER_ENABLED=0/false/off 时 registerBodyGateway 忽略注入（纯脑模式）。
   */
  private bodyGateway: BodyGatewayLike | null = null;

  // ---- Step 7 扩展：7 个新皮层模块 + AnticipationEngine ----
  /** 前额叶工作记忆 */
  private workingMemoryCortex: import("./working-memory-cortex.js").WorkingMemoryCortex | null = null;
  /** 任务切换皮层 */
  private taskSwitchingCortex: import("./task-switching-cortex.js").TaskSwitchingCortex | null = null;
  /** 情境皮层（多源融合） */
  private contextCortex: import("./context-cortex.js").ContextCortex | null = null;
  /** 工具规划皮层 */
  private toolPlanningCortex: import("./tool-planning-cortex.js").ToolPlanningCortex | null = null;
  /** 在线学习皮层 */
  private onlineLearningCortex: import("./online-learning-cortex.js").OnlineLearningCortex | null = null;
  /**
   * 召回查询扩展器（P1-1 单窗口优化）：recall 前做指代消解 + 话题扩展 +
   * 多意图拆分，解决长会话里"那个/它/继续"类 query 的召回失焦。
   */
  private recallQueryExpander: import("./memory-query-expander.js").RecallQueryExpander | null = null;
  /**
   * 用户画像聚合器（P0-1）：以 USER_PROFILE.md 为事实源，
   * 强信号快速路径 + 每 N 轮 LLM 深度合成，让画像"越来越了解用户"。
   */
  private userProfileAggregator: import("./user-profile-aggregator.js").UserProfileAggregator | null = null;
  /**
   * 隐式反馈检测器（P1-3）：从对话形态（纠正/认同/重复提问/换话题）中
   * 检测记忆相关性信号，回灌 MemoryFeedbackStore 参与召回排序。
   */
  private implicitFeedbackDetector: import("./memory-implicit-feedback.js").MemoryImplicitFeedbackDetector | null = null;
  /** 意图预判引擎（外部已有服务，可选注入） */
  private anticipationEngine: import("./decision-hub.js").AnticipationEngineLike | null = null;
  /** 情绪调节器（深度优化：情绪影响路由） */
  private emotionModulator: import("./emotion-modulator.js").EmotionModulator | null = null;
  /**
   * 主题词提取器（深度优化：让工作记忆真正"记住在聊什么"）。
   *
   * 由 create-app-services.ts 注入：内部走一次轻量 LLM 调用，从用户文本中
   * 提取 1-3 个业务领域关键词。替代了 working-memory-cortex.ts 原硬编码主题词列表。
   * 未注入时降级为不提取（保持纯规则驱动）。
   */
  private topicExtractor: ((text: string) => Promise<string[]>) | null = null;

  /**
   * 跨会话开放环路提取轮次门控（记忆链路 LLM 调用收敛 / 降频改造）：
   * 每 N 轮（SESSION_EPITOME_EVERY_N_TURNS，默认 5）批量提取一次，
   * 新会话开场轮检测到上一会话残留时兜底提取（保证跨会话待办不丢）。
   */
  private readonly epitomeTurnGate = new SessionEpitomeTurnGate();

  private started = false;

  // ---- 皮层注册 ----------------------------------------------------------

  registerCapability(c: CapabilityCortexLike): void {
    this.cap = c;
    console.log("[BrainCenter] 已注册 CapabilityCortex");
  }

  registerAwareness(c: AwarenessCortexLike): void {
    this.awareness = c;
    console.log("[BrainCenter] 已注册 AwarenessCortex");
  }

  registerProaction(c: ProactionCortexLike): void {
    this.proaction = c;
    console.log("[BrainCenter] 已注册 ProactionCortex");
  }

  registerEvolution(c: EvolutionCortexLike): void {
    this.evolution = c;
    console.log("[BrainCenter] 已注册 EvolutionCortex");
  }

  /** 注册自我修复皮层（可选；env BRAIN_CODE_REPAIR_ENABLED=1 时由装配阶段注入） */
  registerCodeRepair(c: CodeRepairCortexLike): void {
    this.codeRepair = c;
    console.log("[BrainCenter] 已注册 CodeRepairCortex（自我修复）");
  }

  /** 转发 bug 信号给 CodeRepairCortex。未注册时静默返回 null。 */
  async reportBug(signal: import("./types.js").BugSignal): Promise<import("./types.js").RepairProposal | null> {
    if (!this.codeRepair?.reportBug) return null;
    return await this.codeRepair.reportBug(signal);
  }

  /** 转发修复查询。未注册时返回空数组。 */
  listRepairs(status?: import("./types.js").RepairStatus): import("./types.js").RepairProposal[] {
    if (!this.codeRepair?.listRepairs) return [];
    return this.codeRepair.listRepairs(status);
  }

  /** 转发修复详情查询。 */
  getRepair(id: string): import("./types.js").RepairProposal | null {
    if (!this.codeRepair?.getRepair) return null;
    return this.codeRepair.getRepair(id);
  }

  /** 转发强制重试。 */
  async retryRepair(id: string): Promise<import("./types.js").RepairProposal | null> {
    if (!this.codeRepair?.retry) return null;
    return await this.codeRepair.retry(id);
  }

  /**
   * 注入主题词提取器（LLM 驱动）。
   *
   * 替代 working-memory-cortex.ts 中原硬编码主题词列表。提取器由调用方实现，
   * 通常是一次轻量 LLM 调用。BrainCenter.cognize 在 extractAndSetSlots 之后异步触发，
   * 不阻塞主流程。
   */
  setTopicExtractor(extractor: ((text: string) => Promise<string[]>) | null): void {
    this.topicExtractor = extractor;
    console.log("[BrainCenter] 已注入 TopicExtractor（LLM 驱动）");
  }

  private moodTopicProvider: ((sessionId: string, text: string) => string[]) | null = null;

  /**
   * 注入 mood 话题提供器（每轮 LLM 调用削减）：读取 MoodInferenceService 缓存中
   * 与情绪推断同一次调用产出的 topics。返回空数组表示未命中（回退独立 TopicExtractor）。
   */
  setMoodTopicProvider(provider: ((sessionId: string, text: string) => string[]) | null): void {
    this.moodTopicProvider = provider;
  }

  registerSensory(c: SensoryCortexLike): void {
    this.sensory = c;
    console.log("[BrainCenter] 已注册 SensoryCortex");
  }

  registerMemory(c: MemoryCortexLike): void {
    this.memory = c;
    console.log("[BrainCenter] 已注册 MemoryCortex");
  }

  /**
   * 批量注册记忆认知架构升级的 7 个子组件到 MemoryCortex（Phase 4）。
   *
   * 装配阶段调用：在 registerMemory 后，把 7 个子模块统一注入。
   * 任意子模块为 null/undefined 时跳过对应注册（独立降级）。
   * memory 未注册时整体空操作。
   *
   * 注意：MemoryCortexLike 外观接口不暴露 register* 方法，
   * 此处通过结构化断言调用具体 MemoryCortex 的注册方法。
   */
  registerMemoryCognitiveSubmodules(submodules: {
    associativeGraph?: unknown;
    metacognitionBridge?: unknown;
    forgettingController?: unknown;
    salienceFilter?: unknown;
    experienceLearningLoop?: unknown;
    inferenceEngine?: unknown;
  }): void {
    if (!this.memory) {
      console.log("[BrainCenter] registerMemoryCognitiveSubmodules: MemoryCortex 未注册，跳过");
      return;
    }
    const mc = this.memory as unknown as Record<string, ((svc: unknown) => void) | undefined>;
    const reg = (methodName: string, svc: unknown): void => {
      if (!svc) return;
      const fn = mc[methodName];
      if (typeof fn === "function") {
        try {
          fn.call(this.memory, svc);
        } catch (err) {
          console.log(`[BrainCenter] ${methodName} 注册失败: ${err}`);
        }
      }
    };
    reg("registerAssociativeGraph", submodules.associativeGraph);
    reg("registerMetacognitionBridge", submodules.metacognitionBridge);
    reg("registerForgettingController", submodules.forgettingController);
    reg("registerSalienceFilter", submodules.salienceFilter);
    reg("registerExperienceLearningLoop", submodules.experienceLearningLoop);
    reg("registerInferenceEngine", submodules.inferenceEngine);
    console.log("[BrainCenter] 已注册记忆认知子组件（Phase 4 + 推理引擎）");
  }

  /**
   * 拉取结构化人格内核（personality 域）。
   * 委托 MemoryCortex.getPersonalityCore；未注册或缺失时返回 null。
   * 供 PromptContextBuilder 组装 system prompt 稳定前缀使用。
   */
  getPersonalityCore(actorId: string): PersonalityCore | null {
    return this.memory?.getPersonalityCore?.(actorId) ?? null;
  }

  /**
   * recall-gate 向量预筛（P0-4）：白名单未命中时对用户原文做一次廉价向量检索，
   * top1 分数 ≥ 阈值即放行长期记忆注入。委托 MemoryCortex.semanticRecallPreScreen；
   * 未注册或检索失败时返回 false（fail-closed，保持白名单行为）。
   */
  async semanticRecallPreScreen(actorId: string, query: string): Promise<boolean> {
    try {
      return (await this.memory?.semanticRecallPreScreen?.(actorId, query)) ?? false;
    } catch {
      return false;
    }
  }

  registerSynapse(c: SynapseBusLike): void {
    this.synapse = c;
    console.log("[BrainCenter] 已注册 SynapseBus");
  }

  registerLimbic(c: LimbicCortexLike): void {
    this.limbic = c;
    console.log("[BrainCenter] 已注册 LimbicCortex");
  }

  registerPlanner(c: PlannerCortexLike): void {
    this.planner = c;
    console.log("[BrainCenter] 已注册 PlannerCortex");
  }

  /** 注册脑干（subcortical:自主节律调度） */
  registerBrainStem(s: BrainStemLike): void {
    this.brainStem = s;
    console.log("[BrainCenter] 已注册 BrainStem（脑干/自主节律）");
  }

  /**
   * 获取脑干引用（供装配阶段补充注册子系统，如 WorkingMemoryCortex）。
   * 注意：返回 BrainStemLike（最小化外观接口），仅能调用 sweepOnce/snapshot 等基础方法。
   * 装配阶段需要扩展接口时，应直接在 BrainStem 类中扩展并暴露 register 方法。
   */
  getBrainStem(): BrainStemLike | null {
    return this.brainStem;
  }

  /** 注册小脑（subcortical:时序协调） */
  registerCerebellum(c: CerebellumLike): void {
    this.cerebellum = c;
    console.log("[BrainCenter] 已注册 Cerebellum（小脑/时序协调）");
  }

  /**
   * 注册多模态融合皮层（Phase 4）。
   *
   * 注册后 cognize 阶段 1.5 改用 fusionCortex.fuse() 组装感知帧，
   * 在 SensoryFrame 基础上增加结构化冲突检测与优先级仲裁。
   * 纯规则无 LLM 调用；env BRAIN_MULTIMODAL_FUSION_ENABLED=0 时 cognize 自动降级回 buildSensoryFrame。
   */
  registerMultimodalFusion(c: MultimodalFusionCortexLike): void {
    this.multimodalFusion = c;
    console.log("[BrainCenter] 已注册 MultimodalFusionCortex（多模态融合）");
  }

  /**
   * 小脑调度入口：皮层 ProactionCortex 决策 speak 后,交小脑决定何时执行。
   * - 用户 busy/sleeping → defer,等 reaper 复查
   * - 抑制窗口内 → defer
   * - 否则 → 犹豫后立即执行
   * 小脑未注册时直接执行（降级,不 defer）。
   */
  async scheduleProactive(
    decision: BrainDecision,
    signal: BrainSignalInput,
    fire: () => Promise<void>,
  ): Promise<void> {
    if (!this.cerebellum) {
      await fire();
      return;
    }
    await this.cerebellum.schedule(decision, signal, fire);
  }

  /** 小脑打断：用户开口时清空 defer 队列 + 设抑制窗口,避免 Agent 抢话 */
  interruptProactive(actorId: string): void {
    this.cerebellum?.interrupt(actorId);
  }

  /** 脑干立即扫描（测试/外部触发用） */
  async sweepBrainStem(): Promise<void> {
    await this.brainStem?.sweepOnce?.();
  }

  /** 注册端到端认知引擎：让 BrainCenter 成为认知中枢而非被动外观 */
  registerCognitiveEngine(engine: CognitiveEngine): void {
    this.cognitiveEngine = engine;
    console.log("[BrainCenter] 已注册 CognitiveEngine（端到端认知）");
  }

  registerRuntimeKernel(kernel: RuntimeKernel): void {
    this.runtimeKernel = kernel;
    console.log("[BrainCenter] 已注册 RuntimeKernel（常驻内核态，默认共享实例）");
  }

  /**
   * 取当前 actor 的 RuntimeKernel。
   * - 传 actorId：返回 per-actor 实例（无则 lazy-clone 默认 kernel）
   * - 不传 actorId：返回默认共享实例（兼容旧调用）
   */
  getRuntimeKernel(actorId?: string): RuntimeKernel | null {
    if (!this.runtimeKernel) return null;
    if (!actorId) return this.runtimeKernel;
    return getRuntimeKernel(actorId);
  }

  getRuntimeKernelSnapshot(actorId?: string): RuntimeKernelState | null {
    return this.getRuntimeKernel(actorId)?.snapshot() ?? null;
  }

  updateRuntimeKernel(
    patch: Partial<RuntimeKernelState>,
    actorId?: string,
  ): RuntimeKernelState | null {
    return this.getRuntimeKernel(actorId)?.update(patch) ?? null;
  }

  // ---- BodyGateway 注入（大脑→身体下行网关）----------------------------

  /**
   * 注入 BodyGateway（大脑→身体下行网关）。
   *
   * 注入后：
   *  - cognize 阶段 1 并行调 bodyGateway.sense({ kind: "where_am_i" }) 补全身体状态
   *  - snapshot() 聚合 bodyGateway.snapshot().state
   *  - 装配阶段应额外调 actionExecutor.registerBodyGateway(gw) 让 ActionExecutor.execute 优先委托
   *
   * env BODY_CENTER_ENABLED=0/false/off 时忽略注入（降级为纯脑模式，向后兼容）。
   */
  registerBodyGateway(gw: BodyGatewayLike): void {
    if (!this.isBodyCenterEnabled()) {
      console.log("[BrainCenter] BODY_CENTER_ENABLED=0, bodyGateway ignored");
      return;
    }
    this.bodyGateway = gw;
    console.log("[BrainCenter] 已注册 BodyGateway（大脑→身体下行网关）");
  }

  /** 获取 BodyGateway 引用（供装配阶段注入 ActionExecutor 等） */
  getBodyGateway(): BodyGatewayLike | null {
    return this.bodyGateway;
  }

  /**
   * 检查 BODY_CENTER_ENABLED 环境变量是否启用身体中心。
   * - "0" / "false" / "off"（不区分大小写）→ 返回 false（禁用身体中心，纯脑模式）
   * - 其他（含未设置）→ 返回 true（启用身体中心）
   */
  private isBodyCenterEnabled(): boolean {
    const raw = process.env.BODY_CENTER_ENABLED?.trim().toLowerCase();
    if (raw === "0" || raw === "false" || raw === "off") return false;
    return true;
  }

  /**
   * Step 6 扩展：注册 DecisionHub 协调层。
   *
   * 注册后 cognize 阶段 2 优先使用 DecisionHub.decidePassive（规则驱动），
   * 替代原 CognitiveEngine 的 LLM 路由判断，避免幻觉。
   * 未注册时回退到 cognitiveEngine（向后兼容）。
   */
  setDecisionHub(hub: import("./decision-hub.js").DecisionHub): void {
    this.decisionHub = hub;
    console.log("[BrainCenter] 已注册 DecisionHub（规则驱动端到端认知）");
  }

  /** Step 6 扩展：获取 DecisionHub 引用（供外部装配层调用） */
  getDecisionHub(): import("./decision-hub.js").DecisionHub | null {
    return this.decisionHub;
  }

  /**
   * 轻量规则路由（单一权威路由源的前置）：纯规则、不调 LLM、不收集感知。
   *
   * 供 fast 路径注入「规则置信度」，把低置信度升级从「hedging 事后检测」前移，
   * 避免 fast 先凭印象答、再二次升级 complex 的重复 LLM 消耗。
   * 未注册 DecisionHub 时返回默认 fast 低置信度（保守，不强制升级）。
   */
  routeLight(userMessage: string): {
    mode: "direct" | "tool_loop";
    confidence: number;
    reason: string;
    agentType?: "tech" | "info" | "life";
  } {
    const hub = this.decisionHub;
    if (hub) {
      const d = hub.getRuleRouter().route(userMessage);
      return {
        mode: d.mode,
        confidence: d.confidence,
        reason: d.reason,
        agentType: d.agentType,
      };
    }
    return { mode: "direct", confidence: 0.5, reason: "no_decision_hub" };
  }

  // ---- Step 7 扩展：新模块注册 + getter --------------------------------

  registerWorkingMemoryCortex(wm: import("./working-memory-cortex.js").WorkingMemoryCortex): void {
    this.workingMemoryCortex = wm;
    console.log("[BrainCenter] 已注册 WorkingMemoryCortex（前额叶工作记忆）");
  }
  getWorkingMemoryCortex(): import("./working-memory-cortex.js").WorkingMemoryCortex | null {
    return this.workingMemoryCortex;
  }

  registerTaskSwitchingCortex(ts: import("./task-switching-cortex.js").TaskSwitchingCortex): void {
    this.taskSwitchingCortex = ts;
    console.log("[BrainCenter] 已注册 TaskSwitchingCortex（任务切换皮层）");
  }
  getTaskSwitchingCortex(): import("./task-switching-cortex.js").TaskSwitchingCortex | null {
    return this.taskSwitchingCortex;
  }

  registerContextCortex(cc: import("./context-cortex.js").ContextCortex): void {
    this.contextCortex = cc;
    console.log("[BrainCenter] 已注册 ContextCortex（情境皮层）");
  }
  getContextCortex(): import("./context-cortex.js").ContextCortex | null {
    return this.contextCortex;
  }

  registerToolPlanningCortex(tp: import("./tool-planning-cortex.js").ToolPlanningCortex): void {
    this.toolPlanningCortex = tp;
    console.log("[BrainCenter] 已注册 ToolPlanningCortex（工具规划皮层）");
  }
  getToolPlanningCortex(): import("./tool-planning-cortex.js").ToolPlanningCortex | null {
    return this.toolPlanningCortex;
  }

  registerOnlineLearningCortex(ol: import("./online-learning-cortex.js").OnlineLearningCortex): void {
    this.onlineLearningCortex = ol;
    console.log("[BrainCenter] 已注册 OnlineLearningCortex（在线学习皮层）");
  }
  getOnlineLearningCortex(): import("./online-learning-cortex.js").OnlineLearningCortex | null {
    return this.onlineLearningCortex;
  }

  registerAnticipationEngine(engine: import("./decision-hub.js").AnticipationEngineLike): void {
    this.anticipationEngine = engine;
    console.log("[BrainCenter] 已注册 AnticipationEngine（意图预判引擎）");
  }

  /** 注册召回查询扩展器（P1-1：recall 前指代消解 + 话题扩展 + 多意图拆分） */
  registerRecallQueryExpander(expander: import("./memory-query-expander.js").RecallQueryExpander): void {
    this.recallQueryExpander = expander;
    console.log("[BrainCenter] 已注册 RecallQueryExpander（召回查询扩展器）");
  }

  /** 注册用户画像聚合器（P0-1：USER_PROFILE.md 动态更新 + LLM 深度合成） */
  registerUserProfileAggregator(aggregator: import("./user-profile-aggregator.js").UserProfileAggregator): void {
    this.userProfileAggregator = aggregator;
    console.log("[BrainCenter] 已注册 UserProfileAggregator（用户画像聚合器）");
  }
  getUserProfileAggregator(): import("./user-profile-aggregator.js").UserProfileAggregator | null {
    return this.userProfileAggregator;
  }

  /** 注册隐式反馈检测器（P1-3：对话形态 → 记忆相关性反馈回灌） */
  registerImplicitFeedbackDetector(detector: import("./memory-implicit-feedback.js").MemoryImplicitFeedbackDetector): void {
    this.implicitFeedbackDetector = detector;
    console.log("[BrainCenter] 已注册 MemoryImplicitFeedbackDetector（隐式反馈检测器）");
  }

  registerEmotionModulator(em: import("./emotion-modulator.js").EmotionModulator): void {
    this.emotionModulator = em;
    console.log("[BrainCenter] 已注册 EmotionModulator（情绪调节器）");
  }
  getEmotionModulator(): import("./emotion-modulator.js").EmotionModulator | null {
    return this.emotionModulator;
  }

  getAnticipationEngine(): import("./decision-hub.js").AnticipationEngineLike | null {
    return this.anticipationEngine;
  }

  // ---- 核心方法 ----------------------------------------------------------

  /** 能力自省：返回当前 actor 已注册的能力描述符列表 */
  introspect(actorId: string): CapabilityDescriptor[] {
    if (!this.cap) {
      console.log("[BrainCenter] introspect: CapabilityCortex 缺失，返回空列表");
      return [];
    }
    return this.cap.introspect(actorId);
  }

  /**
   * 用 ToolRegistry 当前全量工具名刷新各 domain 的 descriptor.tools。
   *
   * 场景：MCP 动态注册、self-programming 生成新 skill、社区 skill 启用后，
   * capabilityCortex 的 loadSeed 快照已过期，需要重新填充才能让
   * brain.list_capabilities 返回真实工具名。
   *
   * 内部有 60s 节流，避免每次调用都全量重算。
   */
  refreshCapabilityTools(toolNames: string[]): void {
    if (!this.cap || typeof this.cap.attachToolNames !== "function") return;
    const now = Date.now();
    if (now - this._lastCapabilityRefreshTs < 60_000) return;
    this._lastCapabilityRefreshTs = now;
    try {
      this.cap.attachToolNames(toolNames);
    } catch (err) {
      console.log(`[BrainCenter] refreshCapabilityTools 失败: ${err}`);
    }
  }
  private _lastCapabilityRefreshTs = 0;

  /** 能力缺口识别：委托给 CapabilityCortex（async，支持 LLM 语义分析）；未注册或方法缺失时返回 null */
  async identifyGap(scenario: string): Promise<CapabilityGapReport | null> {
    if (!this.cap || typeof this.cap.identifyGap !== "function") {
      return null;
    }
    try {
      return await this.cap.identifyGap(scenario);
    } catch (err) {
      console.log(`[BrainCenter] identifyGap 调用失败: ${err}`);
      return null;
    }
  }

  /** 用户觉察：返回当前 actor 的活动状态 */
  observe(actorId: string): UserActivityState | null {
    if (!this.awareness) {
      console.log("[BrainCenter] observe: AwarenessCortex 缺失，返回 null");
      return null;
    }
    return this.awareness.observe(actorId);
  }

  /**
   * 语义觉察：返回用户活动状态 + 心智状态复合对象。
   *
   * fire-on-demand 入口：只在对话内主动钩子命中等真正需要感知用户当下状态时调用，
   * 避免每轮对话都跑语义推断浪费 token。AwarenessCortex 未注册 / 未注入
   * semanticInferrer / 调用失败时，mental 降级为 null（activity 仍尽力返回）。
   */
  async observeWithMental(
    actorId: string,
    opts?: { recentConversationHistory?: string },
  ): Promise<{ activity: UserActivityState | null; mental: UserMentalState | null }> {
    if (!this.awareness || typeof this.awareness.observeWithMental !== "function") {
      // 未暴露 observeWithMental 时，回退到基础 observe（仅 activity）。
      return { activity: this.observe(actorId), mental: null };
    }
    try {
      return await this.awareness.observeWithMental(actorId, opts);
    } catch (err) {
      console.log(`[BrainCenter] observeWithMental 失败（降级 activity）: ${err}`);
      return { activity: this.observe(actorId), mental: null };
    }
  }

  /**
   * 记录一次工具交互到自我学习闭环。
   *
   * AgentCore 在工具调用结束（无论成功失败）时调用此方法。BrainCenter 转发到
   * EvolutionCortex.recordToolInteraction → selfLearning.recordInteraction 持久化。
   *
   * 后续显式 proposeEvolution 查询时从 selfLearning.getRecentRecords() 即可读到失败轨迹，
   * 生成进化提案。这是"失败时自我学习"的真正入口。
   *
   * 设计要点：
   *  - fire-and-forget，错误不抛回调用方
   *  - 不阻塞 cognize 主流程
   *  - 仅在 BRAIN_CENTER_ENABLED=1 时生效
   */
  recordToolInteraction(params: {
    actorId: string;
    sessionId: string;
    userRequest: string;
    attemptedTools: string[];
    success: boolean;
    errorMessage?: string;
    responseTime?: number;
  }): void {
    const tools = params.attemptedTools.length > 0 ? params.attemptedTools : ["unknown"];
    const toolList = tools.join(", ");
    const beliefKey = stableLearningKey(
      `tool:${toolList}:request:${summarizeLearningText(params.userRequest, 80)}`,
    );
    const beliefId = `belief-${beliefKey}`;
    const outcome = params.success ? "success" : "failure";
    const experienceText = params.success
      ? `Tool interaction succeeded. userRequest="${summarizeLearningText(params.userRequest)}" tools="${toolList}"`
      : `Tool interaction failed. userRequest="${summarizeLearningText(params.userRequest)}" tools="${toolList}" error="${summarizeLearningText(params.errorMessage ?? "unknown error")}"`;

    void this.memory
      ?.remember(params.actorId, {
        actorId: params.actorId,
        kind: "experience",
        domain: "episodic",
        content: experienceText,
        importance: params.success ? "medium" : "high",
        source: "tool",
        sessionId: params.sessionId,
        timestamp: new Date().toISOString(),
        metadata: {
          outcome,
          learningBeliefKey: beliefKey,
          lesson: `For similar requests, using ${toolList} is ${params.success ? "supported by a recent success" : "risky until the failure pattern is understood"}.`,
          interpretation: params.success
            ? "A concrete tool execution succeeded and should modestly reinforce the related strategy."
            : "A concrete tool execution failed and should make the related strategy more cautious.",
          attemptedTools: tools,
          userRequest: params.userRequest,
          errorMessage: params.errorMessage,
          responseTime: params.responseTime,
        },
      })
      .catch((e) => {
        console.warn("[BrainCenter] recordToolInteraction memory write failed:", e);
      });

    void this.memory
      ?.recordLearningFeedback?.({
        actorId: params.actorId,
        beliefId,
        outcome,
        note: params.success
          ? `Tool execution succeeded: ${toolList}`
          : `Tool execution failed: ${toolList}; ${params.errorMessage ?? "unknown error"}`,
        evidence: [experienceText],
      })
      .catch((e) => {
        console.warn("[BrainCenter] recordToolInteraction learning feedback failed:", e);
      });

    if (!this.evolution?.recordToolInteraction) {
      // EvolutionCortex 未注册或未实现 recordToolInteraction，静默降级
      return;
    }
    void this.evolution.recordToolInteraction({
      sessionId: params.sessionId,
      userRequest: params.userRequest,
      attemptedTools: params.attemptedTools,
      success: params.success,
      errorMessage: params.errorMessage,
      responseTime: params.responseTime,
    }).catch((e) => {
      console.warn("[BrainCenter] recordToolInteraction 转发失败:", e);
    });
  }

  /** 记录用户纠正信号：例如“不是这样/应该是X/你前面错了”。 */
  recordUserCorrection(actorId: string, userText: string, assistantText?: string): void {
    if (!this.memory) return;
    const correctedText = summarizeLearningText(userText);
    const assistantSummary = assistantText ? summarizeLearningText(assistantText) : "";
    // 记忆相关性在线反馈：用户纠正 → 对助手回复中涉及的旧记忆内容做负反馈。
    // 助手回复通常复述了被召回的旧记忆，后续再次召回同指纹记忆时会被惩罚降权。
    if (assistantSummary) {
      const lines = assistantSummary
        .split(/\n+/)
        .map((l) => l.trim())
        .filter((l) => l.length >= 6);
      for (const line of lines.length > 0 ? lines : [assistantSummary]) {
        try {
          this.memory.recordMemoryFeedback?.({
            actorId,
            content: line,
            outcome: "correction",
          });
        } catch {
          /* 反馈记录非阻塞 */
        }
      }
    }
    const beliefKey = stableLearningKey(`correction:${correctedText}`);
    const content = assistantSummary
      ? `User correction received. user="${correctedText}" assistant="${assistantSummary}"`
      : `User correction received. user="${correctedText}"`;
    void this.memory
      .remember(actorId, {
        actorId,
        kind: "experience",
        domain: "episodic",
        content,
        importance: "high",
        source: "chat",
        timestamp: new Date().toISOString(),
        metadata: {
          outcome: "correction",
          learningBeliefKey: beliefKey,
          lesson: `Treat the corrected user statement as the newer belief for this topic.`,
          interpretation: "The user explicitly corrected the assistant and the prior assumption should be downgraded.",
          userText,
          assistantText,
        },
      })
      .catch((e) => {
        console.warn("[BrainCenter] recordUserCorrection memory write failed:", e);
      });
    void this.memory
      .recordLearningFeedback?.({
        actorId,
        beliefId: `belief-${beliefKey}`,
        outcome: "correction",
        note: content,
        evidence: [userText, assistantSummary].filter(Boolean),
      })
      .catch((e) => {
        console.warn("[BrainCenter] recordUserCorrection learning feedback failed:", e);
      });
  }

  getLearningSnapshot(actorId: string): LearningSnapshot | null {
    return this.memory?.getLearningSnapshot?.(actorId) ?? null;
  }

  /**
   * 记忆相关性在线反馈回灌：转发到 MemoryCortex.recordMemoryFeedback。
   * 未注册时静默降级（不阻塞调用方）。
   */
  recordMemoryFeedback(input: MemoryFeedbackInput): void {
    if (!this.memory?.recordMemoryFeedback) return;
    try {
      this.memory.recordMemoryFeedback(input);
    } catch (err) {
      console.warn("[BrainCenter] recordMemoryFeedback failed:", err);
    }
  }

  /** 读取某 actor 的记忆反馈快照（调试/统计用）。 */
  getMemoryFeedbackSnapshot(actorId: string): unknown {
    return this.memory?.getMemoryFeedbackSnapshot?.(actorId) ?? null;
  }

  /** 跨会话开放环路：转发到 MemoryCortex（KV 持久化）。未注册时静默降级。 */
  updateSessionEpitome(actorId: string, entries: SessionEpitomeEntries, turnText?: string): void {
    if (!this.memory?.updateSessionEpitome) return;
    try {
      this.memory.updateSessionEpitome(actorId, entries, turnText);
    } catch (err) {
      console.warn("[BrainCenter] updateSessionEpitome failed:", err);
    }
  }

  /** 读取某 actor 的跨会话开放环路快照（新会话开场注入用）。 */
  getSessionEpitome(actorId: string): SessionEpitomeSnapshot | null {
    return this.memory?.getSessionEpitome?.(actorId) ?? null;
  }

  /** 读取某 actor 的最近召回锚点（连续性诊断用）。 */
  getRecallAnchors(actorId: string): unknown[] {
    return this.memory?.getRecallAnchors?.(actorId) ?? [];
  }

  /**
   * 连续性诊断：聚合最近召回锚点 + 反馈惩罚 + 跨会话开放环路。
   * 用于定位"上下文跳转"根因（最近注入了什么、哪些被反馈降权、上一会话遗留了什么）。
   */
  diagnoseContinuity(actorId: string): Record<string, unknown> {
    return {
      actorId,
      recalledAt: new Date().toISOString(),
      recentRecalls: this.getRecallAnchors(actorId),
      feedback: this.getMemoryFeedbackSnapshot(actorId),
      epitome: this.getSessionEpitome(actorId),
    };
  }

  /**
   * 端到端认知入口（整体端到端调度的核心）。
   *
   * 像真人一样一气呵成完成"感知 → 理解 → 决策 → 响应"：
   *  阶段 1 — 感知收集（并行，各脑区同时工作，不串行切片）：
   *    listen(audio) / look(visual) / recall(query) / inferEmotion(text)
   *    / observe(actorId) / introspect(actorId) / recentDecisions(actorId)
   *  阶段 2 — 端到端认知 LLM（一次调用）：
   *    把所有脑区上下文一次性交给 CognitiveEngine，
   *    产出 {路由, 响应, 记忆写入, 动作, 是否需要工具循环}
   *  阶段 3 — 后置执行：
   *    checkSafety(action) + remember(memoryWrites)
   *
   * 工具循环（openai-compatible-tool-loop）是执行层迭代，保留——人用工具也是迭代的。
   * 真正端到端的是"认知决策"：路由+召回+情绪+响应策略合并为一次认知。
   */
  async cognize(input: CognitiveInput): Promise<CognitiveResult> {
    const now = new Date().toISOString();
    const actorId = input.actorId;
    const query = input.text ?? input.signal?.title ?? "";

    if (query && looksLikeUserCorrection(query)) {
      try {
        this.recordUserCorrection(actorId, query);
      } catch {
        /* correction learning is non-blocking */
      }
      // 主动学习循环：纠正时立即更新用户画像（降权错误偏好 + 提取正确信号）
      try {
        this.onlineLearningCortex?.recordCorrection(actorId, query);
      } catch {
        /* onlineLearning correction is non-blocking */
      }
    }

    // === 阶段 1：感知收集（并行，含 Step 7 新模块一次性大并行）===
    // 性能优化（方案 B）：把阶段 1（7 原始模块）与阶段 1.6 中不依赖阶段 1 结果的
    // 4 个新模块（WorkingMemory/CurrentTask/AnticipatedIntent/UserProfile）合并为一次 Promise.all。
    // Situation 依赖 userActivity，单独后置调用。
    // 性能优化(C1)：6 个同步通道直接取值,不包 Promise.resolve,减少微任务开销;
    // 仅 6 个真 async 通道(audio/visual/recall/emotion/anticipatedIntent/bodySense)进 Promise.all。
    const userActivity = this.awareness?.observe(actorId) ?? null;
    const capabilities = this.cap?.introspect(actorId) ?? [];
    const recentDecisions = this.proaction?.recentDecisions?.(actorId) ?? [];
    const workingMemorySnap = this.workingMemoryCortex?.load(actorId) ?? undefined;
    const currentTask = this.taskSwitchingCortex?.getCurrentTask(actorId) ?? null;
    const userPattern = this.onlineLearningCortex?.getProfile(actorId) ?? undefined;

    // === 阶段 0.9：拉取最近对话历史（提前，供 recall query 扩展用）===
    // 原"阶段 1.5.1"在 recall 之后才拉历史，导致 recall 拿不到上下文。
    // 单窗口长会话下用户大量使用指代（"那个/它/继续"），query 扩展必须在
    // recall 之前完成。拉取逻辑与原阶段 1.5.1 完全一致（含 master 会话修复）。
    let recentConversationHistory = "";
    let cognizeThreadMessageCount = -1;
    try {
      const chatSessionId =
        input.sessionId && isNotesChatSessionId(input.sessionId)
          ? input.sessionId
          : resolvePrimaryChatSessionId(
              actorId,
              getAgentRuntimeConfig().masterDelegation.enabled,
            );
      const threadStore = getChatThreadStore();
      const messages = threadStore.thread(chatSessionId, "");
      cognizeThreadMessageCount = messages.length;
      const recentMessages = messages.slice(-12);
      const currentUserMessage =
        input.text?.trim()
          ? ({ role: "user", content: input.text.trim() } satisfies ChatCompletionMessageParam)
          : null;
      const recentWindow = currentUserMessage
        ? [...recentMessages, currentUserMessage].slice(-12)
        : recentMessages;
      if (recentWindow.length > 0) {
        const historyLines = recentWindow
          .map((msg: ChatCompletionMessageParam) => formatRecentConversationLine(msg))
          .filter((line): line is string => Boolean(line));
        recentConversationHistory = historyLines.join("\n");
      }
    } catch (err) {
      console.log(`[BrainCenter] 拉取对话历史失败（忽略）: ${err}`);
    }

    // === 阶段 0.93：长期记忆召回门控（记忆架构重构，单点评估）===
    // 触发条件由 L1 路由 LLM 产出的 understanding 承担（2026-10-10 词表判定退役）；
    // understandingPromise 与路由并行启动，此处消费前才 await，不增加串行延迟。
    // understanding 缺省（路由失败/降级）→ 不触发（最小注入）。
    // 判定结果随 CognitiveResult.recallGate 透出，agent-core / prompt 装配层
    // 直接复用，不再各自重评。
    const turnUnderstanding = await (input.understandingPromise?.catch(() => undefined) ??
      Promise.resolve(undefined));
    const recallGate = shouldRecallLongTerm({
      text: query,
      threadMessageCount: cognizeThreadMessageCount,
      understanding: turnUnderstanding,
    });
    if (recallGate.trigger) {
      console.log(`[BrainCenter] recall gate triggered (${recallGate.reason})`);
    }

    // === 阶段 0.95：召回 query 扩展（P1-1 单窗口优化）===
    // 指代消解 + 话题扩展 + 多意图拆分。纯规则毫秒级。
    // recallQuery 仅用于记忆检索；后续 LLM prompt 仍用用户原始 query。
    let recallQuery = query;
    let recallSubQueries: string[] | undefined;
    if (this.recallQueryExpander && query && recallGate.trigger) {
      try {
        const expansion = this.recallQueryExpander.expand({
          query,
          recentConversationHistory,
        });
        recallQuery = expansion.primaryQuery || query;
        if (expansion.subQueries.length > 1) {
          recallSubQueries = expansion.subQueries;
        }
        if (expansion.expanded) {
          console.log(
            `[BrainCenter] recall query 已扩展: "${query}" → "${recallQuery}"` +
              (recallSubQueries ? ` (+${recallSubQueries.length - 1} 子意图)` : ""),
          );
        }
      } catch {
        /* 扩展失败用原始 query */
      }
    }

    // === 阶段 0.96：元认知目录缓存刷新（P2-1）===
    // fire-and-forget 刷新 MemoryInventory 60s TTL 缓存（不阻塞 cognize），
    // prompt-context-builder assembleMemory 同步读缓存注入【记忆目录】块，
    // 让主 Agent LLM "知道自己记住了什么"（用户问"你知道我什么"时有真实依据）。
    if (this.memory && typeof this.memory.getInventorySummary === "function") {
      void this.memory.getInventorySummary(actorId).catch(() => {
        /* 目录刷新失败静默，prompt 侧读到空串跳过注入 */
      });
    }

    const [
      audioResult,
      visualResult,
      recallResult,
      emotion,
      anticipatedIntent,
      bodySense,
      situation,
    ] = await Promise.all([
      input.audio && this.sensory
        ? this.sensory.listen(input.audio).catch(() => null)
        : Promise.resolve(null),
      input.visual && this.sensory
        ? this.sensory.look(input.visual).catch(() => null)
        : Promise.resolve(null),
      // 记忆架构重构：recall 通道受白名单门控（recall-gate），
      // 未触发时直接返回 null（不检索长期记忆），query 扩展仅在触发时执行。
      this.memory && recallGate.trigger
        ? (typeof this.memory.recallWithProvenance === "function"
            ? this.memory.recallWithProvenance(actorId, recallQuery, {
                limit: 5,
                // P2-2 多意图并行召回：recallWithProvenance 路径同样透传子意图
                ...(recallSubQueries ? { subQueries: recallSubQueries } : {}),
              })
            : this.memory.recall(actorId, recallQuery, {
                limit: 5,
                ...(recallSubQueries ? { subQueries: recallSubQueries } : {}),
              })
          ).catch(() => null)
        : Promise.resolve(null),
      this.limbic?.inferEmotion
        ? this.limbic.inferEmotion(actorId, { text: input.text }).then((ev) => {
            // Limbic 返回中性且 emotionModulator 有文本推理 → 用文本推理补充
            if (ev && Math.abs(ev.valence) < 0.2 && ev.arousal >= 0.25 && ev.arousal <= 0.35 && this.emotionModulator && input.text) {
              const textEmotion = this.emotionModulator.inferFromText(input.text, actorId);
              if (textEmotion) return textEmotion;
            }
            return ev;
          }).catch(() => null)
        : (this.emotionModulator && input.text
            ? Promise.resolve(this.emotionModulator.inferFromText(input.text, actorId))
            : Promise.resolve(null)),
      this.anticipationEngine?.predictNextIntent
        ? this.anticipationEngine.predictNextIntent(actorId, { text: query }).catch(() => null)
        : Promise.resolve(null),
      // BodyGateway 感官查询：where_am_i（含 device/screenX/screenY/mood/rendering）
      this.bodyGateway
        ? this.bodyGateway.sense({ kind: "where_am_i", actorId }).catch(() => null)
        : Promise.resolve(null),
      // Situation 依赖 userActivity（已在 Promise.all 前同步拿到），并入大并行消除阶段 1.6 的串行等待
      this.contextCortex
        ? this.contextCortex
            .gatherContext(actorId, { activity: userActivity ?? null })
            .catch(() => null)
        : Promise.resolve(null),
    ]);

    // === 阶段 1.5：组装多模态融合帧（SensoryFrame）===
    // 将 audioResult/visualResult/emotion/userActivity 融合为统一感知帧，
    // 让认知 LLM 一次拿到完整的多模态上下文。
    // Phase 4：若 MultimodalFusionCortex 已注册且启用，则用 fuse() 做结构化冲突检测；
    // BRAIN_MULTIMODAL_FUSION_ENABLED=0 时降级回 buildSensoryFrame（保持纯规则、无额外 token）。
    const fusionInputs = {
      actorId,
      audioText: audioResult?.text,
      visualDescription: visualResult?.description,
      emotion: emotion ?? undefined,
      activity: userActivity ?? undefined,
    };
    const sensoryFrame = this.sensory
      ? (this.multimodalFusion && isMultimodalFusionEnabled()
          ? this.multimodalFusion.fuse(fusionInputs)
          : this.sensory.buildSensoryFrame(fusionInputs))
      : undefined;

    // === 阶段 1.5.1：（已上移到阶段 0.9）===
    // 最近对话历史拉取已提前到 Promise.all 之前（阶段 0.9），
    // 供 recall query 扩展消费；此处直接复用 recentConversationHistory。

    const context: CognitiveContext = {
      memories: recallResult?.items ?? [],
      emotion: emotion ?? null,
      userActivity: userActivity ?? null,
      capabilities: capabilities ?? [],
      recentDecisions: recentDecisions ?? [],
      audioText: audioResult?.text,
      visualDescription: visualResult?.description,
      sensoryFrame,
      recentConversationHistory: recentConversationHistory || undefined,
      // Step 7 扩展：阶段 1 大并行已收集的字段（方案 B 合并）
      workingMemory: workingMemorySnap,
      currentTask,
      anticipatedIntent,
      userPattern,
      // BodyGateway 感官查询结果（where_am_i）：device/screenX/screenY/mood/rendering 等
      // bodyGateway 未注入时为 undefined（纯脑模式，向后兼容）
      bodyState: bodySense?.ok ? (bodySense.data as unknown as BodyState) : undefined,
      // 情境（阶段 1 大并行已收集，替代原先阶段 1.6 的串行 await）
      situation: situation ?? undefined,
    };

    // === 阶段 1.7：（已废弃正则预评判）===
    // 原先在此用 AwarenessCortex.assessConfidence 正则规则预评分，但正则无法理解
    // 对话语义（如「嗯」是模糊追问还是确认、「那个」指代什么），会误判。
    // 现置信度由 cognize LLM 基于对话内容语义评判（见阶段 2），规则仅作 cognize
    // 失败降级时的兜底（见阶段 2 catch 分支）。

    // === 阶段 2：端到端认知 ===
    // Step 6 扩展：优先使用 DecisionHub.decidePassive（规则驱动，不调 LLM，避免幻觉）。
    // 未注册 DecisionHub 时回退到 cognitiveEngine（保留原 LLM 路由，向后兼容）。
    let cognitive: {
      route: SystemRouteDecision;
      response: string;
      memoryWrites: MemoryItem[];
      action?: { tool: string; args: Record<string, unknown> };
      needsToolLoop: boolean;
      rationale: string;
      confidence?: number;
      confidenceReason?: string;
      toolPlan?: import("./tool-planning-cortex.js").ToolPlan;
    };
    // 兜底置信度：仅当 cognize 失败/未返回 confidence 时用规则评估
    let ruleFallbackConfidence: { score: number; reason: string } | null = null;

    // Step 6：优先使用 DecisionHub（规则驱动端到端认知）
    if (this.decisionHub) {
      try {
        const decision = await this.decisionHub.decidePassive(input, context);
        const route = this.decisionHub.getRuleRouter().toSystemRouteDecision(query, decision.route);
        cognitive = {
          route,
          response: decision.response, // 始终为空字符串（让 streamCompletion 生成）
          memoryWrites: decision.memoryWrites,
          action: decision.action,
          needsToolLoop: decision.needsToolLoop,
          rationale: decision.rationale,
          confidence: decision.confidence,
          confidenceReason: decision.confidenceReason,
          toolPlan: decision.toolPlan ?? undefined,
        };
      } catch (e) {
        // DecisionHub 失败 → 降级到 cognitiveEngine（如有）或 routeSystem
        console.log(`[BrainCenter] DecisionHub.decidePassive 失败，降级: ${e}`);
        const fallbackRoute = this.routeSystem(query, { actorId });
        cognitive = {
          route: fallbackRoute,
          response: "",
          memoryWrites: [],
          needsToolLoop: true,
          rationale: `decision_hub_failed:${String(e).slice(0, 80)}`,
        };
      }
    } else if (this.cognitiveEngine) {
      // 回退路径：原 CognitiveEngine（保留 LLM 路由，向后兼容）
      try {
        cognitive = await this.cognitiveEngine.cognize(input, context);
      } catch (e) {
        // 端到端认知失败 → 降级到 routeSystem 规则路由 + 规则置信度兜底
        // needsToolLoop 由 route.mode 决定：
        //  - fast/fast：不走工具循环，response="" 由外层 streamCompletion
        //    用对应模式调 LLM 流式补全（避免空 response 直返的安全职责在外层）
        //  - fast/complex：需要工具循环（子 Agent 委派）
        const fallbackRoute = this.routeSystem(query, { actorId });
        cognitive = {
          route: fallbackRoute,
          response: "",
          memoryWrites: [],
          needsToolLoop: fallbackRoute.mode !== "direct",
          rationale: `cognize_failed:${String(e).slice(0, 80)}`,
        };
        if (typeof this.awareness?.assessConfidence === "function") {
          try {
            ruleFallbackConfidence = this.awareness.assessConfidence(query, recallResult, capabilities ?? []);
          } catch { /* ignore */ }
        }
      }
    } else {
      // 未注入认知引擎 → 降级到 routeSystem + 规则置信度兜底
      // needsToolLoop 由 route.mode 决定（同 cognize_failed 分支语义）：
      //  - fast/fast：不走工具循环，response="" 由外层 streamCompletion 流式补全
      //  - fast/complex：需要工具循环
      const fallbackRoute = this.routeSystem(query, { actorId });
      cognitive = {
        route: fallbackRoute,
        response: "",
        memoryWrites: [],
        needsToolLoop: fallbackRoute.mode !== "direct",
        rationale: "no_cognitive_engine",
      };
      if (typeof this.awareness?.assessConfidence === "function") {
        try {
          ruleFallbackConfidence = this.awareness.assessConfidence(query, recallResult, capabilities ?? []);
        } catch { /* ignore */ }
      }
    }

    // === 阶段 2.5：低置信度路由升级 ===
    // 置信度来源优先级：cognize LLM 基于对话内容的语义评判 > 规则兜底（仅 cognize 失败时）。
    // score < 0.4 且 route.mode === "direct" 时升级到 complex，让子 Agent 兜底。
    //
    // ⚠️ 仅对 `fast` 路由生效：该路由是「主 Agent 带工具先试」，若 LLM 基于内容
    // 判定置信度低（信息不足/能力缺失），委派给子 Agent 兜底是合理的。
    // 对 `fast` / `fast` 绝不升级——这两类是认知 LLM 明确判定「可直接回答」的路由。
    let finalRoute = cognitive.route;
    let finalRationale = cognitive.rationale;
    let finalNeedsToolLoop = cognitive.needsToolLoop;
    // 选取有效置信度：优先 cognize 的内容评判，缺省时用规则兜底
    const effScore = typeof cognitive.confidence === "number" ? cognitive.confidence : ruleFallbackConfidence?.score;
    const effReason = typeof cognitive.confidence === "number"
      ? (cognitive.confidenceReason ?? `cognize_confidence=${cognitive.confidence.toFixed(2)}`)
      : (ruleFallbackConfidence?.reason ?? "");
    if (typeof effScore === "number" && effScore < 0.4 && finalRoute.mode === "direct") {
      console.log(
        `[BrainCenter] 低置信度路由升级 actorId=${actorId} score=${effScore.toFixed(2)} ` +
          `reason=${effReason}`,
      );
      finalRoute = {
        userMessage: finalRoute.userMessage,
        system: "system2",
        mode: "tool_loop",
        rationale: `low_confidence_override:${effReason}`,
        decidedAt: now,
      };
      finalRationale = `${cognitive.rationale}; low_confidence(score=${effScore.toFixed(2)}): ${effReason}`;
      finalNeedsToolLoop = true;
    }

    // === 阶段 3：后置执行（安全检查 + 输出过滤 + 记忆写入）===
    const safety: SafetyCheckResult = cognitive.action
      ? this.checkSafety(cognitive.action)
      : {
          allowed: true,
          severity: "allowed",
          reason: "no_action",
          checkedAt: now,
        };

    // Stage 4 Task 2：输出安全过滤——检测 LLM 输出中的敏感信息并替换为 [REDACTED]。
    // limbic 未注册时 checkOutputSafety 原文本透传（safe=true）。
    const outputSafety = this.checkOutputSafety(cognitive.response, {
      actorId,
      sessionId: input.sessionId,
      stage: "cognize",
    });
    const finalResponse = outputSafety.sanitized;
    if (!outputSafety.safe) {
      console.log(
        `[BrainCenter] cognize 输出已脱敏 actorId=${actorId} reason=${outputSafety.reason}`,
      );
    }

    // 性能优化：记忆写入 fire-and-forget，不阻塞 cognize 返回。
    // streamCompletion 不依赖记忆写入结果，后台执行即可减少 complex 首字节延迟。
    if (cognitive.memoryWrites.length > 0 && this.memory) {
      const mem = this.memory;
      const wmCortex = this.workingMemoryCortex;
      const writes = cognitive.memoryWrites;
      void (async () => {
        try {
          let allWrites = writes;
          if (wmCortex) {
            try {
              const wmItems = wmCortex.toMemoryItems(actorId);
              if (wmItems.length > 0) {
                allWrites = [...writes, ...wmItems];
              }
            } catch {
              /* ignore working memory export failure */
            }
          }
          if (typeof mem.rememberBatch === "function") {
            await mem.rememberBatch(actorId, allWrites);
          } else {
            for (const item of allWrites) {
              try {
                await mem.remember(actorId, item);
              } catch {
                /* ignore */
              }
            }
          }
        } catch {
          /* ignore memory write failure */
        }
      })();
    }

    // 跨会话开放环路（记忆连续性 Phase 2）：提取 open loops / 承诺 / 偏好，
    // 持久化到 KV，新会话开场注入【上一会话待办】。
    // 降频改造（记忆链路 LLM 调用收敛）：从每轮提取改为每 N 轮批量提取
    // （SESSION_EPITOME_EVERY_N_TURNS，默认 5）；会话边界（新会话开场轮，
    // thread 极短）检测到上一会话残留时兜底批量提取，保证跨会话待办不丢。
    // 提取为纯规则 + 同步内存合并 + 一次 KV 写（毫秒级），在 cognize 主路径
    // 同步执行——新会话开场轮 cognize 返回后，agent-core 读取
    // 【上一会话待办】（buildRecentConversationHistoryBlock → KV session_epitome）
    // 时兜底数据已落盘，无竞态。提取原料用 query / memoryWrites / 脱敏后的
    // finalResponse（Agent 回复中的承诺也能被捕获）；无 memoryWrites 的轮次
    // 同样登记（query 中的用户请求不漏提取）。
    if (this.memory) {
      try {
        const batch = this.epitomeTurnGate.registerTurn(
          actorId,
          { query, writes: cognitive.memoryWrites, assistantText: finalResponse },
          { newSession: cognizeThreadMessageCount >= 0 && cognizeThreadMessageCount <= 1 },
        );
        if (batch.length > 0) {
          const merged: SessionEpitomeEntries = { openLoops: [], commitments: [], preferences: [] };
          const turnTexts: string[] = [];
          for (const turn of batch) {
            const entries = extractEpitomeEntries(turn.query, turn.writes, turn.assistantText);
            merged.openLoops.push(...entries.openLoops);
            merged.commitments.push(...entries.commitments);
            merged.preferences.push(...entries.preferences);
            if (turn.query || turn.assistantText) {
              // turnText 供完成检测：用户说"搞定了/不用了"时关闭对应 open loop（P3）
              turnTexts.push(`${turn.query}\n${turn.assistantText ?? ""}`);
            }
          }
          this.updateSessionEpitome(actorId, merged, turnTexts.join("\n"));
        }
      } catch {
        /* epitome 提取失败不影响对话主链路 */
      }
    }

    // === 深度优化（工作记忆连贯性）：阶段 3.4 自动提取对话要点写入槽位 ===
    // 让 setSlot 真正被使用，工作记忆每轮自动更新（不是只 pushGoal）
    if (this.workingMemoryCortex) {
      try {
        this.workingMemoryCortex.extractAndSetSlots(actorId, query);
      } catch {
        /* ignore slot extraction failure */
      }
    }

    // === 深度优化（工作记忆主题词）：阶段 3.4.1 提取主题词 ===
    // 每轮 LLM 调用削减：优先消费情绪推断（MoodInferenceService，阶段 1 已跑）
    // 同一次调用顺带产出的 topics（缓存读取，零额外 LLM）；未覆盖时才回退
    // 独立 TopicExtractor LLM 调用。仍是 fire-and-forget：
    // 主题词用于下一轮 working-memory 关联，本轮不读它，因此无需阻塞 cognize。
    if (this.workingMemoryCortex && query) {
      const applyTopics = (topics: string[]): boolean => {
        if (topics && topics.length > 0) {
          this.workingMemoryCortex!.setTopicSlots(actorId, topics);
          return true;
        }
        return false;
      };

      // 快路径：mood 缓存命中（阶段 1 情绪推断已完成且产出 topics）
      let applied = false;
      try {
        applied = applyTopics(this.moodTopicProvider?.(actorId, query) ?? []);
      } catch {
        /* provider 失败静默，走 LLM 回退 */
      }

      if (!applied && this.topicExtractor) {
        void Promise.race([
          this.topicExtractor(query),
          new Promise<string[]>((_, reject) =>
            setTimeout(() => reject(new Error("topic_extract_timeout")), 2000),
          ),
        ])
          .then((topics) => {
            applyTopics(topics);
          })
          .catch((err) => {
            if (String(err).includes("timeout")) {
              console.log(`[BrainCenter] topicExtractor 超时(2s)，跳过本轮主题词更新`);
            }
            // 其他失败静默：主题词是增强项，不影响本轮回复正确性
          });
      }
    }

    // === Step 7 扩展：阶段 3.6 — 在线学习观察 ===
    // 每轮 cognize 完成后流式更新用户画像。每轮都调用，不受 observeCount 守卫限制
    // 去掉原 observeCount === 0 守卫（bug：仅首轮更新，后续轮次画像不会更新）
    if (this.onlineLearningCortex) {
      try {
        // finalRoute 是 SystemRouteDecision，OnlineLearning.observe 需要 RuleRouteDecision
        const routeForLearning = {
          ...finalRoute,
          confidence: typeof cognitive.confidence === "number" ? cognitive.confidence : 0.5,
          reason: cognitive.rationale ?? finalRoute.rationale ?? "",
          matchedRules: [] as string[],
        } as import("./rule-router.js").RuleRouteDecision;
        this.onlineLearningCortex.observe(actorId, { text: query }, routeForLearning);
      } catch (err) {
        console.log(`[BrainCenter] 在线学习观察失败（忽略）: ${err}`);
      }
    }

    // === 阶段 3.6.1 — 用户画像聚合（已迁出）===
    // 2026-09-29：observeTurn 迁至 turn-lifecycle.finalizeTurn——原位传
    // cognitive.response（DecisionHub 路径恒空串），画像只见用户半边；
    // finalizeTurn 拿真实助手全文，且任务面轮次也开始喂画像。

    // === 阶段 3.6.2 — 记忆隐式反馈检测（P1-3）===
    // 从对话形态（纠正/认同/重复提问/换话题）检测上一轮召回记忆的相关性信号，
    // 回灌 MemoryFeedbackStore，影响后续召回排序。纯规则零延迟。
    if (this.implicitFeedbackDetector && this.memory && typeof this.memory.recordImplicitFeedbacks === "function") {
      try {
        const signals = this.implicitFeedbackDetector.detectAndAdvance(actorId, {
          userText: query,
          assistantText: cognitive.response ?? "",
          recalledMemories: (recallResult?.items ?? []).map((it) => ({
            content: it.content,
            score: it.score,
          })),
        });
        if (signals.length > 0) {
          this.memory.recordImplicitFeedbacks(actorId, signals);
        }
      } catch (err) {
        console.log(`[BrainCenter] 隐式反馈检测失败（忽略）: ${err}`);
      }
    }

    // === Step 7 扩展：阶段 3.7 — 情感调制推理触发（4 项仿人推理能力扩展）===
    // 在 cognize 后置阶段异步触发多线索交叉推理：
    //   1. 从 LimbicCortex 获取当前情绪（getCurrentEmotion）
    //   2. 构造线索：userInput（显性）+ 最近召回的记忆（隐性）
    //   3. 调用 memory.inferFromClues(actorId, clues, emotion) 做情感调制推理
    // 异步触发，不阻塞响应；失败静默降级。
    if (this.memory && typeof this.memory.inferFromClues === "function" && query) {
      const emotion = this.getCurrentEmotion(actorId);
      const clues: InferenceClue[] = [
        { text: query, source: "user_input" },
        ...(recallResult?.items ?? [])
          .slice(0, 2)
          .map((it) => ({ text: it.content, source: "memory_recalled" as const })),
      ];
      if (clues.length >= 2) {
        void this.memory
          .inferFromClues(actorId, clues, emotion)
          .catch(() => {
            /* 静默降级 */
          });
      }
    }

    // 深度优化：阶段 3.7 提取工作记忆摘要（注入 streamCompletion 的 prompt）
    // 让主 Agent LLM 真正感知"当前对话上下文"
    let workingMemorySummary = "";
    if (this.workingMemoryCortex) {
      try {
        workingMemorySummary = this.workingMemoryCortex.toSummary(actorId);
      } catch {
        /* ignore summary failure */
      }
    }

    return {
      actorId,
      route: finalRoute,
      response: finalResponse,
      emotion: context.emotion,
      memoryWrites: cognitive.memoryWrites,
      action: cognitive.action,
      safety,
      needsToolLoop: finalNeedsToolLoop,
      rationale: finalRationale,
      cognizedAt: now,
      // 携带阶段 1 已召回的记忆条目，供后续 standard path 复用，避免重复 MemoryCortex.recall
      recallItems: recallResult?.items ?? [],
      // 门控单点化：白名单判定结果透出，agent-core / prompt 装配层复用，不再各自重评
      recallGate: { trigger: recallGate.trigger, reason: recallGate.reason },
      // 深度优化：工作记忆摘要（活跃目标+槽位+待办），供 streamCompletion 注入 prompt
      workingMemorySummary,
      // 最近 6 轮对话历史，供 streamCompletion 注入 prompt【最近对话】块（解决追问断片）
      recentConversationHistory: recentConversationHistory || undefined,
      // 深度优化：工具规划链（complex 路由时由 DecisionHub 或 ToolPlanningCortex 生成）
      // 注入到 streamCompletion 的 system prompt，约束 LLM 工具选择顺序和范围
      toolPlan: cognitive.toolPlan,
      };
  }

  /** 主动决策：根据输入信号产出大脑决策 */
  async decide(signal: BrainSignalInput): Promise<BrainDecision> {
    if (!this.proaction) {
      console.log("[BrainCenter] decide: ProactionCortex 缺失，返回静默降级决策");
      return {
        actorId: signal.actorId,
        outcome: "silent",
        valueScore: 0,
        disturbScore: 0,
        rationale: "ProactionCortex 未注册，默认静默",
        decidedAt: new Date().toISOString(),
      };
    }
    return this.proaction.decide(signal);
  }

  /** 自我进化：提交一个进化提案 */
  evolve(
    proposal: Omit<EvolutionProposal, "id" | "status" | "createdAt" | "updatedAt">,
  ): EvolutionProposal {
    if (!this.evolution) {
      console.log("[BrainCenter] evolve: EvolutionCortex 缺失，返回未持久化的临时提案");
      const now = new Date().toISOString();
      return {
        ...proposal,
        id: randomUUID(),
        status: "pending",
        createdAt: now,
        updatedAt: now,
      };
    }
    return this.evolution.evolve(proposal);
  }

  /**
   * 用户同意装载进化提案生成的 Skill（用户审批闸门）。
   * 委托 EvolutionCortex.approveByUser：调 PromotionPipeline.promote 装载到 SkillManager。
   */
  async approveEvolution(
    proposalId: string,
    sessionId?: string,
  ): Promise<{ ok: boolean; proposal: EvolutionProposal | null; error?: string }> {
    if (!this.evolution?.approveByUser) {
      return { ok: false, proposal: null, error: "EvolutionCortex 或 approveByUser 未注册" };
    }
    return this.evolution.approveByUser(proposalId, sessionId);
  }

  /**
   * 用户拒绝装载进化提案生成的 Skill（用户审批闸门）。
   * 委托 EvolutionCortex.rejectByUser：awaiting_user_approval → rejected。
   */
  rejectEvolution(
    proposalId: string,
    reason: string | undefined,
    sessionId?: string,
  ): { ok: boolean; proposal: EvolutionProposal | null } {
    if (!this.evolution?.rejectByUser) {
      return { ok: false, proposal: null };
    }
    return this.evolution.rejectByUser(proposalId, reason, sessionId);
  }

  /**
   * 显式执行入口：外部（用户 / Agent）按 id 触发单个进化提案执行。
   * 委托 EvolutionCortex.executeProposal；未注册 / 未实现时返回 ok=false。
   */
  async executeEvolution(proposalId: string): Promise<{
    ok: boolean;
    proposal: EvolutionProposal | null;
    error?: string;
  }> {
    if (!this.evolution?.executeProposal) {
      return { ok: false, proposal: null, error: "EvolutionCortex 或 executeProposal 未注册" };
    }
    return this.evolution.executeProposal(proposalId);
  }

  /** 听：委托 SensoryCortex.listen 做语音识别；缺失时返回空结果 */
  async listen(
    audio: AudioBufferRef,
    opts?: { language?: string },
  ): Promise<SensoryListenResult> {
    if (!this.sensory) {
      console.log("[BrainCenter] listen: SensoryCortex 缺失");
      return {
        text: "",
        confidence: 0,
        isFinal: false,
        processedAt: new Date().toISOString(),
        error: "SensoryCortex 未注册",
      };
    }
    try {
      return await this.sensory.listen(audio, opts);
    } catch (err) {
      console.log(`[BrainCenter] listen 调用失败: ${err}`);
      return {
        text: "",
        confidence: 0,
        isFinal: false,
        processedAt: new Date().toISOString(),
        error: "SensoryCortex 未注册",
      };
    }
  }

  /** 看：委托 SensoryCortex.look 截屏并生成视觉描述；缺失时返回空结果 */
  async look(opts?: VisualInput): Promise<SensoryLookResult> {
    if (!this.sensory) {
      console.log("[BrainCenter] look: SensoryCortex 缺失");
      return {
        processedAt: new Date().toISOString(),
        error: "SensoryCortex 未注册",
      };
    }
    try {
      return await this.sensory.look(opts);
    } catch (err) {
      console.log(`[BrainCenter] look 调用失败: ${err}`);
      return {
        processedAt: new Date().toISOString(),
        error: "SensoryCortex 未注册",
      };
    }
  }

  /** 说：委托 SensoryCortex.speak 合成并投递语音；缺失时返回投递失败 */
  async speak(
    text: string,
    opts?: { voiceId?: string; channel?: string },
  ): Promise<SensorySpeakResult> {
    if (!this.sensory) {
      console.log("[BrainCenter] speak: SensoryCortex 缺失");
      return {
        delivered: false,
        channel: opts?.channel ?? "ws",
        processedAt: new Date().toISOString(),
        error: "SensoryCortex 未注册",
      };
    }
    try {
      return await this.sensory.speak(text, opts);
    } catch (err) {
      console.log(`[BrainCenter] speak 调用失败: ${err}`);
      return {
        delivered: false,
        channel: opts?.channel ?? "ws",
        processedAt: new Date().toISOString(),
        error: "SensoryCortex 未注册",
      };
    }
  }

  /** 记忆写入：委托 MemoryCortex.remember；缺失时记日志并跳过 */
  async remember(actorId: string, item: MemoryItem): Promise<void> {
    if (!this.memory) {
      console.log("[BrainCenter] remember: MemoryCortex 缺失");
      return;
    }
    try {
      return await this.memory.remember(actorId, item);
    } catch (err) {
      console.log(`[BrainCenter] remember 调用失败: ${err}`);
      return;
    }
  }

  /** 记忆召回：委托 MemoryCortex.recall；缺失时返回空召回结果 */
  async recall(
    actorId: string,
    query: string,
    opts?: { domain?: MemoryDomainKind; limit?: number },
  ): Promise<MemoryRecallResult> {
    if (!this.memory) {
      console.log("[BrainCenter] recall: MemoryCortex 缺失");
      return {
        actorId,
        query,
        items: [],
        domain: opts?.domain ?? "semantic",
        mode: "single_domain",
        recalledAt: new Date().toISOString(),
      };
    }
    try {
      return await this.memory.recall(actorId, query, opts);
    } catch (err) {
      console.log(`[BrainCenter] recall 调用失败: ${err}`);
      return {
        actorId,
        query,
        items: [],
        domain: opts?.domain ?? "semantic",
        mode: "single_domain",
        recalledAt: new Date().toISOString(),
      };
    }
  }

  /** 突触发射：委托 SynapseBus.fire 发布进程内事件；缺失时返回未投递信封 */
  fire(
    type: string,
    data: Record<string, unknown>,
    opts?: { actorId?: string; source?: string },
  ): SynapseEnvelope {
    if (!this.synapse) {
      console.log("[BrainCenter] fire: SynapseBus 缺失");
      return {
        message: {
          id: randomUUID(),
          type,
          route: "internal",
          from: opts?.source ?? "brain",
          data,
          timestamp: new Date().toISOString(),
        },
        delivered: false,
        error: "SynapseBus 未注册",
      };
    }
    try {
      return this.synapse.fire(type, data, opts);
    } catch (err) {
      console.log(`[BrainCenter] fire 调用失败: ${err}`);
      return {
        message: {
          id: randomUUID(),
          type,
          route: "internal",
          from: opts?.source ?? "brain",
          data,
          timestamp: new Date().toISOString(),
        },
        delivered: false,
        error: "SynapseBus 未注册",
      };
    }
  }

  /** 安全检查：委托 LimbicCortex.checkSafety；缺失时默认放行 */
  checkSafety(
    action: { tool: string; args: Record<string, unknown> },
    ctx?: Record<string, unknown>,
  ): SafetyCheckResult {
    if (!this.limbic) {
      console.log("[BrainCenter] checkSafety: LimbicCortex 缺失");
      return {
        allowed: true,
        severity: "allowed",
        reason: "LimbicCortex 未注册，默认放行",
        checkedAt: new Date().toISOString(),
      };
    }
    try {
      return this.limbic.checkSafety(action, ctx);
    } catch (err) {
      console.log(`[BrainCenter] checkSafety 调用失败: ${err}`);
      return {
        allowed: true,
        severity: "allowed",
        reason: "LimbicCortex 未注册，默认放行",
        checkedAt: new Date().toISOString(),
      };
    }
  }

  /**
   * 输出安全过滤（Stage 4 Task 2）：委托 LimbicCortex.checkOutputSafety。
   *
   * 在 cognize 阶段 3 后置执行、在 executeProactiveDecision 话术输出后执行，
   * 检测 LLM 输出中的 API key / 私钥 / 长随机串 / 内部路径并替换为 [REDACTED]。
   * LimbicCortex 未注册或调用异常时原文本透传（降级，不阻塞主流程）。
   */
  checkOutputSafety(
    text: string,
    ctx?: Record<string, unknown>,
  ): { safe: boolean; sanitized: string; reason?: string } {
    if (!this.limbic || typeof this.limbic.checkOutputSafety !== "function") {
      return { safe: true, sanitized: text };
    }
    try {
      return this.limbic.checkOutputSafety(text, ctx);
    } catch (err) {
      console.log(`[BrainCenter] checkOutputSafety 调用失败: ${err}`);
      return { safe: true, sanitized: text };
    }
  }

  /**
   * 获取当前情绪状态（4 项仿人推理能力扩展）。
   *
   * 从 LimbicCortex.getLastEmotion 拉取最近一次情绪识别结果，
   * 转换为 EmotionState（VAD 三维度）供推理引擎做情感调制。
   *
   * LimbicCortex 未注册 / 无最近情绪时返回 null（推理引擎将不调制）。
   *
   * @param actorId 当前 actor
   * @returns EmotionState 或 null
   */
  getCurrentEmotion(actorId: string): EmotionState | null {
    if (!this.limbic) return null;
    try {
      const ev = this.limbic.getLastEmotion(actorId);
      if (!ev) return null;
      // EmotionVector → EmotionState 字段直接映射
      // （EmotionVector.arousal 是 0~1，EmotionState 标注 -1~1 但阈值逻辑对 0~1 也成立）
      return {
        arousal: ev.arousal,
        valence: ev.valence,
        dominance: ev.dominance,
      };
    } catch {
      return null;
    }
  }

  /** 规划：委托 PlannerCortex.plan；缺失时返回空计划 */
  async plan(
    goal: string,
    opts?: { actorId?: string; maxSteps?: number },
  ): Promise<PlanResult> {
    if (!this.planner) {
      console.log("[BrainCenter] plan: PlannerCortex 缺失");
      return {
        goal,
        steps: [],
        rationale: "PlannerCortex 未注册",
        createdAt: new Date().toISOString(),
      };
    }
    try {
      return await this.planner.plan(goal, opts);
    } catch (err) {
      console.log(`[BrainCenter] plan 调用失败: ${err}`);
      return {
        goal,
        steps: [],
        rationale: "PlannerCortex 未注册",
        createdAt: new Date().toISOString(),
      };
    }
  }

  /** 系统路由：委托 PlannerCortex.routeSystem；缺失时返回 fast 兜底 */
  routeSystem(
    userMessage: string,
    opts?: { actorId?: string },
  ): SystemRouteDecision {
    if (!this.planner) {
      console.log("[BrainCenter] routeSystem: PlannerCortex 缺失");
      return {
        userMessage,
        system: "system1",
        mode: "direct",
        rationale: "PlannerCortex 未注册",
        decidedAt: new Date().toISOString(),
      };
    }
    try {
      return this.planner.routeSystem(userMessage, opts);
    } catch (err) {
      console.log(`[BrainCenter] routeSystem 调用失败: ${err}`);
      return {
        userMessage,
        system: "system1",
        mode: "direct",
        rationale: "PlannerCortex 未注册",
        decidedAt: new Date().toISOString(),
      };
    }
  }

  /** 子 Agent 委派：委托 PlannerCortex.delegate；缺失时返回失败 */
  async delegate(
    subAgentType: string,
    task: { goal: string; input?: unknown },
    opts?: { actorId?: string },
  ): Promise<unknown> {
    if (!this.planner) {
      console.log("[BrainCenter] delegate: PlannerCortex 缺失");
      return { ok: false, error: "PlannerCortex 未注册" };
    }
    try {
      return await this.planner.delegate(subAgentType, task, opts);
    } catch (err) {
      console.log(`[BrainCenter] delegate 调用失败: ${err}`);
      return {
        ok: false,
        error: `delegate 调用失败: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * LLM 语义委派判断（shouldDelegate 的 LLM 化版本）。
   *
   * 委托 PlannerCortex.shouldDelegateWithLLM：替代原 DELEGATE_KEYWORDS 纯关键词匹配，
   * 做语义级判断（评估任务复杂度、是否需要外部工具/信息）。
   * 未注入 DelegateJudge / 降级开关关闭 / LLM 失败时回退到 shouldDelegate 规则匹配。
   *
   * 注意：routeSystem 同步路径仍用 shouldDelegate（规则），不调用此异步方法。
   * 此方法供异步调用方（如 cognize 增强路径 / 外部 API）使用。
   */
  async shouldDelegateWithLLM(
    userMessage: string,
    opts?: { actorId?: string },
  ): Promise<{
    delegate: boolean;
    agentType?: string;
    reason?: string;
    confidence?: number;
  }> {
    if (!this.planner || typeof this.planner.shouldDelegateWithLLM !== "function") {
      return { delegate: false };
    }
    try {
      return await this.planner.shouldDelegateWithLLM(userMessage, opts);
    } catch (err) {
      console.log(`[BrainCenter] shouldDelegateWithLLM 调用失败: ${err}`);
      return { delegate: false };
    }
  }

  /** 大脑状态快照：聚合九个脑区当前状态 */
  snapshot(actorId: string): BrainSnapshot {
    const now = new Date().toISOString();
    return {
      actorId,
      capabilities: this.cap ? this.cap.introspect(actorId) : [],
      userActivity: this.awareness ? this.awareness.observe(actorId) : null,
      lastDecisions: this.proaction?.recentDecisions?.(actorId) ?? [],
      pendingEvolutions: this.evolution?.listPending?.(actorId) ?? [],
      sensory: this.sensory ? { stats: this.sensory.getStats() } : undefined,
      memory: this.memory ? { recentItems: [] } : undefined,
      synapse: this.synapse
        ? {
            recentMessages: this.synapse.getRecentMessages(10),
            subscribers: this.synapse.getSubscriberCount(),
          }
        : undefined,
      limbic: this.limbic
        ? {
            lastEmotion: this.limbic.getLastEmotion(actorId) ?? undefined,
            lastSafetyCheck: this.limbic.getLastSafetyCheck() ?? undefined,
          }
        : undefined,
      planner: this.planner
        ? {
            lastPlan: this.planner.getLastPlan() ?? undefined,
            lastRoute: this.planner.getLastRoute() ?? undefined,
          }
        : undefined,
      brainStem: this.brainStem?.snapshot
        ? (() => {
            const s = this.brainStem!.snapshot()!;
            return {
              ...s,
              lastSweepAt: s.lastSweepAt ?? undefined,
            };
          })()
        : undefined,
      cerebellum: this.cerebellum?.snapshot
        ? (() => {
            const s = this.cerebellum!.snapshot()!;
            return {
              ...s,
              lastInterruptAt: s.lastInterruptAt ?? undefined,
            };
          })()
        : undefined,
      runtimeKernel: this.runtimeKernel?.snapshot(),
      bodyState: this.safeGetBodyState(),
      capturedAt: now,
    };
  }

  /**
   * 安全获取身体状态聚合（BodyGateway.snapshot().state）。
   * - bodyGateway 未注入 → 返回 undefined（纯脑模式，向后兼容）
   * - snapshot 调用异常 → 记日志并返回 undefined（不阻塞 BrainSnapshot）
   */
  private safeGetBodyState(): BodyState | undefined {
    if (!this.bodyGateway) return undefined;
    try {
      return this.bodyGateway.snapshot().state;
    } catch (err) {
      console.log(`[BrainCenter] snapshot bodyGateway 异常（忽略）: ${err}`);
      return undefined;
    }
  }

  /**
   * 获取各皮层模块健康状态（是否已注册 + 是否已启动）。
   * 供外部健康检查 / 监控使用。
   */
  getHealth(): {
    started: boolean;
    modules: Array<{ name: string; registered: boolean }>;
  } {
    return {
      started: this.started,
      modules: [
        { name: "CapabilityCortex", registered: this.cap !== null },
        { name: "AwarenessCortex", registered: this.awareness !== null },
        { name: "ProactionCortex", registered: this.proaction !== null },
        { name: "EvolutionCortex", registered: this.evolution !== null },
        { name: "CodeRepairCortex", registered: this.codeRepair !== null },
        { name: "SensoryCortex", registered: this.sensory !== null },
        { name: "MemoryCortex", registered: this.memory !== null },
        { name: "SynapseBus", registered: this.synapse !== null },
        { name: "LimbicCortex", registered: this.limbic !== null },
        { name: "PlannerCortex", registered: this.planner !== null },
        { name: "BrainStem", registered: this.brainStem !== null },
        { name: "Cerebellum", registered: this.cerebellum !== null },
        { name: "CognitiveEngine", registered: this.cognitiveEngine !== null },
        { name: "DecisionHub", registered: this.decisionHub !== null },
        { name: "WorkingMemoryCortex", registered: this.workingMemoryCortex !== null },
        { name: "TaskSwitchingCortex", registered: this.taskSwitchingCortex !== null },
        { name: "ContextCortex", registered: this.contextCortex !== null },
        { name: "ToolPlanningCortex", registered: this.toolPlanningCortex !== null },
        { name: "OnlineLearningCortex", registered: this.onlineLearningCortex !== null },
        { name: "EmotionModulator", registered: this.emotionModulator !== null },
        { name: "BodyGateway", registered: this.bodyGateway !== null },
      ],
    };
  }

  // ---- 生命周期 ----------------------------------------------------------

  /** 启动大脑：依次启动已注册的皮层（缺失或无 start 方法则跳过） */
  async start(): Promise<void> {
    if (this.started) {
      console.log("[BrainCenter] 已启动，跳过重复 start");
      return;
    }
    console.log("[BrainCenter] 正在启动...");
    await this.startCortex("CapabilityCortex", this.cap);
    await this.startCortex("AwarenessCortex", this.awareness);
    await this.startCortex("ProactionCortex", this.proaction);
    await this.startCortex("EvolutionCortex", this.evolution);
    await this.startCortex("CodeRepairCortex", this.codeRepair);
    await this.startCortex("SensoryCortex", this.sensory);
    await this.startCortex("MemoryCortex", this.memory);
    await this.startCortex("SynapseBus", this.synapse);
    await this.startCortex("LimbicCortex", this.limbic);
    await this.startCortex("PlannerCortex", this.planner);
    await this.startCortex("BrainStem", this.brainStem);
    await this.startCortex("Cerebellum", this.cerebellum);
    this.started = true;
    console.log("[BrainCenter] 启动完成");
  }

  /** 停止大脑：依次停止已注册的皮层（缺失或无 stop 方法则跳过） */
  async stop(): Promise<void> {
    if (!this.started) {
      console.log("[BrainCenter] 未启动，跳过 stop");
      return;
    }
    console.log("[BrainCenter] 正在停止...");
    await this.stopCortex("CapabilityCortex", this.cap);
    await this.stopCortex("AwarenessCortex", this.awareness);
    await this.stopCortex("ProactionCortex", this.proaction);
    await this.stopCortex("EvolutionCortex", this.evolution);
    await this.stopCortex("CodeRepairCortex", this.codeRepair);
    await this.stopCortex("SensoryCortex", this.sensory);
    await this.stopCortex("MemoryCortex", this.memory);
    await this.stopCortex("SynapseBus", this.synapse);
    await this.stopCortex("LimbicCortex", this.limbic);
    await this.stopCortex("PlannerCortex", this.planner);
    await this.stopCortex("Cerebellum", this.cerebellum);
    await this.stopCortex("BrainStem", this.brainStem);
    this.started = false;
    console.log("[BrainCenter] 已停止");
  }

  // ---- 内部工具 ----------------------------------------------------------

  private async startCortex(
    name: string,
    c: { start?(): Promise<void> } | null,
  ): Promise<void> {
    if (!c || typeof c.start !== "function") {
      return;
    }
    try {
      await c.start();
      console.log(`[BrainCenter] ${name} 已启动`);
    } catch (err) {
      console.log(`[BrainCenter] ${name} 启动失败: ${err}`);
    }
  }

  private async stopCortex(
    name: string,
    c: { stop?(): Promise<void> } | null,
  ): Promise<void> {
    if (!c || typeof c.stop !== "function") {
      return;
    }
    try {
      await c.stop();
      console.log(`[BrainCenter] ${name} 已停止`);
    } catch (err) {
      console.log(`[BrainCenter] ${name} 停止失败: ${err}`);
    }
  }
}
