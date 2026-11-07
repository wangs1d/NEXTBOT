/**
 * 路程估时服务：
 *   目的地文本 × 起点（坐标或文本）→ 高德地理编码 → 高德路径规划（驾车含实时
 *   路况时长 / 步行按真实步速）→ { durationMin, distanceKm, source }；
 *   无 Key / 失败自动降级 OSRM（调用方注入 computeRoute 形状的兜底函数）。
 *
 * 2026-11-05 升级为「对话可问的通用能力」：
 *   - `estimateTravelTime` 统一入口：起点可缺省（上层按用户实时定位补齐）、
 *     交通方式 auto/walking/driving 自选（auto ≤1.5km 走步行，避免 1km 判成
 *     开车 3 分钟）、坐标顺序自适应（高德要「经度,纬度」，而 clock 工具吐的是
 *     latitude/longitude，LLM 原样填进来会静默算错）。
 *   - `estimateDriveMinutes` 保留为驾车语义的薄包装（日程出发提醒在用），
 *     起点坐标统一按客户端 GPS（WGS-84）→ GCJ-02 转换后送高德。
 *
 * AMAP_WEB_KEY 每次调用时读取（不走模块级常量），运行时 applyPass 类 env
 * 热下发与测试注入无需重载模块。
 */
import { wgs84ToGcj02 } from "./reverse-geocode-service.js";

const AMAP_GEO_BASE = "https://restapi.amap.com/v3/geocode/geo";
const AMAP_DRIVING_BASE = "https://restapi.amap.com/v3/direction/driving";
const AMAP_WALKING_BASE = "https://restapi.amap.com/v3/direction/walking";
const AMAP_TIMEOUT_MS = 8_000;

export type RouteEstimateSource = "amap" | "osrm";

export type RouteEstimate = {
  durationMin: number;
  distanceKm: number;
  source: RouteEstimateSource;
};

export type GeoPoint = { latitude: number; longitude: number };
export type TravelMode = "walking" | "driving";
/** auto = 按直线距离自动选步行/驾车 */
export type TravelModeHint = "auto" | TravelMode;
/** 坐标来源坐标系：客户端 GPS 是 WGS-84，高德要 GCJ-02 */
export type CoordSystem = "wgs84" | "gcj02";

/** 超过该时长（分钟）的路程视为跨城长途，超出「出发预留」策略的适用域 → 回退静态表 */
export const MAX_ROUTE_MINUTES = 480;

/** auto 模式的步行阈值（与行程编排 amapTransport 同口径） */
export const WALK_MAX_KM = 1.5;

// 高德只懂国内（GCJ-02）。用经纬度取值范围判别顺序：经度 70~180 / 纬度 0~60
// 两个区间不相交，所以「哪个数是经度」在国境内是确定的，无需调用方声明顺序。
const LNG_MIN = 70;
const LNG_MAX = 180;
const LAT_MIN = 0;
const LAT_MAX = 60;

function inRange(v: number, lo: number, hi: number): boolean {
  return Number.isFinite(v) && v >= lo && v <= hi;
}

function parseAmapLocation(raw: string): GeoPoint | null {
  const parts = raw.split(",").map((s) => Number(s.trim()));
  if (parts.length !== 2 || !parts.every((n) => Number.isFinite(n))) return null;
  return { longitude: parts[0]!, latitude: parts[1]! };
}

/**
 * 坐标串归一成高德要的「经度,纬度」。
 * 「39.9,116.4」（纬度,经度）会被自动纠正为「116.4,39.9」——LLM 把
 * clock.get_user_location 返回的 latitude,longitude 直接当入参是高频写法，
 * 旧实现按 lng,lat 解释会静默落到另一个点（不报错，只是结果错）。
 * 返回 null 表示不是坐标串（按地名处理）。
 */
export function normalizeAmapLocation(raw: string): string | null {
  const parts = raw.split(",").map((s) => Number(s.trim()));
  if (parts.length !== 2 || !parts.every((n) => Number.isFinite(n))) return null;
  const [a, b] = parts as [number, number];
  const aIsLng = inRange(a, LNG_MIN, LNG_MAX);
  const aIsLat = inRange(a, LAT_MIN, LAT_MAX);
  const bIsLng = inRange(b, LNG_MIN, LNG_MAX);
  const bIsLat = inRange(b, LAT_MIN, LAT_MAX);
  if (!aIsLng && !aIsLat && !bIsLng && !bIsLat) return null;
  // 明确的「纬度,经度」→ 换回「经度,纬度」
  if (aIsLat && bIsLng) return `${b},${a}`;
  return `${a},${b}`;
}

