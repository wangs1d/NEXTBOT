import { resolveActorId } from "../agent/actor-id.js";
import type { AgentPairingService } from "../services/agent-pairing-service.js";
import { relayRequiresPairEnv } from "../services/agent-pairing-service.js";
import type { FriendMessageService } from "../services/friend-message-service.js";
import type { AgentAccountService } from "../services/agent-account-service.js";
import type { ToolRegistry } from "./tool-registry.js";

export function registerAgentRelayTools(
  registry: ToolRegistry,
  friendMessages: FriendMessageService,
  pairing: AgentPairingService,
  agentAccountService?: AgentAccountService,
): void {
  registry.register("world.link.send_message", async (input, context) => {
    let targetSessionId = String(input.targetSessionId ?? "").trim();
    const body = String(input.body ?? "").trim();
    const subject =
      input.subject !== undefined && input.subject !== null
        ? String(input.subject).trim()
        : undefined;
    if (!targetSessionId) {
      throw new Error("缺少 targetSessionId");
    }
    if (!body) {
      throw new Error("缺少 body");
    }
    // QQ 式身份短号直发：纯数字目标先按登录主体查，未命中且形如短号则按号反查
    // （与 /friends/* 与 world.link 的解析同口径；actorId 优先保证数字形态的
    // 旧 sessionId 不被误吸走）。
    if (agentAccountService) {
      const direct = agentAccountService.getByActorId(targetSessionId);
      if (direct) {
        targetSessionId = direct.userId;
      } else if (/^[1-9]\d{5,7}$/.test(targetSessionId)) {
        const byNumber = agentAccountService.getByAgentNumber(targetSessionId);
        if (byNumber) targetSessionId = byNumber.userId;
      }
    }
    const actorId = resolveActorId(context);
    if (targetSessionId === actorId) {
      throw new Error("不能向自己的 session 发中继消息");
    }

    if (relayRequiresPairEnv() && !pairing.arePaired(actorId, targetSessionId)) {
      throw new Error(
        "中继已要求配对：请双方先使用相同配对码调用 POST /agent/pair，或设置环境变量 AGENT_RELAY_REQUIRE_PAIR=0（仅开发环境）。",
      );
    }

    // 投递统一走 FriendMessageService：内存中继 + 接收方 hub 持久入站 +
    // 发送方 hub 留档 + WS 直推（含 fromName）+ lastMessageAt 双向刷新。
    const result = await friendMessages.send({
      fromActorId: actorId,
      toActorId: targetSessionId,
      text: body,
      subject: subject || undefined,
      traceId: typeof input.traceId === "string" ? input.traceId : undefined,
      chatUserMessageId: context.chatUserMessageId,
    });
    if (!result.ok) {
      // 结构化失败（含门禁 reason），与 world.link.send_friend_request 同口径，
      // 让 LLM 能按 reason 引导用户（注册账号 / 先加好友）
      return {
        ok: false as const,
        ...(result.reason ? { reason: result.reason } : {}),
        message: result.error,
      };
    }

    return {
      ok: true,
      messageId: result.messageId,
      toSessionId: targetSessionId,
      pushedToPeer: result.pushedToPeer,
      summary: result.pushedToPeer
        ? "已投递并推送给对方在线连接"
        : "已持久写入对方收件箱与消息中心（对方当前离线，上线后会补投提醒）",
    };
  });
}
