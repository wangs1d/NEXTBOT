/**
 * 路线能力：agent 自主调用「从用户位置到某地 多远/多久」的契约测试（2026-11-05）。
 *
 * 背景：高德 key 接入后，真正把「用户位置 × 目的地」算出来的链路只有行程编排和
 * 日程出发提醒；对话侧旅行工具却要求 from 必填（模型只能编「家」或反问），
 * 且通用 compute-route 走的是无路况 OSRM。本次改造后锁死五条契约：
 *   1. travel.compute-route 起点可省略 → 用客户端实时定位（requestLocation）；
 *   2. 坐标串顺序自适应：模型把 latitude,longitude 原样传进来要能纠正成 lng,lat；
 *   3. 客户端 GPS（WGS-84）送高德前转 GCJ-02；
 *   4. 高德失败才降级兜底，且结果如实标 osrm；
 *   5. 短距 auto 走步行接口，长距走驾车（含实时路况）。
 *
 * 运行：npx tsx --test test/travel-route-capability.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeAmapLocation,
  estimateTravelTime,
} from "../src/services/route-duration-service.js";
import { wgs84ToGcj02 } from "../src/services/reverse-geocode-service.js";
import { createTravelPlanningBuiltinSkills } from "../src/skills/travel-planning/travel-planning-skills.js";
import { createTravelCommuteBuiltinSkills } from "../src/skills/travel-planning/travel-commute-skills.js";
import type { SkillDefinition } from "../src/skills/types.js";

type FetchLike = typeof globalThis.fetch;

type AmapStubOptions = {
  /** 地名 → "lng,lat"；未命中的地名返回 status=0（模拟高德查不到） */
  geocode?: Record<string, string>;
  driving?: { durationSec: number; distanceM: number } | null;
  walking?: { durationSec: number; distanceM: number } | null;
};

type RecordedCall = { url: string; kind: "geocode" | "driving" | "walking" | "other"; origin?: string; destination?: string };

/** 高德三接口的 fetch 桩：按 URL 分派，记录每次调用的入参 */
function stubAmapFetch(opts: AmapStubOptions): { calls: RecordedCall[]; restore: () => void } {
  const original = globalThis.fetch;
  const calls: RecordedCall[] = [];
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    const u = new URL(url);
    const json = (body: unknown) => ({ ok: true, json: async () => body }) as Response;

    if (u.pathname.endsWith("/v3/geocode/geo")) {
      const address = u.searchParams.get("address") ?? "";
      calls.push({ url, kind: "geocode" });
      const hit = opts.geocode?.[address];
      return hit
        ? json({ status: "1", geocodes: [{ location: hit }] })
        : json({ status: "0", info: "INVALID_USER_KEY" });
    }
    if (u.pathname.endsWith("/v3/direction/driving") || u.pathname.endsWith("/v3/direction/walking")) {
      const kind = u.pathname.endsWith("/driving") ? "driving" : "walking";
      const origin = u.searchParams.get("origin") ?? "";
      const destination = u.searchParams.get("destination") ?? "";
      calls.push({ url, kind, origin, destination });
      const spec = kind === "driving" ? opts.driving : opts.walking;
      if (!spec) return json({ status: "0", info: "ENGINE_RESPONSE_DATA_ERROR" });
      return json({
        status: "1",
        route: { paths: [{ duration: String(spec.durationSec), distance: String(spec.distanceM) }] },
      });
    }
    calls.push({ url, kind: "other" });
    return json({});
  }) as FetchLike;

  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function withAmapKey<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env.AMAP_WEB_KEY;
  process.env.AMAP_WEB_KEY = "test-amap-key";
  return fn().finally(() => {
    if (prev === undefined) delete process.env.AMAP_WEB_KEY;
    else process.env.AMAP_WEB_KEY = prev;
  });
}

