/**
 * 开机自启常驻启动器：由计划任务 / Run 键经 autostart-launcher.vbs 以隐藏窗口拉起。
 * 职责：等网络 → 端口占用检测（服务已在跑则直接退出）→ 拉起服务栈 → 崩溃退避重启 → 日志落盘。
 * 默认 dev 模式（scripts/dev-all.mjs，与日常 npm run dev:all 同一链路）；
 * 生产模式改下方 MODE 或设 AUTOSTART_MODE=prod（需先 npm run build --workspace=server）。
 */
import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isTcpPortInUse } from "../port-in-use.mjs";
import { warnPortOwner } from "../server-instance.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const isWin = process.platform === "win32";

// 环境变量可覆盖；计划任务/Run 键拉起场景直接改这里的默认值最直接
const MODE = (process.env.AUTOSTART_MODE ?? "dev").toLowerCase(); // dev | prod
const SERVER_PORT = Number(process.env.AUTOSTART_SERVER_PORT ?? 3000);
const NETWORK_TIMEOUT_MS = Number(process.env.AUTOSTART_NETWORK_TIMEOUT_MS ?? 120_000);
const MAX_CONSECUTIVE_FAILURES = Number(process.env.AUTOSTART_MAX_RESTARTS ?? 5);
// 子进程稳定运行超过该时长后清零连续失败计数，避免长期运行后偶发崩溃耗尽配额
const STABLE_RESET_MS = 10 * 60_000;

const LOG_DIR = path.join(ROOT, "logs", "autostart");
const PIDS_FILE = path.join(LOG_DIR, "pids.json");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ─── 日志：按天落盘 logs/autostart/server-YYYY-MM-DD.log，超 8MB 轮转 ───
let logFd = null;

function openLog() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const file = path.join(LOG_DIR, `server-${new Date().toISOString().slice(0, 10)}.log`);
  try {
    if (fs.statSync(file).size > 8 * 1024 * 1024) fs.renameSync(file, `${file}.1`);
  } catch {
    /* 首次启动无文件 */
  }
  logFd = fs.openSync(file, "a");
}

function log(msg) {
  const line = `[${new Date().toLocaleString("sv-SE")}] [autostart] ${msg}\n`;
  if (logFd !== null) {
    try {
      fs.writeSync(logFd, line);
    } catch {
      /* 磁盘异常时丢日志不致命 */
    }
  }
  try {
    process.stdout.write(line);
  } catch {
    /* 隐藏窗口下无有效控制台 */
  }
}

// ─── 网络：双探针（阿里 DNS / Cloudflare DNS），超时后仍继续启动（外联可稍后自愈）───
function probeTcp(host, port, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

async function waitForNetwork() {
  const deadline = Date.now() + NETWORK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if ((await probeTcp("223.5.5.5", 53)) || (await probeTcp("1.1.1.1", 53))) return true;
    await sleep(3000);
  }
  return false;
}

// ─── pid 档案：uninstall/status 依据它定位启动器与服务栈进程 ───
function readPids() {
  try {
    return JSON.parse(fs.readFileSync(PIDS_FILE, "utf8"));
  } catch {
    return {};
  }
}

