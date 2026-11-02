/**
 * 记忆扫描 Worker 宿主（主进程侧）：懒启动 + 请求超时 + 空闲回收。
 *
 * 任务级隔离（C 方案）的边界：
 *  - 只有「全量只读扫描」进 worker（重、慢、可离线）；
 *  - 归档/去重/删除/LLM 审查仍在主进程执行（单写者，不碰 SQLITE_BUSY 与缓存一致性）。
 *
 * 失败语义：worker 崩溃/超时 → 抛错，调用方回退主进程直读（行为不变，只是慢）。
 * 开关：AGENT_MEMORY_SCAN_WORKER=0 可整体关闭（回退主进程扫描）。
 */

import { Worker } from "node:worker_threads";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type MemoryScanRow = {
  id: string;
  memory: string;
  createdAt?: string;
  updatedAt?: string;
  metadata: Record<string, unknown>;
};

type Pending = {
  resolve: (rows: MemoryScanRow[]) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
};

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, Pending>();
let idleTimer: NodeJS.Timeout | null = null;

const WORKER_IDLE_MS = 5 * 60 * 1000;
const SCAN_TIMEOUT_MS = 30_000;

export function isMemoryScanWorkerEnabled(): boolean {
  const raw = process.env.AGENT_MEMORY_SCAN_WORKER?.trim().toLowerCase();
  return !(raw === "0" || raw === "false" || raw === "off" || raw === "no");
}

function workerUrl(): URL {
  // dev：src/services/workers/*.mjs；打包：dist-bundle/workers/*.mjs（build 脚本原样拷贝）
  return new URL("./workers/memory-scan-worker.mjs", import.meta.url);
}

function failAll(reason: string): void {
  for (const [, p] of pending) {
    clearTimeout(p.timer);
    p.reject(new Error(reason));
  }
  pending.clear();
}

function ensureWorker(): Worker {
  if (worker) return worker;
  const url = workerUrl();
  const path = fileURLToPath(url);
  if (!existsSync(path)) {
    throw new Error(`memory scan worker not found: ${path}`);
  }
  const w = new Worker(url, {});
  w.unref?.();
  w.on("message", (msg: { id?: number; ok?: boolean; rows?: MemoryScanRow[]; error?: string }) => {
    if (!msg || typeof msg.id !== "number") return;
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok) p.resolve(msg.rows ?? []);
    else p.reject(new Error(msg.error || "memory scan worker failed"));
  });
  w.on("error", (err) => {
    failAll(`memory scan worker error: ${err.message}`);
    worker = null;
  });
  w.on("exit", (code) => {
    if (code !== 0) failAll(`memory scan worker exited: code=${code}`);
    else failAll("memory scan worker exited");
    worker = null;
  });
  worker = w;
  return w;
}

function scheduleIdleStop(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (pending.size > 0) return;
    void stopMemoryScanWorker();
  }, WORKER_IDLE_MS);
  idleTimer.unref?.();
}

export async function scanVectorDbInWorker(
  dbPath: string,
  actorVariants: string[],
): Promise<MemoryScanRow[]> {
  const w = ensureWorker();
  const id = ++seq;
  return new Promise<MemoryScanRow[]>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`memory scan worker timeout (${SCAN_TIMEOUT_MS}ms)`));
    }, SCAN_TIMEOUT_MS);
    timer.unref?.();
    pending.set(id, { resolve, reject, timer });
    w.postMessage({ id, type: "scan", dbPath, actorVariants });
    scheduleIdleStop();
  });
}

export async function stopMemoryScanWorker(): Promise<void> {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  const w = worker;
  worker = null;
  if (w) {
    try {
      await w.terminate();
    } catch {
      /* 忽略终止失败 */
    }
  }
  failAll("memory scan worker stopped");
}
