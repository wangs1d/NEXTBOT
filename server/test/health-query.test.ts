// Task 19 健康关怀测试：
//  1. health.query：确定性统计聚合（count/days/sum/mean/mean_daily + 备注关键词过滤 + 自定义区间）
//  2. agent.tasks.list：任务状态查询（active 过滤 + 进度字段）
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { HealthFitnessService } from "../src/services/health-fitness-service.js";
import { createHealthQueryHandler } from "../src/tools/capability-modules/health-fitness/handlers.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";
import {
  getAgentTaskStore,
  resetAgentTaskStoreForTests,
} from "../src/services/agent-task-store.js";
import { registerAgentTasksTools } from "../src/tools/agent-tasks-tools.js";

const ACTOR = "actor-health-query-test";

/** 构造 handler 直调用的最小 ToolContext（resolveActorId 只读 sessionId/userId） */
const ctx = { sessionId: ACTOR } as never;

function daysAgo(n: number, hour = 8): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  // 防未来时间戳：n=0 时固定 hour=8 会在午夜~08:00 运行时构造出"未来"记录，
  // 被 getSummary 窗口上界（now）滤掉导致 days 聚合少一天——夹到当前小时
  const safeHour = n === 0 ? Math.min(hour, new Date().getHours()) : hour;
  d.setHours(safeHour, 0, 0, 0);
  if (d.getTime() > Date.now()) d.setTime(Date.now() - 60_000);
  return d.toISOString();
}

// ── 1. health.query 统计聚合 ──────────────────────────

