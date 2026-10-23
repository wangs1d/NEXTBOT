import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { WorldService } from "@nextbot/agent-world";
import type { FriendRequestRecord, FriendService } from "../../services/friend-service.js";
import type { AgentAccountRecord, AgentAccountService } from "../../services/agent-account-service.js";
import { AGENT_NUMBER_PATTERN } from "../../services/agent-account-service.js";
import type { FriendMessageService } from "../../services/friend-message-service.js";

function accountActorRefine(data: { userId?: string; sessionId?: string }, ctx: z.RefinementCtx): void {
  const u = data.userId?.trim() ?? "";
  const s = data.sessionId?.trim() ?? "";
  if (!u && !s) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "userId 或 sessionId 至少填一项",
      path: ["userId"],
    });
  }
}

/** 发送好友请求 */
const sendFriendRequestSchema = z
  .object({
    userId: z.string().optional(),
    sessionId: z.string().optional(),
    toActorId: z.string().max(254).optional(),
    /** QQ 式身份短号（6-8 位数字）；与 toActorId 二选一，也接受 toActorId 直接填短号 */
    toAgentNumber: z.string().max(20).optional(),
    message: z.string().max(500).optional(),
  })
  .superRefine(accountActorRefine);

/** 响应好友请求 */
const respondFriendRequestSchema = z
  .object({
    userId: z.string().optional(),
    sessionId: z.string().optional(),
    requestId: z.string().min(1),
    accept: z.boolean(),
  })
  .superRefine(accountActorRefine);

/** 取消好友请求 */
const cancelFriendRequestSchema = z
  .object({
    userId: z.string().optional(),
    sessionId: z.string().optional(),
    requestId: z.string().min(1),
  })
  .superRefine(accountActorRefine);

/** 查询参数 */
const friendQuerySchema = z
  .object({
    userId: z.string().optional(),
    sessionId: z.string().optional(),
  })
  .superRefine(accountActorRefine);

/** 自动同意开关 */
const autoAcceptSchema = z
  .object({
    userId: z.string().optional(),
    sessionId: z.string().optional(),
    enabled: z.boolean(),
  })
  .superRefine(accountActorRefine);

/** 发现/搜索 */
const discoverQuerySchema = friendQuerySchema.and(
  z.object({
    q: z.string().max(100).optional(),
    limit: z.coerce.number().int().min(1).max(50).optional(),
  })
);

/** 好友消息直连发送（聊天面板） */
const sendFriendMessageSchema = z
  .object({
    userId: z.string().optional(),
    sessionId: z.string().optional(),
    toActorId: z.string().min(1).max(254),
    text: z.string().min(1).max(4000),
  })
  .superRefine(accountActorRefine);

/** 好友消息历史/标读查询参数 */
const friendMessageTargetSchema = friendQuerySchema.and(
  z.object({
    targetActorId: z.string().min(1).max(254),
  })
);

const friendMessageQuerySchema = friendMessageTargetSchema.and(
  z.object({
    limit: z.coerce.number().int().min(1).max(200).optional(),
    /** 增量拉取游标：只返回会话内 seq > sinceSeq 的消息（断线补拉/实时追平用） */
    sinceSeq: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  })
);

function accountActorFromBody(data: { userId?: string; sessionId?: string }): string {
  const u = data.userId?.trim() ?? "";
  const s = data.sessionId?.trim() ?? "";
  return u || s;
}

/**
 * 好友展示名：只有「用户真正起过的昵称」才直接展示。
 * 注册时自动派生自邮箱/实例 id 的占位名（等于账号 id 或邮箱 @ 前缀）不算昵称——
 * 添加好友的凭证是注册即得的身份号码（不是邮箱），所以这类情况回退到身份号码。
 */
function friendDisplayName(account: AgentAccountRecord | undefined, actorId: string): string {
  const name = account?.displayName?.trim() ?? "";
  const localPart = (actorId.includes("@") ? actorId.split("@")[0] : actorId).toLowerCase();
  const isDerivedPlaceholder =
    !name || name.toLowerCase() === actorId.toLowerCase() || name.toLowerCase() === localPart;
  if (!isDerivedPlaceholder) return name;
  return account?.agentNumber?.trim() || name || actorId;
}

