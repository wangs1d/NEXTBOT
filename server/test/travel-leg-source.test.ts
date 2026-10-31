/**
 * 车程取数与时刻装配单测：
 *   1. 取数顺序 高德路径规划 → OSRM → 直线估算，且每条腿带 source 来源标；
 *   2. OSRM 熔断只影响 OSRM 这一级，不再把整批拖回估算；
 *   3. retimeDayAfterEdit 的时钟：到达 = 上一站结束 + 本段车程，饭点窗口只往后
 *      推（不在晚到时把人拽回 13:00），车程来源随 transportFromPrev 传到展示层。
 *
 * 网络全部由 fetch 桩接管；OSRM 地址指向必关闭端口，避免任何用例漏出真网。
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

process.env.TRAVEL_ROUTE_API_BASE = "http://127.0.0.1:9";

import { PlanningService } from "../src/skills/travel-planning/travel-planning-service.js";

type Leg = { mode: string; durationMin: number; distanceKm: number; source?: string; note?: string };

const AMAP_HOST = "restapi.amap.com";
const OSRM_PATH = "/route/v1/driving/";

let calls: string[] = [];
const realFetch = globalThis.fetch;

/** fetch 桩：只按 URL 分派，记录每次请求（含被拒的） */
function installFetch(handler: (url: string) => Response | Promise<Response>): void {
  calls = [];
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    calls.push(url);
    return handler(url);
  }) as typeof fetch;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** 高德路径规划成功响应：duration 秒 / distance 米 */
function amapOk(durationSec: number, distanceM: number): Response {
  return json({ status: "1", route: { paths: [{ duration: String(durationSec), distance: String(distanceM) }] } });
}

/** OSRM 成功响应：duration 秒 / distance 米 */
function osrmOk(durationSec: number, distanceM: number): Response {
  return json({ code: "Ok", routes: [{ duration: durationSec, distance: distanceM }] });
}

function isAmap(url: string): boolean {
  return url.includes(AMAP_HOST);
}
function isOsrm(url: string): boolean {
  return url.includes(OSRM_PATH);
}

/** private 方法在测试里直连（编译期私有，运行时可用） */
function legOf(svc: PlanningService, a: [number, number], b: [number, number]): Promise<Leg> {
  return (svc as unknown as {
    transportLeg: (a1: number, b1: number, a2: number, b2: number) => Promise<Leg>;
  }).transportLeg(a[0], a[1], b[0], b[1]);
}

beforeEach(() => {
  process.env.AMAP_WEB_KEY = "test-amap-key";
  process.env.TRAVEL_ROUTE_API_BASE = "http://127.0.0.1:9";
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.AMAP_WEB_KEY;
});

describe("transportLeg：高德优先 / OSRM 兜底 / 估算末级", () => {
  it("短驳走高德步行，腿来源标 amap", async () => {
    installFetch(() => amapOk(900, 1200)); // 15 分钟 / 1.2km
    const svc = new PlanningService();
    const leg = await legOf(svc, [30.0, 120.0], [30.005, 120.005]);

    assert.equal(leg.source, "amap");
    assert.equal(leg.mode, "步行", "≤1.5km 直驳用步行口径，不能用驾车时长压低");
    assert.equal(leg.durationMin, 15);
    assert.equal(leg.distanceKm, 1.2);
    assert.ok(calls[0]!.includes("/direction/walking"), `应请求高德步行接口：${calls[0]}`);
    assert.equal(calls.filter(isOsrm).length, 0, "高德成功就不该再打 OSRM");
  });

  it("跨区走高德驾车（含实时路况 strategy=2）", async () => {
    installFetch(() => amapOk(3000, 42000));
    const svc = new PlanningService();
    const leg = await legOf(svc, [30.0, 120.0], [30.3, 120.4]);

    assert.equal(leg.source, "amap");
    assert.equal(leg.mode, "驾车");
    assert.equal(leg.durationMin, 50);
    assert.ok(calls[0]!.includes("/direction/driving"));
    assert.ok(calls[0]!.includes("strategy=2"));
  });

  it("高德失败才降级 OSRM，腿来源标 osrm", async () => {
    installFetch((url) => {
      if (isAmap(url)) return json({ status: "0", info: "DAILY_QUERY_OVER_LIMIT" });
      if (isOsrm(url)) return osrmOk(1200, 4000);
      return json({}, 404);
    });
    const svc = new PlanningService();
    const leg = await legOf(svc, [30.0, 120.0], [30.3, 120.4]);

    assert.equal(leg.source, "osrm");
    assert.equal(leg.durationMin, 20);
    assert.equal(leg.mode, "打车/Grab");
    assert.equal(calls.filter(isAmap).length, 1);
    assert.equal(calls.filter(isOsrm).length, 1);
  });

  it("两级都挂才估算：标 estimate，且 OSRM 熔断后本批不再重试", async () => {
    installFetch(() => {
      throw new Error("network down");
    });
    const svc = new PlanningService();
    const first = await legOf(svc, [30.0, 120.0], [31.0, 121.0]);
    const second = await legOf(svc, [30.0, 120.0], [32.0, 122.0]);

    assert.equal(first.source, "estimate");
    assert.equal(second.source, "estimate");
    assert.equal(calls.filter(isOsrm).length, 1, "熔断期内不再打 OSRM；高德每段仍会试一次");
    assert.equal(calls.filter(isAmap).length, 2);
  });

  it("没配高德 key 时不发高德请求，直接走 OSRM", async () => {
    delete process.env.AMAP_WEB_KEY;
    installFetch((url) => (isOsrm(url) ? osrmOk(600, 3000) : json({}, 500)));
    const svc = new PlanningService();
    const leg = await legOf(svc, [30.0, 120.0], [30.3, 120.4]);

    assert.equal(leg.source, "osrm");
    assert.equal(calls.filter(isAmap).length, 0);
  });

  it("同一对坐标命中 24h 缓存，重复查询不再发请求", async () => {
    installFetch(() => amapOk(900, 1200));
    const svc = new PlanningService();
    await legOf(svc, [30.0, 120.0], [30.005, 120.005]);
    const before = calls.length;
    const again = await legOf(svc, [30.0, 120.0], [30.005, 120.005]);

    assert.equal(again.source, "amap");
    assert.equal(calls.length, before, "缓存命中不应再请求上游");
  });
});

