import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";

import type { ToolContext } from "../../tools/tool-registry.js";
import type { ShoppingCompareService } from "../../services/shopping-compare-service.js";
import {
  getShoppingDecisionPage,
  recordShoppingDecisionPage,
} from "../../services/shopping-decision-store.js";

/**
 * 商品决策页路由（比价卡 →「打开比价决策页」链路）。
 *
 * 模式与 travel-map 完全同构（自包含 HTML + 内存载荷 + 同源取数）：
 * - 页面本体 server/web/shopping/decision-page.html（自包含，无外部依赖）；
 * - 比价完成时 ShoppingCompareService.onCompareResult →
 *   recordShoppingDecisionPage 存载荷，比价回执携带 decisionPageUrl；
 * - 页面 GET ?id= 加载后同源取回 /shopping/decision-pages/:id 渲染。
 *
 * HTML 为纯静态自包含资源（数据异步取），可长缓存；载荷 24h 过期，
 * 过期后页面显示「比价结果已过期，请在聊天里重新比价」的兜底。
 */

const webRoot = join(import.meta.dirname ?? ".", "../../../web/shopping");

export function registerShoppingDecisionRoutes(
  app: FastifyInstance,
  deps?: { shoppingCompareService?: ShoppingCompareService },
): void {
  /** GET /shopping/decision-page — 决策页（自包含 HTML，按 ?id= 异步取数） */
  app.get("/shopping/decision-page", async (_req, reply) => {
    reply.header("Cache-Control", "private, max-age=86400");
    reply.type("text/html; charset=utf-8");
    const file = join(webRoot, "decision-page.html");
    if (!existsSync(file)) {
      return reply.code(500).send("decision-page.html missing");
    }
    return readFileSync(file, "utf8");
  });

  /**
   * POST /shopping/compare — 只读触发一次跨平台比价（shopping.compare.prices
   * 工具同源同权限级：全部只读，无订单/支付副作用；Cookie 门禁在
   * ShoppingOrderService 内不因 HTTP 直调而放宽）。成功回执自动存档决策页
   * （经 onCompareResult），并携带 decisionPageUrl。
   */
  app.post("/shopping/compare", async (req, reply) => {
    const service = deps?.shoppingCompareService;
    if (!service) return reply.code(503).send({ ok: false, error: "比价服务未装配" });
    const body = (req.body ?? {}) as {
      query?: unknown;
      platforms?: unknown;
      actorId?: unknown;
      limit?: unknown;
    };
    const query = typeof body.query === "string" ? body.query.trim() : "";
    if (!query) return reply.code(400).send({ ok: false, error: "query is required" });
    const platforms = Array.isArray(body.platforms)
      ? body.platforms.filter((p): p is string => typeof p === "string")
      : undefined;
    const actorId =
      typeof body.actorId === "string" && body.actorId.trim()
        ? body.actorId.trim()
        : "http-direct";
    const limit = typeof body.limit === "number" && Number.isFinite(body.limit)
      ? Math.max(1, Math.min(10, Math.floor(body.limit)))
      : undefined;
    const ctx: ToolContext = { sessionId: `http-compare-${Date.now()}`, userId: actorId };
    reply.header("Cache-Control", "no-store");
    return reply.send(
      await service.comparePrices(ctx, query, {
        ...(platforms ? { platforms } : {}),
        ...(limit ? { limit } : {}),
      }),
    );
  });

  /** POST /shopping/decision-pages — 直投比价载荷（测试/客户端直传用），返回取数 id */
  app.post("/shopping/decision-pages", async (req, reply) => {
    const body = req.body as unknown;
    if (!body || typeof body !== "object") {
      return reply.code(400).send({ error: "payload must be a JSON object" });
    }
    const payload = body as { query?: unknown };
    if (typeof payload.query !== "string" || !payload.query.trim()) {
      return reply.code(400).send({ error: "query is required" });
    }
    const id = recordShoppingDecisionPage(payload as Parameters<typeof recordShoppingDecisionPage>[0]);
    reply.header("Cache-Control", "no-store");
    return reply.send({ id, url: `/shopping/decision-page?id=${id}` });
  });

  /** GET /shopping/decision-pages/:id — 页面同源取回比价载荷 */
  app.get("/shopping/decision-pages/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const payload = getShoppingDecisionPage(String(id));
    if (!payload) {
      return reply.code(404).send({ error: "decision page not found or expired" });
    }
    reply.header("Cache-Control", "no-store");
    return reply.send(payload);
  });
}
