import { cpSync, existsSync, mkdirSync } from "node:fs";
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
 *   1. NEXTBOT_DATA_DIR —— 显式指定（dev 脚本用它指向 Nextbot-dev，与安装版隔离）
 *   2. 测试进程（npm run test*）—— 用系统临时目录，绝不碰真实数据
 *   3. 平台默认目录
 *
 * 首次解析时做一次性旧数据迁移：目标目录不存在且旧 cwd/data 存在 →
 * 整目录拷贝过去（照片/POI 库/缓存一个不少）。旧目录保留不删，支持回滚。
 */

let cached: string | null = null;

/** 运行期数据目录（懒解析 + 进程内缓存；首次调用触发旧数据迁移）。 */
export function getDataDir(): string {
  if (cached) return cached;
  const dir = resolveDataDir();
  if (!isTestProcess()) migrateLegacyData(dir);
  mkdirSync(dir, { recursive: true });
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

function migrateLegacyData(target: string): void {
  if (existsSync(target)) return;
  const legacy = resolve(process.cwd(), "data");
  try {
    if (existsSync(legacy)) cpSync(legacy, target, { recursive: true });
  } catch {
    // 迁移失败不阻塞启动：服务在全新目录上照常工作，旧数据仍在原处
  }
  const legacyMemoryMedia = resolve(process.cwd(), ".memory-media");
  const memoryMediaTarget = join(target, "memory-media");
  try {
    if (existsSync(legacyMemoryMedia) && !existsSync(memoryMediaTarget)) {
      cpSync(legacyMemoryMedia, memoryMediaTarget, { recursive: true });
    }
  } catch {
    // 同上，媒体迁移失败只影响旧照片展示，不影响运行
  }
}
