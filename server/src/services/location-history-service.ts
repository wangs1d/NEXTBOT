/**
 * 位置历史存储与查询（位置方案 B）。
 *
 * SQLite 本地存储（缺省 data/location/location.db，AGENT_LOCATION_DB 覆盖），
 * 表 location_samples：actor + 时间 + 经纬度 + 逆地理标签。
 *
 * 隐私约束（服务层保证）：
 *   - 保留期外的轨迹由 pruneExpired 惰性删除（缺省 7 天，可配置）；
 *   - clear(actorId) 一键清除该用户全部历史；
 *   - 只写本地磁盘，不经过任何网络出口。
 *
 * 常去地点挖掘：mineFrequentPlaces 用 DBSCAN（eps 米 / minPoints）把近 N 天
 * 样本聚簇，输出质心、到访次数、簇半径与最常见标签，供地理围栏与主动性消费。
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";
import type { Database as SqliteDatabase } from "better-sqlite3";

import {
  getLocationDbPath,
  getLocationDbscanEpsMeters,
  getLocationDbscanMinPoints,
  getLocationHistoryRetentionDays,
} from "../config/location-env.js";
import { dbscan, haversineMeters } from "./geo-utils.js";

export type LocationSampleSource = "continuous" | "ondemand" | "report";

export type LocationSample = {
  id: number;
  actorId: string;
  recordedAt: string;
  latitude: number;
  longitude: number;
  label: string | null;
  city: string | null;
  district: string | null;
  region: string | null;
  country: string | null;
  timezone: string | null;
  source: LocationSampleSource;
  /**
   * 水平精度半径（米，68% 置信）；null=设备未提供。
   *
   * 2026-11-13 补列。此前精度元数据只活在 WS 契约里，落库时被整段丢弃——
   * 于是「这个 fix 有多准」在历史数据上永久不可知，服务端也无法在入库环节
   * 裁决低精度 fix（室内漂移会把人判到隔壁街区）。有了它，常去地点挖掘
   * （DBSCAN）与围栏判定才能按精度加权，而不是把所有点当同等可信。
   */
  accuracyMeters: number | null;
};

/** 常去地点（DBSCAN 簇的摘要形态） */
export type FrequentPlace = {
  /** 稳定 id：质心取整指纹（同地点跨天挖掘结果可对齐） */
  id: string;
  label: string | null;
  latitude: number;
  longitude: number;
  /** 簇内样本数（≈ 到访上报次数） */
  visitCount: number;
  /** 覆盖的天数（按本地日期去重） */
  distinctDays: number;
  firstSeenAt: string;
  lastSeenAt: string;
  /** 簇内样本到质心的最大距离（米），供「到达判定」半径参考 */
  radiusMeters: number;
};

/**
 * 停留段（stay point）：一段时间内持续停留在同一地点的轨迹切片。
 *
 * 与「常去地点」的区别：常去地点回答「去过哪几次」，停留段回答「待了多久」——
 * 地点语义（家/公司）必须看停留时长和时段，路过一次便利店不能算家。
 */
export type DwellEpisode = {
  /** 段内样本质心 */
  latitude: number;
  longitude: number;
  startAt: string;
  endAt: string;
  durationMinutes: number;
  sampleCount: number;
  /** 段内最常见的逆地理标签（城市级，仅作展示兜底） */
  label: string | null;
  /** 段内最常见的上报时区（时间分布统计用） */
  timezone: string | null;
  /** 段内最优水平精度（米，越小越可信） */
  accuracyMeters: number | null;
};

export type MovementStats = {
  sampleCount: number;
  /** 窗口内相邻样本的累计位移（米） */
  pathMeters: number;
  /** 首尾直线位移（米） */
  displacementMeters: number;
  /** 是否判定「在移动」：任一相邻跳变超过阈值 */
  moving: boolean;
  firstAt: string | null;
  lastAt: string | null;
};

export type LocationHistoryOptions = {
  dbPath?: string;
  retentionDays?: number;
  dbscanEpsMeters?: number;
  dbscanMinPoints?: number;
  now?: () => Date;
};

/**
 * label 是否只是客户端兜底的坐标串（如「25.0631, 104.8918」）。
 *
 * 客户端在逆地理失败时会把坐标直接当 label 上报；这类 label 不是地名，
 * 服务端补到真实地址后应该覆盖它，否则常去地点/停留段投票永远投给坐标串。
 */