test("health.query：count 聚合 + 备注关键词过滤（这周跑了几次步）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "health-query-"));
  try {
    const svc = new HealthFitnessService(dir);
    await svc.load();
    // 本周内：3 条跑步 + 1 条游泳；10 天前 1 条跑步（窗口外）
    await svc.logMetric(ACTOR, "exercise_duration", 30, "min", "跑步", daysAgo(1));
    await svc.logMetric(ACTOR, "exercise_duration", 45, "min", "跑步", daysAgo(3));
    await svc.logMetric(ACTOR, "exercise_duration", 40, "min", "跑步", daysAgo(5));
    await svc.logMetric(ACTOR, "exercise_duration", 60, "min", "游泳", daysAgo(2));
    await svc.logMetric(ACTOR, "exercise_duration", 50, "min", "跑步", daysAgo(10));

    const handler = createHealthQueryHandler(svc);

    // 这周跑了几次步 → 3（关键词过滤 + 7 天窗口）
    const r1 = (await handler(
      { type: "exercise_duration", aggregate: "count", note_keyword: "跑步", period: "week" },
      ctx,
    )) as Record<string, unknown>;
    assert.equal(r1.ok, true);
    assert.equal(r1.value, 3);
    assert.equal(r1.unit, "min");
    assert.match(String(r1.summary), /跑步/);

    // 不过滤：本周全部运动记录 → 4
    const r2 = (await handler(
      { type: "exercise_duration", aggregate: "count", period: "week" },
      ctx,
    )) as Record<string, unknown>;
    assert.equal(r2.value, 4);

    // month 窗口包含 10 天前那条 → 5
    const r3 = (await handler(
      { type: "exercise_duration", aggregate: "count", note_keyword: "跑步", period: "month" },
      ctx,
    )) as Record<string, unknown>;
    assert.equal(r3.value, 4);

    // 默认 aggregate=count + period=week（不含 10 天前那条）
    const r4 = (await handler({ type: "exercise_duration" }, ctx)) as Record<string, unknown>;
    assert.equal(r4.value, 4);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("health.query：days / sum / mean / mean_daily 聚合口径", async () => {
  const dir = await mkdtemp(join(tmpdir(), "health-query-"));
  try {
    const svc = new HealthFitnessService(dir);
    await svc.load();
    // 3 个不同天：10000 / 8000+2000（同日两条）/ 6000
    await svc.logMetric(ACTOR, "steps", 10000, "steps", undefined, daysAgo(2));
    await svc.logMetric(ACTOR, "steps", 8000, "steps", undefined, daysAgo(1, 9));
    await svc.logMetric(ACTOR, "steps", 2000, "steps", undefined, daysAgo(1, 20));
    await svc.logMetric(ACTOR, "steps", 6000, "steps", undefined, daysAgo(0));

    const handler = createHealthQueryHandler(svc);
    const q = async (aggregate: string) =>
      ((await handler({ type: "steps", aggregate, period: "week" }, ctx)) as Record<string, unknown>).value;

    assert.equal(await q("days"), 3); // 3 个有记录的天
    assert.equal(await q("sum"), 26000); // 10000+8000+2000+6000
    assert.equal(await q("mean"), 6500); // 26000/4
    assert.equal(await q("mean_daily"), 8666.67); // 26000/3 天
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("health.query：custom 区间 + 无记录 + 参数校验", async () => {
  const dir = await mkdtemp(join(tmpdir(), "health-query-"));
  try {
    const svc = new HealthFitnessService(dir);
    await svc.load();
    await svc.logMetric(ACTOR, "weight", 65, "kg", undefined, daysAgo(2));
    await svc.logMetric(ACTOR, "weight", 66, "kg", undefined, daysAgo(20));

    const handler = createHealthQueryHandler(svc);

    // custom 区间只含 2 天前那条
    const r1 = (await handler(
      {
        type: "weight",
        aggregate: "count",
        period: "custom",
        from: daysAgo(3),
        to: new Date().toISOString(),
      },
      ctx,
    )) as Record<string, unknown>;
    assert.equal(r1.value, 1);

    // 无记录类型 → value 0 + 空结果 summary
    const r2 = (await handler(
      { type: "spo2", aggregate: "count", period: "week" },
      ctx,
    )) as Record<string, unknown>;
    assert.equal(r2.ok, true);
    assert.equal(r2.value, 0);
    assert.match(String(r2.summary), /没有/);

    // 缺 type
    const r3 = (await handler({}, ctx)) as Record<string, unknown>;
    assert.equal(r3.ok, false);
    // 非法 aggregate
    const r4 = (await handler(
      { type: "steps", aggregate: "median" },
      ctx,
    )) as Record<string, unknown>;
    assert.equal(r4.ok, false);
    // custom 缺 from/to
    const r5 = (await handler({ type: "steps", period: "custom" }, ctx)) as Record<string, unknown>;
    assert.equal(r5.ok, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── 2. agent.tasks.list 任务查询 ──────────────────────

test("agent.tasks.list：active 过滤 + 进度字段（我还有什么待办）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-tasks-"));
  const prevFile = process.env.AGENT_TASK_PERSIST_FILE;
  process.env.AGENT_TASK_PERSIST_FILE = join(dir, "agent-tasks.json");
  resetAgentTaskStoreForTests();
  try {
    const store = getAgentTaskStore();
    store.create({ actorId: ACTOR, sessionId: ACTOR, goal: "整理周报数据" });
    store.create({ actorId: ACTOR, sessionId: ACTOR, goal: "订下周体检" });
    const done = store.create({ actorId: ACTOR, sessionId: ACTOR, goal: "已完成的事" });
    store.update(done.id, (t) => {
      t.status = "done";
    });
    store.create({ actorId: "other-actor", sessionId: "other", goal: "别人的任务" });

    const registry = new ToolRegistry();
    registerAgentTasksTools(registry);

    // 默认 active：只含本 actor 的未完成任务
    const r1 = (await registry.execute("agent.tasks.list", {}, ctx)) as {
      ok: boolean;
      result: {
        count: number;
        total: number;
        tasks: Array<{ goal: string; statusLabel: string; progress: { subtaskTotal: number } }>;
      };
    };
    assert.equal(r1.ok, true);
    assert.equal(r1.result.count, 2);
    assert.equal(r1.result.total, 3); // 本 actor 全部（含 done）
    assert.ok(r1.result.tasks.every((t) => ["排队中", "执行中"].includes(t.statusLabel) || t.progress));

    // status=done 过滤
    const r2 = (await registry.execute("agent.tasks.list", { status: "done" }, ctx)) as {
      ok: boolean;
      result: { count: number };
    };
    assert.equal(r2.result.count, 1);

    // 非法 status
    const r3 = (await registry.execute("agent.tasks.list", { status: "running" }, ctx)) as {
      result: Record<string, unknown>;
    };
    assert.equal(r3.result.ok, false);
  } finally {
    resetAgentTaskStoreForTests();
    if (prevFile === undefined) delete process.env.AGENT_TASK_PERSIST_FILE;
    else process.env.AGENT_TASK_PERSIST_FILE = prevFile;
    await rm(dir, { recursive: true, force: true });
  }
});
