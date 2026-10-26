/**
 * 旅游规划优化单测：坐标转换 / 调度器每日完整性 / 地理编码择优 / 瓦片缓存。
 *
 * 对应「旅游规划页面」三项用户问题：
 *   1. 位置要准确     → GCJ-02↔WGS-84 转换正确、多候选择优
 *   2. 每日真实安排   → 装不下顺延而非丢弃、每天午晚餐齐全、每天有景点
 *   3. 地图预加载     → 瓦片代理白名单与磁盘缓存命中
 *
 * 测试封闭：OSRM 指向本机关闭端口（瞬时失败走 haversine 估算），
 * 瓦片缓存用临时目录 + 本地 http server，无外部依赖。
 */

import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

// OSRM 指向必关闭的端口：connection refused 立即返回，测试不被 5s 超时拖住
process.env.TRAVEL_ROUTE_API_BASE = "http://127.0.0.1:9";

import { gcj02ToWgs84, wgs84ToGcj02 } from "../src/skills/travel-planning/coord-transform.js";
import {
  pickBestNominatim,
  PlanningService,
} from "../src/skills/travel-planning/travel-planning-service.js";
import type { RawPOI } from "../src/skills/travel-planning/poi-cache-manager.js";
import { TravelTileCache } from "../src/services/travel-tile-cache.js";

// ==================== 工具 ====================

let poiSeq = 0;
function mkPoi(
  name: string,
  lat: number,
  lon: number,
  type: "attraction" | "hotel" | "restaurant" = "attraction",
): RawPOI {
  poiSeq++;
  return {
    id: `t-${poiSeq}-${name}`,
    name,
    latitude: lat,
    longitude: lon,
    address: `${name}地址`,
    type,
    rating: 4.5,
    tags: ["测试"],
    raw: { source: "test" },
  };
}

/** 目的地中心（大理附近，纯测试坐标） */
const CENTER = { latitude: 25.69, longitude: 100.16 };

function attractionGrid(n: number, spreadDeg = 0.05): RawPOI[] {
  // n 个景点铺成网格（约 5km×5km），模拟一个真实目的地的景点分布
  const side = Math.ceil(Math.sqrt(n));
  const out: RawPOI[] = [];
  for (let i = 0; i < n; i++) {
    const r = Math.floor(i / side);
    const c = i % side;
    out.push(
      mkPoi(
        `景点${i + 1}`,
        CENTER.latitude + (r / Math.max(1, side - 1)) * spreadDeg,
        CENTER.longitude + (c / Math.max(1, side - 1)) * spreadDeg,
        "attraction",
      ),
    );
  }
  return out;
}

function restaurantRing(n: number): RawPOI[] {
  const out: RawPOI[] = [];
  for (let i = 0; i < n; i++) {
    const ang = (2 * Math.PI * i) / Math.max(1, n);
    out.push(
      mkPoi(
        `餐厅${i + 1}`,
        CENTER.latitude + 0.005 * Math.cos(ang),
        CENTER.longitude + 0.005 * Math.sin(ang),
        "restaurant",
      ),
    );
  }
  return out;
}

const PREFERENCES = {
  raw: [],
  seaside: false,
  pool: false,
  activities: false,
  kids: false,
  elderly: false,
  pace: "balanced",
  activityMix: "mixed",
  sources: {},
} as any;

const TRAVEL_INFO = {
  destination: "测试市",
  visa: { required: false, type: "免签" },
  currency: { name: "人民币", code: "CNY", symbol: "¥" },
  timezone: { name: "北京时间", offset: "UTC+8" },
  language: ["中文"],
  voltage: "220V",
  socket: "两脚",
  bestSeason: { months: ["4", "5"], description: "春秋最佳" },
  emergency: {},
  customs: [],
  tips: [],
} as any;

const PRICING_CTX = { destination: "测试市", preferences: {}, startDate: "2026-09-15" } as any;

