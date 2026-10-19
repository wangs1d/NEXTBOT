import type { FastifyInstance } from "fastify";

import type { AipService } from "../aip/aip-service.js";
import {
  ClientEventType,
  ServerEventType,
  type EventEnvelope,
  type WalletAction,
} from "../protocol.js";
import { parseClientLocation } from "../types/client-location.js";
import type { RuntimeFacade } from "../runtime/runtime-facade.js";
import type { AuditService } from "../services/audit-service.js";
import type { SessionService } from "../services/session-service.js";
import type { RealFundsWalletService } from "../services/real-funds-wallet-service.js";
import type { AgentPairingService } from "../services/agent-pairing-service.js";
import type { FriendMessageService } from "../services/friend-message-service.js";
import type { WsConnectionRegistry } from "../services/ws-connection-registry.js";
import { normalizeDeviceClass } from "../services/ws-connection-registry.js";
import { declareClientCapabilities } from "../services/client-capability-registry.js";
import type { VirtualPhoneService } from "../services/virtual-phone-service.js";
import type { UserPersonalizationService } from "../services/user-personalization/user-personalization-service.js";
import type { VoiceCapabilityService } from "../services/voice-capability-service.js";
import type { VoiceMessageService } from "../services/voice-message-service.js";
import { createExternalChatProviderFromEnv } from "../external-model/resolve-provider.js";
import { resolvePrimaryChatSessionId } from "../agent/master-chat-session.js";
import { getAgentRuntimeConfig } from "../agent/agent-runtime-config.js";
import { setVoiceMode } from "../proactivity/voice-mode-state.js";
import {
  handleAgentEmbodimentInteractEvent,
} from "./handlers/agent-embodiment-interact.js";
import {
  handleChatAgentProcessingUiEvent,
  handleChatUserMessageEvent,
  messageBatchProcessor,
} from "./handlers/chat-user-message.js";
import { handleAgentEmbodimentStateEvent } from "./handlers/agent-embodiment-state.js";
import { getEmbodimentAutonomy } from "../services/embodiment-autonomy-service.js";
import { getTaskOutbox } from "../task-plane/task-outbox.js";
import { getTaskHub } from "../task-plane/task-hub.js";
import {
  buildTaskUpdateEnvelope,
  isTaskPlaneWsEventsEnabled,
} from "../task-plane/task-events.js";
import type { DesktopBridgeCoordinator } from "../services/desktop-bridge-coordinator.js";
import type { PhoneBridgeCoordinator, PhoneBridgeResult } from "../services/phone-bridge-coordinator.js";
import type { PhoneCallCoordinator } from "../services/phone-call-coordinator.js";
import type {
  SharedBrowserCoordinator,
  SharedBrowserResult,
} from "../services/shared-browser-coordinator.js";
import type { MessageHubPlatform, MessageHubService } from "../services/message-hub-service.js";
import type { LocationCoordinator } from "../services/location-coordinator.js";
import type { LocationIngestPipeline } from "../services/location-ingest-pipeline.js";
import {
  AgentWorldClientEventType,
  AgentWorldServerEventType,
  UNIFIED_LAYER_MANIFEST,
  UNIFIED_PROTOCOL_VERSION,
  UnifiedClientEventType,
  UnifiedServerEventType,
  allowWorldHttpMutations,
  canViewWorldPartition,
  resolveUnifiedMemoryActorId,
  type SocialFeedService,
  type WorldPartitionWsRegistry,
  type WorldService,
  worldPartitionAttachSchema,
  worldPartitionDetachSchema,
  worldSocialCommentPayloadSchema,
  worldSocialLikePayloadSchema,
  worldSocialPostDeletePayloadSchema,
  worldSocialPostPayloadSchema,
  worldSocialReportPayloadSchema,
  unifiedCapabilitiesClientSchema,
  unifiedGovernanceProbeSchema,
  unifiedHumanDirectiveSchema,
  unifiedMemoryGetSchema,
  unifiedMemoryPatchSchema,
  unifiedQuotaAdjustSchema,
} from "@private-ai-agent/agent-world";
import { isAgentWorldSocialEnabled, isAccessAuthRequired } from "../config/env.js";
import { UnifiedErrorCode } from "../protocol-unified-errors.js";
import type { AgentMemorySyncService } from "../services/agent-memory-sync-service.js";
import { clearAllMemoryForActor } from "../services/memory-clear-service.js";
import { getMemoryConsolidationService } from "../services/memory-consolidation-service.js";
import type { ComputeQuotaService } from "../services/compute-quota-service.js";
import type { UnifiedIdempotencyService } from "../services/unified-idempotency-service.js";
import { aipDispatchWsSchema, walletRequestSchema } from "../schemas/api.js";
import {
  handleDeviceWsClose,
  handleDeviceWsEvent,
  isDeviceEvent,
  type DeviceWsHandlerDeps,
} from "../device-bus/ws-device-handler.js";
import type { DeviceRegistry } from "../device-bus/device-registry.js";
import type { DevicePairingService } from "../services/device-pairing-service.js";
import { AccessAuthService } from "../services/access-auth-service.js";
import type { MorningBriefingScheduler } from "../services/morning-briefing-scheduler.js";
import type { EveningDigestScheduler } from "../services/evening-digest-scheduler.js";
import { getUserPreferences } from "../routes/http/user-preferences.js";
import { getTaskPlanStore, taskPlanKey } from "../agent/task-plan-store.js";

type SocketWithHeartbeat = {
  send(data: string): void;
  close(code?: number, data?: string): void;
  ping?(data?: Buffer, mask?: boolean, cb?: (err?: Error) => void): void;
  on(event: string, listener: (...args: any[]) => void): void;
  readyState?: number;
  isAlive?: boolean;
};

const WS_READY_STATE_OPEN = 1;
const WS_HEARTBEAT_INTERVAL_MS = 25_000;
const WS_HEARTBEAT_GRACE_MS = 10_000;

function safeSocketSend(socket: SocketWithHeartbeat, data: string): boolean {
  const open = socket.readyState === undefined || socket.readyState === WS_READY_STATE_OPEN;
  if (!open) return false;
  try {
    socket.send(data);
    return true;
  } catch {
    try {
      socket.close(1011, "send_failed");
    } catch {
      // Ignore close failures on broken sockets.
    }
    return false;
  }
}

/**
 * 从Fastify请求中获取客户端IP地址
 */
function getClientIp(request: any): string | undefined {
  // 首先检查x-forwarded-for头（代理服务器设置）
  const forwardedFor = request.headers?.["x-forwarded-for"];
  if (forwardedFor) {
    // x-forwarded-for可能包含多个IP，取第一个
    const ips = forwardedFor.split(",");
    return ips[0]?.trim();
  }
  
  // 检查x-real-ip头
  const realIp = request.headers?.["x-real-ip"];
  if (realIp) {
    return realIp.trim();
  }
  
  // 最后使用socket.remoteAddress
  return request.socket?.remoteAddress;
}

function parsePhoneDeviceInfo(payload: Record<string, unknown>): Record<string, unknown> {
  const deviceInfo: Record<string, unknown> = {};
  const keys = [
    "model",
    "manufacturer",
    "brand",
    "androidVersion",
    "sdkInt",
    "isHuawei",
    "isHarmonyOS",
    "systemVersion",
    "batteryLevel",
    // 通知使用权授权状态（注册时客户端上报）：capture_status 工具读它决定
    // 是否引导 LLM 发 permission_request 授权卡
    "notificationListenerEnabled",
  ];
  for (const key of keys) {
    if (payload[key] !== undefined) {
      deviceInfo[key] = payload[key];
    }
  }
  return deviceInfo;
}

export type WsRouteDeps = {
  sessionService: SessionService;
  realFundsWallet: RealFundsWalletService;
  worldService: WorldService;
  auditService: AuditService;
  wsConnectionRegistry: WsConnectionRegistry;
  agentPairingService: AgentPairingService;
  aipService: AipService;
  worldPartitionWsRegistry: WorldPartitionWsRegistry;
  runtime: RuntimeFacade;
  socialFeedService: SocialFeedService;
  computeQuotaService: ComputeQuotaService;
  agentMemorySyncService: AgentMemorySyncService;
  unifiedIdempotencyService: UnifiedIdempotencyService;
  desktopBridgeCoordinator: DesktopBridgeCoordinator;
  phoneBridgeCoordinator: PhoneBridgeCoordinator;
  /** 共用浏览器桥：用户与 Agent 共用客户端内嵌浏览器的动作转发通道 */
  sharedBrowserCoordinator: SharedBrowserCoordinator;
  /** 消息聚合中心：手机桥接 phone.msg.report 批量落库用；null=未装配 */
  messageHubService?: MessageHubService | null;
  /** 站内好友消息投递内核：session.init 时补投未读好友消息（可选） */
  friendMessageService?: FriendMessageService | null;
  /** 按需位置协调器：Agent 需要位置时向客户端请求实时 GPS */
  locationCoordinator: LocationCoordinator;
  /** 位置上报管线（方案 A-D）：历史落库 / 围栏判定 / 到达触发；null=未装配 */
  locationIngest?: LocationIngestPipeline | null;
  virtualPhoneService: VirtualPhoneService;
  userPersonalizationService: UserPersonalizationService;
  deviceRegistry: DeviceRegistry;
  devicePairingService: DevicePairingService;
  /** Agent 底层语音能力中枢（用于 chat.user_message 的 ASR 链路） */
  voiceCapabilityService?: VoiceCapabilityService;
  /** 语音消息落盘服务（用于解析 audio 消息的本地文件路径） */
  voiceMessageService?: VoiceMessageService;
  /** 早间简报调度器：WS 连接建立时 subscribe，断开时 unsubscribe */
  morningBriefingScheduler?: MorningBriefingScheduler;
  /** 晚间 digest 调度器（Task 15 生活节律）：WS 连接建立时 subscribe，断开时 unsubscribe */
  eveningDigestScheduler?: EveningDigestScheduler;
  /** 设备自绑定鉴权服务（ACCESS_AUTH_REQUIRED=1 时 session.init 须持有效 token） */
  accessAuthService?: AccessAuthService;
  /**
   * 电话代办协调器（可选）：在 chat.user_action 入口消费确认卡点击，
   * 作为 phone_call.start 确认门的权威证据源（LLM 无法伪造）。
   */
  phoneCallCoordinator?: PhoneCallCoordinator;
  /** 账号服务（可选）：session.init 记录最近活跃（管理后台「最近活跃」指标） */
  agentAccountService?: { touchLastActive(actorId: string): void } | null;
};

