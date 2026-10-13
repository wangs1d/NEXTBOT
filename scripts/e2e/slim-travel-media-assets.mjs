/**
 * 旅行媒体资产存量瘦身：把已落盘的**原图**就地重编码为受控尺寸。
 *
 * 为什么需要（2026-10-12）：本地化原本原样保存上游字节，assets 存量
 * 1970 张 / 762MB，最大单张 9.3MB。写侧已加 normalizeDownloadedImage 收口
 * （travel-media-store.downloadImage），存量不会自动变小——须离线重刷。
 * 实测收益：762MB → 约 214MB（3.6x）。
 *
 * ── 三个必须做对的点（前两次跑挂在这上面）────────────────────
 *  1. **先 chdir 到 server/**：travel-poi-db 的库路径是 `process.cwd()/data`。
 *     不切 cwd 就从仓库根跑，会连上/新建一个**空库** → 「改名写盘」照做、
 *     「DB 回写」全 miss → 文件改了名而 DB 还指旧名 = 24 张悬空断链，
 *     且静态路由对不存在的文件直接 404 不报错，故障完全静默。
 *  2. **四阶段分离 + 幂等**：计划 / 写盘 / 回写 DB / 删旧，每阶段都能重跑。
 *     上一次把四步糅在一起，中途被杀就留下「新旧并存」的烂摊子（1.1G/4052 文件）。
 *  3. **跳过已压文件**：判据是 `宽 ≤ 1280 且字节 ≤ 120KB` 或「重编码没变小」。
 *     缺这一条时，已压过的图会被二次压缩并生成新 sha → 又一轮改名，脚本永远收敛不了。
 *
 * 用法：
 *   node scripts/e2e/slim-travel-media-assets.mjs            # 演练，只报告
 *   node scripts/e2e/slim-travel-media-assets.mjs --apply    # 真改（含改 DB）
 * 配套自检（必跑）：node scripts/e2e/verify-travel-media.mjs
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
const PLAN_FILE = path.join(SERVER, 'data', 'slim-travel-media-plan.json');
const MAX_EDGE = 1280;
const QUALITY = 76;
const SMALL_ENOUGH = 120 * 1024;
const APPLY = process.argv.includes('--apply');

process.chdir(SERVER);
if (!fs.existsSync(path.join(SERVER, 'data', 'travel-poi.db'))) {
  console.error('未找到 media 库 server/data/travel-poi.db，请确认路径');
  process.exit(1);
}
const dbModulePath = path.join(SERVER, 'src', 'skills', 'travel-planning', 'travel-poi-db.ts');
const { travelPoiDb } = await import(pathToFileURL(dbModulePath).href);

// ───────────────────────── 阶段 1：出计划（纯计算，不写盘）─────────────────────────
// 计划落盘后可重入：中途被杀再跑会复用已有计划，不会重扫 800MB。
let plan;
if (fs.existsSync(PLAN_FILE)) {
  plan = JSON.parse(fs.readFileSync(PLAN_FILE, 'utf8'));
  console.log(`复用已有计划：${plan.entries.length} 条待处理`);
} else {
  const entries = [];
  let scanned = 0;
  let before = 0;
  let after = 0;
  for (const dir of fs.readdirSync(ASSETS)) {
    const abs = path.join(ASSETS, dir);
    if (!fs.statSync(abs).isDirectory()) continue;
    for (const file of fs.readdirSync(abs)) {
      if (!/\.(jpg|jpeg|png)$/i.test(file)) continue;
      const full = path.join(abs, file);
      const size = fs.statSync(full).size;
      scanned++;
      before += size;
      if (size <= SMALL_ENOUGH) {
        after += size;
        continue;
      }
      try {
        const meta = await sharp(full).metadata();
        // 关键幂等判据：已经限宽过的直接跳过，二次压缩只会白白生成新 sha
        if ((meta.width ?? 0) <= MAX_EDGE && (meta.format === 'jpeg')) {
          after += size;
          continue;
        }
        const buf = await sharp(full).rotate().resize({ width: MAX_EDGE, withoutEnlargement: true })
          .jpeg({ quality: QUALITY, mozjpeg: true }).toBuffer();
        if (buf.length >= size) {
          after += size;
          continue;
        }
        const newSha = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
        const to = `${newSha}.jpg`;
        entries.push({ dir, from: file, to, size, newSize: buf.length });
        after += buf.length;
      } catch {
        after += size;
      }
    }
  }
  plan = { entries, scanned, before, after };
  fs.writeFileSync(PLAN_FILE, JSON.stringify(plan));
  console.log(
    `计划生成：scanned=${scanned} 待处理=${entries.length} ` +
      `${(before / 1048576).toFixed(1)}MB -> ${(after / 1048576).toFixed(1)}MB`,
  );
}

const { entries } = plan;
console.log(
  `计划总量：${(plan.before / 1048576).toFixed(1)}MB -> ${(plan.after / 1048576).toFixed(1)}MB ` +
    `(${(plan.before / plan.after).toFixed(2)}x)，共 ${entries.length} 条`,
);
if (!APPLY) {
  console.log('演练模式（未改文件与 DB）。加 --apply 执行。');
  process.exit(0);
}

// ───────────────────────── 阶段 2：写新文件（不删旧）─────────────────────────
// 先写不删：此刻 DB 还指旧名，中断只会多留无主文件；反过来先删就是断链。
let written = 0;
for (const e of entries) {
  const target = path.join(ASSETS, e.dir, e.to);
  if (fs.existsSync(target)) continue;
  const src = path.join(ASSETS, e.dir, e.from);
  if (!fs.existsSync(src)) continue;
  const buf = await sharp(src).rotate().resize({ width: MAX_EDGE, withoutEnlargement: true })
    .jpeg({ quality: QUALITY, mozjpeg: true }).toBuffer();
  fs.writeFileSync(target, buf);
  if (++written % 200 === 0) process.stdout.write(`  写入 ${written}/${entries.length}\n`);
}
console.log(`新文件就位：${written} 份（复用已存在 ${entries.length - written} 份）`);

// ───────────────────────── 阶段 3：回写 DB ─────────────────────────
// 键用 `dir/from`，与 DB 里 url 去掉 `/travel/media/assets/` 后的 `dir/file` 精确对齐。
const fileMap = new Map();
for (const e of entries) fileMap.set(`${e.dir}/${e.from}`, e);

let touched = 0;
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
    if (!url.startsWith('/travel/media/assets/')) continue;
    const rel = url.slice('/travel/media/assets/'.length);
    const hit = fileMap.get(rel);
    if (!hit) continue;
    payload.url = `/travel/media/assets/${hit.dir}/${hit.to}`;
    payload.sha256 = hit.to.slice(0, hit.to.indexOf('.'));
    travelPoiDb.upsertMedia({
      poiKey: row.poi_key,
      kind: 'image',
      itemId: row.item_id,
      payload,
      createdAt: row.created_at,
    });
    touched++;
  }
}
console.log(`DB 回写：${touched}/${entries.length} 条已指向新文件`);
if (touched === 0 && entries.length > 0) {
  console.error('❌ 一条都没回写上——多半又连到了空库（cwd 不对）。已中止，**不删旧文件**。');
  process.exit(1);
}

// ───────────────────────── 阶段 4：回收旧文件 ─────────────────────────
let reclaimed = 0;
for (const e of entries) {
  try {
    const old = path.join(ASSETS, e.dir, e.from);
    if (fs.existsSync(old) && fs.existsSync(path.join(ASSETS, e.dir, e.to))) {
      fs.unlinkSync(old);
      reclaimed++;
    }
  } catch {
    /* 留着只是多占空间，不影响正确性 */
  }
}
console.log(`回收旧原图：${reclaimed}/${entries.length} 份`);
fs.unlinkSync(PLAN_FILE);

let total = 0;
for (const d of fs.readdirSync(ASSETS)) {
  const abs = path.join(ASSETS, d);
  if (!fs.statSync(abs).isDirectory()) continue;
  for (const f of fs.readdirSync(abs)) total += fs.statSync(path.join(abs, f)).size;
}
console.log(`资产目录现占 ${(total / 1048576).toFixed(1)}MB`);
console.log('下一步务必跑：node scripts/e2e/verify-travel-media.mjs');