const service = new PlanningService();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const buildDays = (serviceRef: PlanningService, ...args: any[]) =>
  // buildDaysFast 为私有方法，测试经由受控入参直接驱动
  (serviceRef as any).buildDaysFast(...args);

function attrCount(day: { items: Array<{ type: string }> }): number {
  return day.items.filter((it) => it.type === "attraction").length;
}

function mealNames(day: { items: Array<{ type: string; name: string }> }): {
  lunch: boolean;
  dinner: boolean;
} {
  const rests = day.items.filter((it) => it.type === "restaurant");
  return { lunch: rests.length >= 1, dinner: rests.length >= 2 };
}

// ==================== 坐标转换 ====================

describe("coord-transform (位置准确性)", () => {
  it("境外坐标原样返回（不偏移）", () => {
    const ny = { lat: 40.7128, lon: -74.006 };
    const a = wgs84ToGcj02(ny.lat, ny.lon);
    const b = gcj02ToWgs84(ny.lat, ny.lon);
    assert.equal(a.latitude, ny.lat);
    assert.equal(a.longitude, ny.lon);
    assert.equal(b.latitude, ny.lat);
    assert.equal(b.longitude, ny.lon);
  });

  it("国内 GCJ→WGS→GCJ 往返误差 < 1e-4 度（约10米）", () => {
    // 高德返回的故宫坐标（GCJ-02 量级）
    const gcj = { lat: 39.9163, lon: 116.3972 };
    const wgs = gcj02ToWgs84(gcj.lat, gcj.lon);
    const back = wgs84ToGcj02(wgs.latitude, wgs.longitude);
    assert.ok(Math.abs(back.latitude - gcj.lat) < 1e-4, `lat 往返误差 ${Math.abs(back.latitude - gcj.lat)}`);
    assert.ok(Math.abs(back.longitude - gcj.lon) < 1e-4, `lon 往返误差 ${Math.abs(back.longitude - gcj.lon)}`);
  });

  it("国内转换偏移量在 200~800 米（真实火星坐标偏移量级）", () => {
    const lat = 25.69, lon = 100.16;
    const gcj = wgs84ToGcj02(lat, lon);
    const dLat = ((gcj.latitude - lat) * Math.PI) / 180;
    const dLon = ((gcj.longitude - lon) * Math.PI) / 180;
    const meters =
      Math.sqrt(dLat * dLat + dLon * dLon) * 6371000;
    assert.ok(meters > 200 && meters < 800, `偏移 ${meters.toFixed(1)}m 应在 200~800m`);
  });
});

// ==================== 地理编码择优 ====================

describe("pickBestNominatim (位置准确性)", () => {
  it("歧义地名优先选行政中心而非同名 POI", () => {
    const candidates = [
      { lat: "25.60", lon: "100.20", class: "tourism", type: "hotel", display_name: "大理某客栈", importance: 0.3 },
      { lat: "25.69", lon: "100.16", class: "place", type: "city", display_name: "大理市", importance: 0.7 },
    ];
    const best = pickBestNominatim(candidates, "大理");
    assert.equal(best?.display_name, "大理市");
  });

  it("无行政中心候选时按 importance 择优；空列表返回 null", () => {
    const candidates = [
      { lat: "1", lon: "1", class: "tourism", type: "attraction", importance: 0.2 },
      { lat: "2", lon: "2", class: "boundary", type: "administrative", importance: 0.4 },
    ];
    assert.equal(pickBestNominatim(candidates, "x")?.lat, "2");
    assert.equal(pickBestNominatim([], "x"), null);
  });
});

// ==================== 调度器：每日真实安排 ====================

