import type { ToolHandler } from "../../tool-registry.js";
import type { PictureKit, ImageAsset } from "@nextbot/picture";

/**
 * picture.gallery 工具 handler。
 *
 * 图库数据源是 `@nextbot/picture` 的 PictureKit(存储根 data/pictures);
 * 返回给 LLM 的条目附带缩略图/原图 URL(由 routes/http/picture.ts 提供静态服务),
 * 客户端可直接展示。
 */

function assetUrls(asset: ImageAsset): { thumbnailUrl: string; imageUrl: string } {
  return {
    thumbnailUrl: `/picture/assets/${asset.id}/thumbnail/small`,
    imageUrl: `/picture/assets/${asset.id}/file`,
  };
}

function assetSummary(asset: ImageAsset): Record<string, unknown> {
  return {
    id: asset.id,
    fileName: asset.fileName,
    width: asset.width,
    height: asset.height,
    tags: asset.tags,
    rating: asset.rating,
    sceneType: asset.sceneType,
    takenAt: asset.takenAt,
    createdAt: asset.createdAt,
    ...assetUrls(asset),
  };
}

export function createPictureGalleryHandler(pictureKit: PictureKit): ToolHandler {
  return async (input) => {
    const action = String(input.action ?? "query");
    try {
      switch (action) {
        case "query": {
          const page = Math.max(1, Number(input.page ?? 1) || 1);
          const pageSize = Math.min(50, Math.max(1, Number(input.pageSize ?? 20) || 20));
          const result = await pictureKit.store.query({
            filters: typeof input.tagFilter === "string" && input.tagFilter ? { tags: [input.tagFilter] } : undefined,
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
        }
        case "get": {
          const asset = pictureKit.store.get(String(input.photoId ?? ""));
          if (!asset) {
            return { ok: false, error: `照片不存在: ${String(input.photoId ?? "")}` };
          }
          return { ok: true, photo: assetSummary(asset) };
        }
        case "add_tag":
          return { ok: true, photo: assetSummary(await pictureKit.store.addTag(String(input.photoId), String(input.tag ?? "收藏"))) };
        case "remove_tag":
          return { ok: true, photo: assetSummary(await pictureKit.store.removeTag(String(input.photoId), String(input.tag ?? ""))) };
        case "set_rating":
          return { ok: true, photo: assetSummary(await pictureKit.store.setRating(String(input.photoId), Number(input.rating ?? 0))) };
        case "set_scene":
          return { ok: true, photo: assetSummary(await pictureKit.store.setSceneType(String(input.photoId), String(input.sceneType ?? ""))) };
        case "stats":
          return { ok: true, stats: pictureKit.store.stats() };
        default:
          return { ok: false, error: `未知的 picture.gallery action: ${action}` };
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };
}