function writePids(patch) {
  try {
    fs.writeFileSync(PIDS_FILE, JSON.stringify({ ...readPids(), ...patch }, null, 2));
  } catch {
    /* pid 档案写失败不影响主流程 */
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (err) {
    return /** @type {NodeJS.ErrnoException} */ (err).code === "EPERM";
  }
}

function killTree(pid) {
  if (!pid) return;
  if (isWin) {
    try {
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore", windowsHide: true });
    } catch {
      /* 进程可能已退出 */
    }
  } else {
    try {
      process.kill(Number(pid), "SIGTERM");
    } catch {
      /* 同上 */
    }
  }
}

// ─── 服务栈子进程 ───
function childCommand() {
  if (MODE === "prod") {
    return {
      file: process.execPath,
      args: [path.join(ROOT, "server", "scripts", "start-with-gateway.mjs")],
      label: "server/scripts/start-with-gateway.mjs（含可选 OpenClaw 网关）",
    };
  }
  return {
    file: process.execPath,
    args: [path.join(ROOT, "scripts", "dev-all.mjs")],
    label: "scripts/dev-all.mjs（dev:all 开发栈）",
  };
}

let shuttingDown = false;
let currentChild = null;

function spawnChild() {
  const { file, args, label } = childCommand();
  log(`拉起服务栈（mode=${MODE}）：${label}`);
  const child = spawn(file, args, {
    cwd: ROOT,
    stdio: ["ignore", logFd, logFd],
    windowsHide: true,
  });
  writePids({
    launcherPid: process.pid,
    childPid: child.pid,
    mode: MODE,
    startedAt: new Date().toISOString(),
  });
  return child;
}

function shutdown(exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (currentChild?.pid) killTree(currentChild.pid);
  try {
    fs.rmSync(PIDS_FILE, { force: true });
  } catch {
    /* 清理失败不阻塞退出 */
  }
  process.exit(exitCode);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

async function main() {
  openLog();
  log(`启动器运行 pid=${process.pid} mode=${MODE} root=${ROOT}`);

  const prev = readPids();
  if (prev.launcherPid && prev.launcherPid !== process.pid && isProcessAlive(prev.launcherPid)) {
    log(`已有启动器在运行 pid=${prev.launcherPid}，本实例退出`);
    return;
  }
  if (await isTcpPortInUse(SERVER_PORT)) {
    // 占用者身份可见化：异数据根的双实例正是「删了行程却没变」的成因（2026-10-24）
    warnPortOwner(SERVER_PORT);
    log(`端口 ${SERVER_PORT} 已被占用，服务疑似已在运行，本实例退出`);
    return;
  }

  if (!(await waitForNetwork())) {
    log(`等待网络超时（${NETWORK_TIMEOUT_MS}ms），仍继续启动`);
  }

  let consecutiveFailures = 0;
  while (!shuttingDown) {
    if (await isTcpPortInUse(SERVER_PORT)) {
      warnPortOwner(SERVER_PORT);
      log(`端口 ${SERVER_PORT} 已被占用，视为服务已在运行，启动器退出`);
      break;
    }
    const startedAt = Date.now();
    const child = spawnChild();
    currentChild = child;
    const code = await new Promise((resolve) => {
      child.once("exit", (c, sig) => resolve(c ?? (sig ? 1 : 0)));
      child.once("error", (err) => {
        log(`spawn 失败：${err.message}`);
        resolve(1);
      });
    });
    currentChild = null;
    writePids({ childPid: null, lastExitAt: new Date().toISOString(), lastExitCode: code });
    if (shuttingDown) break;

    if (await isTcpPortInUse(SERVER_PORT)) {
      log(`启动器子进程退出（code=${code}）但端口仍被占用，服务仍在运行，启动器退出`);
      break;
    }
    if (Date.now() - startedAt > STABLE_RESET_MS) consecutiveFailures = 0;
    consecutiveFailures += 1;
    if (consecutiveFailures > MAX_CONSECUTIVE_FAILURES) {
      log(`连续 ${consecutiveFailures - 1} 次重启均失败，放弃（详见 logs/autostart/ 日志）`);
      break;
    }
    const delayMs = Math.min(30_000 * 2 ** (consecutiveFailures - 1), 5 * 60_000);
    log(
      `服务栈退出（code=${code}，运行 ${Math.round((Date.now() - startedAt) / 1000)}s），` +
        `${Math.round(delayMs / 1000)}s 后第 ${consecutiveFailures} 次重启`,
    );
    await sleep(delayMs);
  }
}

main().catch((err) => {
  log(`启动器异常退出：${err?.stack ?? err}`);
  process.exit(1);
});
