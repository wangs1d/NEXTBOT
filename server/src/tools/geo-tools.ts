/**
 * geo.* 工具：地点检索与距离计算（2026-11-13 新增）。
 *
 * 为什么必须有：
 * 此前 agent **没有任何真实地理位置工具** —— `travel.search-poi` 是旅行规划专用
 * （一次拉一整城景点/酒店/餐厅，且城市中心点来自本地 POI 缓存），不是「查某地
 * 在哪、离我多远」的通用能力。结果是用户问「离下五屯九华苑多远」时，agent 只能
 * 靠模型知识猜，而它会：
 *   - 把地名当成它记忆里的坐标（常差好几公里）；
 *   - 或者拿旅行 POI 缓存里的城市中心点去算 —— 该缓存里「贵州兴义」的中心点
 *     曾经是脏数据（25.2613404，指向 23km 外的清水河镇），于是算出 20+ 公里。
 *
 * 这里补齐的是一条**权威且可校验**的链路：
 *   1. geo.place_search —— 高德 POI 检索（text/around），拿到真实地点的 GCJ-02 坐标；
 *   2. geo.distance     —— 两个坐标的 Haversine 距离 + 可选步行/驾车时长；
 *      两点坐标都来自高德（同一坐标系），距离不再受坐标系错配影响。
 *
 * 坐标系约定（全链路统一 GCJ-02）：
 *   - 高德 POI 检索返回 GCJ-02；
 *   - 客户端 GPS 上报是 WGS-84 → 本模块调用前统一 WGS84→GCJ02 转换后再比，
 *     避免「用户 WGS84 vs 地点 GCJ02」的 50~500m 错配；
 *   - 服务端已有一套 wgs84ToGcj02（reverse-geocode-service.ts），这里复用它，
 *     不重复实现（两套实现漂移过一次就是坐标系事故的温床）。
 */
import type { ChatCompletionTool } from "openai/resources/chat/completions";

import { wgs84ToGcj02 } from "../services/reverse-geocode-service.js";
import { haversineMeters } from "../services/geo-utils.js";
import type { ToolRegistry, ToolContext } from "./tool-registry.js";
import { resolveActorId } from "../agent/actor-id.js";

// ─── 高德 POI 检索 ──────────────────────────────────────────────────────

export type GeoPlaceResult = {
  name: string;
  address: string;
  latitude: number;
  longitude: number;
  type: string;
  distanceMeters?: number;
  city?: string;
};

/** 高德 POI 检索（text=关键词检索 / around=周边检索）。全部返回 GCJ-02。 */
async function amapPlaceSearch(params: {
  key: string;
  keywords?: string;
  city?: string;
  location?: { latitude: number; longitude: number };
  radiusMeters?: number;
  limit?: number;
}): Promise<GeoPlaceResult[]> {
  const isAround = params.location != null;
  const base = isAround
    ? "https://restapi.amap.com/v3/place/around"
    : "https://restapi.amap.com/v3/place/text";
  const q = new URLSearchParams({ key: params.key, output: "JSON", offset: String(params.limit ?? 10) });
  if (isAround) {
    q.set("location", `${params.location!.longitude},${params.location!.latitude}`);
    q.set("radius", String(Math.min(Math.max(params.radiusMeters ?? 1000, 100), 50_000)));
    q.set("types", "110000|120100|060100|010000|050000");
  } else {
    if (!params.keywords) return [];
    q.set("keywords", params.keywords);
    if (params.city) q.set("city", params.city);
    q.set("citylimit", "false");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const res = await fetch(`${base}?${q.toString()}`, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      status?: string;
      pois?: Array<{
        name?: string;
        address?: string | string[];
        location?: string;
        type?: string;
        cityname?: string;
        distance?: string | number;
      }>;
    };
    if (data.status !== "1" || !Array.isArray(data.pois)) return [];
    const out: GeoPlaceResult[] = [];
    for (const p of data.pois) {
      if (!p.location || !p.location.includes(",")) continue;
      const [lng, lat] = p.location.split(",").map(Number);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      const addr = Array.isArray(p.address) ? (p.address[0] ?? "") : (p.address ?? "");
      const dist = typeof p.distance === "number" ? p.distance : Number(p.distance);
      out.push({
        name: String(p.name ?? ""),
        address: String(addr),
        latitude: lat,
        longitude: lng,
        type: String(p.type ?? ""),
        city: p.cityname ? String(p.cityname) : undefined,
        distanceMeters: Number.isFinite(dist) ? dist : undefined,
      });
    }
    return out;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

// ─── 工具定义 ──────────────────────────────────────────────────────────

export const GEO_PLACE_SEARCH_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "geo.place_search",
    description:
      "按地名检索真实地点的经纬度与地址（高德 POI，GCJ-02 坐标）。" +
      "回答「XX 在哪」「XX 的地址是什么」时调用；" +
      "需要计算「我离 XX 多远」时，先用它拿到地点坐标，再调 geo.distance。" +
      "可传 city 限定城市（如「兴义」）以提升消歧精度。",
    parameters: {
      type: "object",
      properties: {
        keywords: { type: "string", description: "地点名或地址关键词，如「下五屯九华苑」「XX银行」" },
        city: { type: "string", description: "可选：限定城市名，提升同名地点的消歧精度（如「兴义」）" },
        limit: { type: "integer", description: "可选：返回条数（缺省 5，上限 20）" },
      },
      required: ["keywords"],
      additionalProperties: false,
    },
  },
};

