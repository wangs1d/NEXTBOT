/**
 * 启动 server 开发 watch；端口已占用则直接退出（不进入 node --watch 空等）。
 */
import { execSync, spawn } from "node:child_process";
import { config } from "dotenv";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isTcpPortInUse } from "./port-in-use.mjs";
import {
  isPidAlive,
  ownDataDir,
  readServerInstance,
  sameDataRoot,
  warnPortOwner,
} from "./server-instance.mjs";
import {
  readGatewayPort,
  spawnOpenClawGateway,
  waitForPort,
} from "./spawn-openclaw-gateway.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const serverDir = join(root, "server");
const isWin = process.platform === "win32";

// tsx watch 监听整个 server/ 目录，而服务运行时会落盘 data/、logs/ 及测试残留 JSON，
// 若不排除会形成「启动→落盘→重启」死循环，这里只保留源码路径触发重启。
const WATCH_EXCLUDES = [
  "--exclude", "data/**",
  "--exclude", "logs/**",
  "--exclude", "test/**",
  "--exclude", "**/*.tmp",
  "--exclude", "test-*.json*",
];

// `node dev-server-watch.mjs runtime` → remote 拓扑：runtime watch（内部端口）
// + gateway watch（对外端口）；缺省参数 → embedded 单进程（src/index.ts）
const entryArg = process.argv[2] ?? "";
const isRemoteEntry = entryArg === "runtime";
const entry = isRemoteEntry ? "src/runtime-main.ts" : "src/index.ts";

config({ path: join(serverDir, ".env"), quiet: true });
config({ path: join(serverDir, ".env.local"), quiet: true });

const portRaw = Number(process.env.PORT ?? "3000");
const port = Number.isInteger(portRaw) && portRaw > 0 && portRaw < 65536 ? portRaw : 3000;
const runtimeHttpPortRaw = Number(process.env.RUNTIME_HTTP_PORT ?? "3211");
const runtimeHttpPort =
  Number.isInteger(runtimeHttpPortRaw) && runtimeHttpPortRaw > 0 && runtimeHttpPortRaw < 65536
    ? runtimeHttpPortRaw
    : 3211;

if (await isTcpPortInUse(isRemoteEntry ? runtimeHttpPort : port)) {
  warnPortOwner(isRemoteEntry ? runtimeHttpPort : port);
  process.exit(0);
}

let gatewayChild = null;
const gatewayPort = readGatewayPort();
if (!(await isTcpPortInUse(gatewayPort))) {
  gatewayChild = spawnOpenClawGateway();
  if (gatewayChild) {
    const ready = await waitForPort(gatewayPort, 25_000);
    if (!ready) {
      console.warn(`[openclaw] Gateway 端口 ${gatewayPort} 未就绪，微信 Claw 绑定可能失败`);
    }
  }
}

// 数据根不在本脚本注入（2026-10-24 双根 split-brain 修复）：此前 dev 默认注入
// %APPDATA%\Nextbot-dev\data，而 autostart/prod 链默认 %APPDATA%\Nextbot\data，
// 同一个 :3000 谁占着读谁的根，删除落在 A 根、列表刷新读 B 根。现在统一由
// server/.env.local 的 NEXTBOT_DATA_DIR 决定（loadServerEnv 以 override 加载，
// server 侧自行对齐）；本脚本顶部的 dotenv 已把它带进本进程 env，子进程随之继承。
// 需要临时隔离实验数据时改 server/.env.local，不要在这里另注入。

let child = null;
let respawning = false;

function spawnWatchChild() {
  child = spawn("npx", ["tsx", "watch", "--clear-screen=false", ...WATCH_EXCLUDES, entry], {
    cwd: serverDir,
    stdio: "inherit",
    shell: isWin,
    env: {
      ...process.env,
      ...(isRemoteEntry ? { RUNTIME_MODE: "remote" } : {}),
      NODE_OPTIONS: [process.env.NODE_OPTIONS, "--max-old-space-size=512"].filter(Boolean).join(" "),
      AGENT_WORLD_PLACEHOLDER_REGISTER: "1",
      ALLOW_WORLD_HTTP_MUTATIONS: "1",
      AGENT_PROMPT_WORLD_CAPS: "1",
      ENABLE_MASTER_AGENT_DELEGATION: "1",
    },
  });
  child.on("error", (err) => {
    console.error("[dev-server] 子进程启动失败:", err instanceof Error ? err.message : String(err));
    stopAll();
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    if (respawning) return; // 看门狗主动重拉，不触发退出级联
    if (signal === "SIGTERM" || signal === "SIGINT") {
      // 父进程主动关闭，正常退出
      stopAll();
      process.exit(0);
      return;
    }
    console.error(`[dev-server] 子进程异常退出: code=${code ?? "?"}, signal=${signal ?? "none"}`);
    stopAll();
    // 延迟退出，给日志时间输出
    setTimeout(() => process.exit(code ?? 1), 500).unref();
  });
}

