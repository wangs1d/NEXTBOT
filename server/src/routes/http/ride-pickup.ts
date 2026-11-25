/**
 * 选点卡「拖图后重新推荐」接口（2026-11-24）。
 *
 * 对应滴滴《上车点推荐算法》的「更改逻辑」：用户拖动地图后，按拖动后的位置
 * 重新推荐 1~3 个上车点（不是只在原候选里吸附）。
 *
 * 为什么走 HTTP 而不是 card.action：拖动是高频交互（每次停手都可能触发），
 * 走动作通道会灌进对话流；这里只读、幂等、可去抖，适合独立端点。
 *
 * 入参 `lng/lat` 一律 **WGS-84**（与客户端 GPS/卡片回传同基准），内部由
 * ride-pickup-candidates 转 GCJ 调滴滴；返回候选坐标也是 WGS-84。
 */
import type { FastifyInstance } from "fastify";

import { regeocodeViaDidi, searchNearbyPickupsViaDidi } from "../../services/ride-pickup-candidates.js";
import type { HttpRouteDeps } from "./types.js";

export function registerRidePickupRoutes(app: FastifyInstance, deps: HttpRouteDeps): void {
  app.post("/api/ride/pickup-candidates", async (req, reply) => {
    const mcp = deps.mcpClientService;
    if (!mcp) {
      return reply.code(503).send({ ok: false, error: "MCP 未装配，无法推荐上车点" });
    }
    const body = (req.body ?? {}) as { lng?: unknown; lat?: unknown; candidates?: unknown };
    const lng = Number(body.lng);
    const lat = Number(body.lat);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
      return reply.code(400).send({ ok: false, error: "缺少有效的 lng/lat" });
    }
    if (lng < -180 || lng > 180 || lat < -90 || lat > 90) {
      return reply.code(400).send({ ok: false, error: "经纬度超出范围" });
    }

    // 只要地名（客户端拖动时先把图钉标签刷出来）就别再打 maps_place_around：
    // 那一路 200~800ms，会把「拖到哪叫哪」的手感拖没。
    const wantCandidates = body.candidates !== false;
    const [candidates, poi] = await Promise.all([
      wantCandidates
        ? searchNearbyPickupsViaDidi(mcp, lng, lat).catch(() => [])
        : Promise.resolve([]),
      regeocodeViaDidi(mcp, lng, lat, wantCandidates ? 3500 : 2000).catch(() => null),
    ]);

    return {
      ok: true,
      label: poi?.name?.trim() || poi?.address?.trim() || "",
      candidates,
    };
  });
}
