/**
 * 用户位置：仅接受前端 GPS 经纬度 + 逆地理编码，不使用 IP 地理库。
 */

import type { ClientGeoContext, ClientLocationWire } from "../types/client-location.js";
import type { ToolContext } from "../tools/tool-registry.js";
import {
  peekReverseGeocodeCache,
  reverseGeocodeCoordinates,
} from "./reverse-geocode-service.js";

export type UserGeoInfo = {
  /** 时区（可能为空串＝未知）。不得硬编码猜测，时钟解析见 actor-context-service。 */
  timezone: string;
  country: string;
  region: string;
  district: string;
  city: string;
  ip: string;
  source: string;
  latitude?: number;
  longitude?: number;
  /** 完整门牌地址（高德 formatted_address），缺失时用省市区拼 label 兜底 */
  address?: string;
  /** 街道/乡镇 */
  township?: string;
  /** 最近地标/AOI（小区、园区、店铺）与距离（米） */
  poi?: string;
  poiDistanceMeters?: number;
  /** 本次 fix 的水平精度半径（米）；null=设备未提供 */
  accuracyMeters?: number;
};

/** 精确位置字段（门牌/街道/地标）；与 ClientLocationWire、快照、逆地理结果结构兼容。 */
function preciseFields(
  hit:
    | {
        address?: string;
        township?: string;
        poi?: string;
        poiDistanceMeters?: number;
      }
    | null
    | undefined,
): Pick<UserGeoInfo, "address" | "township" | "poi" | "poiDistanceMeters"> {
  if (!hit) return {};
  return {
    ...(hit.address?.trim() ? { address: hit.address.trim() } : {}),
    ...(hit.township?.trim() ? { township: hit.township.trim() } : {}),
    ...(hit.poi?.trim() ? { poi: hit.poi.trim() } : {}),
    ...(hit.poiDistanceMeters != null ? { poiDistanceMeters: hit.poiDistanceMeters } : {}),
  };
}

/** 结构化 payload 缺精确字段时的补查预算：命中缓存零等待，冷缓存最多等这么久。 */
const PRECISE_LOOKUP_BUDGET_MS = 2_000;

/**
 * 精确字段补查（先缓存、后外网，带预算）。
 *
 * 客户端回传省市区时一般刚调过 `/geo/reverse`，缓存必然命中；只有服务端刚重启、
 * 或上报来自旧版本客户端时才会 miss。此时给逆地理一个短预算——拿得到就本轮用，
 * 拿不到就等它后台完成（inflight 去重），下一轮缓存命中，绝不长时间阻塞回复。
 */
