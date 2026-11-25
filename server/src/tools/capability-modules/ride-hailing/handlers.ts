import type { ToolHandler, ToolContext, ToolRegistry } from "../../tool-registry.js";
import type { ClientLocationWire } from "../../../types/client-location.js";
import type { BookingService } from "../../../services/booking/booking-service.js";
import type { McpClientService } from "../../../services/mcp-client-service.js";
import {
  regeocodeViaDidi,
  searchNearbyPickupsViaDidi,
} from "../../../services/ride-pickup-candidates.js";
import { rideMap3dEnabled } from "../../../services/ride-map-config.js";

/**
 * ride_hailing.* 工具 handler 工厂集合 + 注册入口。
 *
 * 返回契约与 shopping-order 一致：
 *   - 成功：`{ ok: true, summary, ... }`
 *   - 失败：`{ ok: false, error, retryable? }`
 *
 * 位置联动（方案 B）：pickup 缺省时依次尝试——
 *   1. context.clientLocation（前端 GPS 上报）→ 逆推展示标签
 *   2. context.requestLocation（按需向客户端请求实时定位）
 *   3. 兜底「当前位置」文本（模拟 Provider 可用；live Provider 会要求显式地址）
 */

export interface RideHailingModuleDeps {
  bookingService: BookingService;
  /** 滴滴 MCP client：选点卡的周边候选走滴图 maps_place_around；缺省时候选为空、卡退化纯地图选点 */
  mcp?: McpClientService;
}

/** 纯坐标串（如「113.8033,31.5705」）不是地名，不能当上车点文案透出给用户。 */
function isCoordOnlyLabel(label: string): boolean {
  return /^\s*-?\d+(?:\.\d+)?\s*[,，]\s*-?\d+(?:\.\d+)?\s*$/.test(label);
}

/**
 * 选点卡锚点可接受的定位精度（米）。
 *
 * 2026-11-24 真机实测：手机常态 acc=43~60m（室内/WiFi 混合定位），此前门槛
 * 定 10m 导致每次按需定位都「不达标 → 跑满 GPS 预算 → 超时回空包」，
 * 选点卡因此 origin=无、candidates=0、预选态全空（线上日志实证）。
 * 上车点选点只需要「人在哪一栋楼」，50m 足够把地图居中并把候选搜出来，
 * 精度仍如实带到卡片上由用户自己拖图微调。
 */
const RIDE_PICKUP_ACCURACY_M = 50;

function formatLocationLabel(loc: ClientLocationWire): string {
  const label = loc.label?.trim() ?? "";
  if (label && !isCoordOnlyLabel(label)) return label;
  const area = [loc.district, loc.city].filter(Boolean).join("");
  if (area) return area;
  return "当前位置";
}

async function resolvePickup(
  context: ToolContext,
  pickupInput: unknown,
): Promise<{
  pickup: string;
  note?: string;
  location?: ClientLocationWire;
}> {
  if (typeof pickupInput === "string" && pickupInput.trim()) {
    return { pickup: pickupInput.trim() };
  }
  // 上车点只认「当下实时 GPS」：不读随消息上报的 context.clientLocation，
  // 也不缓存兜底。真机实证：缓存里的旧坐标（湖北随州 113.8,31.57）曾冒充
  // 兴义的实时位置，导致地图中心错、候选错、city 错三连故障。
  // maxAgeMs=0 让 locationCoordinator 无条件绕过复用缓存、向手机现拉一次；
  // 精度门槛 50m（2026-11-24 改）：手机常态 43~60m，10m 门槛把可用的 fix
  // 全部判死，选点卡因此拿不到 origin。拉不到才返回空，由 quote handler
  // 推纯地图选点卡——宁可让用户手动拖，绝不用旧坐标冒充实时。
  const requested = (await context.requestLocation?.(
    "叫车需要获取当前位置作为上车点",
    { maxAgeMs: 0, maxAccuracyMeters: RIDE_PICKUP_ACCURACY_M },
  )) ?? null;
  if (requested) {
    const label = formatLocationLabel(requested);
    return {
      pickup: label,
      note: `起点已获取实时定位：${label}`,
      location: requested,
    };
  }
  return { pickup: "", note: "未获取到实时定位" };
}

