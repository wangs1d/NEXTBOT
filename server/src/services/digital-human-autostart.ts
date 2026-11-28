/**
 * 数字人服务（avatar-talk-service / uvicorn :8765）随后端进程常驻。
 *
 * 演进（2026-11-28）：
 * v1 钩子只挂 dev-all / start-with-gateway 两条链 → tsx 直跑绕过，数字人没被拉起；
 * v2 改为后端 spawn detached 的 `ensure-digital-human.mjs` CLI 守护者 → 实测
 *    CLI 进程在宿主（dev-all 后台任务 / 启动器）被清理时会被连带回收，
 *    uvicorn（python）反而稳定存活 —— node 中间层不可靠。
 * v3（本版）守护逻辑内嵌后端进程：后端活着 = 数字人有守护；后端退出时
 *    uvicorn detached 常驻不倒，下次后端启动重新收编（端口复用 + 巡检接管）。
 *
 * 语义：
 * - 启动时端口占用 = 服务已在（引擎可能在加载）→ 只开巡检，不抢占；
 * - 端口空闲 → spawn detached 的 uvicorn（python，实测脱离一切宿主存活）；
 * - 巡检（15s）：uvicorn 死透（端口空闲）→ 指数退避重拉（3s → 30s 封顶）；
 *   引擎就绪后退避归零。引擎加载期间端口同样空闲，但那种情况下 child 存活，
 *   巡检的 child 判空会跳过，不会重复拉；
 * - 无 GPU Python 环境 → 静默跳过，绝不影响后端主流程。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const asBool = (v: string | undefined) =>
  ["1", "true", "yes", "on"].includes((v ?? "").trim().toLowerCase());

const SERVICE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..", "..", "..", "avatar-talk-service",
);
const LOG_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..", "..", "..", "logs", "digital-human",
);
const PORT = Number(process.env.NEXTBOT_DIGITAL_HUMAN_PORT ?? 8765);

let patrolTimer: NodeJS.Timeout | null = null;
let child: ReturnType<typeof spawn> | null = null;
let respawnAttempts = 0;
let stopping = false;

function log(line: string): void {
  const text = `[${new Date().toLocaleString("sv-SE")}] [digital-human/backend] ${line}\n`;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(
      path.join(LOG_DIR, `service-${new Date().toISOString().slice(0, 10)}.log`),
      text,
    );
  } catch {
    /* 日志失败不影响后端 */
  }
}

function pickPython(): string | null {
  const candidates: string[] = [
    process.env.NEXTBOT_DIGITAL_HUMAN_PYTHON ?? "",
    "D:\\Ditto\\venv\\Scripts\\python.exe",
    path.join(SERVICE_DIR, ".venv", "Scripts", "python.exe"),
    path.join(SERVICE_DIR, ".venv", "bin", "python"),
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* 路径不可达，跳过 */
    }
  }
  return null;
}

function portInUse(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port: PORT });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(800, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

async function engineReady(): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/health`, {
      signal: AbortSignal.timeout(3_000),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { service?: string; engine?: { ready?: boolean } };
    return body?.service === "ok" && body?.engine?.ready === true;
  } catch {
    return false;
  }
}

function spawnService(): void {
  if (stopping || child) return;
  const python = pickPython();
  if (!python) {
    log("skip：未找到 GPU Python 环境，无法重拉");
    return;
  }
  let outFd: number | "ignore" = "ignore";
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    outFd = fs.openSync(
      path.join(LOG_DIR, `uvicorn-${new Date().toISOString().slice(0, 10)}.log`),
      "a",
    );
  } catch {
    /* 打开失败则静默 */
  }
  child = spawn(
    python,
    ["-m", "uvicorn", "main:app", "--host", "127.0.0.1", "--port", String(PORT)],
    {
      cwd: SERVICE_DIR,
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
      stdio: ["ignore", outFd, outFd],
      windowsHide: true,
      detached: true,
    },
  );
  log(`spawn uvicorn pid=${child.pid} python=${python} port=${PORT} attempt=${respawnAttempts}`);
  child.on("error", (err) => log(`spawn 失败：${err.message}`));
  child.once("exit", (code, signal) => {
    log(`uvicorn 退出 code=${code} signal=${signal ?? "-"}`);
    child = null;
    if (stopping) return;
    // 立即退避排队一次重拉；巡检定时器有 child 判空互斥，不会双重拉。
    const delay = Math.min(30_000, 3_000 * 2 ** respawnAttempts);
    respawnAttempts += 1;
    setTimeout(() => {
      if (stopping || child) return;
      spawnService();
    }, delay).unref();
  });
  child.unref();
}

async function patrol(): Promise<void> {
  if (stopping) return;
  if (child) return; // 自己的 uvicorn 还活着（加载中或服务中）
  if (await portInUse()) {
    // 别人拉起的服务在跑：不抢占；若引擎已就绪则退避归零。
    if (await engineReady()) respawnAttempts = 0;
    return;
  }
  log("巡检：端口空闲，重拉数字人服务");
  spawnService();
}

let started = false;

export function startDigitalHumanAutostart(): void {
  if (started) return;
  started = true;
  try {
    if (asBool(process.env.NEXTBOT_SKIP_DIGITAL_HUMAN)) return;

    void (async () => {
      if (await portInUse()) {
        const ok = await engineReady();
        log(`端口 ${PORT} 已占用，收编现有服务${ok ? "（引擎就绪）" : "（引擎加载中）"}`);
      } else {
        spawnService();
      }
      // 后端活着 = 数字人有守护：15s 巡检自愈。
      patrolTimer = setInterval(() => void patrol(), 15_000);
      patrolTimer.unref();
    })();
  } catch {
    /* 数字人失败不阻断后端 */
  }
}

export function stopDigitalHumanAutostart(): void {
  stopping = true;
  if (patrolTimer) {
    clearInterval(patrolTimer);
    patrolTimer = null;
  }
}
