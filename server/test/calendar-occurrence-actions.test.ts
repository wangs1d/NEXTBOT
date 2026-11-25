// calendar 工具实例层 action：skip_occurrence / reschedule_occurrence。
// 2026-11-25：模型要能处理「这周三不去」「明天那次改到下午三点」。
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ScheduleTaskService } from "../src/services/schedule-task-service.js";
import { registerCalendarTools } from "../src/tools/calendar-tools.js";
import { ToolRegistry, type ToolContext } from "../src/tools/tool-registry.js";

const ctx: ToolContext = { sessionId: "occ-session", userId: "occ-user" };

async function withRegistry<T>(fn: (registry: ToolRegistry, tasks: ScheduleTaskService) => Promise<T>) {
  const dir = await mkdtemp(join(tmpdir(), "calendar-occ-actions-"));
  const prev = process.env.SCHEDULE_TASKS_FILE;
  process.env.SCHEDULE_TASKS_FILE = join(dir, "schedule-tasks.json");
  try {
    const tasks = new ScheduleTaskService();
    const registry = new ToolRegistry();
    registerCalendarTools(registry, tasks, null as never);
    return await fn(registry, tasks);
  } finally {
    if (prev == null) delete process.env.SCHEDULE_TASKS_FILE;
    else process.env.SCHEDULE_TASKS_FILE = prev;
    await rm(dir, { recursive: true, force: true });
  }
}

/** 明天本地 09:00 的 ISO。 */
function tomorrowAt9(): string {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 9, 0, 0).toISOString();
}

test("skip_occurrence：跳过下一次，回执给新的 nextRunAt", async () => {
  await withRegistry(async (registry, tasks) => {
    await registry.execute(
      "calendar",
      {
        action: "create",
        description: "去游泳",
        shortTitle: "游泳",
        reminderMessage: "该游泳啦",
        recurrence: "daily",
        runAt: tomorrowAt9().slice(0, 19),
        timezone: "Asia/Shanghai",
      },
      ctx,
    );
    const task = tasks.listAllTasks()[0]!;
    const first = task.nextRunAt!;

    const result = await registry.execute(
      "calendar",
      { action: "skip_occurrence", taskId: task.taskId, occurrenceAt: first },
      ctx,
    );
    assert.equal(result.result.ok, true);
    assert.equal(result.result.action, "skip_occurrence");
    assert.notEqual(result.result.nextRunAt, first);
    assert.ok(String(result.result.nextRunAt) > first);
    assert.deepEqual(tasks.getTask(task.taskId)?.excludedOccurrences, [first]);
  });
});

test("reschedule_occurrence：只挪一次，其余不变", async () => {
  await withRegistry(async (registry, tasks) => {
    await registry.execute(
      "calendar",
      {
        action: "create",
        description: "去游泳",
        shortTitle: "游泳",
        reminderMessage: "该游泳啦",
        recurrence: "daily",
        runAt: tomorrowAt9().slice(0, 19),
        timezone: "Asia/Shanghai",
      },
      ctx,
    );
    const task = tasks.listAllTasks()[0]!;
    const first = task.nextRunAt!;
    const target = new Date(new Date(first).getTime() + 3 * 3600_000).toISOString();

    const result = await registry.execute(
      "calendar",
      {
        action: "reschedule_occurrence",
        taskId: task.taskId,
        occurrenceAt: first,
        at: target,
      },
      ctx,
    );
    assert.equal(result.result.ok, true);
    assert.equal(result.result.nextRunAt, target);
    assert.equal(tasks.getTask(task.taskId)?.occurrenceOverrides?.length, 1);
  });
});

test("非法 occurrenceAt：明确报错，不写脏数据", async () => {
  await withRegistry(async (registry, tasks) => {
    await registry.execute(
      "calendar",
      {
        action: "create",
        description: "去游泳",
        shortTitle: "游泳",
        reminderMessage: "该游泳啦",
        recurrence: "daily",
        runAt: tomorrowAt9().slice(0, 19),
        timezone: "Asia/Shanghai",
      },
      ctx,
    );
    const task = tasks.listAllTasks()[0]!;
    const bogus = new Date(new Date(task.nextRunAt!).getTime() + 37 * 60_000).toISOString();
    const result = await registry.execute(
      "calendar",
      { action: "skip_occurrence", taskId: task.taskId, occurrenceAt: bogus },
      ctx,
    );
    assert.equal(result.result.ok, false);
    assert.match(String(result.result.error), /not an occurrence/);
    assert.equal(tasks.getTask(task.taskId)?.excludedOccurrences, undefined);
  });
});
