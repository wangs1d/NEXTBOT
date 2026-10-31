/**
 * resource-pool 契约测试：并发预算随机器容量与内存水位收紧，
 * 常驻缓存按 LRU / 空闲时限淘汰。容量与水位用 setCapacityForTests /
 * setPressureSampleForTests 固定，断言不依赖真实机器内存。
 */
import assert from "node:assert/strict";
import os from "node:os";
import test from "node:test";

const {
  setCapacityForTests,
  setPressureSampleForTests,
  turnBudget,
  toolBudget,
  poolPressure,
  nodeId,
  retentionMaxEntries,
  RetentionMap,
  retainedStats,
  resourcePoolSnapshot,
  refreshPressure,
} = await import("../src/services/resource-pool.js");

const GB = 1024 ** 3;

test("2G 机器 normal 水位：turn 预算取 env 与机器预算的交集，机器低于 env 时按机器", () => {
  setCapacityForTests(2 * GB, 0.3 * GB);
  assert.equal(poolPressure().tier, "normal");
  // 机器预算 = 2G * 4 = 8：env 给 8 时不收紧，env 给 16 时被机器压到 8
  assert.equal(turnBudget(8), 8);
  assert.equal(turnBudget(16), 8);
  // 重型工具闸 env 是硬上限，normal 水位不动
  assert.equal(toolBudget(4), 4);
});

test("内存水位收紧：elevated 打六折，critical 打二五折且不低于 1", () => {
  setCapacityForTests(2 * GB, 0.75 * 2 * GB);
  assert.equal(poolPressure().tier, "elevated");
  assert.equal(turnBudget(8), 4);
  assert.equal(toolBudget(4), 2);

  setCapacityForTests(2 * GB, 0.9 * 2 * GB);
  assert.equal(poolPressure().tier, "critical");
  assert.equal(turnBudget(8), 2);
  assert.equal(toolBudget(4), 1);

  // 小机器 + critical：机器预算本身已到底，仍必须至少放行 1 路
  setCapacityForTests(1 * GB, 0.95 * GB);
  assert.equal(turnBudget(8), 1);
  assert.equal(toolBudget(1), 1);
});

test("水位取堆与 cgroup 的最差占比：V8 堆贴近上限同样触发收紧", () => {
  setPressureSampleForTests({ heapUsed: 0.8 * 900 * 1024 ** 2, heapLimit: 900 * 1024 ** 2, memoryBytes: 0.3 * GB });
  setCapacityForTests(2 * GB);
  assert.equal(poolPressure().tier, "elevated");
  assert.equal(turnBudget(8), 4);

  setPressureSampleForTests({ heapUsed: 0.9 * 900 * 1024 ** 2, heapLimit: 900 * 1024 ** 2, memoryBytes: 0.3 * GB });
  assert.equal(poolPressure().tier, "critical");
  assert.equal(toolBudget(4), 1);

  setPressureSampleForTests(null);
});

test("nodeId：未设 NEXTBOT_NODE_ID 时回落主机名", () => {
  assert.equal(nodeId(), process.env.NEXTBOT_NODE_ID?.trim() || os.hostname());
});

test("retentionMaxEntries：按容量给上限，env 更小时以 env 为准", () => {
  setCapacityForTests(2 * GB, 0.3 * GB);
  assert.equal(retentionMaxEntries(64), 64);
  assert.equal(retentionMaxEntries(4000), 128);
  assert.ok(retentionMaxEntries(8) >= 16);
});

test("RetentionMap 超量按最近未用淘汰：命中会刷新新旧，被淘汰的是最久未用的", () => {
  const map = new RetentionMap<number>("test-lru", { maxEntries: 2, idleMs: Number.POSITIVE_INFINITY });
  map.set("a", 1);
  map.set("b", 2);
  assert.equal(map.get("a"), 1); // a 变成最新，b 成为最久未用
  map.set("c", 3);

  assert.equal(map.size, 2);
  assert.ok(map.has("a"), "刚命中过的条目必须留下");
  assert.ok(map.has("c"));
  assert.ok(!map.has("b"), "最久未用的条目必须被淘汰");
  const stats = map.stats();
  assert.equal(stats.evictedLru, 1);
  assert.equal(stats.maxEntries, 2);
});

test("RetentionMap 空闲清扫：超过 idleMs 未再访问即丢弃，未超时保留", async () => {
  const map = new RetentionMap<number>("test-idle", { maxEntries: 100, idleMs: 1000 });
  map.set("old", 1);
  map.set("fresh", 2);
  // 把 fresh 访问时间推后，模拟它仍在被使用
  await new Promise((r) => setTimeout(r, 1100));
  map.set("fresh", 3);

  const removed = map.sweep(Date.now());
  assert.equal(removed, 1);
  assert.ok(!map.has("old"), "空闲超时的条目应被清扫");
  assert.equal(map.get("fresh"), 3);
  assert.equal(map.stats().evictedIdle, 1);
});

test("sweepRetained / resourcePoolSnapshot：常驻缓存登记后统一清扫并进指标", async () => {
  const { sweepRetained } = await import("../src/services/resource-pool.js");
  const map = new RetentionMap<number>("test-swept", { maxEntries: 10, idleMs: 50 });
  map.set("x", 1);
  await new Promise((r) => setTimeout(r, 80));
  map.set("y", 2); // 刷新登记时间戳，保证 x 空闲、y 未空闲

  setCapacityForTests(2 * GB, 0.3 * GB);
  const swept = sweepRetained();
  assert.ok(swept.removed >= 1, "超时空闲条目必须被全局清扫带走");
  assert.ok(!map.has("x"));
  assert.ok(map.has("y"));

  const names = retainedStats().map((s) => s.name);
  assert.ok(names.includes("test-swept"), "登记过的缓存要能在指标里看到");

  const snap = resourcePoolSnapshot(8, 4);
  assert.equal(snap.capacityBytes, 2 * GB);
  assert.equal(snap.turnBudget, 8);
  assert.equal(snap.toolBudgetBg, 4);
  assert.equal(snap.tier, "normal");
  assert.equal(snap.nodeId, nodeId());
  assert.ok(Array.isArray(snap.retained));
  await refreshPressure(); // 非 Linux 上读不到 cgroup，必须静默不抛
});
