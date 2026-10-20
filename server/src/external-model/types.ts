/**
 * 外部对话模型接入层：与具体厂商（Moonshot、OpenAI 等）解耦，由适配器实现统一契约。
 */

import type { ChatCompletionTool } from "openai/resources/chat/completions";

export type StreamDeltaHandler = (delta: string) => void;

/** 视觉帧来源：设备摄像头、外部视频流、Agent 侧附件（预留，便于后续自接入摄像头）。 */
export type VisionSourceKind =
  | "device_camera"
  | "external_stream"
  | "agent_attachment"
  | "desktop_screen";

/** 已通过 MIME 裁定的单帧图像（Base64 无 `data:` 前缀）。 */
export type VisionFrame = {
  sourceKind: VisionSourceKind;
  /** 稳定源 id，如 `default-front`、`usb-0`；可选 */
  sourceId?: string;
  mimeType: string;
  dataBase64: string;
  /** 客户端采集时间 ISO8601，可选 */
  capturedAt?: string;
};

/** 单轮用户输入：主文本 + 可选视觉（送入支持视觉的 Chat 模型）。 */
export type ChatUserTurn = {
  text: string;
  visionFrames?: VisionFrame[];
  /**
   * 客户端为该 user 消息生成的稳定 id（与 WebSocket `chat.user_message.messageId` 一致）。
   * Provider 会把它登记到 ChatThreadStore 的反向索引，供后续「编辑/删除/替换并重发」使用。
   * 未传或为空时按「无 id」处理，相关操作将无法按 id 命中。
   */
  clientMessageId?: string;
};

/**
 * 注入外部模型 system 的 UAP 记忆片段（SOUL / USER / MEMORY 分层）。
 * `values` / `abilities` 对应长期演化中的慢变量：价值观与能力倾向（见 ARCHITECTURE 长期演化节）。
 */
