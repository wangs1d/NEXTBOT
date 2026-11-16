/**
 * 地点语义（家 / 公司 / 其他）——位置方案 E。
 *
 * 目标：让 Agent 知道「用户现在在家 / 在公司 / 在外地」，并支撑语义级主动行为。
 * 判断顺序刻意设计成三级证据，而不是靠围栏名称猜：
 *   1. **POI/AOI 类型**（最强先验）：逆地理返回的「商务住宅;住宅区」→ 家，
 *      「商务写字楼;产业园区」→ 公司，酒店/学校/商场只标 other；
 *   2. **停留时间分布**（独立证据）：夜间长停留 → 家，工作日白天长停留 → 公司；
 *   3. **用户确认**（最终权威）：用户一句话纠正后 source=user，自动推断不再覆盖。
 *
 * 数据全部落本地 SQLite（与位置历史同一个 location.db），不上云。
 * 推断本身不注册系统围栏——未经确认不把家庭坐标写进系统定位服务。
 */

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";
import type { Database as SqliteDatabase } from "better-sqlite3";

import { getLocationDbPath } from "../config/location-env.js";
import { dbscan, haversineMeters } from "./geo-utils.js";
import type { DwellEpisode, LocationHistoryService } from "./location-history-service.js";
import {
  peekReverseGeocodeCache,
  reverseGeocodeCoordinates,
  type ReverseGeocodeHit,
} from "./reverse-geocode-service.js";

export type PlaceSemanticKind = "home" | "work" | "other";
export type PlaceSemanticSource = "poi" | "inferred" | "user";

export type PlaceSemanticRecord = {
  id: string;
  actorId: string;
  kind: PlaceSemanticKind;
  /** 0..1：推断置信度；用户确认恒为 1 */
  confidence: number;
  label: string | null;
  /** 行政区（逆地理产物）：回答「家在哪个城市」必须靠它，而不是只存 AOI 名称 */
  city: string | null;
  district: string | null;
  region: string | null;
  country: string | null;
  /** 完整门牌地址（逆地理 formatted_address） */
  address: string | null;
  latitude: number;
  longitude: number;
  radiusMeters: number;
  poiName: string | null;
  poiType: string | null;
  source: PlaceSemanticSource;
  confirmed: boolean;
  evidence: string[];
  /** 覆盖到的本地日期数（夜/工作日统计的分母） */
  distinctDays: number;
  /** 停留段数量（≈ 到访次数） */
  visitDays: number;
  lastSeenAt: string | null;
  updatedAt: string;
};

export type PlaceMatch = {
  record: PlaceSemanticRecord;
  distanceMeters: number;
};

export type PoiKindPrior = {
  kind: PlaceSemanticKind;
  confidence: number;
  /** 命中的 POI 类型族（展示/证据用，如「住宅」「办公」「酒店」） */
  labelHint: string;
  matched: string;
};

/** 原始样本的粗粒度出现特征（补充停留段：稀疏上报也能证明「夜里常在这」）。 */
export type PresenceFeatures = {
  totalSamples: number;
  /** 夜间样本数（22:00–06:00 本地） */
  nightSamples: number;
  /** 覆盖的夜间数（同一晚 23:50 与次日 00:10 记为同一晚） */
  nightNights: number;
  /** 工作日白天样本数（09:00–18:00） */
  workdayDaySamples: number;
  /** 覆盖的工作日数 */
  workdayDays: number;
  /** 该地点占全部夜间样本的比例是否过半（避免多个地点各算「家」） */
  dominantNight: boolean;
  /** 该地点占全部工作日白天样本的比例是否过半 */
  dominantWorkday: boolean;
};

type RawPresence = PresenceFeatures & {
  latitude: number;
  longitude: number;
  radiusMeters: number;
  label: string | null;
  lastSeenAt: string | null;
};

