/**
 * 旅行媒体孤儿资产清理：把「磁盘上有、但没有任何引用源指向」的文件移出资产树。
 *
 * 为什么需要（2026-10-12）：存量瘦身与断链修复跑完后，assets/ 里堆了
 * 1845 个没人引用的文件 / 713.8MB——旧原图（改名后未回收）与remote-cache
 * 抓取缓存。它们**完全不影响功能**，只是纯占磁盘，这才是体积真正的来源
 * （压缩只解决「单张多大」，回收才解决「有多少张」）。
 *
 * ── 引用源必须穷举，漏一个就误删───────────────────────────────
 *   1. `travel-poi.db` media 表的 `payload.url`（POI 实拍图，唯一权威源）
 *   2. `data/travel-media/destination-covers.json` 的 `covers` 当前封面 URL
 *   3. **同文件 `coverDirs` 登记的目录**：`resolveSuperseded` 是**目录级路由**
 *      ——「该目录下任何文件的请求都换发当前封面」，所以这些目录里的文件
 *      即使不是当前封面也可能在服务，**整个目录受保护**。
 *   4. `server/data` 下所有文本文件里的 `travel-media/assets/...` 字面引用
 *      （行程快照等历史载荷可能烤死了本地 URL）。
 *   5. `assets/remote-cache/`：纯 sha1(remoteUrl) 抓取缓存，删了会按需重抓，
 *      但仍走网络，故**默认不删**，需显式 `--purge-remote-cache`。
 *
 * 用法：
 *   node --import tsx scripts/e2e/purge-orphan-travel-assets.mjs            # 演练
 *   node --import tsx scripts/e2e/purge-orphan-travel-assets.mjs --apply     # 移入隔离区
 *   node --import tsx scripts/e2e/purge-orphan-travel-assets.mjs --apply --purge-remote-cache
 * 隔离区：data/travel-media/.quarantine/<时间戳>/，确认无影响后自行删除。
 */
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'node:url';

const SERVER = path.resolve(import.meta.dirname, '..', '..', 'server');
const MEDIA_ROOT = path.join(SERVER, 'data', 'travel-media');
const ASSETS = path.join(MEDIA_ROOT, 'assets');
const REMOTE_CACHE = 'remote-cache';
const APPLY = process.argv.includes('--apply');
const PURGE_REMOTE = process.argv.includes('--purge-remote-cache');

process.chdir(SERVER);
if (!fs.existsSync(path.join(SERVER, 'data', 'travel-poi.db'))) {
  console.error('未找到媒体库 server/data/travel-poi.db，请确认路径');
  process.exit(1);
}
const { travelPoiDb } = await import(
  pathToFileURL(path.join(SERVER, 'src', 'skills', 'travel-planning', 'travel-poi-db.ts')).href
);

const PREFIX = '/travel/media/assets/';

// ── 引用源 1：POI 媒体表
const refs = new Set();
for (const key of travelPoiDb.listMediaPoiKeys()) {
  for (const row of travelPoiDb.listAllMedia(key)) {
    let payload;
    try {
      payload = JSON.parse(row.payload_json ?? '{}');
    } catch {
      continue;
    }
    const url = String(payload.url ?? '');
    if (url.startsWith(PREFIX)) refs.add(url.slice(PREFIX.length));
  }
}

// ── 引用源 2/3：目的地封面（当前 URL + 目录级路由）
const coverFile = path.join(MEDIA_ROOT, 'destination-covers.json');
const coverDirs = new Set();
if (fs.existsSync(coverFile)) {
  const cf = JSON.parse(fs.readFileSync(coverFile, 'utf-8'));
  for (const rec of Object.values(cf.covers ?? {})) {
    const url = String(rec?.url ?? '');
    if (url.startsWith(PREFIX)) refs.add(url.slice(PREFIX.length));
  }
  for (const dir of Object.keys(cf.coverDirs ?? {})) coverDirs.add(dir);
}

