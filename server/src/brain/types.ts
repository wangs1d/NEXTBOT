// Agent Brain Center — 核心类型定义

import type { RuntimeKernelState } from "../agent/runtime-kernel.js";
import type { BodyState } from "../body/types.js";

// 能力描述符
export type CapabilityStatus = "active" | "disabled" | "planned" | "deprecated";
export interface CapabilityDescriptor {
  domain: string;              // 能力域标识，如 "wallet" / "calendar" / "self_programming"
  label: string;              // 中文标签
  description?: string;       // 简短描述
  tools: string[];            // 该域下的工具名列表
  status: CapabilityStatus;
  source: "builtin" | "skill" | "dynamic";  // 能力来源
  registeredAt: string;       // ISO timestamp
}

// 用户活动状态
// 注：活动类型仅作为「打扰评分上下文」（如 sleeping 状态打扰分高），
// 不作为主动决策的入口。主动决策由 LifeSignal 原始字段驱动通用评分。
export type UserActivityKind =
  | "just_off_work"     // 刚下班
  | "going_out"         // 准备出行
  | "meeting"           // 会议中（schedule-task-service 当前有进行中的日历事件）
  | "in_focus"          // 深度专注（持续 busy 超过 25 分钟且无 speak 打断）
  | "idle"              // 空闲
  | "busy"              // 忙碌
  | "sleeping"          // 休息/睡眠
  | "unknown";

export interface UserActivityState {
  actorId: string;
  activity: UserActivityKind;
  confidence: number;        // 0-1
  evidence: string[];        // 证据片段
  metadata?: Record<string, unknown>;  // 如 { destination, time } 用于 going_out
  occurredAt: string;        // ISO timestamp
}

/**
 * 用户心智状态（SemanticAwarenessInferrer 产出）。
 *
 * 比 UserActivityState 更深层：描述用户「为什么」处于当前状态、
 * 在聊什么话题趋势、和 Agent 的关系亲密度。由轻量 LLM 推断，
 * 未注册 inferrer 时降级为 unknown（不影响 AwarenessCortex 原规则路径）。
 */
export interface UserMentalState {
  actorId: string;
  /** 意图分类：用户当下想做什么 */
  intentCategory:
    | "planning"     // 规划期（如换工作、筹备旅行）
    | "executing"    // 执行期（赶工、做具体事）
    | "reflecting"   // 反思期（复盘、总结）
    | "chatting"     // 闲聊
    | "seeking_help" // 求助
    | "venting"      // 宣泄情绪
    | "unknown";
  /** 情绪成因猜测：帮助 Agent 选择合适的话术 */
  emotionCause:
    | "work_pressure"    // 工作压力
    | "interpersonal"    // 人际冲突
    | "physical_unwell"  // 身体不适
    | "anticipation"     // 期待
    | "disappointment"   // 失落
    | "neutral"
    | "unknown";
  /** 当前连续话题趋势（如 "换工作 已聊 3 天"），无趋势时为 null */
  topicTrend: { topic: string; daysActive: number; turnCountInTopic: number } | null;
  /** 与 Agent 的关系亲密度 0-1（基于累计对话轮数 + 共享记忆数 + 承诺兑现率） */
  relationshipCloseness: number;
  /** 推断依据（简短证据片段，供 debug） */
  evidence: string[];
  inferredAt: string;      // ISO timestamp
}

/**
 * 语义觉察推断器接口（可注入 AwarenessCortex）。
 *
 * 实现方通常跑一次轻量 LLM，基于最近 N 轮对话历史 + 情绪时间线 + 关系状态，
 * 产出 UserMentalState。未注册时 AwarenessCortex.observe 返回 mental=unknown。
 */
export interface SemanticAwarenessInferrer {
  infer(
    actorId: string,
    opts: {
      recentConversationHistory?: string;
      recentActivity?: UserActivityState;
    },
  ): Promise<UserMentalState>;
}

// 大脑决策
export type BrainDecisionOutcome = "speak" | "silent" | "shadow";

