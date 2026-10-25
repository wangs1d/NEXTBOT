/**
 * 目的地串味回归（2026-10-24 真机实测）。
 *
 * 事故形态：用户说「帮我规划三亚3天…从成都出发坐高铁还是飞机你帮我比一下」，
 * 模型把**出发地**成都填进了 travel.plan-itinerary 的 destination，于是整份行程
 * 按成都排站（宽窄巷子/都江堰/川西竹海），用户点名的蜈支洲岛、西岛只在候选池里
 * 挂了个名，一天都没进去。
 *
 * 两层防线各自的可测契约：
 *   1. 确定性嗅探：原话里「从X出发 / X到Y」的 X 是出发地，不是目的地；
 *   2. 技能入口：模型参数与原话字面证据冲突时，以原话为准。
 */
import test from "node:test";
import assert from "node:assert/strict";

const { composeTravelPlanRequest } = await import("../src/agent/realtime-search-query.js");
const { createTravelPlanningBuiltinSkills } = await import(
  "../src/skills/travel-planning/travel-planning-skills.js"
);

const INCIDENT_TEXT =
  "帮我规划三亚3天，想住海边，必须去蜈支洲岛和西岛，从成都出发坐高铁还是飞机你帮我比一下，另外哪些景点需要提前预约也告诉我";

// ── 1. 确定性嗅探 ────────────────────────────────────────────

test("嗅探：出发地不抢目的地（三亚/成都同句事故原话）", () => {
  const r = composeTravelPlanRequest(INCIDENT_TEXT);
  assert.equal(r.destination, "三亚");
  assert.equal(r.days, 3);
});

test("嗅探：从X出发去Y / X到Y 都取 Y", () => {
  assert.equal(composeTravelPlanRequest("从成都出发去三亚3天").destination, "三亚");
  assert.equal(composeTravelPlanRequest("成都到三亚4天").destination, "三亚");
  assert.equal(composeTravelPlanRequest("我在上海想去杭州2天").destination, "杭州");
});

test("嗅探：意愿动词不粘进地名（旧实现抽出「上海想」这类脏词）", () => {
  const dest = composeTravelPlanRequest("我想去大理玩3天").destination;
  assert.equal(dest, "大理");
  assert.ok(!/想|从|在/.test(dest ?? ""), `目的地不该带连接词，实际 ${dest}`);
});

test("嗅探：只有一个候选且形似出发地时仍返回它（宁可次优，不能没有）", () => {
  assert.equal(composeTravelPlanRequest("去成都玩5天，喜欢美食和古迹").destination, "成都");
  assert.equal(composeTravelPlanRequest("从成都出发").destination, "成都");
});

// ── 2. 技能入口的目的地守卫 ──────────────────────────────────

type PlanningRequest = { input?: string; destination?: string; days?: number };

function planHandler() {
  const captured: PlanningRequest[] = [];
  const skills = createTravelPlanningBuiltinSkills({
    travelPlanningService: {
      generateItinerary: async (req: PlanningRequest) => {
        captured.push(req);
        throw new Error("stub：只验入参，规划本体由其他用例覆盖");
      },
    } as never,
  });
  const skill = skills.find((s) => s.metadata.name === "travel.plan-itinerary");
  assert.ok(skill, "应存在 travel.plan-itinerary 技能");
  return {
    captured,
    run: (input: Record<string, unknown>) =>
      skill!.handler(input as Record<string, unknown>, { sessionId: "s-guard" } as never),
  };
}

test("守卫：模型把出发地当 destination 传进来时，以原话里的三亚为准", async () => {
  const h = planHandler();
  await h.run({ input: INCIDENT_TEXT, destination: "成都", days: 3 });
  assert.equal(h.captured.length, 1);
  assert.equal(h.captured[0].destination, "三亚", "原话字面证据应压过模型的二手转述");
});

test("守卫：模型与原话一致时不动；原话抽不出目的地时保留模型参数", async () => {
  const h = planHandler();
  await h.run({ input: INCIDENT_TEXT, destination: "三亚" });
  assert.equal(h.captured[0].destination, "三亚");

  await h.run({ input: "就按你想的排，帮我把行程定下来", destination: "大理" });
  assert.equal(h.captured[1].destination, "大理", "纯指代轮不该被嗅探器改写");

  await h.run({ input: INCIDENT_TEXT });
  assert.equal(h.captured[2].destination, undefined, "模型没传时不擅自注入（沿用既有契约）");
});

test("守卫：同族写法（云南大理 vs 大理）不算冲突", async () => {
  const h = planHandler();
  await h.run({ input: "规划云南大理4天", destination: "大理" });
  assert.equal(h.captured[0].destination, "大理");
});

test("守卫：非热门但字面干净的地名（兴义）也能压过出发地", async () => {
  const h = planHandler();
  await h.run({ input: "帮我规划兴义3天，从成都出发", destination: "成都" });
  assert.equal(h.captured[0].destination, "兴义");
  assert.equal(composeTravelPlanRequest("帮我规划兴义3天，从成都出发").destination, "兴义");
});