/**
 * 把 resolvePickup 结果折进下单/报价参数。
 *
 * 关键：GPS 命中时把**原始坐标**一并带给 provider（pickupCoords）。
 * 定位标签只有区县级粗粒度（「成都市武侯区」），拿它做地理编码要么失败
 * 要么把上车点锚到区中心——真机实证报「无法定位/没有细地址」。坐标在手
 * 就不该倒腾回文本再搜一遍。
 */
function buildPickupParams(
  resolved: Awaited<ReturnType<typeof resolvePickup>>,
): Record<string, unknown> {
  const params: Record<string, unknown> = { pickup: resolved.pickup };
  if (resolved.location) {
    params.pickupCoords = {
      lat: resolved.location.latitude,
      lng: resolved.location.longitude,
    };
  }
  return params;
}

/**
 * 选点卡的锚点：优先用已有的实时定位；没有就按需向客户端现拉一次。
 *
 * 为什么需要：用户给了文字上车点（如「九华园」）但检索失败时，resolvePickup
 * 走的是「显式 pickup」分支——它直接返回文本、不会请求定位，于是这一路推卡
 * 时 origin 为空，即使手机有 GPS 也看不到「预选位置」。这里在推卡前补拉一次，
 * 拉到就以它为地图中心 + 周边候选锚点。
 */
async function resolveCardOrigin(
  context: ToolContext,
  existing: { lat: number; lng: number; label: string; accuracyMeters?: number | null } | null,
): Promise<{ lat: number; lng: number; label: string; accuracyMeters?: number | null } | null> {
  if (existing) return existing;
  const live = (await context.requestLocation?.(
    "叫车需要当前位置校准选点地图",
    { maxAgeMs: 0, maxAccuracyMeters: RIDE_PICKUP_ACCURACY_M },
  )) ?? null;
  return live
    ? {
        lat: live.latitude,
        lng: live.longitude,
        label: formatLocationLabel(live),
        accuracyMeters: live.accuracyMeters ?? null,
      }
    : null;
}

/**
 * 起点没着落时的确定性出口（2026-11-20）：推「选上车点」卡
 * （shopping_login 同通道 type=card），用户点候选/拖地图选好点后经
 * card.action ride.pickup.select 续报价——全程零模型轮次、零文字追问。
 *
 * 定位口径（2026-11-20 用户定稿）：上车点**只认当下实时定位**——
 * resolvePickup 每次调用都会按需向客户端现拉一次 GPS，拉到即用；
 * 历史定位/快照一律不兜底（宁可诚实降级纯地图选点，不用旧位置装新鲜）。
 *
 * 候选来自滴滴 MCP 滴图地图 maps_place_around（不依赖高德）：
 * 实时定位拿到 → 候选围着它搜、地图居中（预选态）；拿不到 → 空候选，
 * 卡退化为纯地图选点，不阻塞、不冒充。
 */
