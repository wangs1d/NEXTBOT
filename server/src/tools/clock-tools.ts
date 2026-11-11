/**

 * 时钟工具：获取当前时间和日期信息

 * 优先使用前端 GPS 定位，结合本地时间提供准确的时间信息

 */



import {

  formatUserLocationLabel,

  resolveUserGeo,

  type UserGeoInfo,

} from "../services/user-location-service.js";

import type { ToolRegistry } from "./tool-registry.js";





async function geoCtx(context: {
  clientIp?: string;
  clientLocation?: import("../types/client-location.js").ClientLocationWire;
  requestLocation?: () => Promise<import("../types/client-location.js").ClientLocationWire | null>;
}) {

  // 客户端已不随聊天消息携带 GPS（省电设计）：没有自带位置时改走按需实时定位
  // （LocationCoordinator 新鲜缓存优先，否则向客户端下发 agent.location_request），
  // 否则本工具对 clientLocation 的依赖在真实链路里永远落空。
  if (context.clientLocation) {

    return {

      clientIp: context.clientIp,

      clientLocation: context.clientLocation,

    };

  }

  const live = await context.requestLocation?.();

  if (live) {

    return {

      clientIp: context.clientIp,

      clientLocation: live,

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



function buildLocationToolResult(info: UserGeoInfo): Record<string, unknown> {

  const label = locationField(info);

  // 坐标仅供 LLM 结构化使用（下游工具入参），禁止写进面向用户的文本——
  // 2026-10-08 用户明确要求：经纬度数字任何时候都不出现在回复里。
  const sourceHint = info.source === "client-gps" || info.source === "bigdatacloud" || info.source === "amap"
    ? "GPS 定位"
    : "设备定位";

  return {

    ok: true,

    city: info.city,

    region: info.region,

    country: info.country,

    timezone: info.timezone,

    location: label,

    latitude: info.latitude,

    longitude: info.longitude,

    geoSource: info.source,

    message: label

      ? `根据${sourceHint}，用户当前位于：${label}${info.timezone ? `（时区 ${info.timezone}）` : ""}。经纬度仅供工具调用入参，禁止向用户展示坐标数字。`

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

    const userInfo = await resolveUserGeo(await geoCtx(context));

    // 坐标在手就不算失败（2026-10-08 定位修复）：逆地理抖动（AMAP key 未配/
    // bigdatacloud 被墙）只影响城市名展示，不影响"用户在哪"这个事实。
    // 旧逻辑 !city && !region 直接报"请开启定位权限"，把拿到 GPS 坐标的轮次
    // 教成 LLM 反问用户城市/使用记忆旧城市——"得不到真实定位"的服务端病灶。
    if (!userInfo || (userInfo.latitude == null && !userInfo.city && !userInfo.region)) {

      return noLocationError();

    }

    return buildLocationToolResult(userInfo);

  });
}
