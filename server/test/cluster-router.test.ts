/**
 * cluster-router 契约测试：单节点零行为变化；多节点下同一 actor 归属确定，
 * sticky 复用存活节点，节点下线重哈希。注册表用 setNodesForTests 固定。
 */
import assert from "node:assert/strict";
import test from "node:test";

const {
  setNodesForTests,
  routeActor,
  isOwner,
  clusterEnabled,
  clusterNodes,
  clusterSnapshot,
} = await import("../src/services/cluster-router.js");
const { nodeId } = await import("../src/services/resource-pool.js");

const SELF = nodeId();

test("单节点（未设 NEXTBOT_NODES）：cluster 关闭，一切 actor 归自己", () => {
  setNodesForTests(null);
  assert.equal(clusterEnabled(), false);
  assert.equal(clusterNodes().length, 1);
  for (const actor of ["a@x.com", "user-42", "dev-bridge"]) {
    const r = routeActor(actor);
    assert.equal(r.nodeId, SELF);
    assert.equal(isOwner(actor), true);
  }
});

test("多节点：同一 actor 归属确定且落在注册表内", () => {
  setNodesForTests([
    { nodeId: "node-a", endpoint: "wss://a.example.com/ws" },
    { nodeId: "node-b", endpoint: "wss://b.example.com/ws" },
    { nodeId: SELF, endpoint: "" },
  ]);
  assert.equal(clusterEnabled(), true);
  const valid = new Set(["node-a", "node-b", SELF]);
  const seen = new Set<string>();
  for (let i = 0; i < 60; i++) {
    const r = routeActor(`user-${i}`);
    assert.ok(valid.has(r.nodeId), `user-${i} 落在注册表内`);
    seen.add(r.nodeId);
    // 同一 actor 重复路由必须一致（sticky 或确定性哈希）
    assert.equal(routeActor(`user-${i}`).nodeId, r.nodeId);
  }
  assert.ok(seen.size > 1, "60 个 actor 应散到多个节点");
  setNodesForTests(null);
});

test("sticky：节点扩容后存量 actor 不漂移；节点下线后重哈希到存活节点", () => {
  setNodesForTests([{ nodeId: "node-a", endpoint: "wss://a/ws" }, { nodeId: SELF, endpoint: "" }]);
  const before = routeActor("user-sticky");
  // 扩容不改归属（sticky 优先）
  setNodesForTests([
    { nodeId: "node-a", endpoint: "wss://a/ws" },
    { nodeId: "node-b", endpoint: "wss://b/ws" },
    { nodeId: SELF, endpoint: "" },
  ]);
  const kept = routeActor("user-sticky");
  assert.equal(kept.nodeId, before.nodeId, "存活节点内的归属不因扩容漂移");
  assert.equal(kept.sticky, true);

  // 唯一非自身节点下线 → 重哈希必须落到存活节点（自己）
  const actor = "user-failover";
  setNodesForTests([{ nodeId: "node-a", endpoint: "wss://a/ws" }, { nodeId: SELF, endpoint: "" }]);
  routeActor(actor); // 建立 sticky
  setNodesForTests([{ nodeId: SELF, endpoint: "" }]);
  const after = routeActor(actor);
  assert.equal(after.nodeId, SELF);
  assert.equal(isOwner(actor), true);
  setNodesForTests(null);
});

test("集群快照：节点数与 sticky 计数进指标", () => {
  setNodesForTests([{ nodeId: "node-a", endpoint: "wss://a/ws" }, { nodeId: SELF, endpoint: "" }]);
  routeActor("snap-1");
  routeActor("snap-2");
  const snap = clusterSnapshot();
  assert.equal(snap.nodeId, SELF);
  assert.equal(snap.enabled, true);
  assert.equal(snap.nodes.length, 2);
  assert.ok(snap.stickyActors >= 2);
  setNodesForTests(null);
});
