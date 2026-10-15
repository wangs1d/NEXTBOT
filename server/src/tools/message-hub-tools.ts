import { resolveActorId } from "../agent/actor-id.js";
import type { MessagePlatformGateway } from "../services/message-platform-gateway.js";
import type { MessageHubService } from "../services/message-hub-service.js";
import type { FriendMessageService } from "../services/friend-message-service.js";
import { runChatTurnForActor } from "../services/chat-turn-runner.js";
import type { RuntimeFacade } from "../runtime/runtime-facade.js";
import type { ToolContext, ToolRegistry } from "./tool-registry.js";

export function registerMessageHubTools(
  registry: ToolRegistry,
  deps: { hub: MessageHubService; gateway: MessagePlatformGateway; runtime: RuntimeFacade; friendMessages?: FriendMessageService },
): void {
  registry.register("messages.overview", async (_params, ctx: ToolContext) => {
    const actorId = resolveActorId(ctx);
    const overview = deps.hub.overview(actorId);
    if (overview.totalUnread === 0) {
      const platforms = overview.platforms.length
        ? `（有历史会话的平台：${overview.platforms.map((p) => p.platform).join("、")}，均无未读）`
        : "（暂无任何消息记录）";
      return { ok: true, totalUnread: 0, platforms: overview.platforms, summary: `没有未读消息${platforms}` };
    }
    const lines = overview.platforms.map((p) => {
      const latest = p.latest[0];
      const latestText = latest ? `，最新：${latest.participantName ?? latest.title ?? "未知"}「${latest.preview}」` : "";
      return `${p.platform} ${p.unreadCount} 条未读 / ${p.conversationCount} 个会话${latestText}`;
    });
    return {
      ok: true,
      totalUnread: overview.totalUnread,
      platforms: overview.platforms,
      summary: `共 ${overview.totalUnread} 条未读。${lines.join("；")}。要看某个会话的完整消息请用 messages.read_conversation（conversationId 见 platforms 字段）。`,
    };
  });

  registry.register("messages.list_conversations", async (params, ctx: ToolContext) => {
    const actorId = resolveActorId(ctx);
    return {
      ok: true,
      conversations: deps.hub.listConversations(actorId, {
        platform: typeof params.platform === "string" ? params.platform : undefined,
        limit: typeof params.limit === "number" ? params.limit : undefined,
      }),
    };
  });

  registry.register("messages.read_conversation", async (params, ctx: ToolContext) => {
    const actorId = resolveActorId(ctx);
    const conversationId = String(params.conversationId ?? "").trim();
    if (!conversationId) return { ok: false, error: "missing conversationId" };
    const conversation = deps.hub.getConversation(actorId, conversationId);
    if (!conversation) return { ok: false, error: "conversation not found" };
    return {
      ok: true,
      conversation,
      messages: deps.hub.listMessages(actorId, conversationId, {
        limit: typeof params.limit === "number" ? params.limit : undefined,
      }),
    };
  });

  registry.register(
    "messages.reply",
    async (params, ctx: ToolContext) => {
      const actorId = resolveActorId(ctx);
      const conversationId = String(params.conversationId ?? "").trim();
      const text = String(params.text ?? "").trim();
      if (!conversationId) return { ok: false, error: "missing conversationId" };
      if (!text) return { ok: false, error: "missing text" };
      const conversation = deps.hub.getConversation(actorId, conversationId);
      if (!conversation) return { ok: false, error: "conversation not found" };
      if (conversation.platform === "sms" && !ctx.phoneBridgeOnline) {
        return {
          ok: false,
          error: "手机不在线，无法代发短信",
          errorCode: "TOOL_UNAVAILABLE",
        };
      }
      // friend（站内好友消息）：经 FriendMessageService 统一投递（对方 hub 持久
      // 入站 + WS 直推 + 本方留档），不走 MessagePlatformGateway 的外部桥。
      if (conversation.platform === "friend") {
        if (!deps.friendMessages) {
          return { ok: false, error: "站内好友消息通道未装配", errorCode: "TOOL_UNAVAILABLE" };
        }
        const toActorId = conversation.participantId?.trim() || conversation.channelId.trim();
        const sent = await deps.friendMessages.send({
          fromActorId: actorId,
          toActorId,
          text,
          ...(typeof params.replyToMessageId === "string" && params.replyToMessageId.trim()
            ? { replyToMessageId: params.replyToMessageId.trim() }
            : {}),
        });
        if (!sent.ok) {
          return { ok: false, error: sent.error, errorCode: "TOOL_UNAVAILABLE" };
        }
        const updated = deps.hub.getConversation(actorId, conversationId);
        return {
          ok: true,
          delivered: true,
          conversation: updated ?? conversation,
          summary: sent.pushedToPeer
            ? "站内消息已送达对方（在线直推）。"
            : "站内消息已持久送达对方收件箱（对方离线，上线会补投提醒）。",
        };
      }
      const sendResult = await deps.gateway.send({
        actorId,
        platform: conversation.platform,
        channelId: conversation.channelId,
        text,
        conversationId,
        replyToMessageId: typeof params.replyToMessageId === "string" ? params.replyToMessageId : undefined,
        to: typeof params.to === "string" ? params.to.trim() : undefined,
      });
      const created = await deps.hub.createOutbound({
        actorId,
        platform: conversation.platform,
        channelId: conversation.channelId,
        text,
        participantId: conversation.participantId,
        participantName: conversation.participantName,
        title: conversation.title,
        replyToMessageId: typeof params.replyToMessageId === "string" ? params.replyToMessageId : undefined,
        externalMessageId: sendResult.externalMessageId,
        meta: { delivered: sendResult.delivered === true, platformMessage: sendResult.message ?? "" },
      });
      return {
        ok: true,
        delivered: sendResult.delivered === true,
        conversation: created.conversation,
        message: created.message,
        summary: sendResult.delivered
          ? "已发送。"
          : `未送达：${sendResult.message ?? "发送通道不可用"}。不要谎称已发出。`,
      };
    },
    { sideEffect: "write", requireHonestFailure: true },
  );

  registry.register("messages.mark_read", async (params, ctx: ToolContext) => {
    const actorId = resolveActorId(ctx);
    const conversationId = String(params.conversationId ?? "").trim();
    if (!conversationId) return { ok: false, error: "missing conversationId" };
    const ok = await deps.hub.markConversationRead(actorId, conversationId);
    return ok ? { ok: true } : { ok: false, error: "conversation not found" };
  });

  registry.register("messages.suggest_reply", async (params, ctx: ToolContext) => {
    const actorId = resolveActorId(ctx);
    const conversationId = String(params.conversationId ?? "").trim();
    if (!conversationId) return { ok: false, error: "missing conversationId" };
    const conversation = deps.hub.getConversation(actorId, conversationId);
    if (!conversation) return { ok: false, error: "conversation not found" };
    const messages = deps.hub.listMessages(actorId, conversationId, {
      limit: typeof params.limit === "number" ? params.limit : 20,
    });
    const transcript = messages
      .map((m) => `${m.direction === "outbound" ? "我" : (m.senderName || m.senderId || "对方")}: ${m.text}`)
      .join("\n");
    const style = typeof params.style === "string" && params.style.trim()
      ? `回复风格要求：${params.style.trim()}\n`
      : "";
    const prompt =
      `请基于以下聊天记录，生成一条适合直接发送的简短中文回复。` +
      `只输出回复正文，不要解释，不要加引号。\n${style}聊天记录：\n${transcript}`;
    const result = await runChatTurnForActor(deps.runtime, actorId, {
      text: prompt,
      userId: ctx.userId ?? actorId,
      preferFullPipeline: true,
      agentAccessMode: ctx.agentAccessMode,
      clientLocation: ctx.clientLocation,
    });
    if (!result.ok) return { ok: false, error: result.message };
    return {
      ok: true,
      conversation,
      suggestedReply: result.finalText.trim(),
    };
  });
}
