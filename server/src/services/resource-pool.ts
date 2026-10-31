/**
 * 资源池基层：机器容量 -> 并发预算 -> 常驻数据上限。
 *
 * 解决的问题：并发闸门只认 env 常量，不知道本机有多大；
 * 常驻 Map（记忆快照/画像路由/锚点）只增不减，2G 机器会被拖死。
 * 本模块统一给出：
 *  1. capacityBytes()        本进程真实可用总容量（cgroup memory.max 优先，回落 os.totalmem）
 *  2. poolPressure()         内存水位 = max(V8 堆占比, cgroup memory.current 占容量)，normal/elevated/critical
 *  3. turnBudget()/toolBudget() 各类闸口上限 = min(env 常量, 机器预算, 水位缩放)
 *  4. RetentionMap           有界缓存（LRU + 空闲时限），由 sweepRetained() 统一清扫
 *  5. resourcePoolSnapshot() 供 /system/concurrency 展示（带 nodeId，供集群归因）
 */

import os from "node:os";
import v8 from "node:v8";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LRUCache } from "lru-cache";

export type PoolClass = "globalTurn" | "bg" | "tool";
export type PressureTier = "normal" | "elevated" | "critical";

/** 内存占容量比例水位：超过 critical 直接把闸压到最低，避免 OOM。 */
const ELEVATED_RATIO = 0.7;
const CRITICAL_RATIO = 0.88;

/** 每 GB 内存对应的 turn 预算（保守值，2G -> 4，4G -> 8，8G+ -> 16）。 */
const TURNS_PER_GB = 4;
const MIN_TURN_BUDGET = 2;
const MAX_TURN_BUDGET = 16;

let capacityCache: number | null = null;
let capacityPromise: Promise<number> | null = null;
/** cgroup memory.current 心跳缓存（含子进程）；读不到回落本进程 RSS。 */
let cgroupCurrentCache: number | null = null;

/**
 * 候选文件：容器内直接读根路径；裸机 systemd 服务要按 /proc/self/cgroup
 * 找到自己那一格（否则读到的是根 cgroup 的文件，MemoryMax 形同不存在）。
 */
function cgroupV2Paths(file: string): string[] {
  const paths = [join("/sys/fs/cgroup", file)];
  try {
    const self = readFileSync("/proc/self/cgroup", "utf8");
    // cgroup v2 只有一行 "0::/system.slice/nextbot.service"
    const line = self.split("\n").find((l) => l.startsWith("0::"));
    const rel = line?.slice(3).trim();
    if (rel && rel !== "/") paths.splice(1, 0, join("/sys/fs/cgroup", rel, file));
  } catch {
    /* 读不到就不找自己的 cgroup */
  }
  return paths;
}

/** cgroup v2 优先，v1 兜底，最后回落 os.totalmem()——容器里 os.totalmem 是宿主总量，不可信。 */
async function detectCapacity(): Promise<number> {
  const total = os.totalmem();
  const paths = [...cgroupV2Paths("memory.max"), "/sys/fs/cgroup/memory/memory.limit_in_bytes"];
  for (const p of paths) {
    try {
      const raw = (await readFile(p, "utf8")).trim();
      if (raw === "max") continue;
      const n = Number.parseInt(raw, 10);
      // v1 无限制时给出天文数字；大于宿主总量视为未设限
      if (Number.isFinite(n) && n > 0 && n <= total) return n;
    } catch {
      /* 读不到就回落 */
    }
  }
  return total;
}

/** 预热：boot 时调用一次把容量缓存下来（之后全部同步读，闸口不能 await）。 */
export function initResourcePool(): Promise<number> {
  if (capacityCache !== null) return Promise.resolve(capacityCache);
  if (!capacityPromise) {
    capacityPromise = detectCapacity().then((n) => {
      capacityCache = n;
      return n;
    });
  }
  return capacityPromise;
}

export function capacityBytes(): number {
  return capacityCache ?? os.totalmem();
}

/**
 * 心跳里异步刷新 cgroup memory.current（含子进程与同 cgroup 工具进程），
 * 供下一次同步 poolPressure 使用；失败静默保留旧值。
 */
