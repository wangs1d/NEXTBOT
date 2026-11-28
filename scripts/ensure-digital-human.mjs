/**
 * 数字人服务（avatar-talk-service / uvicorn :8765）随后端自动拉起。
 *
 * 挂载点：scripts/dev-all.mjs（本机日常 + 开机自启的 dev 链路）、
 *         server/scripts/start-with-gateway.mjs（prod 链路）、
 *         server/src/services/digital-human-autostart.ts（后端进程自启钩子）。
 *
 * 设计约束（2026-11-28 修订）：
 * - GPU 服务冷启动 ~25-150s（CUDA Graph 捕获 + 头像加载），后端启动链不能同步等；
 *   这里 fire-and-forget，就绪与否只写日志，绝不阻断后端 :3000。
 * - 端口已占用 = 已在跑（可能是手工起的），直接复用，不重复拉、不抢占。
 * - **supervisor 单实例锁**：uvicorn 在引擎加载完才绑定端口，加载窗口期端口是
 *   空闲的；若没有锁，后端每次重启拉起的新 watchdog 都会看到「端口空闲」而再
 *   spawn 一个引擎，多个 Ditto 实例同时抢 ~8GB 显存必然 OOM 崩溃，进而触发更
 *   多 watchdog 重拉 → 无限崩溃循环（2026-11-28 00:23-00:45 实测 20+ 次 spawn）。
 *   锁 = logs/digital-human/supervisor.lock（原子创建 + 持有者 pid 存活检测），
 *   持有者死亡后锁自动失效（自愈），无需人工清理。
 * - 没有 GPU Python 环境（云端部署 / 他人机器）→ 静默跳过，后端照常起。
 * - detached 常驻：后端退出不杀数字人；uvicorn 意外退出时由唯一 watchdog
 *   指数退避重拉（3s → 30s 封顶），引擎就绪后归零。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVICE_DIR = path.join(ROOT, "avatar-talk-service");
const LOG_DIR = path.join(ROOT, "logs", "digital-human");
const SUPERVISOR_LOCK = path.join(LOG_DIR, "supervisor.lock");
const DEFAULT_PORT = 8765;

const asBool = (v) => ["1", "true", "yes", "on"].includes((v ?? "").trim().toLowerCase());

function config() {
  const portRaw = Number(process.env.NEXTBOT_DIGITAL_HUMAN_PORT ?? DEFAULT_PORT);
  const port = Number.isInteger(portRaw) && portRaw > 0 && portRaw < 65536 ? portRaw : DEFAULT_PORT;
  return {
    port,
    base: `http://127.0.0.1:${port}`,
    disabled: asBool(process.env.NEXTBOT_SKIP_DIGITAL_HUMAN),
    waitMs: Math.max(5_000, Number(process.env.NEXTBOT_DIGITAL_HUMAN_WAIT_MS ?? 90_000)),
  };
}

/** 优先显式指定 → Ditto GPU venv → 项目 .venv（Windows / POSIX 双布局）。 */
function pickPython() {
  const candidates = [
    process.env.NEXTBOT_DIGITAL_HUMAN_PYTHON,
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

function portInUse(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(800, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

async function healthy(base) {
  try {
    const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(3_000) });
    if (!res.ok) return false;
    const body = await res.json();
    return body?.service === "ok" && body?.engine?.ready === true;
  } catch {
    return false;
  }
}

let logFd = null;
function log(line) {
  const text = `[${new Date().toLocaleString("sv-SE")}] [digital-human] ${line}\n`;
  try {
    if (logFd === null) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
      const file = path.join(LOG_DIR, `service-${new Date().toISOString().slice(0, 10)}.log`);
      try {
        if (fs.statSync(file).size > 8 * 1024 * 1024) fs.renameSync(file, `${file}.1`);
      } catch {
        /* 首次启动 */
      }
      logFd = fs.openSync(file, "a");
    }
    fs.writeSync(logFd, text);
  } catch {
    /* 日志失败不影响服务 */
  }
  try {
    process.stdout.write(text);
  } catch {
    /* 隐藏窗口下无控制台 */
  }
}

// ─── supervisor 单实例锁 ────────────────────────────────────────────────

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = 进程存在但无权限发信号 → 视为存活
    return err?.code === "EPERM";
  }
}

