/**
 * 承诺 → 日程物化出口（commitment-schedule-outlet）：
 *   active+未来 deadline 物化 / pending 确认后才物化 / 改期反向同步 /
 *   终态撤下 / 时间闸（过去 deadline 不物化）/ 无期限不物化 / 重复 persist 幂等。
 *
 * 测试封闭：临时 SQLite + 临时 SCHEDULE_TASKS_FILE + 注入时钟。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CommitmentBoard } from "../src/agentic-memory/commitment-board.js";
import { openAgenticSqlite } from "../src/agentic-memory/sqlite-store.js";
import { createCommitmentScheduleOutlet } from "../src/services/commitment-schedule-outlet.js";
import { ScheduleTaskService } from "../src/services/schedule-task-service.js";

const BASE = "2026-09-24T08:00:00Z";

type CommitmentRecordLike = { id: string };

interface OutletCtx {
  board: CommitmentBoard;
  tasks: ScheduleTaskService;
  setNow: (iso: string) => void;
  /** 等物化出口的 fire-and-forget Promise 落地 */
  tick: () => Promise<void>;
}

async function withBoardAndTasks(fn: (ctx: OutletCtx) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "commitment-schedule-outlet-"));
  const prev = process.env.SCHEDULE_TASKS_FILE;
  process.env.SCHEDULE_TASKS_FILE = join(dir, "schedule-tasks.json");
  const db = openAgenticSqlite(join(dir, "board.db"));
  let nowMs = Date.parse(BASE);
  const now = () => new Date(nowMs);
  const board = new CommitmentBoard(db, now);
  // 时基贯通：日程服务也要用同一冻结时钟，否则「runAt 必须在未来」按真实时钟判定，
  // 真实日期越过 fixture 后所有物化静默失败（时间炸弹）。
  const tasks = new ScheduleTaskService({ now });
  board.setScheduleOutlet(createCommitmentScheduleOutlet({ tasks, now }));
  const tick = async () => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
  };
  try {
    await fn({
      board,
      tasks,
      setNow: (iso) => {
        nowMs = Date.parse(iso);
      },
      tick,
    });
  } finally {
    board.close();
    if (prev == null) delete process.env.SCHEDULE_TASKS_FILE;
    else process.env.SCHEDULE_TASKS_FILE = prev;
    await rm(dir, { recursive: true, force: true });
  }
}

test("active + 未来 deadline → 物化为 source=commitment 日程", async () => {
  await withBoardAndTasks(async ({ board, tasks, tick }) => {
    const created = board.create({
      actorId: "user1",
      text: "周五下班前交周报",
      committedBy: "user",
      deadline: "2026-09-25T10:00:00Z",
      status: "active",
    });
    assert.ok(!("error" in created));
    await tick();
    const task = tasks.findTaskBySourceRefId((created as CommitmentRecordLike).id);
    assert.ok(task, "应物化出日程");
    assert.equal(task!.source, "commitment");
    assert.equal(task!.kind, "reminder");
    assert.equal(task!.category, "itinerary");
    assert.equal(task!.runAt, "2026-09-25T10:00:00.000Z");
    assert.equal(task!.sessionId, "user1");
    assert.ok(task!.title!.includes("周五下班前交周报"));
  });
});

test("pending_confirmation 不物化，confirm 后才物化", async () => {
  await withBoardAndTasks(async ({ board, tasks, tick }) => {
    const created = board.create({
      actorId: "user1",
      text: "预约牙医",
      committedBy: "user",
      deadline: "2026-09-26T09:00:00Z",
      status: "pending_confirmation",
    });
    const id = (created as CommitmentRecordLike).id;
    await tick();
    assert.equal(tasks.findTaskBySourceRefId(id), undefined, "待确认不应物化");

    const confirmed = board.confirm(id);
    assert.ok(!("error" in confirmed));
    await tick();
    assert.ok(tasks.findTaskBySourceRefId(id), "确认后应物化");
  });
});

test("deadline 变更 → 日程反向改期", async () => {
  await withBoardAndTasks(async ({ board, tasks, tick }) => {
    const created = board.create({
      actorId: "user1",
      text: "给客户发报价",
      committedBy: "agent",
      deadline: "2026-09-25T06:00:00Z",
      status: "active",
    });
    const id = (created as CommitmentRecordLike).id;
    await tick();
    const before = tasks.findTaskBySourceRefId(id);
    assert.equal(before!.runAt, "2026-09-25T06:00:00.000Z");

    board.update(id, { deadline: "2026-09-27T06:00:00Z" });
    await tick();
    const after = tasks.findTaskBySourceRefId(id);
    assert.equal(after!.runAt, "2026-09-27T06:00:00.000Z", "改期应同步到日程");
    assert.equal(after!.taskId, before!.taskId, "应改期同一任务而非新建");
  });
});

test("承诺终态 → 日程软取消", async () => {
  await withBoardAndTasks(async ({ board, tasks, tick }) => {
    const created = board.create({
      actorId: "user1",
      text: "回传合同",
      committedBy: "third_party",
      deadline: "2026-09-26T02:00:00Z",
      status: "active",
    });
    const id = (created as CommitmentRecordLike).id;
    await tick();
    assert.ok(tasks.findTaskBySourceRefId(id));

    board.cancel(id, "用户说不用了");
    await tick();
    const task = tasks.findTaskBySourceRefId(id);
    assert.equal(task, undefined, "findTaskBySourceRefId 只查未取消");
    const all = tasks.listAllTasks().filter((t) => t.sourceRefId === id);
    assert.equal(all.length, 1);
    assert.equal(all[0]!.status, "cancelled");
  });
});

test("时间闸：过去 deadline / 无期限不物化", async () => {
  await withBoardAndTasks(async ({ board, tasks, tick }) => {
    board.create({
      actorId: "user1",
      text: "昨天该交的报表",
      committedBy: "user",
      deadline: "2026-09-23T02:00:00Z",
      status: "active",
    });
    board.create({
      actorId: "user1",
      text: "有空聊聊",
      committedBy: "user",
      status: "active",
    });
    await tick();
    assert.equal(tasks.listAllTasks().filter((t) => t.source === "commitment").length, 0);
  });
});

test("重复 persist（提醒档位等状态更新）不重复物化", async () => {
  await withBoardAndTasks(async ({ board, tasks, tick }) => {
    const created = board.create({
      actorId: "user1",
      text: "每日站会前同步进展",
      committedBy: "user",
      deadline: "2026-09-25T01:00:00Z",
      status: "active",
    });
    const id = (created as CommitmentRecordLike).id;
    await tick();
    board.update(id, { notes: "补充说明" });
    await tick();
    const all = tasks.listAllTasks().filter((t) => t.sourceRefId === id);
    assert.equal(all.length, 1, "只应有一条物化日程");
  });
});
