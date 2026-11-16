/**
 * 内置 Skill：通用真实导航（navigation.navigate）
 *
 * 定位：导航是**通用能力**，不属于旅游业务——日常通勤、找店、赴约、旅游行程里的
 * 「导航去 XX」都是同一个诉求。因此本模块放在 services/navigation 下，注册在
 * 版本闸（isOssEdition 剔除 travel.*）之外，任何场景（含旅游规划）都复用同一实现。
 *
 * 能力：在对话内以**导航卡**展示真实路线（内置地图 + 起终点 + 距离/耗时），
 * 不打开浏览器、不返回外链。
 *   - 配了 AMAP_WEB_KEY 时先用高德把起点/目的地解析成精确坐标并取路径几何；
 *   - 起点省略 = 用户实时定位；定位也拿不到 = 卡片只展示目的地名称；
 *   - 公交/骑行不虚报驾车时长（高德估时只支持驾车/步行）。
 *
 * 依赖通过 deps 注入（定位、路线兜底），避免通用能力反向依赖旅游模块。
 */

import type { SkillDefinition } from "../../skills/types.js";
import type { ToolContext } from "../../tools/tool-registry.js";
import { resolveCurrentGeoPoint } from "../user-location-service.js";
import { estimateTravelTime, amapGeocode, type GeoPoint } from "../route-duration-service.js";
import { gcj02ToWgs84 } from "../reverse-geocode-service.js";
import { navigationCardStore } from "./navigation-card-store.js";
import type { NavTravelMode } from "./nav-provider.js";

/** 可作为导航起点的定位点（label/city 仅用于回执文案） */
export type NavigationOriginPoint = {
  latitude: number;
  longitude: number;
  label?: string;
  city?: string;
};

export type NavigationSkillDeps = {
  /**
   * 取用户当前精确坐标：优先消息自带定位，缺失时按需向客户端要一次实时 GPS。
   * 不注入 = 使用通用定位口 resolveCurrentGeoPoint（拿不到返回 null）。
   */
  resolveOriginPoint?: (
    ctx?: Pick<ToolContext, "clientLocation" | "requestLocation">,
  ) => Promise<NavigationOriginPoint | null>;
  /** 高德不可用时的路线兜底（通常为 OSRM）；不注入则不做兜底 */
  routeFallback?: (
    from: GeoPoint | string,
    to: string,
  ) => Promise<{ durationMin: number; distanceKm: number } | null>;
};

/** 「经度,纬度」坐标串 → {lng, lat}；不是坐标串返回 null */
function parseCoordText(text: string): { lng: number; lat: number } | null {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(text);
  if (!m) return null;
  const lng = Number(m[1]);
  const lat = Number(m[2]);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  return { lng, lat };
}

/** 高德地理编码返回的「经度,纬度」→ GeoPoint */
function parseLngLat(raw: string): GeoPoint | null {
  const p = parseCoordText(raw);
  return p ? { latitude: p.lat, longitude: p.lng } : null;
}

