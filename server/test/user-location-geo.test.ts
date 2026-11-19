/**
 * 用户位置解析：逆地理重复调用收口单测（2026-10-12 延迟优化）。
 *
 * 背景：前端每条消息都会先拉新 GPS，再调服务端 `/geo/reverse` 把坐标解析成
 * 省市区，然后把**已解析好的** city/district/region/country/timezone 随消息回传。
 * 但服务端 `geoFromClientLocation` 此前无视这些字段，又拿经纬度调一次
 * `reverseGeocodeCoordinates`（BigDataCloud + open-meteo 两个外网请求），
 * 即「同一条消息前后端各逆地理一遍」。本套测试锁死两条契约：
 *   1. payload 已带结构化字段 → 零外网调用，直接复用；
 *   2. 只有坐标（逆地理失败兜底）→ 仍回退服务端反查，且同坐标第二次命中缓存。
 */

import assert from "node:assert/strict";
import test from "node:test";

import { resolveUserGeo } from "../src/services/user-location-service.js";
import { resetReverseGeocodeCacheForTest } from "../src/services/reverse-geocode-service.js";

type FetchLike = typeof globalThis.fetch;

function withStubbedFetch(
  handler: (url: string) => { ok: boolean; json: () => Promise<unknown> },
): { calls: () => number; restore: () => void } {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (input: unknown) => {
    calls++;
    return handler(String(input)) as Response;
  }) as FetchLike;
  return {
    calls: () => calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

test("payload 带结构化地址 → 不触发任何逆地理网络请求", async () => {
  resetReverseGeocodeCacheForTest();
  const stub = withStubbedFetch(() => {
    throw new Error("structured payload 不应触发网络请求");
  });
  try {
    const info = await resolveUserGeo({
      clientLocation: {
        latitude: 25.0911,
        longitude: 104.9011,
        district: "兴义市",
        city: "黔西南布依族苗族自治州",
        region: "贵州省",
        country: "中国",
        timezone: "Asia/Shanghai",
        // 新客户端会带上逆地理产物；带了就不再反查（旧客户端只带省市区，
        // 缓存未命中时会做一次短预算补查，见文件末尾的精确地址用例）。
        address: "贵州省黔西南布依族苗族自治州兴义市下五屯街道永康路007号九华苑",
        poi: "九华苑",
      },
    });
    assert.equal(stub.calls(), 0, "结构化字段齐备时禁止调用逆地理");
    assert.equal(info?.city, "黔西南布依族苗族自治州");
    assert.equal(info?.district, "兴义市");
    assert.equal(info?.timezone, "Asia/Shanghai");
    assert.equal(info?.source, "client-gps");
    assert.match(String(info?.address), /九华苑/);
  } finally {
    stub.restore();
  }
});

test("仅坐标 payload → 回退服务端逆地理，且同坐标二次命中缓存", async () => {
  resetReverseGeocodeCacheForTest();
  const stub = withStubbedFetch((url) => {
    if (url.includes("bigdatacloud")) {
      return {
        ok: true,
        json: async () => ({
          locality: "兴义市",
          city: "黔西南布依族苗族自治州",
          principalSubdivision: "贵州省",
          countryName: "中国",
        }),
      };
    }
    // open-meteo 时区（以及 amap 分支的兜底响应，status!=1 会被判 null）
    return { ok: true, json: async () => ({ timezone: "Asia/Shanghai" }) };
  });
  try {
    const first = await resolveUserGeo({
      clientLocation: { latitude: 25.0911, longitude: 104.9011 },
    });
    assert.ok(first, "纯坐标应能反查出地址");
    assert.equal(first?.city, "黔西南布依族苗族自治州");
    const callsAfterFirst = stub.calls();
    assert.ok(callsAfterFirst >= 1, "首次应发生网络请求");

    // 缓存键精确到 6 位小数（≈0.11m，高德 location 参数的上限）：
    // 完全相同的坐标必须命中缓存；相邻但不同的坐标（0.00004°≈4m）不得共用同一条
    // 门牌地址——4 位小数的旧键会把 11m 内的两个位置归并，精度提升会被缓存吃掉。
    const second = await resolveUserGeo({
      clientLocation: { latitude: 25.0911, longitude: 104.9011 },
    });
    assert.equal(second?.city, "黔西南布依族苗族自治州");
    assert.equal(stub.calls(), callsAfterFirst, "同一坐标第二次必须命中缓存");

    await resolveUserGeo({
      clientLocation: { latitude: 25.09114, longitude: 104.90114 },
    });
    assert.ok(
      stub.calls() > callsAfterFirst,
      "不同坐标不得被 11m 网格归并到同一条逆地理结果",
    );
  } finally {
    stub.restore();
  }
});

/**
 * 2026-11-14 精确定位回归：只返回到省市区时用户只能听到「你在某某市」。
 * 高德 regeo 必须走 extensions=all 并解析门牌/街道/最近 AOI，且这些字段
 * 要在「客户端回传结构化省市区」的快路径上从逆地理缓存补回来（零网络）。
 */
test("高德 regeo 精确到门牌与最近地标，结构化 payload 从缓存补回精确字段", async () => {
  resetReverseGeocodeCacheForTest();
  const prevKey = process.env.AMAP_WEB_KEY;
  process.env.AMAP_WEB_KEY = "test-amap-key";
  const stub = withStubbedFetch((url) => {
    if (url.includes("/v3/geocode/regeo")) {
      assert.match(url, /extensions=all/, "必须请求 extensions=all 才能拿到门牌/地标");
      return {
        ok: true,
        json: async () => ({
          status: "1",
          regeocode: {
            formatted_address: "贵州省黔西南布依族苗族自治州兴义市下五屯街道永康路007号九华苑",
            addressComponent: {
              province: "贵州省",
              city: "黔西南布依族苗族自治州",
              district: "兴义市",
              township: "下五屯街道",
              country: "中国",
              streetNumber: { street: "永康路", number: "007号" },
            },
            aois: [{ name: "九华苑", distance: "0" }],
            pois: [{ name: "九华苑", distance: "0" }],
          },
        }),
      };
    }
    return { ok: true, json: async () => ({ timezone: "Asia/Shanghai" }) };
  });
  try {
    const precise = await resolveUserGeo({
      clientLocation: { latitude: 25.0627, longitude: 104.8924 },
    });
    assert.ok(precise, "纯坐标应能反查出精确地址");
    assert.match(String(precise?.address), /永康路007号九华苑/);
    assert.equal(precise?.township, "下五屯街道");
    assert.equal(precise?.poi, "九华苑");
    assert.equal(precise?.poiDistanceMeters, 0);

    const callsAfterFirst = stub.calls();
    // 客户端回传省市区（结构化）时不再打外网，但仍要从缓存补回门牌/地标
    const structured = await resolveUserGeo({
      clientLocation: {
        latitude: 25.0627,
        longitude: 104.8924,
        city: "黔西南布依族苗族自治州",
        district: "兴义市",
        region: "贵州省",
        country: "中国",
      },
    });
    assert.equal(stub.calls(), callsAfterFirst, "结构化 payload 不得新增网络请求");
    assert.match(String(structured?.address), /永康路007号九华苑/);
    assert.equal(structured?.poi, "九华苑");
  } finally {
    stub.restore();
    if (prevKey === undefined) delete process.env.AMAP_WEB_KEY;
    else process.env.AMAP_WEB_KEY = prevKey;
  }
});
