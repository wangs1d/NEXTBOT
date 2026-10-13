/**
 * 下线旅行 POI 的视频与评论：删除 media 表里的 video/review 两类行。
 *
 * 背景（2026-10-12 用户决定）：视频能力整体下线。评论的数据来源是 B 站视频的
 * 观众留言，视频没了评论就没有来源，因此一并删除。
 *
 * 幂等：按 (poi_key, kind, item_id) 逐行删除，重复跑结果一致。
 * 只动这两类行，image 行（含存量瘦身后的新压图）完全不受影响。
 *
 * 用法：node scripts/e2e/purge-travel-videos.mjs [--dry]
 */
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'node:url';

const SERVER = path.resolve(import.meta.dirname, '..', '..', 'server');
const DRY = process.argv.includes('--dry');

// travel-poi-db 的库路径是 process.cwd()/data，必须先切到 server/ 再 import
process.chdir(SERVER);
const { travelPoiDb } = await import(
  pathToFileURL(path.join(SERVER, 'src', 'skills', 'travel-planning', 'travel-poi-db.ts')).href
);

const PURGE_KINDS = ['video', 'review'];

let videos = 0;
let reviews = 0;
let images = 0;
let thumbnails = [];

for (const key of travelPoiDb.listMediaPoiKeys()) {
  images += travelPoiDb.listMedia(key, 'image').length;
  for (const kind of PURGE_KINDS) {
    for (const row of travelPoiDb.listMedia(key, kind)) {
      // 视频条目里可能存了缩略图的本地资产路径，一并记下来稍后回收
      try {
        const payload = JSON.parse(row.payload_json ?? '{}');
        for (const key2 of ['thumbnail', 'thumbUrl', 'cover', 'coverUrl', 'poster']) {
          const v = payload[key2];
          if (typeof v === 'string' && v.includes('/travel/media/assets/')) thumbnails.push(v);
        }
      } catch {
        /* 脏数据不影响删除 */
      }
      if (!DRY) travelPoiDb.deleteMedia(key, kind, row.item_id);
      if (kind === 'video') videos++;
      else reviews++;
    }
  }
}

console.log(
  `${DRY ? '[试运行] 将删除' : '已删除'} video ${videos} 条 / review ${reviews} 条；` +
    `保留 image ${images} 条`,
);

// 回收视频封面缩略图（内容寻址，可能与其他 POI 共用同一张，删前查引用）
const uniqThumbs = [...new Set(thumbnails.map((t) => t.replace('/travel/media/assets/', '')))];
const ASSETS = path.join(SERVER, 'data', 'travel-media', 'assets');
const stillReferenced = new Set();
for (const key of travelPoiDb.listMediaPoiKeys()) {
  for (const row of travelPoiDb.listMedia(key, 'image')) {
    const u = String(JSON.parse(row.payload_json ?? '{}').url ?? '');
    if (u.includes('/travel/media/assets/')) stillReferenced.add(u.replace('/travel/media/assets/', ''));
  }
}
const removable = uniqThumbs.filter((rel) => !stillReferenced.has(rel));
let removed = 0;
if (!DRY) {
  for (const rel of removable) {
    try {
      fs.unlinkSync(path.join(ASSETS, rel));
      removed++;
    } catch {
      /* 不存在即视为已回收 */
    }
  }
}
console.log(`视频封面缩略图：${uniqThumbs.length} 个引用，去重后待回收 ${removable.length} 个，已回收 ${removed}`);

if (DRY) {
  console.log('试运行结束（未改动）。去掉 --dry 执行。');
} else {
  let left = 0;
  for (const key of travelPoiDb.listMediaPoiKeys()) {
    left += travelPoiDb.listMedia(key, 'video').length + travelPoiDb.listMedia(key, 'review').length;
  }
  console.log(left === 0 ? '✅ video/review 已清空' : `❌ 仍有 ${left} 条残留`);
}