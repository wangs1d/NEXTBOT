/**
 * 通用导航能力 · Provider 抽象层。
 *
 * 目标：手机端的通用导航底座——真实导航能力收敛在 NavigationProvider 接口之后，
 * 业务方（导航会话 / 旅游规划页面 / 后续任何需要导航的功能）只认接口，
 * 不感知具体地图厂商；换导航源 = 新增一个实现并注册，调用方零改动。
 *
 * 首版实现：高德 Web 导航（URI API，无需 Key / SDK，网页版逐向导航）。
 *   https://uri.amap.com/navigation?from={lng},{lat},{名称}&to={lng},{lat},{名称}
 *     &mode={car|bus|walk|ride}&policy=&src=&coordinate=gaode&callnative=0
 *   - callnative=0：固定走网页导航，不唤起高德 App（用户不在高德 App 里导航）
 *   - from 可省略：由导航源自行取当前位置（页面/浏览器已有定位能力）
 *   - 坐标只出现在导航 URI 参数里（工具入参），禁止透出到用户可见文案
 */

/** 导航目标点。lat/lng 为 GCJ-02（国内 POI 源即为高德坐标，免转换）。 */
export interface NavStopInput {
  name: string;
  lat: number;
  lng: number;
}

export type NavTravelMode = "driving" | "walking" | "transit" | "cycling";

export interface NavLegRequest {
  /** 起点；null → 由导航源自行定位（行程首段） */
  from: NavStopInput | null;
  to: NavStopInput;
  mode?: NavTravelMode;
}

export interface NavigationProvider {
  readonly id: string;
  readonly label: string;
  /** 构建一段「从 from 到 to」的真实导航链接 */
  buildLegUrl(req: NavLegRequest): string;
}

const AMAP_MODE: Record<NavTravelMode, string> = {
  driving: "car",
  walking: "walk",
  transit: "bus",
  cycling: "ride",
};

/** 坐标统一 6 位小数（高德 URI 精度上限），避免长浮点串进 URL */
function fmtCoord(v: number): string {
  return (Math.round(v * 1e6) / 1e6).toString();
}

/** 名称拼进 `lng,lat,名称` 三元组，逗号/换行必须清掉，限长防异常长名 */
function safeName(name: string): string {
  const cleaned = name
    .replace(/[,，\n\r]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40);
  return cleaned || "目的地";
}

/** 高德 Web 导航（URI API）实现 */
export const AMAP_WEB_NAV_ID = "amap-web";

export class AmapWebNavProvider implements NavigationProvider {
  readonly id = AMAP_WEB_NAV_ID;
  readonly label = "高德导航";

  buildLegUrl(req: NavLegRequest): string {
    const mode = AMAP_MODE[req.mode ?? "driving"] ?? "car";
    const parts: string[] = [];
    if (req.from) {
      parts.push(
        `from=${fmtCoord(req.from.lng)},${fmtCoord(req.from.lat)},${encodeURIComponent(safeName(req.from.name))}`,
      );
    }
    parts.push(
      `to=${fmtCoord(req.to.lng)},${fmtCoord(req.to.lat)},${encodeURIComponent(safeName(req.to.name))}`,
    );
    parts.push(`mode=${mode}`, "policy=", "src=Nextbot", "coordinate=gaode", "callnative=0");
    return `https://uri.amap.com/navigation?${parts.join("&")}`;
  }
}

/** 导航点（坐标必填：高德导航 URI 只认 `lng,lat,名称` 三元组） */
export interface NavUrlStop {
  name: string;
  /** GCJ-02 纬度 */
  lat: number;
  /** GCJ-02 经度 */
  lng: number;
}

/**
 * 构建高德 Web 导航 URI（真实路网逐向导航）。
 *
 * `to` 必须有坐标：高德对纯地名的 `to=名称` 会生成
 * `to[lnglat]=名称,undefined` 的坏链接（打不开路径页），所以目的地解析不到坐标时
 * 由调用方改用 buildAmapSearchUrl 兜底。
 * 起点缺省 = 高德路径页仍进入 /dir 路线页，起点留空由用户在页面上选择/定位。
 */
export function buildAmapNavigationUrl(input: {
  from?: NavUrlStop | null;
  to: NavUrlStop;
  mode?: NavTravelMode;
}): string {
  const mode = AMAP_MODE[input.mode ?? "driving"] ?? "car";
  const parts: string[] = [];
  if (input.from) {
    parts.push(
      `from=${fmtCoord(input.from.lng)},${fmtCoord(input.from.lat)},${encodeURIComponent(safeName(input.from.name))}`,
    );
  }
  parts.push(
    `to=${fmtCoord(input.to.lng)},${fmtCoord(input.to.lat)},${encodeURIComponent(safeName(input.to.name))}`,
  );
  parts.push(`mode=${mode}`, "policy=", "src=Nextbot", "coordinate=gaode", "callnative=0");
  return `https://uri.amap.com/navigation?${parts.join("&")}`;
}

/**
 * 高德搜索页（兜底）：目的地解析不到坐标时使用——链接仍可用，
 * 用户点开可在地图上选中目的地后自行开始导航，绝不返回坏掉的路网页。
 */
export function buildAmapSearchUrl(keyword: string): string {
  return `https://uri.amap.com/search?keyword=${encodeURIComponent(safeName(keyword))}&src=Nextbot&coordinate=gaode&callnative=0`;
}

const PROVIDERS: Record<string, NavigationProvider> = {
  [AMAP_WEB_NAV_ID]: new AmapWebNavProvider(),
};

export const DEFAULT_NAV_PROVIDER_ID = AMAP_WEB_NAV_ID;

/** 按 id 取导航源；未知 id 回落默认（高德），保证调用方永远拿到可用实现 */
export function getNavigationProvider(id?: string | null): NavigationProvider {
  if (id && PROVIDERS[id]) return PROVIDERS[id]!;
  return PROVIDERS[DEFAULT_NAV_PROVIDER_ID]!;
}

export function listNavigationProviders(): Array<{ id: string; label: string }> {
  return Object.values(PROVIDERS).map((p) => ({ id: p.id, label: p.label }));
}
