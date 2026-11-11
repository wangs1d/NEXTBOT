import type { FastifyRequest } from "fastify";

import { resolveActorId } from "../agent/actor-id.js";
import {
  isChannelSessionIsolationEnabled,
  resolveChannelScopedSessionId,
} from "../agent/master-chat-session.js";
import { runChatTurnForActor } from "./chat-turn-runner.js";
import type { RuntimeFacade } from "../runtime/runtime-facade.js";
import type { MessageHubPlatform, MessageHubService } from "./message-hub-service.js";

function parseBooleanEnv(raw: string | undefined): boolean {
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

export type UnifiedBridgeInboundBody = {
  platform: MessageHubPlatform;
  text: string;
  userId?: string;
  sessionId?: string;
  senderId?: string;
  senderName?: string;
  channelId?: string;
  channelName?: string;
  accountId?: string;
  messageId?: string;
  autoReply?: boolean;
};

let warnedDefaultBridgeActor = false;

/**
 * 入站消息在「没有显式 userId/sessionId 绑定」时的归属 actor。
 *
 * 显式配置优先；都没有时保留 session-mvp-001 兜底（旧部署不断），但只告警
 * 一次：强鉴权后占位身份不代表任何账号，消息落进去就是共享桶。
 */
function defaultBridgeActorId(env: NodeJS.ProcessEnv): string {
  const explicit = env.MESSAGE_BRIDGE_DEFAULT_ACTOR_ID?.trim();
  if (explicit) return explicit;
  if (!warnedDefaultBridgeActor) {
    warnedDefaultBridgeActor = true;
    console.warn(
      "[message-bridge] 未配置 MESSAGE_BRIDGE_DEFAULT_ACTOR_ID：" +
        "未显式绑定账号的入站消息会落到 session-mvp-001 共享桶。",
    );
  }
  return "session-mvp-001";
}

export class MessageBridgeService {
  constructor(
    private readonly runtime: RuntimeFacade,
    private readonly hub: MessageHubService,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  isEnabled(): boolean {
    return parseBooleanEnv(this.env.MESSAGE_BRIDGE_ENABLED) || parseBooleanEnv(this.env.WECHAT_CLAW_BRIDGE_ENABLED);
  }

  assertAuthorized(request: FastifyRequest): void {
    const token =
      this.env.MESSAGE_BRIDGE_TOKEN?.trim() ||
      this.env.WECHAT_CLAW_BRIDGE_TOKEN?.trim() ||
      "";
    if (!token) return;
    const header =
      (typeof request.headers.authorization === "string"
        ? request.headers.authorization.replace(/^Bearer\s+/i, "").trim()
        : "") ||
      (typeof request.headers["x-message-bridge-token"] === "string"
        ? request.headers["x-message-bridge-token"].trim()
        : "");
    if (header !== token) {
      throw new Error("message bridge auth failed");
    }
  }

  async ingest(body: UnifiedBridgeInboundBody): Promise<{
    ok: true;
    actorId: string;
    conversationId: string;
    messageId: string;
    replyText?: string;
  } | { ok: false; message: string }> {
    if (!this.isEnabled()) {
      return { ok: false, message: "message bridge disabled" };
    }
    const text = body.text.trim();
    if (!text) return { ok: false, message: "message text is empty" };

    // P1 渠道隔离（2026-09-06）：入站无显式 userId/sessionId 绑定时，不再默认
    // 挤进主线程会话（session-mvp-001）——按来源平台派生 `actorId@平台` 独立会话，
    // 线程/短期记忆按渠道隔离；显式绑定（userId 或 sessionId）保持原样。
    // AGENT_CHANNEL_SESSION_ISOLATION=0 回退旧行为。
    const baseActorId = resolveActorId({
      userId: body.userId,
      sessionId: body.sessionId?.trim() || defaultBridgeActorId(this.env),
    });
    const hasExplicitBinding = Boolean(body.userId?.trim() || body.sessionId?.trim());
    const actorId =
      hasExplicitBinding || !isChannelSessionIsolationEnabled()
        ? baseActorId
        : resolveChannelScopedSessionId(baseActorId, body.platform);
    const channelId = body.channelId?.trim() || body.senderId?.trim() || body.accountId?.trim() || `${body.platform}-default`;
    const ingested = await this.hub.ingestInbound({
      actorId,
      platform: body.platform,
      channelId,
      text,
      participantId: body.senderId?.trim() || body.accountId?.trim(),
      participantName: body.senderName?.trim() || body.channelName?.trim() || body.platform,
      title: body.channelName?.trim() ? `${body.platform} · ${body.channelName!.trim()}` : body.platform,
      senderId: body.senderId?.trim(),
      senderName: body.senderName?.trim() || body.channelName?.trim(),
      externalMessageId: body.messageId,
      meta: { accountId: body.accountId, autoReply: body.autoReply === true },
    });

    if (body.autoReply !== true) {
      return {
        ok: true,
        actorId,
        conversationId: ingested.conversation.conversationId,
        messageId: ingested.message.messageId,
      };
    }

    const reply = await runChatTurnForActor(this.runtime, actorId, {
      text,
      messageId: body.messageId,
      userId: body.userId ?? actorId,
      preferFullPipeline: true,
    });
    if (!reply.ok) {
      return { ok: false, message: reply.message };
    }
    return {
      ok: true,
      actorId,
      conversationId: ingested.conversation.conversationId,
      messageId: ingested.message.messageId,
      replyText: reply.finalText,
    };
  }
}
