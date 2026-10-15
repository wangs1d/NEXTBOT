import type { FastifyInstance } from "fastify";
import { z } from "zod";
import fs from "fs";
import { travelMediaStore } from "../../skills/travel-planning/travel-media-store.js";
import { destinationCoverStore } from "../../skills/travel-planning/travel-destination-cover-store.js";
import type { PlanningService } from "../../skills/travel-planning/travel-planning-service.js";

const poiBodySchema = z.object({
  name: z.string().min(1).max(120),
  type: z.enum(["attraction", "hotel", "restaurant"]),
  latitude: z.coerce.number().finite().optional(),
  longitude: z.coerce.number().finite().optional(),
});

const addImageSchema = poiBodySchema.extend({
  url: z.string().url().optional(),
  dataUrl: z.string().max(15 * 1024 * 1024).optional(),
  source: z.enum(["user", "curated", "wikimedia"]).optional(),
  uploader: z.string().max(60).optional(),
  takenAt: z.string().max(40).optional(),
});

const updateImageSchema = poiBodySchema.extend({
  url: z.string().min(1).max(1000),
  source: z.enum(["user", "curated", "wikimedia"]).optional(),
  takenAt: z.string().max(40).optional(),
  uploader: z.string().max(60).optional(),
});

const deleteByUrlSchema = poiBodySchema.extend({
  url: z.string().min(1).max(1000),
});

const backfillSchema = poiBodySchema;

const remoteQuerySchema = z.object({ u: z.string().min(8).max(2000) });

const coverQuerySchema = z.object({ destination: z.string().min(1).max(80) });

const coverRefreshSchema = z.object({
  destination: z.string().min(1).max(80),
  latitude: z.coerce.number().finite().optional(),
  longitude: z.coerce.number().finite().optional(),
  attractionNames: z.array(z.string().min(1).max(80)).max(6).optional(),
});

/**
 * 远程图代理白名单：仅 Wikimedia 家族（thumb/upload/commons 图床、wikipedia、
 * wikidata）。行程链路的所有远程图 URL 都出自这三个域，收窄到零 SSRF 面。
 */
const REMOTE_IMAGE_HOST_SUFFIXES = ["wikimedia.org", "wikipedia.org", "wikidata.org"] as const;

function isAllowedRemoteImageHost(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    const host = u.hostname.toLowerCase();
    return REMOTE_IMAGE_HOST_SUFFIXES.some(
      (s) => host === s || host.endsWith(`.${s}`),
    );
  } catch {
    return false;
  }
}

/**
 * POI 媒体库路由：本地上传实拍图、评论、视频（元数据+播放页），
 * 供行程面板展示与排序聚合分使用。视频不自托管，只存元数据 + 播放页跳转。
 *
 * 管理端：图片/评论/视频的更新与删除（PUT/DELETE），以及单 POI 手动回填
 * （自动回填被 TRAVEL_MEDIA_BACKFILL=off 关闭时的替代写入路径）。
 */
