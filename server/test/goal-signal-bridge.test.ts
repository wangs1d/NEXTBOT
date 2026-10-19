// GoalSignalBridge 单测（2026-10-10，阶段二：感知 ↔ 目标双向桥）。
// 覆盖：方向 A（活跃目标上下文注入）/ 方向 B（按需检索判定 + 查询词构造）。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { GoalBoard } from "../src/proactivity/goal-board.js";
import { GoalPlanner } from "../src/proactivity/goal-planner.js";
import {
  CROSS_SOURCE_REPEAT_WINDOW_MS,
  GoalSignalBridge,
  adjustImportanceByGoalRelation,
  appendGoalHint,
  composeRetrievalQuery,
  downgradeImportanceForRepeat,
  isCrossSourceRepeat,
} from "../src/proactivity/goal-signal-bridge.js";

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

// ─── 归属判定（2026-10-19）：仲裁依据来自目标状态，而不是规则写死的等级 ───

test("归属: 信号实词命中目标标题 → 判定相关，且带目标上下文", () => {
  const h = makeBridge();
  try {
    h.planner.createPlan({ actorId: "u1", title: "三亚旅行准备", steps: ["比价往返机票"] });
    const rel = h.bridge.relatedGoalFor("u1", "连续工作 3 小时 三亚");
    assert.ok(rel, "标题实词命中算相关");
    assert.equal(rel!.matchedOn, "三亚", "命中词留痕");
    assert.equal(rel!.needsUser, false, "没有等确认/partial → 不是阻塞点");
    assert.match(rel!.hint, /三亚旅行准备/);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("归属: 通用词不算相关（防过度归属把无关信息吸到目标上）", () => {
  const h = makeBridge();
  try {
    h.planner.createPlan({ actorId: "u1", title: "今天计划安排", steps: ["处理一下"] });
    assert.equal(h.bridge.relatedGoalFor("u1", "今天有个会议安排要不要提醒"), null);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("归属: 步骤等确认 / 验收 partial → needsUser（用户是阻塞点）", () => {
  const h = makeBridge();
  try {
    const r = h.planner.createPlan({ actorId: "u1", title: "搬家", steps: ["联系中介约看房"] });
    assert.ok(r.ok);
    const step = h.planner.stepsOf(r.goal)[0];
    step.status = "awaiting_confirm";
    const rel = h.bridge.relatedGoalFor("u1", "中介 来消息了");
    assert.ok(rel);
    assert.equal(rel!.needsUser, true, "有步骤等确认即视为阻塞点");
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("归属: 无相关目标 → null（规则走原仲裁，行为不变）", () => {
  const h = makeBridge();
  try {
    h.planner.createPlan({ actorId: "u1", title: "备考雅思", steps: ["刷真题"] });
    assert.equal(h.bridge.relatedGoalFor("u1", "外面下暴雨了"), null);
    assert.equal(h.bridge.relatedGoalFor("u1", ""), null);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("等级调整: 阻塞点 +1 档，其余不变档；永不升到 critical", () => {
  assert.equal(adjustImportanceByGoalRelation("low", { needsUser: true }), "medium");
  assert.equal(adjustImportanceByGoalRelation("medium", { needsUser: true }), "high");
  assert.equal(adjustImportanceByGoalRelation("high", { needsUser: true }), "high", "不越级到 critical");
  assert.equal(adjustImportanceByGoalRelation("critical", { needsUser: true }), "critical");
  assert.equal(adjustImportanceByGoalRelation("medium", { needsUser: false }), "medium", "只是相关不改档");
  assert.equal(adjustImportanceByGoalRelation("medium", null), "medium", "无关系逐字不变");
});

test("正文拼接: 已带目标口径则不重复追加", () => {
  const rel = { goalId: "g1", title: "搬家", needsUser: false, matchedOn: "搬家", hint: "你还在推进「搬家」" };
  assert.equal(appendGoalHint("外面下雨了", rel), "外面下雨了（顺便：你还在推进「搬家」）");
  assert.equal(appendGoalHint("你还在推进「搬家」的事", rel), "你还在推进「搬家」的事", "已有目标口径不重复");
  assert.equal(appendGoalHint("外面下雨了", null), "外面下雨了");
});

// ─── 跨源去重（2026-10-19）：同一个目标被两层各说一遍 = 重复噪音 ───

test("重复判定: 无上次记录不算重复；窗口内算、越窗不算", () => {
  assert.equal(isCrossSourceRepeat(undefined, NOW), false, "从未开口过不算重复");
  assert.equal(isCrossSourceRepeat(null, NOW), false);
  assert.equal(isCrossSourceRepeat(NOW - 60_000, NOW), true, "刚说过 = 重复");
  assert.equal(
    isCrossSourceRepeat(NOW - CROSS_SOURCE_REPEAT_WINDOW_MS - 1, NOW),
    false,
    "超出窗口不算重复",
  );
});

test("重复降档: 沿阶梯向下走一格，见底即止；需要用户拍板的不降", () => {
  assert.equal(downgradeImportanceForRepeat("critical", null), "high");
  assert.equal(downgradeImportanceForRepeat("high", null), "medium");
  assert.equal(downgradeImportanceForRepeat("medium", null), "low");
  assert.equal(downgradeImportanceForRepeat("low", null), "low", "low 见底不再降");
  // 用户是阻塞点的开口（等确认/卡住/问还作不作数）：重复也保持原档
  assert.equal(downgradeImportanceForRepeat("medium", { needsUser: true }), "medium");
  assert.equal(downgradeImportanceForRepeat("high", { needsUser: true }), "high");
});

test("跨源去重(端到端): 目标板记账 + 闸门——首次照发，窗口内第二个源降一档", () => {
  const dir = mkdtempSync(join(tmpdir(), "goal-open-"));
  try {
    const board = new GoalBoard({ dataPath: dir, emitGoal: () => {}, nowFn: () => NOW });
    const goal = board.create({ actorId: "u1", kind: "plan", type: "plan", title: "搬家" });
    // 与装配层 gateGoalOpening 同构：读上次开口 → 记本次开口
    const open = (importance: "low" | "medium" | "high", needsUser: boolean) => {
      const repeat = isCrossSourceRepeat(board.get(goal.goalId)?.lastOpenedAt, NOW);
      board.noteOpened(goal.goalId, NOW);
      return repeat ? downgradeImportanceForRepeat(importance, { needsUser }) : importance;
    };
    assert.equal(open("medium", false), "medium", "首次开口照原档");
    assert.equal(board.get(goal.goalId)?.lastOpenedAt, NOW, "开口已记账");
    assert.equal(open("medium", false), "low", "窗口内第二个源降一档");
    assert.equal(open("medium", true), "medium", "请用户拍板的开口不降档");
    // 另一个目标不受牵连（去重键是目标，不是全局）
    const other = board.create({ actorId: "u1", kind: "plan", type: "plan", title: "学英语" });
    const repeatOther = isCrossSourceRepeat(board.get(other.goalId)?.lastOpenedAt, NOW);
    assert.equal(repeatOther, false, "各自独立记账");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
