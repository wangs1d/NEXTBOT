import { getDataDir } from "../../config/data-dir.js";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";

import { registerAccountRoutes, isEmailOtpEnforced } from "./accounts.js";
import { registerAccountWebRoutes } from "./accounts-web.js";
import { registerFinanceIngestRoutes } from "./finance-ingest.js";
import { registerIngestRoutes } from "./ingest.js";
import { registerAgentCollaborationRoutes } from "./agent.js";
import { registerBodyRoutes } from "./body.js";
import { registerBrainRoutes } from "./brain.js";
import { registerCatalogRoutes } from "./catalog.js";
import { registerChatRoutes } from "./chat.js";
import { registerClientManifestRoutes } from "./client-manifest.js";
import { registerClientTelemetryRoutes } from "./client-telemetry.js";
import { registerInternalManifestEventRoutes } from "./internal-manifest-events.js";
import { registerModelProviderRoutes } from "./model-providers.js";
import { registerServiceConfigRoutes } from "./service-config.js";
import { registerFriendRoutes } from "./friends.js";
import { registerInfoRoutes } from "./info.js";
import { registerUnifiedProtocolRoutes } from "./protocol-unified.js";
import { registerSystemRoutes } from "./system.js";
import { registerScheduleRoutes } from "./schedule.js";
import { registerWalletRoutes } from "./wallet.js";
import { registerWeatherRoutes } from "./weather.js";
import { registerGeoRoutes } from "./geo.js";
import { registerPhoneRoutes } from "./phone.js";
import { registerCompanionRoutes } from "./companion.js";
import {
  registerWorldFreeMarketRoutes,
  registerWorldRoutes,
  registerWorldSocialRoutes,
} from "@nextbot/agent-world";
import { registerChatWeb } from "./chat-web.js";
import { isAgentWorldSocialEnabled, isOssEdition } from "../../config/env.js";
import { registerMultiAgentMonitorRoutes } from "./multi-agent-monitor.js";
import { registerNightlyMemoryRoutes } from "./nightly-memory.js";
import { registerWechatClawRoutes } from "./wechat-claw.js";
import { registerMessageHubRoutes } from "./messages.js";
import { registerMessageBridgeRoutes } from "./message-bridge.js";
import { registerChatDataRoutes } from "./chat-data.js";
import { registerBrowserSessionRoutes } from "./browser-sessions.js";
import { registerPhoneBridgeRoutes } from "./phone-bridge.js";
import { registerPhoneBridgeCaptureRoutes } from "./phone-bridge-captures.js";
import { registerDownloadRoutes } from "./downloads.js";
import { registerLifeSignalRoutes } from "./life-signals.js";
import { registerMoodInferenceRoutes } from "./mood-inferences.js";
import { registerMarketSignalRoutes } from "./market-signals.js";
import { registerMorningBriefingRoutes } from "./morning-briefing.js";
import { registerBriefingDeliveryRoutes } from "./briefing-delivery.js";
import { registerPresenceDetectRoutes } from "./presence-detect.js";
import { registerProactivitySuppressionRoutes } from "./proactivity-suppression.js";
import { registerProactivityPipelineRoutes, registerAutonomyRoutes } from "./proactivity.js";
import { registerCapabilityReadinessRoutes } from "./capability-readiness.js";
import { registerChatSuggestionRoutes } from "./chat-suggestions.js";
import { registerMemoryCrudRoutes } from "./memory-crud.js";
import { registerProfileManageRoutes } from "./profile-manage.js";
import { registerHealthRhythmRoutes } from "./health-rhythm.js";
import { registerUserAvatarRoutes } from "./user-avatar.js";
import { registerPaymentGuardrailRoutes } from "./payment-guardrails.js";
import { registerBriefingTestRoutes, registerEveningDigestTestRoutes } from "./briefing-test.js";
import { registerBriefingTtsRoutes } from "./briefing-tts.js";
import { registerVoiceRealtimeRoutes } from "./voice-realtime.js";
import { registerVoiceprintRoutes } from "./voiceprint.js";
import { registerUserPreferencesRoutes } from "./user-preferences.js";
import { registerFeedbackRoutes } from "./feedback.js";
import { registerAdminAuthRoutes } from "./admin-session-auth.js";
import { installAdminConsoleLoopbackGate } from "./admin-console-gate.js";
import { registerAdminConsoleRoutes } from "./admin-console.js";
import { registerAdminInboxRoutes } from "./admin-inbox.js";
import { registerSearchProxyRoutes } from "./search-proxy.js";
import { registerToolSearchAdminRoutes } from "./tool-search-admin.js";
import { registerGatewayAdminRoutes } from "./gateway-admin.js";
import { registerToolRegistryRoutes } from "./tool-registry-routes.js";
import { registerNotesRoutes } from "./notes.js";
import { registerDeviceRoutes } from "./device.js";
import { registerAuthRoutes } from "./auth.js";
import { registerApprovalRoutes } from "./approvals.js";
import { registerInboxRoutes } from "./inbox.js";
import { registerAttentionRoutes } from "./attention.js";
import { registerVoiceMessageRoutes } from "./voice-messages.js";
import { registerImageFileRoutes } from "./image-files.js";
import { registerPictureRoutes } from "./picture.js";
import { registerGalleryWallRoutes } from "./gallery-wall.js";
import { registerVideoProxyRoutes } from "./video-files.js";
import { registerMediaStreamProxyRoutes } from "./media.js";
import { registerUserFileRoutes } from "./user-files.js";
import { registerTravelMediaRoutes } from "./travel-media.js";
import { registerAgentActivityRoutes } from "./agent-activities.js";
import { registerAgentHomepageRoutes } from "./agent-homepage.js";
import { registerTravelPlanRoutes } from "./travel-plan.js";
import { registerTravelPlanSessionRoutes } from "../../skills/travel-planning/travel-plan-session.js";
import { registerTravelMapRoutes, registerPoiDetailsRoute } from "./travel-map.js";
import { registerShoppingDecisionRoutes } from "./shopping-decision.js";
import { registerTravelDataRoutes } from "./travel-data.js";
import { registerExitGateMetricsRoutes } from "./exit-gate-metrics.js";
import { registerRecommendationRoutes } from "../../recommendation/http.js";
import { registerWebhookRoutes } from "../../services/webhook/webhook-routes.js";
import type { HttpRouteDeps } from "./types.js";

