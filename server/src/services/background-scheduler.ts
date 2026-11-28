/**
 * 后台任务调度器（2026-11 性能治理）。
 *
 * 背景：服务里有 50+ 个裸 `setInterval`，各自为政——启动瞬间同时触发、
 * 周期固定不抖动、内存水位高时照样跑，扫描任务和用户对话抢同一个事件循环。
 *
 * 本调度器不是"把所有循环合并成一个 tick"（周期跨 30s~24h，合并会变形），
 * 而是给每个后台循环提供统一的生命周期与策略：
 *   1. 首轮延迟按 jitter 错峰，避免启动时几十个任务同时打满 CPU；
 *   2. 每次 tick 再抖一次，削掉多个任务的长尾对齐；
 *   3. `poolPressure()` 非 normal 时跳过非关键任务（复用 resource-pool 的
 *      cgroup 水位信号，不再新造一套"忙不忙"判断）；
 *   4. 串行执行：上一轮未结束绝不重入（异步任务尤其重要）；
 *   5. 定时器 unref，不阻塞进程退出；异常统一兜底，单任务失败不影响其他任务。
 *
 * 迁移方式：把 `setInterval(fn, ms)` 换成 `backgroundScheduler.schedule({...})`，
 * `clearInterval(t)` 换成 `backgroundScheduler.cancel(name)`。
 */

import { poolPressure } from "./resource-pool.js";

export type BackgroundTaskOptions = {
  /** 唯一名字，重复注册会替换旧任务（幂等）。 */
  name: string;
  intervalMs: number;
  /** 任务体；可以是异步，调度器保证不重入。 */
  run: () => void | Promise<void>;
  /** 每轮抖动的比例（0~1），默认 0.15。 */
  jitterRatio?: number;
  /** 首轮延迟；缺省按 interval × 随机(0~jitterRatio) 错峰。 */
  firstDelayMs?: number;
  /** 内存水位非 normal 时是否跳过，默认 true。 */
  skipWhenBusy?: boolean;
  /** 首轮是否立即执行（默认 false，按 firstDelay 错峰）。 */
  runOnStart?: boolean;
};

type TaskState = {
  opts: Required<Pick<BackgroundTaskOptions, "name" | "intervalMs" | "run" | "jitterRatio" | "skipWhenBusy">> &
    BackgroundTaskOptions;
  timer: ReturnType<typeof setTimeout> | null;
  running: boolean;
  started: boolean;
  runs: number;
  skippedBusy: number;
  failures: number;
  lastRunAt: number | null;
  lastDurationMs: number | null;
};

const DEFAULT_JITTER_RATIO = 0.15;

function jitterMs(baseMs: number, ratio: number): number {
  if (!(ratio > 0)) return 0;
  return Math.floor(Math.random() * baseMs * ratio);
}

function positiveInterval(ms: number): number {
  return Number.isFinite(ms) && ms >= 1000 ? ms : 1000;
}

class BackgroundScheduler {
  private readonly tasks = new Map<string, TaskState>();
  private stoppedAll = false;

  /** 注册（或替换）一个后台任务；返回取消函数。 */
  schedule(opts: BackgroundTaskOptions): () => void {
    const name = opts.name.trim();
    if (!name) throw new Error("backgroundScheduler.schedule 需要非空 name");
    this.cancel(name);

    const intervalMs = positiveInterval(opts.intervalMs);
    const jitterRatio = opts.jitterRatio ?? DEFAULT_JITTER_RATIO;
    const state: TaskState = {
      opts: {
        ...opts,
        name,
        intervalMs,
        jitterRatio,
        skipWhenBusy: opts.skipWhenBusy ?? true,
      } as TaskState["opts"],
      timer: null,
      running: false,
      started: true,
      runs: 0,
      skippedBusy: 0,
      failures: 0,
      lastRunAt: null,
      lastDurationMs: null,
    };
    this.tasks.set(name, state);
    this.stoppedAll = false;

    const firstDelay =
      opts.firstDelayMs !== undefined
        ? Math.max(0, opts.firstDelayMs)
        : opts.runOnStart
          ? 0
          : jitterMs(intervalMs, jitterRatio);

    this.arm(state, firstDelay);

    return () => this.cancel(name);
  }

  private arm(state: TaskState, delayMs: number): void {
    if (!state.started) return;
    state.timer = setTimeout(() => {
      state.timer = null;
      void this.runOnce(state);
    }, delayMs);
    // 不阻塞进程退出：原 50+ 个循环大多已经 unref，这里统一。
    state.timer.unref?.();
  }

  private async runOnce(state: TaskState): Promise<void> {
    if (!state.started) return;

    if (state.running) {
      // 上一轮还没结束（异步任务卡住）：本轮跳过，等下一次。
      this.arm(state, this.nextInterval(state));
      return;
    }

    if (state.opts.skipWhenBusy && poolPressure().tier !== "normal") {
      state.skippedBusy += 1;
      this.arm(state, this.nextInterval(state));
      return;
    }

    state.running = true;
    const t0 = Date.now();
    try {
      await state.opts.run();
      state.runs += 1;
    } catch (err) {
      state.failures += 1;
      console.error(
        `[background-scheduler] ${state.opts.name} 执行失败:`,
        err instanceof Error ? err.stack ?? err.message : err,
      );
    } finally {
      state.lastRunAt = Date.now();
      state.lastDurationMs = state.lastRunAt - t0;
      state.running = false;
      this.arm(state, this.nextInterval(state));
    }
  }

  private nextInterval(state: TaskState): number {
    return state.opts.intervalMs + jitterMs(state.opts.intervalMs, state.opts.jitterRatio);
  }

  /** 取消单个任务（不存在的名字为 no-op）。 */
  cancel(name: string): void {
    const state = this.tasks.get(name);
    if (!state) return;
    state.started = false;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    this.tasks.delete(name);
  }

  /** 停止全部任务（服务关闭）。 */
  stopAll(): void {
    for (const name of [...this.tasks.keys()]) this.cancel(name);
    this.stoppedAll = true;
  }

  /** 是否已注册某任务（诊断用）。 */
  has(name: string): boolean {
    return this.tasks.has(name);
  }

  /** 当前任务快照：运行次数 / 因忙跳过次数 / 失败次数 / 上次耗时。 */
  snapshot(): Array<{
    name: string;
    intervalMs: number;
    running: boolean;
    runs: number;
    skippedBusy: number;
    failures: number;
    lastRunAt: number | null;
    lastDurationMs: number | null;
  }> {
    return [...this.tasks.values()].map((s) => ({
      name: s.opts.name,
      intervalMs: s.opts.intervalMs,
      running: s.running,
      runs: s.runs,
      skippedBusy: s.skippedBusy,
      failures: s.failures,
      lastRunAt: s.lastRunAt,
      lastDurationMs: s.lastDurationMs,
    }));
  }

  /** 是否已整体停止（避免 stopAll 后又被 schedule 意外拉起时静默）。 */
  isStopped(): boolean {
    return this.stoppedAll;
  }
}

export const backgroundScheduler = new BackgroundScheduler();
