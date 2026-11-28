/**
 * 复合工具的 action 分化：calendar / geofence 都是单入口 + `action` 分流。
 *
 * 本文件只回答一个问题：工具被选中之后，action 是否精确路由到原 handler 语义？
 *   - schema 只暴露 1 个函数名 + action enum（工具面不膨胀）
 *   - 每个 action 落到原逻辑（创建/查询/改期/删除/空闲槽/批量、围栏增删查）
 *   - 缺 action / 未知 action → 可读错误 + 可选值列表（不让模型静默走错分支）
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CALENDAR_CHAT_TOOLS } from "../src/external-model/builtin-chat-tools.js";
import { ScheduleConflictService } from "../src/services/schedule-conflict-service.js";
import { ScheduleTaskService } from "../src/services/schedule-task-service.js";
import { registerCalendarTools } from "../src/tools/calendar-tools.js";
import { GEOFENCE_CHAT_TOOLS, registerGeofenceTools } from "../src/tools/geofence-tools.js";
import { ToolRegistry, type ToolContext } from "../src/tools/tool-registry.js";
import { GeofenceService } from "../src/services/geofence-service.js";

const ctx: ToolContext = { sessionId: "composite-user", userId: "composite-user" };

function actionEnumOf(tools: typeof CALENDAR_CHAT_TOOLS): string[] {
  const params = tools[0].function.parameters as {
    properties: { action: { enum: string[] } };
  };
  return params.properties.action.enum;
}

test("schema：两族各只占 1 个函数名，action enum 覆盖原全部子能力", () => {
  assert.deepEqual(CALENDAR_CHAT_TOOLS.map((t) => t.function.name), ["calendar"]);
  assert.deepEqual(actionEnumOf(CALENDAR_CHAT_TOOLS), [
    "create",
    "batch_create",
    "list_tasks",
    "delete_task",
    "update_task",
    "find_free_slots",
    "skip_occurrence",
    "reschedule_occurrence",
  ]);

  assert.deepEqual(GEOFENCE_CHAT_TOOLS.map((t) => t.function.name), ["geofence"]);
  assert.deepEqual(actionEnumOf(GEOFENCE_CHAT_TOOLS), ["create", "list", "delete"]);
});

async function withCalendar<T>(
  fn: (registry: ToolRegistry, tasks: ScheduleTaskService) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "composite-calendar-"));
  const prev = process.env.SCHEDULE_TASKS_FILE;
  process.env.SCHEDULE_TASKS_FILE = join(dir, "schedule-tasks.json");
  try {
    const tasks = new ScheduleTaskService();
    const conflicts = new ScheduleConflictService(tasks);
    const registry = new ToolRegistry();
    registerCalendarTools(registry, tasks, null as never, conflicts);
    return await fn(registry, tasks);
  } finally {
    if (prev == null) delete process.env.SCHEDULE_TASKS_FILE;
    else process.env.SCHEDULE_TASKS_FILE = prev;
    await rm(dir, { recursive: true, force: true });
  }
}

type ToolResult = { ok: boolean; result: Record<string, unknown> };

test("calendar：create → list_tasks → update_task → delete_task 各走各的分支", async () => {
  await withCalendar(async (registry) => {
    const created = (await registry.execute(
      "calendar",
      {
        action: "create",
        description: "项目评审",
        runAt: "2099-03-05T10:00:00",
        timezone: "Asia/Shanghai",
        durationMinutes: 60,
      },
      ctx,
    )) as ToolResult;
    assert.equal(created.result.ok, true);
    // 复合入口回传 action，供卡片/事件分流判定（不再是靠函数名猜）
    assert.equal(created.result.action, "create");
    const taskId = String(created.result.taskId ?? "");
    assert.ok(taskId, "create 必须返回 taskId");

    const listWindow = { action: "list_tasks", to: "2100-01-01T00:00:00.000Z" };
    const listed = (await registry.execute("calendar", listWindow, ctx)) as ToolResult;
    assert.equal(listed.result.action, "list_tasks");
    const tasksList = listed.result.tasks as Array<Record<string, unknown>>;
    assert.equal(tasksList.length, 1, "list_tasks 只读：与 create 写入的是同一份存储");
    assert.equal(tasksList[0].taskId, taskId);

    const updated = (await registry.execute(
      "calendar",
      { action: "update_task", taskId, runAt: "2099-03-06T10:00:00", timezone: "Asia/Shanghai" },
      ctx,
    )) as ToolResult;
    assert.equal(updated.result.action, "update_task");
    assert.equal(updated.result.ok, true);

    const deleted = (await registry.execute("calendar", { action: "delete_task", taskId }, ctx)) as ToolResult;
    assert.equal(deleted.result.action, "delete_task");
    assert.equal(deleted.result.ok, true);

    const after = (await registry.execute("calendar", listWindow, ctx)) as ToolResult;
    assert.equal((after.result.tasks as unknown[]).length, 0);
  });
});

test("calendar：batch_create / find_free_slots 分流不串台", async () => {
  await withCalendar(async (registry) => {
    const batch = (await registry.execute(
      "calendar",
      {
        action: "batch_create",
        timezone: "Asia/Shanghai",
        items: [
          { description: "高数", runAt: "2099-03-02T01:00:00" },
          { description: "英语", runAt: "2099-03-02T03:00:00" },
        ],
      },
      ctx,
    )) as ToolResult;
    assert.equal(batch.result.action, "batch_create");
    assert.equal(batch.result.created, 2);

    const free = (await registry.execute(
      "calendar",
      { action: "find_free_slots", durationMinutes: 30, timezone: "Asia/Shanghai" },
      ctx,
    )) as ToolResult;
    assert.equal(free.result.action, "find_free_slots");
    assert.ok(Array.isArray(free.result.slots), "find_free_slots 必须回 slots，而不是写入");
  });
});

test("calendar / geofence：缺 action 与未知 action 都给出可读错误", async () => {
  await withCalendar(async (registry) => {
    const missing = (await registry.execute("calendar", {}, ctx)) as ToolResult;
    assert.equal(missing.result.ok, false);
    assert.match(String(missing.result.error), /可选值/);

    const unknown = (await registry.execute("calendar", { action: "postpone" }, ctx)) as ToolResult;
    assert.equal(unknown.result.ok, false);
    assert.match(String(unknown.result.error), /postpone/);
  });

  const dir = await mkdtemp(join(tmpdir(), "composite-geofence-"));
  try {
    const geoRegistry = new ToolRegistry();
    registerGeofenceTools(geoRegistry, { service: new GeofenceService(join(dir, "geo.db")) });
    const geoMissing = (await geoRegistry.execute("geofence", {}, ctx)) as ToolResult;
    assert.equal(geoMissing.result.ok, false);
    assert.match(String(geoMissing.result.error), /create、list、delete/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
