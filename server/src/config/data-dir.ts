import { mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/**
 * 统一运行期数据目录解析。
 *
 * 历史问题：各处散落 `join(process.cwd(), "data", ...)`，数据跟着进程 cwd 走——
 * dev 落在 server/data（项目目录内），安装版落在 <安装目录>\runtime\data。
 * 现在统一收敛到本模块，写入系统级应用数据目录（微信/VSCode 同款做法），
 * 与代码目录、安装目录彻底分离：
 *
 *   Windows  %APPDATA%\Nextbot\data
 *   macOS    ~/Library/Application Support/Nextbot/data
 *   Linux    $XDG_DATA_HOME/Nextbot/data（缺省 ~/.local/share）
 *
 * 解析优先级：
 *   1. NEXTBOT_DATA_DIR —— 统一在 server/.env.local 指定（loadServerEnv 以
 *      override 加载，dev/autostart/prod 所有链路强制同根；启动脚本不得各自
 *      注入分歧值——2026-10-24 之前 dev 注入 Nextbot-dev、autostart 落平台默认，
 *      同一个 :3000 双根 split-brain，删除落在 A 根、列表刷新读 B 根）
 *   2. 测试进程（npm run test*）—— 用系统临时目录，绝不碰真实数据
 *   3. 平台默认目录（打包安装版无 .env.local 时的兜底）
 *
 * 旧数据迁移不在启动期自动整目录回灌（目标目录一旦为空，server/data 之类的
 * 陈旧全量副本会被原样灌回来，实证过是僵尸数据复活源）；改为显式命令：
 *   npm run migrate:legacy
 */

let cached: string | null = null;

/** 运行期数据目录（懒解析 + 进程内缓存；首次调用触发旧数据迁移）。 */
export function getDataDir(): string {
  if (cached) return cached;
  const dir = resolveDataDir();
  mkdirSync(dir, { recursive: true });
  if (!isTestProcess()) {
    // 首次解析即打印：index/gateway/runtime 任一进程的启动日志都能直接核对
    // 自己在读哪个根，双根 split-brain 靠它第一时间暴露
    console.log(`[data-dir] 数据根: ${dir}`);
  }
  cached = dir;
  return dir;
}

/** 解析「相对数据目录」的路径（env 配置项用）；绝对路径原样返回。 */
export function resolveDataPath(p: string): string {
  return isAbsolute(p) ? resolve(p) : join(getDataDir(), p);
}

function resolveDataDir(): string {
  const override = process.env.NEXTBOT_DATA_DIR?.trim();
  if (override) return resolve(override);
  if (isTestProcess()) return join(tmpdir(), "nextbot-test-data");
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

/** npm run test*（含 test:master-agent 等）都算测试进程；直接跑 tsx 的 eval 脚本不算。 */
function isTestProcess(): boolean {
  return /^test/.test(process.env.npm_lifecycle_event ?? "");
}
