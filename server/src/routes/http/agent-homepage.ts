// Agent 主页数据聚合 API：
//   GET /api/agent-homepage  — 主页全量（header 档案 + 自己的动态）
//   GET /api/agent-now       — 右上角足迹卡轻量块（盯着 + 最近足迹），挂载/轮询/推送后重拉
//
// 数据源全部复用现有服务，不新增存储：
//   档案/签名                    → user-preferences agentProfile（agent.update_homepage 维护）
//   盯着（进行时）               → CommitmentBoard active 承诺
//   最近足迹（完成时）           → AgentActivityStore
//   动态                         → SocialFeedService 里 authorSessionId == 自己的帖子
import type { FastifyInstance } from "fastify";

import type { CommitmentBoard } from "../../agentic-memory/commitment-board.js";
import type { WsConnectionRegistry } from "../../services/ws-connection-registry.js";
import {
  AGENT_NAME_KV_KEY,
  parseAgentIdentityKv,
} from "../../services/agent-identity.js";
import type { AgentMemorySyncService } from "../../services/agent-memory-sync-service.js";
import type { AgentAccountService } from "../../services/agent-account-service.js";
import type { AgentActivityStore } from "../../proactivity/activity-store.js";
import type { SocialFeedService } from "@private-ai-agent/agent-world";
import { getUserPreferences } from "./user-preferences.js";
import {
  applyAgentHomepagePatch,
  applyAgentIdentityRename,
  type AgentIdentityToolDeps,
} from "../../tools/agent-identity-tools.js";

export type AgentHomepageRouteDeps = {
  agentActivityStore: AgentActivityStore;
  agentMemorySyncService: AgentMemorySyncService;
  socialFeedService: SocialFeedService;
  agentAccountService: AgentAccountService;
  /** 承诺板（未启用时「盯着」小节为空，端点不报错） */
  commitmentBoard?: CommitmentBoard | null;
  wsConnectionRegistry?: WsConnectionRegistry | null;
};

function resolveActorIdFromQuery(sessionId?: string, userId?: string): string {
  return (userId ?? sessionId ?? "").trim();
}

/** 「盯着」小节：承诺板 active 承诺，带下次复核时间（deadline 升序，最多 max 条） */
function watchingCommitments(
  deps: AgentHomepageRouteDeps,
  actorId: string,
  max: number,
): Array<{ id: string; text: string; deadline: string | null; category: string | null }> {
  if (!deps.commitmentBoard) return [];
  try {
    return deps.commitmentBoard
      .list({ actorId, status: ["active"], limit: 50 })
      .sort((a, b) => (a.deadline ?? "9999").localeCompare(b.deadline ?? "9999"))
      .slice(0, max)
      .map((c) => ({
        id: c.id,
        text: c.text.slice(0, 120),
        deadline: c.deadline,
        category: c.category,
      }));
  } catch {
    return [];
  }
}

/** 最近足迹（完成时）：activity-store 倒序前 max 条 */
function recentActivities(deps: AgentHomepageRouteDeps, actorId: string, max: number) {
  return deps.agentActivityStore.list(actorId, max).map((a) => ({
    id: a.id,
    kind: a.kind,
    category: a.category,
    title: a.title,
    summary: a.summary,
    status: a.status,
    statusLabel: a.statusLabel ?? null,
    createdAt: a.createdAt,
    readAt: a.readAt,
  }));
}

/** 主页动态：站内社交里 Agent 自己发的帖子（置顶帖排最前） */
function ownPosts(
  deps: AgentHomepageRouteDeps,
  actorId: string,
  max: number,
  pinnedPostId: string | null,
) {
  try {
    const { feed } = deps.socialFeedService.getFeedForViewer(actorId, 200);
    const posts = Array.isArray(feed.posts) ? feed.posts : [];
    const own = posts.filter(
      (p) => (p as { isOwnAgent?: boolean }).isOwnAgent === true,
    ) as Array<Record<string, unknown>>;
    const pinned = pinnedPostId
      ? own.filter((p) => p.id === pinnedPostId)
      : [];
    const rest = pinnedPostId ? own.filter((p) => p.id !== pinnedPostId) : own;
    return [...pinned, ...rest].slice(0, max);
  } catch {
    return [];
  }
}

