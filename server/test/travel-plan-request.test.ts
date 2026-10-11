/**
 * travel_planning 确定性请求构造器单测（2026-10-10 P1）。
 *
 * 契约：路由判 travel_planning 后，travel.plan-itinerary 的调用参数由纯代码
 * 构造（与 composeMediaSearchQuery 同构的确定性半边）。input 恒为用户原话；
 * destination/days 是代码可确定性抽取的结构化增量；抽不出则缺省（agent-core
 * 按「无目的地不预执行」处理，回退模型自决 + 出口闸兜底）。
 */
import assert from "node:assert/strict";
import test from "node:test";

const { composeTravelPlanRequest } = await import("../src/agent/realtime-search-query.js");
const { INTENT_ROUTING_TABLE, parseIntentJson } = await import("../src/agent/intent-router.js");

test("真机事故轮原话：马尔代夫一周游 → 目的地+7天", () => {
  const r = composeTravelPlanRequest("帮我规划一下去马尔代夫游玩一个星期左右的行程");
  assert.equal(r.input, "帮我规划一下去马尔代夫游玩一个星期左右的行程");
  assert.equal(r.destination, "马尔代夫");
  assert.equal(r.days, 7);
});

test("「去成都玩5天，喜欢美食和古迹」→ 成都+5天", () => {
  const r = composeTravelPlanRequest("去成都玩5天，喜欢美食和古迹");
  assert.equal(r.destination, "成都");
  assert.equal(r.days, 5);
});

test("「周末去兴义玩」→ 兴义+2天（周末不当目的地）", () => {
  const r = composeTravelPlanRequest("周末去兴义玩");
  assert.equal(r.destination, "兴义");
  assert.equal(r.days, 2);
});

test("「三天两夜去大理怎么安排」→ 大理+3天", () => {
  const r = composeTravelPlanRequest("三天两夜去大理怎么安排");
  assert.equal(r.destination, "大理");
  assert.equal(r.days, 3);
});

test("「下周去三亚玩五天」→ 出发时间不污染目的地", () => {
  const r = composeTravelPlanRequest("下周去三亚玩五天");
  assert.equal(r.destination, "三亚");
  assert.equal(r.days, 5);
});

test("纯指代轮：无目的地 → destination 缺省（不预执行信号），input 保留", () => {
  const r = composeTravelPlanRequest("帮我规划个行程");
  assert.equal(r.input, "帮我规划个行程");
  assert.equal(r.destination, undefined);
  assert.equal(r.days, undefined);
});

test("上下文实体兜底：纯指代轮从最近对话消解出目的地", () => {
  const r = composeTravelPlanRequest("帮我规划个五天的行程", [
    "用户问：三亚有哪些必去景点",
    "助手答：三亚的景点很多。",
  ]);
  assert.ok(r.destination, `应从上下文消解出目的地，实际: ${JSON.stringify(r)}`);
  assert.equal(r.days, 5);
});

test("空输入 → 空请求", () => {
  assert.deepEqual(composeTravelPlanRequest(""), { input: "" });
});

test("路由表：travel_planning → 任务面 full 束 / budget 3 / flash", () => {
  assert.deepEqual(INTENT_ROUTING_TABLE.travel_planning, {
    plane: "task",
    capabilities: ["full"],
    budget: 3,
    tier: "flash",
  });
});

test("别名解析：travel_plan / trip / itinerary 都归 travel_planning", () => {
  for (const raw of ["travel_planning", "travel_plan", "trip", "itinerary", "travel"]) {
    const parsed = parseIntentJson(`{"intent":"${raw}","confidence":0.9}`);
    assert.equal(parsed?.intent, "travel_planning", `别名 ${raw} 应归 travel_planning`);
  }
});
