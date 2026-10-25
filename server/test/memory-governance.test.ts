/**
 * memory.forget / activity.timeline 行为测试（2026-09-24）。
 *
 * 契约：
 *   - forget 按关键词联动清除：兴趣池 / 降价监控 / 计划目标，逐项如实计数
 *   - 长期记忆未启用 → skipped 如实说明（不假装删除）
 *   - scope 收窄生效（scope=interest 只清兴趣）
 *   - timeline：聚合真实台账返回 + 空态零编造
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { GoalBoard } = await import("../src/proactivity/goal-board.js");
const { GoalPlanner } = await import("../src/proactivity/goal-planner.js");
const { InterestWatcher } = await import("../src/proactivity/interest-watcher.js");
const { ShoppingCompareService } = await import("../src/services/shopping-compare-service.js");
const mod = await import("../src/tools/capability-modules/memory-governance/handlers.js");
const { createForgetHandler, createTimelineHandler } = mod;

const CTX = { sessionId: "s1", userId: "u1" };

function makeBoard(): InstanceType<typeof GoalBoard> {
  return new GoalBoard({ dataPath: mkdtempSync(join(tmpdir(), "pa-forget-")), emitGoal: () => {} });
}

function makeOrderServiceStub(): never {
  throw new Error("不应触达浏览器链路");
}

async function makeWatcher(): Promise<InstanceType<typeof InterestWatcher>> {
  const dir = mkdtempSync(join(tmpdir(), "pa-forget-"));
  const w = new InterestWatcher({ persistPath: join(dir, "interest.json") });
  await w.load();
  return w;
}

function makeCompareStub(): InstanceType<typeof ShoppingCompareService> {
  return new ShoppingCompareService({
    shoppingOrderService: {
      listSupportedPlatforms: () => ["taobao", "jd", "pdd"],
      searchProduct: makeOrderServiceStub,
    },
    dataDir: join(mkdtempSync(join(tmpdir(), "pa-forget-")), "shopping"),
  } as never);
}

async function makeDeps() {
  const watcher = await makeWatcher();
  await watcher.addInterest("u1", "戴森吹风机", "brand");
  await watcher.addInterest("u1", "刘浩存", "person");

  const compare = makeCompareStub();
  await compare.addWatch("u1", "戴森吹风机", "taobao", 200);

  const board = makeBoard();
  const planner = new GoalPlanner({ goalBoard: board });
  planner.createPlan({ actorId: "u1", title: "戴森吹风机比价采购", steps: ["查价格"] });
  planner.createPlan({ actorId: "u1", title: "无关计划", steps: ["做别的"] });

  return { watcher, compare, board, planner };
}

test("forget auto：多处台账联动清除并如实计数", async (t) => {
  const { watcher, compare, board, planner } = await makeDeps();
  const handler = createForgetHandler({
    interestWatcher: watcher,
    shoppingCompareService: compare,
    goalBoard: board,
  });
  const r = (await handler({ target: "戴森吹风机" }, CTX)) as {
    ok: boolean;
    cleared: Record<string, number>;
    skipped: string[];
  };
  assert.equal(r.ok, true);
  assert.equal(r.cleared.interests, 1);
  assert.equal(r.cleared.watches, 1);
  assert.equal(r.cleared.goals, 1);
  assert.equal(r.cleared.memories, 0);
  assert.ok(r.skipped.some((s) => s.startsWith("memory(")), "mem0 未启用 → skipped 如实说明");

  // 池内净效果：另一兴趣不受影响
  const left = watcher.listInterests("u1").map((i) => i.name);
  assert.deepEqual(left, ["刘浩存"]);
  assert.equal(compare.listWatches("u1").length, 0);
  assert.equal(planner.getPlan("nope", "u1"), null);
  assert.equal(board.list("u1").some((g) => g.title.includes("戴森")), false);
  assert.equal(board.list("u1").some((g) => g.title.includes("无关计划")), true);
});

test("forget scope=interest：只清兴趣，监控与计划不动", async (t) => {
  const { watcher, compare, board, planner } = await makeDeps();
  const handler = createForgetHandler({
    interestWatcher: watcher,
    shoppingCompareService: compare,
    goalBoard: board,
  });
  const r = (await handler({ target: "戴森吹风机", scope: "interest" }, CTX)) as {
    cleared: Record<string, number>;
  };
  assert.equal(r.cleared.interests, 1);
  assert.equal(r.cleared.watches, 0);
  assert.equal(r.cleared.goals, 0);
  assert.equal(compare.listWatches("u1").length, 1);
  assert.equal(board.list("u1").filter((g) => g.kind === "plan").length, 2);
});

test("forget：目标过短拒绝", async (t) => {
  const handler = createForgetHandler({});
  const r = (await handler({ target: "戴" }, CTX)) as { ok: boolean };
  assert.equal(r.ok, false);
});

test("activity.timeline：聚合台账返回；未装配如实报错", async (t) => {
  const handlerNone = createTimelineHandler({});
  const rNone = (await handlerNone({}, CTX)) as { ok: boolean };
  assert.equal(rNone.ok, false);

  const { compare } = await makeDeps();
  const { AgentActivityStore } = await import("../src/proactivity/activity-store.js");
  const { AuditTrailService } = await import("../src/proactivity/audit-timeline.js");
  const store = new AgentActivityStore(join(mkdtempSync(join(tmpdir(), "pa-forget-")), "a.json"));
  store.record({ actorId: "u1", kind: "action.purchase", title: "已为你订购牛奶", summary: "下单成功" });
  const svc = new AuditTrailService({ activityStore: store });
  const handler = createTimelineHandler({ auditTrailService: svc });
  const r = (await handler({}, CTX)) as {
    ok: boolean;
    count: number;
    entries: Array<{ bucket: string; title: string }>;
  };
  assert.equal(r.ok, true);
  assert.equal(r.count, 1);
  assert.equal(r.entries[0]!.bucket, "done");
  void compare;
});