/** 决策建议的主动动作（环境控制类） */
export interface BrainDecisionAction {
  /** 工具名，如 smart_home.set_state / desktop.open / schedule.create_task */
  tool: string;
  /** 工具参数 */
  args: Record<string, unknown>;
  /** 动作原因 */
  reason: string;
}

export interface BrainDecision {
  actorId: string;
  outcome: BrainDecisionOutcome;
  valueScore: number;        // 0-10，价值评分
  disturbScore: number;      // 0-10，打扰评分
  rationale: string;
  message?: string;          // 若 outcome=speak，最终话术
  channel?: string;          // 发送通道
  /** 决策建议的主动动作列表（环境控制类，如关窗/调空调/创建日程） */
  actions?: BrainDecisionAction[];
  /**
   * decide 阶段（端到端 LLM 路径）已召回的记忆条目（limit=5）。
   * 携带此字段供 executeProactiveDecision / buildProactivePrompt 复用，
   * 避免对同一 LifeSignal 重复执行 MemoryCortex.recall。
   * 缺失时（如非 e2e 路径 / 召回失败）buildProactivePrompt 降级到独立 episodic 召回。
   */
  recallItems?: MemoryRecallItem[];
  decidedAt: string;
}

// 大脑状态快照
export interface BrainSnapshot {
  actorId: string;
  capabilities: CapabilityDescriptor[];
  userActivity: UserActivityState | null;
  lastDecisions: BrainDecision[];
  capturedAt: string;
  // 神经解剖扩展（可选）
  sensory?: {
    lastFrame?: SensoryFrame;
    stats?: { totalListen?: number; totalLook?: number; totalSpeak?: number };
  };
  memory?: {
    recentItems?: MemoryItem[];
    consolidationStats?: MemoryConsolidationStats;
  };
  synapse?: {
    recentMessages?: SynapseMessage[];
    subscribers?: number;
  };
  limbic?: {
    lastEmotion?: EmotionVector;
    lastSafetyCheck?: SafetyCheckResult;
  };
  planner?: {
    lastPlan?: PlanResult;
    lastRoute?: SystemRouteDecision;
  };
  // subcortical 扩展（脑干/小脑,可选）
  brainStem?: {
    lastSweepAt?: string;
    syntheticSignalsEmitted?: number;
    activeActors?: number;
  };
  cerebellum?: {
    pendingCount?: number;
    interruptedCount?: number;
    lastInterruptAt?: string;
  };
  runtimeKernel?: RuntimeKernelState;
  /**
   * 身体状态聚合（来自 BodyGateway.snapshot().state）。
   * 含电量/位置/算力配额/负载/疲劳度/当前设备/情绪基调/是否在渲染具身。
   * bodyGateway 未注入时为 undefined（纯脑模式，向后兼容）。
   */
  bodyState?: BodyState;
}

// 信号输入（用于 decide）
export interface BrainSignalInput {
  actorId: string;
  kind: string;              // 信号类型
  title: string;
  summary?: string;
  importance?: "critical" | "high" | "medium" | "low";
  metadata?: Record<string, unknown>;
}

// ============================================================
// 神经解剖分区扩展类型（SensoryCortex / MemoryCortex / SynapseBus / LimbicCortex / PlannerCortex）
// ============================================================

// ---------- 1. 感官类型（SensoryCortex 用） ----------

// 感官输入（统一抽象 ASR / 视觉 / 情绪信号）
export interface SensoryInput {
  source: "audio" | "visual" | "text" | "multimodal";
  audio?: AudioBufferRef;       // 音频引用
  visual?: VisualInput;         // 视觉输入
  text?: string;                // 文本输入
  emotionHint?: EmotionVector;  // 情绪提示
  occurredAt: string;
}

// 音频缓冲引用（不限定具体类型，避免与 voice-dialogue/types 强耦合）
export interface AudioBufferRef {
  data: unknown;                // Buffer 或引用
  format: "mp3" | "wav" | "pcm" | "ogg";
  sampleRate?: number;
  channels?: number;
}

// 视觉输入
export interface VisualInput {
  source: "screenshot" | "file" | "url";
  region?: { x: number; y: number; width: number; height: number };
  path?: string;                // 文件路径（file/url 时）
  capture?: boolean;            // 是否要触发截屏
}

