/**
 * 位置上报 → 情境快照 的单测（持续感知 State 层落点）。
 *
 * 锁死的语义：
 *   1. 每次上报都刷新快照（含被历史频控丢弃的那部分）——状态是最新事实，
 *      频控只该限制样本入库密度；
 *   2. placeKind 由命中的围栏名称推断（在家/在公司），重叠时取半径最小的；
 *   3. 围栏查询失败不得影响坐标快照（降级为 unknown）；
 *   4. 快照位置更新不得顶掉设备直报时区。
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ActorContextService } from "../src/services/actor-context-service.js";
import { GeofenceService, inferPlaceKind } from "../src/services/geofence-service.js";
import { LocationIngestPipeline } from "../src/services/location-ingest-pipeline.js";

const NOW = Date.UTC(2026, 10, 5, 1, 0, 0);

async function makeStack() {
  const dir = await mkdtemp(join(tmpdir(), "ingest-ctx-"));
  const context = new ActorContextService({
    persistPath: join(dir, "actor-context.json"),
    persistThrottleMs: 0,
    serverTimezone: "Asia/Shanghai",
    now: () => NOW,
  });
  const geofence = new GeofenceService({
    dbPath: join(dir, "location.db"),
    now: () => new Date(NOW),
  });
  const pipeline = new LocationIngestPipeline({
    history: null,
    geofence,
    context,
    minIntervalMs: 10_000,
    now: () => NOW,
  });
  return {
    context,
    geofence,
    pipeline,
    async dispose() {
      geofence.close();
      await context.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("围栏名称推断地点语义：只认明确的家/公司", () => {
  assert.equal(inferPlaceKind("家"), "home");
  assert.equal(inferPlaceKind("Home"), "home");
  assert.equal(inferPlaceKind("我住的地方"), "other");
  assert.equal(inferPlaceKind("公司"), "work");
  assert.equal(inferPlaceKind("Office"), "work");
  assert.equal(inferPlaceKind("健身房"), "other");
  assert.equal(inferPlaceKind(""), "other");
  assert.equal(inferPlaceKind(undefined), "other");
});

test("上报即更新快照：位置、时区、placeKind 一次到位", async () => {
  const stack = await makeStack();
  try {
    const created = stack.geofence.create("u1", {
      name: "家",
      latitude: 31.23,
      longitude: 121.47,
      radiusMeters: 200,
      event: "enter",
      actionType: "reminder",
      actionConfig: { title: "到家了" },
    });
    assert.ok(!("error" in created));

    stack.pipeline.ingest(
      "u1",
      { latitude: 31.23, longitude: 121.47, city: "上海", timezone: "Asia/Shanghai" },
      "report",
    );

    const ctx = stack.context.get("u1");
    assert.equal(ctx?.location?.city, "上海");
    assert.equal(ctx?.location?.placeKind, "home");
    assert.equal(ctx?.location?.placeLabel, "家");
    // 旧客户端只随位置带时区：仍应被采纳（标记 legacy-location）
    assert.equal(ctx?.clock?.source, "legacy-location");
    assert.equal(stack.context.resolveClock("u1").timezone, "Asia/Shanghai");
  } finally {
    await stack.dispose();
  }
});

test("频控丢弃的上报仍然刷新快照（状态不受采样频率限制）", async () => {
  const stack = await makeStack();
  try {
    const first = stack.pipeline.ingest("u2", { latitude: 30.0, longitude: 120.0 }, "report");
    assert.equal(first, true);
    // 同一时刻的第二次上报被 10s 频控丢弃
    const second = stack.pipeline.ingest("u2", { latitude: 30.5, longitude: 120.5 }, "report");
    assert.equal(second, false);
    // 但快照必须是最新坐标——用户刚移动，prompt 不能还看到旧位置
    assert.equal(stack.context.get("u2")?.location?.latitude, 30.5);
  } finally {
    await stack.dispose();
  }
});

test("重叠围栏取半径最小的（更具体的地点优先）", async () => {
  const stack = await makeStack();
  try {
    stack.geofence.create("u3", {
      name: "小区",
      latitude: 31.2,
      longitude: 121.4,
      radiusMeters: 800,
      event: "enter",
      actionType: "reminder",
      actionConfig: { title: "回小区" },
    });
    stack.geofence.create("u3", {
      name: "家",
      latitude: 31.2,
      longitude: 121.4,
      radiusMeters: 80,
      event: "enter",
      actionType: "reminder",
      actionConfig: { title: "到家" },
    });
    stack.pipeline.ingest("u3", { latitude: 31.2, longitude: 121.4 }, "report");
    const ctx = stack.context.get("u3");
    assert.equal(ctx?.location?.placeKind, "home");
    assert.equal(ctx?.location?.placeLabel, "家");
  } finally {
    await stack.dispose();
  }
});

test("不在任何围栏内时 placeKind 为 unknown，不影响坐标快照", async () => {
  const stack = await makeStack();
  try {
    stack.pipeline.ingest("u4", { latitude: 22.5, longitude: 114.0, city: "深圳" }, "report");
    const ctx = stack.context.get("u4");
    assert.equal(ctx?.location?.placeKind, "unknown");
    assert.equal(ctx?.location?.city, "深圳");
  } finally {
    await stack.dispose();
  }
});

test("快照位置更新不覆盖设备直报时区的存储值（解析冲突时改信定位）", async () => {
  const stack = await makeStack();
  try {
    stack.context.updateClock("u5", {
      timezone: "America/New_York",
      utcOffsetMinutes: -300,
      source: "snapshot",
    });
    stack.pipeline.ingest(
      "u5",
      { latitude: 31.2, longitude: 121.4, timezone: "Asia/Shanghai" },
      "continuous",
    );
    // 存储层：clock 块仍是设备直报原值
    assert.equal(stack.context.get("u5")?.clock?.timezone, "America/New_York");
    // 解析层：设备与定位偏移冲突 → 改信定位（2026-11-06 冲突防御）
    const clock = stack.context.resolveClock("u5");
    assert.equal(clock.timezone, "Asia/Shanghai");
    assert.equal(clock.source, "geo");
  } finally {
    await stack.dispose();
  }
});

test("旧客户端设备时区变了：随位置上报的时区应更新 legacy 时钟", async () => {
  const stack = await makeStack();
  try {
    // 第一次上报：设备在 GMT（模拟器默认时区）
    stack.pipeline.ingest("u6", { latitude: 37.42, longitude: -122.08, timezone: "GMT" }, "report");
    assert.equal(stack.context.get("u6")?.clock?.timezone, "GMT");
    assert.equal(stack.context.get("u6")?.clock?.source, "legacy-location");
    // 用户把设备时区改成 Asia/Shanghai 后再次上报
    stack.pipeline.ingest(
      "u6",
      { latitude: 25.088, longitude: 104.896, timezone: "Asia/Shanghai" },
      "report",
    );
    const clock = stack.context.get("u6")?.clock;
    assert.equal(clock?.timezone, "Asia/Shanghai", "legacy 时钟必须跟住设备时区变化");
    assert.equal(clock?.source, "legacy-location");
    assert.equal(stack.context.resolveClock("u6").timezone, "Asia/Shanghai");
  } finally {
    await stack.dispose();
  }
});

test("legacy 时钟不顶掉设备直报（高权威来源不动）", async () => {
  const stack = await makeStack();
  try {
    stack.context.updateClock("u7", { timezone: "Europe/Paris", source: "event" });
    stack.pipeline.ingest(
      "u7",
      { latitude: 31.2, longitude: 121.4, timezone: "Asia/Shanghai" },
      "report",
    );
    const clock = stack.context.get("u7")?.clock;
    assert.equal(clock?.timezone, "Europe/Paris");
    assert.equal(clock?.source, "event");
  } finally {
    await stack.dispose();
  }
});
