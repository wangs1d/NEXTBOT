import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ScheduleTaskService, type ScheduleTaskChangeAction } from "../src/services/schedule-task-service.js";

async function withTempScheduleFile<T>(fn: (service: ScheduleTaskService, filePath: string) => Promise<T>) {
  const dir = await mkdtemp(join(tmpdir(), "schedule-task-service-"));
  const prev = process.env.SCHEDULE_TASKS_FILE;
  const filePath = join(dir, "schedule-tasks.json");
  process.env.SCHEDULE_TASKS_FILE = filePath;
  try {
    const service = new ScheduleTaskService();
    return await fn(service, filePath);
  } finally {
    if (prev == null) {
      delete process.env.SCHEDULE_TASKS_FILE;
    } else {
      process.env.SCHEDULE_TASKS_FILE = prev;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

test("preserves absolute runAt values that already include timezone info", async () => {
  await withTempScheduleFile(async (service) => {
    const runAt = new Date(Date.now() + 10 * 60_000).toISOString();
    const task = await service.createTask({
      sessionId: "session-1",
      title: "absolute time reminder",
      description: "absolute time reminder",
      kind: "reminder",
      runAt,
      recurrence: "none",
      timezone: "Asia/Shanghai",
      reminderMessage: "absolute time reminder",
    });

    assert.equal(task.runAt, runAt);
    assert.equal(task.nextRunAt, runAt);
  });
});

test("parses local naive runAt in the provided timezone without shifting earlier", async () => {
  await withTempScheduleFile(async (service) => {
    const task = await service.createTask({
      sessionId: "session-local",
      title: "local reminder",
      description: "local reminder",
      kind: "reminder",
      runAt: "2099-01-01T08:30:00",
      recurrence: "none",
      timezone: "Asia/Shanghai",
      reminderMessage: "local reminder",
    });

    assert.equal(task.runAt, "2099-01-01T00:30:00.000Z");
  });
});

test("creates cron task and computes next run", async () => {
  await withTempScheduleFile(async (service) => {
    const task = await service.createTask({
      sessionId: "session-cron",
      title: "cron reminder",
      description: "cron reminder",
      kind: "reminder",
      recurrence: "cron",
      cronExpression: "*/5 * * * *",
      timezone: "Asia/Shanghai",
      reminderMessage: "cron reminder",
    });

    assert.equal(task.recurrence, "cron");
    assert.equal(task.cronExpression, "*/5 * * * *");
    assert.ok(task.nextRunAt);
  });
});

test("triggers webhook task by token", async () => {
  await withTempScheduleFile(async (service) => {
    let fired = 0;
    service.setReminderHandler(async () => {
      fired += 1;
    });
    const task = await service.createTask({
      sessionId: "session-webhook",
      title: "webhook reminder",
      description: "webhook reminder",
      kind: "reminder",
      runAt: "2099-01-01T08:30:00",
      recurrence: "none",
      timezone: "Asia/Shanghai",
      webhookToken: "hook-1",
      reminderMessage: "webhook reminder",
    });

    const triggered = await service.triggerByWebhookToken("hook-1");
    assert.equal(triggered.taskId, task.taskId);
    assert.equal(fired, 1);
  });
});

test("emits task change events for create update and delete", async () => {
  await withTempScheduleFile(async (service) => {
    const actions: ScheduleTaskChangeAction[] = [];
    service.setTaskChangeHandler(async (action) => {
      actions.push(action);
    });

    const task = await service.createTask({
      sessionId: "session-2",
      title: "change handler reminder",
      description: "change handler reminder",
      kind: "reminder",
      runAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      recurrence: "none",
      timezone: "Asia/Shanghai",
      reminderMessage: "change handler reminder",
    });

    await service.updateTask(task.taskId, { title: "updated title" });
    await service.deleteTask(task.taskId);

    assert.deepEqual(actions, ["created", "updated", "deleted"]);
  });
});

/** 2026-10-21 文案契约闸：模型直填的回声文案（原句/半截原句）落库前重推导。 */
test("normalizes echoed reminder copy at the write gate", async () => {
  await withTempScheduleFile(async (service) => {
    const task = await service.createTask({
      sessionId: "session-echo",
      description: "一分钟后的11点03分提醒我吃饭",
      kind: "reminder",
      runAt: "2099-01-01T11:03:00",
      recurrence: "none",
      timezone: "Asia/Shanghai",
      shortTitle: "的11点03分提醒我吃饭",
      reminderMessage: "的11点03分提醒我吃饭",
    });
    assert.equal(task.shortTitle, "吃饭");
    assert.equal(task.reminderMessage, "该吃饭啦");

    // 干净的裸事项词不是回声：原样放行（闸口只拦回声，不做风格改写）
    const bare = await service.createTask({
      sessionId: "session-bare",
      description: "明天早上9点提醒我开会",
      kind: "reminder",
      runAt: "2099-01-01T09:00:00",
      recurrence: "none",
      timezone: "Asia/Shanghai",
      reminderMessage: "开会",
    });
    assert.equal(bare.reminderMessage, "开会");
  });
});

test("keeps clean friendly copy and non-manual source copy untouched", async () => {
  await withTempScheduleFile(async (service) => {
    const task = await service.createTask({
      sessionId: "session-clean",
      description: "记得提醒我3点吃药",
      kind: "reminder",
      runAt: "2099-01-01T15:00:00",
      recurrence: "none",
      timezone: "Asia/Shanghai",
      shortTitle: "吃药",
      reminderMessage: "该吃药啦",
    });
    assert.equal(task.shortTitle, "吃药");
    assert.equal(task.reminderMessage, "该吃药啦");

    // 承诺/ics 等非手动来源有各自的确定性文案生成器，闸口不得改写
    const commitmentMessage = "承诺到期：Agent 承诺于2026年10月23日下午3点提醒用户交周报";
    const commitment = await service.createTask({
      sessionId: "session-commitment",
      description: "交周报",
      kind: "reminder",
      runAt: "2099-01-01T15:00:00",
      recurrence: "none",
      timezone: "Asia/Shanghai",
      reminderMessage: commitmentMessage,
      source: "commitment",
    });
    assert.equal(commitment.reminderMessage, commitmentMessage);
  });
});