describe("retimeDayAfterEdit：本段车程计入时钟，饭点窗口只往后推", () => {
  type Item = {
    type: string;
    name?: string;
    startTime: string;
    latitude: number;
    longitude: number;
    visitDuration?: number;
    transportFromPrev?: { mode: string; durationMin: number; source?: string };
  };

  it("午餐：300 分钟车程后 15:00 到达就是 15:00 吃，不回拽到 13:00", async () => {
    installFetch(() => amapOk(300 * 60, 210000)); // 300 分钟
    const svc = new PlanningService();
    const items: Item[] = [
      { type: "attraction", name: "上午景点", startTime: "09:00", latitude: 30.0, longitude: 120.0, visitDuration: 60 },
      { type: "restaurant", name: "午餐", startTime: "12:00", latitude: 31.9, longitude: 121.9 },
    ];

    const r = await svc.retimeDayAfterEdit(items, 1);

    assert.equal(items[0]!.startTime, "09:00");
    assert.equal(items[1]!.startTime, "15:00", "到达 15:00（10:00 + 300 分），不能被拽回 13:00");
    assert.deepEqual(
      { mode: items[1]!.transportFromPrev?.mode, min: items[1]!.transportFromPrev?.durationMin, src: items[1]!.transportFromPrev?.source },
      { mode: "驾车", min: 300, src: "amap" },
      "餐饮段也要计腿，且来源一路带下去",
    );
    assert.equal(r.dayEndMin, 16 * 60 + 15, "15:00 用餐 75 分钟 → 当日 16:15 收尾");
  });

  it("景点：下一站起点 = 上一站结束 + 本段车程（自洽）", async () => {
    installFetch(() => amapOk(45 * 60, 30000)); // 45 分钟
    const svc = new PlanningService();
    const items: Item[] = [
      { type: "attraction", name: "A", startTime: "09:00", latitude: 30.0, longitude: 120.0, visitDuration: 90 },
      { type: "attraction", name: "B", startTime: "09:00", latitude: 30.5, longitude: 120.5, visitDuration: 60 },
      { type: "attraction", name: "C", startTime: "09:00", latitude: 30.8, longitude: 120.8, visitDuration: 30 },
    ];

    await svc.retimeDayAfterEdit(items, 1);

    assert.equal(items[1]!.startTime, "11:15", "10:30 结束 + 45 分车程");
    assert.equal(items[2]!.startTime, "13:00", "11:15 + 60 分钟停留 + 45 分车程");
    assert.equal(items[1]!.transportFromPrev?.durationMin, 45);
    assert.equal(items[2]!.transportFromPrev?.durationMin, 45);
  });

  it("早到午餐仍按 11:00 起排（窗口下沿不放宽）", async () => {
    installFetch(() => amapOk(10 * 60, 6000));
    const svc = new PlanningService();
    const items: Item[] = [
      { type: "attraction", name: "早景点", startTime: "09:00", latitude: 30.0, longitude: 120.0, visitDuration: 60 },
      { type: "restaurant", name: "午餐", startTime: "12:00", latitude: 30.05, longitude: 120.05 },
    ];

    await svc.retimeDayAfterEdit(items, 1);

    assert.equal(items[1]!.startTime, "11:00", "10:00 到达也不能 10 点吃午饭");
  });
});
