// GoalRunner 单测（2026-10-10，对标 Muse「Goal 为主引擎」）。
// 覆盖：后台自主推进 / 外部步骤转确认 / 间隔闸 / 预算如实停步 / 一键回退 / 阶段性汇报。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { GoalBoard } from "../src/proactivity/goal-board.js";
import { GoalPlanner } from "../src/proactivity/goal-planner.js";
import { GoalRunner, type GoalRunnerProposal } from "../src/proactivity/goal-runner.js";

const NOW = new Date(2026, 9, 10, 10, 0, 0).getTime();

type Harness = {
  runner: GoalRunner;
  planner: GoalPlanner;
  board: GoalBoard;
  proposals: GoalRunnerProposal[];
  /** 派发记录（launchTask 收到什么） */
  dispatched: Array<{ actorId: string; goal: string; light?: boolean }>;
  /** 预算闸：null = 拒绝派发（模拟超限/LLM 不可用） */
  launchAllowed: { value: boolean };
  dir: string;
};

function makeHarness(opts: { env?: Record<string, string | undefined>; minIntervalMs?: number } = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "goal-runner-"));
  const emittedGoals: string[] = [];
  const board = new GoalBoard({ dataPath: dir, emitGoal: (g) => emittedGoals.push(g.goalId), nowFn: () => NOW });
  const proposals: GoalRunnerProposal[] = [];
  const dispatched: Harness["dispatched"] = [];
  const launchAllowed = { value: true };
  let seq = 0;
  const planner = new GoalPlanner({
    goalBoard: board,
    launchTask: (input) => {
      if (!launchAllowed.value) return null; // 预算超限/LLM 不可用：步骤停 todo
      dispatched.push({ actorId: input.actorId, goal: input.goal, ...(input.light ? { light: true } : {}) });
      return `task_${seq++}`;
    },
  });
  const runner = new GoalRunner({
    goalPlanner: planner,
    listActors: () => ["user-a"],
    emitProposal: (p) => proposals.push(p),
    nowFn: () => NOW,
    env: opts.env ?? {},
    ...(opts.minIntervalMs !== undefined ? { minIntervalMs: opts.minIntervalMs } : {}),
    log: () => {},
  });
  return { runner, planner, board, proposals, dispatched, launchAllowed, dir };
}

function makePlan(h: Harness, steps: string[]): string {
  const r = h.planner.createPlan({ actorId: "user-a", title: "学英语", steps });
  assert.ok(r.ok);
  return r.goal.goalId;
}