// 感官「听」结果
export interface SensoryListenResult {
  text: string;
  confidence: number;
  language?: string;
  isFinal: boolean;
  processedAt: string;
  error?: string;               // 子系统缺失或调用失败时的错误信息
}

// 感官「看」结果
export interface SensoryLookResult {
  screenshot?: string;          // base64 或路径
  description?: string;         // VLM 描述
  processedAt: string;
  error?: string;               // 子系统缺失或调用失败时的错误信息
}

// 感官「说」结果
export interface SensorySpeakResult {
  audio?: AudioBufferRef;       // 合成音频（如 TTS）
  delivered: boolean;           // 是否已投递
  channel: string;              // 投递通道（ws / phone / ...）
  processedAt: string;
  error?: string;               // 子系统缺失或调用失败时的错误信息
}

// 多模态融合帧：把 ASR + 视觉 + 情绪融合为统一感知帧
export interface SensoryFrame {
  actorId: string;
  audioText?: string;
  visualDescription?: string;
  emotion?: EmotionVector;
  activity?: UserActivityState;  // 引用现有类型
  capturedAt: string;
  /** 多模态冲突标记（Phase 4 扩展，如 ["audio_visual_conflict"]） */
  conflictFlags?: string[];
  /** 融合置信度 0-1（Phase 4 扩展） */
  fusionConfidence?: number;
  /** 主导模态（Phase 4 扩展，如 "audio" / "visual" / "activity"） */
  primaryModality?: "audio" | "visual" | "activity" | "emotion";
}

/** FusedFrame 是 SensoryFrame 的别名（Phase 4 向后兼容） */
export type FusedFrame = SensoryFrame;

// ---------- 2. 记忆类型（MemoryCortex 用） ----------

// 记忆域种类（对应不同脑区）
export type MemoryDomainKind =
  | "working"          // 工作记忆（短期）
  | "episodic"         // 情节记忆（事件）
  | "semantic"         // 语义记忆（知识）
  | "procedural"       // 程序记忆（技能）
  | "emotional"        // 情感记忆
  | "narrative"        // 叙事记忆
  | "personality"      // 人格内核（结构化特质，防漂移）
  | "relationship"     // 关系记忆（里程碑/轨迹/共同经历，Phase 1.2）
  | "world";           // 世界状态轨迹（WorldModel 状态时间序列，P1-10）

// ---- 人格内核（personality 域）----

/** 说话风格子结构 */
export interface PersonalitySpeechStyle {
  /** 语气基调，如 "温和" / "活泼" / "沉稳" */
  tone: string;
  /** 正式程度，如 "适中" / "正式" / "随性" */
  formality: string;
  /** 幽默程度，如 "适度" / "偏高" / "偏低" */
  humor: string;
}

/**
 * 结构化人格内核 —— 存储于 MemoryCortex 的 personality 域，
 * 防止单次对话导致人格漂移。组装 system prompt 时拉取并注入稳定前缀。
 */
export interface PersonalityCore {
  /** 核心价值观，如 ["真诚", "帮助他人", "持续成长"] */
  values: string[];
  /** 说话风格 */
  speech_style: PersonalitySpeechStyle;
  /** 信念，如 ["技术应服务于人"] */
  beliefs: string[];
  /** 口癖 / 小习惯，如 ["偶尔用比喻解释复杂概念"] */
  quirks: string[];
}

// 记忆条目种类
export type MemoryItemKind =
  | "task"
  | "fact"
  | "preference"
  | "event"
  | "commitment"
  | "knowledge"
  | "experience"
  | "procedure";

/**
 * 记忆隐私分级。
 * - public：可自由注入 prompt
 * - personal：注入前需经 redactSensitiveText 脱敏（去 PII）
 * - sensitive：敏感，默认不注入 prompt（仅特定路径可用）
 * - restricted：受限，recall 默认不返回给 prompt 路径
 */
export type MemorySensitivity = "public" | "personal" | "sensitive" | "restricted";

