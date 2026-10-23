/**
 * Worker 线程池：基于 node:worker_threads 的通用任务分发器。
 *
 * 用于将慢能力（code.run / image.generate）放到独立 worker 线程执行，
 * 实现故障隔离——worker 崩溃不影响主进程。
 *
 * 设计要点：
 *   - 每种任务类型对应一个 worker 池（默认 2 个实例，WORKER_POOL_SIZE_* 可调，
 *     2026-09-08 A3：由"每类型单 Worker + FIFO"改为真并行池——多后台任务并行时
 *     code.run/image.generate 不再在 worker 层串行排队，与 per-tool 信号量对齐）
 *   - 主进程通过 postMessage 提交任务，worker 执行后 postMessage 返回结果
 *   - 池按需扩容：首个任务起 1 个 worker，出现排队且未达上限时再扩
 *   - worker 崩溃后自动重启（下次 submit 时 ensureWorker）
 *   - 任务有序列化开销，仅用于真正的慢任务（>100ms）
 *
 * 通信协议：
 *   主→Worker: { id, type, payload }
 *   Worker→主: { id, ok, result | error }
 */

import { Worker } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getDataDir } from "../config/data-dir.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export type WorkerTaskType = "code.run" | "image.generate";

export interface WorkerTaskRequest {
  id: string;
  type: WorkerTaskType;
  payload: unknown;
}

export interface WorkerTaskResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

type PendingTask = {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  /** 承接本任务的 worker 实例（崩溃时只拒绝它自己的在途任务） */
  worker: Worker;
};

function poolSizeFor(type: WorkerTaskType): number {
  const key = type === "code.run" ? "WORKER_POOL_SIZE_CODE" : "WORKER_POOL_SIZE_IMAGE";
  const n = Number.parseInt(process.env[key] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 8) : 2;
}

/**
 * 主进程侧的 Worker 池管理器。
 * 每个 WorkerTaskType 对应一个可并行 worker 池（按需扩容至上限）。
 */
class WorkerPoolManager {
  private workers = new Map<WorkerTaskType, Worker[]>();
  private pending = new Map<string, PendingTask>();
  private taskQueue = new Map<WorkerTaskType, Array<() => void>>();

  /**
   * 提交一个任务到 worker 线程执行。
   * 有空闲 worker 立即执行；无空闲且池未满则扩容执行；否则排队等待。
   */
  async submit<T>(type: WorkerTaskType, payload: unknown, timeoutMs = 120_000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const task = () => {
        const id = randomUUID();
        const timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`Worker[${type}] 任务超时 (${timeoutMs}ms)`));
        }, timeoutMs);

        const worker = this.acquireIdleWorker(type);
        // task 只在存在空闲 worker 时被调度；防御性兜底：无 worker 时回池排队
        if (!worker) {
          clearTimeout(timer);
          this.pending.delete(id);
          this.enqueue(type, task);
          return;
        }

        this.pending.set(id, {
          resolve: (result) => {
            clearTimeout(timer);
            resolve(result as T);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
          timer,
          worker,
        });
        worker.postMessage({ id, type, payload } satisfies WorkerTaskRequest);
      };

      this.ensureWorker(type);
      if (this.idleCount(type) > 0) {
        task();
      } else if (this.poolSize(type) < poolSizeFor(type)) {
        // 池未满：扩容一个新 worker 立即承接（真并行，不排队）
        this.ensureWorker(type, true);
        task();
      } else {
        this.enqueue(type, task);
      }
    });
  }

  private enqueue(type: WorkerTaskType, task: () => void): void {
    const queue = this.taskQueue.get(type) ?? [];
    queue.push(task);
    this.taskQueue.set(type, queue);
  }

  private poolSize(type: WorkerTaskType): number {
    return this.workers.get(type)?.length ?? 0;
  }

  private idleCount(type: WorkerTaskType): number {
    const all = this.workers.get(type) ?? [];
    return all.filter((w) => !this.isBusy(w)).length;
  }

  /** busy 判定：worker 是否还有在途任务（pending 表反查，避免额外状态位漂移）。 */
  private isBusy(worker: Worker): boolean {
    for (const p of this.pending.values()) {
      if (p.worker === worker) return true;
    }
    return false;
  }

  private acquireIdleWorker(type: WorkerTaskType): Worker | null {
    const all = this.workers.get(type) ?? [];
    return all.find((w) => !this.isBusy(w)) ?? null;
  }

  /**
   * 确保池中至少有一个 worker；force=true 时无视现有数量直接扩一个
   * （上限由 poolSizeFor 控制，调用方已先检查）。
   */
  private ensureWorker(type: WorkerTaskType, force = false): void {
    if (!force && this.poolSize(type) > 0) return;

    const workerScript = this.resolveWorkerScript(type);
    const worker = new Worker(workerScript, {
      workerData: { type, dataDir: getDataDir() },
    });

    worker.on("message", (msg: WorkerTaskResponse) => {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      this.drainQueue(type);
      if (msg.ok) {
        pending.resolve(msg.result);
      } else {
        pending.reject(new Error(msg.error ?? "worker 执行失败"));
      }
    });

    worker.on("error", (err) => {
      console.error(`[worker-pool] Worker[${type}] 崩溃:`, err.message);
      // 只拒绝崩在该 worker 上的在途任务，其余 worker 的任务不受影响
      for (const [id, pending] of this.pending) {
        if (pending.worker !== worker) continue;
        clearTimeout(pending.timer);
        pending.reject(new Error(`Worker[${type}] 崩溃: ${err.message}`));
        this.pending.delete(id);
      }
      this.removeWorker(type, worker);
      // 重启 worker（下次 submit 时会 ensureWorker）
    });

    worker.on("exit", (code) => {
      if (code !== 0) {
        console.warn(`[worker-pool] Worker[${type}] 退出 code=${code}`);
      }
      this.removeWorker(type, worker);
    });

    this.workers.set(type, [...(this.workers.get(type) ?? []), worker]);
  }

  private removeWorker(type: WorkerTaskType, worker: Worker): void {
    const all = this.workers.get(type);
    if (!all) return;
    const idx = all.indexOf(worker);
    if (idx >= 0) all.splice(idx, 1);
    if (all.length === 0) this.workers.delete(type);
  }

  private drainQueue(type: WorkerTaskType): void {
    const queue = this.taskQueue.get(type);
    if (!queue || queue.length === 0) return;
    const worker = this.acquireIdleWorker(type);
    if (!worker) return;
    const next = queue.shift()!;
    next();
  }

  private resolveWorkerScript(type: WorkerTaskType): string {
    // Worker 脚本按类型映射到对应文件
    const scriptMap: Record<WorkerTaskType, string> = {
      "code.run": join(__dirname, "workers", "code-worker.mjs"),
      "image.generate": join(__dirname, "workers", "image-worker.mjs"),
    };
    return scriptMap[type];
  }

  /** 销毁所有 worker（优雅关闭）。 */
  async terminate(): Promise<void> {
    for (const [, list] of this.workers) {
      for (const worker of list) {
        await worker.terminate();
      }
    }
    this.workers.clear();
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error("worker pool 已终止"));
    }
    this.pending.clear();
  }

  /** 获取 worker 池状态（供监控）。 */
  getStats() {
    const stats: Record<string, { busy: number; size: number; queued: number }> = {};
    for (const [type, list] of this.workers) {
      stats[type] = {
        busy: list.filter((w) => this.isBusy(w)).length,
        size: list.length,
        queued: this.taskQueue.get(type)?.length ?? 0,
      };
    }
    return stats;
  }
}

// 全局单例
export const workerPool = new WorkerPoolManager();
