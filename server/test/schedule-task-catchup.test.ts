/**
 * 定时任务迟跑（missed）回归测试：
 *  1. 迟到超阈（>5min，模拟 runtime 离线跨过触发点）不执行：记 status=missed
 *     的 run、单次任务收口 completed、周期任务推进到未来槽位、通知恰好一次。
 *  2. 准点（lag < 5min）正常执行，不带任何迟到/补发语义。
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ScheduleTaskService,
  type ScheduleTaskRecord,
} from "../src/services/schedule-task-service.js";

async function withTempScheduleFile<T>(
  fn: (service: ScheduleTaskService) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "schedule-task-catchup-"));
  const prev = process.env.SCHEDULE_TASKS_FILE;
  process.env.SCHEDULE_TASKS_FILE = join(dir, "schedule-tasks.json");
  try {
    return await fn(new ScheduleTaskService());
  } finally {
    if (prev == null) delete process.env.SCHEDULE_TASKS_FILE;
    else process.env.SCHEDULE_TASKS_FILE = prev;
    await rm(dir, { recursive: true, force: true });
  }
}

/** 直接改内存里的 nextRunAt（parseRunAt 拒绝过去时间，只能创建后回拨）模拟离线跨点。 */
function backdateNextRunAt(service: ScheduleTaskService, taskId: string, toMs: number): void {
  const store = (
    service as unknown as { byTaskId: Map<string, ScheduleTaskRecord> }
  ).byTaskId;
  const task = store.get(taskId);
  assert.ok(task, "task should exist in memory store");
  task.nextRunAt = new Date(toMs).toISOString();
}

async function waitFor<T>(probe: () => T | undefined, timeoutMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = probe();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("waitFor timeout");
}

test("迟到超阈：reminder 不执行、记 missed、单次任务收口、通知恰好一次", async () => {
  await withTempScheduleFile(async (service) => {
    let handlerFired = 0;
    let missedNotifications = 0;
    service.setReminderHandler(async () => {
      handlerFired += 1;
    });
    service.setTaskMissedHandler((_task, plannedAt) => {
      missedNotifications += 1;
      assert.ok(plannedAt, "missed 通知应携带原定时间");
    });
    const task = await service.createTask({
      sessionId: "catchup-stale",
      title: "过期提醒",
      description: "过期提醒",
      kind: "reminder",
      runAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      recurrence: "none",
      timezone: "Asia/Shanghai",
      reminderMessage: "早就过期的提醒",
    });
    // 模拟 runtime 离线 30 分钟后重启
    backdateNextRunAt(service, task.taskId, Date.now() - 30 * 60_000);

    await service.runSchedulerTick();
    await waitFor(() => service.listRuns(task.taskId)[0]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(handlerFired, 0, "迟到超阈不得执行提醒");
    assert.equal(missedNotifications, 1, "missed 通知应恰好一次");
    const run = service.listRuns(task.taskId)[0];
    assert.equal(run?.status, "missed");
    assert.equal(service.getTask(task.taskId)?.status, "completed");
    assert.equal(service.getTask(task.taskId)?.nextRunAt, null);
  });
});

test("迟到超阈：agent_task 不执行、不注入任何补发语境", async () => {
  await withTempScheduleFile(async (service) => {
    let handlerFired = 0;
    service.setAgentTaskHandler(async () => {
      handlerFired += 1;
      return { type: "agent_task", ok: true };
    });
    const task = await service.createTask({
      sessionId: "catchup-agent",
      title: "科技早报",
      description: "科技早报",
      kind: "agent_task",
      runAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      recurrence: "none",
      timezone: "Asia/Shanghai",
      agentTask: { prompt: "给我一份科技早报" },
    });
    backdateNextRunAt(service, task.taskId, Date.now() - 45 * 60_000);

    await service.runSchedulerTick();
    await waitFor(() => service.listRuns(task.taskId)[0]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(handlerFired, 0, "迟到超阈不得执行 agent_task");
    assert.equal(service.listRuns(task.taskId)[0]?.status, "missed");
  });
});

test("准点触发（lag<5min）正常执行，无迟到语义", async () => {
  await withTempScheduleFile(async (service) => {
    const delivered: string[] = [];
    service.setReminderHandler(async (_task, message) => {
      delivered.push(message);
    });
    const task = await service.createTask({
      sessionId: "catchup-ontime",
      title: "喝水提醒",
      description: "喝水提醒",
      kind: "reminder",
      runAt: new Date(Date.now() + 10_000).toISOString(),
      recurrence: "none",
      timezone: "Asia/Shanghai",
      reminderMessage: "该喝水了",
    });
    backdateNextRunAt(service, task.taskId, Date.now() - 1_000);

    await service.runSchedulerTick();
    const message = await waitFor(() => delivered[0]);
    assert.equal(message, "该喝水了", `准点触发应原样送达，实际：${message}`);
    const run = await waitFor(() => service.listRuns(task.taskId)[0]);
    assert.equal(run.status, "success");
    assert.equal(service.getTask(task.taskId)?.status, "completed");
  });
});

test("迟到超阈：周期任务推进到未来槽位且只记一次 missed", async () => {
  await withTempScheduleFile(async (service) => {
    let missedNotifications = 0;
    service.setReminderHandler(async () => {});
    service.setTaskMissedHandler(() => {
      missedNotifications += 1;
    });
    // 每日 08:00（Asia/Shanghai）的任务，nextRunAt 已是 25 小时前的一个旧槽位
    const task = await service.createTask({
      sessionId: "catchup-daily",
      title: "每日早报",
      description: "每日早报",
      kind: "reminder",
      runAt: "2099-01-01T08:00:00",
      recurrence: "daily",
      timezone: "Asia/Shanghai",
      reminderMessage: "早报到",
    });
    backdateNextRunAt(service, task.taskId, Date.now() - 25 * 3_600_000);

    await service.runSchedulerTick();
    await waitFor(() => service.listRuns(task.taskId)[0]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(missedNotifications, 1, "连环陈旧槽位只应通知一次");
    const missedRuns = service.listRuns(task.taskId).filter((r) => r.status === "missed");
    assert.equal(missedRuns.length, 1, "连环陈旧槽位只应记一次 missed");
    const after = service.getTask(task.taskId);
    assert.equal(after?.status, "active", "周期任务迟跑收口后仍应继续调度");
    const nextMs = new Date(after?.nextRunAt ?? "").getTime();
    assert.ok(Number.isFinite(nextMs) && nextMs > Date.now(), "nextRunAt 应推进到未来");
  });
});
