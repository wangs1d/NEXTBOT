import type { ToolHandler, ToolContext, ToolRegistry } from "../../tool-registry.js";
import type { BookingService } from "../../../services/booking/booking-service.js";
import { travelPlanStore } from "../../../skills/travel-planning/travel-plan-store.js";

/**
 * travel_booking.* 工具 handler 工厂集合 + 注册入口。
 *
 * 返回契约与 ride-hailing 一致：
 *   - 成功：`{ ok: true, summary, ... }`
 *   - 失败：`{ ok: false, error, retryable? }`
 *
 * search 的 params 口径与 TravelTicketProvider.buildQuoteRequest 对齐
 * （type/from/to/city/code/departTime/checkInDate/checkOutDate/hotelName/tier/seat/basePriceCny）。
 */

export interface TravelBookingModuleDeps {
  bookingService: BookingService;
}

function str(input: Record<string, unknown>, key: string): string | undefined {
  const v = input[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function num(input: Record<string, unknown>, key: string): number | undefined {
  const v = input[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function travelParams(input: Record<string, unknown>): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  const type = str(input, "type");
  if (type) params.type = type;
  for (const key of ["from", "to", "city", "code", "departTime", "checkInDate", "checkOutDate", "hotelName", "tier", "seat", "cashierUrl"]) {
    const v = str(input, key);
    if (v) params[key] = v;
  }
  const base = num(input, "basePriceCny");
  if (base != null) params.basePriceCny = base;
  return params;
}

/**
 * 满意门（travel 主线 F5，预订后置）：用户说满意了才谈预订。
 *
 * 拦的是「刚排完一版就顺手下单」——规划轮用户大概率还要改（换酒店/挪景点），
 * 此时报价→确认→扣款走完，改一版就得退改。判据只认「这个城市 2 小时内刚规划
 * 过、且那版还没定稿」：单独订酒店（没规划过）与改订已定稿行程都不拦，
 * 避免把闸门变成对所有预订的无差别阻拦。
 *
 * @returns 需要用户先表态时返回阶段一拒绝回执；放行时返回 null。
 */
export function satisfactionGate(input: Record<string, unknown>): Record<string, unknown> | null {
  const type = str(input, "type");
  if (type !== "flight" && type !== "train" && type !== "hotel") return null;
  const city = str(input, "city") ?? (type === "hotel" ? str(input, "to") : undefined);
  if (!city) return null;
  const plan = travelPlanStore.findRecentForDestination(city);
  if (!plan || plan.status === "approved") return null;
  return {
    ok: false,
    needApproval: true,
    planId: plan.planId,
    destination: plan.destination,
    summary:
      `「${plan.destination}」这版行程（${plan.title}）用户还没确认满意，先不下单。` +
      "把方案讲回给用户、问要不要改；用户明确说满意/就按这个订之后，" +
      "先调 travel.approve-plan 定稿，再回来报价下单。",
    error: "行程未定稿（满意门）：需用户先确认方案",
  };
}

/** travel_booking.search —— 多源报价比价。 */
export function createTravelSearchHandler(service: BookingService): ToolHandler {
  return async (input: Record<string, unknown>, context: ToolContext) => {
    const type = str(input, "type");
    if (type !== "flight" && type !== "train" && type !== "hotel") {
      return { ok: false, error: "type 必须是 flight / train / hotel" };
    }
    const gate = satisfactionGate(input);
    if (gate) return gate;
    const params = travelParams(input);
    const city = str(input, "city") ?? (type === "hotel" ? str(input, "to") : undefined);
    const scheduleAt = type === "hotel" ? str(input, "checkInDate") : str(input, "departTime");
    return service.search(
      context,
      "travel",
      { city, scheduleAt: scheduleAt ?? null, params },
      str(input, "provider"),
    );
  };
}

/** travel_booking.book —— 两阶段确认下单（创建待支付订单）。 */
export function createTravelBookHandler(service: BookingService): ToolHandler {
  return async (input: Record<string, unknown>, context: ToolContext) => {
    const optionId = str(input, "optionId");
    if (!optionId) return { ok: false, error: "缺少 optionId（来自 travel_booking.search 的选项 id）" };
    const type = str(input, "type");
    if (type !== "flight" && type !== "train" && type !== "hotel") {
      return { ok: false, error: "type 必须是 flight / train / hotel" };
    }
    const gate = satisfactionGate(input);
    if (gate) return gate;
    const confirm = input.confirm === true;
    const confirmationToken = str(input, "confirmationToken");
    if (confirm && !confirmationToken) {
      return { ok: false, error: "confirm=true 时必须提供 confirmationToken（来自阶段一）" };
    }
    const params = travelParams(input);
    const city = str(input, "city") ?? (type === "hotel" ? str(input, "to") : undefined);
    const scheduleAt = type === "hotel" ? str(input, "checkInDate") : str(input, "departTime");
    return service.book(context, "travel", {
      optionId,
      params,
      city,
      scheduleAt: scheduleAt ?? null,
      confirm,
      confirmationToken,
    });
  };
}

/** travel_booking.status —— 订单状态。 */
export function createTravelStatusHandler(service: BookingService): ToolHandler {
  return async (input: Record<string, unknown>, context: ToolContext) => {
    return service.getStatus(context, "travel", str(input, "orderId"));
  };
}

/** travel_booking.cancel —— 两阶段确认取消（未出票订单）。 */
export function createTravelCancelHandler(service: BookingService): ToolHandler {
  return async (input: Record<string, unknown>, context: ToolContext) => {
    const orderId = str(input, "orderId");
    if (!orderId) return { ok: false, error: "缺少 orderId（要取消的订单号）" };
    const confirm = input.confirm === true;
    const confirmationToken = str(input, "confirmationToken");
    if (confirm && !confirmationToken) {
      return { ok: false, error: "confirm=true 时必须提供 confirmationToken（来自阶段一）" };
    }
    return service.cancel(context, "travel", orderId, confirm, confirmationToken, str(input, "reason"));
  };
}

/** travel_booking.refund —— 已支付/已出票订单退改工单（两阶段确认，真实退改在原平台办理）。 */
export function createTravelRefundHandler(service: BookingService): ToolHandler {
  return async (input: Record<string, unknown>, context: ToolContext) => {
    const orderId = str(input, "orderId");
    if (!orderId) return { ok: false, error: "缺少 orderId（要退改的订单号）" };
    const kind = str(input, "kind");
    if (kind !== "refund" && kind !== "change") {
      return { ok: false, error: "kind 必须是 refund（退票）/ change（改签）" };
    }
    const confirm = input.confirm === true;
    const confirmationToken = str(input, "confirmationToken");
    if (confirm && !confirmationToken) {
      return { ok: false, error: "confirm=true 时必须提供 confirmationToken（来自阶段一）" };
    }
    return service.requestRefund(context, "travel", orderId, {
      kind,
      reason: str(input, "reason"),
      confirm,
      confirmationToken,
    });
  };
}

/** 注册 travel-booking 全部工具到 ToolRegistry。 */
export function registerTravelBookingTools(registry: ToolRegistry, deps: TravelBookingModuleDeps): void {
  const { bookingService } = deps;
  registry.register("travel_booking.search", createTravelSearchHandler(bookingService));
  registry.register("travel_booking.book", createTravelBookHandler(bookingService));
  registry.register("travel_booking.status", createTravelStatusHandler(bookingService));
  registry.register("travel_booking.cancel", createTravelCancelHandler(bookingService));
  registry.register("travel_booking.refund", createTravelRefundHandler(bookingService));
}
