import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DdlRadarService,
  localDayDiff,
  MAX_ITEMS_PER_TIER,
  type IngestDeadlinesLike,
  type ScheduleTasksLike,
} from "../src/services/ddl-radar-service.js";

/** 固定"现在"：2026-10-22 10:00 本地时间（周四），避免测试随真实时钟漂移 */
const NOW = new Date(2026, 9, 22, 10, 0, 0);
const at = (dayOffset: number, h = 15, m = 0): string => {
  const d = new Date(2026, 9, 22 + dayOffset, h, m, 0);
  return d.toISOString();
};

function ingestOf(
  rows: Array<{ key: string; title: string; dueAt: string; category?: string }>,
): IngestDeadlinesLike {
  return {
    listDeadlines: () =>
      rows.map((r) => ({
        key: r.key,
        title: r.title,
        dueAt: r.dueAt,
        category: r.category,
        sourceLabel: "测试台账",
      })),
  };
}

function scheduleOf(
  rows: Array<{
    taskId: string;
    title?: string;
    description: string;
    when: string;
    status?: string;
  }>,
): ScheduleTasksLike {
  return {
    listTasksBySession: () =>
      rows.map((r) => ({
        taskId: r.taskId,
        title: r.title,
        description: r.description,
        runAt: r.when,
        nextRunAt: null,
        status: r.status ?? "pending",
        category: "study",
      })),
  };
}

const radar = (deps: {
  ingest?: IngestDeadlinesLike | null;
  schedule?: ScheduleTasksLike | null;
}) =>
  new DdlRadarService({
    ingestService: deps.ingest ?? null,
    scheduleTaskService: deps.schedule ?? null,
    now: () => NOW,
  });

// ───────────────────────── 分档 ─────────────────────────

test("今天到期 → tier=today；明天 → tomorrow；2~3 天 → soon", () => {
  const r = radar({
    ingest: ingestOf([
      { key: "a", title: "交数据结构作业", dueAt: at(0, 23) },
      { key: "b", title: "交英语论文提纲", dueAt: at(1, 12) },
      { key: "c", title: "报名四六级", dueAt: at(3, 9) },
    ]),
  }).scan("s1", "u1");

  assert.equal(r.today.length, 1);
  assert.equal(r.today[0]!.title, "交数据结构作业");
  assert.equal(r.tomorrow.length, 1);
  assert.equal(r.tomorrow[0]!.tier, "tomorrow");
  assert.equal(r.soon.length, 1);
  assert.equal(r.soon[0]!.tier, "soon");
  assert.equal(r.total, 3);
});

test("超过 3 天的远期 DDL 不进任何档（不打扰）", () => {
  const r = radar({
    ingest: ingestOf([{ key: "far", title: "期末大作业", dueAt: at(9, 23) }]),
  }).scan("s1", "u1");
  assert.equal(r.total, 0);
  assert.deepEqual([r.today, r.tomorrow, r.soon], [[], [], []]);
});

test("已过截止时间 → 归 today 且 overdue=true（不能凭空消失）", () => {
  const r = radar({
    ingest: ingestOf([{ key: "late", title: "交实习报告", dueAt: at(-1, 18) }]),
  }).scan("s1", "u1");
  assert.equal(r.today.length, 1);
  assert.equal(r.today[0]!.overdue, true);
  assert.ok(r.today[0]!.hoursLeft < 0);
});

test("日历日差按本地日切：23:50 与次日 00:10 差 1 天而不是 0.3 天", () => {
  const late = new Date(2026, 9, 22, 23, 50, 0);
  const next = new Date(2026, 9, 23, 0, 10, 0);
  assert.equal(localDayDiff(late, next), 1);
});

// ───────────────────────── 日程源过滤 ─────────────────────────

test("日程里的普通会议与提醒不当 DDL（只有命中截止语义才收）", () => {
  const r = radar({
    schedule: scheduleOf([
      { taskId: "t1", title: "项目周会", description: "每周例会", when: at(1, 10) },
      { taskId: "t2", title: "喝水提醒", description: "每小时一次", when: at(1, 11) },
      { taskId: "t3", title: "提交课程设计报告", description: "发到教务系统", when: at(1, 18) },
    ]),
  }).scan("s1", "u1");

  assert.equal(r.tomorrow.length, 1);
  assert.equal(r.tomorrow[0]!.id, "schedule:t3");
  assert.equal(r.tomorrow[0]!.source, "schedule");
});

