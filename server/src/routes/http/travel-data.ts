/**
 * 旅行数据维护路由（/travel/data）
 *
 * 让「数据是什么时候抓的、有多少还是外链」变成可查询、可主动触发的事情——
 * 此前数据只有散落的 JSON + 被动 TTL，没有全局视图也没有更新入口。
 */
import type { FastifyInstance, FastifyRequest } from "fastify";

import { travelDataRefresh } from "../../skills/travel-planning/travel-data-refresh.js";

export function registerTravelDataRoutes(app: FastifyInstance): void {
  /** GET /travel/data — 数据健康快照（城市/POI/图片/本地化率/最后更新时间） */
  app.get("/travel/data", async () => travelDataRefresh.snapshot());

  /**
   * POST /travel/data/refresh — 主动更新
   *   { mode: "localize", limit? }                 把仍是外链的图片抓成本机资产
   *   { mode: "media", destination, limit? }       对某目的地缺图的 POI 重抓一轮
   * 维护任务互斥：已有任务在跑时返回 409，避免叠加把外网打满。
   */
  app.post("/travel/data/refresh", async (req: FastifyRequest, reply) => {
    const body = (req.body ?? {}) as { mode?: string; destination?: string; limit?: number };
    const mode = body.mode ?? "localize";
    const limit = Number.isFinite(body.limit) && (body.limit as number) > 0 ? Number(body.limit) : undefined;

    if (mode === "localize") {
      const result = await travelDataRefresh.runExclusive(() =>
        travelDataRefresh.localizePendingImages({ limit }),
      );
      if (!result) return reply.code(409).send({ ok: false, reason: "ALREADY_RUNNING" });
      return { ok: true, mode, result };
    }

    if (mode === "media") {
      const destination = (body.destination ?? "").trim();
      if (!destination) return reply.code(400).send({ ok: false, reason: "DESTINATION_REQUIRED" });
      const result = await travelDataRefresh.runExclusive(() =>
        travelDataRefresh.refreshDestination(destination, { limit }),
      );
      if (!result) return reply.code(409).send({ ok: false, reason: "ALREADY_RUNNING" });
      return { ok: true, mode, result };
    }

    return reply.code(400).send({ ok: false, reason: "BAD_MODE", allowed: ["localize", "media"] });
  });

  /** 域索引（与其他路由域一致的自我描述） */
  app.get("/travel/data/_meta", async () => ({
    domain: "travel-data",
    endpoints: [
      "GET  /travel/data               数据健康快照",
      "POST /travel/data/refresh       {mode:'localize'|'media',destination?,limit?}",
    ],
    storage: "SQLite（data/travel-poi.db：cities/pois/media_pois/media/meta 四表）",
  }));
}