export function registerWebSocketRoute(app: FastifyInstance, deps: WsRouteDeps): void {
  const {
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
    userPersonalizationService,
    deviceRegistry,
    devicePairingService,
    voiceCapabilityService,
    voiceMessageService,
    morningBriefingScheduler,
    eveningDigestScheduler,
    accessAuthService,
    phoneCallCoordinator,
    agentAccountService,
  } = deps;

  // device-bus 处理器依赖（device.* 事件路由）
  const deviceHandlerDeps: DeviceWsHandlerDeps = {
    deviceRegistry,
    auditService,
    phoneBridgeCoordinator,
    desktopBridgeCoordinator,
    devicePairingService,
    log: {
      info: (msg, ctx) => app.log.info(ctx ?? {}, `[DeviceBus] ${msg}`),
      warn: (msg, ctx) => app.log.warn(ctx ?? {}, `[DeviceBus] ${msg}`),
    },
  };

  const broadcastPartitionPresence = (partitionId: string): void => {
    const watcherSessionIds = worldPartitionWsRegistry.uniqueWatcherSessionIds(partitionId);
    worldPartitionWsRegistry.broadcastToPartition(
      partitionId,
      JSON.stringify({
        type: AgentWorldServerEventType.WorldPresenceUpdate,
        payload: { partitionId, watcherSessionIds },
      }),
    );
  };

  app.get(
    "/ws",
    { websocket: true },
    (socket, request) => {
      const ws = socket as SocketWithHeartbeat;
      let boundActorId: string | undefined;
      let initAsDesktopBridge = false;
      let initAsPhoneBridge = false;
      const clientIp = getClientIp(request);
      // ─── 设备自绑定鉴权（ACCESS_AUTH_REQUIRED=1 时）：upgrade query token 预检 ───
      // 有效 → 预钉身份（session.init 时强制覆盖 userId）；无效 → 立即拒连；
      // 缺失 → 放行连接，等 session.init payload.token 兜底校验。
      // desktopBridge / phoneBridge 通道走各自桥接 token 流程，不受此门影响。
      const accessAuthServiceImpl = accessAuthService;
      const accessAuthActive = isAccessAuthRequired() && accessAuthServiceImpl != null;
      let accessAuthUserId: string | undefined;
      if (accessAuthActive && accessAuthServiceImpl) {
        const upgradeToken = AccessAuthService.extractToken({
          authorization: request.headers.authorization,
          queryToken: (request.query as { token?: string } | undefined)?.token,
        });
        if (upgradeToken) {
          const verified = accessAuthServiceImpl.verifyToken(upgradeToken);
          if (!verified) {
            safeSocketSend(
              ws,
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: {
                  code: "AUTH_INVALID",
                  message: "访问 token 无效或已吊销（经 /api/auth/bind 获取）",
                },
              }),
            );
            try {
              ws.close(1008, "auth_invalid");
            } catch {
              // Ignore close failures on broken sockets.
            }
            return;
          }
          accessAuthUserId = verified.userId;
        }
      }
      ws.isAlive = true;
      let heartbeatMissedAt = 0;
      const heartbeatTimer = setInterval(() => {
        const open = ws.readyState === undefined || ws.readyState === WS_READY_STATE_OPEN;
        if (!open) return;
        if (ws.isAlive === false) {
          const overdue = Date.now() - heartbeatMissedAt;
          if (heartbeatMissedAt > 0 && overdue >= WS_HEARTBEAT_GRACE_MS) {
            app.log.warn(
              { actorId: boundActorId, clientIp },
              "WebSocket heartbeat timeout, closing stale connection",
            );
            try {
              ws.close(1001, "heartbeat_timeout");
            } catch {
              // Ignore close failures on stale sockets.
            }
          }
          return;
        }
        ws.isAlive = false;
        heartbeatMissedAt = Date.now();
        try {
          ws.ping?.();
        } catch {
          try {
            ws.close(1001, "heartbeat_ping_failed");
          } catch {
            // Ignore close failures on broken sockets.
          }
        }
      }, WS_HEARTBEAT_INTERVAL_MS);
      heartbeatTimer.unref?.();

      ws.on("pong", () => {
        ws.isAlive = true;
        heartbeatMissedAt = 0;
      });

      ws.on("error", (err) => {
        app.log.warn({ err, actorId: boundActorId, clientIp }, "WebSocket transport error");
      });

      ws.on("close", () => {
        clearInterval(heartbeatTimer);
        const detached = worldPartitionWsRegistry.detachSocket(socket);
        if (detached) {
          broadcastPartitionPresence(detached.partitionId);
        }
        desktopBridgeCoordinator.unbindIfSocket(socket);
        desktopBridgeCoordinator.cancelPendingForSocket(socket);
        locationCoordinator.unbindSocket(socket);
        if (boundActorId) {
          phoneBridgeCoordinator.unbindIfSocket(boundActorId, socket);
          sharedBrowserCoordinator.unbindIfSocket(boundActorId, socket);
        }
        phoneBridgeCoordinator.cancelPendingForSocket(socket);
        // 终端互连平台：清理该 socket 上绑定的设备
        void handleDeviceWsClose(socket, deviceHandlerDeps);
        if (boundActorId) {
            messageBatchProcessor.setClientProcessingUiActive(boundActorId, false);
            socialFeedService.unsubscribe(boundActorId);
            wsConnectionRegistry.unregister(boundActorId, socket);
            getEmbodimentAutonomy()?.unregisterSession(boundActorId);
            morningBriefingScheduler?.unsubscribe(boundActorId);
            eveningDigestScheduler?.unsubscribe(boundActorId);
            // 会话结束触发：立即整合该 actor 待处理记忆候选（不等 30s 防抖）。
            // fire-and-forget——含 LLM 抽取，不阻塞断开清理路径。
            void getMemoryConsolidationService()?.flushForActor(boundActorId);
            boundActorId = undefined;
          }
      });

      ws.on("message", async (raw: Buffer) => {
        ws.isAlive = true;
        heartbeatMissedAt = 0;
        const sendUnifiedError = (code: string, message: string, traceId?: string): void => {
          safeSocketSend(
            ws,
            JSON.stringify({
              type: ServerEventType.ErrorEvent,
              payload: { code, message, traceId },
            }),
          );
        };

        // 呼叫失败只回 error.event（客户端关外呼窗并 toast 提示原因），
        // 不再往聊天流落文字气泡：语音电话的内容不以文字方式进聊天记录。

        let event: EventEnvelope;
        try {
          event = JSON.parse(raw.toString()) as EventEnvelope;
        } catch {
          safeSocketSend(
            ws,
            JSON.stringify({
              type: ServerEventType.ErrorEvent,
              payload: { code: "BAD_JSON", message: "无法解析事件 JSON" },
            }),
          );
          return;
        }

        if (event.type === "ws.keepalive") {
          safeSocketSend(
            ws,
            JSON.stringify({
              type: "ws.keepalive_ack",
              payload: {
                ok: true,
                serverTime: new Date().toISOString(),
                sessionId: boundActorId,
              },
            }),
          );
          return;
        }

        // 设备活跃度刷新（提醒智能路由）：业务消息（非 keepalive）代表"人在这台设备上"，
        // 刷新该连接 lastActiveAt；后台挂机仅有心跳的连接不会被误判为用户所在端。
        if (boundActorId) {
          wsConnectionRegistry.touchActivity(boundActorId, ws);
        }

        // ========== 终端互连平台 device.* 事件路由 ==========
        // device.register 不需要 boundActorId（设备身份在 payload 内）；
        // 其余 device.* 事件依赖 socket 上已绑定的 deviceId（由 register 写入）。
        if (isDeviceEvent(event.type)) {
          await handleDeviceWsEvent(socket, event, deviceHandlerDeps);
          return;
        }

        if (event.type === ClientEventType.VirtualPhoneUserCall) {
          if (!boundActorId) {
            sendUnifiedError("SESSION_REQUIRED", "请先发送 session.init");
            return;
          }
          const callPl = event.payload as Record<string, unknown>;
          const toActorId = String(callPl.toActorId ?? "").trim();
          const userMessage = String(callPl.userMessage ?? callPl.message ?? "").trim();
          if (!toActorId) {
            sendUnifiedError("BAD_PHONE_CALL", "缺少 toActorId（目标Agent ID）");
            return;
          }
          const callResult = await virtualPhoneService.handleUserCallAgent({
            fromUserId: boundActorId,
            toActorId,
            userMessage: userMessage || undefined,
          });
          if (!callResult.ok) {
            sendUnifiedError("PHONE_CALL_FAILED", callResult.error ?? "呼叫失败");
            return;
          }
          socket.send(
            JSON.stringify({
              type: ServerEventType.VirtualPhoneCallStatus,
              payload: {
                ok: true,
                callId: callResult.callId,
                status: "ringing",
                toActorId,
                message: "正在呼叫 Agent，请稍候…",
              },
            }),
          );
          return;
        }

        if (event.type === ClientEventType.VirtualPhoneCallMyAgent) {
          if (!boundActorId) {
            sendUnifiedError("SESSION_REQUIRED", "请先发送 session.init");
            return;
          }
          const callPl = event.payload as Record<string, unknown>;
          const userMessage = String(callPl.userMessage ?? callPl.message ?? "").trim();
          const callResult = await virtualPhoneService.handleUserCallAgent({
            fromUserId: boundActorId,
            toActorId: boundActorId,
            userMessage: userMessage || undefined,
          });
          if (!callResult.ok) {
            sendUnifiedError("PHONE_CALL_FAILED", callResult.error ?? "呼叫失败");
            return;
          }
          socket.send(
            JSON.stringify({
              type: ServerEventType.VirtualPhoneCallStatus,
              payload: {
                ok: true,
                callId: callResult.callId,
                status: "ringing",
                toActorId: boundActorId,
                message: "正在呼叫你的 Agent…",
              },
            }),
          );
          return;
        }

        // phone.call_reply（通话中打字回复）已删除：通话对话由 duplex realtime
        // 语音引擎接管（麦克风语音进、语音回，callId 上下文注入），无打字通道。

        // 用户挂断当前通话
        if (event.type === ClientEventType.VirtualPhoneCallHangup) {
          if (!boundActorId) {
            sendUnifiedError("SESSION_REQUIRED", "请先发送 session.init");
            return;
          }
          const hangupPl = event.payload as Record<string, unknown>;
          const hangupCallId = String(hangupPl.callId ?? "").trim();
          if (!hangupCallId) {
            sendUnifiedError("BAD_PHONE_CALL", "缺少 callId");
            return;
          }
          const hangupResult = virtualPhoneService.endCall(hangupCallId, "user_hangup");
          if (!hangupResult.ok) {
            sendUnifiedError("PHONE_CALL_FAILED", hangupResult.error ?? "挂断失败");
            return;
          }
          socket.send(
            JSON.stringify({
              type: ServerEventType.VirtualPhoneCallStatus,
              payload: { ok: true, callId: hangupCallId, status: "ended", reason: "user_hangup" },
            }),
          );
          return;
        }

        if (event.type === ClientEventType.CompanionContactFeedback) {
          if (!boundActorId) {
            sendUnifiedError("SESSION_REQUIRED", "请先发送 session.init");
            return;
          }
          const pl = event.payload as Record<string, unknown>;
          const sessionId = String(pl.sessionId ?? boundActorId).trim() || boundActorId;
          if (sessionId !== boundActorId) {
            sendUnifiedError("FORBIDDEN", "sessionId 与当前连接不一致");
            return;
          }
          const channel = String(pl.channel ?? "").trim();
          const responded = pl.responded === true;
          const feedbackRaw = pl.feedback == null ? "" : String(pl.feedback).trim();
          const quietHours = pl.quietHours === true;
          const responseTimeMs =
            typeof pl.responseTimeMs === "number" && Number.isFinite(pl.responseTimeMs)
              ? Math.max(0, Math.floor(pl.responseTimeMs))
              : undefined;
          if (!["websocket", "voice", "phone_call"].includes(channel)) {
            sendUnifiedError("BAD_CONTACT_FEEDBACK", "channel 必须是 websocket、voice 或 phone_call");
            return;
          }
          if (feedbackRaw && !["positive", "negative", "neutral"].includes(feedbackRaw)) {
            sendUnifiedError("BAD_CONTACT_FEEDBACK", "feedback 必须是 positive、negative 或 neutral");
            return;
          }
          userPersonalizationService.observeContactOutcome(boundActorId, {
            channel: channel as "websocket" | "voice" | "phone_call",
            responded,
            responseTimeMs,
            feedback: feedbackRaw
              ? (feedbackRaw as "positive" | "negative" | "neutral")
              : undefined,
            quietHours,
          });
          socket.send(
            JSON.stringify({
              type: "companion.contact_feedback_ack",
              payload: {
                ok: true,
                understanding: userPersonalizationService.getUnderstandingSnapshot(boundActorId),
              },
            }),
          );
          return;
        }

        if (event.type === ClientEventType.SessionInit) {
          const payload = event.payload as Record<string, unknown>;
          const sessionIdRaw = String(payload.sessionId ?? "").trim();
          const userIdRaw = payload.userId != null ? String(payload.userId).trim() : "";
          const isDesktopBridgeChannel = payload.desktopBridge === true;
          const isPhoneBridgeChannel = payload.phoneBridge === true;
          // 客户端能力声明（2026-09-12）：mediaPlayback 等能力由客户端在聊天主通道的
          // session.init 里自报，媒体推送类工具据此决定「下发指令」还是「如实告知办不到」。
          // 桥接通道不解析（其 actorId 与主通道相同，避免覆盖主通道声明；媒体事件也
          // 只推给聊天主通道）。未带 capabilities 的旧客户端视为不声明＝不支持。
          const declaredCapabilities = payload.capabilities as
            | Record<string, unknown>
            | undefined;
          // ─── 设备自绑定鉴权门（ACCESS_AUTH_REQUIRED=1 且未在 upgrade query 预验时）───
          // 非桥接通道须在 payload.token 携带有效 access token；desktopBridge /
          // phoneBridge 通道豁免（继续走各自 PHONE_BRIDGE_TOKEN / DESKTOP_BRIDGE_TOKEN
          // 注册流程）。缺失/无效 → error.frame + 关闭连接。
          if (
            accessAuthActive &&
            accessAuthServiceImpl &&
            !accessAuthUserId &&
            !isDesktopBridgeChannel &&
            !isPhoneBridgeChannel
          ) {
            const initToken = typeof payload.token === "string" ? payload.token.trim() : "";
            const verified = initToken ? accessAuthServiceImpl.verifyToken(initToken) : null;
            if (!verified) {
              safeSocketSend(
                ws,
                JSON.stringify({
                  type: ServerEventType.ErrorEvent,
                  payload: {
                    code: "AUTH_REQUIRED",
                    message:
                      "服务已开启访问鉴权：请在 WS 连接 query 或 session.init payload 携带有效 token（POST /api/auth/bind 获取）",
                  },
                }),
              );
              try {
                ws.close(1008, "auth_required");
              } catch {
                // Ignore close failures on broken sockets.
              }
              return;
            }
            accessAuthUserId = verified.userId;
          }
          // 身份钉死：token 归属优先，忽略 payload 里客户端声明的 userId/sessionId
          const actorId = accessAuthUserId ?? (userIdRaw || sessionIdRaw);
          if (!actorId) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: { code: "BAD_SESSION_INIT", message: "需要 userId 或 sessionId" },
              }),
            );
            return;
          }
          if (!isDesktopBridgeChannel && !isPhoneBridgeChannel) {
            declareClientCapabilities(actorId, {
              mediaPlayback: declaredCapabilities?.mediaPlayback === true,
            });
          }
          if (isDesktopBridgeChannel) {
            if (!userIdRaw) {
              socket.send(
                JSON.stringify({
                  type: ServerEventType.ErrorEvent,
                  payload: {
                    code: "DESKTOP_BRIDGE_USER_ID_REQUIRED",
                    message: "与手机同一账号控制电脑时，session.init 须提供与手机相同的 userId（不可仅用 sessionId）",
                  },
                }),
              );
              return;
            }
            if (!desktopBridgeCoordinator.isBridgeFeatureEnabled()) {
              socket.send(
                JSON.stringify({
                  type: ServerEventType.ErrorEvent,
                  payload: {
                    code: "DESKTOP_BRIDGE_DISABLED",
                    message: "服务端未开启电脑桥接（设置 DESKTOP_BRIDGE_ENABLED=1 或 DESKTOP_BRIDGE_TOKEN）",
                  },
                }),
              );
              return;
            }
          }
          if (isPhoneBridgeChannel) {
            if (!userIdRaw) {
              socket.send(
                JSON.stringify({
                  type: ServerEventType.ErrorEvent,
                  payload: {
                    code: "PHONE_BRIDGE_USER_ID_REQUIRED",
                    message: "手机桥接须提供 userId，不可仅用 sessionId",
                  },
                }),
              );
              return;
            }
            if (!phoneBridgeCoordinator.isBridgeFeatureEnabled()) {
              socket.send(
                JSON.stringify({
                  type: ServerEventType.ErrorEvent,
                  payload: {
                    code: "PHONE_BRIDGE_DISABLED",
                    message: "服务端未开启手机桥接（设置 PHONE_BRIDGE_ENABLED=1 或 PHONE_BRIDGE_TOKEN）",
                  },
                }),
              );
              return;
            }
          }
          const deviceId = String(payload.deviceId ?? "");
          const userAlias = payload.userAlias ? String(payload.userAlias) : undefined;
          sessionService.upsert({ sessionId: actorId, deviceId, userAlias });
          realFundsWallet.bootstrap(actorId);
          worldService.getOrCreate(actorId);
          if (boundActorId && boundActorId !== actorId) {
            messageBatchProcessor.setClientProcessingUiActive(boundActorId, false);
          }
          desktopBridgeCoordinator.unbindIfSocket(socket);
          if (boundActorId && boundActorId !== actorId) {
            phoneBridgeCoordinator.unbindIfSocket(boundActorId, socket);
          }
          if (boundActorId && boundActorId !== actorId) {
            wsConnectionRegistry.unregister(boundActorId, socket);
          }
          if (boundActorId) {
            sharedBrowserCoordinator.unbindIfSocket(boundActorId, socket);
          }
          boundActorId = actorId;
          initAsDesktopBridge = isDesktopBridgeChannel;
          initAsPhoneBridge = isPhoneBridgeChannel;
          // 活跃打点：session.init = 应用启动/重连，是「最近活跃」最可靠的信号
          agentAccountService?.touchLastActive(actorId);
          if (!isDesktopBridgeChannel && !isPhoneBridgeChannel) {
            // 设备类别随连接登记（2026-09-18）：session.init 自报 platform，
            // critical 升级链据此区分电脑端/移动端触达；旧客户端缺省按桌面端处理
            wsConnectionRegistry.register(actorId, socket, {
              deviceClass: normalizeDeviceClass(payload.platform ?? payload.deviceClass),
            });
            getEmbodimentAutonomy()?.registerSession(actorId);
            // 离线结果重放（2026-09-08 outbox）：用户离线期间完成的任务面结果
            // 暂存于 TaskOutbox，重连时按 FIFO 原样重推，闭合「离线=结果丢失」缺口。
            getTaskOutbox().replayFor(actorId, socket);
            // 好友消息补投（2026-10-15 闭环）：离线期间好友发来的站内消息在 hub
            // 持久落库；重连时把未读会话的最新一条以 AgentPeerMessage 重推
            // （客户端按 messageId 幂等，已提示过的不重复打扰）。
            if (friendMessageService) {
              friendMessageService
                .replayUnread(actorId)
                .catch(() => {
                  /* 补投失败不影响连接建立 */
                });
            }
            // 活跃任务快照重播（2026-09-08 任务回执）：断线重连/换设备后，
            // 客户端凭 running/awaiting_input 任务的幂等快照重建对话流内回执。
            // quiet 任务（原地同步执行的轻任务）不补发（2026-09-09）。
            if (isTaskPlaneWsEventsEnabled()) {
              for (const record of getTaskHub().activeRecords(actorId)) {
                if (record.quiet) continue;
                try {
                  socket.send(buildTaskUpdateEnvelope(record));
                } catch {
                  /* 单条失败不影响其余快照 */
                }
              }
            }
            // 早间简报：WS 连接建立时把 session 加入调度器，按用户偏好定时推送
            morningBriefingScheduler?.subscribe(actorId, getUserPreferences(actorId));
            // 晚间 digest（Task 15 生活节律）：连接建立时订阅，到点推送今日回顾+明日预告
            eveningDigestScheduler?.subscribe(actorId);
            // 按需位置：绑定 socket，Agent 需要位置时向该客户端请求实时 GPS
            locationCoordinator.bindSocket(actorId, socket);
            // 持续模式（方案 A）：下发定时上报配置，客户端按 intervalSec 回传
            // client.location_report(source:"continuous")；ondemand 不发，客户端无定时器
            locationCoordinator.sendTrackingConfig(socket);
            // 共用浏览器桥：客户端声明 browserBridge 时把本连接绑为浏览器执行器
            //（用户与 Agent 共用同一个 WebView2 浏览器；重连后随 session.init 重绑）
            if (payload.browserBridge === true) {
              sharedBrowserCoordinator.bindExecutor(actorId, socket);
              socket.send(
                JSON.stringify({
                  type: ServerEventType.SharedBrowserSync,
                  payload: { sharedBrowserOnline: true, updatedAt: new Date().toISOString() },
                }),
              );
            }
          } else if (isDesktopBridgeChannel && !desktopBridgeCoordinator.requiresRegisterToken()) {
            desktopBridgeCoordinator.bindExecutor(actorId, socket);
            socket.send(
              JSON.stringify({
                type: ServerEventType.DesktopBridgeRegisterAck,
                payload: { ok: true, actorId, mode: "userId" },
              }),
            );
          } else if (isPhoneBridgeChannel && !phoneBridgeCoordinator.requiresRegisterToken()) {
            const deviceInfo = parsePhoneDeviceInfo(payload);
            phoneBridgeCoordinator.bindExecutor(actorId, socket, deviceInfo);
            socket.send(
              JSON.stringify({
                type: ServerEventType.PhoneBridgeRegisterAck,
                payload: { ok: true, actorId, mode: "userId" },
              }),
            );
          }
          await auditService.record({
            type: ClientEventType.SessionInit,
            sessionId: actorId,
            deviceId,
            userAlias: userAlias ?? "",
            userId: userIdRaw || undefined,
          });
          return;
        }

        if (event.type === ClientEventType.DesktopBridgeRegister) {
          if (!boundActorId) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: { code: "SESSION_REQUIRED", message: "请先发送 session.init" },
              }),
            );
            return;
          }
          if (!initAsDesktopBridge) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: {
                  code: "DESKTOP_BRIDGE_INIT_REQUIRED",
                  message: "session.init 须设置 desktopBridge: true 方可绑定桌面执行器",
                },
              }),
            );
            return;
          }
          if (!desktopBridgeCoordinator.requiresRegisterToken()) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.DesktopBridgeRegisterAck,
                payload: { ok: true, actorId: boundActorId, mode: "userId", note: "当前为无口令模式，已在 session.init 自动绑定" },
              }),
            );
            return;
          }
          const token = String((event.payload as Record<string, unknown>).token ?? "").trim();
          if (!desktopBridgeCoordinator.verifyRegisterToken(token)) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: {
                  code: "DESKTOP_BRIDGE_TOKEN_REJECTED",
                  message: "桥接 token 与服务器 DESKTOP_BRIDGE_TOKEN 不一致",
                },
              }),
            );
            return;
          }
          desktopBridgeCoordinator.bindExecutor(boundActorId, socket);
          socket.send(
            JSON.stringify({
              type: ServerEventType.DesktopBridgeRegisterAck,
              payload: { ok: true, actorId: boundActorId, mode: "token" },
            }),
          );
          return;
        }

        if (event.type === ClientEventType.DesktopBridgeResult) {
          const pl = event.payload as Record<string, unknown>;
          const jobId = String(pl.jobId ?? "").trim();
          if (!jobId) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: { code: "BAD_DESKTOP_BRIDGE_RESULT", message: "缺少 jobId" },
              }),
            );
            return;
          }
          const ok = desktopBridgeCoordinator.completeFromSocket(socket, jobId, pl);
          if (!ok) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: { code: "DESKTOP_BRIDGE_JOB_UNKNOWN", message: "jobId 与当前连接不匹配或已结束" },
              }),
            );
          }
          return;
        }

        if (event.type === ClientEventType.DesktopEvent) {
          if (!boundActorId) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: { code: "SESSION_REQUIRED", message: "请先发送 session.init" },
              }),
            );
            return;
          }
          if (!initAsDesktopBridge) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: {
                  code: "DESKTOP_BRIDGE_INIT_REQUIRED",
                  message: "session.init 须设置 desktopBridge: true 方可推送 desktop.event",
                },
              }),
            );
            return;
          }
          // desktop.event 消息把 event_type / timestamp 放在顶层（与 type 同级），
          // payload 为事件数据本体；此处只做接收与转发，不转 LifeSignal（Task 4 的工作）。
          const rawEvent = event as Record<string, unknown>;
          const eventType = String(rawEvent.event_type ?? rawEvent.eventType ?? "").trim();
          if (!eventType) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: { code: "BAD_DESKTOP_EVENT", message: "缺少 event_type" },
              }),
            );
            return;
          }
          const eventData = (event.payload as Record<string, unknown>) ?? {};
          const rawTs = rawEvent.timestamp;
          const eventTs: number | string =
            typeof rawTs === "number" || typeof rawTs === "string" ? rawTs : Date.now();
          desktopBridgeCoordinator.handleEventFromSocket(socket, boundActorId, {
            actorId: boundActorId,
            eventType,
            payload: eventData,
            timestamp: eventTs,
          });
          return;
        }

        if (event.type === ClientEventType.PhoneBridgeRegister) {
          if (!boundActorId) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: { code: "SESSION_REQUIRED", message: "请先发送 session.init" },
              }),
            );
            return;
          }
          if (!initAsPhoneBridge) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: {
                  code: "PHONE_BRIDGE_INIT_REQUIRED",
                  message: "session.init 须设置 phoneBridge: true 方可绑定手机执行器",
                },
              }),
            );
            return;
          }
          if (!phoneBridgeCoordinator.requiresRegisterToken()) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.PhoneBridgeRegisterAck,
                payload: { ok: true, actorId: boundActorId, mode: "userId", note: "当前为无口令模式，已在 session.init 自动绑定" },
              }),
            );
            return;
          }
          const token = String((event.payload as Record<string, unknown>).token ?? "").trim();
          if (!phoneBridgeCoordinator.verifyRegisterToken(token)) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: {
                  code: "PHONE_BRIDGE_TOKEN_REJECTED",
                  message: "桥接 token 与服务器 PHONE_BRIDGE_TOKEN 不一致",
                },
              }),
            );
            return;
          }
          const deviceInfo = parsePhoneDeviceInfo(event.payload as Record<string, unknown>);
          phoneBridgeCoordinator.bindExecutor(boundActorId, socket, deviceInfo);
          socket.send(
            JSON.stringify({
              type: ServerEventType.PhoneBridgeRegisterAck,
              payload: { ok: true, actorId: boundActorId, mode: "token" },
            }),
          );
          return;
        }

        if (event.type === ClientEventType.PhoneBridgeResult) {
          if (!boundActorId) return;
          const pl = event.payload as Record<string, unknown>;
          const jobId = String(pl.jobId ?? "").trim();
          if (!jobId) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: { code: "BAD_PHONE_BRIDGE_RESULT", message: "缺少 jobId" },
              }),
            );
            return;
          }
          phoneBridgeCoordinator.completeFromSocket(boundActorId, socket, jobId, pl as PhoneBridgeResult);
          return;
        }

        if (event.type === ClientEventType.BrowserBridgeResult) {
          const pl = event.payload as Record<string, unknown>;
          const jobId = String(pl.jobId ?? "").trim();
          if (!jobId) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: { code: "BAD_BROWSER_BRIDGE_RESULT", message: "缺少 jobId" },
              }),
            );
            return;
          }
          if (!boundActorId) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: { code: "SESSION_REQUIRED", message: "请先发送 session.init" },
              }),
            );
            return;
          }
          const ok = sharedBrowserCoordinator.completeFromSocket(
            boundActorId,
            socket,
            jobId,
            pl as SharedBrowserResult,
          );
          if (!ok) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: { code: "BROWSER_BRIDGE_JOB_UNKNOWN", message: "jobId 与当前连接不匹配或已结束" },
              }),
            );
          }
          return;
        }

        if (event.type === ClientEventType.BrowserBridgeInfo) {
          // 共用浏览器 CDP 桥：客户端显式开启调试端口时上报端点（空 = 清除）。
          if (!boundActorId) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: { code: "SESSION_REQUIRED", message: "请先发送 session.init" },
              }),
            );
            return;
          }
          const endpoint = String((event.payload as Record<string, unknown>)?.endpoint ?? "");
          // 仅接受本机回环端点，防误配把调试口暴露到非回环地址
          if (endpoint && !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(endpoint)) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: { code: "BAD_BROWSER_BRIDGE_INFO", message: "endpoint 须为本机回环地址" },
              }),
            );
            return;
          }
          sharedBrowserCoordinator.setCdpEndpoint(boundActorId, endpoint);
          return;
        }

        if (event.type === ClientEventType.PhoneMsgReport) {
          // 手机桥接消息捕捉批量上报 → 消息聚合中心落库 → ack 回执供手机端出队。
          if (!boundActorId || !initAsPhoneBridge) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: {
                  code: "PHONE_BRIDGE_INIT_REQUIRED",
                  message: "消息上报仅允许在已完成注册的手机桥接连接上发送",
                },
              }),
            );
            return;
          }
          if (!messageHubService) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: { code: "MESSAGE_HUB_UNAVAILABLE", message: "消息聚合中心未装配" },
              }),
            );
            return;
          }
          const reportPayload = (event.payload ?? {}) as Record<string, unknown>;
          const batchId = String(reportPayload.batchId ?? "").trim();
          const items = Array.isArray(reportPayload.messages) ? reportPayload.messages : [];
          // alipay：支付宝 App 支付/收款推送（通知监听白名单专属映射；财务实时入账通道）
          // email（2026-10-18）：QQ邮箱/网易邮箱等国内邮箱 App 的通知捕捉入站
          const reportablePlatforms = new Set<string>(["wechat", "qq", "feishu", "sms", "alipay", "email", "generic"]);
          let accepted = 0;
          let duplicates = 0;
          let invalid = 0;
          for (const raw of items.slice(0, 100)) {
            const item = (raw ?? {}) as Record<string, unknown>;
            const platform = String(item.platform ?? "").trim();
            const text = String(item.text ?? "").trim();
            if (!reportablePlatforms.has(platform) || !text) {
              invalid += 1;
              continue;
            }
            const channelId =
              String(item.channelId ?? item.participantId ?? item.title ?? "unknown")
                .trim()
                .slice(0, 200) || "unknown";
            try {
              const result = await messageHubService.ingestInbound({
                actorId: boundActorId,
                platform: platform as MessageHubPlatform,
                channelId,
                text: text.slice(0, 4000),
                participantId: item.participantId != null ? String(item.participantId).slice(0, 200) : undefined,
                participantName: item.participantName != null ? String(item.participantName).slice(0, 200) : undefined,
                title: item.title != null ? String(item.title).slice(0, 200) : undefined,
                senderId: item.senderId != null ? String(item.senderId).slice(0, 200) : undefined,
                senderName: item.senderName != null ? String(item.senderName).slice(0, 200) : undefined,
                externalMessageId: item.externalMessageId != null ? String(item.externalMessageId).slice(0, 200) : undefined,
                meta: {
                  source: "phone_capture",
                  capturedAt: item.capturedAt != null ? String(item.capturedAt) : undefined,
                },
              });
              // gated（入口闸拦截）≠ accepted：库都没进，计成 accepted 会让
              // 客户端误以为已入库而丢消息，归入 invalid 让客户端可见地丢弃
              if ((result as { gated?: boolean }).gated) invalid += 1;
              else if (result.deduped) duplicates += 1;
              else accepted += 1;
            } catch {
              invalid += 1;
            }
          }
          socket.send(
            JSON.stringify({
              type: ServerEventType.PhoneMsgReportAck,
              payload: { ok: true, batchId, accepted, duplicates, invalid, total: items.length },
            }),
          );
          return;
        }

        if (event.type === ClientEventType.PhoneLocReport) {
          // 手机后台低频定位回传：与 LocationReport 同管线落 location.db（fire-and-forget）。
          if (!boundActorId || !initAsPhoneBridge) return;
          const locPayload = (event.payload ?? {}) as Record<string, unknown>;
          const ingested = parseClientLocation(locPayload);
          if (ingested && locationIngest) {
            locationIngest.ingest(boundActorId, { ...ingested, source: "continuous" }, "continuous");
          }
          return;
        }

        if (event.type === ClientEventType.LocationReport) {
          // 客户端回传实时位置：响应 agent.location_request（携带 jobId）或天气面板主动上报。
          if (!boundActorId) {
            sendUnifiedError("SESSION_REQUIRED", "请先发送 session.init");
            return;
          }
          const pl = (event.payload ?? {}) as Record<string, unknown>;
          const consumed = locationCoordinator.completeFromSocket(socket, boundActorId, pl);
          if (!consumed) {
            const jobId = String(pl.jobId ?? "").trim();
            sendUnifiedError("BAD_LOCATION_REPORT", `jobId 与当前连接不匹配或已过期: ${jobId}`);
          }
          // 位置管线（方案 A-D）：历史落库 / 围栏 enter-leave / 到达主动触发。
          // fire-and-forget：管线内部各自容错，不影响按需请求主链路。
          const ingestedLoc = parseClientLocation(pl);
          if (ingestedLoc && locationIngest) {
            const source =
              ingestedLoc.source ??
              (String(pl.jobId ?? "").trim() ? "ondemand" : "report");
            locationIngest.ingest(boundActorId, ingestedLoc, source);
          }
          return;
        }

        if (event.type === ClientEventType.ModeChanged) {
          // 语音模式切换上报：记录 per-actor 状态（诊断 + Phase2 投递矩阵消费）。
          // 纯状态记录，无副作用，未上报过的旧客户端不受影响。
          if (!boundActorId) {
            sendUnifiedError("SESSION_REQUIRED", "请先发送 session.init");
            return;
          }
          const modePl = (event.payload ?? {}) as Record<string, unknown>;
          const active = modePl.active === true;
          const source = String(modePl.source ?? "client").trim() || "client";
          setVoiceMode(boundActorId, active, source);
          app.log.debug({ actorId: boundActorId, active, source }, "voice mode changed");
          return;
        }

        if (event.type === ClientEventType.ChatUserAction) {
          // 用户在「选择型卡片」底部按钮上点击的入口。
          // 语义上等价于 chat.user_message(都是用户输入),但携带 action
          // 元数据(actionId/cardId/variant/payload)便于审计/埋点/路由分流。
          // 这里把它转写为 chat.user_message,走完全相同的 chat 流程,
          // 避免在下游 handler 里出现"user_message vs user_action"双分支。
          if (!boundActorId) {
            sendUnifiedError("SESSION_REQUIRED", "请先发送 session.init");
            return;
          }
          const actPl = (event.payload ?? {}) as Record<string, unknown>;
          const label = String(actPl.label ?? "").trim();
          if (!label) {
            sendUnifiedError("BAD_USER_ACTION", "缺少 label(按钮显示文案)");
            return;
          }
          const cardId = String(actPl.cardId ?? "").trim();
          const actionId = String(actPl.actionId ?? actPl.id ?? "").trim();
          const variant = String(actPl.variant ?? "primary").trim();
          // 仅保留原始可序列化字段,避免后端把前端 payload 当受信输入。
          const actionPayload =
            actPl.payload && typeof actPl.payload === "object"
              ? (actPl.payload as Record<string, unknown>)
              : {};

          // 电话代办确认门（权威证据源）：在点击原点捕获「确认拨打/取消」按钮，
          // 写入 phone-call 会话——后续 phone_call.start 只认可这里记录的确认，
          // LLM 侧无法伪造。其余卡片动作不受影响。
          phoneCallCoordinator?.observeCardAction(boundActorId, {
            cardId,
            actionId,
            payload: actionPayload,
          });

          // 计划交接回执（2026-10-19 handoff）：用户在「我已完成，继续下一步」按钮上
          // 点了一下 = 收回执行权的唯一证据。在点击原点就把等待步置 done（不信模型、
          // 也不必等下一轮），并标记本轮是计划续跑——下游据此走确定性任务面路由。
          const planStepId =
            typeof actionPayload.planStepId === "string" ? actionPayload.planStepId.trim() : "";
          let planContinuation:
            | { stepId: string; stepTitle: string; nextStepId?: string; nextStepTitle?: string }
            | undefined;
          if (planStepId) {
            const store = getTaskPlanStore();
            const planKey = taskPlanKey({
              sessionId: typeof actPl.sessionId === "string" ? actPl.sessionId : boundActorId,
              actorId: boundActorId,
            });
            const resumed = store?.resume(planKey, planStepId, { by: "user", note: label });
            if (resumed?.ok) {
              planContinuation = {
                stepId: resumed.step.id,
                stepTitle: resumed.step.title,
                ...(resumed.nextStep ? { nextStepId: resumed.nextStep.id, nextStepTitle: resumed.nextStep.title } : {}),
              };
            } else {
              // 幂等：重复点击 / 该步已不在等待态 → 不阻断（仍按普通消息走），只记日志
              app.log.debug(
                { actorId: boundActorId, stepId: planStepId, error: resumed?.ok === false ? resumed.error : "计划未装配" },
                "plan handoff confirm ignored",
              );
            }
          }

          // 构造等价的 user message payload。
          // text 使用按钮 label(等价于用户打字输入了这段话);
          // messageId 由客户端提供,保证前端 UI 与后端审计可对齐。
          const userMessagePayload: Record<string, unknown> = {
            sessionId: actPl.sessionId ?? boundActorId,
            messageId: actPl.messageId ?? `action-${Date.now()}`,
            text: label,
            timestamp:
              typeof actPl.timestamp === "string"
                ? actPl.timestamp
                : new Date().toISOString(),
            // 透传上下文(若有):clientLocation / visionFrames 等。
            ...(actPl.clientLocation
              ? { clientLocation: actPl.clientLocation }
              : {}),
          };
          if (typeof actPl.userId === "string" && actPl.userId.trim()) {
            userMessagePayload.userId = actPl.userId.trim();
          }
          // 在 payload 中标记「来源是卡片按钮」,供下游 handler / 记忆 / 审计使用。
          userMessagePayload.cardAction = {
            cardId,
            actionId,
            variant,
            payload: actionPayload,
          };
          // 计划续跑标记（内部字段）：让下游把这一轮确定性路由到任务面，
          // 而不是拿「我已完成，继续下一步」去猜意图。
          if (planContinuation) userMessagePayload.planContinuation = planContinuation;

          await handleChatUserMessageEvent(
            {
              socket,
              boundActorId: boundActorId ?? "",
              sessionId: boundActorId ?? "",
              initAsDesktopBridge,
              clientIp,
              deviceClass: wsConnectionRegistry.deviceClassOf(boundActorId ?? "", socket),
              sendUnifiedError,
            },
            userMessagePayload,
            {
              runtime,
              auditService,
              voiceCapabilityService,
              voiceMessageService,
              phoneCallCoordinator,
            },
          );
          return;
        }

        if (event.type === ClientEventType.ChatUserMessage) {
          await handleChatUserMessageEvent(
            {
              socket,
              boundActorId: boundActorId ?? "",
              sessionId: boundActorId ?? "",
              initAsDesktopBridge,
              clientIp,
              deviceClass: wsConnectionRegistry.deviceClassOf(boundActorId ?? "", socket),
              sendUnifiedError,
            },
            event.payload,
            {
              runtime,
              auditService,
              voiceCapabilityService,
              voiceMessageService,
              phoneCallCoordinator,
            },
          );
          return;
        }

        if (event.type === ClientEventType.ChatAgentProcessingUi) {
          handleChatAgentProcessingUiEvent(
            {
              socket,
              boundActorId: boundActorId ?? "",
              sessionId: boundActorId ?? "",
              initAsDesktopBridge,
              clientIp,
              sendUnifiedError,
            },
            event.payload,
          );
          return;
        }

        if (event.type === ClientEventType.ChatTaskCancel) {
          // 用户取消后台任务（对话流内任务回执上的取消入口）。
          // 与「发送新消息打断前台回复」语义分离：只作用于任务面的这条任务。
          if (!boundActorId) {
            sendUnifiedError("SESSION_REQUIRED", "请先发送 session.init");
            return;
          }
          const cancelPl = (event.payload ?? {}) as Record<string, unknown>;
          const cancelTaskId = String(cancelPl.taskId ?? "").trim();
          if (!cancelTaskId) {
            sendUnifiedError("BAD_REQUEST", "缺少 taskId");
            return;
          }
          const cancelled =
            runtime.cancelBackgroundTask?.(boundActorId, cancelTaskId) ?? false;
          app.log.debug(
            { actorId: boundActorId, taskId: cancelTaskId, cancelled },
            "chat.task_cancel",
          );
          return;
        }

        if (event.type === ClientEventType.ChatClearHistory) {
          if (!boundActorId) {
            sendUnifiedError("SESSION_REQUIRED", "请先发送 session.init");
            return;
          }
          await clearAllMemoryForActor(boundActorId, {
            externalChat: createExternalChatProviderFromEnv(),
            agentMemorySyncService,
          });
          return;
        }

        if (event.type === ClientEventType.AgentEmbodimentInteract) {
          await handleAgentEmbodimentInteractEvent(
            {
              socket,
              boundActorId: boundActorId ?? "",
              sessionId: boundActorId ?? "",
              initAsDesktopBridge,
              clientIp,
              sendUnifiedError,
            },
            event.payload,
            { runtime, auditService },
          );
          return;
        }

        if (event.type === ClientEventType.AgentEmbodimentState) {
          if (!boundActorId) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: { code: "SESSION_REQUIRED", message: "请先发送 session.init" },
              }),
            );
            return;
          }
          if (initAsDesktopBridge || initAsPhoneBridge) return;
          handleAgentEmbodimentStateEvent(boundActorId, event.payload);
          return;
        }

        if (event.type === AgentWorldClientEventType.WorldPartitionAttach) {
          if (!boundActorId) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: { code: "SESSION_REQUIRED", message: "请先发送 session.init" },
              }),
            );
            return;
          }
          if (!worldService.isAgentWorldRegistered(boundActorId)) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: {
                  code: "WORLD_REGISTRATION_REQUIRED",
                  message: "请先完成 Agent World 注册",
                },
              }),
            );
            return;
          }
          const parsedPa = worldPartitionAttachSchema.safeParse(event.payload);
          if (!parsedPa.success) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: { code: "VALIDATION_ERROR", message: parsedPa.error.message },
              }),
            );
            return;
          }
          const { partitionId, traceId } = parsedPa.data;
          const state =
            partitionId === boundActorId
              ? worldService.getOrCreate(partitionId)
              : worldService.getExisting(partitionId);
          if (!state) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: {
                  code: "PARTITION_NOT_FOUND",
                  message: "该房间不存在或尚无持久状态；共享房请先创建 world.room.create。",
                  traceId,
                },
              }),
            );
            return;
          }
          if (!canViewWorldPartition(boundActorId, state.ownerSessionId, agentPairingService)) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: {
                  code: "FORBIDDEN",
                  message: "无权订阅该房间（须为房间拥有者或与拥有者同一配对码）。",
                  traceId,
                },
              }),
            );
            return;
          }
          worldPartitionWsRegistry.attach(partitionId, boundActorId, socket);
          socket.send(
            JSON.stringify({
              type: AgentWorldServerEventType.WorldPartitionSnapshot,
              payload: { partitionId, revision: state.revision, state, traceId },
            }),
          );
          broadcastPartitionPresence(partitionId);
          return;
        }

        if (event.type === AgentWorldClientEventType.WorldPartitionDetach) {
          if (!boundActorId) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: { code: "SESSION_REQUIRED", message: "请先发送 session.init" },
              }),
            );
            return;
          }
          const parsedPd = worldPartitionDetachSchema.safeParse(event.payload);
          if (!parsedPd.success) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: { code: "VALIDATION_ERROR", message: parsedPd.error.message },
              }),
            );
            return;
          }
          const currentPartition = worldPartitionWsRegistry.getPartitionForSocket(socket);
          const requested = parsedPd.data.partitionId;
          if (requested && currentPartition && requested !== currentPartition) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: {
                  code: "VALIDATION_ERROR",
                  message: "当前连接未订阅所请求的 partitionId",
                  traceId: parsedPd.data.traceId,
                },
              }),
            );
            return;
          }
          const targetPid = requested ?? currentPartition;
          if (!targetPid || !currentPartition) {
            return;
          }
          worldPartitionWsRegistry.detachSocket(socket);
          broadcastPartitionPresence(targetPid);
          return;
        }

        // Agent World 社交经济域开关（AGENT_WORLD_SOCIAL_ENABLED，实验性子系统默认关闭）：
        // 关闭时拒绝 world.social.* 社交事件（保留 identity/注册/房间 partition 能力），
        // 开启后行为与现状一致。
        if (!isAgentWorldSocialEnabled() && event.type.startsWith("world.social.")) {
          socket.send(
            JSON.stringify({
              type: ServerEventType.ErrorEvent,
              payload: {
                code: "WORLD_SOCIAL_DISABLED",
                message: "Agent World 社交域已关闭（AGENT_WORLD_SOCIAL_ENABLED=1 可开启）",
              },
            }),
          );
          return;
        }

        if (event.type === AgentWorldClientEventType.WorldSocialSubscribe) {
          if (!boundActorId) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: { code: "SESSION_REQUIRED", message: "请先发送 session.init" },
              }),
            );
            return;
          }
          if (!worldService.isAgentWorldRegistered(boundActorId)) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: {
                  code: "WORLD_REGISTRATION_REQUIRED",
                  message: "请先完成 Agent World 注册",
                },
              }),
            );
            return;
          }
          socialFeedService.subscribe(boundActorId);
          return;
        }

        if (event.type === AgentWorldClientEventType.WorldSocialUnsubscribe) {
          if (!boundActorId) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: { code: "SESSION_REQUIRED", message: "请先发送 session.init" },
              }),
            );
            return;
          }
          socialFeedService.unsubscribe(boundActorId);
          return;
        }

        if (event.type === AgentWorldClientEventType.WorldSocialPost) {
          if (!boundActorId) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: { code: "SESSION_REQUIRED", message: "请先发送 session.init" },
              }),
            );
            return;
          }
          if (!worldService.isAgentWorldRegistered(boundActorId)) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: {
                  code: "WORLD_REGISTRATION_REQUIRED",
                  message: "请先完成 Agent World 注册",
                },
              }),
            );
            return;
          }
          const socPost = worldSocialPostPayloadSchema.safeParse(event.payload);
          if (!socPost.success) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: { code: "INVALID_SOCIAL_EVENT", message: socPost.error.message },
              }),
            );
            return;
          }
          const text = socPost.data.text ?? "";
          const mediaType = socPost.data.mediaType ?? "none";
          const mediaUrl = socPost.data.mediaUrl === undefined ? null : socPost.data.mediaUrl;
          const rSoc = socialFeedService.createPost(boundActorId, text, mediaType, mediaUrl);
          if (!rSoc.ok) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: { code: "SOCIAL_POST_FAILED", message: rSoc.reason },
              }),
            );
            return;
          }
          return;
        }

        if (event.type === AgentWorldClientEventType.WorldSocialComment) {
          if (!boundActorId) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: { code: "SESSION_REQUIRED", message: "请先发送 session.init" },
              }),
            );
            return;
          }
          if (!worldService.isAgentWorldRegistered(boundActorId)) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: {
                  code: "WORLD_REGISTRATION_REQUIRED",
                  message: "请先完成 Agent World 注册",
                },
              }),
            );
            return;
          }
          const socC = worldSocialCommentPayloadSchema.safeParse(event.payload);
          if (!socC.success) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: { code: "INVALID_SOCIAL_EVENT", message: socC.error.message },
              }),
            );
            return;
          }
          const rC = socialFeedService.addComment(boundActorId, socC.data.postId, socC.data.text);
          if (!rC.ok) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: { code: "SOCIAL_COMMENT_FAILED", message: rC.reason },
              }),
            );
            return;
          }
          return;
        }

        if (event.type === AgentWorldClientEventType.WorldSocialLikeToggle) {
          if (!boundActorId) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: { code: "SESSION_REQUIRED", message: "请先发送 session.init" },
              }),
            );
            return;
          }
          if (!worldService.isAgentWorldRegistered(boundActorId)) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: {
                  code: "WORLD_REGISTRATION_REQUIRED",
                  message: "请先完成 Agent World 注册",
                },
              }),
            );
            return;
          }
          const socL = worldSocialLikePayloadSchema.safeParse(event.payload);
          if (!socL.success) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: { code: "INVALID_SOCIAL_EVENT", message: socL.error.message },
              }),
            );
            return;
          }
          const rL = socialFeedService.toggleLike(boundActorId, socL.data.postId);
          if (!rL.ok) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: { code: "SOCIAL_LIKE_FAILED", message: rL.reason },
              }),
            );
            return;
          }
          return;
        }

        if (event.type === AgentWorldClientEventType.WorldSocialPostDelete) {
          if (!boundActorId) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: { code: "SESSION_REQUIRED", message: "请先发送 session.init" },
              }),
            );
            return;
          }
          if (!worldService.isAgentWorldRegistered(boundActorId)) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: {
                  code: "WORLD_REGISTRATION_REQUIRED",
                  message: "请先完成 Agent World 注册",
                },
              }),
            );
            return;
          }
          const socDel = worldSocialPostDeletePayloadSchema.safeParse(event.payload);
          if (!socDel.success) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: { code: "INVALID_SOCIAL_EVENT", message: socDel.error.message },
              }),
            );
            return;
          }
          const rDel = socialFeedService.deletePost(boundActorId, socDel.data.postId);
          if (!rDel.ok) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: { code: "SOCIAL_DELETE_FAILED", message: rDel.reason },
              }),
            );
            return;
          }
          return;
        }

        if (event.type === AgentWorldClientEventType.WorldSocialReport) {
          if (!boundActorId) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: { code: "SESSION_REQUIRED", message: "请先发送 session.init" },
              }),
            );
            return;
          }
          if (!worldService.isAgentWorldRegistered(boundActorId)) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: {
                  code: "WORLD_REGISTRATION_REQUIRED",
                  message: "请先完成 Agent World 注册",
                },
              }),
            );
            return;
          }
          const socRep = worldSocialReportPayloadSchema.safeParse(event.payload);
          if (!socRep.success) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: { code: "INVALID_SOCIAL_EVENT", message: socRep.error.message },
              }),
            );
            return;
          }
          const rRep = socialFeedService.reportPost(boundActorId, socRep.data.postId, socRep.data.reason);
          if (!rRep.ok) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: { code: "SOCIAL_REPORT_FAILED", message: rRep.reason },
              }),
            );
            return;
          }
          return;
        }

        if (event.type === ClientEventType.AipDispatch) {
          if (!boundActorId) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: { code: "SESSION_REQUIRED", message: "请先发送 session.init" },
              }),
            );
            return;
          }
          const parsedAip = aipDispatchWsSchema.safeParse(event.payload);
          if (!parsedAip.success) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: { code: "VALIDATION_ERROR", message: parsedAip.error.message },
              }),
            );
            return;
          }
          const rAip = aipService.dispatch({
            fromSessionId: boundActorId,
            toSessionId: parsedAip.data.toSessionId,
            rawEnvelope: parsedAip.data.envelope,
            chatUserMessageId: parsedAip.data.chatUserMessageId,
          });
          if (!rAip.ok) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: { code: "AIP_DISPATCH_FAILED", message: rAip.message },
              }),
            );
            return;
          }
          socket.send(
            JSON.stringify({
              type: ServerEventType.ToolResult,
              payload: {
                toolName: "aip.dispatch",
                ok: true,
                result: {
                  messageId: rAip.record.messageId,
                  pushedToPeer: rAip.pushedToPeer,
                  aip: rAip.record.aip,
                },
                traceId: "",
              },
            }),
          );
          return;
        }

        if (event.type === UnifiedClientEventType.Capabilities) {
          const parsedCap = unifiedCapabilitiesClientSchema.safeParse(event.payload);
          if (!parsedCap.success) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: { code: "VALIDATION_ERROR", message: parsedCap.error.message },
              }),
            );
            return;
          }
          socket.send(
            JSON.stringify({
              type: UnifiedServerEventType.Capabilities,
              payload: {
                ok: true,
                unifiedProtocol: UNIFIED_PROTOCOL_VERSION,
                layers: UNIFIED_LAYER_MANIFEST,
                traceId: parsedCap.data.traceId,
              },
            }),
          );
          return;
        }

        if (event.type === UnifiedClientEventType.QuotaAdjust) {
          if (!boundActorId) {
            sendUnifiedError(UnifiedErrorCode.SessionRequired, "请先发送 session.init");
            return;
          }
          const parsedQ = unifiedQuotaAdjustSchema.safeParse(event.payload);
          if (!parsedQ.success) {
            sendUnifiedError(UnifiedErrorCode.ValidationError, parsedQ.error.message);
            return;
          }
          const quotaActor = resolveUnifiedMemoryActorId(parsedQ.data);
          if (quotaActor !== boundActorId) {
            sendUnifiedError(
              UnifiedErrorCode.Forbidden,
              "userId/sessionId 与当前连接不一致",
              parsedQ.data.traceId,
            );
            return;
          }
          const cached = unifiedIdempotencyService.get(
            quotaActor,
            UnifiedClientEventType.QuotaAdjust,
            parsedQ.data.requestId,
          );
          if (cached) {
            socket.send(
              JSON.stringify({
                type: UnifiedServerEventType.QuotaState,
                payload: { ...cached, deduped: true },
              }),
            );
            return;
          }
          const adj = computeQuotaService.adjust(quotaActor, parsedQ.data.op, parsedQ.data.units);
          const st = computeQuotaService.getState(quotaActor);
          const payload = {
            ok: adj.ok,
            op: parsedQ.data.op,
            units: parsedQ.data.units,
            reason: adj.ok ? undefined : adj.reason,
            code: adj.ok ? undefined : UnifiedErrorCode.BadRequest,
            ...st,
            traceId: parsedQ.data.traceId,
          };
          unifiedIdempotencyService.set(
            quotaActor,
            UnifiedClientEventType.QuotaAdjust,
            parsedQ.data.requestId,
            payload,
          );
          socket.send(JSON.stringify({ type: UnifiedServerEventType.QuotaState, payload }));
          return;
        }

        if (event.type === UnifiedClientEventType.MemoryPatch) {
          if (!boundActorId) {
            sendUnifiedError(UnifiedErrorCode.SessionRequired, "请先发送 session.init");
            return;
          }
          const parsedMp = unifiedMemoryPatchSchema.safeParse(event.payload);
          if (!parsedMp.success) {
            sendUnifiedError(UnifiedErrorCode.ValidationError, parsedMp.error.message);
            return;
          }
          const memPatchActor = resolveUnifiedMemoryActorId(parsedMp.data);
          if (memPatchActor !== boundActorId) {
            sendUnifiedError(
              UnifiedErrorCode.Forbidden,
              "userId/sessionId 与当前连接不一致",
              parsedMp.data.traceId,
            );
            return;
          }
          const cached = unifiedIdempotencyService.get(
            memPatchActor,
            UnifiedClientEventType.MemoryPatch,
            parsedMp.data.requestId,
          );
          if (cached) {
            socket.send(
              JSON.stringify({
                type: UnifiedServerEventType.MemorySnapshot,
                payload: { ...cached, deduped: true },
              }),
            );
            return;
          }
          const patchResult = await agentMemorySyncService.applyPatch(
            memPatchActor,
            parsedMp.data.basisRevision,
            parsedMp.data.patches,
          );
          if (!patchResult.ok) {
            const failedPayload = {
              ok: false,
              code: UnifiedErrorCode.BadRequest,
              reason: patchResult.reason,
              currentRevision: patchResult.currentRevision,
              traceId: parsedMp.data.traceId,
            };
            unifiedIdempotencyService.set(
              memPatchActor,
              UnifiedClientEventType.MemoryPatch,
              parsedMp.data.requestId,
              failedPayload,
            );
            socket.send(
              JSON.stringify({ type: UnifiedServerEventType.MemorySnapshot, payload: failedPayload }),
            );
            return;
          }
          const snap = agentMemorySyncService.getSnapshot(memPatchActor);
          const payload = {
            ok: true,
            revision: patchResult.revision,
            entries: snap.entries,
            traceId: parsedMp.data.traceId,
          };
          unifiedIdempotencyService.set(
            memPatchActor,
            UnifiedClientEventType.MemoryPatch,
            parsedMp.data.requestId,
            payload,
          );
          socket.send(JSON.stringify({ type: UnifiedServerEventType.MemorySnapshot, payload }));
          return;
        }

        if (event.type === UnifiedClientEventType.MemoryGet) {
          if (!boundActorId) {
            sendUnifiedError(UnifiedErrorCode.SessionRequired, "请先发送 session.init");
            return;
          }
          const parsedMg = unifiedMemoryGetSchema.safeParse(event.payload);
          if (!parsedMg.success) {
            sendUnifiedError(UnifiedErrorCode.ValidationError, parsedMg.error.message);
            return;
          }
          const memGetActor = resolveUnifiedMemoryActorId(parsedMg.data);
          if (memGetActor !== boundActorId) {
            sendUnifiedError(
              UnifiedErrorCode.Forbidden,
              "userId/sessionId 与当前连接不一致",
              parsedMg.data.traceId,
            );
            return;
          }
          const snapG = agentMemorySyncService.getSnapshot(memGetActor, parsedMg.data.keys);
          socket.send(
            JSON.stringify({
              type: UnifiedServerEventType.MemorySnapshot,
              payload: {
                ok: true,
                revision: snapG.revision,
                entries: snapG.entries,
                traceId: parsedMg.data.traceId,
              },
            }),
          );
          return;
        }

        if (event.type === UnifiedClientEventType.HumanDirective) {
          if (!boundActorId) {
            sendUnifiedError(UnifiedErrorCode.SessionRequired, "请先发送 session.init");
            return;
          }
          const parsedHd = unifiedHumanDirectiveSchema.safeParse(event.payload);
          if (!parsedHd.success) {
            sendUnifiedError(UnifiedErrorCode.ValidationError, parsedHd.error.message);
            return;
          }
          const hdActor = resolveUnifiedMemoryActorId(parsedHd.data);
          if (hdActor !== boundActorId) {
            sendUnifiedError(
              UnifiedErrorCode.Forbidden,
              "userId/sessionId 与当前连接不一致",
              parsedHd.data.traceId,
            );
            return;
          }
          const cached = unifiedIdempotencyService.get(
            hdActor,
            UnifiedClientEventType.HumanDirective,
            parsedHd.data.requestId,
          );
          if (cached) {
            socket.send(
              JSON.stringify({
                type: UnifiedServerEventType.HumanDirectiveAck,
                payload: { ...cached, deduped: true },
              }),
            );
            return;
          }
          if (parsedHd.data.scope === "partition" && !parsedHd.data.partitionId?.trim()) {
            sendUnifiedError(
              UnifiedErrorCode.ValidationError,
              "scope=partition 时必须提供 partitionId",
              parsedHd.data.traceId,
            );
            return;
          }
          const receivedAt = new Date().toISOString();
          await auditService.record({
            type: UnifiedClientEventType.HumanDirective,
            sessionId: hdActor,
            scope: parsedHd.data.scope,
            partitionId: parsedHd.data.partitionId,
            priority: parsedHd.data.priority ?? "normal",
            text: parsedHd.data.text,
            traceId: parsedHd.data.traceId,
          });
          const payload = {
            ok: true,
            scope: parsedHd.data.scope,
            partitionId: parsedHd.data.partitionId,
            receivedAt,
            traceId: parsedHd.data.traceId,
          };
          unifiedIdempotencyService.set(
            hdActor,
            UnifiedClientEventType.HumanDirective,
            parsedHd.data.requestId,
            payload,
          );
          socket.send(JSON.stringify({ type: UnifiedServerEventType.HumanDirectiveAck, payload }));
          return;
        }

        if (event.type === UnifiedClientEventType.GovernanceProbe) {
          if (!boundActorId) {
            sendUnifiedError(UnifiedErrorCode.SessionRequired, "请先发送 session.init");
            return;
          }
          const parsedGp = unifiedGovernanceProbeSchema.safeParse(event.payload);
          if (!parsedGp.success) {
            sendUnifiedError(UnifiedErrorCode.ValidationError, parsedGp.error.message);
            return;
          }
          const gpActor = resolveUnifiedMemoryActorId(parsedGp.data);
          if (gpActor !== boundActorId) {
            sendUnifiedError(
              UnifiedErrorCode.Forbidden,
              "userId/sessionId 与当前连接不一致",
              parsedGp.data.traceId,
            );
            return;
          }
          const action = parsedGp.data.action;
          const allowed =
            action !== "world.http.mutation" || allowWorldHttpMutations();
          socket.send(
            JSON.stringify({
              type: UnifiedServerEventType.GovernanceAck,
              payload: {
                ok: true,
                allowed,
                action,
                rulesApplied: ["world.http.mutation<=ALLOW_WORLD_HTTP_MUTATIONS"],
                traceId: parsedGp.data.traceId,
              },
            }),
          );
          return;
        }

        if (event.type === ClientEventType.WalletSimulateRequest) {
          const parsed = walletRequestSchema.safeParse(event.payload);
          if (!parsed.success) {
            socket.send(
              JSON.stringify({
                type: ServerEventType.ErrorEvent,
                payload: { code: "INVALID_WALLET_EVENT", message: parsed.error.message },
              }),
            );
            return;
          }
          const data = parsed.data;
          const result = realFundsWallet.simulate(
            data.sessionId,
            data.action as WalletAction,
            data.amount,
          );
          await auditService.record({
            type: ClientEventType.WalletSimulateRequest,
            sessionId: data.sessionId,
            action: data.action,
            amount: data.amount,
            requestId: data.requestId,
          });
          socket.send(
            JSON.stringify({
              type: ServerEventType.WalletSimulateResult,
              payload: {
                requestId: data.requestId,
                action: data.action,
                amount: data.amount,
                ok: result.ok,
                ledgerKind: "real_funds",
                ledger: result.ledger,
                auditId: `audit-${Date.now()}`,
                reason: result.reason,
              },
            }),
          );
          return;
        }

        socket.send(
          JSON.stringify({
            type: ServerEventType.ErrorEvent,
            payload: { code: "UNKNOWN_EVENT", message: `未知事件: ${event.type}` },
          }),
        );
      });
    },
  );
}