export const GEO_DISTANCE_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "geo.distance",
    description:
      "计算两个地点之间的直线距离（米）与步行/驾车预估时长。" +
      "两个地点都用**地名**给出（如 from=「九华苑」、to=「兴义万峰林机场」），" +
      "或直接给 fromLatitude/fromLongitude 坐标。" +
      "回答「离 XX 多远」「XX 到 YY 多少公里」时调用。" +
      "注意：用户当前位置由系统自动提供，你不必传 from 坐标，除非用户明确给了别的起点。",
    parameters: {
      type: "object",
      properties: {
        from: { type: "string", description: "起点地名，如「下五屯九华苑」" },
        to: { type: "string", description: "终点地名，如「兴义万峰林机场」" },
        city: { type: "string", description: "可选：城市限定，用于地名消歧（如「兴义」）" },
        fromLatitude: { type: "number", description: "可选：起点纬度（WGS-84 或 GCJ-02 均可，模块内部统一）" },
        fromLongitude: { type: "number", description: "可选：起点经度" },
        toLatitude: { type: "number", description: "可选：终点纬度" },
        toLongitude: { type: "number", description: "可选：终点经度" },
      },
      additionalProperties: false,
    },
  },
};

export type GeoToolDeps = {
  /**
   * 最近一次已知位置（带龄期）。
   *
   * 按需实时位置走 ToolContext.requestLocation（框架已注入），这里只补
   * 「拿不到实时位置时的降级」这一路。传入 actorId 以便按用户隔离位置缓存。
   */
  getKnownLocation?: (actorId?: string) => {
    latitude: number;
    longitude: number;
    accuracyMeters?: number;
    label?: string;
    ageMs: number;
  } | null;
};

// ─── 工具实现 ──────────────────────────────────────────────────────────

function resolveAmapKey(): string {
  return (process.env.AMAP_WEB_KEY ?? "").trim();
}

/**
 * 把「WGS-84 或 GCJ-02 混用的坐标」统一到 GCJ-02。
 *
 * 现实里坐标来源太杂：客户端 GPS 是 WGS-84，高德 POI 是 GCJ-02，用户从地图
 * App 复制的可能是任一种。直接混比会有 50~500m 误差 —— 放在「几百米的距离」
 * 问题上就是错的答案。
 *
 * 判定策略：GCJ-02 与 WGS-84 的偏移在国内约 50~500m。换算成度数后
 * |Δlat| ≈ 0.0004~0.004、|Δlng| ≈ 0.0005~0.005。据此：
 *   - 偏移明显大于该量级 → 不是坐标系问题，是真实位置差，**不动**；
 *   - 偏移落在该量级内 → 判定为「其实是另一坐标系」，转换到 GCJ-02。
 * 落在边界上的情形仍可能误判，故所有对外结果都带上坐标来源标注。
 */
