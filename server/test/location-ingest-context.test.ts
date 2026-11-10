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

import { ActorContextService, resolveUserClock } from "../src/services/actor-context-service.js";
import { GeofenceService, inferPlaceKind } from "../src/services/geofence-service.js";
import {
  LocationIngestPipeline,
  type LocationIngestDeps,
} from "../src/services/location-ingest-pipeline.js";

const NOW = Date.UTC(2026, 10, 5, 1, 0, 0);

async function makeStack(pipelineOverrides?: Partial<LocationIngestDeps>) {
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
    ...pipelineOverrides,
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

test("精度元数据落快照：accuracyMeters 与 capturedAt 龄期诚实", async () => {
  const stack = await makeStack();
  try {
    // 正常偏差（30s）：观测时刻用 fix 的真实采集时刻
    const capturedAt = new Date(NOW - 30_000).toISOString();
    stack.pipeline.ingest(
      "u8",
      {
        latitude: 31.23,
        longitude: 121.47,
        accuracyMeters: 12.5,
        altitudeMeters: 1100.2,
        speedMps: 1.4,
        headingDegrees: 213.5,
        capturedAt,
      },
      "report",
    );
    const loc = stack.context.get("u8")?.location;
    assert.equal(loc?.accuracyMeters, 12.5);
    assert.equal(loc?.observedAt, Date.parse(capturedAt));

    // 设备钟偏差过大（>10min，如坏钟手机）：回退服务端接收时刻，不把钟差写进龄期
    const bogusAt = new Date(NOW - 90 * 60_000).toISOString();
    stack.pipeline.ingest(
      "u9",
      { latitude: 30.0, longitude: 120.0, accuracyMeters: 35, capturedAt: bogusAt },
      "report",
    );
    const loc9 = stack.context.get("u9")?.location;
    assert.equal(loc9?.observedAt, NOW);
    assert.equal(loc9?.accuracyMeters, 35);
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

test("设备钟坏了（报 GMT+0）人在中国：逆地理修正 geo 后解析信定位", async () => {
  // 真机实证场景（2378709729@qq.com，2026-11-09）：设备钟快照 GMT+0，
  // 坐标在贵州兴义。客户端回声把快照 geo 时区污染成 GMT，geo 冲突保护
  // 拿 GMT 比 GMT 永远不触发 → 时间块按 UTC 渲染（差 8 小时）。
  const stack = await makeStack({
    reverseGeocode: async () => ({
      city: "兴义市",
      district: "黄草街道",
      region: "贵州省",
      country: "中华人民共和国",
      timezone: "Asia/Shanghai",
      label: "黄草街道 · 兴义市 · 贵州省 · 中华人民共和国",
      source: "bigdatacloud",
    }),
  });
  try {
    stack.context.updateClock("u8", {
      timezone: "GMT",
      utcOffsetMinutes: 0,
      source: "snapshot",
    });
    stack.pipeline.ingest(
      "u8",
      { latitude: 25.088, longitude: 104.896, timezone: "GMT" },
      "report",
    );
    await stack.pipeline.waitForEnrichmentForTest();
    // 快照层：location.timezone 被服务端反解覆盖修正，缺失文本字段补齐
    const loc = stack.context.get("u8")?.location;
    assert.equal(loc?.timezone, "Asia/Shanghai", "快照 geo 时区必须被反解结果修正");
    assert.ok(loc?.label?.includes("兴义市"), "逆地理 label 应补进快照");
    // 解析层：设备 GMT（偏移 0）与 geo Asia/Shanghai（偏移 +480）冲突 → 信定位
    const clock = stack.context.resolveClock("u8");
    assert.equal(clock.timezone, "Asia/Shanghai");
    assert.equal(clock.source, "geo");
  } finally {
    await stack.dispose();
  }
});

test("逆地理失败时快照保持客户端原值（修正缺席不劣化）", async () => {
  const stack = await makeStack({ reverseGeocode: async () => null });
  try {
    stack.pipeline.ingest(
      "u9",
      { latitude: 25.088, longitude: 104.896, timezone: "GMT", city: "手工上报城市" },
      "report",
    );
    await stack.pipeline.waitForEnrichmentForTest();
    const loc = stack.context.get("u9")?.location;
    assert.equal(loc?.timezone, "GMT");
    assert.equal(loc?.city, "手工上报城市");
  } finally {
    await stack.dispose();
  }
});

test("设备时区字符串与自报偏移自相矛盾：geo 印证偏移时信 geo", () => {
  // 变体场景：字符串说 Asia/Shanghai(+480) 但设备自报偏移 0。
  // geo=Europe/London（冬季偏移 0）与设备钟互相印证 → 字符串是过期/损坏读数，信 geo。
  const geoConfirm = resolveUserClock({
    clientTimezone: "Asia/Shanghai",
    clientUtcOffsetMinutes: 0,
    clientSource: "snapshot",
    geoTimezone: "Europe/London",
    serverTimezone: "Asia/Shanghai",
  });
  assert.equal(geoConfirm.timezone, "Europe/London");
  assert.equal(geoConfirm.source, "geo");

  // geo 与字符串一致（两个源互相印证）、只有自报偏移是异类 → 保留设备字符串
  const keepClient = resolveUserClock({
    clientTimezone: "Asia/Shanghai",
    clientUtcOffsetMinutes: 0,
    clientSource: "snapshot",
    geoTimezone: "Asia/Shanghai",
    serverTimezone: "Asia/Shanghai",
  });
  assert.equal(keepClient.timezone, "Asia/Shanghai");
  assert.equal(keepClient.source, "client-snapshot");

  // 自洽的正常设备不受影响：字符串与偏移一致 → 仍信设备
  const trusted = resolveUserClock({
    clientTimezone: "Asia/Shanghai",
    clientUtcOffsetMinutes: 480,
    clientSource: "snapshot",
  });
  assert.equal(trusted.timezone, "Asia/Shanghai");
  assert.equal(trusted.source, "client-snapshot");
});