export type AgentPromptMemoryContext = {
  persona?: string;
  /**
   * 结构化人格内核（personality 域）的可读文本，注入 system prompt 稳定前缀。
   * 由 PromptContextBuilder 从 MemoryCortex.getPersonalityCore 拉取并格式化，
   * 防止单次对话导致人格漂移。
   */
  personalityCore?: string;
  values?: string;
  abilities?: string;
  /** 宿主 Agent 内置能力说明（钱包、日程、虚拟电话、子 Agent 委派等，非 UAP KV） */
  agentCaps?: string;
  /** Agent World 环境说明：注册、世界点数、自由市场、Agent 间对局等（非 UAP KV） */
  worldCaps?: string;
  /** BM25+Qdrant+RRF 融合后的履历/叙事摘录，供本轮推理引用 */
  narrativeRecall?: string;
  /**
   * 用户理解档案块（agent 对用户理解的结构化沉淀：topic + 理解句 + 性质标注
   * + 演变历史）。被问及用户相关话题时以此为准，按性质回应（玩笑/粉丝式
   * 称呼不当真实事实转述）。
   */
  userUnderstanding?: string;
  /**
   * 结构化事实块（用户档案字段的确定性记录：称呼/职业/居住地/技术栈…）。
   * KV 式精确记录，确定性高于语义检索来源；同字段新值实时覆盖旧值。
   */
  userFacts?: string;
  /**
   * 用户关系一览块（2026-10-20 生活模型）：用户生活中人物/宠物的结构化一览
   * （「妹妹·小满；好友·老王」）。供理解人物关系与自然称呼，确定性高于语义检索；
   * 仅作背景，不暴露记忆系统存在。
   */
  lifeRelations?: string;
  /**
   * 时间问句定位块（2026-10-19）：用户问「2024 年 6 月我住哪」这类带时间词的
   * 问题且命中档案字段时，程序化给出那个时间点有效的值（来自 valid_from/valid_to
   * 区间查询）。确定性答案，不靠语义召回猜。
   */
  temporalAddressing?: string;
  /**
   * 本轮寻址块（2026-09-29 P0-1 缓存优化）：用户最新消息命中的理解话题/事实
   * 字段清单。理解档案/事实块本体进稳定层时不再带逐条寻址标记（那会让稳定层
   * 逐轮变字节，打断 DeepSeek 前缀缓存——实测改一行命中 98%→27%），命中信息
   * 改由本块沉底注入动态层，功能等价（"我老婆是谁"仍直达对应条目）。
   */
  turnAddressing?: string;
  memorySummary?: string;
  memoryPreferences?: string;
  memoryFacts?: string;
  memoryCommitments?: string;
  memoryOpenLoops?: string;
  sessionRecap?: string;
  /** 用户打断的回复上下文，用于整合到下一次回复中 */
  interruptedContext?: string;
  /** 用户当前所在地（前端 GPS + 逆地理，注入 system，供位置相关问答使用） */
  userLocation?: string;
  /** 用户常去地点（位置历史 DBSCAN 聚类，程序化注入，零 LLM） */
  frequentPlaces?: string;
  /**
   * 当下状态（WorldBoard.current 程序化整理，零 LLM）：屏幕焦点/在线状态 +
   * 持续时长 + 顺嘴纪律锚点。让顺嘴/关心贴着「此刻」说，不再拿旧记忆套模板。
   * 陈旧信号（>10min）不注入。
   */
  currentUserState?: string;
  /**
   * 顺嘴机会（主动性搭车通道，每轮至多一条）：挂起的 low 主动意图织入
   * 回复末尾的括号旁注。块内自带织入形态指令；与话题不搭时模型可不提。
   */
  turnAside?: string;
  /** Per-turn task profile and operating policy injected into the system prompt. */
  taskContext?: string;
  /** `USER_PROFILE.md` 摘录：长期用户画像 */
  userProfile?: string;
  /** 本轮语气与情绪适配指引（幽默/正式/温馨、安抚等） */
  toneGuidance?: string;
  relationshipGuidance?: string;
  /** 当日滚动摘要（跨 session 同日上下文，短期工作记忆 L1） */
  dailyDigest?: string;
  /** 后台记忆管理服务自动合成的用户长期画像（偏好/话题/意图/风险标记） */
  userProfileSummary?: string;
  /** 冷启动引导（P2）：画像还是模板且会话首轮时的一条自然破冰提示（动态层） */
  onboardingHint?: string;
  /**
   * 记忆目录（元认知）：MemoryInventory 统计的记忆规模/时间分布/高频主题摘要。
   * 让 LLM "知道自己记住了什么"，用户问"你知道我什么"时有真实依据可答。
   * 由 PromptContextBuilder 同步读 MemoryInventory 缓存注入（cognize 阶段刷新）。
   */
  memoryInventory?: string;
  memoryContinuity?: string;
  relationshipMemory?: string;
  lifeThemeMemory?: string;
  dreamMemory?: string;
  /**
   * 主动跨天 recall：用「昨天的 userText」作为 query 跑一次 narrative recall，
   * 让 LLM 即使当前话题与昨天无关也能看到昨天的关键事件。
   * 解决「前天说后天要去玩，今天提及时 agent 能关联记忆」的连续性问题。
   */
  yesterdayHighlight?: string;
  /** 短句追问时锚定上一轮对话，避免跨话题串台 */
  followUpAnchor?: string;
  /** 服务端 ScheduleTaskService 实时日程快照（每轮刷新） */
  scheduleSnapshot?: string;
  /**
   * 在办目标摘要（2026-10-19 三层尺度架构）：GoalBoard 活跃目标的前 3 条，
   * 一行一个（标题 · 进度 · 下一步是否等确认）。让对话面知道「我正在替用户
   * 办这件事」——用户问「那事怎么样了」时不必靠记忆模糊召回。
   * 一天只变几次（进度随步骤推进），只进动态层，绝不进稳定层。
   */
  activeGoals?: string;
  /**
   * 会话级任务步骤（TaskPlanStore）：本轮有 plan 才有，携带完整步骤表。
   * 与 activeGoals 互补——goal 是跨会话意图，plan 是本会话的执行路径；
   * 完成即归档，通常只在几轮内存在。
   */
  taskPlan?: string;
  /**
   * 行程状态热层快照（travel-prompt-snapshot）：已生成行程的一行回执列表
   * （目的地/日期/planId），仅用户消息命中行程语义时注入。完整明细不进上下文，
   * 由 travel.get-itinerary 按需回查。
   */
  travelState?: string;
  /**
   * 扣子式前置检索证据（2026-09-13）：realtime_lookup 轮由程序先执行
   * search_web，把真实返回注入此块；模型必须基于证据作答，不再自行决定
   * 是否搜索。由 agent-core 前置检索写入（构建晚于 PromptContextBuilder）。
   */
  webEvidence?: string;
  /**
   * 当前精确时间（年/月/日/时/分/秒 + 星期 + 时区），每轮注入。
   * 与对话历史中每条消息的 `[ts:...]` 前缀对应，供 LLM 做时间维度计算与对齐。
   */
  currentTime?: string;
  /**
   * 运行环境块（2026-10-07）：用户此刻从手机 App 还是电脑桌面端发消息。
   * WS 连接自报 platform → agent-core → prompt-context-builder；缺省不注入。
   */
  deviceEnvironment?: string;
  /**
   * 当前情绪状态摘要：LimbicCortex/EmotionModulator 的 VAD 值可读化输出。
   * 让 LLM 知道自己当前的情绪（如低落、兴奋、关注），影响回复语气。
   * 由 agent-core 从 brainCenter.limbicCortex.getEmotion() 拉取并格式化注入。
   */
  emotionState?: string;
  /**
   * 工具规划链（来自 ToolPlanningCortex），约束 LLM 工具选择顺序和范围。
   * complex 路由时注入，建议 LLM 按规划顺序调用工具，避免乱试或遗漏关键工具。
   */
  toolPlan?: string;
  /**
   * 可复用技能轻量索引（Level 0 渐进式召回）。
   *
   * 只含 name + description + skillType + tags 的紧凑列表（不含 doc 全文），
   * 让 LLM 感知"我有这些沉淀的技能"，需要时再用 skill.view 工具加载全文（Level 1）。
   * 由 PromptContextBuilder 从 SkillManager.list() 提取并压缩注入。
   */
  skillIndex?: string;
  /**
   * 当前工作记忆摘要（活跃目标 / 已知槽位 / 待办），来自 WorkingMemoryCortex.toSummary。
   * 作为独立块注入 system prompt（不再拼入 narrativeRecall），避免被 formatNarrativeRecallPrompt
   * 的 slice(0,4) 截断或块结构被拍平。解决"上下文跳转、不能针对当前话回复"的连续性问题。
   */
  workingMemorySummary?: string;
  /**
   * 最近对话回顾（thread 较短时注入，用于指代消解与话题衔接）。
   * 仅在 thread 消息 < 12 条时填充（与消息数组重复时跳过），块内含"非用户最新指令"提示。
   * 作为独立块注入，避免被 formatNarrativeRecallPrompt 当作召回条目丢弃。
   */
  recentConversationHistory?: string;
  /**
   * 当日对话日志检索命中（DailyJournalService.searchToday 结果）。
   * 短期记忆：当天对话由 md 文件承载，注入 prompt 供 agent 读取当前对话历史；
   * 过往日期已固化进长期记忆图，不再走本条文件检索（跨天由图谱/KV 召回兜底）。
   */
  journalRecall?: string;
  /**
   * 语义意图理解结果：LLM 对用户本轮句子的真实意图解析。
   * 作为独立块注入，让主 LLM 明确知道"用户想做什么"，避免答非所问。
   */
  semanticIntent?: string;
  /**
   * 用户兴趣关注列表（InterestWatcher 接线）：agent 在 system 中看到用户
   * 长期关注的人/事/物（【用户兴趣关注列表】块），话题接得住，且提示用
   * interest.manage 工具维护。无列表时不注入（零开销）。
   */
  interestList?: string;
  /**
   * 未兑现承诺摘要（P2-11 承诺草稿板接线）：active/pending_confirmation 的
   * 承诺注入【未兑现承诺】块——用户问"我这周要干嘛/有什么没办"时 agent
   * 直接可见，无需工具回查。无未兑现承诺时不注入（零开销）。
   */
  /**
   * 对话时间线事实（ConversationTimelineService）：首次对话时间 / 累计轮次 /
   * 最近一次对话时间。回答「第一次对话是什么时候 / 认识多久 / 上次聊什么」时
   * LLM 有确定信息可用。无记录时不注入（零开销）。
   */
  conversationTimeline?: string;
  modeRoleGuidance?: string;
  /**
   * 回复风格模式（2026-09-06）：chat/task 车道标记，供审计与车道相关逻辑使用。
   * 2026-09-22 人格·终极版重塑后，风格由 personaStatic（稳定层）/ personaMood
   * （动态层）承担，本字段不再控制任何块注入。
   */
  replyStyleMode?: "chat" | "task";
  /**
   * 人格·终极版·静态块（2026-09-22，agent/persona-core 产出）：身份/关系档位/
   * 反谄媚/情绪诚实/硬边界/简短。常驻 system 稳定层。
   */
  personaStatic?: string;
  /**
   * 人格·终极版·动态块：每轮按 resolvePersonaMood 只注入一个 mood 段
   * （base/casual_wit/roasting/playful/empathy/serious）。沉到动态层。
   */
  personaMood?: string;
  /**
   * 【语感基准】few-shot 块（2026-10-06 活人感治理）：真实口吻对话对照 +
   * 助手腔反例，对抗主模型的中性助手腔训练分布。按 sessionId 轮换、
   * 会话内字节稳定（稳定层 MEMORY 带注入，见 chat-voice-baseline.ts）。
   */
  voiceBaseline?: string;
};