describe("buildDaysFast 每日完整性 (真实逐日规划)", () => {
  it("3 天行程 × 24 景点：每天有景点、午晚餐齐全", async () => {
    const { days } = await buildDays(
      service,
      3,
      "2026-09-15",
      attractionGrid(24),
      [mkPoi("酒店1", CENTER.latitude, CENTER.longitude, "hotel")],
      restaurantRing(12),
      CENTER,
      PREFERENCES,
      TRAVEL_INFO,
      PRICING_CTX,
      [], // perDayWeather：空数组 = 无逐日天气（不触发天气分槽/暴雨降档）
      [], // cafes：空数组 = 无茶歇候选池
    );
    assert.equal(days.length, 3);
    for (let i = 0; i < 3; i++) {
      const day = days[i];
      assert.ok(attrCount(day) >= 1, `Day${i + 1} 应至少有 1 个景点，实际 ${attrCount(day)}`);
      const meals = mealNames(day);
      assert.ok(meals.lunch, `Day${i + 1} 缺午餐`);
      assert.ok(meals.dinner, `Day${i + 1} 缺晚餐`);
    }
    // 景点总量应尽量铺满（而非集中在前一天后被丢弃）
    const total = days.reduce((n, d) => n + attrCount(d), 0);
    assert.ok(total >= 6, `3 天共排入 ${total} 个景点，应 ≥ 6`);
    // 每天分布均衡：不允许某天 0 个而另一天满载
    const counts = days.map(attrCount);
    assert.ok(Math.max(...counts) - Math.min(...counts) <= 4, `每日景点数过散: ${counts.join(",")}`);
  });

  it("单日超预算的景点顺延到后续天而非丢弃（spillover）", async () => {
    // 18 个景点挤在一起：单天时间预算只能装 ~3 个，其余必须分流
    const { days } = await buildDays(
      service,
      3,
      "2026-09-15",
      attractionGrid(18, 0.02),
      [mkPoi("酒店1", CENTER.latitude, CENTER.longitude, "hotel")],
      restaurantRing(10),
      CENTER,
      PREFERENCES,
      TRAVEL_INFO,
      PRICING_CTX,
      [], // perDayWeather：空数组 = 无逐日天气（不触发天气分槽/暴雨降档）
      [], // cafes：空数组 = 无茶歇候选池
    );
    const counts = days.map(attrCount);
    const total = counts.reduce((a, b) => a + b, 0);
    // 修复前：Day1 装满后剩余直接丢弃 → 后面天可能为 0
    assert.ok(counts[0]! >= 1, "Day1 有景点");
    assert.ok(counts[1]! >= 1, `Day2 有景点（顺延生效），实际 ${counts[1]}`);
    assert.ok(counts[2]! >= 1, `Day3 有景点（顺延生效），实际 ${counts[2]}`);
    assert.ok(total >= 9, `顺延后总排入 ${total} 个景点，应明显多于单天容量 3~4`);
  });

  it("顺延/补位不产生重复景点：同名景点全行程至多出现一次", async () => {
    // 回归：旧实现顺延只把副本插进下一天、原件仍留在当天，同一点会
    // 同天/跨天重复出现（线上「喀什古城景区一天两次」即此路径）
    const { days } = await buildDays(
      service,
      3,
      "2026-09-15",
      attractionGrid(18, 0.02),
      [mkPoi("酒店1", CENTER.latitude, CENTER.longitude, "hotel")],
      restaurantRing(10),
      CENTER,
      PREFERENCES,
      TRAVEL_INFO,
      PRICING_CTX,
      [],
      [],
    );
    const names = days.flatMap((d: { items: Array<{ type: string; name: string }> }) =>
      d.items.filter((it) => it.type === "attraction").map((it) => it.name),
    );
    const unique = new Set(names);
    assert.equal(
      names.length,
      unique.size,
      `出现重复景点: ${names.filter((n: string, i: number) => names.indexOf(n) !== i).join("、")}`,
    );
  });

  it("顺路闸：距住宿超合理通勤半径的景点移出编排并回报名单", async () => {
    // 近点 2 个（酒店周边 ~1km）+ 远点 6 个（约 550km 外，模拟「新疆」混入全疆 POI）
    const near = attractionGrid(2, 0.01);
    const far = Array.from({ length: 6 }, (_, i) =>
      mkPoi(`远方景点${i + 1}`, CENTER.latitude + 5, CENTER.longitude + i * 0.1, "attraction"),
    );
    const { days, farPoiNames } = await buildDays(
      service,
      2,
      "2026-09-15",
      [...near, ...far],
      [mkPoi("酒店1", CENTER.latitude, CENTER.longitude, "hotel")],
      restaurantRing(6),
      CENTER,
      PREFERENCES,
      TRAVEL_INFO,
      PRICING_CTX,
      [],
      [],
    );
    const scheduled = days.flatMap((d: { items: Array<{ type: string; name: string }> }) =>
      d.items.filter((it) => it.type === "attraction").map((it) => it.name),
    );
    assert.ok(scheduled.length > 0, "近点应正常排入");
    for (const name of scheduled) {
      assert.ok(!name.startsWith("远方景点"), `远点「${name}」不应被排入行程`);
    }
    assert.ok((farPoiNames ?? []).length === 6, `farPoiNames 应含 6 个远点，实际 ${farPoiNames?.length}`);
  });

  it("第 2 天起以「从酒店出发」开篇（起点锚定住宿）", async () => {
    const { days } = await buildDays(
      service,
      3,
      "2026-09-15",
      attractionGrid(9),
      [mkPoi("酒店1", CENTER.latitude, CENTER.longitude, "hotel")],
      restaurantRing(8),
      CENTER,
      PREFERENCES,
      TRAVEL_INFO,
      PRICING_CTX,
      [],
      [],
    );
    for (let i = 1; i < days.length; i++) {
      const first = days[i].items[0];
      assert.ok(first, `Day${i + 1} 应有条目`);
      assert.equal(first.type, "hotel", `Day${i + 1} 首条应为酒店出发锚点，实际 ${first.type}`);
      assert.ok(
        (first.tips ?? []).some((t: string) => t.includes("从酒店出发")),
        `Day${i + 1} 首条应注明「从酒店出发」`,
      );
    }
  });

  it("5 天行程 × 12 景点（池子紧张）：依然每天有安排，绝无空天", async () => {
    const { days } = await buildDays(
      service,
      5,
      "2026-09-15",
      attractionGrid(12),
      [mkPoi("酒店1", CENTER.latitude, CENTER.longitude, "hotel")],
      restaurantRing(10),
      CENTER,
      PREFERENCES,
      TRAVEL_INFO,
      PRICING_CTX,
      [], // perDayWeather：空数组 = 无逐日天气（不触发天气分槽/暴雨降档）
      [], // cafes：空数组 = 无茶歇候选池
    );
    assert.equal(days.length, 5);
    for (let i = 0; i < 5; i++) {
      const day = days[i];
      assert.ok(
        day.items.length >= 1,
        `Day${i + 1} 不能是空天（至少有酒店/餐食锚点）`,
      );
      const meals = mealNames(day);
      assert.ok(meals.lunch && meals.dinner, `Day${i + 1} 午晚餐应齐全`);
      if (i < 4) {
        assert.ok(attrCount(day) >= 1, `Day${i + 1} 池子可覆盖时应至少 1 个景点，实际 ${attrCount(day)}`);
      }
    }
  });

  it("极端：1 个景点 3 天 —— 无景点天也有餐食与住宿锚点，不是空白页", async () => {
    const { days } = await buildDays(
      service,
      3,
      "2026-09-15",
      [mkPoi("唯一景点", CENTER.latitude + 0.01, CENTER.longitude + 0.01, "attraction")],
      [mkPoi("酒店1", CENTER.latitude, CENTER.longitude, "hotel")],
      restaurantRing(4),
      CENTER,
      PREFERENCES,
      TRAVEL_INFO,
      PRICING_CTX,
      [], // perDayWeather：空数组 = 无逐日天气（不触发天气分槽/暴雨降档）
      [], // cafes：空数组 = 无茶歇候选池
    );
    for (let i = 0; i < 3; i++) {
      const day = days[i];
      assert.ok(day.items.length >= 3, `Day${i + 1} 至少有 午餐+晚餐+酒店锚点，实际 ${day.items.length}`);
      const meals = mealNames(day);
      assert.ok(meals.lunch && meals.dinner, `Day${i + 1} 无景点也应午晚餐齐全`);
      assert.ok(
        day.items.some((it: { type: string }) => it.type === "hotel"),
        `Day${i + 1} 应有住宿锚点`,
      );
    }
  });

  it("时间线单调不回绕：每天条目时间不早于前一条目", async () => {
    const { days } = await buildDays(
      service,
      3,
      "2026-09-15",
      attractionGrid(15),
      [mkPoi("酒店1", CENTER.latitude, CENTER.longitude, "hotel")],
      restaurantRing(9),
      CENTER,
      PREFERENCES,
      TRAVEL_INFO,
      PRICING_CTX,
      [], // perDayWeather：空数组 = 无逐日天气（不触发天气分槽/暴雨降档）
      [], // cafes：空数组 = 无茶歇候选池
    );
    for (let i = 0; i < days.length; i++) {
      const times = days[i]!.items.map((it: { startTime: string }) => it.startTime);
      for (let t = 1; t < times.length; t++) {
        assert.ok(
          times[t]! >= times[t - 1]!,
          `Day${i + 1} 时间线回绕: ${times[t - 1]} → ${times[t]}`,
        );
      }
      // 不越过当日硬上限（22:00 之后不应有新条目开始）
      const last = times[times.length - 1]!;
      assert.ok(last <= "22:30", `Day${i + 1} 条目开始时间越过夜间上限: ${last}`);
    }
  });

  it("0 景点池：所有天仍有完整餐食 + 住宿锚点（诚实降级不空白）", async () => {
    const { days } = await buildDays(
      service,
      2,
      "2026-09-15",
      [],
      [mkPoi("酒店1", CENTER.latitude, CENTER.longitude, "hotel")],
      restaurantRing(6),
      CENTER,
      PREFERENCES,
      TRAVEL_INFO,
      PRICING_CTX,
      [], // perDayWeather：空数组 = 无逐日天气（不触发天气分槽/暴雨降档）
      [], // cafes：空数组 = 无茶歇候选池
    );
    assert.equal(days.length, 2);
    for (let i = 0; i < 2; i++) {
      const meals = mealNames(days[i]!);
      assert.ok(meals.lunch && meals.dinner, `Day${i + 1} 午晚餐应齐全`);
      assert.ok(days[i]!.items.some((it: { type: string }) => it.type === "hotel"));
    }
  });
});

