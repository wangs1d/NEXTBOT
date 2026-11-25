/**
 * 上车点候选服务（ride_pickup 卡数据源，2026-11-20 定稿）。
 *
 * 数据面只用滴滴 MCP 滴图地图（maps_place_around：keywords + location + radius，
 * 返回 display_name/address/location/distance），不用高德——实测兴义梦乐城
 * 坐标可返回「向阳小区地上停车场(112m)…」这类理想上车点。
 * MCP 未注册 / 调用失败 / 解析失败 → 空数组，卡退化为纯地图选点，不阻塞。
 */
import type { McpClientService } from "./mcp-client-service.js";
import { gcj02ToWgs84, wgs84ToGcj02 } from "../skills/travel-planning/coord-transform.js";

/**
 * 滴滴滴图（maps_*）与网约车（taxi_*）全部使用 GCJ-02（2026-11-23 实测对照：
 * 春熙路滴滴坐标与高德 GCJ-02 差约 2m）。本项目服务端以 WGS-84 为单一基准
 * （手机 GPS 也是 WGS-84），所以**凡是进出滴滴的坐标都在这里转一次**：
 *   - 入参 WGS → GCJ 再发给滴滴；
 *   - 滴滴返回的 GCJ → WGS 再交给卡片/上层。
 * 少转或多转一次就是 300~700m 的偏移，表现为「定位点飘到隔壁街」。
 */

export interface RidePickupCandidate {
  id: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  distM: number | null;
}

function textOf(result: Record<string, unknown>): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
  if (Array.isArray(content)) return content.map((c) => c?.text ?? "").join("\n");
  return JSON.stringify(result);
}

