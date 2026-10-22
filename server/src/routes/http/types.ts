import type { AipService } from "../../aip/aip-service.js";
import type { AgentPairingService } from "../../services/agent-pairing-service.js";
import type { AgentAccountService } from "../../services/agent-account-service.js";
import type { EmailRegistrationService } from "../../services/email-registration-service.js";
import type { EmailOtpService } from "../../services/email-otp-service.js";
import type { EmailSmsService } from "../../services/email-sms-service.js";
import type { BetaWhitelistService } from "../../services/beta-whitelist-service.js";
import type { BetaInviteService, BetaWaitlistService } from "../../services/beta-invite-service.js";
import type { FinanceIngestService } from "../../services/finance-ingest-service.js";
import type { AgentRelayService } from "../../services/agent-relay-service.js";
import type { FriendService } from "../../services/friend-service.js";
import type { FriendMessageService } from "../../services/friend-message-service.js";
import type { ScheduleTaskService } from "../../services/schedule-task-service.js";
import type { ScheduleIntentService } from "../../services/schedule-intent-service.js";
import type { InfoHubService } from "../../services/info-hub-service.js";
import type { UpstreamSearchService } from "../../services/upstream-search-service.js";
import type { SkillManager } from "../../skills/index.js";
import type { ToolRegistry } from "../../tools/tool-registry.js";
import type { RealFundsWalletService } from "../../services/real-funds-wallet-service.js";
import type { NotesService } from "../../services/notes-service.js";
import type { ExternalChatProvider } from "../../external-model/types.js";
import type {
  A2aOutsourcingService,
  SkillMetadataValidatorLike,
  SocialFeedService,
  WorldService,
} from "@private-ai-agent/agent-world";
import type { AgentMemorySyncService } from "../../services/agent-memory-sync-service.js";
import type { ComputeQuotaService } from "../../services/compute-quota-service.js";
import type { WeatherPrefsService } from "../../services/weather-prefs-service.js";
import type { WeatherService } from "../../services/weather-service.js";
import type { TtsService } from "../../services/tts-service.js";
import type { VoiceCapabilityService } from "../../services/voice-capability-service.js";
import type { VoiceMessageService } from "../../services/voice-message-service.js";
import type { ImageGenerationService } from "../../services/image-generation-service.js";
import type { PictureKit } from "@private-ai-agent/picture";
import type { FileProcessingService } from "../../services/file-processing-service.js";
import type { VirtualPhoneService } from "../../services/virtual-phone-service.js";
import type { DesktopBridgeCoordinator } from "../../services/desktop-bridge-coordinator.js";
import type { PhoneBridgeCoordinator } from "../../services/phone-bridge-coordinator.js";
import type { WechatClawBindingService } from "../../services/wechat-claw-binding-service.js";
import type { WechatClawBridgeService } from "../../services/wechat-claw-bridge-service.js";
import type { MessageHubService } from "../../services/message-hub-service.js";
import type { MessagePlatformGateway } from "../../services/message-platform-gateway.js";
import type { MessageBridgeService } from "../../services/message-bridge-service.js";
import type { BrowserSessionService } from "../../services/browser-session-service.js";
import type { RuntimeFacade } from "../../runtime/runtime-facade.js";
import type { CompanionService } from "../../services/companion-service.js";
import type { WsConnectionRegistry } from "../../services/ws-connection-registry.js";
import type { LifeSignalHubService } from "../../services/life-signal-hub-service.js";
import type { MarketSignalService } from "../../services/market-signal-service.js";
import type { ProactiveLifeRuntimeService } from "../../services/proactive-life-runtime-service.js";
import type { UserPersonalizationService } from "../../services/user-personalization/user-personalization-service.js";
import type { HookBus } from "../../services/hooks/index.js";
import type { WebhookService } from "../../services/webhook/index.js";
import type { MoodInferenceService } from "../../services/mood-inference-service.js";
import type { DevicePairingService } from "../../services/device-pairing-service.js";
import type { DeviceRegistry } from "../../device-bus/device-registry.js";
import type { BrainCenter } from "../../brain/index.js";
import type { BodyCenter } from "../../body/index.js";
import type { ReflexArc } from "../../body/reflex-arc.js";
import type { ProactivitySuppressionStore } from "../../proactivity/suppression-store.js";