// ==================== 逐日天气 × 吃玩休息节奏 ====================

/** 构造逐日天气包（TripDayWeather 结构对齐 travel-planning-service 内部定义，不经网络） */
function mkDayWx(opts: {
  morningRainy?: boolean;
  afternoonRainy?: boolean;
  afternoonHot?: boolean;
  summary?: string;
}) {
  const slot = (rainy: boolean, hot: boolean) => ({ rainy, hot, cold: false, precipPct: rainy ? 85 : 10 });
  return {
    ctx: {
      morning: slot(opts.morningRainy ?? false, false),
      afternoon: slot(opts.afternoonRainy ?? false, opts.afternoonHot ?? false),
      evening: slot(false, false),
      isRainyDay: !!(opts.morningRainy || opts.afternoonRainy),
      isHotDay: !!opts.afternoonHot,
      isColdDay: false,
      summary: opts.summary ?? "",
    },
    summary: opts.summary,
  } as any;
}

describe("逐日天气分槽与茶歇 (吃玩休息)", () => {
  it("foldHourlyToCtx：下午下雨行折叠出 afternoon.rainy，上午不受影响", () => {
    const rows = [
      { hour: "09:00", temperatureC: 20, weatherCode: 0 },
      { hour: "10:00", temperatureC: 21, weatherCode: 0 },
      { hour: "13:00", temperatureC: 19, weatherCode: 63 },
      { hour: "14:00", temperatureC: 18, weatherCode: 63, precipitationProbabilityPct: 80 },
      { hour: "20:00", temperatureC: 17, weatherCode: 0 },
    ];
    const ctx = (service as any).foldHourlyToCtx(rows);
    assert.equal(ctx.morning.rainy, false, "上午无雨");
    assert.equal(ctx.afternoon.rainy, true, "下午中雨码 63 → rainy");
    assert.equal(ctx.isRainyDay, true);
  });

  it("foldHourlyToCtx：下午 ≥32°C 折叠出 afternoon.hot（触发茶歇避暑）", () => {
    const rows = [
      { hour: "09:00", temperatureC: 28, weatherCode: 0 },
      { hour: "13:00", temperatureC: 35, weatherCode: 0 },
      { hour: "15:00", temperatureC: 36, weatherCode: 0 },
    ];
    const ctx = (service as any).foldHourlyToCtx(rows);
    assert.equal(ctx.afternoon.hot, true);
    assert.equal(ctx.isHotDay, true);
    assert.equal(ctx.afternoon.rainy, false);
  });

  it("雨天下午 + 咖啡池：当天必排茶歇，tips 带避雨说明", async () => {
    const cafes = [mkPoi("咖啡馆A", CENTER.latitude + 0.01, CENTER.longitude, "restaurant")];
    const { days } = await buildDays(
      service,
      2,
      "2026-09-15",
      attractionGrid(8),
      [mkPoi("酒店1", CENTER.latitude, CENTER.longitude, "hotel")],
      restaurantRing(6),
      CENTER,
      PREFERENCES,
      TRAVEL_INFO,
      PRICING_CTX,
      [mkDayWx({ afternoonRainy: true, summary: "小雨，18–24°C" }), mkDayWx({ afternoonRainy: true, summary: "小雨" })],
      cafes,
    );
    for (let i = 0; i < days.length; i++) {
      const day = days[i];
      const tea = day.items.find(
        (it: { tips?: string[] }) => it.tips?.some((t) => t.includes("茶歇")),
      );
      assert.ok(tea, `Day${i + 1} 雨天下午应排茶歇`);
      assert.ok(
        tea.tips.some((t: string) => t.includes("避雨")),
        "茶歇 tips 应说明避雨原因",
      );
      assert.equal(day.dayWeather, i === 0 ? "小雨，18–24°C" : "小雨", "dayWeather 应携带逐日摘要");
    }
  });

  it("晴天 intensive 节奏：不排茶歇（茶歇仅 hot/rainy 必排或 relaxed 可排）", async () => {
    const cafes = [mkPoi("咖啡馆B", CENTER.latitude + 0.01, CENTER.longitude, "restaurant")];
    const { days } = await buildDays(
      service,
      1,
      "2026-09-15",
      attractionGrid(6),
      [mkPoi("酒店1", CENTER.latitude, CENTER.longitude, "hotel")],
      restaurantRing(6),
      CENTER,
      { ...PREFERENCES, pace: "intensive" },
      TRAVEL_INFO,
      PRICING_CTX,
      [mkDayWx({})],
      cafes,
    );
    const tea = days[0]!.items.find((it: { tips?: string[] }) =>
      it.tips?.some((t) => t.includes("茶歇")),
    );
    assert.ok(!tea, "晴天 intensive 不应排茶歇");
  });

  it("雨天空景点池：茶歇锚定主酒店照排（每天不空白）", async () => {
    const cafes = [mkPoi("咖啡馆C", CENTER.latitude + 0.005, CENTER.longitude + 0.005, "restaurant")];
    const { days } = await buildDays(
      service,
      1,
      "2026-09-15",
      [],
      [mkPoi("酒店1", CENTER.latitude, CENTER.longitude, "hotel")],
      restaurantRing(4),
      CENTER,
      PREFERENCES,
      TRAVEL_INFO,
      PRICING_CTX,
      [mkDayWx({ afternoonRainy: true })],
      cafes,
    );
    const tea = days[0]!.items.find((it: { tips?: string[] }) =>
      it.tips?.some((t) => t.includes("茶歇")),
    );
    assert.ok(tea, "无景点时雨天茶歇仍应排（锚定酒店）");
  });
});

