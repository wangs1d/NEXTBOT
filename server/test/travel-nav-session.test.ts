import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";

import {
  AmapWebNavProvider,
  getNavigationProvider,
} from "../src/services/navigation/nav-provider.js";
import {
  NavigationSessionError,
  NavigationSessionService,
} from "../src/services/navigation/navigation-session-service.js";
import { registerTravelMapRoutes } from "../src/routes/http/travel-map.js";

const STOPS = [
  { name: "清水寺", lat: 34.994_856, lng: 135.785_041 },
  { name: "八坂神社", lat: 35.003_713, lng: 135.778_247 },
  { name: "祇园, 晚餐", lat: 35.003_9, lng: 135.774_6 },
];

test("amap provider: full leg url with from/to/mode/coordinate/callnative", () => {
  const url = new AmapWebNavProvider().buildLegUrl({
    from: STOPS[0]!,
    to: STOPS[1]!,
    mode: "walking",
  });
  assert.ok(url.startsWith("https://uri.amap.com/navigation?"));
  assert.ok(url.includes("from=135.785041,34.994856"));
  assert.ok(url.includes(`to=135.778247,35.003713,${encodeURIComponent("八坂神社")}`));
  assert.ok(url.includes("mode=walk"));
  assert.ok(url.includes("coordinate=gaode"));
  assert.ok(url.includes("callnative=0"));
  assert.ok(url.includes("src=PrivateAgent"));
});

test("amap provider: no from when origin unknown, name commas sanitized", () => {
  const url = new AmapWebNavProvider().buildLegUrl({ from: null, to: STOPS[2]! });
  assert.ok(!url.includes("from="));
  // 名称里的逗号必须清掉，否则会破坏 lng,lat,名称 三元组
  assert.ok(!url.includes(encodeURIComponent("祇园,")));
  assert.ok(url.includes(encodeURIComponent("祇园 晚餐")));
});

test("provider registry: unknown id falls back to default amap", () => {
  assert.equal(getNavigationProvider("baidu-x").id, "amap-web");
  assert.equal(getNavigationProvider().id, "amap-web");
  assert.equal(getNavigationProvider("amap-web").id, "amap-web");
});

test("session flow: create → arrive → depart → done, legUrl tracks progress", () => {
  const svc = new NavigationSessionService();
  const s0 = svc.create("plan-1", { stops: STOPS, startIndex: 0, mode: "walking" });
  assert.equal(s0.phase, "going");
  assert.equal(s0.legIndex, 1);
  assert.equal(s0.total, 3);
  // 首段无起点（交给导航源自定位），目标 = 第一站
  assert.ok(s0.legUrl!.includes("to=" + "135.785041"));
  assert.ok(!s0.legUrl!.includes("from="));

  const s1 = svc.arrive("plan-1");
  assert.equal(s1.phase, "stay");
  assert.equal(s1.legUrl, null); // 停留中无导航链接

  const s2 = svc.depart("plan-1");
  assert.equal(s2.phase, "going");
  assert.equal(s2.legIndex, 2);
  // 上一站作起点
  assert.ok(s2.legUrl!.includes("from=135.785041,34.994856"));
  assert.ok(s2.legUrl!.includes(encodeURIComponent("八坂神社")));

  svc.arrive("plan-1");
  const s3 = svc.depart("plan-1");
  assert.equal(s3.legIndex, 3);
  svc.arrive("plan-1");
  const s4 = svc.depart("plan-1"); // 最后一站出发 → done
  assert.equal(s4.phase, "done");
  assert.equal(s4.legUrl, null);
  assert.equal(svc.getActive("plan-1"), null);
});

test("session: skip advances while going; depart before arrive rejected", () => {
  const svc = new NavigationSessionService();
  svc.create("plan-2", { stops: STOPS, startIndex: 0 });
  assert.throws(() => svc.depart("plan-2"), (e: unknown) => {
    assert.ok(e instanceof NavigationSessionError);
    assert.equal(e.status, 409);
    return true;
  });
  const s = svc.skip("plan-2");
  assert.equal(s.legIndex, 2);
  assert.equal(s.phase, "going");

  const s2 = svc.skip("plan-2");
  assert.equal(s2.legIndex, 3);
  const s3 = svc.skip("plan-2");
  assert.equal(s3.phase, "done");
});