function parseJsonLoose(result: Record<string, unknown>): unknown {
  const text = textOf(result);
  try {
    return JSON.parse(text);
  } catch {
    const m = text.match(/\[[\s\S]*\]|\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

function toNumber(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

/**
 * 定位坐标周边的可上车点候选（默认搜「停车场」，按距离排 **top3**）。
 *
 * 对齐滴滴「上车点推荐算法」四步（网信算备120116299582406230049号）：
 *   1. 上车点生成：滴滴基于**路网拓扑**生成「可上车位置」，并用附近 POI 命名；
 *      我们没有路网吸附接口，用滴图 maps_place_around 的停车场/落客点近似，
 *      这是明确的近似项，不假装成路网级推荐。
 *   2. 召回打分：按距离召回（radius 800m）。
 *   3. 规则重排：距离为主，可停靠属性由「停车场」关键词天然满足 → **只留 3 条**
 *      （滴滴官方口径就是「推荐 1~3 条」，不是把周边全列出来）。
 *   4. 命名：直接用 POI 的 display_name（如「九华苑停车场」）。
 *
 * 入参 `lng/lat` 与返回候选坐标均为 **WGS-84**（服务端基准）；内部转 GCJ 调滴滴。
 * 坐标/数字参数按滴滴 MCP 契约一律传字符串。
 */
export async function searchNearbyPickupsViaDidi(
  mcp: McpClientService,
  lng: number,
  lat: number,
  keyword = "停车场",
  radiusM = 800,
): Promise<RidePickupCandidate[]> {
  if (!mcp.listServers().some((s) => s.alias === "didi")) return [];
  const gcj = wgs84ToGcj02(lat, lng);
  try {
    const res = await mcp.callTool(
      "didi",
      "maps_place_around",
      {
        keywords: keyword,
        location: `${gcj.longitude.toFixed(6)},${gcj.latitude.toFixed(6)}`,
        radius: String(Math.round(radiusM)),
      },
      20_000,
    );
    if (!res.ok) return [];
    const parsed = parseJsonLoose(res.result);
    const pois: Array<Record<string, unknown>> = Array.isArray(parsed)
      ? (parsed as Array<Record<string, unknown>>)
      : Array.isArray((parsed as { pois?: unknown })?.pois)
        ? ((parsed as { pois: Array<Record<string, unknown>> }).pois)
        : [];
    const out: RidePickupCandidate[] = [];
    for (const poi of pois) {
      const loc = (poi.location ?? {}) as { lng?: unknown; lat?: unknown };
      const lngN = toNumber(loc.lng);
      const latN = toNumber(loc.lat);
      const name = typeof poi.display_name === "string"
        ? poi.display_name.trim()
        : typeof poi.name === "string"
          ? (poi.name as string).trim()
          : "";
      if (lngN == null || latN == null || !name) continue;
      const distRaw = toNumber(poi.distance);
      // 滴滴候选是 GCJ-02：转回 WGS-84 再交给卡片（客户端渲染时再转 GCJ 上底图）
      const wgs = gcj02ToWgs84(latN, lngN);
      out.push({
        id: typeof poi.id === "string" ? poi.id : `poi_${out.length}`,
        name,
        address: typeof poi.address === "string" ? (poi.address as string).trim() : "",
        lng: wgs.longitude,
        lat: wgs.latitude,
        distM: distRaw != null && distRaw > 0 ? Math.round(distRaw) : null,
      });
      if (out.length >= 3) break;
    }
    return out.sort((a, b) => (a.distM ?? Infinity) - (b.distM ?? Infinity));
  } catch {
    return [];
  }
}

/**
 * 地址文本 → 坐标（滴图 maps_textsearch）。无 GPS 时把选点卡锚到目的地
 * 周边用：拿到目的地坐标才能拉候选 + 地图居中，卡不再是全国视野空板。
 * 生产端点强制要求 city（缺失 HTTP 400），调用方尽量带 city；失败返回 null。
 */
export async function textsearchViaDidi(
  mcp: McpClientService,
  keywords: string,
  city?: string,
): Promise<{ lng: number; lat: number; name: string } | null> {
  if (!mcp.listServers().some((s) => s.alias === "didi")) return null;
  if (!keywords.trim()) return null;
  try {
    const res = await mcp.callTool(
      "didi",
      "maps_textsearch",
      { keywords: keywords.trim(), ...(city?.trim() ? { city: city.trim() } : {}) },
      20_000,
    );
    if (!res.ok) return null;
    const parsed = parseJsonLoose(res.result) as Record<string, unknown> | null;
    // 滴滴 MCP 是 HTTP 200 但业务体带错误码（如 city="兴义市" → CITY_NOT_FOUND）。
    // 不能只看 res.ok，否则业务失败会被当成「搜不到目的地」的失败假象。
    if (parsed && !Array.isArray(parsed) && typeof parsed.code === "string" &&
        !/^0$|success/i.test(parsed.code)) {
      return null;
    }
    if (parsed && !Array.isArray(parsed) && typeof parsed.status === "string" &&
        !/^0$|success/i.test(parsed.status)) {
      return null;
    }
    const pois: Array<Record<string, unknown>> = Array.isArray(parsed)
      ? (parsed as Array<Record<string, unknown>>)
      : Array.isArray((parsed as { pois?: unknown })?.pois)
        ? ((parsed as { pois: Array<Record<string, unknown>> }).pois)
        : [];
    const first = pois[0];
    if (!first) return null;
    const loc = (first.location ?? {}) as { lng?: unknown; lat?: unknown };
    const lngN = toNumber(loc.lng);
    const latN = toNumber(loc.lat);
    if (lngN == null || latN == null) return null;
    const name =
      typeof first.display_name === "string"
        ? first.display_name.trim()
        : typeof first.name === "string"
          ? (first.name as string).trim()
          : keywords.trim();
    // 滴滴返回 GCJ-02 → 统一成 WGS-84（服务端基准）
    const wgs = gcj02ToWgs84(latN, lngN);
    return { lng: wgs.longitude, lat: wgs.latitude, name };
  } catch {
    return null;
  }
}

/**
 * 坐标 → 中文地名（滴图 maps_regeocode）。选点卡拖图选的自定义上车点
 * 用它命名，报价卡/确认卡显示真实地址而非坐标。
 * 入参 `lng/lat` 为 WGS-84（卡内选点回传即 WGS），内部转 GCJ 调滴滴。
 * 顺带返回 city/county：无定位路径下 card-action 可用它补 textsearch 的
 * 必填 city，避免「无法定位目的地」。
 */
export async function regeocodeViaDidi(
  mcp: McpClientService,
  lng: number,
  lat: number,
  /** 单次调用上限：推卡前置的反查必须短（默认 20s 会把卡片拖死），
   *  选点卡传 3.5s，失败就用定位原始 label（2026-11-24）。 */
  timeoutMs = 20_000,
): Promise<{ name: string; address: string; city: string; county: string } | null> {
  if (!mcp.listServers().some((s) => s.alias === "didi")) return null;
  const gcj = wgs84ToGcj02(lat, lng);
  try {
    const res = await mcp.callTool(
      "didi",
      "maps_regeocode",
      { location: `${gcj.longitude.toFixed(6)},${gcj.latitude.toFixed(6)}` },
      timeoutMs,
    );
    if (!res.ok) return null;
    const parsed = parseJsonLoose(res.result) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== "object") return null;
    const name = typeof parsed.display_name === "string" ? parsed.display_name.trim() : "";
    const address =
      typeof parsed.formatted_address === "string" ? parsed.formatted_address.trim() : "";
    const city = typeof parsed.city === "string" ? parsed.city.trim() : "";
    const county = typeof parsed.county === "string" ? parsed.county.trim() : "";
    if (!name && !address) return null;
    return { name, address, city, county };
  } catch {
    return null;
  }
}

export interface DrivingRouteSummary {
  distanceText: string;
  durationText: string;
  distanceKm: number | null;
  durationMin: number | null;
  points: Array<{ lat: number; lng: number }>;
  /** 起点/终点（WGS-84）：算路失败时客户端仍要能标出“在哪儿上车、去哪儿” */
  from?: { lat: number; lng: number };
  to?: { lat: number; lng: number };
}

/**
 * 驾车路线（滴图 maps_direction_driving）：origin/destination 为「lng,lat」
 * 字符串，返回 distance/duration{text,value} + geo_list 轨迹点。
 * 入参起终点与返回 `points` 均为 **WGS-84**（内部与滴滴 GCJ-02 互转），
 * 选点卡确认上车点后调，路线随 ride_quote 卡下发，App 内直接看。
 */
export async function drivingRouteViaDidi(
  mcp: McpClientService,
  fromLng: number,
  fromLat: number,
  toLng: number,
  toLat: number,
): Promise<DrivingRouteSummary | null> {
  if (!mcp.listServers().some((s) => s.alias === "didi")) return null;
  const gFrom = wgs84ToGcj02(fromLat, fromLng);
  const gTo = wgs84ToGcj02(toLat, toLng);
  try {
    const res = await mcp.callTool(
      "didi",
      "maps_direction_driving",
      {
        origin: `${gFrom.longitude.toFixed(6)},${gFrom.latitude.toFixed(6)}`,
        destination: `${gTo.longitude.toFixed(6)},${gTo.latitude.toFixed(6)}`,
      },
      30_000,
    );
    if (!res.ok) return null;
    const parsed = parseJsonLoose(res.result) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== "object") return null;
    const distance = (parsed.distance ?? {}) as { text?: unknown; value?: unknown };
    const duration = (parsed.duration ?? {}) as { text?: unknown; value?: unknown };
    const distanceText = typeof distance.text === "string" ? distance.text : "";
    const durationText = typeof duration.text === "string" ? duration.text : "";
    if (!distanceText && !durationText) return null;
    const distanceValueM = toNumber(distance.value);
    const durationValueS = toNumber(duration.value);
    const geoList = Array.isArray(parsed.geo_list) ? parsed.geo_list : [];
    const points = geoList
      .map((g) => {
        const p = (g ?? {}) as { latitude?: unknown; longitude?: unknown };
        const la = toNumber(p.latitude);
        const lo = toNumber(p.longitude);
        if (la == null || lo == null) return null;
        // 滴滴轨迹点 GCJ-02 → WGS-84（客户端渲染时再转 GCJ 上高德底图）
        const wgs = gcj02ToWgs84(la, lo);
        return { lat: wgs.latitude, lng: wgs.longitude };
      })
      .filter((p): p is { lat: number; lng: number } => p != null)
      .slice(0, 400);
    return {
      distanceText:
        distanceText ||
        (distanceValueM != null ? `${(distanceValueM / 1000).toFixed(1)} km` : ""),
      durationText:
        durationText ||
        (durationValueS != null ? `${Math.round(durationValueS / 60)}分钟` : ""),
      distanceKm: distanceValueM != null ? Math.round(distanceValueM / 10) / 100 : null,
      durationMin: durationValueS != null ? Math.round(durationValueS / 60) : null,
      points,
    };
  } catch {
    return null;
  }
}

/**
 * 滴滴 App 深链（taxi_generate_ride_app_link：from/to 坐标必填，
 * 可选 product_category）。入参为 WGS-84，内部转 GCJ 交给滴滴。
 */
export async function rideAppLinkViaDidi(
  mcp: McpClientService,
  fromLng: number,
  fromLat: number,
  toLng: number,
  toLat: number,
  productCategory?: string,
): Promise<string | null> {
  if (!mcp.listServers().some((s) => s.alias === "didi")) return null;
  const gFrom = wgs84ToGcj02(fromLat, fromLng);
  const gTo = wgs84ToGcj02(toLat, toLng);
  try {
    const res = await mcp.callTool(
      "didi",
      "taxi_generate_ride_app_link",
      {
        from_lng: gFrom.longitude.toFixed(6),
        from_lat: gFrom.latitude.toFixed(6),
        to_lng: gTo.longitude.toFixed(6),
        to_lat: gTo.latitude.toFixed(6),
        ...(productCategory?.trim() ? { product_category: productCategory.trim() } : {}),
      },
      20_000,
    );
    if (!res.ok) return null;
    const url = deepFindUrl(parseJsonLoose(res.result));
    return url || null;
  } catch {
    return null;
  }
}

function deepFindUrl(v: unknown): string | null {
  if (typeof v === "string") {
    return /^https?:\/\//.test(v) ? v : null;
  }
  if (Array.isArray(v)) {
    for (const item of v) {
      const hit = deepFindUrl(item);
      if (hit) return hit;
    }
    return null;
  }
  if (v && typeof v === "object") {
    for (const val of Object.values(v as Record<string, unknown>)) {
      const hit = deepFindUrl(val);
      if (hit) return hit;
    }
  }
  return null;
}