/**
 * 给好友请求补上「对方」的账号资料（昵称 / 身份短号 / 邮箱），供客户端显示。
 * 对方以身份短号添加时，请求里存的是登录主体（邮箱形态主体就是邮箱地址）；
 * 客户端直接渲染 fromActorId/toActorId 会把邮箱当名字显示，故在服务端统一解析。
 */
function enrichRequestsWithAccount(
  agentAccountService: AgentAccountService,
  actorId: string,
  requests: FriendRequestRecord[],
): Array<Record<string, unknown>> {
  return requests.map((r) => {
    const counterpart = r.fromActorId === actorId ? r.toActorId : r.fromActorId;
    const account = agentAccountService.getByActorId(counterpart);
    return {
      ...r,
      displayName: friendDisplayName(account, counterpart),
      agentNumber: account?.agentNumber ?? null,
      email: account?.email ?? null,
    };
  });
}


/**
 * 解析好友申请目标：toActorId 优先（先按登录主体精确查）；
 * 未命中且形如短号（或显式传了 toAgentNumber）时按身份短号反查。
 * 返回目标 actorId（登录主体 userId）；解析不到返回 undefined。
 */
function resolveTargetActorId(
  agentAccountService: AgentAccountService,
  rawToActorId: string | undefined,
  toAgentNumber: string | undefined,
): string | undefined {
  const raw = rawToActorId?.trim() ?? "";
  if (raw) {
    const direct = agentAccountService.getByActorId(raw);
    if (direct) return direct.userId;
  }
  const num = toAgentNumber?.trim() || raw;
  if (num && AGENT_NUMBER_PATTERN.test(num)) {
    return agentAccountService.getByAgentNumber(num)?.userId;
  }
  return raw || undefined;
}