/** 工具环单轮内所有 tool 消息已写入 `messages` 之后触发（可观测 / 评估 / 审计）。 */
export type ToolLoopAfterBatchInfo = {
  roundIndex: number;
  assistantText: string;
  toolResults: Array<{ name: string; ok: boolean }>;
};

export type ToolExposureProfile =
  | "none"
  | "light"
  | "contextual"
  | "full"
  | "delegate"
  | "scoped"
  // 显式白名单（2026-09-05 前后台架构）：chatToolsBuiltin 即最终可见工具集，
  // 不做任何筛选/合并；chatToolsExtra 仅进 searchableTools 延迟目录语料，供
  // tool_discover 按需召回。前台（dispatch+快查）与任务面（plan 产出工具）
  // 都走该 profile——「先 plan，再一次性注入计划工具」的唯一注入通道。
  | "explicit";

export type ToolRankingHint = {
  preferredNamespaces?: string[];
  cautiousNamespaces?: string[];
};

/** {@link ExternalChatProvider.streamCompletion} 可选行为。 */
export type AgentStreamOptions = {
  promptContext?: { memory?: AgentPromptMemoryContext };
  toolLoop?: {
    /** 规划波次上限（plan + replan 总次数，Plan-and-Execute）；fast 场景建议 1 */
    maxRounds?: number;
    onAfterToolBatch?: (info: ToolLoopAfterBatchInfo) => void;
  };
  /** 单轮快路径：不写入 provider 会话 thread（避免历史越积越慢） */
  ephemeralTurn?: boolean;
  /**
   * Token 审计 stage 覆盖（B1 度量，2026-09-08）：任务面传入 task_plane_fast /
   * task_plane_complex；缺省时 provider 按分支落 main_chat（非工具）/ main_chat_tools（工具循环）。
   */
  auditStage?: string;
  /**
   * 会话级任务计划的主键（2026-10-19）。
   *
   * 工具层用 `ToolContext.sessionId` 写计划，而工具循环内只能拿到 provider 的
   * sessionId（对话面 = actorId）——两者不一定相等。plan.* 的软提示判重、等待步
   * 工具面收缩、执行守卫都靠这个键查计划，所以由 agent-core 显式下发，不在
   * 工具循环里猜。
   */
  planSessionKey?: string;
  /** 替换默认 system（跳过 UAP 记忆拼装，用于低延迟场景） */
  systemPromptOverride?: string;
  /** 覆盖默认 chat 模型（如专用快模型） */
  modelOverride?: string;
  /** 限制 provider thread 保留的消息条数（不含 system）；建议 8–12 */
  maxThreadMessages?: number;
  /** Kimi k2.5+：关闭 thinking，降低 tool 落子延迟 */
  disableThinking?: boolean;
  /** 按会话已购技能合并进 LLM tools（内置 Skill + 已拥有社区 Skill） */
  chatToolsBuiltin?: ChatCompletionTool[];
  /** 替换默认内置工具列表（子 Agent 按能力过滤时使用） */
  chatToolsExtra?: ChatCompletionTool[];
  /** 主 Agent 通过 function calling 委派子 Agent（追加调度说明 + master_invoke_sub_agent 工具） */
  masterSubAgentDelegate?: boolean;
  /** 已废弃：沙箱模式已移除，Agent 始终以 full 运行；字段保留仅为协议兼容 */
  agentAccessMode?: "sandbox" | "full";
  /** 电脑桥接在线时向 LLM 暴露 desktop.visual.*（手机↔PC，可不依赖完全访问） */
  desktopBridgeOnline?: boolean;
  /** 手机桥接在线时向 LLM 暴露 phone.*（远程控制真实手机，可不依赖完全访问） */
  phoneBridgeOnline?: boolean;
  toolExposureProfile?: ToolExposureProfile;
  /**
   * 任务面能力束（2026-09-05，来自路由层 TurnPlan.capabilities）。
   * delegate profile 下按它裁剪注入的工具：search/media 等轻任务只注入对应工具族，
   * 其余工具进 BM25 延迟目录按需召回；含 "full" 或未传时不裁剪（全量注入）。
   */
  toolCapabilities?: string[];
  /**
   * 路由意图标签（2026-09-19）：路由层对本轮消息的语义判定（如 action_write /
   * realtime_lookup / multi_step_task）。工具循环的单一出口检查用它确定性判定
   * "路由声明需要动手、模型却零工具尝试"的续波——不用文本风格正则。
   */
  turnIntent?: string;
  /**
   * 确定性媒体预执行调用（2026-10-10）：media_retrieval 轮由代码在工具循环
   * 开场先真搜一次（查询词来自路由层 composeMediaSearchQuery），模型只叙述。
   * provider 必须把本字段透传进 streamCompletionWithTools——白名单漏掉它
   * 会导致预执行静默失效、退回「出口闸拉回补搜」的事后补丁路径。
   */
  deterministicToolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
  /**
   * 答案留存（2026-10-13 根修：工具轮的答案不进流式通道）。
   *
   * "after_tool_use"：本轮执行过实质工具后，答案正文不再经流式通道直推，
   * 随返回值交 done 与卡片同帧下发（对话面卡片轮跳变的通道级根除）。
   * "always"：从第一波就留存——前置检索证据轮（检索发生在循环外）同样
   * 基于检索事实作答、同样配搜索卡，通道契约与工具轮一致。
   * 仅对话面主链路置位（语音轮豁免：TTS 消费流式分句）；任务面/子 Agent
   * 等既有流式消费方不置位，行为不变。provider 必须透传进
   * streamCompletionWithTools（漏传 = 留存静默失效）。
   */
  holdAnswer?: "after_tool_use" | "always";
  /**
   * chat 车道主生成采样放开（2026-10-06 语感治理 A）：true 时 provider 对该轮
   * 主生成下发 temperature/frequency_penalty（CHAT_TEMPERATURE / CHAT_FREQUENCY_PENALTY
   * 可覆盖）。仅 agent-core 的 chat 车道主链路置位；任务面、ephemeral 内部调用
   * （识情/路由/收尾汇总）一律不置位，保持默认采样。
   */
  chatLaneSampling?: boolean;
  /**
   * 纯闲聊轮硬隔离（2026-10-06 语感治理追加）：agent-core chat 车道且路由判定
   * 本轮为纯闲聊（routeIntent==="chat"）时置位。置位后 agent-core 不向本轮注入
   * 任何工具（toolExposureProfile "none"），provider 同时裁掉展示形式协议
   * （RENDER_HINT/卡片/NEXT_UP 接续建议）——闲聊轮模型看不见工具就不会推销
   * "要不要我帮你查/设/记"，看不见 NEXT_UP 协议就不会在聊天末尾挂任务胶囊。
   * 误判兜底：用户闲聊里冒出正事，下一轮路由重分类即恢复工具；2026-10-07 追加
   * 程序层安全网——消息带动作/查数据信号（turnNeedsToolFloor）时不置位本字段、
   * 不做零工具隔离，两处消费口径恒一致。
   */
  chatLanePureChat?: boolean;
  /**
   * 本轮是否已注入前置检索证据块（2026-09-23）：工具循环出口检查用于豁免
   * "realtime 意图 + 证据已在 prompt 里 + 模型零工具直答"的正确行为轮。
   */
  turnEvidenceInjected?: boolean;
  /** 路由置信度（透传 turn-trace 观测用，2026-09-23）。 */
  turnRouteConfidence?: number;
  toolRankingHint?: ToolRankingHint;
  /** 强制保留的工具名列表(绕过 contextual 筛选)。状态机模式用此字段确保白名单工具始终可见。 */
  pinnedToolNames?: string[];
  /**
   * 禁用 BM25 延迟工具目录（tool_discover→tool_call 两波召回）。
   * 轻量白名单链路（对话面 explicit 档等）必须置 true：maxRounds 小时
   * "发现→执行"两波必断头，延迟目录用不上。禁用后 visible 工具全量暴露，
   * 超出白名单能力的请求由服务端转任务面承担。
   */
  disableToolSearch?: boolean;
  /**
   * RuntimeKernel minimal 模式控制位：true 时 provider 跳过身份/风格/时间戳说明类后缀追加，
   * 但仍保留功能性后缀（工具说明/主 Agent 调度/用户可见进度/访问权限）。
   * 配合 RuntimeKernel.buildSessionSystem() 实现"层 A 不进 prompt"。
   */
  suppressRuntimeSuffixes?: boolean;
  /**
   * 功能性后缀开关（仅 suppressRuntimeSuffixes=true 时生效）：
   * - true/undefined（默认）：保留工具说明/主 Agent 调度/用户可见进度等功能性后缀
   * - false：极致节省模式，所有功能性后缀也剥离（不推荐生产）
   */
  functionalSuffixes?: boolean;
  /**
   * 中断信号：用户发新消息或取消时,调用方 abort 此 signal,
   * provider 底层 fetch/SDK 收到后真正中断 HTTP 流式请求(节省 tokens/算力)。
   * 未传时无法中断(向后兼容)。
   */
  signal?: AbortSignal;
  /**
   * 本次回复的输出 token 上限（对应 OpenAI 的 max_tokens）。
   * - fast 等对话模式建议 600-1000，防止回复失控拉长、控制输出成本
   * - 不传则不限制（默认行为，对齐 reasoner/工具链复杂输出）
   */
  maxOutputTokens?: number;
  /**
   * 结构化输出模式（2026-10-07 对齐主流网关）：透传为 OpenAI 兼容的
   * `response_format`。`json_object` 时厂商在解码层保证输出为合法 JSON——
   * 思考模型照常思考，最终 content 不再可能被思考挤占/污染（协议层契约，
   * 取代 prompt 祈祷式约定）。仅在对端点能力有把握的调用点置位
   * （provider-profiles.supportsJsonMode）；端点不支持时报错，调用方需有
   * 去掉该参数的重试通道。
   */
  responseFormat?: "json_object";
};

