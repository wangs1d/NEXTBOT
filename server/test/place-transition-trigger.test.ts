import assert from "node:assert/strict";
import { test } from "node:test";

import {
  PlaceTransitionTrigger,
  type SemanticPlaceSnapshot,
} from "../src/proactivity/triggers/place-transition-trigger.js";
import type { ProactiveIntent } from "../src/proactivity/proactivity-types.js";

const HOME: SemanticPlaceSnapshot = {
  placeId: "home",
  kind: "home",
  latitude: 39.9,
  longitude: 116.4,
  label: "家",
  radiusMeters: 150,
  confirmed: false,
};
const WORK: SemanticPlaceSnapshot = {
  placeId: "work",
  kind: "work",
  latitude: 39.95,
  longitude: 116.45,
  label: "公司",
  radiusMeters: 150,
  confirmed: false,
};
const GYM: SemanticPlaceSnapshot = {
  placeId: "gym",
  kind: "other",
  latitude: 39.901,
  longitude: 116.401,
  label: "健身房",
  radiusMeters: 100,
  confirmed: false,
};
const HANGZHOU: SemanticPlaceSnapshot = {
  placeId: "hz",
  kind: "other",
  latitude: 30.27,
  longitude: 120.15,
  label: "杭州",
  radiusMeters: 300,
  confirmed: false,
};

function harness(opts?: { confirmations?: number }) {
  let nowMs = Date.parse("2026-09-10T08:00:00Z");
  let current: SemanticPlaceSnapshot | null = null;
  const intents: ProactiveIntent[] = [];
  const trigger = new PlaceTransitionTrigger({
    resolvePlace: () => current,
    resolveHome: () => HOME,
    submitIntent: (intent) => intents.push(intent),
    now: () => new Date(nowMs),
    confirmations: opts?.confirmations ?? 2,
  });
  const report = (
    place: SemanticPlaceSnapshot | null,
    extra?: { accuracyMeters?: number; trigger?: "geofence" | "startup" | "manual" },
  ): ProactiveIntent | null => {
    current = place;
    return trigger.handleLocationReport("u1", {
      latitude: place?.latitude ?? HOME.latitude,
      longitude: place?.longitude ?? HOME.longitude,
      accuracyMeters: extra?.accuracyMeters ?? 20,
      ...(extra?.trigger ? { trigger: extra.trigger } : {}),
    });
  };
  const advance = (ms: number): void => {
    nowMs += ms;
  };
  return { report, advance, intents };
}

test("首次上报只建基线，不把「一直在家」当「刚到家」", () => {
  const { report, intents } = harness();
  assert.equal(report(HOME), null);
  assert.equal(report(HOME), null);
  assert.equal(intents.length, 0);
});

test("离家→到公司：需要两次确认，只发一条到公司意图", () => {
  const { report, intents } = harness();
  report(HOME); // 基线
  report(HOME);
  assert.equal(report(WORK), null); // 第一次到公司：待确认
  const intent = report(WORK); // 第二次确认
  assert.equal(intent?.kind, "place_work_arrival");
  assert.equal(intents.length, 1);
  assert.match(intents[0].summary, /刚到/);
});

test("公司→家：回家意图；12h 内重复回家被冷却", () => {
  const { report, advance, intents } = harness();
  report(HOME);
  report(WORK);
  report(WORK); // 到公司 → work_arrival
  const base = intents.length;
  advance(60 * 60 * 1000);

  report(HOME);
  const arrived = report(HOME);
  assert.equal(arrived?.kind, "place_home_arrival");
  assert.equal(intents.length, base + 1);

  // 再回公司（12h 内，到公司冷却中 → 无意图，但状态要更新）
  advance(60 * 60 * 1000);
  report(WORK);
  report(WORK);
  assert.equal(intents.length, base + 1);

  // 再回家（12h 内）→ 冷却，不再开口
  advance(60 * 60 * 1000);
  report(HOME);
  report(HOME);
  assert.equal(intents.length, base + 1);
});

test("到家后去附近健身房：离家意图，不误判成异地", () => {
  const { report, intents } = harness();
  report(HOME); // 基线
  report(GYM);
  const intent = report(GYM);
  assert.equal(intent?.kind, "place_home_departure");
  assert.equal(intents.length, 1);
});

test("从家到 1000km 外的城市：异地游玩建议意图（24h 冷却）", () => {
  const { report, advance, intents } = harness();
  report(HOME); // 基线
  report(HANGZHOU);
  const intent = report(HANGZHOU);
  assert.equal(intent?.kind, "place_new_city");
  assert.match(intents[0].summary, /真实/);
  assert.match(intents[0].summary, /杭州/);

  // 同一天换到另一处外地地点：24h 冷却，不重复建议
  advance(60 * 60 * 1000);
  report({ ...HANGZHOU, placeId: "hz2", label: "西湖" });
  report({ ...HANGZHOU, placeId: "hz2", label: "西湖" });
  assert.equal(intents.length, 1);
});

test("低精度 fix 不触发任何语义转换", () => {
  const { report, intents } = harness();
  report(HOME);
  report(WORK, { accuracyMeters: 800 });
  report(WORK, { accuracyMeters: 800 });
  assert.equal(intents.length, 0);
});

test("系统围栏事件算可信 fix：一次上报即可确认转换", () => {
  const { report, intents } = harness({ confirmations: 2 });
  report(HOME);
  report(WORK, { trigger: "geofence" });
  assert.equal(intents.length, 1);
  assert.equal(intents[0].kind, "place_work_arrival");
});
