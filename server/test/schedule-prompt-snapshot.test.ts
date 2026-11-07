import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ScheduleTaskService } from "../src/services/schedule-task-service.js";
import { buildSchedulePromptSnapshot } from "../src/services/schedule-prompt-snapshot.js";

async function withTempScheduleFile<T>(fn: (service: ScheduleTaskService) => Promise<T>) {
  const dir = await mkdtemp(join(tmpdir(), "schedule-prompt-snapshot-"));
  const prev = process.env.SCHEDULE_TASKS_FILE;
  const filePath = join(dir, "schedule-tasks.json");
  process.env.SCHEDULE_TASKS_FILE = filePath;
  try {
    const service = new ScheduleTaskService();
    return await fn(service);
  } finally {
    if (prev == null) {
      delete process.env.SCHEDULE_TASKS_FILE;
    } else {
      process.env.SCHEDULE_TASKS_FILE = prev;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

async function createReminder(
  service: ScheduleTaskService,
  overrides: Partial<Parameters<ScheduleTaskService["createTask"]>[0]> = {},
) {
  return service.createTask({
    sessionId: "session-1",
    title: "睡觉",
    description: "7分钟后提醒我睡觉",
    kind: "reminder",
    runAt: new Date(Date.now() + 7 * 60_000).toISOString(),
    recurrence: "none",
    timezone: "Asia/Shanghai",
    reminderMessage: "该睡觉啦",
    ...overrides,
  });
}

test("pending view: active one-shot reminder renders remaining time and local clock", async () => {
  await withTempScheduleFile(async (service) => {
    await createReminder(service);

    const snapshot = buildSchedulePromptSnapshot(service, "session-1", false);
    assert.match(snapshot, /SCH\|pending\|count=1/);
    assert.match(snapshot, /单次/);
    assert.match(snapshot, /还剩约7分钟/);
    assert.match(snapshot, /该睡觉啦/);
    // ISO 绝对时间锚保留在行首
    assert.match(snapshot, /- \d{4}-\d{2}-\d{2}T/);
    // 任务时区 HH:MM 本地时间（Asia/Shanghai）
    assert.match(snapshot, /\|单次\|\d{2}:\d{2} 还剩约7分钟\|/);
    // 引用纪律脚注：禁止复读历史对话里的相对措辞
    assert.match(snapshot, /禁止照搬历史对话里的相对说法/);
  });
});

test("pending view: reminder 45s away renders less-than-one-minute label", async () => {
  await withTempScheduleFile(async (service) => {
    await createReminder(service, { runAt: new Date(Date.now() + 45_000).toISOString() });
    const snapshot = buildSchedulePromptSnapshot(service, "session-1", false);
    assert.match(snapshot, /还剩不到1分钟/);
  });
});

test("pending view: no horizon gate — reminder 3 days out is still listed", async () => {
  await withTempScheduleFile(async (service) => {
    await createReminder(service, {
      runAt: new Date(Date.now() + 3 * 24 * 60 * 60_000).toISOString(),
    });
    const snapshot = buildSchedulePromptSnapshot(service, "session-1", false);
    assert.match(snapshot, /还剩约3天|还剩约72小时/);
    assert.match(snapshot, /SCH\|pending\|count=1/);
  });
});

test("pending view: recently fired reminder stays as a completed line with its true local time", async () => {
  await withTempScheduleFile(async (service) => {
    // 直接落盘一条已完成任务，新实例 load 后验证
    const completedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    await writeFile(
      process.env.SCHEDULE_TASKS_FILE!,
      JSON.stringify({
        tasks: [
          {
            taskId: "task-done-1",
            sessionId: "session-1",
            title: "睡觉",
            description: "两小时后（17:20）提醒我睡觉",
            kind: "reminder",
            category: "trivia",
            recurrence: "none",
            timezone: "Asia/Shanghai",
            // UTC 17:20 = 北京 01:20：历史轮曾把 UTC 钟点误说成「五点二十」，
            // 快照必须给出权威本地时间供后续轮对照
            runAt: "2026-11-06T17:20:00.000Z",
            nextRunAt: null,
            status: "completed",
            reminderMessage: "该睡觉啦",
            createdAt: completedAt,
            updatedAt: completedAt,
            lastRunAt: completedAt,
          },
        ],
        runs: [],
      }),
      "utf-8",
    );
    const reloaded = new ScheduleTaskService();
    await reloaded.load();

    // 12h 内刚响过的提醒不再从快照消失：以「已完成 + 真实本地钟点」留在末尾，
    // 让模型能顶掉历史里的错误说法（2026-11-07「五点二十」事故根治项）。
    const snapshot = buildSchedulePromptSnapshot(reloaded, "session-1", false);
    assert.match(snapshot, /SCH\|pending\|count=0/);
    assert.match(snapshot, /已完成/);
    assert.match(snapshot, /本地 01:20 已响过/);
    assert.match(snapshot, /该睡觉啦/);
    assert.match(snapshot, /以此块为准/);
  });
});

test("pending view: reminder fired >12h ago drops out entirely", async () => {
  await withTempScheduleFile(async (service) => {
    const completedAt = new Date(Date.now() - 13 * 60 * 60_000).toISOString();
    await writeFile(
      process.env.SCHEDULE_TASKS_FILE!,
      JSON.stringify({
        tasks: [
          {
            taskId: "task-done-old",
            sessionId: "session-1",
            title: "睡觉",
            description: "提醒我睡觉",
            kind: "reminder",
            recurrence: "none",
            timezone: "Asia/Shanghai",
            runAt: completedAt,
            nextRunAt: null,
            status: "completed",
            reminderMessage: "该睡觉啦",
            createdAt: completedAt,
            updatedAt: completedAt,
            lastRunAt: completedAt,
          },
        ],
        runs: [],
      }),
      "utf-8",
    );
    const reloaded = new ScheduleTaskService();
    await reloaded.load();
    assert.equal(buildSchedulePromptSnapshot(reloaded, "session-1", false), "");
  });
});

test("pending view: recurring daily task lists next occurrence", async () => {
  await withTempScheduleFile(async (service) => {
    await service.createTask({
      sessionId: "session-1",
      title: "喝水",
      description: "每天提醒喝水",
      kind: "reminder",
      // 2099 年锚点的 daily 任务，下一次实例在 2099-01-02（daily 推进）
      runAt: "2099-01-01T08:00:00",
      recurrence: "daily",
      timezone: "Asia/Shanghai",
      reminderMessage: "该喝水啦",
    });
    const snapshot = buildSchedulePromptSnapshot(service, "session-1", false);
    assert.match(snapshot, /SCH\|pending\|count=1/);
    assert.match(snapshot, /每天/);
    assert.match(snapshot, /该喝水啦/);
  });
});

test("pending view: nearest items sorted first, capped at 3", async () => {
  await withTempScheduleFile(async (service) => {
    await createReminder(service, { title: "事项一", reminderMessage: "事项一", runAt: new Date(Date.now() + 10 * 60_000).toISOString() });
    await createReminder(service, { title: "事项二", reminderMessage: "事项二", runAt: new Date(Date.now() + 20 * 60_000).toISOString() });
    await createReminder(service, { title: "事项三", reminderMessage: "事项三", runAt: new Date(Date.now() + 30 * 60_000).toISOString() });
    await createReminder(service, { title: "事项四", reminderMessage: "事项四", runAt: new Date(Date.now() + 40 * 60_000).toISOString() });

    const snapshot = buildSchedulePromptSnapshot(service, "session-1", false);
    assert.match(snapshot, /count=4\|shown=3\|more=1/);
    const lines = snapshot.split("\n").filter((l) => l.startsWith("- "));
    assert.equal(lines.length, 3);
    // 升序：最近的事项在前
    assert.match(lines[0], /事项一/);
    assert.match(lines[2], /事项三/);
    assert.doesNotMatch(snapshot, /事项四/);
  });
});

test("pending view: other session's reminders are not listed", async () => {
  await withTempScheduleFile(async (service) => {
    await createReminder(service, { sessionId: "someone-else" });
    assert.equal(buildSchedulePromptSnapshot(service, "session-1", false), "");
  });
});

test("query view (extended): 7d range lists active tasks; count=0 when empty", async () => {
  await withTempScheduleFile(async (service) => {
    // 空态：明确告诉模型「当前视野没有日程」
    assert.equal(buildSchedulePromptSnapshot(service, "session-1", true), "SCH|range=7d|count=0");

    // 未来 active 任务进入 7 天视野，行带剩余时间
    await createReminder(service, { title: "开会", reminderMessage: "该开会啦", runAt: new Date(Date.now() + 2 * 60 * 60_000).toISOString() });
    const snapshot = buildSchedulePromptSnapshot(service, "session-1", true);
    assert.match(snapshot, /SCH\|range=7d\|count=1/);
    assert.match(snapshot, /还剩约2小时/);
    assert.match(snapshot, /该开会啦/);
  });
});
