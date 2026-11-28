/**
 * 天气查询「用户原话驱动」契约（2026-11-21 根治）。
 *
 * 背景：旧实现把「查哪天」交给模型填 focus/days，模型漏传或复合路径丢参数时，
 * 回执退化成「今天+明天」两套：卡片取今日 todayRangeC、正文复述模板句的明日段，
 * 同一条回复出现两个温度区间打架（用户实测「明天天气」出 9-16 与 9-14）。
 *
 * 根治：服务端读权威意图源 context.userText，确定性决定查哪天，模型参数降级为兜底。
 * 本文件锁死：原话优先于模型参数、单日回执不含第二套温度、卡片只出一组区间。
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  parseWeatherDayIntent,
  registerWeatherTools,
} from "../src/tools/weather-tools.js";
import { ToolRegistry, type ToolContext } from "../src/tools/tool-registry.js";
import type { WeatherService } from "../src/services/weather-service.js";
import { buildToolCard } from "../src/services/tool-card-registry.js";

// ---------- 1. 意图解析纯函数 ----------

test("parseWeatherDayIntent：单日相对词映射正确，长词优先", () => {
  assert.deepEqual(parseWeatherDayIntent("明天天气"), { kind: "single", dayIndex: 1, label: "明天" });
  assert.deepEqual(parseWeatherDayIntent("明天天气怎么样"), { kind: "single", dayIndex: 1, label: "明天" });
  assert.deepEqual(parseWeatherDayIntent("今日气温"), { kind: "single", dayIndex: 0, label: "今天" });
  assert.deepEqual(parseWeatherDayIntent("今天热不热"), { kind: "single", dayIndex: 0, label: "今天" });
  assert.deepEqual(parseWeatherDayIntent("后天"), { kind: "single", dayIndex: 2, label: "后天" });
  assert.deepEqual(parseWeatherDayIntent("大后天天气"), { kind: "single", dayIndex: 3, label: "大后天" });
});

test("parseWeatherDayIntent：多日需求映射天数", () => {
  assert.deepEqual(parseWeatherDayIntent("这周天气"), { kind: "multi", days: 7 });
  assert.deepEqual(parseWeatherDayIntent("未来3天天气"), { kind: "multi", days: 3 });
  assert.deepEqual(parseWeatherDayIntent("查一下5天预报"), { kind: "multi", days: 5 });
});

test("parseWeatherDayIntent：泛问/空串/超范围返回 null（退回模型参数）", () => {
  assert.equal(parseWeatherDayIntent("天气怎么样"), null);
  assert.equal(parseWeatherDayIntent(""), null);
  assert.equal(parseWeatherDayIntent(undefined), null);
  assert.equal(parseWeatherDayIntent("未来99天天气"), null, "超出 16 天不认，防 API 报错");
});

// ---------- 2. 工具执行：原话驱动查询范围 ----------

/** 桩：记录 getBrief 收到的 days，返回一份今日 9-16 / 明日 9-14 / 后天 8-13 的回执。 */
function fakeWeatherWithSpy(): { svc: WeatherService; daysSeen: number[] } {
  const daysSeen: number[] = [];
  const svc = {
    getBrief: async (
      _lat: number,
      _lon: number,
      _tz?: string,
      label?: string,
      days?: number,
    ): Promise<any> => {
      daysSeen.push(days ?? 2);
      return {
        clothingAdvice: "长袖",
        currentTempC: 11,
        apparentTempC: 10,
        todayMinC: 9,
        todayMaxC: 16,
        weatherText: "晴",
        humidityPct: 50,
        windKmh: 8,
        peakRainPct: 0,
        locationLabel: label || "兴义市",
        timezone: "Asia/Shanghai",
        tomorrow: { weatherText: "多云", minC: 9, maxC: 14, rainPct: 0, weatherCode: 2 },
        rainWindow: null,
        daily: [
          { date: "2026-11-21", weatherText: "晴", minC: 9, maxC: 16, rainPct: 0, weatherCode: 0 },
          { date: "2026-11-22", weatherText: "多云", minC: 9, maxC: 14, rainPct: 0, weatherCode: 2 },
          { date: "2026-11-23", weatherText: "阴", minC: 8, maxC: 13, rainPct: 10, weatherCode: 3 },
          { date: "2026-11-24", weatherText: "小雨", minC: 7, maxC: 12, rainPct: 60, weatherCode: 61 },
        ],
      };
    },
  } as unknown as WeatherService;
  return { svc, daysSeen };
}

const BASE_CONTEXT: ToolContext = {
  sessionId: "s-weather-query-driven",
  getLastKnownLocation: () => ({
    latitude: 25.0631,
    longitude: 104.8915,
    city: "兴义市",
    region: "贵州省",
    country: "中国",
    timezone: "Asia/Shanghai",
    ageMs: 0,
  }),
};

async function exec(userText: string | undefined, modelInput: Record<string, unknown> = {}) {
  const { svc, daysSeen } = fakeWeatherWithSpy();
  const registry = new ToolRegistry();
  registerWeatherTools(registry, svc);
  const { result } = await registry.execute("weather.get_local", modelInput, {
    ...BASE_CONTEXT,
    userText,
  });
  return { result, daysSeen };
}

