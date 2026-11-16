/**
 * geo.* 工具单测（2026-11-13 新增）。
 *
 * 覆盖：
 *   1. geo.place_search：参数校验、AMAP key 缺失时的诚实失败
 *   2. geo.distance：坐标缺失/地名检索失败时的诚实失败
 *   3. 坐标系统一：WGS-84 用户坐标与 GCJ-02 地点坐标混比必须先转换
 *      （不转换会有 50~500m 误差 —— 在「离某地多远」问题上就是错的答案）
 *   4. 诚实失败：不允许用 0,0 或猜测坐标兜底
 *
 * 测试封闭：注入 fetch stub，不打真实外网。
 */

import assert from "node:assert/strict";
import test from "node:test";

import { registerGeoTools } from "../src/tools/geo-tools.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";

const AMAP_KEY = "test-key";
const GEOFENCE_ORIGIN = { geolocation: "x" };

/** 构造一个 stub 高德：按 URL 里有没有 place/text 决定返回哪组 POI。 */
function installAmapStub(
  options: {
    text?: Array<{ name: string; location: string; address?: string }>;
    around?: Array<{ name: string; location: string; address?: string }>;
  },
): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const isAround = url.includes("/place/around");
    const list = isAround ? (options.around ?? []) : (options.text ?? []);
    // 关键词检索按查询词过滤：同名工具会分别查 from 与 to，
    // 不做区分的话两个查询会拿到同一组 POI。
    let picked = list;
    try {
      const kw = new URL(url).searchParams.get("keywords");
      if (kw) {
        const hit = list.filter((p) => p.name.includes(kw) || kw.includes(p.name));
        if (hit.length > 0) picked = hit;
      }
    } catch {
      picked = list;
    }
    const pois = picked.map((p) => ({
      name: p.name,
      address: p.address ?? "",
      location: p.location,
      type: "商务住宅",
      cityname: "黔西南布依族苗族自治州",
    }));
    return new Response(
      JSON.stringify({ status: "1", pois }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

function makeRegistry() {
  const registry = new ToolRegistry();
  const prevKey = process.env.AMAP_WEB_KEY;
  process.env.AMAP_WEB_KEY = AMAP_KEY;
  registerGeoTools(registry, {});
  return {
    registry,
    restore: () => {
      if (prevKey === undefined) delete process.env.AMAP_WEB_KEY;
      else process.env.AMAP_WEB_KEY = prevKey;
    },
  };
}

const ctx = { sessionId: "s1", userId: "u1" } as never;

test("geo.place_search：命中返回 GCJ-02 坐标与地址", async () => {
  const restoreFetch = installAmapStub({
    text: [{ name: "九华苑", location: "104.893425,25.060232", address: "永康路与文教二路交叉口西220米" }],
  });
  const { registry, restore } = makeRegistry();
  try {
    const r = await registry.execute("geo.place_search", { keywords: "九华苑", city: "兴义" }, ctx);
    assert.equal(r.result.ok, true);
    const places = r.result.places as Array<{ name: string; latitude: number; longitude: number }>;
    assert.equal(places.length, 1);
    assert.equal(places[0]!.name, "九华苑");
    assert.equal(places[0]!.latitude, 25.060232);
    assert.equal(places[0]!.longitude, 104.893425);
    assert.equal(r.result.coordSystem, "gcj02");
  } finally {
    restoreFetch();
    restore();
  }
});

test("geo.place_search：缺少 keywords → 诚实失败", async () => {
  const { registry, restore } = makeRegistry();
  try {
    const r = await registry.execute("geo.place_search", {}, ctx);
    assert.equal(r.result.ok, false);
    assert.match(String(r.result.error), /keywords/);
  } finally {
    restore();
  }
});

test("geo.place_search：查无地点 → 诚实失败并提示换关键词（不编坐标）", async () => {
  const restoreFetch = installAmapStub({ text: [] });
  const { registry, restore } = makeRegistry();
  try {
    const r = await registry.execute("geo.place_search", { keywords: "不存在的地方XYZ" }, ctx);
    assert.equal(r.result.ok, false);
    assert.match(String(r.result.error), /未找到/);
    assert.match(String(r.result.hint), /不要凭记忆猜坐标/);
  } finally {
    restoreFetch();
    restore();
  }
});

test("geo.distance：坐标缺失且无地名 → 诚实失败（不用 0,0 兜底）", async () => {
  const { registry, restore } = makeRegistry();
  try {
    const r = await registry.execute("geo.distance", {}, ctx);
    assert.equal(r.result.ok, false);
    assert.match(String(r.result.error), /终点/);
  } finally {
    restore();
  }
});

test("geo.distance：终点地名查无 → 诚实失败", async () => {
  const restoreFetch = installAmapStub({ text: [] });
  const { registry, restore } = makeRegistry();
  try {
    const r = await registry.execute("geo.distance", { to: "不存在的地方XYZ" }, ctx);
    assert.equal(r.result.ok, false);
    assert.match(String(r.result.error), /未找到/);
  } finally {
    restoreFetch();
    restore();
  }
});

test("geo.distance：AMAP key 缺失 → 诚实失败而非静默返回错距离", async () => {
  const registry = new ToolRegistry();
  const prevKey = process.env.AMAP_WEB_KEY;
  delete process.env.AMAP_WEB_KEY;
  try {
    registerGeoTools(registry, {});
    const r = await registry.execute("geo.distance", { to: "九华苑" }, ctx);
    assert.equal(r.result.ok, false);
    assert.match(String(r.result.error), /AMAP_WEB_KEY/);
  } finally {
    if (prevKey !== undefined) process.env.AMAP_WEB_KEY = prevKey;
  }
});

test("geo.distance：WGS-84 用户坐标与 GCJ-02 地点坐标混比 → 自动统一坐标系", async () => {
  // 九华苑（高德 GCJ-02）
  const restoreFetch = installAmapStub({
    text: [{ name: "九华苑", location: "104.893425,25.060232" }],
  });
  const { registry, restore } = makeRegistry();
  try {
    // 用户真实位置（WGS-84，与九华苑相距约 300m）
    const r = await registry.execute(
      "geo.distance",
      {
        fromLatitude: 25.062799956069178,
        fromLongitude: 104.8924159251335,
        to: "九华苑",
      },
      ctx,
    );
    assert.equal(r.result.ok, true);
    const meters = Number(r.result.distanceMeters);
    // 真实距离 ≈ 300m。若未做坐标系统一，会算成 ≈ 0m（两坐标直接混比）。
    assert.ok(meters > 100 && meters < 600, `距离应在 100~600m，实际 ${meters}m`);
    assert.equal(r.result.coordSystem, "gcj02");
  } finally {
    restoreFetch();
    restore();
  }
});

test("geo.distance：两个地名互算时不得对高德坐标二次转换", async () => {
  const restoreFetch = installAmapStub({
    text: [
      { name: "九华苑", location: "104.893425,25.060232" },
      { name: "兴义万峰林机场", location: "104.961777,25.082489" },
    ],
  });
  const { registry, restore } = makeRegistry();
  try {
    const r = await registry.execute(
      "geo.distance",
      { from: "九华苑", to: "兴义万峰林机场" },
      ctx,
    );
    assert.equal(r.result.ok, true);
    const from = r.result.from as { latitude: number };
    const to = r.result.to as { latitude: number };
    // 起点必须是高德原始坐标（25.060232），不得被再转一次（转后 ≈25.057）
    assert.equal(from.latitude, 25.060232, "高德坐标不得二次转换");
    assert.equal(to.latitude, 25.082489);
    const meters = Number(r.result.distanceMeters);
    assert.ok(meters > 5000 && meters < 10000, `距离应在 5~10km，实际 ${meters}m`);
  } finally {
    restoreFetch();
    restore();
  }
});

test("geo.distance：系统提供用户位置时走 requestLocation 并带精度", async () => {
  const restoreFetch = installAmapStub({
    text: [{ name: "九华苑", location: "104.893425,25.060232" }],
  });
  const { registry, restore } = makeRegistry();
  try {
    const withLoc = {
      sessionId: "s1",
      userId: "u1",
      requestLocation: async () => ({
        latitude: 25.062799956069178,
        longitude: 104.8924159251335,
        accuracyMeters: 12,
        label: "兴义市 · 下五屯街道",
      }),
    } as never;
    const r = await registry.execute("geo.distance", { to: "九华苑" }, withLoc);
    assert.equal(r.result.ok, true);
    const from = r.result.from as { accuracyMeters?: number; name?: string };
    assert.equal(from.accuracyMeters, 12, "应透出定位精度");
    assert.match(String(from.name), /下五屯/);
  } finally {
    restoreFetch();
    restore();
  }
});

// ─── 地名自证：防止 geocode 脏坐标污染缓存（2026-11-13 事故回归）──────
// 实测事故：「贵州兴义」经 Nominatim 拿到 (25.2613404, 104.8558378)，
// 该点实际在兴义市清水河镇（距市中心 19.3km），被当作城市中心写进 POI 缓存，
// 导致用户问「离九华苑多远」得到 20+ 公里（真实值 0.16 公里）。
// 防线：候选中心点必须与高德对同一查询词的权威坐标相距 < 8km。
test("地名自证：与高德权威坐标偏差超容差的候选坐标被拦截", async () => {
  const KEY = "64ee97c2787ab6657d9a981368497356";
  const originalFetch = globalThis.fetch;
  // 高德 geocode 对「贵州兴义」返回市中心；候选点差 19.3km（清水河镇）
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/v3/geocode/geo")) {
      return new Response(
        JSON.stringify({
          status: "1",
          geocodes: [{ location: "104.895503,25.091960", formatted_address: "贵州省黔西南布依族苗族自治州兴义市" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return originalFetch(input);
  }) as typeof fetch;

  try {
    const { PlanningService } = await import("../src/skills/travel-planning/travel-planning-service.js");
    const svc = new PlanningService() as unknown as {
      verifyCenterAgainstAmap: (
        lat: number,
        lon: number,
        q: string,
      ) => Promise<{ ok: boolean; reason: string; distanceMeters?: number }>;
    };
    // 脏数据坐标：清水河镇
    const bad = await svc.verifyCenterAgainstAmap(25.2613404, 104.8558378, "贵州兴义");
    assert.equal(bad.ok, false, "19.3km 偏差必须被拦截");
    assert.ok((bad.distanceMeters ?? 0) > 8000);

    // 高德权威坐标本身：零偏差，放行
    const good = await svc.verifyCenterAgainstAmap(25.09196, 104.895503, "贵州兴义");
    assert.equal(good.ok, true, "权威坐标必须放行");
  } finally {
    globalThis.fetch = originalFetch;
    void KEY;
  }
});

test("地名片段提取：能从地名中提取可自证的片段", async () => {
  const { extractPlaceNameSegments } = await import(
    "../src/skills/travel-planning/travel-planning-service.js"
  );
  const segs = extractPlaceNameSegments("贵州兴义");
  assert.ok(segs.includes("贵州兴义"), "应含完整地名");
  assert.ok(segs.includes("兴义"), "应含专名片段");
  // 英文地名无中文片段 → 不做自证（放行）
  assert.equal(extractPlaceNameSegments("Kyoto").length, 0);
});