export type { HttpRouteDeps } from "./types.js";

/**
 * 按子域注册 HTTP 路由：系统、聊天（主域）、钱包、世界、Agent 协作、账号。
 */
export function registerHttpRoutes(app: FastifyInstance, deps: HttpRouteDeps): void {
  // 管理后台回环门禁必须最先安装：onRequest hook 只对之后注册的路由生效。
  // /admin 页面与全部 /api/admin/* 默认仅本机（SSH 隧道）可达，公网一律 404。
  installAdminConsoleLoopbackGate(app);
  const worldRouteDeps = deps as unknown as Parameters<typeof registerWorldRoutes>[1];

  registerSystemRoutes(app, deps);
  // 客户端版本清单（自包含，无 deps）：桌面客户端启动检查 + 后期 runtime 收回总开关
  registerClientManifestRoutes(app);
  // 安装包运行埋点（自包含，无 deps）：客户端启动上报 + 管理端 runtime 收回决策台账
  registerClientTelemetryRoutes(app);
  // 清单变化 SSE 事件流（自包含；MANIFEST_EVENT_TOKEN 未配置时 403 禁用）：
  // 更新控制面机器（ECS）上启用，下游（云端网关/本地 runtime）订阅后秒级广播
  registerInternalManifestEventRoutes(app);
  // 模型接入目录（自包含，无 deps）：向导/设置页目录式选模型，base URL 服务端统一下发
  registerModelProviderRoutes(app);
  // 服务接入（内测 byok）：用户自配模型/TTS/邮箱授权码（GET/PUT /api/service-config + tts-test）
  registerServiceConfigRoutes(app, {
    ttsService: deps.ttsService,
    externalChatSwapper: deps.externalChatSwapper,
    mailWatchApplyPass: deps.proactivityFabric?.mailWatchApplyPass,
  });
  registerUnifiedProtocolRoutes(app, deps);
  registerInfoRoutes(app, deps);
  registerScheduleRoutes(app, deps);
  registerWeatherRoutes(app, deps);
  registerGeoRoutes(app);
  // 版本闸（NEXTBOT_EDITION=oss 开源版剔除）：旅游全家桶（媒体/行程/地图）+ 虚拟电话
  if (!isOssEdition()) {
    registerTravelMediaRoutes(app, deps);
    // 行程路由域（编辑/搜索/预订/分享；travelPlanningService 未装配时端点返回 503）
    registerTravelPlanRoutes(app, deps);
    // 规划会话路由域（v3 旅游界面 Agent 驱动规划流：卡片事件 + 真实生成）
    registerTravelPlanSessionRoutes(app, deps);
    // 行程规划浏览器页面（行程卡 → 系统浏览器打开；见 travel-map.ts）
    registerTravelMapRoutes(app);
    // POI 补图主源接 search image 端口（upstreamSearchService，与规划配图同底座）；
    // 未装配时端点内自动回落必应直抓。
    registerPoiDetailsRoute(app, {
      searchImages: async (query, limit) => {
        const res = await deps.upstreamSearchService.searchImages(query, limit ?? 4, "shared-travel-img");
        return res.items.map((it) => it.mediaUrl).filter((u): u is string => Boolean(u));
      },
    });
    // 旅行数据维护（快照 + 主动刷新：存量图片本地化 / 按目的地补图）
    registerTravelDataRoutes(app);
    // 出口闸触发率看板（L4 运营闭环：持续高触发 ⇒ 改描述不加闸）
    registerExitGateMetricsRoutes(app);
    registerPhoneRoutes(app, deps);
  }
  registerCompanionRoutes(app, deps);
  registerChatRoutes(app, deps);
  registerWalletRoutes(app, deps);
  // 商品决策页（比价卡 → 决策页；自包含页面 + 内存载荷，模式同 travel-map）
  registerShoppingDecisionRoutes(app, {
    shoppingCompareService: deps.shoppingCompareService,
  });
  registerWorldRoutes(app, worldRouteDeps);
  // Agent World 社交经济域开关（AGENT_WORLD_SOCIAL_ENABLED，实验性子系统默认关闭）：
  // 关闭时跳过社交经济域路由 mount（自由市场/技能商店/A2A 外包/社交动态），
  // 仅保留 world.ts 的 identity/注册/房间路由；开启后行为与现状一致。
  if (isAgentWorldSocialEnabled()) {
    registerWorldFreeMarketRoutes(app, worldRouteDeps);
    registerWorldSocialRoutes(app, worldRouteDeps);
  }
  registerChatWeb(app);
  registerAgentCollaborationRoutes(app, deps);
  registerAccountRoutes(app, deps);
  // 网页登录页按 OTP 闸状态渲染验证码步骤（SMTP 凭据齐备即自动收紧）
  registerAccountWebRoutes(app, { otpEnabled: isEmailOtpEnforced(deps) });
  registerFinanceIngestRoutes(app, deps);
  // 数据入口：用户自助上传（截图/表格/ics/文本）→ 抽取草稿 → 确认入库。
  // 与财务入站同构：未装配服务时端点 503，不影响其他路由。
  registerIngestRoutes(app, deps);
  // 好友社交（world.link.* 工具族的 HTTP 面；开源版剔除）
  if (!isOssEdition()) {
    registerFriendRoutes(app, deps);
  }
  registerVoiceMessageRoutes(app, {
    voiceMessageService: deps.voiceMessageService,
  });
  registerImageFileRoutes(app, { imageGenerationService: deps.imageGenerationService });
  registerPictureRoutes(app, { pictureKit: deps.pictureKit });
  // 3D 照片墙（自包含页面 + 贴墙布局 + 视觉分析触发；见 gallery-wall.ts）
  registerGalleryWallRoutes(app, { pictureKit: deps.pictureKit });
  registerVideoProxyRoutes(app);
  registerMediaStreamProxyRoutes(app);
  registerUserFileRoutes(app, { fileProcessingService: deps.fileProcessingService });
  registerWechatClawRoutes(app, deps);
  registerMessageBridgeRoutes(app, { messageBridgeService: deps.messageBridgeService });
  registerMessageHubRoutes(app, {
    messageHubService: deps.messageHubService,
    messagePlatformGateway: deps.messagePlatformGateway,
    runtime: deps.runtime!,
  });
  registerChatDataRoutes(app, {
    externalChat: deps.externalChat ?? null,
    agentMemorySyncService: deps.agentMemorySyncService,
  });
  registerBrowserSessionRoutes(app, deps);
  // 手机桥接（拨真实手机/短信/定位捕捉；内测独占，开源版剔除）
  if (!isOssEdition()) {
    registerPhoneBridgeRoutes(app, { phoneBridgeCoordinator: deps.phoneBridgeCoordinator });
    registerPhoneBridgeCaptureRoutes(app);
  }
  registerMultiAgentMonitorRoutes(app, {
    runtime: deps.runtime,
    scheduleTaskService: deps.scheduleTaskService,
  });
  registerNightlyMemoryRoutes(app);
  registerDownloadRoutes(app);
  registerToolSearchAdminRoutes(app);
  registerGatewayAdminRoutes(app);
  registerToolRegistryRoutes(app);
  registerLifeSignalRoutes(app, deps);
  if (deps.moodInferenceService) {
    registerMoodInferenceRoutes(app, { moodInferenceService: deps.moodInferenceService });
  }
  registerMarketSignalRoutes(app, deps);
  if (deps.notesService) {
    registerNotesRoutes(app, {
      notesService: deps.notesService,
      scheduleTaskService: deps.scheduleTaskService,
      externalChat: deps.externalChat ?? null,
    });
  }
  if (deps.webhookService && deps.hookBus) {
    registerWebhookRoutes(app, deps.webhookService, deps.hookBus);
  }
  // 简报天气定位兜底：客户端 GPS（比 IP 准）——实时定位优先，离线回退缓存
  const briefingClientLocation = deps.locationCoordinator
    ? async (
        sessionId: string,
      ): Promise<
        | { latitude: number; longitude: number; label?: string; city?: string; timezone?: string }
        | null
      > => {
        const coordinator = deps.locationCoordinator!;
        const live = await coordinator.requestLocation(
          sessionId,
          "morning-briefing:weather",
        );
        if (live) return live;
        return coordinator.getCachedWithTime(sessionId)?.payload ?? null;
      }
    : undefined;
  // 播报稿口语润色（单次小 LLM 调用，ephemeral 不污染会话）：启动简报路由与
  // 手动预览共用同一份，保证与调度推送路径口径一致；LLM 未启用时服务内回退模板
  const briefingLlmComplete = deps.externalChat?.isEnabled()
    ? async (prompt: string) => {
        let full = "";
        await deps.externalChat!.streamCompletion(
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
    : undefined;
  registerMorningBriefingRoutes(app, {
    weatherService: deps.weatherService,
    weatherPrefsService: deps.weatherPrefsService,
    scheduleTaskService: deps.scheduleTaskService,
    notesService: deps.notesService,
    // 用户称呼第一事实源：结构化事实库「称呼」字段（与首启向导/聊天面同源；
    // 绝不回退账号 displayName——那是 agent 的网络名，方向会反）
    factStore: deps.factStore,
    // 兜底：记忆同步 KV 的 user_profile「称呼」行
    agentMemorySyncService: deps.agentMemorySyncService,
    requestClientLocation: briefingClientLocation,
    llmComplete: briefingLlmComplete,
  });
  registerBriefingDeliveryRoutes(app);
  if (deps.proactivitySuppressionStore) {
    registerProactivitySuppressionRoutes(app, {
      suppressionStore: deps.proactivitySuppressionStore,
    });
  }
  registerProactivityPipelineRoutes(app, {
    pipeline: deps.proactivePipeline ?? null,
    pushService: deps.proactivePushService ?? null,
    fabric: deps.proactivityFabric ?? null,
    suppressionStore: deps.proactivitySuppressionStore ?? null,
  });
  registerAutonomyRoutes(app, {
    autonomySettings: deps.autonomySettings ?? null,
  });
  // 能力就绪状态（渐进式解锁卡片）+ 记忆管理 + 支付护栏/回执（自包含，无 deps）
  registerCapabilityReadinessRoutes(app);
  // 聊天推荐项（「为你推荐」，联查能力就绪状态后抽样）
  registerChatSuggestionRoutes(app);
  registerMemoryCrudRoutes(app);
  registerProfileManageRoutes(app);
  // 健康节奏（自包含，无 deps）：灵动岛久坐/喝水提醒的按身份档位下发
  registerHealthRhythmRoutes(app);
  // 用户头像（自包含，无 deps）：上传/查询/静态拉流
  registerUserAvatarRoutes(app);
  // 声纹注册/验证（首启向导 + 语音对话说话人闸；引擎本地 ONNX，缺失时优雅降级）
  registerVoiceprintRoutes(app);
  registerPaymentGuardrailRoutes(app);
  registerAgentActivityRoutes(app, { activityStore: deps.agentActivityStore, auditTrailService: deps.auditTrailService });
  registerBriefingTestRoutes(app, {
    wsConnectionRegistry: deps.wsConnectionRegistry,
    agentMemorySyncService: deps.agentMemorySyncService,
    // 手动预览与调度路径同源：天气/日程/笔记依赖必须齐，否则预览永远全空
    weatherService: deps.weatherService,
    weatherPrefsService: deps.weatherPrefsService,
    scheduleTaskService: deps.scheduleTaskService,
    notesService: deps.notesService,
    requestClientLocation: briefingClientLocation,
    llmComplete: briefingLlmComplete,
  });
  // 明日速览手动触发：与到点自动推送同实例、同 WS 事件，用于验证卡片渲染与文案口径
  registerEveningDigestTestRoutes(app, {
    wsConnectionRegistry: deps.wsConnectionRegistry,
    eveningDigestService: deps.eveningDigestService,
  });
  // agent pulse 手动触发（Muse 式聚合评审）：返回聚合/prompt/LLM 原始输出/最终
  // 文案/是否提交的完整留痕，用于验证触发链路与内容口径——走的就是服务本体
  // check()，闸门语义与定时路径完全一致
  if (deps.agentPulseCheck) {
    app.post("/api/test/trigger-agent-pulse", async (request) => {
      const body = (request.body ?? {}) as {
        force?: boolean;
        fixture?: {
          tasks?: string[];
          unread?: string[];
          goals?: string[];
          interests?: string[];
          goalLine?: string;
          findings?: string[];
          presence?: string;
          screenFocus?: string;
          recentTurns?: string[];
        };
      };
      try {
        const result = await deps.agentPulseCheck!({ force: body.force === true, fixture: body.fixture });
        return { ok: true, result };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    });
  }
  registerBriefingTtsRoutes(app, { ttsService: deps.ttsService });
  // MiniMax 端到端实时语音对话探针（text 或 PCM 音频进 → 24kHz wav 语音+转录出）
  registerVoiceRealtimeRoutes(app);
  registerPresenceDetectRoutes(app);
  registerUserPreferencesRoutes(app);
  registerAgentHomepageRoutes(app, {
    agentActivityStore: deps.agentActivityStore,
    agentMemorySyncService: deps.agentMemorySyncService,
    socialFeedService: deps.socialFeedService,
    agentAccountService: deps.agentAccountService,
    goalBoard: deps.goalBoard ?? null,
  });
  registerFeedbackRoutes(app, { inboxService: deps.inboxService ?? null });
  // 管理后台账号密码登录 + 可吊销会话（status/setup/login/logout；requireAdmin 已升级双通道）
  registerAdminAuthRoutes(app);
  registerAdminConsoleRoutes(app, deps);
  // 云端搜索代理（ECS 专用：env 闸控，未启用不挂载；安装包用户搜索走这里）
  registerSearchProxyRoutes(app);
  // 管理后台「消息发送」：收件人解析（全体/指定/分组）+ 发送台账（requireAdmin）
  registerAdminInboxRoutes(app, deps);
  if (deps.devicePairingService && deps.deviceRegistry) {
    registerDeviceRoutes(app, {
      devicePairingService: deps.devicePairingService,
      deviceRegistry: deps.deviceRegistry,
    });
  }
  // 设备自绑定鉴权路由（accessAuthService 未注入时不挂载）
  if (deps.accessAuthService) {
    registerAuthRoutes(app, { accessAuthService: deps.accessAuthService });
  }
  // 待确认收件箱路由（approvalInboxService 未注入时不挂载）
  if (deps.approvalInboxService) {
    registerApprovalRoutes(app, { approvalInboxService: deps.approvalInboxService });
  }
  // 站内信路由（inboxService 未注入时不挂载）
  if (deps.inboxService) {
    registerInboxRoutes(app, { inboxService: deps.inboxService });
  }
  // 分级触达注意力路由（attentionStore + reachRouter 未注入时不挂载）
  if (deps.attentionStore && deps.reachRouter) {
    registerAttentionRoutes(app, {
      attentionStore: deps.attentionStore,
      reachRouter: deps.reachRouter,
      activityStore: deps.agentActivityStore ?? null,
    });
  }
  // Brain Center 路由（brainCenter 为 null 时端点返回 503 not enabled）
  registerBrainRoutes(app, deps);
  // Body Center 路由（bodyCenter 为 null 时端点返回 503 not enabled）
  registerBodyRoutes(app, deps);
  // 购物建议能力（runtime 内置；商品图/商品库只读端点，推荐卡走 shopping.suggest 工具卡）
  registerRecommendationRoutes(app, {
    catalog: deps.recommendationCatalog ?? null,
    mediaDir: join(getDataDir(), "recommendation", "media"),
  });
  // Feature Catalog 能力分类路由（featureCatalog 为 null 时端点返回 503）
  registerCatalogRoutes(app, deps);
}
