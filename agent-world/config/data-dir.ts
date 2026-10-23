/**
 * agent-world 运行期数据目录解析（与 server/src/config/data-dir.ts 同构）。
 *
 * 本包是可独立运行的便携模块，不能反向依赖 server；但持久化路径必须与宿主
 * server 落在同一数据目录——否则 dev 栈（NEXTBOT_DATA_DIR 指向 Nextbot-dev）
 * 下 world-state / social-feed 会散落到进程 cwd 的 data/ 里，与仓库混住。
 *
 * 解析优先级与 server 侧一致：
 *   1. NEXTBOT_DATA_DIR —— 显式指定（dev / 安装版启动器注入）
 *   2. 测试进程（npm run test*）—— 系统临时目录，绝不碰真实数据
 *   3. 平台默认应用数据目录
 */

import { mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

let cached: string | null = null;

/** 运行期数据目录（懒解析 + 进程内缓存）。 */
export function getDataDir(): string {
  if (cached) return cached;
  const override = process.env.NEXTBOT_DATA_DIR?.trim();
  const dir = override
    ? resolve(override)
    : isTestProcess()
      ? join(tmpdir(), "nextbot-test-data")
      : defaultDataDir();
  mkdirSync(dir, { recursive: true });
  cached = dir;
  return dir;
}

function defaultDataDir(): string {
  if (process.platform === "win32") {
    return join(process.env.APPDATA?.trim() || join(homedir(), "AppData", "Roaming"), "Nextbot", "data");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "Nextbot", "data");
  }
  return join(process.env.XDG_DATA_HOME?.trim() || join(homedir(), ".local", "share"), "Nextbot", "data");
}

/** npm run test* 算测试进程；直接跑 tsx/vitest 的独立脚本不算。 */
function isTestProcess(): boolean {
  return /^test/.test(process.env.npm_lifecycle_event ?? "");
}

/** 解析「相对数据目录」的路径；绝对路径原样返回。 */
export function resolveDataPath(p: string): string {
  return isAbsolute(p) ? resolve(p) : join(getDataDir(), p);
}
