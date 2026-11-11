/**
 * calendar.batch_create 批量创建工具：
 *   多条一次创建 / 坏条目不拖垮整批 / 冲突跳过回传详情 / 幂等（同批重发同 taskId）。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ScheduleConflictService } from "../src/services/schedule-conflict-service.js";
import { ScheduleTaskService } from "../src/services/schedule-task-service.js";
import { registerCalendarTools } from "../src/tools/calendar-tools.js";
import { ToolRegistry, type ToolContext } from "../src/tools/tool-registry.js";

const ctx: ToolContext = { sessionId: "batch-session", userId: "batch-user" };

async function withRegistry<T>(fn: (registry: ToolRegistry, tasks: ScheduleTaskService) => Promise<T>) {
  const dir = await mkdtemp(join(tmpdir(), "calendar-batch-"));
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

test("batch_create：多条一次创建，坏条目单独报错不拖垮整批", async () => {
  await withRegistry(async (registry, tasks) => {
    const result = await registry.execute(
      "calendar", {
      action: "batch_create",
      timezone: "Asia/Shanghai",
        items: [
          { description: "高数 课上", runAt: "2099-03-02T01:00:00Z", durationMinutes: 90 },
          { description: "英语 课上", runAt: "2099-03-02T04:00:00Z" },
          { description: "缺时间的条目", runAt: "" },
        ],
      },
      ctx,
    );
    assert.equal(result.result.ok, false); // 有失败条目（业务层 ok；外层 ok 仅代表工具执行成功）
    assert.equal(result.result.created, 2);
    assert.equal(result.result.failed, 1);
    const okRows = (result.result.results as Array<Record<string, unknown>>).filter((r) => r.ok);
    assert.equal(okRows.length, 2);
    assert.ok((okRows[0] as { taskId: string }).taskId);
    // 每条都真实落了日程，category 缺省 itinerary
    const created = tasks.listAllTasks().filter((t) => t.source !== "commitment" && t.source !== "ics");
    assert.equal(created.length, 2);
    assert.ok(created.every((t) => t.category === "itinerary"));
  });
});

test("batch_create：冲突条目跳过并回传冲突详情（不强制）", async () => {
  await withRegistry(async (registry) => {
    // 先占住 10:00-11:30
    await registry.execute(
      "calendar",
      { action: "create", description: "项目评审", runAt: "2099-03-05T10:00:00", timezone: "Asia/Shanghai", durationMinutes: 90 },
      ctx,
    );
    const result = await registry.execute(
      "calendar",
      {
        action: "batch_create",
        timezone: "Asia/Shanghai",
        items: [
          { description: "撞车会议", runAt: "2099-03-05T10:30:00", durationMinutes: 60 },
          { description: "不撞车的", runAt: "2099-03-05T14:00:00" },
        ],
      },
      ctx,
    );
    assert.equal(result.result.created, 1);
    assert.equal(result.result.skipped, 1);
    const skippedRow = (result.result.results as Array<Record<string, unknown>>).find((r) => r.skipped);
    assert.ok(skippedRow, "跳过条目应带冲突详情");
  });
});

test("batch_create：同批重发幂等（同 taskId，不重复建）", async () => {
  await withRegistry(async (registry, tasks) => {
    const items = [
      { description: "每周组会", runAt: "2099-03-09T02:00:00Z", recurrence: "weekly" },
      { description: "周报截止", runAt: "2099-03-13T10:00:00Z" },
    ];
    const first = await registry.execute("calendar", { action: "batch_create", items }, ctx);
    const second = await registry.execute("calendar", { action: "batch_create", items }, ctx);
    const ids1 = (first.result.results as Array<{ taskId?: string }>).map((r) => r.taskId);
    const ids2 = (second.result.results as Array<{ taskId?: string }>).map((r) => r.taskId);
    assert.deepEqual(ids2, ids1, "重复创建应返回已有 taskId");
    assert.equal(tasks.listAllTasks().length, 2, "不产生重复任务");
  });
});

test("batch_create：空 items 拒绝；超 60 条拒绝", async () => {
  await withRegistry(async (registry) => {
    const empty = await registry.execute("calendar", { action: "batch_create", items: [] }, ctx);
    assert.equal(empty.result.ok, false);
    const tooMany = await registry.execute(
      "calendar",
      { action: "batch_create", items: Array.from({ length: 61 }, (_, i) => ({ description: `t${i}`, runAt: "2099-03-02T01:00:00Z" })) },
      ctx,
    );
    assert.equal(tooMany.result.ok, false);
  });
});
