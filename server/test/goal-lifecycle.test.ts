/**
 * Goal 生命周期（验收 / 预算 / 退避 / 模板 / 内省 / 成本 / 统一视图）测试。
 * 2026-10-19，docs/goal-hybrid-architecture.md P0.5 + P1 + P2。
 *
 * 契约：
 *  - 验收：执行成功 ≠ 目标达成；有 successCriteria 时完成步必须有结果说明才算确证
 *  - 预算：目标级日额度独立于全局；跨天重置
 *  - 退避：失败 1 次退 2h，连续 2 次冻结（isEligible=false）
 *  - 模板：同类目标不传步骤即可生成（应用失败规避改写）
 *  - 内省：闲置 7 天 + 低显著度 → 问；30 天 → 作废
 *  - 成本：按 kind 聚合目标/步骤/达成率 + goal stage token 占比
 *  - 视图：goal + commitment 合并，等拍板的排前面
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { GoalBoard, backoffMsForFailStreak, dayKeyOf } = await import(
  "../src/proactivity/goal-board.js"
);
const { GoalPlanner } = await import("../src/proactivity/goal-planner.js");
const { verifyDeterministic } = await import("../src/proactivity/goal-verifier.js");
const { matchGoalTemplate, buildStepsFromTemplate } = await import(
  "../src/proactivity/goal-templates.js"
);
const { GoalIntrospector } = await import("../src/proactivity/goal-introspector.js");
const { buildGoalCostReport } = await import("../src/proactivity/goal-cost.js");
const { buildUnifiedGoalView } = await import("../src/proactivity/goal-unified-view.js");

const DAY = 86_400_000;

function makeBoard(startAt = 1_800_000_000_000) {
  const dir = mkdtempSync(join(tmpdir(), "pa-goal-life-"));
  let now = startAt;
  const board = new GoalBoard({ dataPath: dir, emitGoal: () => {}, nowFn: () => now });
  const planner = new GoalPlanner({ goalBoard: board });
  return {
    board,
    planner,
    nowFn: () => now,
    tick: (ms: number) => {
      now += ms;
      return now;
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

// ─────────────────────────── 验收 ───────────────────────────

test("验收：全部完成且有结果说明 → met", () => {
  const r = verifyDeterministic({
    title: "订三亚行程",
    successCriteria: "机票酒店都定下来",
    steps: [
      { title: "比价机票", status: "done", note: "选了 12:40 那班" },
      { title: "订酒店", status: "done", note: "海棠湾 3 晚" },
    ],
  });
  assert.equal(r?.verdict, "met");
});

test("验收：有验收条款但完成步没留结果 → partial（不许宣布完成）", () => {
  const r = verifyDeterministic({
    title: "订三亚行程",
    successCriteria: "机票酒店都定下来",
    steps: [
      { title: "比价机票", status: "done", note: "选了 12:40 那班" },
      { title: "订酒店", status: "done" },
    ],
  });
  assert.equal(r?.verdict, "partial");
  assert.ok(r?.note.includes("无法确认"));
});

test("验收：无验收条款时，步骤全完成即 met（不因缺 note 卡住）", () => {
  const r = verifyDeterministic({
    title: "整理一下",
    steps: [{ title: "整理文件", status: "done" }],
  });
  assert.equal(r?.verdict, "met");
});

test("验收：失败步按比例判 partial / failed；全失败 → failed", () => {
  const partial = verifyDeterministic({
    title: "x",
    steps: [
      { title: "a", status: "done", note: "ok" },
      { title: "b", status: "done", note: "ok" },
      { title: "c", status: "failed", note: "断网" },
    ],
  });
  assert.equal(partial?.verdict, "partial");

  const failed = verifyDeterministic({
    title: "x",
    steps: [
      { title: "a", status: "done", note: "ok" },
      { title: "b", status: "failed" },
      { title: "c", status: "failed" },
    ],
  });
  assert.equal(failed?.verdict, "failed");

  const allFailed = verifyDeterministic({
    title: "x",
    steps: [{ title: "a", status: "failed" }],
  });
  assert.equal(allFailed?.verdict, "failed");
});

test("验收：还有步骤没结论 → partial（不误判完成）", () => {
  const r = verifyDeterministic({
    title: "x",
    steps: [
      { title: "a", status: "done", note: "ok" },
      { title: "b", status: "todo" },
    ],
  });
  assert.equal(r?.verdict, "partial");
});

// ─────────────────────────── 模板 ───────────────────────────

test("模板：同类目标命中并应用失败规避改写", () => {
  const tpl = matchGoalTemplate("帮我订下周去三亚的行程，酒店和接机一起排了");
  assert.equal(tpl?.id, "travel");
  const steps = buildStepsFromTemplate(tpl!);
  // pitfalls 把「比价」改写成「先确认日期人数，再比价」
  const compareStep = steps.find((s) => s.includes("比价"));
  assert.ok(compareStep?.startsWith("确认日期与人数后"), `实际: ${compareStep}`);
  assert.ok(steps.length >= 5);
});

test("模板：排除词生效（不误吸）", () => {
  assert.equal(matchGoalTemplate("出差报销怎么弄"), null);
});

test("模板：createPlan 不传步骤时自动套模板，并落 successCriteria", () => {
  const { board, planner, cleanup } = makeBoard();
  try {
    const r = planner.createPlan({ actorId: "a", title: "准备考研，明年三月考" });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.ok(planner.stepsOf(r.goal).length >= 3);
    assert.ok(r.goal.successCriteria, "模板的达成判据应落到主表");
    assert.equal((r.goal.payload as { templateId?: string }).templateId, "exam");
    void board;
  } finally {
    cleanup();
  }
});

// ─────────────────────────── 预算 / 退避 ───────────────────────────

test("预算：目标级日额度用尽即拒，跨天重置", () => {
  const { board, tick, cleanup } = makeBoard();
  try {
    const g = board.create({ actorId: "a", kind: "plan", type: "plan", title: "x" });
    assert.equal(board.trySpendStep(g.goalId, 2), true);
    assert.equal(board.trySpendStep(g.goalId, 2), true);
    assert.equal(board.trySpendStep(g.goalId, 2), false, "第 3 次应超限");
    // 跨天
    tick(DAY);
    assert.equal(board.trySpendStep(g.goalId, 2), true, "新的一天额度重置");
  } finally {
    cleanup();
  }
});

test("退避：失败 1 次退 2h（退避期内不可推进），成功清零", () => {
  const now = 1_800_000_000_000;
  assert.equal(backoffMsForFailStreak(0, now), now + 10 * 60_000);
  assert.equal(backoffMsForFailStreak(1, now), now + 2 * 3600_000);
  assert.equal(backoffMsForFailStreak(2, now), Number.POSITIVE_INFINITY);

  const { board, cleanup } = makeBoard(now);
  try {
    const g = board.create({ actorId: "a", kind: "plan", type: "plan", title: "x" });
    board.noteAttempt(g.goalId, { ok: false, reason: "步骤失败" });
    assert.equal(board.isEligible(g.goalId), false, "退避期内不可推进");

    board.noteAttempt(g.goalId, { ok: true });
    assert.equal(board.get(g.goalId)?.attempts?.failStreak, 0);
    assert.equal(board.isEligible(g.goalId), true, "成功后立即恢复可推进");
  } finally {
    cleanup();
  }
});

test("退避：连续两次执行类失败后冻结，不再自动推进", () => {
  const { board, cleanup } = makeBoard();
  try {
    const g = board.create({ actorId: "a", kind: "plan", type: "plan", title: "x" });
    board.noteAttempt(g.goalId, { ok: false, reason: "凭证失效" });
    board.noteAttempt(g.goalId, { ok: false, reason: "凭证失效" });
    assert.equal(board.isEligible(g.goalId), false);
    const rec = board.get(g.goalId);
    assert.equal(rec?.attempts?.failStreak, 2);
    assert.ok(rec?.attempts?.lastFailReason?.includes("凭证"));

    // 成功尝试清零
    board.noteAttempt(g.goalId, { ok: true });
    assert.equal(board.get(g.goalId)?.attempts?.failStreak, 0);
  } finally {
    cleanup();
  }
});

// ─────────────────────────── 内省 ───────────────────────────

test("内省：闲置 7 天且显著度低 → 问一句；30 天 → 作废", () => {
  const { board, planner, tick, nowFn, cleanup } = makeBoard();
  try {
    const r = planner.createPlan({ actorId: "a", title: "学英语", steps: ["定周计划", "每天半小时"] });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const goalId = r.goal.goalId;
    board.setSalience(goalId, 0.2);
    tick(8 * DAY);

    const introspector = new GoalIntrospector({ goalBoard: board, nowFn });
    const findings = introspector.actionable("a");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].action, "ask_stale");
    assert.ok(findings[0].message?.includes("还作数"));

    // 问过之后显著度抬回 0.5，同一天再扫不会重复问
    assert.equal(introspector.actionable("a").length, 0, "不应连续追问");

    // 再闲置到 30 天 → 作废
    tick(23 * DAY);
    board.setSalience(goalId, 0.2);
    const later = introspector.actionable("a");
    assert.ok(later.some((f) => f.action === "expire"));
    assert.equal(board.get(goalId)?.status, "done");
  } finally {
    cleanup();
  }
});

// ─────────────────────────── 成本 / 视图 ───────────────────────────

test("成本报告：按 kind 聚合目标/步骤/达成率，token 占比可算", () => {
  const { board, planner, cleanup } = makeBoard();
  try {
    const a = planner.createPlan({ actorId: "a", title: "订三亚行程" });
    const b = planner.createPlan({ actorId: "a", title: "整理房间", steps: ["收衣服", "擦桌子"] });
    assert.equal(a.ok && b.ok, true);
    if (!a.ok || !b.ok) return;
    board.setVerdict(a.goal.goalId, "met", "都定好了");
    board.setVerdict(b.goal.goalId, "partial", "只整理了一半");

    const report = buildGoalCostReport({
      goalBoard: board,
      goalPlanner: planner,
      actorId: "a",
      readAudit: () => [
        { stage: "goal_plan_stage", totalTokens: 1500 },
        { stage: "chat", totalTokens: 8500 },
      ],
    });
    assert.equal(report.totals.goals, 2);
    assert.equal(report.totals.verified, 2);
    assert.ok(report.totals.steps >= 3);
    const row = report.rows.find((r) => r.kind === "plan");
    assert.equal(row?.met, 1);
    assert.equal(row?.partial, 1);
    assert.equal(row?.metRate, 0.5);
    assert.equal(report.token.goalStageTokens, 1500);
    assert.equal(report.token.goalStageShare, 0.15);
  } finally {
    cleanup();
  }
});

test("统一视图：goal 与承诺合并，等拍板的排前面", () => {
  const { board, planner, cleanup } = makeBoard();
  try {
    planner.createPlan({ actorId: "a", title: "订三亚行程" });
    const g2 = planner.createPlan({ actorId: "a", title: "整理房间", steps: ["收衣服", "擦桌子"] });
    assert.equal(g2.ok, true);
    if (!g2.ok) return;
    // 伪造一个待确认步骤
    const steps = planner.stepsOf(g2.goal);
    steps[0].status = "awaiting_confirm";

    const view = buildUnifiedGoalView({
      goalBoard: board,
      actorId: "a",
      progressOf: (g) => planner.progressLine(g),
    });
    assert.equal(view.counts.goals, 2);
    assert.equal(view.counts.needsUser, 1);
    assert.equal(view.items[0].title, "整理房间", "等确认的应排第一");
    assert.ok(view.items[0].progress);

    // 无承诺板时也不炸
    assert.equal(view.counts.commitments, 0);
  } finally {
    cleanup();
  }
});

test("dayKeyOf：本地日键格式", () => {
  const key = dayKeyOf(new Date(2026, 9, 19, 15, 0, 0).getTime());
  assert.equal(key, "2026-10-19");
});