function isCoordinateLabel(raw: string | null | undefined): boolean {
  const value = raw?.trim();
  if (!value) return true;
  return /^-?\d{1,3}(?:\.\d+)?\s*[,，]\s*-?\d{1,3}(?:\.\d+)?$/.test(value);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS location_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  latitude REAL NOT NULL,
  longitude REAL NOT NULL,
  label TEXT,
  city TEXT,
  district TEXT,
  region TEXT,
  country TEXT,
  timezone TEXT,
  source TEXT NOT NULL DEFAULT 'report',
  accuracy_meters REAL
);
CREATE INDEX IF NOT EXISTS idx_location_samples_actor_time
  ON location_samples(actor_id, recorded_at);
`;

/**
 * 存量库平滑迁移：给已存在的 location_samples 补精度列。
 *
 * CREATE TABLE IF NOT EXISTS 对老库不会补列，所以老库（2026-11-13 前建的）
 * 缺 accuracy_meters，读写会直接报 "no such column"。这里做一次幂等的
 * ALTER TABLE——列已存在时 SQLite 报错，忽略即可（表是新建的则根本没这问题）。
 */
function ensureAccuracyColumn(db: SqliteDatabase): void {
  try {
    db.exec("ALTER TABLE location_samples ADD COLUMN accuracy_meters REAL");
  } catch {
    // 列已存在：预期路径，静默。
  }
}

function rowToSample(row: Record<string, unknown>): LocationSample {
  return {
    id: Number(row.id),
    actorId: String(row.actor_id),
    recordedAt: String(row.recorded_at),
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    label: (row.label as string | null) ?? null,
    city: (row.city as string | null) ?? null,
    district: (row.district as string | null) ?? null,
    region: (row.region as string | null) ?? null,
    country: (row.country as string | null) ?? null,
    timezone: (row.timezone as string | null) ?? null,
    source: (row.source as LocationSampleSource) ?? "report",
    accuracyMeters:
      row.accuracy_meters == null ? null : Number(row.accuracy_meters),
  };
}

/** 惰性清理的最小间隔：避免每条上报都全表 DELETE。 */
const PRUNE_THROTTLE_MS = 60 * 60 * 1000;

export class LocationHistoryService {
  private readonly db: SqliteDatabase;
  private readonly retentionDays: number;
  private readonly dbscanEpsMeters: number;
  private readonly dbscanMinPoints: number;
  private readonly now: () => Date;
  private lastPruneAt = 0;
  private onCleared: ((actorId: string) => void) | null = null;

  constructor(opts?: LocationHistoryOptions) {
    const file = opts?.dbPath ?? getLocationDbPath();
    mkdirSync(dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
    ensureAccuracyColumn(this.db);
    this.retentionDays = opts?.retentionDays ?? getLocationHistoryRetentionDays();
    this.dbscanEpsMeters = opts?.dbscanEpsMeters ?? getLocationDbscanEpsMeters();
    this.dbscanMinPoints = opts?.dbscanMinPoints ?? getLocationDbscanMinPoints();
    this.now = opts?.now ?? (() => new Date());
  }

  /** 写入一条位置样本（写入侧不区分模式；是否落历史由装配层的开关决定）。 */
  record(
    actorId: string,
    loc: {
      latitude: number;
      longitude: number;
      city?: string;
      district?: string;
      region?: string;
      country?: string;
      timezone?: string;
      label?: string;
      /** 水平精度半径（米，68% 置信）。缺省=null=设备未提供 */
      accuracyMeters?: number;
    },
    source: LocationSampleSource = "report",
    at: Date = this.now(),
  ): LocationSample {
    const stmt = this.db.prepare(
      `INSERT INTO location_samples
        (actor_id, recorded_at, latitude, longitude, label, city, district, region, country, timezone, source, accuracy_meters)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const info = stmt.run(
      actorId,
      at.toISOString(),
      loc.latitude,
      loc.longitude,
      loc.label?.trim() || null,
      loc.city?.trim() || null,
      loc.district?.trim() || null,
      loc.region?.trim() || null,
      loc.country?.trim() || null,
      loc.timezone?.trim() || null,
      source,
      // 精度：负数/NaN 视为未提供（写 null），避免脏值污染「这个 fix 有多准」的统计
      Number.isFinite(loc.accuracyMeters) && (loc.accuracyMeters as number) >= 0
        ? (loc.accuracyMeters as number)
        : null,
    );
    this.pruneExpired(true);
    return {
      id: Number(info.lastInsertRowid),
      actorId,
      recordedAt: at.toISOString(),
      latitude: loc.latitude,
      longitude: loc.longitude,
      label: loc.label?.trim() || null,
      city: loc.city?.trim() || null,
      district: loc.district?.trim() || null,
      region: loc.region?.trim() || null,
      country: loc.country?.trim() || null,
      timezone: loc.timezone?.trim() || null,
      source,
      accuracyMeters:
        Number.isFinite(loc.accuracyMeters) && (loc.accuracyMeters as number) >= 0
          ? (loc.accuracyMeters as number)
          : null,
    };
  }

  /**
   * 用逆地理结果回填一条已入库样本的行政区/地址。
   *
   * 为什么必须回填：客户端上报通常只有经纬度（label 甚至是坐标串），而逆地理
   * 在 ingest 主链路上是异步 fire-and-forget，只更新了 ActorContext 快照。
   * 历史表此前因此留下大量 city/district/region 为 null 的样本——地点语义和
   * 常去地点只能拿到坐标，回答「家在哪个城市」时没有可引用的行政区。
   *
   * 写入规则：
   *   - 只补空，不覆盖客户端已解析出的行政区（客户端可能更贴近真实 fix）；
   *   - label 仅在原值是空/坐标串时覆盖，避免把「兴义市 · 黔西南…」这类
   *     客户端地名换成服务端的长地址；
   *   - expected 用于防止在途逆地理把 A 点的地址写到 B 点（位置已移动）。
   */
  enrich(
    sampleId: number,
    hit: {
      label?: string;
      city?: string;
      district?: string;
      region?: string;
      country?: string;
      timezone?: string;
    },
    expected?: { latitude: number; longitude: number },
  ): boolean {
    if (!Number.isFinite(sampleId)) return false;
    const row = this.db
      .prepare(`SELECT latitude, longitude, label FROM location_samples WHERE id = ?`)
      .get(sampleId) as
      | { latitude: number; longitude: number; label: string | null }
      | undefined;
    if (!row) return false;
    if (expected) {
      const moved = haversineMeters(
        { latitude: Number(row.latitude), longitude: Number(row.longitude) },
        expected,
      );
      if (!Number.isFinite(moved) || moved > 50) return false;
    }
    const label = isCoordinateLabel(row.label) ? hit.label?.trim() || null : null;
    const info = this.db
      .prepare(
        `UPDATE location_samples SET
           label = COALESCE(?, label),
           city = COALESCE(NULLIF(city, ''), ?),
           district = COALESCE(NULLIF(district, ''), ?),
           region = COALESCE(NULLIF(region, ''), ?),
           country = COALESCE(NULLIF(country, ''), ?),
           timezone = COALESCE(NULLIF(timezone, ''), ?)
         WHERE id = ?`,
      )
      .run(
        label,
        hit.city?.trim() || null,
        hit.district?.trim() || null,
        hit.region?.trim() || null,
        hit.country?.trim() || null,
        hit.timezone?.trim() || null,
        sampleId,
      );
    return Number(info.changes) > 0;
  }

  /** 按时间范围查询（升序，最多 limit 条，缺省 2000）。 */
  query(actorId: string, from: Date, to: Date = this.now(), limit = 2000): LocationSample[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM location_samples
          WHERE actor_id = ? AND recorded_at >= ? AND recorded_at <= ?
          ORDER BY recorded_at ASC LIMIT ?`,
      )
      .all(actorId, from.toISOString(), to.toISOString(), Math.max(1, limit)) as Record<string, unknown>[];
    return rows.map(rowToSample);
  }

  /** 最新一条样本（无历史返回 null）。 */
  latest(actorId: string): LocationSample | null {
    const row = this.db
      .prepare(
        `SELECT * FROM location_samples WHERE actor_id = ? ORDER BY recorded_at DESC LIMIT 1`,
      )
      .get(actorId) as Record<string, unknown> | undefined;
    return row ? rowToSample(row) : null;
  }

  count(actorId: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS c FROM location_samples WHERE actor_id = ?`)
      .get(actorId) as { c: number };
    return Number(row.c);
  }

  /**
   * 有位置样本的全部 actor。
   * 启动时用它做一次地点语义回填：老数据可能在首次上报的 prune 里被清掉，
   * 必须在清理前先把「家/公司」算出来并持久化。
   */
  listActors(): string[] {
    const rows = this.db
      .prepare(`SELECT DISTINCT actor_id FROM location_samples`)
      .all() as Array<{ actor_id: string }>;
    return rows.map((row) => String(row.actor_id));
  }

  /**
   * 注册「用户清除历史」回调（如到达触发器缓存失效）：
   * 已删除的数据不应再驱动任何主动行为。
   */
  setOnCleared(fn: ((actorId: string) => void) | null): void {
    this.onCleared = fn;
  }

  /** 一键清除该用户全部位置历史（返回删除条数）。 */
  clear(actorId: string): number {
    const info = this.db.prepare(`DELETE FROM location_samples WHERE actor_id = ?`).run(actorId);
    const deleted = Number(info.changes);
    if (deleted > 0) {
      try {
        this.onCleared?.(actorId);
      } catch {
        /* 回调失败不影响清除本身 */
      }
    }
    return deleted;
  }

  /**
   * 删除保留期外的样本。record 路径带节流（每小时最多一次全表清理）；
   * throttled=false 时强制执行（用户手动/测试用）。
   */
  pruneExpired(throttled = false): number {
    const nowMs = this.now().getTime();
    if (throttled && nowMs - this.lastPruneAt < PRUNE_THROTTLE_MS) return 0;
    this.lastPruneAt = nowMs;
    const cutoff = new Date(nowMs - this.retentionDays * 24 * 60 * 60 * 1000).toISOString();
    const info = this.db
      .prepare(`DELETE FROM location_samples WHERE recorded_at < ?`)
      .run(cutoff);
    return Number(info.changes);
  }

  /**
   * 停留段抽取：把近 days 天样本切成「同一地点持续停留」的切片。
   *
   * 判据（缺省值刻意保守，宁可判不出也不把路过当家）：
   *   - 相邻样本间隔 ≤ 30 分钟（太稀疏无法证明连续停留）
   *   - 距当前质心 ≤ 150 米（室内漂移/小区内走动仍算同一地点）
   *   - 停留时长 ≥ 20 分钟
   *   - 水平精度 ≤ 300 米（低精度 fix 不参与，避免 WiFi 漂移伪造停留）
   *
   * 输出按时间升序，供地点语义层做时间分布与聚类。
   */
  dwellEpisodes(
    actorId: string,
    opts?: {
      days?: number;
      maxGapMs?: number;
      radiusMeters?: number;
      minDurationMs?: number;
      maxAccuracyMeters?: number;
      maxSamples?: number;
    },
  ): DwellEpisode[] {
    const days = Math.min(opts?.days ?? this.retentionDays, this.retentionDays);
    const maxGapMs = opts?.maxGapMs ?? 30 * 60 * 1000;
    const radiusMeters = opts?.radiusMeters ?? 150;
    const minDurationMs = opts?.minDurationMs ?? 20 * 60 * 1000;
    const maxAccuracyMeters = opts?.maxAccuracyMeters ?? 300;
    const from = new Date(this.now().getTime() - days * 24 * 60 * 60 * 1000);
    const samples = this.query(actorId, from, this.now(), opts?.maxSamples ?? 5000).filter(
      (s) => s.accuracyMeters == null || s.accuracyMeters <= maxAccuracyMeters,
    );
    if (samples.length === 0) return [];

    const episodes: DwellEpisode[] = [];
    let bucket: LocationSample[] = [];

    const flush = (): void => {
      if (bucket.length === 0) return;
      const startMs = Date.parse(bucket[0].recordedAt);
      const endMs = Date.parse(bucket[bucket.length - 1].recordedAt);
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs - startMs < minDurationMs) {
        bucket = [];
        return;
      }
      const lat = bucket.reduce((sum, s) => sum + s.latitude, 0) / bucket.length;
      const lng = bucket.reduce((sum, s) => sum + s.longitude, 0) / bucket.length;
      const labelCounts = new Map<string, number>();
      const tzCounts = new Map<string, number>();
      let bestAccuracy: number | null = null;
      for (const s of bucket) {
        const label = s.label?.trim();
        if (label) labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
        const tz = s.timezone?.trim();
        if (tz) tzCounts.set(tz, (tzCounts.get(tz) ?? 0) + 1);
        if (s.accuracyMeters != null && (bestAccuracy == null || s.accuracyMeters < bestAccuracy)) {
          bestAccuracy = s.accuracyMeters;
        }
      }
      const top = (m: Map<string, number>): string | null =>
        [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
      episodes.push({
        latitude: lat,
        longitude: lng,
        startAt: bucket[0].recordedAt,
        endAt: bucket[bucket.length - 1].recordedAt,
        durationMinutes: Math.round((endMs - startMs) / 60_000),
        sampleCount: bucket.length,
        label: top(labelCounts),
        timezone: top(tzCounts),
        accuracyMeters: bestAccuracy,
      });
      bucket = [];
    };

    for (const sample of samples) {
      const prev = bucket[bucket.length - 1];
      if (!prev) {
        bucket = [sample];
        continue;
      }
      const gapMs = Date.parse(sample.recordedAt) - Date.parse(prev.recordedAt);
      const centroid = {
        latitude: bucket.reduce((sum, s) => sum + s.latitude, 0) / bucket.length,
        longitude: bucket.reduce((sum, s) => sum + s.longitude, 0) / bucket.length,
      };
      const samePlace = haversineMeters(centroid, sample) <= radiusMeters;
      if (Number.isFinite(gapMs) && gapMs >= 0 && gapMs <= maxGapMs && samePlace) {
        bucket.push(sample);
      } else {
        flush();
        bucket = [sample];
      }
    }
    flush();
    return episodes;
  }

  /**
   * 常去地点挖掘：近 days 天（缺省=保留期）样本 DBSCAN 聚簇，
   * 按到访次数降序输出前 maxPlaces 个。
   */
  mineFrequentPlaces(
    actorId: string,
    opts?: { days?: number; epsMeters?: number; minPoints?: number; maxPlaces?: number },
  ): FrequentPlace[] {
    const days = Math.min(opts?.days ?? this.retentionDays, this.retentionDays);
    const eps = opts?.epsMeters ?? this.dbscanEpsMeters;
    const minPts = opts?.minPoints ?? this.dbscanMinPoints;
    const maxPlaces = opts?.maxPlaces ?? 10;
    const from = new Date(this.now().getTime() - days * 24 * 60 * 60 * 1000);
    const samples = this.query(actorId, from, this.now(), 5000);
    if (samples.length < minPts) return [];

    const { clusters } = dbscan(samples, eps, minPts);
    const places = clusters.map((cluster) => {
      // 质心：算术平均（簇半径 ≤ eps，球面误差可忽略）
      const lat = cluster.reduce((s, p) => s + p.latitude, 0) / cluster.length;
      const lng = cluster.reduce((s, p) => s + p.longitude, 0) / cluster.length;
      const centroid = { latitude: lat, longitude: lng };
      const times = cluster.map((p) => p.recordedAt).sort();
      const daysSet = new Set(times.map((t) => t.slice(0, 10)));
      const labelCounts = new Map<string, number>();
      for (const p of cluster) {
        const l = p.label?.trim();
        if (l) labelCounts.set(l, (labelCounts.get(l) ?? 0) + 1);
      }
      const label =
        [...labelCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
      const radiusMeters = Math.max(
        ...cluster.map((p) => haversineMeters(centroid, p)),
      );
      return {
        id: `place_${(Math.round(lat * 1000)).toString(36)}_${(Math.round(lng * 1000)).toString(36)}`,
        label,
        latitude: Math.round(lat * 1e6) / 1e6,
        longitude: Math.round(lng * 1e6) / 1e6,
        visitCount: cluster.length,
        distinctDays: daysSet.size,
        firstSeenAt: times[0],
        lastSeenAt: times[times.length - 1],
        radiusMeters: Math.round(radiusMeters),
      } satisfies FrequentPlace;
    });
    return places
      .sort((a, b) => b.visitCount - a.visitCount || b.distinctDays - a.distinctDays)
      .slice(0, maxPlaces);
  }

  /**
   * 窗口内移动统计（节律 location-sensor / 到达判定消费）：
   * 相邻样本跳变超过 jumpMeters 视为移动中。
   */
  movementStats(actorId: string, windowMs: number, jumpMeters = 120): MovementStats {
    const from = new Date(this.now().getTime() - windowMs);
    const samples = this.query(actorId, from, this.now(), 2000);
    if (samples.length === 0) {
      return {
        sampleCount: 0,
        pathMeters: 0,
        displacementMeters: 0,
        moving: false,
        firstAt: null,
        lastAt: null,
      };
    }
    let pathMeters = 0;
    let moving = false;
    for (let i = 1; i < samples.length; i++) {
      const d = haversineMeters(samples[i - 1], samples[i]);
      pathMeters += d;
      if (d > jumpMeters) moving = true;
    }
    const displacementMeters = haversineMeters(samples[0], samples[samples.length - 1]);
    return {
      sampleCount: samples.length,
      pathMeters: Math.round(pathMeters),
      displacementMeters: Math.round(displacementMeters),
      moving,
      firstAt: samples[0].recordedAt,
      lastAt: samples[samples.length - 1].recordedAt,
    };
  }

  close(): void {
    this.db.close();
  }
}
