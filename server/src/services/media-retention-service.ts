/**
 * 媒体文件保留策略：只保留最近 7 天。
 *
 * 背景：图片原图既占磁盘（历史大图单张几十 MB），解码时又会放大内存。
 * 用户端已把媒体落到本地并做了预加载，服务端只保留 7 天作为多端同步窗口。
 *
 * 只删本服务自己命名的文件（时间戳-uuid8），目录里其他东西一律不动；
 * 缩略图缓存（images-thumbs）同步清理，避免留下指向已删原图的孤儿文件。
 *
 * 由 backgroundScheduler 每天跑一次，默认启动 5 分钟后先跑一轮（覆盖长期未重启的情况）。
 */

import { readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

import { getDataDir } from "../config/data-dir.js";
import { backgroundScheduler } from "./background-scheduler.js";

/** 保留天数：用户端已本地保存，服务端只做短期中转。 */
const RETENTION_DAYS = 7;
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;
const DAILY_MS = 24 * 60 * 60 * 1000;

/** 原图命名：`<ts>-<uuid8>.{png,webp,jpg,jpeg}` */
const IMAGE_FILE_RE = /^\d+-[a-f0-9]{8}\.(?:png|webp|jpe?g)$/i;
/** 缩略图命名：`<ts>-<uuid8>@<width>.webp` */
const THUMB_FILE_RE = /^\d+-[a-f0-9]{8}@\d+\.webp$/i;

export type MediaRetentionStats = {
  scanned: number;
  deleted: number;
  failed: number;
  freedBytes: number;
  dryRun: boolean;
};

/**
 * 执行一次保留期清理。
 *
 * `roots` 仅用于测试注入；生产固定为 data/images 与 data/images-thumbs。
 */
export async function runMediaRetentionOnce(opts: {
  now?: number;
  dryRun?: boolean;
  roots?: string[];
} = {}): Promise<MediaRetentionStats> {
  const now = opts.now ?? Date.now();
  const dryRun = opts.dryRun === true;
  const cutoff = now - RETENTION_MS;
  const roots =
    opts.roots ??
    [join(getDataDir(), "images"), join(getDataDir(), "images-thumbs")];

  const stats: MediaRetentionStats = { scanned: 0, deleted: 0, failed: 0, freedBytes: 0, dryRun };

  for (const root of roots) {
    let actors: string[];
    try {
      actors = await readdir(root);
    } catch {
      continue; // 目录不存在（还没产生过媒体）
    }

    for (const actor of actors) {
      const dir = join(root, actor);
      let files: string[];
      try {
        if (!(await stat(dir)).isDirectory()) continue;
        files = await readdir(dir);
      } catch {
        continue;
      }

      for (const name of files) {
        if (!IMAGE_FILE_RE.test(name) && !THUMB_FILE_RE.test(name)) continue;
        const full = join(dir, name);
        stats.scanned += 1;
        try {
          const st = await stat(full);
          if (!st.isFile()) continue;
          if (st.mtimeMs > cutoff) continue;
          if (!dryRun) await unlink(full);
          stats.deleted += 1;
          stats.freedBytes += st.size;
        } catch {
          // 单个文件被占用/权限问题：跳过，下一天再试
          stats.failed += 1;
        }
      }
    }
  }

  return stats;
}

let started = false;

/** 启动每日清理；重复调用幂等。 */
export function startMediaRetention(): void {
  if (started) return;
  started = true;
  backgroundScheduler.schedule({
    name: "media-retention.daily",
    intervalMs: DAILY_MS,
    firstDelayMs: 5 * 60_000,
    run: async () => {
      const s = await runMediaRetentionOnce();
      console.log(
        `[media-retention] 清理完成（保留 ${RETENTION_DAYS} 天）` +
          ` scanned=${s.scanned} deleted=${s.deleted} failed=${s.failed} ` +
          `freed=${(s.freedBytes / 1024 / 1024).toFixed(1)}MB`,
      );
    },
  });
}
