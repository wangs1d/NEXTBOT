/**
 * 内置 Skill：通用真实导航（navigation.navigate）
 *
 * 定位：导航是**通用能力**，不属于旅游业务——日常通勤、找店、赴约、旅游行程里的
 * 「导航去 XX」都是同一个诉求。因此本模块放在 services/navigation 下，注册在
 * 版本闸（isOssEdition 剔除 travel.*）之外，任何场景（含旅游规划）都复用同一实现。
 *
 * 能力：给用户真实路网的逐向导航链接（高德 Web 导航 URI），不是网页搜索、不是只算距离。
 *   - 配了 AMAP_WEB_KEY 时先用高德把起点/目的地解析成精确坐标（GCJ-02）；
 *   - 解析失败自动降级为地名导航，链接始终可用；
 *   - 起点省略 = 用户实时定位；定位也拿不到 = 交给高德按用户当前位置导航。
 *
 * 依赖通过 deps 注入（定位、路线兜底），避免通用能力反向依赖旅游模块。
 */

import type { SkillDefinition } from "../../skills/types.js";
import type { ToolContext } from "../../tools/tool-registry.js";
import { resolveCurrentGeoPoint } from "../user-location-service.js";
import { estimateTravelTime, type GeoPoint } from "../route-duration-service.js";
import { buildAmapNavigationUrl, type NavTravelMode } from "./nav-provider.js";

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
        "给用户真实路网的逐向导航链接（高德 Web 导航），不是网页搜索、不是只算距离。" +
        "日常出行与旅游规划通用：通勤、赴约、找店、景点之间移动都可用。" +
        "配了 AMAP_WEB_KEY 时先用高德把目的地/起点解析成精确坐标（GCJ-02），失败自动降级为地名导航，链接始终可用。" +
        "适用表达：「导航去XX」「带我去XX」「开车/走路/坐公交怎么去XX」「从A导航到B」「给我开个导航」。" +
        "起点可省略=按用户实时定位；用户没说从哪出发时别反问，直接调用。" +
        "边界：只问距离/耗时（不要求点开导航）用路线耗时工具；叫车报价用 ride_hailing.quote；" +
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
        url: "高德导航链接（真实逐向导航）",
        from: "起点名称（省略时为「当前位置」）",
        to: "目的地名称",
        mode: "交通方式",
        durationMin: "预计耗时（分钟；高德实时成功时给出）",
        distanceKm: "距离（公里；高德实时成功时给出）",
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

      // 坐标串不进用户可见文案（经纬度禁令）；坐标只出现在导航 URI 参数里。
      const toCoord = parseCoordText(toRaw);
      const toLabel = toCoord ? "目的地" : toRaw;

      // 起点：给定优先；省略取实时定位；都拿不到 → 起点留空交给高德按当前位置导航。
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
      let durationMin: number | undefined;
      let distanceKm: number | undefined;
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
        }
      }

      const url = buildAmapNavigationUrl({
        from: fromPoint
          ? { name: fromLabel, lat: fromPoint.latitude, lng: fromPoint.longitude }
          : null,
        to: toPoint
          ? { name: toLabel, lat: toPoint.latitude, lng: toPoint.longitude }
          : { name: toLabel },
        mode,
      });

      // 公交/骑行没有对应估时（estimateTravelTime 只支持步行/驾车），
      // 不能把驾车时长当成公交时长返回；这两种方式让高德页面自己算。
      const reportEstimate = mode === "driving" || mode === "walking";
      return {
        ok: true,
        url,
        from: fromLabel,
        to: toLabel,
        mode,
        ...(reportEstimate && durationMin != null ? { durationMin } : {}),
        ...(reportEstimate && distanceKm != null ? { distanceKm } : {}),
        displayNote:
          "把 url 作为 Markdown 链接「开始导航」呈现（如 [开始导航](url)），不要直接铺开长链接、不要展示经纬度；" +
          "导航由用户点击后在高德网页开始，不要声称已替用户开始导航。" +
          (fromPoint ? "" : "（未取到精确起点，已交给高德按用户当前位置导航）") +
          (toPoint ? "" : "（目的地未解析到精确坐标，已按地名导航）"),
      };
    },
  };

  register(navigate);
}
