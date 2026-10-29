/**
 * 模拟本地生活 Provider：家政（home_service）与餐厅（restaurant）。
 *
 * 与 SimulatedRideProvider 同理：BOOKING_MODE=mock 下打通
 * search → book（两阶段确认）→ status → cancel / reschedule 全链路，
 * 所有结果带 simulated=true，不产生真实订单。
 */

import { randomBytes } from "node:crypto";

import type {
  BookingDomain,
  BookingDraft,
  BookingOption,
  BookingProvider,
  BookingProviderContext,
  BookingProviderRef,
  BookingProviderResult,
  BookingProviderBookPayload,
  BookingProviderStatusPayload,
  BookingSearchQuery,
} from "../booking-provider.js";

interface SimulatedOrder {
  providerOrderId: string;
  createdAt: number;
  cancelled: boolean;
  scheduleAt: string | null;
}

abstract class SimulatedLocalProviderBase {
  readonly key = "simulated";
  abstract readonly domain: BookingDomain;
  protected readonly orders = new Map<string, SimulatedOrder>();
  protected readonly now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? (() => Date.now());
  }

  availability(): { ok: true } {
    return { ok: true };
  }

  protected orderSuffix(): string {
    return this.domain === "home_service" ? "HOME" : "REST";
  }

  async book(
    _draft: BookingDraft,
    _ctx: BookingProviderContext,
  ): Promise<BookingProviderResult<BookingProviderBookPayload>> {
    const providerOrderId = `SIM-${this.orderSuffix()}-${randomBytes(4).toString("hex").toUpperCase()}`;
    this.orders.set(providerOrderId, {
      providerOrderId,
      createdAt: this.now(),
      cancelled: false,
      scheduleAt: _draft.scheduleAt ?? null,
    });
    return {
      ok: true,
      providerOrderId,
      status: "confirmed",
      message: "模拟下单成功（沙盒）",
      tracking: { simulated: true, contact: "模拟服务商 400-000-0000" },
    };
  }

  async getStatus(
    ref: BookingProviderRef,
    _ctx: BookingProviderContext,
  ): Promise<BookingProviderResult<BookingProviderStatusPayload>> {
    const order = this.orders.get(ref.providerOrderId);
    if (!order) return { ok: false, error: "模拟订单不存在" };
    if (order.cancelled) return { ok: true, status: "cancelled", message: "已取消（模拟）" };
    // 模拟生命周期：服务时间前 = confirmed，超过服务时间 2 小时 = completed
    if (order.scheduleAt) {
      const doneAt = Date.parse(order.scheduleAt) + 2 * 60 * 60 * 1000;
      if (Number.isFinite(doneAt) && this.now() >= doneAt) {
        return { ok: true, status: "completed", message: "服务已完成（模拟）" };
      }
      return { ok: true, status: "confirmed", message: `已确认，服务时间 ${order.scheduleAt}（模拟）` };
    }
    return { ok: true, status: "confirmed", message: "已确认（模拟）" };
  }

  async cancel(
    ref: BookingProviderRef,
    _reason: string | undefined,
    _ctx: BookingProviderContext,
  ): Promise<BookingProviderResult<{ message?: string }>> {
    const order = this.orders.get(ref.providerOrderId);
    if (!order) return { ok: false, error: "模拟订单不存在" };
    if (order.cancelled) return { ok: false, error: "订单已是取消状态" };
    order.cancelled = true;
    return { ok: true, message: "已取消（模拟）" };
  }

  async reschedule(
    ref: BookingProviderRef,
    scheduleAt: string,
    _ctx: BookingProviderContext,
  ): Promise<BookingProviderResult<{ message?: string }>> {
    const order = this.orders.get(ref.providerOrderId);
    if (!order) return { ok: false, error: "模拟订单不存在" };
    if (order.cancelled) return { ok: false, error: "订单已取消，无法改期" };
    order.scheduleAt = scheduleAt;
    return { ok: true, message: `已改期至 ${scheduleAt}（模拟）` };
  }
}

// --------------------------------------------------------------------------- //
// 家政 / 本地生活
// --------------------------------------------------------------------------- //

export const HOME_SERVICE_TYPES = ["cleaning", "repair", "moving", "beauty", "pet"] as const;
export type HomeServiceType = (typeof HOME_SERVICE_TYPES)[number];

const HOME_SERVICE_PACKAGES: Record<HomeServiceType, Array<{ id: string; title: string; amountCny: number; durationMinutes: number }>> = {
  cleaning: [
    { id: "clean-basic", title: "日常保洁 2 小时", amountCny: 120, durationMinutes: 120 },
    { id: "clean-deep", title: "深度保洁 4 小时", amountCny: 260, durationMinutes: 240 },
    { id: "clean-movein", title: "开荒保洁 6 小时", amountCny: 420, durationMinutes: 360 },
  ],
  repair: [
    { id: "repair-visit", title: "上门检修（小时工）", amountCny: 100, durationMinutes: 60 },
    { id: "repair-plumber", title: "管道疏通", amountCny: 180, durationMinutes: 90 },
  ],
  moving: [
    { id: "moving-small", title: "小件搬家（面包车）", amountCny: 220, durationMinutes: 180 },
    { id: "moving-truck", title: "整居搬家（厢式货车）", amountCny: 680, durationMinutes: 300 },
  ],
  beauty: [
    { id: "beauty-home", title: "上门美发", amountCny: 128, durationMinutes: 60 },
    { id: "beauty-manicure", title: "上门美甲", amountCny: 158, durationMinutes: 90 },
  ],
  pet: [
    { id: "pet-feed", title: "宠物上门喂养（单次）", amountCny: 60, durationMinutes: 30 },
    { id: "pet-groom", title: "宠物上门洗护", amountCny: 200, durationMinutes: 120 },
  ],
};

