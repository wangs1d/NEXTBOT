/**
 * 【在办目标】注入契约测试（2026-10-19，三层尺度架构 P0-A）。
 *
 * 契约（防止重犯承诺板的老坑：只填字段不渲染 = 每轮白查台账）：
 *   1. 有活跃目标 → 块出现在 dynamicContext，且**不在 stablePrefix**
 *      （目标进度随步骤变，放稳定层会逐轮打断前缀缓存）
 *   2. 无活跃目标 → 零注入（不产出空壳块）
 *   3. 摘要控量：最多 3 条，超出折叠成一句；整块 < 400 字符
 *   4. 已完成/过期的目标不进摘要
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { GoalBoard } = await import("../src/proactivity/goal-board.js");
const { GoalPlanner } = await import("../src/proactivity/goal-planner.js");
const { buildActiveGoalsPromptBlock } = await import("../src/agent/active-goals-prompt.js");
const { assembleLayeredSections } = await import("../src/agent/prompt-assembler.js");

function makeBoard() {
  const dir = mkdtempSync(join(tmpdir(), "pa-goals-inject-"));
  const board = new GoalBoard({ dataPath: dir, emitGoal: () => {} });
  const planner = new GoalPlanner({ goalBoard: board });
  return { board, planner, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function makePlanWithProgress(
  planner: InstanceType<typeof GoalPlanner>,
  title: string,
  stepCount: number,
  doneCount: number,
): string {
  const r = planner.createPlan({
    actorId: "actor-1",
    title,
    steps: Array.from({ length: stepCount }, (_, i) => `步骤${i + 1}`),
  });
  assert.equal(r.ok, true);
  if (!r.ok) return "";
  const steps = planner.stepsOf(r.goal);
  for (let i = 0; i < doneCount && i < steps.length; i += 1) steps[i].status = "done";
  if (doneCount < steps.length) steps[doneCount].status = "running";
  return r.goal.goalId;
}

test("有活跃目标 → 块进动态层，且不进稳定层", () => {
  const { board, planner, cleanup } = makeBoard();
  try {
    makePlanWithProgress(planner, "三亚行程", 5, 2);
    const block = buildActiveGoalsPromptBlock({ goalBoard: board, goalPlanner: planner, actorId: "actor-1" });
    assert.ok(block, "应产出【在办目标】块");
    assert.ok(block!.includes("【在办目标】"));
    assert.ok(block!.includes("三亚行程"));
    assert.ok(block!.includes("2/5 步"), `进度应可读，实际: ${block}`);

    const { stablePrefix, dynamicContext } = assembleLayeredSections({ activeGoals: block! });
    assert.equal(
      stablePrefix.some((s) => s.includes("【在办目标】")),
      false,
      "绝不能进稳定层（会逐轮打断前缀缓存）",
    );
    assert.ok(dynamicContext.some((s) => s.includes("【在办目标】")), "必须渲染进动态层");
  } finally {
    cleanup();
  }
});

test("无活跃目标 → 零注入", () => {
  const { board, planner, cleanup } = makeBoard();
  try {
    const block = buildActiveGoalsPromptBlock({ goalBoard: board, goalPlanner: planner, actorId: "actor-1" });
    assert.equal(block, null);
    const { stablePrefix, dynamicContext } = assembleLayeredSections({});
    assert.equal(stablePrefix.length, 0);
    assert.equal(dynamicContext.length, 0);
  } finally {
    cleanup();
  }
});

test("摘要控量：最多 3 条，超出折叠，整块 < 400 字符", () => {
  const { board, planner, cleanup } = makeBoard();
  try {
    for (let i = 0; i < 5; i += 1) makePlanWithProgress(planner, `计划${i + 1}`, 3, i % 3);
    const block = buildActiveGoalsPromptBlock({ goalBoard: board, goalPlanner: planner, actorId: "actor-1" });
    assert.ok(block);
    const bullets = block!.split("\n").filter((l) => l.startsWith("· "));
    assert.equal(bullets.length, 3, `摘要应只列 3 条，实际 ${bullets.length}`);
    assert.ok(block!.includes("另有 2 个"));
    assert.ok(block!.length < 400, `整块过长：${block!.length} 字符`);
  } finally {
    cleanup();
  }
});

test("已完成的目标不进摘要", () => {
  const { board, planner, cleanup } = makeBoard();
  try {
    const goalId = makePlanWithProgress(planner, "已办完的事", 2, 2);
    board.markDone(goalId);
    const block = buildActiveGoalsPromptBlock({ goalBoard: board, goalPlanner: planner, actorId: "actor-1" });
    assert.equal(block, null);
  } finally {
    cleanup();
  }
});
