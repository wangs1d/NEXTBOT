import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import Database from "better-sqlite3";

import {
  LocationHistoryService,
  type DayTimeline,
  type DwellEpisode,
} from "../src/services/location-history-service.js";
import {
  PlaceSemanticsService,
  classifyByTemporal,
  combineSemantics,
  computeTemporalFeatures,
  formatPlaceAdminArea,
  inferKindFromPoi,
} from "../src/services/place-semantics-service.js";
import type { ReverseGeocodeHit } from "../src/services/reverse-geocode-service.js";

const NOW = new Date("2026-09-10T12:00:00Z");

function hit(overrides: Partial<ReverseGeocodeHit>): ReverseGeocodeHit {
  return {
    city: "北京市",
    district: "朝阳区",
    region: "北京市",
    country: "中国",
    timezone: "Asia/Shanghai",
    label: "北京市 朝阳区",
    source: "test",
    ...overrides,
  };
}

function episode(
  latitude: number,
  longitude: number,
  startAt: string,
  durationMinutes: number,
): DwellEpisode {
  return {
    latitude,
    longitude,
    startAt,
    endAt: new Date(Date.parse(startAt) + durationMinutes * 60_000).toISOString(),
    durationMinutes,
    sampleCount: Math.max(2, Math.round(durationMinutes / 5)),
    label: "北京市",
    timezone: "Asia/Shanghai",
    accuracyMeters: 20,
  };
}

/** 5 晚 22:00–05:00 在家（CST=UTC+8，14:00Z–21:00Z） */
function homeEpisodes(): DwellEpisode[] {
  return Array.from({ length: 5 }, (_, i) =>
    episode(39.9, 116.4, `2026-09-0${i + 1}T14:00:00Z`, 420),
  );
}

/** 4 个工作日 09:00–17:00 在公司（01:00Z–09:00Z） */
function workEpisodes(): DwellEpisode[] {
  return Array.from({ length: 4 }, (_, i) =>
    episode(39.95, 116.45, `2026-09-0${i + 1}T01:00:00Z`, 480),
  );
}

test("inferKindFromPoi：住宅/办公先验，酒店和学校只算 other", () => {
  assert.equal(inferKindFromPoi({ type: "商务住宅;住宅区;住宅小区" })?.kind, "home");
  assert.equal(inferKindFromPoi({ type: "商务写字楼;商务写字楼" })?.kind, "work");
  assert.equal(inferKindFromPoi({ type: "产业园区;产业园区" })?.kind, "work");

  const hotel = inferKindFromPoi({ type: "住宿服务;宾馆酒店;四星级宾馆" });
  assert.equal(hotel?.kind, "other");
  assert.equal(hotel?.labelHint, "酒店");

  assert.equal(inferKindFromPoi({ type: "科教文化服务;学校;高等院校" })?.kind, "other");

  // 高德有时只给数字类型码（实测「三家村小区」是 120302）：名称兜底
  const numericHome = inferKindFromPoi({ type: "120302", name: "兴义市三家村小区" });
  assert.equal(numericHome?.kind, "home");
  assert.ok((numericHome?.confidence ?? 0) >= 0.6);
  assert.equal(inferKindFromPoi({ type: "120302", name: "稻子巷商场" })?.kind, "other");
  // 名字带「公寓」但实为酒店：不能判家
  assert.equal(inferKindFromPoi({ type: "120302", name: "维也纳公寓酒店" })?.kind, "other");

  // 名字无法明确判断时不猜（避免「九华苑」被误判成家）
  assert.equal(inferKindFromPoi({ name: "九华苑" }), null);
});

test("时间分布：夜间长停留→家，工作日白天长停留→公司", () => {
  const home = computeTemporalFeatures(homeEpisodes());
  assert.equal(classifyByTemporal(home).kind, "home");
  assert.ok(home.distinctNights >= 4);

  const work = computeTemporalFeatures(workEpisodes());
  assert.equal(classifyByTemporal(work).kind, "work");
  assert.ok(work.workdayDayMinutes >= 300);
});

