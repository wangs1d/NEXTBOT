/**
 * 位置方案 A + D 单测：持续模式配置 / 位置传感器 / 到达触发器。
 *
 * 覆盖：
 *   1. location-env：模式解析（默认 ondemand）、间隔夹紧、历史开关跟随模式
 *   2. LocationCoordinator：持续模式下发 tracking_config（ondemand 不发）
 *   3. LocationSensor：移动跳变 → receptivity 负信号；静止不产出
 *   4. ReceptivityDimensionModel：location_movement 拉低接受度、静止/attempts 口径不变
 *   5. LocationTrigger：到达常去地点触发一次，冷却期内不重复；到访不足不触发
 *
 * 测试封闭：临时 SQLite、注入时钟、env 隔离（前后保存还原），无外部依赖。
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  getLocationReportIntervalSec,
  getLocationTrackingMode,
  isLocationHistoryEnabled,
} from "../src/config/location-env.js";
import { LocationCoordinator } from "../src/services/location-coordinator.js";
import {
  LocationHistoryService,
} from "../src/services/location-history-service.js";
import { LocationSensor } from "../src/rhythm/sensors/location-sensor.js";
import { ReceptivityDimensionModel } from "../src/rhythm/dimensions/receptivity-model.js";
import {
  buildLocationArrivalIntent,
  LocationTrigger,
} from "../src/proactivity/triggers/location-trigger.js";
import type { ProactiveIntent } from "../src/proactivity/proactivity-types.js";

const BASE_AT = Date.parse("2026-09-04T10:00:00Z");

// ---- env 隔离 ----

function withEnv(env: Record<string, string>, fn: () => void | Promise<void>): () => Promise<void> {
  return async () => {
    const saved = new Map<string, string | undefined>();
    for (const k of Object.keys(env)) saved.set(k, process.env[k]);
    for (const [k, v] of Object.entries(env)) process.env[k] = v;
    try {
      await fn();
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };
}

test("location-env：默认 continuous + 间隔夹紧 + 历史默认开启（env 可关）", async () => {
  await withEnv(
    {
      LOCATION_TRACKING_MODE: "",
      LOCATION_REPORT_INTERVAL_SEC: "5",
      LOCATION_HISTORY_ENABLED: "",
    },
    () => {
      assert.equal(getLocationTrackingMode(), "continuous", "2026-11-19 起缺省持续上报");
      assert.equal(isLocationHistoryEnabled(), true, "2026-09-05 起历史默认开启（常去地点注入依赖样本）");
      assert.equal(getLocationReportIntervalSec(), 30, "5s 被夹紧到下限 30s");
    },
  )();
  await withEnv(
    {
      LOCATION_TRACKING_MODE: "ondemand",
      LOCATION_REPORT_INTERVAL_SEC: "600",
    },
    () => {
      assert.equal(getLocationTrackingMode(), "ondemand", "显式 ondemand 仍可退回按需");
      assert.equal(getLocationReportIntervalSec(), 600);
    },
  )();
  await withEnv(
    {
      LOCATION_TRACKING_MODE: "continuous",
      LOCATION_REPORT_INTERVAL_SEC: "99999",
    },
    () => {
      assert.equal(getLocationTrackingMode(), "continuous");
      assert.equal(isLocationHistoryEnabled(), true, "continuous 默认落历史");
      assert.equal(getLocationReportIntervalSec(), 3600, "上限 1h");
    },
  )();
  await withEnv(
    {
      LOCATION_TRACKING_MODE: "continuous",
      LOCATION_HISTORY_ENABLED: "0",
    },
    () => {
      assert.equal(isLocationHistoryEnabled(), false, "显式 0 关闭（默认开启也可显式关闭）");
    },
  )();
});

test("LocationCoordinator：持续模式随绑定下发 config，ondemand 静默", async () => {
  await withEnv({ LOCATION_TRACKING_MODE: "continuous", LOCATION_REPORT_INTERVAL_SEC: "600" }, () => {
    const sent: string[] = [];
    const socket = { send: (d: string) => sent.push(d) };
    const coord = new LocationCoordinator();
    assert.deepEqual(coord.getTrackingConfig(), { mode: "continuous", intervalSec: 600 });
    assert.equal(coord.sendTrackingConfig(socket), true);
    const msg = JSON.parse(sent[0]) as { type: string; payload: { mode: string; intervalSec: number } };
    assert.equal(msg.type, "agent.location_tracking_config");
    assert.equal(msg.payload.mode, "continuous");
    assert.equal(msg.payload.intervalSec, 600);
  })();

  await withEnv({ LOCATION_TRACKING_MODE: "ondemand" }, () => {
    const sent: string[] = [];
    const socket = { send: (d: string) => sent.push(d) };
    const coord = new LocationCoordinator();
    assert.equal(coord.isContinuousTrackingEnabled(), false);
    assert.equal(coord.sendTrackingConfig(socket), false, "ondemand 不下发");
    assert.equal(sent.length, 0);
  })();
});

// ---- 方案 D：传感器与触发器（注入时钟 + 临时库） ----

interface SensorCtx {
  history: LocationHistoryService;
  setNow: (ms: number) => void;
  dir: string;
}

async function withSensor(fn: (ctx: SensorCtx) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "location-sensor-"));
  let nowMs = BASE_AT;
  const history = new LocationHistoryService({
    dbPath: join(dir, "history.db"),
    now: () => new Date(nowMs),
  });
  const setNow = (ms: number) => {
    nowMs = ms;
  };
  try {
    await fn({ history, setNow, dir });
  } finally {
    history.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("LocationSensor：移动跳变产出 receptivity=0 观察，静止不产出", async () => {
  await withSensor(async ({ history, setNow }) => {
    let sensorNowMs = BASE_AT;
    const sensor = new LocationSensor(history, { now: () => new Date(sensorNowMs) });
    const since = new Date(BASE_AT - 24 * 3600_000);

    // 静止：无观察
    for (let i = 0; i < 6; i++) {
      history.record(
        "u1",
        { latitude: 39.9 + Math.sin(i) * 0.00005, longitude: 116.4 },
        "continuous",
        new Date(BASE_AT + i * 5 * 60_000),
      );
    }
    assert.equal(sensor.collect("u1", since).length, 0, "漂移样本不产观察");

    // 通勤跳变两次（间隔 1h）：产出 2 条移动观察
    history.record("u1", { latitude: 39.92, longitude: 116.4 }, "continuous", new Date(BASE_AT + 6 * 3600_000));
    history.record("u1", { latitude: 39.94, longitude: 116.4 }, "continuous", new Date(BASE_AT + 7 * 3600_000));
    sensorNowMs = BASE_AT + 8 * 3600_000; // 传感器与历史时钟都推进到样本之后，窗口才可见
    setNow(BASE_AT + 8 * 3600_000);
    const obs = sensor.collect("u1", since);
    assert.equal(obs.length, 2);
    assert.equal(obs[0].dimension, "receptivity");
    assert.equal(obs[0].value, 0);
    assert.equal(obs[0].kind, "location_movement");
    assert.equal(obs[0].source, "location");
  });
});

test("ReceptivityModel：location_movement 拉低接受度，静止不虚增、attempts 不计", () => {
  const model = new ReceptivityDimensionModel();
  const at = "2026-09-04T09:00:00+08:00"; // 本地 9 点
  let state = model.ingest(null, [
    { dimension: "receptivity", at, value: 1, kind: "contact_outcome", source: "t" },
    { dimension: "receptivity", at, value: 1, kind: "contact_outcome", source: "t" },
  ]);
  const before = state.byHour[9];
  assert.ok(before > 0.4, "两次 accepted 已抬高 9 点接受度");
  assert.equal(state.attempts, 2);

  state = model.ingest(state, [
    // 移动负信号 ×4（同小时）
    ...[0, 1, 2, 3].map(() => ({
      dimension: "receptivity" as const,
      at,
      value: 0,
      kind: "location_movement",
      source: "location",
    })),
    // 静止样本：不应贡献
    { dimension: "receptivity", at, value: 1, kind: "location_movement", source: "location" },
  ]);
  assert.ok(state.byHour[9] < before, "移动观察拉低了接受度");
  assert.equal(state.attempts, 2, "attempts 只计真实触达反馈（置信度口径不变）");
});

test("LocationTrigger：到达常去地点触发一次，冷却 + 到访门槛生效", async () => {
  await withSensor(async ({ history }) => {
    const intents: ProactiveIntent[] = [];
    let nowMs = BASE_AT;
    const trigger = new LocationTrigger({
      history,
      submitIntent: (i) => intents.push(i),
      now: () => new Date(nowMs),
      cooldownMs: 6 * 3600_000,
      minVisits: 8,
    });

    // 家：20 个样本（达到 DBSCAN 默认成簇门槛 minPoints=20），分布在约 1.7 小时内
    for (let i = 0; i < 20; i++) {
      history.record(
        "u1",
        { latitude: 39.9 + Math.sin(i) * 0.00005, longitude: 116.4, label: "家" },
        "continuous",
        new Date(BASE_AT - 8 * 3600_000 + i * 5 * 60_000),
      );
    }
    // 远处：5 个样本（低于成簇门槛 → 噪声，不构成常去地点）
    for (let i = 0; i < 5; i++) {
      history.record(
        "u1",
        { latitude: 39.99, longitude: 116.49, label: "路过点" },
        "continuous",
        new Date(BASE_AT - 4 * 3600_000 + i * 5 * 60_000),
      );
    }

    // 到达「路过点」附近：样本不成簇，不是常去地点，不触发
    assert.equal(trigger.handleLocationReport("u1", { latitude: 39.99, longitude: 116.49 }), null);
    assert.equal(intents.length, 0);

    // 到家：触发一次
    const fired = trigger.handleLocationReport("u1", { latitude: 39.9, longitude: 116.4 });
    assert.ok(fired, "到达常去地点应触发");
    assert.equal(fired.kind, "location_arrival");
    assert.equal(fired.mode, "speak");
    assert.equal(fired.source, "location");
    assert.match(fired.summary, /家/);
    assert.equal(intents.length, 1);

    // 冷却期内再报：不重复
    nowMs = BASE_AT + 60_000;
    assert.equal(trigger.handleLocationReport("u1", { latitude: 39.9, longitude: 116.4 }), null);
    assert.equal(intents.length, 1);

    // 7 小时后：可再次触发
    nowMs = BASE_AT + 7 * 3600_000;
    assert.ok(trigger.handleLocationReport("u1", { latitude: 39.9, longitude: 116.4 }));
    assert.equal(intents.length, 2);
  });
});

test("LocationTrigger：未开启历史（null）时永不触发", () => {
  const intents: ProactiveIntent[] = [];
  const trigger = new LocationTrigger({ history: null, submitIntent: (i) => intents.push(i) });
  assert.equal(trigger.handleLocationReport("u1", { latitude: 39.9, longitude: 116.4 }), null);
  assert.equal(intents.length, 0);
});

test("LocationTrigger：重启后持续停留不重复触发（lastSeenAt 冷却基线跨重启生效）", async () => {
  await withSensor(async ({ history }) => {
    // 用户一直在家：20 个样本持续到 BASE_AT（成簇 + lastSeenAt 新鲜）
    for (let i = 0; i < 20; i++) {
      history.record(
        "u1",
        { latitude: 39.9 + Math.sin(i) * 0.00005, longitude: 116.4, label: "家" },
        "continuous",
        new Date(BASE_AT - 100 * 60_000 + i * 5 * 60_000),
      );
    }
    const intents: ProactiveIntent[] = [];
    let nowMs = BASE_AT + 2 * 60_000;
    // 全新 trigger 实例 = 模拟重启（内存冷却为空）
    const trigger = new LocationTrigger({
      history,
      submitIntent: (i) => intents.push(i),
      now: () => new Date(nowMs),
      cooldownMs: 6 * 3600_000,
      minVisits: 8,
    });
    // 重启后人在家且 lastSeenAt 距今仅 2 分钟：不是「刚到家」，不触发
    assert.equal(trigger.handleLocationReport("u1", { latitude: 39.9, longitude: 116.4 }), null);
    assert.equal(intents.length, 0);

    // 8 小时后（离家一整天）回家：lastSeenAt 已 8h 旧 > 冷却 6h，正常触发
    nowMs = BASE_AT + 8 * 3600_000;
    const fired = trigger.handleLocationReport("u1", { latitude: 39.9, longitude: 116.4 });
    assert.ok(fired, "离开超过冷却期后回家应触发");
    assert.equal(intents.length, 1);
  });
});

test("LocationTrigger：clear→onCleared→invalidate 联动，已删数据不再触发", async () => {
  await withSensor(async ({ history }) => {
    // 家：20 个样本 @ -8h..-6h20m（BASE_AT 时已离开超 6h，可触发）
    for (let i = 0; i < 20; i++) {
      history.record(
        "u1",
        { latitude: 39.9 + Math.sin(i) * 0.00005, longitude: 116.4, label: "家" },
        "continuous",
        new Date(BASE_AT - 8 * 3600_000 + i * 5 * 60_000),
      );
    }
    const intents: ProactiveIntent[] = [];
    let nowMs = BASE_AT;
    const trigger = new LocationTrigger({
      history,
      submitIntent: (i) => intents.push(i),
      now: () => new Date(nowMs),
      cooldownMs: 6 * 3600_000,
      minVisits: 8,
    });
    history.setOnCleared((actorId) => trigger.invalidate(actorId));

    assert.ok(trigger.handleLocationReport("u1", { latitude: 39.9, longitude: 116.4 }));
    assert.equal(intents.length, 1);

    // 7 小时后本可再次触发，但用户此时清除了历史 → 缓存失效、无数据可挖
    nowMs = BASE_AT + 7 * 3600_000;
    assert.equal(history.clear("u1"), 20);
    assert.equal(trigger.handleLocationReport("u1", { latitude: 39.9, longitude: 116.4 }), null);
    assert.equal(intents.length, 1, "清除历史后不再基于已删数据触发");
  });
});

test("buildLocationArrivalIntent：无标签地点回退坐标描述", () => {
  const intent = buildLocationArrivalIntent("u1", {
    id: "place_x",
    label: null,
    latitude: 39.9,
    longitude: 116.4,
    visitCount: 12,
    distinctDays: 3,
    firstSeenAt: "2026-09-01T00:00:00Z",
    lastSeenAt: "2026-09-04T00:00:00Z",
    radiusMeters: 80,
  });
  assert.match(intent.title, /39\.9000, 116\.4000/);
});
