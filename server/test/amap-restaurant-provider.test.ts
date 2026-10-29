/**
 * 高德餐厅 Provider 单测（注入 fetchImpl，不发真实网络请求）。
 *
 * 覆盖：真实字段映射 / 缺失字段留空不补 / 非餐饮类目过滤 / 缓存命中不再打接口 /
 * 无定位时先索取再如实报错 / 只有城市走关键字检索 / book 拒绝占座。
 */

import assert from "node:assert/strict";
import test from "node:test";

import { getBookingConfig } from "../src/services/booking/booking-config.js";
import { AmapRestaurantProvider } from "../src/services/booking/providers/amap-restaurant-provider.js";
import { SimulatedRestaurantProvider } from "../src/services/booking/providers/simulated-local-providers.js";
import type {
  BookingOption,
  BookingProviderContext,
  BookingProviderResult,
  BookingSearchQuery,
} from "../src/services/booking/booking-provider.js";
import type { ToolContext } from "../src/tools/tool-registry.js";

const config = getBookingConfig({ AMAP_WEB_KEY: "test-amap-key" } as NodeJS.ProcessEnv);

function unwrapOk<T>(r: BookingProviderResult<T>): T {
  if (!r.ok) throw new Error(`期望 ok=true，实际 ${JSON.stringify(r)}`);
  return r;
}

function unwrapErr<T>(r: BookingProviderResult<T>): { ok: false; error: string; retryable?: boolean } {
  if (r.ok) throw new Error(`期望 ok=false，实际 ${JSON.stringify(r)}`);
  return r;
}

function makeProvider(fetchImpl: (url: string) => Promise<Response>) {
  return new AmapRestaurantProvider(config, { cachePath: null, fetchImpl });
}