// 记忆条目
export interface MemoryItem {
  actorId: string;
  kind: MemoryItemKind;
  domain?: MemoryDomainKind;     // 推荐写入哪个域
  content: string;
  importance?: "critical" | "high" | "medium" | "low";
  /** 隐私分级，缺省 "public"。restricted 级不进入 prompt 路径。 */
  sensitivity?: MemorySensitivity;
  sessionId?: string;            // 工作记忆的会话 id
  source?: "chat" | "tool" | "digest" | "world" | "system";
  metadata?: Record<string, unknown>;
  timestamp: string;
  /**
   * 多模态记忆扩展（可选）。
   * 携带此字段时，content 视为该媒体的文字描述（caption），
   * 二进制数据由 MemoryCortex 存到本地文件系统，路径写入 mediaRef.storageId。
   * 缺省时为纯文本记忆（向后兼容）。
   */
  media?: MemoryMedia;
}

/** 多模态媒体数据（写入时携带二进制，存储后只保留引用） */
export interface MemoryMedia {
  kind: "image" | "audio" | "video";
  /** 媒体二进制数据（仅写入时携带，存储后丢弃） */
  blob?: Buffer;
  /** 存储后生成的引用 ID（如 sha256.<ext>），召回时用此拉取文件 */
  storageId?: string;
  mime: string;
  /** 媒体的文字描述 / caption（与 MemoryItem.content 重复但独立保留，便于召回时直接用） */
  caption?: string;
  /** 原始来源标记：screenshot / voice_message / camera_capture / user_upload */
  origin?: string;
}

// 记忆召回结果
export interface MemoryRecallResult {
  actorId: string;
  query: string;
  items: MemoryRecallItem[];
  domain: MemoryDomainKind;
  mode: "single_domain" | "cross_domain";
  recalledAt: string;
}

// 记忆召回条目
export interface MemoryRecallItem {
  content: string;
  domain: MemoryDomainKind;
  source?: string;
  importance?: "critical" | "high" | "medium" | "low";
  /** 隐私分级，缺省 "public"。recall 默认剔除 restricted。 */
  sensitivity?: MemorySensitivity;
  score?: number;                // 相关度评分 0-1
  timestamp?: string;
  /**
   * 多模态记忆扩展（可选）。
   * 携带此字段时，content 是文字描述，mediaRef 指向已存储的媒体文件。
   * 召回后由 prompt 注入层补 `[图片：${caption}]` 占位符（阶段1不直接把图喂给 LLM）。
   * 缺省时为纯文本召回（向后兼容）。
   */
  modality?: "text" | "image" | "audio" | "video";
  mediaRef?: {
    storageId: string;
    kind: "image" | "audio" | "video";
    mime: string;
    caption?: string;
  };
  /**
   * 元记忆扩展（Phase 0）：来源链路。
   * 仅在 recallWithProvenance 路径下填充，普通 recall 不填。
   */
  provenance?: MemoryProvenance;
  /**
   * 元记忆扩展（Phase 0）：置信分层。
   * 规则计算：verified → known；pending → uncertain；accessCount<3 → unknown。
   */
  confidenceTier?: ConfidenceTier;
  /**
   * 显著性扩展（Phase 0）：显著性分数 0-1。
   * 仅在 salience filter 路径下填充。
   */
  salienceScore?: number;
}

// 记忆固化统计
export interface MemoryConsolidationStats {
  actorIds: string[];
  dailyCleanupCount: number;
  weeklyMergedCount: number;
  monthlyAbstractedCount: number;
  consistencyFlagCount: number;
  knowledgePromotedCount: number;
  compressionRate: number;
  estimatedRecallPrecision: number;
  plannedActions: number;
  executedActions: number;
  consolidatedAt: string;
}

// ---------- 3. 突触通信类型（SynapseBus 用） ----------

// 突触路由（跨分区/跨 Agent 通信的投递路径）
export type SynapseRoute =
  | "internal"       // 进程内（HookBus）
  | "inter_agent"    // 跨 Agent（AIP）
  | "to_user"        // 推送给用户（WS）
  | "offline";       // 离线存储（MessageHub）

// 突触消息（统一信封）
export interface SynapseMessage {
  id: string;
  type: string;                   // 事件类型，如 "sensory.listen"
  route: SynapseRoute;
  from: string;                   // 发送方分区/agent id
  to?: string;                    // 接收方（agent id / actorId，广播时为空）
  data: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  timestamp: string;
}