// ==================== 住宿锚定优选 ====================

describe("pickPrimaryHotel (住宿锚定)", () => {
  it("优选离景点质心近的酒店，而非搜索结果第一个", () => {
    const attractions = attractionGrid(6, 0.01); // 集中在 CENTER 附近
    const nearHotel = mkPoi("近酒店", CENTER.latitude + 0.005, CENTER.longitude, "hotel");
    const farHotel = mkPoi("远酒店", CENTER.latitude + 0.5, CENTER.longitude + 0.5, "hotel"); // ~70km 外
    const picked = (service as any).pickPrimaryHotel([farHotel, nearHotel], attractions, PREFERENCES);
    assert.equal(picked?.name, "近酒店", "应选离景点质心近的酒店");
  });

  it("无酒店池返回 undefined（起点退回目的地中心）", () => {
    const picked = (service as any).pickPrimaryHotel([], attractionGrid(3), PREFERENCES);
    assert.equal(picked, undefined);
  });
});

// ==================== 雨天室内餐厅优先 ====================

describe("pickRestaurantOnRoute indoorHint (雨天室内)", () => {
  const prefs = PREFERENCES;
  const usedIds = new Set<string>();

  it("传 'indoor' 时，稍远但带 indoor 标签的餐厅胜过更近的室外餐厅", () => {
    const nearOutdoor = mkPoi("路边摊", CENTER.latitude + 0.01, CENTER.longitude, "restaurant");
    const farIndoor = mkPoi("商场餐厅", CENTER.latitude + 0.05, CENTER.longitude, "restaurant");
    farIndoor.tags = ["indoor"];
    const picked = (service as any).pickRestaurantOnRoute(
      [nearOutdoor, farIndoor], CENTER.latitude, CENTER.longitude, usedIds, prefs, undefined, "indoor",
    );
    assert.equal(picked?.name, "商场餐厅", "雨天应优先室内餐厅");
  });

  it("不传 indoorHint（晴天）时，距离近的餐厅照常胜出", () => {
    const nearOutdoor = mkPoi("路边摊2", CENTER.latitude + 0.01, CENTER.longitude, "restaurant");
    const farIndoor = mkPoi("商场餐厅2", CENTER.latitude + 0.05, CENTER.longitude, "restaurant");
    farIndoor.tags = ["indoor"];
    const picked = (service as any).pickRestaurantOnRoute(
      [nearOutdoor, farIndoor], CENTER.latitude, CENTER.longitude, new Set(), prefs, undefined,
    );
    assert.equal(picked?.name, "路边摊2", "晴天距离优先");
  });

  it("传 'indoor' 但候选全无 indoor 标签：自然回落距离优先", () => {
    const near = mkPoi("近餐厅", CENTER.latitude + 0.01, CENTER.longitude, "restaurant");
    const far = mkPoi("远餐厅", CENTER.latitude + 0.05, CENTER.longitude, "restaurant");
    const picked = (service as any).pickRestaurantOnRoute(
      [near, far], CENTER.latitude, CENTER.longitude, new Set(), prefs, undefined, "indoor",
    );
    assert.equal(picked?.name, "近餐厅");
  });
});