test("问「明天天气」：即使模型啥参数都不传，也只查必要天数且回执只有明日一组温度", async () => {
  const { result, daysSeen } = await exec("明天天气怎么样");
  assert.equal(result.ok, true);
  assert.equal(result.focusDay, "tomorrow", "明日聚焦回执");
  assert.equal(daysSeen[0], 2, "明天查 2 天（今日+明日），但不把今日塞进回执");
  assert.equal(result.todayRangeC, undefined, "回执绝不能带今日区间——那是打架的源头");
  assert.equal(result.summary, undefined, "回执不带服务端预拼整句，正文由模型按字段实时生成");
  assert.equal(result.tomorrowRangeC, "9°–14°");
  assert.equal(result.weatherText, "多云", "事实仍在结构化字段里");
  // 卡片只出一组温度
  const card = buildToolCard("weather.get_local", result);
  const temps = (card?.items ?? []).filter((i: any) => String(i.text).includes("气温"));
  assert.equal(temps.length, 1, "卡片只能有一行温度区间");
  assert.match(String(temps[0].text), /9°–14°/);
  assert.doesNotMatch(String(temps[0].text), /9°–16°/, "卡片不得出现今日 9-16");
});

test("问「明天天气」：模型乱传 days=7 也以原话为准，不被带偏", async () => {
  const { result, daysSeen } = await exec("明天天气", { days: 7 });
  assert.equal(daysSeen[0], 2, "原话「明天」覆盖模型 days=7");
  assert.equal(result.focusDay, "tomorrow");
  assert.equal(result.todayRangeC, undefined);
});

test("问「今天天气」：days=1，回执不带预拼整句", async () => {
  const { result, daysSeen } = await exec("今天天气热不热");
  assert.equal(daysSeen[0], 1);
  assert.equal(result.todayRangeC, "9°–16°");
  assert.equal(result.summary, undefined, "今日回执也不带服务端拼好的整句");
  assert.equal(result.focusDay, undefined, "今日走默认回执，无需特殊 focus 标记");
});

test("问「后天天气」：出通用单日回执，只有后天一组温度", async () => {
  const { result, daysSeen } = await exec("后天天气");
  assert.equal(daysSeen[0], 3);
  assert.equal(result.focusDay, "single");
  assert.equal(result.focusRangeC, "8°–13°");
  assert.equal(result.todayRangeC, undefined, "不得带今日区间");
  const card = buildToolCard("weather.get_local", result);
  const temps = (card?.items ?? []).filter((i: any) => String(i.text).includes("气温"));
  assert.equal(temps.length, 1);
  assert.match(String(temps[0].text), /8°–13°/);
});

test("问「这周天气」：days=7，走多日回执带 dailyForecast", async () => {
  const { result, daysSeen } = await exec("这周天气怎么样");
  assert.equal(daysSeen[0], 7);
  assert.ok(Array.isArray(result.dailyForecast), "多日回执带逐日预报");
});

test("兜底：无原话时用模型参数（主动任务等无 userText 场景不被改坏）", async () => {
  const { result, daysSeen } = await exec(undefined, { days: 5 });
  assert.equal(daysSeen[0], 5, "无原话时退回模型 days");
  const withFocus = await exec(undefined, { focus: "tomorrow" });
  assert.equal(withFocus.result.focusDay, "tomorrow", "无原话时模型 focus 仍生效");
});

test("泛问「天气怎么样」无明确日：默认单日，不再查今+明两套", async () => {
  const { daysSeen } = await exec("天气怎么样");
  assert.equal(daysSeen[0], 1, "泛问默认查单日一次——杜绝两套数据打架");
});

test("兜底路径也没给任何参数时：默认单日一次", async () => {
  const { daysSeen, result } = await exec(undefined, {});
  assert.equal(daysSeen[0], 1, "模型参数路径缺省也只查一次");
  assert.equal(result.focusDay, undefined, "无聚焦标记，走默认单日回执");
});

// ---------- 3. 跨轮缓存串味回归（2026-11-22 真机复现）----------
test("跨轮：同一 registry 内先问今天再问明天，第二次不得命中第一次的结果缓存", async () => {
  // 真机现象：APK 改问「明天天气」仍回今天+明天。根因不是 handler 没读 query，
  // 而是 registry.execute 的工具结果缓存键只有 name+input、不含 userText；
  // 根治后模型不再传 days/focus，两轮 input 都是 {} → 60s 内命中同一份缓存，
  // handler 压根不被调用，parseWeatherDayIntent 自然没机会生效。
  const { svc, daysSeen } = fakeWeatherWithSpy();
  const registry = new ToolRegistry();
  registerWeatherTools(registry, svc);
  const ctx = (userText: string): ToolContext => ({ ...BASE_CONTEXT, userText });

  const first = await registry.execute("weather.get_local", {}, ctx("今天天气"));
  const second = await registry.execute("weather.get_local", {}, ctx("明天天气"));

  assert.equal(daysSeen.length, 2, "两轮都应真正执行 handler（不得被跨轮结果缓存短路）");
  assert.equal((first.result as any).todayRangeC, "9°–16°", "第一轮今天：默认回执带今日区间");
  assert.equal((second.result as any).focusDay, "tomorrow", "第二轮明天：必须重新解析出明日聚焦");
  assert.equal((second.result as any).todayRangeC, undefined, "第二轮不得残留今天的区间");
});
