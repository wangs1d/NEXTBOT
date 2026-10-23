import type { ToolHandler } from "../../tool-registry.js";
import type { PictureKit } from "@nextbot/picture";
import { PHOTO_STYLES, applyPhotoStyle, type PhotoStyleId } from "../../../services/photo-style-service.js";

/**
 * 照片墙工具层 handler（skill 出口，schema 见 skills/builtin/picture-skills.ts）：
 *
 *   picture.stylize      照片风格化：撕纸海报/拍立得/黑白胶片/双色版画（程序合成，
 *                        零模型零网络），产物入库并自动贴墙
 *   picture.housekeeping 清理治理：连拍簇/截图/迷你图建议（删除须 confirmed）
 *   picture.memories     记忆回顾：窗口期内按事件簇聚合出「这个月的记忆」
 */

function photoRef(pictureKit: PictureKit, photoId: string): Record<string, unknown> | null {
  const asset = pictureKit.store.get(photoId);
  if (!asset) return null;
  return {
    id: asset.id,
    fileName: asset.fileName,
    width: asset.width,
    height: asset.height,
    takenAt: asset.takenAt ?? asset.createdAt,
    caption: asset.analysis?.caption ?? null,
    place: asset.analysis?.place ?? null,
  };
}

function assetSummary(pictureKit: PictureKit, assetId: string): Record<string, unknown> | null {
  const asset = pictureKit.store.get(assetId);
  if (!asset) return null;
  return {
    id: asset.id,
    fileName: asset.fileName,
    width: asset.width,
    height: asset.height,
    format: asset.format,
    fileSize: asset.fileSize,
    tags: asset.tags,
    takenAt: asset.takenAt ?? asset.createdAt,
    createdAt: asset.createdAt,
    thumbnailUrl: `/picture/assets/${asset.id}/thumbnail/small`,
    imageUrl: `/picture/assets/${asset.id}/file`,
  };
}

// ──────────────────────────── picture.stylize ────────────────────────────

