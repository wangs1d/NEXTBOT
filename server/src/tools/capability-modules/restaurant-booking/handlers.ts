import type { ToolHandler, ToolContext, ToolRegistry } from "../../tool-registry.js";
import type { BookingService } from "../../../services/booking/booking-service.js";

/**
 * restaurant.* 工具 handler 工厂集合 + 注册入口。
 *
 * 返回契约与 shopping-order 一致；安全护栏由 BookingService 统一保障。
 * 位置联动：search 时把 context.clientLocation 透传给 Provider（附近推荐）。
 */

export interface RestaurantBookingModuleDeps {
  bookingService: BookingService;
}

function optionalString(raw: unknown): string | undefined {
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

function coerceCovers(raw: unknown): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n <= 50 ? Math.floor(n) : 2;
}

function buildParams(input: Record<string, unknown>): Record<string, unknown> {
  return {
    query: optionalString(input.query) ?? "",
    cuisine: optionalString(input.cuisine) ?? "",
    covers: coerceCovers(input.covers),
    dineAt: optionalString(input.dineAt) ?? optionalString(input.scheduleAt) ?? null,
    contactPhone: optionalString(input.contactPhone),
  };
}

/** restaurant.search —— 餐厅搜索（附近推荐 + 时段）。 */
export function createRestaurantSearchHandler(service: BookingService): ToolHandler {
  return async (input: Record<string, unknown>, context: ToolContext) => {
    // 「附近」语义（无关键词/菜系）先要定位；带关键词时交给 Provider 按需索取
    const params = buildParams(input);
    const needsNearbyHint = !params.query && !params.cuisine;
    const hasLocation = Boolean(context.clientLocation)
      || (needsNearbyHint ? Boolean(await context.requestLocation?.("餐厅推荐需要当前位置")) : false);
    const hint = needsNearbyHint && hasLocation
      ? "已结合当前定位优先推荐附近餐厅"
      : undefined;
    const result = await service.search(
      context,
      "restaurant",
      {
        city: optionalString(input.city),
        scheduleAt: (params.dineAt as string | null) ?? null,
        params,
      },
      optionalString(input.provider),
    );
    if (!result.ok) return result;
    return hint ? { ...result, locationHint: hint } : result;
  };
}

/** restaurant.book —— 两阶段确认订座。 */
export function createRestaurantBookHandler(service: BookingService): ToolHandler {
  return async (input: Record<string, unknown>, context: ToolContext) => {
    const optionId = optionalString(input.optionId);
    const dineAt = optionalString(input.dineAt);
    if (!optionId) return { ok: false, error: "缺少 optionId（来自 restaurant.search 的餐厅选项 id）" };
    if (!dineAt) return { ok: false, error: "缺少 dineAt（用餐时间，ISO）" };

    const confirm = input.confirm === true;
    const confirmationToken = optionalString(input.confirmationToken);
    if (confirm && !confirmationToken) {
      return { ok: false, error: "confirm=true 时必须提供 confirmationToken（来自阶段一）" };
    }

    return service.book(context, "restaurant", {
      provider: optionalString(input.provider),
      optionId,
      params: buildParams(input),
      city: optionalString(input.city),
      scheduleAt: dineAt,
      confirm,
      confirmationToken,
    });
  };
}

/** restaurant.status —— 预订状态。 */
export function createRestaurantStatusHandler(service: BookingService): ToolHandler {
  return async (input: Record<string, unknown>, context: ToolContext) => {
    return service.getStatus(context, "restaurant", optionalString(input.orderId));
  };
}

/** restaurant.cancel —— 两阶段确认取消。 */
export function createRestaurantCancelHandler(service: BookingService): ToolHandler {
  return async (input: Record<string, unknown>, context: ToolContext) => {
    const orderId = optionalString(input.orderId);
    if (!orderId) return { ok: false, error: "缺少 orderId（要取消的订单号）" };
    const confirm = input.confirm === true;
    const confirmationToken = optionalString(input.confirmationToken);
    if (confirm && !confirmationToken) {
      return { ok: false, error: "confirm=true 时必须提供 confirmationToken（来自阶段一）" };
    }
    return service.cancel(context, "restaurant", orderId, confirm, confirmationToken, optionalString(input.reason));
  };
}

/** 注册 restaurant-booking 全部工具到 ToolRegistry。 */
export function registerRestaurantBookingTools(registry: ToolRegistry, deps: RestaurantBookingModuleDeps): void {
  const { bookingService } = deps;
  registry.register("restaurant.search", createRestaurantSearchHandler(bookingService));
  registry.register("restaurant.book", createRestaurantBookHandler(bookingService));
  registry.register("restaurant.status", createRestaurantStatusHandler(bookingService));
  registry.register("restaurant.cancel", createRestaurantCancelHandler(bookingService));
}
