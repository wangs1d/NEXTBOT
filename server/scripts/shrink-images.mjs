#!/usr/bin/env node
/**
 * 历史大图收缩（一次性的磁盘治理脚本，独立进程运行，不占服务主线程）。
 *
 * 背景：早期图片落盘一律走 PNG 原样保存，单张 20~67MB，data 目录被媒体图撑满；
 * 单张解码后位图 200MB+，两三个并发就能把容器内存顶穿。
 *
 * 本脚本只做两件无损/低损的事：
 *   1. 长边超过上限的图等比缩到上限（默认 2048）
 *   2. 用最高压缩级别重编码 PNG
 * 并**保持文件名与扩展名不变**——历史消息里的 `/agent/images/x.png` URL 不受影响。
 *
 * 默认 dry-run：只统计能省多少，不写盘。确认后再加 `--apply`。
 *
 * 用法：
 *   node server/scripts/shrink-images.mjs                 # 预览
 *   node server/scripts/shrink-images.mjs --apply         # 实际执行
 *   node server/scripts/shrink-images.mjs --apply --min-mb 2 --max-edge 2048
 *   node server/scripts/shrink-images.mjs --apply --dir data/images --dir data/shared-travel-img
 */

import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const keepOriginals = args.includes("--keep-originals");

function argValue(name, fallback) {
  const idx = args.indexOf(name);
  if (idx < 0) return fallback;
  const raw = args[idx + 1];
  return raw && !raw.startsWith("--") ? raw : fallback;
}

const minMb = Number.parseFloat(argValue("--min-mb", "1")) || 1;
const maxEdge = Number.parseInt(argValue("--max-edge", "2048"), 10) || 2048;
const minBytes = minMb * 1024 * 1024;

const here = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const serverDir = resolve(here, "..");
const dataDir = process.env.AGENT_DATA_DIR?.trim() || join(serverDir, "data");

const dirs = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--dir" && args[i + 1]) dirs.push(resolve(serverDir, args[i + 1]));
}
if (dirs.length === 0) dirs.push(join(dataDir, "images"), join(dataDir, "shared-travel-img"));

const SKIP_DIRS = new Set(["images-thumbs", "_media-archive", "crash-dumps", "_retired", "node_modules"]);

async function* walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

const sharp = (await import("sharp")).default;

let scanned = 0;
let candidates = 0;
let savedBytes = 0;
let processed = 0;
const manifest = [];

for (const dir of dirs) {
  for await (const file of walk(dir)) {
    if (!/\.(png|jpe?g|webp|avif)$/i.test(file)) continue;
    scanned++;
    let st;
    try {
      st = await stat(file);
    } catch {
      continue;
    }
    if (st.size < minBytes) continue;

    const ext = extname(file).toLowerCase();
    if (ext !== ".png") {
      // 只处理历史 PNG（新图已经是 WebP）
      continue;
    }

    candidates++;
    try {
      const input = await readFile(file);
      const meta = await sharp(input, { animated: false }).metadata();
      const longEdge = Math.max(meta.width ?? 0, meta.height ?? 0);
      const buf = await sharp(input, { animated: false })
        .rotate()
        .resize({ width: maxEdge, height: maxEdge, fit: "inside", withoutEnlargement: true })
        .png({ compressionLevel: 9, effort: 8 })
        .toBuffer();

      // 只在确实更小时替换（避免把已优化的图重新编码变大）
      if (buf.length >= st.size * 0.95) continue;

      const delta = st.size - buf.length;
      savedBytes += delta;
      manifest.push({
        file,
        beforeBytes: st.size,
        afterBytes: buf.length,
        longEdge,
        maxEdge,
      });

      if (apply) {
        const tmp = `${file}.tmp-${process.pid}`;
        await writeFile(tmp, buf);
        await rename(tmp, file);
        if (keepOriginals) {
          const archive = join(dataDir, "_media-archive");
          await mkdir(archive, { recursive: true });
          await writeFile(join(archive, `${Date.now()}-${file.split(/[\\/]/).pop()}`), input);
        }
        processed++;
      }
    } catch (err) {
      console.warn(`[shrink-images] 跳过 ${file}: ${err instanceof Error ? err.message : err}`);
    }
  }
}

const mb = (n) => `${(n / 1024 / 1024).toFixed(2)} MB`;
console.log(
  `[shrink-images] 扫描 ${scanned} 个文件，候选（PNG ≥ ${minMb}MB）${candidates} 个，` +
    `可省 ${mb(savedBytes)}${apply ? `，已处理 ${processed} 个` : "（dry-run，加 --apply 执行）"}`,
);
if (manifest.length > 0) {
  const manifestPath = join(dataDir, "shrink-images-manifest.json");
  if (apply) {
    await writeFile(manifestPath, JSON.stringify({ at: new Date().toISOString(), items: manifest }, null, 2));
    console.log(`[shrink-images] 清单已写入 ${manifestPath}`);
  }
  for (const item of manifest.slice(0, 20)) {
    console.log(
      `  ${item.file}  ${mb(item.beforeBytes)} → ${mb(item.afterBytes)}  (长边 ${item.longEdge})`,
    );
  }
  if (manifest.length > 20) console.log(`  ... 其余 ${manifest.length - 20} 项见清单`);
}
