import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";

import type { PictureKit } from "@nextbot/picture";

import { analyzePendingPhotos, countPendingAnalysis } from "../../services/photo-analysis-service.js";
import type { PhotoAnalyzeFn } from "../../services/photo-analysis-service.js";
import { GalleryWallService } from "../../services/gallery-wall-service.js";

/**
 * 3D 照片墙路由（B 面渲染载体，模式与 travel-map 相同）：
 *
 *   GET  /gallery-wall                     自包含页面（three.js 经 importmap 引本机 vendor）
 *   GET  /gallery-wall/vendor/three.module.js  本地 three.js（长缓存，无 CDN 依赖）
 *   GET  /gallery-wall/layout              贴墙布局（确定性计算，见 gallery-wall-service）
 *   POST /gallery-wall/analyze             视觉分析待补照片（显式触发，控制 token 成本）
 *
 * 桌面端：GalleryWallHost（webview_windows 单例）加载 ?host=1 页面，
 * 页面经 window.__galleryWall 暴露 setPaused/flyToPhoto/refresh 桥，
 * 经 chrome.webview.postMessage 回传 openGrid（切到 2D 管理视图）。
 */

const webRoot = join(import.meta.dirname ?? ".", "../../../web/gallery-wall");

function buildGalleryWallHtml(): string {
  const htmlPath = join(webRoot, "panel.html");
  if (existsSync(htmlPath)) {
    // 页面模板为纯静态资源（数据走 /gallery-wall/layout 同源取），长缓存
    return readFileSync(htmlPath, "utf8");
  }
  return "<!doctype html><meta charset='utf-8'><body style='background:#0a0a0a;color:#888;font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0'>照片墙页面资源缺失</body>";
}

export function registerGalleryWallRoutes(
  app: FastifyInstance,
  deps: { pictureKit: PictureKit; analyzeFn?: PhotoAnalyzeFn },
): void {
  const wallService = new GalleryWallService(deps.pictureKit, deps.pictureKit.store.rootDir);

  app.get("/gallery-wall", async (_req, reply) => {
    reply.header("Cache-Control", "public, max-age=600");
    reply.type("text/html; charset=utf-8");
    return buildGalleryWallHtml();
  });

  app.get("/gallery-wall/vendor/three.module.js", async (_req, reply) => {
    const vendorPath = join(webRoot, "vendor", "three.module.js");
    if (!existsSync(vendorPath)) {
      return reply.code(404).type("text/plain").send("three.js vendor missing");
    }
    reply.header("Cache-Control", "public, max-age=604800, immutable");
    reply.type("text/javascript; charset=utf-8");
    return reply.send(readFileSync(vendorPath));
  });

  app.get("/gallery-wall/layout", async (_req, reply) => {
    const layout = await wallService.layout();
    reply.header("Cache-Control", "no-store");
    return layout;
  });

  /** POST /gallery-wall/wall-owner — 「设为墙主」：photoId 所在墙的墙主覆盖为它 */
  app.post("/gallery-wall/wall-owner", async (request, reply) => {
    const photoId = String((request.body as { photoId?: unknown } | null)?.photoId ?? "").trim();
    if (!photoId) {
      return reply.code(400).send({ ok: false, error: "photoId 不能为空" });
    }
    if (!deps.pictureKit.store.get(photoId)) {
      return reply.code(404).send({ ok: false, error: `照片不存在: ${photoId}` });
    }
    const eventId = await wallService.setOwnerForPhoto(photoId);
    if (!eventId) {
      return reply.code(404).send({ ok: false, error: "该照片不在任何一面照片墙上" });
    }
    return reply.send({ ok: true, eventId, photoId });
  });

  app.post("/gallery-wall/analyze", async (request, reply) => {
    const body = (request.body ?? {}) as { limit?: unknown };
    const limit = Number(body.limit);
    try {
      const result = await analyzePendingPhotos(deps.pictureKit, {
        limit: Number.isFinite(limit) ? limit : undefined,
        analyzeFn: deps.analyzeFn,
      });
      return reply.send({ ok: true, ...result });
    } catch (error) {
      return reply.code(500).send({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.get("/gallery-wall/pending", async () => ({
    ok: true,
    pending: countPendingAnalysis(deps.pictureKit),
  }));
}
