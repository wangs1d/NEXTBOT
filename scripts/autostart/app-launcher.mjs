/**
 * 桌面 App 开机自启启动器：由 HKCU Run 键「Nextbot」经 app-launcher.vbs
 * 隐藏拉起。
 *
 * 此前 Run 键直接指向 NEXTBOT.exe，登录即开 app，而后端自启链（计划任务，
 * 延迟 15s + 依赖构建）要再等一两分钟才监听 3000 —— 用户看到的就是
 * 「开机时后端没拉起」。现在改为：等后端端口就绪后再拉起 app。
 *
 * 职责边界（2026-10-27 定稿）：只负责「确保后端在线 → 拉起 app 一次」，
 * 拉起后本脚本即退出。不监视、不拉回 —— 用户手动关闭 app 后必须保持
 * 关闭状态（看门狗自动重启行为已按需求移除：用户要的是启动时拉起后端，
 * 不是关闭后又重启）。
 */
import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isTcpPortInUse } from "../port-in-use.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const APP_EXE = path.join(
  ROOT,
  "client",
  "flutter_app",
  "build",
  "windows",
  "x64",
  "runner",
  "Release",
  "NEXTBOT.exe",
);
const TASK_NAME = "NextbotServer";
const PORT = Number(process.env.AUTOSTART_SERVER_PORT ?? 3000);
const TRIGGER_TASK_AFTER_MS = 30_000; // 端口迟迟不开先补触发一次计划任务
const MAX_WAIT_MS = 180_000; // 超时后照常开 app，离线状态由 app 自行重连

const LOG_DIR = path.join(ROOT, "logs", "autostart");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let logFd = null;
function openLog() {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    logFd = fs.openSync(path.join(LOG_DIR, "app-launcher.log"), "a");
  } catch {
    logFd = null;
  }
}
function log(msg) {
  const line = `[${new Date().toLocaleString("sv-SE")}] [app-launcher] ${msg}\n`;
  if (logFd !== null) {
    try {
      fs.writeSync(logFd, line);
    } catch {
      /* 磁盘异常丢日志不致命 */
    }
  }
}

function isAppRunning() {
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq NEXTBOT.exe" /FO CSV /NH', {
      encoding: "utf8",
      windowsHide: true,
    });
    return out.includes("NEXTBOT.exe");
  } catch {
    return false;
  }
}

function launchApp() {
  try {
    const child = spawn(APP_EXE, [], {
      cwd: path.dirname(APP_EXE),
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    return child.pid ?? null;
  } catch (err) {
    log(`spawn 失败：${err?.message ?? err}`);
    return null;
  }
}

// ─── 主流程：等后端 → 拉起 app 一次 → 退出 ───
openLog();

const startedAt = Date.now();
let taskTriggered = false;
let backendReady = false;
while (Date.now() - startedAt < MAX_WAIT_MS) {
  if (await isTcpPortInUse(PORT)) {
    backendReady = true;
    break;
  }
  if (!taskTriggered && Date.now() - startedAt >= TRIGGER_TASK_AFTER_MS) {
    taskTriggered = true;
    try {
      execSync(`schtasks /run /tn ${TASK_NAME}`, { stdio: "ignore", windowsHide: true });
    } catch {
      /* 计划任务不存在则忽略，超时后照常开 app */
    }
  }
  await sleep(500);
}

if (isAppRunning()) {
  log("app 已在运行，无需拉起");
  process.exit(0);
}
if (!fs.existsSync(APP_EXE)) process.exit(0); // 未构建桌面端时不拉，避免报错弹窗

const waitSec = Math.round((Date.now() - startedAt) / 1000);
log(`后端${backendReady ? "已就绪" : "等待超时"}（${waitSec}s），拉起桌面 App`);
launchApp();
