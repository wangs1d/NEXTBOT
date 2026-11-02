/**
 * 按 actor 的并发配额（全局闸之前的一层）。
 *
 * 机器容量归 resource-pool 管，它只懂「这台机器能同时跑几轮」，不懂「谁在占」。
 * 云端一机多用户时，单个用户的多个会话可以把全局 turn 闸占满，别人只能吃 429；
 * 后台任务同理（一个人的四个任务能排空整条 bg 通道）。这里给每个 actor 加一把
 * 自己的小闸：先取本 actor 的名额，再取全局名额，顺序固定（不会反向互等）。
 *
 * - 名额超出 = 在**本 actor 自己的队列**里排队，排队超时语义与全局闸一致
 * - 闸实例只在有人占用/排队时存在，空闲即删，常驻内存只随「正在忙的 actor」增长
 * - 上限用 env 常量：单机自用想放宽就调大，不需要按机器水位再缩一层
 *   （水位收紧是全局闸的职责，全局压到 1 时本层 2 自然不起作用）
 */

import { Semaphore, backgroundTaskLimiter, globalTurnLimiter, isHeavyTool } from "./concurrency-limiter.js";

export type ActorQuotaClass = "turn" | "bg" | "heavyTool";

function envPosInt(key: string, fallback: number): number {
  const n = Number.parseInt(process.env[key] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** 同一 actor 同时可跑的对话轮（默认 2：够本人连发两条，不至于占满全局 8）。 */
function turnMax(): number {
  return envPosInt("MAX_CONCURRENT_TURNS_PER_ACTOR", 2);
}

/** 同一 actor 同时可跑的后台任务（默认 2，全局 bg 上限 4）。 */
function bgMax(): number {
  return envPosInt("MAX_BG_TASKS_PER_ACTOR", 2);
}

/** 同一 actor 同时占用的重型工具位（默认 2，全局按名上限 2~3）。 */
function heavyToolMax(): number {
  return envPosInt("MAX_CONCURRENT_HEAVY_TOOLS_PER_ACTOR", 2);
}

function baseMax(cls: ActorQuotaClass): number {
  if (cls === "turn") return turnMax();
  if (cls === "bg") return bgMax();
  return heavyToolMax();
}

/** 名额只认 actorId：空/匿名归到同一个桶，避免"没认领身份"的请求各自开闸。 */
function quotaActorKey(actorId: string | undefined | null): string {
  const v = String(actorId ?? "").trim();
  return v || "anonymous";
}

/** 只统计「真正在忙」的 actor：空闲闸即时删除，因此这张表不会随历史用户增长。 */
const gates = new Map<string, Semaphore>();

function gateFor(cls: ActorQuotaClass, actorId: string): Semaphore {
  const key = `${cls}:${actorId}`;
  let gate = gates.get(key);
  if (!gate) {
    gate = new Semaphore(baseMax(cls), `actor-${cls}:${actorId}`);
    gates.set(key, gate);
  } else {
    // env 在测试/热改里可能变过；每次取用时对齐上限（上调会唤醒排队者）
    gate.updateMax(baseMax(cls));
  }
  return gate;
}

function pruneIfIdle(key: string): void {
  const gate = gates.get(key);
  if (gate && gate.activeCount === 0 && gate.queuedCount === 0) gates.delete(key);
}

/**
 * 获取本 actor 的一个名额。
 * @param timeoutMs 排队超时（0 = 永等）；超时 reject，由调用方按忙线处理
 * @returns release 函数（必须在 finally 里调用，且早于全局名额的释放）
 */
async function acquire(
  cls: ActorQuotaClass,
  rawActorId: string | undefined | null,
  timeoutMs: number,
): Promise<() => void> {
  const actorId = quotaActorKey(rawActorId);
  const key = `${cls}:${actorId}`;
  const gate = gateFor(cls, actorId);
  let release: () => void;
  try {
    release = await gate.acquire(timeoutMs);
  } catch (err) {
    // 排队超时后本 actor 可能一个都没在跑，闸要留在原地等下一个；这里显式回收
    pruneIfIdle(key);
    throw err;
  }
  let done = false;
  return () => {
    if (done) return;
    done = true;
    release();
    pruneIfIdle(key);
  };
}

/**
 * 一轮用户对话的两级名额：先占本 actor 再占全局。
 * 顺序固定 actor → global（反着取会和别的轮次互等），任一失败即回滚已占的。
 * 排队超时会抛错，语义与只用全局闸时一致（调用方回忙线文案）。
 */
export async function acquireTurnSlots(actorId: string, timeoutMs: number): Promise<() => void> {
  const releaseActor = await acquire("turn", actorId, timeoutMs);
  let releaseGlobal: () => void;
  try {
    releaseGlobal = await globalTurnLimiter.acquire(timeoutMs);
  } catch (err) {
    releaseActor();
    throw err;
  }
  return () => {
    releaseGlobal();
    releaseActor();
  };
}

/** 一个后台任务的两级名额：同 actor 限流 + 全局 bg 闸（超时 0 = 排队等槽位）。 */
export async function acquireBgTaskSlots(actorId: string, timeoutMs: number): Promise<() => void> {
  const releaseActor = await acquire("bg", actorId, timeoutMs);
  let releaseGlobal: () => void;
  try {
    releaseGlobal = await backgroundTaskLimiter.acquire(timeoutMs);
  } catch (err) {
    releaseActor();
    throw err;
  }
  return () => {
    releaseGlobal();
    releaseActor();
  };
}

/**
 * 重型工具（code.* / image.generate / voice.*）的按 actor 硬上限。
 *
 * 全局按名上限只管「这台机器同时能跑几个 code.run」，一个人开四个后台任务就能
 * 把它们全占满，别人的图片/语音只能排队。这里先占本 actor 的重型位再进全局闸，
 * 超出的在**自己队列**里等（与全局闸同样不等超时）——谁的活谁收尾，不抢别人的位。
 * 非重型工具与具身分域工具（同设备互斥）不走这层。
 */
export async function executeWithinActorHeavyToolLimit<T>(
  toolName: string,
  actorId: string | undefined | null,
  fn: () => Promise<T>,
): Promise<T> {
  if (!isHeavyTool(toolName)) return fn();
  const release = await acquire("heavyTool", actorId, 0);
  try {
    return await fn();
  } finally {
    release();
  }
}

export interface ActorQuotaSnapshot {
  limits: { turn: number; bg: number; heavyTool: number };
  gates: Array<{
    kind: ActorQuotaClass;
    actorId: string;
    active: number;
    queued: number;
    max: number;
  }>;
}

/** 供 /system/concurrency 展示：当前正在占名额的 actor 与排队深度。 */
export function actorQuotaSnapshot(): ActorQuotaSnapshot {
  const rows: ActorQuotaSnapshot["gates"] = [];
  for (const [key, gate] of gates) {
    rows.push({
      kind: key.slice(0, key.indexOf(":")) as ActorQuotaClass,
      actorId: key.slice(key.indexOf(":") + 1),
      active: gate.activeCount,
      queued: gate.queuedCount,
      max: gate.max,
    });
  }
  rows.sort((a, b) => b.active - a.active || a.actorId.localeCompare(b.actorId));
  return { limits: { turn: turnMax(), bg: bgMax(), heavyTool: heavyToolMax() }, gates: rows };
}

/** 仅测试用：看清注册表，避免上一个用例的残留闸影响断言。 */
export function resetActorQuotaForTests(): void {
  gates.clear();
}
