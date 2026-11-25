// 实例层（P2）：跳过某一次 / 单次改期。
// 2026-11-25：之前只有「整条规则」，用户说「这周三不去」只能删整个提醒。
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ScheduleTaskService } from "../src/services/schedule-task-service.js";

const TZ = "Asia/Shanghai";
/** 本地 2026-05-20 09:00（周三）。 */
const NOW = new Date("2026-05-20T01:00:00.000Z");

async function withService<T>(fn: (service: ScheduleTaskService) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "schedule-occurrence-"));
  const service = new ScheduleTaskService({
    now: () => NOW,
    persistPath: join(dir, "schedule-tasks.json"),
  });
  try {
    return await fn(service);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function createDaily(service: ScheduleTaskService) {
  // 本地 05-21（周四）09:00 起，每天一次
  return service.createTask({
    sessionId: "s-occ",
    description: "去游泳",
    shortTitle: "游泳",
    kind: "reminder",
    reminderMessage: "该游泳啦",
    runAt: "2026-05-21T09:00:00",
    recurrence: "daily",
    timezone: TZ,
  });
}

test("跳过某一次：nextRunAt 立即推进，展开里也不再出现", async () => {
  await withService(async (service) => {
    const task = await createDaily(service);
    const nextIso = task.nextRunAt!;
    assert.equal(nextIso, "2026-05-21T01:00:00.000Z");

    const updated = await service.skipOccurrence(task.taskId, nextIso);
    assert.deepEqual(updated.excludedOccurrences, ["2026-05-21T01:00:00.000Z"]);
    // 下一次被跳过 → 直接推到后天
    assert.equal(updated.nextRunAt, "2026-05-22T01:00:00.000Z");

    const from = new Date("2026-05-20T16:00:00.000Z");
    const to = new Date(from.getTime() + 5 * 86_400_000);
    const views = service.listTaskViewsBySession("s-occ", {
      from: from.toISOString(),
      to: to.toISOString(),
    });
    const times = views[0]!.occurrences;
    assert.equal(times.includes("2026-05-21T01:00:00.000Z"), false);
    assert.equal(times.includes("2026-05-22T01:00:00.000Z"), true);
  });
});

test("单次改期：只挪那一次，其余实例不变", async () => {
  await withService(async (service) => {
    const task = await createDaily(service);
    const nextIso = task.nextRunAt!;
    const moved = await service.rescheduleOccurrence(
      task.taskId,
      nextIso,
      "2026-05-21T03:00:00.000Z", // 本地 11:00
    );
    assert.equal(moved.nextRunAt, "2026-05-21T03:00:00.000Z");
    assert.equal(moved.occurrenceOverrides?.length, 1);

    const from = new Date("2026-05-20T16:00:00.000Z");
    const to = new Date(from.getTime() + 4 * 86_400_000);
    const times = service
      .listTaskViewsBySession("s-occ", { from: from.toISOString(), to: to.toISOString() })[0]!
      .occurrences;
    assert.equal(times.includes("2026-05-21T03:00:00.000Z"), true);
    assert.equal(times.includes("2026-05-21T01:00:00.000Z"), false);
    assert.equal(times.includes("2026-05-22T01:00:00.000Z"), true);
  });
});

test("不是该提醒的实例：拒绝，避免脏 exdate", async () => {
  await withService(async (service) => {
    const task = await createDaily(service);
    await assert.rejects(
      () => service.skipOccurrence(task.taskId, "2026-05-21T05:37:00.000Z"),
      /not an occurrence/,
    );
  });
});

test("单次任务没有实例可编辑，提示直接取消", async () => {
  await withService(async (service) => {
    const task = await service.createTask({
      sessionId: "s-occ",
      description: "开会",
      shortTitle: "开会",
      kind: "reminder",
      reminderMessage: "该开会啦",
      runAt: "2026-05-21T02:00:00",
      recurrence: "none",
      timezone: TZ,
    });
    await assert.rejects(
      () => service.skipOccurrence(task.taskId, "2026-05-21T02:00:00.000Z"),
      /single-shot/,
    );
  });
});

test("清空例外后恢复原规则", async () => {
  await withService(async (service) => {
    const task = await createDaily(service);
    const nextIso = task.nextRunAt!;
    await service.skipOccurrence(task.taskId, nextIso);
    const cleared = await service.clearOccurrenceExceptions(task.taskId);
    assert.equal(cleared.excludedOccurrences, undefined);
    assert.equal(cleared.nextRunAt, "2026-05-21T01:00:00.000Z");
  });
});
