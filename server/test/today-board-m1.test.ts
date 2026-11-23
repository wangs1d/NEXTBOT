// 今日看板（常驻通知 + 小组件数据源，需求 §5.2/§5.3）单测：
// 排序、脱敏、取前两条与「都没有」兜底都在服务端算，这里盯住这几条口径。
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildTodayBoard, countdownLabel } from "../src/services/today-board.js";
import type { BillParcelEntry, BillParcelListQuery } from "../src/services/bill-parcel-ledger.js";
import type { ScheduleTaskRecord } from "../src/services/schedule-task-service.js";

// 固定本地时钟：09:20
const NOW = new Date(2026, 10, 23, 9, 20, 0).getTime();

function task(overrides: Partial<ScheduleTaskRecord> = {}): ScheduleTaskRecord {
  return {
    taskId: "t1",
    sessionId: "user-a",
    shortTitle: "牙医",
    description: "去协和医院看牙",
    kind: "reminder",
    recurrence: "none",
    timezone: "Asia/Shanghai",
    runAt: new Date(NOW + 40 * 60_000).toISOString(),
    nextRunAt: new Date(NOW + 40 * 60_000).toISOString(),
    status: "active",
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

function entry(overrides: Partial<BillParcelEntry> = {}): BillParcelEntry {
  return {
    id: "e1",
    category: "parcel",
    source: "sms",
    actorId: "user-a",
    title: "顺丰到件",
    amount: null,
    billType: null,
    trackingNo: null,
    pickupCode: "8-3-2024",
    carrier: "顺丰",
    occurredAt: NOW,
    excerpt: "",
    ...overrides,
  };
}

function harness(
  tasks: ScheduleTaskRecord[],
  entries: BillParcelEntry[] = [],
): Parameters<typeof buildTodayBoard>[0] {
  return {
    scheduleTasks: {
      listTasksBySession: (sessionId, range) => {
        const from = range?.from ? Date.parse(range.from) : 0;
        const to = range?.to ? Date.parse(range.to) : Number.POSITIVE_INFINITY;
        return tasks
          .filter((t) => t.sessionId === sessionId)
          .filter((t) => {
            const at = Date.parse(t.nextRunAt ?? t.runAt);
            return at >= from && at <= to;
          })
          .sort((a, b) => Date.parse(a.runAt) - Date.parse(b.runAt));
      },
    },
    ledger: {
      list: (query: BillParcelListQuery) =>
        entries.filter((e) => !query.category || e.category === query.category),
    },
  };
}

test("看板: 下一件事优先，标题是它、正文报其余待办", () => {
  const board = buildTodayBoard(harness([task()], [entry()]), "user-a", NOW);
  assert.equal(board.lines[0].kind, "next_event");
  assert.equal(board.lines[0].text, "10:00 牙医 · 还有 40 分钟");
  assert.equal(board.lines[0].ref, "t1");
  assert.equal(board.title, "10:00 牙医");
  assert.equal(board.text, "1 个快递待取 · 取件码 8-3-2024");
  assert.deepEqual(
    board.nextEvent && { id: board.nextEvent.taskId, label: board.nextEvent.startLabel },
    { id: "t1", label: "10:00" },
  );
});

test("看板: 没有日程时按待取件/今天到期排,金额不进正文", () => {
  const board = buildTodayBoard(
    harness([], [
      entry({ id: "p1", pickupCode: null }),
      entry({ id: "p2", pickupCode: null }),
      entry({ id: "b1", category: "bill", billType: "信用卡还款", amount: 1280, pickupCode: null, title: "信用卡还款 1,280 元" }),
    ]),
    "user-a",
    NOW,
  );
  assert.deepEqual(board.lines.map((l) => l.kind), ["parcel_pending", "bill_due"]);
  assert.equal(board.lines[0].text, "2 个快递待取");
  assert.equal(board.lines[1].text, "信用卡还款今天到期");
  assert.ok(!JSON.stringify(board.lines).includes("1280"), "金额属于隐私，默认不进常驻通知");
  assert.equal(board.title, "2 个快递待取");
  assert.equal(board.text, "另有 1 项待办");
  assert.equal(board.nextEvent, undefined);
});

test("看板: 什么都没发生给安心话,不拿碎提醒凑数", () => {
  // trivia（喝水/节律类轻提醒）不进看板
  const board = buildTodayBoard(
    harness([task({ taskId: "t trivia", category: "trivia" })]),
    "user-a",
    NOW,
  );
  assert.equal(board.lines.length, 1);
  assert.equal(board.lines[0].kind, "idle");
  assert.equal(board.lines[0].text, "今天没什么要操心的");
  assert.equal(board.text, "管家在");
});

test("看板: 已过今天的日程不算下一件事", () => {
  const board = buildTodayBoard(
    harness([task({ runAt: new Date(NOW - 3 * 60 * 60_000).toISOString(), nextRunAt: null })]),
    "user-a",
    NOW,
  );
  assert.equal(board.lines[0].kind, "idle");
});

test("倒计时: 马上 / 分钟 / 小时取整", () => {
  assert.equal(countdownLabel(30_000), "马上");
  assert.equal(countdownLabel(40 * 60_000), "还有 40 分钟");
  assert.equal(countdownLabel(3 * 60 * 60_000), "还有 3 小时");
  assert.equal(countdownLabel(80 * 60_000), "还有 1 小时 20 分");
});
