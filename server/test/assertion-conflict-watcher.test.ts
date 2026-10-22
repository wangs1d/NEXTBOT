// 断言冲突监察单测（2026-10-22）：消息树枝 × 上传树枝 → 模型修正提案。
// 覆盖：命中产提案（指名课程与时间）/ 冷却防重 / 无变动信号不触发 /
// 无匹配主张不触发 / 渠道 scoped actor 归一。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { AssertionConflictWatcher } from "../src/proactivity/branches/assertion-conflict-watcher.js";
import { ScheduleAssertionStore } from "../src/proactivity/branches/schedule-assertion-store.js";
import type { ProactiveProposal } from "../src/proactivity/pipeline-types.js";

// 固定时钟：2026-10-22（周四）正午
const NOW = new Date(2026, 9, 22, 12, 0, 0).getTime();
const DAY = 24 * 3600_000;

type Harness = {
  watcher: AssertionConflictWatcher;
  proposals: ProactiveProposal[];
  store: ScheduleAssertionStore;
  dir: string;
};

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "conflict-watcher-"));
  const store = new ScheduleAssertionStore({ persistPath: join(dir, "assertions.json"), nowFn: () => NOW });
  const proposals: ProactiveProposal[] = [];
  const watcher = new AssertionConflictWatcher({
    store,
    submitProposal: (p) => proposals.push(p),
    now: () => NOW,
  });
  return { watcher, proposals, store, dir };
}

test("命中：变动信号 × 已导入主张 → 冲突提案（指名课程/时间/来源）", () => {
  const h = makeHarness();
  h.store.ingestDocument("user-a", "课表", [
    { subject: "高等数学", title: "高等数学", runAt: NOW + 2 * DAY, durationMinutes: 90 },
  ]);
  h.watcher.handleInbound({ actorId: "user-a", text: "高等数学明天的课取消了，老师有事", platform: "wechat" });
  assert.equal(h.proposals.length, 1);
  const p = h.proposals[0]!;
  assert.equal(p.kind, "action.schedule_conflict");
  assert.equal(p.tier, "must");
  assert.equal(p.importance, "high");
  assert.equal(p.subject, "高等数学");
  assert.ok(p.dedupKey.startsWith(`schedule_conflict:${p.evidence.find((e) => e.startsWith("assertion:"))!.slice(10)}`));
  assert.ok(p.directText.includes("课表"));
  assert.ok(p.directText.includes("高等数学"));
  assert.ok(p.directText.includes("10月24日 12:00"));
  assert.ok(p.confirmAction?.label === "让助手处理");
  rmSync(h.dir, { recursive: true, force: true });
});

test("冷却：同一主张 30 分钟内同内容不重复提案", () => {
  const h = makeHarness();
  h.store.ingestDocument("user-a", "课表", [
    { subject: "高等数学", title: "高等数学", runAt: NOW + 2 * DAY },
  ]);
  const text = "高等数学明天的课取消了";
  h.watcher.handleInbound({ actorId: "user-a", text });
  h.watcher.handleInbound({ actorId: "user-a", text });
  assert.equal(h.proposals.length, 1);
  rmSync(h.dir, { recursive: true, force: true });
});

test("无日程变动信号：即使文本含课程名也不触发", () => {
  const h = makeHarness();
  h.store.ingestDocument("user-a", "课表", [
    { subject: "高等数学", title: "高等数学", runAt: NOW + 2 * DAY },
  ]);
  h.watcher.handleInbound({ actorId: "user-a", text: "高等数学作业交了吗" });
  assert.equal(h.proposals.length, 0);
  rmSync(h.dir, { recursive: true, force: true });
});

test("有变动信号但无匹配主张：不触发（消息树枝自己那条链负责）", () => {
  const h = makeHarness();
  h.watcher.handleInbound({ actorId: "user-a", text: "明天的课取消了" });
  assert.equal(h.proposals.length, 0);
  rmSync(h.dir, { recursive: true, force: true });
});

test("渠道 scoped actor 归一：user-a@wechat 命中 user-a 的主张", () => {
  const h = makeHarness();
  h.store.ingestDocument("user-a", "课表", [
    { subject: "高等数学", title: "高等数学", runAt: NOW + 2 * DAY },
  ]);
  h.watcher.handleInbound({ actorId: "user-a@wechat", text: "高等数学改到周五下午了", platform: "wechat" });
  assert.equal(h.proposals.length, 1);
  assert.equal(h.proposals[0]!.actorId, "user-a");
  rmSync(h.dir, { recursive: true, force: true });
});
