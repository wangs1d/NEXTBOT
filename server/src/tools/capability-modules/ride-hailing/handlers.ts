import type { ToolHandler, ToolContext, ToolRegistry } from "../../tool-registry.js";
import type { ClientLocationWire } from "../../../types/client-location.js";
import type { BookingService } from "../../../services/booking/booking-service.js";

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
}

function formatLocationLabel(loc: ClientLocationWire): string {
  if (loc.label?.trim()) return loc.label.trim();
  const area = [loc.district, loc.city].filter(Boolean).join("");
  if (area) return area;
  return `${loc.latitude.toFixed(4)},${loc.longitude.toFixed(4)}`;
}

async function resolvePickup(
  context: ToolContext,
  pickupInput: unknown,
): Promise<{ pickup: string; note?: string; location?: ClientLocationWire }> {
  if (typeof pickupInput === "string" && pickupInput.trim()) {
    return { pickup: pickupInput.trim() };
  }
  if (context.clientLocation) {
    const label = formatLocationLabel(context.clientLocation);
    return { pickup: label, note: `起点自动取当前位置：${label}`, location: context.clientLocation };
  }
  const requested = (await context.requestLocation?.("叫车需要获取当前位置作为起点")) ?? null;
  if (requested) {
    const label = formatLocationLabel(requested);
    return { pickup: label, note: `起点已获取实时定位：${label}`, location: requested };
  }
  return { pickup: "当前位置", note: "未获取到定位，起点按「当前位置」处理" };
}

/** ride_hailing.quote —— 车型与价格预估。 */
export function createRideQuoteHandler(service: BookingService): ToolHandler {
  return async (input: Record<string, unknown>, context: ToolContext) => {
    const dropoff = typeof input.dropoff === "string" ? input.dropoff.trim() : "";
    if (!dropoff) return { ok: false, error: "缺少 dropoff（目的地）" };
    const provider = typeof input.provider === "string" && input.provider.trim() ? input.provider.trim() : undefined;
    const city = typeof input.city === "string" && input.city.trim() ? input.city.trim() : undefined;
    const scheduleAt =
      typeof input.scheduleAt === "string" && input.scheduleAt.trim() ? input.scheduleAt.trim() : null;

    const { pickup, note } = await resolvePickup(context, input.pickup);
    const result = await service.search(
      context,
      "ride",
      { city, scheduleAt, params: { pickup, dropoff, scheduleAt } },
      provider,
    );
    if (!result.ok) return result;
    // 报价上下文回带给卡片：选择车型的卡内动作要原样带回起终点/时间，
    // 客户端不解释参数，只把服务端给的 payload 回传。
    const rideRequest = { pickup, dropoff, ...(city ? { city } : {}), ...(scheduleAt ? { scheduleAt } : {}) };
    return { ...result, ...(note ? { pickupNote: note } : {}), rideRequest };
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
    const city = typeof input.city === "string" && input.city.trim() ? input.city.trim() : undefined;
    const scheduleAt =
      typeof input.scheduleAt === "string" && input.scheduleAt.trim() ? input.scheduleAt.trim() : null;
    const passengerPhone =
      typeof input.passengerPhone === "string" && input.passengerPhone.trim()
        ? input.passengerPhone.trim()
        : undefined;

    // 阶段一解析起点（摘要里向用户复述上车点）；阶段二 token 草稿已带起点，
    // 跳过解析避免确认时多余的客户端定位往返
    const params = confirm
      ? { dropoff, passengerPhone }
      : { dropoff, passengerPhone, pickup: (await resolvePickup(context, input.pickup)).pickup };
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
      pickup: params.pickup,
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
  const { bookingService } = deps;
  registry.register("ride_hailing.quote", createRideQuoteHandler(bookingService));
  registry.register("ride_hailing.book", createRideBookHandler(bookingService));
  registry.register("ride_hailing.status", createRideStatusHandler(bookingService));
  registry.register("ride_hailing.cancel", createRideCancelHandler(bookingService));
}
