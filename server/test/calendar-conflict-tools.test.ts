/**
 * 工具注册层端到端：calendar.create 冲突拦截 / forceCreate 放行、
 * calendar.update_task 改期、calendar.find_free_slots 空闲时段。
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

const ctx: ToolContext = { sessionId: "tool-session", userId: "tool-user" };

async function withRegistry<T>(fn: (registry: ToolRegistry, tasks: ScheduleTaskService) => Promise<T>) {
  const dir = await mkdtemp(join(tmpdir(), "calendar-conflict-tools-"));
  const prev = process.env.SCHEDULE_TASKS_FILE;
  process.env.SCHEDULE_TASKS_FILE = join(dir, "schedule-tasks.json");
  try {
    const tasks = new ScheduleTaskService();
    const conflicts = new ScheduleConflictService(tasks);
    const registry = new ToolRegistry();
    // scheduleIntentService 仅 create_from_text 需要；本文件不调用它，传 null 占位
    registerCalendarTools(registry, tasks, null as never, conflicts);
    return await fn(registry, tasks);
  } finally {
    if (prev == null) delete process.env.SCHEDULE_TASKS_FILE;
    else process.env.SCHEDULE_TASKS_FILE = prev;
    await rm(dir, { recursive: true, force: true });
  }
}

test("calendar.create: conflict blocks creation, forceCreate passes, no-duration skips check", async () => {
  await withRegistry(async (registry) => {
    const first = await registry.execute(
      "calendar", {
      action: "create",
      description: "项目评审",
        title: "项目评审",
        runAt: "2099-03-05T10:00:00",
        timezone: "Asia/Shanghai",
        durationMinutes: 90,
        category: "itinerary",
      },
      ctx,
    );
    assert.equal(first.ok, true);
    assert.equal(first.result.matched, true);

    // 与 10:00–11:30 重叠 → 拦截
    const second = await registry.execute(
      "calendar", {
      action: "create",
      description: "客户见面",
        title: "客户见面",
        runAt: "2099-03-05T10:30:00",
        timezone: "Asia/Shanghai",
        durationMinutes: 60,
        category: "itinerary",
      },
      ctx,
    );
    assert.equal(second.result.conflict, true);
    assert.equal(second.result.matched, false);
    const list = second.result.conflicts as Array<Record<string, unknown>>;
    assert.equal(list.length, 1);
    assert.equal(list[0].title, "项目评审");

    // 用户坚持 → forceCreate 放行
    const forced = await registry.execute(
      "calendar", {
      action: "create",
      description: "客户见面",
        title: "客户见面",
        runAt: "2099-03-05T10:30:00",
        timezone: "Asia/Shanghai",
        durationMinutes: 60,
        category: "itinerary",
        forceCreate: true,
      },
      ctx,
    );
    assert.equal(forced.result.matched, true);
    assert.ok(forced.result.taskId);

    // 零时长时间点提醒 → 不做冲突检测，直接创建
    const point = await registry.execute(
      "calendar", {
      action: "create",
      description: "取快递",
        title: "取快递",
        runAt: "2099-03-05T10:45:00",
        timezone: "Asia/Shanghai",
        category: "itinerary",
      },
      ctx,
    );
    assert.equal(point.result.matched, true);
  });
});

test("calendar.update_task: reschedules with conflict re-check and self-exclusion", async () => {
  await withRegistry(async (registry, tasks) => {
    const created = await registry.execute(
      "calendar", {
      action: "create",
      description: "牙医",
        title: "牙医",
        runAt: "2099-03-06T14:00:00",
        timezone: "Asia/Shanghai",
        durationMinutes: 60,
        category: "itinerary",
      },
      ctx,
    );
    const taskId = String(created.result.taskId);

    // 改到无冲突时段
    const moved = await registry.execute(
      "calendar", {
      action: "update_task",
      taskId, runAt: "2099-03-06T16:00:00", timezone: "Asia/Shanghai" },
      ctx,
    );
    assert.equal(moved.result.matched, true);
    assert.equal(moved.result.summary, "日程已更新");
    const task = tasks.getTask(taskId);
    assert.ok(task);
    assert.equal(task.runAt, "2099-03-06T08:00:00.000Z");

    // 制造冲突源后再改期 → 拦截
    await registry.execute(
      "calendar", {
      action: "create",
      description: "周会",
        title: "周会",
        runAt: "2099-03-07T10:00:00",
        timezone: "Asia/Shanghai",
        durationMinutes: 60,
        category: "itinerary",
      },
      ctx,
    );
    const blocked = await registry.execute(
      "calendar", {
      action: "update_task",
      taskId, runAt: "2099-03-07T10:30:00", timezone: "Asia/Shanghai" },
      ctx,
    );
    assert.equal(blocked.result.conflict, true);

    // 只改标题不改时间 → 不触发冲突检测（自身排除验证）
    const rename = await registry.execute(
      "calendar", {
      action: "update_task",
      taskId, title: "牙医复诊", reminderMessage: "牙医复诊" },
      ctx,
    );
    assert.equal(rename.result.matched, true);
  });
});

test("calendar.find_free_slots: returns slots around busy events", async () => {
  await withRegistry(async (registry) => {
    await registry.execute(
      "calendar", {
      action: "create",
      description: "占用",
        title: "占用",
        runAt: "2099-03-05T10:00:00",
        timezone: "Asia/Shanghai",
        durationMinutes: 120,
        category: "itinerary",
      },
      ctx,
    );
    const res = await registry.execute(
      "calendar", {
      action: "find_free_slots",
      durationMinutes: 60,
        from: "2099-03-05T00:00:00Z",
        to: "2099-03-06T00:00:00Z",
        timezone: "Asia/Shanghai",
      },
      ctx,
    );
    assert.equal(res.ok, true);
    const slots = res.result.slots as Array<Record<string, unknown>>;
    assert.ok(slots.length >= 2);
    assert.equal(slots[0].startLocal !== "", true);
    assert.equal(res.result.durationMinutes, 60);
  });
});

test("calendar tools without conflict service: create/update still work, free_slots disabled", async () => {
  const dir = await mkdtemp(join(tmpdir(), "calendar-no-conflict-"));
  const prev = process.env.SCHEDULE_TASKS_FILE;
  process.env.SCHEDULE_TASKS_FILE = join(dir, "schedule-tasks.json");
  try {
    const tasks = new ScheduleTaskService();
    const registry = new ToolRegistry();
    registerCalendarTools(registry, tasks, null as never);
    const created = await registry.execute(
      "calendar", {
      action: "create",
      description: "无冲突服务",
        title: "无冲突服务",
        runAt: "2099-03-05T10:00:00",
        timezone: "Asia/Shanghai",
        durationMinutes: 60,
      },
      ctx,
    );
    assert.equal(created.result.matched, true);
    const free = await registry.execute("calendar", { action: "find_free_slots", durationMinutes: 30 }, ctx);
    assert.equal(free.result.ok, false);
    assert.ok(String(free.result.error).includes("空闲时段查询未启用"));
  } finally {
    if (prev == null) delete process.env.SCHEDULE_TASKS_FILE;
    else process.env.SCHEDULE_TASKS_FILE = prev;
    await rm(dir, { recursive: true, force: true });
  }
});
