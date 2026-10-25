/**
 * 旧数据显式迁移:cwd/data(及 .memory-media)→ 当前数据根。
 *
 * 2026-10-24 起启动期自动整目录回灌已移除——目标目录一旦为空,server/data
 * 之类的陈旧全量副本会被原样灌回来(实证过是僵尸数据复活源:用户删掉的
 * 行程经由它重新出现在列表)。需要迁移时手动执行:
 *
 *   npm run migrate:legacy
 *
 * 仅当目标数据根不存在时执行(全新机器首次迁移);目标已存在一律拒绝,
 * 避免把陈旧副本灌进活跃数据根。目标解析与 server/src/config/data-dir.ts
 * 同规则(env 优先 → 平台默认)。
 */
import { cpSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

function resolveDataDir() {
  const override = process.env.NEXTBOT_DATA_DIR?.trim();
  if (override) return resolve(override);
  if (process.platform === "win32") {
    const appData = process.env.APPDATA?.trim() || join(homedir(), "AppData", "Roaming");
    return join(appData, "Nextbot", "data");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "Nextbot", "data");
  }
  const xdgDataHome = process.env.XDG_DATA_HOME?.trim() || join(homedir(), ".local", "share");
  return join(xdgDataHome, "Nextbot", "data");
}

const target = resolveDataDir();
if (existsSync(target)) {
  console.error(`[migrate-legacy] 目标数据根已存在，拒绝回灌：${target}`);
  process.exit(1);
}
const legacy = resolve(process.cwd(), "data");
if (!existsSync(legacy)) {
  console.error(
    `[migrate-legacy] 未找到旧数据目录：${legacy}（需在含 data/ 的目录下执行，通常为 server/）`,
  );
  process.exit(1);
}
cpSync(legacy, target, { recursive: true });
const legacyMedia = resolve(process.cwd(), ".memory-media");
if (existsSync(legacyMedia)) {
  cpSync(legacyMedia, join(target, "memory-media"), { recursive: true });
}
console.log(`[migrate-legacy] 已迁移 ${legacy} → ${target}`);
