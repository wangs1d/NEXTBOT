/**
 * TaskPlanStore（会话级任务计划）行为测试（2026-10-19，三层尺度架构 P0-B）。
 *
 * 契约：
 *   - 写入：2-8 步建档，步骤全 pending；未完成计划默认拒绝重写（mode=replace 才覆盖）
 *   - 状态：单步推进 running/done/failed，事件带变化步骤
 *   - 重排：只重排未完成，done/failed/skipped 保留存档
 *   - 交接（handoff）：进等待必须带说明；agent 不能自己放行；resume 是唯一收回通道
 *   - 注入：未完成时才产出 prompt 块；等待时附交接说明与工具面收缩提示
 *   - 持久化：同目录新实例可恢复（多步任务常跨轮、跨重启）
 *   - 边界：超 8 步报错；无计划时 setStatus 如实报错
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { TaskPlanStore, isHandoffDoneReply } = await import("../src/agent/task-plan-store.js");

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), "pa-taskplan-"));
  let now = 1_700_000_000_000;
  const store = new TaskPlanStore({ dataPath: dir, nowFn: () => now, log: () => {} });
  return {
    store,
    dir,
    nowFn: () => now,
    tick: (ms = 1000) => {
      now += ms;
      return now;
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("plan.write 建档：步骤全 pending，进度 0/N", () => {
  const { store, cleanup } = makeStore();
  try {
    const r = store.write({
      sessionId: "sess-a",
      actorId: "actor-1",
      goal: "订下周去三亚的行程",
      steps: ["确认日期和人数", "比价机票", "订酒店", "安排接机"],
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.plan.steps.length, 4);
    assert.ok(r.plan.steps.every((s) => s.status === "pending"));
    assert.equal(store.progressLine(r.plan), "0/4 步");
    assert.ok(r.plan.planId.startsWith("tp_"));
  } finally {
    cleanup();
  }
});

test("覆盖守卫：未完成计划默认拒绝重写，mode=replace 才覆盖", () => {
  const { store, tick, cleanup } = makeStore();
  try {
    const first = store.write({ sessionId: "s", actorId: "a", goal: "旧任务", steps: ["x", "y"] });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    store.setStatus("s", "s1", "done", "第一步好了");
    tick();

    // 默认 new：拒绝（否则进度清零 = 用户眼里任务倒退）
    const refused = store.write({ sessionId: "s", actorId: "a", goal: "新任务", steps: ["p"] });
    assert.equal(refused.ok, false);
    if (refused.ok) return;
    assert.ok(refused.error.includes("plan.replan"));
    assert.equal(store.get("s")!.steps[0].status, "done");

    // 显式 replace：允许覆盖，planId 保留
    const second = store.write({ sessionId: "s", actorId: "a", goal: "新任务", steps: ["p"], mode: "replace" });
    assert.equal(second.ok, true);
    if (!second.ok) return;
    assert.equal(second.plan.planId, first.plan.planId);
    assert.equal(second.plan.steps.length, 1);
    assert.equal(second.plan.goal, "新任务");
  } finally {
    cleanup();
  }
});

test("plan.set_status：单步推进并广播带步骤的事件", () => {
  const { store, tick, cleanup } = makeStore();
  try {
    const w = store.write({ sessionId: "s", actorId: "a", goal: "任务", steps: ["一", "二"] });
    assert.equal(w.ok, true);
    if (!w.ok) return;

    const events: Array<{ type: string; stepId?: string; status?: string }> = [];
    store.subscribeSession("s", (ev) => {
      events.push({ type: ev.type, stepId: ev.step?.id, status: ev.step?.status });
    });

    tick();
    const r = store.setStatus("s", "s1", "running");
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.step.status, "running");
    assert.equal(store.progressLine(r.plan), "0/2 步，当前「一」");

    tick();
    store.setStatus("s", "s1", "done", "日期确认完毕");
    assert.deepEqual(events.at(-1), { type: "status", stepId: "s1", status: "done" });
    assert.equal(store.progressLine(store.get("s")!), "1/2 步");
  } finally {
    cleanup();
  }
});

test("plan.replan：保留已完成/失败/跳过，只重排待办", () => {
  const { store, tick, cleanup } = makeStore();
  try {
    const w = store.write({ sessionId: "s", actorId: "a", goal: "任务", steps: ["一", "二", "三"] });
    assert.equal(w.ok, true);
    if (!w.ok) return;
    store.setStatus("s", "s1", "done", "ok");
    store.setStatus("s", "s2", "failed", "查不到");
    tick();

    const rp = store.replan("s", ["换个思路", "收尾"], "原路走不通");
    assert.equal(rp.ok, true);
    if (!rp.ok) return;
    const statuses = rp.plan.steps.map((s) => s.status);
    // 存档 2 条（done + failed）+ 新待办 2 条
    assert.equal(rp.plan.steps.length, 4);
    assert.equal(statuses.filter((s) => s === "done").length, 1);
    assert.equal(statuses.filter((s) => s === "failed").length, 1);
    assert.equal(statuses.filter((s) => s === "pending").length, 2);
  } finally {
    cleanup();
  }
});

test("prompt 块：未完成时注入，全完成时不再占上下文", () => {
  const { store, cleanup } = makeStore();
  try {
    assert.equal(store.buildPromptBlock("s"), undefined);
    store.write({ sessionId: "s", actorId: "a", goal: "任务", steps: ["一", "二"] });
    const block = store.buildPromptBlock("s");
    assert.ok(block?.includes("【当前任务步骤】"));
    assert.ok(block?.includes("任务：任务"));
    assert.ok(block?.includes("1. 一"));
    store.setStatus("s", "s1", "done");
    store.setStatus("s", "s2", "skipped");
    assert.equal(store.buildPromptBlock("s"), undefined);
  } finally {
    cleanup();
  }
});

test("持久化：同目录新实例可恢复计划", () => {
  const { store, dir, nowFn, cleanup } = makeStore();
  try {
    store.write({ sessionId: "sess-persist", actorId: "a", goal: "跨轮任务", steps: ["一", "二"] });
    store.setStatus("sess-persist", "s1", "done", "第一步好了");
    // 同一时钟：默认 Date.now 会把 2023 的测试时间戳判成过期（prune 7 天归档）
    const restored = new TaskPlanStore({ dataPath: dir, nowFn, log: () => {} });
    const plan = restored.get("sess-persist");
    assert.ok(plan);
    assert.equal(plan?.goal, "跨轮任务");
    assert.equal(plan?.steps[0].status, "done");
    assert.equal(plan?.steps[0].note, "第一步好了");
  } finally {
    cleanup();
  }
});

test("边界：超 8 步报错；无计划时 setStatus 报错；clear 后读不到", () => {
  const { store, cleanup } = makeStore();
  try {
    const tooMany = store.write({
      sessionId: "s",
      actorId: "a",
      goal: "太多",
      steps: Array.from({ length: 9 }, (_, i) => `步${i + 1}`),
    });
    assert.equal(tooMany.ok, false);

    const noPlan = store.setStatus("nope", "s1", "done");
    assert.equal(noPlan.ok, false);

    store.write({ sessionId: "s", actorId: "a", goal: "任务", steps: ["一"] });
    assert.equal(store.clear("s"), true);
    assert.equal(store.get("s"), null);
  } finally {
    cleanup();
  }
});

test("handoff：进等待必须带交接说明；agent 不能替用户放行；resume 收回后继续", () => {
  const { store, cleanup } = makeStore();
  try {
    store.write({ sessionId: "s", actorId: "a", goal: "点外卖", steps: ["选餐厅", "下单", "取餐"] });

    // 缺 handoff.instruction → 拒绝（否则恢复时只能靠模型猜）
    const noHandoff = store.setStatus("s", "s1", "awaiting_confirm");
    assert.equal(noHandoff.ok, false);

    const handed = store.setStatus("s", "s1", "awaiting_confirm", undefined, {
      handoff: {
        instruction: "在美团点一份麻辣烫送到公司",
        checkMode: "user_confirm",
        actions: [{ id: "open", label: "打开美团" }],
        idempotencyKey: "order-1",
      },
    });
    assert.equal(handed.ok, true);
    if (!handed.ok) return;
    assert.equal(handed.step.handoff?.instruction, "在美团点一份麻辣烫送到公司");
    assert.ok(typeof handed.step.handoff?.since === "number");

    // 关键：agent 自己不能把等待步置 done / 继续做（沉默 ≠ 同意）
    const selfApprove = store.setStatus("s", "s1", "done", "我点好了");
    assert.equal(selfApprove.ok, false);
    const selfResume = store.setStatus("s", "s1", "running");
    assert.equal(selfResume.ok, false);

    // 用户回执 → 唯一放行通道；载荷清空，nextStep 指向下一步
    const resumed = store.resume("s", "s1", { by: "user", note: "已付款" });
    assert.equal(resumed.ok, true);
    if (!resumed.ok) return;
    assert.equal(resumed.step.status, "done");
    assert.equal(resumed.step.note, "已付款");
    assert.equal(resumed.step.handoff, undefined);
    assert.equal(resumed.nextStep?.id, "s2");

    // 重复回执：已不在等待态，如实报错（幂等，不会二次推进）
    const again = store.resume("s", "s1", { by: "user" });
    assert.equal(again.ok, false);
  } finally {
    cleanup();
  }
});

test("handoff：probe 证据也能收回；用户不做可置 skipped", () => {
  const { store, cleanup } = makeStore();
  try {
    store.write({ sessionId: "s", actorId: "a", goal: "查快递", steps: ["等快递到驿站", "去取"] });
    store.setStatus("s", "s1", "awaiting_confirm", undefined, {
      handoff: {
        instruction: "快递到驿站后去取一下",
        checkMode: "probe",
        probe: { tool: "order.list", expect: "状态=已签收" },
      },
    });
    const byProbe = store.resume("s", "s1", { by: "probe" });
    assert.equal(byProbe.ok, true);

    store.setStatus("s", "s2", "awaiting_confirm", undefined, {
      handoff: { instruction: "去驿站取件", checkMode: "user_confirm" },
    });
    const skip = store.setStatus("s", "s2", "skipped", "用户不去了");
    assert.equal(skip.ok, true);
    assert.equal(store.blockingStep("s"), null);
  } finally {
    cleanup();
  }
});

test("prompt 块：等待步注入交接说明 + 外部动作工具已收起", () => {
  const { store, cleanup } = makeStore();
  try {
    store.write({ sessionId: "s", actorId: "a", goal: "点外卖", steps: ["选餐厅", "下单"] });
    store.setStatus("s", "s1", "awaiting_confirm", undefined, {
      handoff: { instruction: "在美团点一份麻辣烫", checkMode: "user_confirm" },
    });
    const block = store.buildPromptBlock("s");
    assert.ok(block?.includes("等你操作：在美团点一份麻辣烫"));
    assert.ok(block?.includes("外部动作类工具本轮已收起"));
    assert.ok(block?.includes("skipped"));
  } finally {
    cleanup();
  }
});

test("文字回执判定：只认明确的「已完成」短句，歧义一律不猜", () => {
  // 认
  for (const t of ["我已完成", "点好了", "付了", "买好了", "搞定了", "我已完成，继续下一步", "弄好了。"]) {
    assert.equal(isHandoffDoneReply(t), true, `应识别：${t}`);
  }
  // 不认（宁可让用户去点，也不误判完成）
  for (const t of ["", "好了", "我没完成", "还没点", "帮我查一下订单", "我完成之后再说", "点好了吗"]) {
    assert.equal(isHandoffDoneReply(t), false, `不应识别：${t}`);
  }
});

test("工具处理器：store 未装配时如实报错，装配后写入/读取闭环", async () => {
  const { TaskPlanStore, initTaskPlanStore, __setTaskPlanStoreForTest } = await import(
    "../src/agent/task-plan-store.js"
  );
  const { createTaskPlanWriteHandler, createTaskPlanReadHandler } = await import(
    "../src/tools/capability-modules/task-plan/handlers.js"
  );
  const dir = mkdtempSync(join(tmpdir(), "pa-taskplan-h-"));
  try {
    __setTaskPlanStoreForTest(undefined);
    const notReady = await createTaskPlanWriteHandler()(
      { goal: "x", steps: ["y"] },
      { sessionId: "s", userId: "u1" } as never,
    );
    assert.equal((notReady as { ok: boolean }).ok, false);

    initTaskPlanStore({ dataPath: dir, log: () => {} });
    const written = await createTaskPlanWriteHandler()(
      { goal: "订三亚行程", steps: ["确认日期", "比价机票"] },
      { sessionId: "s", userId: "u1" } as never,
    );
    assert.equal((written as { ok: boolean }).ok, true);

    const read = await createTaskPlanReadHandler()({}, { sessionId: "s", userId: "u1" } as never);
    const payload = read as { ok: boolean; hasPlan: boolean; steps: Array<{ id: string }> };
    assert.equal(payload.hasPlan, true);
    assert.equal(payload.steps.length, 2);
  } finally {
    __setTaskPlanStoreForTest(undefined);
    rmSync(dir, { recursive: true, force: true });
    void TaskPlanStore;
  }
});
