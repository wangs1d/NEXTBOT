/**

 * 时钟工具：获取当前时间和日期信息

 * 优先使用前端 GPS 定位，结合本地时间提供准确的时间信息

 */



import {

  formatUserLocationLabel,

  resolveUserGeo,

  type UserGeoInfo,

} from "../services/user-location-service.js";

import type { KnownLocation, ToolRegistry } from "./tool-registry.js";





async function geoCtx(context: {
  clientIp?: string;
  clientLocation?: import("../types/client-location.js").ClientLocationWire;
  requestLocation?: (
    reason?: string,
    opts?: { maxAgeMs?: number; maxAccuracyMeters?: number },
  ) => Promise<import("../types/client-location.js").ClientLocationWire | null>;
  /** 最近已知位置（内存缓存 → 落盘历史），带 ageMs 标龄期 */
  getLastKnownLocation?: () => KnownLocation | null;
}): Promise<{
  clientIp?: string;
  clientLocation?: import("../types/client-location.js").ClientLocationWire;
  /** 兜底坐标龄期（毫秒）；>0 时结果 message 必须如实标注非实时 */
  knownAgeMs?: number;
}> {
  // 客户端已不随聊天消息携带 GPS（省电设计）：没有自带位置时改走按需实时定位
  // （LocationCoordinator 新鲜缓存优先，否则向客户端下发 agent.location_request），
  // 否则本工具对 clientLocation 的依赖在真实链路里永远落空。
  if (context.clientLocation) {
    return {
      clientIp: context.clientIp,
      clientLocation: context.clientLocation,
    };
  }

  // 「我在哪」必须回答此刻的位置：15 分钟复用窗口里的旧坐标、或 10m 以上的
  // 粗 fix（后台常驻上报常见）都不能直接拿来答，不达标就现场拉一次 GPS。
  // 2026-11-18：门槛与客户端 10m 对齐（此前 50m，街区尺度仍会答错门牌）。
  const live = await context.requestLocation?.("clock.get_user_location:当前精确位置", {
    maxAgeMs: 60_000,
    maxAccuracyMeters: 10,
  });

  if (live) {
    return {
      clientIp: context.clientIp,
      clientLocation: live,
    };
  }

  // 兜底（2026-11-19「看不见位置」根修）：实时拉不到 ≠ 没有位置。室内无 fix、
  // 定位超时、客户端按需回包失败都属常态——此时回落最近已知位置（内存缓存 →
  // 落盘历史），带龄期如实标注。答「几分钟前的位置」远好于报错让 Agent 说「看不见」。
  const known = context.getLastKnownLocation?.();
  if (known && Number.isFinite(known.latitude) && Number.isFinite(known.longitude)) {
    return {
      clientIp: context.clientIp,
      clientLocation: {
        latitude: known.latitude,
        longitude: known.longitude,
        ...(known.accuracyMeters != null ? { accuracyMeters: known.accuracyMeters } : {}),
      },
      knownAgeMs: known.ageMs,
    };
  }

  return { clientIp: context.clientIp };
}



function formatTimeInTimezone(

  date: Date,

  timezone: string,

  includeSeconds = true,

): string {

  const options: Intl.DateTimeFormatOptions = {

    timeZone: timezone,

    year: "numeric",

    month: "2-digit",

    day: "2-digit",

    hour: "2-digit",

    minute: "2-digit",

    hour12: false,

  };



  if (includeSeconds) {

    options.second = "2-digit";

  }



  return date.toLocaleString("zh-CN", options);

}



function getWeekdayInTimezone(date: Date, timezone: string): string {

  return date.toLocaleString("zh-CN", {

    timeZone: timezone,

    weekday: "long",

  });

}



function locationField(info: UserGeoInfo): string {

  return formatUserLocationLabel(info);

}

/** 位置龄期标注（与 weather-tools 同款措辞）：仅回落到「最近已知位置」时出现。 */
function locationAgeNote(ageMs: number | null): string {
  if (ageMs == null) return "";
  const min = Math.max(1, Math.round(ageMs / 60_000));
  return min < 60 ? `约 ${min} 分钟前的定位` : `约 ${(min / 60).toFixed(1)} 小时前的定位`;
}



