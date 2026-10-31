/**
 * 集群路由基层：节点注册表 -> actor 归属 -> sticky。
 *
 * 单进程时代只做归因与铺路：未设 NEXTBOT_NODES 时注册表只有自己，
 * routeActor 永远返回本节点，行为零变化。扩到多节点时，WS 接入层
 * 在 session.init 用 isOwner 判定归属，非 owner 带上 owner 端点重定向，
 * 保证同一 actor 的常驻状态（记忆/会话分片/能力声明）只落在一个节点。
 * 选址 = sticky 优先（存活节点内复用上次的），否则 rendezvous 哈希；
 * sticky 节点下线自动重哈希，重新上线由 sticky 免去再度迁移。
 */

import { createHash } from "node:crypto";
import { nodeId, retentionMaxEntries, RetentionMap } from "./resource-pool.js";

export interface ClusterNode {
  nodeId: string;
  /** 客户端可重连的 ws(s) 端点；本节点可为空串 */
  endpoint: string;
}

export interface ActorRoute {
  nodeId: string;
  endpoint: string;
  /** 命中 sticky（true）还是本次新哈希（false） */
  sticky: boolean;
}

const SELF_NODE_ID = nodeId();
const STICKY_TTL_MS = 12 * 60 * 60_000;

let nodes: ClusterNode[] = [];
const stickyByActor = new RetentionMap<string>("cluster-sticky", {
  maxEntries: retentionMaxEntries(2000),
  idleMs: STICKY_TTL_MS,
});

/** NEXTBOT_NODES 形如 "idA=wss://a/ws,idB=wss://b/ws"；未设时只有自己。 */
function parseNodes(raw: string | undefined): ClusterNode[] {
  const parsed: ClusterNode[] = [];
  for (const part of (raw ?? "").split(",")) {
    const entry = part.trim();
    if (!entry) continue;
    const eq = entry.indexOf("=");
    if (eq <= 0) continue;
    const id = entry.slice(0, eq).trim();
    const endpoint = entry.slice(eq + 1).trim();
    if (id) parsed.push({ nodeId: id, endpoint });
  }
  if (!parsed.some((n) => n.nodeId === SELF_NODE_ID)) {
    parsed.push({ nodeId: SELF_NODE_ID, endpoint: process.env.NEXTBOT_PUBLIC_WS_URL?.trim() ?? "" });
  }
  return parsed;
}

/** 注册表变化（扩缩容）时调用；sticky 保留，存活节点内的归属不漂移。 */
export function initClusterRouter(): void {
  nodes = parseNodes(process.env.NEXTBOT_NODES);
}

export function clusterEnabled(): boolean {
  return nodes.length > 1;
}

export function clusterNodes(): ClusterNode[] {
  return nodes;
}

/** rendezvous（HRW）：对每个节点算 hash(actorId+nodeId)，取最大者。 */
function rendezvous(actorId: string): ClusterNode {
  let best: ClusterNode = nodes[0];
  let bestScore = "";
  for (const node of nodes) {
    const score = createHash("sha256").update(`${actorId}\u0000${node.nodeId}`).digest("hex");
    if (score > bestScore) {
      bestScore = score;
      best = node;
    }
  }
  return best;
}

export function routeActor(actorId: string): ActorRoute {
  const actor = actorId?.trim() ?? "";
  if (!clusterEnabled() || !actor) {
    return { nodeId: SELF_NODE_ID, endpoint: selfEndpoint(), sticky: false };
  }
  const stickyId = stickyByActor.get(actor);
  const stickyNode = stickyId ? nodes.find((n) => n.nodeId === stickyId) : undefined;
  if (stickyNode) return { nodeId: stickyNode.nodeId, endpoint: stickyNode.endpoint, sticky: true };
  const chosen = rendezvous(actor);
  stickyByActor.set(actor, chosen.nodeId);
  return { nodeId: chosen.nodeId, endpoint: chosen.endpoint, sticky: false };
}

export function isOwner(actorId: string): boolean {
  return routeActor(actorId).nodeId === SELF_NODE_ID;
}

export interface ClusterSnapshot {
  nodeId: string;
  enabled: boolean;
  nodes: ClusterNode[];
  stickyActors: number;
}

export function clusterSnapshot(): ClusterSnapshot {
  return {
    nodeId: SELF_NODE_ID,
    enabled: clusterEnabled(),
    nodes: nodes,
    stickyActors: stickyByActor.size,
  };
}

function selfEndpoint(): string {
  return nodes.find((n) => n.nodeId === SELF_NODE_ID)?.endpoint ?? "";
}

/** 仅测试用：直接覆写注册表（sticky 保留，与扩缩容语义一致）。 */
export function setNodesForTests(list: ClusterNode[] | null): void {
  nodes = list ?? parseNodes(undefined);
}
