import { ServerEventType } from "../protocol.js";
import type { ClientPushPort } from "../ports/client-push-port.js";
import type { AgentAccountService } from "./agent-account-service.js";
import type { FriendService } from "./friend-service.js";
import type { MessageHubService } from "./message-hub-service.js";
import type { AgentRelayService } from "./agent-relay-service.js";

/**
 * 站内好友消息统一发送内核（2026-10-15 闭环根修）。
 *
 * 此前 world.link.send_message（原 agent.send_to_peer）只做「内存中继 + 在线 WS 直推」：离线收件箱纯内存
 * 重启即丢、发件不留档、好友回信 agent 读不到——发送半环不闭环。
 *
 * 本服务收口全部投递面，一条消息五处落点：
 *   1. AgentRelayService 内存收件箱（GET /agent/inbox 旧客户端兼容面）；
 *   2. 接收方 hub ingestInbound（platform=friend，SQLite 持久 + 未读计数 +
 *      onInbound 主动链路钩子）——离线必达、agent 可读的根；
 *   3. 发送方 hub createOutbound——代发留档；
 *   4. WS AgentPeerMessage 直推（含 fromName，客户端 toast/通知直接可读）；
 *   5. friendService lastMessageAt 双向刷新。
 * world.link.send_message、messages.reply（friend 平台）、HTTP /friends/messages
 * 三个出口全部走这里，保证语义一致。
 */

export type FriendMessageSendInput = {
  fromActorId: string;
  toActorId: string;
  text: string;
  subject?: string;
  traceId?: string;
  chatUserMessageId?: string;
  /** 引用的对方消息 ID（messages.reply 带 replyToMessageId 回信时透传留档） */
  replyToMessageId?: string;
};

export type FriendMessageSendResult = {
  ok: true;
  messageId: string;
  pushedToPeer: boolean;
};

export type FriendMessageSendFailure = {
  ok: false;
  error: string;
  /** 门禁原因：非好友关系（站内信后台专用，不设注册前提） */
  reason?: "NOT_FRIENDS";
};

export type FriendPeerMessageEnvelopePayload = {
  messageId: string;
  fromSessionId: string;
  toSessionId: string;
  fromName?: string;
  text: string;
  subject?: string;
  receivedAt: string;
  unreadFromPeer?: number;
  replayed?: boolean;
  chatUserMessageId?: string;
};

export type FriendPeerMessageType = (typeof ServerEventType)[keyof typeof ServerEventType];

export function buildFriendPeerEnvelope(
  type: FriendPeerMessageType,
  payload: FriendPeerMessageEnvelopePayload,
): string {
  return JSON.stringify({ type, payload });
}

export class FriendMessageService {
  constructor(
    private readonly deps: {
      hub: MessageHubService;
      relay: AgentRelayService;
      wsRegistry: ClientPushPort;
      accounts: AgentAccountService;
      friends: FriendService;
    },
  ) {}

  private displayNameOf(actorId: string): string {
    return this.deps.accounts.getByActorId(actorId)?.displayName?.trim() || actorId;
  }

  async send(input: FriendMessageSendInput): Promise<FriendMessageSendResult | FriendMessageSendFailure> {
    const from = input.fromActorId.trim();
    const to = input.toActorId.trim();
    const text = input.text.trim();
    if (!from || !to) return { ok: false, error: "缺少发送方或接收方身份" };
    if (!text) return { ok: false, error: "消息正文不能为空" };
    if (from === to) return { ok: false, error: "不能给自己发好友消息" };

    // 门禁：仅好友关系可互发消息（站内信后台专用，不设注册前提；
    // 非好友 → 引导先加好友，加好友须双方完成 Agent World 注册）
    if (!this.deps.friends.areFriends(from, to)) {
      return {
        ok: false,
        reason: "NOT_FRIENDS",
        error:
          "你与对方还不是好友，无法发送站内消息。请先调用 world.link.send_friend_request 发送好友请求（须用户同意），对方接受后再发消息。",
      };
    }

    const fromName = this.displayNameOf(from);

    // 1. 内存中继收件箱（/agent/inbox 兼容面）
    const record = this.deps.relay.postMessage({
      fromSessionId: from,
      toSessionId: to,
      text,
      subject: input.subject,
      traceId: input.traceId,
      chatUserMessageId: input.chatUserMessageId,
    });

    // 2. 接收方 hub 持久入站（gate 已豁免 friend 平台）
    try {
      await this.deps.hub.ingestInbound({
        actorId: to,
        platform: "friend",
        channelId: from,
        text,
        participantId: from,
        participantName: fromName,
        title: `好友 · ${fromName}`,
        senderId: from,
        senderName: fromName,
        externalMessageId: record.messageId,
        meta: { via: "friend_message_service" },
      });
    } catch {
      // hub 未加载等异常不阻断投递：内存收件箱与 WS 直推照常
    }

    // 3. 发送方 hub 留档（代发留痕，outbound 会话由 hub 幂等 upsert）
    try {
      await this.deps.hub.createOutbound({
        actorId: from,
        platform: "friend",
        channelId: to,
        text,
        participantId: to,
        participantName: this.displayNameOf(to),
        title: `好友 · ${this.displayNameOf(to)}`,
        externalMessageId: record.messageId,
        ...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {}),
        meta: { via: "friend_message_service" },
      });
    } catch {
      // 留档失败不阻断投递
    }

