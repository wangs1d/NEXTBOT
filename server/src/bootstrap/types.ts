import type { FastifyInstance } from "fastify";
import type { AgentCore } from "../services/agent-core.js";
import type { RuntimeFacade } from "../runtime/runtime-facade.js";
import type { AgentAccountService } from "../services/agent-account-service.js";
import type { AipService } from "../aip/aip-service.js";
import type { AgentPairingService } from "../services/agent-pairing-service.js";
import type { AgentRelayService } from "../services/agent-relay-service.js";
import type { AuditService } from "../services/audit-service.js";
import type { EmailRegistrationService } from "../services/email-registration-service.js";
import type { FriendService } from "../services/friend-service.js";
import type { InfoHubService } from "../services/info-hub-service.js";
import type { RealFundsWalletService } from "../services/real-funds-wallet-service.js";
import type { SessionService } from "../services/session-service.js";
import type { ScheduleTaskService } from "../services/schedule-task-service.js";
import type { ScheduleIntentService } from "../services/schedule-intent-service.js";
import type { WsConnectionRegistry } from "../services/ws-connection-registry.js";
import type { SkillManager } from "../skills/index.js";
import type { SkillMetadata } from "../skills/types.js";
import type { ToolRegistry } from "../tools/tool-registry.js";
import type {
  A2aOutsourcingService,
  SkillMetadataValidatorLike,
  SocialFeedService,
  WorldService,
} from "@nextbot/agent-world";
import type { AgentMemorySyncService } from "../services/agent-memory-sync-service.js";
import type { ComputeQuotaService } from "../services/compute-quota-service.js";
import type { UnifiedIdempotencyService } from "../services/unified-idempotency-service.js";
import type { WeatherPrefsService } from "../services/weather-prefs-service.js";
import type { WeatherService } from "../services/weather-service.js";
import type { TtsService } from "../services/tts-service.js";
import type { VirtualPhoneService } from "../services/virtual-phone-service.js";
import type { VoiceCapabilityService } from "../services/voice-capability-service.js";
import type { VoiceMessageService } from "../services/voice-message-service.js";
import type { ImageGenerationService } from "../services/image-generation-service.js";
import type { FileProcessingService } from "../services/file-processing-service.js";
import type { EmailSmsService } from "../services/email-sms-service.js";
import type { EmailOtpService } from "../services/email-otp-service.js";
import type { MediaMusicService } from "../services/media-music-service.js";
import type { HealthFitnessService } from "../services/health-fitness-service.js";
import type { FinanceDeepService } from "../services/finance-deep-service.js";
import type { BillManagementService } from "../services/bill-management-service.js";
import type { SocialOutreachService } from "../services/social-outreach-service.js";
import type { CodeSandboxService } from "../services/code-sandbox-service.js";
import type { VoiceDialogueService } from "../services/voice-dialogue/voice-dialogue-service.js";
import type { HabitLoopService } from "../services/habit-loop/index.js";
import type { ArrivalMonitorService } from "../services/arrival-concierge/index.js";
import type { TransferWatchService } from "../services/transfer-watch-service.js";
import type { VoiceDuplexService } from "../services/voice-duplex/index.js";
import type { BookingOrderStore } from "../services/booking/index.js";
import type { FeatureCatalog } from "../catalog/index.js";
import type { IntelligentReminderService } from "../services/intelligent-reminder/intelligent-reminder-service.js";
import type { UserResponsePersistenceService } from "../services/intelligent-reminder/user-response-persistence.js";
import type { McpClientService } from "../services/mcp-client-service.js";
import type { LifeSignalHubService } from "../services/life-signal-hub-service.js";
import type { MarketSignalService } from "../services/market-signal-service.js";
import type { ProactiveLifeRuntimeService } from "../services/proactive-life-runtime-service.js";
import type { HookBus } from "../services/hooks/index.js";
import type { WebhookService } from "../services/webhook/index.js";
import type { NotesService } from "../services/notes-service.js";
import type { MorningBriefingScheduler } from "../services/morning-briefing-scheduler.js";
import type { ExternalChatProvider } from "../external-model/types.js";
import type { MoodInferenceService } from "../services/mood-inference-service.js";
import type { MessageHubService } from "../services/message-hub-service.js";
import type { MessagePlatformGateway } from "../services/message-platform-gateway.js";
import type { MessageBridgeService } from "../services/message-bridge-service.js";
import type { DeviceRegistry } from "../device-bus/device-registry.js";
import type { DevicePairingService } from "../services/device-pairing-service.js";
import type { BrainCenter } from "../brain/index.js";
import type { BodyCenter } from "../body/index.js";
import type { ReflexArc } from "../body/reflex-arc.js";

