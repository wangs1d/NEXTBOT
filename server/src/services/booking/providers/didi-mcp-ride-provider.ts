/**
 * 滴滴出行 Provider（官方 MCP 桥接，travel-upgrade-plan P2 接驳下单链）。
 *
 * 用户已接入滴滴官方 MCP（http 端点，别名 didi，经 McpClientService）：
 *   maps_textsearch（POI 搜索拿坐标）→ taxi_estimate（估价，沙箱返回自由文本）
 *   → taxi_create_order（下单）→ taxi_query_order / taxi_get_driver_location（查单）
 *   → taxi_cancel_order（取消）。
 *
 * 桥接意义：ride_hailing.* 工具族此前只有 simulated/amap 两个 provider，
 * 接驳提醒确认后的「真实下单」没有走滴滴。本 provider 把滴滴 MCP 并入
 * BookingService 的 ride 域（数组首位、availability 优先），让接驳确认后
 * ride_hailing.quote → book 两阶段确认真实走到滴滴（开发/沙箱环境为滴滴
 * 官方沙箱 Mock 端点，生产配真实 Key 后同链路真实下单）。
 *
 * 诚实边界：
 *   - 估价文本解析不出车型/流程ID 时不造假 option（返回明确错误）；
 *   - 沙箱估价金额多为非承诺预估，解析不出 amount 时按 null 处理（以平台为准）；
 *   - 下单未返回订单号视为失败，不虚构「已下单」。
 */
import type {
  BookingProvider,
  BookingProviderBookPayload,
  BookingProviderContext,
  BookingProviderRef,
  BookingProviderResult,
  BookingProviderStatusPayload,
  BookingDraft,
  BookingOption,
  BookingSearchQuery,
  BookingOrderStatus,
} from "../booking-provider.js";
import type { McpClientService } from "../../mcp-client-service.js";
import { drivingRouteViaDidi, rideAppLinkViaDidi, type DrivingRouteSummary } from "../../ride-pickup-candidates.js";
import { gcj02ToWgs84, wgs84ToGcj02 } from "../../../skills/travel-planning/coord-transform.js";

/** 从 MCP 工具结果提取文本（content[].text 或原始 JSON） */
function textOf(result: Record<string, unknown>): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
  if (Array.isArray(content)) return content.map((c) => c?.text ?? "").join("\n");
  return JSON.stringify(result);
}

/** 深度查找对象中第一个命中 key 的值 */
function deepFind(obj: unknown, keyPattern: RegExp): unknown {
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const hit = deepFind(item, keyPattern);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }
  if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (keyPattern.test(k) && v !== undefined && v !== null && v !== "") return v;
      const hit = deepFind(v, keyPattern);
      if (hit !== undefined) return hit;
    }
  }
  return undefined;
}

/** 从工具结果文本中解析 JSON（尽力而为） */
function parseResultJson(result: Record<string, unknown>): unknown {
  const text = textOf(result);
  try {
    return JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {
        /* ignore */
      }
    }
  }
  return text;
}

/** optionId 形态：didi:{estimate_trace_id}:{product_category} */
const OPTION_ID_RE = /^didi:([A-Za-z0-9_-]+):(\d+)$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/**
 * 解析「纬度,经度」坐标对文本（formatLocationLabel 的兜底形态）。
 * 中国域内纬度约 20–55、经度约 73–135，按值域判向，不依赖书写顺序。
 */
function parseCoordPair(text: string): { lat: number; lng: number } | null {
  const m = text.match(/^\s*(-?\d{1,3}(?:\.\d+)?)\s*[,，]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/);
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  const inLat = (v: number) => v >= 15 && v <= 60;
  const inLng = (v: number) => v >= 70 && v <= 140;
  if (inLat(a) && inLng(b)) return { lat: a, lng: b };
  if (inLat(b) && inLng(a)) return { lat: b, lng: a };
  return null;
}