/** 工具开始执行前（用于 UI 展示模型填写的 userStatusLine 等） */
export type ToolExecuteStartInfo = {
  toolName: string;
  input: Record<string, unknown>;
  /** 模型在调用工具前输出的 assistant 文本（若有） */
  assistantPreamble?: string;
};

/** 工具执行完成后 */
export type ToolExecutedInfo = {
  toolName: string;
  input: Record<string, unknown>;
  ok: boolean;
  result: Record<string, unknown>;
};

/** 外部模型 function calling 与本地 ToolRegistry 之间的桥接。 */
export type ChatToolExecutionContext = {
  executeTool: (
    name: string,
    args: Record<string, unknown>,
    /**
     * 执行附加信息（可省略）。signal = 单次工具调用的取消信号：工具循环的
     * 超时竞速落定即 abort，子进程/HTTP 类 handler 可据此提前退出，
     * 不再"超时只是不等待、执行体继续占着真实设备"。
     */
    extras?: { signal?: AbortSignal },
  ) => Promise<{ ok: boolean; result: Record<string, unknown> }>;
  /** 查询工具缓存（命中则跳过 executeTool 的安全检查/BodyGateway 等中间层） */
  getCachedToolResult?: (
    name: string,
    args: Record<string, unknown>,
  ) => { ok: boolean; result: Record<string, unknown> } | null;
  /** 工具轮次中模型流式输出的口语化进度（不写入最终正文流） */
  onAgentStatusLine?: (line: string) => void;
  onToolExecuteStart?: (info: ToolExecuteStartInfo) => void;
  onToolExecuted?: (info: ToolExecutedInfo) => void;
};

