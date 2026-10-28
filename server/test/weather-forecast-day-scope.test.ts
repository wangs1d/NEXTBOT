// 天气取数口径测试（回归位）：
//  1. 降水概率只取「今天」那一天——问多日时不能把后面某天的雨算到今天头上
//  2. 时区与逐小时时刻以坐标所在时区为准（timezone=auto + 响应 utc_offset_seconds），
//     服务器本地时区是 UTC 时也不许把面板时刻/日历日挪走
//  3. 降水要落到具体钟点段（上午/晚上），只说「今天 99%」用户没法决定几点出门；
//     已经下过的时段不许再催带伞
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { WeatherService, extractRainWindow, rainWindowSuffixText } from "../src/services/weather-service.js";

const OFFSET_SECONDS = 8 * 3600;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** 位置本地时间串（Open-Meteo 的 hourly.time 就是这个形状，不带偏移） */
function localTimeStr(ms: number): string {
  const d = new Date(ms + OFFSET_SECONDS * 1000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:00`;
}

function localDateKey(ms: number): string {
  return localTimeStr(ms).slice(0, 10);
}

/** 造一份「今天干燥、明天大雨」的 48 小时 + 2 日预报 */
function buildPayload(): Record<string, unknown> {
  const todayStart = new Date(Date.now() + OFFSET_SECONDS * 1000);
  todayStart.setUTCHours(0, 0, 0, 0);
  const baseMs = todayStart.getTime() - OFFSET_SECONDS * 1000;
  const todayKey = localDateKey(baseMs);
  const tomorrowKey = localDateKey(baseMs + 86_400_000);

  const time: string[] = [];
  const temperature: number[] = [];
  const probability: number[] = [];
  const code: number[] = [];
  for (let h = 0; h < 48; h++) {
    const ms = baseMs + h * 3_600_000;
    time.push(localTimeStr(ms));
    temperature.push(20);
    probability.push(ms < baseMs + 86_400_000 ? 5 : 90);
    code.push(ms < baseMs + 86_400_000 ? 1 : 65);
  }

  return {
    timezone: "Asia/Shanghai",
    utc_offset_seconds: OFFSET_SECONDS,
    current: { temperature_2m: 18, relative_humidity_2m: 70, apparent_temperature: 17, weather_code: 1, wind_speed_10m: 8, precipitation: 0 },
    hourly: { time, temperature_2m: temperature, precipitation_probability: probability, weather_code: code },
    daily: {
      time: [todayKey, tomorrowKey],
      weather_code: [1, 65],
      temperature_2m_max: [22, 19],
      temperature_2m_min: [16, 15],
      precipitation_probability_max: [5, 90],
    },
  };
}

function withStubbedFetch(run: (capturedUrls: string[]) => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  const capturedUrls: string[] = [];
  globalThis.fetch = (async (url: unknown) => {
    capturedUrls.push(String(url));
    return {
      ok: true,
      status: 200,
      json: async () => buildPayload(),
    };
  }) as unknown as typeof fetch;
  return run(capturedUrls).finally(() => {
    globalThis.fetch = original;
  });
}

test("降水概率按天：days=7 时今天仍取今天那一段的最大值，不吞后面那天的 90%", async () => {
  await withStubbedFetch(async (capturedUrls) => {
    const brief = await new WeatherService().getBrief(25.0628, 104.891, undefined, "兴义市", 7);
    assert.match(capturedUrls[0]!, /forecast_days=7/);
    assert.equal(brief.peakRainPct, 5, "今天不能借用后一天的降水概率");
    assert.equal(brief.tomorrow?.rainPct, 90, "明天的数照常带出来");
    assert.doesNotMatch(brief.clothingAdvice, /雨具/, "今天不下雨就不该因为后天的雨喊带伞");
  });
});

test("缺省时区走 auto，由坐标推导；brief 回传接口解析出的真实时区", async () => {
  await withStubbedFetch(async (capturedUrls) => {
    const brief = await new WeatherService().getBrief(25.0628, 104.891);
    assert.match(capturedUrls[0]!, /[?&]timezone=auto/);
    assert.equal(brief.timezone, "Asia/Shanghai");
  });
});

test("服务器时区为 UTC 时，逐小时仍按坐标时区定位起点（不整体偏 8 小时）", async () => {
  const previousTz = process.env.TZ;
  process.env.TZ = "UTC";
  const startedAt = Date.now();
  try {
    await withStubbedFetch(async () => {
      const brief = await new WeatherService().getBrief(25.0628, 104.891, "auto", "兴义市", 2);
      assert.ok(brief.hourlyForecast.length > 0);
      const instantOf = (time: string) => Date.parse(`${time}:00Z`) - OFFSET_SECONDS * 1000;
      const first = instantOf(brief.hourlyForecast[0]!.time);
      // 起点 = 坐标本地的「下一个整点」：按服务器（UTC）本地解析会整体偏 8 小时
      assert.ok(first >= startedAt, `${brief.hourlyForecast[0]!.time} 不该是已经过去的小时`);
      assert.ok(first - startedAt <= 3_600_000, `${brief.hourlyForecast[0]!.time} 起点偏太远`);
      for (const row of brief.hourlyForecast) {
        assert.ok(instantOf(row.time) >= startedAt, `${row.time} 是已经过去的小时`);
      }
    });
  } finally {
    if (previousTz === undefined) delete process.env.TZ;
    else process.env.TZ = previousTz;
  }
});

/** 24 小时全填某值，再按小时覆盖 */
function dayProbs(pairs: Record<number, number>): (number | null)[] {
  const arr: (number | null)[] = Array.from({ length: 24 }, () => 0);
  for (const [h, p] of Object.entries(pairs)) arr[Number(h)] = p;
  return arr;
}

test("时段聚合：早上下午都下雨时，取峰值所在的钟点段而不是含糊说「今天」", () => {
  const w = extractRainWindow({
    probsByHour: dayProbs({ 7: 55, 8: 60, 10: 70, 11: 95, 12: 80, 20: 45 }),
  });
  assert.ok(w);
  assert.equal(w.period, "上午", "峰值在 11 点，时段应落在上午");
  assert.equal(w.startHour, 10);
  assert.equal(w.endHour, 13, "结束小时不含，10–13 点即 10/11/12 三小时");
  assert.equal(w.peakPct, 95);
  assert.equal(w.alreadyPassed, false);
  assert.match(rainWindowSuffixText(w), /上午到中午 10–13 点最明显/);
});

test("时段聚合：跨多个时段的长雨带要说清收尾，不能只贴峰值那一段的名字", () => {
  const w = extractRainWindow({
    probsByHour: dayProbs({ 6: 54, 7: 72, 8: 86, 9: 95, 10: 99, 11: 98, 12: 88, 13: 72, 14: 55 }),
  });
  assert.ok(w);
  // 6 点起下到 15 点、峰值在上午的形状
  assert.equal(w.period, "上午");
  assert.equal(w.label, "早上到下午 6–15 点");
});

test("时段聚合：多段分开时取概率最高的那一段", () => {
  const w = extractRainWindow({ probsByHour: dayProbs({ 3: 50, 4: 52, 18: 88, 19: 90 }) });
  assert.ok(w);
  assert.equal(w.period, "晚上");
  assert.equal(w.startHour, 18);
  assert.equal(w.endHour, 20);
});

test("时段聚合：全部达标钟点已经过去的（早上问晚上的雨）不再当成待办", () => {
  const w = extractRainWindow({
    probsByHour: dayProbs({ 6: 70, 7: 80, 8: 75 }),
    nowHourOfDay: 20,
  });
  assert.ok(w);
  assert.equal(w.alreadyPassed, true);
  assert.match(rainWindowSuffixText(w), /已下过/);
});

test("时段聚合：只看还没到的钟点，凌晨那场雨不该在下午还挂着头", () => {
  const w = extractRainWindow({
    probsByHour: dayProbs({ 2: 60, 15: 85, 16: 90 }),
    nowHourOfDay: 14,
  });
  assert.ok(w);
  assert.equal(w.period, "下午");
  assert.equal(w.startHour, 15);
  assert.equal(w.alreadyPassed, false);
});

test("时段聚合：概率没到 40% 就不编时段", () => {
  assert.equal(extractRainWindow({ probsByHour: dayProbs({ 9: 30, 10: 35 }) }), null);
  assert.equal(rainWindowSuffixText(null), "");
});

test("brief 出口：时段进正文摘要与穿衣建议", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    json: async () => {
      const payload = buildPayload() as Record<string, unknown>;
      const hourly = { ...(payload.hourly as Record<string, unknown>) };
      // 今天 24 小时全部 90%：无论用例几点跑，都存在「还没到」的达标钟点
      hourly.precipitation_probability = Array.from({ length: 48 }, () => 90);
      return { ...payload, hourly };
    },
  })) as unknown as typeof fetch;
  try {
    const brief = await new WeatherService().getBrief(25.0628, 104.891, "auto", "兴义市", 2);
    assert.ok(brief.rainWindow, "全天有雨应给出钟点段");
    const PERIOD = "(凌晨|早上|上午|中午|下午|晚上|深夜)";
    assert.match(brief.rainWindow.label, new RegExp(`^${PERIOD}(到${PERIOD})? \\d+–\\d+ 点$`));
    assert.match(brief.summaryLine, new RegExp(`集中在 ${PERIOD}(到${PERIOD})? \\d+–\\d+ 点`));
    assert.match(brief.clothingAdvice, /携带雨具（.*最明显）/);
  } finally {
    globalThis.fetch = original;
  }
});

after(() => {
  // 兜底还原：用例中途抛错也不能把进程时区留在 UTC
  delete process.env.TZ;
});
