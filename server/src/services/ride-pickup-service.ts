/**
 * 打车「选上车点」地图卡的数据源（滴图 MCP）。
 *
 * 为什么单独成服务：
 *   - 报价/下单走 BookingService 的 ride 域；上车点选择发生在这之前，是
 *     「地图 + 逆地理 + 周边推荐点」三件事，不属于任何 provider 的订单接口。
 *   - 地图卡在聊天里要能被拖动：客户端拖一下就要重新逆地理，不能每次都
 *     跑一轮模型；所以 HTTP 路由（/geo/ride-pickup/resolve）与本服务同源。
 *
 * 诚实边界：
 *   - 只认滴滴官方 MCP（别名 didi）返回的地点/地址；没配 key 或调用失败时
 *     返回 null，由调用方退回纯坐标展示，不编造地址。
 *   - 周边推荐点失败不影响主流程：地图仍可拖，只是没有推荐标记。
 */
import type { McpClientService } from "./mcp-client-service.js";

export type RidePickupPoint = {
  name: string;
  address?: string;
  lat: number;
  lng: number;
  distanceM?: number;
};

export type RidePickupResolveResult = {
  point: RidePickupPoint | null;
  candidates: RidePickupPoint[];
};

export type RidePickupPlan = {
  dropoff: string;
  city?: string;
  dest: RidePickupPoint | null;
  center: { lat: number; lng: number } | null;
  pickup: RidePickupPoint | null;
  candidates: RidePickupPoint[];
};

const DIDI_ALIAS = "didi";
const MCP_TIMEOUT_MS = 12_000;

function textOf(result: Record<string, unknown>): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
  if (Array.isArray(content)) return content.map((c) => c?.text ?? "").join("\n");
  return JSON.stringify(result);
}