/**
 * 工具调用协议族。
 *
 * 让上层调用方能根据协议族选择正确的适配器，而非假设全部走 OpenAI 格式。
 * - `openai`：OpenAI Chat Completions 的 tool_calls / tool_call_id 格式
 * - `anthropic`：Anthropic Messages API 的 tool_use / tool_result block 格式
 * - `gemini`：Gemini functionCall / functionResponse 格式
 * - `custom`：自研协议（如世界模型原生 function-calling）
 */
export type ToolCallingProtocol = "openai" | "anthropic" | "gemini" | "custom";

/**
 * Provider 能力声明。
 *
 * 让上层调用方在不试探的前提下知道 provider 支持哪些特性，
 * 用于"换大脑"时按能力路由（而非按模型名字符串）。
 */
export interface ProviderCapabilities {
  /** 工具调用协议族，缺省 "openai"（向后兼容） */
  toolCallingProtocol?: ToolCallingProtocol;
  /** 是否支持并行工具调用（parallel_tool_calls） */
  supportsParallelToolCalls?: boolean;
  /** 是否支持视觉输入（vision frames） */
  supportsVision?: boolean;
  /** 最大上下文窗口（token 数），缺省 0 表示未知 */
  maxContextTokens?: number;
  /** 是否支持 reasoning / thinking 字段（如 Kimi k2.5+ disableThinking） */
  supportsThinking?: boolean;
  /** 是否支持流式输出 */
  supportsStreaming?: boolean;
}