// 突触投递回执
export interface SynapseEnvelope {
  message: SynapseMessage;
  delivered: boolean;
  deliveredAt?: string;
  error?: string;
}

// ---------- 4. 边缘系统类型（LimbicCortex 用） ----------

// 安全检查严重程度
export type SafetySeverity = "allowed" | "high_risk" | "denied";

// 安全检查结果（Brain 视角）
export interface SafetyCheckResult {
  allowed: boolean;
  severity: SafetySeverity;
  reason: string;
  tool?: string;
  args?: Record<string, unknown>;
  checkedAt: string;
}

// 情绪向量（VAD 模型 + 标签）
export interface EmotionVector {
  actorId: string;
  valence: number;       // -1（极负）到 1（极正）
  arousal: number;       // 0（平静）到 1（极度兴奋）
  dominance: number;     // 0（受支配）到 1（支配）
  label: string;         // 文字标签，如 "焦虑" / "放松" / "愤怒"
  confidence?: number;
  detectedAt: string;
  /** 情绪原因（Phase 2.1 扩展，可选） */
  cause?: string;
  /** 情绪强度 0-1（Phase 2.1 扩展，由 arousal + |valence| 计算） */
  intensity?: number;
  /** 次要情绪标签（Phase 2.1 扩展，可选） */
  secondaryLabel?: string;
}

// 语气策略应用结果
export interface TonePolicyResult {
  rewrittenText: string;
  toneProfile: string;   // 如 "gentle" / "funny" / "cool" / "sad"
  adjusted: boolean;     // 是否真的改写了
  reason?: string;
}

// ---------- 5. 规划类型（PlannerCortex 用） ----------

// 规划步骤
export interface PlanStep {
  id: string;
  title: string;
  description: string;
  expectedTools?: string[];        // 预期使用的工具
  dependencies?: string[];         // 依赖的前置 step id
  status: "pending" | "in_progress" | "completed" | "failed" | "skipped" | "blocked";
  estimatedDurationMs?: number;
  /** 执行后工具产出的观察结果摘要（由 toolExecutor fallback 写入） */
  observation?: string;
}

// 规划结果
export interface PlanResult {
  goal: string;
  steps: PlanStep[];
  createdAt: string;
  rationale?: string;
}

// ReAct 观察
export interface ReActObservation {
  stepId?: string;
  observation: string;
  success: boolean;
  errorMessage?: string;
  nextAction: "continue" | "retry" | "abort" | "wait_approval";
  observedAt: string;
}

// 双模式路由：Fast 前台秒回 + Complex 后台并行
export type SystemRouteMode =
  | "direct"     // 快速模式：垫词 + 简单任务 + 轻工具，极快返回
  | "tool_loop"; // 复杂模式：后台委派子 Agent / 复杂工具链 / 多步计划，完成后分步推送

// 快慢双系统路由决策
export interface SystemRouteDecision {
  userMessage: string;
  system: "system1" | "system2";
  mode: SystemRouteMode;
  rationale: string;
  decidedAt: string;
}

// ============================================================
// 端到端认知类型（BrainCenter.cognize 用）
// ============================================================

// 端到端认知输入：感知来源（文本/语音/视觉/主动信号）
export interface CognitiveInput {
  actorId: string;
  text?: string;               // 用户文本消息
  audio?: AudioBufferRef;     // 语音输入（转写后填 text）
  visual?: VisualInput;       // 视觉输入
  signal?: BrainSignalInput;  // 主动信号（被动认知时为空）
  sessionId?: string;
  /**
   * 本轮语义理解标记的异步载体（2026-10-10 词表判定退役）：agent-core 传入
   * L1 路由决策的 understanding Promise——cognize 与路由并行启动，不阻塞；
   * recall-gate 的触发判定在记忆阶段消费前才 await。路由失败时 Promise 返回
   * undefined → 门控按「不触发」（最小注入）执行。
   */
  understandingPromise?: Promise<
    import("../agent/task-router.js").TurnUnderstanding | undefined
  >;
}

