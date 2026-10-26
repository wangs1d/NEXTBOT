import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 右侧行程档案栏快照测试（buildDossier）。
 *
 * 档案栏是会话状态的确定性投影，编排器不参与：头部一句话、五步进度轨、
 * 已定条（含「和谁去 · 节奏」合并行）。这里锁住三件容易写歪的事：
 * - 步骤轨跟着 state 走，generated 才算五步全走完；
 * - 关键维度（去哪儿/玩几天/从哪儿走/和谁去）恒挂，未定标 todo；
 * - 选问维度（预算/交通/想去/住/吃）只在真有答案时出现，「随便」类不算。
 *
 * 运行：npx tsx --test test/travel-plan-dossier.test.ts
 */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "travel-plan-dossier-test-"));
process.env.TRAVEL_PLAN_STORE_DIR = path.join(tmpDir, "plans");
process.env.TRAVEL_SHARE_STORE_FILE = path.join(tmpDir, "share-codes.json");

const { buildDossier } = await import(
  "../src/skills/travel-planning/travel-plan-session.js"
);
type PlanSession = import("../src/skills/travel-planning/travel-plan-session.js").PlanSession;
type State = Parameters<typeof buildDossier>[1];

function session(over: Partial<PlanSession> = {}): PlanSession {
  return {
    id: "ps-dossier",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    originalMessage: "下周末和女朋友从北京出发去成都玩三天",
    destination: "成都",
    days: 3,
    origin: "北京",
    answers: [],
    history: [],
    ready: false,
    questionTurns: 0,
    draft: null,
    budgetApproved: false,
    weatherSent: false,
    guideSent: false,
    ...over,
  };
}

const fact = (d: ReturnType<typeof buildDossier>, id: string) =>
  d.facts.find((f) => f.id === id);

test("gathering：停在第一步，关键维度齐的标 set、缺的标 todo", () => {
  const d = buildDossier(session(), "gathering");
  assert.equal(d.head, "成都 · 3 天 · 北京出发");
  assert.deepEqual(
    d.steps.map((s) => s.state),
    ["active", "todo", "todo", "todo", "todo"],
  );
  assert.equal(d.steps[0]!.label, "问答");
  assert.equal(fact(d, "days")!.value, "3 天");
  assert.equal(fact(d, "origin")!.value, "北京出发");
  // 原话里读得出「女朋友」→ 同行人已定，并带上同行人推出的节奏
  assert.equal(fact(d, "party")!.state, "set");
  assert.equal(fact(d, "party")!.value, "和伴侣 · 松弛");
});

test("目的地/天数未定时挂空位，让用户看见还欠什么", () => {
  const d = buildDossier(
    session({ destination: undefined, days: undefined, origin: undefined, originalMessage: "想出去玩" }),
    "gathering",
  );
  assert.equal(d.head, "目的地待定");
  assert.deepEqual(
    d.facts.map((f) => [f.id, f.state]),
    [
      ["destination", "todo"],
      ["days", "todo"],
      ["origin", "todo"],
      ["party", "todo"],
    ],
  );
});

test("定位补的出发地如实标注，不冒充用户原话", () => {
  const d = buildDossier(
    session({ origin: "贵阳", originSource: "located" }),
    "gathering",
  );
  assert.equal(fact(d, "origin")!.value, "贵阳（定位）出发");
});

test("点选的同行人原样展示，「改」成紧凑后节奏跟着改", () => {
  const answered = session({
    originalMessage: "下周末从北京出发去成都玩三天",
    answers: [
      { id: "party", question: "这次和谁一起去？", answer: "和伴侣、紧凑" },
      { id: "budget", question: "预算按哪档？", answer: "舒适 · 性价比" },
    ],
  });
  const d = buildDossier(answered, "gathering");
  assert.equal(fact(d, "party")!.value, "和伴侣 · 紧凑");
  // 选问维度：有答案才出现
  assert.equal(fact(d, "budget")!.value, "舒适 · 性价比");
});

test("「先不选/随便」不算已定，选问维度不占位", () => {
  const d = buildDossier(
    session({
      answers: [{ id: "budget", question: "预算按哪档？", answer: "随便，都行" }],
    }),
    "gathering",
  );
  assert.equal(fact(d, "budget"), undefined);
});

test("筛选勾选后：想去/住/吃进档案，步骤轨推进到补心愿", () => {
  const picked = session({
    ready: true,
    guideSent: true,
    guideSelections: {
      view: ["宽窄巷子", "大熊猫基地", "都江堰", "人民公园"],
      stay: ["春熙路亚朵"],
      food: ["陈麻婆豆腐", "小龙坎"],
    },
  });
  const d = buildDossier(picked, "wishlist_ready");
  assert.deepEqual(
    d.steps.map((s) => s.state),
    ["done", "done", "active", "todo", "todo"],
  );
  assert.equal(fact(d, "picks")!.value, "宽窄巷子、大熊猫基地、都江堰 等 4 处");
  assert.equal(fact(d, "stay")!.value, "春熙路亚朵");
  assert.equal(fact(d, "food")!.value, "陈麻婆豆腐、小龙坎");
});

test("state → 进度轨：ready 在核预算、budget_ready 仍停核预算、generated 全走完", () => {
  const track = (s: State) => buildDossier(session(), s).steps.map((x) => x.state);
  assert.deepEqual(track("ready"), ["done", "done", "done", "active", "todo"]);
  assert.deepEqual(track("budget_ready"), ["done", "done", "done", "active", "todo"]);
  assert.deepEqual(track("guide_ready"), ["done", "active", "todo", "todo", "todo"]);
  assert.deepEqual(track("generated"), ["done", "done", "done", "done", "done"]);
});
