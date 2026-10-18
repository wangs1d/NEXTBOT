import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * POI 负向偏好反馈路由测试（travel 双端①，routes/http/travel-plan.ts 的
 * POST /travel/plans/:planId/poi-feedback）。
 *
 * 用真实 fastify 实例 + inject（不起监听端口）：
 * - 反馈透传画像写入口（actorId = 行程归属 sessionId）
 * - kind→fallbackKind 映射（photo→attraction / food→restaurant）
 * - 无归属会话 409 / 校验失败 400 / 画像服务未装配 503
 *
 * 运行：npx tsx --test test/travel-poi-feedback.test.ts
 */

// 环境变量须在模块导入前设置（travel-plan-store 单例构造时读取）
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "travel-poi-feedback-test-"));
process.env.TRAVEL_PLAN_STORE_DIR = path.join(tmpDir, "plans");

const { travelPlanStore } = await import(
  "../src/skills/travel-planning/travel-plan-store.js"
);
type StoredTravelPlan = import("../src/skills/travel-planning/travel-plan-store.js").StoredTravelPlan;
const { registerTravelPlanRoutes } = await import("../src/routes/http/travel-plan.js");
const { default: Fastify } = await import("fastify");
import type { PlanningService } from "../src/skills/travel-planning/travel-planning-service.js";

/** 桩 PlanningService（本路由域不触达，仅满足必填依赖） */
const stubService = {} as PlanningService;

function buildPlan(planId: string, sessionId?: string): StoredTravelPlan {
  const item = (over: Partial<StoredTravelPlan["days"][number]["items"][number]> = {}) => ({
    type: "attraction",
    name: "默认景点",
    startTime: "2026-08-30T09:00:00",
    latitude: 3.12,
    longitude: 73.22,
    address: "默认地址",
    description: "默认描述",
    ...over,
  });
  return {
    planId,
    ...(sessionId ? { sessionId } : {}),
    destination: "成都",
    title: "成都2日游",
    startDate: "2026-08-30",
    endDate: "2026-08-31",
    createdAt: Date.now(),
    days: [
      { date: "2026-08-30", items: [item({ name: "宽窄巷子", tags: ["古镇", "文化"] })] },
    ],
  } as StoredTravelPlan;
}

/** 画像写入口桩：收集 recordPoiDislike 调用 */
function makeProfilerStub() {
  const calls: Array<{ actorId: string; name: string; tags: string[]; fallbackKind?: string }> = [];
  return {
    calls,
    service: {
      recordPoiDislike: (actorId: string, name: string, tags: string[], fallbackKind?: string) => {
        calls.push({ actorId, name, tags, fallbackKind });
      },
    },
  };
}

function makeApp(profiler?: ReturnType<typeof makeProfilerStub>["service"]) {
  const app = Fastify();
  registerTravelPlanRoutes(app, {
    travelPlanningService: stubService,
    ...(profiler ? { userPersonalizationService: profiler } : {}),
  });
  return app;
}

test("poi-feedback: 反馈透传画像写入口（actorId=行程 sessionId，标签+点名都进）", async () => {
  travelPlanStore.save(buildPlan("pf-1", "actor-a1"));
  const prof = makeProfilerStub();
  const app = makeApp(prof.service);
  const res = await app.inject({
    method: "POST",
    url: "/travel/plans/pf-1/poi-feedback",
    payload: { kind: "photo", name: "宽窄巷子", tags: ["古镇", "文化"] },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true, recorded: "宽窄巷子" });
  assert.equal(prof.calls.length, 1);
  assert.equal(prof.calls[0].actorId, "actor-a1");
  assert.equal(prof.calls[0].name, "宽窄巷子");
  assert.deepEqual(prof.calls[0].tags, ["古镇", "文化"]);
  await app.close();
});

test("poi-feedback: kind 映射 fallbackKind（photo→attraction / food→restaurant）", async () => {
  travelPlanStore.save(buildPlan("pf-2", "actor-a2"));
  const prof = makeProfilerStub();
  const app = makeApp(prof.service);
  await app.inject({
    method: "POST",
    url: "/travel/plans/pf-2/poi-feedback",
    payload: { kind: "food", name: "小龙坎" },
  });
  await app.inject({
    method: "POST",
    url: "/travel/plans/pf-2/poi-feedback",
    payload: { kind: "photo", name: "太古里" },
  });
  assert.equal(prof.calls.length, 2);
  assert.equal(prof.calls[0].fallbackKind, "restaurant");
  assert.deepEqual(prof.calls[0].tags, []);
  assert.equal(prof.calls[1].fallbackKind, "attraction");
  await app.close();
});

test("poi-feedback: 无归属会话 409，不落画像", async () => {
  travelPlanStore.save(buildPlan("pf-3"));
  const prof = makeProfilerStub();
  const app = makeApp(prof.service);
  const res = await app.inject({
    method: "POST",
    url: "/travel/plans/pf-3/poi-feedback",
    payload: { name: "宽窄巷子" },
  });
  assert.equal(res.statusCode, 409);
  assert.equal(prof.calls.length, 0);
  await app.close();
});

test("poi-feedback: 校验失败 400（名称超长）/ 画像服务未装配 503", async () => {
  travelPlanStore.save(buildPlan("pf-4", "actor-a4"));
  const app1 = makeApp(makeProfilerStub().service);
  const bad = await app1.inject({
    method: "POST",
    url: "/travel/plans/pf-4/poi-feedback",
    payload: { name: "x".repeat(61) },
  });
  assert.equal(bad.statusCode, 400);
  await app1.close();

  const app2 = makeApp();
  const noDep = await app2.inject({
    method: "POST",
    url: "/travel/plans/pf-4/poi-feedback",
    payload: { name: "宽窄巷子" },
  });
  assert.equal(noDep.statusCode, 503);
  await app2.close();
});