// ==================== 茶歇图片直通 ====================

describe("collectMediaForDays cafe 图源直通", () => {
  it("cafe 不在缓存三桶：extraImagesByPoiId 透传后进 imageMap，不再进 missing", () => {
    const cafeItem = {
      itemId: "restaurant-cafe-1-1",
      poiId: "cafe-1",
      type: "restaurant" as const,
      name: "咖啡馆D",
      latitude: CENTER.latitude,
      longitude: CENTER.longitude,
    };
    const days = [{ date: "2026-09-15", items: [cafeItem] }] as any;
    const extra = new Map([["cafe-1", ["https://img.example/amap-cafe.jpg"]]]);
    const { imageMap, missing } = (service as any).collectMediaForDays(days, null, extra);
    // imageMap 键格式为 `${type}-${itemId}`
    assert.deepEqual(imageMap.get(`restaurant-${cafeItem.itemId}`), ["https://img.example/amap-cafe.jpg"]);
    assert.equal(missing.length, 0, "有直通图不应进回填队列");
  });

  it("无直通图且缓存未命中：照旧进 missing（后台回填）", () => {
    const cafeItem = {
      itemId: "restaurant-cafe-2-1",
      poiId: "cafe-2",
      type: "restaurant" as const,
      name: "咖啡馆E",
      latitude: CENTER.latitude,
      longitude: CENTER.longitude,
    };
    const days = [{ date: "2026-09-15", items: [cafeItem] }] as any;
    const { imageMap, missing } = (service as any).collectMediaForDays(days, null, new Map());
    assert.ok(!imageMap.has("restaurant-cafe-2-1"));
    assert.equal(missing.length, 1);
  });
});