async function pushPickupSelectCard(
  context: ToolContext,
  rideRequest: { dropoff: string; city?: string; scheduleAt?: string | null },
  origin: { lat: number; lng: number; label: string; accuracyMeters?: number | null } | null,
  mcp?: McpClientService,
): Promise<boolean> {
  if (!context.pushMediaCards) return false;
  // 候选与逆地理并行（每次 20s 超时的 MCP 串行会让卡片明显变慢）。
  const emptyCandidates: Awaited<ReturnType<typeof searchNearbyPickupsViaDidi>> = [];
  const [candidates, poi] = await Promise.all([
    origin && mcp ? searchNearbyPickupsViaDidi(mcp, origin.lng, origin.lat) : Promise.resolve(emptyCandidates),
    origin && mcp
      ? regeocodeViaDidi(mcp, origin.lng, origin.lat, 3500).catch(() => null)
      : Promise.resolve(null),
  ]);
  // 定位标签升级（2026-11-24）：GPS 只能给出「兴义市 · 黔西南布依族苗族自治州」
  // 这种行政串，卡片上写这个用户根本读不出「我在哪」。用滴图反查 POI 名
  // （实测该坐标 → 「九华苑」，精确到永康路21号）当上车点标题；反查失败才回退。
  const originLabel = poi?.name?.trim() || origin?.label || "";
  const accText = typeof origin?.accuracyMeters === "number"
    ? `acc=${Math.round(origin.accuracyMeters)}m`
    : "acc=?";
  console.log(
    `[ride-pickup] 推选点卡 dropoff=${rideRequest.dropoff} origin=${origin ? `${origin.lng.toFixed(5)},${origin.lat.toFixed(5)}(${originLabel}) ${accText}` : "无"} candidates=${candidates.length}` +
      (origin && candidates.length === 0 ? " ← 有定位但候选为空：查 didi MCP maps_place_around" : ""),
  );
  const sent = context.pushMediaCards([
    {
      type: "card",
      cardType: "ride_pickup",
      title: "选上车点",
      items: [],
      // 卡面自带地图/候选/按钮，正文不再重复解释操作步骤（2026-11-24 精简）
      footer: "",
      extra: {
        ridePickup: {
          // 配了 AMAP_JS_KEY 才走卡内 3D 地图（WebView + 高德 JS API）；否则客户端平面地图
          map3d: rideMap3dEnabled(),
          dropoff: rideRequest.dropoff,
          ...(rideRequest.city ? { city: rideRequest.city } : {}),
          ...(rideRequest.scheduleAt ? { scheduleAt: rideRequest.scheduleAt } : {}),
          ...(origin
            ? {
                origin: {
                  lat: origin.lat,
                  lng: origin.lng,
                  ...(originLabel ? { label: originLabel } : {}),
                  // 精度如实下发：客户端据此提示「定位约 ±43m，可拖图微调」，
                  // 而不是把 50m 的 fix 装成精确点（2026-11-24）。
                  ...(typeof origin.accuracyMeters === "number"
                    ? { accuracyMeters: origin.accuracyMeters }
                    : {}),
                },
              }
            : {}),
          candidates,
        },
      },
    } as unknown as Parameters<NonNullable<ToolContext["pushMediaCards"]>>[0][number],
  ]);
  return sent !== false;
}

/** 起点没着落的统一失败回执：error 同时是对模型的行动指引。 */
function pickupUnresolvedResult(
  cardPushed: boolean,
  dropoff: string,
): {
  ok: false;
  code: string;
  retryable: boolean;
  error: string;
} {
  console.log(
    `[ride-pickup] quote 起点没着落 dropoff=${dropoff} cardPushed=${cardPushed}（false=聊天通道不可用，文字兜底）`,
  );
  return {
    ok: false,
    code: "PICKUP_UNRESOLVED",
    retryable: true,
    error: cardPushed
      ? `上车点没着落，选上车点卡已推送给用户（目的地=${dropoff}），用户在卡上选好后服务端会自动续报价，你无需再调用本工具。正文：**必须为空，一个字都不要写**——卡片自带「选个上车点」标题、地图、候选和按钮说明，任何文字介绍都多余且重复（2026-11-20 用户定稿：删掉硬编码开场白）。若用户改用文字给了具体上车点，再调本工具并携带该 pickup。`
      : `起点没着落且聊天通道不可用，只能文字向用户要一个具体上车点（如「九华园1号门」）。`,
  };
}

