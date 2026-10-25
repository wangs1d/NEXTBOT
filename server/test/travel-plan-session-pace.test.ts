import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 规划会话护栏测试：同行人 → 节奏推断（travel-plan-session）。
 *
 * 产品口径：节奏不再单独出一张问题卡问「想怎么玩」——同行人一定就直接给结论
 * （情侣/家人→松弛、朋友→紧凑、独自→均衡），卡片把推断结果显示出来让用户改。
 * 这里锁住两件事：
 * - filterQuestion：同行人已知（点选答过 / 原话说得出来）时拦掉节奏卡；
 * - paceInferForOptions：同行人选项 → 节奏结论，判不出同行人的选项不挂结论。
 *
 * 运行：npx tsx --test test/travel-plan-session-pace.test.ts
 */

// 环境变量须在模块导入前设置（travel-plan-store 单例构造时读取）
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "travel-plan-session-pace-test-"));
process.env.TRAVEL_PLAN_STORE_DIR = path.join(tmpDir, "plans");
process.env.TRAVEL_SHARE_STORE_FILE = path.join(tmpDir, "share-codes.json");

const { filterQuestion, paceInferForOptions } = await import(
  "../src/skills/travel-planning/travel-plan-session.js"
);
type PlanSession = import("../src/skills/travel-planning/travel-plan-session.js").PlanSession;

function session(over: Partial<PlanSession> = {}): PlanSession {
  return {
    id: "ps-test",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    originalMessage: "下周末从北京出发去成都玩三天",
    destination: "成都",
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

const paceQuestion = {
  id: "pace",
  stage: "行程节奏",
  title: "想怎么玩？",
  multi: false,
  options: ["松弛慢逛", "均衡适中", "紧凑多逛"],
};

const partyQuestion = {
  id: "party",
  stage: "同行人",
  title: "这次和谁一起去？",
  multi: false,
  options: ["和伴侣", "和朋友", "带爸妈", "一个人"],
};

test("同行人未知时节奏仍可单独问；同行人已知则拦掉节奏卡", () => {
  assert.ok(filterQuestion(session(), paceQuestion), "同行人未知：节奏卡放行");
  const answered = session({
    answers: [{ id: "party", question: "这次和谁一起去？", answer: "和伴侣" }],
  });
  assert.equal(filterQuestion(answered, paceQuestion), null, "答过同行人：不再问节奏");
});

test("原话里读得出同行人时同样不再问节奏（含非 pace id 的节奏问法）", () => {
  const fromMessage = session({
    originalMessage: "下周末和女朋友去成都玩三天",
  });
  assert.equal(filterQuestion(fromMessage, paceQuestion), null);
  assert.equal(
    filterQuestion(fromMessage, { ...paceQuestion, id: "trip_style", title: "想慢逛还是多打卡？" }),
    null,
    "id 不是 pace 但问的是节奏，一样拦",
  );
});

test("同行人卡本身不受节奏护栏影响，目的地缺失时一律不出卡", () => {
  assert.ok(filterQuestion(session(), partyQuestion), "同行人未答：同行人卡放行");
  assert.equal(
    filterQuestion(session({ destination: undefined }), partyQuestion),
    null,
    "没拿到目的地不出卡",
  );
});

test("paceInferForOptions：同行人选项 → 节奏结论，三档备选可改", () => {
  const infer = paceInferForOptions(["和伴侣", "和朋友", "带爸妈", "一个人"]);
  assert.ok(infer);
  assert.equal(infer["和伴侣"]!.pace, "松弛");
  assert.equal(infer["和朋友"]!.pace, "紧凑");
  assert.equal(infer["带爸妈"]!.pace, "松弛");
  assert.equal(infer["一个人"]!.pace, "均衡");
  assert.equal(infer["和伴侣"]!.detail.includes("2–3 站"), true);
  assert.deepEqual(infer["和朋友"]!.options, ["松弛", "均衡", "紧凑"]);
});

test("判不出同行人的选项不挂推断，全判不出则整张卡不带推断", () => {
  assert.equal(paceInferForOptions(["看心情", "都行"]), undefined);
  const partial = paceInferForOptions(["和朋友", "看心情"]);
  assert.ok(partial);
  assert.deepEqual(Object.keys(partial), ["和朋友"]);
});