function toGcj02(
  lat: number,
  lng: number,
  source: "wgs84" | "gcj02" | "auto",
): { latitude: number; longitude: number; converted: boolean } {
  if (source === "gcj02") return { latitude: lat, longitude: lng, converted: false };
  if (source === "wgs84") {
    const g = wgs84ToGcj02(lat, lng);
    return { latitude: g.latitude, longitude: g.longitude, converted: true };
  }
  // auto：与 GCJ-02 自身的基准比较（用 WGS84 反算出的 GCJ-02 作参考）
  const asGcj = wgs84ToGcj02(lat, lng);
  const dLat = Math.abs(asGcj.latitude - lat);
  const dLng = Math.abs(asGcj.longitude - lng);
  const MIN = 0.0004; // ≈ 44m
  const MAX = 0.006; // ≈ 660m
  if (dLat > MIN && dLat < MAX && dLng > MIN && dLng < MAX) {
    // 偏移量级符合「坐标系错配」特征 → 判定输入其实是 WGS-84，转成 GCJ-02
    return { latitude: asGcj.latitude, longitude: asGcj.longitude, converted: true };
  }
  return { latitude: lat, longitude: lng, converted: false };
}

/** 步行速度 4.8 km/h；驾车按城市平均 24 km/h（含红绿灯与拥堵）。 */
const WALK_SPEED_MPS = 4.8 / 3.6;
const DRIVE_SPEED_MPS = 24 / 3.6;

