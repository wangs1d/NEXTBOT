import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 满意门（travel 主线 F5，预订后置）。
 *
 * 用户拍板的顺序是「规划好 → 用户满意 → 才谈预订」。这条顺序不能只写在
 * 提示词里靠模型自觉：拦点放在预订工具入口，定稿放在显式动作上，
 * 于是「刚排完就顺手下单」会被工具层拒绝，而不是靠运气。
 */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "travel-approval-test-"));
process.env.TRAVEL_PLAN_STORE_DIR = tmpDir;

const { travelPlanStore } = await import(
  "../src/skills/travel-planning/travel-plan-store.js"
);
const { satisfactionGate } = await import(
  "../src/tools/capability-modules/travel-booking/handlers.js"
);
const { createTravelPlanningBuiltinSkills } = await import(
  "../src/skills/travel-planning/travel-planning-skills.js"
);
const { buildTravelBriefCardBlock } = await import(
  "../src/services/deterministic-card-chain.js"
);

function savePlan(planId: string, destination: string, overrides: Record<string, unknown> = {}) {
  travelPlanStore.save({
    planId,
    destination,
    title: `${destination}3日游`,
    startDate: "2026-11-02",
    endDate: "2026-11-04",
    createdAt: Date.now(),
    days: [
      {
        date: "2026-11-02",
        items: [
          {
            type: "attraction",
            name: "武侯祠",
            startTime: "2026-11-02T09:30:00",
            latitude: 30.6,
            longitude: 104.0,
            address: "武侯区",
            priceInfo: "",
            description: "",
          },
        ],
      },
    ],
    ...overrides,
  } as never);
}

function approveSkill() {
  const skills = createTravelPlanningBuiltinSkills({ travelPlanningService: {} as never });
  const skill = skills.find((s) => s.metadata.name === "travel.approve-plan");
  assert.ok(skill, "travel.approve-plan 应已注册");
  return skill!;
}

// ==================== 预订闸 ====================

test("没规划过这个城市：预订照走，不拦（满意门不是无差别闸）", () => {
  assert.equal(satisfactionGate({ type: "hotel", city: "拉萨" }), null);
});

test("刚规划过且没定稿：报价与下单一起拦下，并点名定稿工具", () => {
  savePlan("plan-gate-1", "西昌");
  const gate = satisfactionGate({ type: "hotel", city: "西昌", checkInDate: "2026-11-02" });
  assert.ok(gate);
  assert.equal(gate.needApproval, true);
  assert.equal(gate.planId, "plan-gate-1");
  assert.match(String(gate.summary), /travel\.approve-plan/);
  // 下单阶段同样拦（不能因为已经拿到报价就绕过）
  const bookGate = satisfactionGate({
    type: "hotel",
    city: "西昌",
    optionId: "opt-1",
    confirm: true,
    confirmationToken: "t",
  });
  assert.equal(bookGate?.needApproval, true);
});

test("酒店没填 city 时用 to 兜底判定（目的地就是 to）", () => {
  savePlan("plan-gate-2", "西昌");
  assert.ok(satisfactionGate({ type: "hotel", to: "西昌" }));
});

test("定稿后放行；已定稿行程重复订也放行", async () => {
  savePlan("plan-gate-3", "眉山地方的城");
  assert.ok(satisfactionGate({ type: "train", from: "成都", to: "眉山地方的城", city: "眉山地方的城" }));
  const out = await approveSkill().handler!({ planId: "plan-gate-3" });
  assert.equal(out.ok, true);
  assert.equal(satisfactionGate({ type: "hotel", city: "眉山地方的城" }), null);
});

test("三天前排过的行程不拦住今天单独订酒店（窗口只认刚规划完的）", () => {
  savePlan("plan-gate-4", "凉山西昌市", { createdAt: Date.now() - 3 * 24 * 60 * 60 * 1000 });
  assert.equal(satisfactionGate({ type: "hotel", city: "凉山西昌市" }), null);
});

// ==================== 定稿动作 ====================

test("travel.approve-plan：缺 planId 按目的地定位，再缺取最近一份", async () => {
  savePlan("plan-ap-1", "都江堰", { createdAt: Date.now() - 60_000 });
  savePlan("plan-ap-2", "青城山", { createdAt: Date.now() });

  const byDest = await approveSkill().handler!({ destination: "都江堰" });
  assert.equal(byDest.planId, "plan-ap-1");
  assert.equal(travelPlanStore.get("plan-ap-1")?.status, "approved");

  const latest = await approveSkill().handler!({});
  assert.equal(latest.planId, "plan-ap-2");
  assert.match(String(latest.next), /travel_booking\.search/);

  const again = await approveSkill().handler!({ planId: "plan-ap-2" });
  assert.equal(again.ok, true);
  assert.match(String(again.summary), /此前已确认/);
});

test("指名的 planId 找不到就如实失败，不顺手定稿别的行程", async () => {
  savePlan("plan-ap-keep", "已定稿别城");
  const out = await approveSkill().handler!({ planId: "plan-does-not-exist" });
  assert.equal(out.ok, false);
  assert.equal(travelPlanStore.get("plan-ap-keep")?.status, undefined);
});

// ==================== 简报卡上的定稿按钮 ====================

test("草案版简报卡给一颗「满意了，按这个订」；已定稿版不再给", () => {
  savePlan("plan-brief-draft", "AB城");
  const draftBlock = buildTravelBriefCardBlock(travelPlanStore.get("plan-brief-draft")!);
  assert.ok(draftBlock);
  assert.match(draftBlock!, /"label":"这版我满意了，就按这个订"/);

  travelPlanStore.approvePlan("plan-brief-draft");
  const approvedBlock = buildTravelBriefCardBlock(travelPlanStore.get("plan-brief-draft")!);
  assert.ok(approvedBlock);
  assert.doesNotMatch(approvedBlock!, /这版我满意了/);
});