export function registerTravelMediaRoutes(
  app: FastifyInstance,
  deps: { travelPlanningService?: PlanningService } = {},
): void {
  /** 查询单个 POI 的媒体（含聚合统计） */
  app.get("/travel/media", async (request, reply) => {
    const parsed = poiBodySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const { name, type, latitude, longitude } = parsed.data;
    const entry = travelMediaStore.get(type, name);
    if (!entry) return { ok: true, exists: false, aggregate: null };
    return {
      ok: true,
      exists: true,
      poiKey: entry.poiKey,
      name: entry.name,
      type: entry.type,
      latitude: entry.latitude ?? latitude,
      longitude: entry.longitude ?? longitude,
      images: entry.images,
      aggregate: travelMediaStore.aggregate(type, name),
    };
  });

  /** 上传实拍图：body 传 dataUrl（自动落盘）或外链 url */
  app.post("/travel/media/images", async (request, reply) => {
    const parsed = addImageSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const { name, type, latitude, longitude, ...img } = parsed.data;
    const result = travelMediaStore.addImage(
      type,
      name,
      img,
      latitude !== undefined && longitude !== undefined ? { latitude, longitude } : undefined,
    );
    if (!result.ok) return reply.code(400).send(result);
    return { ok: true, image: result.image, aggregate: travelMediaStore.aggregate(type, name) };
  });

  // ======================== 管理端：更新 / 删除 / 回填 ========================

  /** 更新图片元数据（来源/拍摄时间/上传者；改 source 会影响展示优先级） */
  app.put("/travel/media/images", async (request, reply) => {
    const parsed = updateImageSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const { name, type, url, ...patch } = parsed.data;
    const updated = travelMediaStore.updateImage(type, name, url, patch);
    if (!updated) return reply.code(404).send({ ok: false, error: "图片不存在" });
    return { ok: true, aggregate: travelMediaStore.aggregate(type, name) };
  });

  /** 删除图片（本地 assets 文件一并清理） */
  app.delete("/travel/media/images", async (request, reply) => {
    const parsed = deleteByUrlSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const { name, type, url } = parsed.data;
    const removed = travelMediaStore.removeImage(type, name, url);
    if (!removed) return reply.code(404).send({ ok: false, error: "图片不存在" });
    return { ok: true, aggregate: travelMediaStore.aggregate(type, name) };
  });

  /** 手动补全单个 POI 的照片（自动回填关闭时的替代路径；视频/评论能力已下线） */
  app.post("/travel/media/backfill", async (request, reply) => {
    if (!deps.travelPlanningService) {
      return reply.code(503).send({ ok: false, error: "规划服务未装配，无法回填" });
    }
    const parsed = backfillSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const { name, type, latitude, longitude } = parsed.data;
    try {
      const added = await deps.travelPlanningService.backfillMediaForPoi(
        name,
        type,
        latitude,
        longitude,
      );
      return {
        ok: true,
        filled: added.images,
        added,
        aggregate: travelMediaStore.aggregate(type, name),
      };
    } catch (err) {
      return reply.code(502).send({
        ok: false,
        error: `回填失败：${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });

  /**
   * 目的地当前封面（2026-10-15）：行程卡海报活取用。客户端磁盘缓存按 URL
   * 钉死字节，服务端重选封面后历史卡片烤死的旧 URL 无法靠 302 自愈——卡片
   * 改为按目的地名活取封面库当前值，新图自动上卡。
   */
  app.get("/travel/media/destination-cover", async (request, reply) => {
    const parsed = coverQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const cover = destinationCoverStore.get(parsed.data.destination);
    return { ok: true, url: cover?.url ?? null, source: cover?.source ?? null };
  });

  /**
   * 强制刷新目的地封面（管理端）：驱逐缓存 → 完整解析链重选（候选池含网搜
   * 风景源 + VLM 终审）→ 新旧不同登记升级映射，历史卡片自动换新图。
   * 坐标/景点名可选——提供后地理锚定与招牌景点搜索更准，不提供也能解析。
   */
  app.post("/travel/media/destination-cover/refresh", async (request, reply) => {
    if (!deps.travelPlanningService) {
      return reply.code(503).send({ ok: false, error: "规划服务未装配，无法刷新" });
    }
    const parsed = coverRefreshSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
    }
    const { destination, latitude, longitude, attractionNames } = parsed.data;
    const center =
      latitude !== undefined && longitude !== undefined
        ? { latitude, longitude }
        : undefined;
    try {
      const result = await deps.travelPlanningService.refreshDestinationCover(
        destination,
        center,
        attractionNames ?? [],
      );
      return { ok: true, ...result };
    } catch (err) {
      return reply.code(502).send({
        ok: false,
        error: `刷新失败：${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });

  /**
   * 远程图代理（2026-09-28，存量数据兼容通道）：历史行程/聊天快照里烤死的
   * wikimedia 远程 URL，客户端网络直连不可达（不走系统代理，IPv4 被墙）。
   * 客户端把这类 URL 重写到本路由，服务端以 URL 哈希为键落盘缓存（双路抓取，
   * 见 travelMediaStore.resolveOrFetchRemote），首次抓取后续永久本机直出。
   *
   * 封面升级映射（2026-09-28）：被换下的旧封面 URL 命中映射时改发当前封面
   * （重定向语义用 302 指向新代理地址，客户端 Image.network 自动跟随），
   * 历史卡片自动换上更好的新封面。
   */
  app.get("/travel/media/remote", async (request, reply) => {
    const parsed = remoteQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, reason: "BAD_PARAMS" });
    }
    const remoteUrl = parsed.data.u;
    if (!isAllowedRemoteImageHost(remoteUrl)) {
      return reply.code(400).send({ ok: false, reason: "HOST_NOT_ALLOWED" });
    }
    // 封面升级：旧封面 URL → 当前封面（本地资产直接 302；仍远程的走本路由再跳一次）
    const upgraded = destinationCoverStore.resolveSuperseded(remoteUrl);
    if (upgraded) {
      if (upgraded.url.startsWith("/travel/media/assets/")) {
        // Location 头必须 ASCII：中文目的地名编码掉（与 assets 路由同款）
        return reply.redirect(encodeURI(upgraded.url), 302);
      }
      return reply.redirect(`/travel/media/remote?u=${encodeURIComponent(upgraded.url)}`, 302);
    }
    const hit = await travelMediaStore.resolveOrFetchRemote(remoteUrl);
    if (!hit) return reply.code(502).send({ ok: false, reason: "UPSTREAM_UNREACHABLE" });
    void reply.header("Content-Type", hit.mime);
    void reply.header("Cache-Control", "public, max-age=2592000, immutable");
    return reply.send(fs.createReadStream(hit.file));
  });

  /** 媒体库静态资源（上传实拍图）。文件名严格校验防穿越，长缓存（内容不可变）。
   *  封面升级映射：目的封面对象目录内的历史文件请求改发当前封面（本地资产 302）。 */
  app.get<{ Params: { dir: string; fileName: string } }>(
    "/travel/media/assets/:dir/:fileName",
    async (request, reply) => {
      const { dir, fileName } = request.params;
      const full = travelMediaStore.resolveAssetPath(dir, fileName);
      if (!full) return reply.code(404).send({ ok: false, reason: "NOT_FOUND" });
      // 封面升级：旧封面对象目录内的任何文件 → 当前封面（避免长缓存钉死旧图）
      const upgraded = destinationCoverStore.resolveSuperseded(
        `/travel/media/assets/${dir}/${fileName}`,
      );
      if (upgraded?.url.startsWith("/travel/media/assets/")) {
        // Location 头必须 ASCII：路径里的中文目的地编码掉，否则 Node 抛 ERR_INVALID_CHAR
        return reply.redirect(encodeURI(upgraded.url), 302);
      }
      const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
      const mime =
        ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : ext === "gif" ? "image/gif" : "image/jpeg";
      void reply.header("Content-Type", mime);
      void reply.header("Cache-Control", "public, max-age=2592000, immutable");
      return reply.send(fs.createReadStream(full));
    },
  );

  /** 域索引（与其他路由域一致的自我描述） */
  app.get("/travel/media/_meta", async () => ({
    domain: "travel-media",
    endpoints: [
      "GET  /travel/media?name=&type=&latitude=&longitude=",
      "POST /travel/media/images   {name,type,dataUrl|url,source?,uploader?}",
      "GET  /travel/media/assets/:dir/:fileName",
      "GET  /travel/media/remote?u=<wikimedia 图床 URL>",
      "PUT    /travel/media/images   {name,type,url,source?,takenAt?,uploader?}",
      "DELETE /travel/media/images   {name,type,url}",
      "POST   /travel/media/backfill {name,type,latitude?,longitude?}",
      "GET    /travel/media/destination-cover?destination=",
      "POST   /travel/media/destination-cover/refresh {destination,latitude?,longitude?,attractionNames?}",
    ],
    note: "poiKey 归一化规则见 travel-media-store.ts poiKeyOf()，上传与查询需使用同一 name/type。cover-chain v3(网搜入池+SF侧车终审)",
  }));
}