function amapResponse(pois: unknown[], status = "1") {
  return new Response(
    JSON.stringify({ status, info: status === "1" ? "OK" : "INVALID_USER_KEY", count: pois.length, pois }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

const REAL_POI = {
  id: "B0FFHXXXX1",
  name: "渝旋转自助小火锅",
  type: "餐饮服务;中餐厅;火锅店",
  keytag: "小火锅",
  typecode: "050117",
  location: "104.915,25.095",
  distance: "1074",
  address: "盘江东路12号",
  business_area: "盘江东路",
  tel: "13800000000",
  biz_ext: { cost: "32.00", rating: "3.8", open_time: "08:00-22:00", opentime2: "周一至周日 08:00-22:00" },
};

/** 高德空字段的真实形状是 `[]`，不是 "" */
const NO_COST_POI = {
  ...REAL_POI,
  id: "B0FFHXXXX2",
  name: "徐记自助餐",
  keytag: "自助餐",
  distance: "1085",
  business_area: [],
  tel: [],
  biz_ext: { cost: [], rating: "2.4", open_time: [], opentime2: [] },
};

const NON_FOOD_POI = { ...REAL_POI, id: "B0FFHXXXX3", name: "某街道办事处", type: "政府机构;政府机关;政府机关" };

function query(overrides?: Partial<BookingSearchQuery>): BookingSearchQuery {
  return {
    domain: "restaurant",
    location: { latitude: 25.0887, longitude: 104.9068, city: "兴义市" },
    params: { query: "自助餐", cuisine: "", covers: 2, dineAt: null },
    ...overrides,
  };
}

function providerCtx(toolContext?: Partial<ToolContext>): BookingProviderContext {
  return { actorId: "u1", location: null, toolContext: { sessionId: "s", userId: "u", ...toolContext } as ToolContext };
}

const extra = (o: BookingOption) => o.extra as Record<string, unknown>;

test("amap restaurant provider - 有定位走周边搜索并映射真实字段", async () => {
  const urls: string[] = [];
  const provider = makeProvider(async (url) => {
    urls.push(url);
    return amapResponse([REAL_POI, NO_COST_POI, NON_FOOD_POI]);
  });

  const res = unwrapOk(await provider.search(query(), providerCtx()));
  assert.match(urls[0], /restapi\.amap\.com\/v3\/place\/around/);
  assert.match(urls[0], /location=104\.9068%2C25\.0887/);
  assert.match(urls[0], /keywords=%E8%87%AA%E5%8A%A9%E9%A4%90/);
  assert.match(urls[0], /radius=5000/);
  assert.match(String(res.note), /高德地图开放平台真实门店/);

  // 非餐饮类目被过滤掉
  assert.equal(res.options.length, 2);
  const [first, second] = res.options;
  assert.equal(first.provider, "amap");
  assert.equal(first.simulated, false);
  assert.equal(first.title, "渝旋转自助小火锅 · 小火锅 · 人均 ¥32");
  assert.equal(first.description, "距 1.1 公里 · 评分 3.8 · 盘江东路12号");
  assert.equal(first.amountCny, 64); // 人均 32 × 2 人
  assert.equal(extra(first).tel, "13800000000");
  assert.equal(extra(first).distanceMeters, 1074);
  assert.equal(extra(first).openTime, "周一至周日 08:00-22:00");

  // 平台没给的字段留空，不补占位、不估算
  assert.equal(second.title, "徐记自助餐 · 自助餐");
  assert.equal(second.amountCny, null);
  assert.equal(extra(second).perCapita, null);
  assert.equal(extra(second).tel, "");
  assert.equal(extra(second).businessArea, "");
});

test("amap restaurant provider - 坐标转 WGS-84，火星坐标留在 extra.gcj02", async () => {
  const provider = makeProvider(async () => amapResponse([REAL_POI]));
  const res = unwrapOk(await provider.search(query(), providerCtx()));
  const e = extra(res.options[0]);
  assert.deepEqual(e.gcj02, { latitude: 25.095, longitude: 104.915 });
  assert.notEqual(e.latitude, 25.095);
  // 国内 GCJ-02 与 WGS-84 的典型偏差在 1km 以内
  assert.ok(Math.abs(Number(e.latitude) - 25.095) < 0.01);
  assert.ok(Math.abs(Number(e.longitude) - 104.915) < 0.01);
});

test("amap restaurant provider - GPS 抖动后同网格命中缓存，不再打接口", async () => {
  let calls = 0;
  const provider = makeProvider(async () => {
    calls++;
    return amapResponse([REAL_POI]);
  });
  unwrapOk(await provider.search(query(), providerCtx()));
  const second = unwrapOk(
    await provider.search(query({ location: { latitude: 25.08871, longitude: 104.90681 } }), providerCtx()),
  );
  assert.equal(calls, 1);
  assert.match(String(second.note), /缓存/);
});

test("amap restaurant provider - 无定位时先向客户端索取，仍拿不到才如实报错", async () => {
  let asked = 0;
  const provider = makeProvider(async () => amapResponse([REAL_POI]));

  const denied = unwrapErr(
    await provider.search(
      query({ location: null }),
      providerCtx({
        requestLocation: async () => {
          asked++;
          return null;
        },
      }),
    ),
  );
  assert.equal(asked, 1);
  assert.match(denied.error, /定位/);
  assert.equal(denied.retryable, true);

  const granted = unwrapOk(
    await provider.search(
      query({ location: null }),
      providerCtx({
        requestLocation: async () => {
          asked++;
          return { latitude: 25.0887, longitude: 104.9068 };
        },
      }),
    ),
  );
  assert.equal(granted.options.length, 1);
  assert.equal(asked, 2);
});

test("amap restaurant provider - 只有城市时走关键字检索", async () => {
  const urls: string[] = [];
  const provider = makeProvider(async (url) => {
    urls.push(url);
    return amapResponse([REAL_POI]);
  });
  unwrapOk(await provider.search(query({ city: "兴义", location: null }), providerCtx()));
  assert.match(urls[0], /place\/text/);
  assert.match(urls[0], /city=%E5%85%B4%E4%B9%89/);
  assert.match(urls[0], /citylimit=true/);
});

test("amap restaurant provider - 无匹配返回空列表并说明是数据源没有", async () => {
  const provider = makeProvider(async () => amapResponse([NON_FOOD_POI]));
  const res = unwrapOk(await provider.search(query(), providerCtx()));
  assert.equal(res.options.length, 0);
  assert.match(String(res.note), /没有匹配/);
});

test("amap restaurant provider - 接口非正常响应如实报错且可重试", async () => {
  const provider = makeProvider(async () => amapResponse([], "0"));
  const err = unwrapErr(await provider.search(query(), providerCtx()));
  assert.equal(err.retryable, true);
});

test("amap restaurant provider - book 拒绝占座并指向门店电话", async () => {
  const provider = makeProvider(async () => amapResponse([REAL_POI]));
  const err = unwrapErr(
    await provider.book(
      { domain: "restaurant", provider: "amap", optionId: "amap-B0FFHXXXX1", title: "x", amountCny: null, summary: "", params: {} },
      providerCtx(),
    ),
  );
  assert.match(err.error, /电话/);
  assert.equal(err.retryable, false);
});

test("amap restaurant provider - 缺 AMAP_WEB_KEY 时不可用", () => {
  const bare = new AmapRestaurantProvider(getBookingConfig({} as NodeJS.ProcessEnv), { cachePath: null });
  const avail = bare.availability();
  assert.equal(avail.ok, false);
  assert.match(String(avail.reason), /AMAP_WEB_KEY/);
});

test("模拟餐厅库 - 关键词不匹配返回空，不回吐全量样例", async () => {
  const provider = new SimulatedRestaurantProvider();
  const res = unwrapOk(
    await provider.search(query({ params: { query: "自助餐", cuisine: "", covers: 2 } }), providerCtx()),
  );
  assert.equal(res.options.length, 0);
  assert.match(String(res.note), /模拟库/);

  const hit = unwrapOk(await provider.search(query({ params: { query: "外婆家", cuisine: "", covers: 2 } }), providerCtx()));
  assert.equal(hit.options.length, 1);
  assert.equal(hit.options[0].simulated, true);
});