/** 各 HTTP 子域注册函数共用的依赖 */
export type HttpRouteDeps = {
  toolRegistry: ToolRegistry;
  skillManager: SkillManager;
  skillMetadataValidator: SkillMetadataValidatorLike;
  realFundsWallet: RealFundsWalletService;
  worldService: WorldService;
  a2aOutsourcingService: A2aOutsourcingService;
  socialFeedService: SocialFeedService;
  agentRelayService: AgentRelayService;
  scheduleTaskService: ScheduleTaskService;
  scheduleIntentService: ScheduleIntentService;
  infoHubService: InfoHubService;
  upstreamSearchService: UpstreamSearchService;
  agentPairingService: AgentPairingService;
  aipService: AipService;
  agentAccountService: AgentAccountService;
  emailRegistrationService: EmailRegistrationService;
  /** 邮箱所有权验证码（OTP）存取；未装配时 OTP 闸不生效 */
  emailOtpService?: EmailOtpService;
  /** 出站邮件 SMTP 通道；未配置凭据时 isEmailEnabled()=false，OTP 闸不生效 */
  emailSmsService?: EmailSmsService;
  /** 内测注册白名单（未装配时不设闸；名单落 data/beta-whitelist.json，校验实时读盘） */
  betaWhitelistService?: BetaWhitelistService;
  /** 内测候补申请队列（未装配时 /accounts/beta/apply 返回 503） */
  betaWaitlistService?: BetaWaitlistService;
  /** 内测邀请码（未装配时注册闸不认码） */
  betaInviteService?: BetaInviteService;
  /** 财务入站邮件记账（未装配时 /finance/ingest/* 端点返回 503） */
  financeIngestService?: FinanceIngestService;
  /** 数据入口：用户自助上传（截图/表格/ics/文本）→ 抽取 → 确认入库（未装配时 /ingest/* 返回 503） */
  ingestService?: import("../../services/ingest-service.js").IngestService;
  /** ics 日历订阅：用户自助粘贴订阅链接（未装配时 /ingest/subscriptions 返回 503） */
  icsSubscriptionService?: import("../../services/ics-subscription-service.js").IcsSubscriptionService;
  /** 支付订单服务（未装配时管理概览不含支付统计） */
  paymentService?: import("../../services/payment-service.js").PaymentService;
  computeQuotaService: ComputeQuotaService;
  agentMemorySyncService: AgentMemorySyncService;
  /** 结构化事实库（简报用户称呼「称呼」字段源）；未装配时称呼走 KV 兜底 */
  factStore?: {
    getFact(
      actorId: string,
      field: string,
      entity?: string,
    ): { field: string; value: string } | null;
  };
  weatherService: WeatherService;
  weatherPrefsService: WeatherPrefsService;
  /** 位置协调器（客户端 GPS）：简报天气未配置城市时的优先兜底；可选 */
  locationCoordinator?: import("../../services/location-coordinator.js").LocationCoordinator;
  virtualPhoneService: VirtualPhoneService;
  ttsService: TtsService;
  /** 语音消息落盘服务（voice.send_message 工具 + 用户上传录音共用） */
  voiceMessageService: VoiceMessageService;
  /** 语音能力中枢（ASR 端点 /agent/voice/transcribe 使用）；可选，未注入时该端点返回 503 */
  voiceCapabilityService?: VoiceCapabilityService;
  /** 图像生成服务（image.generate 工具 + 静态拉流共用） */
  imageGenerationService: ImageGenerationService;
  /** 图片能力套件(图库) */
  pictureKit: PictureKit;
  /** 文件/文档处理服务（file.read_text 等工具 + 静态拉流共用） */
  fileProcessingService: FileProcessingService;
  desktopBridgeCoordinator: DesktopBridgeCoordinator;
  phoneBridgeCoordinator: PhoneBridgeCoordinator;
  wechatClawBindingService: WechatClawBindingService;
  wechatClawBridgeService: WechatClawBridgeService;
  messageHubService: MessageHubService;
  messagePlatformGateway: MessagePlatformGateway;
  messageBridgeService: MessageBridgeService;
  browserSessionService: BrowserSessionService;
  friendService: FriendService;
  /** 站内好友消息统一投递内核（friend-message-service）；未装配时好友消息端点 503 */
  friendMessageService?: FriendMessageService;
  companionService: CompanionService;
  runtime?: RuntimeFacade;
  wsConnectionRegistry?: WsConnectionRegistry;
  lifeSignalHubService?: LifeSignalHubService;
  /** 主动触达负反馈抑制表（Task 20 统一频控框架）；可选，未注入时抑制路由不挂载 */
  proactivitySuppressionStore?: ProactivitySuppressionStore;
  /** 统一主动性管道（docs/proactivity-architecture.md）；可选，未注入时诊断路由不挂载 */
  proactivePipeline?: import("../../proactivity/proactive-pipeline.js").ProactivePipeline | null;
  /** 移动端推送通道（离线必达升级）；可选，未注入时推送注册路由禁用 */
  proactivePushService?: import("../../proactivity/mobile-push-service.js").MobilePushService | null;
  /**
   * 五层主动性架构观测（传感健康/仲裁预览/目标板/链路自检）；可选，
   * 未注入时 /sensors 与 /selftest 端点不可用。
   */
  proactivityFabric?: import("../../routes/http/proactivity.js").ProactivityFabricDeps | null;
  /** 每用户自主性等级 + 勿扰（GET/PUT /api/autonomy）；可选，未注入时路由不挂载 */
  autonomySettings?: import("../../services/autonomy-settings-store.js").AutonomySettingsStore | null;
  /** 助手动态台账（右侧面板「助手动态」卡数据源） */
  agentActivityStore: import("../../proactivity/activity-store.js").AgentActivityStore;
  /** 行为审计时间线（GET /agent/audit-timeline；可选，未注入时该端点 503） */
  auditTrailService?: import("../../proactivity/audit-timeline.js").AuditTrailService | null;
  /** 承诺板（主页「盯着」小节数据源；未启用时该小节为空） */
  commitmentBoard?: import("../../agentic-memory/commitment-board.js").CommitmentBoard | null;
  marketSignalService?: MarketSignalService;
  proactiveLifeRuntimeService?: ProactiveLifeRuntimeService;
  userPersonalizationService?: UserPersonalizationService;
  hookBus?: HookBus;
  webhookService?: WebhookService;
  notesService?: NotesService;
  externalChat?: ExternalChatProvider | null;
  /** 服务接入热替换：PUT /api/service-config 保存后装入新主对话 provider（未注入时保存仅落盘+写 env） */
  externalChatSwapper?: (next: ExternalChatProvider | null) => void;
  moodInferenceService?: MoodInferenceService;
  /** 终端互连平台：设备配对服务 */
  devicePairingService?: DevicePairingService;
  /** 终端互连平台：设备注册表 */
  deviceRegistry?: DeviceRegistry;
  /** 设备自绑定鉴权服务（/api/* 周界鉴权凭证的签发与校验；未注入时鉴权路由不挂载） */
  accessAuthService?: import("../../services/access-auth-service.js").AccessAuthService;
  /** 待确认收件箱外观（proactivity + habit 待确认条目统一 list/resolve；未注入时收件箱路由不挂载） */
  approvalInboxService?: import("../../services/approval-inbox-service.js").ApprovalInboxService;
  /** 站内信服务（平台→用户收件箱；未注入时 /api/inbox 路由不挂载） */
  inboxService?: import("../../services/inbox-service.js").InboxService;
  /** 注意力台账（分级触达的投递/ack 记录；未注入时 /api/attention 不挂载） */
  attentionStore?: import("../../proactivity/attention-store.js").AttentionStore;
  /** 分级触达路由（矩阵路由 + 升级计时；未注入时 /api/attention 不挂载） */
  reachRouter?: import("../../proactivity/reach-router.js").ReachRouter;
  /** Agent Brain Center —— 大脑中心外观（BRAIN_CENTER_ENABLED=0 时为 null） */
  brainCenter?: BrainCenter | null;
  /** Agent Body Center —— 身体中心外观（未启用时为 null） */
  bodyCenter?: BodyCenter | null;
  /** 反射弧（身体侧硬安全门），用于 /body/reflex/patterns 热加载与列出；未装配时为 null */
  reflexArc?: ReflexArc | null;
  /** 旅游规划服务：媒体库手动回填接口依赖（未装配时回填端点返回 503） */
  travelPlanningService?: import("../../skills/travel-planning/travel-planning-service.js").PlanningService;
  /** Feature Catalog 能力分类目录（未装配时 /api/catalog/* 端点返回 503） */
  featureCatalog?: import("../../catalog/index.js").FeatureCatalog;
  /** 购物建议商品库（runtime 内置能力，shopping.suggest 工具数据源；未装配时只读端点 503） */
  recommendationCatalog?: import("../../recommendation/index.js").ProductCatalog;
};
