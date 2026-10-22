// 日程事实主张库单测（2026-10-22）：版本链（v2 快照取代 v1）/ 冲突匹配口径 /
// 持久化重建 / 降级条目退出匹配但不删除。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ScheduleAssertionStore } from "../src/proactivity/branches/schedule-assertion-store.js";

// 固定时钟：2026-10-22 正午
const NOW = new Date(2026, 9, 22, 12, 0, 0).getTime();
const DAY = 24 * 3600_000;

function makeStore(dir?: string): ScheduleAssertionStore {
  const path = join(dir ?? mkdtempSync(join(tmpdir(), "assertions-")), "assertions.json");
  return new ScheduleAssertionStore({ persistPath: path, nowFn: () => NOW });
}

const TIMETABLE_V1 = [
  { subject: "高等数学", title: "高等数学", runAt: NOW + 2 * DAY, durationMinutes: 90 },
  { subject: "大学英语", title: "大学英语", runAt: NOW + 3 * DAY, durationMinutes: 60 },
  { subject: "数据结构", title: "数据结构", runAt: NOW + 4 * DAY },
];

test("v1 入库：全部 scheduled，版本 1", () => {
  const store = makeStore();
  const r = store.ingestDocument("user-a", "课表", TIMETABLE_V1);
  assert.equal(r.documentId.length, 12);
  assert.equal(r.version, 1);
  assert.equal(r.asserted, 3);
  assert.equal(r.superseded, 0);
  assert.equal(store.stats().scheduled, 3);
});

test("v2 快照取代：新版没有的条目降级 superseded，退出冲突匹配但不删除", () => {
  const store = makeStore();
  store.ingestDocument("user-a", "课表", TIMETABLE_V1);
  // v2：高数挪到周三，英语保留，数据结构删掉
  const r = store.ingestDocument("user-a", "课表", [
    { subject: "高等数学", title: "高等数学", runAt: NOW + 8 * DAY, durationMinutes: 90 },
    { subject: "大学英语", title: "大学英语", runAt: NOW + 3 * DAY, durationMinutes: 60 },
  ]);
  assert.equal(r.version, 2);
  // 被取代 = 2：数据结构被删 + 高数旧时段（挪课 = 旧时段主张失效，assertionId 含
  // runAt，同科目不同时段是两条主张——周课表同科目多节课互不吞并）
  assert.equal(r.superseded, 2);
  const stats = store.stats();
  assert.equal(stats.scheduled, 2);
  assert.equal(stats.superseded, 2);
  // 被取代的主张不再参与冲突匹配（同 actor 同文本只命中现行主张）
  const hits = store.findConflicts("user-a", {
    windowStart: NOW,
    windowEnd: NOW + 14 * DAY,
    text: "数据结构的课取消了",
  });
  assert.equal(hits.length, 0);
});

test("冲突匹配：subject/title 子串命中 + 时间窗内；窗外/异 actor 不命中", () => {
  const store = makeStore();
  store.ingestDocument("user-a", "课表", TIMETABLE_V1);
  // 命中：subject 在文本里 + 主张在 14 天窗内
  const hit = store.findConflicts("user-a", {
    windowStart: NOW,
    windowEnd: NOW + 14 * DAY,
    text: "高等数学明天停课一次",
  });
  assert.equal(hit.length, 1);
  assert.equal(hit[0]!.subject, "高等数学");
  // 文本不含任何 subject/title：不命中（宁漏不误）
  assert.equal(store.findConflicts("user-a", { windowStart: NOW, windowEnd: NOW + 14 * DAY, text: "那门课取消了" }).length, 0);
  // 窗外（30 天后）：不命中
  assert.equal(store.findConflicts("user-a", { windowStart: NOW + 20 * DAY, windowEnd: NOW + 40 * DAY, text: "高等数学取消了" }).length, 0);
  // 异 actor：不命中
  assert.equal(store.findConflicts("user-b", { windowStart: NOW, windowEnd: NOW + 14 * DAY, text: "高等数学取消了" }).length, 0);
});

test("持久化重建：新实例恢复文档版本与主张", () => {
  const dir = mkdtempSync(join(tmpdir(), "assertions-persist-"));
  const path = join(dir, "assertions.json");
  const s1 = new ScheduleAssertionStore({ persistPath: path, nowFn: () => NOW });
  s1.ingestDocument("user-a", "课表", TIMETABLE_V1);
  const s2 = new ScheduleAssertionStore({ persistPath: path, nowFn: () => NOW });
  const r = s2.ingestDocument("user-a", "课表", TIMETABLE_V1);
  assert.equal(r.version, 2); // 版本链跨实例延续
  assert.equal(s2.stats().scheduled, 3);
  rmSync(dir, { recursive: true, force: true });
});

test("空/非法条目：不入库返回零值（不 throw）", () => {
  const store = makeStore();
  const r = store.ingestDocument("user-a", "课表", [
    { subject: "", title: "x", runAt: NOW },
    { subject: "高数", title: "高数", runAt: Number.NaN },
  ]);
  assert.equal(r.documentId, "");
  assert.equal(r.asserted, 0);
  assert.equal(store.stats().documents, 0);
});