type AnyHandler = (
  input: Record<string, unknown>,
  ctx: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

function skillOf(skills: SkillDefinition[], name: string): AnyHandler {
  const skill = skills.find((s) => s.metadata.name === name);
  assert.ok(skill, `未找到技能 ${name}`);
  return skill!.handler as unknown as AnyHandler;
}

/** 路线工具只需要 computeRoute（兜底）+ 无天气，其余方法用不到 */
function fakePlanningService(computeRoute?: AnyHandler) {
  return {
    computeRoute:
      computeRoute ??
      (async () => {
        throw new Error("兜底不应被调用");
      }),
  } as unknown as never;
}

const NO_WEATHER = { getBrief: async () => null } as unknown as never;

const LOCATED_CTX = {
  sessionId: "route-test",
  // 北京东城区附近（WGS-84）
  clientLocation: { latitude: 39.9042, longitude: 116.4074, label: "北京市 · 东城区" },
};

// ======================== 坐标顺序 ========================

test("normalizeAmapLocation：纬度,经度 自动纠正为 经度,纬度", () => {
  assert.equal(normalizeAmapLocation("39.9,116.4"), "116.4,39.9");
  assert.equal(normalizeAmapLocation("116.4,39.9"), "116.4,39.9");
  assert.equal(normalizeAmapLocation(" 39.904200 , 116.407400 "), "116.4074,39.9042");
  // 非坐标串 → null（按地名处理）
  assert.equal(normalizeAmapLocation("首都机场T3"), null);
  assert.equal(normalizeAmapLocation("1,2,3"), null);
});

// ======================== travel.compute-route ========================

test("compute-route：from 用「纬度,经度」也能命中正确起点，走高德驾车实时耗时", async () => {
  await withAmapKey(async () => {
    const stub = stubAmapFetch({
      geocode: { "首都机场T3": "116.603,40.079" },
      driving: { durationSec: 2400, distanceM: 36_000 },
    });
    try {
      const route = skillOf(
        createTravelPlanningBuiltinSkills({
          travelPlanningService: fakePlanningService(),
        }),
        "travel.compute-route",
      );
      const res = await route({ from: "39.9,116.4", to: "首都机场T3" }, LOCATED_CTX);

      assert.equal(res.ok, true, JSON.stringify(res));
      assert.equal(res.mode, "driving");
      assert.equal(res.durationMin, 40);
      assert.equal(res.distanceKm, 36);
      assert.equal(res.routeSource, "amap");
      assert.equal(res.originSource, "given");

      const drive = stub.calls.find((c) => c.kind === "driving");
      assert.equal(drive?.origin, "116.4,39.9", "纬度,经度 入参必须纠正后再送高德");
      assert.equal(drive?.destination, "116.603,40.079");
    } finally {
      stub.restore();
    }
  });
});

test("compute-route：不传 from 时按用户实时定位取起点（WGS-84 → GCJ-02）", async () => {
  await withAmapKey(async () => {
    const stub = stubAmapFetch({
      geocode: { "国贸地铁站": "116.461,39.908" },
      driving: { durationSec: 900, distanceM: 6_200 },
    });
    try {
      const route = skillOf(
        createTravelPlanningBuiltinSkills({ travelPlanningService: fakePlanningService() }),
        "travel.compute-route",
      );
      const res = await route({ to: "国贸地铁站" }, LOCATED_CTX);

      assert.equal(res.ok, true, JSON.stringify(res));
      assert.equal(res.originSource, "current-location");
      assert.equal(res.from, "北京市 · 东城区");
      assert.equal(res.durationMin, 15);
      assert.equal(res.distanceKm, 6.2);

      const expected = wgs84ToGcj02(39.9042, 116.4074);
      const drive = stub.calls.find((c) => c.kind === "driving");
      assert.equal(
        drive?.origin,
        `${expected.longitude.toFixed(6)},${expected.latitude.toFixed(6)}`,
        "客户端 GPS 必须转 GCJ-02 再送高德",
      );
    } finally {
      stub.restore();
    }
  });
});

test("compute-route：拿不到定位时如实失败并提示补起点（不编造路线）", async () => {
  await withAmapKey(async () => {
    const stub = stubAmapFetch({ geocode: {}, driving: { durationSec: 600, distanceM: 3000 } });
    try {
      const route = skillOf(
        createTravelPlanningBuiltinSkills({ travelPlanningService: fakePlanningService() }),
        "travel.compute-route",
      );
      const res = await route({ to: "国贸地铁站" }, { sessionId: "no-location" });

      assert.equal(res.ok, false);
      assert.equal(res.needOrigin, true);
      assert.equal(stub.calls.length, 0, "没有起点就不该打外网");
    } finally {
      stub.restore();
    }
  });
});

test("compute-route：高德不可用时降级兜底，并如实标 routeSource=osrm", async () => {
  await withAmapKey(async () => {
    const stub = stubAmapFetch({ geocode: {}, driving: null });
    try {
      const route = skillOf(
        createTravelPlanningBuiltinSkills({
          travelPlanningService: fakePlanningService(async () => ({
            mode: "驾车",
            durationMin: 22,
            distanceKm: 8.4,
          })),
        }),
        "travel.compute-route",
      );
      const res = await route({ from: "望京SOHO", to: "国贸地铁站" }, LOCATED_CTX);

      assert.equal(res.ok, true, JSON.stringify(res));
      assert.equal(res.routeSource, "osrm");
      assert.equal(res.durationMin, 22);
      assert.equal(res.distanceKm, 8.4);
      assert.match(String(res.note), /无实时路况/);
    } finally {
      stub.restore();
    }
  });
});

test("compute-route：短距 auto 走步行接口（避免 1km 被算成开车 3 分钟）", async () => {
  await withAmapKey(async () => {
    const stub = stubAmapFetch({
      geocode: { "便利店": "116.4105,39.9055" },
      driving: { durationSec: 180, distanceM: 900 },
      walking: { durationSec: 720, distanceM: 850 },
    });
    try {
      const route = skillOf(
        createTravelPlanningBuiltinSkills({ travelPlanningService: fakePlanningService() }),
        "travel.compute-route",
      );
      const res = await route({ to: "便利店" }, LOCATED_CTX);

      assert.equal(res.ok, true, JSON.stringify(res));
      assert.equal(res.mode, "walking");
      assert.equal(res.durationMin, 12);
      // 850m 按 100m 精度归一到 0.9km（与 amap 距离精度同口径）
      assert.equal(res.distanceKm, 0.9);
      assert.equal(stub.calls.filter((c) => c.kind === "walking").length, 1);
      assert.equal(stub.calls.filter((c) => c.kind === "driving").length, 0);
    } finally {
      stub.restore();
    }
  });
});

// ======================== travel.departure-advice ========================

test("departure-advice：from 缺省按定位算，并按到达时间倒推最晚出发", async () => {
  await withAmapKey(async () => {
    const stub = stubAmapFetch({
      geocode: { "首都机场T3": "116.603,40.079" },
      driving: { durationSec: 2400, distanceM: 36_000 },
    });
    try {
      const commute = skillOf(
        createTravelCommuteBuiltinSkills({
          travelPlanningService: fakePlanningService() as never,
          weatherService: NO_WEATHER,
        }),
        "travel.departure-advice",
      );
      const res = await commute({ to: "首都机场T3", arriveBy: "2026-11-06 09:00" }, LOCATED_CTX);

      assert.equal(res.ok, true, JSON.stringify(res));
      assert.equal(res.originSource, "current-location");
      assert.equal(res.from, "北京市 · 东城区");
      assert.equal(res.durationMin, 40);
      assert.equal(res.routeSource, "amap");
      // 09:00 - 40 分钟车程 - 10 分钟缓冲
      assert.equal(res.suggestedDeparture, "08:10");
      assert.match(String(res.advice), /车程约 40 分钟/);
      assert.match(String(res.advice), /已按你的当前位置计算/);
    } finally {
      stub.restore();
    }
  });
});

test("departure-advice：from 缺省且无定位 → 不猜起点，请用户说明", async () => {
  await withAmapKey(async () => {
    const stub = stubAmapFetch({ geocode: {}, driving: null });
    try {
      const commute = skillOf(
        createTravelCommuteBuiltinSkills({
          travelPlanningService: fakePlanningService() as never,
          weatherService: NO_WEATHER,
        }),
        "travel.departure-advice",
      );
      const res = await commute({ to: "首都机场T3" }, { sessionId: "no-location" });

      assert.equal(res.ok, false);
      assert.equal(res.needOrigin, true);
      assert.equal(stub.calls.length, 0);
    } finally {
      stub.restore();
    }
  });
});

// ======================== 服务层 ========================

test("estimateTravelTime：无 key 直接返回 null（不抛异常，交给上层引导）", async () => {
  const prev = process.env.AMAP_WEB_KEY;
  delete process.env.AMAP_WEB_KEY;
  try {
    const est = await estimateTravelTime({
      origin: { latitude: 39.9, longitude: 116.4 },
      destination: "首都机场T3",
    });
    assert.equal(est, null);
  } finally {
    if (prev !== undefined) process.env.AMAP_WEB_KEY = prev;
  }
});