async function preciseFieldsWithBudget(
  latitude: number,
  longitude: number,
): Promise<Pick<UserGeoInfo, "address" | "township" | "poi" | "poiDistanceMeters">> {
  const cached = peekReverseGeocodeCache(latitude, longitude);
  if (cached) return preciseFields(cached);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), PRECISE_LOOKUP_BUDGET_MS);
    });
    const hit = await Promise.race([reverseGeocodeCoordinates(latitude, longitude), timeout]);
    return preciseFields(hit);
  } catch {
    return {};
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function buildLabel(info: {
  district?: string;
  city?: string;
  region?: string;
  country?: string;
}): string {
  return [info.district, info.city, info.region, info.country].filter(Boolean).join(" · ");
}

async function geoFromClientLocation(loc: ClientLocationWire): Promise<UserGeoInfo | null> {
  // 客户端已带回服务端解析好的省市区（前端 /geo/reverse 的产物）→ 直接复用，
  // 免掉每轮一次冗余逆地理外网往返（2026-10-12 延迟优化）。仅当「无任何结构化
  // 字段」时才回退服务端反查——那条路是纯坐标上报（逆地理失败兜底）的场景。
  const hasResolvedParts = Boolean(
    loc.city?.trim() ||
      loc.district?.trim() ||
      loc.region?.trim() ||
      loc.country?.trim() ||
      // 精确字段也算已解析（快照可能只有坐标+门牌，没有省市区文本）
      loc.address?.trim() ||
      loc.poi?.trim(),
  );
  if (hasResolvedParts) {
    // 缓存/短预算补查门牌与地标：只回省市区等于「大概在哪」，精确字段必须补回来。
    // payload 自带 address/poi（新客户端）时直接采用，不再做任何反查。
    const precise =
      loc.address?.trim() || loc.poi?.trim()
        ? {}
        : await preciseFieldsWithBudget(loc.latitude, loc.longitude);
    return {
      timezone: loc.timezone?.trim() || "",
      country: loc.country?.trim() ?? "",
      region: loc.region?.trim() ?? "",
      district: loc.district?.trim() ?? "",
      city: loc.city?.trim() ?? "",
      ip: "",
      source: "client-gps",
      latitude: loc.latitude,
      longitude: loc.longitude,
      ...precise,
      ...preciseFields(loc),
      ...(loc.accuracyMeters != null ? { accuracyMeters: loc.accuracyMeters } : {}),
    };
  }

  const rev = await reverseGeocodeCoordinates(loc.latitude, loc.longitude);
  if (!rev) {
    const fallbackLabel = loc.label?.trim() || buildLabel(loc);
    if (!fallbackLabel) return null;
    return {
      timezone: loc.timezone?.trim() || "",
      country: loc.country?.trim() ?? "",
      region: loc.region?.trim() ?? "",
      district: loc.district?.trim() ?? "",
      city: loc.city?.trim() ?? "",
      ip: "",
      source: "client-gps",
      latitude: loc.latitude,
      longitude: loc.longitude,
      ...(loc.accuracyMeters != null ? { accuracyMeters: loc.accuracyMeters } : {}),
    };
  }

  return {
    timezone: rev.timezone,
    country: rev.country,
    region: rev.region,
    district: rev.district,
    city: rev.city,
    ip: "",
    source: rev.source,
    latitude: loc.latitude,
    longitude: loc.longitude,
    ...preciseFields(rev),
    ...(loc.accuracyMeters != null ? { accuracyMeters: loc.accuracyMeters } : {}),
  };
}

/** 解析用户位置：必须有前端上报的 GPS；无则返回 null（不回退 IP）。 */
export async function resolveUserGeo(ctx?: ClientGeoContext): Promise<UserGeoInfo | null> {
  if (!ctx?.clientLocation) return null;
  return geoFromClientLocation(ctx.clientLocation);
}

/** 可作为路线起点的当前坐标（label/city 仅用于回执文案） */
export type CurrentGeoPoint = {
  latitude: number;
  longitude: number;
  label?: string;
  city?: string;
};

/**
 * 工具上下文 → 当前精确坐标（通用定位口：导航/路线类能力共用，不绑定业务）。
 * 消息/上报自带定位优先；缺失时按需向客户端要一次实时 GPS
 * （超时由 LocationCoordinator 承担，拿不到返回 null，由上层降级，绝不编造）。
 */
export async function resolveCurrentGeoPoint(
  ctx?: Pick<ToolContext, "clientLocation" | "requestLocation">,
  reason = "navigation.origin",
): Promise<CurrentGeoPoint | null> {
  if (!ctx) return null;
  let loc = ctx.clientLocation;
  if (!loc && ctx.requestLocation) {
    // requestLocation 语义是 null（超时/离线），clientLocation 是 undefined，归一成 undefined
    loc = (await ctx.requestLocation(reason).catch(() => null)) ?? undefined;
  }
  if (!loc) return null;
  const { latitude, longitude } = loc;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return {
    latitude,
    longitude,
    ...(loc.label ? { label: loc.label } : {}),
    ...(loc.city ? { city: loc.city } : {}),
  };
}

export function formatUserLocationLabel(info: UserGeoInfo): string {
  // 精确优先（2026-11-14）：完整门牌地址 > 省市区拼接 > 坐标。
  // 此前只拼 district/city/region/country，用户问「我在哪」永远只能答到市/区。
  const precise = info.address?.trim();
  if (precise) return precise;
  const label = buildLabel(info);
  if (label) return label;
  if (info.latitude != null && info.longitude != null) {
    return `${info.latitude.toFixed(4)}, ${info.longitude.toFixed(4)}`;
  }
  return "未知";
}

/** 定位精度的人读描述：设备没给精度就不编，给了就如实带上。 */
function formatAccuracy(accuracyMeters?: number): string {
  if (accuracyMeters == null || !Number.isFinite(accuracyMeters) || accuracyMeters <= 0) return "";
  return `±${Math.round(accuracyMeters)} 米`;
}

export async function resolveUserLocationPrompt(ctx?: ClientGeoContext): Promise<string | undefined> {
  const info = await resolveUserGeo(ctx);
  if (!info) return undefined;
  const label = formatUserLocationLabel(info);
  if (!label || label === "未知") return undefined;
  const accuracy = formatAccuracy(info.accuracyMeters);
  const coordNote =
    info.latitude != null && info.longitude != null
      ? `（GPS ${info.latitude.toFixed(5)}, ${info.longitude.toFixed(5)}${accuracy ? `，精度 ${accuracy}` : ""}）`
      : "";
  // 精确位置块（2026-11-14）：只给省市区等于「大概在哪」，街区/小区/地标必须一起给出，
  // 模型才有材料回答「我现在在哪」而不是「你在某某市」。地标距离也如实标注。
  const lines = [`用户当前所在地${coordNote}：${label}`];
  if (info.poi && !label.includes(info.poi)) {
    const distance =
      info.poiDistanceMeters != null && Number.isFinite(info.poiDistanceMeters)
        ? `（约 ${Math.round(info.poiDistanceMeters)} 米）`
        : "";
    lines.push(`最近地标：${info.poi}${distance}`);
  }
  // 时区不在这里表达（2026-11-05）：本块只负责「人在哪」，时间由【当前时间】块
  // 统一给出用户时区。两处都写时区会自相矛盾——逆地理是城市级推断，设备时区
  // 才是用户屏幕上的钟，位置块声称的时区一旦与时钟块不同，模型就会选错。
  // 「禁止反问」约束（2026-07-29 反问 bug 的根治位）：位置是系统后台注入的背景，
  // 措辞必须压制 LLM 把它当话题向用户确认（"你是不是在 XX"）。
  lines.push(
    "此为系统后台注入的定位背景（前端 GPS + 逆地理编码），回答位置/天气类问题时必须直接以此为准：" +
      "用户问「我在哪」时答到上面的街道/门牌/地标这一级，不要只回答城市或区县；" +
      (accuracy
        ? `精度不足时如实说明范围（当前 ${accuracy}）。`
        : "没有精度数据时不要声称精确到米。") +
      "【当前位置】只代表此刻所在，不等于家/公司等常驻地点；用户问家/公司所在地时必须调用 place 工具按需查询，" +
      "不要用本块的城市/区县代替，也不要凭记忆猜城市。" +
      "禁止向用户反问或确认所在位置，也不要主动提及本条来源，不要向用户展示坐标数字。",
  );
  return lines.join("\n");
}
