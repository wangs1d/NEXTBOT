/**
 * 资料库资产迁移：把历史数据目录里的图片/行程补进当前数据目录，
 * 使手机端 GET /api/library/items 能直接看到（该接口只读 data/images 与 travel-plans）。
 *
 * 为什么需要：资料库的 images 分区只认 `data/images/<actor>/` 下
 * `时间戳-uuid8.png`（与 /agent/images/ 拉流校验一致），travelPlans 只认
 * `data/travel-plans/<actor>/`。历史账号目录、旧命名文件、旧数据目录都不会被读到。
 *
 * 用法（在 server/ 下）：
 *   npx tsx scripts/migrate-library-assets.ts --source "<旧 data 目录>" --dry-run
 *   npx tsx scripts/migrate-library-assets.ts --source "<旧 data 目录>" \
 *     --map 2378709729_qq_com=2388709729_qq_com
 *
 * 行为：
 *   - 只迁 .png；文件名不符合 `时间戳-uuid8.png` 的按 mtime 重命名（否则拉流 404）
 *   - 内容 sha1 去重，重复执行安全（幂等）
 *   - 保留 mtime（资料库按修改时间倒序）
 *   - 默认跳过 e2e-/probe-/debug- 等测试目录，--include-test 可强开
 *   - travel-plans 按 actor 分区整体复制，同样做内容去重
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

interface Args {
  source: string;
  target: string;
  map: Map<string, string>;
  dryRun: boolean;
  includeTest: boolean;
}

const CANONICAL_IMAGE = /^\d+-[a-f0-9]{8}\.png$/;
const TEST_DIR = /^(e2e|probe|debug|admin)[-_.]/i;

function parseArgs(argv: string[]): Args {
  const map = new Map<string, string>();
  let source = "";
  let target = "";
  let dryRun = false;
  let includeTest = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--source") source = argv[++i] ?? "";
    else if (arg === "--target") target = argv[++i] ?? "";
    else if (arg === "--map") {
      for (const pair of (argv[++i] ?? "").split(",")) {
        const [from, to] = pair.split("=");
        if (from && to) map.set(from.trim(), to.trim());
      }
    } else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--include-test") includeTest = true;
  }
  return { source, target, map, dryRun, includeTest };
}

async function sha1Of(path: string): Promise<string> {
  const buf = await readFile(path);
  return createHash("sha1").update(buf).digest("hex");
}

async function hashesInDir(dir: string, filter: (name: string) => boolean): Promise<Set<string>> {
  const out = new Set<string>();
  if (!existsSync(dir)) return out;
  for (const name of await readdir(dir)) {
    if (!filter(name)) continue;
    try {
      out.add(await sha1Of(join(dir, name)));
    } catch {
      // 单文件读取失败忽略
    }
  }
  return out;
}

async function migrateImages(args: Args): Promise<{ imported: number; skipped: number; dirs: string[] }> {
  const srcRoot = join(args.source, "images");
  const dstRoot = join(args.target, "images");
  let imported = 0;
  let skipped = 0;
  const dirs: string[] = [];
  if (!existsSync(srcRoot)) return { imported, skipped, dirs };

  for (const entry of await readdir(srcRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const srcActor = entry.name;
    if (TEST_DIR.test(srcActor) && !args.includeTest) continue;
    const dstActor = args.map.get(srcActor) ?? srcActor;
    const srcDir = join(srcRoot, srcActor);
    const dstDir = join(dstRoot, dstActor);
    const seen = await hashesInDir(dstDir, () => true);
    let dirImported = 0;

    for (const name of await readdir(srcDir)) {
      if (!name.toLowerCase().endsWith(".png")) continue;
      const srcPath = join(srcDir, name);
      let st;
      try {
        st = await stat(srcPath);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      let hash: string;
      try {
        hash = await sha1Of(srcPath);
      } catch {
        continue;
      }
      if (seen.has(hash)) {
        skipped += 1;
        continue;
      }
      seen.add(hash);
      // 非规范命名必须重命名：/agent/images/ 拉流只认 `时间戳-uuid8.png`
      const dstName = CANONICAL_IMAGE.test(name)
        ? name
        : `${Math.round(st.mtimeMs)}-${randomUUID().slice(0, 8)}.png`;
      if (!args.dryRun) {
        await mkdir(dstDir, { recursive: true });
        if (existsSync(join(dstDir, dstName))) {
          skipped += 1;
          continue;
        }
        await copyFile(srcPath, join(dstDir, dstName));
        await utimes(join(dstDir, dstName), st.atime, st.mtime);
      }
      imported += 1;
      dirImported += 1;
    }
    if (dirImported > 0) dirs.push(`${srcActor} -> ${dstActor} (${dirImported})`);
  }
  return { imported, skipped, dirs };
}

async function migrateTravelPlans(args: Args): Promise<{ imported: number; skipped: number }> {
  const srcRoot = join(args.source, "travel-plans");
  const dstRoot = join(args.target, "travel-plans");
  let imported = 0;
  let skipped = 0;
  if (!existsSync(srcRoot)) return { imported, skipped };

  const walk = async (dir: string): Promise<string[]> => {
    const out: string[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...(await walk(full)));
      else if (entry.name.endsWith(".json")) out.push(full);
    }
    return out;
  };

  for (const entry of await readdir(srcRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const srcActor = entry.name;
    if (TEST_DIR.test(srcActor) && !args.includeTest) continue;
    const dstActor = args.map.get(srcActor) ?? srcActor;
    const srcDir = join(srcRoot, srcActor);
    const dstDir = join(dstRoot, dstActor);
    const seen = await hashesInDir(dstDir, (n) => n.endsWith(".json"));

    for (const srcPath of await walk(srcDir)) {
      let hash: string;
      try {
        hash = await sha1Of(srcPath);
      } catch {
        continue;
      }
      if (seen.has(hash)) {
        skipped += 1;
        continue;
      }
      seen.add(hash);
      const rel = relative(srcDir, srcPath);
      const dstPath = join(dstDir, rel);
      if (!args.dryRun) {
        await mkdir(join(dstPath, ".."), { recursive: true });
        if (existsSync(dstPath)) {
          skipped += 1;
          continue;
        }
        await writeFile(dstPath, await readFile(srcPath));
        const st = await stat(srcPath);
        await utimes(dstPath, st.atime, st.mtime);
      }
      imported += 1;
    }
  }
  return { imported, skipped };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.source || !existsSync(args.source)) {
    console.error("缺少 --source（旧 data 目录）或目录不存在");
    process.exit(1);
  }
  if (!args.target) {
    const { getDataDir } = await import("../src/config/data-dir.js");
    args.target = getDataDir();
  }
  console.log(`source : ${args.source}`);
  console.log(`target : ${args.target}`);
  console.log(`map    : ${args.map.size ? [...args.map].map(([a, b]) => `${a}=${b}`).join(", ") : "(none)"}`);
  console.log(`mode   : ${args.dryRun ? "dry-run" : "copy"}`);

  const images = await migrateImages(args);
  const plans = await migrateTravelPlans(args);
  for (const line of images.dirs) console.log(`  images ${line}`);
  console.log(
    `images      imported=${images.imported} skipped(dup)=${images.skipped}`,
  );
  console.log(
    `travelPlans imported=${plans.imported} skipped(dup)=${plans.skipped}`,
  );
  console.log(args.dryRun ? "dry-run 结束，未写入" : "迁移完成");
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