export function createPictureStylizeHandler(pictureKit: PictureKit): ToolHandler {
  return async (input) => {
    const action = String(input.action ?? "apply");

    if (action === "styles") {
      return { ok: true, styles: PHOTO_STYLES };
    }

    if (action === "apply") {
      const photoId = String(input.photoId ?? "").trim();
      const asset = pictureKit.store.get(photoId);
      if (!asset) {
        return { ok: false, error: `照片不存在: ${photoId || "(空)"}` };
      }
      const style = String(input.style ?? "") as PhotoStyleId;
      const spec = PHOTO_STYLES.find((s) => s.id === style);
      if (!spec) {
        return {
          ok: false,
          error: `未知风格: ${style || "(空)"}。可选：${PHOTO_STYLES.map((s) => `${s.id}(${s.label})`).join("、")}`,
        };
      }
      try {
        const { readFile } = await import("node:fs/promises");
        const source = await readFile(asset.filePath);
        const title = typeof input.title === "string" && input.title.trim() ? input.title.trim() : undefined;
        const result = await applyPhotoStyle(source, style, {
          title: title ?? asset.analysis?.caption ?? undefined,
          seed: asset.id,
        });
        const { asset: created } = await pictureKit.store.ingest(result.buffer, {
          fileName: `${asset.id}-${style}.png`,
          tags: ["风格化", spec.label, `源:${asset.id}`],
          autoTag: false,
        });
        return {
          ok: true,
          photo: assetSummary(pictureKit, created.id),
          sourcePhotoId: asset.id,
          style: spec.id,
          styleLabel: spec.label,
          note: `已生成「${spec.label}」风格版本并入库，会自动贴上照片墙。`,
        };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }

    return { ok: false, error: `未知的 picture.stylize action: ${action}` };
  };
}

// ──────────────────────────── picture.housekeeping ────────────────────────────

const BURST_GAP_MS = 2_000;
const BURST_MIN_SIZE = 4;
const TINY_FILE_BYTES = 30 * 1024;
const SCREENSHOT_NAME_RE = /screenshot|screen[\s_-]?shot|截图|截屏/i;

export function createPictureHousekeepingHandler(pictureKit: PictureKit): ToolHandler {
  return async (input) => {
    const action = String(input.action ?? "suggest");

    if (action === "suggest") {
      const assets = [...pictureKit.store.listAll()].sort((a, b) => {
        const ta = Date.parse(a.takenAt ?? a.createdAt) || 0;
        const tb = Date.parse(b.takenAt ?? b.createdAt) || 0;
        return ta - tb;
      });

      // 连拍簇：间隔 <2s 的连续照片，≥4 张建议精简（保留第一张，其余列出）
      const bursts: Array<Record<string, unknown>> = [];
      let run: typeof assets = [];
      let prevTs = 0;
      const flushRun = () => {
        if (run.length >= BURST_MIN_SIZE) {
          bursts.push({
            type: "burst",
            reason: `连拍 ${run.length} 张（间隔不足 2 秒），通常保留 1-2 张就够`,
            keepPhotoId: run[0]!.id,
            candidates: run.slice(1).map((a) => ({ id: a.id, fileName: a.fileName })),
          });
        }
        run = [];
      };
      for (const asset of assets) {
        const ts = Date.parse(asset.takenAt ?? asset.createdAt) || 0;
        if (prevTs && ts - prevTs <= BURST_GAP_MS) {
          run.push(asset);
        } else {
          flushRun();
          run = [asset];
        }
        prevTs = ts;
      }
      flushRun();

      // 截图：文件名命中或视觉分析认定
      const screenshots = assets
        .filter((a) => SCREENSHOT_NAME_RE.test(a.fileName) || a.analysis?.scene === "截图")
        .map((a) => ({ id: a.id, fileName: a.fileName }));

      // 迷你图：<30KB 的小文件（缩略图误存/损坏图）
      const tiny = assets
        .filter((a) => (a.fileSize ?? Infinity) < TINY_FILE_BYTES)
        .map((a) => ({ id: a.id, fileName: a.fileName }));

      const totalCandidates =
        bursts.reduce((n, b) => n + (b.candidates as unknown[]).length, 0) +
        screenshots.length + tiny.length;
      return {
        ok: true,
        totalCandidates,
        bursts,
        screenshots,
        tiny,
        note: totalCandidates
          ? "以上是清理建议：删除前请与用户逐类确认，用户同意后以 action=remove&confirmed=true 执行。"
          : "图库很干净，没有需要清理的内容。",
      };
    }

    if (action === "remove") {
      const photoIds = Array.isArray(input.photoIds)
        ? (input.photoIds as unknown[]).map((id) => String(id)).filter(Boolean)
        : [];
      if (photoIds.length === 0) {
        return { ok: false, error: "photoIds 不能为空" };
      }
      // 破坏性操作确认闸：未确认一律只返回预览
      if (input.confirmed !== true) {
        return {
          ok: false,
          needsConfirmation: true,
          error: `将永久删除 ${photoIds.length} 张照片（不可恢复）。请与用户逐类确认后，以 confirmed:true 重新调用。`,
          photoIds: photoIds.map((id) => photoRef(pictureKit, id)),
        };
      }
      let removed = 0;
      const failed: string[] = [];
      for (const id of photoIds) {
        try {
          if (await pictureKit.store.remove(id, { deleteFiles: true })) removed += 1;
          else failed.push(id);
        } catch {
          failed.push(id);
        }
      }
      return { ok: failed.length === 0, removed, failed };
    }

    return { ok: false, error: `未知的 picture.housekeeping action: ${action}` };
  };
}

// ──────────────────────────── picture.memories ────────────────────────────

export interface MemoryPhoto {
  id: string;
  thumbnailUrl: string;
  imageUrl: string;
  caption: string | null;
}

export function createPictureMemoriesHandler(pictureKit: PictureKit): ToolHandler {
  return async (input) => {
    const days = Math.max(1, Math.min(365, Number(input.days ?? 30) || 30));
    const count = Math.max(1, Math.min(5, Number(input.count ?? 3) || 3));
    const assets = pictureKit.store.listAll();
    if (assets.length === 0) {
      return { ok: true, memories: [], text: "图库还是空的，还没有可回顾的记忆。" };
    }

    // 复用贴墙布局的事件簇（同一条聚类口径：3h 分簇）
    const { clusterAssetsByTime } = await import("../../../services/gallery-wall-service.js");
    const windowStart = Date.now() - days * 86_400_000;
    const clusters = clusterAssetsByTime(assets)
      .filter((cluster) => {
        const ts = Date.parse(cluster[0]!.takenAt ?? cluster[0]!.createdAt) || 0;
        return ts >= windowStart;
      })
      .sort((a, b) => b.length - a.length)
      .slice(0, count);

    const memories = clusters.map((cluster) => {
      const startTs = Date.parse(cluster[0]!.takenAt ?? cluster[0]!.createdAt);
      const d = new Date(startTs);
      const place = cluster.map((a) => a.analysis?.place ?? null).find((p) => !!p && p.trim()) ?? null;
      const withCaption = [...cluster].sort(
        (a, b) => (b.analysis?.caption ? 1 : 0) - (a.analysis?.caption ? 1 : 0),
      );
      const photos: MemoryPhoto[] = withCaption.slice(0, 3).map((a) => ({
        id: a.id,
        thumbnailUrl: `/picture/assets/${a.id}/thumbnail/medium`,
        imageUrl: `/picture/assets/${a.id}/file`,
        caption: a.analysis?.caption ?? null,
      }));
      return {
        title: `${d.getMonth() + 1}月${d.getDate()}日${place ? ` · ${place}` : ""}`,
        start: new Date(startTs).toISOString(),
        place,
        photoCount: cluster.length,
        photos,
      };
    });

    const text = memories.length
      ? memories.map((m) => `${m.title}，${m.photoCount} 张照片`).join("；")
      : `最近 ${days} 天没有照片记录。`;
    return { ok: true, days, memories, text };
  };
}
