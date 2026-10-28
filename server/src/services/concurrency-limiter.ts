/**
 * 异步信号量（Semaphore）：限制同一时刻可并发执行的异步操作数量。
 *
 * 用于高并发回压：
 *   - 全局 LLM turn 并发上限（防止事件循环饱和 + LLM API 限流耗尽）
 *   - 重型工具（code.run / image.generate / voice.speak）并发上限
 *
 * 设计要点：
 *   - 纯 Promise + FIFO 队列，无外部依赖
 *   - acquire() 支持超时，超时后返回 null（调用方自行处理 429/排队失败）
 *   - withLimit() 自动 acquire/release，异常时也能释放
 *   - 暴露 active / queued 指标供监控和压测使用
 */

import { adaptiveConcurrency } from "./adaptive-concurrency.js";
import { workerPool } from "./worker-pool.js";

export class Semaphore {
  private active = 0;
  private maxLimit: number;
  private readonly waiters: Array<{
    resolve: () => void;
    reject: (e: Error) => void;
    timer?: ReturnType<typeof setTimeout>;
  }> = [];

  constructor(
    max: number,
    private readonly label: string = "unnamed",
  ) {
    this.maxLimit = max;
  }

  /** 当前正在执行的数量。 */
  get activeCount(): number {
    return this.active;
  }

  /** 当前排队等待的数量。 */
  get queuedCount(): number {
    return this.waiters.length;
  }

  /** 当前并发上限（可被自适应控制器动态调整）。 */
  get max(): number {
    return this.maxLimit;
  }

  /**
   * 动态更新并发上限（由 AdaptiveConcurrency 调用）。
   * 上调时立即唤醒排队的 waiter。
   */
  updateMax(newMax: number): void {
    const old = this.maxLimit;
    this.maxLimit = newMax;
    if (newMax > old) {
      // 上调：尝试唤醒排队的 waiter
      while (this.active < this.maxLimit && this.waiters.length > 0) {
        const next = this.waiters.shift()!;
        if (next.timer) clearTimeout(next.timer);
        this.active++;
        next.resolve();
      }
    }
  }

  /**
   * 获取一个许可。若已达上限则排队等待。
   * @param timeoutMs 超时毫秒；超时后 reject（默认 0 = 永不超时）
   * @returns release 函数（必须在 finally 中调用）
   */
  async acquire(timeoutMs = 0): Promise<() => void> {
    if (this.active < this.maxLimit) {
      this.active++;
      return this.createReleaser();
    }

    return new Promise<() => void>((resolve, reject) => {
      const waiter: {
        resolve: () => void;
        reject: (e: Error) => void;
        timer?: ReturnType<typeof setTimeout>;
      } = {
        resolve: () => {
          this.active++;
          resolve(this.createReleaser());
        },
        reject,
      };

      if (timeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          const idx = this.waiters.indexOf(waiter);
          if (idx >= 0) {
            this.waiters.splice(idx, 1);
            reject(new Error(`Semaphore[${this.label}] 等待超时 (${timeoutMs}ms)`));
          }
        }, timeoutMs);
      }

      this.waiters.push(waiter);
    });
  }

  /**
   * 在信号量保护下执行函数，自动 acquire/release。
   * @param fn 要执行的异步函数
   * @param timeoutMs 排队超时
   */
  async withLimit<T>(fn: () => Promise<T>, timeoutMs = 0): Promise<T> {
    const release = await this.acquire(timeoutMs);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private createReleaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;

      const next = this.waiters.shift();
      if (next) {
        if (next.timer) clearTimeout(next.timer);
        next.resolve();
      }
    };
  }
}

// ============================================================
// 单例：全局 turn 并发限制器 + 按工具类别的限制器
// ============================================================