export function registerGeoTools(registry: ToolRegistry, deps: GeoToolDeps = {}): void {
  // ── geo.place_search ────────────────────────────────────────────────
  registry.register("geo.place_search", async (input) => {
    const key = resolveAmapKey();
    if (!key) {
      return {
        ok: false,
        error: "地点检索未配置 AMAP_WEB_KEY，无法检索真实地点坐标",
      };
    }
    const keywords = String(input.keywords ?? "").trim();
    if (!keywords) return { ok: false, error: "缺少必填参数 keywords" };
    const city = String(input.city ?? "").trim();
    const limit = Math.min(20, Math.max(1, Number(input.limit) || 5));

    const places = await amapPlaceSearch({ key, keywords, city: city || undefined, limit });
    if (places.length === 0) {
      return {
        ok: false,
        error: `未找到与「${keywords}」匹配的地点${city ? `（城市：${city}）` : ""}`,
        hint: "可尝试加上城市名或更完整的地址重试；不要凭记忆猜坐标。",
      };
    }
    return {
      ok: true,
      query: keywords,
      city: city || undefined,
      count: places.length,
      coordSystem: "gcj02",
      places: places.map((p) => ({
        name: p.name,
        address: p.address,
        latitude: p.latitude,
        longitude: p.longitude,
        type: p.type,
        city: p.city,
      })),
    };
  });

  // ── geo.distance ────────────────────────────────────────────────────
  registry.register("geo.distance", async (input, context: ToolContext) => {
    const key = resolveAmapKey();
    if (!key) {
      return { ok: false, error: "距离计算未配置 AMAP_WEB_KEY，无法检索地点坐标" };
    }
    const city = String(input.city ?? "").trim();

    // ── 终点先解析（2026-11-13）：起终点都要查 POI 时，先把终点定下来。
    //    否则终点查无（用户地名写错）时报出来的却是「拿不到你的当前位置」，
    //    把错误指向了错误的环节 —— 用户会以为定位坏了。
    let toLat = Number(input.toLatitude);
    let toLng = Number(input.toLongitude);
    let toLabel = "终点（坐标）";
    let toAddress = "";
    const toNameRaw = String(input.to ?? "").trim();
    if (!Number.isFinite(toLat) || !Number.isFinite(toLng)) {
      if (!toNameRaw) {
        return { ok: false, error: "缺少终点：请提供 to 地名或 toLatitude/toLongitude" };
      }
      const toHits = await amapPlaceSearch({ key, keywords: toNameRaw, city: city || undefined, limit: 5 });
      if (toHits.length === 0) {
        return {
          ok: false,
          error: `未找到「${toNameRaw}」的坐标`,
          hint: "请给出更完整的地址，或加上城市名。",
        };
      }
      const toHit = toHits[0]!;
      toLat = toHit.latitude;
      toLng = toHit.longitude;
      toLabel = toHit.name;
      toAddress = toHit.address;
    }

    // ── 起点：优先用户给出的坐标 → 否则用系统提供的位置
    let fromLat = Number(input.fromLatitude);
    let fromLng = Number(input.fromLongitude);
    let fromLabel = "起点（坐标）";
    let fromAccuracy: number | undefined;
    let fromAgeMs: number | undefined;
    /** 起点坐标是否已是 GCJ-02（高德 POI 检索结果为真；用户直接给的坐标未知） */
    let fromIsGcj02 = false;

    const hasFromCoords = Number.isFinite(fromLat) && Number.isFinite(fromLng);
    if (!hasFromCoords) {
      const fromName = String(input.from ?? "").trim();
      if (fromName) {
        const hits = await amapPlaceSearch({ key, keywords: fromName, city: city || undefined, limit: 1 });
        if (hits.length === 0) {
          return { ok: false, error: `未找到起点「${fromName}」的坐标` };
        }
        fromLat = hits[0]!.latitude;
        fromLng = hits[0]!.longitude;
        fromLabel = hits[0]!.name;
        // 高德 POI 已是 GCJ-02：标记来源，避免后面再被当成 WGS-84 转一次
        fromIsGcj02 = true;
      } else {
        // 用户当前位置：优先实时请求，其次最近已知
        let known: {
          latitude: number;
          longitude: number;
          accuracyMeters?: number;
          label?: string;
          ageMs?: number;
        } | null = null;
        if (context.requestLocation) {
          try {
            // 「离我多远」的起点是此刻位置：旧缓存/粗 fix 会让距离偏差同量级，
            // 因此要求 2 分钟内且 ≤10m（2026-11-18 与客户端精度门槛对齐，
            // 此前 100m 会让「离我多远」直接偏差一个街区）。
            known = await context.requestLocation("geo.distance:计算到目标地点的距离", {
              maxAgeMs: 2 * 60_000,
              maxAccuracyMeters: 10,
            });
          } catch {
            known = null;
          }
        }
        if (!known && deps.getKnownLocation) {
          try {
            known = deps.getKnownLocation(resolveActorId(context));
          } catch {
            known = null;
          }
        }
        if (!known) {
          return {
            ok: false,
            error: "拿不到你的当前位置，也无法计算距离",
            hint: "请允许定位权限后重试，或在问题里带上起点地名。",
          };
        }
        fromLat = known.latitude;
        fromLng = known.longitude;
        fromLabel = known.label ?? "你的当前位置";
        fromAccuracy = known.accuracyMeters;
        fromAgeMs = known.ageMs;
      }
    }

    // ── 统一到 GCJ-02 再算距离（混比会有 50~500m 误差）
    const from = toGcj02(fromLat!, fromLng!, fromIsGcj02 ? "gcj02" : "auto");
    const to = toGcj02(toLat!, toLng!, "gcj02"); // 高德 POI 已是 GCJ-02
    const meters = haversineMeters(
      { latitude: from.latitude, longitude: from.longitude },
      { latitude: to.latitude, longitude: to.longitude },
    );

    return {
      ok: true,
      from: {
        name: fromLabel,
        latitude: Number(from.latitude.toFixed(6)),
        longitude: Number(from.longitude.toFixed(6)),
        accuracyMeters: fromAccuracy,
        ageMs: fromAgeMs,
      },
      to: {
        name: toLabel,
        address: toAddress,
        latitude: Number(to.latitude.toFixed(6)),
        longitude: Number(to.longitude.toFixed(6)),
      },
      distanceMeters: Math.round(meters),
      distanceKm: Number((meters / 1000).toFixed(2)),
      walkingMinutes: Math.round(meters / WALK_SPEED_MPS / 60),
      drivingMinutes: Math.round(meters / DRIVE_SPEED_MPS / 60),
      coordSystem: "gcj02",
      note:
        fromAccuracy != null && fromAccuracy > 100
          ? `定位精度约 ${Math.round(fromAccuracy)} 米，距离误差同量级，请如实说明`
          : undefined,
    };
  });
}

/** 供 LLM 侧汇总的内置 geo 工具定义。 */
export const GEO_CHAT_TOOLS: ChatCompletionTool[] = [
  GEO_PLACE_SEARCH_TOOL,
  GEO_DISTANCE_TOOL,
];

/** 工具元数据（供 tool-search 索引用）。 */
export const GEO_TOOL_METADATA = [
  {
    name: "geo.place_search",
    displayName: "检索地点坐标",
    description: "按地名检索真实地点的经纬度与地址（高德 POI）",
    tags: ["geo", "location", "place", "poi", "地理", "地点", "坐标"],
  },
  {
    name: "geo.distance",
    displayName: "计算地点距离",
    description: "计算两个地点之间的距离与步行/驾车时长",
    tags: ["geo", "location", "distance", "地理", "距离"],
  },
];
