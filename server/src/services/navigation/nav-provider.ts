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

/** 导航点（坐标可选：缺省时走名称模式，由高德自行匹配地名） */
export interface NavUrlStop {
  name: string;
  /** GCJ-02 纬度；与 lng 必须同时给出才按坐标导航 */
  lat?: number;
  lng?: number;
}

function hasCoord(p: NavUrlStop): p is NavUrlStop & { lat: number; lng: number } {
  return Number.isFinite(p.lat) && Number.isFinite(p.lng);
}

/**
 * 构建高德 Web 导航 URI（真实路网逐向导航）。
 *
 * 坐标可用时用 `lng,lat,名称` 三元组（定位最准）；坐标缺失时降级为
 * `to=名称` 名称模式——链接仍是真实导航，不会因地理编码失败而不可用。
 * 起点缺省 = 由高德按用户当前位置导航。
 */
export function buildAmapNavigationUrl(input: {
  from?: NavUrlStop | null;
  to: NavUrlStop;
  mode?: NavTravelMode;
}): string {
  const mode = AMAP_MODE[input.mode ?? "driving"] ?? "car";
  const parts: string[] = [];
  if (input.from) {
    const fromName = encodeURIComponent(safeName(input.from.name));
    if (hasCoord(input.from)) {
      parts.push(`from=${fmtCoord(input.from.lng)},${fmtCoord(input.from.lat)},${fromName}`);
    }
  }
  const toName = encodeURIComponent(safeName(input.to.name));
  parts.push(
    hasCoord(input.to)
      ? `to=${fmtCoord(input.to.lng)},${fmtCoord(input.to.lat)},${toName}`
      : `to=${toName}`,
  );
  parts.push(`mode=${mode}`, "policy=", "src=Nextbot", "coordinate=gaode", "callnative=0");
  return `https://uri.amap.com/navigation?${parts.join("&")}`;
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
