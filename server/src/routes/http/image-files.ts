import type { FastifyInstance } from "fastify";

import type { ImageGenerationService } from "../../services/image-generation-service.js";

/**
 * 图像生成静态拉流路由：
 *   - `GET /agent/images/:actorId/:fileName`  静态拉取生成的图片（PNG）
 *   - `GET /agent/images/:actorId/:fileName?w=400`  按需缩略图（webp）
 *
 * 与 voice-messages 路由同模式：
 *   - 文件名严格校验防穿越
 *   - 长缓存（生成的图片不可变）
 *
 * `?w=` 只影响本次响应的字节量：资料库/图库网格的格子 100~130px，拉原图是
 * 几十 MB 级别的浪费（网格一屏三十张）；带 `w` 时由 ImageGenerationService
 * 压成窄幅 webp 并落盘缓存，二次请求直接静态返回。不带 `w` 行为与以前完全一致。
 */
export function registerImageFileRoutes(
  app: FastifyInstance,
  deps: { imageGenerationService: ImageGenerationService },
): void {
  app.get<{
    Params: { actorId: string; fileName: string };
    Querystring: { w?: string };
  }>(
    "/agent/images/:actorId/:fileName",
    async (request, reply) => {
      const { actorId, fileName } = request.params;
      const fullPath = deps.imageGenerationService.resolveFilePath(actorId, fileName);
      if (!fullPath) {
        return reply.code(404).send({ ok: false, reason: "NOT_FOUND" });
      }
      const exists = await deps.imageGenerationService.fileExists(fullPath);
      if (!exists) {
        return reply.code(404).send({ ok: false, reason: "NOT_FOUND" });
      }

      const requested = Number(request.query?.w);
      if (Number.isFinite(requested) && requested > 0) {
        // 夹到 [64, 1600]：防止异常宽度打爆 sharp 缓存目录（同一张图每种宽度一份）。
        const width = Math.min(1600, Math.max(64, Math.round(requested)));
        const thumb = await deps.imageGenerationService.thumbnailPath(actorId, fileName, width);
        if (thumb) {
          void reply.header("Content-Type", "image/webp");
          void reply.header("Cache-Control", "public, max-age=2592000, immutable");
          return reply.send(deps.imageGenerationService.createReadStream(thumb));
        }
        // 缩略图失败 → 落到原图，绝不让缩略图链路影响可用性
      }

      // 2026-11 起新图默认落盘 WebP（旧图仍是 PNG），按扩展名给内容类型。
      void reply.header("Content-Type", fullPath.toLowerCase().endsWith(".webp") ? "image/webp" : "image/png");
      void reply.header("Cache-Control", "public, max-age=2592000, immutable");
      void reply.header("Accept-Ranges", "bytes");
      return reply.send(deps.imageGenerationService.createReadStream(fullPath));
    },
  );
}
