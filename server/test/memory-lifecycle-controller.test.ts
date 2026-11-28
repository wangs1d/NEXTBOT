import assert from "node:assert/strict";
import Database from "better-sqlite3";
import test from "node:test";

import {
  MemoryLifecycleService,
  planMemoryLifecycle,
  registerMemoryLifecycleExecutor,
  type MemoryLifecycleExecutor,
} from "../src/agentic-memory/memory-lifecycle-controller.js";
import { MemoryLifecycleOpStore } from "../src/agentic-memory/memory-lifecycle-ops.js";
import { createMemoryRecord } from "../src/agentic-memory/memory-record.js";

function withStore(fn: (store: MemoryLifecycleOpStore, db: Database.Database) => Promise<void>): Promise<void> {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  const store = new MemoryLifecycleOpStore(db);
  return fn(store, db).finally(() => store.close());
}

test("生命周期规划：四类意图输出标准动作，顺序稳定", async () => {
  const record = createMemoryRecord({ actorId: "a", sourceRef: "event:1", text: "用户事实", sourceRole: "user" });
  const upsert = planMemoryLifecycle({
    actorId: "a",
    intent: "upsert",
    target: { kind: "record", record, text: "用户事实", source: "event:1" },
  });
  assert.deepEqual(upsert.actions.map((a) => a.id), ["upsert:narrative"]);

  const forget = planMemoryLifecycle({
    actorId: "a",
    intent: "forget",
    target: { kind: "keyword", key: " 体检报告 " },
  });
  assert.deepEqual(forget.actions.map((a) => a.id), [
    "forget:facts",
    "forget:understandings",
    "forget:graph",
    "forget:vector",
    "forget:bridge",
    "forget:suppression",
    "invalidate:inventory",
  ]);
  assert.equal(forget.actions[0]!.payload.keyword, "体检报告");
  assert.equal(forget.actions[5]!.payload.keyword, "体检报告");

  assert.equal(planMemoryLifecycle({
    actorId: "a",
    intent: "suppress",
    target: { kind: "text", key: "体检报告" },
  }).actions[0]!.store, "suppression");

  assert.equal(planMemoryLifecycle({
    actorId: "a",
    intent: "forget",
    target: { kind: "source_ref", sourceRef: "event:1" },
  }).actions[0]!.store, "provenance");
});

test("生命周期执行：opId 幂等，已完成动作重放不重复", async () => {
  await withStore(async (store) => {
    const calls: string[] = [];
    const executor: MemoryLifecycleExecutor = async (action) => {
      calls.push(action.id);
      return { ok: true };
    };
    const service = new MemoryLifecycleService(store, executor);
    const input = {
      opId: "op-1",
      actorId: "a",
      intent: "forget" as const,
      target: { kind: "keyword" as const, key: "体检报告" },
    };
    await service.execute(input);
    await service.execute(input);
    assert.equal(calls.length, 7);
    assert.equal(store.get("op-1")!.status, "completed");
    assert.deepEqual(store.completedActionIds("op-1"), new Set(calls));
  });
});

test("生命周期执行：自动 opId 写入请求快照，重放不换号", async () => {
  await withStore(async (store) => {
    const service = new MemoryLifecycleService(store, async () => ({ ok: true }));
    const result = await service.execute({
      actorId: "a",
      intent: "forget",
      target: { kind: "field", key: "city" },
    });
    const request = store.get(result.opId)!.request as { opId?: string };
    assert.equal(request.opId, result.opId);
    await service.replay(result.opId);
    assert.equal(store.get(result.opId)!.status, "completed");
  });
});

test("生命周期执行：同 opId 并发调用串行且只执行一次", async () => {
  await withStore(async (store) => {
    let calls = 0;
    const service = new MemoryLifecycleService(store, async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { ok: true };
    });
    const input = {
      opId: "op-concurrent",
      actorId: "a",
      intent: "forget" as const,
      target: { kind: "keyword" as const, key: "体检报告" },
    };
    const [first, second] = await Promise.all([
      service.execute(input),
      service.execute(input),
    ]);
    assert.equal(calls, 7);
    assert.deepEqual(first.actions, second.actions);
    assert.equal(store.get(input.opId)!.status, "completed");
  });
});

test("生命周期执行：同 opId 不得改写已入队请求", async () => {
  await withStore(async (store) => {
    let calls = 0;
    const service = new MemoryLifecycleService(store, async () => {
      calls += 1;
      return { ok: true };
    });
    await service.execute({
      opId: "op-fixed",
      actorId: "a",
      intent: "forget",
      target: { kind: "field", key: "city" },
    });
    await assert.rejects(service.execute({
      opId: "op-fixed",
      actorId: "a",
      intent: "forget",
      target: { kind: "field", key: "job" },
    }), /不同请求/);
    assert.equal(calls, 1);
    assert.equal(store.get("op-fixed")!.status, "completed");
  });
});

test("生命周期执行：单次覆盖执行器优先生效", async () => {
  await withStore(async (store) => {
    const calls: string[] = [];
    const service = new MemoryLifecycleService(store, async () => {
      calls.push("default");
    });
    await service.execute({
      opId: "op-override",
      actorId: "a",
      intent: "forget",
      target: { kind: "field", key: "city" },
    }, async () => {
      calls.push("override");
      return { ok: true };
    });
    assert.deepEqual(calls, ["override"]);
  });
});

test("生命周期执行：注册执行器承接叙事 upsert", async () => {
  await withStore(async (store) => {
    const calls: string[] = [];
    registerMemoryLifecycleExecutor("upsert:narrative", async (action, plan) => {
      calls.push(`${plan.actorId}:${action.id}`);
      return { persisted: true };
    });
    const service = new MemoryLifecycleService(store);
    const record = createMemoryRecord({ actorId: "a", sourceRef: "event:1", text: "用户事实", sourceRole: "user" });
    const result = await service.execute({
      opId: "op-upsert",
      actorId: "a",
      intent: "upsert",
      target: { kind: "record", record, text: "用户事实", source: "event:1" },
    });
    assert.deepEqual(calls, ["a:upsert:narrative"]);
    assert.deepEqual(result.actions["upsert:narrative"], { persisted: true });
  });
});

test("生命周期执行：失败停在当前动作，重放只补未完成动作", async () => {
  await withStore(async (store) => {
    const calls: string[] = [];
    let fail = true;
    const executor: MemoryLifecycleExecutor = async (action) => {
      calls.push(action.id);
      if (action.id === "forget:graph" && fail) throw new Error("graph down");
      return { ok: true };
    };
    const service = new MemoryLifecycleService(store, executor);
    const input = {
      opId: "op-2",
      actorId: "a",
      intent: "forget" as const,
      target: { kind: "keyword" as const, key: "体检报告" },
    };
    await assert.rejects(service.execute(input), /graph down/);
    assert.equal(store.get("op-2")!.status, "failed");
    assert.deepEqual(calls, ["forget:facts", "forget:understandings", "forget:graph"]);

    fail = false;
    calls.length = 0;
    await service.replay("op-2");
    assert.deepEqual(calls, [
      "forget:graph",
      "forget:vector",
      "forget:bridge",
      "forget:suppression",
      "invalidate:inventory",
    ]);
    assert.equal(store.get("op-2")!.status, "completed");
  });
});
