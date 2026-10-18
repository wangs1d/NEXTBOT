import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 导航 arrive 出片时刻提示测试（travel 双端⑤，routes/http/travel-map.ts）。
 *
 * 到达后按站名回查 POI 库 photo 字段（机位/最佳时段）随 arrive 响应带出：
 * - 库里有 photo → 响应含 photoTip
 * - 无 photo / 目的地无缓存 → 不带字段（宁缺毋滥）
 *
 * 运行：npx tsx --test test/travel-nav-photo-tip.test.ts
 */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "travel-nav-photo-tip-"));
process.env.TRAVEL_PLAN_STORE_DIR = path.join(tmpDir, "plans");
// POI 库同样隔离到临时目录：poiCache.set 会整城替换落库，绝不能写真实 data/travel-poi.db
process.env.TRAVEL_POI_DB_DIR = path.join(tmpDir, "poi-db");

const { travelPlanStore } = await import(
  "../src/skills/travel-planning/travel-plan-store.js"
);
type StoredTravelPlan = import("../src/skills/travel-planning/travel-plan-store.js").StoredTravelPlan;
const { poiCache } = await import("../src/skills/travel-planning/poi-cache-manager.js");
const { registerTravelMapRoutes } = await import("../src/routes/http/travel-map.js");
const { default: Fastify } = await import("fastify");

const app = Fastify();
registerTravelMapRoutes(app);

// 行程 + POI 缓存夹具：宽窄巷子有出片字段，人民公园没有
travelPlanStore.save({
  planId: "photo-tip-1",
  sessionId: "actor-pt",
  destination: "成都",
  title: "成都一日",
  startDate: "2026-10-20",
  endDate: "2026-10-20",
  createdAt: Date.now(),
  days: [],
} as StoredTravelPlan);

poiCache.set(
  "成都",
  {
    attractions: [
      {
        id: "poi-kzx",
        name: "宽窄巷子",
        latitude: 30.66,
        longitude: 104.05,
        address: "成都",
        type: "attraction",
        photo: { score: 0.8, spot: "东口牌坊侧面斜拍", bestTime: "16:00 后逆光" },
      },
      {
        id: "poi-rmgy",
        name: "人民公园",
        latitude: 30.66,
        longitude: 104.05,
        address: "成都",
        type: "attraction",
      },
    ],
    hotels: [],
    restaurants: [],
  },
  { latitude: 30.66, longitude: 104.05 },
);

async function createSession(planId: string, firstStop: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/travel-map/nav/session",
    payload: { planId, stops: [{ name: firstStop, lat: 30.66, lng: 104.05 }] },
  });
  assert.equal(res.statusCode, 200);
  return firstStop;
}

test("arrive: 站点有出片字段 → 响应带 photoTip（机位 + 最佳时段）", async () => {
  await createSession("photo-tip-1", "宽窄巷子");
  const res = await app.inject({
    method: "POST",
    url: "/travel-map/nav/arrive",
    payload: { planId: "photo-tip-1" },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.phase, "stay");
  assert.deepEqual(body.photoTip, { spot: "东口牌坊侧面斜拍", bestTime: "16:00 后逆光" });
});

test("arrive: 站点无出片字段 / 无目的地缓存 → 不带 photoTip", async () => {
  await app.inject({
    method: "POST",
    url: "/travel-map/nav/session",
    payload: { planId: "photo-tip-1", stops: [{ name: "人民公园", lat: 30.66, lng: 104.05 }] },
  });
  const noPhoto = await app.inject({
    method: "POST",
    url: "/travel-map/nav/arrive",
    payload: { planId: "photo-tip-1" },
  });
  assert.equal(noPhoto.statusCode, 200);
  assert.equal("photoTip" in noPhoto.json(), false);

  // 目的地未缓存：另一行程
  travelPlanStore.save({
    planId: "photo-tip-2",
    sessionId: "actor-pt2",
    destination: "南极",
    title: "离谱行程",
    createdAt: Date.now(),
    days: [],
  } as StoredTravelPlan);
  await app.inject({
    method: "POST",
    url: "/travel-map/nav/session",
    payload: { planId: "photo-tip-2", stops: [{ name: "极点", lat: -90, lng: 0 }] },
  });
  const noCache = await app.inject({
    method: "POST",
    url: "/travel-map/nav/arrive",
    payload: { planId: "photo-tip-2" },
  });
  assert.equal(noCache.statusCode, 200);
  assert.equal("photoTip" in noCache.json(), false);
});
