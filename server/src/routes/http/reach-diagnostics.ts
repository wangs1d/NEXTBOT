import type { FastifyInstance } from "fastify";

import { requireAdmin } from "./admin-auth.js";
import type { HttpRouteDeps } from "./types.js";

/**
 * 期望效用触达决策层诊断端点。
 *
 * - GET /api/reach/config                          配置快照（公开，无用户数据）
 * - GET /api/admin/reach/diagnostics?actorId=&kind=&action=&limit=50
 *       决策统计 + 最近决策（逐通道 cost/utility/p/reason），仅本机管理端
 *
 * 未装配 ReachDecisionService 时两个端点均不挂载（404），不影响其他路由。
 */
export function registerReachDiagnosticsRoutes(app: FastifyInstance, deps: HttpRouteDeps): void {
  const svc = deps.reachDecisionService;
  if (!svc) return;

  app.get("/api/reach/config", async () => {
    const { config } = svc.diagnostics({ limit: 0 });
    return { ok: true, config };
  });

  app.get("/api/admin/reach/diagnostics", { preHandler: requireAdmin }, async (req, reply) => {
    const q = req.query as { actorId?: string; kind?: string; action?: string; limit?: string };
    const rawLimit = q.limit ? Number.parseInt(q.limit, 10) : 50;
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 200) : 50;
    const action = q.action;
    const diagnostics = svc.diagnostics({
      ...(q.actorId ? { actorId: q.actorId } : {}),
      ...(q.kind ? { kind: q.kind } : {}),
      ...(action === "send_now" || action === "defer" || action === "batch" || action === "drop"
        ? { action }
        : {}),
      limit,
    });
    return reply.send(diagnostics);
  });
}