export function registerAgentHomepageRoutes(
  app: FastifyInstance,
  deps: AgentHomepageRouteDeps,
): void {
  // 右栏预览卡轻量端点：只回「此刻」块（盯着 + 最近足迹），高频轮询用
  app.get("/api/agent-now", async (request) => {
    const q = request.query as { sessionId?: string; userId?: string; watchingLimit?: string };
    const actorId = resolveActorIdFromQuery(q.sessionId, q.userId);
    if (!actorId) {
      return { ok: false, error: "sessionId required", watching: [], recent: [] };
    }
    const watchingLimit = Math.min(Math.max(Number(q.watchingLimit ?? 3), 0), 10);
    return {
      ok: true,
      watching: watchingCommitments(deps, actorId, watchingLimit),
      recent: recentActivities(deps, actorId, 5),
    };
  });

  // 主页全量
  app.get("/api/agent-homepage", async (request) => {
    const q = request.query as { sessionId?: string; userId?: string };
    const actorId = resolveActorIdFromQuery(q.sessionId, q.userId);
    if (!actorId) {
      return { ok: false, error: "sessionId required" };
    }
    const prefs = getUserPreferences(actorId);
    const profile = prefs.agentProfile;
    const identityRaw = deps.agentMemorySyncService
      .getSnapshot(actorId, [AGENT_NAME_KV_KEY])
      .entries[AGENT_NAME_KV_KEY];
    const identity = parseAgentIdentityKv(identityRaw);

    return {
      ok: true,
      profile,
      // QQ 式身份短号（注册即得；旧账号 load 时补号）。客户端主页展示+复制，
      // 是好友申请的对外凭据；无账号主体（session 身份）为 null，客户端回退 actorId。
      agentNumber: deps.agentAccountService.getByActorId(actorId)?.agentNumber ?? null,
      // KV 里的名字档案优先（agent.update_identity 维护）；没有时回退 prefs
      identity: identity ?? {
        displayName: profile.displayName,
        handle: profile.handle,
        origin: profile.nameOrigin,
        updatedAt: profile.updatedAt ?? new Date().toISOString(),
      },
      posts: ownPosts(deps, actorId, 20, profile.pinnedPostId),
    };
  });

  // 用户驱动的改名：与 agent.update_identity 工具走同一条统一管道
  // （账号 + 记忆 KV + prefs + 叙事记忆 + WS 广播一次完成，不产生漂移）
  app.post("/api/agent-identity/rename", async (request, reply) => {
    const body = request.body as {
      sessionId?: string;
      userId?: string;
      displayName?: string;
      handle?: string;
      reason?: string;
      origin?: string;
    };
    const actorId = resolveActorIdFromQuery(body.sessionId, body.userId);
    if (!actorId) return reply.code(400).send({ ok: false, error: "sessionId required" });
    if (!body.displayName?.trim()) {
      return reply.code(400).send({ ok: false, error: "displayName required" });
    }
    try {
      const identityDeps: AgentIdentityToolDeps = {
        accounts: deps.agentAccountService,
        memorySync: deps.agentMemorySyncService,
        wsRegistry: deps.wsConnectionRegistry ?? null,
      };
      const result = await applyAgentIdentityRename(identityDeps, actorId, {
        displayName: body.displayName,
        ...(body.handle ? { handle: body.handle } : {}),
        ...(body.reason ? { reason: body.reason } : {}),
        origin: "user",
      });
      return { ...result, ok: true };
    } catch (e) {
      return reply.code(400).send({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });

  // 用户驱动的主页文案编辑（签名/状态/置顶），与 agent.update_homepage 同管道
  app.post("/api/agent-homepage/patch", async (request, reply) => {
    const body = request.body as {
      sessionId?: string;
      userId?: string;
      signature?: string;
      statusText?: string;
      pinnedPostId?: string | null;
    };
    const actorId = resolveActorIdFromQuery(body.sessionId, body.userId);
    if (!actorId) return reply.code(400).send({ ok: false, error: "sessionId required" });
    const patch: Record<string, unknown> = {};
    if (body.signature !== undefined) patch.signature = String(body.signature);
    if (body.statusText !== undefined) patch.statusText = String(body.statusText);
    if (body.pinnedPostId !== undefined) {
      const pinned = body.pinnedPostId === null ? "" : String(body.pinnedPostId);
      patch.pinnedPostId = pinned.trim() || null;
    }
    try {
      const identityDeps: AgentIdentityToolDeps = {
        accounts: deps.agentAccountService,
        memorySync: deps.agentMemorySyncService,
        wsRegistry: deps.wsConnectionRegistry ?? null,
      };
      const result = applyAgentHomepagePatch(identityDeps, actorId, patch);
      return { ...result, ok: true };
    } catch (e) {
      return reply.code(400).send({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });
}