function buildLocationToolResult(info: UserGeoInfo, knownAgeMs?: number): Record<string, unknown> {

  const label = locationField(info);

  // 兜底坐标（knownAgeMs>0）必须如实标龄期，禁止把旧定位说成此刻实时位置——
  // 数据旧可以兜底，措辞不能骗人（用户抱怨「老是用之前的数据」的措辞半边）。
  const ageNote =
    knownAgeMs != null && knownAgeMs > 0
      ? `此为最近已知位置（${locationAgeNote(knownAgeMs)}，非实时），转述时必须带上时间，不得说成此刻实时位置。`
      : "";

  // 坐标仅供 LLM 结构化使用（下游工具入参），禁止写进面向用户的文本——
  // 2026-10-08 用户明确要求：经纬度数字任何时候都不出现在回复里。
  const sourceHint = info.source === "client-gps" || info.source === "bigdatacloud" || info.source === "amap"
    ? "GPS 定位"
    : "设备定位";

  return {

    ok: true,

    city: info.city,

    district: info.district,

    region: info.region,

    country: info.country,

    // 精确位置字段（2026-11-14）：只给 city/region 时模型只能答到行政区，
    // 用户问「我现在在哪」永远停在城市级。address/township/poi 是高德逆地理
    // 给出的门牌与最近地标，原样透出供模型作答（坐标仍禁止展示）。
    ...(info.address ? { address: info.address } : {}),

    ...(info.township ? { township: info.township } : {}),

    ...(info.poi ? { poi: info.poi } : {}),

    ...(info.poiDistanceMeters != null ? { poiDistanceMeters: info.poiDistanceMeters } : {}),

    ...(info.accuracyMeters != null ? { accuracyMeters: info.accuracyMeters } : {}),

    timezone: info.timezone,

    location: label,

    latitude: info.latitude,

    longitude: info.longitude,

    geoSource: info.source,

    message: label

      ? `${ageNote}根据${sourceHint}，用户当前位于：${label}` +
        (info.poi && !label.includes(info.poi)
          ? `，最近地标：${info.poi}${info.poiDistanceMeters != null ? `（约 ${Math.round(info.poiDistanceMeters)} 米）` : ""}`
          : "") +
        `${info.timezone ? `（时区 ${info.timezone}）` : ""}。` +
        "用户问「我在哪」时应按 address/location 答到街道/门牌/地标这一级，不要只回答城市或区县；" +
        "本结果只代表此刻位置，不代表家/公司；用户问家/公司在哪个城市时调用 place 工具按需查询，不要用本结果的城市顶替。" +
        "经纬度仅供工具调用入参，禁止向用户展示坐标数字。"

      : `${sourceHint}成功，但城市名解析暂不可用。lat/lon 字段可直接作为天气等工具的入参；禁止向用户展示坐标数字、禁止因缺城市名反问用户所在城市。`,

  };

}



function noLocationError(): Record<string, unknown> {

  return {

    ok: false,

    error: "无法获取您的位置。请在 App/浏览器中开启定位权限，以便识别您所在的城市。",

  };

}



export function registerClockTools(toolRegistry: ToolRegistry): void {

  toolRegistry.register("clock.get_user_location", async (_input, context) => {

    const geo = await geoCtx(context);

    const userInfo = await resolveUserGeo(geo);

    // 坐标在手就不算失败（2026-10-08 定位修复）：逆地理抖动（AMAP key 未配/
    // bigdatacloud 被墙）只影响城市名展示，不影响"用户在哪"这个事实。
    // 旧逻辑 !city && !region 直接报"请开启定位权限"，把拿到 GPS 坐标的轮次
    // 教成 LLM 反问用户城市/使用记忆旧城市——"得不到真实定位"的服务端病灶。
    if (!userInfo || (userInfo.latitude == null && !userInfo.city && !userInfo.region)) {

      return noLocationError();

    }

    return buildLocationToolResult(userInfo, geo.knownAgeMs);

  });
}