/**
 * 可插拔的外部聊天提供方（通常对应「云端 Chat Completions」类 API）。
 * - `isEnabled()` 为 false 时，编排层应走本地兜底逻辑，不得调用 `streamCompletion`。
 */
export interface ExternalChatProvider {
  /** 稳定标识，用于日志与配置区分，如 `moonshot-kimi` */
  readonly id: string;
  /** 人类可读名称，用于错误提示等 */
  readonly displayLabel: string;

  /**
   * 能力声明：让上层按能力路由而非按模型名。
   * 缺省（未实现 getter）时按 "openai" 协议处理（向后兼容）。
   */
  readonly capabilities?: ProviderCapabilities;

  isEnabled(): boolean;

  /**
   * 流式生成回复；`onDelta` 为增量文本（UTF-16 字符串片段，与常见 SDK 一致）。
   * 实现需自行按 `sessionId` 维护多轮上下文（若支持）。
   * `tools` 传入时启用 function calling（OpenAI 兼容端点）。
   */
  streamCompletion(
    sessionId: string,
    userTurn: ChatUserTurn,
    onDelta: StreamDeltaHandler,
    tools?: ChatToolExecutionContext,
    streamOpts?: AgentStreamOptions,
  ): Promise<string>;

  /**
   * 可选：丢弃某会话的服务端侧对话记忆
   */
  clearSession?(sessionId: string): void;

  /**
   * 可选：将已完成的一轮 user/assistant 写入服务端线程（不调用模型）。
   * 用于 Plan-Execute 等使用临时 session 的路径，避免主会话丢失短期上下文。
   */
  appendThreadTurn?(
    sessionId: string,
    userTurn: ChatUserTurn,
    assistantText: string,
    maxThreadMessages?: number,
    model?: string,
  ): void;

  /**
   * 可选：按 clientMessageId 移除该 user 消息及其后的全部线程内容。
   * 用于 fast→complex 升级重放前清理 fast 轮写入的线程残迹（防重复落盘）。
   */
  removeUserTurnAndAfter?(sessionId: string, clientMessageId?: string): void;

  /**
   * 可选：把后台任务的目标与结果作为单条 assistant 角色事实记录写入线程。
   * 取代旧的「伪造 user 轮 [后台任务] <原文> + assistant 回复对」——user 轮
   * 会让后续对话把任务原文当作用户说过的话接茬（2026-09-08 事故根因之一）。
   */
  appendTaskRecord?(sessionId: string, goal: string, resultText: string): void;
}
