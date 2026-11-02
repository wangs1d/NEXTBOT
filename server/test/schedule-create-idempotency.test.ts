/**
 * 幂等创建：设置提醒只落一条任务。
 *
 * 提醒创建的写入方是模型前台工具调用（calendar.create → createTask），
 * 叠加客户端断线重发、HTTP 直写，同一次创建
 * 意图可能从多条路径先后到达。根修：幂等收口在存储层 createTask（同会话 + 同类型 +
 * 同归一化内容 + 同时间签名 → 返回已有任务），所有路径天然只建一次；
 * 本文件从服务层与工具层两端验证。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ScheduleIntentService } from "../src/services/schedule-intent-service.js";
import { ScheduleTaskService, type ScheduleTaskChangeAction } from "../src/services/schedule-task-service.js";
import { registerCalendarTools } from "../src/tools/calendar-tools.js";
import { registerLifeTools } from "../src/tools/life-tools.js";
import { ToolRegistry, type ToolContext } from "../src/tools/tool-registry.js";

const ctx: ToolContext = { sessionId: "tool-session", userId: "tool-user" };

async function withService<T>(fn: (service: ScheduleTaskService, actions: ScheduleTaskChangeAction[]) => Promise<T>) {
  const dir = await mkdtemp(join(tmpdir(), "schedule-idempotency-"));
  const prev = process.env.SCHEDULE_TASKS_FILE;
  process.env.SCHEDULE_TASKS_FILE = join(dir, "schedule-tasks.json");
  try {
    const service = new ScheduleTaskService();
    const actions: ScheduleTaskChangeAction[] = [];
    service.setTaskChangeHandler(async (action) => {
      actions.push(action);
    });
    return await fn(service, actions);
  } finally {
    if (prev == null) delete process.env.SCHEDULE_TASKS_FILE;
    else process.env.SCHEDULE_TASKS_FILE = prev;
    await rm(dir, { recursive: true, force: true });
  }
}

function reminderInput(overrides: Partial<Parameters<ScheduleTaskService["createTask"]>[0]> = {}) {
  return {
    sessionId: "session-1",
    description: "明天开会",
    kind: "reminder" as const,
    runAt: "2099-03-05T08:00:00",
    recurrence: "none" as const,
    timezone: "Asia/Shanghai",
    reminderMessage: "明天开会",
    ...overrides,
  };
}

test("同会话同内容同时间签名：第二次 createTask 返回已有任务，不重复落库不重复广播", async () => {
  await withService(async (service, actions) => {
    const first = await service.createTask(reminderInput());
    const second = await service.createTask(reminderInput());

    assert.equal(second.taskId, first.taskId);
    assert.equal(service.listAllTasks().filter((t) => t.kind === "reminder").length, 1);
    assert.deepEqual(actions, ["created"]);
  });
});

test("内容相同但 runAt 锚点超出容差：视为两次独立创建", async () => {
  await withService(async (service) => {
    const first = await service.createTask(reminderInput());
    const second = await service.createTask(reminderInput({ runAt: "2099-03-05T09:00:00" }));

    assert.notEqual(second.taskId, first.taskId);
    assert.equal(service.listAllTasks().length, 2);
  });
});

test("重复判定按会话隔离：不同会话同内容同时间各自创建", async () => {
  await withService(async (service) => {
    const first = await service.createTask(reminderInput());
    const second = await service.createTask(reminderInput({ sessionId: "session-2" }));

    assert.notEqual(second.taskId, first.taskId);
    assert.equal(service.listAllTasks().length, 2);
  });
});

test("内容不同（描述或提醒语）不算重复", async () => {
  await withService(async (service) => {
    await service.createTask(reminderInput());
    const other = await service.createTask(reminderInput({ description: "明天交周报", reminderMessage: "明天交周报" }));

    assert.notEqual(other.description, "明天开会");
    assert.equal(service.listAllTasks().length, 2);
  });
});

test("同一事项不同表述：规则路径带时间的原句 vs 工具路径干净事项，只落一条提醒", async () => {
  await withService(async (service) => {
    // 实证 2026-11-01：同一句「6点提醒我去游泳」先经 calendar.create 落库原句
    // （description=今天18:00提醒我去游泳），23 秒后又经 calendar.create
    // 落库干净事项（description=去游泳）——两条 18:00 到点提醒。
    const first = await service.createTask({
      sessionId: "session-1",
      description: "今天18:00提醒我去游泳",
      kind: "reminder",
      runAt: "2099-03-05T10:00:00",
      recurrence: "none",
      timezone: "Asia/Shanghai",
      reminderMessage: "到点了，快去游泳吧",
    });
    const second = await service.createTask({
      sessionId: "session-1",
      description: "去游泳",
      shortTitle: "游泳",
      kind: "reminder",
      runAt: "2099-03-05T10:00:00",
      recurrence: "none",
      timezone: "Asia/Shanghai",
      reminderMessage: "该去游泳了，收拾东西出门",
    });

    assert.equal(second.taskId, first.taskId);
    assert.equal(service.listAllTasks().filter((t) => t.kind === "reminder").length, 1);

    // 同一时刻的不同事项仍是两次独立创建，不能被事项判重误吞
    const other = await service.createTask({
      sessionId: "session-1",
      description: "去健身房",
      kind: "reminder",
      runAt: "2099-03-05T10:00:00",
      recurrence: "none",
      timezone: "Asia/Shanghai",
      reminderMessage: "该去健身房了",
    });
    assert.notEqual(other.taskId, first.taskId);
  });
});

test("已结束的任务不参与判定：取消后可重设同名同刻提醒", async () => {
  await withService(async (service) => {
    const first = await service.createTask(reminderInput());
    await service.updateTask(first.taskId, { status: "cancelled" });
    const recreated = await service.createTask(reminderInput());

    assert.notEqual(recreated.taskId, first.taskId);
  });
});

test("周期任务：同重复规则同锚点判重，cron 签名按表达式比较", async () => {
  await withService(async (service) => {
    const daily = await service.createTask(
      reminderInput({ runAt: "2099-03-05T08:00:00", recurrence: "daily" }),
    );
    const dailyDup = await service.createTask(
      reminderInput({ runAt: "2099-03-05T08:00:30", recurrence: "daily" }),
    );
    assert.equal(dailyDup.taskId, daily.taskId);

    // 周期锚点差 10 分钟：保留保守语义，允许创建（用户可能确实要错峰第二条）
    const dailyShifted = await service.createTask(
      reminderInput({ runAt: "2099-03-05T08:10:00", recurrence: "daily" }),
    );
    assert.notEqual(dailyShifted.taskId, daily.taskId);

    const cron = await service.createTask(
      reminderInput({ runAt: undefined as unknown as string, recurrence: "cron", cronExpression: "0 8 * * *" }),
    );
    const cronDup = await service.createTask(
      reminderInput({ runAt: undefined as unknown as string, recurrence: "cron", cronExpression: "0 8 * * *" }),
    );
    assert.equal(cronDup.taskId, cron.taskId);

    const cronOther = await service.createTask(
      reminderInput({ runAt: undefined as unknown as string, recurrence: "cron", cronExpression: "30 8 * * *" }),
    );
    assert.notEqual(cronOther.taskId, cron.taskId);
  });
});

test("工具层端到端：模型重复调用 calendar.create 只落一条任务", async () => {
  const dir = await mkdtemp(join(tmpdir(), "schedule-idempotency-tools-"));
  const prev = process.env.SCHEDULE_TASKS_FILE;
  process.env.SCHEDULE_TASKS_FILE = join(dir, "schedule-tasks.json");
  try {
    const tasks = new ScheduleTaskService();
    const registry = new ToolRegistry();
    // 确定性解析器可脱离 LLM 构造（externalChat=null）
    const intents = new ScheduleIntentService(null);
    registerCalendarTools(registry, tasks, intents);
    registerLifeTools(registry, tasks, intents);

    // 第一击：模拟首个真实创建（如客户端先一步 HTTP 直写；与工具层同一 actorKey）
    const programCreated = await tasks.createTask({
      sessionId: "tool-user",
      description: "2点提醒我睡觉",
      kind: "reminder",
      runAt: "2099-03-05T14:00:00",
      recurrence: "none",
      timezone: "Asia/Shanghai",
      reminderMessage: "2点提醒我睡觉",
    });

    // 第二击：同一轮模型又调用了 calendar.create（同内容同时间）
    const byTool = await registry.execute(
      "calendar.create",
      { description: "2点提醒我睡觉", title: "2点提醒我睡觉", runAt: "2099-03-05T14:00:00", timezone: "Asia/Shanghai" },
      ctx,
    );
    assert.equal(byTool.ok, true);
    assert.equal(byTool.result.taskId, programCreated.taskId);

    // 第三击：客户端「服务繁忙」自动重试（新 messageId，HTTP 直写）同内容重发
    const byRetry = await tasks.createTask({
      sessionId: "tool-user",
      description: "2点提醒我睡觉",
      kind: "reminder",
      runAt: "2099-03-05T14:01:00",
      recurrence: "none",
      timezone: "Asia/Shanghai",
      reminderMessage: "2点提醒我睡觉",
    });
    assert.equal(byRetry.taskId, programCreated.taskId);

    assert.equal(tasks.listAllTasks().length, 1);
  } finally {
    if (prev == null) delete process.env.SCHEDULE_TASKS_FILE;
    else process.env.SCHEDULE_TASKS_FILE = prev;
    await rm(dir, { recursive: true, force: true });
  }
});
