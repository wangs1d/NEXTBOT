/**
 * 查看开机自启状态：注册方式、计划任务信息、服务端口、启动器进程与最近日志。
 * 用法：npm run autostart:status
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isTcpPortInUse } from "../port-in-use.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, "..", "..");

const TASK_NAME = "NextbotServer";
const RUN_VALUE_NAME = "NextbotServer";
// 旧版注册名（2026-10-23 前），仅用于残留检测提示
const LEGACY_TASK_NAME = "PrivateAgentServer";
const LEGACY_RUN_VALUE_NAME = "PrivateAgentServer";
const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const LOG_DIR = path.join(ROOT, "logs", "autostart");
const PIDS_FILE = path.join(LOG_DIR, "pids.json");

if (process.platform !== "win32") {
  console.error("仅支持 Windows。");
  process.exit(1);
}

function runPs(script) {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const r = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
    { windowsHide: true, encoding: "utf8" },
  );
  return (r.stdout ?? "").trim();
}

function regQuery() {
  const r = spawnSync("reg.exe", ["query", RUN_KEY, "/v", RUN_VALUE_NAME], {
    windowsHide: true,
    encoding: "utf8",
  });
  if (r.status !== 0) return null;
  const m = (r.stdout ?? "").match(/REG_SZ\s+(.*)/);
  return m ? m[1].trim() : "(已设置)";
}

function isProcessAlive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (err) {
    return /** @type {NodeJS.ErrnoException} */ (err).code === "EPERM";
  }
}

// ─── 注册状态 ───
const psOut = runPs(
  `try { $t = Get-ScheduledTask -TaskName '${TASK_NAME}' -ErrorAction Stop; ` +
    "$i = $t | Get-ScheduledTaskInfo; " +
    "Write-Output ('STATE=' + $t.State); " +
    "Write-Output ('LASTRUN=' + $i.LastRunTime); " +
    "Write-Output ('LASTRESULT=' + $i.LastTaskResult); " +
    "Write-Output ('NEXTRUN=' + $i.NextRunTime); " +
    "} catch { Write-Output 'STATE=NOT_FOUND' }",
);
const taskInfo = Object.fromEntries(psOut.split(/\r?\n/).map((l) => l.split("=", 2)));

console.log("── 开机自启状态 ──");
if (taskInfo.STATE && taskInfo.STATE !== "NOT_FOUND") {
  console.log(`注册方式：计划任务「${TASK_NAME}」（状态 ${taskInfo.STATE}）`);
  if (taskInfo.LASTRUN) console.log(`  上次触发：${taskInfo.LASTRUN}，结果码 ${taskInfo.LASTRESULT}`);
  if (taskInfo.NEXTRUN) console.log(`  下次触发：${taskInfo.NEXTRUN}`);
} else {
  console.log("注册方式：计划任务未注册");
}
const runValue = regQuery();
if (runValue) console.log(`注册方式：Run 键（${runValue}）`);
if ((!taskInfo.STATE || taskInfo.STATE === "NOT_FOUND") && !runValue) {
  console.log("当前未注册开机自启，执行 npm run autostart:install 注册。");
  // 旧版注册名残留检测（重装新版本后可能遗留，会双重拉起服务端）
  const legacyRun = spawnSync("reg.exe", ["query", RUN_KEY, "/v", LEGACY_RUN_VALUE_NAME], {
    windowsHide: true,
    encoding: "utf8",
  });
  const legacyTask = runPs(
    `try { Get-ScheduledTask -TaskName '${LEGACY_TASK_NAME}' -ErrorAction Stop | Out-Null; Write-Output 'FOUND' } ` +
      "catch { Write-Output 'NOT_FOUND' }",
  );
  if (legacyRun.status === 0 || legacyTask.includes("FOUND")) {
    console.log(`⚠ 发现旧版自启残留「${LEGACY_TASK_NAME}」，执行 npm run autostart:uninstall 清理，避免双重拉起。`);
  }
}

// ─── 运行状态 ───
const portBusy = await isTcpPortInUse(3000);
console.log(`服务端口 3000：${portBusy ? "运行中" : "未运行"}`);

let pids = {};
try {
  pids = JSON.parse(fs.readFileSync(PIDS_FILE, "utf8"));
} catch {
  /* 无档案 */
}
if (pids.launcherPid) {
  const alive = isProcessAlive(pids.launcherPid);
  console.log(`启动器进程 pid=${pids.launcherPid}（mode=${pids.mode ?? "?"}）：${alive ? "存活" : "已退出"}`);
}

// ─── 最近日志 ───
try {
  const logs = fs
    .readdirSync(LOG_DIR)
    .filter((f) => /^server-\d{4}-\d{2}-\d{2}\.log$/.test(f))
    .sort();
  if (logs.length > 0) {
    const file = path.join(LOG_DIR, logs.at(-1));
    const lines = fs.readFileSync(file, "utf8").trimEnd().split(/\r?\n/);
    console.log(`── 最近日志（${path.basename(file)}，末 ${Math.min(8, lines.length)} 行）──`);
    for (const line of lines.slice(-8)) console.log(`  ${line}`);
  }
} catch {
  /* 尚无日志 */
}
