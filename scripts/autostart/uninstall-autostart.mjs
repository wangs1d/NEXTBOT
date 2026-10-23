/**
 * 注销开机自启（仅 Windows）：删除计划任务与 Run 键，
 * 并结束由启动器拉起的服务栈进程（按 logs/autostart/pids.json 定位，仅杀 node.exe，避免误伤）。
 * 用法：npm run autostart:uninstall
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, "..", "..");

const TASK_NAME = "NextbotServer";
const RUN_VALUE_NAME = "NextbotServer";
// 旧版注册名（2026-10-23 前），残留一并清理
const LEGACY_TASK_NAME = "PrivateAgentServer";
const LEGACY_RUN_VALUE_NAME = "PrivateAgentServer";
const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const PIDS_FILE = path.join(ROOT, "logs", "autostart", "pids.json");

if (process.platform !== "win32") {
  console.error("仅支持 Windows。");
  process.exit(1);
}

function isNodeProcess(pid) {
  if (!pid) return false;
  const r = spawnSync("tasklist.exe", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
    windowsHide: true,
    encoding: "utf8",
  });
  // 过滤命中返回形如 "node.exe","1234",...；未命中返回 "信息: ..." 文本
  return (r.stdout ?? "").trim().startsWith('"node.exe"');
}

function killNodeTree(pid) {
  if (!isNodeProcess(pid)) return false;
  spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  return true;
}

// 1. 结束由启动器拉起的进程树（启动器 + 服务栈）
let stopped = 0;
try {
  const pids = JSON.parse(fs.readFileSync(PIDS_FILE, "utf8"));
  for (const key of ["childPid", "launcherPid"]) {
    if (killNodeTree(pids[key])) stopped += 1;
  }
} catch {
  /* 无 pid 档案则跳过 */
}
try {
  fs.rmSync(PIDS_FILE, { force: true });
} catch {
  /* 忽略 */
}
if (stopped > 0) console.log(`✓ 已停止自启拉起的进程 ${stopped} 个`);

// 2. 删除计划任务
const del = spawnSync("schtasks.exe", ["/delete", "/tn", TASK_NAME, "/f"], {
  windowsHide: true,
  encoding: "utf8",
});
if (del.status === 0) {
  spawnSync("schtasks.exe", ["/end", "/tn", TASK_NAME], { windowsHide: true, stdio: "ignore" });
  console.log(`✓ 已删除计划任务「${TASK_NAME}」`);
}

// 3. 删除 Run 键
const regDel = spawnSync("reg.exe", ["delete", RUN_KEY, "/v", RUN_VALUE_NAME, "/f"], {
  windowsHide: true,
  encoding: "utf8",
});
if (regDel.status === 0) console.log("✓ 已删除 Run 键");

if (del.status !== 0 && regDel.status !== 0) {
  console.log("未发现已注册的开机自启（计划任务与 Run 键均不存在）。");
}

// 4. 旧版注册名残留清理（静默）
spawnSync("schtasks.exe", ["/end", "/tn", LEGACY_TASK_NAME], { windowsHide: true, stdio: "ignore" });
const legacyDel = spawnSync("schtasks.exe", ["/delete", "/tn", LEGACY_TASK_NAME, "/f"], { windowsHide: true, stdio: "ignore" });
const legacyRegDel = spawnSync("reg.exe", ["delete", RUN_KEY, "/v", LEGACY_RUN_VALUE_NAME, "/f"], { windowsHide: true, stdio: "ignore" });
if (legacyDel.status === 0 || legacyRegDel.status === 0) {
  console.log(`✓ 已清理旧版自启残留「${LEGACY_TASK_NAME}」`);
}
console.log("完成。服务端此后不再随登录自启；如服务仍在运行，为手动启动的实例，不受影响。");