    // 5. 双向 lastMessageAt
    try {
      await this.deps.friends.updateLastMessageTime(from, to);
      await this.deps.friends.updateLastMessageTime(to, from);
    } catch {
      // 排序辅助字段，失败不影响投递
    }

    // 4. WS 直推（在线即时送达）
    const pushed = this.deps.wsRegistry.trySend(
      to,
      buildFriendPeerEnvelope(ServerEventType.AgentPeerMessage, {
        messageId: record.messageId,
        fromSessionId: from,
        toSessionId: to,
        fromName,
        text,
        ...(input.subject ? { subject: input.subject } : {}),
        receivedAt: record.createdAt,
        ...(input.chatUserMessageId ? { chatUserMessageId: input.chatUserMessageId } : {}),
      }),
    );

    return {
      ok: true,
      messageId: record.messageId,
      pushedToPeer: pushed,
    };
  }

  /** 好友会话双向记录（客户端聊天面板历史用；时间正序）。 */
  listTranscript(actorId: string, friendActorId: string, limit = 100) {
    const conversationId = `${actorId}::friend::${friendActorId}`;
    return this.deps.hub.listMessages(actorId, conversationId, { limit });
  }

  /** 好友会话未读数（重连补投/角标用）。 */
  unreadCount(actorId: string, friendActorId: string): number {
    const conversation = this.deps.hub.getConversation(
      actorId,
      `${actorId}::friend::${friendActorId}`,
    );
    return conversation?.unreadCount ?? 0;
  }

  /** 标读好友会话（等价 messages.mark_read，HTTP 面用）。 */
  async markRead(actorId: string, friendActorId: string): Promise<boolean> {
    return this.deps.hub.markConversationRead(
      actorId,
      `${actorId}::friend::${friendActorId}`,
    );
  }

  /**
   * 重连补投：好友会话有未读时，把对方「最后一条未读消息」以 AgentPeerMessage
   * 形态重推（payload.replayed=true + unreadFromPeer 计数）。客户端按 messageId
   * 幂等去重，已落库的不再重复提示；hub 未读语义不变（打开面板/标读后清零，
   * 之后不再重推）。
   */
  async replayUnread(actorId: string): Promise<number> {
    const conversations = this.deps.hub.listConversations(actorId, { platform: "friend", limit: 50 });
    let replayed = 0;
    for (const conv of conversations) {
      if ((conv.unreadCount ?? 0) <= 0) continue;
      const messages = this.deps.hub.listMessages(actorId, conv.conversationId, { limit: 10 });
      const lastInbound = [...messages].reverse().find((m) => m.direction === "inbound");
      if (!lastInbound) continue;
      const peer = conv.channelId;
      const pushed = this.deps.wsRegistry.trySend(
        actorId,
        buildFriendPeerEnvelope(ServerEventType.AgentPeerMessage, {
          messageId: lastInbound.messageId,
          fromSessionId: lastInbound.senderId ?? peer,
          toSessionId: actorId,
          fromName: lastInbound.senderName ?? this.displayNameOf(peer),
          text: lastInbound.text,
          receivedAt: lastInbound.createdAt,
          unreadFromPeer: conv.unreadCount,
          replayed: true,
        }),
      );
      if (pushed) replayed += 1;
    }
    return replayed;
  }
}