export type PlaceSemanticsOptions = {
  dbPath?: string;
  /** query 可选：有原始样本时启用「夜间出现」证据（测试可只给 dwellEpisodes） */
  history?:
    | (Pick<LocationHistoryService, "dwellEpisodes"> & {
        query?: LocationHistoryService["query"];
      })
    | null;
  now?: () => Date;
  /** 语义重算 TTL（缺省 30 分钟；位置样本变化不频繁） */
  ttlMs?: number;
  /**
   * 语义分析回看天数（缺省 30 天）。
   * 孤立于原轨迹保留期：原始样本 7 天后会被清，但在此之前用更长的窗口
   * 一次性算出「家/公司」并持久化，之后即使样本被清也不丢语义。
   */
  lookbackDays?: number;
  /** POI 缓存查询（测试可注入）；缺省 peekReverseGeocodeCache */
  peekGeocode?: (latitude: number, longitude: number) => ReverseGeocodeHit | null;
  /** 是否在后台预热逆地理缓存（测试关闭） */
  warmGeocode?: boolean;
  /**
   * 语义重算落库后的失效回调（装配层接 agentCore.invalidatePlacePrompt）。
   * 否则常去地点 prompt 缓存最长 10 分钟仍会拿着旧的无行政区文本，
   * 让「家在哪个城市」在重算成功后继续错误引用当前位置。
   */
  onPlacesUpdated?: (actorId: string) => void;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS place_semantics (
  actor_id TEXT NOT NULL,
  place_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  confidence REAL NOT NULL,
  label TEXT,
  city TEXT,
  district TEXT,
  region TEXT,
  country TEXT,
  address TEXT,
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
`;

/**
 * 存量库平滑迁移：补齐行政区/地址列。
 *
 * `CREATE TABLE IF NOT EXISTS` 不会给老库补列，已有 place_semantics 表的部署
 * 直接读写新列会报 "no such column"。与 location_samples 的精度列迁移同口径：
 * 幂等 ALTER TABLE，列已存在时 SQLite 报错，忽略即可。
 */
function ensurePlaceAdminColumns(db: SqliteDatabase): void {
  for (const [name, type] of [
    ["city", "TEXT"],
    ["district", "TEXT"],
    ["region", "TEXT"],
    ["country", "TEXT"],
    ["address", "TEXT"],
  ] as const) {
    try {
      db.exec(`ALTER TABLE place_semantics ADD COLUMN ${name} ${type}`);
    } catch {
      // 列已存在：预期路径，静默。
    }
  }
}

/** 同地点合并半径：质心轻微漂移仍认作同一个地点，避免 place_id 频繁变化 */
const PLACE_MERGE_RADIUS_METERS = 120;
/** 匹配当前位置时的容差（米）：室内漂移 + 围栏边界模糊 */
const MATCH_MARGIN_METERS = 80;
/** 一次重算最多做的 POI 查询数（按停留时长排序） */
const MAX_POI_LOOKUPS = 6;

type TemporalFeatures = {
  totalMinutes: number;
  nightMinutes: number;
  workdayDayMinutes: number;
  weekendMinutes: number;
  distinctDays: number;
  distinctNights: number;
};

// ─── POI 语义先验 ──────────────────────────────────────────────

function normalizeType(raw: string | undefined | null): string {
  return (raw ?? "").trim();
}

/**
 * 由 POI/AOI 类型推断地点语义（强先验）。
 *
 * 高德 `type` 是分号分隔的层级（如「商务住宅;住宅区;住宅小区」），直接对整串
 * 做关键词匹配即可。**住宿要区分住宅与酒店**：住宅/公寓/宿舍是家，酒店/宾馆
 * 是临时落脚点，不能当作家，否则会说出「你到家了」这种错话。
 */
type PoiFamily = Omit<PoiKindPrior, "matched"> & { re: RegExp };

// 顺序有意义：酒店必须在住宅之前判（「XX公寓酒店」是酒店不是家）
const POI_FAMILIES: PoiFamily[] = [
  {
    kind: "other",
    confidence: 0.85,
    labelHint: "酒店",
    re: /住宿服务|宾馆酒店|酒店|宾馆|旅馆|招待所|民宿/,
  },
  {
    kind: "home",
    confidence: 0.9,
    labelHint: "住宅",
    re: /商务住宅|住宅区|住宅小区|别墅|公寓|宿舍|职工宿舍|社区|小区/,
  },
  {
    kind: "work",
    confidence: 0.9,
    labelHint: "办公",
    re: /写字楼|商务楼|办公楼|产业园区|科技园|工业园|创业园|孵化器|公司|企业|工厂|政府|行政|单位/,
  },
  {
    kind: "other",
    confidence: 0.8,
    labelHint: "学校",
    re: /学校|大学|学院|幼儿园|中学|小学|培训机构/,
  },
  {
    kind: "other",
    confidence: 0.75,
    labelHint: "休闲",
    re: /公园|景点|景区|体育|健身|影院|剧场|游乐|休闲/,
  },
  {
    kind: "other",
    confidence: 0.7,
    labelHint: "商业",
    re: /购物|商场|超市|餐饮|美食|餐厅|咖啡|便利店|市场/,
  },
  {
    kind: "other",
    confidence: 0.7,
    labelHint: "交通",
    re: /交通|地铁|公交|机场|火车站|车站|码头/,
  },
];

function matchPoiFamily(text: string): PoiFamily | null {
  return POI_FAMILIES.find((family) => family.re.test(text)) ?? null;
}

function familyToPrior(family: PoiFamily): Omit<PoiKindPrior, "matched"> {
  return {
    kind: family.kind,
    confidence: family.confidence,
    labelHint: family.labelHint,
  };
}

/**
 * 由 POI/AOI 类型推断地点语义（强先验）。
 *
 * 高德 `type` 通常是「商务住宅;住宅区;住宅小区」这种文本层级，但部分 POI/AOI
 * 只返回数字码（实测「三家村小区」是 `120302`）。所以 type 匹配不到时，
 * 再用名称做一次保守兜底——名字里带「小区/公寓/大厦/产业园」仍然是强信号。
 */
export function inferKindFromPoi(input: {
  type?: string | null;
  name?: string | null;
}): PoiKindPrior | null {
  const type = normalizeType(input.type);
  const name = (input.name ?? "").trim();

  const fromType = type ? matchPoiFamily(type) : null;
  if (fromType) {
    return { ...familyToPrior(fromType), matched: type };
  }

  if (name) {
    const fromName = matchPoiFamily(name);
    if (fromName) {
      const prior = familyToPrior(fromName);
      // 名称兜底比类型弱一档：仍可用，但置信度下调
      return { ...prior, confidence: Math.max(0.6, prior.confidence - 0.1), matched: name };
    }
  }
  return null;
}

// ─── 时间分布 ──────────────────────────────────────────────────

type LocalParts = { hour: number; weekday: number; dateKey: string };

const formatterCache = new Map<string, Intl.DateTimeFormat | null>();

function formatterFor(timeZone: string | null | undefined): Intl.DateTimeFormat | null {
  const key = timeZone?.trim() || "__server__";
  const cached = formatterCache.get(key);
  if (cached !== undefined) return cached;
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      ...(timeZone?.trim() ? { timeZone: timeZone.trim() } : {}),
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
      weekday: "short",
    });
    formatterCache.set(key, fmt);
    return fmt;
  } catch {
    formatterCache.set(key, null);
    return null;
  }
}

function localParts(ms: number, timeZone: string | null | undefined): LocalParts | null {
  const fmt = formatterFor(timeZone);
  if (!fmt) return null;
  try {
    const parts = fmt.formatToParts(new Date(ms));
    const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
    const hour = Number.parseInt(get("hour"), 10);
    const year = get("year");
    const month = get("month");
    const day = get("day");
    const weekdayText = get("weekday");
    const weekdayMap: Record<string, number> = {
      Sun: 0,
      Mon: 1,
      Tue: 2,
      Wed: 3,
      Thu: 4,
      Fri: 5,
      Sat: 6,
    };
    const weekday = weekdayMap[weekdayText] ?? 1;
    if (!Number.isFinite(hour) || !year || !month || !day) return null;
    return { hour, weekday, dateKey: `${year}-${month}-${day}` };
  } catch {
    return null;
  }
}

function previousDateKey(dateKey: string): string {
  const ms = Date.parse(`${dateKey}T00:00:00Z`);
  if (!Number.isFinite(ms)) return dateKey;
  return new Date(ms - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * 从原始样本算「出现」特征。
 *
 * 为什么不能只看停留段：默认 ondemand 模式下样本很稀，用户可能每晚只上报
 * 一两帧，凑不出 20 分钟的连续停留段。但「4 个不同的夜里都在同一个点」
 * 本身就是很强的家的证据——这也是系统级 significant place 的常见做法。
 */
export function computePresence(
  samples: Array<{
    latitude: number;
    longitude: number;
    recordedAt: string;
    timezone?: string | null;
    label?: string | null;
    accuracyMeters?: number | null;
  }>,
): { presences: RawPresence[]; totalNightSamples: number; totalWorkdayDaySamples: number } {
  const usable = samples.filter(
    (s) => s.accuracyMeters == null || s.accuracyMeters <= 300,
  );
  if (usable.length === 0) {
    return { presences: [], totalNightSamples: 0, totalWorkdayDaySamples: 0 };
  }
  const { clusters } = dbscan(usable, PLACE_MERGE_RADIUS_METERS, 3);
  const raw: Array<Omit<RawPresence, "dominantNight" | "dominantWorkday">> = [];

  for (const cluster of clusters) {
    let nightSamples = 0;
    let workdayDaySamples = 0;
    let totalSamples = 0;
    let lastSeenAt: string | null = null;
    const nightKeys = new Set<string>();
    const workdayKeys = new Set<string>();
    const labelCounts = new Map<string, number>();
    for (const sample of cluster) {
      const parts = localParts(Date.parse(sample.recordedAt), sample.timezone);
      if (!parts) continue;
      totalSamples += 1;
      if (!lastSeenAt || sample.recordedAt > lastSeenAt) lastSeenAt = sample.recordedAt;
      const label = sample.label?.trim();
      if (label) labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
      if (parts.hour >= 22) {
        nightSamples += 1;
        nightKeys.add(parts.dateKey);
      } else if (parts.hour < 6) {
        nightSamples += 1;
        // 凌晨属于前一晚：23:50 → 00:10 不应算两晚
        nightKeys.add(previousDateKey(parts.dateKey));
      }
      if (parts.weekday >= 1 && parts.weekday <= 5 && parts.hour >= 9 && parts.hour < 18) {
        workdayDaySamples += 1;
        workdayKeys.add(parts.dateKey);
      }
    }
    const latitude = cluster.reduce((sum, s) => sum + s.latitude, 0) / cluster.length;
    const longitude = cluster.reduce((sum, s) => sum + s.longitude, 0) / cluster.length;
    const centroid = { latitude, longitude };
    raw.push({
      latitude,
      longitude,
      radiusMeters: Math.max(
        80,
        Math.round(Math.max(...cluster.map((s) => haversineMeters(centroid, s)))),
      ),
      totalSamples,
      nightSamples,
      nightNights: nightKeys.size,
      workdayDaySamples,
      workdayDays: workdayKeys.size,
      label: topOf(labelCounts),
      lastSeenAt,
    });
  }

  const totalNightSamples = raw.reduce((sum, p) => sum + p.nightSamples, 0);
  const totalWorkdayDaySamples = raw.reduce((sum, p) => sum + p.workdayDaySamples, 0);
  const presences: RawPresence[] = raw.map((p) => ({
    ...p,
    // 占比过半才算「主要夜间地点」：两个地点各 2 晚时不能都判家
    dominantNight: totalNightSamples > 0 && p.nightSamples / totalNightSamples >= 0.55,
    dominantWorkday:
      totalWorkdayDaySamples > 0 && p.workdayDaySamples / totalWorkdayDaySamples >= 0.5,
  }));
  return { presences, totalNightSamples, totalWorkdayDaySamples };
}

/** 按本地时间切分停留段，统计夜间 / 工作日白天 / 周末停留分钟。 */
export function computeTemporalFeatures(episodes: DwellEpisode[]): TemporalFeatures {
  let nightMinutes = 0;
  let workdayDayMinutes = 0;
  let weekendMinutes = 0;
  let totalMinutes = 0;
  const days = new Set<string>();
  const nights = new Set<string>();
  const STEP_MS = 5 * 60 * 1000;

  for (const episode of episodes) {
    totalMinutes += episode.durationMinutes;
    const startMs = Date.parse(episode.startAt);
    const endMs = Date.parse(episode.endAt);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) continue;
    for (let t = startMs; t < endMs; t += STEP_MS) {
      const parts = localParts(t, episode.timezone);
      if (!parts) continue;
      const stepMinutes = Math.min(5, (endMs - t) / 60_000);
      const isNight = parts.hour >= 22 || parts.hour < 6;
      const isWorkdayDay = parts.weekday >= 1 && parts.weekday <= 5 && parts.hour >= 9 && parts.hour < 18;
      const isWeekend = parts.weekday === 0 || parts.weekday === 6;
      if (isNight) {
        nightMinutes += stepMinutes;
        nights.add(parts.dateKey);
      }
      if (isWorkdayDay) workdayDayMinutes += stepMinutes;
      if (isWeekend) weekendMinutes += stepMinutes;
      days.add(parts.dateKey);
    }
  }

  return {
    totalMinutes: Math.round(totalMinutes),
    nightMinutes: Math.round(nightMinutes),
    workdayDayMinutes: Math.round(workdayDayMinutes),
    weekendMinutes: Math.round(weekendMinutes),
    distinctDays: days.size,
    distinctNights: nights.size,
  };
}

type Classification = {
  kind: PlaceSemanticKind;
  confidence: number;
  evidence: string[];
};

/**
 * 时间分布 + 出现次数 → 候选语义（只在证据足够时才给非 other）。
 *
 * presence 是可选的稀疏样本证据：默认 ondemand 模式下很多用户凑不出连续
 * 停留段，但「4 个不同的夜里都出现在同一地点」仍然足以判家。
 */
export function classifyByTemporal(
  features: TemporalFeatures,
  presence?: PresenceFeatures | null,
): Classification {
  const total = Math.max(1, features.totalMinutes);
  const nightRatio = features.nightMinutes / total;
  const workdayDayRatio = features.workdayDayMinutes / total;
  const evidence: string[] = [];

  const homeByDwell =
    features.distinctNights >= 4 &&
    features.nightMinutes >= 360 &&
    nightRatio >= 0.55;
  const workByDwell =
    features.distinctDays >= 4 &&
    features.workdayDayMinutes >= 300 &&
    workdayDayRatio >= 0.5;

  // 稀疏证据：夜间出现 ≥4 晚且样本 ≥6，且该地点是主要夜间地点
  const homeByPresence =
    !!presence &&
    presence.nightNights >= 4 &&
    presence.nightSamples >= 6 &&
    presence.dominantNight;
  // 工作日白天出现 ≥4 天且样本 ≥6，且是主要白天地点
  const workByPresence =
    !!presence &&
    presence.workdayDays >= 4 &&
    presence.workdayDaySamples >= 6 &&
    presence.dominantWorkday;

  if (homeByDwell) {
    evidence.push(
      `夜间停留 ${features.nightMinutes} 分钟 / ${features.distinctNights} 晚（占比 ${(nightRatio * 100).toFixed(0)}%）`,
    );
  }
  if (homeByPresence && !homeByDwell) {
    evidence.push(`夜间出现 ${presence!.nightSamples} 次 / ${presence!.nightNights} 晚`);
  }
  if (workByDwell) {
    evidence.push(
      `工作日白天停留 ${features.workdayDayMinutes} 分钟 / ${features.distinctDays} 天（占比 ${(workdayDayRatio * 100).toFixed(0)}%）`,
    );
  }
  if (workByPresence && !workByDwell) {
    evidence.push(
      `工作日白天出现 ${presence!.workdayDaySamples} 次 / ${presence!.workdayDays} 天`,
    );
  }

  const homeScore = homeByDwell
    ? Math.min(
        0.9,
        0.5 + Math.min(0.2, features.distinctNights * 0.03) + Math.min(0.2, nightRatio * 0.2),
      )
    : homeByPresence
      ? Math.min(0.85, 0.5 + Math.min(0.2, presence!.nightNights * 0.03) + Math.min(0.15, presence!.nightSamples * 0.01))
      : 0;
  const workScore = workByDwell
    ? Math.min(
        0.9,
        0.5 + Math.min(0.2, features.distinctDays * 0.03) + Math.min(0.2, workdayDayRatio * 0.2),
      )
    : workByPresence
      ? Math.min(0.85, 0.5 + Math.min(0.2, presence!.workdayDays * 0.03) + Math.min(0.15, presence!.workdayDaySamples * 0.01))
      : 0;

  if (homeScore > 0 && (workScore === 0 || homeScore >= workScore)) {
    return { kind: "home", confidence: homeScore, evidence };
  }
  if (workScore > 0) {
    return { kind: "work", confidence: workScore, evidence };
  }
  if (features.totalMinutes > 0) {
    evidence.push(`停留 ${features.totalMinutes} 分钟 / ${features.distinctDays} 天，时段特征不明确`);
  } else if (presence && presence.totalSamples > 0) {
    evidence.push(
      `出现 ${presence.totalSamples} 次（夜间 ${presence.nightSamples}、工作日白天 ${presence.workdayDaySamples}），证据不足`,
    );
  }
  return { kind: "other", confidence: 0.3, evidence };
}

/** 合并 POI 先验与时间证据（POI 优先，时间只做印证/降级）。 */
export function combineSemantics(
  prior: PoiKindPrior | null,
  temporal: Classification,
): Classification {
  if (!prior) return temporal;
  const evidence = [`POI 先验：${prior.labelHint}（${prior.matched}）`, ...temporal.evidence];
  let confidence = prior.confidence;
  let kind = prior.kind;

  if (prior.kind === "home") {
    if (temporal.kind === "home") {
      confidence = Math.min(0.97, prior.confidence + 0.07);
    } else if (temporal.kind === "work") {
      // 住宅 POI + 工作日白天占优：可能是「在家办公」或用户白天长期在家。
      // 不推翻 POI（它比时间更硬），但降低置信度并保留证据。
      confidence = Math.max(0.62, prior.confidence - 0.25);
      evidence.push("时间分布偏工作日白天，置信度下调");
    }
  } else if (prior.kind === "work") {
    if (temporal.kind === "work") {
      confidence = Math.min(0.97, prior.confidence + 0.07);
    } else if (temporal.kind === "home") {
      // 办公 POI + 夜间停留占优：可能是加班/夜班，仍按公司处理但降置信度
      confidence = Math.max(0.62, prior.confidence - 0.25);
      evidence.push("时间分布偏夜间，置信度下调");
    }
  }

  // POI 与长期出现冲突时的兜底：商场/景区这类「混用建筑」很常见（住宅楼下是商铺、
  // 园区里挂着商业 POI），如果夜间/工作日白天的出现证据足够强，允许降级为候选，
  // 等用户一句话确认。酒店/学校/交通枢纽不在此列——那些不能当作家/公司。
  if (prior.kind === "other" && temporal.kind !== "other" && temporal.confidence >= 0.7) {
    if (
      temporal.kind === "home" &&
      (prior.labelHint === "商业" || prior.labelHint === "休闲" || prior.labelHint === "交通")
    ) {
      return {
        kind: "home",
        confidence: 0.66,
        evidence: [
          ...evidence,
          "POI 为商业/休闲但与夜间长期出现冲突，按家候选处理（待用户确认）",
        ],
      };
    }
    if (
      temporal.kind === "work" &&
      (prior.labelHint === "商业" || prior.labelHint === "休闲")
    ) {
      return {
        kind: "work",
        confidence: 0.63,
        evidence: [
          ...evidence,
          "POI 为商业/休闲但与工作日白天长期出现冲突，按公司候选处理（待用户确认）",
        ],
      };
    }
  }

  // 明确的反证：酒店/商场等 other 先验不被时间分布翻成家/公司
  if (prior.kind === "other" && temporal.kind !== "other") {
    evidence.push("POI 类型不属于居住/办公，忽略时间推断");
  }

  return { kind, confidence, evidence };
}

function topOf(map: Map<string, number>): string | null {
  return [...map.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

/**
 * 地点的行政区文本（展示/回答「在哪个城市」用）。
 *
 * 只拼 region/city/district，不拼完整门牌：prompt 和工具回执需要的是稳定、
 * 短的行政归属，完整地址在 `address` 字段单独提供。直辖市会有
 * 「北京市/北京市/朝阳区」重复，这里去掉相邻重复项。
 */
export function formatPlaceAdminArea(
  record: Pick<PlaceSemanticRecord, "region" | "city" | "district">,
): string {
  const parts = [record.region, record.city, record.district]
    .map((part) => part?.trim() ?? "")
    .filter(Boolean);
  return parts.filter((part, index) => index === 0 || part !== parts[index - 1]).join("");
}

export class PlaceSemanticsService {
  private readonly db: SqliteDatabase;
  private readonly history: PlaceSemanticsOptions["history"];
  private readonly now: () => Date;
  private readonly ttlMs: number;
  private readonly lookbackDays: number;
  private readonly peekGeocode: (latitude: number, longitude: number) => ReverseGeocodeHit | null;
  private readonly warmGeocodeEnabled: boolean;
  private readonly onPlacesUpdated: ((actorId: string) => void) | null;
  private readonly cache = new Map<string, { at: number; records: PlaceSemanticRecord[] }>();

  constructor(opts?: PlaceSemanticsOptions) {
    const file = opts?.dbPath ?? getLocationDbPath();
    mkdirSync(dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
    ensurePlaceAdminColumns(this.db);
    this.history = opts?.history ?? null;
    this.now = opts?.now ?? (() => new Date());
    this.ttlMs = opts?.ttlMs ?? 30 * 60 * 1000;
    this.lookbackDays = Math.max(1, opts?.lookbackDays ?? 30);
    this.peekGeocode = opts?.peekGeocode ?? peekReverseGeocodeCache;
    this.warmGeocodeEnabled = opts?.warmGeocode ?? true;
    this.onPlacesUpdated = opts?.onPlacesUpdated ?? null;
  }

  /** 计算（或读缓存）该 actor 的地点语义列表；无位置历史时回退到上次持久化结果。 */
  async getPlaces(actorId: string): Promise<PlaceSemanticRecord[]> {
    const cached = this.cache.get(actorId);
    if (cached && this.now().getTime() - cached.at <= this.ttlMs) return cached.records;

    const computed = this.compute(actorId);
    const records = computed.length > 0 ? computed : this.load(actorId);
    if (computed.length > 0) {
      this.persist(actorId, computed);
      try {
        this.onPlacesUpdated?.(actorId);
      } catch {
        /* 失效回调失败不影响语义结果 */
      }
    }
    this.cache.set(actorId, { at: this.now().getTime(), records });
    return records;
  }

  /** 同步匹配（prompt / 上报链路用）：只读缓存或 DB，绝不发网络请求。 */
  matchCached(
    actorId: string,
    loc: { latitude: number; longitude: number },
  ): PlaceMatch | null {
    const records = this.cache.get(actorId)?.records ?? this.load(actorId);
    if (records.length === 0) return null;
    let best: { record: PlaceSemanticRecord; distanceMeters: number; rank: number[] } | null = null;
    for (const record of records) {
      const distance = haversineMeters(loc, record);
      if (distance > record.radiusMeters + MATCH_MARGIN_METERS) continue;
      // 排序键：用户确认 > 非 other > 置信度高 > 半径小 > 距离近
      const rank = [
        record.confirmed ? 1 : 0,
        record.kind === "other" ? 0 : 1,
        record.confidence,
        -record.radiusMeters,
        -distance,
      ];
      if (!best || compareRank(rank, best.rank) > 0) best = { record, distanceMeters: distance, rank };
    }
    return best ? { record: best.record, distanceMeters: best.distanceMeters } : null;
  }

  /** 找到该 actor 已确认/高置信的某个语义地点（家/公司）。 */
  findPlace(actorId: string, kind: PlaceSemanticKind): PlaceSemanticRecord | null {
    const records = this.cache.get(actorId)?.records ?? this.load(actorId);
    return (
      records
        .filter((r) => r.kind === kind)
        .sort((a, b) => Number(b.confirmed) - Number(a.confirmed) || b.confidence - a.confidence)[0] ??
      null
    );
  }

  /**
   * 用户确认/纠正某地点的语义（最终权威）。
   * label 可选：高德 AOI 经常把相邻小区贴错（实测「九华苑」被贴成旁边的
   * 「三家村小区」），用户纠正名称后必须永久保留，重算不能再被 POI 覆盖。
   * 返回 null 表示 placeId 不存在。
   */
  confirm(
    actorId: string,
    placeId: string,
    kind: PlaceSemanticKind,
    label?: string | null,
  ): PlaceSemanticRecord | null {
    const nowIso = this.now().toISOString();
    const normalizedLabel = label?.trim() || null;
    const info = this.db
      .prepare(
        `UPDATE place_semantics
            SET kind = ?, confidence = 1, source = 'user', confirmed = 1,
                label = COALESCE(?, label), updated_at = ?
          WHERE actor_id = ? AND place_id = ?`,
      )
      .run(kind, normalizedLabel, nowIso, actorId, placeId);
    if (Number(info.changes) === 0) return null;
    this.cache.delete(actorId);
    return this.get(actorId, placeId);
  }

  /** 删除单个地点语义（用户说「那不是我公司」时用 confirm 改，忘掉某个才用这个）。 */
  remove(actorId: string, placeId: string): boolean {
    const info = this.db
      .prepare(`DELETE FROM place_semantics WHERE actor_id = ? AND place_id = ?`)
      .run(actorId, placeId);
    this.cache.delete(actorId);
    return Number(info.changes) > 0;
  }

  /** 一键忘掉该 actor 的全部地点语义（清位置历史时联动）。 */
  forget(actorId: string): number {
    const info = this.db.prepare(`DELETE FROM place_semantics WHERE actor_id = ?`).run(actorId);
    this.cache.delete(actorId);
    return Number(info.changes);
  }

  get(actorId: string, placeId: string): PlaceSemanticRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM place_semantics WHERE actor_id = ? AND place_id = ?`)
      .get(actorId, placeId) as Record<string, unknown> | undefined;
    return row ? rowToRecord(row) : null;
  }

  /** 已持久化的地点语义（不做重算）。 */
  load(actorId: string): PlaceSemanticRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM place_semantics WHERE actor_id = ? ORDER BY updated_at DESC`)
      .all(actorId) as Record<string, unknown>[];
    return rows.map(rowToRecord);
  }

  close(): void {
    this.db.close();
  }

  // ─── 内部：聚类 + 分类 ───────────────────────────────────────

  private compute(actorId: string): PlaceSemanticRecord[] {
    if (!this.history) return [];
    let episodes: DwellEpisode[] = [];
    try {
      // dwellEpisodes 内部会按保留期 clamp：保留 7 天时只看 7 天，
      // 保留 30 天时自动用满 30 天。
      episodes = this.history.dwellEpisodes(actorId, { days: this.lookbackDays });
    } catch {
      episodes = [];
    }

    // 原始样本的「出现」特征：稀疏上报下补足停留段凑不出来的证据。
    // 默认 ondemand 模式很多用户每晚只有一两帧，连续停留段为空，
    // 但「4 个不同的夜里都在同一点」仍然足以判家。
    let presences: RawPresence[] = [];
    if (this.history.query) {
      try {
        const now = this.now();
        const from = new Date(now.getTime() - this.lookbackDays * 24 * 60 * 60 * 1000);
        // 2000 条足够覆盖 30 天的夜间/工作日证据；DBSCAN 是 O(n²)，
        // 这里必须设上限，不能拿全量样本把事件循环卡住。
        presences = computePresence(this.history.query(actorId, from, now, 2000)).presences;
      } catch {
        presences = [];
      }
    }

    type Candidate = { episodes: DwellEpisode[]; presence: RawPresence | null };
    const candidates: Candidate[] = [];
    const dwellClusters =
      episodes.length > 0 ? dbscan(episodes, PLACE_MERGE_RADIUS_METERS, 1).clusters : [];
    const usedPresence = new Set<number>();

    for (const cluster of dwellClusters) {
      const latitude = cluster.reduce((sum, e) => sum + e.latitude, 0) / cluster.length;
      const longitude = cluster.reduce((sum, e) => sum + e.longitude, 0) / cluster.length;
      let best = -1;
      let bestDistance = Number.POSITIVE_INFINITY;
      presences.forEach((presence, index) => {
        if (usedPresence.has(index)) return;
        const distance = haversineMeters({ latitude, longitude }, presence);
        if (distance <= PLACE_MERGE_RADIUS_METERS && distance < bestDistance) {
          best = index;
          bestDistance = distance;
        }
      });
      if (best >= 0) usedPresence.add(best);
      candidates.push({ episodes: cluster, presence: best >= 0 ? presences[best] : null });
    }

    // 没有停留段、但有出现证据的地点：补成候选（门槛比停留段低一档）
    presences.forEach((presence, index) => {
      if (usedPresence.has(index)) return;
      if (presence.nightSamples < 2 && presence.workdayDaySamples < 3) return;
      candidates.push({ episodes: [], presence });
    });
    if (candidates.length === 0) return [];

    const existing = this.load(actorId);
    const records: PlaceSemanticRecord[] = [];

    for (const candidate of candidates) {
      const cluster = candidate.episodes;
      const presence = candidate.presence;
      if (cluster.length === 0 && !presence) continue;
      const totalMinutes = cluster.reduce((sum, e) => sum + e.durationMinutes, 0);
      if (totalMinutes < 30 && !presence) continue; // 太短的停留段不构成地点

      const latitude =
        cluster.length > 0
          ? cluster.reduce((sum, e) => sum + e.latitude, 0) / cluster.length
          : presence!.latitude;
      const longitude =
        cluster.length > 0
          ? cluster.reduce((sum, e) => sum + e.longitude, 0) / cluster.length
          : presence!.longitude;
      const centroid = { latitude, longitude };
      const radiusMeters =
        cluster.length > 0
          ? Math.max(
              80,
              Math.round(Math.max(...cluster.map((e) => haversineMeters(centroid, e)))),
            )
          : Math.max(80, Math.round(presence!.radiusMeters));

      const labelCounts = new Map<string, number>();
      for (const episode of cluster) {
        const label = episode.label?.trim();
        if (label) labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
      }
      if (presence?.label) {
        labelCounts.set(presence.label, (labelCounts.get(presence.label) ?? 0) + 1);
      }

      const matched = existing.find(
        (record) => haversineMeters(record, centroid) <= PLACE_MERGE_RADIUS_METERS,
      );
      const id = matched?.id ?? `pl_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
      const poi = this.lookupPoi(actorId, centroid.latitude, centroid.longitude);
      const prior = inferKindFromPoi({
        type: poi?.poiType ?? poi?.aoiType,
        name: poi?.aoi ?? poi?.poi,
      });
      const features = computeTemporalFeatures(cluster);
      const presenceFeatures: PresenceFeatures | null = presence
        ? {
            totalSamples: presence.totalSamples,
            nightSamples: presence.nightSamples,
            nightNights: presence.nightNights,
            workdayDaySamples: presence.workdayDaySamples,
            workdayDays: presence.workdayDays,
            dominantNight: presence.dominantNight,
            dominantWorkday: presence.dominantWorkday,
          }
        : null;
      const temporal = classifyByTemporal(features, presenceFeatures);
      const combined = combineSemantics(prior, temporal);

      // 用户确认过的地点：语义与置信度永久保留，只刷新坐标/停留特征
      const kind = matched?.confirmed ? matched.kind : combined.kind;
      const confidence = matched?.confirmed ? 1 : combined.confidence;
      const source: PlaceSemanticSource = matched?.confirmed
        ? "user"
        : prior
          ? "poi"
          : "inferred";
      const clusterLastSeen = cluster.map((e) => e.endAt).sort().at(-1) ?? null;
      const lastSeenAt =
        [clusterLastSeen, presence?.lastSeenAt ?? null]
          .filter((value): value is string => !!value)
          .sort()
          .at(-1) ?? null;

      // 行政区优先取本轮逆地理结果；缓存未命中时保留上次已持久化的值，
      // 避免一次外网抖动把「贵州省兴义市」清空回 null。
      const admin = {
        city: poi?.city?.trim() || matched?.city || null,
        district: poi?.district?.trim() || matched?.district || null,
        region: poi?.region?.trim() || matched?.region || null,
        country: poi?.country?.trim() || matched?.country || null,
        address: poi?.address?.trim() || matched?.address || null,
      };

      records.push({
        id,
        actorId,
        kind,
        confidence,
        // 用户纠正过的名称优先：高德 AOI 贴错相邻小区时，重算不能再改回去
        label: matched?.confirmed
          ? matched.label?.trim() || poi?.aoi || poi?.poi || topOf(labelCounts) || null
          : poi?.aoi ?? poi?.poi ?? topOf(labelCounts) ?? null,
        ...admin,
        latitude,
        longitude,
        radiusMeters,
        poiName: poi?.aoi ?? poi?.poi ?? null,
        poiType: poi?.poiType ?? poi?.aoiType ?? null,
        source,
        confirmed: matched?.confirmed ?? false,
        evidence: matched?.confirmed
          ? ["用户已确认"]
          : [
              ...combined.evidence,
              cluster.length > 0
                ? `停留 ${totalMinutes} 分钟 / ${cluster.length} 段`
                : "无连续停留段",
              ...(presence
                ? [
                    `出现 ${presence.totalSamples} 次（夜间 ${presence.nightSamples} 次/${presence.nightNights} 晚，工作日白天 ${presence.workdayDaySamples} 次/${presence.workdayDays} 天）`,
                  ]
                : []),
            ],
        distinctDays: Math.max(
          features.distinctDays,
          presence?.nightNights ?? 0,
          presence?.workdayDays ?? 0,
        ),
        visitDays: cluster.length || presence?.totalSamples || 0,
        lastSeenAt,
        updatedAt: this.now().toISOString(),
      });
    }

    return records.sort((a, b) => b.confidence - a.confidence);
  }

  private lookupPoi(actorId: string, latitude: number, longitude: number): ReverseGeocodeHit | null {
    let hit: ReverseGeocodeHit | null = null;
    try {
      hit = this.peekGeocode(latitude, longitude);
    } catch {
      hit = null;
    }
    // 缓存没有就后台预热（不阻塞语义计算）。预热完成后失效本轮缓存，
    // 下一轮 prompt/上报即可用 POI 类型升级「家/公司」候选。
    if (!hit && this.warmGeocodeEnabled) {
      void reverseGeocodeCoordinates(latitude, longitude)
        .then((resolved) => {
          if (resolved) this.cache.delete(actorId);
        })
        .catch(() => {});
    }
    return hit;
  }

  private persist(actorId: string, records: PlaceSemanticRecord[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO place_semantics
        (actor_id, place_id, kind, confidence, label, city, district, region, country, address,
         latitude, longitude, radius_meters,
         poi_name, poi_type, source, confirmed, evidence, distinct_days, visit_days, last_seen_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(actor_id, place_id) DO UPDATE SET
         kind = excluded.kind,
         confidence = excluded.confidence,
         label = excluded.label,
         city = excluded.city,
         district = excluded.district,
         region = excluded.region,
         country = excluded.country,
         address = excluded.address,
         latitude = excluded.latitude,
         longitude = excluded.longitude,
         radius_meters = excluded.radius_meters,
         poi_name = excluded.poi_name,
         poi_type = excluded.poi_type,
         source = excluded.source,
         confirmed = excluded.confirmed,
         evidence = excluded.evidence,
         distinct_days = excluded.distinct_days,
         visit_days = excluded.visit_days,
         last_seen_at = excluded.last_seen_at,
         updated_at = excluded.updated_at`,
    );
    const staleStmt = this.db.prepare(
      `SELECT place_id FROM place_semantics WHERE actor_id = ? AND confirmed = 0`,
    );
    const deleteStmt = this.db.prepare(
      `DELETE FROM place_semantics WHERE actor_id = ? AND place_id = ? AND confirmed = 0`,
    );
    const tx = this.db.transaction((items: PlaceSemanticRecord[]) => {
      for (const r of items) {
        stmt.run(
          actorId,
          r.id,
          r.kind,
          r.confidence,
          r.label,
          r.city,
          r.district,
          r.region,
          r.country,
          r.address,
          r.latitude,
          r.longitude,
          r.radiusMeters,
          r.poiName,
          r.poiType,
          r.source,
          r.confirmed ? 1 : 0,
          JSON.stringify(r.evidence),
          r.distinctDays,
          r.visitDays,
          r.lastSeenAt,
          r.updatedAt,
        );
      }
      // 清理已经不在近 7 天停留段里的自动推断地点；用户确认过的永久保留
      const keep = new Set(items.map((item) => item.id));
      for (const row of staleStmt.all(actorId) as Array<{ place_id: string }>) {
        if (!keep.has(row.place_id)) deleteStmt.run(actorId, row.place_id);
      }
    });
    tx(records);
  }
}

function compareRank(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function parseEvidence(raw: unknown): string[] {
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function rowToRecord(row: Record<string, unknown>): PlaceSemanticRecord {
  return {
    id: String(row.place_id),
    actorId: String(row.actor_id),
    kind: (row.kind as PlaceSemanticKind) ?? "other",
    confidence: Number(row.confidence) || 0,
    label: (row.label as string | null) ?? null,
    city: (row.city as string | null) ?? null,
    district: (row.district as string | null) ?? null,
    region: (row.region as string | null) ?? null,
    country: (row.country as string | null) ?? null,
    address: (row.address as string | null) ?? null,
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    radiusMeters: Number(row.radius_meters),
    poiName: (row.poi_name as string | null) ?? null,
    poiType: (row.poi_type as string | null) ?? null,
    source: (row.source as PlaceSemanticSource) ?? "inferred",
    confirmed: Number(row.confirmed) === 1,
    evidence: parseEvidence(row.evidence),
    distinctDays: Number(row.distinct_days) || 0,
    visitDays: Number(row.visit_days) || 0,
    lastSeenAt: (row.last_seen_at as string | null) ?? null,
    updatedAt: String(row.updated_at ?? ""),
  };
}