export function registerFriendRoutes(
  app: FastifyInstance,
  deps: {
    friendService: FriendService;
    agentAccountService: AgentAccountService;
    friendMessageService?: FriendMessageService;
    worldService: WorldService;
  }
): void {
  const { friendService, agentAccountService, friendMessageService, worldService } = deps;

  /**
   * 发送好友请求
   * POST /friends/request
   */
  app.post("/friends/request", async (request, reply) => {
    const parsed = sendFriendRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }

    const fromActorId = accountActorFromBody(parsed.data);
    // 发起方必须已有 Agent World 身份（与 world.link.send_friend_request 工具面同口径）
    if (fromActorId && !worldService.isAgentWorldRegistered(fromActorId)) {
      return reply.code(403).send({
        ok: false,
        code: "WORLD_REGISTRATION_REQUIRED",
        message:
          "当前登录主体还没有 Agent World 身份，无法发起好友请求；请先完成世界注册（world.open_registry.agent_quick 或 POST /world/register/agent_quick）",
      });
    }
    const toActorId = resolveTargetActorId(
      agentAccountService,
      parsed.data.toActorId,
      parsed.data.toAgentNumber,
    );
    if (!toActorId) {
      return reply.code(400).send({ ok: false, message: "缺少目标：请填 toActorId 或 toAgentNumber（对方身份号码）" });
    }

    // 检查目标是否已有 Agent World 身份
    if (!worldService.isAgentWorldRegistered(toActorId)) {
      return reply.code(404).send({ ok: false, message: "目标尚未完成 Agent World 注册，无法添加好友" });
    }

    const result = await friendService.sendFriendRequest(
      fromActorId,
      toActorId,
      parsed.data.message
    );

    if (!result.ok) {
      return reply.code(400).send({ ok: false, message: result.reason });
    }

    return { ok: true, request: result.request };
  });

  /**
   * 响应好友请求（接受/拒绝）
   * POST /friends/request/respond
   */
  app.post("/friends/request/respond", async (request, reply) => {
    const parsed = respondFriendRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }

    const responderActorId = accountActorFromBody(parsed.data);
    const result = await friendService.respondToRequest(
      parsed.data.requestId,
      responderActorId,
      parsed.data.accept
    );

    if (!result.ok) {
      return reply.code(400).send({ ok: false, message: result.reason });
    }

    return { ok: true, request: result.request };
  });

  /**
   * 取消好友请求
   * POST /friends/request/cancel
   */
  app.post("/friends/request/cancel", async (request, reply) => {
    const parsed = cancelFriendRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }

    const requesterActorId = accountActorFromBody(parsed.data);
    const result = await friendService.cancelRequest(
      parsed.data.requestId,
      requesterActorId
    );

    if (!result.ok) {
      return reply.code(400).send({ ok: false, message: result.reason });
    }

    return { ok: true };
  });

  /**
   * 获取 incoming 好友请求（别人发给我的）
   * GET /friends/requests/incoming
   */
  app.get("/friends/requests/incoming", async (request, reply) => {
    const parsed = friendQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }

    const actorId = accountActorFromBody(parsed.data);
    const requests = friendService.getIncomingRequests(actorId);

    return { ok: true, requests: enrichRequestsWithAccount(agentAccountService, actorId, requests) };
  });

  /**
   * 获取 outgoing 好友请求（我发给别人的）
   * GET /friends/requests/outgoing
   */
  app.get("/friends/requests/outgoing", async (request, reply) => {
    const parsed = friendQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }

    const actorId = accountActorFromBody(parsed.data);
    const requests = friendService.getOutgoingRequests(actorId);

    return { ok: true, requests: enrichRequestsWithAccount(agentAccountService, actorId, requests) };
  });

  /**
   * 获取所有好友请求历史
   * GET /friends/requests/all
   */
  app.get("/friends/requests/all", async (request, reply) => {
    const parsed = friendQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }

    const actorId = accountActorFromBody(parsed.data);
    const requests = friendService.getAllRequests(actorId);

    return { ok: true, requests: enrichRequestsWithAccount(agentAccountService, actorId, requests) };
  });

  /**
   * 获取好友列表
   * GET /friends/list
   */
  app.get("/friends/list", async (request, reply) => {
    const parsed = friendQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }

    const actorId = accountActorFromBody(parsed.data);
    const friends = friendService.getFriends(actorId);

    // 为每个好友添加账号信息（展示名走 friendDisplayName：无真昵称时用身份号码，不用邮箱）
    const friendsWithDetails = friends.map((f: any) => {
      const account = agentAccountService.getByActorId(f.friendActorId);
      return {
        ...f,
        displayName: friendDisplayName(account, f.friendActorId),
        email: account?.email ?? null,
        agentNumber: account?.agentNumber ?? null,
      };
    });

    return { ok: true, friends: friendsWithDetails };
  });

  /**
   * 检查好友关系
   * GET /friends/check
   */
  app.get("/friends/check", async (request, reply) => {
    const parsed = friendQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }

    const actorId = accountActorFromBody(parsed.data);
    const query = request.query as Record<string, unknown>;
    const targetRaw = String(query.targetActorId ?? "").trim();
    const targetAgentNumber = String(query.targetAgentNumber ?? "").trim();

    const targetActorId = resolveTargetActorId(
      agentAccountService,
      targetRaw || undefined,
      targetAgentNumber || undefined,
    );

    if (!targetActorId) {
      return reply.code(400).send({ ok: false, message: "缺少 targetActorId 参数" });
    }

    const areFriends = friendService.areFriends(actorId, targetActorId);
    return { ok: true, areFriends };
  });

  /**
   * 查询本 actor 的好友请求自动同意开关
   * GET /friends/auto-accept
   */
  app.get("/friends/auto-accept", async (request, reply) => {
    const parsed = friendQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }

    const actorId = accountActorFromBody(parsed.data);
    return { ok: true, autoAccept: friendService.isAutoAccept(actorId) };
  });

  /**
   * 设置本 actor 的好友请求自动同意开关。
   * agent 好友（服务端托管、无人手动响应）打开后即可被其他用户直接添加。
   * POST /friends/auto-accept
   */
  app.post("/friends/auto-accept", async (request, reply) => {
    const parsed = autoAcceptSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }

    const actorId = accountActorFromBody(parsed.data);
    friendService.setAutoAccept(actorId, parsed.data.enabled);
    return { ok: true, autoAccept: parsed.data.enabled };
  });

  /**
   * 发现/搜索可添加的用户（按昵称 / id / 邮箱子串匹配，q 为空时按最近注册浏览）。
   * 每个结果标注与当前用户的好友关系状态及对方是否开启了自动同意。
   * GET /friends/discover
   */
  app.get("/friends/discover", async (request, reply) => {
    const parsed = discoverQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }

    const actorId = accountActorFromBody(parsed.data);
    const accounts = agentAccountService.searchAccounts({
      q: parsed.data.q,
      limit: parsed.data.limit,
      excludeActorId: actorId,
    });

    const results = accounts.map((a) => ({
      actorId: a.userId,
      displayName: a.displayName,
      email: a.email ?? null,
      agentNumber: a.agentNumber ?? null,
      createdAt: a.createdAt,
      friendship: friendService.friendshipStatus(actorId, a.userId),
      autoAccept: friendService.isAutoAccept(a.userId),
    }));

    return { ok: true, results };
  });

  /**
   * 好友消息历史（双向，时间正序；hub platform=friend 会话的 HTTP 面）。
   * GET /friends/messages?userId|sessionId&targetActorId&limit&sinceSeq
   * sinceSeq 传上次收到的最大 seq 即只拉增量（seq 缺省时全量拉最近 limit 条）。
   */
  app.get("/friends/messages", async (request, reply) => {
    const parsed = friendMessageQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    if (!friendMessageService) {
      return reply.code(503).send({ ok: false, message: "站内好友消息通道未装配" });
    }
    const actorId = accountActorFromBody(parsed.data);
    const messages = friendMessageService.listTranscript(
      actorId,
      parsed.data.targetActorId.trim(),
      parsed.data.limit ?? 100,
      parsed.data.sinceSeq,
    );
    const unreadCount = friendMessageService.unreadCount(actorId, parsed.data.targetActorId.trim());
    return { ok: true, messages, unreadCount };
  });

  /**
   * 好友消息直连发送（好友聊天面板；与 world.link.send_message 同一投递内核）。
   * POST /friends/messages
   */
  app.post("/friends/messages", async (request, reply) => {
    const parsed = sendFriendMessageSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    if (!friendMessageService) {
      return reply.code(503).send({ ok: false, message: "站内好友消息通道未装配" });
    }
    const fromActorId = accountActorFromBody(parsed.data);
    const toActorId = resolveTargetActorId(
      agentAccountService,
      parsed.data.toActorId,
      undefined,
    );
    if (!toActorId || !agentAccountService.getByActorId(toActorId)) {
      return reply.code(404).send({ ok: false, message: "目标用户不存在" });
    }
    const result = await friendMessageService.send({
      fromActorId,
      toActorId,
      text: parsed.data.text,
    });
    if (!result.ok) {
      return reply.code(400).send({ ok: false, message: result.error });
    }
    return {
      ok: true,
      messageId: result.messageId,
      pushedToPeer: result.pushedToPeer,
      // 发送方会话内序号：客户端本地气泡带真 seq，后续增量拉取按它去重
      ...(result.outboundSeq != null ? { seq: result.outboundSeq } : {}),
    };
  });

  /**
   * 好友会话标读（打开聊天面板后调用；清 hub 未读，重连补投随之停止）。
   * POST /friends/messages/read
   */
  app.post("/friends/messages/read", async (request, reply) => {
    const parsed = friendMessageTargetSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    if (!friendMessageService) {
      return reply.code(503).send({ ok: false, message: "站内好友消息通道未装配" });
    }
    const actorId = accountActorFromBody(parsed.data);
    const ok = await friendMessageService.markRead(actorId, parsed.data.targetActorId.trim());
    return { ok };
  });
}
