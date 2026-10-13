/**
 * 旅行媒体库自检 / 修复：核对 media 表里的本地图片 url 是否真有文件。
 *
 * 为什么需要（2026-10-12）：slim-travel-media-assets.mjs 改名的同时要回写 DB，
 * 一旦「改了名但没回写 DB」就会留下悬空引用——图全挂且**无任何报错**
 * （静态路由对不存在的文件直接 404，不抛异常）。这类事故必须在工具侧被看见。
 *
 * 用法：
 *   node scripts/e2e/verify-travel-media.mjs          # 只报告
 *   node scripts/e2e/verify-travel-media.mjs --repair # 从备份 tar 恢复缺失文件
 */
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'node:url';

const SERVER = path.resolve(import.meta.dirname, '..', '..', 'server');
const ASSETS = path.join(SERVER, 'data', 'travel-media', 'assets');
const BACKUP = path.join(SERVER, 'data', 'travel-media-slim-backup.tar');
const REPAIR = process.argv.includes('--repair');
const OUT = path.join(SERVER, 'data', 'broken-media-urls.txt');

// travel-poi-db 的库路径是 process.cwd()/data（与运行时一致的服务端工作目录）。
// 不切 cwd 的话，脚本从仓库根跑时会连上/新建一个**空库**，报告「0 条数据」——
// 这不是「没断链」，是看错了库。必须先切到 server/ 再 import。
process.chdir(SERVER);
const actualDb = path.join(process.cwd(), 'data', 'travel-poi.db');
if (!fs.existsSync(actualDb)) {
  console.error(`未找到媒体库 ${actualDb}，请确认路径`);
  process.exit(1);
}

const { travelPoiDb } = await import(
  pathToFileURL(path.join(SERVER, 'src', 'skills', 'travel-planning', 'travel-poi-db.ts')).href
);

const local = [];
let external = 0;
const broken = [];
for (const key of travelPoiDb.listMediaPoiKeys()) {
  for (const row of travelPoiDb.listAllMedia(key)) {
    if (row.kind !== 'image') continue;
    const url = String(JSON.parse(row.payload_json ?? '{}').url ?? '');
    if (/^https?:/i.test(url)) {
      external++;
      continue;
    }
    const rel = url.replace('/travel/media/assets/', '');
    local.push(rel);
    if (!fs.existsSync(path.join(ASSETS, rel))) broken.push(rel);
  }
}

console.log(`本地图片条目 ${local.length}，其中断链 ${broken.length}；未本地化（外链）${external}`);
if (broken.length === 0) {
  console.log('✅ 无断链');
  process.exit(0);
}

fs.writeFileSync(OUT, broken.join('\n'));
console.log(`断链清单已写出：${OUT}`);

if (!REPAIR) {
  console.log('加 --repair 可从 travel-media-slim-backup.tar 恢复。');
  process.exit(1);
}
if (!fs.existsSync(BACKUP)) {
  console.error(`找不到备份 ${BACKUP}，无法自动恢复。`);
  process.exit(1);
}

// 用 tar 逐个抽取缺失文件（只补缺的，不覆盖现存的新压版本）。
// 逐条 execFileSync 在 24 份时够用，但 tar 每次都要重扫 800MB 归档，很慢——
// 所以先把待补清单落盘，再让 tar 从清单读（-T），一次线性扫描搞定。
const missing = broken.filter((rel) => !fs.existsSync(path.join(ASSETS, rel)));
const { execFileSync } = await import('node:child_process');
if (missing.length > 0) {
  const listFile = path.join(SERVER, 'data', '.restore-list.txt');
  fs.writeFileSync(listFile, missing.map((rel) => `travel-media/assets/${rel}`).join('\n'));
  // --force-local：GNU tar 在 Windows 上会把 `E:\...` 形式的归档参数当成
  // `host:path` 去连远端（报 "Cannot connect to E: resolve failed"）。
  execFileSync('tar', ['--force-local', '-xf', BACKUP, '-C', path.join(SERVER, 'data'), '-T', listFile], {
    stdio: 'inherit',
  });
  fs.unlinkSync(listFile);
}
console.log(`已从备份恢复 ${missing.length} 份缺失图片`);

let stillBroken = 0;
for (const rel of broken) if (!fs.existsSync(path.join(ASSETS, rel))) stillBroken++;
console.log(stillBroken === 0 ? '✅ 断链已全部修复' : `❌ 仍有 ${stillBroken} 份缺失，需人工介入`);
process.exit(stillBroken === 0 ? 0 : 1);