import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * travel.edit-itinerary 工具（B1）+ 存储版本自增（A6）行为验证。
 * remove/update 不依赖外部网络；replace 依赖 PlanningService（此处用桩验证回执）。
 */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "travel-edit-skill-test-"));
process.env.TRAVEL_PLAN_STORE_DIR = tmpDir;

/** 行程归属用户（真实 actorId 为裸邮箱），HTTP 侧用 userId 传入 */
const TEST_ACTOR = "tester@example.com";

const { travelPlanStore } = await import(
  "../src/skills/travel-planning/travel-plan-store.js"
);
const { createTravelPlanningBuiltinSkills } = await import(
  "../src/skills/travel-planning/travel-planning-skills.js"
);

function buildPlan(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    planId: "plan-edit-1",
    actorId: TEST_ACTOR,
    destination: "三亚",
    title: "三亚2日游",
    startDate: "2026-09-06",
    endDate: "2026-09-07",
    createdAt: Date.now(),
    days: [
      {
        date: "2026-09-06",
        items: [
          { type: "hotel", name: "亚龙湾酒店", startTime: "2026-09-06 14:00", latitude: 18.2, longitude: 109.6, address: "亚龙湾", priceInfo: "¥1,200/晚", description: "海景" },
          { type: "attraction", name: "天涯海角", startTime: "2026-09-06 10:00", latitude: 18.3, longitude: 109.3, address: "天涯区", priceInfo: "¥80", description: "" },
        ],
      },
      {
        date: "2026-09-07",
        items: [
          { type: "restaurant", name: "第一市场海鲜", startTime: "2026-09-07 12:00", latitude: 18.24, longitude: 109.5, address: "解放路", priceInfo: "人均¥150", description: "" },
        ],
      },
    ],
    ...overrides,
  };
}

/** 最小 PlanningService 桩：remove/update 不触达服务，replace 由桩返回固定替代 */
const stubService = {
  findAlternativePoi: async (_type: string, _lat: number, _lon: number, _exclude: string, _comment?: string) => ({
    id: "poi-1",
    name: "大东海沙滩",
    latitude: 18.21,
    longitude: 109.51,
    address: "大东海",
    type: "attraction",
    tags: ["海滩"],
    raw: { source: "overpass" },
  }),
  describePoi: () => "风景优美的市区海滩",
} as never;

