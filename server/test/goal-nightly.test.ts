/**
 * GoalNightlyJob + 目标夜间内省排期（2026-10-19）契约测试。
 *
 * 补齐的是什么：内省引擎（goal-introspector）早就有，但没人排期——闲置衰减/
 * 过期/语义复核在生产从不发生，只有 HTTP 查询在读它。这里锁住四件事：
 *   - 到点判定：本地时命中且当天没跑过才跑（同一天重复调用不再触发）
 *   - 开口：decay 不开口；ask_stale / expire / suggest_replan / verified_met 转提案
 *   - 冷却：partial 建议同类 3 天内只提一次（否则会被夜夜追问）
 *   - 语义翻案：判 met 的 partial 计划改判 met 并进 ReadyTray，且不再同时推重排
 *   - 关闭开关：GOAL_NIGHTLY=0 时 runOnce 直接空跑
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { GoalBoard } = await import("../src/proactivity/goal-board.js");
const { GoalPlanner } = await import("../src/proactivity/goal-planner.js");
const { GoalIntrospector } = await import("../src/proactivity/goal-introspector.js");
const { GoalNightlyJob } = await import("../src/proactivity/goal-nightly.js");

const DAY = 86_400_000;

function makeBoard() {
  const dir = mkdtempSync(join(tmpdir(), "pa-nightly-"));
  return new GoalBoard({ dataPath: dir, emitGoal: () => {} });
}

/** 造一个闲置 N 天的在办目标（直接改 createdAt 让闲置天数可控） */
function seedGoal(board: ReturnType<typeof makeBoard>, opts: { actorId: string; title: string; idleDays: number; salience: number }) {
  const goal = board.create({ actorId: opts.actorId, kind: "track", type: "custom", title: opts.title, payload: {} });
  const rec = board.get(goal.goalId)!;
  rec.createdAt = Date.now() - opts.idleDays * DAY;
  rec.salience = opts.salience;
  return rec;
}

test("到点判定：命中 hour 且当天未跑过才触发（同一天不重复）", () => {
  const board = makeBoard();
  const introspector = new GoalIntrospector({ goalBoard: board });
  const job = new GoalNightlyJob({
    introspector,
    listActors: () => [],
    emit: () => {},
    nowFn: () => new Date(2026, 9, 19, 3, 30).getTime(),
    env: {},
    log: () => {},
  });
  assert.equal(job.maybeRun(), true, "3:30 命中 3 点档");
  assert.equal(job.maybeRun(), false, "同一天再调用不再触发");
  const other = new GoalNightlyJob({
    introspector,
    listActors: () => [],
    emit: () => {},
    nowFn: () => new Date(2026, 9, 19, 14, 0).getTime(),
    env: {},
    log: () => {},
  });
  assert.equal(other.maybeRun(), false, "非执行时刻不触发");
});

test("开口：decay 不开口，其余动作转提案（来源标记 goal_introspect）", async () => {
  const board = makeBoard();
  const now = Date.now();
  seedGoal(board, { actorId: "u1", title: "闲置很久的事", idleDays: 40, salience: 0.9 });
  seedGoal(board, { actorId: "u1", title: "刚建的小事", idleDays: 0, salience: 1 });
  const introspector = new GoalIntrospector({ goalBoard: board });
  const emitted: Array<{ actorId: string; title: string; summary: string; source: string }> = [];
  const job = new GoalNightlyJob({
    introspector,
    listActors: () => ["u1"],
    emit: (p) => emitted.push(p),
    nowFn: () => now,
    env: {},
    log: () => {},
  });
  const report = await job.runOnce("测试");
  assert.equal(report.actors, 1);
  assert.equal(emitted.length, 1, "只有过期那条开口，decay 不开口");
  assert.equal(emitted[0]!.source, "goal_introspect");
  assert.match(emitted[0]!.summary, /40 天没动/);
  // 过期目标已作废
  assert.equal(board.list("u1").find((g) => g.title === "闲置很久的事")!.status, "done");
});

