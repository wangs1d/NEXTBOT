/**
 * TaskPlanProbeRunner 行为测试（2026-10-19 handoff · checkMode="probe"）。
 *
 * 契约：
 *   - 命中（结果序列化后包含 expect）→ 该步置 done，回调带 nextStep
 *   - 未命中 → 保持等待，不回调
 *   - 节流：同一步在 minProbeGapMs 内不重复探测
 *   - 只管 probe 步：user_confirm 的等待步一律跳过
 *   - 没写 expect 时按「工具返回 ok」判定
 *   - 收回失败（已被用户先点了）不回调、不重复探测
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { TaskPlanStore } = await import("../src/agent/task-plan-store.js");
const { TaskPlanProbeRunner } = await import("../src/agent/task-plan-probe-runner.js");

function makeEnv() {
  const dir = mkdtempSync(join(tmpdir(), "pa-planprobe-"));
  let now = 1_700_000_000_000;
  const store = new TaskPlanStore({ dataPath: dir, nowFn: () => now, log: () => {} });
  return {
    store,
    nowFn: () => now,
    tick: (ms = 60_000) => {
      now += ms;
      return now;
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function seedProbePlan(store: InstanceType<typeof TaskPlanStore>, expectValue = "已签收") {
  store.write({ sessionId: "s", actorId: "a", goal: "取快递", steps: ["等快递到驿站", "去驿站取件"] });
  const r = store.setStatus("s", "s1", "awaiting_confirm", undefined, {
    handoff: {
      instruction: "快递到驿站后去取一下",
      checkMode: "probe",
      probe: { tool: "order.list", args: { id: "x" }, expect: expectValue },
    },
  });
  assert.equal(r.ok, true);
}

test("probe 命中：步骤置 done，回调带 nextStep", async () => {
  const { store, cleanup } = makeEnv();
  try {
    seedProbePlan(store);
    const calls: Array<{ stepId: string; nextStepId?: string }> = [];
    const runner = new TaskPlanProbeRunner({
      store,
      executeProbe: async () => ({ ok: true, result: { status: "已签收" } }),
      onResumed: (r) => calls.push({ stepId: r.step.id, nextStepId: r.nextStep?.id }),
      log: () => {},
    });

    const resumed = await runner.tick();
    assert.equal(resumed, 1);
    assert.deepEqual(calls, [{ stepId: "s1", nextStepId: "s2" }]);
    assert.equal(store.get("s")!.steps[0].status, "done");
    assert.equal(store.get("s")!.steps[0].handoff, undefined);
    assert.equal(store.blockingStep("s"), null);
  } finally {
    cleanup();
  }
});

test("probe 未命中：保持等待，不回调", async () => {
  const { store, cleanup } = makeEnv();
  try {
    seedProbePlan(store, "已签收");
    let called = 0;
    const runner = new TaskPlanProbeRunner({
      store,
      executeProbe: async () => ({ ok: true, result: { status: "运输中" } }),
      onResumed: () => {
        called += 1;
      },
      log: () => {},
    });
    assert.equal(await runner.tick(), 0);
    assert.equal(called, 0);
    assert.equal(store.get("s")!.steps[0].status, "awaiting_confirm");
  } finally {
    cleanup();
  }
});

test("节流：同一步在间隔内只探测一次，过了间隔才再查", async () => {
  const { store, tick, nowFn, cleanup } = makeEnv();
  try {
    seedProbePlan(store, "永远不匹配");
    let probes = 0;
    const runner = new TaskPlanProbeRunner({
      store,
      nowFn,
      executeProbe: async () => {
        probes += 1;
        return { ok: true, result: { status: "运输中" } };
      },
      minProbeGapMs: 5 * 60_000,
      log: () => {},
    });

    await runner.tick();
    await runner.tick(); // 同一时刻 → 被节流
    assert.equal(probes, 1);

    tick(5 * 60_000 + 1);
    await runner.tick();
    assert.equal(probes, 2);
  } finally {
    cleanup();
  }
});

test("只管 probe 步：user_confirm 的等待步不探测", async () => {
  const { store, cleanup } = makeEnv();
  try {
    store.write({ sessionId: "s", actorId: "a", goal: "点外卖", steps: ["下单"] });
    store.setStatus("s", "s1", "awaiting_confirm", undefined, {
      handoff: { instruction: "在美团点一份麻辣烫", checkMode: "user_confirm" },
    });
    let probes = 0;
    const runner = new TaskPlanProbeRunner({
      store,
      executeProbe: async () => {
        probes += 1;
        return { ok: true, result: {} };
      },
      onResumed: () => {},
      log: () => {},
    });
    await runner.tick();
    assert.equal(probes, 0);
    assert.equal(store.get("s")!.steps[0].status, "awaiting_confirm");
  } finally {
    cleanup();
  }
});

test("没写 expect 时按工具 ok 判定；探测抛错不影响计划", async () => {
  const { store, cleanup } = makeEnv();
  try {
    store.write({ sessionId: "s", actorId: "a", goal: "任务", steps: ["等外部状态"] });
    store.setStatus("s", "s1", "awaiting_confirm", undefined, {
      handoff: { instruction: "等一会儿", checkMode: "probe", probe: { tool: "query.status" } },
    });
    const runner = new TaskPlanProbeRunner({
      store,
      executeProbe: async () => {
        throw new Error("接口挂了");
      },
      onResumed: () => assert.fail("探测失败不该回调"),
      log: () => {},
    });
    assert.equal(await runner.tick(), 0);
    assert.equal(store.get("s")!.steps[0].status, "awaiting_confirm");

    const okRunner = new TaskPlanProbeRunner({
      store,
      executeProbe: async () => ({ ok: true, result: {} }),
      onResumed: () => {},
      log: () => {},
    });
    assert.equal(await okRunner.tick(), 1);
    assert.equal(store.get("s")!.steps[0].status, "done");
  } finally {
    cleanup();
  }
});

test("已被用户先点了：resume 失败 → 不回调，计数为 0", async () => {
  const { store, cleanup } = makeEnv();
  try {
    seedProbePlan(store, "已签收");
    let called = 0;
    const runner = new TaskPlanProbeRunner({
      store,
      // 探测期间用户点了按钮（并发）
      executeProbe: async () => {
        store.resume("s", "s1", { by: "user" });
        return { ok: true, result: { status: "已签收" } };
      },
      onResumed: () => {
        called += 1;
      },
      log: () => {},
    });
    assert.equal(await runner.tick(), 0);
    assert.equal(called, 0);
    assert.equal(store.get("s")!.steps[0].status, "done");
  } finally {
    cleanup();
  }
});