test("已取消/已完成的日程不进 DDL", () => {
  const r = radar({
    schedule: scheduleOf([
      { taskId: "c1", title: "提交论文", description: "x", when: at(1, 12), status: "cancelled" },
      { taskId: "c2", title: "提交作业", description: "x", when: at(1, 12), status: "completed" },
    ]),
  }).scan("s1", "u1");
  assert.equal(r.total, 0);
});

// ───────────────────────── 去重 / 降级 ─────────────────────────

test("同一件事既在 ingest 台账又命中日程 → 去重保留更早的截止", () => {
  const r = radar({
    ingest: ingestOf([{ key: "cm1", title: "交毕业论文初稿", dueAt: at(1, 20) }]),
    schedule: scheduleOf([
      { taskId: "t9", title: "交毕业论文初稿", description: "提交毕业论文初稿", when: at(1, 9) },
    ]),
  }).scan("s1", "u1");

  assert.equal(r.tomorrow.length, 1, "去重后只剩一条");
  assert.equal(r.tomorrow[0]!.source, "schedule", "保留更早的那条（09:00）");
});

test("数据源缺失或抛错 → 降级为空，不抛异常", () => {
  const empty = radar({}).scan("s1", "u1");
  assert.equal(empty.total, 0);

  const broken = new DdlRadarService({
    ingestService: {
      listDeadlines: () => {
        throw new Error("db locked");
      },
    },
    scheduleTaskService: {
      listTasksBySession: () => {
        throw new Error("boom");
      },
    },
    now: () => NOW,
  });
  const r = broken.scan("s1", "u1");
  assert.equal(r.total, 0);
});

test("未传 actorId 时用 sessionId 兜底查 ingest 台账", () => {
  const seen: Array<string | undefined> = [];
  const ingest: IngestDeadlinesLike = {
    listDeadlines: (actorId) => {
      seen.push(actorId);
      return actorId === "sess-9"
        ? [{ key: "x", title: "交作业", dueAt: at(0, 22), sourceLabel: "测试台账" }]
        : [];
    },
  };
  const r = radar({ ingest }).scan("sess-9");
  assert.deepEqual(seen, ["sess-9"]);
  assert.equal(r.today.length, 1);
});

// ───────────────────────── 投递面视图 ─────────────────────────

test("forEvening 只给 L2：明天到期 + 今天已过期（不含今天还没到点的）", () => {
  const svc = radar({
    ingest: ingestOf([
      { key: "a", title: "今天还没到点的", dueAt: at(0, 23) },
      { key: "b", title: "今天已经过点的", dueAt: at(-1, 18) },
      { key: "c", title: "明天要交的", dueAt: at(1, 12) },
      { key: "d", title: "这周要交的", dueAt: at(3, 12) },
    ]),
  });
  const { tomorrow, overdue } = svc.forEvening("s1", "u1");
  assert.deepEqual(tomorrow.map((i) => i.id), ["ingest:c"]);
  assert.deepEqual(overdue.map((i) => i.id), ["ingest:b"]);
});

test("forMorning 给 L3 + L1，且不含明天的（L2 不在晨报重复）", () => {
  const svc = radar({
    ingest: ingestOf([
      { key: "a", title: "今天截止", dueAt: at(0, 20) },
      { key: "b", title: "明天截止", dueAt: at(1, 12) },
      { key: "c", title: "后天截止", dueAt: at(2, 12) },
    ]),
  });
  const { today, soon } = svc.forMorning("s1", "u1");
  assert.deepEqual(today.map((i) => i.id), ["ingest:a"]);
  assert.deepEqual(soon.map((i) => i.id), ["ingest:c"]);
});

test("单档最多 5 条（防卡片被撑爆）", () => {
  const rows = Array.from({ length: 9 }, (_, i) => ({
    key: `m${i}`,
    title: `作业${i}`,
    dueAt: at(1, 8 + i),
  }));
  const r = radar({ ingest: ingestOf(rows) }).scan("s1", "u1");
  assert.equal(r.tomorrow.length, MAX_ITEMS_PER_TIER);
});
