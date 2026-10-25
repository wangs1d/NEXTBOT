import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getDataDir } from "./data-dir.js";

/**
 * 服务实例身份档案——写入端(读取端:scripts/server-instance.mjs)。
 *
 * 每个持有对外 HTTP 端口的服务进程在 listen 成功后写入平台默认应用数据目录
 * (固定 %APPDATA%\Nextbot,与实际数据根无关,保证异数据根之间也能互查):
 *
 *   { pid, port, dataDir, stack, startedAt }
 *
 * 启动器(dev-server-watch / autostart)据此做异数据根互斥与冲突可见化,
 * 是 2026-10-24 双根 split-brain(删 A 根、刷 B 根)的防复发锚点。
 * remote 拓扑下只有 gateway(对外端口)写入;runtime(内部端口 3211)不写,
 * 避免覆盖对外身份。路径规则与 scripts/server-instance.mjs 必须同步修改。
 */
export function writeServerInstance(port: number, stack: string): void {
  // 测试进程不落档案:并发测试会互相覆盖且污染真实身份目录
  if (/^test/.test(process.env.npm_lifecycle_event ?? "")) return;
  try {
    const dir = identityDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "server-instance.json"),
      JSON.stringify(
        {
          pid: process.pid,
          port,
          dataDir: getDataDir(),
          stack,
          startedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
  } catch (err) {
    console.warn(
      `[server-instance] 身份档案写入失败(不影响服务):${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function identityDir(): string {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA?.trim() || join(homedir(), "AppData", "Roaming");
    return join(appData, "Nextbot");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "Nextbot");
  }
  const xdgDataHome = process.env.XDG_DATA_HOME?.trim() || join(homedir(), ".local", "share");
  return join(xdgDataHome, "Nextbot");
}