test("GoalRunner: 后台自主推进 todo 步骤（无对话也动起来）", () => {
  const h = makeHarness();
  try {
    const goalId = makePlan(h, ["整理词汇表", "每天背 20 个单词"]);
    const r = h.runner.tick();
    assert.equal(r.advanced, 1, "推进了一个目标");
    assert.equal(h.dispatched.length, 1, "派发了后台任务");
    assert.match(h.dispatched[0].goal, /整理词汇表/, "派发的是第一步");
    assert.equal(h.proposals.length, 0, "静默推进不打扰用户（对齐决策点才打扰）");
    // 第二次 tick：doing 未完成 → already_doing，不再派发
    h.runner.tick();
    assert.equal(h.dispatched.length, 1, "进行中不重复派发");
    assert.equal(goalId.length > 0, true);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("GoalRunner: 外部副作用步骤 → 转 awaiting_confirm 并产提案（决策点才打扰）", () => {
  const h = makeHarness();
  try {
    // "下单" 命中 act_external
    makePlan(h, ["下单买机票"]);
    const r = h.runner.tick();
    assert.equal(r.proposals, 1, "外部步骤产一条等确认提案");
    assert.equal(h.proposals[0].kind, "goal_confirm");
    assert.equal(h.proposals[0].importance, "medium");
    assert.match(h.proposals[0].summary, /下单买机票/);
    assert.match(h.proposals[0].dedupKey, /goal_runner:confirm:/);
    assert.equal(h.dispatched.length, 0, "外部步骤不自动派发");
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("GoalRunner: 派发通道不可用（预算超限）→ 如实停步，不产噪音提案", () => {
  const h = makeHarness();
  try {
    h.launchAllowed.value = false; // 模拟 PROACTIVITY_GOAL_DAILY_BUDGET 超限
    makePlan(h, ["整理资料"]);
    const r = h.runner.tick();
    assert.equal(h.dispatched.length, 0, "预算超限不派发");
    assert.equal(r.proposals, 0, "成本问题不变成用户噪音");
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("GoalRunner: 间隔闸——同一计划两轮 tick 间不连推", () => {
  const h = makeHarness({ minIntervalMs: 60 * 60_000 });
  try {
    const goalId = makePlan(h, ["步骤一", "步骤二"]);
    h.runner.tick();
    assert.equal(h.dispatched.length, 1, "第一次派发");
    // 模拟「后台任务完成」：先关派发通道，markStep(done) 内部自动 advance 会被拦下，
    // 第二步停在 todo；再开通道 → 下一步就绪。
    h.launchAllowed.value = false;
    h.planner.markStep(goalId, "user-a", "s1", "done");
    h.launchAllowed.value = true;
    const before = h.dispatched.length;
    h.runner.tick();
    assert.equal(h.dispatched.length, before, "间隔未到，第二次 tick 不连推");
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("GoalRunner: 计划完成（advance → finished）→ 产完成汇报提案", () => {
  // 用最小桩规划器直接驱动 finished 分支：真实 GoalPlanner 的 markStep 会在
  // 完成最后一步时内部 finishPlan（status→ready），goal_ready 评估器已接管汇报；
  // GoalRunner 的 finished 分支是防御性的（TaskHub 终态回调等边角路径）。
  const proposals: GoalRunnerProposal[] = [];
  const runner = new GoalRunner({
    goalPlanner: {
      listPlans: () => [{ goalId: "g1", actorId: "user-a", kind: "plan", title: "学英语", status: "watching", createdAt: NOW, type: "custom" }],
      advance: () => ({ ok: true, action: "finished", summary: "「学英语」计划完成：3 步办成" }),
    } as never,
    listActors: () => ["user-a"],
    emitProposal: (p) => proposals.push(p),
    nowFn: () => NOW,
    env: {},
    log: () => {},
  });
  const r = runner.tick();
  assert.equal(r.proposals, 1);
  assert.match(proposals[0].dedupKey, /goal_runner:finished:g1/);
  assert.match(proposals[0].title, /已完成/);
  assert.match(proposals[0].summary, /3 步办成/);
});

test("GoalRunner: 已完成/就绪计划不再扫描", () => {
  const h = makeHarness();
  try {
    const goalId = makePlan(h, ["一步"]);
    h.board.markDone(goalId);
    const r = h.runner.tick();
    assert.equal(r.scanned, 0, "done 计划跳过");
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("GoalRunner: GOAL_RUNNER_ENABLED=0 一键关（回退）", () => {
  const h = makeHarness({ env: { GOAL_RUNNER_ENABLED: "0" } });
  try {
    makePlan(h, ["步骤一"]);
    assert.equal(h.runner.enabled(), false);
    const r = h.runner.tick();
    assert.equal(r.scanned, 0);
    assert.equal(h.dispatched.length, 0, "关闭后不推进");
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("GoalRunner: 单轮最多推进 maxPerTick 个目标（防一次 tick 爆派）", () => {
  const dir = mkdtempSync(join(tmpdir(), "goal-runner-"));
  try {
    const board = new GoalBoard({ dataPath: dir, emitGoal: () => {}, nowFn: () => NOW });
    const proposals: GoalRunnerProposal[] = [];
    const dispatched: string[] = [];
    const planner = new GoalPlanner({
      goalBoard: board,
      launchTask: (input) => {
        dispatched.push(input.goal);
        return `t${dispatched.length}`;
      },
    });
    for (let i = 0; i < 5; i++) planner.createPlan({ actorId: "user-a", title: `目标${i}`, steps: ["一步"] });
    const runner = new GoalRunner({
      goalPlanner: planner,
      listActors: () => ["user-a"],
      emitProposal: (p) => proposals.push(p),
      nowFn: () => NOW,
      env: {},
      maxPerTick: 2,
      log: () => {},
    });
    const r = runner.tick();
    assert.equal(r.advanced, 2, "单轮封顶 2");
    assert.equal(dispatched.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GoalRunner: 阶段性进展汇报（每 2 步一次，不重复）", () => {
  const h = makeHarness();
  try {
    const goalId = makePlan(h, ["a", "b", "c", "d"]);
    h.planner.markStep(goalId, "user-a", "s1", "done");
    h.planner.markStep(goalId, "user-a", "s2", "done");
    assert.equal(h.runner.maybeReportProgress(goalId, "user-a"), true, "完成 2 步汇报一次");
    assert.equal(h.runner.maybeReportProgress(goalId, "user-a"), false, "同一里程碑不重复");
    h.planner.markStep(goalId, "user-a", "s3", "done");
    h.planner.markStep(goalId, "user-a", "s4", "done");
    assert.equal(h.runner.maybeReportProgress(goalId, "user-a"), true, "完成 4 步再汇报");
    assert.equal(h.proposals.length, 2);
    assert.equal(h.proposals[0].importance, "low", "阶段进展轻打扰");
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("GoalRunner: status() 反映运行态（诊断面板）", () => {
  const h = makeHarness({ env: { GOAL_RUNNER_TICK_MS: "45000" } });
  try {
    makePlan(h, ["步骤"]);
    h.runner.tick();
    const st = h.runner.status();
    assert.equal(st.enabled, true);
    assert.equal(st.tickMs, 45000);
    assert.equal(st.tracked, 1);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});