function readSupervisorLock() {
  try {
    return JSON.parse(fs.readFileSync(SUPERVISOR_LOCK, "utf8"));
  } catch {
    return null;
  }
}

/** 原子抢占 supervisor 锁；已有存活持有者时返回 false。持有者死亡 → 锁自愈可抢。 */
function acquireSupervisorLock() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    const existing = readSupervisorLock();
    if (existing && pidAlive(existing.pid)) {
      return false;
    }
    if (existing) {
      // 持有者已死：清掉陈旧锁（unlink 竞争失败也没关系，下一轮重试）
      try {
        fs.unlinkSync(SUPERVISOR_LOCK);
      } catch {
        /* 被别的进程清了 */
      }
    }
    try {
      const fd = fs.openSync(SUPERVISOR_LOCK, "wx");
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() }));
      fs.closeSync(fd);
      return true;
    } catch (err) {
      if (err?.code !== "EEXIST") return false;
      // EEXIST：刚好被别人抢走，回头确认持有者是否存活
    }
  }
  return false;
}

let child = null;
let stopping = false;
let respawnAttempts = 0;

function spawnService(python, port) {
  if (stopping) return;
  if (child) return; // 已有存活 child：巡检定时器与 exit-handler 重拉互斥
  if (!python) {
    log("skip：未找到 GPU Python 环境，无法重拉");
    return;
  }
  // 子进程必须持有独立的 stdout/stderr 句柄：直接复用父进程的 logFd 时，
  // 父进程（dev-all / 启动器）退出会连带关闭该 fd，uvicorn 首次写入即崩，
  // 表现为 detached 子进程随即死亡（2026-11-27 实测）。
  let outFd = "ignore";
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const file = path.join(LOG_DIR, `uvicorn-${new Date().toISOString().slice(0, 10)}.log`);
    outFd = fs.openSync(file, "a");
  } catch {
    /* 打开失败则静默 */
  }
  child = spawn(
    python,
    ["-m", "uvicorn", "main:app", "--host", "127.0.0.1", "--port", String(port)],
    {
      cwd: SERVICE_DIR,
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
      stdio: ["ignore", outFd, outFd],
      windowsHide: true,
      detached: true,
    },
  );
  log(`spawn uvicorn pid=${child.pid} python=${python} port=${port} attempt=${respawnAttempts}`);
  child.on("error", (err) => log(`spawn 失败：${err.message}`));
  child.once("exit", (code, signal) => {
    if (child?.pid === undefined) return;
    log(`uvicorn 退出 code=${code} signal=${signal ?? "-"}`);
    child = null;
    if (stopping) return;
    // GPU 驱动偶发无堆栈退出：指数退避重拉（3s → 6s → 12s → 24s → 30s 封顶），
    // 避免崩溃循环期间高频 spawn 加剧显存/驱动压力；引擎就绪后归零。
    const delay = Math.min(30_000, 3_000 * 2 ** respawnAttempts);
    respawnAttempts += 1;
    setTimeout(() => {
      if (stopping || child) return;
      log(`watchdog：${Math.round(delay / 1000)}s 后重拉数字人服务`);
      spawnService(python, port);
    }, delay).unref();
  });
  child.unref();
}

