/**
 * 旅游出发地解析（2026-10-26）
 *
 * 背景：旅游两条链路（主聊天 travel.plan-itinerary / 旅游界面 plan-session）在
 * 用户没说出发地时都会反问「从哪个城市出发」，而系统其实已经持有用户实时定位
 * （LocationCoordinator GPS + 逆地理）。本模块把定位收敛成「可作为出发地的城市名」：
 *   - 兴义市（黔西南自治州下辖）→ 兴义，而不是州名「黔西南布依族苗族自治州」
 *   - 直辖市（amap city 字段缺失/落到区）→ 北京 / 上海 / 天津 / 重庆
 *   - 普通地级市 → 去「市」后缀（杭州市 → 杭州）
 *
 * 另提供无直飞时的转机枢纽候选：省会优先（按出发地省分映射），再补常见国际
 * 枢纽，供 travel-live-pricing 做两段真实查价（查不到价绝不编造）。
 */

import type { ClientLocationWire } from "../../types/client-location.js";
import type { ToolContext } from "../../tools/tool-registry.js";
import { resolveUserGeo } from "../../services/user-location-service.js";

/** 可作为出发地的定位结果（region 为省级行政区全名，供转机枢纽映射） */
export type LocatedOrigin = { city: string; region: string };

const MUNICIPALITIES = ["北京", "上海", "天津", "重庆"] as const;

/** 省级行政区短名 → 省会/首府（转机枢纽的第一候选） */
const PROVINCE_CAPITALS: Record<string, string> = {
  河北: "石家庄",
  山西: "太原",
  辽宁: "沈阳",
  吉林: "长春",
  黑龙江: "哈尔滨",
  江苏: "南京",
  浙江: "杭州",
  安徽: "合肥",
  福建: "福州",
  江西: "南昌",
  山东: "济南",
  河南: "郑州",
  湖北: "武汉",
  湖南: "长沙",
  广东: "广州",
  海南: "海口",
  四川: "成都",
  贵州: "贵阳",
  云南: "昆明",
  陕西: "西安",
  甘肃: "兰州",
  青海: "西宁",
  台湾: "台北",
  内蒙古: "呼和浩特",
  广西: "南宁",
  西藏: "拉萨",
  宁夏: "银川",
  新疆: "乌鲁木齐",
};

/** 无直飞时的通用枢纽顺序：国际航线主要口岸优先，省会未命中时兜底 */
const DEFAULT_HUBS = ["广州", "上海", "昆明", "成都", "西安", "深圳"] as const;

/**
 * 逆地理的省市区 → 可作出发地的城市名。
 * amap 对州/盟下辖的县级市会把 city 填成自治州全名（兴义 → 黔西南布依族苗族自治州），
 * 此时应取区县（兴义市 → 兴义）；直辖市 city 字段常缺省落到区县，直接取 region。
 */
export function deriveOriginCityName(geo: {
  city?: string;
  district?: string;
  region?: string;
}): string {
  const region = (geo.region ?? "").trim();
  const city = (geo.city ?? "").trim();
  const district = (geo.district ?? "").trim();

  const municipality = MUNICIPALITIES.find((m) => region.startsWith(m));
  if (municipality) return municipality;
  if (region.startsWith("香港")) return "香港";
  if (region.startsWith("澳门")) return "澳门";

  const prefectureLike = /(自治州|地区|盟)$/;
  let name = city;
  if (!name || prefectureLike.test(name)) name = district || name;
  name = name.replace(/市$/, "").trim();
  if (name) return name;

  // 兜底：省名去后缀（航班查询大概率失配，上层按查不到如实降级）
  return region
    .replace(/(特别行政区|维吾尔自治区|壮族自治区|回族自治区|自治区|省|市)$/g, "")
    .trim();
}

/** 单次定位载荷 → 出发地（逆地理走服务端缓存，命中时零网络） */
export async function resolveOriginFromLocation(
  loc: ClientLocationWire,
): Promise<LocatedOrigin | null> {
  const geo = await resolveUserGeo({ clientLocation: loc });
  if (!geo) return null;
  const city = deriveOriginCityName(geo);
  if (!city) return null;
  return { city, region: (geo.region ?? "").trim() };
}

/**
 * 工具上下文 → 出发地：优先消息/上报自带定位，缺失时按需向客户端要一次实时 GPS
 * （12s 超时由 LocationCoordinator 承担，拿不到返回 null，上层维持反问兜底）。
 */
export async function resolveOriginFromContext(
  ctx?: Pick<ToolContext, "clientLocation" | "requestLocation">,
): Promise<LocatedOrigin | null> {
  if (!ctx) return null;
  let loc = ctx.clientLocation;
  if (!loc && ctx.requestLocation) {
    // requestLocation 语义是 null（超时/离线），clientLocation 是 undefined，归一成 undefined
    loc = (await ctx.requestLocation("travel.origin").catch(() => null)) ?? undefined;
  }
  if (!loc) return null;
  return resolveOriginFromLocation(loc);
}

/** 转机枢纽候选：省会优先，再补通用枢纽；去 origin 本身，截前 max 个 */
export function transferHubCandidates(origin: string, originRegion?: string, max = 3): string[] {
  const originName = origin.trim();
  const out: string[] = [];
  const push = (hub?: string): void => {
    const name = (hub ?? "").trim();
    if (!name || name === originName || out.includes(name)) return;
    out.push(name);
  };
  const regionKey = (originRegion ?? "")
    .replace(/(特别行政区|维吾尔自治区|壮族自治区|回族自治区|自治区|省|市)$/g, "")
    .trim();
  push(PROVINCE_CAPITALS[regionKey]);
  for (const hub of DEFAULT_HUBS) push(hub);
  return out.slice(0, max);
}
