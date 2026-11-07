/**
 * 用户位置：仅接受前端 GPS 经纬度 + 逆地理编码，不使用 IP 地理库。
 */

import type { ClientGeoContext, ClientLocationWire } from "../types/client-location.js";
import { reverseGeocodeCoordinates } from "./reverse-geocode-service.js";

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
};

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
    loc.city?.trim() || loc.district?.trim() || loc.region?.trim() || loc.country?.trim(),
  );
  if (hasResolvedParts) {
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
  };
}

/** 解析用户位置：必须有前端上报的 GPS；无则返回 null（不回退 IP）。 */
export async function resolveUserGeo(ctx?: ClientGeoContext): Promise<UserGeoInfo | null> {
  if (!ctx?.clientLocation) return null;
  return geoFromClientLocation(ctx.clientLocation);
}

export function formatUserLocationLabel(info: UserGeoInfo): string {
  const label = buildLabel(info);
  if (label) return label;
  if (info.latitude != null && info.longitude != null) {
    return `${info.latitude.toFixed(4)}, ${info.longitude.toFixed(4)}`;
  }
  return "未知";
}

export async function resolveUserLocationPrompt(ctx?: ClientGeoContext): Promise<string | undefined> {
  const info = await resolveUserGeo(ctx);
  if (!info) return undefined;
  const label = formatUserLocationLabel(info);
  if (!label || label === "未知") return undefined;
  const coordNote =
    info.latitude != null && info.longitude != null
      ? `（GPS ${info.latitude.toFixed(4)}, ${info.longitude.toFixed(4)}）`
      : "";
  // 时区不在这里表达（2026-11-05）：本块只负责「人在哪」，时间由【当前时间】块
  // 统一给出用户时区。两处都写时区会自相矛盾——逆地理是城市级推断，设备时区
  // 才是用户屏幕上的钟，位置块声称的时区一旦与时钟块不同，模型就会选错。
  // 「禁止反问」约束（2026-07-29 反问 bug 的根治位）：位置是系统后台注入的背景，
  // 措辞必须压制 LLM 把它当话题向用户确认（"你是不是在 XX"）。
  return `用户当前所在地${coordNote}：${label}。此为系统后台注入的定位背景（前端 GPS + 逆地理编码），回答位置/天气类问题时必须直接以此为准，禁止向用户反问或确认所在位置，也不要主动提及本条来源。`;
}