export class SimulatedHomeServiceProvider extends SimulatedLocalProviderBase implements BookingProvider {
  readonly domain = "home_service" as const;
  readonly label = "模拟家政/本地生活（沙盒）";

  async search(
    query: BookingSearchQuery,
    _ctx: BookingProviderContext,
  ): Promise<BookingProviderResult<{ options: BookingOption[]; note?: string }>> {
    const raw = typeof query.params.serviceType === "string" ? query.params.serviceType.trim() : "";
    const serviceType = (HOME_SERVICE_TYPES as readonly string[]).includes(raw)
      ? (raw as HomeServiceType)
      : null;
    if (!serviceType) {
      return {
        ok: false,
        error: `缺少或非法 serviceType（家政类型）。可选：${HOME_SERVICE_TYPES.join("/")}`,
        retryable: true,
      };
    }
    const address = typeof query.params.address === "string" ? query.params.address.trim() : "";
    const packages = HOME_SERVICE_PACKAGES[serviceType];
    const options: BookingOption[] = packages.map((p) => ({
      id: p.id,
      provider: this.key,
      title: `${p.title}（模拟 ¥${p.amountCny}）`,
      description: `${p.title} · 时长约 ${p.durationMinutes / 60} 小时${address ? ` · 上门地址：${address}` : ""}`,
      amountCny: p.amountCny,
      currency: "CNY",
      durationMinutes: p.durationMinutes,
      scheduleAt: query.scheduleAt ?? null,
      simulated: true,
      extra: { serviceType, simulatedNote: "模拟套餐，非真实平台报价" },
    }));
    return {
      ok: true,
      options,
      note: "模拟模式（BOOKING_MODE=mock）：套餐为确定性模拟数据，不会真实下单或扣费",
    };
  }
}

// --------------------------------------------------------------------------- //
// 餐厅预订
// --------------------------------------------------------------------------- //

const SIMULATED_RESTAURANTS = [
  { id: "rest-001", name: "外婆家（模拟）", cuisine: "江浙菜", perCapita: 70 },
  { id: "rest-002", name: "海底捞（模拟）", cuisine: "火锅", perCapita: 130 },
  { id: "rest-003", name: "绿茶餐厅（模拟）", cuisine: "融合菜", perCapita: 65 },
  { id: "rest-004", name: "肯德基（模拟）", cuisine: "快餐", perCapita: 35 },
];

export class SimulatedRestaurantProvider extends SimulatedLocalProviderBase implements BookingProvider {
  readonly domain = "restaurant" as const;
  readonly label = "模拟餐厅预订（沙盒）";

  async search(
    query: BookingSearchQuery,
    _ctx: BookingProviderContext,
  ): Promise<BookingProviderResult<{ options: BookingOption[]; note?: string }>> {
    const keyword = typeof query.params.query === "string" ? query.params.query.trim() : "";
    const cuisine = typeof query.params.cuisine === "string" ? query.params.cuisine.trim() : "";
    const coversRaw = Number(query.params.covers);
    const covers = Number.isFinite(coversRaw) && coversRaw > 0 ? Math.floor(coversRaw) : 2;
    const dineAt = typeof query.params.dineAt === "string" ? query.params.dineAt : query.scheduleAt ?? null;

    const matched = SIMULATED_RESTAURANTS.filter((r) => {
      if (cuisine && !r.cuisine.includes(cuisine) && !r.name.includes(cuisine)) return false;
      if (keyword && !r.name.includes(keyword) && !r.cuisine.includes(keyword)) return false;
      return true;
    });
    // 过滤不中就返回空：把全量样例当结果回吐，会让「自助餐」拿到四家非自助店
    if (matched.length === 0) {
      const wanted = [cuisine, keyword].filter(Boolean).join("「」「");
      return {
        ok: true,
        options: [],
        note:
          `模拟库（BOOKING_MODE=mock，仅 ${SIMULATED_RESTAURANTS.length} 家样例）里没有匹配「${wanted}」的餐厅。` +
          "这不是「附近没有」，是数据源本身没有——请如实告知用户当前未接真实门店数据。",
      };
    }

    const options: BookingOption[] = matched.slice(0, 4).map((r) => ({
      id: r.id,
      provider: this.key,
      title: `${r.name} · ${r.cuisine} · 人均 ¥${r.perCapita}`,
      description: `${covers} 人用餐${dineAt ? ` · ${dineAt}` : ""}（模拟可订）`,
      amountCny: r.perCapita * covers, // 预估消费（到店付）
      currency: "CNY",
      scheduleAt: dineAt,
      simulated: true,
      extra: { covers, perCapita: r.perCapita, payAtStore: true, simulatedNote: "模拟餐厅，非真实平台数据" },
    }));
    return {
      ok: true,
      options,
      note: "模拟模式（BOOKING_MODE=mock）：餐厅为确定性模拟数据，不会真实占座",
    };
  }
}
