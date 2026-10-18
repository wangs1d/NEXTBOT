import { resolveActorId } from "../agent/actor-id.js";
import type { MessagePlatformGateway } from "../services/message-platform-gateway.js";
import type { MessageHubService } from "../services/message-hub-service.js";
import type { FriendMessageService } from "../services/friend-message-service.js";
import { runChatTurnForActor } from "../services/chat-turn-runner.js";
import type { RuntimeFacade } from "../runtime/runtime-facade.js";
import type { ToolContext, ToolRegistry } from "./tool-registry.js";

/**
 * 国内生态通知捕捉覆盖清单（与 Android 端 MessageCaptureListenerService.PACKAGE_PLATFORM
 * 对齐；国外源 Gmail/Outlook 等暂不接入）。仅作为 capture_status 的覆盖面说明供 agent
 * 如实告知用户，不是运行时拦截。
 */
const DOMESTIC_CAPTURE_APPS = [
  "微信",
  "QQ",
  "飞书",
  "钉钉",
  "短信",
  "支付宝",
  "QQ邮箱",
  "网易邮箱",
  "淘宝",
  "京东",
  "拼多多",
  "美团",
  "饿了么",
  "菜鸟裹裹",
  "顺丰速运",
  "抖音",
  "哔哩哔哩",
  "小红书",
  "微博",
] as const;

export function registerMessageHubTools(
  registry: ToolRegistry,
  deps: {
    hub: MessageHubService;
    gateway: MessagePlatformGateway;
    runtime: RuntimeFacade;
    friendMessages?: FriendMessageService;
    /** 手机桥接协调器：capture_status 读注册时上报的通知使用权授权状态 */
    phoneBridgeCoordinator?: { getDeviceInfo(actorId: string): Record<string, unknown> | undefined };
  },
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
          return {
            ok: false,
            error: sent.error,
            ...(sent.reason ? { reason: sent.reason } : {}),
            errorCode: "TOOL_UNAVAILABLE",
          };
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

  registry.register("messages.search", async (params, ctx: ToolContext) => {
    const actorId = resolveActorId(ctx);
    const query = String(params.query ?? "").trim();
    if (!query) return { ok: false, error: "missing query" };
    const messages = deps.hub.searchMessages(actorId, {
      query,
      platform: typeof params.platform === "string" ? params.platform.trim() || undefined : undefined,
      since: typeof params.since === "string" ? params.since.trim() || undefined : undefined,
      limit: typeof params.limit === "number" ? params.limit : undefined,
    });
    return {
      ok: true,
      count: messages.length,
      messages: messages.map((m) => ({
        platform: m.platform,
        conversationId: m.conversationId,
        direction: m.direction,
        senderName: m.senderName,
        text: m.text.slice(0, 200),
        createdAt: m.createdAt,
      })),
      summary:
        messages.length > 0
          ? `找到 ${messages.length} 条含「${query}」的消息（按时间倒序）。要看某个会话完整内容用 messages.read_conversation。`
          : `没有找到含「${query}」的消息。注意：只搜得到被捕捉/汇聚进聚合中心的消息，App 未发通知或未开通知使用权时收不到。`,
    };
  });

  registry.register("messages.capture_status", async (_params, ctx: ToolContext) => {
    const actorId = resolveActorId(ctx);
    const stats = deps.hub.captureStats(actorId);
    const now = Date.now();
    const platforms = stats.map((s) => {
      const hoursAgo = Math.max(0, Math.round((now - Date.parse(s.lastInboundAt)) / 3_600_000));
      return {
        platform: s.platform,
        lastCaptureAt: s.lastInboundAt,
        hoursSinceLastCapture: hoursAgo,
        countLast24h: s.count24h,
        stale: hoursAgo >= 6,
      };
    });
    const staleOnes = platforms.filter((p) => p.stale);
    // 通知使用权授权状态：手机注册时上报（parsePhoneDeviceInfo 透传）。
    // undefined = 旧客户端未上报，不引导（保守避免误判）；显式 false 才发卡引导。
    const bridgeOnline = ctx.phoneBridgeOnline === true;
    const listenerEnabled =
      deps.phoneBridgeCoordinator?.getDeviceInfo(actorId)?.notificationListenerEnabled === true;
    const listenerDenied = bridgeOnline && listenerEnabled === false;
    const coverageText =
      platforms.length === 0
        ? "还没有任何手机通知捕捉记录（手机桥接可能没发过通知）。"
        : `通知捕捉覆盖 ${platforms.length} 个平台：${platforms
            .map((p) => `${p.platform} 最近 ${p.hoursSinceLastCapture} 小时前（24h 内 ${p.countLast24h} 条）`)
            .join("；")}。${
            staleOnes.length > 0
              ? `${staleOnes.map((p) => p.platform).join("、")} 已超过 6 小时无捕捉——可能是对应 App 没发通知、通知使用权被系统收回或手机桥接离线，如实告知用户即可，不要臆断消息不存在。`
              : "各平台捕获流正常。"
          }`;
    return {
      ok: true,
      platforms,
      bridgeOnline,
      listenerEnabled,
      coveredApps: DOMESTIC_CAPTURE_APPS,
      // 未授权引导独立于记录数：哪怕有历史捕捉记录（授权被收回/重装后未重授）也要引导
      summary: listenerDenied
        ? `${coverageText}另外，手机桥接在线但未授予系统「通知使用权」——发一张 permission_request 卡片引导用户授权（actions 带 {"id":"open_notification_listener_settings","label":"去系统设置授权"}），并说明授权后微信/QQ/短信/邮箱/物流等通知会汇总给你。`
        : coverageText,
    };
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