// ── 引用源 4：data/ 下文本文件里的字面引用
const textRefs = new Set();
function scan(dir, depth = 0) {
  if (depth > 5) return;
  let ents;
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      // assets 是被清理的对象本身；.quarantine 已是弃置区
      if (e.name !== 'assets' && e.name !== '.quarantine') scan(p, depth + 1);
      continue;
    }
    if (!/\.(json|html|txt|ts|js|mjs)$/i.test(e.name)) continue;
    let txt;
    try {
      txt = fs.readFileSync(p, 'utf-8');
    } catch {
      continue;
    }
    for (const m of txt.matchAll(/travel-media\/assets\/[A-Za-z0-9_\-\/.]+/g)) {
      textRefs.add(m[0].slice('travel-media/assets/'.length));
    }
  }
}
scan(path.join(SERVER, 'data'));

console.log(
  `引用源：媒体表 ${refs.size} · 受保护封面目录 ${coverDirs.size} · 文本字面引用 ${textRefs.size}`,
);

const orphan = [];
let orphanBytes = 0;
let protectedCoverFiles = 0;
let protectedTextFiles = 0;
for (const dir of fs.readdirSync(ASSETS)) {
  const abs = path.join(ASSETS, dir);
  if (!fs.statSync(abs).isDirectory()) continue;
  const isCoverDir = coverDirs.has(dir);
  const isRemoteCache = dir === REMOTE_CACHE;
  for (const file of fs.readdirSync(abs)) {
    const rel = `${dir}/${file}`;
    if (refs.has(rel) || textRefs.has(rel)) continue;
    if (isCoverDir) {
      protectedCoverFiles++;
      continue;
    }
    if (isRemoteCache && !PURGE_REMOTE) continue;
    orphan.push(rel);
    orphanBytes += fs.statSync(path.join(abs, file)).size;
  }
}

console.log(`受保护：封面目录内 ${protectedCoverFiles} 份（目录级路由，不可删）`);
console.log(`孤儿文件 ${orphan.length} 份，合计 ${(orphanBytes / 1048576).toFixed(1)}MB`);
if (!PURGE_REMOTE) console.log('（remote-cache 缓存已跳过，加 --purge-remote-cache 才清）');
if (orphan.length === 0) {
  console.log('✅ 无孤儿文件');
  process.exit(0);
}
if (!APPLY) {
  console.log('演练模式。加 --apply 移入隔离区。');
  process.exit(0);
}

// 移到隔离区而非 unlink：孤儿判定一旦有漏，代价只是白占一份磁盘，不是功能损坏。
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const quarantine = path.join(MEDIA_ROOT, '.quarantine', stamp);
let moved = 0;
for (const rel of orphan) {
  const src = path.join(ASSETS, rel);
  const dst = path.join(quarantine, rel);
  try {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.renameSync(src, dst);
    moved++;
  } catch {
    /* 移不动的留着，只是白占空间 */
  }
}
console.log(`已移入隔离区 ${moved}/${orphan.length} 份 → ${quarantine}`);

// 回收空目录
let prunedDirs = 0;
for (const dir of fs.readdirSync(ASSETS)) {
  const abs = path.join(ASSETS, dir);
  try {
    if (fs.statSync(abs).isDirectory() && fs.readdirSync(abs).length === 0) {
      fs.rmdirSync(abs);
      prunedDirs++;
    }
  } catch {
    /* ignore */
  }
}
console.log(`回收空目录 ${prunedDirs} 个`);

let remaining = 0;
let remainingBytes = 0;
for (const dir of fs.readdirSync(ASSETS)) {
  const abs = path.join(ASSETS, dir);
  if (!fs.statSync(abs).isDirectory()) continue;
  for (const f of fs.readdirSync(abs)) {
    remaining++;
    remainingBytes += fs.statSync(path.join(abs, f)).size;
  }
}
console.log(`资产目录现存 ${remaining} 份 / ${(remainingBytes / 1048576).toFixed(1)}MB`);
console.log(`确认无影响后可删除隔离区：${quarantine}`);
console.log('下一步跑：node --import tsx scripts/e2e/verify-travel-media.mjs');