// ==================== 瓦片缓存与代理白名单 ====================

describe("travel-tile-cache (地图预加载)", () => {
  let server: http.Server;
  let port = 0;
  let hits = 0;
  let cache: TravelTileCache;
  let dir: string;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "tile-cache-test-"));
    server = http.createServer((req, res) => {
      hits++;
      res.writeHead(200, { "Content-Type": "image/png" });
      res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, hits & 0xff]));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    assert.ok(addr && typeof addr === "object");
    port = (addr as { port: number }).port;

    process.env.TRAVEL_TILE_CACHE_DIR = dir;
    process.env.TRAVEL_TILE_ALLOW_HOSTS = "127.0.0.1";
    cache = new TravelTileCache();
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    delete process.env.TRAVEL_TILE_CACHE_DIR;
    delete process.env.TRAVEL_TILE_ALLOW_HOSTS;
  });

  it("白名单：openfreemap/arcgisonline 放行，其它域名与 http 拒绝", () => {
    // CARTO 已下线，仍要在拒绝列表里
    assert.ok(cache.isAllowedUpstream("https://tiles.openfreemap.org/styles/dark"));
    assert.ok(cache.isAllowedUpstream("https://tiles.openfreemap.org/tiles/basemap/1/2/3.pbf"));
    assert.ok(cache.isAllowedUpstream("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/1/2/3"));
    assert.ok(!cache.isAllowedUpstream("https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json"));
    assert.ok(!cache.isAllowedUpstream("https://evil.example.com/tile.png"));
    assert.ok(!cache.isAllowedUpstream("http://tiles.openfreemap.org/tiles/basemap/1/2/3.pbf"));
    assert.ok(!cache.isAllowedUpstream("not a url"));
  });

  it("磁盘缓存：第二次同 URL 命中缓存不再打上游", async () => {
    const url = `http://127.0.0.1:${port}/tile/1/2/3.png`;
    const r1 = await cache.fetch(url);
    assert.ok(r1.ok);
    assert.equal(r1.fromCache, false);
    const beforeHits = hits;
    const r2 = await cache.fetch(url);
    assert.ok(r2.ok);
    assert.equal(r2.fromCache, true, "第二次应命中缓存");
    assert.equal(hits, beforeHits, "上游请求数不应增加");
    assert.deepEqual([...r1.body], [...r2.body], "缓存内容一致");
    // 磁盘上应真实落盘（.body 文件存在）
    const sub = readdirSync(dir).find((d) => statSync(join(dir, d)).isDirectory());
    assert.ok(sub, "应有二级缓存目录");
  });

  it("上游失败且无缓存：返回失败状态，不落盘", async () => {
    const r = await cache.fetch(`http://127.0.0.1:${port}/missing`.replace(`:${port}`, ":1"));
    assert.equal(r.ok, false);
    assert.ok(r.status >= 400);
  });

  it("非白名单 URL 直接 403，不发起网络请求", async () => {
    const r = await cache.fetch("https://evil.example.com/tile.png");
    assert.equal(r.status, 403);
    assert.equal(r.ok, false);
  });
});