/** ride_hailing.quote —— 车型与价格预估。 */
export function createRideQuoteHandler(
  service: BookingService,
  mcp?: McpClientService,
): ToolHandler {
  return async (input: Record<string, unknown>, context: ToolContext) => {
    const dropoff = typeof input.dropoff === "string" ? input.dropoff.trim() : "";
    if (!dropoff) return { ok: false, error: "缺少 dropoff（目的地）" };
    const provider = typeof input.provider === "string" && input.provider.trim() ? input.provider.trim() : undefined;
    // 滴滴生产端点 maps_textsearch 强制要求 city（缺失直接 HTTP 400）：
    // 模型没传时从客户端定位补，不再依赖模型自觉
    const city =
      (typeof input.city === "string" && input.city.trim()) ||
      context.clientLocation?.city?.trim() ||
      undefined;
    const scheduleAt =
      typeof input.scheduleAt === "string" && input.scheduleAt.trim() ? input.scheduleAt.trim() : null;

    const resolvedPickup = await resolvePickup(context, input.pickup);

    // 起点没着落的两种形态（2026-11-19 根修）：
    //   a) 无 pickup 文本且无任何定位来源 → resolvePickup 兜底「当前位置」必失败，直接推卡；
    //   b) 有 pickup 文本但检索失败（provider 回 code=PICKUP_UNRESOLVED）→ 同样推卡，
    //      此时若有客户端坐标就带周边候选。
    // 出口只有一个：ride_pickup 选点卡 + 对模型的行动指引，杜绝文字追问。
    // 定位口径（2026-11-20 用户定稿）：**只用当下实时定位**——resolvePickup
    // 每次都会按需现拉 GPS；历史/快照一律不兜底，拉不到就诚实降级纯地图选点。
    const rideRequestBase = {
      dropoff,
      ...(city ? { city } : {}),
      ...(scheduleAt ? { scheduleAt } : null),
    };
    // 地图中心只认本次实时定位。绝不回退 context.clientLocation（随消息上报、
    // 可能是几小时前的磁盘缓存坐标）——拿不到实时定位就是 null，卡片走全国
    // 视野纯地图选点，用户自己拖到目的地附近，也不会被错坐标误导。
    const origin = resolvedPickup.location
      ? {
          lat: resolvedPickup.location.latitude,
          lng: resolvedPickup.location.longitude,
          label: resolvedPickup.pickup,
        }
      : null;

    // 设计稿范式（2026-11-20 用户定稿）：**只要用户没指定具体上车点，一律推
    // 「选上车点」卡**——有 GPS 就带滴图周边候选 + 地图居中定位点（预选态），
    // 无 GPS 就是纯地图选点。不再有「有定位就直接用坐标报价跳过选点」的捷径：
    // 上车点必须让用户在卡上过目确认，选完经 ride.pickup.select 续报价。
    if (!(typeof input.pickup === "string" && input.pickup.trim())) {
      const pushed = await pushPickupSelectCard(
        context,
        rideRequestBase,
        origin,
        mcp,
      );
      return pickupUnresolvedResult(pushed, dropoff);
    }

    // 用户/模型显式给了上车点：文本检索报价；起点检索失败时仍推卡兜底
    const result = await service.search(
      context,
      "ride",
      { city, scheduleAt, params: { dropoff, scheduleAt, pickup: input.pickup.trim() } },
      provider,
    );
    if (!result.ok) {
      const failedResult = result as { code?: string; error?: string };
      const pickupFailed =
        failedResult.code === "PICKUP_UNRESOLVED" ||
        /起点|pickup/i.test(String(failedResult.error ?? ""));
      if (pickupFailed) {
        // 显式 pickup 检索失败这一路 resolvePickup 没拉定位，推卡前补一次，
        // 否则手机有 GPS 也出不来「预选位置」。
        const cardOrigin = await resolveCardOrigin(context, origin);
        const pushed = await pushPickupSelectCard(
          context,
          rideRequestBase,
          cardOrigin,
          mcp,
        );
        return pickupUnresolvedResult(pushed, dropoff);
      }
      return result;
    }
    // 报价上下文回带给卡片：选择车型的卡内动作要原样带回起终点/时间，
    // 客户端不解释参数，只把服务端给的 payload 回传。
    const rideRequest = {
      pickup: resolvedPickup.pickup,
      dropoff,
      ...(city ? { city } : {}),
      ...(scheduleAt ? { scheduleAt } : {}),
    };
    return {
      ...result,
      ...(resolvedPickup.note ? { pickupNote: resolvedPickup.note } : {}),
      rideRequest,
    };
  };
}

