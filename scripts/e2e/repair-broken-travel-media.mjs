/**
 * 旅行媒体断链修复：把「DB 指向的文件不存在」的行拉回可用状态。
 *
 * 背景（2026-10-12）：存量瘦身分四阶段跑，中途有一轮 DB 回写与文件改名
 * 不同步，留下了 367 条悬空引用。这类故障**完全静默**——静态路由对不存在
 * 的文件直接 404 不抛异常，只有自检脚本能看见。
 *
 * 修复策略（按优先级，都不需要联网）：
 *   1. 行内 `item_id` 指向的**原图仍在磁盘** → 重新压缩成合规尺寸，写新文件，
 *      回写 url/sha256。既修链又保持瘦身成果（365 条走这条）。
 *   2. 原图也不在 → 该图已彻底丢失（瘦身删旧后无主），删掉这行 media，
 *      避免永久悬空。下次 refresh 会按originUrl 重新抓（2 条走这条）。
 *
 * 用法：
 *   node --import tsx scripts/e2e/repair-broken-travel-media.mjs          # 演练
 *   node --import tsx scripts/e2e/repair-broken-travel-media.mjs --apply
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const sharp = require('sharp');

const SERVER = path.resolve(import.meta.dirname, '..', '..', 'server');
const ASSETS = path.join(SERVER, 'data', 'travel-media', 'assets');
const MAX_EDGE = 1280;
const QUALITY = 76;
const APPLY = process.argv.includes('--apply');

// travel-poi-db 的库路径是 process.cwd()/data：不切 cwd 会连上/新建空库，
// 报告「0 条数据」——那不是「没问题」，是看错了库。
process.chdir(SERVER);
if (!fs.existsSync(path.join(SERVER, 'data', 'travel-poi.db'))) {
  console.error('未找到媒体库 server/data/travel-poi.db，请确认路径');
  process.exit(1);
}
const { travelPoiDb } = await import(
  pathToFileURL(path.join(SERVER, 'src', 'skills', 'travel-planning', 'travel-poi-db.ts')).href
);

const broken = [];
for (const key of travelPoiDb.listMediaPoiKeys()) {
  for (const row of travelPoiDb.listAllMedia(key)) {
    if (row.kind !== 'image') continue;
    let payload;
    try {
      payload = JSON.parse(row.payload_json ?? '{}');
    } catch {
      continue;
    }
    const url = String(payload.url ?? '');
    if (/^https?:/i.test(url) || !url) continue;
    const rel = url.replace('/travel/media/assets/', '');
    if (fs.existsSync(path.join(ASSETS, rel))) continue;
    const srcRel = String(row.item_id ?? '').replace('/travel/media/assets/', '');
    broken.push({ row, payload, rel, srcRel, srcAbs: srcRel ? path.join(ASSETS, srcRel) : '' });
  }
}

console.log(`断链 ${broken.length} 条`);
if (broken.length === 0) {
  console.log('✅ 无需修复');
  process.exit(0);
}

const recoverable = broken.filter((b) => b.srcRel && fs.existsSync(b.srcAbs));
const orphan = broken.filter((b) => !(b.srcRel && fs.existsSync(b.srcAbs)));
console.log(`  可从原图重压修复：${recoverable.length}；原图也已丢失（将删行）：${orphan.length}`);
if (!APPLY) {
  console.log('演练模式（未改文件与 DB）。加 --apply 执行。');
  process.exit(0);
}

let fixed = 0;
let failed = 0;
for (const b of recoverable) {
  try {
    const buf = await sharp(b.srcAbs).rotate()
      .resize({ width: MAX_EDGE, withoutEnlargement: true })
      .jpeg({ quality: QUALITY, mozjpeg: true }).toBuffer();
    const sha = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
    const dir = path.dirname(b.rel);
    const target = path.join(ASSETS, dir, `${sha}.jpg`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (!fs.existsSync(target)) fs.writeFileSync(target, buf);
    b.payload.url = `/travel/media/assets/${dir}/${sha}.jpg`;
    b.payload.sha256 = sha;
    travelPoiDb.upsertMedia({
      poiKey: b.row.poi_key,
      kind: 'image',
      itemId: b.row.item_id,
      payload: b.payload,
      createdAt: b.row.created_at,
    });
    fixed++;
  } catch {
    failed++;
  }
}
console.log(`重压修复 ${fixed} 条（失败 ${failed}）`);

let dropped = 0;
for (const b of orphan) {
  try {
    if (travelPoiDb.deleteMedia(b.row.poi_key, 'image', b.row.item_id)) dropped++;
  } catch {
    /* 删不掉就留着，下次 refresh 会因 url 不存在而重新登记 */
  }
}
console.log(`清理彻底丢失的行 ${dropped} 条`);

// 自检：修复后重新核对一遍，绝不「报告成功但仍有断链」
let stillBroken = 0;
for (const key of travelPoiDb.listMediaPoiKeys()) {
  for (const row of travelPoiDb.listAllMedia(key)) {
    if (row.kind !== 'image') continue;
    let payload;
    try {
      payload = JSON.parse(row.payload_json ?? '{}');
    } catch {
      continue;
    }
    const url = String(payload.url ?? '');
    if (/^https?:/i.test(url) || !url) continue;
    if (!fs.existsSync(path.join(ASSETS, url.replace('/travel/media/assets/', '')))) stillBroken++;
  }
}
console.log(stillBroken === 0 ? '✅ 断链已清零' : `❌ 仍有 ${stillBroken} 条断链`);
process.exit(stillBroken === 0 ? 0 : 1);