export function createNavigationBuiltinSkills(
  register: (skill: SkillDefinition) => void,
  deps: NavigationSkillDeps = {},
): void {
  const resolveOriginPoint = deps.resolveOriginPoint ?? resolveCurrentGeoPoint;

  const navigate: SkillDefinition = {
    metadata: {
      name: "navigation.navigate",
      version: "1.0.0",
      displayName: "真实路径导航（高德）",
      description:
        "在对话内展示真实路线的导航卡（内置地图 + 起终点 + 距离/耗时），不是网页搜索、不是只算距离、也不打开浏览器。" +
        "日常出行与旅游规划通用：通勤、赴约、找店、景点之间移动都可用。" +
        "配了 AMAP_WEB_KEY 时先用高德把目的地/起点解析成精确坐标并取真实路径。" +
        "适用表达：「导航去XX」「带我去XX」「开车/走路/坐公交怎么去XX」「从A导航到B」「给我开个导航」。" +
        "起点可省略=按用户实时定位；用户没说从哪出发时别反问，直接调用。" +
        "边界：只问距离/耗时（不要求看导航）用路线耗时工具；叫车报价用 ride_hailing.quote；" +
        "浏览器里打开网页用 agent_browser/shared_browser，不要拿本工具当网页导航。",
      kind: "builtin",
      tags: ["navigation", "导航", "路线", "驾车", "步行", "公交", "骑行", "地图", "高德", "amap"],
      icon: "🧭",
      parameters: [
        {
          name: "to",
          type: "string",
          required: true,
          description: "导航目的地：地名（尽量带城市/地标，如「首都机场T3」「杭州西湖」）或坐标串「经度,纬度」",
        },
        {
          name: "from",
          type: "string",
          required: false,
          description: "起点：地名或坐标串「经度,纬度」。省略=按用户实时定位（拿不到定位时由高德按用户当前位置导航）",
        },
        {
          name: "mode",
          type: "string",
          required: false,
          enum: ["driving", "walking", "transit", "cycling"],
          description: "交通方式：driving=驾车（默认）/ walking=步行 / transit=公交 / cycling=骑行",
        },
      ],
      outputSchema: {
        ok: "是否成功",
        from: "起点名称（省略时为「当前位置」）",
        to: "目的地名称",
        mode: "交通方式",
        durationMin: "预计耗时（分钟；高德实时成功时给出）",
        distanceKm: "距离（公里；高德实时成功时给出）",
        navigationCardId: "导航卡数据 ID（服务端建卡用，不要向用户展示）",
        displayNote: "展示提示",
        error: "失败原因（ok=false 时）",
      },
      permissions: ["network:external"],
      timeoutMs: 20_000,
    },
    handler: async (input, execContext) => {
      const toRaw = typeof input.to === "string" ? input.to.trim() : "";
      if (!toRaw) return { ok: false, error: "缺少必填参数 to（目的地）" };
      const fromRaw = typeof input.from === "string" ? input.from.trim() : "";
      const mode = (
        ["driving", "walking", "transit", "cycling"].includes(String(input.mode))
          ? String(input.mode)
          : "driving"
      ) as NavTravelMode;

      // 坐标串不进用户可见文案（经纬度禁令）；坐标只进卡片载荷。
      const toCoord = parseCoordText(toRaw);
      const toLabel = toCoord ? "目的地" : toRaw;

      // 起点：给定优先；省略取实时定位；都拿不到 → 卡片只有终点。
      let origin: string | GeoPoint | null = null;
      let fromCoord: { lng: number; lat: number } | null = null;
      let fromLabel = "当前位置";
      if (fromRaw) {
        // 坐标串原样交给 estimateTravelTime（它按 GCJ-02 解读，二次转换会偏移）
        fromCoord = parseCoordText(fromRaw);
        origin = fromRaw;
        fromLabel = fromCoord ? "指定起点" : fromRaw;
      } else {
        const point = await resolveOriginPoint(execContext).catch(() => null);
        if (point) {
          origin = { latitude: point.latitude, longitude: point.longitude };
          fromLabel = point.label || point.city || "当前位置";
        }
      }

      let fromPoint: GeoPoint | null = fromCoord
        ? { latitude: fromCoord.lat, longitude: fromCoord.lng }
        : null;
      let toPoint: GeoPoint | null = toCoord
        ? { latitude: toCoord.lat, longitude: toCoord.lng }
        : null;
      let fromIsGcj = Boolean(fromCoord);
      let durationMin: number | undefined;
      let distanceKm: number | undefined;
      let polylineGcj: GeoPoint[] | undefined;
      if (origin) {
        const est = await estimateTravelTime({
          origin,
          destination: toRaw,
          mode: mode === "walking" ? "walking" : "driving",
          ...(deps.routeFallback ? { osrmFallback: deps.routeFallback } : {}),
        });
        if (est) {
          fromPoint = est.originPoint ?? fromPoint;
          toPoint = est.destinationPoint ?? toPoint;
          durationMin = est.durationMin;
          distanceKm = est.distanceKm;
          // 公交/骑行没有对应路径规划：估时是借驾车算的，几何不能画成公交路线
          if (mode === "driving" || mode === "walking") polylineGcj = est.polyline;
          // estimateTravelTime 返回的 originPoint 一律是 GCJ-02：
          // 客户端 GPS 进来时已按 WGS-84 转成高德串再解析（OSRM 兜底也复用该坐标）。
          if (est.originPoint) fromIsGcj = true;
        }
      }

      // 起点缺失不会走估时；这里单独编码一次目的地，保证卡片有终点坐标。
      if (!toPoint && !toCoord) {
        const destGeo = await amapGeocode(toRaw).catch(() => null);
        const p = destGeo ? parseLngLat(destGeo) : null;
        if (p) toPoint = p;
      }

      // 卡片底图是 WGS-84（Esri 瓦片）：高德坐标统一做一次 GCJ→WGS 近似逆变换。
      const fromWgs = fromPoint
        ? fromIsGcj
          ? gcj02ToWgs84(fromPoint.latitude, fromPoint.longitude)
          : fromPoint
        : null;
      const toWgs = toPoint ? gcj02ToWgs84(toPoint.latitude, toPoint.longitude) : null;
      const polylineWgs: Array<[number, number]> = (polylineGcj ?? []).map((p) => {
        const w = gcj02ToWgs84(p.latitude, p.longitude);
        return [w.latitude, w.longitude];
      });

      // 公交/骑行没有对应估时（estimateTravelTime 只支持步行/驾车），
      // 不能把驾车时长当成公交时长展示。
      const reportEstimate = mode === "driving" || mode === "walking";
      const navigationCardId = navigationCardStore.set({
        from: fromWgs
          ? { name: fromLabel, lat: fromWgs.latitude, lng: fromWgs.longitude }
          : null,
        to: toWgs ? { name: toLabel, lat: toWgs.latitude, lng: toWgs.longitude } : null,
        mode,
        ...(reportEstimate && durationMin != null ? { durationMin } : {}),
        ...(reportEstimate && distanceKm != null ? { distanceKm } : {}),
        polyline: polylineWgs,
      });

      return {
        ok: true,
        from: fromLabel,
        to: toLabel,
        mode,
        ...(reportEstimate && durationMin != null ? { durationMin } : {}),
        ...(reportEstimate && distanceKm != null ? { distanceKm } : {}),
        navigationCardId,
        displayNote:
          "导航卡已由系统在对话中自动展示（内置地图 + 起终点 + 距离/耗时），正文用一两句话确认即可：" +
          "不要贴链接、不要展示经纬度、不要逐条复述路线，也不要声称已替用户开始导航。" +
          (toWgs ? "" : "（未解析到目的地精确坐标，卡片只能显示名称，如实说明即可）"),
      };
    },
  };

  register(navigate);
}
