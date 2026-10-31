/**
 * 路程估时薄服务（无本地依赖）：
 *   目的地文本 × 起点（坐标或文本）→ 高德地理编码 → 高德路径规划（驾车含实时
 *   路况时长 / 步行按真实步速）→ { durationMin, distanceKm, source }；
 *   无 Key / 失败自动降级 OSRM（调用方注入 computeRoute 形状的兜底函数）。
 *
 * 提取自 travel-commute-skills 的同名私有函数（travel.departure-advice 与本服务
 * 共用同一套高德调用），供提醒策略层消费——schedule-reminder-policy 的
 * travelMinutes 因子由此从「venue 静态查找表」升级为真实路程（2026-10-05），
 * 只换因子来源，不改策略决策结构。
 *
 * AMAP_WEB_KEY 每次调用时读取（不走模块级常量），运行时 applyPass 类 env
 * 热下发与测试注入无需重载模块。
 */

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

export type DriveEstimateInput = {
  /** 目的地文本（日程 location 线索，如「首都机场T3」「杭州君悦酒店」） */
  destinationText: string;
  /** 起点坐标（用户实时/最近位置，优先于起点文本） */
  origin?: { latitude: number; longitude: number };
  /** 起点文本（无坐标时地理编码） */
  originText?: string;
  /** OSRM 兜底（如 travel-planning-service.computeRoute），高德不可用时走 */
  osrmFallback?: (
    from: string | { latitude: number; longitude: number },
    to: string | { latitude: number; longitude: number },
  ) => Promise<{ durationMin: number; distanceKm: number } | null>;
};

/** 超过该时长（分钟）的路程视为跨城长途，超出「出发预留」策略的适用域 → 回退静态表 */
export const MAX_ROUTE_MINUTES = 480;

/**
 * 估时主入口：高德优先（含实时路况）→ OSRM 兜底。任何一步失败返回 null，
 * 由调用方回退静态表——路程估时永远不阻塞主链路。
 */
export async function estimateDriveMinutes(input: DriveEstimateInput): Promise<RouteEstimate | null> {
  const dest = (input.destinationText ?? "").trim();
  if (!dest) return null;
  try {
    const originStr = input.origin
      ? `${input.origin.longitude.toFixed(6)},${input.origin.latitude.toFixed(6)}`
      : (input.originText ?? "").trim() || null;
    if (!originStr) return null;
    const [originGeo, destGeo] = await Promise.all([
      /^[-0-9.,]+$/.test(originStr) ? Promise.resolve(originStr) : amapGeocode(originStr),
      amapGeocode(dest),
    ]);
    if (originGeo && destGeo) {
      const r = await amapDrivingRoute(originGeo, destGeo);
      if (r && r.durationMin > 0 && r.durationMin <= MAX_ROUTE_MINUTES) {
        return { durationMin: r.durationMin, distanceKm: r.distanceKm, source: "amap" };
      }
    }
    if (input.osrmFallback) {
      const r = await input.osrmFallback(
        input.origin ?? originStr ?? input.originText ?? "",
        dest,
      );
      if (r && typeof r.durationMin === "number" && r.durationMin > 0 && r.durationMin <= MAX_ROUTE_MINUTES) {
        return {
          durationMin: Math.round(r.durationMin),
          distanceKm: Math.round((Number(r.distanceKm) || 0) * 10) / 10,
          source: "osrm",
        };
      }
    }
  } catch {
    // 路线失败 → 静态表兜底
  }
  return null;
}
