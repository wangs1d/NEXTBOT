import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { reverseGeocodeCoordinates } from "../../services/reverse-geocode-service.js";
import type { HttpRouteDeps } from "./types.js";

const reverseQuerySchema = z.object({
  latitude: z.coerce.number().finite(),
  longitude: z.coerce.number().finite(),
});

const pickupResolveSchema = z.object({
  latitude: z.coerce.number().finite(),
  longitude: z.coerce.number().finite(),
  withCandidates: z.coerce.number().optional(),
});

const pickupStaticMapSchema = z.object({
  latitude: z.coerce.number().finite(),
  longitude: z.coerce.number().finite(),
  zoom: z.coerce.number().finite().optional(),
  width: z.coerce.number().int().positive().max(800).optional(),
  height: z.coerce.number().int().positive().max(800).optional(),
});

/** 前端 GPS 逆地理：返回中文省市区（不使用 IP）。 */
export function registerGeoRoutes(app: FastifyInstance, deps?: Pick<HttpRouteDeps, "ridePickupService">): void {
  app.get("/geo/reverse", async (request, reply) => {
    const parsed = reverseQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const { latitude, longitude } = parsed.data;
    const hit = await reverseGeocodeCoordinates(latitude, longitude);
    if (!hit) {
      return reply.code(502).send({
        ok: false,
        message: "逆地理编码失败，请确认已开启定位且网络可用",
      });
    }
    return { ok: true, location: hit };
  });

  /**
   * 打车选点地图卡：拖动地图后解析中心点（滴图 maps_regeocode），
   * withCandidates=1 时并发返回周边公交站/地铁站推荐点（maps_place_around）。
   * 走独立的 GET 而不是让模型转述：拖动一次就是一次地图交互，不能等 LLM。
   */
  app.get("/geo/ride-pickup/resolve", async (request, reply) => {
    const service = deps?.ridePickupService;
    if (!service) {
      return reply.code(503).send({ ok: false, message: "上车点服务未装配" });
    }
    const parsed = pickupResolveSchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const { latitude, longitude, withCandidates } = parsed.data;
    const resolved = await service.resolvePoint(latitude, longitude, {
      withCandidates: withCandidates === 1,
    });
    return {
      ok: true,
      location: { lat: latitude, lng: longitude },
      ...(resolved.point ? { pickup: resolved.point } : {}),
      ...(resolved.candidates.length > 0 ? { candidates: resolved.candidates } : {}),
      mcpAvailable: service.availability().ok,
    };
  });

  /**
   * 打车选点地图卡的底图（滴图 maps_static_map）。
   * 滴图 MCP 不提供瓦片服务，聊天卡用静态地图 + 客户端图钉实现拖选：
   * 停手后客户端按新中心重新请求本接口。
   */
  app.get("/geo/ride-pickup/static-map", async (request, reply) => {
    const service = deps?.ridePickupService;
    if (!service) {
      return reply.code(503).send({ ok: false, message: "上车点服务未装配" });
    }
    const parsed = pickupStaticMapSchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const { latitude, longitude, zoom, width, height } = parsed.data;
    const url = await service.staticMap(
      latitude,
      longitude,
      zoom ?? 16,
      width ?? 720,
      height ?? 408,
    );
    if (!url) {
      return reply.code(502).send({ ok: false, message: "滴图静态地图暂不可用" });
    }
    return { ok: true, url };
  });

  app.get("/geo", async () => ({
    domain: "geo",
    endpoints: [
      "/geo/reverse?latitude=&longitude=",
      "/geo/ride-pickup/resolve?latitude=&longitude=&withCandidates=1",
      "/geo/ride-pickup/static-map?latitude=&longitude=&zoom=&width=&height=",
    ],
    note: "GPS 逆地理（不使用 IP 定位）；上车点解析与底图走滴图 MCP",
  }));
}