/** ride_hailing.book —— 两阶段确认下单。 */
export function createRideBookHandler(service: BookingService): ToolHandler {
  return async (input: Record<string, unknown>, context: ToolContext) => {
    const dropoff = typeof input.dropoff === "string" ? input.dropoff.trim() : "";
    const optionId = typeof input.optionId === "string" ? input.optionId.trim() : "";
    if (!dropoff) return { ok: false, error: "缺少 dropoff（目的地）" };
    if (!optionId) return { ok: false, error: "缺少 optionId（来自 ride_hailing.quote 的选项 id）" };

    const confirm = input.confirm === true;
    const confirmationToken =
      typeof input.confirmationToken === "string" ? input.confirmationToken.trim() : undefined;
    if (confirm && !confirmationToken) {
      return { ok: false, error: "confirm=true 时必须提供 confirmationToken（来自阶段一）" };
    }

    const provider = typeof input.provider === "string" && input.provider.trim() ? input.provider.trim() : undefined;
    // 与 quote 同口径：生产端点检索强制 city，缺省从客户端定位补
    const city =
      (typeof input.city === "string" && input.city.trim()) ||
      context.clientLocation?.city?.trim() ||
      undefined;
    const scheduleAt =
      typeof input.scheduleAt === "string" && input.scheduleAt.trim() ? input.scheduleAt.trim() : null;
    const passengerPhone =
      typeof input.passengerPhone === "string" && input.passengerPhone.trim()
        ? input.passengerPhone.trim()
        : undefined;

    // 阶段一解析起点（摘要里向用户复述上车点 + 坐标直传）；阶段二 token 草稿
    // 已带起点，跳过解析避免确认时多余的客户端定位往返
    const resolved = confirm ? null : await resolvePickup(context, input.pickup);
    const params = confirm
      ? { dropoff, passengerPhone }
      : { dropoff, passengerPhone, ...buildPickupParams(resolved!) };
    const result = await service.book(context, "ride", {
      provider,
      optionId,
      params,
      city,
      scheduleAt,
      confirm,
      confirmationToken,
    });
    if (!result.ok || confirm) return result;
    // 阶段一的确认卡需要完整上下文（起终点/城市/用车时间），
    // 卡内「确认叫车」按钮再把 token 原样带回执行阶段二。
    return {
      ...result,
      dropoff,
      pickup: resolved?.pickup ?? "",
      ...(city ? { city } : {}),
    };
  };
}

/** ride_hailing.status —— 订单追踪。 */
export function createRideStatusHandler(service: BookingService): ToolHandler {
  return async (input: Record<string, unknown>, context: ToolContext) => {
    const orderId = typeof input.orderId === "string" && input.orderId.trim() ? input.orderId.trim() : undefined;
    return service.getStatus(context, "ride", orderId);
  };
}

/** ride_hailing.cancel —— 两阶段确认取消。 */
export function createRideCancelHandler(service: BookingService): ToolHandler {
  return async (input: Record<string, unknown>, context: ToolContext) => {
    const orderId = typeof input.orderId === "string" ? input.orderId.trim() : "";
    if (!orderId) return { ok: false, error: "缺少 orderId（要取消的订单号）" };
    const confirm = input.confirm === true;
    const confirmationToken =
      typeof input.confirmationToken === "string" ? input.confirmationToken.trim() : undefined;
    if (confirm && !confirmationToken) {
      return { ok: false, error: "confirm=true 时必须提供 confirmationToken（来自阶段一）" };
    }
    const reason = typeof input.reason === "string" && input.reason.trim() ? input.reason.trim() : undefined;
    return service.cancel(context, "ride", orderId, confirm, confirmationToken, reason);
  };
}

/** 注册 ride-hailing 全部工具到 ToolRegistry。 */
export function registerRideHailingTools(registry: ToolRegistry, deps: RideHailingModuleDeps): void {
  const { bookingService, mcp } = deps;
  registry.register("ride_hailing.quote", createRideQuoteHandler(bookingService, mcp));
  registry.register("ride_hailing.book", createRideBookHandler(bookingService));
  registry.register("ride_hailing.status", createRideStatusHandler(bookingService));
  registry.register("ride_hailing.cancel", createRideCancelHandler(bookingService));
}
