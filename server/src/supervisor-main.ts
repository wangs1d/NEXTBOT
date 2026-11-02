/**
 * 服务监督进程：自己持有对外端口，把每条连接交给 worker（同目录的 index.js）。
 *
 * - worker 崩溃后按退避重拉；重拉期间端口一直在，客户端收不到 ECONNREFUSED，
 *   只会看到请求排队几秒。
 * - worker 就绪前到达的连接先排队（有上限与存活期），就绪后统一下发。
 * - 退出码/最后若干行输出写进数据根 logs/runtime-crash-<时间>.log，供事后定位。
 * - worker 通过 IPC 的 disconnect 感知监督进程已死并自行退出，不留孤儿占数据根。
 */
import { fork, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadServerEnv } from "./config/load-server-env.js";
import { getDataDir } from "./config/data-dir.js";
import { getRuntimeConfig, getRuntimeTopologyConfig } from "./config/env.js";
import { writeServerInstance } from "./config/server-instance.js";

loadServerEnv();

if (getRuntimeTopologyConfig().mode === "remote") {
  console.error(
    "[supervisor] RUNTIME_MODE=remote 下请运行 runtime 进程与 gateway：npm run start:runtime / start:gateway（开发态 npm run dev:remote）",
  );
  process.exit(2);
}

const BACKOFF_MS = [1_000, 5_000, 15_000, 30_000];
const CRASH_LOOP_WINDOW_MS = 5 * 60_000;
const CRASH_LOOP_MAX = 4;
const MAX_QUEUED_CONNECTIONS = 256;
const QUEUED_CONNECTION_TTL_MS = 30_000;
const LOG_RING_MAX = 200;

const runtime = getRuntimeConfig();
const workerEntry = join(dirname(fileURLToPath(import.meta.url)), "index.js");

let worker: ChildProcess | null = null;
let workerReady = false;
let restarts = 0;
let stopping = false;
const crashTimes: number[] = [];
const logRing: string[] = [];
const queue: Array<{ socket: Socket; timer: NodeJS.Timeout }> = [];

function log(line: string): void {
  console.log(`[supervisor] ${line}`);
}

function remember(line: string): void {
  logRing.push(line);
  if (logRing.length > LOG_RING_MAX) logRing.shift();
}

function writeCrashReport(code: number | null, signal: NodeJS.Signals | null): string | null {
  try {
    const dir = join(getDataDir(), "logs");
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = join(dir, `runtime-crash-${stamp}.log`);
    writeFileSync(
      file,
      [
        `time=${new Date().toISOString()}`,
        `exitCode=${code} signal=${signal ?? "-"}`,
        `dataDir=${getDataDir()}`,
        `worker=${workerEntry}`,
        "",
        "--- worker output tail ---",
        ...logRing,
        "",
      ].join("\n"),
      "utf8",
    );
    return file;
  } catch (err) {
    log(`崩溃报告写入失败：${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function dropQueued(): void {
  for (const item of queue) {
    clearTimeout(item.timer);
    try {
      item.socket.destroy();
    } catch {
      // 对端已断
    }
  }
  queue.length = 0;
}

function forward(socket: Socket): void {
  if (!worker || !workerReady || !worker.connected) {
    if (queue.length >= MAX_QUEUED_CONNECTIONS) {
      socket.destroy();
      return;
    }
    const drop = (): void => {
      const idx = queue.findIndex((q) => q.socket === socket);
      if (idx >= 0) {
        clearTimeout(queue[idx].timer);
        queue.splice(idx, 1);
      }
    };
    const timer = setTimeout(() => {
      drop();
      socket.destroy();
    }, QUEUED_CONNECTION_TTL_MS);
    timer.unref();
    socket.once("close", drop);
    queue.push({ socket, timer });
    return;
  }
  worker.send({ type: "socket" }, socket, (err) => {
    if (err) socket.destroy();
  });
}

function flushQueue(): void {
  const pending = queue.splice(0, queue.length);
  for (const item of pending) {
    clearTimeout(item.timer);
    item.socket.removeAllListeners("close");
    forward(item.socket);
  }
}

function spawnWorker(): void {
  if (stopping) return;
  workerReady = false;
  const child = fork(workerEntry, [], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: { ...process.env, NEXTBOT_SOCKET_FROM_PARENT: "1" },
  });
  worker = child;

  const onOutput = (chunk: Buffer, toStderr: boolean): void => {
    const text = chunk.toString();
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      remember(line);
      if (toStderr) process.stderr.write(`${line}\n`);
      else process.stdout.write(`${line}\n`);
    }
  };
  child.stdout?.on("data", (chunk: Buffer) => onOutput(chunk, false));
  child.stderr?.on("data", (chunk: Buffer) => onOutput(chunk, true));

  child.on("message", (msg: { type?: string }) => {
    if (msg?.type === "ready") {
      workerReady = true;
      log(`worker 就绪 pid=${child.pid}，放行排队连接 ${queue.length} 条`);
      flushQueue();
    }
  });

  child.on("error", (err) => {
    log(`worker 进程错误：${err.message}`);
  });

  child.once("exit", (code, signal) => {
    if (worker === child) worker = null;
    workerReady = false;
    if (stopping) return;

    const now = Date.now();
    crashTimes.push(now);
    while (crashTimes.length > 0 && now - crashTimes[0] > CRASH_LOOP_WINDOW_MS) crashTimes.shift();

    log(`worker 退出 code=${code} signal=${signal ?? "-"}（${crashTimes.length} 次 / 5 分钟内）`);
    dropQueued();

    if (crashTimes.length >= CRASH_LOOP_MAX) {
      const report = writeCrashReport(code, signal);
      log(
        `worker 连续崩溃 ${crashTimes.length} 次，停止自动重拉；端口保持监听，等待人工处理` +
          (report ? `（报告：${report}）` : ""),
      );
      return;
    }

    const delay = BACKOFF_MS[Math.min(restarts, BACKOFF_MS.length - 1)];
    restarts += 1;
    log(`${delay}ms 后重启 worker（第 ${restarts} 次）`);
    setTimeout(spawnWorker, delay).unref();
  });
}

const server = createServer({ pauseOnConnect: true }, (socket) => {
  socket.on("error", () => socket.destroy());
  forward(socket);
});

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    log(`端口 ${runtime.port} 已被占用：已有实例在跑，本进程退出`);
    process.exit(0);
  }
  log(`端口监听失败：${err.message}`);
  process.exit(1);
});

server.listen({ port: runtime.port, host: runtime.host }, () => {
  log(`已接管端口 ${runtime.port}，启动 worker`);
  writeServerInstance(runtime.port, "embedded-supervisor");
  spawnWorker();
});

function stop(): void {
  if (stopping) return;
  stopping = true;
  dropQueued();
  try {
    server.close();
  } catch {
    // 已关闭
  }
  try {
    worker?.kill();
  } catch {
    // 已退出
  }
  setTimeout(() => process.exit(0), 300).unref();
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
process.on("SIGBREAK", stop);
process.on("exit", () => {
  try {
    worker?.kill();
  } catch {
    // 已退出
  }
});