// 端到端认知上下文：各脑区并行收集的感知/记忆/情绪/活动/能力，一次性交给 CognitiveEngine
export interface CognitiveContext {
  memories: MemoryRecallItem[];            // 召回记忆（MemoryCortex）
  emotion: EmotionVector | null;            // 情绪状态（LimbicCortex）
  userActivity: UserActivityState | null;   // 用户活动状态（AwarenessCortex）
  capabilities: CapabilityDescriptor[];    // 当前能力（CapabilityCortex）
  recentDecisions: BrainDecision[];        // 最近主动决策（ProactionCortex）
  audioText?: string;                       // 语音转写结果（SensoryCortex）
  visualDescription?: string;               // 视觉描述（SensoryCortex）
  sensoryFrame?: SensoryFrame;              // 多模态融合帧（SensoryCortex.buildSensoryFrame 产出）
  /**
   * 最近对话历史（最近 3 轮，6 条消息）。
   * 从 thread store 拉取，注入到 cognize prompt 让 LLM 能理解追问上下文。
   * 例：用户追问"kimi的新模型啊"时，cognize 需要知道上一轮刚聊过 Kimi K3。
   * 格式：`用户：xxx\nAgent：xxx\n用户：yyy\nAgent：yyy`
   */
  recentConversationHistory?: string;
  // ---- Step 7 扩展：新皮层模块上下文（由 DecisionHub.gatherContext 拉取）----
  /** 工作记忆快照（前额叶） */
  workingMemory?: import("./working-memory-cortex.js").WorkingMemorySnapshot;
  /** 当前任务上下文（任务切换皮层） */
  currentTask?: import("./task-switching-cortex.js").TaskContext | null;
  /** 多源情境融合结果（情境皮层） */
  situation?: import("./context-cortex.js").SituatedContext;
  /** 意图预判结果（AnticipationEngine） */
  anticipatedIntent?: { intent: string; confidence: number; preparationHints?: string[] } | null;
  /** 用户画像（在线学习皮层） */
  userPattern?: import("./online-learning-cortex.js").UserProfile;
  /**
   * 身体状态聚合（来自 BodyGateway）。
   *
   * cognize 阶段 1 并行调 bodyGateway.sense({ kind: "where_am_i" }) 拉取，
   * 让认知 LLM 能感知"我在哪个设备上/电量多少/是否在渲染具身"等物理上下文。
   * bodyGateway 未注入时为 undefined（纯脑模式，向后兼容）。
   */
  bodyState?: BodyState;
}

// 端到端认知结果：一次 LLM 产出的完整认知输出
export interface CognitiveResult {
  actorId: string;
  route: SystemRouteDecision;              // 路由决策（快/慢系统）
  response: string;                         // 主响应话术（fast/direct 时为最终，plan 时为初步）
  emotion: EmotionVector | null;           // 识别的情绪
  memoryWrites: MemoryItem[];              // 待写入记忆
  action?: { tool: string; args: Record<string, unknown> }; // 待执行动作（可选）
  safety: SafetyCheckResult;                // 安全检查
  needsToolLoop: boolean;                   // 是否需要进工具循环
  rationale: string;
  cognizedAt: string;
  /**
   * 阶段 1 已召回的记忆条目（limit=5）。
   * 携带此字段供后续 standard path 复用，避免同一轮用户消息重复执行 MemoryCortex.recall。
   * 缺失或为空时（如 memory 未注册 / 召回失败），后续 standard path 仍走原 prepareNarrativeRecall 逻辑。
   */
  recallItems?: MemoryRecallItem[];
  /**
   * 长期记忆召回门控结果（门控单点化）：cognize 阶段 0.93 用完整输入评估的
   * recall-gate 白名单判定。agent-core / prompt 装配层直接复用本判定，
   * 不再各自重评（三处独立评估正则易漂移）。缺失时消费方自行降级评估。
   */
  recallGate?: { trigger: boolean; reason: string };
  /**
   * 工作记忆摘要（深度链接优化）：含活跃目标 + 槽位 + 待办。
   * 由 BrainCenter.cognize 阶段 3 生成，注入到 streamCompletion 的 system prompt，
   * 让主 Agent LLM 真正感知"当前对话上下文"。
   * 空字符串表示工作记忆为空或未注册。
   */
  workingMemorySummary?: string;
  /**
   * 最近对话历史（最近 6 轮，12 条消息）。
   * 从 thread store 拉取，注入到 streamCompletion 的 system prompt【最近对话】块，
   * 让主 Agent LLM 能理解追问上下文与指代消解。
   * 空字符串表示无历史或拉取失败。
   */
  recentConversationHistory?: string;
  /**
   * 工具规划链（cognize 阶段 2 由 DecisionHub 或 ToolPlanningCortex 生成）。
   * complex 路由时由 ToolPlanningCortex.planTools 产出，注入到 streamCompletion 的
   * system prompt【建议工具链】块，约束 LLM 工具选择顺序和范围。
   * 缺失时（fast 路由 / 工具规划皮层未注册）跳过注入。
   */
  toolPlan?: import("./tool-planning-cortex.js").ToolPlan;
}

