/**
 * 上车点候选服务（ride_pickup 卡数据源，2026-11-20 定稿）。
 *
 * 数据面只用滴滴 MCP 滴图地图（maps_place_around：keywords + location + radius，
 * 返回 display_name/address/location/distance），不用高德——实测兴义梦乐城
 * 坐标可返回「向阳小区地上停车场(112m)…」这类理想上车点。
 * MCP 未注册 / 调用失败 / 解析失败 → 空数组，卡退化为纯地图选点，不阻塞。
 */
import type { McpClientService } from "./mcp-client-service.js";

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
 * 定位坐标周边的可上车点候选（默认搜「停车场」，按距离排 top5）。
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
  try {
    const res = await mcp.callTool(
      "didi",
      "maps_place_around",
      {
        keywords: keyword,
        location: `${lng.toFixed(6)},${lat.toFixed(6)}`,
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
      out.push({
        id: typeof poi.id === "string" ? poi.id : `poi_${out.length}`,
        name,
        address: typeof poi.address === "string" ? (poi.address as string).trim() : "",
        lng: lngN,
        lat: latN,
        distM: distRaw != null && distRaw > 0 ? Math.round(distRaw) : null,
      });
      if (out.length >= 5) break;
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
    return { lng: lngN, lat: latN, name };
  } catch {
    return null;
  }
}

/**
 * 坐标 → 中文地名（滴图 maps_regeocode）。选点卡拖图选的自定义上车点
 * 用它命名，报价卡/确认卡显示真实地址而非坐标。
 * 顺带返回 city/county：无定位路径下 card-action 可用它补 textsearch 的
 * 必填 city，避免「无法定位目的地」。
 */
export async function regeocodeViaDidi(
  mcp: McpClientService,
  lng: number,
  lat: number,
): Promise<{ name: string; address: string; city: string; county: string } | null> {
  if (!mcp.listServers().some((s) => s.alias === "didi")) return null;
  try {
    const res = await mcp.callTool(
      "didi",
      "maps_regeocode",
      { location: `${lng.toFixed(6)},${lat.toFixed(6)}` },
      20_000,
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
}

/**
 * 驾车路线（滴图 maps_direction_driving）：origin/destination 为「lng,lat」
 * 字符串，返回 distance/duration{text,value} + geo_list 轨迹点。
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
  try {
    const res = await mcp.callTool(
      "didi",
      "maps_direction_driving",
      {
        origin: `${fromLng.toFixed(6)},${fromLat.toFixed(6)}`,
        destination: `${toLng.toFixed(6)},${toLat.toFixed(6)}`,
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
        return la != null && lo != null ? { lat: la, lng: lo } : null;
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
 * 可选 product_category）。报价成功后生成「去滴滴 App 发单」备用入口。
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
  try {
    const res = await mcp.callTool(
      "didi",
      "taxi_generate_ride_app_link",
      {
        from_lng: fromLng.toFixed(6),
        from_lat: fromLat.toFixed(6),
        to_lng: toLng.toFixed(6),
        to_lat: toLat.toFixed(6),
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
