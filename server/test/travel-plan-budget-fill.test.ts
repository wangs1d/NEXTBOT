import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 预算卡自由填写测试（travel-plan-session）。
 *
 * 产品口径：预算问题除四个档位选项外，必须留一个「直接填大概预算」的入口
 * （输入框 + 就用这个），用户可以不选档位、只填金额作答；自报金额由编排器
 * 补写成「自报¥N · 档位」，下游 budgetTierHintOf 靠档位词落到引擎档。
 *
 * 运行：node --import tsx --test test/travel-plan-budget-fill.test.ts
 */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "travel-plan-budget-fill-test-"));
process.env.TRAVEL_PLAN_STORE_DIR = path.join(tmpDir, "plans");
process.env.TRAVEL_SHARE_STORE_FILE = path.join(tmpDir, "share-codes.json");

const { normalizeOrchestration, budgetTierHintOf } = await import(
  "../src/skills/travel-planning/travel-plan-session.js"
);
type PlanSession = import("../src/skills/travel-planning/travel-plan-session.js").PlanSession;

function session(): PlanSession {
  return {
    id: "ps-test",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    originalMessage: "下周末去成都玩三天",
    destination: "成都",
    answers: [],
    history: [],
    ready: false,
    questionTurns: 0,
    draft: null,
    budgetApproved: false,
    weatherSent: false,
    guideSent: false,
  };
}

test("预算卡：LLM 漏给 placeholder/allowNote 时确定性补上自由填写入口", () => {
  const orch = normalizeOrchestration(
    {
      updates: {},
      answerUpdates: {},
      say: "预算上大概想花多少？",
      ready: false,
      question: {
        id: "budget",
        stage: "预算",
        title: "这趟大概想花多少？",
        multi: false,
        options: ["经济", "舒适", "品质", "豪华"],
      },
    },
    session(),
  );
  assert.ok(orch.question);
  assert.equal(orch.question!.id, "budget");
  assert.equal(orch.question!.allowNote, true);
  assert.ok(orch.question!.placeholder, "预算卡必须带填写占位符");
});

test("预算卡：LLM 把 id 写成「预算」也归一成 budget", () => {
  const orch = normalizeOrchestration(
    {
      updates: {},
      answerUpdates: {},
      say: "预算大概什么档？",
      ready: false,
      question: {
        id: "预算",
        stage: "预算",
        title: "预算什么档？",
        multi: false,
        options: ["经济", "舒适"],
      },
    },
    session(),
  );
  assert.ok(orch.question);
  assert.equal(orch.question!.id, "budget");
  assert.equal(orch.question!.allowNote, true);
});

test("非预算卡的 placeholder/allowNote 不被预算兜底污染", () => {
  const orch = normalizeOrchestration(
    {
      updates: {},
      answerUpdates: {},
      say: "哪天出发？",
      ready: false,
      question: {
        id: "days",
        stage: "时间",
        title: "哪天出发？",
        multi: false,
        options: ["10月1日", "10月2日"],
      },
    },
    session(),
  );
  assert.ok(orch.question);
  assert.notEqual(orch.question!.allowNote, true);
  assert.equal(orch.question!.placeholder, undefined);
});

test("budgetTierHintOf：自报金额补写答案靠档位词落到引擎档", () => {
  assert.equal(budgetTierHintOf("自报¥3000 · 舒适"), "预算适中");
  assert.equal(budgetTierHintOf("自报¥8000 · 品质"), "预算高端");
  assert.equal(budgetTierHintOf("舒适"), "预算适中");
  assert.equal(budgetTierHintOf("预算适中"), "预算适中");
  assert.equal(budgetTierHintOf("经济"), "预算经济；住宿经济");
  assert.equal(budgetTierHintOf("人均3000"), null, "纯金额判不出档位时走引擎默认档");
});