async function waitReady(base, waitMs) {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline && !stopping) {
    if (await healthy(base)) {
      log(`引擎就绪 ${base}`);
      respawnAttempts = 0; // 成功拉起：退避归零
      return true;
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  log(`等待引擎就绪超时（${waitMs}ms），后端不受影响，数字人继续后台加载`);
  return false;
}

/**
 * 确保数字人服务在跑。
 *
 * 默认 `fast` 模式：端口检测 + spawn 在 ~1s 内完成，可安全 await；
 * 引擎加载（~25-150s）完全后台化，绝不阻断后端启动。调用方在 process.exit 前
 * await 本函数即可保证 detached 子进程已被拉起。
 *
 * 单实例语义：抢不到 supervisor 锁（别的 watchdog 存活中）→ 永不 spawn，
 * 只探测并汇报端口状态，避免多引擎抢显存的崩溃循环。
 *
 * 返回 { status: 'ready' | 'already-running' | 'started' | 'delegated'
 *        | 'disabled' | 'no-python' | 'error', base }
 */
export function ensureDigitalHuman({ fast = true } = {}) {
  const cfg = config();
  if (cfg.disabled) {
    log("skip：NEXTBOT_SKIP_DIGITAL_HUMAN 已设置");
    return Promise.resolve({ status: "disabled", base: cfg.base });
  }

  return (async () => {
    try {
      if (await portInUse(cfg.port)) {
        const ok = await healthy(cfg.base);
        log(`端口 ${cfg.port} 已占用，复用现有服务${ok ? "（引擎就绪）" : ""}`);
        return { status: ok ? "ready" : "already-running", base: cfg.base };
      }
      if (!acquireSupervisorLock()) {
        const holder = readSupervisorLock();
        log(`端口空闲但已有活跃 watchdog（pid=${holder?.pid ?? "?"}），让出 spawn 权`);
        return { status: "delegated", base: cfg.base };
      }
      const python = pickPython();
      if (!python) {
        log("skip：未找到 GPU Python 环境（D:\\Ditto\\venv / avatar-talk-service\\.venv）；"
          + "需要时设 NEXTBOT_DIGITAL_HUMAN_PYTHON 指向 uvicorn 可用的解释器");
        return { status: "no-python", base: cfg.base };
      }
      spawnService(python, cfg.port);
      if (fast) {
        // ready 轮询后台跑（有 watchdog 与超时日志），调用方立即拿到控制权。
        void waitReady(cfg.base, cfg.waitMs);
      } else {
        await waitReady(cfg.base, cfg.waitMs);
      }
      return { status: "started", base: cfg.base };
    } catch (err) {
      log(`ensure 异常：${err?.message ?? String(err)}（后端不受影响）`);
      return { status: "error", base: cfg.base };
    }
  })();
}

/** 供启动器退出时显式停止 watch dog；数字人进程本身 detached 常驻，不随之 kill。 */
export function stopDigitalHumanWatchdog() {
  stopping = true;
}

// ─── CLI 入口 ────────────────────────────────────────────────────────────
// `node scripts/ensure-digital-human.mjs` 直跑：拉起/复用服务并驻留守护。
// 后端进程（server/src/index.ts）以 detached 子进程方式调用本入口，
// 实现「数字人随后端一起拉起」且后端启动零阻塞。
//
// 守护者唯一性（以 supervisor 锁为凭证）：
// - 本进程 spawn 了 uvicorn → 持锁驻留，child 退出指数退避重拉。
// - 端口已被占用（复用场景，如手工起的服务 / 上个 detached 实例活下来了）
//   → 尝试拿锁：拿到 = 我成为守护者，开启周期巡检（服务死透则重拉）；
//     拿不到 = 已有守护者驻留 → 本实例立即退出，避免 watchdog 堆积。
const invokedDirectly = process.argv[1] != null
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  void (async () => {
    const cfg = config();
    const result = await ensureDigitalHuman();

    const guard = () => {
      // 巡检：端口空闲 = 服务死透（引擎加载期间端口同样空闲，但那种情况下
      // 本守护者要么持有自己的 child，要么拿不到锁），重新拉起。
      void (async () => {
        if (stopping || child) return;
        if (await portInUse(cfg.port)) return;
        log("巡检：端口空闲，重拉数字人服务");
        spawnService(pickPython() ?? "", cfg.port);
      })();
    };

    if (result.status === "started") {
      // 已持锁：child exit handler 负责重拉。
      setInterval(() => {}, 60_000);
      return;
    }
    if (result.status === "ready" || result.status === "already-running") {
      if (!acquireSupervisorLock()) {
        log("已有守护者驻留（supervisor 锁被持有），本实例退出");
        return;
      }
      log("接管守护：周期巡检已启动");
      setInterval(guard, 15_000).unref();
      return;
    }
    // delegated / disabled / no-python / error：无需驻留。
  })();
}
