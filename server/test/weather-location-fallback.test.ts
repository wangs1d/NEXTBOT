/**
 * weather.get_local 定位链路契约：
 *   1. 实时 GPS 拿不到时逐级回落到「最近一次已知位置」，坐标仍是真数，
 *      label 必须带龄期标注（不把旧定位当实时透出）
 *   2. 全部来源都拿不到时自报 `{ok:false}`，判定层据此归为 error 出告警卡，
 *      不出空天气卡；且失败不写工具结果缓存，用户补上定位后立即可查
 */

import assert from "node:assert/strict";
import test from "node:test";

import { registerWeatherTools } from "../src/tools/weather-tools.js";
import { ToolRegistry, type ToolContext } from "../src/tools/tool-registry.js";
import type { WeatherService } from "../src/services/weather-service.js";
import { effectStatusOf } from "../src/render/index.js";

/** 只关心工具怎么拿坐标、怎么标注来源，取数部分用桩替掉。 */
const fakeWeather = {
  getBrief: async (
    lat: number,
    lon: number,
    _tz?: string,
    label?: string,
  ): Promise<any> => ({
    summaryLine: "晴 18℃",
    clothingAdvice: "长袖即可",
    currentTempC: 18,
    apparentTempC: 17,
    todayMinC: 15,
    todayMaxC: 22,
    weatherText: "晴",
    humidityPct: 60,
    windKmh: 9,
    peakRainPct: 5,
    locationLabel: label || `${lat.toFixed(2)}, ${lon.toFixed(2)}`,
    timezone: "Asia/Shanghai",
    tomorrow: null,
    rainWindow: null,
    hourlyForecast: [],
    daily: [],
  }),
} as unknown as WeatherService;

const XINGYI = {
  latitude: 25.0631,
  longitude: 104.8915,
  city: "兴义市",
  region: "贵州省",
  country: "中国",
  timezone: "Asia/Shanghai",
};

function buildRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registerWeatherTools(registry, fakeWeather);
  return registry;
}

const BASE_CONTEXT: ToolContext = { sessionId: "s-weather-loc" };

test("实时 GPS 超时 → 回落最近已知位置，仍能出真天气并标注龄期", async () => {
  const registry = buildRegistry();
  const { ok, result } = await registry.execute("weather.get_local", {}, {
    ...BASE_CONTEXT,
    requestLocation: async () => null,
    getLastKnownLocation: () => ({ ...XINGYI, ageMs: 25 * 60_000 }),
  });

  assert.equal(ok, true);
  assert.equal(result.ok, true, "回落成功不该自报失败");
  assert.match(String(result.locationLabel), /兴义市/);
  assert.match(String(result.locationLabel), /约 25 分钟前的定位/, "旧定位必须标龄期");
  assert.equal(effectStatusOf(result), "ok", "有数据的效果应计入数据源");
});

test("没有任何位置来源 → 自报失败，判定层归为 error 而非空天气卡", async () => {
  const registry = buildRegistry();
  const { result } = await registry.execute("weather.get_local", {}, {
    ...BASE_CONTEXT,
    requestLocation: async () => null,
    getLastKnownLocation: () => null,
  });

  assert.equal(result.ok, false);
  assert.equal(effectStatusOf(result), "error");
});

test("一次瞬时失败不写结果缓存：用户补上定位后立刻能查出天气", async () => {
  const registry = buildRegistry();
  const failing = {
    ...BASE_CONTEXT,
    requestLocation: async () => null,
    getLastKnownLocation: () => null,
  };
  const first = await registry.execute("weather.get_local", {}, failing);
  assert.equal(first.result.ok, false);

  const succeeding = {
    ...BASE_CONTEXT,
    requestLocation: async () => XINGYI,
  };
  const second = await registry.execute("weather.get_local", {}, succeeding);
  assert.equal(second.result.ok, true, "失败结果被缓存会让「稍后重试」在这一分钟内永远失败");
  assert.equal(second.result.locationLabel, "兴义市 · 贵州省 · 中国");
});

test("成功结果仍走缓存：同参数 TTL 内不重复取数", async () => {
  const registry = buildRegistry();
  let calls = 0;
  const context = {
    ...BASE_CONTEXT,
    requestLocation: async () => {
      calls++;
      return XINGYI;
    },
  };
  await registry.execute("weather.get_local", {}, context);
  await registry.execute("weather.get_local", {}, context);
  assert.equal(calls, 1, "60s 内重复问天气不该重复拉 GPS 与预报");
});