// ─── 入口崩溃空转看门狗 ───
// tsx watch 的入口若在模块解析阶段崩溃（如并行重编 @nextbot/agent-world 时
// 撞进 dist 被删除的窗口，ERR_MODULE_NOT_FOUND），进程仍存活但 watch 链未
// 建立完整，之后没有任何文件变更能触发重试 —— 端口永远不监听，而上层
// autostart 只看进程树活着也不重拉，表象就是「服务挂了拉不起来」
// （2026-10-23 实证，空转 20+ 分钟直到人工 touch 源码才恢复）。
// 这里持续监测端口：连续 120s 不监听（覆盖 tsx 冷启动）即杀掉 tsx watch
// 重新拉起，让新进程完整重建模块图。连续 3 次重拉仍起不来则退出，交由
// autostart 的退避重启层接管。
const WATCHDOG_PORT_DOWN_MS = 120_000;
const WATCHDOG_MAX_CONSECUTIVE = 3;
let watchdogTimer = null;
let portDownSince = null;
let watchdogKills = 0;

function stopPortWatchdog() {
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
}

function respawnWatchChild() {
  respawning = true;
  if (isWin) {
    try {
      execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore", windowsHide: true });
    } catch {
      /* 进程可能已自行退出 */
    }
  } else {
    try {
      child.kill("SIGTERM");
    } catch {
      /* 同上 */
    }
  }
  setTimeout(() => {
    respawning = false;
    spawnWatchChild();
  }, 1_500);
}

function startPortWatchdog() {
  stopPortWatchdog();
  const targetPort = isRemoteEntry ? runtimeHttpPort : port;
  let checking = false;
  watchdogTimer = setInterval(async () => {
    if (checking || !child || child.exitCode !== null) return;
    checking = true;
    try {
      if (await isTcpPortInUse(targetPort)) {
        portDownSince = null;
        watchdogKills = 0;
        return;
      }
      portDownSince ??= Date.now();
      if (Date.now() - portDownSince < WATCHDOG_PORT_DOWN_MS) return;
      portDownSince = null;
      watchdogKills += 1;
      if (watchdogKills > WATCHDOG_MAX_CONSECUTIVE) {
        console.error(
          `[dev-server] 端口 ${targetPort} 持续不监听，看门狗 ${WATCHDOG_MAX_CONSECUTIVE} 次重拉仍失败，退出交由 autostart 接管`,
        );
        // 必须连主 child 一起杀，否则空转的 tsx watch 成为孤儿，稍后可能
        // 自行重启抢占端口，与 autostart 重拉的服务栈形成双实例
        try {
          execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore", windowsHide: true });
        } catch {
          /* 进程可能已自行退出 */
        }
        stopPortWatchdog();
        stopAll();
        process.exit(1);
        return;
      }
      // 异数据根互斥（2026-10-24 双根修复）：有活着的异根服务进程在（例如它自己
      // 的 watch 重启窗口短暂让出端口）时绝不抢滩，退出交由对方自愈；同根则维持
      // 原有重拉自愈逻辑
      const owner = readServerInstance();
      if (owner && isPidAlive(owner.pid) && !sameDataRoot(owner.dataDir, ownDataDir())) {
        console.error(
          `[dev-server] 端口 ${targetPort} 长时间未监听，但异数据根服务进程仍存活 ` +
            `pid=${owner.pid}（root=${owner.dataDir}）；不抢滩，退出交由其自愈`,
        );
        try {
          execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore", windowsHide: true });
        } catch {
          /* 进程可能已自行退出 */
        }
        stopPortWatchdog();
        stopAll();
        process.exit(1);
        return;
      }
      console.warn(
        `[dev-server] 端口 ${targetPort} 超过 ${WATCHDOG_PORT_DOWN_MS / 1000}s 未监听（入口疑似崩溃空转），重拉 tsx watch（第 ${watchdogKills} 次）`,
      );
      respawnWatchChild();
    } finally {
      checking = false;
    }
  }, 5_000).unref();
}

spawnWatchChild();
startPortWatchdog();

// remote 拓扑：runtime 之外加挂 gateway watch（对外端口 3000；被占用则跳过）
let gatewayWatchChild = null;
if (isRemoteEntry && !(await isTcpPortInUse(port))) {
  gatewayWatchChild = spawn("npx", ["tsx", "watch", "--clear-screen=false", ...WATCH_EXCLUDES, "src/gateway-main.ts"], {
    cwd: serverDir,
    stdio: "inherit",
    shell: isWin,
    env: { ...process.env, RUNTIME_MODE: "remote" },
  });
  gatewayWatchChild.on("exit", (code) => {
    if (code !== 0 && code !== null) {
      console.error(`[dev-server] gateway watch 异常退出: code=${code}`);
    }
  });
}

function stopGateway() {
  if (gatewayChild && !gatewayChild.killed) {
    try {
      gatewayChild.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  }
}

function stopAll() {
  stopGateway();
  if (gatewayWatchChild && !gatewayWatchChild.killed) {
    try {
      gatewayWatchChild.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  }
}

child.on("error", (err) => {
  console.error("[dev-server] 子进程启动失败:", err instanceof Error ? err.message : String(err));
  stopAll();
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal === "SIGTERM" || signal === "SIGINT") {
    // 父进程主动关闭，正常退出
    stopAll();
    process.exit(0);
    return;
  }
  console.error(`[dev-server] 子进程异常退出: code=${code ?? "?"}, signal=${signal ?? "none"}`);
  stopAll();
  // 延迟退出，给日志时间输出
  setTimeout(() => process.exit(code ?? 1), 500).unref();
});
process.once("SIGINT", () => {
  stopAll();
  process.exit(0);
});
process.once("SIGTERM", () => {
  stopAll();
  process.exit(0);
});
