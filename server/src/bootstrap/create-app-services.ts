import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import Fastify from "fastify";
import {
  A2aOutsourcingService,
  loadPersistedCommunitySkills,
  registerWorldFreeMarketTools,
  registerWorldOpenRegistryTools,
  registerWorldRoomTools,
  registerWorldSocialTools,
  SocialFeedService,
  AgentWorldServerEventType,
  WorldPartitionWsRegistry,
  WorldService,
  type WorldRevisionEvent,
} from "@private-ai-agent/agent-world";
import { createExternalChatProviderFromEnv, MutableExternalChatProvider, ActorModelBindingStore } from "../external-model/index.js";
import { applyPersistedServiceConfig } from "../config/service-config-store.js";
import { createPictureKit } from "@private-ai-agent/picture";
import { getChatThreadPersistence } from "../external-model/chat-thread-persist.js";
import { createRecommendationCatalog, fetchLiveProducts, liveProductToRecord } from "../recommendation/index.js";
import { aggregateXiaohongshuUgc } from "../recommendation/ugc-aggregator.js";
import { pickBestProductImage } from "../services/product-image-scorer.js";
import { getChatThreadStore } from "../external-model/chat-thread-store.js";
import { createLlmRollingRecapSummarizer } from "../services/conversation-rolling-summarizer.js";
import { registerHttpRoutes } from "../routes/http/index.js";

import { AgentAccountService } from "../services/agent-account-service.js";
import { BetaWhitelistService } from "../services/beta-whitelist-service.js";
import { BetaInviteService, BetaWaitlistService } from "../services/beta-invite-service.js";
import { AgentMemorySyncService } from "../services/agent-memory-sync-service.js";
import { FriendService } from "../services/friend-service.js";
import { createAgentCore } from "../agent/agent-runtime.js";
import { DirectRuntimeAdapter, type RuntimeFacade } from "../runtime/runtime-facade.js";
import { PromptContextBuilder } from "../agent/prompt-context-builder.js";
import { buildActiveGoalsPromptBlock } from "../agent/active-goals-prompt.js";
import { getTaskPlanStore, initTaskPlanStore } from "../agent/task-plan-store.js";
import { TaskPlanProbeRunner } from "../agent/task-plan-probe-runner.js";
import { getToolResultProcessor } from "../services/tool-result-processor.js";
import { getRuntimeKernel } from "../agent/runtime-kernel.js";
import {
  formatAgentRuntimeConfigSummary,
  getAgentRuntimeConfig,
} from "../agent/agent-runtime-config.js";
import { resolvePrimaryChatSessionId } from "../agent/master-chat-session.js";
import { EvolutionLoopService } from "../services/evolution-loop-service.js";
import { UserPersonalizationService } from "../services/user-personalization/user-personalization-service.js";
import { createNarrativeMemoryPort, wrapNarrativeWithHybrid } from "../services/narrative-memory-port.js";
import { createNarrativeHybridRetrievalDefault } from "../services/narrative-hybrid-retrieval-service.js";
import { initMemoryManagerService, getMemoryManagerService } from "../services/memory-manager-service.js";
import { initHumanLikeMemoryService } from "../services/human-like-memory-service.js";
import { getAgenticMemoryRuntime, registerMemoryComponents } from "../agentic-memory/index.js";
import { ensureLocalEmbeddingEndpoint } from "../agentic-memory/local-embedding/local-embedding-endpoint.js";
import { resolveEmbeddingEndpoint } from "../services/openai-embedding-client.js";
import { createMemoryBridgeIfEnabled } from "../agentic-memory/memory-bridge-service.js";
import { createAgenticLedgerIfEnabled } from "../agentic-memory/ledger.js";
import { createCommitmentBoardIfEnabled } from "../agentic-memory/commitment-board.js";
import { isCommitmentAutoExtractEnabled } from "../agentic-memory/env.js";
import { extractCommitments } from "../agentic-memory/commitment-extractor.js";
import { createProvenanceIfEnabled } from "../agentic-memory/provenance.js";
import {
  createUserUnderstandingStoreIfEnabled,
} from "../agentic-memory/user-understanding-store.js";
import {
  createStructuredFactStoreIfEnabled,
  isProfileField,
} from "../agentic-memory/structured-fact-store.js";
import { LifeModelStore } from "../agentic-memory/life-model-store.js";
import { registerLifeManageTools } from "../tools/life-manage-tools.js";
import {
  reconcileProfileFactsForActors,
  reconcileProfileFactsRuntime,
} from "../services/user-personalization/profile-fact-authority-runtime.js";
import { createMemoryFtsStoreIfEnabled } from "../agentic-memory/fts-store.js";
import { retireMemoriesForFactChange } from "../agentic-memory/fact-supersede.js";
import { getMemoryReinforcementStore } from "../agentic-memory/memory-reinforcement.js";
import { initMemorySuppressionStore } from "../agentic-memory/memory-suppression.js";
import { getMemoryHealthSnapshot } from "../agentic-memory/health.js";
import { registerCommitmentTools, MEMORY_INVALIDATION_CHAT_TOOLS } from "../tools/commitment-tools.js";
import { registerTaskDispatchTool } from "../tools/task-dispatch-tool.js";
import { registerTaskPlaneTools } from "../tools/task-plane-tools.js";
import { getAgentTaskStore } from "../services/agent-task-store.js";
import { getAgentTaskOrchestrator } from "../services/agent-task-orchestrator.js";
import { getTaskHub } from "../task-plane/task-hub.js";
import { getTaskOutbox } from "../task-plane/task-outbox.js";
import { scheduleInterruptedTaskRecovery } from "../task-plane/restart-recovery.js";
import { AutonomySettingsStore } from "../services/autonomy-settings-store.js";
import { registerGeofenceTools } from "../tools/geofence-tools.js";
import { GeofenceService, isPublicHttpUrl } from "../services/geofence-service.js";
import { LocationHistoryService } from "../services/location-history-service.js";
import { LocationIngestPipeline } from "../services/location-ingest-pipeline.js";
import {
  getLocationDbPath,
  getLocationHistoryRetentionDays,
  isLocationHistoryEnabled,
} from "../config/location-env.js";
import { LocationSensor } from "../rhythm/sensors/location-sensor.js";
import { LocationTrigger } from "../proactivity/triggers/location-trigger.js";
import { createProactiveOutreachExecutor } from "../proactivity/proactive-outreach-executor.js";
import { getDailyDigestService } from "../services/daily-digest-service.js";
import { getShortTermMemoryConfig } from "../services/short-term-memory-config.js";
import { initShortTermMemoryGatewayService } from "../services/short-term-memory-gateway.js";
import { initDailyJournalService, getDailyJournalService } from "../services/daily-journal-service.js";
import { EveningDigestService } from "../services/evening-digest-service.js";
import { EveningDigestScheduler } from "../services/evening-digest-scheduler.js";
import { LifeRhythmEngine } from "../rhythm/engine.js";
import { RhythmProfileStore } from "../rhythm/profile-store.js";
import { UserTimingService } from "../proactivity/user-timing-service.js";
import { NightlyRhythmAnalyzer } from "../rhythm/nightly-rhythm-analyzer.js";
import { SleepWindowSensor } from "../rhythm/sensors/sleep-window-sensor.js";
import { DesktopActivitySensor } from "../rhythm/sensors/desktop-activity-sensor.js";
import { InteractionSignalSensor } from "../rhythm/sensors/interaction-signal-sensor.js";
import { createReminderReschedulerConsumer } from "../rhythm/consumers/reminder-rescheduler.js";
import { createReceptiveHoursWriterConsumer } from "../rhythm/consumers/receptive-hours-writer.js";
import { createProactiveCandidateSourceConsumer } from "../rhythm/consumers/proactive-candidate-source.js";
import type { RhythmProfileUpdatedPayload } from "@private-ai-agent/agent-protocol";
import {
  initNightlyMemoryTaskService,
  getNightlyMemoryTaskService,
} from "../services/nightly-memory-task-service.js";
import { 
  initDailyChatSyncService,
  getDailyChatSyncService,
} from "../services/daily-chat-sync-service.js";
import { compactObserveLine } from "../tokenjuice/compactor.js";
import { TrajectoryPromotionPipeline, parseSkillPromotionPipelineMode } from "../services/skill-promotion-pipeline.js";
import { SkillPromotionQueueService } from "../services/skill-promotion-queue-service.js";
import { TrajectorySkillPromotionService } from "../services/trajectory-skill-promotion-service.js";
import { AgentSelfLearningService } from "../services/agent-self-learning-service.js";
import { SkillGenerator } from "../services/skill-generator.js";
import { KnowledgeGapExecutor } from "../services/knowledge-gap-executor.js";
import { KnowledgeVerificationService } from "../services/knowledge-verification-service.js";
import { ProactiveAgentCenter } from "../services/proactive-agent-center.js";
import { ProactiveOutboundMessageService } from "../services/proactive-outbound-message-service.js";
import {
  ArrivalMonitorService,
  JuheTrainProvider,
  ManualScheduleProvider,
  VariflightFlightProvider,
} from "../services/arrival-concierge/index.js";
import { HabitLoopService } from "../services/habit-loop/index.js";
import {
  configureChatSuggestionProfileSource,
  configureChatSuggestionUsageSource,
} from "../services/chat-suggestions-service.js";
import { MiniMaxRealtimeEngine, VoiceDuplexService } from "../services/voice-duplex/index.js";
import { registerVoiceDuplexWsRoute } from "../ws/voice-duplex-route.js";
import type { TravelTicketProvider } from "../services/booking/providers/travel-ticket-provider.js";
import { LifeSignalHubService } from "../services/life-signal-hub-service.js";
import { AnticipationEngineService } from "../services/anticipation-engine-service.js";
import { ProactiveLifeRuntimeService } from "../services/proactive-life-runtime-service.js";
import { DesktopPresenceSignalService } from "../services/desktop-presence-signal-service.js";
import { HookBus, setHookBus } from "../services/hooks/index.js";
import { WebhookService } from "../services/webhook/index.js";
import { AgentPairingService } from "../services/agent-pairing-service.js";
import { AgentRelayService } from "../services/agent-relay-service.js";
import { FriendMessageService } from "../services/friend-message-service.js";
import { AuditService } from "../services/audit-service.js";
import { EmailRegistrationService } from "../services/email-registration-service.js";
import { InfoHubService } from "../services/info-hub-service.js";
import { RealFundsWalletService } from "../services/real-funds-wallet-service.js";
import { PaymentService } from "../services/payment-service.js";
import { MeituanService } from "../services/meituan-service.js";
import { AlipayBotService } from "../services/alipay-bot-service.js";
import { ScheduleIntentService } from "../services/schedule-intent-service.js";
import { ScheduleTaskService } from "../services/schedule-task-service.js";
import { habitHintsFromSleepSamples } from "../services/schedule-reminder-policy.js";
import {
  getScheduleHabitStore,
  initScheduleHabitStore,
} from "../services/schedule-habit-store.js";
import {
  getPresenceFootprintStore,
  initPresenceFootprintStore,
} from "../rhythm/presence-footprint-store.js";
import { ScheduleConflictService } from "../services/schedule-conflict-service.js";
import { ScheduleBookingBridge } from "../services/schedule-booking-bridge.js";
import { createCommitmentScheduleOutlet } from "../services/commitment-schedule-outlet.js";
import { IcsSubscriptionService, readIcsWatchConfig } from "../services/ics-subscription-service.js";
import {
  MailScheduleBridge,
  suppressMailInterrupt,
  type MailScheduleSyncReport,
} from "../services/mail-schedule-extractor.js";
import { estimateDriveMinutes } from "../services/route-duration-service.js";

/** 出发预留起点的新鲜度阈值：最近已知定位超过该时长改走按需实时定位 */
const ROUTE_ORIGIN_FRESH_MS = 2 * 60 * 60_000;
/** 路程估时整体预算：策略计算（建任务/改期）不能被外网路线请求拖死 */
const ROUTE_ESTIMATE_BUDGET_MS = 6_000;
import { SessionService } from "../services/session-service.js";
import { TtsService } from "../services/tts-service.js";
import { VirtualPhoneService } from "../services/virtual-phone-service.js";
import { VoiceCapabilityService } from "../services/voice-capability-service.js";
import { VoiceMessageService } from "../services/voice-message-service.js";
import { ImageGenerationService } from "../services/image-generation-service.js";
import { FileProcessingService } from "../services/file-processing-service.js";
import { EmailSmsService } from "../services/email-sms-service.js";
import { EmailOtpService } from "../services/email-otp-service.js";
import { MediaMusicService } from "../services/media-music-service.js";
import { MailWatchService, createImapflowClient } from "../services/mail-watch-service.js";
import {
  FinanceBillAutoFetchService,
  createPlaywrightAlipayBillFetcher,
} from "../services/finance-bill-auto-fetch-service.js";
import { isBillRelatedMail } from "../services/finance-ingest-service.js";
import { HealthFitnessService } from "../services/health-fitness-service.js";
import { PeriodCareService } from "../services/period-care-service.js";
import { SafetyGuardService } from "../services/safety-guard-service.js";
import { FinanceDeepService } from "../services/finance-deep-service.js";
import { SubscriptionAuditService } from "../services/subscription-audit-service.js";
import { BillManagementService } from "../services/bill-management-service.js";
import { FinanceIngestService } from "../services/finance-ingest-service.js";
import { SocialOutreachService } from "../services/social-outreach-service.js";
import { CodeSandboxService } from "../services/code-sandbox-service.js";
import { ShoppingOrderService } from "../services/shopping-order-service.js";
import { ShoppingOrderStore } from "../services/shopping-order-store.js";
import { ShoppingCompareService } from "../services/shopping-compare-service.js";
import { OfficialPriceGateway } from "../services/shopping-platforms/official-price-source.js";
import { AgentBrowserService } from "../services/agent-browser-service.js";
import {
  BookingService,
  BookingOrderStore,
  buildDefaultBookingProviders,
  getBookingConfig,
} from "../services/booking/index.js";
import { buildQuoteAggregator } from "../services/booking/quote/index.js";
import { VoiceDialogueService } from "../services/voice-dialogue/voice-dialogue-service.js";
import { OpenAITTSAdapter } from "../services/voice-dialogue/adapters/openai-tts-adapter.js";
import { MiniMaxTTSAdapter } from "../services/voice-dialogue/adapters/minimax-tts-adapter.js";
import { MiniMaxRealtimeService } from "../services/voice-dialogue/minimax-realtime-service.js";
import { OpenAILLMAdapter } from "../services/voice-dialogue/adapters/openai-llm-adapter.js";
import { FunAsrAdapter } from "../services/voice-dialogue/adapters/funasr-asr-adapter.js";
import { createIntelligentReminderSystem } from "../services/intelligent-reminder/index.js";
import { UpstreamSearchService } from "../services/upstream-search-service.js";
import { VideoGrabService, setVideoGrabServiceRef, setVideoGrabMcpClientRef } from "../services/video-grab-service.js";
import { WsConnectionRegistry } from "../services/ws-connection-registry.js";
import { startClientUpdatePusher } from "../services/client-update-pusher.js";
import { SkillManager } from "../skills/index.js";
import { registerAgentWorldIdentityBuiltinSkills } from "../skills/builtin/agent-world-identity-skills.js";
import { registerVirtualPhoneBuiltinSkills } from "../skills/builtin/virtual-phone-skills.js";
import { registerAlipayPaymentBuiltinSkills } from "../skills/builtin/alipay-payment-skills.js";
import { registerMerchantOrderBuiltinSkills } from "../skills/builtin/merchant-order-skills.js";
import { registerFinanceIngestBuiltinSkills } from "../skills/builtin/finance-ingest-skills.js";
import { registerBookingTravelBuiltinSkills } from "../skills/builtin/booking-travel-skills.js";
import { registerArrivalConciergeBuiltinSkills } from "../skills/builtin/arrival-concierge-skills.js";
import { registerHabitLoopBuiltinSkills } from "../skills/builtin/habit-loop-skills.js";
import { registerPictureBuiltinSkills } from "../skills/builtin/picture-skills.js";
import { registerTravelPlanningBuiltinSkills } from "../skills/travel-planning/travel-planning-skills.js";
import { registerTravelCommuteBuiltinSkills } from "../skills/travel-planning/travel-commute-skills.js";
import { PlanningService as TravelPlanningService } from "../skills/travel-planning/travel-planning-service.js";
import { TravelHeatEnricher } from "../skills/travel-planning/travel-heat-enricher.js";
import { travelPlanStore } from "../skills/travel-planning/travel-plan-store.js";
import { TravelBudgetGuardService } from "../services/travel-budget-guard-service.js";
import { travelMemoir } from "../services/travel-memoir-service.js";
import { TravelPoiVideoService } from "../services/travel-poi-video-service.js";
import { TransferWatchService } from "../services/transfer-watch-service.js";
import { travelDataRefresh } from "../skills/travel-planning/travel-data-refresh.js";
import { MerchantOrderService } from "../services/merchant-order-service.js";
import { SkillValidator } from "../skills/skill-validator.js";
import type { SkillMetadata } from "../skills/types.js";
import { registerAgentIdentityTools } from "../tools/agent-identity-tools.js";
import {
  AGENT_NAME_KV_KEY,
  parseAgentIdentityKv,
} from "../services/agent-identity.js";
import {
  buildPersonaStaticBlock,
  resolveRelationshipTier,
  type RelationshipTier,
  type UserAdaptationProfile,
} from "../agent/persona-core.js";
import { getSoulOverlay } from "../agent/soul-store.js";
import { registerWalletTools } from "../tools/wallet-tools.js";
import { registerPaymentTools } from "../tools/payment-tools.js";
import { QrAssistService } from "../services/qr-assist-service.js";
import { registerWechatClawTools } from "../tools/wechat-claw-tools.js";
import { registerMeituanTools } from "../tools/meituan-tools.js";
import { registerAgentPhoneTools } from "../tools/agent-phone-tools.js";
import { registerAgentVoiceTools } from "../tools/agent-voice-tools.js";
import { registerSurfaceTools } from "../tools/surface-tools.js";
import {
  buildCapabilityModules,
  getAllCapabilityModuleIntentRules,
  registerAllCapabilityModules,
  type CapabilityModuleDeps,
} from "../tools/capability-modules/index.js";
import { setExtraIntentRules } from "../tools/tool-search/intent-metadata.js";
import {
  FeatureCatalog,
  buildCatalogIntentRules,
  classifyFeatureByName,
} from "../catalog/index.js";
import { setFeatureCatalog } from "../agent/agent-capabilities.js";
import { setCapabilityModuleDeps, getBuiltinAgentChatTools, invalidateBuiltinToolsCache, selectRelevantTools, setDeclaredSkillTimeoutResolver, declaredSkillTimeoutFromManager } from "../external-model/openai-compatible-tool-loop.js";
import { registerAgentLinkTools } from "../tools/agent-link-tools.js";
import { registerAgentRelayTools } from "../tools/agent-relay-tools.js";
import { registerCalendarTools } from "../tools/calendar-tools.js";
import { registerClockTools } from "../tools/clock-tools.js";
import { registerAgentActivityTools } from "../tools/agent-activity-tools.js";
import { registerEmbodimentTools } from "../tools/embodiment-tools.js";
import {
  EmbodimentAutonomyService,
  initEmbodimentAutonomy,
} from "../services/embodiment-autonomy-service.js";
import { registerLifeTools } from "../tools/life-tools.js";
import { registerSmartHomeTools } from "../tools/smart-home-tools.js";
import { registerDeviceTools } from "../tools/device-tools.js";
import { SmartHomeService } from "../services/smart-home-service.js";
import { DeviceRegistry } from "../device-bus/device-registry.js";
import { createHomeAdapterFactory } from "../device-bus/adapters/home-adapter.js";
import { createPhoneAdapterFactory } from "../device-bus/adapters/phone-adapter.js";
import { createDesktopAdapterFactory } from "../device-bus/adapters/desktop-adapter.js";
import { createTabletAdapterFactory } from "../device-bus/adapters/tablet-adapter.js";
import { createGlassesAdapterFactory } from "../device-bus/adapters/glasses-adapter.js";
import { createCameraAdapterFactory } from "../device-bus/adapters/camera-adapter.js";
import { DevicePairingService } from "../services/device-pairing-service.js";
import { AccessAuthService } from "../services/access-auth-service.js";
import { registerAccessAuthHook } from "../routes/http/auth.js";
import { ApprovalInboxService, isSpendConfirmation } from "../services/approval-inbox-service.js";
import { registerWeatherTools } from "../tools/weather-tools.js";
import { registerCareReminderTools } from "../tools/care-reminder-tools.js";
import { registerLifeSignalTools } from "../tools/life-signal-tools.js";
import { registerMarketSignalTools } from "../tools/market-signal-tools.js";
import { ToolRegistry } from "../tools/tool-registry.js";
import type { ToolContext } from "../tools/tool-registry.js";
import { resolveActorId, isEphemeralActorId } from "../agent/actor-id.js";
import { DesktopBridgeCoordinator } from "../services/desktop-bridge-coordinator.js";
import { SharedBrowserCoordinator } from "../services/shared-browser-coordinator.js";
import { ShoppingBrowserExecutor } from "../services/shopping-platforms/browser-executor.js";
import { SharedBrowserCdpGateway } from "../services/shared-browser/cdp-gateway.js";
import {
  DesktopSceneWatcherService,
  isDesktopSceneWatcherEnabled,
} from "../services/desktop-scene-watcher-service.js";
import {
  createDesktopSceneActionExecutor,
  DesktopSceneDocumentHandler,
  DesktopSceneMeetingHandler,
  DesktopScenePriceHandler,
} from "../services/desktop-scene-handlers.js";
import { LocationCoordinator } from "../services/location-coordinator.js";
import { WechatClawBindingService } from "../services/wechat-claw-binding-service.js";
import { WechatClawBridgeService } from "../services/wechat-claw-bridge-service.js";
import { MessageHubService, type MessageHubPlatform } from "../services/message-hub-service.js";
import { MessagePlatformGateway } from "../services/message-platform-gateway.js";
import { MessageBridgeService } from "../services/message-bridge-service.js";
import { createDesktopVisualFromEnv } from "../services/desktop-visual-subprocess.js";
import { registerDesktopVisualTools } from "../tools/desktop-visual-tools.js";
import { registerPhoneBridgeTools } from "../tools/phone-bridge-tools.js";
import { registerMessageHubTools } from "../tools/message-hub-tools.js";
import { PhoneBridgeCoordinator } from "../services/phone-bridge-coordinator.js";
import { PhoneCallCoordinator } from "../services/phone-call-coordinator.js";
import { registerVisionTools } from "../tools/vision-tools.js";
import { registerWebTools } from "../tools/web-tools.js";
import { registerVideoTools } from "../tools/video-tools.js";
import { registerInternetIntelligenceTools } from "../tools/internet-intelligence-tools.js";
import { registerHttpTools } from "../tools/http-tools.js";
import { registerMcpTools } from "../tools/mcp-tools.js";
import { buildMcpChatTools } from "../tools/mcp-tools.js";
import { McpClientService } from "../services/mcp-client-service.js";
import { setMcpChatTools, setBrainChatTools, setBodyChatTools, setMemoryChatTools } from "../external-model/openai-compatible-tool-loop.js";
import { warnOnChatToolDrift } from "../tools/chat-tool-drift.js";
import { registerBrainTools, BRAIN_TOOLS } from "../tools/brain-tools.js";
import { registerMemoryRecallTools, MEMORY_RECALL_CHAT_TOOLS } from "../tools/memory-recall-tools.js";
import { configureMemoryConsolidation } from "../services/memory-consolidation-service.js";
import { registerBrowserTools } from "../tools/browser-tools.js";
import { BrowserSessionService } from "../services/browser-session-service.js";
import { InternetIntelligenceService } from "../services/internet-intelligence-service.js";
import { registerSelfProgrammingTools } from "../tools/self-programming-tools.js";
import { registerAISkillGenerationTools } from "../tools/ai-skill-generation-tools.js";
import { registerSelfLearningTools } from "../tools/self-learning-tools.js";
import { registerSkillManageTools } from "../tools/skill-manage-tools.js";
import { registerNotesTools } from "../tools/notes-tools.js";
import { NotesService } from "../services/notes-service.js";
import {
  MorningBriefingService,
  generateImportantDayBlessing,
  importantDayTypeLabel,
  type MorningBriefingImportantDay,
} from "../services/morning-briefing-service.js";
import { MorningBriefingScheduler } from "../services/morning-briefing-scheduler.js";
import { markMorningBriefingDelivered } from "../routes/http/user-preferences.js";
import {
  getUserPreferences,
  listPrefsActorIds,
  patchAgentProfile,
} from "../routes/http/user-preferences.js";
import { registerCapabilityQueryTools } from "../tools/agent-capability-query-tools.js";
import { ServerEventType } from "../protocol.js";
import { embodimentAlert, embodimentThinking } from "../services/agent-embodiment.js";
import { formatReminderDisplayMessage } from "../tools/schedule-user-reply.js";
import { WeatherPrefsService } from "../services/weather-prefs-service.js";
import { WeatherService } from "../services/weather-service.js";
import { ComputeQuotaService } from "../services/compute-quota-service.js";
import { AipService } from "../aip/aip-service.js";
import { registerAipTools } from "../tools/aip-tools.js";
import { registerProtocolUnifiedTools } from "../tools/protocol-unified-tools.js";
import { registerWebSocketRoute } from "../ws/connection.js";
import { UnifiedIdempotencyService } from "../services/unified-idempotency-service.js";
import { join } from "path";
import {
  getHttpRateLimitRuntime,
  isAgentWorldSocialEnabled,
  isBrainEvolutionEnabled,
  isAccessAuthRequired,
  isOssEdition,
} from "../config/env.js";
import { registerHttpRateLimit } from "../http-rate-limit/http-rate-limit.js";
import type { AppServices } from "./types.js";
import { VisionPeriodicScheduler } from "../vision/vision-periodic-scheduler.js";
import { CompanionService } from "../services/companion-service.js";
import { MarketSignalService } from "../services/market-signal-service.js";
import { MoodInferenceService } from "../services/mood-inference-service.js";
import {
  notifyScheduleTasksChanged,
  scheduleWsPayloadDeleted,
  scheduleWsPayloadFromTask,
} from "../services/schedule-ws-notify.js";
import {
  BrainCenter,
  CapabilityCortex,
  AwarenessCortex,
  ProactionCortex,
  EvolutionCortex,
  CodeRepairCortex,
  DefaultTestRunner,
  type CodeRepairLlmLike,
  SensoryCortex,
  MemoryCortex,
  SynapseBus,
  LimbicCortex,
  PlannerCortex,
  BrainStem,
  Cerebellum,
  RuleRouter,
  ActionExecutor,
  DecisionHub,
  WorkingMemoryCortex,
  TaskSwitchingCortex,
  ContextCortex,
  ToolPlanningCortex,
  OnlineLearningCortex,
  EmotionModulator,
  type BrainSignalInput,
  type BrainDecision,
  type BrainDecisionAction,
  type CognitiveEngine,
  type CognitiveInput,
  type CognitiveContext,
  type EndToEndDecisionMaker,
  type MemoryCortexLike,
  type RecentConversationProvider,
  type GapAnalyzer,
  type DelegateJudge,
  createCognitiveEngineFromEnv,
  createDefaultEndToEndDecisionMaker,
  createDefaultDelegateJudge,
  createDefaultTopicExtractor,
  createWorldModelFromEnv,
  getTransitionStore,
  // 记忆认知架构升级（Phase 4）：7 个子模块
  MemoryAssociativeGraph,
  MemoryMetacognitionBridge,
  MemoryForgettingController,
  MemorySchemaFormation,
  MemorySalienceFilter,
  MemoryExperienceLearningLoop,
  // 推理引擎（多线索交叉推理）
  MemoryInferenceEngine,
  // 4 项仿人推理能力扩展：规则自学习 + 类比迁移 + 情感调制 + 无意识触发
  RuleLearner,
  AnalogyMigrator,
  InferenceEmotionModulator,
  BrainStemAutoInferer,
  // LLM 规则归纳器：让 LLM 从历史记忆中归纳因果规则（仅参与"学规则"）
  LLMRuleInducer,
} from "../brain/index.js";
import {
  BodyCenter,
  BodyBus,
  BodyGateway,
  ReflexArc,
  type BodyAction,
  type BodyActionResult,
  type BodySenseQuery,
  type BodySenseResult,
  type BodyModuleSnapshot,
} from "../body/index.js";
import { Eye } from "../body/eye.js";
import { createMemoryAssociationSynthesizer } from "../brain/memory-cognitive/memory-association-synthesizer.js";
import { SemanticAwarenessInferrerImpl } from "../brain/semantic-awareness-inferrer.js";
// 记忆模块整体优化：画像聚合 / 查询扩展 / 隐式反馈 / 记忆目录
import { createUserProfileAggregator } from "../brain/user-profile-aggregator.js";
import { RecallQueryExpander } from "../brain/memory-query-expander.js";
import { MemoryImplicitFeedbackDetector } from "../brain/memory-implicit-feedback.js";
import { MemoryInventory, setGlobalMemoryInventory } from "../brain/memory-inventory.js";
import {
  ConversationTimelineService,
  setConversationTimelineService,
} from "../services/conversation-timeline.js";
import { Ear } from "../body/ear.js";
import { Skin, type SmartHomeLike } from "../body/skin.js";
import { VestibularApparatus } from "../body/vestibular-apparatus.js";
import { HomeostasisCore } from "../body/homeostasis-core.js";
import { registerBodyTools, BODY_CHAT_TOOLS } from "../tools/body-tools.js";
import { getAgentTaskSafety } from "../services/agent-task-safety.js";
import { detectAssistantToneMode } from "../services/assistant-tone-policy.js";
import {
  detectEmotionFromText,
  detectPreferredToneFromText,
  buildToneGuidance,
  type EmotionState,
} from "../services/user-personalization/emotion-tone.js";
import { runPlanExecuteLoop, type PlanExecuteLoopResult } from "../agent/plan-execute-loop.js";
import { InboxService } from "../services/inbox-service.js";
import { setBudgetAlertSink } from "../services/llm-budget-guard.js";
import { ProactiveContactPolicyService } from "../services/proactive-contact-policy.js";
import { setCapabilityCortex } from "../agent/agent-capabilities.js";
// 主动性多元化模块（ProactivityHub）+ 节律感知（RhythmCore）+ 统一主动性管道
import { ProactivityHub } from "../proactivity/proactivity-hub.js";
import { InterestWatcher } from "../proactivity/interest-watcher.js";
import { ProactivitySuppressionStore } from "../proactivity/suppression-store.js";
import { FrequencyGovernor } from "../proactivity/frequency-governor.js";
import { PresenceService } from "../proactivity/presence-service.js";
import { ProactiveDeliveryService } from "../proactivity/delivery-service.js";
import { AgentActivityStore } from "../proactivity/activity-store.js";
import { AttentionStore } from "../proactivity/attention-store.js";
import { ReachRouter, type ReachChannelDeps } from "../proactivity/reach-router.js";
import { OutcomeStore } from "../proactivity/outcome-store.js";
import { TopicDismissTracker } from "../proactivity/topic-dismiss-tracker.js";
// ─── 五层主动性架构（传感→评估→仲裁→目标→表达）───
import { SensorKernel, registerFeeder } from "../proactivity/sensors/kernel.js";
import type { Signal } from "../proactivity/sensors/types.js";
import { ScreenFocusSensor } from "../rhythm/sensors/screen-focus-sensor.js";
import { ScreenSensor } from "../proactivity/sensors/screen-sensor.js";
import { FileWatcherSensor } from "../proactivity/sensors/file-watcher.js";
import { ClipboardSensor, isClipboardSensorEnabled } from "../proactivity/sensors/clipboard-sensor.js";
import { registerPerceptionOverviewTool } from "../tools/perception-tools.js";
import { ScheduleSensor } from "../proactivity/sensors/schedule-sensor.js";
// 外部信源收编（2026-10-10）：邮件/日历/财务 → ProactiveSensor 适配器
import { MailSensor } from "../proactivity/sensors/mail-sensor.js";
import { IcsSensor } from "../proactivity/sensors/ics-sensor.js";
import { FinanceSensor } from "../proactivity/sensors/finance-sensor.js";
import { SourceStore } from "../proactivity/source-store.js";
import { ArbiterV2 } from "../proactivity/arbiter-v2.js";
import {
  appendEventAudit,
  MappingExecutor,
  type EventAuditRecord,
} from "../proactivity/mapping-executor.js";
import { buildBoardRules } from "../proactivity/mapping-rules.js";
import { WorldBoard, bridgeSensorKernelToBoard } from "../proactivity/world-board.js";
import { deriveOrderSignal } from "../proactivity/shopping-signal.js";
import { registerOrderStatusTools } from "../tools/shopping-tools.js";
import { TurnAsideQueue } from "../proactivity/turn-aside-queue.js";
import { formatCurrentStatePrompt } from "../agent/current-state-prompt.js";
import { resolveAutoMailAccount } from "../proactivity/auto-mail-account.js";

/** 读 ndjson 尾部 N 行（P3 自诊断用；文件缺失/损坏返回空） */
function readNdjsonTail(path: string, maxLines: number): unknown[] {
  try {
    if (!existsSync(path)) return [];
    const raw = readFileSync(path, "utf8");
    const lines = raw.trim().split("\n");
    const out: unknown[] = [];
    for (const line of lines.slice(-maxLines)) {
      try {
        out.push(JSON.parse(line));
      } catch {
        /* 跳过半行 */
      }
    }
    return out;
  } catch {
    return [];
  }
}
import { GoalBoard } from "../proactivity/goal-board.js";
import { GoalPlanner } from "../proactivity/goal-planner.js";
import { GoalRunner } from "../proactivity/goal-runner.js";
import { GoalIntrospector } from "../proactivity/goal-introspector.js";
import { GoalNightlyJob, createGoalSemanticVerifier } from "../proactivity/goal-nightly.js";
import { buildGoalCostReport } from "../proactivity/goal-cost.js";
import { buildUnifiedGoalView } from "../proactivity/goal-unified-view.js";
import { GoalSignalBridge, adjustImportanceByGoalRelation, appendGoalHint } from "../proactivity/goal-signal-bridge.js";
import { DiscoveryLayer, primarySubjectOf } from "../proactivity/discovery-layer.js";
import { AuditTrailService } from "../proactivity/audit-timeline.js";
import { ProactiveCaller, type CallOutcome } from "../proactivity/proactive-caller.js";
import { fabricSelftest } from "../proactivity/selftest.js";
import { CostCalibrator } from "../proactivity/cost-calibrator.js";
import { MessageWatchTrigger } from "../proactivity/triggers/message-watch-trigger.js";
import { SpeechPolisher } from "../proactivity/speech-polisher.js";
import { MobilePushService } from "../proactivity/mobile-push-service.js";
import { AlarmClockService } from "../services/alarm-clock/alarm-clock-service.js";
import { registerAlarmRoutes } from "../routes/http/alarms.js";
import { ProactivePipeline } from "../proactivity/proactive-pipeline.js";
import { SilenceLog } from "../proactivity/silence-log.js";
import { PendingConfirmationStore } from "../proactivity/pending-confirmation-store.js";
import { CommitmentTrigger, sendCommitmentNudge } from "../proactivity/triggers/commitment-trigger.js";
import { PreferenceChangeTrigger } from "../proactivity/triggers/preference-change-trigger.js";
import type { ProactiveImportance, ProactiveProposal } from "../proactivity/pipeline-types.js";
import { registerInterestWatchTools } from "../tools/interest-watch-tools.js";
import {
  registerProactivityConfirmTools,
  registerProactivityFeedbackTools,
} from "../tools/proactivity-feedback-tools.js";
import { registerAgentTasksTools } from "../tools/agent-tasks-tools.js";
import { registerRhythmReminderTools } from "../tools/rhythm-reminder-tools.js";
import {
  ConsumptionLedgerListener,
  isConsumptionTool,
  summarizeToolPayload,
} from "../services/consumption-ledger-listener.js";
import { fetchHotRankings } from "../services/hot-rankings.js";
import { RhythmCore } from "../body/rhythm-core.js";
import { UserProfileStore } from "../services/user-personalization/user-profile-store.js";

export async function createAppServices(): Promise<AppServices> {
  const app = Fastify({ logger: true });
  await app.register(cors, {
    origin: true,
    credentials: true,
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
  });
  await registerHttpRateLimit(app, getHttpRateLimitRuntime());
  await app.register(websocket);
  await app.register(multipart, { limits: { fileSize: 500 * 1024 * 1024 } });

  const sessionService = new SessionService();
  // 启动期并行化：把无相互依赖的持久化 load / MCP 工具发现收集为并行任务，
  // 在首次使用其结果之前统一等待，避免各文件 IO 串行累加启动耗时。
  const bootLoads: Promise<unknown>[] = [];
  bootLoads.push(getChatThreadPersistence().load());
  // 滚动摘要增强器：trim 丢弃历史消息时，LLM 增量生成高质量 recap（模拟人类记忆，保留原意）。
  // 未配置任何 provider 密钥时返回 null（仅保留已有 recap 行，不影响对话主链路）。
  getChatThreadStore().setRecapSummarizer(createLlmRollingRecapSummarizer());
  const scheduleTaskService = new ScheduleTaskService();
  // 用户作息偏好（分级提醒的冷启动习惯源）：顶层初始化，与 brain 开关解耦——
  // 设置接口 / 对话自述捕获在任何形态下都可用；habit provider 在 brain 块内装配。
  initScheduleHabitStore();
  // 在场足迹：作息由 agent 观察「用户何时在线」得出（工具调用 / 对话 / 设备上下线打点），
  // 顶层初始化，与 brain 开关解耦——打点在任何形态下都要生效，否则观察链断供。
  initPresenceFootprintStore();
  // 日程冲突检测 + 预订↔日程联动桥（程序层能力，LLM 只负责转述）
  const scheduleConflictService = new ScheduleConflictService(scheduleTaskService);
  const scheduleBookingBridge = new ScheduleBookingBridge(scheduleTaskService, scheduleConflictService);
  const weatherService = new WeatherService();
  const weatherPrefsService = new WeatherPrefsService();
  const infoHubService = new InfoHubService();
  const browserSessionService = new BrowserSessionService();
  const upstreamSearchService = new UpstreamSearchService(infoHubService);
  const videoGrabService = new VideoGrabService();
  setVideoGrabServiceRef(videoGrabService);
  const internetIntelligenceService = new InternetIntelligenceService({
    search: upstreamSearchService,
    pages: infoHubService,
    weather: weatherService,
  });
  const realFundsWallet = new RealFundsWalletService();
  const paymentService = new PaymentService();
  const meituanService = new MeituanService();
  const alipayBotService = new AlipayBotService();
  // 商家下单服务：从 data/merchants.json 加载商家目录，按意图路由商家并桥接支付宝下单→支付短链
  const merchantOrderService = new MerchantOrderService(
    process.env.MERCHANT_REGISTRY_FILE ?? join(process.cwd(), "data", "merchants.json"),
    alipayBotService,
  );
  bootLoads.push(merchantOrderService.load());
  const auditService = new AuditService();
  const computeQuotaService = new ComputeQuotaService();
  const companionService = new CompanionService();
  const agentMemorySyncService = new AgentMemorySyncService();
  const unifiedIdempotencyService = new UnifiedIdempotencyService();
  const toolRegistry = new ToolRegistry();
  const lifeSignalHubService = new LifeSignalHubService(
    join(process.cwd(), "data", "life-signals.json"),
  );
  bootLoads.push(lifeSignalHubService.load());
  const anticipationEngineService = new AnticipationEngineService(
    join(process.cwd(), "data", "anticipation-candidates.json"),
  );
  bootLoads.push(anticipationEngineService.load());
  const marketSignalService = new MarketSignalService(lifeSignalHubService);
  const desktopPresenceSignalService = new DesktopPresenceSignalService(lifeSignalHubService);
  const messageHubService = new MessageHubService(join(process.cwd(), "data", "message-hub.json"));
  bootLoads.push(messageHubService.load());
  // 订单信号派生（2026-10-19 handoff 数据源半边）：手机通知捕捉里命中订单词的
  // （美团/饿了么/骑手/已送达…），派生成 shopping 流信号喂进 SensorKernel →
  // 跨源采集库。emit 闭包晚绑定（sensorKernel 在下方才创建）；查询面是
  // order.status 工具（tools/shopping-tools.ts）。
  let emitShoppingOrder:
    | ((signal: Omit<import("../proactivity/sensors/types.js").Signal, "stream">) => void)
    | null = null;
  messageHubService.onInbound = (input, message) => {
    if (!emitShoppingOrder) return;
    const signal = deriveOrderSignal({
      actorId: input.actorId,
      platform: String(input.platform ?? ""),
      title: input.title ?? "",
      text: message.text ?? input.text ?? "",
    });
    if (signal) emitShoppingOrder(signal);
  };
  const messagePlatformGateway = new MessagePlatformGateway();

  const skillManager = new SkillManager();
  skillManager.configureEnabledPersistence(join(process.cwd(), "data", "skill-enabled.json"));
  // 自我进化技能（code + procedural）磁盘持久化目录：跨重启恢复"越用越强"的技能
  skillManager.configureEvolvedSkillsDir(join(process.cwd(), "data", "skills-evolved"));
  skillManager.configureProceduralSkillsDir(join(process.cwd(), "data", "skills"));
  // SkillCurator 质量巡检：每小时归档长期未使用的 procedural 技能（磁盘保留，不物理删除）
  const curatorTimer = setInterval(() => {
    try {
      skillManager.runCuratorGrooming();
    } catch (e) {
      console.warn("[SkillCurator] 巡检异常:", e);
    }
  }, 60 * 60 * 1000);
  if (typeof curatorTimer.unref === "function") curatorTimer.unref();
  const skillMetadataValidator = {
    validateMetadata(metadata: unknown) {
      return SkillValidator.validateMetadata(metadata as SkillMetadata);
    },
  };
  bootLoads.push(loadPersistedCommunitySkills(skillManager));
  toolRegistry.setSkillManager(skillManager);
  // 工具超时预算 ← 技能声明（2026-10-12）：把 `SkillMetadata.timeoutMs` 接进工具循环的
  // 超时解析，作为**下界**（工具的通用兜底档/30s 默认值不得把它吃掉）。
  // 事故背景：声明此前只被 skill-sandbox 消费，实盘量出 10 个技能声明 30~120s 全被
  // 30s 钳住（travel.plan-itinerary 声明 120s / 实测 57s → 被击杀 → 行程卡整轮缺席）。
  // 接上之后，新增慢工具只需在技能里声明 timeoutMs，不必再改工具循环。
  setDeclaredSkillTimeoutResolver(declaredSkillTimeoutFromManager(skillManager));
  // 技能管理工具（skill.list / skill.view / skill.manage）：让 LLM 自主查询/沉淀/修补 procedural 技能
  registerSkillManageTools(toolRegistry, skillManager);

  registerWebTools(toolRegistry, infoHubService, upstreamSearchService, videoGrabService);
  registerVideoTools(toolRegistry, videoGrabService, upstreamSearchService);
  registerInternetIntelligenceTools(toolRegistry, internetIntelligenceService);
  registerHttpTools(toolRegistry);

  // ========== MCP 客户端服务 ==========
  const mcpClientService = new McpClientService();
  // MCP 工具发现会 spawn 子进程 / 调 mcporter CLI，可能耗时（单 server 15s 超时），
  // 与上面的持久化 load 并行启动，避免串行阻塞。
  const mcpDiscoverTask = mcpClientService.listServers().length > 0
    ? mcpClientService.discoverTools()
    : Promise.resolve();
  // 统一等待全部启动期异步任务（MCP 工具注册依赖 discover 结果）
  await Promise.all([...bootLoads, mcpDiscoverTask]);
  // video.grab 的抖音/小红书适配器优先经 McpClientService 直连 yby6（mcporter CLI 生产机不可用）
  setVideoGrabMcpClientRef(mcpClientService);
  const mcpToolCount = mcpClientService.listTools().length;
  if (mcpToolCount > 0) {
    registerMcpTools(toolRegistry, mcpClientService);
    setMcpChatTools(buildMcpChatTools(mcpClientService));
    app.log.info(`[MCP] 已发现并注册 ${mcpToolCount} 个 MCP 工具（${mcpClientService.listServers().map(s => s.alias).join(", ")}）`);
  } else if (mcpClientService.listServers().length > 0) {
    app.log.info("[MCP] 已配置 server 但未发现可用工具，请确认 mcporter 中已正确配置 server alias");
  } else {
    app.log.info("[MCP] 未配置 MCP Server（可通过 data/mcp-servers.json 或 MCP_SERVERS 环境变量配置）");
  }

  registerBrowserTools(toolRegistry, browserSessionService);
  registerClockTools(toolRegistry);
  registerWeatherTools(toolRegistry, weatherService);
  registerCareReminderTools(toolRegistry, {
    agentMemorySyncService,
    scheduleTaskService,
  });
  registerLifeSignalTools(toolRegistry, lifeSignalHubService);
  registerMarketSignalTools(toolRegistry, marketSignalService);
  let messageBridgeService: MessageBridgeService;

  const agentRelayService = new AgentRelayService();
  const wsConnectionRegistry = new WsConnectionRegistry();
  // 客户端版本更新推送（2026-10-21）：配了 UPDATE_MANIFEST_SOURCE_URL 才启用——
  // 云端版（腾讯机）与 byok 本地 runtime 各自从更新控制面拉清单、变化沿 wss 广播
  startClientUpdatePusher(wsConnectionRegistry);
  const embodimentAutonomy = new EmbodimentAutonomyService(wsConnectionRegistry);
  initEmbodimentAutonomy(embodimentAutonomy);

  scheduleTaskService.setWeatherBriefHandler(async (task) => {
    const prefs = weatherPrefsService.get(task.sessionId);
    if (!prefs) {
      return { type: "weather_brief", ok: false, error: "未保存天气位置偏好，请在客户端保存定位后再试" };
    }
    const brief = await weatherService.getBrief(
      prefs.latitude,
      prefs.longitude,
      prefs.timezone || task.timezone,
      prefs.label,
    );
    const message = `${brief.summaryLine} 穿衣建议：${brief.clothingAdvice}`;
    wsConnectionRegistry.trySend(
      task.sessionId,
      JSON.stringify({
        type: ServerEventType.WeatherBrief,
        payload: { taskId: task.taskId, message, brief },
      }),
    );
    return {
      type: "weather_brief",
      ok: true,
      title: task.title,
      message,
      brief,
    };
  });
  const agentPairingService = new AgentPairingService();
  const ttsService = new TtsService();
  const virtualPhoneService = new VirtualPhoneService(ttsService, wsConnectionRegistry);

  // 初始化语音对话服务（ASR + LLM + TTS 抽象层）
  const voiceDialogueService = new VoiceDialogueService();

  // ASR Adapter：FunASR 自托管（中文最佳）
  const funasrAdapter = new FunAsrAdapter();

  // 注册 OpenAI provider（默认）
  const openaiLLMAdapter = new OpenAILLMAdapter();
  voiceDialogueService.registerProvider("openai", {
    asr: funasrAdapter,
    tts: new OpenAITTSAdapter(ttsService),
    llm: openaiLLMAdapter,
  });
  // 零配置启动门禁：byok 捆绑形态下用户首启还没填 key，这里必须能过——
  // 否则服务在装配期就 abort，3000 从不监听，客户端只能「界面能开但连不上」。
  if (!openaiLLMAdapter.isConfigured()) {
    app.log.warn(
      "[VoiceDialogue] 未配置 OPENAI_API_KEY —— 语音通话的 LLM 暂不可用" +
        "（服务已降级，不影响其它能力）；在「设置-模型服务」填入 key 后重启 runtime 即恢复。",
    );
  }

  // 注册 MiniMax TTS provider（speech-2.5，中文拟真度最佳，优先使用）
  const minimaxTTS = new MiniMaxTTSAdapter();
  if (minimaxTTS.isEnabled()) {
    voiceDialogueService.registerProvider("minimax", {
      asr: funasrAdapter, // ASR 走 FunASR
      tts: minimaxTTS,
      llm: new OpenAILLMAdapter(),
    });
    voiceDialogueService.setDefaultProvider("minimax");
    app.log.info(
      `[VoiceDialogue] MiniMax TTS 已启用，设为默认提供商（ASR：${funasrAdapter.name}）`,
    );
  }

  if (!minimaxTTS.isEnabled()) {
    app.log.info("[VoiceDialogue] MiniMax TTS 未配置，语音对话使用 OpenAI 作为默认提供商");
    voiceDialogueService.setDefaultProvider("openai");
  }

  // FunASR 自托管 ASR 优先（中文识别效果优于 whisper）
  if (funasrAdapter.isEnabled()) {
    app.log.info(
      `[VoiceDialogue] FunASR 已启用（${process.env.FUNASR_BASE_URL}），中文 ASR 走 FunASR`,
    );
  }

  // 初始化 Agent 底层语音能力中枢（TTS + ASR + WS 推送）。
  // 作为 Agent 的底层能力，被 voice.speak 工具、智能提醒、主动消息等场景统一调度。
  const voiceMessageService = new VoiceMessageService();
  voiceMessageService.setTtsService(ttsService);
  // 初始化图像生成能力服务（OpenAI 兼容 text-to-image，下载到本地静态目录）。
  // 与语音消息同模式：独立目录 data/images/{actorId}/{imageId}.png，HTTP 走 /agent/images。
  const imageGenerationService = new ImageGenerationService();
  upstreamSearchService.setImageStorageService(imageGenerationService);
  // 初始化文件/文档处理能力服务（read/write/parse_pdf/parse_office/export_format）。
  // 独立目录 data/user-files/{actorId}/{fileName}，HTTP 走 /agent/files。
  const fileProcessingService = new FileProcessingService();
  // 初始化邮件/短信主动发送服务（SMTP + 阿里云短信，凭证从环境变量读取）。
  const emailSmsService = new EmailSmsService();
  // 邮箱所有权验证码（OTP）：注册/登录前向自报邮箱发码证明所有权；
  // 凭据复用 emailSmsService 的 OUTBOUND_SMTP_*（未配置时 OTP 闸不生效）。
  const emailOtpService = new EmailOtpService();
  // 初始化媒体音乐服务（搜索 + WS 推送播放控制事件）。
  // 登录音源（2026-09-18）：注入浏览器会话库——用户导入 music.163.com Cookie 并授权后，
  // 播放 URL 解析带用户身份（VIP 曲目用其会员权益）；无会话自动回退匿名。
  const mediaMusicService = new MediaMusicService(wsConnectionRegistry, undefined, browserSessionService);
  // 初始化健康/运动数据服务（data/health/{actorId}.json，1s 防抖落盘）。
  const healthFitnessService = new HealthFitnessService(join(process.cwd(), "data", "health"));
  // 初始化财务深度服务（data/finance/{actorId}/{transactions,budgets}.json + reports/）。
  const financeDeepService = new FinanceDeepService(join(process.cwd(), "data", "finance"));
  // 初始化订阅盘点服务（财务管家 P0：候选检测/确认/使用率/续费前提醒，
  // 与账本同目录 subscriptions.json，懒加载 + 写穿）。
  const subscriptionAuditService = new SubscriptionAuditService({
    financeDeepService,
  });
  // 初始化账单管理服务（订阅与财务清理：账单追踪/到期提醒/缴费入账联动预算，
  // 与账本同目录 bills.json，懒加载 + 写穿）。
  const billManagementService = new BillManagementService({
    financeDeepService,
  });
  // 初始化社交主动出击服务（Twitter OAuth 1.0a + 微博 + 小红书/朋友圈占位，凭证从环境变量读取）。
  const socialOutreachService = new SocialOutreachService();
  // 初始化代码执行沙盒服务（python/node 子进程，独立工作目录 data/sandbox/{actorId}/{workspaceId}/）。
  const codeSandboxService = new CodeSandboxService();
  // 初始化购物/下单服务（页面执行：内置浏览器优先 + 无头兜底 + 扫码登录门）。
  // 本地订单表 data/shopping/orders.json（单日预算统计依据）+ 支付宝钱包通道（收银台代付）。
  const shoppingOrderStore = new ShoppingOrderStore(join(process.cwd(), "data", "shopping", "orders.json"));
  // 共用浏览器桥：用户与 Agent 共用客户端内嵌浏览器（WebView2）。
  // Agent 的 shared_browser.* 动作经此转发到用户正在看的浏览器执行；
  // 所有 invoke/失败写审计（AuditService）。
  const sharedBrowserCoordinator = new SharedBrowserCoordinator(auditService);
  // 可信输入网关（CDP 桥）：总开关 SHARED_BROWSER_CDP_ENABLED（默认关）；
  // 客户端显式开启调试端口并上报端点后，trusted 工具用 Playwright 直连用户浏览器。
  const sharedBrowserCdpGateway = new SharedBrowserCdpGateway();
  // 购物页面获取器：客户端在线且开启调试端口时优先在用户可见内置浏览器执行
  // （登录态即用户自身，免 Cookie 导入）；否则回退无头 + Cookie；支持扫码登录门。
  const shoppingBrowserExecutor = new ShoppingBrowserExecutor({
    coordinator: sharedBrowserCoordinator,
    gateway: sharedBrowserCdpGateway,
    browserSessionService,
  });
  const shoppingOrderService = new ShoppingOrderService({
    browserSessionService,
    audit: auditService,
    store: shoppingOrderStore,
    alipayBot: alipayBotService,
    browserExecutor: shoppingBrowserExecutor,
    imageStore: imageGenerationService,
  });
  // 初始化购物比价服务（跨平台同款比价 + 降价监控 + 保险/服务调研对比，只读零副作用）。
  // 到价推送 onPriceAlert 在 ProactivityHub 装配段经 setOnPriceAlert 晚接线。
  // 联盟网关单例：比价线与推荐实时聚合线（shopping.suggest 库未命中兜底）共用。
  const officialPriceGateway = new OfficialPriceGateway();
  const shoppingCompareService = new ShoppingCompareService({
    shoppingOrderService,
    upstreamSearchService,
    officialPriceGateway,
    dataDir: join(process.cwd(), "data", "shopping"),
  });
  // 初始化 Agent 虚拟浏览器服务（有状态会话池，通用网页多步操作：open/click/type/scroll/screenshot/extract_text/wait_for/close）。
  // open 撞白名单站点登录页时，经 QrAssistService 自动把登录二维码推到聊天。
  const agentBrowserService = new AgentBrowserService({
    browserSessionService,
    audit: auditService,
    qrAssist: new QrAssistService({ imageStore: imageGenerationService }),
  });
  // 共用浏览器桥（sharedBrowserCoordinator / sharedBrowserCdpGateway）已提前到
  // shopping-order 装配段创建：购物页面获取器（内置浏览器优先）复用同一实例。
  // 初始化统一预订服务（方案 A：网约车/家政/餐厅共用编排——两阶段确认 +
  // 单笔/单日限额 + 订单落库 + 承诺板跟踪；Provider 按 BOOKING_MODE 组装）。
  // 承诺板在下方 agentic-memory 装配段构造后经 setCommitmentBoard 注入。
  const bookingConfig = getBookingConfig();
  // 实时报价比价抽象层：local 价格库保底 + 飞猪 FlyAI CLI 实时源（酒店/机票，
  // 装 flyai CLI 即出价：npm i -g @fly-ai/flyai-cli）+ 浏览器代查源（携程机票）。
  // 源可用性由各自 fetch 内部判定（CLI 未装 / Playwright 未装都如实返回错误），
  // 聚合器汇总，故这里无条件挂载。
  const quoteAggregator = buildQuoteAggregator({
    browserRunner: agentBrowserService,
  });
  const bookingProviders = buildDefaultBookingProviders(bookingConfig, {
    quoteAggregator,
    // 滴滴官方 MCP 桥接（travel-upgrade-plan P2）：接驳下单真实走滴滴
    mcpClient: mcpClientService,
  });
  const bookingOrderStore = new BookingOrderStore(join(process.cwd(), "data", "booking", "orders.json"));
  // 行后旅行回忆录（travel 双端⑦）：订单库/账本服务在这里注入真实实例
  // （travel-map 路由经 travelMemoir 单例取用，避免同文件双实例读写不一致）
  travelMemoir.configure({
    travelPlanStore,
    bookingOrderStore,
    financeDeepService,
  });
  const bookingService = new BookingService({
    providers: bookingProviders,
    store: bookingOrderStore,
    audit: auditService,
    config: bookingConfig,
  });
  app.log.info(
    `[Booking] 统一预订层已启用（mode=${bookingConfig.mode}，providers=[${bookingProviders.map((p) => `${p.key}:${p.domain}`).join(",")}]，限额 ¥${bookingConfig.maxAmountCny}/单、¥${bookingConfig.dailyBudgetCny}/日）`,
  );
  const voiceCapabilityService = new VoiceCapabilityService({
    ttsService,
    voiceDialogueService,
    wsRegistry: wsConnectionRegistry,
    voiceMessageService,
    logger: app.log,
  });
  if (voiceCapabilityService.getCapabilityInfo().ttsEnabled) {
    app.log.info(
      `[VoiceCapability] 已启用（TTS 提供商：${voiceCapabilityService.getCapabilityInfo().ttsProvider}）`,
    );
  } else {
    app.log.warn("[VoiceCapability] TTS 未启用，voice.speak 工具将仅推送文本兜底");
  }

  // 初始化手机桥接协调器（须在智能提醒系统之前，供其调度 phone.ring）
  const phoneBridgeCoordinator = new PhoneBridgeCoordinator({
    onSync: (actorId, payload) => {
      wsConnectionRegistry.trySend(
        actorId,
        JSON.stringify({ type: ServerEventType.PhoneBridgeSync, payload }),
      );
    },
  });
  registerPhoneBridgeTools(toolRegistry, { bridge: phoneBridgeCoordinator });
  // messages.reply 的 sms 平台经手机桥真发（SmsManager + 手机确认窗）
  messagePlatformGateway.setPhoneBridgeSender({
    hasExecutor: (actorId) => phoneBridgeCoordinator.hasExecutor(actorId),
    invoke: (actorId, action, params) => phoneBridgeCoordinator.invoke(actorId, action, params),
  });

  // 电话代办协调器（phone_call.* 工具族）：agent 代用户向第三方真人拨真实电话。
  // 默认 PHONE_CALL_ENABLED=false（工具对 LLM 不可见）；确认门权威证据在
  // connection.ts 的 chat.user_action 原点记录。站内信回执在 inboxService
  // 构造后经 setInbox 晚绑定（见下方装配段）。
  const phoneCallCoordinator = new PhoneCallCoordinator({
    bridge: {
      hasExecutor: (actorId) => phoneBridgeCoordinator.hasExecutor(actorId),
      invoke: (actorId, action, params, timeoutMs) =>
        phoneBridgeCoordinator.invoke(actorId, action, params, timeoutMs),
    },
    pushPort: {
      trySend: (actorId, data) => wsConnectionRegistry.trySend(actorId, data),
    },
    audit: auditService,
    logger: {
      info: (msg) => app.log.info(msg),
      warn: (msg) => app.log.warn(msg),
    },
  });

  // 初始化智能提醒系统（弹窗 → TTS闹钟 → 电话呼叫 三级升级链）
  const intelligentReminder = createIntelligentReminderSystem({
    toolRegistry,
    virtualPhoneService,
    phoneBridgeCoordinator,
    voiceDialogueService,
    voiceCapabilityService,
    sendToClient: async (userId, payload) => {
      await wsConnectionRegistry.trySend(userId, JSON.stringify(payload));
    },
    // 设备分级触达（2026-09-18）：按连接登记的 deviceClass 区分电脑端/移动端，
    // 两端全离线时升级链直达 推送→短信→微信 离线必达，不再假装 WS 弹窗成功
    getDevicePresence: (userId) => ({
      desktopOnline: wsConnectionRegistry.hasDeviceClass(userId, "desktop"),
      mobileOnline: wsConnectionRegistry.hasDeviceClass(userId, "mobile"),
    }),
    // 离线必达主力：手机系统级推送（proactivePushService 在下方装配段创建，
    // 回调在提醒触发时才执行，届时必已初始化）
    offlinePush: (input) => proactivePushService.push(input),
    // 离线末级兜底：真实短信。收件人取 REMINDER_SMS_TO（私人管家单主人场景）；
    // 号码未配置或阿里云 SMS 凭证不齐时如实失败，链路继续落微信/站内信
    offlineSms: async (_userId, text) => {
      const to = (process.env.REMINDER_SMS_TO ?? "").trim();
      if (!to || !emailSmsService.isSmsEnabled()) {
        return { ok: false, reason: "sms_not_configured" };
      }
      return emailSmsService.sendSms({ to, text, templateParams: JSON.stringify({ content: text }) });
    },
    // 升级链持久化：提醒实例与升级计时落盘，重启后恢复并补升级（此前重启即蒸发）
    statePath: join(process.cwd(), "data", "intelligent-reminder", "active-reminders.json"),
    onContactOutcome: (params) => {
      const channel =
        params.channel === "popup"
          ? "websocket"
          : params.channel === "tts_alarm"
            ? "voice"
            : "phone_call";
      userPersonalizationService.observeContactOutcome(params.userId, {
        channel,
        responded: params.responded,
        responseTimeMs: params.responseTimeMs,
        feedback: params.feedback,
        quietHours: params.quietHours,
      });
    },
    logger: app.log,
  });
  await intelligentReminder.userResponsePersistence.load();
  // 恢复重启前残留的升级链（错过升级时刻的提醒立即补升级）
  const restoredReminders = await intelligentReminder.reminderService.load();
  if (restoredReminders > 0) {
    app.log.info(`[reminder] 已从磁盘恢复 ${restoredReminders} 条提醒实例（含升级计时）`);
  }

  scheduleTaskService.setTaskChangeHandler(async (action, task) => {
    notifyScheduleTasksChanged(
      wsConnectionRegistry,
      action === "deleted"
        ? scheduleWsPayloadDeleted(task.sessionId, task.taskId)
        : scheduleWsPayloadFromTask(task, action),
    );
  });

  // 统一主动性管道（docs/proactivity-architecture.md）：到点提醒的离线必达晚绑定回调。
  // 管道在下方装配段创建后注入；在线时 ScheduleReminderFired 原生弹窗即唯一触达
  // （不再叠加 LLM 话术第二条消息——省一次 LLM 调用且不重复打扰）。
  let onReminderOfflineToPipeline:
    | ((
        taskId: string,
        sessionId: string,
        title: string,
        message: string,
        runAt: string,
        preReminder: boolean,
      ) => void)
    | undefined;
  scheduleTaskService.setReminderHandler(async (task, message, options) => {
    const displayMessage = formatReminderDisplayMessage(message);
    // 到点提醒 vs 提前量预告：客户端据此分流（岛默认短档 / 岛长驻留档；
    // 2026-10-05 定调提醒统一归灵动岛，桌面弹窗退役为纯决策出口）。
    // 预告段无 task.title 时给出段名，避免岛上只有泛化「提醒」。
    const preReminder = options?.preReminder === true;
    const wsDelivered = wsConnectionRegistry.trySend(
      task.sessionId,
      JSON.stringify({
        type: ServerEventType.ScheduleReminderFired,
        payload: {
          taskId: task.taskId,
          title: task.title,
          shortTitle: task.shortTitle,
          message: displayMessage,
          reminderMessage: message,
          preReminder,
          recurrence: task.recurrence,
          status: task.status,
          nextRunAt: task.nextRunAt,
        },
      }),
    );
    if (wsDelivered) {
      embodimentAlert(
        task.sessionId,
        (json) => wsConnectionRegistry.trySend(task.sessionId, json),
        displayMessage,
        "schedule.reminder_fired",
      );
    }
    // 手机端不在场（2026-10-13 根修「桌面在线 → 手机错过到点提醒」）：
    // WS 全端 fan-out 任一端在线即算送达的旧语义，会让桌面在线时手机端
    // （后台断连/被杀）永远收不到。手机不在线就补挂一条只面向手机端的
    // 管道提案（定向投递）：手机重连即直推，或升级手机系统推送——桌面
    // 已收到的 reminder_fired 不抵扣手机，也不会吃重复通知。
    if (!wsConnectionRegistry.hasDeviceClass(task.sessionId, "mobile")) {
      onReminderOfflineToPipeline?.(
        task.taskId,
        task.sessionId,
        task.title ?? "",
        displayMessage,
        task.nextRunAt ?? task.runAt,
        preReminder,
      );
    } else if (!wsDelivered) {
      // 手机在线但 fan-out 竞态失败：维持原离线管道兜底
      onReminderOfflineToPipeline?.(
        task.taskId,
        task.sessionId,
        task.title ?? "",
        displayMessage,
        task.nextRunAt ?? task.runAt,
        preReminder,
      );
    }
    // 不再根据"起床/叫醒"等关键词自动拨打电话
    // 日程提醒应仅通过 WebSocket 推送 + embodimentAlert 通知用户
    // 如需电话提醒，用户应显式使用 phone.call_user 工具
  });

  const aipService = new AipService(agentRelayService, wsConnectionRegistry, agentPairingService, auditService);
  const agentAccountService = new AgentAccountService();
  const emailRegistrationService = new EmailRegistrationService();
  // 内测注册白名单（HTTP 注册闸用；名单文件热读，后台改完即生效）
  const betaWhitelistService = new BetaWhitelistService();
  // 内测自助通道：候补申请队列（登录页排队→后台批量审批）+ 邀请码（登录页填码过闸）
  const betaWaitlistService = new BetaWaitlistService();
  const betaInviteService = new BetaInviteService();
  const friendService = new FriendService();
  // 站内好友消息统一投递内核（2026-10-15 闭环）：world.link.send_message / messages.reply
  // (friend) / HTTP /friends/messages 三出口共用；hub 持久落库解决离线必达。
  const friendMessageService = new FriendMessageService({
    hub: messageHubService,
    relay: agentRelayService,
    wsRegistry: wsConnectionRegistry,
    accounts: agentAccountService,
    friends: friendService,
  });
  // 财务入站记账服务（构造提前到 skill 注册之前；LLM/推送回调由装配层后置注入）。
  const financeIngestService = new FinanceIngestService({
    financeDeepService,
    agentAccountService,
  });

  // 加载持久化数据
  await Promise.all([
    scheduleTaskService.load(),
    companionService.load(),
    agentPairingService.load(),
    agentAccountService.load(),
    emailRegistrationService.load(),
    friendService.load(),
    virtualPhoneService.load(),
  ]).catch((err) => {
    app.log.error({ err }, "Failed to load persisted data");
  });
  
  registerWalletTools(toolRegistry, friendService);
  registerPaymentTools(toolRegistry, paymentService, new QrAssistService({ imageStore: imageGenerationService }));
  registerMeituanTools(toolRegistry, meituanService);
  // 版本闸（NEXTBOT_EDITION=oss 开源版剔除）：中继/虚拟电话工具族
  // （好友联络工具族 registerAgentLinkTools 在 worldService 创建后注册——加好友门禁用世界身份）
  if (!isOssEdition()) {
    registerAgentRelayTools(
      toolRegistry,
      friendMessageService,
      agentPairingService,
      agentAccountService,
    );
    registerAgentPhoneTools(toolRegistry, virtualPhoneService);
  }
  registerAgentVoiceTools(toolRegistry, voiceCapabilityService, voiceMessageService);
  // Surface-on-Demand：LLM 可召唤客户端信息面板（语音模式"念+显"双通道）
  registerSurfaceTools(toolRegistry, {
    trySend: (actorId, data) => wsConnectionRegistry.trySend(actorId, data),
  });
  // task.dispatch（2026-09-05 前后台架构）：前台派后台任务原语。launch 晚绑定——
  // 工具注册发生在 registry 装配期（agentCore 尚未创建），agentCore 就绪后接上。
  const taskDispatchLauncherRef: {
    fn: ((input: {
      actorId: string;
      sessionId?: string;
      chatUserMessageId?: string;
      goal: string;
      note?: string;
    }) => string | null) | null;
  } = { fn: null };
  registerTaskDispatchTool(toolRegistry, {
    launch: (input) =>
      taskDispatchLauncherRef.fn?.(input) ??
      (() => {
        console.warn("[task.dispatch] launch 未就绪（agentCore 未初始化），拒绝派发");
        return null;
      })(),
  });
  // 任务委派闭环的对话面查询/取消原语（2026-09-19 P0-2）：task.status 零 LLM
  // 直答结构化查询、task.cancel 与客户端 chat.task_cancel 同语义（终态标记 →
  // dispatchBackgroundTask 的 isCancelled 软取消生效）。
  registerTaskPlaneTools(toolRegistry);
  // 注册能力模块（image-gen / file-doc / email-sms / ...）
  // 通过 setCapabilityModuleDeps 让 getBuiltinAgentChatTools 自动合并 ChatCompletionTool；
  // 通过 setExtraIntentRules 把模块意图元数据合并到 BM25 调权；
  // registerAllCapabilityModules 把 handler 注册到 ToolRegistry。
  // 图片能力套件(图库/解析/缩略图/存储管理),存储根 data/pictures
  const pictureKit = await createPictureKit({
    rootDir: join(process.cwd(), "data", "pictures"),
    batchOutputDir: join(process.cwd(), "data", "pictures", "batch"),
  });
  // ─── 女性关怀（M1）：生理周期关怀 + 安全守护（docs/women-care-proposal.md）───
  // 主动通知走 proactivity 管道、SOS 按需定位走位置协调器，两者都在本文件下方
  // 才创建——持懒引用，工具调用/提醒 tick 时必然已就绪（同 briefing 天气兜底模式）。
  const wellnessPipelineRef: { current: ProactivePipeline | null } = { current: null };
  const wellnessLocationRef: { current: LocationCoordinator | null } = { current: null };
  // 生理周期关怀：加密存储 data/period-care/，每分钟 tick 临近提醒
  const periodCareService = new PeriodCareService({
    dataDir: join(process.cwd(), "data", "period-care"),
    getPipeline: () => wellnessPipelineRef.current,
  });
  await periodCareService.load();
  periodCareService.start();
  // 安全守护：紧急联系人/SOS/借口来电；SOS 位置按需取一次，不持续上传不落库
  const safetyGuardService = new SafetyGuardService({
    dataDir: join(process.cwd(), "data", "safety-guard"),
    sendSms: (params) => emailSmsService.sendSms(params),
    prepareCall: (actorId, input) =>
      phoneCallCoordinator.prepare(actorId, {
        number: input.number,
        contactName: input.contactName,
        goal: input.goal,
        script: input.script,
        facts: input.facts,
      }) as Promise<Record<string, unknown>>,
    isCallEnabled: () => phoneCallCoordinator.isEnabled(),
    requestLocation: async (actorId, reason) => {
      const coordinator = wellnessLocationRef.current;
      if (!coordinator) return null;
      const live = await coordinator.requestLocation(actorId, reason);
      if (live) return live;
      return coordinator.getCachedWithTime(actorId)?.payload ?? null;
    },
    getPipeline: () => wellnessPipelineRef.current,
  });
  await safetyGuardService.load();

  const capabilityModuleDeps: CapabilityModuleDeps = {
    imageGenerationService,
    fileProcessingService,
    pictureKit,
    emailSmsService,
    mediaMusicService,
    wsConnectionRegistry,
    healthFitnessService,
    financeDeepService,
    subscriptionAuditService,
    billManagementService,
    socialOutreachService,
    codeSandboxService,
    shoppingOrderService,
    shoppingCompareService,
    agentBrowserService,
    sharedBrowserCoordinator,
    sharedBrowserCdpGateway,
    bookingService,
    phoneCallCoordinator,
    periodCareService,
    safetyGuardService,
  };
  setCapabilityModuleDeps(capabilityModuleDeps);
  // 意图规则 = 能力模块静态规则 + Feature Catalog 生活域检索词（12 域 aliases）
  setExtraIntentRules([
    ...getAllCapabilityModuleIntentRules(capabilityModuleDeps),
    ...buildCatalogIntentRules(),
  ]);
  registerAllCapabilityModules(toolRegistry, capabilityModuleDeps);
  registerAipTools(toolRegistry, aipService);
  registerProtocolUnifiedTools(toolRegistry, {
    computeQuotaService,
    agentMemorySyncService,
    auditService,
    unifiedIdempotencyService,
  });

  const worldService = new WorldService();
  // 已注册宿主账号（邮箱主体）即视为 Agent World 已注册：另一处设备登录时
  // 不得再走一遍世界注册流程（好友请求等门禁直接放行，2026-10-16）。
  worldService.setExternalRegistrationResolver(
    (actorId) => Boolean(agentAccountService.getByActorId(actorId)),
  );
  registerAgentWorldIdentityBuiltinSkills((skill) => skillManager.register(skill), {
    worldService,
    agentAccountService,
    agentMemorySyncService,
  });
  
  // 注册虚拟电话内置Skills（版本闸：开源版剔除）
  if (!isOssEdition()) {
    registerVirtualPhoneBuiltinSkills((skill) => skillManager.register(skill), {
      virtualPhoneService,
    });
  }

  // 注册支付宝 AI 支付内置Skills（真实购买能力，封装项目内置 alipay-bot CLI）
  registerAlipayPaymentBuiltinSkills((skill) => skillManager.register(skill), {
    alipayBotService,
    qrAssist: new QrAssistService({ imageStore: imageGenerationService }),
  });

  // 注册商家下单内置Skills（官方「智能体接入」模式：下单→alipay_ 短链→submit-payment 支付）
  registerMerchantOrderBuiltinSkills((skill) => skillManager.register(skill), {
    merchantOrderService,
  });

  // 注册财务管家接入内置Skills（快捷指示：开启自动记账/绑定账单邮箱/粘贴账单入账/状态）
  registerFinanceIngestBuiltinSkills((skill) => skillManager.register(skill), {
    financeIngestService,
  });

  // 注册旅游规划内置Skills（承接 3D-Travel 项目能力：规则引擎行程生成 + POI 缓存 + 目的地知识库）
  // 版本闸：开源版剔除 travel.* 技能族（服务本体保留构造——行程路由 deps / shutdown 仍引用）
  //
  // 配图主源接 upstreamSearchService（API 优先、cn.bing.com 兜底、结果转存本地 PNG）：
  // 原来只走 Wikimedia，而 commons/zh.wikipedia 在本机网络下实测 http=000，
  // 导致 POI 照片覆盖率只有 3.4%、且每个 POI 都要先白等一轮超时。这里失败也不会
  // 让配图断掉——PlanningService 内部另有一层必应直抓兜底。
  // 社交热度回填器（travel-upgrade-plan）：小红书/抖音聚合 + LLM 名单内归类。
  // llmComplete 闭包引用 externalChat（声明在下方，运行时调用时已初始化）。
  const travelHeatEnricher = new TravelHeatEnricher({
    searchXiaohongshu: (q, limit) => upstreamSearchService.searchXiaohongshu(q, limit ?? 8),
    searchDouyin: (q, limit) => upstreamSearchService.searchDouyin(q, limit ?? 8),
    llmComplete: async (prompt) => {
      if (!externalChat?.isEnabled()) return "";
      let full = "";
      await externalChat.streamCompletion(
        `travel-heat-${Date.now()}`,
        { text: prompt },
        (delta: string) => { full += delta; },
        undefined,
        // 一次性归类任务：ephemeral 不进 provider 历史、关 thinking 降延迟
        { ephemeralTurn: true, disableThinking: true, maxThreadMessages: 0 },
      );
      return full;
    },
  });
  const travelPlanningService = new TravelPlanningService(weatherService, {
    searchImages: async (query, limit) => {
      const res = await upstreamSearchService.searchImages(query, limit ?? 4, "shared-travel-img");
      return res.items
        .map((it) => it.mediaUrl)
        .filter((u): u is string => Boolean(u));
    },
  }, travelHeatEnricher);
  // 2026-10-12 用户决定下线 POI 视频能力，评论的数据来源是视频评论区（无视频即无评论），
  // 两者一并下线：searchVideos / searchReviews 端口、media 表的 video/review 行、
  // 桌面与手机端的渲染区块全部移除。媒体库只剩照片一类。
  // 若日后重启评论能力，来源得换（结构化评论源要登录态），不能直接复用这段。

  // 旅行数据维护：把媒体补全能力（照片+视频+评论）接进维护服务，
  // 并在启动后延迟跑一次存量图片本地化（把历史遗留的第三方外链抓成本机资产）。
  travelDataRefresh.setMediaFetcher((name, type, lat, lon) =>
    travelPlanningService.backfillMediaForPoi(name, type, lat, lon),
  );
  travelDataRefresh.scheduleStartupLocalize();
  // POI 打卡视频回填（travel 视频下放）：搜索走 searchVideos 三源（B站 API/Bing/社交中转），
  // 从严过滤后每景点只落 1 条播放页 URL（不下载视频文件）；PA_TRAVEL_POI_VIDEO=0 关闭
  const travelPoiVideoBackfill = new TravelPoiVideoService(
    { searchVideos: (q, limit) => upstreamSearchService.searchVideos(q, limit) },
    travelPlanStore,
  );
  if (!isOssEdition()) {
    registerTravelPlanningBuiltinSkills((skill) => skillManager.register(skill), {
      travelPlanningService,
      // 旅行画像读取口（travel-upgrade-plan 画像引擎）：闭包延迟取 userPersonalizationService
      //（声明在本调用之后，运行时才执行，TDZ 安全）；personalization 以 sessionId 为 actorId 索引
      getUserTravelProfile: (sessionId) =>
        sessionId ? userPersonalizationService.getTravelProfile(sessionId) : undefined,
      // POI 打卡视频回填（travel 视频下放）：行程落盘后后台逐景点补 1 条真实相关播放页
      poiVideoBackfill: (plan) => travelPoiVideoBackfill.backfillForPlan(plan),
    });

    // 注册出行通勤内置Skills（实时路况出发建议 + 票夹 + 打包清单；复用同一 WeatherService）
    registerTravelCommuteBuiltinSkills((skill) => skillManager.register(skill), {
      travelPlanningService,
      weatherService,
    });
  }

  const worldPartitionWsRegistry = new WorldPartitionWsRegistry();
  worldService.onWorldRevision((ev: WorldRevisionEvent) => {
    worldPartitionWsRegistry.broadcastToPartition(
      ev.partitionId,
      JSON.stringify({
        type: AgentWorldServerEventType.WorldPartitionDelta,
        payload: {
          partitionId: ev.partitionId,
          revision: ev.revision,
          state: ev.state,
        },
      }),
    );
  });
  const a2aOutsourcingService = new A2aOutsourcingService(worldService);
  const socialFeedService = new SocialFeedService(worldService);
  socialFeedService.attachWebSocketRegistry(wsConnectionRegistry);
  registerWorldOpenRegistryTools(toolRegistry, worldService);
  registerWorldRoomTools(toolRegistry, worldService);
  // ─── Agent World 社交经济域开关（AGENT_WORLD_SOCIAL_ENABLED，实验性子系统默认关闭） ───
  // 关闭时跳过社交经济域（world-free-market / world-music / world-social /
  // a2a-outsourcing / community-skill-store）的工具注册，仅保留 identity / pairing /
  // registration 最小集（open_registry + room）；HTTP 社交路由与 WS 社交事件同步跳过
  // （见 routes/http/index.ts、ws/connection.ts），LLM 工具列表走 filterSocialChatTools
  // 过滤（见 external-model/openai-compatible-tool-loop.ts）。开启后行为与现状一致。
  if (isAgentWorldSocialEnabled()) {
    registerWorldSocialTools(toolRegistry, socialFeedService);
    registerWorldFreeMarketTools(toolRegistry, worldService, a2aOutsourcingService, skillManager);
  } else {
    console.log("[skip] AgentWorld social domain disabled by ENV");
  }
  toolRegistry.setWorldService(worldService);
  // 好友联络工具族（Agent World 域 world.link.*）：门禁依赖世界身份，
  // 须在 worldService 创建（L~1264）之后注册；oss 版剔除
  if (!isOssEdition()) {
    registerAgentLinkTools(toolRegistry, friendService, agentAccountService, worldService);
  }
  // Feature Catalog：能力分类统一层（分类视图，不注册能力）。
  // build() 在全部注册完成后调用（hookBus 段首次 + onReady 二次刷新，
  // MCP 工具异步加载，onReady 时已就绪）。
  const featureCatalog = new FeatureCatalog(toolRegistry, skillManager, mcpClientService);
  registerCapabilityQueryTools(toolRegistry, { skillManager, worldService, virtualPhoneService, featureCatalog });

  // 本地内置向量引擎（零配置记忆底座）：没有任何远端 Embedding 端点时，
  // 在记忆系统装配前预热回环 /v1/embeddings；远端显式配置时完全不启动。
  if (!resolveEmbeddingEndpoint()) {
    const localEndpoint = await ensureLocalEmbeddingEndpoint();
    if (localEndpoint) {
      console.log(
        `[local-embedding] 零配置向量端点就绪 ${localEndpoint.baseUrl} (model=${localEndpoint.model}, dims=${localEndpoint.dims})`,
      );
    }
  }

  const agenticMemoryRuntime = getAgenticMemoryRuntime();
  // 两个内存服务初始化相互独立（narrative 装配只依赖 humanLikeMemory），并行加载。
  // DailyJournal：当日对话日志（白天写入 + 当天词法检索 + 夜晚固化数据源）。
  const [humanLikeMemory, shortTermMemoryGateway] = await Promise.all([
    initHumanLikeMemoryService(),
    initShortTermMemoryGatewayService(),
  ]);
  initDailyJournalService();

  // ─── 方案 A/B/C/D：agentic-memory 四件套（桥接 / 账本 / 承诺板 / 溯源）───
  // 共用同一 SQLite 文件（AGENT_AGENTIC_MEMORY_DB，缺省 data/agentic_memory/
  // agentic-memory.db），各建各表；各自 env 开关独立回退，互不阻断。
  const agenticLedger = createAgenticLedgerIfEnabled();
  const commitmentBoard = createCommitmentBoardIfEnabled();
  // 承诺 → 日程物化出口（2026-09-24）：active 且 deadline 在未来的承诺自动落成
  // source=commitment 的日程（进「今日安排」/冲突检测/到点提醒）；终态/改期反向同步。
  // 承诺板的召回与催办（梯度提醒/超时升级）不变，日程只补「到点那一响」与展示面。
  if (commitmentBoard) {
    commitmentBoard.setScheduleOutlet(createCommitmentScheduleOutlet({ tasks: scheduleTaskService }));
  }
  const provenance = createProvenanceIfEnabled({
    memory: agenticMemoryRuntime?.memory ?? null,
    graph: humanLikeMemory,
    ledger: agenticLedger,
  });
  const userUnderstandingStore = createUserUnderstandingStoreIfEnabled();
  const structuredFactStore = createStructuredFactStoreIfEnabled();
  // 用户生活模型（Life Model，2026-10-20）：记忆四层金字塔第 ④ 层——把散在
  // 结构化事实 / 图式 / 经验学习 / 关系图谱里的产出收敛为「实体-关系-时间」模型。
  // 与其余 agentic-memory 表共用同一 SQLite（隐私级联天然覆盖）；初始化失败降级 null。
  let lifeModelStore: LifeModelStore | null = null;
  try {
    lifeModelStore = new LifeModelStore();
  } catch (err) {
    console.warn("[life-model] 初始化失败（降级，生活模型不可用）:", err);
  }
  // 实体物化（P0 接线）：写非 user 主体的事实时旁路建/更新 life_entities（零新增调用）。
  if (structuredFactStore) {
    structuredFactStore.setEntityObserver((actorId, entity, seenAt, sourceRef) => {
      if (!lifeModelStore) return;
      lifeModelStore.upsertEntity({
        actorId,
        kind: "person",
        canonicalName: entity,
        seenAt,
        confidence: 0.6,
        sourceRef: sourceRef ?? "structured_fact",
      });
    });
  }
  // FTS 关键词第三路（混合检索 P0）：与四件套共用同一 SQLite 文件，
  // 作为 bridge 融合召回的 BM25 rank 来源；关闭/初始化失败返回 null（无害降级）。
  const memoryFtsStore = createMemoryFtsStoreIfEnabled();
  const memoryBridge = createMemoryBridgeIfEnabled({
    memory: agenticMemoryRuntime?.memory ?? null,
    graph: humanLikeMemory,
    ingest: agenticMemoryRuntime?.ingest ?? null,
    retrieval: agenticMemoryRuntime?.retrieval ?? null,
    fts: memoryFtsStore,
  });

  // 档案字段单一权威源（2026-10-09）：结构化事实库是「称呼/职业/居住地…」的
  // 唯一权威。字段值变更后，去抖收敛 USER_PROFILE.md 与 KV 槽位里的副本到权威值，
  // 保证客户端 / 画像 / prompt 三处读到的永远同一份（此前各自独立写导致漂移）。
  const profileFactReconcileTimers = new Map<string, NodeJS.Timeout>();
  const scheduleProfileFactReconcile = (actorId: string): void => {
    if (!actorId || profileFactReconcileTimers.has(actorId)) return;
    const timer = setTimeout(() => {
      profileFactReconcileTimers.delete(actorId);
      void (async () => {
        try {
          const agg = brainCenter?.getUserProfileAggregator?.() ?? null;
          const report = agg
            ? await agg.reconcileProfileFieldAuthority(actorId, agentMemorySyncService)
            : await reconcileProfileFactsRuntime(actorId, agentMemorySyncService);
          if (report.profileChanged || report.profileKvSynced || report.kvRemoved > 0) {
            console.info(
              `[profile-fact-authority] 收敛 ${actorId}: ` +
                `画像${report.profileChanged ? "已投影" : "不变"}` +
                `${report.profileKvSynced ? "，KV画像副本已同步" : ""}` +
                `${report.kvRemoved > 0 ? `，清 KV 副本 ${report.kvRemoved} 行` : ""}`,
            );
          }
        } catch {
          /* 收敛失败不阻断记忆写入主链路 */
        }
      })();
    }, 900);
    timer.unref?.();
    profileFactReconcileTimers.set(actorId, timer);
  };

  // Mem0 落库钩子（方案 B/C/D 的统一取数口）：账本落 claim → 溯源登记 →
  // 承诺自动提取（旁路 LLM，不阻塞写入主链路）。
  // P0-2：承诺捕获与记忆路由解耦——低信号/被拒存的文本也会带 commitments
  // 进来（results 为空的 orphan 事件），钩子门只看 context 不看 highSignal。
  agenticMemoryRuntime?.ingest.addWriteHook((event) => {
    if (!agenticLedger && !provenance && !commitmentBoard && !userUnderstandingStore && !structuredFactStore && !memoryFtsStore) return;
    if (event.results.length > 0) {
      // FTS 关键词索引（混合检索 P0）：与账本同源取数，同步 SQLite 写（μs 级），
      // 失败不阻断账本/溯源主链路
      try {
        memoryFtsStore?.indexMemories(
          event.actorId,
          event.results.map((item) => ({
            id: item.id,
            memory: item.memory,
            metadata: { ...(item.metadata ?? {}), context: event.context },
          })),
        );
      } catch (err) {
        console.warn("[agentic-memory] FTS 索引钩子失败（忽略）:", err);
      }
      const records = agenticLedger
        ? agenticLedger.appendBatch(
            event.results.map((item) => ({
              actorId: event.actorId,
              claim: item.memory,
              sourceRef: event.sourceId,
              confidence: null,
              mem0Id: item.id,
              metadata: {
                context: event.context,
                highSignal: event.highSignal,
                ...(item.metadata ?? {}),
              },
            })),
          )
        : [];
      provenance?.recordDerivations(event.sourceId, event.actorId, {
        mem0Ids: event.results.map((item) => item.id),
        ledgerIds: records.map((r) => r.id),
      });
    }
    if (commitmentBoard && isCommitmentAutoExtractEnabled() && event.context === "main") {
      const sourceRef = event.sourceId;
      // P1-6 统一抽取路径：承诺识别已在同一次 LLM 里完成，钩子直接落板（零额外调用）
      if (event.commitments && event.commitments.length > 0) {
        const created = commitmentBoard.ingestExtracted(event.actorId, event.commitments, {
          sourceRef,
          ledger: agenticLedger,
        });
        if (created.length > 0) {
          provenance?.recordDerivations(sourceRef, event.actorId, {
            ledgerIds: created.flatMap((c) => c.evidenceLedgerIds),
          });
        }
      } else if (event.highSignal) {
        // 回退路径：独立承诺提取 LLM（统一抽取关闭/失败时；仅高信号——
        // 低信号在 unified 关闭时没有承诺抽取通道，scope 开关随之失效）
        void extractCommitments(event.results.map((item) => item.memory).join("\n"), {
          actorId: event.actorId,
        })
          .then((extracted) => {
            if (extracted.length === 0) return;
            const created = commitmentBoard.ingestExtracted(event.actorId, extracted, {
              sourceRef,
              ledger: agenticLedger,
            });
            if (created.length > 0) {
              provenance?.recordDerivations(sourceRef, event.actorId, {
                ledgerIds: created.flatMap((c) => c.evidenceLedgerIds),
              });
            }
          })
          .catch(() => {});
      }
    }
    // P1-6 纠正闭环：用户否认/更正既有信息 → 旧 claim supersede +
    // 溯源级联（账本 void、Mem0 删除、认知图 overridden、关联承诺 superseded）
    for (const correction of event.corrections ?? []) {
      const oldClaims = agenticLedger?.findActiveClaimsByText(event.actorId, correction.oldClaim, 3) ?? [];
      for (const old of oldClaims) {
        if (old.id === event.results.find((r) => r.memory === correction.newClaim)?.id) continue;
        if (provenance) {
          void provenance
            .invalidateClaim(old.id, `用户纠正 → ${correction.newClaim}`)
            .catch(() => {});
        } else {
          agenticLedger?.supersede(
            old.id,
            `void:correction:${Date.now().toString(36)}`,
            `用户纠正 → ${correction.newClaim}`,
          );
        }
      }
    }
    // 角色→人名指代映射（2026-09-13 写时结构化）：落结构化事实库
    // field=指代·role，realtime 轮的代码侧指代消解 O(1) 直查该字段，
    // 不再依赖原文频次挖掘。只记录「用户这么指代」，不断言真实关系。
    for (const referent of event.referents ?? []) {
      try {
        const result = structuredFactStore?.applyFact({
          actorId: event.actorId,
          field: `指代·${referent.role}`,
          value: referent.name,
          sourceRef: event.sourceId,
          confidence: referent.confidence ?? null,
        });
        if (result?.changed) {
          console.info(
            `[structured-facts] 指代映射登记 actor=${event.actorId} 指代·${referent.role}=${referent.name}`,
          );
        }
      } catch (err) {
        console.warn("[structured-facts] 指代映射登记失败（忽略）:", err);
      }
    }
    // 用户理解档案：agent 对用户理解的结构化沉淀（topic + 理解句 + 性质标注）。
    // 同 topic 新理解生效即旧理解入「演变历史」（同事务，不删除——旧对话是
    // 真实发生的事，可追溯）；理解是「修订」而非「证伪」，不做跨存储抹除，
    // 矛盾由注入层的理解权威块 + 演变历史消解。
    for (const understanding of event.understandings ?? []) {
      try {
        const result = userUnderstandingStore?.applyUnderstanding({
          actorId: event.actorId,
          topic: understanding.topic,
          note: understanding.note,
          kind: understanding.kind,
          sourceRef: event.sourceId,
          confidence: understanding.confidence ?? null,
        });
        if (result?.changed) {
          console.info(
            `[user-understanding] 理解${result.previous.length > 0 ? "修订" : "新增"} ` +
              `actor=${event.actorId} topic=${understanding.topic}: ${understanding.note}`,
          );
        }
      } catch (err) {
        console.warn("[user-understanding] 理解入档失败（忽略）:", err);
      }
    }
    // 结构化事实库：用户档案字段的实时更新通道（确定性高、字段固定，KV 式
    // 精确寻址）。同字段新值生效即旧值入演变历史（latest-wins，不删除——
    // 旧值可追溯）；更新类事实（搬家/换工作）由此天然覆盖，不自相矛盾。
    for (const fact of event.facts ?? []) {
      try {
        const result = structuredFactStore?.applyFact({
          actorId: event.actorId,
          field: fact.field,
          value: fact.value,
          sourceRef: event.sourceId,
          confidence: fact.confidence ?? null,
          // 时态与事发时间（2026-10-19 时间锚定）：past 只登记历史、不改现状；
          // upcoming 只登记计划、也不改现状（到期无证据只降级为"未确认"）；
          // eventTime/validFrom/validTo 是"事情何时发生"，与 observed_at 分开存。
          temporal:
            fact.temporal === "past"
              ? "past"
              : fact.temporal === "upcoming"
                ? "upcoming"
                : "current",
          eventTime: fact.eventTime ?? null,
          validFrom: fact.validFrom ?? null,
          validTo: fact.validTo ?? null,
        });
        if (result?.changed) {
          console.info(
            `[structured-facts] 字段${result.previous.length > 0 ? "变更" : "新增"} ` +
              `actor=${event.actorId} ${fact.field}=${fact.value}` +
              (fact.eventTime ? `（事发 ${fact.eventTime}）` : "") +
              (result.previous.length > 0 ? `（原值：${result.previous[0]!.value}）` : ""),
          );
          // 档案字段变更 → 收敛其它存储里的副本（单一权威源）
          if (isProfileField(fact.field)) {
            scheduleProfileFactReconcile(event.actorId);
            // 向量层即时退役（2026-10-19 收尾）：结构化事实是字段级 latest-wins，
            // 但 Mem0 里"住在杭州"那条旧记忆不会自动消失，不处理就有最长约一天
            // 的新旧并存窗口。按 factFields 标签/短句线索归档同字段旧条目
            // （archiveIds：可恢复，非物理删除）；失败静默，交回 lifecycle。
            void retireMemoriesForFactChange({
              memory: agenticMemoryRuntime?.memory ?? null,
              reinforcement: getMemoryReinforcementStore(),
              actorId: event.actorId,
              field: fact.field,
              newValue: fact.value,
              previousValues: result.previous.map((p) => p.value),
            }).catch(() => {});
          }
        } else if (result?.ignored) {
          // 时间锚定的各个拦截口都留痕：past=用户说的是过去，不改现状；
          // upcoming=计划，不改现状；low_confidence=新值明显比现状弱
          const reasonLabel =
            result.ignored === "past"
              ? "（登记为历史陈述）"
              : result.ignored === "upcoming"
                ? "（登记为计划，未发生）"
                : `（现状：${result.fact.value}，置信 ${result.fact.confidence ?? "?"}）`;
          console.info(
            `[structured-facts] 未覆盖（${result.ignored}）` +
              `actor=${event.actorId} ${fact.field}=${fact.value}${reasonLabel}`,
          );
        }
      } catch (err) {
        console.warn("[structured-facts] 事实入档失败（忽略）:", err);
      }
    }
    // 字段级遗忘（Mem0 DELETE 语义）：用户明确要求忘掉的字段 supersede 下线，
    // 历史行保留可追溯；档案字段清档后同样收敛其它存储副本
    for (const field of event.forget ?? []) {
      try {
        const cleared = structuredFactStore?.clearFact(event.actorId, field);
        if (cleared !== null && cleared !== undefined) {
          console.info(
            `[structured-facts] 字段遗忘 actor=${event.actorId} ${field}（下线 ${cleared} 条）`,
          );
          if (cleared > 0 && isProfileField(field)) {
            scheduleProfileFactReconcile(event.actorId);
          }
        }
      } catch (err) {
        console.warn("[structured-facts] 字段遗忘失败（忽略）:", err);
      }
    }
  });

  // ─── P0-3/P2-15：lifecycle 删除调和 + 存量 linkage 回填 ───
  // lifecycle 绕过 bridge 删 Mem0（TTL/去重）→ 通知 bridge 摘除 linkage + FTS 摘除索引；
  // 启动后 30s 做一次存量回填（旧记忆没有 linkage/词面索引，同步/召回都扫不到）。
  agenticMemoryRuntime?.lifecycle.setDeletedNotifier((ids) => {
    memoryBridge?.handleMem0Deleted(ids);
    try {
      memoryFtsStore?.remove(ids);
    } catch {
      /* FTS 摘除失败静默（残留行会被下次 upsert/清理回收） */
    }
  });
  if (memoryBridge && process.env.AGENT_MEMORY_BRIDGE_BACKFILL?.trim() !== "0") {
    const backfillTimer = setTimeout(() => {
      void memoryBridge.backfillLinks().catch(() => {});
    }, 30_000);
    backfillTimer.unref();
  }
  if (memoryFtsStore && process.env.AGENT_MEMORY_FTS_BACKFILL?.trim() !== "0") {
    const ftsBackfillTimer = setTimeout(() => {
      // 候选 actor：session 登记 ∪ journal 目录（mem0ai v3 getAll 须按 user_id 过滤）
      const actorCandidates = new Set<string>(agentMemorySyncService.listSessionIds());
      for (const id of getDailyJournalService()?.listActorIds?.() ?? []) actorCandidates.add(id);
      void memoryFtsStore
        .backfillFromMem0(agenticMemoryRuntime?.memory ?? null, [...actorCandidates])
        .catch(() => {});
    }, 30_000);
    ftsBackfillTimer.unref();
  }

  // 组件注册表：clear-service / prompt-context / health 快照从这里取实例
  // 软抑制存储（"别再提这个"，2026-10-19）：启动期建一次，prompt/召回热路径
  // 只走 peek（不建库），避免在未装配环境里顺手写出库文件。
  try {
    initMemorySuppressionStore();
  } catch (err) {
    console.warn("[memory-suppression] 初始化失败（软抑制不可用，忽略）:", err);
  }

  registerMemoryComponents({
    ledger: agenticLedger,
    commitmentBoard,
    provenance,
    bridge: memoryBridge,
    understandingStore: userUnderstandingStore,
    factStore: structuredFactStore,
    fts: memoryFtsStore,
    lifeModel: lifeModelStore,
  });

  // ─── 档案字段单一权威源：启动期一次性收敛（2026-10-09）───
  // 存量用户此前的漂移（画像/KV 里的称呼副本、别名重复行、行内历史注解）在启动后
  // 做一次幂等收敛；此后由写钩子 + 夜间任务维持。延后 25s 让装配完成
  // （聚合器在 brain 块内创建，收敛走它的串行链）。
  if (process.env.AGENT_PROFILE_FACT_AUTHORITY_RECONCILE?.trim() !== "0") {
    const authorityTimer = setTimeout(() => {
      void (async () => {
        try {
          const actors = new Set<string>(agentMemorySyncService.listSessionIds());
          for (const id of getDailyJournalService()?.listActorIds?.() ?? []) actors.add(id);
          const target = [...actors].filter((id) => id && !isEphemeralActorId(id));
          if (target.length === 0) return;
          const { scanned, changed } = await reconcileProfileFactsForActors(
            target,
            agentMemorySyncService,
          );
          if (changed > 0) {
            console.info(
              `[profile-fact-authority] 启动收敛完成：${changed}/${scanned} 个 actor 有变更`,
            );
          }
        } catch (err) {
          console.warn("[profile-fact-authority] 启动收敛失败（忽略）:", err);
        }
      })();
    }, 25_000);
    authorityTimer.unref();
  }

  // 承诺板提醒/升级出口：proactivity 管道装配后接线（见下方 proactivePipeline
  // 构造之后的 commitmentBoard.setNotifier），未接上前由 board 内置日志降级。
  if (commitmentBoard) {
    registerCommitmentTools(toolRegistry, { board: commitmentBoard, provenance });
    // 统一预订层（方案 A）：booking 结果写入承诺板跟踪状态
    bookingService.setCommitmentBoard(commitmentBoard);
  }

  // ─── 方案 E：记忆写入 → 偏好变更触发链路 ───
  // NarrativeMemoryFacade.ingest 写入后钩子（fire-and-forget）→ 检测偏好变更
  // 信号（零 LLM 正则）→ 与事实主库版本化联动（同主题换值 = 反转 → 确认提案）。
  // 事实库惰性共享 nightly 巩固服务的同一 UserFactStore 单例（getFactStore），
  // 避免双实例缓存导致反转检测读到陈旧偏好。
  // 提交口前向引用：统一管道在下方构造完成后回填（构造前的写入按冷却去重，
  // 极早期丢失一次偏好提示无碍——记忆侧学习照常进行）。
  const proactiveSubmitRef: { current?: (p: ProactiveProposal) => void } = {};
  const preferenceChangeTrigger = new PreferenceChangeTrigger({
    submit: (p) => proactiveSubmitRef.current?.(p),
    getPreferenceFacts: (actorId) =>
      getNightlyMemoryTaskService()?.getFactStore().getFacts(actorId, { kind: "preference" }) ?? [],
  });

  const narrativeMemory = wrapNarrativeWithHybrid(
    createNarrativeMemoryPort({
      agenticIngest: agenticMemoryRuntime?.ingest ?? null,
      agenticRetrieval: agenticMemoryRuntime?.retrieval ?? null,
      compressor: agenticMemoryRuntime?.compressor ?? null,
      humanLikeMemory,
      bridge: memoryBridge,
      onWrite: (actorId, text, source) => {
        void preferenceChangeTrigger.noteMemoryWrite(actorId, text, { sourceRef: source });
      },
    }),
    createNarrativeHybridRetrievalDefault(),
    Boolean(memoryBridge),
  );

  // ─── 统一记忆写入者（四路合一）：对话衍生的写入候选全部进整合队列，
  // 由单一链路完成 回声过滤 → 裁决 → 低信号摘要 → supersession → 落库。
  // 未启用（env 关闭/依赖缺失）时返回 null，各链路自动回退旧直写路径。
  const memoryConsolidation = configureMemoryConsolidation({
    narrative: narrativeMemory,
    kvSync: agentMemorySyncService,
    memory: agenticMemoryRuntime?.memory ?? null,
  });
  agenticMemoryRuntime?.ingest.setLowSignalSink(
    memoryConsolidation
      ? (entry) =>
          memoryConsolidation.submitCandidate({
            actorId: entry.actorId,
            text: entry.text,
            source: "cortex:low_signal",
            context: entry.context,
            highSignal: false,
            createdAt: new Date().toISOString(),
          })
      : null,
  );

  // ─── 记忆回查工具：episodic（当前会话逐轮）+ history（跨会话历史原文，2026-10-10）───
  registerMemoryRecallTools(toolRegistry, {
    shortTermMemoryGateway,
    chatThreadPersistence: getChatThreadPersistence(),
  });
  setMemoryChatTools([...MEMORY_RECALL_CHAT_TOOLS, ...MEMORY_INVALIDATION_CHAT_TOOLS]);

  // DailyDigest 仅承载当日 RAM 摘要（prompt 注入），长期归档已收敛到 journal 夜间固化
  const dailyDigestService = getDailyDigestService();
  await dailyDigestService.load();

  initMemoryManagerService(narrativeMemory, agentMemorySyncService);
  const stmConfig = getShortTermMemoryConfig();

  // ─── 用户时刻统一取用口（2026-10-16 接口统一，用户拍板）───
  // 「按对用户的了解动态设置时刻」的能力此前散落多处（晚报调度器直连
  // RhythmCore、夜间固化直连 AwarenessCortex、过劳提醒经 body 信号 payload
  // 捎带 learnedBedtimeHour……），现统一注册到 UserTimingService：新的
  // 定时场景一律从这里取学到的就寝/起床时刻/睡眠窗口，不再各自直连数据源。
  // 注册序 = 数据质量优先级：在线活跃学习 > 在场足迹推导 > 会话睡眠窗口。
  // rhythmCore/awarenessCortex 声明在后，闭包运行期已初始化，可选链安全。
  const userTiming = new UserTimingService();
  userTiming.registerSource({
    name: "rhythm-core",
    bedtimeHour: (actorId) => rhythmCore?.learnedBedtimeHour(actorId) ?? null,
  });
  userTiming.registerSource({
    name: "presence-footprint",
    bedtimeHour: (actorId) =>
      getPresenceFootprintStore()?.deriveSleepWindow(actorId).sleepStartHour ?? null,
    wakeHour: (actorId) =>
      getPresenceFootprintStore()?.deriveSleepWindow(actorId).wakeHour ?? null,
  });
  userTiming.registerSource({
    name: "awareness-sleep-window",
    bedtimeHour: (actorId) =>
      awarenessCortex?.getLearnedSleepWindow(actorId)?.startHour ?? null,
    wakeHour: (actorId) =>
      awarenessCortex?.getLearnedSleepWindow(actorId)?.endHour ?? null,
    sleepWindow: (actorId) => awarenessCortex?.getLearnedSleepWindow(actorId) ?? null,
  });

  const nightlyMemoryService = initNightlyMemoryTaskService({
    timezone: stmConfig.digestTimezone,
  });
  if (nightlyMemoryService) {
    const memoryManager = (await import("../services/memory-manager-service.js")).getMemoryManagerService();
    nightlyMemoryService.setDependencies(
      memoryManager,
      agentMemorySyncService,
      narrativeMemory,
    );
    nightlyMemoryService.startScheduler();
    app.log.info(
      `[NightlyMemory] Night mode: ${nightlyMemoryService.isInNightMode() ? "🌙 ON" : "☀️ OFF"} (${stmConfig.digestTimezone})`,
    );
    // 计划到期补扫（2026-10-19 P0）：夜间任务一天只跑一次且可能被早退跳过；
    // 进程启动 30s 后补一次，白天重启也不会让到期计划悬着。
    const planSweepTimer = setTimeout(() => {
      void getNightlyMemoryTaskService()
        ?.runPlanSweepForAllActors()
        .then((n) => {
          if (n > 0) app.log.info(`[NightlyMemory] 启动补扫：${n} 条计划到期未确认`);
        })
        .catch(() => {});
    }, 30_000);
    planSweepTimer.unref();
  }
  
  const chatSyncService = initDailyChatSyncService();
  if (chatSyncService) {
    chatSyncService.setDependencies(dailyDigestService, agentMemorySyncService);
    app.log.info(`[DailyChatSync] Service initialized and ready`);
  }
  
  app.log.info(
    `[ShortTermMemory] mode=${stmConfig.mode}, wal=${stmConfig.walEnabled ? "on" : "off"}, digest=${stmConfig.digestEnabled ? "on" : "off"}, deferArchive=${stmConfig.deferTurnArchive ? "on" : "off"}, tz=${stmConfig.digestTimezone}`,
  );

  const pipelineMode = parseSkillPromotionPipelineMode();
  const skillPromoValidateDeps = { skillManager, skillMetadataValidator };
  let skillPromotionQueue: SkillPromotionQueueService | null = null;
  if (pipelineMode === "queue") {
    skillPromotionQueue = new SkillPromotionQueueService(skillPromoValidateDeps);
    skillPromotionQueue.start();
  }
  const trajectoryPromotionPipeline =
    pipelineMode === "off" ?
      null
    : new TrajectoryPromotionPipeline(
        pipelineMode,
        skillPromoValidateDeps,
        skillPromotionQueue,
        // onSkillPromoted 回调：自我进化装载 Skill 成功后触发，
        // 把新能力同步到 CapabilityCortex + 清缓存。
        // 闭包引用 capabilityCortex（在下方 brainEnabled 块创建），
        // 回调运行时（EvolutionCortex.execute 装载阶段）capabilityCortex 已初始化。
        ({ metadata, skillName }) => {
          // 1. 通知 CapabilityCortex 注册新能力描述符（让 agent.query_capabilities 可见）
          if (capabilityCortex) {
            capabilityCortex.register({
              domain: `evolved_${skillName.replace(/\./g, "_")}`,
              label: metadata.displayName || skillName,
              description: metadata.description,
              tools: [skillName],
              status: "active",
              source: "dynamic",
              registeredAt: new Date().toISOString(),
            });
          }
          // 2026-09-11：原「注册到 Python tool-router」步骤已随 router 删除——
          // skill 已在上方注册进 SkillManager，invalidateBuiltinToolsCache 后
          // 经进程内延迟目录即可被检索。
          // 2. 清除 builtin 工具缓存，确保下次请求看到新能力
          invalidateBuiltinToolsCache();
        },
      );

  const trajectorySkillPromotion = new TrajectorySkillPromotionService(trajectoryPromotionPipeline);

  const evolutionLoopService = new EvolutionLoopService(agentMemorySyncService, {
    onObserveForNarrative: (actorId, line) => {
      void (async () => {
        const compacted = await compactObserveLine("evolution.observe", line);
        await narrativeMemory?.ingest(actorId, compacted, "evolution:observe");
      })().catch(() => {});
    },
  });
  worldService.setEvolutionHooks({
    onWorldCreditsCredited: (ev) => {
      agentMemorySyncService.appendMemorySummaryLine(
        ev.actorSessionId,
        `世界入账 +${ev.amount}（${ev.reason}），余额 ${ev.balanceAfter}`,
        "world",
      );
      void narrativeMemory
        ?.ingest(
          ev.actorSessionId,
          `世界入账 +${ev.amount}（${ev.reason}），余额 ${ev.balanceAfter}`,
          "world:credits",
        )
        .catch(() => {});
    },
    onSkillPurchased: (ev) => {
      const m = skillManager.get(ev.skillId);
      agentMemorySyncService.appendMemorySummaryLine(
        ev.actorSessionId,
        `购买技能「${m?.displayName ?? ev.skillId}」（${ev.skillId}）花费 ${ev.pricePaid} 点，余额 ${ev.balanceAfter}`,
        "world",
      );
      void narrativeMemory
        ?.ingest(
          ev.actorSessionId,
          `购买技能「${m?.displayName ?? ev.skillId}」（${ev.skillId}）花费 ${ev.pricePaid} 点，余额 ${ev.balanceAfter}`,
          "world:skill_purchase",
        )
        .catch(() => {});
    },
  });

  // 服务接入（内测 byok）：先重放用户自配密钥（data/service-config.json → env），
  // 再解析 provider 装入可热替换代理——用户在客户端「服务接入」页保存密钥后，
  // PUT /api/service-config 经 externalChatSwapper 热生效，无需重启
  // （见 routes/http/service-config.ts 与 config/service-config-store.ts）。
  await applyPersistedServiceConfig();
  const externalChatHost = new MutableExternalChatProvider(createExternalChatProviderFromEnv());
  const externalChat = externalChatHost;
  // 按 actor 的用户自有模型绑定（云端连接版 BYOK）：key 纯内存（TTL 24h），
  // session.init 上送时由 ws 层写入，agent-core 用户轮经 chatProviderFor 取用。
  const actorModelBindings = new ActorModelBindingStore();
  // 主动话术生成器（内容型场景：行程变化/消息来临 → LLM 主动回复；模板兜底）。
  // 用量纪律：每日熔断 PROACTIVITY_MAX_PHRASE_PER_DAY（默认 30），PROACTIVITY_PHRASE_LLM=0 关闭。
  const speechPolisher = new SpeechPolisher({
    chat: () => (externalChat?.isEnabled() ? externalChat : null),
    dataPath: join(process.cwd(), "data", "proactivity"),
  });
  const moodInferenceService = new MoodInferenceService({
    externalChat,
    persistFilePath: join(process.cwd(), "data", "mood-inferences.jsonl"),
    logger: {
      info: (msg) => app.log.info(msg),
      warn: (msg) => app.log.warn(msg),
      error: (msg) => app.log.error(msg),
    },
  });
  await moodInferenceService.load();
  app.log.info("[MoodInference] 服务已初始化并加载历史数据");

  const notesService = new NotesService(join(process.cwd(), "data"));
  await notesService.load().catch((err) => {
    app.log.error({ err }, "NotesService 加载失败");
  });
  const userPersonalizationService = new UserPersonalizationService(
    agentMemorySyncService,
    externalChat,
  );
  // Task 17：当天命中重要日子回调（proactivityHub 在下方创建后注入实现；
  // 晨报每日生成即每日扫描，当天命中 → 单次 LLM 祝福草稿 → life_reminder 主动提醒）
  let onImportantDayToday:
    | ((sessionId: string, day: MorningBriefingImportantDay) => void)
    | undefined;
  // Task 15：恶劣天气预警回调（proactivityHub 在下方创建后注入实现；
  // 晨报生成时检测预警 + 当日有日程 → weather_alert 合并提醒）
  let onSevereWeatherAlert:
    | ((sessionId: string, alerts: string[], scheduleCount: number) => void)
    | undefined;
  // 简报天气定位兜底：客户端 GPS（比 IP 准）。协调器在下方才创建，这里持
  // 延迟引用（简报每次生成时才调用，赋值必然先于首次生成）。
  const locationCoordinatorRef: { current: LocationCoordinator | null } = { current: null };
  const briefingClientLocation = async (
    sessionId: string,
  ): Promise<
    | { latitude: number; longitude: number; label?: string; city?: string; timezone?: string }
    | null
  > => {
    const coordinator = locationCoordinatorRef.current;
    if (!coordinator) return null;
    const live = await coordinator.requestLocation(sessionId, "morning-briefing:weather");
    if (live) return live;
    return coordinator.getCachedWithTime(sessionId)?.payload ?? null;
  };
  const morningBriefingService = new MorningBriefingService({
    weatherService,
    weatherPrefsService,
    scheduleTaskService,
    notesService,
    getSessionPrefs: (sessionId) => getUserPreferences(sessionId),
    // 天气定位兜底：客户端 GPS（配置城市 > GPS > IP）
    requestClientLocation: briefingClientLocation,
    // 第五源：近期重要日子（读 care.set_important_date 写入的 KV）
    agentMemorySyncService,
    // 用户称呼源：结构化事实库「称呼」字段（与首启向导/聊天面同源；
    // 绝不回退账号 displayName——那是 agent 的网络名，方向会反）
    factStore: structuredFactStore ?? undefined,
    onImportantDayToday: (sessionId, day) => onImportantDayToday?.(sessionId, day),
    onSevereWeatherAlert: (sessionId, alerts, scheduleCount) =>
      onSevereWeatherAlert?.(sessionId, alerts, scheduleCount),
    // 播报稿口语润色（单次小 LLM 调用，与 finance-report 同模式，克制调用）；
    // LLM 未启用/失败时服务内部回退确定性模板，不阻塞简报
    llmComplete: externalChat?.isEnabled()
      ? async (prompt) => {
          let full = "";
          await externalChat!.streamCompletion(
            `morning-briefing-${Date.now()}`,
            { text: prompt },
            (delta: string) => {
              full += delta;
            },
            undefined,
            {
              systemPromptOverride: prompt,
              ephemeralTurn: true,
              disableThinking: true,
              maxThreadMessages: 0,
            },
          );
          return full;
        }
      : undefined,
  });

  const morningBriefingScheduler = new MorningBriefingScheduler({
    briefingService: morningBriefingService,
    getSessionPrefs: (sessionId) => getUserPreferences(sessionId),
    onBriefingTriggered: async (sessionId, payload) => {
      const sent = wsConnectionRegistry.trySend(
        sessionId,
        JSON.stringify({
          type: ServerEventType.MorningBriefing,
          payload: {
            sessionId,
            mode: payload.mode,
            narrationText: payload.narrationText,
            briefing: payload.briefing,
          },
        }),
      );
      if (sent) {
        markMorningBriefingDelivered(sessionId, "scheduled");
      } else {
        // 两端都不在线：转统一管道挂起（directText 零 LLM，must 层必达），任一设备
        // 重连 flushDue 直推；配置移动推送时升级系统通知。dedupKey 带日期防跨日重发。
        proactivePipeline.submitProposal({
          proposalId: `p_${Date.now().toString(36)}_mbrief`,
          actorId: sessionId,
          kind: "morning_briefing",
          tier: "must",
          importance: "medium",
          dedupKey: `morning_briefing:${sessionId}:${new Date().toISOString().slice(0, 10)}`,
          title: "早安简报",
          summary: payload.narrationText.slice(0, 200),
          evidence: ["morning_briefing_scheduled", "ws_push_failed"],
          directText: payload.narrationText,
          createdAt: Date.now(),
          source: "time",
        });
      }
    },
  });
  morningBriefingScheduler.start();
  app.log.info("[MorningBriefing] 调度器已启动");

  // ─── Task 15 生活节律：晚间 digest「今日回顾 + 明日预告」（场景A）───
  // 数据源全确定性（journal 当日要点 / 当日账本新增 / 明日日程 / 次日天气预警）；
  // 文案交给 agent（2026-10-13 定调）：需要提前提醒的信息 → LLM 动态产出，
  // system 注入 agent 自身 soul（buildPersonaStaticBlock 与主对话同源，文案
  // 受 agent 人格影响），失败/未启用回退确定性模板；送达链路参考晨报
  // （WS 推送 EveningDigest 事件），调度模式参考 MorningBriefingScheduler。
  const eveningDigestSoulProvider = (sessionId: string): string | null => {
    try {
      // agent 名（与聊天面同源：记忆同步 KV 的 agent.name）
      let agentName: string | undefined;
      try {
        const identityRaw = agentMemorySyncService
          .getSnapshot(sessionId, [AGENT_NAME_KV_KEY])
          .entries[AGENT_NAME_KV_KEY];
        agentName = parseAgentIdentityKv(identityRaw)?.displayName ?? undefined;
      } catch {
        /* 名字缺失不阻塞 soul */
      }
      // 用户称呼（agent 叫用户的称呼；与晨报同源，不回退 displayName）
      let userAlias: string | undefined;
      try {
        userAlias =
          structuredFactStore?.getFact(sessionId, "称呼")?.value?.trim() ||
          undefined;
      } catch {
        /* 称呼缺失不阻塞 soul */
      }
      // 关系档 + 学到的适配（与人格模块同口径换算；preferredTone 在异步
      // getPromptSlice 里，睡前 soul 保持同步取用 → 只带同步可得信号）
      let tier: RelationshipTier = 1;
      let adaptation: UserAdaptationProfile | undefined;
      try {
        const rel = userPersonalizationService.getRelationshipState(sessionId);
        tier = resolveRelationshipTier(rel?.rapport);
        adaptation = { humorTolerance: rel?.humorTolerance };
      } catch {
        /* 关系态缺失走默认档 */
      }
      return buildPersonaStaticBlock({ userAlias, agentName, tier, adaptation, soulOverlay: getSoulOverlay() ?? undefined });
    } catch {
      return null;
    }
  };
  // 行程预算守门（travel 双端⑥）：行程冷层（今日进行中 + 预算档）+ 订单库（当日旅行消费）
  const travelBudgetGuard = new TravelBudgetGuardService({
    travelPlanStore,
    bookingOrderStore,
  });
  const eveningDigestService = new EveningDigestService({
    journalService: getDailyJournalService(),
    scheduleTaskService,
    weatherService,
    weatherPrefsService,
    soulProvider: eveningDigestSoulProvider,
    // 行程预算守门（travel 双端⑥）：今日在行程中且当日消费超预算档日上限 → 晚报带超支提醒
    travelBudgetProvider: (sessionId) => travelBudgetGuard.checkBudget(sessionId),
    llmComplete: externalChat?.isEnabled()
      ? async (prompt, opts) => {
          let full = "";
          await externalChat!.streamCompletion(
            `evening-digest-${Date.now()}`,
            { text: prompt },
            (delta: string) => {
              full += delta;
            },
            undefined,
            {
              // soul 走 system（agent 人格），睡前 prompt 走 user（ephemeral 不进历史）
              systemPromptOverride: opts?.systemPrompt,
              ephemeralTurn: true,
              disableThinking: true,
              maxThreadMessages: 0,
            },
          );
          return full;
        }
      : undefined,
  });
  const eveningDigestScheduler = new EveningDigestScheduler({
    digestService: eveningDigestService,
    // 推送时刻动态学习（2026-10-16）：经 UserTimingService 多源取就寝时刻
    // → 就寝前 30 分钟（钳位 [20:00, 23:30]）；未学出回退默认 21:00。
    bedtimeHourOf: (sessionId) => userTiming.bedtimeHour(sessionId),
    onDigestTriggered: (sessionId, digest) => {
      const sent = wsConnectionRegistry.trySend(
        sessionId,
        JSON.stringify({
          type: ServerEventType.EveningDigest,
          payload: {
            sessionId,
            narrationText: digest.narrationText,
            digest,
          },
        }),
      );
      if (!sent) {
        // 两端都不在线：转统一管道挂起（directText 零 LLM，must 层必达），重连即直推
        proactivePipeline.submitProposal({
          proposalId: `p_${Date.now().toString(36)}_edigest`,
          actorId: sessionId,
          kind: "evening_digest",
          tier: "must",
          importance: "medium",
          dedupKey: `evening_digest:${sessionId}:${new Date().toISOString().slice(0, 10)}`,
          title: "睡前备忘",
          summary: digest.narrationText.slice(0, 200),
          evidence: ["evening_digest_scheduled", "ws_push_failed"],
          directText: digest.narrationText,
          createdAt: Date.now(),
          source: "time",
        });
      }
    },
  });
  eveningDigestScheduler.start();
  app.log.info("[EveningDigest] 晚间 digest 调度器已启动");

  // ─── 旅游接驳提醒（travel-upgrade-plan P2）：行程交通大段（高铁/航班）到点 ───
  // 询问是否预约滴滴（确认后 Agent 走 ride_hailing.quote/book 真实下单）。调度
  // 模式仿晚间 digest：每分钟 tick；WS 在线直推手机端确认卡，不在线走 proactive
  // 管道 must 层兜底（directText 零 LLM，重连即直推——覆盖航班落地恢复网络场景）。
  const transferWatchService = new TransferWatchService({
    listPlans: () => travelPlanStore.listPlansWithTransfers(),
    setPickupState: (planId, segmentNo, state) =>
      travelPlanStore.setTransferPickupState(planId, segmentNo, state),
    // 返程出发提醒经 UserTimingService 动态反算最晚出发时刻（提醒不早于起床后 30 分钟）
    getWakeHour: (actorId) => userTiming.wakeHour(actorId),
    onReminder: (payload) => {
      if (!payload.sessionId) {
        app.log.warn({ planId: payload.planId, no: payload.segment.no },
          "[TransferWatch] 行程无 sessionId，跳过接驳提醒推送");
        return;
      }
      const sent = wsConnectionRegistry.trySend(
        payload.sessionId,
        JSON.stringify({
          type: ServerEventType.AgentTransferReminder,
          payload: {
            sessionId: payload.sessionId,
            planId: payload.planId,
            destination: payload.destination,
            segment: payload.segment,
            minutesUntil: payload.minutesUntil,
            message: payload.message,
            phase: payload.phase,
          },
        }),
      );
      if (!sent) {
        // 全端离线：must 层兜底（用户重连后 directText 直推原文）
        proactivePipeline.submitProposal({
          proposalId: `p_${Date.now().toString(36)}_transfer`,
          actorId: payload.sessionId,
          kind: "transfer_reminder",
          tier: "must",
          importance: "high",
          dedupKey: `transfer:${payload.planId}:${payload.segment.no}:${payload.phase}`,
          title: "接驳提醒",
          summary: payload.message.slice(0, 200),
          evidence: ["transfer_watch_scheduled", "ws_push_failed"],
          directText: payload.message,
          createdAt: Date.now(),
          source: "time",
        });
      }
    },
  });
  transferWatchService.start();
  app.log.info("[TransferWatch] 接驳提醒调度器已启动");

  // ─── Task 20 生活节律引擎：观察 → 建模 → 调整 闭环 ───
  // 中枢只拥有节律画像（data/rhythm_profiles/*.json，atomic 落盘）；数据从
  // 既有源拉取（AwarenessCortex 睡眠样本 / LifeSignalHub 桌面与交互信号 /
  // 触达反馈回灌），产出经三个消费方落权：A 重排节律提醒、B 回填
  // receptiveHours（ContactPolicy 直接受益）、C rhythm_insight 关怀信号
  // 走现有主动管线。决策权仍归 ContactPolicy/Fatigue/ProactionCortex。
  // RHYTHM_ENGINE_ENABLED=0 可整体关闭。
  const rhythmEnabled = !["0", "false", "off"].includes(
    (process.env.RHYTHM_ENGINE_ENABLED ?? "").trim().toLowerCase(),
  );
  let rhythmSleepSensor: SleepWindowSensor | null = null;
  let rhythmEngine: LifeRhythmEngine | null = null;
  /** 分级提醒策略的作息画像回退源（rhythm 关闭时为 null，仅剩睡眠样本直读） */
  let rhythmProfileStoreRef: RhythmProfileStore | null = null;
  /** 屏幕状态条件化的信号源（proactivity 内核 signals 日志；内核创建后赋值） */
  let screenSignalSourceRef: (() => Signal[]) | null = null;
  if (rhythmEnabled) {
    const rhythmProfileStore = new RhythmProfileStore(join(process.cwd(), "data", "rhythm_profiles"));
    await rhythmProfileStore.load();
    rhythmProfileStoreRef = rhythmProfileStore;
    rhythmEngine = new LifeRhythmEngine({ profileStore: rhythmProfileStore });
    rhythmSleepSensor = new SleepWindowSensor();
    rhythmEngine.registerSensor(rhythmSleepSensor);
    rhythmEngine.registerSensor(new DesktopActivitySensor(lifeSignalHubService));
    rhythmEngine.registerSensor(new InteractionSignalSensor(lifeSignalHubService));
    // 屏幕状态条件化（receptivity）：内核 signals 日志（含 screen_foreground 分类）
    // → 开会/写代码/游戏等强勿扰时段的弱负观察。内核在本函数较后创建，用闭包延迟取。
    rhythmEngine.registerSensor(new ScreenFocusSensor(() => screenSignalSourceRef?.() ?? []));
    rhythmEngine.subscribe(createReminderReschedulerConsumer(scheduleTaskService, rhythmEngine));
    rhythmEngine.subscribe(createReceptiveHoursWriterConsumer(userPersonalizationService));
    rhythmEngine.subscribe(createProactiveCandidateSourceConsumer(lifeSignalHubService, rhythmEngine));
    // WS 摘要推送（客户端可展示节律洞察 / 调整说明；离线静默跳过）
    rhythmEngine.subscribe((update) => {
      const adjusted: string[] = [];
      for (const [taskId, slot] of Object.entries(update.profile.reminderSlots)) {
        if (slot.lastAdjustedAt && !slot.pinnedByUser) adjusted.push(taskId);
      }
      const payload: RhythmProfileUpdatedPayload = {
        actorId: update.actorId,
        changedDimensions: update.changedDimensions,
        adjustedReminderTaskIds: adjusted,
        insights: update.insights.map((insight) => ({
          id: insight.id,
          dimension: insight.dimension,
          kind: insight.kind,
          text: insight.text,
          confidence: insight.confidence,
          generatedAt: insight.generatedAt,
        })),
        updatedAt: update.profile.updatedAt,
      };
      wsConnectionRegistry.trySend(
        update.actorId,
        JSON.stringify({ type: ServerEventType.RhythmProfileUpdated, payload }),
      );
    });
    // 触达结果回灌：personalization 的既有 outcome 消费点桥接到引擎（在线 EWMA）
    userPersonalizationService.registerContactOutcomeListener((actorId, params) => {
      const outcome = params.responded ? "accepted" : params.feedback === "negative" ? "dismissed" : "ignored";
      rhythmEngine?.recordContactOutcome(actorId, outcome, params.at);
    });
    const rhythmAnalyzer = new NightlyRhythmAnalyzer({
      engine: rhythmEngine,
      listActorIds: () => {
        const actorIds = new Set<string>();
        for (const id of agentMemorySyncService.listSessionIds()) {
          if (id && id !== "system") actorIds.add(id);
        }
        for (const id of getDailyJournalService()?.listActorIds?.() ?? []) {
          if (id) actorIds.add(id);
        }
        return [...actorIds];
      },
    });
    rhythmAnalyzer.start();
    app.log.info("[RhythmEngine] 生活节律引擎已启动（夜间统计建模 + 三出口落权）");
  }

  const scheduleIntentService = new ScheduleIntentService(externalChat);
  // 购物建议商品库（runtime 内置能力）：shopping.suggest 工具数据源；数据落 data/recommendation/。
  const recommendationCatalog = createRecommendationCatalog(
    join(process.cwd(), "data", "recommendation"),
  );
  registerLifeTools(toolRegistry, scheduleTaskService, scheduleIntentService, {
    catalog: recommendationCatalog,
    // 库未命中 → 联盟 API 实时聚合兜底（推荐数据源 P1-A 决策：实时聚合为主、
    // 种子库为冷启动缓存）：拉在售商品转 ProductRecord 落库缓存后重检索，
    // 与比价线共用同一 OfficialPriceGateway 单例；8s 死线在 fetchLiveProducts 内。
    liveSourcing: async (query, budget) => {
      const live = await fetchLiveProducts(
        { gateway: officialPriceGateway },
        query,
        { budgetMax: budget },
      );
      return {
        records: live.products.map((p) => liveProductToRecord(p, query)),
        notes: live.notes,
      };
    },
    // 缺图候选多图网搜（图片三优先级第二级）：searchImages 拿 3 张真实图源并
    // 转存 PNG（本地相对路径），交给 pickProductImage 做 VLM 主体图质检。
    // 转存落固定共享命名空间（非触发用户个人目录）：照片按 productId 进程级
    // 缓存跨用户复用，图是功能共享资产、不属于任何账号（盘上无清理任务）。
    webImageCandidates: async (query, _actorId, limit) => {
      const res = await upstreamSearchService.searchImages(query, limit, "shared-product-img");
      return res.items.map((it) => it.mediaUrl).filter((u): u is string => Boolean(u));
    },
    // VLM 选图裁判（image-caption 同源主模型）：网搜图混入场景图/水印图时
    // 挑出「商品主体图」；不可用/超时/全负分返回 null，取首图兜底。
    pickProductImage: async (candidates, productName, deadlineMs) => {
      const best = await pickBestProductImage(candidates, { productName, timeoutMs: deadlineMs });
      return best ? candidates[best.bestIndex]?.url ?? null : null;
    },
    // 单图补图降级路径（未注入 webImageCandidates 时使用；当前已注入多图链路，
    // 保留此端口保证依赖裁剪环境仍有可用兜底）。
    webImageSearch: async (query) => {
      const res = await upstreamSearchService.searchImages(query, 1, "shared-product-img");
      return res.items[0]?.mediaUrl ?? null;
    },
    // 真实口碑聚合（P3：小红书 UGC，归属主推商品）：与社交域共用同一
    // mcporter 通道；alias 未配置/失败/空返回 null，卡片无口碑区不阻断推荐。
    ugcSearch: (productName: string) =>
      aggregateXiaohongshuUgc(
        { search: (q, limit) => upstreamSearchService.searchXiaohongshu(q, limit) },
        productName,
        { deadlineMs: 6_000 },
      ),
    // 每轮实时决策：结合用户画像/习惯（长期画像 + 记忆 KV），由 ephemeral LLM
    // 单轮调用重排候选并按用户场景改写推荐话术；不可用/失败降级商品库原始文案。
    personalization: {
      buildUserContext: async (actorId) => {
        const parts: string[] = [];
        try {
          const slice = await userPersonalizationService?.getPromptSlice(actorId);
          if (slice?.userProfile) parts.push(slice.userProfile);
        } catch {
          /* 画像缺失不阻断推荐 */
        }
        try {
          const { entries } = agentMemorySyncService.getSnapshot(actorId, ["user_profile"]);
          if (typeof entries.user_profile === "string") parts.push(entries.user_profile);
        } catch {
          /* 同上 */
        }
        const digest = parts.join("\n").trim();
        return digest.length > 0 ? digest.slice(0, 1800) : null;
      },
      llmComplete: externalChat?.isEnabled()
        ? async (system, userText) => {
            let full = "";
            await externalChat!.streamCompletion(
              `shopping-suggest-${Date.now()}`,
              { text: userText },
              (delta: string) => {
                full += delta;
              },
              undefined,
              {
                systemPromptOverride: system,
                ephemeralTurn: true,
                disableThinking: true,
                maxThreadMessages: 0,
              },
            );
            return full;
          }
        : null,
    },
  });
  // 闹钟服务在装配序列后段（alarm-clock 段）才构造；calendar 工具经此 getter 懒取用，
  // 创建「闹钟类提醒」时同步补建真闹钟（alarm.sync → 手机端本地精确响铃）
  let alarmClockServiceRef: AlarmClockService | null = null;
  registerCalendarTools(toolRegistry, scheduleTaskService, scheduleIntentService, scheduleConflictService, () => alarmClockServiceRef);
  const smartHomeService = new SmartHomeService();
  registerSmartHomeTools(toolRegistry, smartHomeService);
  // 启动智能家居设备状态轮询（若 HA 已配置），将状态变化发布为 smart_home 信号
  if (smartHomeService.isEnabled()) {
    smartHomeService.startStatePolling(lifeSignalHubService);
  }

  // ========== 终端互连平台 device-bus ==========
  // 统一抽象手机 / 桌面 / 家居 / 摄像头 / 眼镜等终端，按 deviceId 多设备并存。
  // 与现有 wsConnectionRegistry（单 session 单连接）共存，互不依赖。
  const deviceRegistry = new DeviceRegistry();
  deviceRegistry.registerFactory(createHomeAdapterFactory(smartHomeService));
  deviceRegistry.registerFactory(createPhoneAdapterFactory());
  deviceRegistry.registerFactory(createDesktopAdapterFactory());
  deviceRegistry.registerFactory(createTabletAdapterFactory());
  deviceRegistry.registerFactory(createGlassesAdapterFactory());
  deviceRegistry.registerFactory(createCameraAdapterFactory());
  // 家居是本地服务（无 WS），若 HA 已配置则主动注册一个全局 home 设备
  if (smartHomeService.isEnabled()) {
    void deviceRegistry.register({
      deviceId: "home:default",
      kind: "home",
      name: "HomeAssistant",
      ownerUserId: "system",
      capabilities: [],
      status: "online",
      lastSeenAt: Date.now(),
      connectionKind: "local_service",
      metadata: { baseUrl: process.env.HA_BASE_URL },
    }).catch((err) => {
      app.log.warn({ err }, "[DeviceBus] home:default 注册失败");
    });
  }
  app.log.info(
    `[DeviceBus] 已注册适配器工厂: ${deviceRegistry.getRegisteredKinds().join(", ")}`,
  );

  // 设备配对服务：用户生成配对码 → 设备端提交配对码完成绑定
  const devicePairingService = new DevicePairingService();
  await devicePairingService.load();
  // 设备自绑定鉴权服务（ACCESS_AUTH_REQUIRED=1 时 /api/* 周界强制）：token 仅落
  // sha256 哈希（data/access-tokens.json，原子写），绑定码内存态 10 分钟一次性。
  // 未开启时零行为变更。
  const accessAuthService = new AccessAuthService();
  await accessAuthService.load();
  if (isAccessAuthRequired() && !accessAuthService.hasAnyTokens()) {
    // bootstrap：鉴权已开但一台设备都没绑过 → 控制台打印一枚引导绑定码，
    // 让首台设备免凭证完成绑定（此后 /api/auth/pairing-code 须持有效 token）。
    const bootstrapUserId = process.env.ACCESS_BOOTSTRAP_USER_ID?.trim() || "owner";
    const bootstrapCode = accessAuthService.issueBindingCode(bootstrapUserId);
    console.log(
      `[access-auth] 引导模式：尚无绑定设备。首台设备绑定码 ${bootstrapCode}` +
        `（userId=${bootstrapUserId}，10 分钟有效，一次性）。` +
        `新设备提交 POST /api/auth/bind {"code":"${bootstrapCode}","deviceId":"..."} 完成绑定。`,
    );
  }
  // 设备上下线广播：订阅 DeviceRegistry，推送给 ownerUserId 的 WS session
  deviceRegistry.subscribe((event) => {
    // 在场足迹：设备上线（电脑/手机/平板接入）= 用户在场，作息的被动观察源之一。
    // 与「工具调用 / 对话」同源打分；ownerUserId 与 actorId 不一致时只是多一份
    // 独立档案，不会污染主档案。
    const footprintOwner =
      event.kind === "online" ? event.descriptor.ownerUserId : event.ownerUserId;
    if (footprintOwner && footprintOwner !== "system") {
      getPresenceFootprintStore()?.record(footprintOwner);
    }
    let ownerUserId: string | undefined;
    let payload: { type: string; payload: Record<string, unknown> } | undefined;
    if (event.kind === "online") {
      ownerUserId = event.descriptor.ownerUserId;
      payload = {
        type: ServerEventType.DeviceOnline,
        payload: {
          deviceId: event.descriptor.deviceId,
          kind: event.descriptor.kind,
          name: event.descriptor.name,
          ownerUserId: event.descriptor.ownerUserId,
          capabilities: event.descriptor.capabilities,
          status: event.descriptor.status,
        },
      };
    } else if (event.kind === "offline") {
      ownerUserId = event.ownerUserId;
      payload = {
        type: ServerEventType.DeviceOffline,
        payload: {
          deviceId: event.deviceId,
          ownerUserId: event.ownerUserId,
          reason: event.reason,
        },
      };
    } else if (event.kind === "status_changed") {
      ownerUserId = event.ownerUserId;
      payload = {
        type: ServerEventType.DeviceListChanged,
        payload: {
          deviceId: event.deviceId,
          ownerUserId: event.ownerUserId,
          status: event.status,
        },
      };
    } else if (event.kind === "capability_changed") {
      ownerUserId = event.ownerUserId;
      payload = {
        type: ServerEventType.DeviceListChanged,
        payload: {
          deviceId: event.deviceId,
          ownerUserId: event.ownerUserId,
          capabilities: event.capabilities,
        },
      };
    }
    if (ownerUserId && payload) {
      wsConnectionRegistry.trySend(ownerUserId, JSON.stringify(payload));
    }
  });

  registerDeviceTools(toolRegistry, deviceRegistry, devicePairingService);
  const promptContextBuilder = new PromptContextBuilder({
    agentMemorySyncService,
    worldService,
    skillManager,
    virtualPhoneService,
    scheduleTaskService,
    shortTermMemoryGateway,
    featureCatalog,
  });
  const agentCore = createAgentCore({
    toolRegistry,
    externalChat,
    computeQuotaService,
    agentMemorySyncService,
    evolutionLoopService,
    userPersonalizationService,
    worldService,
    skillManager,
    narrativeMemory,
    trajectorySkillPromotion,
    virtualPhoneService,
    scheduleTaskService,
    shortTermMemoryGateway,
    moodInferenceService,
    lifeSignalHubService,
  });
  agentCore.setPhoneBridgeCoordinator(phoneBridgeCoordinator);
  agentCore.setMoodInferenceService(moodInferenceService);
  agentCore.setLifeSignalHubService(lifeSignalHubService);
  agentCore.setWsRegistry(wsConnectionRegistry);
  agentCore.setActorModelBindings(actorModelBindings);

  // task.dispatch launch 晚绑定（2026-09-05 前后台架构）：派发端接到 agentCore
  taskDispatchLauncherRef.fn = (input) =>
    agentCore.dispatchBackgroundTask(input.actorId, input);

  // Runtime 统一入口：进程无关契约。同进程模式直接包裹 AgentCore；
  // 拆进程后此处的实现可替换为 WsRuntimeClient（RUNTIME_MODE=remote）。
  const runtime: RuntimeFacade = new DirectRuntimeAdapter(agentCore);

  // 用户→Agent 通话接通后：走 AgentCore 主对话管线生成回应（转 TTS 随 connected 下发）
  virtualPhoneService.setUserCallAgentHandler(async ({ fromUserId, toActorId, userMessage }) => {
    const prompt = [
      "【系统通知 · 用户来电】",
      "用户通过虚拟电话呼叫你，通话已接通。",
      userMessage
        ? `用户在拨通时留言：${userMessage}`
        : "用户拨通时没有留言，请简短问候并询问有什么可以帮忙。",
      "",
      "请用简短中文口语直接回应（将转为语音播报给用户），不要输出 Markdown、列表或表情符号。",
    ].join("\n");
    const reply = await runtime.handleUserMessage(toActorId, prompt, {
      chatUserMessageId: `phone-user-call:${fromUserId}:${Date.now()}`,
      preferFullPipeline: true,
    });
    await runtime.runToolIfNeeded(toActorId, reply, {
      chatUserMessageId: `phone-user-call-tool:${fromUserId}:${Date.now()}`,
    });
    return { replyText: reply.text.trim() };
  });

  // 通话中用户打字回复（phone.call_reply）已删除：通话对话由 duplex realtime
  // 语音引擎接管（virtualPhoneService.setRealtimeVoiceEnabled，见下方 VoiceDuplex 装配处）。

  scheduleTaskService.setAgentTaskHandler(async (task) => {
    const prompt = task.agentTask?.prompt?.trim();
    if (!prompt) {
      throw new Error("Agent 自动化任务缺少 prompt");
    }
    // 无人值守任务默认沙箱权限（收紧）：定时 agent_task 没有用户在场确认，
    // 默认 full 等于给了一个可自主执行任意工具（含金额/外发类）的常驻后门。
    // 显式声明 accessMode 的任务不受影响；确需旧行为可设
    // SCHEDULE_AGENT_TASK_DEFAULT_ACCESS_MODE=full。
    const accessMode =
      task.agentTask?.accessMode ??
      (process.env.SCHEDULE_AGENT_TASK_DEFAULT_ACCESS_MODE === "full" ? "full" : "sandbox");
    wsConnectionRegistry.trySend(
      task.sessionId,
      JSON.stringify({
        type: ServerEventType.ScheduleAgentTaskFired,
        payload: {
          taskId: task.taskId,
          title: task.title,
          status: "started",
          prompt,
        },
      }),
    );
    embodimentThinking(
      task.sessionId,
      (json) => wsConnectionRegistry.trySend(task.sessionId, json),
      task.title || "自动化任务执行中",
      { phase: "agent_task", source: "schedule.agent_task_fired" },
    );
    const reply = await runtime.handleUserMessage(task.sessionId, prompt, {
      chatUserMessageId: `schedule:${task.taskId}:${Date.now()}`,
      agentAccessMode: accessMode,
      onAssistantDelta: (delta) => {
        wsConnectionRegistry.trySend(
          task.sessionId,
          JSON.stringify({
            type: ServerEventType.ChatAssistantChunk,
            payload: {
              messageId: task.taskId,
              delta,
              source: "schedule.agent_task",
            },
          }),
        );
      },
    });
    const toolRun = await runtime.runToolIfNeeded(task.sessionId, reply, {
      chatUserMessageId: `schedule:${task.taskId}:tool`,
      agentAccessMode: accessMode,
    });
    const result = {
      type: "agent_task",
      ok: toolRun.ok,
      title: task.title,
      prompt,
      text: reply.text,
      toolName: reply.toolName,
      toolResult: toolRun.result,
    };
    // 完成事件投递失败（用户离线：app 没开/断连）→ TaskOutbox 暂存，session.init 重连时
    // 重放——补发/定时任务的结果不再依赖"执行那一刻用户恰好在线"。与 task_plane 的
    // pushDone 同一兜底语义；在线时正常走流式，不入箱不重复。
    const completionDelivered = wsConnectionRegistry.trySend(
      task.sessionId,
      JSON.stringify({
        type: ServerEventType.ScheduleAgentTaskFired,
        payload: {
          taskId: task.taskId,
          title: task.title,
          status: toolRun.ok ? "completed" : "failed",
          result,
        },
      }),
    );
    if (!completionDelivered && reply.text.trim()) {
      getTaskOutbox().enqueue(task.sessionId, {
        messageId: task.taskId,
        finalText: reply.text,
      });
    }
    return result;
  });

  const proactiveOutbound = new ProactiveOutboundMessageService(async (userId, payload) => {
    const proactivePayload =
      payload && typeof payload.payload === "object" && payload.payload
        ? (payload.payload as Record<string, unknown>)
        : null;
    const title = String(proactivePayload?.title ?? "Agent 主动联系");
    const text = String(proactivePayload?.text ?? "");
    const channel = String(proactivePayload?.channel ?? "websocket");

    if (channel === "phone_call") {
      const result = await virtualPhoneService.callUserWithRinging({
        fromActorId: userId,
        toUserId: userId,
        transcript: `${title}。${text}`,
        ringStyle: "reminder",
      });
      if (result.ok && result.pushed) return true;
    }

    if (channel === "voice") {
      // 委托给 VoiceCapabilityService 统一推送主动语音（合成 + WS 一站式）
      return voiceCapabilityService.pushProactiveVoice(userId, title, text);
    }

    return wsConnectionRegistry.trySend(userId, JSON.stringify(payload));
    // 第三参数 null = 无关系记忆写入（原构造即未传）；第四参数：统一管道提交入口（收敛改造）
    // ——send() 组装提案转投 ProactivePipeline，自动获得去重/仲裁/离线挂起（重连直推）/
    // outcome 反馈；proactivePipeline 在下方装配段创建，箭头函数惰性求值（无 TDZ 问题）。
  }, null, (p) => proactivePipeline.submitProposal(p));

  // ─── Brain Center 开关 ───
  // BRAIN_CENTER_ENABLED 未设置或非 "0"/"false"/"off" → 默认启用 brain
  // 启用 brain 时：旧 ProactiveAgentCenter.start() / ProactiveLifeRuntimeService.start()
  //   默认不调用（由 ProactionCortex 接管），除非 BRAIN_PROACTION_LEGACY=1
  // 关闭 brain 时：旧路径完全保持现状
  const brainEnabled = !["0", "false", "off"].includes(
    (process.env.BRAIN_CENTER_ENABLED ?? "").trim().toLowerCase(),
  );
  const brainNeuroEnabled = !["0", "false", "off"].includes(
    (process.env.BRAIN_NEURO_ENABLED ?? "").trim().toLowerCase(),
  );
  const legacyProaction = ["1", "true", "on"].includes(
    (process.env.BRAIN_PROACTION_LEGACY ?? "").trim().toLowerCase(),
  );

  // ─── 实验性子系统开关（默认关闭，偏离 C 端私人管家主链路；见 .env.example 末尾注释块） ───
  // BRAIN_EVOLUTION_ENABLED：EvolutionCortex 子系统总开关（兼容旧变量
  //   BRAIN_SELF_DRIVEN_EVOLUTION_ENABLED / AGENT_EVOLUTION_LOOP_ENABLED，=1 等效开启）。
  const brainEvolutionEnabled = isBrainEvolutionEnabled();

  const proactiveLifeRuntimeService = new ProactiveLifeRuntimeService(
    lifeSignalHubService,
    anticipationEngineService,
    proactiveOutbound,
    userPersonalizationService,
    (actorId) => Boolean(wsConnectionRegistry.get(actorId)),
    moodInferenceService,
  );
  if (!brainEnabled) {
    proactiveLifeRuntimeService.start();
  }
  const proactiveCenter = new ProactiveAgentCenter(
    externalChat,
    promptContextBuilder,
    proactiveOutbound,
    userPersonalizationService,
    (actorId) => Boolean(wsConnectionRegistry.get(actorId)),
  );
  if (!brainEnabled) {
    proactiveCenter.start();
  }

  // ─── Brain Center 装配 ───
  // 启用 brain 时：实例化四皮层、注册子系统、注入 prompt builder、启动。
  // 关闭 brain 时（BRAIN_CENTER_ENABLED=0）：整个 brain/ 模块不实例化、不启动，
  //   旧路径完全保留（proactiveCenter / proactiveLifeRuntimeService 已在上面 start）。
  // 共享实例：供 brain EvolutionCortex 与 agent 工具共用同一份状态
  const skillGenerator = new SkillGenerator(externalChat);
  const agentSelfLearningService = new AgentSelfLearningService(
    externalChat,
    toolRegistry,
    skillManager,
  );

  let brainCenter: BrainCenter | null = null;
  // synapseBus 在 brainNeuroEnabled 块内创建；此处预先声明，
  // 供 brainEnabled 块内的主动决策闭环在 neuro 未启用时降级为 null。
  let synapseBus: SynapseBus | null = null;
  // proactionCortex / memoryCortex 外层声明：端到端认知装配需要同时访问两者
  // （proactionCortex 在 brainEnabled 块创建，memoryCortex 在 brainNeuroEnabled 块创建）
  let proactionCortex: ProactionCortex | null = null;
  let memoryCortex: MemoryCortex | null = null;
  // awarenessCortex 外层声明：brainNeuroEnabled 块内 BrainStem/Cerebellum 需注入 observe()
  let awarenessCortex: AwarenessCortex | null = null;
  // capabilityCortex / limbicCortex 外层声明：Step 7 DecisionHub 装配块需访问两者
  // （capabilityCortex 在 brainEnabled 块创建，limbicCortex 在 brainNeuroEnabled 块创建，
  //  DecisionHub 装配块在两者之外，故需提升至外层作用域）
  let capabilityCortex: CapabilityCortex | null = null;
  let limbicCortex: LimbicCortex | null = null;
  // evolutionCortex 外层声明：brainEnabled 块创建，后续 brainNeuroEnabled 块与工具装配需访问
  let evolutionCortex: EvolutionCortex | null = null;
  // 记忆认知架构升级（Phase 4）：knowledge 服务外层声明
  // brainEnabled 块内实例化，brainNeuroEnabled 块内 7 子模块装配需访问。
  // 两者均为 null 时子模块走降级路径（不阻塞主流程）。
  let knowledgeVerificationService: KnowledgeVerificationService | null = null;
  let knowledgeGapExecutor: KnowledgeGapExecutor | null = null;
  // 顺嘴搭车队列（2026-10-01 P1）：low 级主动意图挂起等下一轮对话织入回复末尾。
  // 共享单例——主动外发执行器（挂起点）与 ProactivityHub（挂起点+取货口）用同一队列。
  const turnAsideQueue = new TurnAsideQueue();
  if (brainEnabled) {
    brainCenter = new BrainCenter();
    brainCenter.registerRuntimeKernel(getRuntimeKernel());

    // RuntimeKernel minimal 模式下，会话首条 system 由 thread-store 注入一次：
    // - thread-store 在创建/恢复会话时调用 sessionSystemProvider() 取 system 文本写入 msgs[0]
    // - provider 检测到 suppressRuntimeSuffixes + overrideSys 时跳过覆盖 msgs[0]（首轮注入一次）
    // - 靠前缀缓存命中降低每轮字节重发开销（content 不变时命中 cache-read）
    // 注：此处使用 singleton kernel；若需 per-actor 个性化 sessionSys，需在 provider 层透传 actorId（独立大改）
    getChatThreadStore().setSessionSystemProvider(() => getRuntimeKernel().buildSessionSystem() ?? null);
    capabilityCortex = new CapabilityCortex();
    awarenessCortex = new AwarenessCortex();
    // 睡眠样本落盘（2026-10-01 rhythm 断供根修）：重启不丢积累，3 晚即可
    // 凑齐 SLEEP_WINDOW_MIN_SAMPLES 让节律引擎有真实作息数据
    awarenessCortex.setPersistPath(join(process.cwd(), "data", "proactivity"));
    proactionCortex = new ProactionCortex();
    // EvolutionCortex 四子系统总开关（BRAIN_EVOLUTION_ENABLED，实验性子系统默认关闭）：
    // 关闭时整个 EvolutionCortex 块跳过装配（evolutionCortex 保持 null），Phase 5
    // 定时器与 self_evolution.* 工具均不创建；开启后行为与现状一致。
    if (brainEvolutionEnabled) {
      evolutionCortex = new EvolutionCortex();
    } else {
      console.log("[skip] EvolutionCortex disabled by ENV");
    }

    // CapabilityCortex：注入回 prompt builder（让能力域出现在 prompt 中）
    setCapabilityCortex(capabilityCortex);

    // ─── GapAnalyzer 装配（identifyGap 的 LLM 语义分析）───
    // identifyGap 不是热路径（由 EvolutionCortex 周期触发），可承受 LLM 调用成本。
    // BRAIN_LLM_IDENTIFYGAP_ENABLED=0 时降级到 SCENARIO_KEYWORD_MAP 规则匹配。
    const gapAnalyzer: GapAnalyzer = {
      async analyze(params) {
        const { scenario, existingDomains } = params;
        const failures = params.recentFailures?.slice(0, 5) ?? [];
        const failureBrief = failures.length > 0
          ? `\n最近工具失败记录：\n${failures.map((f) => `- ${f.tool}: ${f.errorMessage ?? "未知错误"}（请求：${f.userRequest ?? ""}）`).join("\n")}`
          : "";
        const prompt =
          `你是能力缺口分析器。分析用户场景，识别 Agent 当前能力是否足以应对，找出缺失的能力域。\n\n` +
          `用户场景：${scenario}${failureBrief}\n` +
          `当前已注册能力域：${existingDomains.join("、") || "（无）"}\n\n` +
          `已知能力域参考（可缺失的）：travel_planning, finance_deep, code_sandbox, self_programming, weather, shopping_order, calendar, health_fitness, email_sms, image_gen, smart_home, notes\n\n` +
          `分析规则：\n` +
          `  - 场景所需能力域已在 existingDomains 中 → 不是缺口\n` +
          `  - 场景所需能力域不在 existingDomains 中 → 是缺口\n` +
          `  - 缺口域属可 self-programming 扩展的（travel_planning/notes/code_sandbox/self_programming）→ suggestedAction 填"走 self-programming 生成"\n` +
          `  - 其他缺口 → suggestedAction 填"接入第三方工具"\n\n` +
          `只输出 JSON：{"gaps": [{"scenario": "场景描述", "missingCapability": "能力域标识", "suggestedAction": "建议动作"}], "rationale": "整体分析理由"}`;
        let raw = "";
        try {
          const provider = createExternalChatProviderFromEnv();
          if (!provider) throw new Error("no_chat_provider");
          await provider.streamCompletion(
            `gap-analyzer:${Date.now()}`,
            { text: prompt },
            (delta) => { raw += delta; },
            undefined,
            { ephemeralTurn: true, disableThinking: true, maxThreadMessages: 0 },
          );
        } catch (e) {
          throw new Error(`gap_analyzer_llm_failed:${String(e).slice(0, 60)}`);
        }
        const match = raw.match(/\{[\s\S]*\}/);
        if (!match) throw new Error("gap_analyzer_no_json");
        try {
          const parsed = JSON.parse(match[0]);
          const gaps: Array<{
            scenario: string;
            missingCapability: string;
            suggestedAction: string;
          }> = [];
          if (Array.isArray(parsed.gaps)) {
            for (const g of parsed.gaps) {
              if (g && typeof g === "object" && typeof g.missingCapability === "string") {
                gaps.push({
                  scenario: typeof g.scenario === "string" ? g.scenario : scenario,
                  missingCapability: g.missingCapability,
                  suggestedAction: typeof g.suggestedAction === "string" ? g.suggestedAction : "",
                });
              }
            }
          }
          return {
            gaps,
            rationale: typeof parsed.rationale === "string" ? parsed.rationale : undefined,
          };
        } catch {
          throw new Error("gap_analyzer_parse_failed");
        }
      },
    };
    capabilityCortex.registerGapAnalyzer(gapAnalyzer);

    // AwarenessCortex：注册生命信号子系统
    awarenessCortex.registerLifeSignalHub(lifeSignalHubService);
    awarenessCortex.registerDesktopPresence(desktopPresenceSignalService);
    awarenessCortex.registerMoodInference(moodInferenceService);
    awarenessCortex.registerAnticipation(anticipationEngineService);
    // Stage 3 Task 4：注入 schedule-task-service，用于 meeting 状态识别
    awarenessCortex.registerScheduleTask(scheduleTaskService);
    // 分级提醒策略的作息画像：优先用户自述/设定（冷启动立即可用），再回退
    // AwarenessCortex 实时睡眠样本（10 分钟一拍）、节律画像消化态；样本 <3 条
    // 返回 null，策略层走默认时刻（宁缺勿错）。
    // 取值顺序：显式设定 > 睡眠样本(≥3) > 对话自述 > 节律画像维度。
    scheduleTaskService.setReminderHabitProvider((sessionId) => {
      const routine = getScheduleHabitStore()?.get(sessionId) ?? null;
      if (routine?.source === "explicit") {
        return {
          sleepStartHour: routine.sleepStartHour,
          wakeHour: routine.wakeHour,
          sampleCount: 1,
          source: "explicit",
        };
      }
      // 被动观察（首选）：在场足迹——agent 记录用户何时在线，连续几晚即框出作息。
      // 用户「做」什么比「说」什么更硬，且不像睡眠样本那样要求判出 sleeping 状态。
      const observed = getPresenceFootprintStore()?.deriveSleepWindow(sessionId, {
        lookbackDays: 14,
      });
      if (observed && observed.sleepStartHour != null) {
        return {
          sleepStartHour: observed.sleepStartHour,
          wakeHour: observed.wakeHour,
          sampleCount: observed.nightCount,
          source: "observed",
        };
      }
      const direct = habitHintsFromSleepSamples(
        awarenessCortex?.getRecentSleepWindowSamples(sessionId, 14) ?? [],
      );
      if (direct) return direct;
      if (routine) {
        return {
          sleepStartHour: routine.sleepStartHour,
          wakeHour: routine.wakeHour,
          sampleCount: 1,
          source: "chat",
        };
      }
      const sleep = rhythmProfileStoreRef?.get(sessionId)?.dimensions.sleep;
      if (sleep && sleep.sampleCount >= 3 && sleep.windowStartHour != null) {
        return {
          sleepStartHour: sleep.windowStartHour,
          wakeHour: sleep.windowEndHour,
          sampleCount: sleep.sampleCount,
        };
      }
      return null;
    });
    // Task 20：节律引擎睡眠传感器接 AwarenessCortex 逐日睡眠样本
    // （brain 关闭时传感器无数据源，静默空转，其余维度不受影响）
    rhythmSleepSensor?.bindSource(awarenessCortex);

    // ProactionCortex：注册 contact policy + awareness + legacy 主动服务（仅 BRAIN_PROACTION_LEGACY=1）
    const proactiveContactPolicyService = new ProactiveContactPolicyService();
    proactionCortex.registerContactPolicy(proactiveContactPolicyService);
    // B3: 注入 AwarenessCortex，让 disturb 评分感知用户活动状态（busy/sleeping/just_off_work）
    proactionCortex.registerAwareness(awarenessCortex);
    // Stage 3 Task 4：反向注入 ProactionCortex，让 AwarenessCortex 查询 recentDecisions
    // 识别 in_focus 状态（持续 busy > 25min 且无 speak 打断）
    awarenessCortex.registerProaction(proactionCortex);
    // Stage 4 Task 3：注入 AgentSelfLearningService，让 assessConfidence 读取历史失败率
    // 作为元认知置信度评估的因子之一（失败率 > 0.3 → -0.2）。
    awarenessCortex.registerSelfLearning(agentSelfLearningService);
    // 语义觉察推断器：让 observeWithMental 能产出 UserMentalState（纯规则、零 token）。
    // 供对话内主动钩子(AgentCore.maybeTriggerConversationProactive)在需要主动开口时
    // 按需感知用户当下意图，避免常驻注入浪费 token。
    awarenessCortex.registerSemanticInferrer(new SemanticAwarenessInferrerImpl());
    // 端到端认知装配（registerMemory + registerEndToEndMaker + registerCognitiveEngine）
    // 已移到 memoryCortex 声明之后（见 brainNeuroEnabled 块内），避免作用域问题
    if (legacyProaction) {
      proactionCortex.registerLegacyProactiveAgentCenter(proactiveCenter);
      proactionCortex.registerLegacyProactiveLifeRuntime(proactiveLifeRuntimeService);
      proactionCortex.setShadowMode(true);
    }

    // EvolutionCortex：注册四个子系统（自学习 / 技能生成 / 晋升管道 / 进化循环）
    // BRAIN_EVOLUTION_ENABLED=0 时 evolutionCortex 为 null，整块跳过
    if (evolutionCortex) {
      evolutionCortex.registerSelfLearning(agentSelfLearningService);
      evolutionCortex.registerSkillGenerator(skillGenerator);
      if (trajectoryPromotionPipeline) {
        evolutionCortex.registerPromotionPipeline(trajectoryPromotionPipeline);
      }
      // 经验沉淀落地：skill_distill 提案执行成功后把 SKILL.md 写入磁盘 + 注册
      evolutionCortex.registerProceduralSink(skillManager);
      evolutionCortex.registerEvolutionLoop(evolutionLoopService);
    }

    // 知识缺口执行器（学知识层）：RAG 召回 + 联网兜底 + LLM 摘要 + 记忆沉淀 + 验证状态机
    // - 复用 toolRegistry 调 desktop.http_get（享受 URL 白名单+超时+审计）
    // - 复用 narrativeMemory（NarrativeMemoryPort：HumanLikeMemory + Mem0 + 向量库）
    // - 复用 agentMemorySyncService 写入 memory_facts KV（带验证状态标签）
    // - 复用 externalChat 做 LLM 摘要（去噪 + 提炼核心事实）
    // - 复用 knowledgeVerificationService 跟踪置信度 + 反馈累积
    // 记忆认知架构升级（Phase 4）：提升至外层作用域，brainNeuroEnabled 块内 7 子模块装配需访问。
    knowledgeVerificationService = new KnowledgeVerificationService();
    await knowledgeVerificationService.start();
    knowledgeGapExecutor = new KnowledgeGapExecutor({
      toolRegistry,
      narrativeMemory,
      memorySync: agentMemorySyncService,
      verification: knowledgeVerificationService,
      chatProvider: externalChat,
    });
    if (evolutionCortex) {
      evolutionCortex.registerKnowledgeExecutor(knowledgeGapExecutor);
      // 反馈回路：每次工具交互都通知 verification service，触发状态机演进
      evolutionCortex.registerKnowledgeVerification(knowledgeVerificationService);
    }

    // 注册 WS 审批推送器：自主进化闭环的关键依赖
    // EvolutionCortex 自动生成 Skill 后，通过此推送器向用户发送审批请求 WS 事件
    // BRAIN_EVOLUTION_ENABLED=0 时 evolutionCortex 为 null，跳过注册
    if (evolutionCortex) {
      evolutionCortex.registerApprovalEmitter({
        emitApprovalRequest: (sessionId, request) => {
          try {
            const payload = {
              type: "evolution.approval_request" as const,
              payload: { sessionId, ...request, timestamp: new Date().toISOString() },
            };
            // 推送给所有活跃连接（自主进化不绑定特定 session）
            wsConnectionRegistry.trySend(sessionId, JSON.stringify(payload));
          } catch {
            // 静默失败
          }
        },
        emitApprovalResult: (sessionId, result) => {
          try {
            const payload = {
              type: "evolution.approval_result" as const,
              payload: { sessionId, ...result, timestamp: new Date().toISOString() },
            };
            wsConnectionRegistry.trySend(sessionId, JSON.stringify(payload));
          } catch {
            // 静默失败
          }
        },
      });
    }

    // 注册皮层到 BrainCenter
    brainCenter.registerCapability(capabilityCortex);
    brainCenter.registerAwareness(awarenessCortex);
    brainCenter.registerProaction(proactionCortex);
    // BRAIN_EVOLUTION_ENABLED=0 时 evolutionCortex 为 null，不注册进化皮层
    if (evolutionCortex) {
      brainCenter.registerEvolution(evolutionCortex);
    }

    // ─── 自我修复皮层（CodeRepairCortex）装配 ───
    // 默认开启（BRAIN_CODE_REPAIR_ENABLED=0 关闭）。
    // 理由：用户明确要求"出问题的地方把它隔离，然后让 agent 自己去修复，
    // 去测试，然后自己改正"——这是核心能力，必须默认工作。
    // 安全边界已在 cortex 内部通过白名单 + 黑名单 + 危险模式黑名单三道闸门保证。
    // 装配 4 个依赖：
    //   1. LLM 适配器：把 ExternalChatProvider 包装成 CodeRepairLlmLike（一次性非流式调用）
    //   2. TestRunner：默认 DefaultTestRunner（跑 tsc --noEmit + 相关 test）
    //   3. BrainCenter.registerCodeRepair：外观层注入
    //   4. BrainCenter.start()：随主生命周期启动 autoLoop
    if (process.env.BRAIN_CODE_REPAIR_ENABLED?.trim() !== "0") {
      const codeRepairCortex = new CodeRepairCortex({
        serverRoot: process.cwd(),
      });

      // LLM 适配器：复用主聊天通道，但用 ephemeralTurn 避免污染会话历史
      // externalChat 可能为 null（未配置 OPENAI_API_KEY 时），适配器内部处理
      const codeRepairLlm: CodeRepairLlmLike = {
        async complete(systemPrompt, userPrompt, opts) {
          if (!externalChat) {
            throw new Error("externalChat 未配置（未设置 OPENAI_API_KEY 等环境变量）");
          }
          let fullContent = "";
          await externalChat.streamCompletion(
            `code-repair-${Date.now()}`,
            { text: userPrompt },
            (delta) => {
              fullContent += delta;
            },
            undefined,
            {
              systemPromptOverride: systemPrompt,
              ephemeralTurn: true,
              maxThreadMessages: 2,
            },
          );
          // 简单截断到 maxTokens（如果指定），避免 LLM 输出过长
          if (opts?.maxTokens && fullContent.length > opts.maxTokens * 4) {
            return fullContent.slice(0, opts.maxTokens * 4);
          }
          return fullContent;
        },
      };
      codeRepairCortex.registerLlm(codeRepairLlm);

      // 默认测试运行器：tsc --noEmit（60s）+ 相关 test（30s）
      const testRunner = new DefaultTestRunner(process.cwd(), {
        tscTimeoutMs: 60_000,
        testTimeoutMs: 30_000,
      });
      codeRepairCortex.registerTestRunner(testRunner);

      brainCenter.registerCodeRepair(codeRepairCortex);
      if (process.env.BRAIN_CODE_REPAIR_ENABLED?.trim() === "0") {
        console.log("[Bootstrap] CodeRepairCortex 未启用（BRAIN_CODE_REPAIR_ENABLED=0）");
      } else {
        console.log("[Bootstrap] CodeRepairCortex 已启用（默认开启）");
      }
    }

    // 注：BrainCenter.start() / registerBrainTools / setBrainChatTools
    // 已移至 5 个神经解剖分区装配完成之后调用，确保 9 分区均注册后再启动。

    // ─── 主动决策闭环：LifeSignalHub → BrainCenter.decide → 投递 ───
    // 通用路径：任何 LifeSignal 都直接转为 BrainSignalInput，喂给 ProactionCortex
    // 的 value/disturbance 双轨评分。不依赖 AwarenessCortex 的活动类型枚举，
    // 也不需要为新场景扩建关键词——信号自身的 importance/source/kind/metrics
    // 已足够驱动通用决策。AwarenessCortex 的活动推断仅用于 observe() 查询
    // 和（未来）打扰评分上下文，不再是主动决策的瓶颈入口。
    lifeSignalHubService.subscribe((signal) => {
      if (!brainCenter) return;
      // const 本地引用：let brainCenter 在 .then 闭包内会被还原为可空，
      // 用 const bc 锁定窄化，使 scheduleProactive 可直接调用。
      const bc = brainCenter;
      const brainSignal: BrainSignalInput = {
        actorId: signal.actorId,
        kind: signal.kind,
        title: signal.title,
        summary: signal.summary,
        importance: signal.importance,
        metadata: {
          source: signal.source,
          tags: signal.tags,
          metrics: signal.metrics,
          occurredAt: signal.occurredAt,
          description: signal.description,
        },
      };
      // 异步触发决策，不阻塞信号分发
      void bc.decide(brainSignal).then((decision) => {
        if (decision.outcome !== "speak") return;
        // 交小脑调度时机：busy/sleeping → defer 待复查；抑制窗口内 → defer 不抢话；
        // 否则犹豫 0.8-2.5s 后执行（执行前再查抑制窗口，犹豫期被打断则取消）。
        // 小脑未注册时（neuro 关闭）BrainCenter.scheduleProactive 直接 fire。
        void bc
          .scheduleProactive(decision, brainSignal, () =>
            executeProactiveOutreach(decision, brainSignal),
          )
          .catch((err) => {
            console.log(`[BrainCenter] 主动决策执行失败: ${err}`);
          });
      }).catch((err) => {
        console.log(`[BrainCenter] decide 调用失败: ${err}`);
      });
    });

    // ─── 主动决策执行器：已移交 proactivity 模块（proactive-outreach-executor.ts）───
    // bootstrap 只做接线：BrainCenter 决策 speak 后，由执行器完成「主动做事 + 话术生成 + 投递」。
    // brainCenter / synapseBus 以 getter 传入：两者在下方装配段才赋值，执行时才取值。
    const executeProactiveOutreach = createProactiveOutreachExecutor({
      externalChat: () => externalChat,
      toolRegistry,
      brainCenter: () => brainCenter,
      synapseBus: () => synapseBus,
      proactiveOutbound,
      agentMemorySyncService,
      // 顺嘴搭车：low 级主动消息挂起等下一轮对话织入（与 hub 共享同一队列实例）
      turnAsideQueue,
      // 死信闸：全设备离线时放弃话术生成（省 LLM 调用，不产生假台账）
      isActorOnline: (actorId) => proactivityPresence.isOnline(actorId),
    });

  }

  // ========== Webhook 事件驱动 ==========
  // 1) 先建 hookBus（全局唯一事件总线）
  // 2) WebhookService 启动时自动订阅 hookBus，业务代码只需 emit hook
  // 3) 其它服务也通过 hookBus 发事件，无需再 bind WebhookService
  const hookBus = new HookBus();
  setHookBus(hookBus); // 替换单例，便于无 DI 上下文的代码也能 emit

  // ── Feature Catalog：首次构建（覆盖至此已注册的工具/技能）并注入消费方 ──
  featureCatalog.build();
  setFeatureCatalog(featureCatalog);
  // CATALOG_WRITE_DOCS=1 时把能力地图落盘到仓库 docs/（自动生成，勿手改）
  if (process.env.CATALOG_WRITE_DOCS === "1") {
    try {
      const { writeFile, mkdir } = await import("node:fs/promises");
      const docsDir = join(process.cwd(), "..", "docs");
      await mkdir(docsDir, { recursive: true });
      await writeFile(join(docsDir, "CAPABILITY_MAP.md"), featureCatalog.toMarkdown(), "utf8");
      app.log.info("[FeatureCatalog] 能力地图已写入 docs/CAPABILITY_MAP.md");
    } catch (err) {
      app.log.warn(`[FeatureCatalog] 能力地图写盘失败（忽略）: ${err}`);
    }
  }

  const webhookService = new WebhookService(hookBus);
  webhookService.start();

  // 把 hookBus 注入到业务服务。
  // 业务服务 emit 的事件会被 hookBus 路由到所有订阅者，
  // 其中 WebhookService 已经自动订阅，会推送到外部端点。
  marketSignalService.bindHookBus(hookBus);
  lifeSignalHubService.bindHookBus(hookBus);

  // ── 习惯学习 → 自动执行闭环 ──
  // 观察源：①工具执行事件（下方 notifier 全量喂入）②位置历史（惰性闭包，
  // locationHistoryService 在本函数稍后构造，tick 触发时必已就绪）。
  // 执行出口：toolExecutor 走 toolRegistry（保留可用性/沙箱/两阶段等全部门禁）。
  const habitLoopService = new HabitLoopService({
    outbound: proactiveOutbound,
    storeFile: join(process.cwd(), "data", "habit-loop", "rules.json"),
    observationsFile: join(process.cwd(), "data", "habit-loop", "observations.json"),
    toolExecutor: async (tool, input, actorId, mode) => {
      // 分类层护栏：自动执行路径禁止 spend（花钱）/outbound（外发第三方）工具；
      // 用户已确认（confirmed）路径不拦（金融类仍有 AgentTaskSafety/两阶段确认兜底）
      if (mode === "auto") {
        const cls = classifyFeatureByName(tool);
        if (cls.risk === "spend" || cls.risk === "outbound") {
          return {
            ok: false,
            result: {
              error: `习惯自动执行已拦截：${tool} 属于 ${cls.risk === "spend" ? "花钱" : "外发第三方"}类工具，自动模式不允许。请改用每次确认模式，或换用低风险动作`,
            },
          };
        }
      }
      try {
        return await toolRegistry.execute(tool, input, {
          sessionId: `habit-loop-${actorId}`,
          userId: actorId,
        });
      } catch (err) {
        return { ok: false, result: { error: err instanceof Error ? err.message : String(err) } };
      }
    },
    locationLister: async (actorId, sinceMs) => {
      if (!locationHistoryService) return [];
      const samples = locationHistoryService.query(actorId, new Date(sinceMs));
      return samples.map((s) => ({
        at: Date.parse(s.recordedAt) || 0,
        latitude: s.latitude,
        longitude: s.longitude,
        label: s.label ?? undefined,
      }));
    },
  });
  habitLoopService.start();
  registerHabitLoopBuiltinSkills((skill) => skillManager.register(skill), { habitLoop: habitLoopService });
  // 「为你推荐」按用户个性化：注入工具执行观察（只读快照，服务端按 actorId 过滤）
  // 与画像行为信号（按用户加权轮换）。无身份调用完全不个性化。
  configureChatSuggestionUsageSource(() => habitLoopService.getToolUsageObservations());
  configureChatSuggestionProfileSource((actorId) => {
    const b = userPersonalizationService.getBehaviorSignals(actorId);
    return {
      shoppingInterest: b.shoppingInterest,
      planningInterest: b.planningInterest,
      companionNeed: b.companionNeed,
      privacyConcern: b.privacyConcern,
    };
  });

  // ── 图片能力套件 skill 化（PictureKit 在上方 data/pictures 根目录创建）──
  // picture.gallery 与 capability-module 工具同名接管执行；
  // 注册后经工具目录导出以 resource_type="skill" 同步进 tool-router skill 库。
  registerPictureBuiltinSkills((skill) => skillManager.register(skill), { pictureKit });

  // ── 到站管家（接站 / 接机 / 到站打车）──
  // 状态 provider 链：航旅纵横（航班实时）→ 聚合数据（车次时刻表）→
  // 票面兜底；缺 key 自动降级，实时性由设备定位兜底。
  const arrivalMonitorService = new ArrivalMonitorService({
    outbound: proactiveOutbound,
    providers: [new VariflightFlightProvider(), new JuheTrainProvider(), new ManualScheduleProvider()],
    emailSms: emailSmsService,
    platformGateway: messagePlatformGateway,
    // 定位兜底：无实时动态 API 时按设备最新定位判定「已到站」。
    // locationHistoryService 在本函数稍后构造，引用必须整体包在闭包内惰性求值。
    getLocation: (actorId) => {
      if (!locationHistoryService) return null;
      const sample = locationHistoryService.latest(actorId);
      return sample
        ? { latitude: sample.latitude, longitude: sample.longitude, label: sample.label ?? undefined }
        : null;
    },
    defaultActorId: process.env.MESSAGE_BRIDGE_DEFAULT_ACTOR_ID?.trim() || undefined,
  });
  arrivalMonitorService.start();
  // 到站管家技能（版本闸：开源版剔除；监控服务生命周期保持启停对称）
  if (!isOssEdition()) {
    registerArrivalConciergeBuiltinSkills((skill) => skillManager.register(skill), {
      arrivalMonitor: arrivalMonitorService,
      bookingService,
    });
  }

  // ── 旅行票务预订闭环（travel 域结算/出票技能；版本闸：开源版剔除）──
  const travelTicketProvider =
    (bookingService.providersForDomain("travel")[0] as TravelTicketProvider | undefined) ?? null;
  if (!isOssEdition()) {
    if (travelTicketProvider) {
      registerBookingTravelBuiltinSkills((skill) => skillManager.register(skill), {
        alipayBotService,
        bookingOrderStore,
        travelTicketProvider,
        audit: auditService,
      });
    } else {
      app.log.warn("[BookingTravel] travel 域 provider 未注册，跳过结算技能装配");
    }
  }

  // ── 全双工实时语音（WS /ws/voice-duplex）──
  // 引擎装配：云端 MiniMax 只是「实时语音引擎端口」的一个实现。接入本地引擎或
  // 换其它云端时，只需往 realtimeEngines 里加一个 RealtimeVoiceEngine 实现；
  // 会话层、协议层、客户端均不动。无可用引擎时自动回退 pipeline（ASR+LLM+TTS）。
  const minimaxRealtimeService = new MiniMaxRealtimeService();
  const minimaxEngine = new MiniMaxRealtimeEngine(minimaxRealtimeService);
  // 电话通话同步切 realtime：开启后通话对话由 duplex 引擎按 callId 上下文接管，
  // phone.call_reply 打字回复与接通首问 LLM 链路停用。
  virtualPhoneService.setRealtimeVoiceEnabled(minimaxEngine.isEnabled());
  const voiceDuplexService = new VoiceDuplexService({
    voiceDialogueService,
    realtimeEngines: [minimaxEngine],
    // 通话上下文注入：session.start 带 sessionId=callId 时，把通话场景并进 realtime 人设
    callVoiceContext: (callId) => virtualPhoneService.getCallVoiceContext(callId),
    systemPrompt: process.env.VOICE_DUPLEX_SYSTEM_PROMPT?.trim() || undefined,
    maxSessions: 16,
  });
  registerVoiceDuplexWsRoute(app, voiceDuplexService);
  app.log.info(
    `[VoiceDuplex] 全双工语音已启用（/ws/voice-duplex，引擎=${
      minimaxEngine.isEnabled()
        ? minimaxEngine.descriptor.name
        : `pipeline（ASR=${process.env.FUNASR_BASE_URL ? "FunASR流式" : "回退整句"}）`
    }）`,
  );

  // ── Task 16 消费管家：工具执行成功事件（tool.executed）发布 ──
  // 工具执行统一出口（ToolRegistry.execute 成功路径）→ 通知器 → 仅消费类
  // 工具（支付/钱包/跑腿/下单）成功后 emit（副作用工具仅成功时发布；
  // 摘要化 payload：长字符串截断防二维码 dataURL 撑爆事件历史）。
  toolRegistry.setToolExecutedNotifier((info) => {
    // 习惯闭环观察源：全量工具执行（消费过滤只影响 hookBus 发布）
    habitLoopService.recordToolEvent(info.actorId, info.tool);
    if (!isConsumptionTool(info.tool)) return;
    hookBus.emit(
      "tool.executed",
      {
        toolName: info.tool,
        args: summarizeToolPayload(info.input),
        result: summarizeToolPayload(info.result),
        actorId: info.actorId,
        timestamp: info.timestamp,
      },
      { actorId: info.actorId, source: "tool-registry" },
    );
  });

  app.log.info(`[AgentRuntime] ${formatAgentRuntimeConfigSummary(getAgentRuntimeConfig())}`);

  const desktopVisual = createDesktopVisualFromEnv();
  const visionPeriodicScheduler = new VisionPeriodicScheduler({
    runtime,
    wsRegistry: wsConnectionRegistry,
    // 懒引用（desktopVisual 在上方一行才创建；桥/本机视觉均走该端口）
    getVisualPort: () => desktopVisual,
  });
  // 主动性在场服务引用（proactivityPresence 在下方才构造；桌面同步回调运行时已就绪）
  let proactivityPresenceRef: import("../proactivity/presence-service.js").PresenceService | null = null;
  const desktopBridgeCoordinator = new DesktopBridgeCoordinator({
    onSync: (actorId, payload) => {
      wsConnectionRegistry.trySend(
        actorId,
        JSON.stringify({ type: ServerEventType.DesktopBridgeSync, payload }),
      );
      desktopPresenceSignalService.handleSync(actorId, payload);
      // 桌面 presence 同步 = 用户活跃标记，喂节律感知（连续工作/深夜检测）
      rhythmCore?.noteActivity(actorId, "desktop_presence");
      // 同步刷新主动性在场：否则静默工作 10 分钟后被误判 idle，
      // 重新开口时会触发假性「你离开了 N 小时」问候
      proactivityPresenceRef?.noteActivity(actorId);
    },
    onTaskResult: (actorId, payload) => {
      desktopPresenceSignalService.handleTaskResult(actorId, payload);
    },
  });

  // vision 工具族需要 desktopBridgeCoordinator 才能走 desktop:bridge 截图路径，
  // 必须在 desktopBridgeCoordinator 实例化后注册。
  registerVisionTools(toolRegistry, visionPeriodicScheduler, deviceRegistry, desktopBridgeCoordinator);
  registerDesktopVisualTools(toolRegistry, {
    localVisual: desktopVisual,
    bridge: desktopBridgeCoordinator,
    audit: auditService,
  });
  agentCore.setDesktopBridgeCoordinator(desktopBridgeCoordinator);

  // 按需位置协调器：Agent 需要位置（位置类工具）时向客户端请求实时 GPS。
  const locationCoordinator = new LocationCoordinator();
  agentCore.setLocationCoordinator(locationCoordinator);
  // 简报天气定位兜底经延迟引用取到此处创建的协调器
  locationCoordinatorRef.current = locationCoordinator;
  // 安全守护 SOS 的按需定位同样取此处创建的协调器
  wellnessLocationRef.current = locationCoordinator;

  // 分级提醒策略的实时路程因子（2026-10-05）：出发预留不再按 venue 静态表，
  // 用「用户当前位置 × 任务地点」的驾车实时路程。位置取用顺序：最近已知定位
  // （2 小时内新鲜）→ 按需向客户端请求实时 GPS（8s 等待，复用协调器新鲜缓存）
  // → 都没有则回退静态表（行为不劣于现状）。整体 6s 预算，策略计算不拖死建任务。
  scheduleTaskService.setRouteEstimator(async (input) => {
    if (!input.location?.trim()) return null;
    let origin: { latitude: number; longitude: number } | undefined;
    const sample = locationHistoryService?.latest(input.sessionId);
    if (sample && Date.now() - Date.parse(sample.recordedAt) <= ROUTE_ORIGIN_FRESH_MS) {
      origin = { latitude: sample.latitude, longitude: sample.longitude };
    } else {
      const live = await locationCoordinator
        .requestLocation(input.sessionId, "schedule-depart-route")
        .catch(() => null);
      if (live) origin = { latitude: live.latitude, longitude: live.longitude };
    }
    if (!origin) return null;
    const budget = <T>(p: Promise<T>, ms: number): Promise<T | null> =>
      Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), ms))]);
    return budget(
      estimateDriveMinutes({
        destinationText: input.location,
        origin,
        osrmFallback: (from, to) => travelPlanningService.computeRoute(from, to),
      }),
      ROUTE_ESTIMATE_BUDGET_MS,
    );
  });

  // ─── 位置能力（方案 A-D）：默认全部关闭（隐私优先），LOCATION_TRACKING_MODE=continuous 显式开启 ───
  // 方案 C 地理围栏：用户显式创建围栏才存在位置触发，独立于持续模式常驻装配。
  const locationGeofenceService = new GeofenceService();
  registerGeofenceTools(toolRegistry, { service: locationGeofenceService, audit: auditService });
  // 方案 B 位置历史：默认开启（2026-09-05，本地 SQLite 不上云，LOCATION_HISTORY_ENABLED=0 关闭）。
  // 常去地点挖掘（对话 prompt 的【常去地点】块，零 LLM）依赖历史样本。
  const locationTrackingMode = locationCoordinator.getTrackingConfig().mode;
  const locationHistoryEnabled = isLocationHistoryEnabled(locationTrackingMode);
  const locationHistoryService = locationHistoryEnabled ? new LocationHistoryService() : null;
  // 常去地点/移动信号注入 AgentCore：对话 prompt 的位置背景（实时位置 + 常去地点）。
  agentCore.setLocationHistory(locationHistoryService);
  // 方案 D 节律联动：位置历史（若有）作为 receptivity 的移动负信号喂入节律引擎
  if (locationHistoryService && rhythmEngine) {
    rhythmEngine.registerSensor(new LocationSensor(locationHistoryService));
  }
  if (locationHistoryEnabled) {
    app.log.info(
      `[Location] 位置历史已开启（tracking=${locationTrackingMode}，保留 ${getLocationHistoryRetentionDays()} 天，本地 ${getLocationDbPath()}）；常去地点将注入对话 prompt`,
    );
  } else {
    app.log.info("[Location] 位置历史已关闭（LOCATION_HISTORY_ENABLED=0），仅按需定位与显式围栏生效");
  }

  // ─── Task 4: desktop.event → LifeSignal 转换 ───
  // 将 Python 端推送的桌面事件转为 LifeSignal 并 publish 到 LifeSignalHub，
  // 供 BrainStem（sweepOnce → recentSignals）与 ProactionCortex 消费。
  // 未知事件类型忽略；focus_change 频繁故 importance=low，window_open/close=medium。
  desktopBridgeCoordinator.subscribeEvents((actorId, event) => {
    const kindByEventType: Record<string, string> = {
      focus_change: "desktop_focus_change",
      window_open: "desktop_window_open",
      window_close: "desktop_window_close",
    };
    const kind = kindByEventType[event.eventType];
    if (!kind) return;

    const title = String(event.payload.title ?? "");
    const process = String(event.payload.process ?? "");
    const duration = event.payload.duration;
    const ts = event.timestamp;
    const occurredAt =
      typeof ts === "number"
        ? new Date(ts).toISOString()
        : Number.isNaN(Date.parse(ts))
          ? new Date().toISOString()
          : new Date(ts).toISOString();

    const importance: "low" | "medium" | "high" | "critical" =
      event.eventType === "focus_change" ? "low" : "medium";

    lifeSignalHubService.publish({
      id: `${actorId}:desktop-event:${kind}:${occurredAt}`,
      actorId,
      source: "desktop",
      kind,
      title: title || `desktop ${event.eventType.replace(/_/g, " ")}`,
      summary: [title, process].filter(Boolean).join(" - ") || `desktop ${event.eventType}`,
      tags: ["desktop", "desktop_event", event.eventType],
      importance,
      evidence: [
        `desktop event: ${event.eventType}`,
        title ? `title=${title}` : "",
        process ? `process=${process}` : "",
      ].filter(Boolean),
      metrics: typeof duration === "number" ? { duration } : undefined,
      occurredAt,
      metadata: {
        title,
        process,
        event_type: event.eventType,
        timestamp: event.timestamp,
      },
    });
  });

  // ─── 桌面情境感知（SceneWatcher）：会议勿扰 / 文档速读 / 商品比价 ───
  // 检测全部为本地零 token 规则（窗口标题 + 进程 + 停留时长，scene_tick 心跳）；
  // LLM 只在场景确认后单次调用（ephemeralTurn + maxOutputTokens 封顶）。
  // 默认关闭：情境监测涉及隐私，须用户显式 DESKTOP_SCENE_WATCHER_ENABLED=1。
  if (isDesktopSceneWatcherEnabled()) {
    const sceneExec = createDesktopSceneActionExecutor(desktopVisual, desktopBridgeCoordinator);
    // proactiveOutbound.send 的入参是 ProactiveOutboundLike 的超集，可直接复用
    const meetingHandler = new DesktopSceneMeetingHandler(sceneExec, proactiveOutbound);
    const documentHandler = new DesktopSceneDocumentHandler(sceneExec, externalChat, proactiveOutbound);
    const priceHandler = new DesktopScenePriceHandler(sceneExec, externalChat, proactiveOutbound);
    const sceneWatcher = new DesktopSceneWatcherService({
      onMeetingStarted: (actorId, info) => {
        void meetingHandler.onMeetingStarted(actorId, info).catch(() => {});
      },
      onMeetingEnded: (actorId, session) => {
        void meetingHandler.onMeetingEnded(actorId, session).catch(() => {});
      },
      onDocumentDetected: (actorId, info) => {
        void documentHandler.onDocumentDetected(actorId, info).catch(() => {});
      },
      onProductPageDetected: (actorId, info) => {
        void priceHandler.onProductPageDetected(actorId, info).catch(() => {});
      },
    });
    desktopBridgeCoordinator.subscribeEvents((actorId, event) => {
      if (
        event.eventType === "focus_change" ||
        event.eventType === "scene_tick" ||
        event.eventType === "window_open"
      ) {
        sceneWatcher.handleDesktopEvent(actorId, event.eventType, event.payload);
      } else if (event.eventType === "window_close") {
        sceneWatcher.handleWindowClose(actorId, event.payload);
      }
    });
    app.log.info("[DesktopSceneWatcher] 情境感知已启用（meeting DND / document digest / price check）");
  }

  // ─── Body Center 开关 ───
  // BODY_CENTER_ENABLED 未设置或非 "0"/"false"/"off" → 默认启用身体中心
  // 关闭时：整个 body/ 模块不实例化、BrainCenter.registerBodyGateway 会内部跳过
  const bodyCenterEnabled = !["0", "false", "off"].includes(
    (process.env.BODY_CENTER_ENABLED ?? "").trim().toLowerCase(),
  );

  // ─── Body Center 装配 ───
  // 启用 body 时：实例化 BodyModule（Eye/Ear/Skin/Vestibular/Homeostasis/Rhythm）+ BodyBus + ReflexArc + BodyGateway + BodyCenter
  // 关闭 body 时（BODY_CENTER_ENABLED=0）：整个 body/ 模块不实例化、不启动，
  //   BrainCenter.registerBodyGateway 内部会因 isBodyCenterEnabled() 返回 false 而忽略注入
  let bodyCenter: BodyCenter | null = null;
  let reflexArc: ReflexArc | null = null;
  // 节律感知核心（body 侧）：连续工作 / 深夜活跃检测；外层声明供
  // desktopBridgeCoordinator.onSync 闭包与 ProactivityHub 装配层引用。
  let rhythmCore: RhythmCore | null = null;
  if (bodyCenterEnabled) {
    // 1. BodyBus + ReflexArc（硬安全门，纯规则匹配）
    const bodyBus = new BodyBus();
    reflexArc = new ReflexArc();
    // 局部 const 引用：reflexArc 是外层 let（可空），闭包内 TS 无法自动窄化，
    // 用 reflexArcInst 在 if 块内保留 non-null 窄化。
    const reflexArcInst = reflexArc;

    // 2. BodyGateway：注入 ReflexArc + 兜底 ToolRegistry
    const bodyGateway = new BodyGateway({
      reflexArc,
      fallbackToolRegistry: {
        execute: async (name, args, opts) => {
          const actorId = opts?.actorId ?? "body-gateway";
          return toolRegistry.execute(name, args, {
            sessionId: actorId,
            userId: actorId,
            agentAccessMode: "full",
          });
        },
      },
    });

    // 3. 子系统适配器：真实服务接口 → BodyModule 期望的最小化结构接口
    //    （避免修改 body/ 目录，所有适配在装配层完成）

    // 3.1 DeviceRegistry → DeviceRegistryLike（Eye & HomeostasisCore 共用）
    //     真实 DeviceRegistry.invoke 返回 DeviceInvokeResult {ok, data?, error?}，
    //     期望 {ok, result?}；真实 openStream(deviceId, params) 返回 {ok, streamId, stream, error?}，
    //     期望 openStream(deviceId, streamId, params) 返回 AsyncIterable<{type, payload}>
    const deviceRegistryAdapter = {
      listByCapability: (_cap: string) => [] as Array<{ deviceId: string; kind: string }>,
      async invoke(
        deviceId: string,
        action: string,
        params: Record<string, unknown>,
      ): Promise<{ ok: boolean; result?: unknown }> {
        const r = await deviceRegistry.invoke(deviceId, action, params);
        return { ok: r.ok, result: r.data };
      },
      openStream(
        deviceId: string,
        _streamId: string,
        params: Record<string, unknown>,
      ): AsyncIterable<{ type: string; payload: Record<string, unknown> }> {
        const r = deviceRegistry.openStream(deviceId, params);
        if (!r.ok || !r.stream) {
          return (async function* () {
            /* empty stream */
          })();
        }
        const upstream = r.stream;
        return (async function* () {
          for await (const chunk of upstream) {
            yield {
              type: chunk.kind,
              payload:
                typeof chunk.data === "object" && chunk.data !== null
                  ? (chunk.data as Record<string, unknown>)
                  : { data: chunk.data },
            };
          }
        })();
      },
    };

    // 3.2 DesktopBridgeCoordinator → DesktopBridgeLike（Eye 用，可选）
    //     真实 desktopBridgeCoordinator.invoke(actorId, payload, timeoutMs) → DesktopVisualRunResult | null
    //     期望 runTask?({task, region}) → Promise<unknown>
    const desktopBridgeAdapter = {
      async runTask(opts: {
        task: string;
        region?: [number, number, number, number] | null;
        [key: string]: unknown;
      }): Promise<unknown> {
        return desktopBridgeCoordinator.invoke(
          "default",
          { task: opts.task, region: opts.region ?? null },
          600_000,
        );
      },
    };

    // 3.3 SmartHomeService → SmartHomeLike（Skin 用）
    //     真实 SmartHomeService.getState 返回 HADeviceState {entity_id, state: string, attributes, ...}
    //     期望 getState 返回 {state: Record<string, unknown>} | null
    //     真实控制走 callService(domain, service, data)
    const smartHomeAdapter = {
      async controlDevice(opts: {
        deviceId?: string;
        entityType?: string;
        entityId?: string;
        action?: string;
        params?: Record<string, unknown>;
      }): Promise<{ ok: boolean; state?: Record<string, unknown> }> {
        // action 形如 "light.turn_off" → domain=light, service=turn_off
        const action = String(opts.action ?? "");
        const [domain, service] = action.split(".");
        if (!domain || !service) return { ok: false };
        try {
          await smartHomeService.callService(
            domain,
            service,
            opts.params ?? {},
          );
          return { ok: true };
        } catch {
          return { ok: false };
        }
      },
      async getState(entityId: string): Promise<{ state: Record<string, unknown> } | null> {
        try {
          const r = await smartHomeService.getState(entityId);
          return { state: { ...(r.attributes ?? {}), value: r.state } };
        } catch {
          return null;
        }
      },
      async getAllStates(): Promise<Record<string, Record<string, unknown>>> {
        try {
          const list = await smartHomeService.getAllStates();
          const out: Record<string, Record<string, unknown>> = {};
          for (const s of list) {
            out[s.entity_id] = { ...(s.attributes ?? {}), value: s.state };
          }
          return out;
        } catch {
          return {};
        }
      },
    };

    // 3.4 ComputeQuotaService → ComputeQuotaLike（HomeostasisCore 用）
    //     真实 ComputeQuotaService.getState(sessionId) 返回 {limit, reserved, consumed, available}
    //     期望 getQuota() → number 0-1（配额剩余比例）
    const computeQuotaAdapter = {
      getQuota(): number {
        const s = computeQuotaService.getState("default");
        return s.limit > 0 ? s.available / s.limit : 1;
      },
    };

    // 4. BodyModule（注入现有服务 + 适配器为子系统）
    // 注：Hand / Mouth 已移除——工具执行统一走 capability-modules / 各 tools/*.ts
    //     直接注册到 ToolRegistry，经 BodyGateway fallback 兜底，不再有器官门面。
    const eye = new Eye({
      bodyBus,
      desktopVisualPort: desktopVisual,
      desktopBridge: desktopBridgeAdapter,
      deviceRegistry: deviceRegistryAdapter,
    });

    const ear = new Ear({
      bodyBus,
      voiceDialogue: voiceDialogueService,
      funasrAdapter,
    });

    // SmartHomeService 目前未提供状态变化订阅（无 onStateChange），
    // Skin 的 device_change 信号处于休眠；待 SmartHomeService 补充事件后自动生效。
    const skin = new Skin({
      bodyBus,
      smartHomeService: smartHomeAdapter as SmartHomeLike,
    });

    const vestibularApparatus = new VestibularApparatus({
      bodyBus,
      wsRegistry: wsConnectionRegistry,
      embodimentAutonomy,
    });

    const homeostasisCore = new HomeostasisCore({
      bodyBus,
      computeQuotaService: computeQuotaAdapter,
      deviceRegistry: deviceRegistryAdapter,
    });

    // 5. ReflexArc → BodyModuleLike 适配器
    //    ReflexArc 本身实现 ReflexArcLike（check/registerPattern/listPatterns），
    //    但 BodyCenter.setReflex 期望 BodyModuleLike（name/label/tools/act/sense/snapshot）。
    //    BodyGateway 已通过构造参数注入 reflexArc 作为硬安全门（execute 入口先过反射弧检查），
    //    此处适配器仅用于把 ReflexArc 纳入 BodyCenter.snapshot()/start()/stop() 统一管理。
    const reflexModuleAdapter = {
      name: "reflex" as const,
      label: "反射弧（脊髓反射）",
      tools: [] as string[],
      async act(_action: BodyAction): Promise<BodyActionResult> {
        // ReflexArc 已在 BodyGateway.execute 入口处生效，此处不会触达；
        // 返回 ok=true 空结果，避免万一被路由到时阻塞调用方。
        return { ok: true, result: {} };
      },
      async sense(_query: BodySenseQuery): Promise<BodySenseResult> {
        return {
          ok: true,
          data: { patterns: reflexArcInst.listPatterns().length },
        };
      },
      snapshot(): BodyModuleSnapshot {
        return {
          name: "reflex",
          label: "反射弧（脊髓反射）",
          tools: [],
          online: true,
          subsystems: ["reflex-arc"],
          lastActivityAt: null,
        };
      },
    };

    // 6. BodyCenter 外观类
    bodyCenter = new BodyCenter(bodyGateway, bodyBus);
    bodyCenter.setEye(eye);
    bodyCenter.setEar(ear);
    bodyCenter.setSkin(skin);
    bodyCenter.setVestibularApparatus(vestibularApparatus);
    bodyCenter.setHomeostasis(homeostasisCore);
    bodyCenter.setReflex(reflexModuleAdapter);
    // 6.0 节律感知核心（第 10 个 BodyModule）：用户作息学习（最后活跃→就寝
    //     基线），经 UserTimingService 统一取用口供各定时场景消费
    //     （过劳检测/干预链路 2026-10-16 已删除）。
    rhythmCore = new RhythmCore({ bodyBus }, join(process.cwd(), "data", "body"));
    bodyCenter.registerModule(rhythmCore);

    // 6.1 工具路由：仅保留仍有 BodyModule 承接的前缀（当前为空——
    //      工具执行统一由 capability-modules / tools/*.ts 直接注册的 handler 承接，
    //      BodyGateway.execute 对未路由工具走 fallbackToolRegistry 兜底，
    //      并在入口先过 ReflexArc 硬安全门）。
    //      eye.* / ear.* 走 BodyGateway.sense 上行通路，不走 execute 下行。
    //      reflex 是反射弧硬安全门，在 execute 入口已先于路由生效。

    // 5. 工具下沉：仍有工具门面的 BodyModule 通过 registerTools 挂到 ToolRegistry，
    //    handler 内部委托 this.act()；handler 调用栈：ToolRegistry → BodyModule.act → 子系统执行
    eye.registerTools(toolRegistry);
    ear.registerTools(toolRegistry);
    // homeostasisCore.tools=[] 跳过
    // reflexArc 无 registerTools 方法（不在 BodyModuleLike 工具下沉范围内）

    // 6. 注册 body.* LLM 工具（body.where_am_i / body.state / body.list_modules / body.calibrate）
    registerBodyTools(toolRegistry, bodyCenter);
    // 把 body.* 工具 schema 暴露给 LLM（与 setBrainChatTools 对称）。
    // bodyCenterEnabled=false 时本分支不进入，BODY_CHAT_TOOLS 不注入，保持原 getBuiltinAgentChatTools 行为。
    setBodyChatTools(BODY_CHAT_TOOLS);

    app.log.info(`[BodyCenter] 已装配 BodyModule（Eye/Ear/Skin/Vestibular/Homeostasis/Reflex/Rhythm）`);
    app.log.info(`[BodyCenter] 已下沉工具到 ToolRegistry（body.* 工具已注册）`);
    app.log.info(`[BodyCenter] ReflexArc 已加载 ${reflexArc.listPatterns().length} 条内置危险模式`);
  }

  // ─── Brain Center 神经解剖分区装配 ───
  // BRAIN_NEURO_ENABLED 未设置或非 "0"/"false"/"off" → 默认启用 5 个新分区
  // 关闭时：5 个新分区不实例化，BrainCenter 回退到 4 皮层模式
  //
  // 世界模型（World Model）在外层创建：两个装配块（神经分区块 + 端到端认知块）
  // 都需要访问。BRAIN_WORLD_MODEL_ENABLED=0 时不实例化，所有皮层走原路径（零影响）。
  const worldModel = createWorldModelFromEnv();
  if (worldModel) {
    console.log("[BrainCenter] WorldModel 已创建（RuleBasedWorldModel），将在各皮层装配时注入");
  }
  if (brainEnabled && brainNeuroEnabled && brainCenter) {
    // SynapseBus（突触总线 / 胼胝体）—— 先创建，供各皮层注册并建立订阅关系
    synapseBus = new SynapseBus();
    synapseBus.registerHookBus(hookBus);
    synapseBus.registerMessageHub(messageHubService);
    synapseBus.registerAipService(aipService);
    synapseBus.registerWsRegistry(wsConnectionRegistry);

    // SensoryCortex（感官皮层：耳/眼/嘴）
    const sensoryCortex = new SensoryCortex();
    sensoryCortex.registerVoiceDialogue(voiceDialogueService);
    sensoryCortex.registerVoiceCapability(voiceCapabilityService);
    sensoryCortex.registerDesktopVisual(desktopVisual);
    sensoryCortex.registerSynapseBus(synapseBus);
    brainCenter.registerSensory(sensoryCortex);

    // ─── SubTask 14.2 续：BodyBus 上行通路接入 brain ───
    // BodyBus 桥接到 SynapseBus（body.* 信号上达 brain 域）
    // BodyBus → SynapseBus.fire，让 brain 侧皮层通过 SynapseBus.subscribe 收到身体信号
    if (bodyCenter) {
      const bodyBus = bodyCenter.getBus();
      bodyBus.bridgeToSynapse(synapseBus);
      // SensoryCortex 订阅 BodyBus 的 body.eye.frame / body.ear.transcript
      sensoryCortex.attachBodyBus(bodyBus);
      // AwarenessCortex 订阅 body.homeostasis.battery_low / body.skin.device_change / body.vestibular.device_switch
      awarenessCortex?.attachBodyBus(bodyBus);
    }

    // MemoryCortex（记忆皮层 / 海马体）
    memoryCortex = new MemoryCortex();
    memoryCortex.registerShortTerm(shortTermMemoryGateway);
    if (agenticMemoryRuntime) {
      memoryCortex.registerAgentic(agenticMemoryRuntime);
    }
    memoryCortex.registerHumanLike(humanLikeMemory);
    // P0-1/P1-7：写入 fallback 收拢到 bridge（带 linkage）；召回走单次融合
    if (memoryBridge) {
      memoryCortex.registerBridge(memoryBridge);
    }
    if (narrativeMemory) {
      memoryCortex.registerNarrative(narrativeMemory);
    }
    memoryCortex.registerKvSummary(agentMemorySyncService);
    const memoryManagerService = getMemoryManagerService();
    if (memoryManagerService) {
      memoryCortex.registerMemoryManager(memoryManagerService);
    }
    if (nightlyMemoryService) {
      memoryCortex.registerNightlyScheduler(nightlyMemoryService);
    }
    memoryCortex.registerSynapseBus(synapseBus);
    brainCenter.registerMemory(memoryCortex);

    // ─── Phase 1：长期关系图谱 ───
    // 复用 HumanLikeMemoryService 的 relationship domain 作为存储后端，
    // 让 MemoryCortex.recall(domain="relationship") 能拉到关系轨迹摘要（≤200 char）。
    // 不新增 LLM 调用，纯规则读取 + 压缩输出。
    try {
      const { RelationshipGraphService } = await import("../services/relationship-graph-service.js");
      const relationshipGraph = new RelationshipGraphService(humanLikeMemory);
      relationshipGraph.setLifeModelStore(lifeModelStore);
      memoryCortex.registerRelationshipGraph(relationshipGraph);
      // 生活模型通道（实体/关系）并入召回仲裁；未初始化时传 null（通道跳过）
      memoryCortex.registerLifeModelStore(lifeModelStore);
      // 关系状态 → 生活模型收敛（真实挂载）：每轮 getPromptSlice 更新 warmth/rapport
      // 后回调，规则化里程碑检测（零 LLM）→ 建/刷 self_agent 边 + 追加轨迹点。
      userPersonalizationService.setRelationshipStateObserver((actorId, state) => {
        void relationshipGraph.detectAndRecordMilestone(actorId, state).catch(() => {});
      });
      console.log("[BrainCenter] 已注册 RelationshipGraphService（Phase 1 关系图谱）");
    } catch (err) {
      console.log("[BrainCenter] RelationshipGraphService 注册失败（忽略）:", err);
    }

    // 缺口 3 修复：注入 AwarenessCortex 到 nightly 服务，启用"夜间 + sleeping"双条件触发 dreaming
    // 注意：awarenessCortex 在 brainNeuroEnabled 块内创建（行 1093），
    // 此处注入若 awarenessCortex 未创建则传 null（降级为仅时间窗触发）
    if (nightlyMemoryService) {
      if (awarenessCortex) nightlyMemoryService.setAwarenessCortex(awarenessCortex);
      // 动态夜间窗口改走统一取用口（2026-10-16 接口统一）；
      // userTiming 不依赖 awarenessCortex，无它也要注入（多源兜底）
      nightlyMemoryService.setUserTiming(userTiming);
    }

    // 突触总线注册到 BrainCenter（各皮层已通过 registerSynapseBus 建立订阅）
    brainCenter.registerSynapse(synapseBus);

    // LimbicCortex（边缘皮层 / 杏仁核 + 情感）
    limbicCortex = new LimbicCortex();
    limbicCortex.registerTaskSafety(getAgentTaskSafety());
    limbicCortex.registerMoodInference(moodInferenceService);

    // 包装 assistant-tone-policy 函数为 TonePolicyLike 对象
    // services/assistant-tone-policy.ts 导出的是函数而非类，此处适配 decide 入口。
    const tonePolicyAdapter = {
      decide: (text: string, _emotion: unknown) =>
        detectAssistantToneMode(text),
    };
    limbicCortex.registerTonePolicy(tonePolicyAdapter);

    // 包装 emotion-tone 函数为 EmotionToneLike 对象
    // services/user-personalization/emotion-tone.ts 同样是函数模块，此处适配。
    const emotionToneAdapter = {
      detectEmotionFromText,
      detectPreferredToneFromText,
      buildToneGuidance: (state: unknown) =>
        buildToneGuidance(state as EmotionState),
    };
    limbicCortex.registerEmotionTone(emotionToneAdapter);

    limbicCortex.registerSynapseBus(synapseBus);
    brainCenter.registerLimbic(limbicCortex);

    // PlannerCortex（额叶规划皮层）
    const plannerCortex = new PlannerCortex();
    // 2026-09-05 双面架构：路由唯一权威是 llm-task-router（routeTurnByLlm），
    // 不再向 PlannerCortex 注册词法路由（旧 routeTask 已删除）。

    // PlanExecuteLoop 适配器：将 runPlanExecuteLoop 函数包装为 { plan, execute, react } 对象。
    // - plan(goal): 调用 runPlanExecuteLoop 生成计划（函数内部已含执行），缓存结果。
    // - execute(plan): 返回缓存的执行结果（plan=null 触发 applyExecutionResult 将所有
    //   pending step 标记为 completed，避免 mergeStepStatuses 把 step 回退为 pending）。
    // - react(observation): 原样返回（PlannerCortex 为同步调用）。
    // 限制：规划皮层无 per-request 的 toolCtx/baseStreamOpts，工具执行由 AgentCore 主路径
    //       处理；此适配器让 PlannerCortex.plan() 能产出 LLM 生成的结构化计划，替代关键词兜底。
    let lastPeResult: PlanExecuteLoopResult | null = null;
    const planExecuteAdapter = {
      plan: async (goal: string, opts?: unknown) => {
        if (!externalChat) {
          return { finalText: "", plan: null };
        }
        const actorId = (opts as { actorId?: string } | undefined)?.actorId ?? "planner-cortex";
        lastPeResult = await runPlanExecuteLoop({
          provider: externalChat,
          planSessionId: `planner-cortex:${actorId}:${Date.now()}`,
          userText: goal,
          toolCtx: undefined,
          baseStreamOpts: undefined,
        });
        return lastPeResult;
      },
      execute: async (_plan: unknown, _opts?: unknown) => {
        return { finalText: lastPeResult?.finalText ?? "", plan: null };
      },
      react: (observation: unknown) => observation,
    };
    plannerCortex.registerPlanExecuteLoop(planExecuteAdapter);

    // 注册 ToolExecutor：让 PlannerCortex.execute 在 PlanExecuteLoop 返回空时
    // fallback 到真实执行 expectedTools，实现 plan→execute→react 闭环。
    plannerCortex.registerToolExecutor({
      execute: async (name, args, opts) => {
        const actorId = opts?.actorId ?? "planner-cortex";
        return toolRegistry.execute(name, args, {
          sessionId: actorId,
          userId: actorId,
          agentAccessMode: "full",
        });
      },
    });

    // 2026-08-29 master 委派层已删除：PlannerCortex.delegate 无真实委派目标，
    // 不再注册 MasterCoordinator（任务统一走 plan-and-execute 全量工具循环）。

    brainCenter.registerPlanner(plannerCortex);

    // ─── DelegateJudge 装配（shouldDelegate 的 LLM 语义判断）───
    // 仅在边界情况（步骤数 > 阈值但规则未命中委派关键词）时调用 LLM 做语义判断。
    // 热路径成本控制：白名单预筛 + 规则快速路径 + 步骤数阈值 → 绝大多数请求不触发 LLM。
    // BRAIN_LLM_SHOULDDELEGATE_ENABLED=0 时降级到纯规则 shouldDelegate。
    // 决策器实现已抽到 brain/decision-maker-factory.ts，支持未来"换大脑"时同步替换。
    const delegateJudge = createDefaultDelegateJudge();
    plannerCortex.registerDelegateJudge(delegateJudge);

    // ─── subcortical 分区（脑干/小脑）───
    // 脑干：自主节律——45s 心跳扫描，察觉 sustained_busy / late_night / 趋势翻转，
    //       产出合成 LifeSignal 回流 hub，让 Agent 具备"自己察觉"的持续感知。
    // 小脑：时序协调——皮层决定说，小脑决定何时说。busy/sleeping defer、
    //       用户开口打断时清空 defer 队列 + 设 60s 抑制窗口，避免抢话。
    // 两者均注入 awarenessCortex.observe() 用于读用户活动状态。
    // 生命周期由 BrainCenter.start()/stop() 统一托管（startCortex/stopCortex）。
    if (awarenessCortex) {
      const brainStem = new BrainStem();
      brainStem.registerLifeSignalHub(lifeSignalHubService);
      brainStem.registerAwareness(awarenessCortex);
      // Stage 3 Task 1：注入 SensoryCortex，使脑干心跳扫描时能调 look()
      // 周期性获取屏幕描述（busy 时每 5 分钟一次），发布 desktop_app_focus 信号。
      brainStem.registerSensory(sensoryCortex);
      brainStem.registerUserPersonalization(userPersonalizationService);
      // 人格/情绪簇集成：注入 MemoryCortex 引用，使 PersonalityAdjuster
      // 能在 observeTurnAsync 中读写 MemoryCortex.personalityCache
      if (memoryCortex) {
        userPersonalizationService.registerMemoryCortex(memoryCortex);
      }
      brainCenter.registerBrainStem(brainStem);

      const cerebellum = new Cerebellum();
      cerebellum.registerAwareness(awarenessCortex);
      brainCenter.registerCerebellum(cerebellum);
    }

    // ─── Phase 4：多模态融合皮层 ───
    // 纯规则冲突检测 + 优先级仲裁，无 LLM 调用、不增加 token。
    // BRAIN_MULTIMODAL_FUSION_ENABLED=0 时 BrainCenter 内部自动降级回 buildSensoryFrame。
    if (sensoryCortex) {
      const { MultimodalFusionCortex } = await import("../brain/multimodal-fusion-cortex.js");
      brainCenter.registerMultimodalFusion(new MultimodalFusionCortex());
    }

    // ─── 世界模型（World Model）装配：第一部分 ───
    // plannerCortex 在此块内创建，注入 WorldModel 开启 model-based planning 能力。
    // predictiveCodingFeed / metaCognition 在第二块创建，由第二部分注入。
    if (worldModel) {
      plannerCortex.registerWorldModel(worldModel);
      console.log("[BrainCenter] WorldModel 已注入 PlannerCortex（model-based planning）");
    }
  }

  // ─── 端到端认知装配（整体端到端调度的核心）───
  // proactionCortex 在 brainEnabled 块创建，memoryCortex 在 brainNeuroEnabled 块创建。
  // 两者就绪后注入端到端决策器：一次 LLM 完成"理解+决策+响应"，不再切片式串联各脑区。
  if (proactionCortex && memoryCortex && brainCenter) {
    // ProactionCortex 主动认知端到端：注入记忆 + 端到端决策器
    proactionCortex.registerMemory(memoryCortex as unknown as MemoryCortexLike);
    // 注入最近对话提供者：让主动决策能感知用户当前话题走向，
    // 避免用户已转换话题后还回去讲旧话题（根源修复"重复且不正面回复"问题）。
    const recentConvProvider: RecentConversationProvider = {
      fetchRecentConversation(actorId: string, limit = 6): string {
        try {
          const chatSessionId = resolvePrimaryChatSessionId(
            actorId,
            getAgentRuntimeConfig().masterDelegation.enabled,
          );
          const messages = getChatThreadStore().thread(chatSessionId, "");
          const recent = messages.slice(-limit);
          const lines: string[] = [];
          for (const msg of recent) {
            const role = msg.role === "user" ? "用户" : msg.role === "assistant" ? "Agent" : null;
            if (!role) continue;
            const content = typeof msg.content === "string" ? msg.content : "[多模态消息]";
            const cleaned = content.replace(/^\[ts:[^\]]+\]\n?/, "").trim();
            if (cleaned) lines.push(`${role}：${cleaned}`);
          }
          return lines.join("\n");
        } catch {
          return "";
        }
      },
    };
    proactionCortex.registerRecentConversationProvider(recentConvProvider);
    // 决策器实现已抽到 brain/decision-maker-factory.ts，支持未来"换大脑"时同步替换。
    const endToEndMaker = createDefaultEndToEndDecisionMaker();
    proactionCortex.registerEndToEndMaker(endToEndMaker);

    // 注册 ActionExecutor：让 ProactionCortex 决策后能直接执行环境控制类动作
    // （如关窗/调空调/创建日程），而非只发消息。注入 ToolRegistry 的包装。
    proactionCortex.registerActionExecutor({
      execute: async (name, args, opts) => {
        const actorId = opts?.actorId ?? "proaction-cortex";
        return toolRegistry.execute(name, args, {
          sessionId: actorId,
          userId: actorId,
          agentAccessMode: "full",
        });
      },
    });

    // BrainCenter 被动认知端到端：注入认知引擎（一次 LLM 完成路由+响应+记忆判断）
    // 认知引擎实现已抽到 brain/cognitive-engine-factory.ts，通过 COGNITIVE_ENGINE_IMPL 环境变量
    // 配置驱动选择不同实现，支持未来"换大脑"（升级到更强 LLM / 切换到 AGI 世界模型）。
    const cognitiveEngine = createCognitiveEngineFromEnv();
    brainCenter.registerCognitiveEngine(cognitiveEngine);

    // ─── Step 7 扩展：DecisionHub 装配（规则驱动端到端认知）───
    // 替代 cognitiveEngine 的 LLM 路由判断：规则驱动，避免幻觉。
    // BrainCenter.cognize 阶段 2 优先调用 DecisionHub.decidePassive，
    // 未注册时回退到 cognitiveEngine（向后兼容）。
    const ruleRouter = new RuleRouter();
    const actionExecutor = new ActionExecutor({
      execute: async (name, args, opts) => {
        const actorId = opts?.actorId ?? "decision-hub";
        return toolRegistry.execute(name, args, {
          sessionId: actorId,
          userId: actorId,
          agentAccessMode: "full",
        });
      },
    });
    // 注入 LimbicCortex 用于统一安全检查
    if (limbicCortex) {
      actionExecutor.registerLimbic(limbicCortex as unknown as import("../brain/action-executor.js").LimbicCortexLike);
    }
    // Task 12 工具下沉：把 BodyGateway 注入 ActionExecutor，
    // 使 BrainCenter 决策的 BrainDecisionAction 走 BodyGateway（先过反射弧，再路由到 BodyModule.act），
    // 未下沉工具降级到 ActionExecutor 自带的 toolRegistry fallback。
    // bodyCenter 为 null（BODY_CENTER_ENABLED=0）时不注入，ActionExecutor 自动走原 toolRegistry 直连路径。
    if (bodyCenter) {
      actionExecutor.registerBodyGateway(bodyCenter.getGateway());
      // P0-2 工具执行反馈闭环：注入 BodyBus，让 execute 成功/失败后回流信号
      // 到 BodyBus（body.action.executed / body.action.failed），
      // 下一轮 cognize 可通过 BodyBus 感知上一轮 hand 做了什么。
      actionExecutor.registerBodyBus(bodyCenter.getBus());
    }
    const decisionHub = new DecisionHub(ruleRouter, actionExecutor);
    // 注入共享认知能力（记忆/状态/能力）
    if (memoryCortex) {
      decisionHub.registerMemory(memoryCortex as unknown as import("../brain/decision-hub.js").MemoryCortexLike);
    }
    if (awarenessCortex) {
      decisionHub.registerAwareness(awarenessCortex as unknown as import("../brain/decision-hub.js").AwarenessCortexLike);
    }
    if (capabilityCortex) {
      decisionHub.registerCapability(capabilityCortex as unknown as import("../brain/decision-hub.js").CapabilityCortexLike);
    }
    brainCenter.setDecisionHub(decisionHub);
    console.log("[BrainCenter] DecisionHub 装配完成（规则驱动端到端认知 + 统一 ActionExecutor）");

    // ─── Step 7 扩展：7 个新皮层模块装配 ───
    // 类人化 4 模块 + Agent 特化 3 模块，全部注册到 BrainCenter + DecisionHub
    const workingMemoryCortex = new WorkingMemoryCortex();
    const taskSwitchingCortex = new TaskSwitchingCortex();
    taskSwitchingCortex.registerWorkingMemory(workingMemoryCortex); // 任务切换联动工作记忆
    const contextCortexLocal = new ContextCortex();
    if (awarenessCortex) {
      contextCortexLocal.registerAwareness(awarenessCortex as unknown as import("../brain/context-cortex.js").ContextAwarenessLike);
    }
    const toolPlanningCortex = new ToolPlanningCortex();
    const onlineLearningCortex = new OnlineLearningCortex();

    // 注册到 BrainCenter
    brainCenter.registerWorkingMemoryCortex(workingMemoryCortex);
    brainCenter.registerTaskSwitchingCortex(taskSwitchingCortex);
    brainCenter.registerContextCortex(contextCortexLocal);
    brainCenter.registerToolPlanningCortex(toolPlanningCortex);
    brainCenter.registerOnlineLearningCortex(onlineLearningCortex);

    const emotionModulator = new EmotionModulator();
    brainCenter.registerEmotionModulator(emotionModulator);
    decisionHub.registerEmotionModulator(emotionModulator);

    // 深度优化：让脑干定期调度 WorkingMemoryCortex.decay() 和白天 idle 记忆整理
    // 通过 BrainCenter.getBrainStem() 拿回 brainStem 引用（brainStem 在上方 if 块内创建）
    const brainStemRef = brainCenter.getBrainStem() as unknown as
      | (import("../brain/brain-stem.js").BrainStem & {
          registerWorkingMemory(wm: import("../brain/brain-stem.js").BrainStemWorkingMemoryLike): void;
          registerMemoryConsolidator(mc: import("../brain/brain-stem.js").BrainStemMemoryConsolidatorLike): void;
          registerSequencePatternMiner(miner: import("../services/sequence-pattern-miner.js").SequencePatternMiner): void;
        })
      | null;
    if (brainStemRef) {
      brainStemRef.registerWorkingMemory(workingMemoryCortex);
      // 仿人记忆连续性：白天 idle 时触发轻量记忆整理，不必等到夜晚 dreaming
      const memMgrForBrainStem = getMemoryManagerService();
      if (memMgrForBrainStem) {
        brainStemRef.registerMemoryConsolidator(memMgrForBrainStem);
      }

      // ─── Phase 3：序列模式预测 ───
      // 让脑干心跳扫描时调 SequencePatternMiner 从 LifeSignalHub 历史挖掘序列模式，
      // 当前事件流匹配模式前缀时合成 predicted_action 信号。
      // 纯规则无 LLM 调用，PredictiveActionSynthesizer 已在 BrainStem 内部实例化。
      try {
        const { SequencePatternMiner } = await import("../services/sequence-pattern-miner.js");
        const miner = new SequencePatternMiner(lifeSignalHubService);
        brainStemRef.registerSequencePatternMiner(miner);
        console.log("[BrainStem] 已注册 SequencePatternMiner（Phase 3 序列预测）");
      } catch (err) {
        console.log("[BrainStem] SequencePatternMiner 注册失败（忽略）:", err);
      }
    }

    // ─── 记忆认知架构升级（Phase 4）：7 个子模块装配 ───
    // 主开关 BRAIN_MEMORY_COGNITIVE_ENABLED 缺省开启；关闭时 7 个子模块均不实例化，
    // MemoryCortex 行为与升级前完全一致（零影响降级）。
    // 各子模块内部还有独立开关（如 BRAIN_MEMORY_ASSOCIATIVE_ENABLED 等），
    // 控制运行时方法行为；此处仅负责实例化与注入。
    const memoryCognitiveEnabled = !["0", "false", "off"].includes(
      (process.env.BRAIN_MEMORY_COGNITIVE_ENABLED ?? "").trim().toLowerCase(),
    );
    if (memoryCognitiveEnabled) {
      try {
        // 实例化子模块（依赖注入：humanLikeMemory / knowledge 服务 / synapseBus）
        const associativeGraph = new MemoryAssociativeGraph({
          humanLike: humanLikeMemory as unknown as import("../brain/memory-cognitive/memory-associative-graph.js").HumanLikeMemoryAssociativeLike,
          knowledgeGapExecutor: knowledgeGapExecutor as unknown as import("../brain/memory-cognitive/memory-associative-graph.js").KnowledgeGapExecutorLike,
        });
        const metacognitionBridge = new MemoryMetacognitionBridge({
          memoryCortex: memoryCortex as unknown as import("../brain/memory-cognitive/memory-metacognition-bridge.js").MemoryCortexLike,
          knowledgeVerification: knowledgeVerificationService as unknown as import("../brain/memory-cognitive/memory-metacognition-bridge.js").KnowledgeVerificationLike,
          knowledgeGapExecutor: knowledgeGapExecutor as unknown as import("../brain/memory-cognitive/memory-metacognition-bridge.js").KnowledgeGapExecutorLike,
        });
        const forgettingController = new MemoryForgettingController();
        forgettingController.registerHumanLikeMemory(
          humanLikeMemory as unknown as import("../brain/memory-cognitive/memory-forgetting-controller.js").HumanLikeMemoryForgettingLike,
        );
        if (synapseBus) {
          forgettingController.registerSynapseBus(
            synapseBus as unknown as import("../brain/memory-cognitive/memory-forgetting-controller.js").SynapseBusLike,
          );
        }
        const schemaFormation = new MemorySchemaFormation({
          humanLike: humanLikeMemory as unknown as import("../brain/memory-cognitive/memory-schema-formation.js").HumanLikeMemorySchemaLike,
        });
        const salienceFilter = new MemorySalienceFilter();
        const experienceLearningLoop = new MemoryExperienceLearningLoop();
        // 生活模型持久化（P0 接线）：图式写入 life_patterns、经验/信念写入
        // life_episodes/life_beliefs，否则原纯内存 Map 重启即失。未初始化时跳过。
        if (lifeModelStore) {
          schemaFormation.setPersistence(lifeModelStore);
          experienceLearningLoop.setPersistence(lifeModelStore);
        }

        // 推理引擎（多线索交叉推理）：BRAIN_MEMORY_INFERENCE_ENABLED 缺省开启
        // 注入依赖：humanLikeMemory（读节点 + 回写）+ associativeGraph（扩散）+ schemaFormation（图式匹配）
        // 关闭时不实例化，MemoryCortex.inferFromClues 始终返回空结果（优雅降级）
        let inferenceEngine: MemoryInferenceEngine | null = null;
        const inferenceEnabled = !["0", "false", "off"].includes(
          (process.env.BRAIN_MEMORY_INFERENCE_ENABLED ?? "").trim().toLowerCase(),
        );
        // 4 项仿人推理能力的环境开关（各自独立，缺省开启）
        const ruleLearningEnabled = !["0", "false", "off"].includes(
          (process.env.BRAIN_MEMORY_RULE_LEARNING_ENABLED ?? "").trim().toLowerCase(),
        );
        const analogyMigrationEnabled = !["0", "false", "off"].includes(
          (process.env.BRAIN_MEMORY_ANALOGY_MIGRATION_ENABLED ?? "").trim().toLowerCase(),
        );
        const emotionModulationEnabled = !["0", "false", "off"].includes(
          (process.env.BRAIN_MEMORY_EMOTION_MODULATION_ENABLED ?? "").trim().toLowerCase(),
        );
        const autoInferenceEnabled = !["0", "false", "off"].includes(
          (process.env.BRAIN_MEMORY_AUTO_INFERENCE_ENABLED ?? "").trim().toLowerCase(),
        );

        if (inferenceEnabled) {
          // 4 项仿人推理能力扩展（各自独立开关，未启用时不实例化）
          const inferenceHumanLike = humanLikeMemory as unknown as import("../brain/memory-cognitive/memory-inference-engine.js").HumanLikeMemoryInferenceLike;
          // LLM 规则归纳器：BRAIN_MEMORY_LLM_INDUCER_ENABLED 缺省开启
          // 仅当 externalChat 可用且 ruleLearning 开启时才实例化（否则降级到纯算法）
          const llmInducerEnabled = !["0", "false", "off"].includes(
            (process.env.BRAIN_MEMORY_LLM_INDUCER_ENABLED ?? "").trim().toLowerCase(),
          );
          const llmInducer =
            llmInducerEnabled && externalChat?.isEnabled()
              ? new LLMRuleInducer({ chatProvider: externalChat })
              : null;
          if (llmInducer) {
            console.log("[BrainCenter] LLM 规则归纳器已启用（学规则用 LLM，推理仍走算法）");
          } else if (llmInducerEnabled) {
            console.log("[BrainCenter] LLM 规则归纳器未启用（chatProvider 不可用，降级到纯算法）");
          }
          const ruleLearner = ruleLearningEnabled
            ? new RuleLearner({ humanLike: inferenceHumanLike, llmInducer })
            : null;
          const analogyMigrator = analogyMigrationEnabled
            ? new AnalogyMigrator()
            : null;
          const emotionModulator = emotionModulationEnabled
            ? new InferenceEmotionModulator()
            : null;

          inferenceEngine = new MemoryInferenceEngine({
            humanLike: inferenceHumanLike,
            associativeGraph,
            schemaFormation: schemaFormation as unknown as import("../brain/memory-cognitive/memory-inference-engine.js").MemorySchemaFormationLike,
            emotionModulator,
            ruleLearner,
            analogyMigrator,
            // 注入 llmInducer：若 ruleLearner 未注入但 llmInducer 已注入，自动创建
            llmInducer,
          });

          // 无意识触发（BrainStemAutoInferer）：注册到 BrainStem 心跳
          // 每 N 次心跳自动跑推理，结果存入缓存（不主动通知用户）
          if (autoInferenceEnabled && brainStemRef) {
            const autoInferer = new BrainStemAutoInferer({
              inferenceEngine,
              humanLike: inferenceHumanLike,
            });
            brainStemRef.onHeartbeat(() => {
              const actors = brainStemRef.getKnownActors();
              for (const actorId of actors) {
                void autoInferer.onHeartbeat(actorId);
              }
            });
            console.log("[BrainStem] 已桥接 BrainStemAutoInferer 到 45s 心跳（无意识推理）");
          }

          // LLM 规则归纳器：启动时自动触发一次 autoLearn（避免冷启动）
          // 仅在 llmInducer 已注入且 chatProvider 可用时触发
          // 失败静默降级（不阻塞服务启动）
          if (llmInducer) {
            const bootstrapActorIds = process.env.BRAIN_MEMORY_LLM_INDUCER_BOOTSTRAP_ACTORS;
            const actorIdsToLearn = bootstrapActorIds
              ? bootstrapActorIds.split(",").map((s) => s.trim()).filter(Boolean)
              : ["default"];
            void (async () => {
              try {
                for (const aid of actorIdsToLearn) {
                  const learned = await inferenceEngine!.autoLearn(aid);
                  if (learned.length > 0) {
                    console.log(
                      `[BrainCenter] 启动时 LLM 规则归纳完成 actor=${aid} 学到 ${learned.length} 条规则`,
                    );
                  }
                }
              } catch (err) {
                console.log(`[BrainCenter] 启动时 LLM 规则归纳失败（忽略，不影响启动）: ${err}`);
              }
            })();
          }
        }

        // 通过 BrainCenter.registerMemoryCognitiveSubmodules 统一注入到 MemoryCortex
        brainCenter.registerMemoryCognitiveSubmodules({
          associativeGraph,
          metacognitionBridge,
          forgettingController,
          salienceFilter,
          experienceLearningLoop,
          inferenceEngine,
        });

        // 记忆联想性增强：LLM 跨记忆关联合成器（无 API key 时返回 null，静默降级）。
        // 不传显式 key，由工厂内部 resolvePrimaryLlmClientConfig 解析当前主 provider
        // （auto 模式 Moonshot 优先），避免 OPENAI key 与 Moonshot baseURL 错配。
        // recall 命中 ≥2 条时异步合成新关联，高置信结论回灌 humanLike 记忆图；
        // remember 写入后（节流 45s）也做"新记忆 × 旧记忆"在线关联分析（P0-2）。
        memoryCortex.registerAssociationSynthesizer(
          createMemoryAssociationSynthesizer(),
        );

        // ─── 记忆模块整体优化装配（P0/P1/P2）──────────────────────────
        // P0-1 用户画像聚合器：USER_PROFILE.md 动态更新（对话内 LLM 结构化抽取
        //   ADD/UPDATE/DELETE → 确定性落位；无轮次队列、无后台整文合成）。
        const userProfileAggregator = createUserProfileAggregator();
        brainCenter.registerUserProfileAggregator(userProfileAggregator);
        // 2026-10-21 抽取链路合并：画像增量与记忆/承诺/事实走同一次统一抽取调用。
        // ingest 侧读取当前画像快照并入 prompt，产物 profileOps 经写入钩子回到这里
        // 确定性落位——不再单独为画像跑一次 LLM。
        agenticMemoryRuntime?.ingest.setProfileSnapshotProvider((actorId) =>
          userProfileAggregator.readProfile(actorId),
        );
        // 对话主链路走统一写入者（memory-consolidation-service）时，抽取发生在那条链路，
        // 这里必须同样注入画像快照口，否则 profileOps 永远不被请求、画像断流。
        memoryConsolidation?.setProfileSnapshotProvider((actorId) =>
          userProfileAggregator.readProfile(actorId),
        );
        agenticMemoryRuntime?.ingest.addWriteHook((event) => {
          if (!event.profileOps || event.profileOps.length === 0) return;
          void userProfileAggregator
            .applyProfileOpsFromUnified(event.actorId, event.profileOps)
            .catch(() => {
              /* 画像落位失败静默：不影响记忆主链路，深度合成兜底 */
            });
        });
        // 存量画像净噪（2026-10-20）：启动时一次性扫 data/user_profiles/*/USER_PROFILE.md，
        // 用确定性规则清掉历史坏行（疑问句/对助手的 meta 观察/临时行程/行为频率/
        // 无权威字段如「常用语言」/残留占位行）。零 LLM、幂等、不阻塞启动。
        void userProfileAggregator.sanitizeStoredProfiles().catch(() => {
          /* 净噪失败不阻断启动 */
        });
        // 画像事实写入单一所有权：聚合器 LLM 抽取可用时，UserPersonalizationService
        // 不再走正则 patches（曾把「我叫什么？」的疑问词写成称呼）与周期性 LLM 整文件重写，
        // 避免两条写路径互相覆盖。
        userPersonalizationService.setProfileWritesDelegatedToAggregator(
          userProfileAggregator.canExtract,
        );
        // 画像写入只在对话内发生（统一抽取一次调用捎带 profileOps → 确定性落位）。
        // 不再从记忆整理（夜间 dreaming / idle）反触发整文画像 LLM 重写。

        // P1-1 召回查询扩展器：recall 前指代消解 + 话题扩展 + 多意图拆分
        //（单窗口长会话优化核心，纯规则零延迟）。
        brainCenter.registerRecallQueryExpander(new RecallQueryExpander());

        // P1-3 隐式反馈检测器：纠正/认同/重复提问/换话题 → 记忆相关性反馈回灌。
        brainCenter.registerImplicitFeedbackDetector(new MemoryImplicitFeedbackDetector());

        // P2-1 记忆目录（元认知）：统计记忆规模/时间分布/主题，供 prompt 注入
        //   "我知道你什么"摘要（brainCenter.getInventorySummary 消费）。
        //   全局单例：prompt-context-builder assembleMemory 同步读缓存注入【记忆目录】。
        const memoryInventory = new MemoryInventory(agentMemorySyncService);
        memoryCortex.registerMemoryInventory(memoryInventory);
        setGlobalMemoryInventory(memoryInventory);
        // 对话时间线：记录首次对话时间/累计轮次/最近对话，首次事实落长期记忆图。
        // 全局单例：turn-lifecycle 每轮 recordTurn，prompt-context-builder 注入摘要。
        setConversationTimelineService(new ConversationTimelineService());
        // ────────────────────────────────────────────────────────────

        // 心跳桥接：BrainStem 45s 心跳 → ForgettingController.continuousScore
        // 让遗忘曲线打分跟随脑干节律，无需额外定时器。
        // 回调内遍历 brainStemRef.getKnownActors()，对每个 actor 执行连续打分。
        if (brainStemRef) {
          brainStemRef.onHeartbeat(() => {
            const actors = brainStemRef.getKnownActors();
            for (const actorId of actors) {
              void forgettingController.continuousScore(actorId);
            }
          });
          console.log("[BrainStem] 已桥接 ForgettingController.continuousScore 到 45s 心跳");
        }

        console.log("[BrainCenter] 记忆认知架构升级（Phase 4）：7 个子模块装配完成");
      } catch (err) {
        console.log("[BrainCenter] 记忆认知架构升级装配失败（降级到原行为）:", err);
      }
    }

    // 深度优化：注入 TopicExtractor（LLM 驱动）—— 替代 working-memory-cortex.ts 硬编码主题词列表
    // 让 BrainCenter.cognize 每轮异步调一次轻量 LLM 提取 1-3 个业务领域关键词，
    // 写入工作记忆槽位，使 toSummary 真正反映"在聊什么"。
    // 决策器实现已抽到 brain/decision-maker-factory.ts，支持未来"换大脑"时同步替换。
    // 每轮 LLM 调用削减：情绪推断（阶段 1）的同一次调用顺带产出 topics，
    // cognize 阶段 3.4.1 优先读 mood 缓存，仅未命中时才回退独立 TopicExtractor 调用。
    if (externalChat?.isEnabled()) {
      const topicExtractor = createDefaultTopicExtractor(externalChat);
      brainCenter.setTopicExtractor(topicExtractor.extract.bind(topicExtractor));
      brainCenter.setMoodTopicProvider((sessionId, text) =>
        moodInferenceService.getTopicsFromCache(sessionId, text) ?? [],
      );
    }

    // 注入到 DecisionHub（让 decidePassive 调用新模块）
    decisionHub.registerWorkingMemory(workingMemoryCortex);
    decisionHub.registerTaskSwitching(taskSwitchingCortex);
    decisionHub.registerContextCortex(contextCortexLocal);
    decisionHub.registerToolPlanning(toolPlanningCortex);
    decisionHub.registerOnlineLearning(onlineLearningCortex);

    console.log("[BrainCenter] Step 7 扩展装配完成（7 个新皮层模块全部接入 BrainCenter + DecisionHub）");
  }

  // ─── Brain Center 启动 + 工具注册（移至此处确保 9 分区均注册后再启动）───
  if (brainEnabled && brainCenter) {
    await brainCenter.start();
    // 预热：启动后立即触发一次 BrainStem 扫描（加速首次记忆整理触发）
    void brainCenter.sweepBrainStem().catch(() => {});
    console.log("[BrainCenter] 预热完成（BrainStem 首次扫描已触发）");

    // 注册 brain.* 工具到 ToolRegistry，并把 schema 暴露给 LLM。
    // brainCenter 为 null 时（brain 未启用），registerBrainTools 不会注册任何 handler，
    // setBrainChatTools 也不会被调用，BRAIN_TOOLS schema 不进入 LLM 可见列表。
    registerBrainTools(toolRegistry, brainCenter, (name) => {
      // 先从 builtin chat tools 找 schema
      const builtin = getBuiltinAgentChatTools().find(
        (t) => t.type === "function" && t.function?.name === name,
      );
      if (builtin) return builtin;
      // 找不到再从 SkillManager 找（self-programming / 社区 skill）
      const sm = toolRegistry.getSkillManager?.();
      if (sm) {
        const manifest = sm.list(true).find((m) => m.name === name);
        if (manifest) {
          const properties: Record<string, unknown> = {};
          const required: string[] = [];
          for (const p of manifest.parameters) {
            properties[p.name] = {
              type: p.type,
              description: p.description ?? "",
              ...(p.enum ? { enum: p.enum } : {}),
              ...(p.default !== undefined ? { default: p.default } : {}),
            };
            if (p.required) required.push(p.name);
          }
          return {
            type: "function" as const,
            function: {
              name: manifest.name,
              description: manifest.description,
              parameters: { type: "object", properties, required },
            },
          };
        }
      }
      return null;
    });
    setBrainChatTools(BRAIN_TOOLS);

    // ─── 把 ToolRegistry 已注册工具名注入 CapabilityCortex ───
    // 让 brain.list_capabilities / introspect 返回的 descriptor.tools 是真实工具名，
    // 而非 loadSeed 时的空数组。必须在所有 registerXxxTools 完成后调用。
    if (capabilityCortex) {
      // 先从 capability-modules 自动派生 domain → toolNames 映射，
      // 新增 capability-module 时不需要改 DOMAIN_TOOL_PATTERNS
      const modules = buildCapabilityModules(capabilityModuleDeps);
      for (const mod of modules) {
        const toolNames = mod.chatTools
          .map((t) => (t.type === "function" && t.function?.name ? t.function.name : ""))
          .filter(Boolean);
        if (toolNames.length > 0) {
          capabilityCortex.registerDomainToolNames(mod.domain, toolNames);
        }
      }
      capabilityCortex.attachToolNames(toolRegistry.list());
    }

    // ─── SubTask 14.2: BodyCenter 注入 BrainCenter（下行通路）───
    // brainCenter.registerBodyGateway 内部会检查 BODY_CENTER_ENABLED，
    // 关闭时（isBodyCenterEnabled=false）会忽略注入，回退纯脑模式。
    if (bodyCenter) {
      brainCenter.registerBodyGateway(bodyCenter.getGateway());
      // DecisionHub 内部 ActionExecutor 也注入 bodyGateway（让 decidePassive 走 BodyGateway）
      // ActionExecutor 在 brainNeuroEnabled 块内创建，此处通过 BrainCenter 间接拿不到，
      // 已通过 brainCenter.registerBodyGateway 在 cognize 阶段 1 调 bodyGateway.sense 覆盖；
      // decidePassive 路径走 BrainCenter.cognize → CognitiveEngine → 主 Agent toolLoop，
      // 主 Agent 的 toolLoop 经 ChatToolExecutionContext.executeTool 直接调 toolRegistry.execute，
      // 而下沉到 BodyModule 的工具已被 registerTools 注册到 toolRegistry，故能间接命中 BodyModule.act。
      // 这里只注入 brainCenter.bodyGateway，让 cognize 能感知 where_am_i + bodyState。
    }
  }

  // ─── Body Center 启动（在 BrainCenter 启动之前或之后均可，无强依赖）───
  if (bodyCenterEnabled && bodyCenter) {
    await bodyCenter.start();
    app.log.info("[BodyCenter] 已启动");
    const snap = bodyCenter.snapshot();
    app.log.info(
      `[BodyCenter] 模块清单: ${snap.modules
        .map((m) => `${m.name}(${m.tools.length}个工具,${m.online ? "在线" : "离线"})`)
        .join(", ")}`,
    );
  }

  // 把 brainCenter 注入 agentCore：可用时 handleUserMessage 走 cognize() 端到端认知入口，
  // BRAIN_CENTER_ENABLED=0 时 brainCenter 为 null，agentCore 降级到原切片路径。
  agentCore.setBrainCenter(brainCenter);

  // 注入人格内核拉取器：PromptContextBuilder.assembleMemory 每轮拉取 PersonalityCore
  // （BrainCenter.getPersonalityCore → MemoryCortex.getPersonalityCore，KV 持久化 + 默认人格兜底），
  // 格式化后填入 memory.personalityCore，由 buildLayeredSystemPrompt 注入 system prompt 稳定前缀
  // 的【人格内核】块，防止单次对话导致人格漂移。brainCenter 为 null（brain 未启用）时返回 null，
  // personalityCore 字段不注入，降级到无人格内核模式。
  promptContextBuilder.setPersonalityProvider((actorId) => brainCenter?.getPersonalityCore(actorId) ?? null);

  const wechatClawBindingService = new WechatClawBindingService();
  void wechatClawBindingService.load();
  // 微信接入聊天工具族：login_qr 经通用推卡通道把登录二维码实时推到聊天流
  registerWechatClawTools(toolRegistry, wechatClawBindingService, new QrAssistService({ imageStore: imageGenerationService }));
  const wechatClawBridgeService = new WechatClawBridgeService(runtime, {
    weatherPrefsService,
    ttsService,
    messageHubService,
  });
  messageBridgeService = new MessageBridgeService(runtime, messageHubService);

  registerMessageHubTools(toolRegistry, { hub: messageHubService, gateway: messagePlatformGateway, runtime, friendMessages: friendMessageService, phoneBridgeCoordinator });

  registerEmbodimentTools(toolRegistry, {
    wsRegistry: wsConnectionRegistry,
    localVisual: desktopVisual,
    bridge: desktopBridgeCoordinator,
  });

  // ========== 注册自我编程和智能生成工具 ==========
  registerSelfProgrammingTools(toolRegistry, skillManager);
  registerAISkillGenerationTools(toolRegistry, externalChat, skillManager, skillGenerator);
  registerSelfLearningTools(toolRegistry, externalChat, skillManager, agentSelfLearningService);
  registerNotesTools(
    toolRegistry,
    notesService,
    scheduleTaskService,
    externalChat,
    narrativeMemory,
  );

  // ─── ProactivityHub 主动性多元化模块装配 ───
  // 多元触发（对话关怀/任务恭喜/待办闭环/过劳干预/问候）+ 全局频控
  // （FrequencyGovernor：每日预算 + 分 kind 冷却 + 静默时段）+ 两种行为模式：
  //   speak → LifeSignalHub 发布 → BrainCenter.decide → ProactionCortex 既有闭环
  //   act   → 白名单工具静默后台执行（media/calendar/smart_home，无删除类）
  // （advise 模式已随 AdviceStore 死代码一并移除：advise 请求统一改道 speak）
  //
  // 负反馈抑制表（Task 20 统一频控框架）：用户「别再提醒我这个」类负反馈的
  // 持久化抑制（data/proactivity-suppression/{actorId}.json，kind + 关键词），
  // hub 每次主动发送前检查；对话工具 proactivity.feedback + HTTP 路由负责写入。
  const proactivitySuppressionStore = new ProactivitySuppressionStore({
    dirPath:
      process.env.PROACTIVITY_SUPPRESSION_DIR ??
      join(process.cwd(), "data", "proactivity-suppression"),
  });
  await proactivitySuppressionStore.load();
  // 共享频控器：hub 快路径与统一管道同一预算口径（单一预算才是真预算），
  // 状态由 ProactivePipeline 落盘 data/proactivity/frequency.json，重启恢复
  const proactivityGovernor = new FrequencyGovernor();
  // 每用户自主性等级 + 勿扰（客户端设置页可调；等级经 hub 执行端生效，勿扰经 governor 全局生效）
  const autonomySettings = new AutonomySettingsStore(
    join(process.cwd(), "data", "autonomy-settings.json"),
  );
  proactivityGovernor.setDndCheck((actorId) => autonomySettings.isDnd(actorId));
  // 在场感知（active/idle/offline）：WS 连接事件 + 对话活跃喂入，供仲裁择时与投递选通道
  const proactivityPresence = new PresenceService();
  proactivityPresenceRef = proactivityPresence;
  // 沉默日志（方案 B）：hub act 沉默与管道 silenced 共用同一实例，落盘 data/proactivity/silence-log.json
  const proactivitySilenceLog = new SilenceLog(
    join(process.cwd(), "data", "proactivity", "silence-log.json"),
  );
  // 挂起确认存储（ask_first）：hub 行动级与管道提案级共用，落盘 data/proactivity/confirmations.json
  const proactivityConfirmations = new PendingConfirmationStore(
    join(process.cwd(), "data", "proactivity", "confirmations.json"),
  );
  // ─── 分级触达（ReachRouter）：「多急 × 要不要拍板」决定通道，ack 归一 ───
  // 通道阶梯 chat→popup→voice→phone（phone 仅 interrupt 白名单），
  // 静默事件只进台账。通道适配在此装配；push/台账在下方创建后补齐（闭包晚绑定）。
  const attentionStore = new AttentionStore(
    join(process.cwd(), "data", "proactivity", "attention.json"),
  );
  const reachChannels: ReachChannelDeps = {
    // L2 对话气泡：synapseBus（WS + MessageHub 离线降级）→ wsRegistry 直推兜底
    sendChat: async (actorId, payload) => {
      if (synapseBus) {
        await synapseBus.sendToUser(actorId, payload);
        return true;
      }
      return wsConnectionRegistry.trySend(actorId, JSON.stringify(payload));
    },
    // L3 弹窗卡（reminder_popup：客户端弹需点掉的对话框）
    sendPopup: (actorId, payload) =>
      Promise.resolve(wsConnectionRegistry.trySend(actorId, JSON.stringify(payload))),
    // L4 虚拟来电（reminder 风格振铃；仅 interrupt 事件会到达此级）
    placeCall: (actorId, text) =>
      virtualPhoneService
        .callUserWithRinging({
          fromActorId: actorId,
          toUserId: actorId,
          transcript: text,
          ringStyle: "reminder",
        })
        .then((r) => r.ok === true)
        .catch(() => false),
  };
  const reachRouter = new ReachRouter(attentionStore, reachChannels);
  reachRouter.start();

  // 世界状态板前向引用：hub 的对话轮回调入板（板在传感装配段构造）
  const worldBoardRef: { current: WorldBoard | null } = { current: null };
  const proactivityHub = new ProactivityHub({
    frequencyGovernor: proactivityGovernor,
    silenceLog: proactivitySilenceLog,
    pendingConfirmations: proactivityConfirmations,
    // 顺嘴搭车队列：low 级 speak 挂起等下一轮对话；agent-core 经
    // takeTurnAsideForTurn 取走织入（与主动外发执行器共享同一实例）。
    // medium 过期升级（2026-10-01 扩面）：6h 没搭上车就重投正常通道——
    // source=turn_aside_expiry 让 hub 跳过再次搭车（防回环），走直达车道
    // 的 ArbiterV2 正常择时
    turnAsideQueue,
    // 死信闸：全设备离线的 speak 信号直接放弃（省话术 LLM + 不产生假台账）
    presence: proactivityPresence,
    // 每用户自主性等级：0=只建议 1=标准 2=高效（客户端设置页可调）
    autonomyLevel: (actorId) => autonomySettings.getLevel(actorId),
    // 对话轮整理进状态板会话层（决策层只看板，不翻聊天原文）
    onConversationTurn: (actorId, text) =>
      worldBoardRef.current?.append(actorId, "session", "recentTurns", { at: Date.now(), text }, 20),
    // 防重记忆持久化：跨栈去重重启不失效
    dataPath: join(process.cwd(), "data", "proactivity"),
    // 分级触达：ask_first 挂起确认 → Router 投递+升级（hub 的 speak 信号已投
    // chat，这里 assumeDelivered 避免双发；未响应时步进升 popup/voice）
    onPendingConfirmation: (entry) => {
      const spend = isSpendConfirmation(entry, featureCatalog);
      void reachRouter
        .route({
          actorId: entry.actorId,
          kind: entry.kind,
          title: `${spend ? "需要确认" : "主动行动"}：${entry.rationale.slice(0, 60)}`,
          summary: entry.rationale,
          urgency: "alert",
          decision: "confirm",
          spend,
          deadlineAt: entry.expiresAt,
          confirmId: entry.confirmId,
          assumeDelivered: "chat",
        })
        .catch(() => {});
    },
    onConfirmationResolved: (entry, approved, executed) => {
      reachRouter.resolveByConfirmId(
        entry.confirmId,
        approved ? (executed ? "已确认执行" : "已确认未执行") : "已拒绝",
      );
    },
    publishSignal: (signal) => {
      lifeSignalHubService.publish({
        id: `proactivity:${signal.kind}:${signal.actorId}:${Date.now()}`,
        actorId: signal.actorId,
        source: "agent_inference",
        kind: signal.kind,
        title: signal.title,
        summary: signal.summary,
        tags: signal.tags,
        importance: signal.importance,
        evidence: signal.evidence,
        occurredAt: new Date().toISOString(),
        metadata: signal.metadata,
      });
    },
    executeTool: (tool, args, actorId) =>
      toolRegistry.execute(tool, args, {
        sessionId: actorId,
        userId: actorId,
        agentAccessMode: "full",
      }),
    // 对话活跃事件 → 节律感知 + 在场感知（连续工作/深夜检测 + active/idle 判定的数据源）
    onUserActivity: (actorId, source) => {
      rhythmCore?.noteActivity(actorId, source);
      proactivityPresence.noteActivity(actorId);
    },
    // （LLM 通用路径已随 2026-09-24 架构定稿拆除：决策=状态板映射规则，零 LLM）




    // 负反馈抑制表：用户「别再提醒」意愿优先于时间冷却，发送前检查
    suppressionStore: proactivitySuppressionStore,
  });
  // 顺嘴 medium 过期升级接线：6h 没搭上车的中优消息重投正常通道（hub 内
  // source=turn_aside_expiry 防再次搭车回环；走 ArbiterV2 正常择时投递）
  turnAsideQueue.setOnExpire((item) => {
    proactivityHub.submitIntent({
      actorId: item.actorId,
      kind: item.kind as Parameters<typeof proactivityHub.submitIntent>[0]["kind"],
      importance: item.importance,
      title: item.title,
      summary: item.hint || item.title,
      mode: "speak",
      source: "turn_aside_expiry",
      // 时效准入闸：带上事件真实发生时刻（挂起时刻）——过期升级属"延迟投递"，
      // 相关闸豁免，但超保质期（followup 24h）仍会被拦，防"隔夜补刀"翻旧账
      originAt: item.createdAt,
    });
  });
  // 接线 1：agent-core（对话内触发 + advise 注入 + 编排器任务完成恭喜随内部传递）
  agentCore.setProactivityHub(proactivityHub);
  // ── 位置方案 D：到达常去地点 → 主动问候（走 hub 统一频控/话术闭环）──
  const locationTrigger = new LocationTrigger({
    history: locationHistoryService,
    submitIntent: (intent) => proactivityHub.submitIntent(intent),
  });
  // 用户清除位置历史时同步失效到达触发器的缓存：已删数据不再驱动主动行为
  locationHistoryService?.setOnCleared((actorId) => locationTrigger.invalidate(actorId));
  // ── 位置方案 C 出口：围栏事件 → 全量审计 + 按 actionType 分发动作 ──
  locationGeofenceService.setNotifier((event) => {
    void auditService
      .record({
        type: "geofence.triggered",
        actorId: event.fence.actorId,
        fenceId: event.fence.id,
        fenceName: event.fence.name,
        kind: event.kind,
        actionType: event.fence.actionType,
        distanceMeters: event.distanceMeters,
        latitude: event.location.latitude,
        longitude: event.location.longitude,
        at: event.at,
      })
      .catch(() => {});
    const { fence } = event;
    const where = `${fence.latitude.toFixed(4)}, ${fence.longitude.toFixed(4)}`;
    if (fence.actionType === "reminder") {
      const title = String(fence.actionConfig.title ?? fence.name);
      const note = String(fence.actionConfig.note ?? "").trim();
      void toolRegistry
        .execute(
          "calendar.create_task",
          {
            kind: "reminder",
            title,
            shortTitle: title.slice(0, 12),
            description:
              note ||
              `地理围栏「${fence.name}」${event.kind === "enter" ? "到达" : "离开"}时自动创建的提醒`,
            runAt: new Date(Date.now() + 5000).toISOString(),
          },
          { sessionId: fence.actorId, userId: fence.actorId, agentAccessMode: "full" },
        )
        .catch((err) => {
          app.log.warn(`[Location] 围栏提醒创建失败（${fence.name}）: ${err}`);
        });
      return;
    }
    if (fence.actionType === "agent_task") {
      const goal = String(fence.actionConfig.goal ?? "").trim();
      if (!goal) return;
      const taskId = agentCore.submitAutonomousTask(
        fence.actorId,
        `${goal}（地理围栏「${fence.name}」${event.kind === "enter" ? "到达" : "离开"}触发，位置 ${where}）`,
      );
      if (taskId) {
        proactivityHub.submitIntent({
          actorId: fence.actorId,
          kind: "geofence_event",
          importance: "low",
          title: `围栏任务已启动：${fence.name}`,
          summary:
            `你到${event.kind === "enter" ? "达" : "离开"}了「${fence.name}」，已按约定启动任务「${goal}」。` +
            `用一句话轻声告知用户任务已经开始即可，不要展开细节。`,
          mode: "speak",
          source: "location",
        });
      }
      return;
    }
    if (fence.actionType === "webhook") {
      const url = String(fence.actionConfig.url ?? "");
      // 创建时已校验；分发前复检（防旧数据绕过 SSRF 门槛）
      if (!isPublicHttpUrl(url)) return;
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      const extra = fence.actionConfig.headers;
      if (extra && typeof extra === "object") {
        for (const [k, v] of Object.entries(extra as Record<string, unknown>)) {
          if (typeof v === "string" && k.trim()) headers[k.trim()] = v;
        }
      }
      const secret = String(fence.actionConfig.secret ?? "");
      if (secret) headers["X-Geofence-Secret"] = secret;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      void fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          event: "geofence." + event.kind,
          fence: { id: fence.id, name: fence.name, radiusMeters: fence.radiusMeters },
          at: event.at,
          location: event.location,
          distanceMeters: event.distanceMeters,
        }),
        signal: controller.signal,
      })
        .then((res) => {
          app.log.info(`[Location] 围栏 webhook 已回调（${fence.name}，status=${res.status}）`);
        })
        .catch((err) => {
          app.log.warn(`[Location] 围栏 webhook 回调失败（${fence.name}）: ${err}`);
        })
        .finally(() => clearTimeout(timer));
      return;
    }
  });
  // 位置上报管线（WS 层消费）：历史落库 → 围栏判定 → 到达触发
  const locationIngest = new LocationIngestPipeline({
    history: locationHistoryService,
    geofence: locationGeofenceService,
    onLocationReported: (actorId, loc) => locationTrigger.handleLocationReport(actorId, loc),
  });
  // 接线 2：session-epitome 待办闭环（完成检测 → hub.onUserLoopCompleted 恭喜）
  memoryCortex?.setEpitomeLoopClosedListener((actorId, loopText) => {
    proactivityHub.onUserLoopCompleted(actorId, loopText);
  });
  // ─── InterestWatcher 兴趣话题追踪装配（对标扣子主动推送体验）───
  // 用户长期关注的话题从对话中被 LLM 挖出（interest.manage 工具入库），
  // 后台每 tick 拉一次实时热搜（微博/百度/知乎/B站聚合），命中用户兴趣 →
  // 指纹去重 + 2h 间隔 → onInterestAlert → hub 直达车道模板直投（零 LLM）。
  // 频控双层：本模块同兴趣去重 + FrequencyGovernor（interest_alert 4h 冷却/每日预算）。
  // 语义兜底（2026-10-01）：字面包含未命中时复用本地 bge-small-zh ONNX 引擎
  // 做余弦匹配（「苹果手机」对「iPhone 17」类换说法），本地推理零边际成本；
  // 引擎不可用/INTEREST_SEMANTIC_MATCH=0 时自动退回纯字面。
  const interestWatcher = new InterestWatcher({
    persistPath:
      process.env.INTEREST_WATCH_FILE ??
      join(process.cwd(), "data", "interest-watch.json"),
    fetchHot: async (limit) => {
      const res = await fetchHotRankings(limit);
      return res.items.map((item) => ({
        title: item.title,
        platform: item.platform,
        url: item.url,
        hot: item.hot,
      }));
    },
    embed: async (texts) => {
      try {
        const { initLocalEmbeddingEngine } = await import(
          "../agentic-memory/local-embedding/local-embedding-engine.js"
        );
        const engine = await initLocalEmbeddingEngine();
        if (!engine) return null;
        return await engine.embed(texts);
      } catch (err) {
        console.log(`[InterestWatcher] 本地嵌入引擎不可用（退回字面匹配）: ${err}`);
        return null;
      }
    },
    onHit: (actorId, interest, hit) => {
      proactivityHub.onInterestAlert(actorId, interest.name, hit);
    },
  });
  await interestWatcher.load();
  // 工具：让 LLM 在对话中自主维护关注列表（add/touch/remove/list）
  registerInterestWatchTools(toolRegistry, interestWatcher);
  // 工具：生活模型管理（add/query/list/forget）——LLM 在对话中查询/维护
  // 「实体-关系」模型（如「我妹妹叫什么」→ query）。未初始化时跳过。
  if (lifeModelStore) registerLifeManageTools(toolRegistry, lifeModelStore);
  // 工具：主对话识别负反馈（别再提醒/别推了）后写入抑制表（suppress/remove/list）
  registerProactivityFeedbackTools(toolRegistry, proactivitySuppressionStore);
  // 工具：act 三分支 ask_first 确认闭环（用户回复"可以/不行"→ 推进挂起行动计划）
  // + 沉默反问（"你上周为什么没提醒我 XX"→ 检索沉默日志的效用评估依据）
  registerProactivityConfirmTools(toolRegistry, proactivityHub);
  // prompt 注入：每轮告知 agent 用户关注什么（【用户兴趣关注列表】块）
  agentCore.setInterestListProvider((actorId) => interestWatcher.listForPrompt(actorId));
  interestWatcher.start();
  proactivityHub.start();
  console.log("[Bootstrap] ProactivityHub 已装配（多元触发 + 频控 + speak/act/advise）");
  // 定时任务死信通知：连续失败进入死信（停止重试）时主动告知一次，不再无人知晓地空烧
  scheduleTaskService.setTaskDeadLetterHandler((task) => {
    proactivityHub.submitIntent({
      actorId: task.sessionId,
      kind: "life_reminder",
      importance: "medium",
      title: `定时任务「${task.title ?? task.description.slice(0, 30)}」已暂停`,
      summary:
        `这个任务连续 ${task.consecutiveFailures ?? 0} 次执行失败（${task.lastError ?? "原因未知"}），` +
        `我先停止自动重试，避免继续空跑。想让我修好后恢复，随时说一声。`,
      mode: "speak",
      source: "time",
    });
  });
  // 定时任务超窗未补发通知：runtime 离线跨过触发点且超过补发窗口（默认 24h）时，
  // 不再静默执行也不再静默丢弃——告知一次"这个任务错过了，没补"，要补由用户决定。
  scheduleTaskService.setTaskMissedHandler((task, plannedAt) => {
    proactivityHub.submitIntent({
      actorId: task.sessionId,
      kind: "life_reminder",
      importance: "low",
      title: `定时任务「${task.title ?? task.description.slice(0, 30)}」错过太久，已跳过`,
      summary:
        `原定 ${plannedAt} 的这个任务在 runtime 未运行期间错过，已超过补发窗口，我没有再自动执行。` +
        `还需要的话说一声，我重新安排一次。`,
      mode: "speak",
      source: "time",
    });
  });
  // 确认超时不再静默：过期未回复的确认逐条告知用户（"没等到回复，先不做了"）。
  // 防重入：通知路径若再触发 prune（理论上不会）不递归。
  let notifyingExpiredConfirmations = false;
  proactivityConfirmations.setExpiredHandler((entries) => {
    if (notifyingExpiredConfirmations || entries.length === 0) return;
    notifyingExpiredConfirmations = true;
    try {
      for (const e of entries) {
        proactivityHub.submitIntent({
          actorId: e.actorId,
          kind: "life_reminder",
          importance: "low",
          title: "确认超时已取消",
          summary: `刚才想请你确认的「${e.rationale.slice(0, 60)}」一直没等到回复，我先不做了。需要的话随时说一声。`,
          mode: "speak",
          source: "confirmation_expiry",
        });
      }
    } finally {
      notifyingExpiredConfirmations = false;
    }
  });

  // ─── 五层主动性架构装配（L1 传感 → L2 评估 → L3 仲裁 → L4 目标）───
  // 全部零 LLM：传感层持续追踪状态 delta，评估器把 delta 变成事件，
  // 仲裁层按"打断成本 × 紧迫度"裁决何时说，目标板后台预执行备结果。
  // LLM 只在两个点出现：InitiativeEngine 开放评估（有熔断上限）+ 可选话术。
  const proactivityFabricPath = join(process.cwd(), "data", "proactivity");
  /** 管道 outcome 存储（提升为命名引用：CostCalibrator 定时读取） */
  let outcomesStoreForCalibrator: InstanceType<typeof OutcomeStore> | null = null;
  const sensorKernel = new SensorKernel({ dataPath: proactivityFabricPath });
  // 屏幕状态条件化信号源：内核 signals 日志（落盘持久，重启不丢；最近 600 条覆盖数日窗口）
  screenSignalSourceRef = () => sensorKernel.recentLog(600);
  const screenSensor = new ScreenSensor({ visualPort: desktopVisual });
  const scheduleSensor = new ScheduleSensor({ listTasks: () => scheduleTaskService.listAllTasks() });
  sensorKernel.register(screenSensor);
  sensorKernel.register(scheduleSensor);
  // ─── 持续感知补全（2026-09-19 P0-1）：文件系统 + 剪贴板传感器 ───
  // file_watcher：fs.watch 递归监听（env AGENT_FILE_WATCH_DIRS，缺省下载目录），
  //   只报文件名/动作不读内容；clipboard_watch：30s 哈希比对，只落预览+长度。
  //   感知回溯查询经 perception.overview 工具暴露给对话面。
  const fileWatcherSensor = new FileWatcherSensor();
  sensorKernel.register(fileWatcherSensor);
  if (isClipboardSensorEnabled()) {
    sensorKernel.register(new ClipboardSensor({ visualPort: desktopVisual }));
  }
  registerPerceptionOverviewTool(toolRegistry, {
    kernel: sensorKernel,
    screenFocus: () => screenSensor.latest(),
  });
  const goalFeeder = registerFeeder(sensorKernel, "goal_board", "goal");
  /** 入站消息 feeder（unread_burst 评估器的数据源；MessageHub onInbound 推送） */
  const messageFeeder = registerFeeder(sensorKernel, "message_hub", "message");
  /** 物理设备 feeder 缓存（sensorId → emit；device-signal 上行入口用） */
  const deviceFeeders = new Map<string, (signal: { actorId?: string; at: number; fingerprint: string; salience: "high" | "medium" | "low"; payload?: Record<string, unknown> }) => void>();
  const primaryActor = (): string | null => {
    const actors = proactivityHub.exportActors();
    return actors.sort((a, b) => b.lastInteractionAt - a.lastInteractionAt)[0]?.actorId ?? null;
  };
  // presence 追踪传感器：轮询在场状态，变化才产出信号（away_return 的数据源）
  let lastPresenceState = "";
  sensorKernel.register({
    id: "presence_tracker",
    stream: "presence",
    pollIntervalMs: 60_000,
    collect: () => {
      const actorId = primaryActor();
      if (!actorId) return [];
      const state = proactivityPresence.getPresence(actorId, Date.now());
      if (state === lastPresenceState) return [];
      lastPresenceState = state;
      return [
        {
          stream: "presence",
          at: Date.now(),
          fingerprint: `presence:${state}:${Math.floor(Date.now() / 60_000)}`,
          salience: "low",
          delta: `用户当前状态：${state}`,
          payload: { state },
        },
      ];
    },
  });
  sensorKernel.start();

  // 天气一行话缓存（30min 刷新；天气服务需要用户位置偏好，缺省跳过）
  let weatherLineCache: string | null = null;
  const refreshWeatherLine = async (): Promise<void> => {
    try {
      const actorId = primaryActor();
      const prefs = actorId ? weatherPrefsService.get(actorId) : undefined;
      if (!prefs?.latitude || !prefs?.longitude) return;
      const brief = await weatherService.getBrief(
        prefs.latitude,
        prefs.longitude,
        process.env.TZ ?? "Asia/Shanghai",
      );
      weatherLineCache =
        brief.summaryLine ||
        `${brief.weatherText}，${Math.round(brief.todayMinC)}-${Math.round(brief.todayMaxC)}°C${brief.peakRainPct >= 50 ? "，有雨记得带伞" : ""}`;
    } catch {
      weatherLineCache = null;
    }
  };
  void refreshWeatherLine();
  const weatherTimer = setInterval(() => void refreshWeatherLine(), 30 * 60_000);
  if (typeof weatherTimer.unref === "function") weatherTimer.unref();

  // 目标板（L4 预执行）：会前准备包等后台预执行，就绪结果经 goal 流进评估器
  const goalBoard = new GoalBoard({
    dataPath: proactivityFabricPath,
    emitGoal: (goal) => {
      goalFeeder({
        at: Date.now(),
        fingerprint: `goal:${goal.goalId}:${goal.status}:${goal.rev ?? 0}`,
        salience: goal.status === "ready" ? "medium" : "low",
        delta: `目标「${goal.title}」状态 → ${goal.status}`,
        payload: {
          goalId: goal.goalId,
          title: goal.title,
          status: goal.status,
          type: goal.type,
          body: String(goal.payload?.body ?? ""),
        },
      });
    },
    recallMemory: async (query, limit) => {
      const actorId = primaryActor();
      if (!brainCenter || !actorId) return [];
      const result = await brainCenter.recall(actorId, query, { domain: "episodic", limit });
      return (result?.items ?? []).map((item) => item.content);
    },
  });

  // 成本自校准器（P1）：outcome 接受率 EWMA 驱动 alert 档阈值呼吸（零 LLM）
  const costCalibrator = new CostCalibrator(proactivityFabricPath);
  // outcome 喂入走 POST /outcome 路由的 observeOutcome 实时回灌（单一来源，
  // 不做 OutcomeStore 定时轮询——否则同一条 outcome 计数两次，EWMA 失真）。

  // 主动呼叫器（L5）：遇到事情真实打电话汇报 + 通话内多轮对话。
  // 触发是确定性策略（kind 白名单 + critical 豁免静默 + 分 kind 呼叫冷却），
  // LLM 只花在接通后的每轮口语回复；无应答自动降级文本补达。
  const proactiveCaller = new ProactiveCaller({
    virtualPhone: virtualPhoneService,
    turnLlm: externalChat?.isEnabled()
      ? async (history) => {
          let full = "";
          const last = history[history.length - 1];
          await externalChat!.streamCompletion(
            `proactive_call:${Date.now()}`,
            { text: last?.content ?? "" },
            (delta: string) => {
              full += delta;
            },
            undefined,
            {
              systemPromptOverride: history
                .filter((m) => m.role === "system")
                .map((m) => m.content)
                .join(" "),
              ephemeralTurn: true,
              disableThinking: true,
              maxThreadMessages: 0,
              ...(process.env.PROACTIVITY_PHRASE_MODEL
                ? { modelOverride: process.env.PROACTIVITY_PHRASE_MODEL }
                : process.env.PROACTIVITY_MODEL
                  ? { modelOverride: process.env.PROACTIVITY_MODEL }
                  : {}),
            },
          );
          return full;
        }
      : null,
    dataPath: proactivityFabricPath,
    // 振铃无应答/设备离线 → 文本兜底（信息必达，空响不打扰）
    fallbackTextDelivery: (actorId, title, text) => {
      proactivePipeline.submitProposal({
        proposalId: `call_fallback_${Date.now().toString(36)}`,
        actorId,
        kind: "life_reminder",
        tier: "must",
        importance: "high",
        dedupKey: `call_fallback:${title.slice(0, 40)}`,
        title,
        summary: text.slice(0, 120),
        directText: text,
        evidence: ["proactive_call_fallback"],
        createdAt: Date.now(),
        source: "proactive_call",
      });
    },
    onOutcome: (input) => {
      // 通话结果回灌：接受率口径（replied=正反馈，no_response/user_hangup=负反馈）
      costCalibrator.observe(input.outcome === "replied" ? "accepted" : "ignored");
      appendEventAudit(join(process.cwd(), "data", "proactivity", "events.ndjson"), {
        at: Date.now(),
        eventId: input.callId || `call_${Date.now().toString(36)}`,
        kind: `call:${input.kind}`,
        urgency: "alert",
        actorId: input.actorId,
        action: input.outcome,
        title: `通话结束（${input.transcript.length} 轮）`,
      });
    },
  });

  // 注意力仲裁器（L3）：打断成本 = 屏幕上下文 × 对话占用 × 日程临近 × 接受度
  const arbiterV2 = new ArbiterV2({
    presence: proactivityPresence,
    lastConversationAt: () => {
      const actorId = primaryActor();
      return actorId ? proactivityHub.lastInteractionAtOf(actorId) : null;
    },
    screenFocus: () => screenSensor.latest(),
    nextEventMin: () => scheduleSensor.latest()?.min ?? null,
    receptivity: (actorId) => {
      try {
        const hour = new Date().getHours();
        // 节律画像（行为作息推导）× 真实投递接受率（按时段，Laplace 平滑）融合：
        // 用户在该时段「实际接不接受主动消息」比推导画像更硬——样本 ≥3 时
        // 六四开加权（outcome 为主），不足时维持节律画像原值（零样本零影响）
        const byHour = rhythmEngine?.getProfile(actorId)?.dimensions?.receptivity?.byHour;
        const rhythmV = byHour?.[hour];
        const base =
          typeof rhythmV === "number" && Number.isFinite(rhythmV) ? Math.max(0, Math.min(1, rhythmV)) : 0.5;
        const outcomes = outcomesStoreForCalibrator ?? (outcomesStoreForCalibrator = new OutcomeStore(join(process.cwd(), "data", "proactivity", "outcomes.json")));
        const stat = outcomes.hourlyReceptivity(actorId).get(hour);
        if (stat && stat.samples >= 3) return Math.max(0, Math.min(1, 0.6 * stat.rate + 0.4 * base));
        return base;
      } catch {
        return 0.5;
      }
    },
    primaryActorId: primaryActor,
    alertMidThreshold: () => costCalibrator.alertMidThreshold(),
    // 稳定态放行成本上限（2026-10-10）：缺省 4.5；env 可放宽到 ≤6 让"一直在
    // 写代码/用终端"的用户也能收到积压的轻消息（原先恒 >4.5 会饿死到 TTL）
    parkCostCeil: () => {
      const raw = Number.parseFloat(process.env.PROACTIVITY_PARK_COST_CEIL ?? "");
      return Number.isFinite(raw) && raw > 0 ? Math.min(10, raw) : 4.5;
    },
    // 挂起项过期降级投递（2026-10-10）：不再静默丢弃——把"等了但没等到时机"
    // 的事件经管道离线兜底（落站内信）说出。管道晚绑定（下方 ref 已声明）。
    onParkExpire: (entry) => {
      try {
        entry.deliver();
        console.log(`[ArbiterV2] 挂起过期降级投递 label=${entry.label}`);
      } catch (err) {
        console.log(`[ArbiterV2] 挂起过期降级投递失败（忽略）label=${entry.label}: ${err}`);
      }
    },
  });

  // 评估器链（L2）：信号 delta → AttentionEvent（正文模板直出，零 LLM）
  // 感知 → 目标桥晚绑定容器（goalPlanner 在下方创建后填充；见 activeGoalLine）
  const goalSignalBridgeRef: { current: import("../proactivity/goal-signal-bridge.js").GoalSignalBridge | null } = { current: null };
  // 共享发现层晚绑定容器（sourceStore/goalBoard 在下方创建后填充；见 activeGoalLine）
  const discoveryRef: { current: DiscoveryLayer | null } = { current: null };
  const builtinServices = {
      listTodayTasks: () => {
        const now = Date.now();
        const horizon = now + 24 * 3600_000;
        return scheduleTaskService
          .listAllTasks()
          .filter((t) => t.status !== "cancelled")
          .map((t) => ({ title: t.title ?? "", runAt: t.runAt }))
        .filter((t) => {
          const at = typeof t.runAt === "number" ? t.runAt : Date.parse(String(t.runAt));
          return Number.isFinite(at) && at > now && at <= horizon;
        })
        .sort((a, b) => {
          const at = (v: { runAt?: number | string }) =>
            typeof v.runAt === "number" ? v.runAt : Date.parse(String(v.runAt));
          return at(a) - at(b);
        })
        .slice(0, 6);
    },
    commitmentsDue: (withinMs: number) => {
      const now = Date.now();
      return (commitmentBoard?.list({ status: "active", limit: 100 }) ?? [])
        .map((c) => ({ id: c.id, title: c.text, ...(c.deadline ? { dueAt: Date.parse(c.deadline) } : {}) }))
        .filter((c) => Number.isFinite(c.dueAt) && (c.dueAt as number) > now && (c.dueAt as number) <= now + withinMs)
        .sort((a, b) => (a.dueAt as number) - (b.dueAt as number));
    },
    weatherLine: () => weatherLineCache,
    // 未读发件人（digest/晨报拼接）：MessageHub 会话表中 unreadCount>0 的对端
    unreadSenders: () => {
      const actorId = primaryActor();
      if (!actorId) return [];
      try {
        return messageHubService
          .listConversations(actorId, { limit: 20 })
          .filter((c) => c.unreadCount > 0)
          .map((c) => c.participantName || c.title || String(c.platform))
          .slice(0, 5);
      } catch {
        return [];
      }
    },
    readyGoals: () =>
      goalBoard.readyTray().map((g) => ({ title: g.title, body: String(g.payload?.body ?? g.title) })),
    interestLines: () => {
      const actorId = primaryActor();
      return actorId ? [interestWatcher.listForPrompt(actorId, 3) ?? ""] : [];
    },
    recallMemory: async (query: string, limit: number) => {
      const actorId = primaryActor();
      if (!brainCenter || !actorId) return [];
      const result = await brainCenter.recall(actorId, query, { domain: "episodic", limit });
      return (result?.items ?? []).map((item) => item.content);
    },
    // 感知 → 目标桥（2026-10-10）+ 共享发现层读点（2026-10-19）：两者都晚绑定
    // （goalPlanner / sourceStore 在下方创建）。规则文案据此从"碎片化场景"升级为
    // "带目标上下文"，并带上**该目标尚未开口的发现条数**——对话注入与开口闸读的是
    // 同一份发现台账，不再是各读各的。未装配时返回 null，行为不变。
    activeGoalLine: (actorId: string) => {
      const bridge = goalSignalBridgeRef.current;
      const line = bridge?.goalLineFor(actorId) ?? null;
      if (!line) return null;
      const goal = bridge?.activeGoalContext(actorId, 1)[0];
      const pending = goal && discoveryRef.current ? discoveryRef.current.findingsFor(goal.goalId).length : 0;
      return pending > 0 ? `${line}（另有 ${pending} 条相关发现待汇总）` : line;
    },
  };
  // 世界状态板：传感信号分层整理成"专属给规则看的现在"（程序采集+整理，零判断零 LLM）
  const worldBoard = new WorldBoard({ dataPath: proactivityFabricPath });
  worldBoardRef.current = worldBoard;
  bridgeSensorKernelToBoard(sensorKernel, worldBoard, primaryActor);
  // P0 清板（2026-10-01）：板上 actor 坟场一次性清理——7 天无交互的测试/
  // 历史账号（E2E/bench/profile 全家 143 个）不再常驻每 tick 全量评估；
  // 幽灵键（历史接线 bug 把函数源码当 actorId）一并移除。
  // WorldBoard 无删 API，直接操作底层数据文件（板结构稳定：{actors:{id:四层}}）。
  try {
    const boardFile = join(proactivityFabricPath, "world-board.json");
    if (existsSync(boardFile)) {
      const raw = JSON.parse(readFileSync(boardFile, "utf8")) as {
        actors?: Record<string, unknown>;
      };
      const known = new Map(
        proactivityHub.exportActors().map((a) => [a.actorId, a.lastInteractionAt]),
      );
      const nowMs = Date.now();
      let removed = 0;
      for (const id of Object.keys(raw.actors ?? {})) {
        const isGhost = id.includes("exportActors") || id.startsWith("()=>");
        const lastAt = known.get(id);
        const isStale = lastAt == null || nowMs - lastAt > 7 * 24 * 60 * 60_000;
        if (isGhost || isStale) {
          delete raw.actors![id];
          removed++;
        }
      }
      if (removed > 0) {
        writeFileSync(boardFile, JSON.stringify(raw));
        console.log(`[Bootstrap] 状态板已清理僵尸 actor：移除 ${removed} 个（7 天无交互/幽灵键）`);
      }
    }
  } catch (err) {
    console.log(`[Bootstrap] 状态板清理失败（忽略）: ${err}`);
  }
  // P0（2026-10-01「顺嘴要贴此刻」）：状态板当下层接进对话面——agent-core 每轮
  // 读 current（屏幕焦点/在线状态）注入【当下状态】块。此前板只喂映射规则，
  // 聊天回复对「用户此刻在干嘛」零输入，顺嘴只能拿旧记忆套模板（熬夜→劝睡事故）。
  agentCore.setCurrentStateProvider((actorId: string) =>
    formatCurrentStatePrompt(worldBoard, actorId),
  );
  // 映射执行器（L2）：规则表读状态板 → AttentionEvent（正文模板直出，零 LLM）
  const mappingExecutor = new MappingExecutor({
    board: worldBoard,
    rules: buildBoardRules(builtinServices),
    defaultActorId: primaryActor,
    // 规则私有状态 + 事件去重指纹落盘：重启不重发、马拉松计时不清零
    dataPath: proactivityFabricPath,
    // P0 配额窃取根修（2026-10-01）：板上是测试 actor 坟场（143 个 E2E/bench
    // 永不过期），规则去重/节流若按插入序全局消费，先到的测试 actor 吃掉当天
    // 配额——审计实证真实用户 16 天 0 事件。tick 只评估 7 天内交互过的用户。
    isActiveActor: (actorId) => {
      const hit = proactivityHub
        .exportActors()
        .find((a) => a.actorId === actorId);
      return !!hit && Date.now() - hit.lastInteractionAt < 7 * 24 * 60 * 60_000;
    },
  });
  console.log("[Bootstrap] 主动性已装配（传感→状态板→映射规则→仲裁→目标，零 LLM）");

  // ─── 购物降价监控装配（复用 InterestWatcher 轮询模式，tick=PRICE_WATCH_TICK_MS 默认 60min）───
  // shopping.compare.watch 工具入库 → 后台定时复查价格 → 到价且为新低价 →
  // submitIntent（life_reminder kind，走 FrequencyGovernor 频控）speak 闭环主动推。
  await shoppingCompareService.load();
  shoppingCompareService.setOnPriceAlert((actorId, watch, hit) => {
    proactivityHub.submitIntent({
      actorId,
      kind: "life_reminder",
      importance: "medium",
      title: `「${watch.query}」已降到 ¥${hit.priceCny}`,
      summary:
        `用户设置的降价监控命中：用户关注的「${watch.query}」当前在 ${watch.platform} 最低价 ¥${hit.priceCny}，` +
        `已低于设定的目标价 ¥${watch.targetPrice}。` +
        `像朋友分享好 deal 一样自然提起${hit.url ? `，附上链接 ${hit.url}` : ""}，轻问一句要不要下单。别写成资讯播报。`,
      mode: "speak",
      source: "finance",
    });
  });
  shoppingCompareService.start();
  console.log("[Bootstrap] 购物降价监控已装配（shopping.compare.watch）");

  // ─── 用户邮箱盯梢（MailWatch，2026-09-18"Agent 帮用户盯消息"地基）───
  // IMAP 轮询 → 重要性分级（VIP 白名单/确定性关键词规则）：
  //   critical/high → ProactivityHub 主动提醒（life_reminder kind 走频控，speak 闭环）；
  //   全部邮件     → message-hub 落库（platform=email，进消息中心统计）。
  // 财务实时通道（2026-09-18）：账单/支付类新邮件 → isBillRelatedMail 粗筛 →
  //   ingestText（LLM 抽取 + 指纹去重 + 入账，入账后经 setOnIngested 轻提醒）。
  //   这是"后台自动获取财务数据"里延迟最低的通道（邮件到达即入账，秒~分钟级）；
  //   浏览器拉取通道（FinanceBillAutoFetchService）负责兜底对账，两者靠幂等键互补。
  // MAIL_WATCH_ENABLED=0 或配置不齐时 start() 如实 no-op，状态查 mailWatchService.status()。
  // 票务/日历邮件 → 日程物化桥（2026-09-25）：粗筛命中才解 MIME（ICS 附件直取 +
  // 12306/出票/酒店模板规则），静默落 source=email 日程，一轮汇总一条轻提醒。
  const mailScheduleBridge = new MailScheduleBridge({
    tasks: scheduleTaskService,
    notify: (intent) => proactivityHub.submitIntent(intent),
    // 漏检埋点（2026-10-11）：预筛判定"像票务"但规则解不出结构化字段 → 记一条。
    // 只观测不改变行为；计数快照经 proactivityFabric.mailTicketMissStats 查询，
    // 用于评估"要不要为这一小撮开一次有边界的 LLM 兜底"。日志按 actor 归属便于排障。
    onMiss: (miss) => {
      app.log.warn(
        `[mail-ticket] 疑似票务邮件未识别（漏检埋点）：reason=${miss.reason} ` +
          `from=${miss.from} subject=${miss.subject} bodyChars=${miss.bodyChars}`,
      );
    },
  });
  const mailWatchService = new MailWatchService({
    env: process.env,
    messageHub: messageHubService,
    // 生产 IMAP 客户端（imapflow，每轮 poll 新建连接用完即弃）。此前从未注入——
    // 邮件链即使填了授权码也会「running=true 但空转」（2026-10-01 补接线）。
    // cfg 由 service 每轮传入（含运行时 applyPass 设置的授权码）。
    clientFactory: (cfg) => createImapflowClient(cfg),
    onNewMessage: (mail, classification) => {
      // 财务实时入账：账单/支付类邮件直接喂给财务抽取链路（fire-and-forget，
      // 失败只记日志不打断盯梢；是否真有交易由 ingestText 的 LLM 抽取如实判断）
      if (isBillRelatedMail({ from: mail.from, subject: mail.subject, text: mail.textSnippet ?? "" })) {
        const billText =
          `发件人: ${mail.from}\n主题: ${mail.subject}\n时间: ${mail.date ?? ""}\n正文:\n${mail.textSnippet ?? ""}`;
        void financeIngestService
          .ingestText(mail.actorId, billText)
          .then((r) => {
            if (r.ok) {
              app.log.info(`[mail-watch] 账单邮件已自动入账（${mail.from}）: ${r.message}`);
            }
          })
          .catch((e) => {
            app.log.warn(`[mail-watch] 账单邮件自动入账失败（忽略）: ${e instanceof Error ? e.message : String(e)}`);
          });
      }
      // 票务/日历提取支路 + 提醒闸门（2026-10-05 邮箱=信息采集定调）：
      // 提取先于闸门完成——邮件一旦成功识别为票务/预订（哪怕草稿全被时间闸
      // skipped，如过期票），就不再当场 high 打扰：提醒交给日程策略层按事件
      // 时间自动排（前晚备忘/出发预留），桥内那条 medium 汇总保留。
      // 未识别为票务的（验证码/账单/航班延误类模板未命中）保持原闸门当场提醒。
      void (async () => {
        let ticketReport: MailScheduleSyncReport | null = null;
        try {
          ticketReport = await mailScheduleBridge.onMail(mail);
          if (ticketReport && ticketReport.created + ticketReport.updated + ticketReport.cancelled > 0) {
            app.log.info(
              `[mail-watch] 票务邮件已同步日程（${mail.subject}）: +${ticketReport.created} ~${ticketReport.updated} -${ticketReport.cancelled}`,
            );
          }
        } catch (e) {
          app.log.warn(`[mail-watch] 票务邮件日程提取失败（忽略）: ${e instanceof Error ? e.message : String(e)}`);
        }
        // 提醒闸门：只有 critical/high 当场提醒（promotional 在 MailWatch 内已被
        // 过滤不会到这里；normal 静默落库）。此处白名单式判断，新增分级默认不推送。
        if (classification.importance !== "critical" && classification.importance !== "high") return;
        if (suppressMailInterrupt(ticketReport)) return;
        proactivityHub.submitIntent({
          actorId: mail.actorId,
          kind: "life_reminder",
          // high/critical → high：验证码/传票/逾期这类邮件时效以分钟计（验证码
          // 10 分钟作废），降档会被静默时段吞到明早——时效即价值，必须当场提醒。
          // （governor 静默规则本就给 high 开了豁免通道；medium 留给普通关注件。）
          importance: classification.importance === "critical" || classification.importance === "high" ? "high" : "medium",
          title: `邮件：${mail.subject || "（无主题）"}`,
          summary:
            `收到来自 ${mail.from} 的${classification.importance === "critical" ? "重要" : "需要关注"}邮件` +
            `「${mail.subject || "（无主题）"}」` +
            `${mail.textSnippet ? `，开头内容：${mail.textSnippet.slice(0, 120)}` : ""}。` +
            `像助手汇报要事一样自然提起，问用户要不要现在处理；不要复述成资讯播报。`,
          mode: "speak",
          source: "email",
        });
      })();
    },
  });
  mailWatchService.start();
  // P2 邮箱自动接入（2026-10-01）：注册登录留下的邮箱自动接线（host 按域映射、
  // actorId=账号）。env 显式配置优先不覆盖；IMAP 授权码仍需用户填一次（服务端
  // 无从得知，status() 如实报等待授权码）。
  try {
    const autoMail = resolveAutoMailAccount(agentAccountService);
    if (autoMail) {
      mailWatchService.applyAutoAccount(autoMail);
      if (!mailWatchService.status().running && mailWatchService.isConfigured()) {
        mailWatchService.start();
      }
    }
  } catch (err) {
    console.log(`[Bootstrap] 邮箱自动接入失败（忽略）: ${err}`);
  }
  console.log(
    `[Bootstrap] 邮箱盯梢 ${mailWatchService.status().running ? "已启动" : "未启用（MAIL_WATCH_ENABLED/MAIL_WATCH_HOST/USER/PASS）"}`,
  );

  // ─── ICS 日历订阅轮询（2026-09-24，「日程零手工」外部信源）───
  // 拉取用户配置的 .ics 订阅链接 → RFC5545 子集解析 → 事件键 diff →
  // 自动落成 source=ics 的日程（新增/改期/取消反向同步），变更走一次汇总提醒。
  // ICS_SUB_ENABLED=0 或未配 ICS_SUB_URLS 时 start() 如实 no-op，状态查 icsSubscriptionService.status()。
  const icsSubscriptionService = new IcsSubscriptionService({
    config: readIcsWatchConfig(process.env),
    tasks: scheduleTaskService,
    notify: (intent) => proactivityHub.submitIntent(intent),
  });
  icsSubscriptionService.start();
  {
    const icsStatus = icsSubscriptionService.status();
    console.log(
      `[Bootstrap] ICS 日历订阅 ${icsStatus.enabled && icsStatus.feeds.length > 0 ? `已启动（${icsStatus.feeds.length} 个订阅源，每 ${icsStatus.pollSec}s）` : "未启用（ICS_SUB_ENABLED/ICS_SUB_URLS）"}`,
    );
  }

  // ─── 财务账单后台自动拉取（2026-09-18，"系统后台自动获取财务数据"）───
  // 双模式调度：准实时（FINANCE_BILL_AUTO_FETCH_INTERVAL_MIN>0，每 N 分钟拉增量，
  // 下限 10 分钟防支付宝风控）或 每日定点（默认 21 点）。用用户支付宝登录态
  // （Cookie 双门禁同购物域）拉交易明细 → 确定性 id 幂等去重 → 仅新增入账 →
  // 有新增时轻提醒。秒~分钟级的"实时"主力是上面的账单邮件通道（邮件到达即入账），
  // 本服务负责登录态全量兜底对账。FINANCE_BILL_AUTO_FETCH_ENABLED=0 时调度 no-op；
  // finance.bills.sync_now 可手动触发。
  const financeBillAutoFetch = new FinanceBillAutoFetchService({
    browserSessions: browserSessionService,
    financeDeepService,
    fetcher: createPlaywrightAlipayBillFetcher(browserSessionService),
    logger: (level, message) => app.log[level](message),
    onSynced: (actorId, summary) => {
      if (summary.added <= 0) return;
      proactivityHub.submitIntent({
        actorId,
        kind: "life_reminder",
        importance: "low",
        title: "账单已自动同步",
        summary:
          `支付宝账单自动同步完成：新增 ${summary.added} 笔入账` +
          `${summary.duplicates > 0 ? `（另有 ${summary.duplicates} 笔已存在，未重复记账）` : ""}。` +
          `消费统计与预算进度已更新。像管家顺手记完账一样轻描淡写提一句即可，不必展开。`,
        mode: "speak",
        source: "finance",
      });
    },
  });
  financeBillAutoFetch.start();
  toolRegistry.register(
    "finance.bills.sync_now",
    async (input: Record<string, unknown>, context: ToolContext) => {
      void input;
      const actorId = resolveActorId(context);
      const result = await financeBillAutoFetch.runNow(actorId);
      if (!result.ok) {
        return {
          ok: false,
          error: result.error,
          hint:
            "后台自动拉取需要：用户在网页登录支付宝后导入 Cookie（siteId=alipay）并授权 agentAllowed。" +
            "在此之前可让用户直接粘贴账单导出文本（finance.import_transactions 支持自动识别）。",
        };
      }
      return {
        ok: true,
        added: result.added,
        duplicates: result.duplicates,
        summary:
          `支付宝账单同步完成：新增 ${result.added} 笔` +
          `${result.duplicates > 0 ? `，${result.duplicates} 笔已存在未重复入账` : ""}` +
          `${result.note ? `（${result.note}）` : ""}`,
      };
    },
  );
  const financeAutoFetchStatus = financeBillAutoFetch.status();
  console.log(
    `[Bootstrap] 财务账单自动拉取 ${
      financeAutoFetchStatus.enabled
        ? financeAutoFetchStatus.mode === "interval"
          ? `已启动（准实时：每 ${financeAutoFetchStatus.intervalMin} 分钟）`
          : `已启动（每日 ${financeAutoFetchStatus.hour} 点）`
        : "未启用（FINANCE_BILL_AUTO_FETCH_ENABLED=1 开启；需导入支付宝 Cookie；实时场景建议叠加账单邮件通道）"
    }`,
  );

  // ─── 外部信源收编 × 跨源统一采集库（2026-10-10 扫描架构 P0）───
  // 此前外部信源（邮件/日历/财务）各扫各的、各存各的目录，产出不进 SensorKernel，
  // 导致：① 无"自己的数据库"无法跨源查询；② 无法跨源关联（邮件航班+日历行程+账单
  // 酒店）；③ 邮件链路挂了主系统不感知。这里把三者适配成 ProactiveSensor 收编进
  // 统一内核（调度/退避/水位/健康白送），并把内核信号汇聚进 SourceStore。
  // 单源回退：SENSOR_FABRIC_MAIL=0 / SENSOR_FABRIC_ICS=0 / SENSOR_FABRIC_FINANCE=0；
  // 整库回退：SENSOR_SOURCE_STORE=0。适配器只做形状转换，业务逻辑仍留在原服务。
  const sourceStore = new SourceStore({ dataPath: proactivityFabricPath });

  // ─── 共享发现层（2026-10-19，架构收口）───
  // 一条总线（SourceStore 的 finding 条目）+ 一个共同键（subject）+ 一个单开口闸
  // （composeBeforeOpen）。此前 GoalRunner / 夜间内省 / 感知规则桥 / 邮件 / 日历 /
  // 天气 / 财务 各写各的、各说各的，源数一涨就 N²；现在它们先把"发现"写进同一条
  // 总线，开口前统一读合成——"信息汇总、各自联系"由总线与实体倒排自然产生。
  // 目标侧的开口记账接 GoalBoard（goalId 上次开口跨重启仍有效），其余留内存。
  const discovery = new DiscoveryLayer({
    store: sourceStore,
    goalOpens: {
      lastOpenedAt: (subject) => goalBoard.get(subject)?.lastOpenedAt,
      markOpened: (subject, at) => goalBoard.noteOpened(subject, at),
    },
  });
  discoveryRef.current = discovery;
  // 顺嘴搭车出口接入共享发现层（2026-10-19 二期）：取货织入时也走同一道 composeBeforeOpen
  // （把同主题他人发现合并进旁注）+ 取走即说出地结算预留。晚绑定：hub 早于 discovery 构造。
  proactivityHub.setDiscovery(discovery);
  const sensorFabricDisabled = (name: string) => process.env[`SENSOR_FABRIC_${name}`] === "0";
  if (!sensorFabricDisabled("MAIL")) {
    sensorKernel.register(new MailSensor({ fetchNewSince: (since) => mailWatchService.fetchNewSince(since) }));
  }
  if (!sensorFabricDisabled("ICS")) {
    sensorKernel.register(new IcsSensor({ fetchEventsSince: (since) => icsSubscriptionService.fetchEventsSince(since) }));
  }
  if (!sensorFabricDisabled("FINANCE")) {
    sensorKernel.register(
      new FinanceSensor(
        { getTransactions: (...args) => financeDeepService.getTransactions(...args) },
        () => primaryActor(),
      ),
    );
  }
  // 内核 → SourceStore：所有信号（内线 + 外线）统一汇聚进"自己的数据库"
  sensorKernel.onSignal((signal) => sourceStore.feed(signal));
  // 订单流 feeder（2026-10-19）：MessageHubService.onInbound 里派生的 shopping
  // 信号从这里进内核。此刻起 onInbound 的派生开始生效（晚绑定闭环）。
  emitShoppingOrder = registerFeeder(sensorKernel, "shopping_orders", "shopping");
  // order.status：只读跨源库的订单状态查询（probe 判定 / 模型按需查）。
  // 只读工具，handoff 等待期不被 act_external 收缩拦下。
  registerOrderStatusTools(toolRegistry, { sourceStore });
  console.log(
    `[Bootstrap] 跨源统一采集库 ${sourceStore.enabled() ? "已启用" : "已关闭（SENSOR_SOURCE_STORE=0）"}；` +
      `外部信源收编 mail=${!sensorFabricDisabled("MAIL")} ics=${!sensorFabricDisabled("ICS")} finance=${!sensorFabricDisabled("FINANCE")}`,
  );
  // 启动分段加载：把最近 N 天日分区重建进内存窗口 + 实体索引（对齐 Muse「扫进自己的库、
  // 随时可查」——重启后历史仍可跨源检索，不再"重启即失忆"）。延迟到启动完成后执行，
  // 避免同步读盘阻塞引导；只读不写。SENSOR_SOURCE_LOAD_DAYS=0 关闭。
  if (sourceStore.enabled() && sourceStore.loadDays() > 0) {
    const loadTimer = setTimeout(() => {
      try {
        const loaded = sourceStore.loadRecent();
        if (loaded > 0) {
          console.log(
            `[Bootstrap] 跨源库启动加载 ${loaded} 条历史信号（最近 ${sourceStore.loadDays()} 天）；` +
              `保留 ${sourceStore.retentionDays()} 天`,
          );
        }
      } catch (e) {
        console.warn(`[Bootstrap] 跨源库启动加载失败（忽略）：${e instanceof Error ? e.message : String(e)}`);
      }
    }, 1500);
    if (typeof loadTimer.unref === "function") loadTimer.unref();
  }

  // ─── Task 16 消费管家闭环装配（场景B）───
  // 工具执行成功 → hookBus tool.executed → 自动入账（finance-deep）
  // → 预算超支检测（life_reminder 单次提醒）→ 每月 1 日上月消费月报
  // （确定性数据 + 单次 LLM 总结，monthly_report kind）。
  const consumptionLedgerListener = new ConsumptionLedgerListener({
    financeDeepService,
    // 订阅盘点：月报末尾追加订阅盘点段（确认订阅/月成本/低使用率/疑似候选）
    subscriptionAudit: subscriptionAuditService,
    // 预算超支 → 经 ProactivityHub speak 闭环（life_reminder kind 频控）
    onBudgetAlert: (actorId, message) => {
      proactivityHub.submitIntent({
        actorId,
        kind: "life_reminder",
        importance: "medium",
        title: "预算超支提醒",
        summary: message,
        mode: "speak",
        source: "finance",
      });
    },
    // 月报生成完成 → monthly_report kind 推送
    onMonthlyReport: (actorId, reportText) => {
      proactivityHub.submitIntent({
        actorId,
        kind: "monthly_report",
        importance: "low",
        title: "上月消费月报",
        summary: reportText,
        mode: "speak",
        source: "finance",
      });
    },
    // 单次 LLM 总结（与 ProactivityHub llmComplete 同模式，克制调用）
    llmComplete: externalChat?.isEnabled()
      ? async (prompt) => {
          let full = "";
          await externalChat!.streamCompletion(
            `finance-report-${Date.now()}`,
            { text: prompt },
            (delta: string) => {
              full += delta;
            },
            undefined,
            {
              systemPromptOverride: prompt,
              ephemeralTurn: true,
              disableThinking: true,
              maxThreadMessages: 0,
            },
          );
          return full;
        }
      : undefined,
  });
  consumptionLedgerListener.subscribe(hookBus);
  consumptionLedgerListener.start();

  // ─── 订阅盘点装配（财务管家 P0）───
  // 每日扫描：续费日前 3 天 → life_reminder 主动提醒（同一续费日单次）；
  // 候选检测在 list_subscriptions 工具与月报订阅段里按需触发，不占扫描。
  subscriptionAuditService.setOnRenewalReminder((actorId, message) => {
    proactivityHub.submitIntent({
      actorId,
      kind: "life_reminder",
      importance: "medium",
      title: "订阅续费提醒",
      summary: message,
      mode: "speak",
      source: "finance",
    });
  });
  subscriptionAuditService.start();

  // ─── 账单管理装配（订阅与财务清理）───
  // 每日扫描：到期前 3 天 / 已逾期 → life_reminder 主动提醒（同一到期日单次）；
  // 缴费经 pay_bill 工具入账联动预算，不占扫描。
  billManagementService.setOnBillReminder((actorId, message) => {
    proactivityHub.submitIntent({
      actorId,
      kind: "life_reminder",
      importance: "medium",
      title: "账单到期提醒",
      summary: message,
      mode: "speak",
      source: "finance",
    });
  });
  billManagementService.start();

  // ─── Task 17 人情关系管家装配（场景C）───
  // 晨报每日生成 = 每日扫描：当天命中重要日子（KV important_dates，由
  // care.set_important_date 录入）→ 单次 LLM 祝福草稿（关系标签+交往摘要）
  // → life_reminder 主动提醒，草稿附带给用户改写；频控 4h + 负反馈抑制兜底。
  onImportantDayToday = (sessionId, day) => {
    const label = importantDayTypeLabel(day.type);
    const rel = day.relationship ? `（${day.relationship}）` : "";
    void generateImportantDayBlessing(
      day,
      // 单次 LLM 祝福草稿（与消费管家月报同模式，克制调用）
      externalChat?.isEnabled()
        ? async (prompt) => {
            let full = "";
            await externalChat!.streamCompletion(
              `blessing-${day.id}-${Date.now()}`,
              { text: prompt },
              (delta: string) => {
                full += delta;
              },
              undefined,
              {
                systemPromptOverride: prompt,
                ephemeralTurn: true,
                disableThinking: true,
                maxThreadMessages: 0,
              },
            );
            return full;
          }
        : undefined,
    )
      .then((draft) => {
        proactivityHub.submitIntent({
          actorId: sessionId,
          kind: "life_reminder",
          importance: "high",
          title: `今天是${day.name}的${label}`,
          summary:
            `今天是${day.name}${rel}的${label}。我拟了一条祝福草稿，你可以直接发，` +
            `也可以改改再发：${draft}`,
          mode: "speak",
          source: "relationship",
        });
      })
      .catch((err) => {
        console.log(`[Bootstrap] 重要日子祝福提醒失败（忽略）: ${err}`);
      });
  };
  console.log("[Bootstrap] 人情关系管家已装配（晨报近期重要日子块 + 当天命中祝福提醒）");

  // ─── Task 15 恶劣天气预警联动装配（场景A）───
  // 晨报生成时检测当日预警（暴雨/雷暴/冻雨/大雪/高温/寒潮/大风，确定性规则）
  // → 预警且当日有日程 → weather_alert kind 合并提醒（30min 频控 + 负反馈抑制兜底）。
  onSevereWeatherAlert = (sessionId, alerts, scheduleCount) => {
    proactivityHub.submitIntent({
      actorId: sessionId,
      kind: "weather_alert",
      importance: "high",
      title: `恶劣天气预警：${alerts.join("、")}`,
      summary:
        `今天有${alerts.join("、")}预警，而你今天还有${scheduleCount}件事要办。` +
        `像朋友顺手提醒一样：出门注意安全，该带伞带伞、该添衣添衣，` +
        `行程如果受影响可以帮你调整或取消。`,
      mode: "speak",
      source: "weather",
    });
  };
  console.log("[Bootstrap] 恶劣天气预警联动已装配（晨报检测 + weather_alert 合并提醒）");

  // ─── 统一主动性管道装配（docs/proactivity-architecture.md §4）───
  // 触发源只提交提案；管道承担 去重 → 仲裁（过期/负反馈抑制/静默择时/分层预算/在场择时，
  // 纯规则零 LLM）→ 投递（全部在线设备 fan-out 直推，两端离线升级手机推送）→ outcome 回传自适应冷却。
  // 频控与 hub 共用 proactivityGovernor（单一预算口径）；known actor 状态随管道落盘重启恢复，
  // 重启后 hub 才能在用户开口前自主发起问候。
  const proactivePushService = new MobilePushService({
    registryPath: join(process.cwd(), "data", "proactivity", "push-tokens.json"),
  });
  // 助手动态台账：action.* 代办提案投递成功后落一条记录，右侧面板「助手动态」卡读取
  const agentActivityStore = new AgentActivityStore(
    join(process.cwd(), "data", "proactivity", "activities.json"),
  );
  // ─── 计划推进（2026-09-24，对标 Muse 大目标模式）+ 行为审计时间线 ───
  // plan 型目标拆步 → 逐步派后台任务（agentCore.dispatchBackgroundTask）→
  // TaskHub 终态回调自动推进下一步；外部副作用步骤转「等你确认」（敏感动作分级闸）。
  // 成本治理（2026-10-01）：goal 步骤是全量后台 agent 任务、不占社交预算，
  // 是主动性链路唯一可能失控的 LLM 花费口——三层闸：
  //   ① 每日派发上限 PROACTIVITY_GOAL_DAILY_BUDGET（默认 24）——超出返回 null，
  //     步骤停在 todo（goal-planner 如实标注「预算超限」）
  //   ② 轻步骤车道（总结/整理类，goal-planner.isLightStep）按小预算快档派发
  //   ③ token 审计单列 goal_plan_stage（usage 台账可见主动性执行成本）
  const goalDailyBudget = (() => {
    const raw = process.env.PROACTIVITY_GOAL_DAILY_BUDGET;
    const n = raw ? Number.parseInt(raw, 10) : NaN;
    return Number.isFinite(n) && n > 0 ? n : 24;
  })();
  const goalLaneState = { day: "", dispatched: 0 };
  const goalLaneEnabled = () => process.env.GOAL_PLAN_LIGHT_LANE !== "0";
  const goalPlanner = new GoalPlanner({
    goalBoard,
    launchTask: (input) => {
      const today = new Date().toISOString().slice(0, 10);
      if (goalLaneState.day !== today) {
        goalLaneState.day = today;
        goalLaneState.dispatched = 0;
      }
      if (goalLaneState.dispatched >= goalDailyBudget) {
        console.warn(
          `[GoalPlanner] 当日 goal 步骤派发已达上限 ${goalDailyBudget}（PROACTIVITY_GOAL_DAILY_BUDGET），步骤保持待办`,
        );
        return null;
      }
      const taskId = agentCore.dispatchBackgroundTask(input.actorId, {
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        goal: input.goal,
        source: "goal_plan",
        auditStage: "goal_plan_stage",
        ...(input.light && goalLaneEnabled()
          ? { turnPlan: { budget: 2, capabilities: ["full"], tier: "flash" } }
          : {}),
      });
      if (taskId) goalLaneState.dispatched += 1;
      return taskId;
    },
    recordActivity: (input) => {
      agentActivityStore.record({
        actorId: input.actorId,
        kind: "action.plan",
        title: input.title,
        summary: input.summary,
        ...(input.status ? { status: input.status } : {}),
        dedupKey: `plan-notify:${input.actorId}:${input.title}:${input.summary}`,
      });
    },
  });
  goalPlanner.attachTaskHub(getTaskHub());
  goalPlanner.reconcile(getTaskHub());
  capabilityModuleDeps.goalPlanner = goalPlanner;

  // ─── 在办目标进对话面（2026-10-19 三层尺度架构 · P0-A）───
  // 此前 goal 只在 proactivity 侧存在，prompt 层 grep 零命中：用户在对话里说
  // "下周去三亚"，当轮答完就蒸发；用户问"那事怎么样了"只能靠记忆模糊召回。
  // 这里把活跃目标摘要（前 3 条）接进动态层，每轮 ≈100 tokens。
  agentCore.setActiveGoalsProvider((actorId) =>
    buildActiveGoalsPromptBlock({ goalBoard, goalPlanner, actorId }),
  );

  // ─── 会话级任务计划（2026-10-19 三层尺度架构 · P0-B）───
  // TaskPlan 是三层尺度里的中间层：单次多步任务、会话内可续跑、完成即归档。
  // 存储独立（data/session-plans/），绝不进 goals.json——短任务会冲爆长期台账，
  // 而那里是每轮注入的数据源。进程级单例，工具层 getTaskPlanStore() 直取。
  initTaskPlanStore({ dataPath: join(process.cwd(), "data") });

  // ─── 等待步的客观探测（2026-10-19 handoff · checkMode=probe）───
  // 把执行权交给用户后，「他做完了」有两种收回方式：他自己点（已接），或客观
  // 事实已经到了（订单/日程/文件）。后者只能由代码定期查——零 LLM 决策，查到即
  // resume，然后起一轮受控续跑（只做下一步，不重播全表）。
  // 关：PLAN_PROBE_RUNNER_ENABLED=0。
  {
    const planStore = getTaskPlanStore();
    if (planStore) {
      const planProbeRunner = new TaskPlanProbeRunner({
        store: planStore,
        executeProbe: async ({ actorId, sessionId, tool, args }) => {
          const res = await toolRegistry.execute(tool, args ?? {}, {
            sessionId,
            userId: actorId,
          } as ToolContext);
          return { ok: res.ok, result: res.result };
        },
        onResumed: ({ actorId, sessionId, step, nextStep }) => {
          const prompt = nextStep
            ? `（计划续跑：第「${step.title}」步已确认完成，继续下一步「${nextStep.title}」。直接做，不要重新问已完成的信息。）`
            : `（计划续跑：第「${step.title}」步已确认完成，计划全部完成，向用户简单收尾说结果。）`;
          const messageId = `plan-probe-${Date.now()}`;
          const assistantMsgId = `${messageId}-a`;
          void runtime
            .handleUserMessage(actorId, prompt, {
              chatUserMessageId: messageId,
              sessionId,
              onAssistantDelta: (delta) => {
                wsConnectionRegistry.trySend(
                  actorId,
                  JSON.stringify({
                    type: ServerEventType.ChatAssistantChunk,
                    payload: { sessionId: actorId, messageId: assistantMsgId, chunk: delta },
                  }),
                );
              },
            })
            .then((reply) => {
              const text = (reply.text ?? "").trim();
              if (!reply.streamedChunks && text) {
                wsConnectionRegistry.trySend(
                  actorId,
                  JSON.stringify({
                    type: ServerEventType.ChatAssistantChunk,
                    payload: { sessionId: actorId, messageId: assistantMsgId, chunk: text },
                  }),
                );
              }
              wsConnectionRegistry.trySend(
                actorId,
                JSON.stringify({
                  type: ServerEventType.ChatAssistantDone,
                  payload: {
                    sessionId: actorId,
                    messageId: assistantMsgId,
                    finalText: getToolResultProcessor().processAssistantText(text, { userText: prompt }),
                    toolCalls: reply.toolName ? [reply.toolName] : [],
                  },
                }),
              );
            })
            .catch((err) => {
              app.log.warn({ err, actorId }, "plan probe 续跑失败");
            });
        },
      });
      planProbeRunner.start();
    }
  }

  // ─── 感知 ↔ 目标双向桥（2026-10-10，阶段二）───
  // 让规则文案带目标上下文（"你还在推进「学英语」…"），并为 GoalRunner 提供
  // "某步骤是否需要检索"的判定。方向 A 经 builtinServices.activeGoalLine 注入规则；
  // 方向 B 经 GoalRunner.planRetrieval 触发按需检索。
  const goalSignalBridge = new GoalSignalBridge({ goalPlanner });
  goalSignalBridgeRef.current = goalSignalBridge;

  // ─── GoalRunner：目标后台自主循环（2026-10-10，对标 Muse「Goal 为主引擎」）───
  // plan 型目标此前只能靠模型在对话里被动调 goal.plan.advance——没有对话就完全静止。
  // GoalRunner 补上"谁在后台定期推它"：常驻 tick 扫描活跃计划，复用 GoalPlanner.advance
  // （不绕预算闸，所有派发仍走上面的 launchTask 三道护栏）。只在"值得开口"时产提案
  // （外部步骤等确认 / 计划完成 / 阶段进展），静默推进不打扰。GOAL_RUNNER_ENABLED=0 关。
  const goalRunner = new GoalRunner({
    goalPlanner,
    // 2026-10-19：退避闸（failStreak≥2 冻结）、目标级预算、track/preexec 过期收尾
    goalBoard,
    listActors: () => proactivityHub.exportActors().map((a) => a.actorId),
    // 开口只到 hub 为止：subject=goalId 让共享发现层把它和夜间内省/规则桥的发现
    // 汇到同一个共同键上，等级判定与"重复降档"交给 composeBeforeOpen 统一做
    // （2026-10-19 起不再由生产者自己写死等级）。
    emitProposal: (p) =>
      proactivityHub.submitIntent({
        actorId: p.actorId,
        kind: "life_reminder",
        importance: p.importance,
        title: p.title,
        summary: p.summary,
        mode: "speak",
        source: "goal",
        subject: p.goalId,
        needsUser: p.needsUser,
      }),
    // 方向 B（目标 → 感知）：派发前判定下一步是否需要检索（如"查机票"）。
    planRetrieval: (goal, step) => goalSignalBridge.retrievalRequestFor(goal, step),
    // 方向 B 落地（2026-10-19）：检索结果写回该步 note（此前只打日志，是条假通路）。
    // - source 通道：跨源采集库按实体检索（"提到三亚的所有来源"），进程内零成本可查。
    // - realtime 通道：进程内没有直接的联网检索入口（检索能力在任务面工具里），
    //   不假装已查到——只把"要查什么"落到步骤上，由派发出去的那一步带工具查证。
    retrieveForStep: ({ query, channel }) => {
      try {
        if (channel === "source") {
          const hits = sourceStore.findByEntity(query, { limit: 3 });
          if (hits.length === 0) return null;
          return {
            summary: hits.map((h) => `${h.stream}：${(h.delta ?? h.entity).slice(0, 60)}`).join("；"),
          };
        }
        return { summary: `该步需要最新信息，派发后先联网核实：${query}` };
      } catch {
        return null; // 检索失败不阻断推进
      }
    },
  });
  goalRunner.start();
  capabilityModuleDeps.goalRunner = goalRunner;

  // ─── 目标夜间内省（2026-10-19，L3 日批档）───
  // L2 只回答「下一步做什么」，「这个目标还需不需要存在」要判断力但一天一次就够：
  // 确定性扫描闲置/显著度/partial 验收，产出 finding 供夜间任务开口或作废。
  // 语义终审（可选，每晚 ≤5 次 flash）：确定性判不了"办得对不对"，它能把
  // 「步骤做完但没留结果说明」的 partial 计划复核翻案；未配置模型则全程零 LLM。
  const goalIntrospector = new GoalIntrospector({
    goalBoard,
    ...(externalChat?.isEnabled() ? { semanticVerifier: createGoalSemanticVerifier(externalChat) } : {}),
  });

  // L3 排期与开口（2026-10-19）：内省引擎此前只在 HTTP 查询时被动读，闲置衰减/
  // 过期/复核的副作用在生产从不发生。这里补上"谁在夜里调它、结果怎么开口"：
  // 每晚 3 点跑一遍，finding → proactivityHub.submitIntent（频控/静默时段/负反馈
  // 抑制由那条管道统一处理，不新增闸门）。GOAL_NIGHTLY=0 关。
  const goalNightly = new GoalNightlyJob({
    introspector: goalIntrospector,
    listActors: () => proactivityHub.exportActors().map((a) => a.actorId),
    emit: (p) =>
      proactivityHub.submitIntent({
        actorId: p.actorId,
        kind: p.kind,
        importance: p.importance,
        title: p.title,
        summary: p.summary,
        mode: "speak",
        source: p.source,
        subject: p.goalId,
        needsUser: p.needsUser,
      }),
  });
  goalNightly.start();

  // 行为审计时间线（对标 Muse「全量审计轨迹」）：聚合 台账/目标板/任务面/挂起确认，
  // 出口 = GET /agent/audit-timeline + activity.timeline 工具（memory-governance 模块）
  const auditTrailService = new AuditTrailService({
    activityStore: agentActivityStore,
    goalBoard,
    taskHub: getTaskHub(),
    pendingConfirmations: proactivityConfirmations,
  });
  capabilityModuleDeps.auditTrailService = auditTrailService;
  capabilityModuleDeps.interestWatcher = interestWatcher;
  capabilityModuleDeps.commitmentBoard = commitmentBoard;
  capabilityModuleDeps.goalBoard = goalBoard;
  console.log(
    "[Bootstrap] 计划推进 + 行为审计已装配（goal.plan.* / memory.forget / activity.timeline）",
  );
  // 任务面台账/离线结果落盘：重启后台账恢复（非终态如实标记 failed，
  // "怎么样了"答得出"重启中断"）；已入箱未投递的任务结果重连后照常补投
  getTaskHub().enablePersistence(join(process.cwd(), "data", "task-plane", "task-hub.json"));
  getTaskOutbox().enablePersistence(join(process.cwd(), "data", "task-plane", "task-outbox.json"));
  // 被打断任务收口 + 自动重跑（2026-09-23）：清扫只标 failed（无连接无监听，
  // 终态送不出去），由 restart-recovery 延迟统一处理——沿原结果通道推收口
  // 通知（状态带据此收口），再把"被重启错杀"的任务自动重派（代数封顶防死循环）。
  scheduleInterruptedTaskRecovery({ agentCore, registry: wsConnectionRegistry });
  // 足迹卡实时刷新：新条目落库即向该 actor 在线设备推 agent.activity_new
  // （客户端收到后立即重拉台账，替代 1 分钟轮询的滞后；离线时推丢由轮询兜底）
  agentActivityStore.onRecord = (activity) => {
    wsConnectionRegistry.trySend(
      activity.actorId,
      JSON.stringify({
        type: "agent.activity_new",
        payload: {
          activityId: activity.id,
          kind: activity.kind,
          title: activity.title,
          status: activity.status,
        },
      }),
    );
  };
  // 代办足迹执行类上报工具：Agent 办完代办（订牛奶/缴费/改日程…）后自主调用落账
  registerAgentActivityTools(toolRegistry, agentActivityStore);
  // 身份与主页打理工具：agent.update_identity（取名/改名唯一写入口）+ agent.update_homepage
  registerAgentIdentityTools(toolRegistry, {
    accounts: agentAccountService,
    memorySync: agentMemorySyncService,
    wsRegistry: wsConnectionRegistry,
  });
  // 存量回填（2026-10-20）：名字统一管道上线前，部分账号只写了「账号 + prefs」，
  // 漏了 prompt 自我认知用的 `agent.name` KV（小来包 就是这种半截态），另有从
  // 已删除的出厂默认名继承下来的错配 handle（terminator_line）。启动时一次性补写，
  // 此后所有名字写入都收口到 applyAgentIdentityRename。异步执行，不阻塞启动。
  void (async () => {
    try {
      // 先确保 KV 磁盘快照已加载（load 幂等），否则会把半截态误判成「KV 为空」而回填
      await agentMemorySyncService.load();
      const actorIds = await listPrefsActorIds();
      for (const actorId of actorIds) {
        const profile = getUserPreferences(actorId).agentProfile;
        const origin = profile.nameOrigin;
        if ((origin !== "user" && origin !== "self") || !profile.displayName.trim()) continue;
        // 遗留错配 handle：来自已删除的出厂默认名（晨昏线 @terminator_line）→ 清空
        const legacyHandle = profile.handle === "terminator_line";
        const kvRaw = agentMemorySyncService
          .getSnapshot(actorId, [AGENT_NAME_KV_KEY])
          .entries[AGENT_NAME_KV_KEY];
        if (!parseAgentIdentityKv(kvRaw)?.displayName) {
          const ok = await agentMemorySyncService.setEntryAndWait(
            actorId,
            AGENT_NAME_KV_KEY,
            JSON.stringify({
              displayName: profile.displayName.trim(),
              handle: legacyHandle ? "" : profile.handle.trim(),
              origin,
              updatedAt: profile.updatedAt ?? new Date().toISOString(),
            }),
          );
          console.log(
            `[agent-identity-backfill] ${actorId} agent.name 回填${ok ? "成功" : "失败"}：${profile.displayName.trim()}`,
          );
        }
        if (legacyHandle) {
          patchAgentProfile(actorId, { handle: "" }, { allowIdentity: true });
          console.log(`[agent-identity-backfill] ${actorId} 清除遗留错配 handle`);
        }
      }
    } catch (e) {
      console.warn("[agent-identity-backfill] 存量回填异常（不影响启动）", e);
    }
  })();
  // 站内信：平台/运营侧 → 用户收件箱（data/inbox/{actorId}.json 持久化 + 在线 WS 直推）
  const inboxService = new InboxService({
    rootDir: join(process.cwd(), "data", "inbox"),
    wsRegistry: wsConnectionRegistry,
  });
  // LLM 预算告警出口（上线护栏）：阈值命中（80% warn / 100% exceeded 各一次）
  // 发站内信给指定管理员 actor；未配置 AGENT_LLM_BUDGET_ALERT_ACTOR 则仅 console。
  const budgetAlertActor = process.env.AGENT_LLM_BUDGET_ALERT_ACTOR?.trim();
  if (budgetAlertActor) {
    setBudgetAlertSink((status) => {
      void inboxService
        .send({
          actorId: budgetAlertActor,
          title: `LLM 预算${status.level === "exceeded" ? "超限" : "告警"}`,
          body: `${status.scope === "daily" ? "单用户单日" : "会话"}维度 ${status.key} 已用 ${status.usedTokens}/${status.limitTokens} tokens，请检查用量是否异常。`,
          importance: "high",
        })
        .catch(() => {});
    });
  }
  // 电话代办结果回执的必达通道（晚绑定：inboxService 构造晚于 coordinator）
  phoneCallCoordinator.setInbox({
    send: (input) => inboxService.send(input),
  });
  // 分级触达通道补齐：离线推送（push 服务刚创建）+ 静默执行台账（晚绑定闭包）
  reachChannels.sendPush = (input) =>
    Promise.resolve(proactivePushService.push(input))
      .then((r) => r?.ok === true)
      .catch(() => false);
  reachChannels.recordActivity = (input) => {
    agentActivityStore.record({
      actorId: input.actorId,
      kind: input.kind,
      title: input.title,
      summary: input.summary,
    });
  };
  const proactivePipeline = new ProactivePipeline({
    dataPath: join(process.cwd(), "data", "proactivity"),
    governor: proactivityGovernor,
    suppression: proactivitySuppressionStore,
    presence: proactivityPresence,
    // 话题级 dismiss 追踪（2026-10-01）：同话题连续划掉 3 条 → 投「要不要少提这类」建议；
    // 真正的静音仍只走用户明说（proactivity.feedback mute_topic / 抑制表）
    topicDismiss: new TopicDismissTracker({ dataPath: join(process.cwd(), "data", "proactivity") }),
    // 共享发现层（2026-10-19）：所有触发源的唯一收口——write/composeBeforeOpen/noteSpoken
    // 都在管道这一个入口发生（messageWatch / commitmentTrigger / 到点提醒 / 早报 / 承诺
    // 代催 / wellness 等直接调 submitProposal 的旁路，从此结构性走共享层，不必各自打补丁）。
    discovery,
    // 对话进行中判定走对话时刻（hub 记录的最近交互）：桌面同步会持续刷新设备活跃，
    // 若用活跃时刻判定，用户在电脑前的每一分钟都像"对话中"，社交提案将被无限顺延
    lastConversationAt: (actorId) => proactivityHub.lastInteractionAtOf(actorId),
    silenceLog: proactivitySilenceLog,
    confirmations: proactivityConfirmations,
    // 分级触达：提案级确认（承诺代催等）→ Router 挂升级（确认文案已由管道投递）
    onPendingConfirmation: (entry) => {
      void reachRouter
        .route({
          actorId: entry.actorId,
          kind: entry.kind,
          title: `需要确认：${entry.rationale.slice(0, 60)}`,
          summary: entry.rationale,
          urgency: "alert",
          decision: "confirm",
          deadlineAt: entry.expiresAt,
          confirmId: entry.confirmId,
          assumeDelivered: "chat",
          meta: { origin: "pipeline" },
        })
        .catch(() => {});
    },
    // 提案级确认批准动作：承诺代催 → 真实外发（MessagePlatformGateway → 微信/QQ/飞书 bridge）；
    // 其余提案 → 助手动态留痕。外发结果（已送达/排队/失败）经 speak 回执告知用户。
    onProposalApproved: (p) => {
      if (p.kind === "action.commitment.nudge" && commitmentBoard) {
        void sendCommitmentNudge(
          {
            createOutbound: (input) =>
              messageHubService.createOutbound({
                ...input,
                platform: input.platform as MessageHubPlatform,
              }),
            gatewaySend: (input) =>
              messagePlatformGateway.send({
                ...input,
                platform: input.platform as MessageHubPlatform,
              }),
            getCommitment: (id) => commitmentBoard.get(id),
            updateCommitmentNotes: (id, notes) => commitmentBoard.update(id, { notes }),
          },
          p,
        )
          .then((r) => {
            agentActivityStore.record({
              actorId: p.actorId,
              kind: p.kind,
              title: r.sent ? `已代发催促（${r.delivered ? "已送达" : "排队中"}）` : `已确认：${p.title}`,
              summary: r.detail,
              dedupKey: `approved:${p.dedupKey}`,
            });
            proactivityHub.submitIntent({
              actorId: p.actorId,
              kind: "life_reminder",
              importance: "low",
              title: r.sent ? (r.delivered ? "催促消息已发出" : "催促消息已提交网关") : "代催未能执行",
              summary: r.detail,
              mode: "speak",
              source: "relationship",
            });
          })
          .catch((err) => {
            console.log(`[commitment-board] 代发催促失败（忽略）: ${err}`);
          });
        return;
      }
      // 消息/邮件日程变动的「让助手处理」确认（2026-10-01）：派后台任务起草
      // 处理建议（改日程的具体改法 / 回复草稿），结果经任务面推回对话。
      // 只起草不外发——对外动作仍需用户自己过目，LLM 只花在用户点头之后。
      if (p.kind === "action.schedule_change" && p.source === "message_watch") {
        const taskId = agentCore.dispatchBackgroundTask(p.actorId, {
          goal:
            `【消息处理】${p.summary}。来源：${p.detail?.["来源"] ?? "消息"}。` +
            `请基于这条消息起草处理建议：若涉及日程变动，给出具体调整方案（改到什么时间/取消/新增）；` +
            `若适合回复，给出一条可直接发送的回复草稿。只起草，不要执行任何发送/修改类外部动作。`,
          source: "message_watch_confirm",
        });
        agentActivityStore.record({
          actorId: p.actorId,
          kind: p.kind,
          title: taskId ? "已开始起草处理建议" : "处理建议起草排队中（通道不可用）",
          summary: p.summary,
          dedupKey: `approved:${p.dedupKey}`,
          status: taskId ? "pending" : "failed",
        });
        return;
      }
      agentActivityStore.record({
        actorId: p.actorId,
        kind: p.kind,
        title: `已确认：${p.title}`,
        summary: p.summary,
        dedupKey: `approved:${p.dedupKey}`,
      });
    },
    delivery: new ProactiveDeliveryService({
      trySend: (actorId, json) => wsConnectionRegistry.trySend(actorId, json),
      // 定向投递（targetDeviceClass 提案用）：按设备类别投递（手机离线补达场景，
      // 桌面在线不构成对手机的送达也不吃重复通知）
      trySendToDeviceClasses: (actorId, json, deviceClasses) =>
        wsConnectionRegistry.trySendToDeviceClasses(
          actorId,
          json,
          deviceClasses.filter((c): c is "desktop" | "mobile" => c === "desktop" || c === "mobile"),
        ),
      ledger: {
        record: (p) =>
          agentActivityStore.record({
            actorId: p.actorId,
            kind: p.kind,
            title: p.title,
            summary: p.summary,
            // status 不传：由 store 按 kind 推导（schedule_change → 已调整，其余 → 已完成）
            detail: p.detail,
            dedupKey: p.dedupKey,
          }),
      },
    }),
    outcomes: outcomesStoreForCalibrator ?? (outcomesStoreForCalibrator = new OutcomeStore(join(process.cwd(), "data", "proactivity", "outcomes.json"))),
    // 无 directText 的提案走 speak 闭环（现有 ProactionCortex 话术——管道唯一 LLM 调用点）
    speak: (p) =>
      proactivityHub.submitIntent({
        actorId: p.actorId,
        kind: "followup",
        importance: p.importance === "critical" ? "high" : p.importance,
        title: p.title,
        summary: p.summary,
        mode: "speak",
        source: "task",
        // 共享发现层共同键随提案转交（2026-10-19 二期）：producer 给的 subject / needsUser
        // 不能在 speak 兜底这一跳丢掉，否则下游开口只能退回启发式推断（于是三源汇聚失效）。
        ...(p.subject ? { subject: p.subject } : {}),
        ...(p.needsUser ? { needsUser: p.needsUser } : {}),
      }),
    exportActors: () => proactivityHub.exportActors(),
    restoreActors: (entries) => proactivityHub.restoreActors(entries),
    // 移动端推送通道（离线必达升级）：两端都不在线时，必达/critical 提案改走手机系统推送
    // （JPUSH_APP_KEY/JPUSH_MASTER_SECRET 或 BARK_URL / MOBILE_PUSH_WEBHOOK_URL 任一配置即启用）
    mobilePush: proactivePushService,
    // critical 提案升级链接线（Phase 3 待办落地）：送达 ≠ 被看到——critical 直投成功后
    // 挂起 intelligent-reminder 的 popup→tts_alarm→phone_call 三级升级链（未确认按默认
    // 规则 10/12 分钟逐级升级），用户确认（reminder.acknowledge）即停链。
    escalate: (p, deliveryId) => {
      void (async () => {
        const service = intelligentReminder.reminderService;
        const instance = await service.createReminder({
          id: `pipeline_critical_${deliveryId}`,
          title: p.title,
          message: p.directText ?? p.summary,
          priority: "urgent",
          initialLevel: "popup",
          scheduledAt: new Date(),
          metadata: {
            userId: p.actorId,
            actorId: p.actorId,
            deliveryId,
            source: "pipeline-critical-escalation",
          },
        });
        await service.triggerReminder(instance.config.id);
        console.log(
          `[ProactivePipeline] critical 提案已挂起升级链 kind=${p.kind} reminderId=${instance.config.id}`,
        );
      })().catch((err) => {
        console.log(`[ProactivePipeline] critical 升级链挂起失败（忽略）kind=${p.kind}: ${err}`);
      });
    },
  });
  proactivePipeline.start();
  // 管道级确认回流：hub 的确认解析入口对 origin=pipeline 条目委托管道（批准回调 + 回执）
  proactivityHub.setPipelineConfirmationResolver((entry, approved) =>
    proactivePipeline.resolveProposalConfirmation(entry, approved),
  );
  // ─── 五层主动性架构接线（L3 仲裁 + L5 直达车道 + 启动）───
  // 直达车道：hub 的 speak/advise（模板直出）→ ArbiterV2 仲裁（连发统计口径
  // 与评估器事件归一）→ 统一管道（deliveryId/outcome/离线挂起继承）
  proactivityHub.setDirectLane((p) => {
    // ─── 开口时机（共享发现层收口已下沉到管道）───
    // "发现登记 + 开口前读合成 + 按 verdict 消费"现在统一在 proactivePipeline.submitProposal
    // 这一所有触发源的共同底发生一次（2026-10-19）；这里只负责开口时机：按（可能因重复开口
    // 降档的）等级派生 urgency，交给 ArbiterV2 决定"现在打扰还是等 pause"。
    // previewOpen 无副作用（不登记开口/不读发现），真实合成仍只在下方的 submitProposal 里跑。
    const subject = (p.subject ?? primarySubjectOf(`${p.title} ${p.summary}`) ?? "").trim();
    const graded = discovery.previewOpen(subject, p.importance, p.needsUser === true).importance;
    const urgency =
      graded === "high" || graded === "critical" ? ("alert" as const) : ("normal" as const);
    arbiterV2.admit({
      actorId: p.actorId,
      urgency,
      tier: p.tier,
      label: p.title,
      deliver: () => {
        const decision = proactivePipeline.submitProposal(p);
        proactivityHub.noteInitiative(p.actorId, p.kind, p.title);
        console.log(
          `[ArbiterV2] 直达车道投递 kind=${p.kind} verdict=${decision.verdict} urgency=${urgency}`,
        );
      },
    });
  });
  // 管道已就绪：女性关怀（周期提醒/SOS 告警）的懒引用自此可用
  wellnessPipelineRef.current = proactivePipeline;
  // 映射规则事件 → 仲裁裁决 → 管道投递（决策零 LLM；状态板不再喂任何 LLM 观察流）
  mappingExecutor.onEvent((event) => {
    const actorId = event.actorId ?? "local_user";
    // 归属判定（2026-10-19）：这条场景信号是不是在说某个在办目标的事？
    // 命中时**就地替换局部副本**——等级与正文都改由目标状态决定（卡在用户身上的
    // 目标该抢注意力），未命中时下面逐字不变（零风险回退）。生产者的等级从此不是
    // 唯一依据，"规则写死 medium" 这件事被去掉了。
    const relation = goalSignalBridge.relatedGoalFor(actorId, `${event.title} ${event.body}`);
    // 共享发现层收口已下沉到 proactivePipeline.submitProposal（所有触发源的共同底）：
    // 归属判定只在这里按目标状态调一次等级并随提案下传（subject=goalId / needsUser）；
    // 发现登记、开口前读合成、按 verdict 消费都由管道统一负责——本出口不再重复一份。
    const graded = adjustImportanceByGoalRelation(event.importance, relation);
    const goalRepeat = relation
      ? discovery.previewOpen(relation.goalId, event.importance, relation.needsUser === true).repeat
      : false;
    if (relation) {
      event = {
        ...event,
        importance: graded,
        body: appendGoalHint(event.body, relation),
      };
    }
    // 事件审计：每一次主动事件的仲裁动作与管道 verdict 全链留痕（events.ndjson）
    const audit: EventAuditRecord = {
      at: Date.now(),
      eventId: event.id,
      kind: event.kind,
      urgency: event.urgency,
      actorId,
      action: "pending",
      title: event.title,
      ...(relation ? { goalId: relation.goalId, goalMatchedOn: relation.matchedOn, goalRepeat } : {}),
    };
    const action = arbiterV2.admit({
      actorId,
      urgency: event.urgency,
      tier: event.tier,
      label: event.title,
      deliver: () => {
        // 内容型评估器事件（消息来临/临会提醒）→ LLM 话术润色后再投递；
        // 其余 kind 保持模板直投。polish 失败自动回退 event.body。
        const phraseKinds = ["unread_burst", "meeting_soon"];
        // 呼叫路由：PROACTIVE_CALL_KINDS 白名单（默认承诺守约链/行程变化）+
        // 任意 critical 事件——遇到事情打电话汇报，通话内可对话
        const callKinds = (process.env.PROACTIVE_CALL_KINDS ?? "commitment_chain,schedule_change")
          .split(",")
          .map((k) => k.trim())
          .filter(Boolean);
        const viaCall =
          event.callPolicy === "always" ||
          callKinds.includes(event.kind) ||
          event.importance === "critical";
        const submit = (bodyText: string): void => {
          const decision = proactivePipeline.submitProposal({
          proposalId: event.id,
          actorId,
          kind: event.proposalKind,
          tier: event.tier,
          importance: event.importance,
          dedupKey: event.dedupKey,
          title: event.title,
          summary: event.body.slice(0, 120),
          directText: event.body,
          evidence: [`evaluator:${event.kind}`],
          createdAt: Date.now(),
          source: `evaluator:${event.kind}`,
          // 共同键 + 是否请用户拍板随提案下传：管道的单开口闸据此合并同目标/同实体的
          // 他人发现（不再由本出口自己 compose）
          ...(relation ? { subject: relation.goalId, needsUser: relation.needsUser } : {}),
          ...(event.expiresAt !== undefined ? { expiresAt: event.expiresAt } : {}),
          ...(event.confirmLabel ? { confirmAction: { label: event.confirmLabel } } : {}),
        });
        audit.verdict = decision.verdict;
        // 投递成功记入防重复记忆：同一事件不再被 LLM 通用路径重复表达
        if (decision.verdict === "delivered") proactivityHub.noteInitiative(actorId, event.kind, event.title);
        console.log(
          `[ArbiterV2] 事件投递 kind=${event.kind} verdict=${decision.verdict} urgency=${event.urgency}`,
        );
        };
        if (viaCall) {
          // 真实来电汇报 + 通话内对话；无应答/离线自动文本兜底（caller 内部处理）
          void proactiveCaller
            .callAndReport({
              actorId,
              kind: event.kind,
              importance: event.importance === "critical" ? "critical" : "high",
              title: event.title,
              report: event.body,
              context: event.summary,
            })
            .catch((err) => {
              // callAndReport 内部已覆盖全部降级（disabled/cooldown/no_device/no_response
              // → 文本兜底）；到这里的外层异常只记日志，防止兜底后二次投递
              console.log(`[ArbiterV2] 通话异常（忽略）kind=${event.kind}: ${err}`);
            });
        } else if (phraseKinds.includes(event.kind)) {
          void (async () => {
            const polished = await speechPolisher.polish({
              kind: event.kind,
              sessionId: actorId,
              facts: { title: event.title, body: event.body },
              fallback: event.body,
              // 重要性分配：低于门槛（默认 high）的提醒直接模板直投，不花润色调用
              importance: event.importance,
            });
            submit(polished);
          })().catch((err) => {
            // 仅话术生成可失败（回退模板正文）；这里不再二次 submit，防双发
            console.log(`[ArbiterV2] 话术生成失败，用模板直投 kind=${event.kind}: ${err}`);
            submit(event.body);
          });
        } else {
          submit(event.body);
        }
      },
    });
    audit.action = action.action;
    audit.cost = action.cost;
    appendEventAudit(join(process.cwd(), "data", "proactivity", "events.ndjson"), audit);
  });
  // 会前准备包触发：60s 检查下一个日程，20-40min 窗口内启动后台预执行（幂等）。
  // actor 遍历状态板已知用户（与映射执行器同源），primaryActor 仅作兜底——
  // hub 交互记录为空（新装/纯设备在线）时 prep 不能因此哑火（2026-09-24 E2E 实证）。
  const meetingPrepTimer = setInterval(() => {
    const next = scheduleSensor.latest();
    if (!next || next.min <= 0) return;
    const boardActors = worldBoard.knownActors();
    const fallback = primaryActor();
    const actorIds = boardActors.length > 0 ? boardActors : fallback ? [fallback] : [];
    for (const actorId of actorIds) {
      goalBoard.maybeStartMeetingPrep(actorId, {
        title: next.title,
        runAtMin: next.min,
      });
    }
  }, 60_000);
  if (typeof meetingPrepTimer.unref === "function") meetingPrepTimer.unref();
  mappingExecutor.start();
  arbiterV2.start();

  // 方案 E 回填：统一管道就绪后，偏好变更触发的提案开始进入仲裁链
  proactiveSubmitRef.current = (p) => {
    proactivePipeline.submitProposal(p);
  };
  // 在场感知接线：任一设备连上即刷新在场并立即直推挂起的提醒（电脑不在线→手机一连就弹窗）；
  // 全部设备断开才判离线（提案挂起待重连，不落离线信箱）
  wsConnectionRegistry.onConnectionChange = (actorId, connected) => {
    if (connected) {
      proactivityPresence.markConnected(actorId);
      proactivePipeline.flushDue();
    } else {
      proactivityPresence.markDisconnected(actorId);
    }
  };
  // 消息监控触发器：手机入站消息（微信桥/通用消息桥统一汇入 MessageHub）落库后
  // 识别「日程变动」信号（延迟/改期/取消×会议/时间语境，零 LLM 规则）→ 主动提案。
  // 投递成功后由 delivery 层按 action.* 前缀自动落入代办足迹台账。
  const messageWatchTrigger = new MessageWatchTrigger({
    submitProposal: (p) => {
      // 行程/安排变化 = 内容型场景：LLM 基于消息原话生成主动回复（模板兜底），
      // 再进统一管道（must 层必达语义不变）
      void (async () => {
        if (p.directText) {
          // 仅话术生成可失败（回退模板）；提交只执行一次，避免异常路径双发
          p.directText = await speechPolisher.polish({
            kind: "message_watch",
            sessionId: p.actorId,
            facts: {
              sender: p.detail?.["发件人"] ?? "",
              excerpt: p.detail?.["原文"] ?? p.summary,
              verb: (p.evidence.find((e) => e.startsWith("keyword:")) ?? "").slice(8),
            },
            fallback: p.directText,
            // 重要性分配：低于门槛（默认 high）的消息提醒直接模板直投
            importance: p.importance,
          }).catch(() => p.directText!);
        }
        proactivePipeline.submitProposal(p);
      })().catch((err) => {
        console.log(`[MessageWatch] 提案处理失败（忽略）: ${err}`);
      });
    },
    // MESSAGE_WATCH_IMPORTANCE=critical 时夜间立即投递（默认 high：静默时段顺延到早7点）
    importance:
      process.env.MESSAGE_WATCH_IMPORTANCE?.trim().toLowerCase() === "critical"
        ? "critical"
        : undefined,
  });
  messageHubService.onInbound = (input) => {
    // 消息前端陈列已撤（2026-10-14 定调）：不再每条入站直推 hub.message_arrived
    // 上岛展示——多数为垃圾消息，打扰体验。消息统一在后台扫描消化：
    // messageWatchTrigger 识别高价值信号（日程变动等）→ 主动提案链路按价值
    // 推送；messageFeeder 供传感内核 unread_burst 评估；finance 静默入账。
    messageWatchTrigger.handleInbound(input);
    // 入站消息 → 传感内核 message 流（unread_burst 评估器数据源；30min 窗口 ≥3 条触发）。
    // payload.text 带正文（截 500 字）：SourceStore 按 payload.text 建实体索引，
    // 消息正文从此参与跨源检索（「提到三亚的所有来源」能命中消息）。
    messageFeeder({
      actorId: input.actorId,
      at: Date.now(),
      fingerprint: `msg:${input.actorId}:${input.platform}:${input.channelId}:${Date.now()}:${input.text.slice(0, 24)}`,
      salience: "low",
      delta: `来自 ${input.participantName || input.senderName || input.title || input.platform} 的新消息`,
      payload: {
        sender: input.participantName || input.senderName || input.title || String(input.platform),
        text: input.text.slice(0, 500),
      },
    });
    // 微信支付服务通知 → 零 LLM 解析 → 静默自动入账（只落库不推送，查询走 finance.* 工具）
    void financeIngestService.handleInboundMessage(input).catch(() => {});
  };
  // 到点提醒手机端不在场 → 定向手机端的管道提案（directText 零 LLM）：手机重连
  // 即直推（targetDeviceClass 定向，桌面不吃重复），或升级手机系统推送（proactivePushService 已配置时）
  onReminderOfflineToPipeline = (taskId, sessionId, title, message, runAt, preReminder) => {
    proactivePipeline.submitProposal({
      proposalId: `p_${Date.now().toString(36)}_rm${taskId.slice(-6)}`,
      actorId: sessionId,
      kind: "schedule_reminder",
      tier: "must",
      importance: "high",
      // 预告段与到点触发各自一条（同 taskId 同 runAt，必须用后缀区分，否则预告提案
      // 会把到点提案 dedup 吞掉）
      dedupKey: `schedule_reminder:${taskId}:${runAt}${preReminder ? ":pre" : ""}`,
      title,
      summary: message,
      evidence: [
        `taskId=${taskId}`,
        `runAt=${runAt}`,
        preReminder ? "pre_reminder" : "due_reminder",
        "mobile_not_reachable",
      ],
      directText: message,
      createdAt: Date.now(),
      source: "schedule",
      // 定向手机端（2026-10-13）：桌面在线不构成对手机的送达；投递/挂起/推送兜底均只面向手机
      targetDeviceClass: "mobile",
    });
  };
  console.log(
    "[Bootstrap] 统一主动性管道已装配（提案→仲裁→投递→反馈 + known actor 持久化；临会提醒由 meeting_soon 评估器统一承担）",
  );
  // 任务状态可查询："我还有什么待办" → agent.tasks.list 工具（只读查
  // agent-task-store，确定性状态列表，LLM 只负责措辞）
  registerAgentTasksTools(toolRegistry);
  console.log("[Bootstrap] 管家任务闭环已装配（到点提醒 speak + agent.tasks.list 查询）");

  // ─── Task 19 健康关怀装配（场景E）───
  // 1) health.query 已随 health-fitness 能力模块注册（"这周跑了几次步"类确定性
  //    统计，服务端聚合返回数字，LLM 只负责措辞）
  // 2) 节律提醒模板：喝水/睡觉/运动预设（care.rhythm_reminder 工具，默认不创建），
  //    开启 → ScheduleTaskService 每日任务 → 到点 reminderHandler → WS 推送 +
  //    proactivity speak（Task 18 已接通）
  registerRhythmReminderTools(toolRegistry, scheduleTaskService);
  console.log("[Bootstrap] 健康关怀已装配（health.query 统计问答 + 节律提醒模板）");

  // ─── 财务入站邮件记账装配（财务管家 P1）───
  // 服务已在 agentAccountService 旁构造（skill 注册需要）；
  // 这里后置注入 LLM 抽取与入账告知回调。
  // 链路：邮件网关 → POST /finance/ingest/email/inbound → 关键词预过滤 →
  // 单次 LLM 抽取交易 → 去重 → finance-deep 入账 → 轻量告知。
  if (externalChat?.isEnabled()) {
    financeIngestService.setLlmComplete(async (prompt) => {
      let full = "";
      await externalChat!.streamCompletion(
        `finance-ingest-${Date.now()}`,
        { text: prompt },
        (delta: string) => {
          full += delta;
        },
        undefined,
        {
          systemPromptOverride: prompt,
          ephemeralTurn: true,
          disableThinking: true,
          maxThreadMessages: 0,
        },
      );
      return full;
    });
  }
  financeIngestService.setOnIngested((actorId, message) => {
    proactivityHub.submitIntent({
      actorId,
      kind: "life_reminder",
      importance: "low",
      title: "账单邮件已自动记账",
      summary: message,
      mode: "speak",
      source: "finance",
    });
  });

  // ─── 方案 D：承诺驱动的主动触发源（CommitmentTrigger 适配层）───
  // 承诺板扫描事件（deadline 临近提醒 / 超时按 escalationPolicy 升级 / 依赖满足
  // 通知推进）→ 带效用元数据的提案进统一管道：代催（needsAuthorization）映射为
  // 不可逆+第三方+无授权 → ask_first；自动提取低置信承诺折算期望价值（可被
  // 效用评估沉默）；信息性事件（superseded 等）不打扰。
  provenance?.setEvidenceVoidedHook(({ ledgerIds, voidToken, reason }) => {
    const superseded = commitmentBoard?.supersedeByEvidence(ledgerIds, voidToken, reason) ?? [];
    if (superseded.length > 0) {
      console.info(
        `[commitment-board] 证据作废级联：${superseded.length} 条承诺标记 superseded（${reason}）`,
      );
    }
  });
  if (commitmentBoard) {
    const commitmentTrigger = new CommitmentTrigger({
      board: commitmentBoard,
      submit: (p) => {
        proactivePipeline.submitProposal(p);
      },
    });
    commitmentTrigger.attach();
  }

  // ─── P2-16：记忆系统健康快照（调试用）───
  app.get("/api/memory/health", async () => getMemoryHealthSnapshot());

  // 待确认收件箱外观：花钱类主动确认（需点确认）+ 主动动作台账（只读），
  // 统一 list/resolve（/api/approvals）。spend 判定用能力目录 risk=spend。
  const approvalInboxService = new ApprovalInboxService({
    proactivityHub,
    activityStore: agentActivityStore,
    featureCatalog,
    // 任务审批接入（2026-09-19 P1-1）：awaiting_approval 任务进收件箱，
    // approve/reject 委托编排器（审批后真续跑，不再「批了不跑」）
    taskStore: getAgentTaskStore(),
    taskOrchestrator: getAgentTaskOrchestrator(),
    reachRouter,
  });

  // 设备自绑定鉴权周界（仅 ACCESS_AUTH_REQUIRED=1 时挂载 hook；未开启零行为变更）
  registerAccessAuthHook(app, accessAuthService);

  // ─── 闹钟/即时提醒（docs/mobile-agent-reminder-alarm-design.md）───
  // 触发主路在客户端本地（Android 精确闹钟 / iOS 本地通知）；服务端负责落库、
  // 跨设备同步（alarm.sync）、到点兜底触发（alarm.trigger）与推送兜底。
  const alarmClockService = new AlarmClockService({
    wsRegistry: wsConnectionRegistry,
    mobilePush: proactivePushService,
    dataDir: join(process.cwd(), "data", "alarm-clock"),
    // 二阶段语音叫醒：TTS 合成开场白随 alarm.trigger 下发；不可用时客户端文本兜底
    synthesizeSpeech: async (text) => {
      const result = await ttsService.synthesizeMp3Base64(text);
      return result.ok ? { format: "mp3", base64: result.base64 } : null;
    },
    log: {
      info: (msg) => app.log.info(`[alarm-clock] ${msg}`),
      warn: (msg) => app.log.warn(`[alarm-clock] ${msg}`),
    },
  });
  alarmClockService.start();
  alarmClockServiceRef = alarmClockService;
  registerAlarmRoutes(app, { alarmClockService });
  app.addHook("onClose", async () => alarmClockService.stop());

  registerHttpRoutes(app, {
    pictureKit,
    toolRegistry,
    skillManager,
    featureCatalog,
    recommendationCatalog,
    autonomySettings,
    travelPlanningService,
    skillMetadataValidator,
    realFundsWallet,
    paymentService,
    commitmentBoard,
    scheduleTaskService,
    scheduleIntentService,
    proactivitySuppressionStore,
    proactivePipeline,
    // 简报用户称呼第一事实源（与调度推送路径同源）
    factStore: structuredFactStore ?? undefined,
    proactivePushService,
    proactivityFabric: {
      sensorHealth: () => sensorKernel.health(),
      // 目标自驱循环状态（GoalRunner）：无人对话时 goal 是否在后台推进
      goalRunnerStatus: () => goalRunner.status(),
      // 跨源统一采集库健康（2026-10-10）：窗口条数 / 各 stream 计数 / 实体索引规模
      sourceStats: () => sourceStore.stats(),
      // 票务邮件规则漏检埋点（2026-10-11）：预筛命中却零产出 → 计数 + 最近样本。
      // 这是"要不要换 LLM 兜底"的决策数据面（当前 total 恒为 0 表示规则没漏）。
      mailTicketMissStats: () => mailScheduleBridge.missStats(),
      // 跨源实体检索（"提到三亚的所有来源"）——汇聚价值的查询面
      sourceFind: (entity, opts) =>
        sourceStore.findByEntity(entity, opts as Parameters<typeof sourceStore.findByEntity>[1]),
      // 节律采样链健康（睡眠/桌面/屏幕条件化传感器是否还在产出观察）
      rhythmHealth: () => rhythmEngine?.health() ?? null,
      // 邮件反应链测试注入（2026-10-01）：模拟邮件走真实 handleIncoming 链，
      // actorId 缺省取邮箱配置的归属用户（自动接入后=注册邮箱账号）
      mailTestInject: async (mail) =>
        mailWatchService.handleIncoming({
          actorId: mail.actorId ?? mailWatchService.status().actorId ?? primaryActor() ?? "local_user",
          from: mail.from,
          to: mailWatchService.status().user ?? "",
          subject: mail.subject,
          textSnippet: mail.text,
          date: new Date().toISOString(),
          uid: mail.uid,
          ...(mail.source ? { source: mail.source } : {}),
        }),
      // 设置页邮箱接入块：状态查询 + 授权码提交（即刻生效，持久化在客户端 config.env）
      mailWatchStatus: () => mailWatchService.status(),
      mailWatchApplyPass: (pass: string) => mailWatchService.applyPass(pass),
      // P3 自诊断（2026-10-01）：「主动性为什么没说话」按 actor 分层快照。
      // 缺省 actor 取最近活跃用户。全部读内存/落盘文件，零 LLM 零副作用。
      whySilent: (actorId?: string) => {
        const id = actorId ?? primaryActor() ?? "local_user";
        const nowMs = Date.now();
        const known = proactivityHub
          .exportActors()
          .find((a) => a.actorId === id);
        const board = worldBoard.getBoard(id);
        const events = readNdjsonTail(join(proactivityFabricPath, "events.ndjson"), 200).filter(
          (e) => (e as { actorId?: string }).actorId === id,
        );
        return {
          actorId: id,
          active判定: known
            ? {
                lastInteractionAt: known.lastInteractionAt,
                lastInteractionAtIso: new Date(known.lastInteractionAt).toISOString(),
                isActive7d: nowMs - known.lastInteractionAt < 7 * 24 * 60 * 60_000,
              }
            : { isActive7d: false, note: "不在 known-actors 表（从未对话/已被清板）" },
          boardCurrent: board?.current ?? null,
          presenceOnline: proactivityPresence.isOnline(id),
          recentEvents: events.slice(-5),
          eventCountAll: events.length,
          turnAsidePending: turnAsideQueue.pending(id).length,
          hint:
            events.length === 0
              ? "零事件：查信源（screen/presence/schedule 传感器是否 alive）与规则节流状态"
              : undefined,
        };
      },
      arbiterPreview: () => {
        const actorId = primaryActor() ?? "local_user";
        return {
          snapshot: arbiterV2.snapshot(actorId),
          preview: {
            interrupt: arbiterV2.previewDecision("interrupt", actorId),
            alert: arbiterV2.previewDecision("alert", actorId),
            normal: arbiterV2.previewDecision("normal", actorId),
          },
          parked: arbiterV2.parkedEntries(),
        };
      },
      goalStats: () => goalBoard.stats(),
      // 成本-产出面（2026-10-19）：哪类目标花得多、达成率高 → 反哺模板优先级
      goalCost: (actorId?: string) => buildGoalCostReport({ goalBoard, goalPlanner, actorId: actorId ?? null }),
      // 夜间内省（确定性）：闲置/显著度/partial 验收 → 需要开口的 finding
      goalIntrospect: (actorId: string) => goalIntrospector.actionable(actorId),
      // 在办事项统一视图（2026-10-19）：goal + 承诺只读合并，供前端「在办目标」面板
      goalView: (actorId: string) =>
        buildUnifiedGoalView({
          goalBoard,
          commitmentBoard,
          actorId,
          progressOf: (g) => goalPlanner.progressLine(g),
          // 共享发现层读点：该目标尚未开口的发现条数（与开口闸读同一份台账）
          pendingFindingsOf: (goalId: string) => discovery.findingsFor(goalId).length,
        }),
      calibration: () => costCalibrator.snapshot(),
      evaluatorProbes: () => mappingExecutor.probes(),
      observeOutcome: (outcome) => costCalibrator.observe(outcome),
      phraseStats: () => speechPolisher.stats(),
      callStats: () => proactiveCaller.stats(),
      testCall: (actorId) =>
        proactiveCaller.callAndReport({
          actorId,
          kind: "selftest_call",
          importance: "high",
          title: "呼叫链路自检",
          report: "这是呼叫链路自检：我能主动给你打电话、汇报情况，你也可以直接跟我说话。听得到吗？",
          context: "这是一次链路验证来电，用户可能会简单应答或直接挂断。",
        }),
      emitDeviceSignal: (input) => {
        // 每个物理设备 sensorId 一个推送型 feeder（重复注册自动覆盖），信号进
        // 统一内核：去重/落盘/面板计数与内置传感器完全同权
        let emit = deviceFeeders.get(input.sensorId);
        if (!emit) {
          emit = registerFeeder(sensorKernel, input.sensorId, "device");
          deviceFeeders.set(input.sensorId, emit);
        }
        const at = input.at ?? Date.now();
        emit({
          actorId: input.actorId,
          at,
          fingerprint: input.fingerprint ?? `device:${input.sensorId}:${input.kind}:${at}`,
          salience: input.salience ?? "low",
          payload: { kind: input.kind, ...(input.payload ?? {}) },
        });
        return { ok: true };
      },
      selftest: (fire) =>
        fabricSelftest({
          fire,
          pipeline: proactivePipeline,
          primaryActor,
          arbiterV2,
          sensorKernel,
          evaluatorProbes: () => mappingExecutor.probes(),
          calibration: () => costCalibrator.snapshot(),
          phraseStats: () => speechPolisher.stats(),
          callStats: () => proactiveCaller.stats(),
          goalStats: () => ({
            ready: goalBoard.readyTray().length,
            goals: goalBoard.readyTray().map((g) => ({ title: g.title, status: g.status })),
          }),
        }),
    },
    agentActivityStore,
    auditTrailService,
    inboxService,
    infoHubService,
    upstreamSearchService,
    worldService,
    a2aOutsourcingService,
    socialFeedService,
    agentRelayService,
    agentPairingService,
    aipService,
    agentAccountService,
    emailRegistrationService,
    emailOtpService,
    emailSmsService,
    betaWhitelistService,
    betaWaitlistService,
    betaInviteService,
    financeIngestService,
    computeQuotaService,
    agentMemorySyncService,
    weatherService,
    weatherPrefsService,
    locationCoordinator,
    virtualPhoneService,
    ttsService,
    voiceMessageService,
    imageGenerationService,
    fileProcessingService,
    desktopBridgeCoordinator,
    phoneBridgeCoordinator,
    wechatClawBindingService,
    wechatClawBridgeService,
    messageHubService,
    messagePlatformGateway,
    messageBridgeService,
    browserSessionService,
    friendService,
    friendMessageService,
    companionService,
    runtime,
    wsConnectionRegistry,
    lifeSignalHubService,
    marketSignalService,
    proactiveLifeRuntimeService,
    userPersonalizationService,
    webhookService,
    notesService,
    externalChat,
    // 服务接入热替换：PUT /api/service-config 保存后装入新 provider（见 service-config.ts）
    externalChatSwapper: (next) => externalChatHost.swap(next),
    moodInferenceService,
    devicePairingService,
    deviceRegistry,
    accessAuthService,
    approvalInboxService,
    attentionStore,
    reachRouter,
    // /agent/voice/transcribe 端点依赖（ASR 专用走 voiceCapabilityService）
    voiceCapabilityService,
    brainCenter,
    bodyCenter,
    reflexArc,
  });

  registerWebSocketRoute(app, {
    sessionService,
    realFundsWallet,
    worldService,
    auditService,
    wsConnectionRegistry,
    agentPairingService,
    aipService,
    worldPartitionWsRegistry,
    runtime,
    socialFeedService,
    computeQuotaService,
    agentMemorySyncService,
    unifiedIdempotencyService,
    desktopBridgeCoordinator,
    phoneBridgeCoordinator,
    sharedBrowserCoordinator,
    messageHubService,
    friendMessageService,
    locationCoordinator,
    locationIngest,
    virtualPhoneService,
    devicePairingService,
    userPersonalizationService,
    deviceRegistry,
    voiceCapabilityService,
    voiceMessageService,
    morningBriefingScheduler,
    eveningDigestScheduler,
    accessAuthService,
    phoneCallCoordinator,
    agentAccountService,
    actorModelBindings,
  });

  // MCP 工具异步加载，onReady 时已就绪：二次刷新目录（幂等）
  app.addHook("onReady", async () => {
    featureCatalog.build();
  });

  app.addHook("onClose", async () => {
    proactivePipeline.stop();
    proactivityHub.stop();
    interestWatcher.stop();
    shoppingCompareService.stop();
    consumptionLedgerListener.stop();
    subscriptionAuditService.stop();
    billManagementService.stop();
    eveningDigestScheduler.stop();
    transferWatchService.stop();
    // 推送 token 注册表兜底落盘（register/unregister 已写穿，此处防未来新写路径漏刷）
    proactivePushService.flush();
    // 任务面台账强制落盘（1s 防抖窗口内的变更不丢）
    getTaskHub().flushPersistence();
    // 主动性：规则状态与去重指纹强制落盘（马拉松计时/去重指纹）+ 状态板落盘
    mappingExecutor.stop();
    worldBoard.flush();
    sensorKernel.stop();
    // 女性关怀：停经期提醒调度 + 加密数据落盘
    periodCareService.stop();
    void periodCareService.flush();
    void safetyGuardService.flush();
    // 新增子系统：习惯闭环 / 到站监控 / 全双工语音
    habitLoopService.stop();
    arrivalMonitorService.stop();
    voiceDuplexService.stopAll();
    // 位置子系统：停围栏判定 + 关本地 SQLite（WAL 落盘）
    locationGeofenceService.close();
    locationHistoryService?.close();
    try {
      await moodInferenceService.flush();
      app.log.info("[MoodInference] 持久化已 flush");
    } catch (e) {
      app.log.warn(`[MoodInference] shutdown flush failed: ${e}`);
    }
  });

  // 阶段1 守卫：schema ↔ 执行器双向漂移检测（全部注册与注入完成后执行一次）。
  // 「有 schema 无执行器」= 模型调用必报未知工具；「有执行器无 schema」= 工具对
  // LLM 永久不可见。漂移以 warn 输出，不阻断启动（豁免表见 chat-tool-drift.ts）。
  try {
    warnOnChatToolDrift({
      schemas: getBuiltinAgentChatTools(),
      registeredToolNames: toolRegistry.list(),
    });
  } catch (driftError) {
    console.warn("[chat-tool-drift] 漂移检测自身异常（忽略，不影响启动）:", driftError);
  }

  return {
    app,
    sessionService,
    scheduleTaskService,
    scheduleIntentService,
    infoHubService,
    realFundsWallet,
    auditService,
    toolRegistry,
    skillManager,
    skillMetadataValidator,
    agentRelayService,
    wsConnectionRegistry,
    agentPairingService,
    aipService,
    agentAccountService,
    emailRegistrationService,
    agentCore,
    runtime,
    worldService,
  a2aOutsourcingService,
  socialFeedService,
    computeQuotaService,
    agentMemorySyncService,
    unifiedIdempotencyService,
    weatherService,
    weatherPrefsService,
    ttsService,
    voiceCapabilityService,
    voiceMessageService,
    imageGenerationService,
    fileProcessingService,
    emailSmsService,
    emailOtpService,
    mediaMusicService,
    healthFitnessService,
    financeDeepService,
    billManagementService,
    socialOutreachService,
    codeSandboxService,
    virtualPhoneService,
    friendService,
    messageHubService,
    messagePlatformGateway,
    messageBridgeService,
    voiceDialogueService,
    habitLoopService,
    arrivalMonitorService,
    voiceDuplexService,
    bookingOrderStore,
    featureCatalog,
    intelligentReminderService: intelligentReminder.reminderService,
    reminderResponsePersistence: intelligentReminder.userResponsePersistence,
    mcpClientService,
    lifeSignalHubService,
    marketSignalService,
    proactiveLifeRuntimeService,
    hookBus,
    webhookService,
    notesService,
    externalChat,
    moodInferenceService,
    morningBriefingScheduler,
    transferWatchService,
    deviceRegistry,
    devicePairingService,
    accessAuthService,
    approvalInboxService,
    attentionStore,
    reachRouter,
    brainCenter,
    bodyCenter,
    reflexArc,
  };
}
