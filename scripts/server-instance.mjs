/**
 * 服务实例身份档案——启动器侧读取端(写入端:server/src/config/server-instance.ts)。
 *
 * 每个持有对外 HTTP 端口的服务进程 listen 成功后写 server-instance.json
 * (pid/port/dataDir/stack/startedAt),启动器据此回答「:3000 被谁、用哪个
 * 数据根占着」。2026-10-24 双根 split-brain(删 A 根、刷 B 根)的防复发锚点:
 * 异数据根的实例互斥,同根实例自愈互不干预。
 *
 * 注意:身份档案固定放平台默认应用数据目录(与实际数据根无关),保证异数据根
 * 之间也能互查;路径规则必须与 server/src/config/server-instance.ts 同步修改。
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** 身份档案绝对路径(与 server-instance.ts 的 identityDir 同规则)。 */
export function instanceFilePath() {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA?.trim() || join(homedir(), "AppData", "Roaming");
    return join(appData, "Nextbot", "server-instance.json");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "Nextbot", "server-instance.json");
  }
  const xdg = process.env.XDG_DATA_HOME?.trim() || join(homedir(), ".local", "share");
  return join(xdg, "Nextbot", "server-instance.json");
}

/** 读取身份档案;缺失/损坏返回 null(旧实例或外部进程占用时无档案)。 */
export function readServerInstance() {
  try {
    const raw = JSON.parse(readFileSync(instanceFilePath(), "utf8"));
    return raw && Number.isFinite(raw.pid) ? raw : null;
  } catch {
    return null;
  }
}

/** pid 存活探测(EPERM 视为存活,与 autostart-server 同语义)。 */
export function isPidAlive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (err) {
    return /** @type {NodeJS.ErrnoException} */ (err).code === "EPERM";
  }
}

/** 本栈将要使用的数据根(env 优先,否则平台默认),与 data-dir.ts 解析同规则。 */
export function ownDataDir() {
  const override = process.env.NEXTBOT_DATA_DIR?.trim();
  if (override) return override;
  if (process.platform === "win32") {
    const appData = process.env.APPDATA?.trim() || join(homedir(), "AppData", "Roaming");
    return join(appData, "Nextbot", "data");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "Nextbot", "data");
  }
  const xdg = process.env.XDG_DATA_HOME?.trim() || join(homedir(), ".local", "share");
  return join(xdg, "Nextbot", "data");
}

function normalizeRoot(p) {
  return String(p ?? "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export function sameDataRoot(a, b) {
  const na = normalizeRoot(a);
  return na !== "" && na === normalizeRoot(b);
}

/**
 * 端口被占时的可见化:打印占用者身份,异数据根时给出醒目修复指引。
 * 只日志不改退出码——「已 在 运 行」仍是合法终态,互斥由 listen 绑定保证。
 */
export function warnPortOwner(port) {
  const owner = readServerInstance();
  if (!owner) {
    console.warn(
      `[port] 端口 ${port} 已被占用，但无实例身份档案（旧实例或外部进程），占用者数据根未知`,
    );
    return null;
  }
  const startedMs = Date.parse(owner.startedAt ?? "");
  const ageMin = Number.isFinite(startedMs)
    ? Math.max(0, Math.round((Date.now() - startedMs) / 60_000))
    : -1;
  console.warn(
    `[port] 端口 ${port} 由 pid=${owner.pid} 占用（stack=${owner.stack ?? "?"}，` +
      `数据根=${owner.dataDir}，启动于 ${ageMin} 分钟前）`,
  );
  if (!sameDataRoot(owner.dataDir, ownDataDir())) {
    console.error(
      `[port] ⚠ 数据根不一致：本栈将使用 ${ownDataDir()}，而占用者用 ${owner.dataDir}。` +
        `这正是 2026-10-24「行程删了却没变」双根 split-brain 的成因；` +
        `请统一 server/.env.local 的 NEXTBOT_DATA_DIR 后再启动本栈。`,
    );
  }
  return owner;
}
