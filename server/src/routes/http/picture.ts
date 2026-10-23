import type { FastifyInstance } from "fastify";
import { createReadStream, existsSync } from "node:fs";
import type { PictureKit, ImageAsset, ThumbnailSize } from "@nextbot/picture";

import { PictureTrashService } from "../../services/picture-trash-service.js";

/**
 * 图片图库 HTTP 路由(供客户端图库页使用):
 *   - GET    /picture/assets                      资产列表(分页/标签筛选)
 *   - GET    /picture/assets/random               随机抽取(盲盒清理;排除收藏/新入库/指定 id)
 *   - GET    /picture/assets/:id/thumbnail/:size  缩略图(small/medium/large, webp)
 *   - GET    /picture/assets/:id/file             原资产文件
 *   - POST   /picture/assets                      multipart 上传入库
 *   - POST   /picture/assets/batch-delete         批量删除(入回收站)
 *   - POST   /picture/assets/batch-tag            批量打/去标签(收藏等)
 *   - DELETE /picture/assets/:id                  删除照片(入回收站)
 *   - GET    /picture/trash                       回收站列表(30 天惰性清理)
 *   - GET    /picture/trash/:id/preview           回收站条目预览图
 *   - POST   /picture/trash/restore               批量恢复
 *
 * 资产路径均来自索引内存值,不存在路径穿越风险;缩略图命中即走长缓存。
 */
const MIME_BY_EXT: Record<string, string> = {
  ".webp": "image/webp",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".tiff": "image/tiff",
};

const FAVORITE_TAG = "收藏";
/** 回收站保留期(毫秒):30 天 */
const TRASH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** 单次批量上限 */
const BATCH_MAX = 200;

function assetSummary(asset: ImageAsset): Record<string, unknown> {
  return {
    id: asset.id,
    fileName: asset.fileName,
    width: asset.width,
    height: asset.height,
    format: asset.format,
    fileSize: asset.fileSize,
    tags: asset.tags,
    rating: asset.rating,
    sceneType: asset.sceneType,
    takenAt: asset.takenAt,
    createdAt: asset.createdAt,
    caption: asset.analysis?.caption ?? null,
    place: asset.analysis?.place ?? null,
    thumbnailUrl: `/picture/assets/${asset.id}/thumbnail/small`,
    previewUrl: `/picture/assets/${asset.id}/thumbnail/medium`,
    imageUrl: `/picture/assets/${asset.id}/file`,
  };
}

/** 解析 body.ids 为去重字符串数组;非法返回 null */
function parseIds(body: unknown): string[] | null {
  const ids = (body as { ids?: unknown } | null)?.ids;
  if (!Array.isArray(ids)) return null;
  const clean = [...new Set(ids.map((id) => String(id)).filter(Boolean))];
  return clean.length > 0 && clean.length <= BATCH_MAX ? clean : null;
}