function envPosInt(key: string, fallback: number): number {
  const n = Number.parseInt(process.env[key] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** 全局 LLM turn 并发上限（跨所有 session）。 */
const MAX_CONCURRENT_TURNS = envPosInt("MAX_CONCURRENT_TURNS", 8);
/** turn 排队超时（毫秒），超时后返回 429 提示。 */
const TURN_QUEUE_TIMEOUT_MS = envPosInt("TURN_QUEUE_TIMEOUT_MS", 30_000);

/** 全局 LLM turn 信号量。 */
export const globalTurnLimiter = new Semaphore(MAX_CONCURRENT_TURNS, "global-turn");

/** turn 排队超时。 */
export const TURN_QUEUE_TIMEOUT = TURN_QUEUE_TIMEOUT_MS;

/**
 * 后台任务面全局并发闸（A3，2026-09-08）：dispatchBackgroundTask 派发的任务
 * 全部经此信号量——多个后台任务天然并行（无锁），但没有上限会同时打满 LLM
 * provider 限流并让重型工具互相排队。默认 4，AGENT_BG_TASK_MAX_PARALLEL 可调。
 * 桌面/浏览器等具身域的互斥由 getToolLimiter 的分域单飞闸负责（域内=1），
 * 这里的全局闸只管"同时执行的任务数"。
 */
export const backgroundTaskLimiter = new Semaphore(
  envPosInt("AGENT_BG_TASK_MAX_PARALLEL", 4),
  "bg-task",
);

/**
 * 自适应并发控制：定期根据 AIMD 算法调整 globalTurnLimiter 的 max。
 * - 成功且快：+1（直到 ADAPTIVE_CONCURRENCY_MAX）
 * - 成功但慢：×0.7
 * - 失败：×0.5
 */
let adaptiveTimer: ReturnType<typeof setInterval> | null = null;
let adaptiveEnabled = envPosInt("ADAPTIVE_CONCURRENCY_ENABLED", 1) === 1;

export function startAdaptiveConcurrency(): void {
  if (!adaptiveEnabled || adaptiveTimer) return;

  // 初始同步
  globalTurnLimiter.updateMax(adaptiveConcurrency.limit);

  adaptiveTimer = setInterval(() => {
    // 定期同步 currentLimit → Semaphore.max
    globalTurnLimiter.updateMax(adaptiveConcurrency.limit);
  }, 2000);

  // 不阻止进程退出
  if (adaptiveTimer.unref) adaptiveTimer.unref();
}

/**
 * 记录 turn 结果供自适应并发调整。
 * 在 processBatchedMessage 的 finally 块中调用。
 */
export function recordTurnOutcome(success: boolean, durationMs: number, errorMessage?: string): void {
  if (!adaptiveEnabled) return;
  if (success) {
    adaptiveConcurrency.recordSuccess(durationMs);
  } else {
    adaptiveConcurrency.recordFailure(errorMessage ?? "unknown");
  }
  // 立即同步（不等 2s 定时器）
  globalTurnLimiter.updateMax(adaptiveConcurrency.limit);
}

/**
 * 按工具名获取对应的并发限制器。
 * 重型工具单独限流，防止资源耗尽；其他工具不限流。
 */
const toolLimiters = new Map<string, Semaphore | null>();

/** 分域单飞闸（A3，2026-09-08）：这些工具域操作同一物理/虚拟环境（同一台电脑、
 * 同一部手机、同一个浏览器实例），并行必然互踩——无论多少后台任务并行，
 * 同域工具全局同一时刻只允许一个在执行。 */
const DOMAIN_SINGLE_FLIGHT_PREFIXES = [
  "desktop.",
  "agent_browser.",
  "browser.",
  "phone.",
  "embodiment.",
] as const;

function getToolLimiter(toolName: string): Semaphore | null {
  const cached = toolLimiters.get(toolName);
  if (cached !== undefined) return cached;

  // 重型工具的并发上限配置
  const limits: Record<string, number> = {
    "code.run": envPosInt("MAX_CONCURRENT_CODE_RUN", 2),
    "code.write_file": envPosInt("MAX_CONCURRENT_CODE_RUN", 2),
    "code.read_file": envPosInt("MAX_CONCURRENT_CODE_RUN", 2),
    "code.list_files": envPosInt("MAX_CONCURRENT_CODE_RUN", 2),
    "image.generate": envPosInt("MAX_CONCURRENT_IMAGE_GEN", 2),
    "voice.speak": envPosInt("MAX_CONCURRENT_VOICE", 3),
    "voice.send_message": envPosInt("MAX_CONCURRENT_VOICE", 3),
  };

  const exactMax = limits[toolName];
  if (exactMax) {
    const exactLimiter = new Semaphore(exactMax, `tool:${toolName}`);
    toolLimiters.set(toolName, exactLimiter);
    return exactLimiter;
  }

  const domain = DOMAIN_SINGLE_FLIGHT_PREFIXES.find((p) => toolName.startsWith(p));
  if (domain) {
    // 同域共享一个单飞信号量：desktop.open 与 desktop.visual.run_task 互斥，
    // 否则多后台任务各自调不同 desktop.* 工具仍会互踩同一台机器。
    const domainKey = `domain:${domain}`;
    let domainLimiter = toolLimiters.get(domainKey);
    if (!domainLimiter) {
      domainLimiter = new Semaphore(1, domainKey);
      toolLimiters.set(domainKey, domainLimiter);
    }
    toolLimiters.set(toolName, domainLimiter);
    return domainLimiter;
  }

  toolLimiters.set(toolName, null);
  return null;
}

/**
 * 在工具并发限制器保护下执行工具。
 * 若工具不在限流名单中，直接执行（无额外开销）。
 */
export async function executeWithToolLimit<T>(
  toolName: string,
  fn: () => Promise<T>,
): Promise<T> {
  const limiter = getToolLimiter(toolName);
  if (!limiter) return fn();
  return limiter.withLimit(fn, 0);
}

/** 暴露所有 limiter 的快照指标（供监控/压测）。 */
export function getConcurrencyStats() {
  const tools: Record<string, { active: number; queued: number; max: number }> = {};
  for (const [name, limiter] of toolLimiters) {
    if (!limiter) continue;
    tools[name] = {
      active: limiter.activeCount,
      queued: limiter.queuedCount,
      max: limiter.max,
    };
  }

  // 自适应并发状态
  let adaptive: Record<string, unknown> | null = null;
  if (adaptiveEnabled) {
    adaptive = {
      currentLimit: adaptiveConcurrency.limit,
      min: adaptiveConcurrency.minLimit,
      max: adaptiveConcurrency.maxLimit,
      latency: adaptiveConcurrency.getLatencyStats(),
    };
  }

  // Worker 池状态
  const workers = workerPool.getStats();

  return {
    globalTurn: {
      active: globalTurnLimiter.activeCount,
      queued: globalTurnLimiter.queuedCount,
      max: globalTurnLimiter.max,
    },
    backgroundTask: {
      active: backgroundTaskLimiter.activeCount,
      queued: backgroundTaskLimiter.queuedCount,
      max: backgroundTaskLimiter.max,
    },
    adaptive,
    workers,
    tools,
  };
}