export type AppServices = {
  app: FastifyInstance;
  sessionService: SessionService;
  scheduleTaskService: ScheduleTaskService;
  scheduleIntentService: ScheduleIntentService;
  infoHubService: InfoHubService;
  realFundsWallet: RealFundsWalletService;
  auditService: AuditService;
  toolRegistry: ToolRegistry;
  skillManager: SkillManager;
  skillMetadataValidator: SkillMetadataValidatorLike;
  agentRelayService: AgentRelayService;
  wsConnectionRegistry: WsConnectionRegistry;
  agentPairingService: AgentPairingService;
  aipService: AipService;
  agentAccountService: AgentAccountService;
  emailRegistrationService: EmailRegistrationService;
  /** Agent 编排核心（具体类；仅装配层 setter 注入与诊断用） */
  agentCore: AgentCore;
  /** Runtime 统一入口（进程无关契约；一切 Turn 调用方使用本字段） */
  runtime: RuntimeFacade;
  worldService: WorldService;
  a2aOutsourcingService: A2aOutsourcingService;
  socialFeedService: SocialFeedService;
  computeQuotaService: ComputeQuotaService;
  agentMemorySyncService: AgentMemorySyncService;
  unifiedIdempotencyService: UnifiedIdempotencyService;
  weatherService: WeatherService;
  weatherPrefsService: WeatherPrefsService;
  ttsService: TtsService;
  /** Agent 底层语音能力中枢（TTS + ASR + WS 推送，Agent 自调度入口） */
  voiceCapabilityService: VoiceCapabilityService;
  /** 语音消息落盘服务（voice.send_message 工具 + 用户上传录音共用） */
  voiceMessageService: VoiceMessageService;
  /** 图像生成服务（image.generate 工具 + 静态拉流共用） */
  imageGenerationService: ImageGenerationService;
  /** 文件/文档处理服务（file.read_text / file.write_text / file.parse_pdf / file.parse_office / file.export_format） */
  fileProcessingService: FileProcessingService;
  /** 邮件/短信主动发送服务（email.send / sms.send，凭证从环境变量读取） */
  emailSmsService: EmailSmsService;
  /** 邮箱所有权验证码（OTP）：注册/登录闸用，凭据复用 emailSmsService 的 OUTBOUND_SMTP_* */
  emailOtpService: EmailOtpService;
  /** 媒体音乐服务（media.search / media.play / pause / resume / stop / now_playing） */
  mediaMusicService: MediaMusicService;
  /** 健康/运动数据服务（health.log_metric / get_metrics / get_summary / set_goal / get_goals / import_data） */
  healthFitnessService: HealthFitnessService;
  /** 财务深度服务（finance.import_transactions / analyze_spending / set_budget / get_budget_status / reconcile / categorize / export_report） */
  financeDeepService: FinanceDeepService;
  /** 账单管理服务（finance.add/list/update/pay_bill：账单追踪/到期提醒/缴费入账联动预算） */
  billManagementService: BillManagementService;
  /** 社交主动出击服务（social.post / comment / repost / like / get_feed / search_posts，外部真实平台） */
  socialOutreachService: SocialOutreachService;
  /** 代码执行沙盒服务（code.run / list_files / read_file / write_file，python/node 子进程） */
  codeSandboxService: CodeSandboxService;
  virtualPhoneService: VirtualPhoneService;
  friendService: FriendService;
  messageHubService: MessageHubService;
  messagePlatformGateway: MessagePlatformGateway;
  messageBridgeService: MessageBridgeService;
  voiceDialogueService: VoiceDialogueService;
  /** 习惯学习 → 自动执行闭环（挖掘/规则/授权分级/自动执行） */
  habitLoopService: HabitLoopService;
  /** 到站管家（航班/高铁到站监控 + 接站通知 + 到站约车提案） */
  arrivalMonitorService: ArrivalMonitorService;
  /** 接驳提醒（行程交通段到站/起飞前动态窗口主动询问是否预约滴滴） */
  transferWatchService: TransferWatchService;
  /** 全双工实时语音（WS /ws/voice-duplex 会话管理） */
  voiceDuplexService: VoiceDuplexService;
  /** 统一预订层本地订单存储（travel 域结算技能共用） */
  bookingOrderStore: BookingOrderStore;
  /** Feature Catalog 能力分类目录（12 生活域；HTTP /api/catalog/* 数据源） */
  featureCatalog: FeatureCatalog;
  intelligentReminderService: IntelligentReminderService;
  reminderResponsePersistence: UserResponsePersistenceService;
  mcpClientService: McpClientService;
  lifeSignalHubService: LifeSignalHubService;
  marketSignalService: MarketSignalService;
  proactiveLifeRuntimeService: ProactiveLifeRuntimeService;
  /** 全局 hook 总线 — 业务代码 emit hook 的唯一入口，WebhookService 内部订阅它 */
  hookBus: HookBus;
  webhookService: WebhookService;
  notesService: NotesService;
  morningBriefingScheduler: MorningBriefingScheduler;
  externalChat: ExternalChatProvider | null;
  moodInferenceService: MoodInferenceService;
  /** 终端互连平台 —— 设备注册表（多设备并存，按 deviceId 路由） */
  deviceRegistry: DeviceRegistry;
  /** 终端互连平台 —— 设备配对服务（生成配对码 + 持久化 owner↔device 绑定） */
  devicePairingService: DevicePairingService;
  /** 设备自绑定鉴权服务（/api/* 周界鉴权凭证的签发与校验；ACCESS_AUTH_REQUIRED 开启时强制） */
  accessAuthService: import("../services/access-auth-service.js").AccessAuthService;
  /** 待确认收件箱外观（proactivity + habit 待确认条目统一 list/resolve） */
  approvalInboxService: import("../services/approval-inbox-service.js").ApprovalInboxService;
  /** 注意力台账（分级触达的投递记录 + ack 归一） */
  attentionStore: import("../proactivity/attention-store.js").AttentionStore;
  /** 分级触达路由（矩阵路由 + 升级计时 + 专注降级） */
  reachRouter: import("../proactivity/reach-router.js").ReachRouter;
  /** Agent Brain Center —— 大脑中心外观（BRAIN_CENTER_ENABLED=0 时为 null） */
  brainCenter: BrainCenter | null;
  /** Agent Body Center —— 身体中心外观（BODY_CENTER_ENABLED=0 时为 null） */
  bodyCenter: BodyCenter | null;
  /** Agent ReflexArc —— 反射弧硬安全门（BODY_CENTER_ENABLED=0 时为 null） */
  reflexArc: ReflexArc | null;
};

export type SkillMetadataValidator = {
  validateMetadata(metadata: unknown): SkillMetadata;
};
