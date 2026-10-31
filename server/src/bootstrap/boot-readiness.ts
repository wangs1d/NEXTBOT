/**
 * 启动就绪闸。
 *
 * 服务先 listen 再初始化运行状态：端口一开，/health 立刻可答（带 ready 标记），
 * 其余路由在初始化完成前排队。好处是「起没起来」与「初始化到哪一步」不再混在
 * 一个连接拒绝里——崩溃、卡死、慢初始化是三种可区分的现象。
 *
 * 只有显式调用 beginBoot() 的进程才启用闸；单测等未调用的入口长期放行。
 */

let pending = false;
let openGate: Promise<void> | null = null;
let waiters: Array<() => void> = [];

export function beginBoot(): void {
  if (pending) return;
  pending = true;
  openGate = null;
}

export function markBootDone(): void {
  pending = false;
  openGate = null;
  const list = waiters;
  waiters = [];
  for (const resolve of list) resolve();
}

export function isBootPending(): boolean {
  return pending;
}

/** 闸未启用时返回 null，调用方直接放行。 */
export function awaitBoot(): Promise<void> | null {
  if (!pending) return null;
  if (!openGate) {
    openGate = new Promise<void>((resolve) => {
      waiters.push(resolve);
    });
  }
  return openGate;
}
