import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";

import sharp from "sharp";
import type { ImageAsset, PictureKit } from "@nextbot/picture";

/**
 * 图库回收站（批量删除/盲盒清理的安全网）。
 *
 * 删除流程改为：asset 的原图与缩略图**移入** <pictureRoot>/trash/，
 * 索引记录随 trash.json 一起保存，30 天后惰性真删；恢复则把文件放回
 * 原路径并经 ImageStore.restore 重建索引（缩略图缺失时自动重生成）。
 *
 * 目录结构：
 *   trash/<trashId><ext>            原图
 *   trash/<trashId>_t_<size><ext>   缩略图（保持原扩展名）
 *   trash/<trashId>_preview.webp    列表预览图（320 宽）
 *   trash/trash.json                台账
 */

const TRASH_INDEX_VERSION = 1;
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PREVIEW_WIDTH = 320;

export interface TrashEntry {
  trashId: string;
  asset: ImageAsset;
  deletedAt: string;
  /** 回收站内的文件路径（恢复时移回原位） */
  originalTrashPath: string;
  thumbTrashPaths: Record<string, string>;
  previewPath: string;
}

interface TrashIndex {
  version: 1;
  entries: Record<string, TrashEntry>;
}

export interface TrashItemSummary {
  trashId: string;
  fileName: string;
  fileSize: number | null;
  takenAt: string | null;
  deletedAt: string;
  previewUrl: string;
}

export class PictureTrashService {
  private readonly index: TrashIndex = { version: TRASH_INDEX_VERSION, entries: {} };
  private indexLoaded = false;

  constructor(
    private readonly trashDir: string,
    private readonly pictureKit: PictureKit,
  ) {}

  private get indexPath(): string {
    return join(this.trashDir, "trash.json");
  }

  private async ensureLoaded(): Promise<void> {
    if (this.indexLoaded) return;
    try {
      const raw = JSON.parse(await readFile(this.indexPath, "utf8")) as TrashIndex;
      if (raw.version === TRASH_INDEX_VERSION && raw.entries) {
        Object.assign(this.index.entries, raw.entries);
      }
    } catch {
      // 无台账/损坏 → 从空开始
    }
    this.indexLoaded = true;
  }

  private async persist(): Promise<void> {
    await mkdir(this.trashDir, { recursive: true });
    const tmp = `${this.indexPath}.tmp`;
    await writeFile(tmp, JSON.stringify(this.index, null, 2), "utf8");
    await rename(tmp, this.indexPath);
  }

  private async safeRename(from: string, to: string): Promise<void> {
    if (!existsSync(from)) return;
    await mkdir(dirname(to), { recursive: true });
    await rename(from, to);
  }

  /** 把一张照片移入回收站，返回 trashId（失败抛错，调用方回退硬删） */
  async moveIn(asset: ImageAsset): Promise<string> {
    await this.ensureLoaded();
    await mkdir(this.trashDir, { recursive: true });
    const trashId = randomUUID().replace(/-/g, "").slice(0, 16);
    const originalTrashPath = join(this.trashDir, `${trashId}${extname(asset.filePath) || ".png"}`);
    await this.safeRename(asset.filePath, originalTrashPath);

    const thumbTrashPaths: Record<string, string> = {};
    for (const [size, p] of Object.entries(asset.thumbnails ?? {})) {
      const target = join(this.trashDir, `${trashId}_t_${size}${extname(p) || ".webp"}`);
      await this.safeRename(p, target);
      thumbTrashPaths[size] = target;
    }

    // 列表预览图（缩略图可能已被移走，从回收站内的原图生成）
    const previewPath = join(this.trashDir, `${trashId}_preview.webp`);
    try {
      await sharp(originalTrashPath, { animated: false })
        .rotate()
        .resize({ width: PREVIEW_WIDTH, withoutEnlargement: true })
        .webp({ quality: 78 })
        .toFile(previewPath);
    } catch {
      // 预览生成失败不阻塞入站；列表项显示占位
    }

    this.index.entries[trashId] = {
      trashId,
      asset,
      deletedAt: new Date().toISOString(),
      originalTrashPath,
      thumbTrashPaths,
      previewPath,
    };
    await this.persist();
    return trashId;
  }

  /** 恢复一张照片：文件移回原位 + 索引重建 */
  async restore(trashId: string): Promise<boolean> {
    await this.ensureLoaded();
    const entry = this.index.entries[trashId];
    if (!entry) return false;
    await this.safeRename(entry.originalTrashPath, entry.asset.filePath);
    for (const [size, trashPath] of Object.entries(entry.thumbTrashPaths)) {
      const original = entry.asset.thumbnails?.[size];
      if (original) await this.safeRename(trashPath, original);
    }
    await rm(entry.previewPath, { force: true });
    delete this.index.entries[trashId];
    await this.persist();
    await this.pictureKit.store.restore(entry.asset);
    return true;
  }

  /** 彻底删除（跳过 TTL 提前真删）：文件清掉 + 台账移除 */
  async hardDelete(trashId: string): Promise<boolean> {
    await this.ensureLoaded();
    const entry = this.index.entries[trashId];
    if (!entry) return false;
    await rm(entry.originalTrashPath, { force: true });
    for (const p of Object.values(entry.thumbTrashPaths)) await rm(p, { force: true });
    await rm(entry.previewPath, { force: true });
    delete this.index.entries[trashId];
    await this.persist();
    return true;
  }

  /** 惰性清理：真删超过 TTL 的条目 */
  async purge(maxAgeMs: number = DEFAULT_TTL_MS): Promise<number> {
    await this.ensureLoaded();
    const cutoff = Date.now() - maxAgeMs;
    let purged = 0;
    for (const entry of Object.values(this.index.entries)) {
      if (Date.parse(entry.deletedAt) > cutoff) continue;
      await rm(entry.originalTrashPath, { force: true });
      for (const p of Object.values(entry.thumbTrashPaths)) await rm(p, { force: true });
      await rm(entry.previewPath, { force: true });
      delete this.index.entries[entry.trashId];
      purged++;
    }
    if (purged > 0) await this.persist();
    return purged;
  }

  /** 台账列表（新删在前；顺带惰性清理） */
  async list(): Promise<{ items: TrashItemSummary[]; totalBytes: number }> {
    await this.ensureLoaded();
    await this.purge();
    const items = Object.values(this.index.entries)
      .sort((a, b) => Date.parse(b.deletedAt) - Date.parse(a.deletedAt))
      .map((entry) => ({
        trashId: entry.trashId,
        fileName: entry.asset.fileName,
        fileSize: entry.asset.fileSize ?? null,
        takenAt: entry.asset.takenAt ?? entry.asset.createdAt,
        deletedAt: entry.deletedAt,
        previewUrl: `/picture/trash/${entry.trashId}/preview`,
      }));
    return {
      items,
      totalBytes: items.reduce((n, item) => n + (item.fileSize ?? 0), 0),
    };
  }

  /** 预览图路径（未入站/已清理返回 null） */
  async getPreviewPath(trashId: string): Promise<string | null> {
    await this.ensureLoaded();
    return this.index.entries[trashId]?.previewPath ?? null;
  }

  /** 测试与运维用：当前台账条数 */
  async size(): Promise<number> {
    await this.ensureLoaded();
    return Object.keys(this.index.entries).length;
  }
}