export function registerPictureRoutes(app: FastifyInstance, deps: { pictureKit: PictureKit }): void {
  const { pictureKit } = deps;
  const trash = new PictureTrashService(`${pictureKit.store.rootDir}/trash`, pictureKit);

  /** 统一删除：文件移入回收站，索引移除 */
  const trashAsset = async (asset: ImageAsset): Promise<string> => {
    const trashId = await trash.moveIn(asset);
    await pictureKit.store.remove(asset.id, { deleteFiles: false });
    return trashId;
  };

  app.get("/picture/assets", async (request) => {
    const query = request.query as Record<string, unknown>;
    const page = Math.max(1, Number(query.page ?? 1) || 1);
    const pageSize = Math.min(60, Math.max(1, Number(query.pageSize ?? 30) || 30));
    const tag = typeof query.tag === "string" && query.tag ? query.tag : undefined;
    const result = await pictureKit.store.query({
      filters: tag ? { tags: [tag] } : undefined,
      page,
      pageSize,
    });
    return {
      ok: true,
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
      photos: result.items.map(assetSummary),
    };
  });

  app.get<{ Params: { id: string; size: string } }>(
    "/picture/assets/:id/thumbnail/:size",
    async (request, reply) => {
      const { id, size } = request.params;
      if (size !== "small" && size !== "medium" && size !== "large") {
        return reply.code(400).send({ ok: false, reason: "INVALID_SIZE" });
      }
      const asset = pictureKit.store.get(id);
      if (!asset) {
        return reply.code(404).send({ ok: false, reason: "NOT_FOUND" });
      }
      const thumbPath = pictureKit.thumbnails.get(id, size as ThumbnailSize);
      if (!thumbPath) {
        return reply.code(404).send({ ok: false, reason: "NO_THUMBNAIL" });
      }
      void reply.header("Content-Type", "image/webp");
      void reply.header("Cache-Control", "public, max-age=604800");
      return reply.send(createReadStream(thumbPath));
    },
  );

  app.get<{ Params: { id: string } }>("/picture/assets/:id/file", async (request, reply) => {
    const { id } = request.params;
    const asset = pictureKit.store.get(id);
    if (!asset) {
      return reply.code(404).send({ ok: false, reason: "NOT_FOUND" });
    }
    const ext = asset.filePath.slice(asset.filePath.lastIndexOf(".")).toLowerCase();
    void reply.header("Content-Type", MIME_BY_EXT[ext] ?? "application/octet-stream");
    void reply.header("Cache-Control", "public, max-age=604800");
    return reply.send(createReadStream(asset.filePath));
  });

  app.post("/picture/assets", async (request, reply) => {
    const file = await request.file();
    if (!file) {
      return reply.code(400).send({ ok: false, error: "缺少 multipart 文件字段 file" });
    }
    const buffer = await file.toBuffer();
    if (buffer.length === 0) {
      return reply.code(400).send({ ok: false, error: "文件为空" });
    }
    try {
      const { asset, deduplicated } = await pictureKit.store.ingest(buffer, {
        fileName: file.filename || undefined,
      });
      return { ok: true, deduplicated, photo: assetSummary(asset) };
    } catch (error) {
      return reply.code(400).send({
        ok: false,
        error: error instanceof Error ? error.message : "不支持的图片格式",
      });
    }
  });

  app.delete<{ Params: { id: string } }>("/picture/assets/:id", async (request, reply) => {
    const { id } = request.params;
    const asset = pictureKit.store.get(id);
    if (!asset) {
      return reply.code(404).send({ ok: false, reason: "NOT_FOUND" });
    }
    try {
      const trashId = await trashAsset(asset);
      return { ok: true, id, trashId };
    } catch {
      // 移入回收站失败（磁盘异常等）→ 回退原硬删路径，保证删除一定能完成
      const removed = await pictureKit.store.remove(id, { deleteFiles: true });
      if (!removed) {
        return reply.code(500).send({ ok: false, reason: "REMOVE_FAILED" });
      }
      return { ok: true, id, trashId: null };
    }
  });

  /** GET /picture/assets/random — 盲盒清理抽样：排除收藏/新入库/指定 id，均匀随机 */
  app.get("/picture/assets/random", async (request) => {
    const query = request.query as Record<string, unknown>;
    const count = Math.min(50, Math.max(1, Number(query.count ?? 15) || 15));
    const excludeTag = typeof query.excludeTag === "string" && query.excludeTag ? query.excludeTag : FAVORITE_TAG;
    const recentDays = Math.max(0, Number(query.recentDays ?? 7) || 0);
    const excludeIds = new Set(
      String(query.excludeIds ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    );
    const cutoff = Date.now() - recentDays * 86_400_000;
    const pool = pictureKit.store.listAll().filter((asset) => {
      if (excludeTag && asset.tags.includes(excludeTag)) return false;
      if (recentDays > 0 && Date.parse(asset.createdAt) > cutoff) return false;
      if (excludeIds.has(asset.id)) return false;
      return true;
    });
    // Fisher–Yates 部分洗牌：抽 count 张即可
    const picked = [...pool];
    for (let i = 0; i < Math.min(count, picked.length); i++) {
      const j = i + Math.floor(Math.random() * (picked.length - i));
      [picked[i], picked[j]] = [picked[j]!, picked[i]!];
    }
    void trash.purge(TRASH_TTL_MS); // 顺带惰性清理（不阻塞）
    return {
      ok: true,
      pool: pool.length,
      photos: picked.slice(0, count).map(assetSummary),
    };
  });

  /** POST /picture/assets/batch-delete — 批量删除（入回收站），返回 trashIds 供撤销 */
  app.post("/picture/assets/batch-delete", async (request, reply) => {
    const ids = parseIds(request.body);
    if (!ids) {
      return reply.code(400).send({ ok: false, error: `ids 须为 1-${BATCH_MAX} 个照片 id 的数组` });
    }
    const removed: string[] = [];
    const missing: string[] = [];
    const trashIds: string[] = [];
    let freedBytes = 0;
    for (const id of ids) {
      const asset = pictureKit.store.get(id);
      if (!asset) {
        missing.push(id);
        continue;
      }
      try {
        trashIds.push(await trashAsset(asset));
      } catch {
        await pictureKit.store.remove(id, { deleteFiles: true });
        trashIds.push("");
      }
      removed.push(id);
      freedBytes += asset.fileSize ?? 0;
    }
    void trash.purge(TRASH_TTL_MS);
    return { ok: missing.length === 0, removed: removed.length, missing, trashIds, freedBytes };
  });

  /** POST /picture/assets/batch-tag — 批量打/去标签（收藏等） */
  app.post("/picture/assets/batch-tag", async (request, reply) => {
    const ids = parseIds(request.body);
    const tag = String((request.body as { tag?: unknown } | null)?.tag ?? "").trim();
    const remove = (request.body as { remove?: unknown } | null)?.remove === true;
    if (!ids) {
      return reply.code(400).send({ ok: false, error: `ids 须为 1-${BATCH_MAX} 个照片 id 的数组` });
    }
    if (!tag) {
      return reply.code(400).send({ ok: false, error: "tag 不能为空" });
    }
    let updated = 0;
    for (const id of ids) {
      if (!pictureKit.store.get(id)) continue;
      try {
        if (remove) await pictureKit.store.removeTag(id, tag);
        else await pictureKit.store.addTag(id, tag);
        updated++;
      } catch {
        // 单张失败不影响其余
      }
    }
    return { ok: true, updated, tag, remove };
  });

  /** GET /picture/trash — 回收站列表（顺带 30 天惰性清理） */
  app.get("/picture/trash", async () => {
    const { items, totalBytes } = await trash.list();
    return { ok: true, items, totalBytes, ttlDays: Math.round(TRASH_TTL_MS / 86_400_000) };
  });

  /** GET /picture/trash/:id/preview — 回收站条目预览图 */
  app.get<{ Params: { id: string } }>("/picture/trash/:id/preview", async (request, reply) => {
    const previewPath = await trash.getPreviewPath(request.params.id);
    if (!previewPath || !existsSync(previewPath)) {
      return reply.code(404).send({ ok: false, reason: "NOT_FOUND" });
    }
    void reply.header("Content-Type", "image/webp");
    void reply.header("Cache-Control", "no-store");
    return reply.send(createReadStream(previewPath));
  });

  /** POST /picture/trash/restore — 批量恢复（文件移回 + 索引重建） */
  app.post("/picture/trash/restore", async (request, reply) => {
    const ids = parseIds(request.body);
    if (!ids) {
      return reply.code(400).send({ ok: false, error: `ids 须为 1-${BATCH_MAX} 个回收站 id 的数组` });
    }
    const restored: string[] = [];
    const missing: string[] = [];
    for (const id of ids) {
      if (await trash.restore(id)) restored.push(id);
      else missing.push(id);
    }
    return { ok: missing.length === 0, restored: restored.length, missing };
  });

  /** DELETE /picture/trash/:id — 彻底删除（跳过 30 天 TTL 提前真删） */
  app.delete<{ Params: { id: string } }>("/picture/trash/:id", async (request, reply) => {
    const deleted = await trash.hardDelete(request.params.id);
    if (!deleted) {
      return reply.code(404).send({ ok: false, reason: "NOT_FOUND" });
    }
    return { ok: true, id: request.params.id };
  });

  app.get("/picture", async () => ({
    domain: "picture",
    endpoints: [
      "GET /picture/assets?page=&pageSize=&tag=",
      "GET /picture/assets/random?count=&excludeTag=&recentDays=&excludeIds=",
      "GET /picture/assets/:id/thumbnail/:size",
      "GET /picture/assets/:id/file",
      "POST /picture/assets (multipart: file)",
      "POST /picture/assets/batch-delete {ids}",
      "POST /picture/assets/batch-tag {ids, tag, remove?}",
      "DELETE /picture/assets/:id (入回收站)",
      "GET /picture/trash",
      "GET /picture/trash/:id/preview",
      "POST /picture/trash/restore {ids}",
    ],
  }));
}
