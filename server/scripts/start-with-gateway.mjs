import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config as dotenvConfig } from "dotenv";
import net from "node:net";
import { ensureDigitalHuman } from "../../scripts/ensure-digital-human.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverDir = resolve(__dirname, "..");

// 加载 env（与服务端 loadServerEnv 一致）
dotenvConfig({ path: resolve(serverDir, ".env"), quiet: true });
dotenvConfig({ path: resolve(serverDir, ".env.local"), override: true, quiet: true });

const isGatewayEnabled = () => {
  const enabled = (process.env.WECHAT_CLAW_ENABLED ?? "").trim();
  return ["1", "true", "yes", "on"].includes(enabled.toLowerCase());
};

const children = [];

function spawnProcess(command, args, opts = {}) {
  const child = spawn(command, args, {
    stdio: "inherit",
    windowsHide: true,
    ...opts,
  });
  children.push(child);
  child.on("exit", (code) => {
    if (code !== 0 && code !== null && !opts.ignoreExitCode) {
      console.error(`[startup] ${command} 异常退出 (code=${code})`);
    }
  });
  return child;
}

async function waitForPort(port, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await new Promise((resolve, reject) => {
        const socket = net.createConnection({ port, host: "127.0.0.1" }, () => {
          socket.destroy();
          resolve();
        });
        socket.on("error", reject);
        socket.setTimeout(500, () => {
          socket.destroy();
          reject(new Error("timeout"));
        });
      });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error(`端口 ${port} 等待超时 (${timeoutMs}ms)`);
}

function killAll() {
  for (const child of children) {
    try {
      child.kill("SIGTERM");
    } catch { /* ignore */ }
  }
  process.exit(0);
}

async function main() {
  // 0. 数字人服务随后端一起拉起（await 端口检测+spawn ~1s，引擎加载后台化）。
  //    GPU 环境缺失 / 8765 已占用时模块自行跳过 / 复用，不影响主服务启动。
  await ensureDigitalHuman();

  // 1. 如果启用了微信 Claw，启动 OpenClaw Gateway
  if (isGatewayEnabled()) {
    const port = process.env.OPENCLAW_GATEWAY_WS_URL?.match(/:(\d+)/)?.[1] ?? "18789";
    const token = process.env.OPENCLAW_GATEWAY_TOKEN?.trim() ?? "";

    console.log("[startup] 正在启动 OpenClaw Gateway...");

    const openclawCmd = process.platform === "win32"
      ? "openclaw.cmd"
      : "openclaw";

    spawnProcess(openclawCmd, [
      "gateway", "run",
      "--port", port,
      "--auth", "none",
      "--force",
      "--allow-unconfigured",
    ], { ignoreExitCode: true, shell: true });

    try {
      await waitForPort(Number(port), 30000);
      console.log(`[startup] OpenClaw Gateway 已就绪 (ws://127.0.0.1:${port})`);
    } catch {
      console.error("[startup] OpenClaw Gateway 启动超时，继续启动服务...");
    }
  }

  // 2. 启动 Node 服务（2026-09-11：Python tool-router 已删除，检索进程内完成）
  // 堆参数与 Dockerfile 保持一致：768MB 老生代 + 32MB 半空间（见 Dockerfile 注释）。
  const server = spawnProcess(
    "node",
    ["--max-old-space-size=768", "--max-semi-space-size=32", "dist/index.js"],
    { cwd: serverDir },
  );
  // 主服务退出（含崩溃 code≠0）→ 包装进程以相同码退出，交由守护方重启；
  // 否则包装进程会因残留子进程（如 gateway）继续存活，形成 /health 永久失败的僵尸状态。
  server.on("exit", (code) => {
    console.error(`[startup] 主服务退出 (code=${code ?? 0})，包装进程随之退出`);
    process.exit(code ?? 1);
  });

  process.once("SIGINT", killAll);
  process.once("SIGTERM", killAll);
}

main().catch((err) => {
  console.error("[startup] 启动失败:", err.message);
  process.exit(1);
});