function pointToAmapLocation(point: GeoPoint, coordSystem: CoordSystem): string {
  const p = coordSystem === "wgs84" ? wgs84ToGcj02(point.latitude, point.longitude) : point;
  return `${p.longitude.toFixed(6)},${p.latitude.toFixed(6)}`;
}

/** 两点直线距离（km，haversine） */
export function haversineKm(a: GeoPoint, b: GeoPoint): number {
  const R = 6371;
  const dLat = ((b.latitude - a.latitude) * Math.PI) / 180;
  const dLon = ((b.longitude - a.longitude) * Math.PI) / 180;
  const lat1 = (a.latitude * Math.PI) / 180;
  const lat2 = (b.latitude * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** 高德地理编码：地名 → "lng,lat"（国内地名准确；失败返回 null） */
export async function amapGeocode(address: string, city?: string): Promise<string | null> {
  const key = process.env.AMAP_WEB_KEY || "";
  if (!key) return null;
  const params = new URLSearchParams({ key, address });
  if (city) params.set("city", city);
  try {
    const res = await fetch(`${AMAP_GEO_BASE}?${params}`, { signal: AbortSignal.timeout(AMAP_TIMEOUT_MS) });
    const json = (await res.json()) as { status?: string; geocodes?: Array<{ location?: string }> };
    if (json.status === "1" && json.geocodes?.[0]?.location) return json.geocodes[0].location!;
  } catch {
    // 降级
  }
  return null;
}

type AmapRouteMinutes = { durationMin: number; distanceKm: number } | null;

async function amapDirection(
  base: string,
  origin: string,
  destination: string,
  extra?: Record<string, string>,
): Promise<AmapRouteMinutes> {
  const key = process.env.AMAP_WEB_KEY || "";
  if (!key) return null;
  const params = new URLSearchParams({ key, origin, destination, extensions: "base", ...extra });
  try {
    const res = await fetch(`${base}?${params}`, { signal: AbortSignal.timeout(AMAP_TIMEOUT_MS) });
    const json = (await res.json()) as {
      status?: string;
      route?: { paths?: Array<{ duration?: string; distance?: string }> };
    };
    const path = json.route?.paths?.[0];
    if (json.status === "1" && path?.duration) {
      const durationMin = Math.round(Number(path.duration) / 60);
      if (!Number.isFinite(durationMin)) return null;
      return { durationMin, distanceKm: Math.round(Number(path.distance ?? 0) / 100) / 10 };
    }
  } catch {
    // 降级
  }
  return null;
}

/** 高德驾车路径规划：返回 {durationMin, distanceKm}（含实时路况时长估算） */
export async function amapDrivingRoute(
  origin: string,
  destination: string,
): Promise<AmapRouteMinutes> {
  return amapDirection(AMAP_DRIVING_BASE, origin, destination, { strategy: "2" });
}

/** 高德步行路径规划：市内短驳用步行才不会被驾车估时压低（1km 开车 3 分、走路 15 分） */
export async function amapWalkingRoute(
  origin: string,
  destination: string,
): Promise<AmapRouteMinutes> {
  return amapDirection(AMAP_WALKING_BASE, origin, destination);
}

export type TravelEstimate = {
  durationMin: number;
  distanceKm: number;
  /** 实际采用的交通方式（amap 下由距离/入参决定；osrm 兜底恒为驾车） */
  mode: TravelMode;
  source: RouteEstimateSource;
  /** 解析到的起点/终点坐标（地理编码成功时给出，供上层复用免二次编码） */
  originPoint?: GeoPoint;
  destinationPoint?: GeoPoint;
};

export type TravelTimeInput = {
  /**
   * 起点：坐标对象（客户端定位）或地名/坐标串。
   * 缺省/空 → 返回 null，由上层（工具）按用户实时定位补齐或引导用户说明。
   */
  origin?: GeoPoint | string;
  /** origin 为坐标对象时的坐标系，缺省 wgs84（客户端 GPS）→ 转 GCJ-02 再送高德 */
  originCoordSystem?: CoordSystem;
  destination: string;
  /** 交通方式，缺省 auto：直线 ≤1.5km 步行，否则驾车（含实时路况） */
  mode?: TravelModeHint;
  /** 高德不可用时的兜底（通常传 travel-planning-service.computeRoute） */
  osrmFallback?: (
    from: GeoPoint | string,
    to: string,
  ) => Promise<{ durationMin: number; distanceKm: number } | null>;
};

/**
 * 通用估时主入口：起点 × 目的地 → {交通方式, 耗时, 距离, 来源, 坐标}。
 * 高德优先（含实时路况/真实步速）→ 调用方给的 OSRM 兜底 → null。
 * 任何一步失败返回 null，绝不抛异常（路线失败不阻塞主链路）。
 */
export async function estimateTravelTime(input: TravelTimeInput): Promise<TravelEstimate | null> {
  const destText = (input.destination ?? "").trim();
  if (!destText) return null;
  const hint: TravelModeHint = input.mode ?? "auto";

  // 起点归一：对象坐标 → 高德串；数字串 → 顺序纠正；其余地名待编码
  let originGeoIn: string | null = null;
  let originText: string | null = null;
  let originPoint: GeoPoint | undefined;

  if (input.origin && typeof input.origin === "object") {
    const { latitude, longitude } = input.origin;
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
    originPoint = { latitude, longitude };
    originGeoIn = pointToAmapLocation({ latitude, longitude }, input.originCoordSystem ?? "wgs84");
  } else if (typeof input.origin === "string" && input.origin.trim()) {
    const raw = input.origin.trim();
    const normalized = normalizeAmapLocation(raw);
    if (normalized) {
      originGeoIn = normalized;
      originPoint = parseAmapLocation(normalized) ?? undefined;
    } else {
      originText = raw;
    }
  }
  if (!originGeoIn && !originText) return null;

  try {
    const [originGeo, destGeo] = await Promise.all([
      originGeoIn ? Promise.resolve(originGeoIn) : amapGeocode(originText!),
      amapGeocode(destText),
    ]);
    const destPoint = destGeo ? (parseAmapLocation(destGeo) ?? undefined) : undefined;

    if (originGeo && destGeo) {
      const fromPoint = parseAmapLocation(originGeo) ?? originPoint;
      const mode: TravelMode =
        hint === "auto"
          ? fromPoint && destPoint && haversineKm(fromPoint, destPoint) <= WALK_MAX_KM
            ? "walking"
            : "driving"
          : hint;
      const r =
        mode === "walking"
          ? await amapWalkingRoute(originGeo, destGeo)
          : await amapDrivingRoute(originGeo, destGeo);
      if (r && r.durationMin > 0 && r.durationMin <= MAX_ROUTE_MINUTES) {
        return {
          durationMin: r.durationMin,
          distanceKm: r.distanceKm,
          mode,
          source: "amap",
          ...(fromPoint ? { originPoint: fromPoint } : {}),
          ...(destPoint ? { destinationPoint: destPoint } : {}),
        };
      }
    }

    if (input.osrmFallback) {
      const from: GeoPoint | string = originPoint ?? originText!;
      const r = await input.osrmFallback(from, destText);
      if (r && typeof r.durationMin === "number" && r.durationMin > 0 && r.durationMin <= MAX_ROUTE_MINUTES) {
        return {
          durationMin: Math.round(r.durationMin),
          distanceKm: Math.round((Number(r.distanceKm) || 0) * 10) / 10,
          // OSRM 公开节点只有驾车 profile：入参没指定步行时如实标驾车
          mode: hint === "walking" ? "walking" : "driving",
          source: "osrm",
        };
      }
    }
  } catch {
    // 路线失败 → 上层回退静态表/反问
  }
  return null;
}

export type DriveEstimateInput = {
  /** 目的地文本（日程 location 线索，如「首都机场T3」「杭州君悦酒店」） */
  destinationText: string;
  /** 起点坐标（用户实时/最近位置 WGS-84，优先于起点文本） */
  origin?: { latitude: number; longitude: number };
  /** 起点文本（无坐标时地理编码） */
  originText?: string;
  /** OSRM 兜底（如 travel-planning-service.computeRoute），高德不可用时走 */
  osrmFallback?: (
    from: string | { latitude: number; longitude: number },
    to: string | { latitude: number; longitude: number },
  ) => Promise<{ durationMin: number; distanceKm: number } | null>;
};

/**
 * 驾车语义包装（日程出发提醒在用）：只换因子来源，不改调用方决策结构。
 * 起点坐标按客户端 GPS（WGS-84）处理，送高德前转 GCJ-02。
 */
export async function estimateDriveMinutes(input: DriveEstimateInput): Promise<RouteEstimate | null> {
  const dest = (input.destinationText ?? "").trim();
  if (!dest) return null;
  const origin = input.origin ?? ((input.originText ?? "").trim() || undefined);
  if (!origin) return null;

  const est = await estimateTravelTime({
    origin,
    originCoordSystem: "wgs84",
    destination: dest,
    mode: "driving",
    osrmFallback: input.osrmFallback,
  });
  if (!est) return null;
  return { durationMin: est.durationMin, distanceKm: est.distanceKm, source: est.source };
}