test("POI 先验与时间证据合并：一致时加权，矛盾时降级但不推翻", () => {
  const homeTemporal = classifyByTemporal(computeTemporalFeatures(homeEpisodes()));
  const agreed = combineSemantics(
    { kind: "home", confidence: 0.9, labelHint: "住宅", matched: "住宅区" },
    homeTemporal,
  );
  assert.equal(agreed.kind, "home");
  assert.ok(agreed.confidence > 0.9);

  const contradicted = combineSemantics(
    { kind: "work", confidence: 0.9, labelHint: "办公", matched: "写字楼" },
    homeTemporal,
  );
  assert.equal(contradicted.kind, "work");
  assert.ok(contradicted.confidence < 0.9);
});

test("PlaceSemanticsService：识别家/公司、落库、匹配、用户确认不被覆盖", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nextbot-place-"));
  const dbPath = join(dir, "location.db");
  const episodes = [...homeEpisodes(), ...workEpisodes()];
  const peekGeocode = (latitude: number): ReverseGeocodeHit | null => {
    if (Math.abs(latitude - 39.9) < 0.02) {
      return hit({ poi: "九华苑", poiType: "商务住宅;住宅区;住宅小区" });
    }
    if (Math.abs(latitude - 39.95) < 0.02) {
      return hit({ poi: "望京科技园", poiType: "商务写字楼;商务写字楼" });
    }
    return null;
  };

  try {
    const service = new PlaceSemanticsService({
      dbPath,
      history: { dwellEpisodes: () => episodes },
      now: () => NOW,
      peekGeocode,
      warmGeocode: false,
    });

    const places = await service.getPlaces("u1");
    assert.equal(places.length, 2);
    const home = places.find((p) => p.kind === "home");
    const work = places.find((p) => p.kind === "work");
    assert.ok(home, "应识别出家");
    assert.ok(work, "应识别出公司");
    assert.equal(home.label, "九华苑");
    assert.equal(work.label, "望京科技园");
    // 行政区必须随地点落库：只存名字会让模型回答「家在哪个城市」时拿当前位置顶替。
    assert.equal(home.city, "北京市");
    assert.equal(home.district, "朝阳区");
    assert.equal(home.region, "北京市");
    assert.equal(formatPlaceAdminArea(home), "北京市朝阳区");
    assert.ok(home.confidence >= 0.9);

    const matched = service.matchCached("u1", { latitude: 39.9001, longitude: 116.4001 });
    assert.equal(matched?.record.kind, "home");

    // 用户纠正：家其实不是家 → 确认后 source=user、置信度 1，重算不覆盖
    const confirmed = service.confirm("u1", home.id, "work");
    assert.equal(confirmed?.kind, "work");
    assert.equal(confirmed?.confirmed, true);
    assert.equal(confirmed?.confidence, 1);

    const recomputed = await service.getPlaces("u1");
    const kept = recomputed.find((p) => p.id === home.id);
    assert.equal(kept?.kind, "work");
    assert.equal(kept?.confirmed, true);

    // 重启后仍能读到用户确认（不依赖历史）
    const reloaded = new PlaceSemanticsService({
      dbPath,
      history: null,
      now: () => NOW,
      peekGeocode,
      warmGeocode: false,
    });
    const persisted = (await reloaded.getPlaces("u1")).find((p) => p.id === home.id);
    assert.equal(persisted?.kind, "work");
    assert.equal(persisted?.confirmed, true);
    assert.equal(persisted?.city, "北京市", "行政区必须持久化，重启后仍可回答城市");

    service.close();
    reloaded.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PlaceSemanticsService.habits：从多天日行程算工作日中位到达/离开", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nextbot-place-habits-"));
  const dbPath = join(dir, "location.db");
  // 2026-09-11 是周五；最近 5 天 = 周一~周五
  const now = new Date("2026-09-11T12:00:00Z");
  const dayTimeline = (
    _actorId: string,
    opts?: { date?: string; timezone?: string },
  ): DayTimeline => {
    const date = opts?.date ?? "2026-09-11";
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    const visits: DayTimeline["visits"] = [];
    if (weekday >= 1 && weekday <= 5) {
      visits.push({
        kind: "stay",
        startAt: `${date}T01:00:00Z`, // 09:00 CST
        endAt: `${date}T10:00:00Z`, // 18:00 CST
        startLocal: "09:00",
        endLocal: "18:00",
        durationMinutes: 540,
        latitude: 39.95,
        longitude: 116.45,
        label: "望京科技园",
        city: "北京市",
        district: "朝阳区",
        sampleCount: 8,
        accuracyMeters: 20,
      });
      visits.push({
        kind: "stay",
        startAt: `${date}T11:00:00Z`, // 19:00 CST
        endAt: `${date}T15:00:00Z`, // 23:00 CST
        startLocal: "19:00",
        endLocal: "23:00",
        durationMinutes: 240,
        latitude: 39.9,
        longitude: 116.4,
        label: "九华苑",
        city: "北京市",
        district: "朝阳区",
        sampleCount: 4,
        accuracyMeters: 20,
      });
    }
    return {
      date,
      timezone: "Asia/Shanghai",
      from: `${date}T00:00:00Z`,
      to: `${date}T23:59:59Z`,
      visits,
      sampleCount: 12,
      pathMeters: 8000,
    };
  };
  const peekGeocode = (latitude: number): ReverseGeocodeHit | null => {
    if (Math.abs(latitude - 39.9) < 0.02) {
      return hit({ poi: "九华苑", poiType: "商务住宅;住宅区;住宅小区" });
    }
    if (Math.abs(latitude - 39.95) < 0.02) {
      return hit({ poi: "望京科技园", poiType: "商务写字楼;商务写字楼" });
    }
    return null;
  };

  try {
    const service = new PlaceSemanticsService({
      dbPath,
      history: {
        dwellEpisodes: () => [...homeEpisodes(), ...workEpisodes()],
        dayTimeline,
      },
      now: () => now,
      peekGeocode,
      warmGeocode: false,
    });
    await service.getPlaces("u1");

    const habits = await service.habits("u1", { days: 5, timezone: "Asia/Shanghai" });
    const work = habits.find((h) => h.kind === "work");
    assert.ok(work, "应产出公司习惯");
    assert.equal(work.visitDays, 5);
    assert.equal(work.weekday.visits, 5);
    assert.equal(work.weekday.arrival, "09:00");
    assert.equal(work.weekday.departure, "18:00");
    assert.equal(work.weekday.medianDurationMinutes, 540);

    const home = habits.find((h) => h.kind === "home");
    assert.ok(home, "应产出家习惯");
    assert.equal(home.weekday.arrival, "19:00");
    assert.equal(home.weekday.departure, "23:00");
    assert.equal(home.weekend.visits, 0);

    service.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PlaceSemanticsService.habits：同一天多次进出按日合并，不按停留段加权", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nextbot-place-habits-merge-"));
  const dbPath = join(dir, "location.db");
  const now = new Date("2026-09-11T12:00:00Z"); // 周五
  // 每个工作日两段公司停留（09:00-12:00、14:00-18:00）：
  // 到达应取当天第一次 09:00，离开取最后一次 18:00，时长是两段之和 420。
  const dayTimeline = (
    _actorId: string,
    opts?: { date?: string; timezone?: string },
  ): DayTimeline => {
    const date = opts?.date ?? "2026-09-11";
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    const visits: DayTimeline["visits"] = [];
    if (weekday >= 1 && weekday <= 5) {
      visits.push({
        kind: "stay",
        startAt: `${date}T01:00:00Z`, // 09:00 CST
        endAt: `${date}T04:00:00Z`, // 12:00 CST
        startLocal: "09:00",
        endLocal: "12:00",
        durationMinutes: 180,
        latitude: 39.95,
        longitude: 116.45,
        label: "望京科技园",
        city: "北京市",
        district: "朝阳区",
        sampleCount: 6,
        accuracyMeters: 20,
      });
      visits.push({
        kind: "stay",
        startAt: `${date}T06:00:00Z`, // 14:00 CST
        endAt: `${date}T10:00:00Z`, // 18:00 CST
        startLocal: "14:00",
        endLocal: "18:00",
        durationMinutes: 240,
        latitude: 39.95,
        longitude: 116.45,
        label: "望京科技园",
        city: "北京市",
        district: "朝阳区",
        sampleCount: 8,
        accuracyMeters: 20,
      });
    }
    return {
      date,
      timezone: "Asia/Shanghai",
      from: `${date}T00:00:00Z`,
      to: `${date}T23:59:59Z`,
      visits,
      sampleCount: 14,
      pathMeters: 6000,
    };
  };
  const peekGeocode = (latitude: number): ReverseGeocodeHit | null => {
    if (Math.abs(latitude - 39.9) < 0.02) {
      return hit({ poi: "九华苑", poiType: "商务住宅;住宅区;住宅小区" });
    }
    if (Math.abs(latitude - 39.95) < 0.02) {
      return hit({ poi: "望京科技园", poiType: "商务写字楼;商务写字楼" });
    }
    return null;
  };

  try {
    const service = new PlaceSemanticsService({
      dbPath,
      history: {
        dwellEpisodes: () => [...homeEpisodes(), ...workEpisodes()],
        dayTimeline,
      },
      now: () => now,
      peekGeocode,
      warmGeocode: false,
    });
    await service.getPlaces("u1");

    const habits = await service.habits("u1", { days: 5, timezone: "Asia/Shanghai" });
    const work = habits.find((h) => h.kind === "work");
    assert.ok(work, "应产出公司习惯");
    assert.equal(work.visitDays, 5, "同一天两段停留只算 1 天");
    assert.equal(work.weekday.visits, 5, "visits 是天数，不是停留段数");
    assert.equal(work.weekday.arrival, "09:00", "到达取当天第一次");
    assert.equal(work.weekday.departure, "18:00", "离开取当天最后一次");
    assert.equal(work.weekday.medianDurationMinutes, 420, "时长取当天两段之和");

    service.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("结合原始历史样本：稀疏上报也能靠夜间出现识别出家/公司", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nextbot-place-raw-"));
  const dbPath = join(dir, "location.db");
  const now = new Date("2026-10-23T12:00:00Z");
  const actor = "u-raw";
  const home = { lat: 25.0626, lng: 104.8925, poi: "九华苑", type: "商务住宅;住宅区;住宅小区" };
  const work = { lat: 25.0914, lng: 104.8952, poi: "兴义写字楼", type: "商务写字楼;商务写字楼" };
  const history = new LocationHistoryService({ dbPath, now: () => now });

  const recordAt = (
    point: { lat: number; lng: number },
    localDate: string,
    localTime: string,
  ): void => {
    history.record(
      actor,
      {
        latitude: point.lat,
        longitude: point.lng,
        city: "兴义市",
        label: "贵州省 黔西南州 兴义市",
        timezone: "Asia/Shanghai",
        accuracyMeters: 25,
      },
      "report",
      new Date(`${localDate}T${localTime}:00+08:00`),
    );
  };

  try {
    // 4 个夜晚，每晚 2 帧、间隔 1 小时：凑不出 20 分钟连续停留段
    recordAt(home, "2026-10-16", "22:30");
    recordAt(home, "2026-10-16", "23:30");
    recordAt(home, "2026-10-17", "22:10");
    recordAt(home, "2026-10-18", "01:40");
    recordAt(home, "2026-10-19", "23:00");
    recordAt(home, "2026-10-20", "02:00");
    recordAt(home, "2026-10-20", "22:20");
    recordAt(home, "2026-10-21", "01:00");

    // 4 个工作日（10-19 周一 ~ 10-22 周四）白天，每天 2 帧
    for (const day of ["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22"]) {
      recordAt(work, day, "10:00");
      recordAt(work, day, "15:00");
    }

    const episodes = history.dwellEpisodes(actor, { days: 7 });
    assert.equal(episodes.length, 0, "样本间隔 >30min，不应产生停留段");

    const service = new PlaceSemanticsService({
      dbPath,
      history,
      now: () => now,
      warmGeocode: false,
      peekGeocode: (latitude) => {
        if (Math.abs(latitude - home.lat) < 0.02) {
          return hit({ poi: home.poi, poiType: home.type });
        }
        if (Math.abs(latitude - work.lat) < 0.02) {
          return hit({ poi: work.poi, poiType: work.type });
        }
        return null;
      },
    });

    const places = await service.getPlaces(actor);
    const homeRecord = places.find((p) => p.kind === "home");
    const workRecord = places.find((p) => p.kind === "work");
    assert.ok(homeRecord, "应仅凭夜间出现识别出家");
    assert.ok(workRecord, "应仅凭工作日白天出现识别出公司");
    assert.ok(homeRecord.distinctDays >= 4);
    assert.ok(homeRecord.evidence.some((item) => item.includes("夜间出现")));
    assert.ok(workRecord.evidence.some((item) => item.includes("工作日白天出现")));

    service.close();
    history.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("用户纠正地点名称后，重算不会被 POI 覆盖", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nextbot-place-label-"));
  const dbPath = join(dir, "location.db");
  const service = new PlaceSemanticsService({
    dbPath,
    history: { dwellEpisodes: () => homeEpisodes() },
    now: () => NOW,
    warmGeocode: false,
    // 高德 AOI 把「九华苑」贴成相邻的「三家村小区」
    peekGeocode: () => hit({ poi: "兴义市三家村小区", poiType: "120302" }),
  });
  try {
    const before = (await service.getPlaces("u1")).find((p) => p.kind === "home");
    assert.ok(before);
    assert.equal(before.label, "兴义市三家村小区");

    const confirmed = service.confirm("u1", before.id, "home", "九华苑");
    assert.equal(confirmed?.label, "九华苑");
    assert.equal(confirmed?.confirmed, true);

    const after = (await service.getPlaces("u1")).find((p) => p.id === before.id);
    assert.equal(after?.label, "九华苑", "用户纠正的名称必须永久保留");
    assert.equal(after?.kind, "home");
  } finally {
    service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("只有 2 个夜晚的历史：不硬猜家，宁可返回 other", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nextbot-place-sparse-"));
  const dbPath = join(dir, "location.db");
  const now = new Date("2026-10-23T12:00:00Z");
  const actor = "u-sparse";
  const history = new LocationHistoryService({ dbPath, now: () => now });
  try {
    for (const [date, time] of [
      ["2026-10-21", "22:30"],
      ["2026-10-21", "23:30"],
      ["2026-10-22", "22:10"],
      ["2026-10-23", "01:40"],
    ] as const) {
      history.record(
        actor,
        {
          latitude: 25.0626,
          longitude: 104.8925,
          timezone: "Asia/Shanghai",
          label: "贵州省 黔西南州 兴义市",
          accuracyMeters: 25,
        },
        "report",
        new Date(`${date}T${time}:00+08:00`),
      );
    }

    const service = new PlaceSemanticsService({
      dbPath,
      history,
      now: () => now,
      warmGeocode: false,
      peekGeocode: () => null,
    });
    const places = await service.getPlaces(actor);
    assert.equal(
      places.some((p) => p.kind === "home"),
      false,
      "2 晚证据不足，不应判家",
    );
    service.close();
  } finally {
    history.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("存量库迁移：旧表缺行政区列时自动补列且旧数据可读", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nextbot-place-migrate-"));
  const dbPath = join(dir, "location.db");
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE place_semantics (
      actor_id TEXT NOT NULL,
      place_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      confidence REAL NOT NULL,
      label TEXT,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      radius_meters REAL NOT NULL,
      poi_name TEXT,
      poi_type TEXT,
      source TEXT NOT NULL,
      confirmed INTEGER NOT NULL DEFAULT 0,
      evidence TEXT,
      distinct_days INTEGER NOT NULL DEFAULT 0,
      visit_days INTEGER NOT NULL DEFAULT 0,
      last_seen_at TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (actor_id, place_id)
    );
    INSERT INTO place_semantics
      (actor_id, place_id, kind, confidence, label, latitude, longitude, radius_meters,
       poi_name, poi_type, source, confirmed, evidence, updated_at)
    VALUES ('u-old', 'pl_old', 'home', 0.8, '九华苑', 25.0631, 104.8921, 120,
            '九华苑', '120302', 'inferred', 0, '[]', '2026-11-16T00:00:00.000Z');
  `);
  db.close();

  try {
    const service = new PlaceSemanticsService({
      dbPath,
      history: null,
      peekGeocode: () => null,
      warmGeocode: false,
    });
    const loaded = service.load("u-old");
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].label, "九华苑");
    assert.equal(loaded[0].city, null, "迁移后新列应为 null，而不是报 no such column");
    service.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PlaceSemanticsService：无历史时回退到持久化结果，空库返回空", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nextbot-place-empty-"));
  const dbPath = join(dir, "location.db");
  try {
    const service = new PlaceSemanticsService({
      dbPath,
      history: { dwellEpisodes: () => [] },
      now: () => NOW,
      peekGeocode: () => null,
      warmGeocode: false,
    });
    assert.deepEqual(await service.getPlaces("u1"), []);
    service.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
