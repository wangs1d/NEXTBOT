// GoalSignalBridge 单测（2026-10-10，阶段二：感知 ↔ 目标双向桥）。
// 覆盖：方向 A（活跃目标上下文注入）/ 方向 B（按需检索判定 + 查询词构造）。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { GoalBoard } from "../src/proactivity/goal-board.js";
import { GoalPlanner } from "../src/proactivity/goal-planner.js";
import { GoalSignalBridge, composeRetrievalQuery } from "../src/proactivity/goal-signal-bridge.js";

const NOW = new Date(2026, 9, 10, 10, 0, 0).getTime();

function makeBridge() {
  const dir = mkdtempSync(join(tmpdir(), "goal-bridge-"));
  const board = new GoalBoard({ dataPath: dir, emitGoal: () => {}, nowFn: () => NOW });
  let seq = 0;
  const planner = new GoalPlanner({
    goalBoard: board,
    launchTask: () => `t${seq++}`,
  });
  return { bridge: new GoalSignalBridge({ goalPlanner: planner }), planner, board, dir };
}

// ─── 方向 A：感知 → 目标 ───

test("bridge(A): 活跃计划 → goalLineFor 带进度与下一步", () => {
  const h = makeBridge();
  try {
    h.planner.createPlan({ actorId: "u1", title: "学英语", steps: ["背 20 个词", "看一集美剧"] });
    const line = h.bridge.goalLineFor("u1");
    assert.ok(line, "有活跃目标");
    assert.match(line!, /学英语/);
    assert.match(line!, /背 20 个词/, "带下一步");
    const briefs = h.bridge.activeGoalContext("u1");
    assert.equal(briefs.length, 1);
    assert.equal(briefs[0].remaining, 2);
    assert.equal(briefs[0].nextStep, "背 20 个词");
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("bridge(A): 无活跃目标 → goalLineFor 返回 null（规则行为不变）", () => {
  const h = makeBridge();
  try {
    assert.equal(h.bridge.goalLineFor("u1"), null);
    assert.deepEqual(h.bridge.activeGoalContext("u1"), []);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("bridge(A): 完成/就绪目标不计入活跃", () => {
  const h = makeBridge();
  try {
    const r = h.planner.createPlan({ actorId: "u1", title: "已完成的目标", steps: ["一步"] });
    assert.ok(r.ok);
    h.board.markDone(r.goal.goalId);
    assert.equal(h.bridge.goalLineFor("u1"), null, "done 目标不算活跃");
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

// ─── 方向 B：目标 → 感知（按需检索） ───

test("bridge(B): 查询类步骤 → 产出 realtime 检索请求；查询词纯代码构造", () => {
  const h = makeBridge();
  try {
    const r = h.planner.createPlan({ actorId: "u1", title: "去三亚", steps: ["查一下三亚机票", "订酒店"] });
    assert.ok(r.ok);
    const steps = h.planner.stepsOf(r.goal);
    const req = h.bridge.retrievalRequestFor(r.goal, steps[0]);
    assert.ok(req, "查询类步骤产检索请求");
    assert.equal(req!.channel, "realtime");
    assert.equal(req!.query, "三亚机票", "剥去'查一下'动词，留主体");
    assert.equal(req!.stepId, steps[0].id);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("bridge(B): 查历史类步骤 → 走 source 通道（查统一采集库而非联网）", () => {
  const h = makeBridge();
  try {
    const r = h.planner.createPlan({ actorId: "u1", title: "对账", steps: ["看看邮件里的账单记录"] });
    assert.ok(r.ok);
    const req = h.bridge.retrievalRequestFor(r.goal, h.planner.stepsOf(r.goal)[0]);
    assert.ok(req);
    assert.equal(req!.channel, "source", "历史数据走统一采集库");
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("bridge(B): 纯执行步骤（无查询动词）→ 不产检索请求", () => {
  const h = makeBridge();
  try {
    const r = h.planner.createPlan({ actorId: "u1", title: "整理", steps: ["整理桌面文件"] });
    assert.ok(r.ok);
    assert.equal(h.bridge.retrievalRequestFor(r.goal, h.planner.stepsOf(r.goal)[0]), null);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("composeRetrievalQuery: 剥动词/语气词，恒非空兜底", () => {
  assert.equal(composeRetrievalQuery("查一下三亚机票"), "三亚机票");
  assert.equal(composeRetrievalQuery("帮我搜搜国庆去成都的高铁"), "国庆去成都的高铁");
  assert.equal(composeRetrievalQuery("了解一下降噪耳机"), "降噪耳机");
  assert.equal(composeRetrievalQuery("看看明天的天气吧"), "明天的天气");
  assert.equal(composeRetrievalQuery("查"), "查", "剥光后退回原文（恒非空）");
});
