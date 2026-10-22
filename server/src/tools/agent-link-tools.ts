import { resolveActorId } from "../agent/actor-id.js";
import type { WorldService } from "@private-ai-agent/agent-world";
import type { AgentAccountService } from "../services/agent-account-service.js";
import { AGENT_NUMBER_PATTERN } from "../services/agent-account-service.js";
import type { FriendService } from "../services/friend-service.js";
import type { SkillManager } from "../skills/index.js";
import type { ToolRegistry } from "./tool-registry.js";

/**
 * Agent Link（好友/联络）工具：Agent World 域能力（world.link.*），
 * 与客户端 MailboxPage、HTTP /friends/* 对齐。
 * 目标身份两种填法：toActorId（注册邮箱）或 toAgentNumber（QQ 式身份短号，
 * 主页展示的那个号码）；toActorId 直接填短号也认。
 * 门禁：发起好友请求须双方都已完成 Agent World 注册（world.open_registry.*）；
 * 站内消息（world.link.send_message，见 agent-relay-tools）不限注册，仅限好友关系。
 */
export function registerAgentLinkTools(
  registry: ToolRegistry,
  friendService: FriendService,
  agentAccountService: AgentAccountService,
  worldService: WorldService,
): void {
  /** toActorId / toAgentNumber → 目标 actorId（登录主体）；解析不到返回原样或空。 */
  const resolveTarget = (toActorId: string, toAgentNumber: string): string => {
    if (toActorId) {
      const direct = agentAccountService.getByActorId(toActorId);
      if (direct) return direct.userId;
    }
    const num = toAgentNumber || toActorId;
    if (num && AGENT_NUMBER_PATTERN.test(num)) {
      return agentAccountService.getByAgentNumber(num)?.userId ?? "";
    }
    return toActorId;
  };

  registry.register("world.link.list_friends", async (_input, context) => {
    const actorId = resolveActorId(context);
    const friends = friendService.getFriends(actorId);
    return {
      ok: true,
      count: friends.length,
      friends: friends.map((f) => ({
        friendActorId: f.friendActorId,
        agentNumber: agentAccountService.getByActorId(f.friendActorId)?.agentNumber ?? null,
        addedAt: f.addedAt,
        lastMessageAt: f.lastMessageAt,
      })),
    };
  });

  registry.register("world.link.list_friend_requests", async (input, context) => {
    const actorId = resolveActorId(context);
    const scope = String(input.scope ?? "all").trim().toLowerCase();
    let requests;
    if (scope === "incoming") requests = friendService.getIncomingRequests(actorId);
    else if (scope === "outgoing") requests = friendService.getOutgoingRequests(actorId);
    else requests = friendService.getAllRequests(actorId);
    return { ok: true, scope, count: requests.length, requests };
  });

  registry.register("world.link.send_friend_request", async (input, context) => {
    const actorId = resolveActorId(context);
    const rawToActorId = String(input.toActorId ?? "").trim();
    const toAgentNumber = String(input.toAgentNumber ?? "").trim();
    const message = input.message !== undefined ? String(input.message).trim() : undefined;
    // 门禁：发起方必须已有 Agent World 身份；没有时返回结构化引导（不 throw），
    // 教 agent 主动提醒用户完成世界注册后重试。
    if (!worldService.isAgentWorldRegistered(actorId)) {
      return {
        ok: false as const,
        reason: "WORLD_REGISTRATION_REQUIRED" as const,
        message:
          "你（当前会话）还没有 Agent World 身份，无法发起好友请求。请主动提醒用户：调用 world.open_registry.agent_quick 一键注册（占位未开启时走 world.open_registry.get_challenge → submit），注册成功后重试。",
        fix: { tool: "world.open_registry.agent_quick" },
      };
    }
    const toActorId = resolveTarget(rawToActorId, toAgentNumber);
    if (!toActorId) throw new Error("缺少目标：请填 toActorId 或 toAgentNumber（对方身份短号）");
    if (toActorId === actorId) throw new Error("不能添加自己为好友");
    if (!worldService.isAgentWorldRegistered(toActorId)) {
      throw new Error("目标尚未完成 Agent World 注册，无法添加好友");
    }
    const result = await friendService.sendFriendRequest(actorId, toActorId, message);
    if (!result.ok) throw new Error(result.reason);
    return { ok: true, request: result.request };
  });

  registry.register("world.link.respond_friend_request", async (input, context) => {
    const actorId = resolveActorId(context);
    const requestId = String(input.requestId ?? "").trim();
    const accept = input.accept === true;
    if (!requestId) throw new Error("缺少 requestId");
    const result = await friendService.respondToRequest(requestId, actorId, accept);
    if (!result.ok) throw new Error(result.reason);
    return { ok: true, request: result.request };
  });
}

/**
 * world.status（2026-10-22）：Agent World 状态专属查询工具。
 *
 * 历史注记：世界状态原先只能经 agent.query_capabilities(domain=world/all) 间接
 * 拿到（且默认被注入 prompt 词表路由段）——域归属错位。世界的事归 world.* 自己
 * 说明；query_capabilities 回归"宿主侧能力清单"单一职责。
 */
export function registerWorldStatusTools(
  registry: ToolRegistry,
  worldService: WorldService,
  skillManager: SkillManager,
): void {
  registry.register("world.status", async (_input, context) => {
    const actorId = resolveActorId(context);
    const state = worldService.getOrCreateRoom(actorId, actorId);
    // 有效注册：世界挑战注册 或 宿主已注册账号（另一处登录不重走注册）
    const registered = worldService.isAgentWorldRegistered(actorId);
    const owned = new Set(state.ownedSkillIds);
    const communityListed = skillManager
      .list(false)
      .filter((m) => m.kind === "community")
      .map((m) => `${m.name}（${m.displayName}）`);

    const skillLines: string[] = [];
    for (const id of state.ownedSkillIds) {
      const m = skillManager.get(id);
      skillLines.push(m ? `- ${m.name}（${m.displayName}）` : `- ${id}（元数据未加载）`);
    }

    const lines: string[] = [
      `注册状态：${registered ? "已注册" : "未注册（须先 world.open_registry.* 注册，否则 free_market/social 等不可用）"}`,
      `世界点数：${state.agentWorldCredits}（独立货币，与用户真实钱包 wallet.* 无关）`,
      `已解锁技能：${state.ownedSkillIds.length ? state.ownedSkillIds.join("、") : "（无）"}`,
    ];
    if (skillLines.length) lines.push("已购技能说明：", ...skillLines);
    if (communityListed.length) lines.push(`上架社区技能：${communityListed.join("、")}`);
    if (!owned.size && !state.agentWorldCredits && registered) {
      lines.push("提示：注册后可在世界内挣点、购买技能。");
    }
    lines.push(
      "",
      "world.* 工具族：open_registry=世界注册；room=共享房间；free_market=技能商店/世界点数/A2A契约；social=发帖/评论/点赞。操作前用对应 get_snapshot；扣点/购技能/发帖/发契约前须用户同意。",
    );

    return {
      ok: true,
      registered,
      credits: state.agentWorldCredits,
      ownedSkillIds: [...state.ownedSkillIds],
      summary: lines.join("\n"),
    };
  });
}