/**
 * 端到端认知引擎：像真人一样一气呵成完成"理解+决策+响应"。
 *
 * 设计理念（整体端到端调度）：
 *  - 感知/记忆/情绪/活动状态作为上下文一次性注入，不是切片式各自调 LLM；
 *  - 一次 LLM 调用产出 {路由, 响应, 记忆写入, 动作, 是否需要工具循环}；
 *  - 工具循环（openai-compatible-tool-loop）是执行层迭代，保留——人用工具也是迭代的；
 *  - 真正端到端的是"认知决策"：路由+召回+情绪+响应策略合并为一次认知。
 */
export interface CognitiveEngine {
  cognize(
    input: CognitiveInput,
    context: CognitiveContext,
  ): Promise<{
    route: SystemRouteDecision;
    response: string;
    memoryWrites: MemoryItem[];
    action?: { tool: string; args: Record<string, unknown> };
    needsToolLoop: boolean;
    rationale: string;
    /**
     * 认知置信度（0-1）：由 cognize LLM 基于对话内容语义评判，而非规则正则。
     * - 寒暄/简单问答 → 0.9+（信息充足，直接答）
     * - 知识问答且 LLM 知识充足 → 0.7-0.9
     * - 需要工具但信息完整 → 0.5-0.7
     * - 信息不足/能力缺失/需外部数据但无能力 → <0.4（低置信，该委派子 Agent）
     * 阶段 2.5 据此决定是否把 master_only 升级到 master_delegate。
     * 缺省时由 AwarenessCortex.assessConfidence 规则兜底（仅 cognize 失败降级场景）。
     */
    confidence?: number;
    confidenceReason?: string;
  }>;
}

// ============================================================
// subcortical 分区类型(BrainStem 脑干 / Cerebellum 小脑)
// ============================================================

/**
 * 小脑 defer 队列项:暂存待复查的主动决策。
 * 当 ProactionCortex 决策 speak 但用户当前 busy/sleeping 时,
 * 由 Cerebellum 暂存,定时复查用户状态,状态变好后重新触发执行。
 */
export interface PendingDecision {
  actorId: string;
  decision: BrainDecision;
  signal: BrainSignalInput;
  /** 状态变好后调用的执行回调(指向 executeProactiveDecision) */
  fire: () => Promise<void>;
  enqueuedAt: number;
  /** 超时时间戳(ms),超时未触发则降级 silent */
  expiresAt: number;
}

// ============================================================
// 记忆认知架构升级扩展类型（Phase 0）
// ============================================================

/** 记忆来源链路（元记忆用） */
export interface MemoryProvenance {
  /** 原始来源标识：chat / tool / digest / world / system */
  source: string;
  /** 来源类型 */
  sourceType: "chat" | "tool" | "digest" | "world" | "system";
  /** 捕获时间 ISO */
  capturedAt: string;
  /** 来源链路（版本追溯） */
  sourceChain?: {
    versionId: string;
    sourceNodeIds: string[];
    sourceSummary: string;
  }[];
}

/** 置信分层（元记忆用，程序化计算，不让 LLM 表演） */
export type ConfidenceTier = "known" | "uncertain" | "unknown";