function parseResultJson(result: Record<string, unknown>): unknown {
  const text = textOf(result);
  try {
    return JSON.parse(text);
  } catch {
    const objMatch = text.match(/\{[\s\S]*\}/);
    if (objMatch) {
      try {
        return JSON.parse(objMatch[0]);
      } catch {
        /* ignore */
      }
    }
    const arrMatch = text.match(/\[[\s\S]*\]/);
    if (arrMatch) {
      try {
        return JSON.parse(arrMatch[0]);
      } catch {
        /* ignore */
      }
    }
  }
  return text;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** 坐标字符串 "lng,lat" → 数值对；域内值域校验，避免把地址里的数字当坐标。 */
function parseLngLatText(text: string): { lat: number; lng: number } | null {
  const m = text.trim().match(/^(-?\d{1,3}(?:\.\d+)?)\s*[,，]\s*(-?\d{1,3}(?:\.\d+)?)$/);
  if (!m) return null;
  const lng = Number(m[1]);
  const lat = Number(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < 15 || lat > 60 || lng < 70 || lng > 140) return null;
  return { lat, lng };
}

function readPoint(node: Record<string, unknown>): RidePickupPoint | null {
  let lat = typeof node.lat === "number" ? node.lat : Number(node.lat);
  let lng = typeof node.lng === "number" ? node.lng : Number(node.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    const rawLoc =
      (typeof node.location === "string" && node.location) ||
      (typeof node.coordinates === "string" && node.coordinates) ||
      "";
    const pair = rawLoc ? parseLngLatText(rawLoc) : null;
    if (!pair) return null;
    lat = pair.lat;
    lng = pair.lng;
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < 15 || lat > 60 || lng < 70 || lng > 140) return null;
  const name = String(
    node.display_name ?? node.name ?? node.title ?? node.formatted_address ?? node.address ?? "",
  ).trim();
  const address = String(
    node.address ?? node.formatted_address ?? node.address_all ?? "",
  ).trim();
  if (!name && !address) return null;
  const distanceRaw = node.distance;
  const distanceM =
    typeof distanceRaw === "number"
      ? distanceRaw
      : Number.isFinite(Number(distanceRaw)) && String(distanceRaw ?? "").trim() !== ""
        ? Number(distanceRaw)
        : undefined;
  return {
    name: name || address,
    ...(address ? { address } : {}),
    lat,
    lng,
    ...(distanceM != null && Number.isFinite(distanceM) ? { distanceM } : {}),
  };
}

/** 收集结果里所有像 POI 的对象（兼容数组 / {pois:[...]} / 深层包装）。 */
function collectPoints(node: unknown, out: RidePickupPoint[], depth = 0): void {
  if (depth > 6 || out.length >= 24) return;
  if (Array.isArray(node)) {
    for (const item of node) collectPoints(item, out, depth + 1);
    return;
  }
  if (!isRecord(node)) return;
  const point = readPoint(node);
  if (point) out.push(point);
  for (const value of Object.values(node)) {
    if (isRecord(value) || Array.isArray(value)) collectPoints(value, out, depth + 1);
  }
}

function dedupePoints(points: RidePickupPoint[]): RidePickupPoint[] {
  const seen = new Set<string>();
  const out: RidePickupPoint[] = [];
  for (const point of points) {
    const key = `${point.name}@${point.lat.toFixed(5)},${point.lng.toFixed(5)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(point);
  }
  return out;
}

export class RidePickupService {
  constructor(private readonly mcp: McpClientService | null) {}

  /** 滴滴 MCP 是否装配且鉴权可用（与 DidiMcpRideProvider 同判据）。 */
  availability(): { ok: boolean; reason?: string } {
    if (!this.mcp) return { ok: false, reason: "MCP 服务未装配" };
    const server = this.mcp.listServers().find((s) => s.alias === DIDI_ALIAS);
    if (!server) return { ok: false, reason: "滴滴 MCP server 未注册" };
    if (server.url?.includes("${DIDI_MCP_KEY}") && !process.env.DIDI_MCP_KEY?.trim()) {
      return { ok: false, reason: "未配置 DIDI_MCP_KEY" };
    }
    return { ok: true };
  }

  private async call(tool: string, args: Record<string, unknown>): Promise<unknown | null> {
    if (!this.mcp || !this.availability().ok) return null;
    try {
      const res = await this.mcp.callTool(DIDI_ALIAS, tool, args, MCP_TIMEOUT_MS);
      if (!res.ok) return null;
      return parseResultJson(res.result);
    } catch {
      return null;
    }
  }

  /** 坐标 → 可读地址（maps_regeocode）。 */
  async regeocode(lat: number, lng: number): Promise<RidePickupPoint | null> {
    const parsed = await this.call("maps_regeocode", { location: `${lng},${lat}` });
    if (parsed == null) return null;
    const found: RidePickupPoint[] = [];
    collectPoints(parsed, found);
    const point = found[0] ?? null;
    if (point) {
      return { ...point, lat, lng };
    }
    if (isRecord(parsed)) {
      const name = String(parsed.display_name ?? parsed.formatted_address ?? parsed.address ?? "").trim();
      if (name) return { name, lat, lng };
    }
    return null;
  }

  /** 目的地文本 → 坐标（maps_geo，失败再 maps_textsearch）。 */
  async resolveDestination(dropoff: string, city?: string): Promise<RidePickupPoint | null> {
    const text = dropoff.trim();
    if (!text) return null;
    const geo = await this.call("maps_geo", { address: text, ...(city ? { city } : {}) });
    if (geo != null) {
      const found: RidePickupPoint[] = [];
      collectPoints(geo, found);
      if (found[0]) return found[0];
    }
    if (!city) return null;
    const searched = await this.call("maps_textsearch", { keywords: text, city });
    if (searched == null) return null;
    const found: RidePickupPoint[] = [];
    collectPoints(searched, found);
    return found[0] ?? null;
  }

  /**
   * 中心点周边推荐上车点（maps_place_around）。
   *
   * 公交站/地铁站是确定性上车点，比「附近任意 POI」更适合作为预选；
   * 两个关键词并发，失败静默降级，不影响地图拖动。
   */
  async nearbyPickups(lat: number, lng: number): Promise<RidePickupPoint[]> {
    const location = `${lng},${lat}`;
    const [stops, metros] = await Promise.all([
      this.call("maps_place_around", { location, keywords: "公交站", max_distance: "1000" }),
      this.call("maps_place_around", { location, keywords: "地铁站", max_distance: "1500" }),
    ]);
    const collected: RidePickupPoint[] = [];
    for (const parsed of [stops, metros]) {
      if (parsed == null) continue;
      const found: RidePickupPoint[] = [];
      collectPoints(parsed, found);
      collected.push(...found);
    }
    return dedupePoints(collected)
      .sort((a, b) => (a.distanceM ?? Number.MAX_SAFE_INTEGER) - (b.distanceM ?? Number.MAX_SAFE_INTEGER))
      .slice(0, 6);
  }

  /** 地图拖动/点推荐点后的即时解析：逆地理 + 周边推荐。 */
  async resolvePoint(lat: number, lng: number, opts?: { withCandidates?: boolean }): Promise<RidePickupResolveResult> {
    if (opts?.withCandidates) {
      const [point, candidates] = await Promise.all([this.regeocode(lat, lng), this.nearbyPickups(lat, lng)]);
      return { point, candidates };
    }
    return { point: await this.regeocode(lat, lng), candidates: [] };
  }

  /**
   * 弹卡所需的完整上下文：目的地坐标 + 初始中心 + 预选上车点 + 推荐点。
   * 客户端定位优先作为中心；没有定位时用目的地坐标兜底（至少地图不是空白）。
   */
  async buildPlan(input: {
    dropoff: string;
    city?: string;
    location?: { lat: number; lng: number } | null;
  }): Promise<RidePickupPlan> {
    const destPromise = this.resolveDestination(input.dropoff, input.city);
    const hasLocation = !!input.location;
    const center = input.location ? { lat: input.location.lat, lng: input.location.lng } : null;

    if (center) {
      const [dest, pickup, candidates] = await Promise.all([
        destPromise,
        this.regeocode(center.lat, center.lng),
        this.nearbyPickups(center.lat, center.lng),
      ]);
      return { dropoff: input.dropoff, city: input.city, dest, center, pickup, candidates };
    }

    const dest = await destPromise;
    const fallbackCenter = dest ? { lat: dest.lat, lng: dest.lng } : null;
    if (!fallbackCenter) {
      return { dropoff: input.dropoff, city: input.city, dest, center: null, pickup: null, candidates: [] };
    }
    const [pickup, candidates] = await Promise.all([
      this.regeocode(fallbackCenter.lat, fallbackCenter.lng),
      this.nearbyPickups(fallbackCenter.lat, fallbackCenter.lng),
    ]);
    return {
      dropoff: input.dropoff,
      city: input.city,
      dest,
      center: fallbackCenter,
      pickup,
      candidates,
    };
  }
}
