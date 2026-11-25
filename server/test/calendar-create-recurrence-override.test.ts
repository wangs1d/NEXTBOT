// 「删掉重复确认闸、交给 agent 抉择」的落地验证（2026-11-25）：
// 自然语言分支必须尊重模型显式传入的 recurrence，否则"交给 agent"只是空话。
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ScheduleIntentService } from "../src/services/schedule-intent-service.js";
import { ScheduleTaskService } from "../src/services/schedule-task-service.js";
import { registerCalendarTools } from "../src/tools/calendar-tools.js";
import { ToolRegistry, type ToolContext } from "../src/tools/tool-registry.js";

const ctx: ToolContext = { sessionId: "agent-choice", userId: "agent-choice-user" };

async function withRegistry<T>(fn: (registry: ToolRegistry, tasks: ScheduleTaskService) => Promise<T>) {
  const dir = await mkdtemp(join(tmpdir(), "calendar-recurrence-override-"));
  const prev = process.env.SCHEDULE_TASKS_FILE;
  process.env.SCHEDULE_TASKS_FILE = join(dir, "schedule-tasks.json");
  try {
    const tasks = new ScheduleTaskService();
    const registry = new ToolRegistry();
    registerCalendarTools(registry, tasks, new ScheduleIntentService(null));
    return await fn(registry, tasks);
  } finally {
    if (prev == null) delete process.env.SCHEDULE_TASKS_FILE;
    else process.env.SCHEDULE_TASKS_FILE = prev;
    await rm(dir, { recursive: true, force: true });
  }
}

/** 明天本地 09:00（ISO，带 Z）。 */
function tomorrowAt9(): string {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 9, 0, 0).toISOString();
}

test("text 分支：模型传 recurrence 覆盖解析结果（agent 判断这是每周）", async () => {
  await withRegistry(async (registry, tasks) => {
    const result = await registry.execute(
      "calendar",
      {
        action: "create",
        text: "每天早上七点提醒我去游泳",
        recurrence: "weekly",
        timezone: "Asia/Shanghai",
      },
      ctx,
    );
    assert.equal(result.result.ok, true);
    const task = tasks.listAllTasks()[0]!;
    assert.equal(task.recurrence, "weekly");
    assert.match(task.rule ?? "", /FREQ=WEEKLY/);
  });
});

test("text 分支：模型判断只需一次 → 传 none 覆盖掉「每天」", async () => {
  await withRegistry(async (registry, tasks) => {
    await registry.execute(
      "calendar",
      {
        action: "create",
        text: "每天早上七点提醒我去游泳",
        recurrence: "none",
        timezone: "Asia/Shanghai",
      },
      ctx,
    );
    const task = tasks.listAllTasks()[0]!;
    assert.equal(task.recurrence, "none");
    assert.equal(task.rule, undefined);
  });
});

test("text 分支：模型传 cronExpression（每天除周一）", async () => {
  await withRegistry(async (registry, tasks) => {
    await registry.execute(
      "calendar",
      {
        action: "create",
        text: "每天早上七点提醒我游泳",
        recurrence: "cron",
        cronExpression: "0 7 * * 2,3,4,5,6,0",
        timezone: "Asia/Shanghai",
      },
      ctx,
    );
    const task = tasks.listAllTasks()[0]!;
    assert.equal(task.recurrence, "cron");
    assert.equal(task.cronExpression, "0 7 * * 2,3,4,5,6,0");
    assert.match(task.rule ?? "", /BYDAY=SU,TU,WE,TH,FR,SA/);
  });
});

test("没提重复、模型也不传：按单次建，不再要求确认", async () => {
  await withRegistry(async (registry, tasks) => {
    const result = await registry.execute(
      "calendar",
      { action: "create", text: `明天早上九点提醒我开会`, timezone: "Asia/Shanghai" },
      ctx,
    );
    assert.equal(result.result.ok, true);
    const task = tasks.listAllTasks()[0]!;
    assert.equal(task.recurrence, "none");
    // 顺带确认没有 needsRecurrenceConfirm 这类回执残留
    assert.equal("needsRecurrenceConfirm" in result.result, false);
  });
});
