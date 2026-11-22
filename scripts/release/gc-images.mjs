#!/usr/bin/env node
/**
 * 云端图片原图 GC（2026-11-22 隐私方案）。
 *
 * 策略：images/<actor>/*.png 原图超过 RETAIN_DAYS 天即删除；
 *       images-thumbs/ 缩略图保留（资料库卡片仍可显示）；
 *       library-meta 里对应记录保留（URL 仍在，命中本地缓存的用户无感）。
 *
 * 前提：客户端已把媒体持久化到本地图库（media_gallery），因此 7 天前看过的
 * 图在用户手机上仍可回看；云端原图只是「最近 N 天 + 换设备首屏」的补充。
 *
 * 用法：node gc-images.mjs [--dry-run] [--days N]
 */
import { readdirSync, statSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";

const DATA_DIR = process.env.NEXTBOT_DATA_DIR
  || join(process.env.HOME || "/root", ".local/share/Nextbot/data");
const IMAGES_DIR = join(DATA_DIR, "images");

const dryRun = process.argv.includes("--dry-run");
const daysIdx = process.argv.indexOf("--days");
const RETAIN_DAYS = daysIdx >= 0 ? Number(process.argv[daysIdx + 1]) : 7;
const cutoff = Date.now() - RETAIN_DAYS * 24 * 60 * 60 * 1000;

if (!existsSync(IMAGES_DIR)) {
  console.log(`[gc-images] no images dir: ${IMAGES_DIR}`);
  process.exit(0);
}

let deleted = 0;
let bytes = 0;
let skipped = 0;

for (const actor of readdirSync(IMAGES_DIR)) {
  const dir = join(IMAGES_DIR, actor);
  let stat;
  try { stat = statSync(dir); } catch { continue; }
  if (!stat.isDirectory()) continue;
  let files;
  try { files = readdirSync(dir); } catch { continue; }
  for (const name of files) {
    if (!/\.png$/i.test(name)) continue;
    const path = join(dir, name);
    let st;
    try { st = statSync(path); } catch { continue; }
    if (st.mtimeMs >= cutoff) { skipped++; continue; }
    bytes += st.size;
    if (!dryRun) {
      try { unlinkSync(path); } catch (e) {
        console.warn(`[gc-images] delete failed ${path}: ${e.message}`);
        continue;
      }
    }
    deleted++;
  }
}

console.log(`[gc-images] ${dryRun ? "DRY-RUN " : ""}days=${RETAIN_DAYS} deleted=${deleted} kept=${skipped} freed=${(bytes / 1048576).toFixed(1)}MB`);