/**
 * 从一行车型文案里取预估价。
 *
 * 必须带货币符号或「元/块」才算价格：滴滴估价自由文本里还有
 * 「预估流程ID：traceECO123」「3 分钟内接驾」这类数字/近似文本，
 * 早前全局取第一个「预估/约 + 数字」会把「约 1 分钟」或流程 ID 当金额，
 * 再把同一个数字套到所有车型上（真机表现：所有车型价格都一样）。
 */
function parseLineAmount(line: string): number | null {
  const m =
    line.match(/[¥￥]\s*(\d+(?:\.\d+)?)/) ??
    line.match(/(?:预估价|预估价格|价格|车费|费用|金额)\s*[:：]?\s*[¥￥]?\s*(\d+(?:\.\d+)?)/) ??
    line.match(/(\d+(?:\.\d+)?)\s*(?:元|块)/);
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

export class DidiMcpRideProvider implements BookingProvider {
  readonly key = "didi";
  readonly domain = "ride" as const;
  readonly label = "滴滴出行（官方 MCP）";

  constructor(private readonly mcp: McpClientService) {}

  private serverReady(): boolean {
    return this.mcp.listServers().some((s) => s.alias === "didi");
  }

  /** 不可用原因（null = 可用）。未配 key 时回落模拟 provider，配上即自动接管首选。 */
  private availabilityIssue(): string | null {
    const server = this.mcp.listServers().find((s) => s.alias === "didi");
    if (!server) return "滴滴 MCP server 未注册（检查 MCP 配置 data/mcp-servers.json 中的 didi 端点）";
    if (server.url?.includes("${DIDI_MCP_KEY}") && !process.env.DIDI_MCP_KEY?.trim()) {
      return "未配置 DIDI_MCP_KEY（滴滴端点无法鉴权），暂由模拟 provider 兜底";
    }
    return null;
  }

  availability(): { ok: boolean; reason?: string } {
    const issue = this.availabilityIssue();
    return issue ? { ok: false, reason: issue } : { ok: true };
  }

  /**
   * maps_textsearch：地址 → {lng,lat,name}。滴滴要求坐标来自本工具。
   * 返回的坐标是 **WGS-84**（滴滴给 GCJ-02，这里统一转回服务端基准），
   * 估价/算路时再由调用方转 GCJ——全链路只有一处转换口径。
   */
  private async textsearch(
    keywords: string,
    city?: string,
  ): Promise<{ lng: number; lat: number; name: string } | null> {
    const res = await this.mcp.callTool(
      "didi",
      "maps_textsearch",
      { keywords, ...(city ? { city } : {}) },
      20_000,
    );
    if (!res.ok) return null;
    const parsed = parseResultJson(res.result);
    // HTTP 200 但业务体带错误码：city 不合规（如县级「兴义市」）时滴滴返回
    // {"code":"CITY_NOT_FOUND"}，此时 parsed 里根本没有 location，若不显式
    // 拦截就会静默走到「无法定位目的地」——根因是 city 口径，不是目的地本身。
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const code = (parsed as Record<string, unknown>).code;
      const status = (parsed as Record<string, unknown>).status;
      const badCode = typeof code === "string" && !/^0$|success/i.test(code);
      const badStatus = typeof status === "string" && !/^0$|success/i.test(status);
      if (badCode || badStatus) return null;
    }
    const loc = deepFind(parsed, /^(location|lng_lat|coord)$/i);
    let lngRaw: unknown;
    let latRaw: unknown;
    if (loc && typeof loc === "object") {
      lngRaw = (loc as { lng?: unknown }).lng;
      latRaw = (loc as { lat?: unknown }).lat;
    }
    const lngN = Number(lngRaw);
    const latN = Number(latRaw);
    if (!Number.isFinite(lngN) || !Number.isFinite(latN)) return null;
    // 生产端点 POI 名在 display_name（沙箱是 name/title），取不到再落回 keywords
    const name = String(
      deepFind(parsed, /^(display_?name|name|title)$/i) || keywords,
    );
    // 滴滴 GCJ-02 → WGS-84（服务端基准）
    const wgs = gcj02ToWgs84(latN, lngN);
    return { lng: wgs.longitude, lat: wgs.latitude, name };
  }

  async search(
    query: BookingSearchQuery,
    ctx: BookingProviderContext,
  ): Promise<BookingProviderResult<{ options: BookingOption[]; note?: string; route?: DrivingRouteSummary; rideAppLink?: string }>> {
    const dropoffText = typeof query.params.dropoff === "string" ? query.params.dropoff.trim() : "";
    if (!dropoffText) return { ok: false, error: "缺少 dropoff（目的地）", retryable: true };
    const pickupText = typeof query.params.pickup === "string" ? query.params.pickup.trim() : "";
    // 生产端点 maps_textsearch 强制 city（缺失 HTTP 400）：模型/handler 没传时
    // 从客户端定位补，双保险
    const city =
      query.city?.trim() ||
      ctx.location?.city?.trim() ||
      query.location?.city?.trim() ||
      undefined;

    // 起点：坐标直传 > 坐标对文本 > 地址检索 > 客户端 GPS。
    // 定位标签只有区县级粗粒度，地理编码要么失败要么锚到区中心
    // （真机实证报「无法定位/没有细地址」），有坐标就绝不倒腾回文本。
    // 这里所有坐标统一为 **WGS-84**（手机 GPS / 卡内选点都是 WGS），
    // 真正调滴滴（GCJ-02）时在下方 estimate 处一次性转换。
    let from: { lng: number; lat: number; name: string } | null = null;
    const coords =
      isRecord(query.params.pickupCoords) &&
      typeof query.params.pickupCoords.lat === "number" &&
      typeof query.params.pickupCoords.lng === "number"
        ? { lat: query.params.pickupCoords.lat as number, lng: query.params.pickupCoords.lng as number }
        : null;
    if (coords) {
      from = { lng: coords.lng, lat: coords.lat, name: pickupText || "当前位置" };
    } else if (pickupText) {
      const pair = parseCoordPair(pickupText);
      if (pair) {
        from = { lng: pair.lng, lat: pair.lat, name: "当前位置" };
      } else {
        from = await this.textsearch(pickupText, city);
      }
    }
    if (!from) {
      const loc = ctx.location ?? query.location;
      if (loc) {
        from = { lng: loc.longitude, lat: loc.latitude, name: loc.label?.trim() || "当前位置" };
      }
    }
    if (!from) {
      return {
        ok: false,
        // 结构化标记：quote handler 据此推「选上车点」卡，不让模型文字追问
        code: "PICKUP_UNRESOLVED",
        error:
          pickupText
            ? `起点「${pickupText}」定位失败：请说更具体的上车点（如「太古里北门」），或检查定位授权后重试`
            : "缺少起点：请提供 pickup，或确保客户端已上报定位",
        retryable: true,
      };
    }

    const dest = await this.textsearch(dropoffText, city);
    if (!dest) return { ok: false, error: `无法定位目的地「${dropoffText}」，请说更具体的地址（如「太古里北门」）`, retryable: true };

    // 滴滴估价要 GCJ-02：WGS-84 → GCJ-02（数字/坐标参数一律传字符串）。
    const gFrom = wgs84ToGcj02(from.lat, from.lng);
    const gDest = wgs84ToGcj02(dest.lat, dest.lng);
    const est = await this.mcp.callTool(
      "didi",
      "taxi_estimate",
      {
        from_lng: gFrom.longitude.toFixed(6),
        from_lat: gFrom.latitude.toFixed(6),
        from_name: from.name,
        to_lng: gDest.longitude.toFixed(6),
        to_lat: gDest.latitude.toFixed(6),
        to_name: dest.name,
      },
      30_000,
    );
    if (!est.ok) return { ok: false, error: "滴滴估价请求失败（MCP 调用未成功）", retryable: true };

    // 估价是自由文本，两种已知形态逐行解析（每行各自取价，不能全局套一个金额）：
    //   生产：「N. 快车: 约 27 元 (品类代码: 1)」（可带「, 券后约16元」）
    //   沙箱：「快车 (product_category: 3)，预估流程ID：t，预估价 ¥58」
    const text = textOf(est.result);
    const traceIdGlobal = text.match(/预估流程ID[:：]\s*([A-Za-z0-9_-]+)/)?.[1] ?? "";
    const parsed: Array<{
      name: string;
      category: string;
      traceId: string;
      amount: number | null;
      etaMinutes: number | null;
    }> = [];
    for (const line of text.split(/\r?\n/)) {
      const prod = line.match(
        /^\s*\d+[.、]\s*([\u4e00-\u9fa5A-Za-z0-9]{2,10})[:：]\s*约\s*(\d+(?:\.\d+)?)\s*元.*?品类代码[:：]\s*(\d+)/,
      );
      if (prod) {
        parsed.push({
          name: prod[1],
          category: prod[3],
          traceId: traceIdGlobal,
          amount: Number(prod[2]),
          etaMinutes: null,
        });
        continue;
      }
      const m = line.match(
        /([\u4e00-\u9fa5A-Za-z]{2,6})\s*[（(]\s*product_category[:：=]\s*(\d+)\s*[）)]/,
      );
      if (!m) continue;
      const etaMin = Number(line.match(/(\d+)\s*分钟内?[接驾|到达]/)?.[1] ?? NaN);
      parsed.push({
        name: m[1],
        category: m[2],
        traceId: line.match(/预估流程ID[:：]\s*([A-Za-z0-9_-]+)/)?.[1] ?? traceIdGlobal,
        amount: parseLineAmount(line),
        etaMinutes: Number.isFinite(etaMin) ? etaMin : null,
      });
    }
    // 生产文本同时含「无价车型列表行」与「带价明细行」（同 category 两行）：
    // 按车型去重，优先保留带价格的那条。
    const byCategory = new Map<string, (typeof parsed)[number]>();
    for (const p of parsed) {
      const prev = byCategory.get(p.category);
      if (!prev || (prev.amount == null && p.amount != null)) byCategory.set(p.category, p);
    }
    // 流程ID可能只在首行出现一次，也可能每行各带一个；两种形态都保留。
    const usable = [...byCategory.values()].filter((p) => p.traceId);
    if (usable.length === 0) {
      return {
        ok: false,
        error: `滴滴估价返回无法解析（片段：${text.slice(0, 80)}），请稍后重试`,
        retryable: true,
      };
    }

    const options: BookingOption[] = usable.slice(0, 8).map((m) => ({
      // 报价上下文（流程ID/车型）编码进 optionId，下单阶段原样带回
      id: `didi:${m.traceId}:${m.category}`,
      provider: this.key,
      title: m.amount != null ? `${m.name}（预估 ¥${m.amount}）` : m.name,
      description: `${from.name} → ${dest.name}${m.amount != null ? ` · 预估 ¥${m.amount}` : " · 价格以平台为准"}`,
      amountCny: m.amount,
      currency: "CNY" as const,
      etaMinutes: m.etaMinutes,
      extra: { carType: m.name, estimateTraceId: m.traceId, productCategory: m.category },
    }));

    // 加值信息（2026-11-20 接入滴图地图族）：驾车路线（里程/耗时/轨迹）+
    // 滴滴 App 深链（备用发单入口），随报价结果带给 ride_quote 卡。
    // 尽力而为：失败/超时不影响报价本身。
    let route: DrivingRouteSummary | undefined;
    let rideAppLink: string | undefined;
    try {
      // 起终点为 WGS-84；drivingRouteViaDidi / rideAppLinkViaDidi 内部转 GCJ 调滴滴
      const [routeRes, linkRes] = await Promise.all([
        drivingRouteViaDidi(this.mcp, from.lng, from.lat, dest.lng, dest.lat),
        rideAppLinkViaDidi(this.mcp, from.lng, from.lat, dest.lng, dest.lat, usable[0]?.category),
      ]);
      route = routeRes ?? undefined;
      rideAppLink = linkRes ?? undefined;
    } catch {
      /* 加值失败不影响报价 */
    }

    return {
      ok: true,
      options,
      note: "滴滴官方 MCP 报价；下单需两阶段确认（confirm + confirmationToken）",
      ...(route ? { route } : {}),
      ...(rideAppLink ? { rideAppLink } : {}),
    };
  }

  async book(
    draft: BookingDraft,
    _ctx: BookingProviderContext,
  ): Promise<BookingProviderResult<BookingProviderBookPayload>> {
    const m = OPTION_ID_RE.exec(draft.optionId);
    if (!m) {
      return {
        ok: false,
        error: `optionId 非滴滴报价形态（${draft.optionId.slice(0, 40)}），请先 ride_hailing.quote 重新报价`,
        retryable: true,
      };
    }
    const [, traceId, category] = m;
    const res = await this.mcp.callTool(
      "didi",
      "taxi_create_order",
      { product_category: category, estimate_trace_id: traceId },
      45_000,
    );
    if (!res.ok) return { ok: false, error: "滴滴下单请求失败（MCP 调用未成功）", retryable: true };
    const text = textOf(res.result);
    const orderId =
      String(deepFind(parseResultJson(res.result), /order_id|orderId/i) ?? "") ||
      text.match(/订单号[:：]\s*([A-Za-z0-9]+)/)?.[1] ||
      "";
    if (!orderId) return { ok: false, error: `滴滴下单未返回订单号（${text.slice(0, 80)}）`, retryable: true };
    return {
      ok: true,
      providerOrderId: orderId,
      status: "confirmed",
      message: `滴滴已下单，订单号 ${orderId}`,
    };
  }

  async getStatus(
    ref: BookingProviderRef,
    _ctx: BookingProviderContext,
  ): Promise<BookingProviderResult<BookingProviderStatusPayload>> {
    const res = await this.mcp.callTool("didi", "taxi_query_order", { order_id: ref.providerOrderId }, 30_000);
    if (!res.ok) return { ok: false, error: "滴滴查单失败（MCP 调用未成功）", retryable: true };
    const text = textOf(res.result);
    // 沙箱状态推进：0 匹配中 → 1 已接单 → 2 已到达 → 4 行程中 → 5 完成
    const code = Number(
      String(deepFind(parseResultJson(res.result), /^status(_code)?$/i) ?? text.match(/状态码?[:：]\s*(\d)/)?.[1] ?? NaN),
    );
    const map: Record<number, BookingOrderStatus> = { 0: "confirmed", 1: "confirmed", 2: "confirmed", 4: "in_progress", 5: "completed" };
    // 司机位置尽力补一条动态信息（失败不影响查单结果）
    let tracking: Record<string, unknown> | undefined;
    const drv = await this.mcp
      .callTool("didi", "taxi_get_driver_location", { order_id: ref.providerOrderId }, 20_000)
      .catch(() => null);
    if (drv?.ok) {
      const parsed = parseResultJson(drv.result) as Record<string, unknown>;
      if (parsed && typeof parsed === "object") tracking = parsed;
    }
    return {
      ok: true,
      status: map[code] ?? "confirmed",
      message: text.slice(0, 200) || undefined,
      tracking,
    };
  }

  async cancel(
    ref: BookingProviderRef,
    reason: string | undefined,
    _ctx: BookingProviderContext,
  ): Promise<BookingProviderResult<{ message?: string }>> {
    const res = await this.mcp.callTool(
      "didi",
      "taxi_cancel_order",
      { order_id: ref.providerOrderId, ...(reason ? { reason } : {}) },
      30_000,
    );
    if (!res.ok) return { ok: false, error: "滴滴取消请求失败（MCP 调用未成功）", retryable: true };
    return { ok: true, message: textOf(res.result).slice(0, 120) || "滴滴订单已取消" };
  }
}