function getEditHandler(): (input: Record<string, unknown>) => Promise<Record<string, unknown>> {
  const skills = createTravelPlanningBuiltinSkills({
    travelPlanningService: stubService,
  });
  const edit = skills.find((s) => s.metadata.name === "travel.edit-itinerary");
  assert.ok(edit, "edit-itinerary skill 应已注册");
  const ctx = { userId: TEST_ACTOR, sessionId: TEST_ACTOR } as never;
  return ((input: Record<string, unknown>) => edit.handler(input, ctx)) as (
    input: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
}

test("edit-itinerary: update 修改字段并保存，version 自增", async () => {
  travelPlanStore.save(buildPlan());
  const handler = getEditHandler();
  const r = await handler({
    planId: "plan-edit-1",
    action: "update",
    day: 1,
    item: 2,
    patch: { startTime: "2026-09-06 09:30", priceInfo: "¥100" },
  });
  assert.equal(r.ok, true);
  const plan = travelPlanStore.get("plan-edit-1");
  assert.equal(plan?.days[0].items[1].startTime, "2026-09-06 09:30");
  assert.equal(plan?.days[0].items[1].priceInfo, "¥100");
  // 初始保存 version=1，本次编辑自增到 2
  assert.equal(plan?.version, 2);
});

test("edit-itinerary: remove 删除条目并同步结构化快照", async () => {
  const handler = getEditHandler();
  const r = await handler({ planId: "plan-edit-1", action: "remove", day: 2, item: 1 });
  assert.equal(r.ok, true);
  const plan = travelPlanStore.get("plan-edit-1");
  assert.equal(plan?.days[1].items.length, 0);
  // 快照刷新：edit-itinerary 工具名 + 改后天数据
  const { travelItineraryStore } = await import(
    "../src/skills/travel-planning/travel-itinerary-store.js"
  );
  const snap = travelItineraryStore.get();
  assert.equal(snap?.toolName, "travel.edit-itinerary");
  assert.equal(snap?.planId, "plan-edit-1");
  assert.equal(snap?.days[1].items.length, 0);
});

test("edit-itinerary: 越界定位与未知动作返回可读错误", async () => {
  const handler = getEditHandler();
  const r1 = await handler({ planId: "plan-edit-1", action: "remove", day: 5, item: 1 });
  assert.equal(r1.ok, false);
  assert.match(String(r1.error), /定位失败/);
  const r2 = await handler({ planId: "plan-edit-1", action: "destory", day: 1, item: 1 });
  assert.equal(r2.ok, false);
  assert.match(String(r2.error), /未知动作/);
  const r3 = await handler({ planId: "plan-not-exist", action: "remove", day: 1, item: 1 });
  assert.equal(r3.ok, false);
  assert.match(String(r3.error), /行程不存在/);
});

test("plan store: version 每次保存自增（乐观锁基准）", async () => {
  travelPlanStore.save(buildPlan({ planId: "plan-version-check" }));
  const v1 = travelPlanStore.get("plan-version-check")?.version;
  travelPlanStore.save({ ...(buildPlan({ planId: "plan-version-check" })) } as never);
  const v2 = travelPlanStore.get("plan-version-check")?.version;
  assert.equal(v1, 1);
  assert.equal(v2, 2);
});

// ==================== HTTP 路由域：add 端点 + 编辑后局部重排 ====================

const { registerTravelPlanRoutes } = await import("../src/routes/http/travel-plan.js");
const Fastify = (await import("fastify")).default;

/** HTTP 侧桩：searchPois 定位 + retimeDayAfterEdit 确定性改写 startTime（验证重排被真实调用） */
const httpStubService = {
  searchPois: async (_dest: string, type: string, kw?: string) => [
    {
      name: kw === "亚特兰蒂斯" ? "亚特兰蒂斯水世界" : `${type}-候选A`,
      type,
      latitude: 18.25,
      longitude: 109.52,
      address: "海棠区",
      priceInfo: "¥0",
      tags: ["测试"],
    },
  ],
  findAlternativePoi: async () => ({
    id: "poi-x",
    name: "蜈支洲岛",
    latitude: 18.31,
    longitude: 109.76,
    address: "海棠湾",
    type: "attraction",
    tags: ["海岛"],
  }),
  describePoi: () => "测试描述",
  retimeDayAfterEdit: async (items: Array<{ startTime: string; type: string }>, fromIdx: number) => {
    for (let i = fromIdx; i < items.length; i++) {
      if (items[i]!.type !== "hotel") items[i]!.startTime = "20:30";
    }
    return { dayEndMin: 20 * 60 + 30 + 75 };
  },
} as never;

function buildHttpApp() {
  const app = Fastify({ logger: false });
  registerTravelPlanRoutes(app, { travelPlanningService: httpStubService });
  return app;
}

test("HTTP POST items: 新增条目追加并触发局部重排", async () => {
  travelPlanStore.save(buildPlan({ planId: "plan-http-add" }));
  const app = buildHttpApp();
  const res = await app.inject({
    method: "POST",
    url: `/travel/plans/plan-http-add/days/1/items?userId=${encodeURIComponent(TEST_ACTOR)}`,
    payload: { type: "attraction", name: "亚特兰蒂斯" },
  });
  assert.equal(res.statusCode, 200);
  const plan = travelPlanStore.get("plan-http-add");
  const last = plan?.days[1]!.items.at(-1);
  assert.equal(last?.name, "亚特兰蒂斯水世界");
  // 桩把重排起点起的 startTime 改写为 20:30 → 证明重排被真实调用
  assert.equal(last?.startTime, "20:30");
  await app.close();
});

test("HTTP POST items: 乐观锁 If-Match 版本不符返回 409", async () => {
  const app = buildHttpApp();
  const res = await app.inject({
    method: "POST",
    url: `/travel/plans/plan-http-add/days/1/items?userId=${encodeURIComponent(TEST_ACTOR)}`,
    payload: { type: "restaurant", name: "随便" },
    headers: { "if-match": "999" },
  });
  assert.equal(res.statusCode, 409);
  await app.close();
});

test("HTTP comment 换一换: 替换后触发局部重排", async () => {
  travelPlanStore.save(buildPlan({ planId: "plan-http-comment" }));
  const app = buildHttpApp();
  const res = await app.inject({
    method: "POST",
    url: `/travel/plans/plan-http-comment/days/0/items/1/comment?userId=${encodeURIComponent(TEST_ACTOR)}`,
    payload: { comment: "太远了换一个" },
  });
  assert.equal(res.statusCode, 200);
  const plan = travelPlanStore.get("plan-http-comment");
  const replaced = plan?.days[0]!.items[1];
  assert.equal(replaced?.name, "蜈支洲岛");
  // 替换条目及其后条目 startTime 均被重排改写
  assert.equal(replaced?.startTime, "20:30");
  await app.close();
});