test("session: recreate replaces active session; end clears it", () => {
  const svc = new NavigationSessionService();
  svc.create("plan-3", { stops: STOPS, startIndex: 0 });
  const rebuilt = svc.create("plan-3", { stops: STOPS, startIndex: 2 });
  assert.equal(rebuilt.startIdx, 2);
  assert.equal(rebuilt.legIndex, 1);
  assert.equal(rebuilt.total, 1);

  const ended = svc.end("plan-3");
  assert.equal(ended.phase, "done");
  assert.equal(svc.getActive("plan-3"), null);
});

test("session: validation errors", () => {
  const svc = new NavigationSessionService();
  assert.throws(
    () => svc.create("", { stops: STOPS }),
    (e: unknown) => e instanceof NavigationSessionError && e.status === 400,
  );
  assert.throws(
    () => svc.create("plan-4", { stops: [] }),
    (e: unknown) => e instanceof NavigationSessionError && e.status === 400,
  );
  assert.throws(
    () => svc.create("plan-4", { stops: [{ name: "x", lat: 999, lng: 0 }] }),
    (e: unknown) => e instanceof NavigationSessionError && e.status === 400,
  );
  assert.throws(
    () => svc.arrive("plan-missing"),
    (e: unknown) => e instanceof NavigationSessionError && e.status === 404,
  );
});

test("session: startIndex clamped into range", () => {
  const svc = new NavigationSessionService();
  const s = svc.create("plan-5", { stops: STOPS, startIndex: 99 });
  assert.equal(s.startIdx, STOPS.length - 1);
  assert.equal(s.curIdx, STOPS.length - 1);
});

test("nav routes: create → arrive → restore → depart → end over HTTP", async () => {
  const app = Fastify();
  registerTravelMapRoutes(app);
  const created = await app.inject({
    method: "POST",
    url: "/travel-map/nav/session",
    payload: { planId: "plan-9", stops: STOPS, startIndex: 0, mode: "walking" },
  });
  assert.equal(created.statusCode, 200);
  const body = created.json();
  assert.equal(body.phase, "going");
  assert.ok(String(body.legUrl).includes("uri.amap.com/navigation"));

  const arrived = await app.inject({
    method: "POST",
    url: "/travel-map/nav/arrive",
    payload: { planId: "plan-9" },
  });
  assert.equal(arrived.json().phase, "stay");

  // 页面从高德网页返回重载后按 planId 恢复
  const restored = await app.inject({
    method: "GET",
    url: "/travel-map/nav/session?planId=plan-9",
  });
  assert.equal(restored.json().session.phase, "stay");

  const departed = await app.inject({
    method: "POST",
    url: "/travel-map/nav/depart",
    payload: { planId: "plan-9" },
  });
  assert.equal(departed.json().phase, "going");
  assert.equal(departed.json().legIndex, 2);

  const ended = await app.inject({
    method: "POST",
    url: "/travel-map/nav/end",
    payload: { planId: "plan-9" },
  });
  assert.equal(ended.json().phase, "done");
  const gone = await app.inject({
    method: "GET",
    url: "/travel-map/nav/session?planId=plan-9",
  });
  assert.equal(gone.json().session, null);
  await app.close();
});

test("nav routes: unknown action → 404; invalid stops → 400", async () => {
  const app = Fastify();
  registerTravelMapRoutes(app);
  const bad = await app.inject({
    method: "POST",
    url: "/travel-map/nav/nope",
    payload: { planId: "p" },
  });
  assert.equal(bad.statusCode, 404);
  const invalid = await app.inject({
    method: "POST",
    url: "/travel-map/nav/session",
    payload: { planId: "p", stops: [] },
  });
  assert.equal(invalid.statusCode, 400);
  await app.close();
});