export async function refreshPressure(): Promise<void> {
  if (sampleOverride) return;
  for (const p of cgroupV2Paths("memory.current")) {
    try {
      const n = Number.parseInt((await readFile(p, "utf8")).trim(), 10);
      if (Number.isFinite(n) && n > 0) {
        cgroupCurrentCache = n;
        return;
      }
    } catch {
      /* 下一个候选 */
    }
  }
}

export function nodeId(): string {
  return process.env.NEXTBOT_NODE_ID?.trim() || os.hostname();
}

export interface PoolPressure {
  /** cgroup memory.current（含子进程）；读不到时回落本进程 RSS。 */
  memoryBytes: number;
  heapUsedBytes: number;
  heapLimitBytes: number;
  capacityBytes: number;
  /** 水位 = max(V8 堆占比, cgroup memory.current 占容量)。 */
  ratio: number;
  tier: PressureTier;
}

interface PressureSample {
  heapUsed: number;
  heapLimit: number;
  memoryBytes: number;
}

let sampleOverride: PressureSample | null = null;

export function poolPressure(): PoolPressure {
  const cap = capacityBytes();
  const sample: PressureSample = sampleOverride ?? {
    heapUsed: v8.getHeapStatistics().used_heap_size,
    heapLimit: v8.getHeapStatistics().heap_size_limit,
    memoryBytes: cgroupCurrentCache ?? process.memoryUsage().rss,
  };
  const heapRatio = sample.heapLimit > 0 ? sample.heapUsed / sample.heapLimit : 0;
  const memRatio = cap > 0 ? sample.memoryBytes / cap : 0;
  const ratio = Math.max(heapRatio, memRatio);
  const tier: PressureTier =
    ratio >= CRITICAL_RATIO ? "critical" : ratio >= ELEVATED_RATIO ? "elevated" : "normal";
  return {
    memoryBytes: sample.memoryBytes,
    heapUsedBytes: sample.heapUsed,
    heapLimitBytes: sample.heapLimit,
    capacityBytes: cap,
    ratio,
    tier,
  };
}

/** 各闸口在当前水位下允许的最大并发。env 常量仍是上限，这里只做“乘水位”。 */
const BUDGET_TABLE: Record<PressureTier, number> = {
  normal: 1,
  elevated: 0.6,
  critical: 0.25,
};

export function turnBudget(envMax: number): number {
  const hw = Math.max(
    MIN_TURN_BUDGET,
    Math.min(MAX_TURN_BUDGET, Math.floor((capacityBytes() / 1024 ** 3) * TURNS_PER_GB)),
  );
  const scaled = Math.floor(hw * BUDGET_TABLE[poolPressure().tier]);
  return Math.max(1, Math.min(envMax, hw, scaled > 0 ? scaled : 1));
}

/** 重型工具闸（code/image/voice/bg）按水位收紧，env 是硬上限。 */
export function toolBudget(envMax: number): number {
  const scaled = Math.max(1, Math.floor(envMax * BUDGET_TABLE[poolPressure().tier]));
  return Math.min(envMax, scaled);
}


/* ---------------- 常驻数据有界缓存 ---------------- */

export interface RetentionOptions {
  /** 最多保留多少条目（超出按最近未用淘汰） */
  maxEntries: number;
  /** 空闲超过 idleMs 可被清扫淘汰；Infinity 表示只按数量淘汰 */
  idleMs: number;
}

export interface RetainedStats {
  name: string;
  entries: number;
  maxEntries: number;
  idleMs: number;
  evictedIdle: number;
  evictedLru: number;
}

const retained = new Map<string, Pick<RetentionMap<never>, "sweep" | "stats">>();

/** env 上限 + 容量缩放：内存越小，允许的常驻条目越少（下限 16，保证单用户不被饿死）。 */
export function retentionMaxEntries(envMax: number): number {
  const cap = capacityBytes() / 1024 ** 3;
  const scaled = Math.floor(Math.min(envMax, Math.max(32, cap * 64)));
  return Math.max(16, scaled);
}