/** 重构校验结果 */
export interface ReconstructionValidation {
  /** 字段保留率 0-1 */
  accuracy: number;
  /** 缺失的关键信息列表 */
  lostInfo: string[];
  /** 语义偏移 0-1（embedding cosine 距离） */
  distortion: number;
  /** 是否通过校验（accuracy >= 0.7 且 distortion < 0.3） */
  isValid: boolean;
  /** 校验时间 */
  validatedAt: string;
}

/** 扩散激活结果 */
export interface SpreadingActivationResult {
  /** 种子节点 id 列表 */
  seedNodeIds: string[];
  /** 被激活的节点列表（含激活值） */
  activatedNodes: Array<{
    nodeId: string;
    activationValue: number;
    hopCount: number;
  }>;
  /** 扩散深度 */
  maxHopsReached: number;
  /** 扩散时间 */
  spreadAt: string;
}

/** 联想预判结果 */
export interface PredictedAssociation {
  /** 种子节点 */
  seedNodes: string[];
  /** 被激活的节点 */
  activatedNodes: string[];
  /** 预判结果（由激活节点 summary 聚合，非 LLM 生成） */
  predictedOutcome: string;
  /** 预判置信度 0-1 */
  confidence: number;
  /** 预判时间 */
  predictedAt: string;
}

/** 图式节点（语义抽象形成） */
export interface SchemaNode {
  /** 图式 id */
  id: string;
  /** 图式名称，如 "餐厅图式" */
  name: string;
  /** 步骤序列，如 ["进门", "点餐", "吃", "结账"] */
  steps: string[];
  /** 前置条件 */
  preconditions: string[];
  /** 预期结果 */
  expectedOutcomes: string[];
  /** 实例节点 id 列表（来源 episodic 节点） */
  instances: string[];
  /** 刻板印象警告次数（>3 时附加警告） */
  stereotypeWarningCount: number;
  /** 所属 sceneTag */
  sceneTag: string;
  /** 创建时间 */
  createdAt: string;
  /** 最后更新时间 */
  updatedAt: string;
}

/** 图式匹配结果 */
export interface SchemaMatchResult {
  /** 匹配的图式 */
  schema: SchemaNode;
  /** 匹配分数 0-1 */
  matchScore: number;
  /** 是否附加刻板印象警告 */
  hasStereotypeWarning: boolean;
  /** 匹配时间 */
  matchedAt: string;
}

/** 显著性过滤决策 */
export interface SalienceDecision {
  /** 是否接受写入 */
  accept: boolean;
  /** 显著性分数 0-1 */
  score: number;
  /** 决策原因 */
  reason: string;
  /** 是否降级为 decay（短期保留） */
  degraded: boolean;
}

// ============================================================
// MemoryInferenceEngine 推理引擎类型
// ============================================================

/** 线索来源类型 */
export type InferenceClueSource = "user_input" | "perception" | "memory_recalled";

/** 线索（推理引擎输入） */
export interface InferenceClue {
  /** 线索文本 */
  text: string;
  /** 来源：用户输入 / 感知 / 召回的记忆 */
  source: InferenceClueSource;
  /** 权重（缺省：显性 1.0，隐性 0.6） */
  weight?: number;
  /** 检测时间 */
  detectedAt?: string;
}

/** 推理结论（输出，新节点） */
export interface InferenceNode {
  /** 节点 id：inf_<fnv1a hash> */
  id: string;
  /** 推理出的结论文本 */
  conclusion: string;
  /** 置信度 0-1 */
  confidence: number;
  /** 证据 */
  evidence: {
    /** 触发线索文本 */
    clues: string[];
    /** 应用的规则 id */
    rules: string[];
    /** 推理链（人类可读） */
    reasoningChain: string[];
  };
  /** 是否已被验证 */
  isVerified: boolean;
  /** 创建时间 */
  createdAt: string;
}

/** 推理结果 */
export interface InferenceResult {
  /** 推理出的结论列表 */
  inferences: InferenceNode[];
  /** 综合置信度 */
  combinedConfidence: number;
  /** 推理时间 */
  inferredAt: string;
}
