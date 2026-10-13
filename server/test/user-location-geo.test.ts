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
      },
    });
    assert.equal(stub.calls(), 0, "结构化字段齐备时禁止调用逆地理");
    assert.equal(info?.city, "黔西南布依族苗族自治州");
    assert.equal(info?.district, "兴义市");
    assert.equal(info?.timezone, "Asia/Shanghai");
    assert.equal(info?.source, "client-gps");
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

    // 取整到 3 位小数的同一坐标 → 命中缓存，不再产生网络请求
    const second = await resolveUserGeo({
      clientLocation: { latitude: 25.0912, longitude: 104.9012 },
    });
    assert.equal(second?.city, "黔西南布依族苗族自治州");
    assert.equal(stub.calls(), callsAfterFirst, "同坐标第二次必须命中缓存");
  } finally {
    stub.restore();
  }
});