/** max/ttl/淘汰全交给 lru-cache，本类只保留既有调用面与登记表。 */
export class RetentionMap<V extends {}> {
  private readonly cache: LRUCache<string, V>;
  private evictedIdle = 0;
  private evictedLru = 0;

  constructor(
    readonly name: string,
    private readonly opts: RetentionOptions,
  ) {
    this.cache = new LRUCache<string, V>({
      max: opts.maxEntries,
      ttl: Number.isFinite(opts.idleMs) ? opts.idleMs : 0,
      updateAgeOnGet: true,
      ttlAutopurge: false,
      dispose: (_value, _key, reason) => {
        if (reason === "evict") this.evictedLru++;
        else if (reason === "expire") this.evictedIdle++;
      },
    });
    if (!retained.has(name)) retained.set(name, this);
  }

  get size(): number {
    return this.cache.size;
  }

  get(key: string): V | undefined {
    return this.cache.get(key);
  }

  set(key: string, value: V): void {
    this.cache.set(key, value);
  }

  delete(key: string): boolean {
    return this.cache.delete(key);
  }

  has(key: string): boolean {
    return this.cache.has(key);
  }

  /** 只读遍历（不刷新访问时间），供既有「遍历全部」逻辑复用。 */
  entries(): IterableIterator<[string, V]> {
    return this.cache.entries();
  }

  /** 兼容 `for (const [k, v] of map)` 的既有写法。 */
  [Symbol.iterator](): IterableIterator<[string, V]> {
    return this.cache.entries();
  }

  clear(): void {
    this.cache.clear();
  }

  /** 水位清扫：把空闲超时的条目交出去（超量淘汰在 set 时已即时发生）。 */
  sweep(_now: number): number {
    const before = this.evictedIdle;
    this.cache.purgeStale();
    return this.evictedIdle - before;
  }

  stats(): RetainedStats {
    return {
      name: this.name,
      entries: this.cache.size,
      maxEntries: this.opts.maxEntries,
      idleMs: this.opts.idleMs,
      evictedIdle: this.evictedIdle,
      evictedLru: this.evictedLru,
    };
  }
}

/** 全局清扫：每个登记过的常驻缓存按自己的时限淘汰（在闸口心跳里调用）。 */
export function sweepRetained(): { removed: number; tier: PressureTier } {
  void refreshPressure();
  const now = Date.now();
  let removed = 0;
  for (const m of retained.values()) removed += m.sweep(now);
  return { removed, tier: poolPressure().tier };
}

export function retainedStats(): RetainedStats[] {
  return Array.from(retained.values(), (m) => m.stats());
}

export interface ResourcePoolSnapshot {
  nodeId: string;
  capacityBytes: number;
  memoryBytes: number;
  heapUsedBytes: number;
  heapLimitBytes: number;
  ratio: number;
  tier: PressureTier;
  turnBudget: number;
  toolBudgetBg: number;
  retained: RetainedStats[];
}

/** 供 /system/concurrency 与闸口心跳复用的一体化快照。 */
export function resourcePoolSnapshot(
  envTurnMax: number,
  envBgMax: number,
): ResourcePoolSnapshot {
  const p = poolPressure();
  return {
    nodeId: nodeId(),
    capacityBytes: p.capacityBytes,
    memoryBytes: p.memoryBytes,
    heapUsedBytes: p.heapUsedBytes,
    heapLimitBytes: p.heapLimitBytes,
    ratio: p.ratio,
    tier: p.tier,
    turnBudget: turnBudget(envTurnMax),
    toolBudgetBg: toolBudget(envBgMax),
    retained: retainedStats(),
  };
}

/** 仅测试用：固定容量；显式给水位时连采样一起固定（堆占比归零，让水位只取决于容量）。 */
export function setCapacityForTests(bytes: number | null, memoryBytes: number | null = null): void {
  capacityCache = bytes;
  capacityPromise = null;
  if (memoryBytes !== null) {
    sampleOverride = { heapUsed: 0, heapLimit: 0, memoryBytes };
  }
}

/** 仅测试用：单独固定堆与 cgroup 水位采样。 */
export function setPressureSampleForTests(sample: PressureSample | null): void {
  sampleOverride = sample;
}