test("冷却：partial 的重排建议同类 3 天内只提一次", () => {
  const board = makeBoard();
  const planner = new GoalPlanner({ goalBoard: board });
  const now = Date.now();
  const r = planner.createPlan({ actorId: "u1", title: "学英语", steps: ["每天背 20 个单词"] });
  assert.ok(r.ok);
  const rec = board.get(r.goal.goalId)!;
  rec.verdict = "partial";
  rec.verdictNote = "只做了一半";
  rec.createdAt = now - 20 * DAY;

  const introspector = new GoalIntrospector({ goalBoard: board, nowFn: () => now });
  const first = introspector.runForActor("u1");
  assert.equal(first.filter((f) => f.action === "suggest_replan").length, 1, "首次应建议重排");
  // 当天再扫（模拟进程重启后重复跑）：冷却期内不再开口
  const second = introspector.runForActor("u1");
  assert.equal(second.filter((f) => f.action === "suggest_replan").length, 0, "冷却期内不重复打扰");
  assert.equal(second.filter((f) => f.action === "decay").length, 1);
  // 冷却过后又能提
  const later = new GoalIntrospector({ goalBoard: board, nowFn: () => now + 4 * DAY });
  assert.equal(later.runForActor("u1").filter((f) => f.action === "suggest_replan").length, 1);
});

test("语义翻案：判 met 的 partial 计划改判 met 进 ReadyTray，且不再推重排", async () => {
  const board = makeBoard();
  const planner = new GoalPlanner({ goalBoard: board });
  const now = Date.now();
  const r = planner.createPlan({
    actorId: "u1",
    title: "整理上周差旅报销",
    steps: ["收集发票"],
    successCriteria: "发票齐了且报销单填完",
  });
  assert.ok(r.ok);
  const rec = board.get(r.goal.goalId)!;
  rec.verdict = "partial";
  // 语义验收器说"其实办成了"
  const introspector = new GoalIntrospector({
    goalBoard: board,
    nowFn: () => now,
    semanticVerifier: async () => ({ verdict: "met", note: "发票与报销单都有留存，实际已办成" }),
  });
  const findings = await introspector.runNightlyForActor("u1");
  assert.equal(findings.filter((f) => f.action === "verified_met").length, 1);
  assert.equal(findings.filter((f) => f.action === "suggest_replan").length, 0, "翻案后不再推重排");
  const after = board.get(r.goal.goalId)!;
  assert.equal(after.verdict, "met");
  assert.equal(after.status, "ready", "met → ReadyTray 等投递时机");
});

test("未注入语义验收器 = 零 LLM 行为不变（partial 仍只建议重排）", async () => {
  const board = makeBoard();
  const planner = new GoalPlanner({ goalBoard: board });
  const r = planner.createPlan({ actorId: "u1", title: "备考", steps: ["刷题"] });
  assert.ok(r.ok);
  const rec = board.get(r.goal.goalId)!;
  rec.verdict = "partial";
  const introspector = new GoalIntrospector({ goalBoard: board });
  const findings = await introspector.runNightlyForActor("u1");
  assert.equal(findings.filter((f) => f.action === "verified_met").length, 0);
  assert.equal(findings.filter((f) => f.action === "suggest_replan").length, 1);
});

test("GOAL_NIGHTLY=0 时整轮空跑（不内省、不开口）", async () => {
  const board = makeBoard();
  seedGoal(board, { actorId: "u1", title: "闲置很久的事", idleDays: 40, salience: 0.9 });
  const introspector = new GoalIntrospector({ goalBoard: board });
  const emitted: unknown[] = [];
  const job = new GoalNightlyJob({
    introspector,
    listActors: () => ["u1"],
    emit: (p) => emitted.push(p),
    env: { GOAL_NIGHTLY: "0" },
    log: () => {},
  });
  const report = await job.runOnce("测试");
  assert.deepEqual(report, { actors: 0, findings: 0, delivered: 0 });
  assert.equal(emitted.length, 0);
  assert.equal(board.get(board.list("u1")[0]!.goalId)!.status, "watching", "关掉时不作废");
});

test("模板偏好：命中模板的计划把结果形态偏好落载荷并随 create/list 暴露", () => {
  const board = makeBoard();
  const planner = new GoalPlanner({ goalBoard: board });
  const r = planner.createPlan({ actorId: "u1", title: "下周去三亚玩四天" });
  assert.ok(r.ok);
  const prefs = (r.goal.payload as { preferences?: string } | undefined)?.preferences;
  assert.ok(prefs && prefs.length > 0, "出行模板应带操作偏好");
  assert.ok(planner.listPlans("u1")[0], "list 可见");
});
