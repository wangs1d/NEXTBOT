/**
 * 客户端能力声明注册表（进程内，按 actorId）。
 *
 * 契约：客户端在 session.init 的 `capabilities` 里自报它真正会消费的界面/事件能力
 * （键名任意，值必须严格为 true）。未声明 = 不支持——依赖该能力的工具如实返回失败，
 * 让模型改走真实可达路径，而不是空口宣称成功（历史事故：客户端从未实现
 * agent.media.play，push「成功」后模型宣称「歌已经放上了」，实际什么都没响）。
 */

import { RetentionMap, retentionMaxEntries } from "./resource-pool.js";

const TTL_MS = 12 * 60 * 60_000;

interface StoredCapabilities {
  capabilities: ReadonlyMap<string, boolean>;
  declaredAt: number;
}

/** 有界缓存：空闲超 TTL_MS 由资源池心跳清扫，actor 数超上限按最近未用淘汰。 */
const byActor = new RetentionMap<StoredCapabilities>("client-capabilities", {
  maxEntries: retentionMaxEntries(2000),
  idleMs: TTL_MS,
});

/** 整体覆盖写入一次声明快照（重连即以最新声明为准）。非 true 的键不收。 */
export function declareClientCapabilities(
  actorId: string,
  caps: Record<string, unknown> | undefined,
): void {
  const id = actorId?.trim();
  if (!id) return;
  const capabilities = new Map<string, boolean>();
  for (const [key, value] of Object.entries(caps ?? {})) {
    if (value === true) capabilities.set(key, true);
  }
  byActor.set(id, { capabilities, declaredAt: Date.now() });
}

export function clearClientCapabilities(actorId: string): void {
  byActor.delete(actorId);
}

/** 客户端是否声明了某项能力。未声明/已过期一律 false（fail-closed = 诚实失败）。 */
export function clientSupportsCapability(actorId: string, capability: string): boolean {
  return liveEntry(actorId)?.capabilities.get(capability) === true;
}

/** 该 actor 当前声明过的能力键；未声明/已过期 = 空数组。 */
export function declaredClientCapabilities(actorId: string): string[] {
  const stored = liveEntry(actorId);
  return stored ? [...stored.capabilities.keys()] : [];
}

function liveEntry(actorId: string): StoredCapabilities | undefined {
  const key = actorId?.trim() ?? "";
  const stored = byActor.get(key);
  if (!stored) return undefined;
  if (Date.now() - stored.declaredAt > TTL_MS) {
    byActor.delete(key);
    return undefined;
  }
  return stored;
}
