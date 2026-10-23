/**
 * 高德打车 Provider（BOOKING_MODE=live 时注册）。
 *
 * 两段能力，诚实降级：
 *   1. 估价（search）：高德 Web 服务公开 API——地理编码（v3/geocode/geo）+
 *      驾车路径规划（v3/direction/driving）拿距离/时长，按本地费率表出预估价。
 *      只需 RIDE_AMAP_WEB_KEY / AMAP_WEB_KEY。注意：预估价非平台实时报价。
 *   2. 真实下单（book/getStatus/cancel）：高德打车「企业版」开放 API
 *      （聚合多家网约车，需企业资质开通）。未配置
 *      RIDE_AMAP_ENTERPRISE_BASE_URL / TOKEN 时，book 返回明确错误而不是假装下单。
 *
 * 企业版端点契约以开放平台文档为准（base 可配置）：
 *   POST {base}/order/create  下单；POST {base}/order/query 查询；
 *   POST {base}/order/cancel  取消。统一 Authorization: Bearer <token>。
 */

import type {
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
import type { BookingConfig } from "../booking-config.js";

const GEOCODE_URL = "https://restapi.amap.com/v3/geocode/geo";
const DIRECTION_URL = "https://restapi.amap.com/v3/direction/driving";

/** 本地费率表（元）：与 simulated ride 同档，标注为预估价。 */
const FARE_TIERS: Array<{ id: string; title: string; base: number; perKm: number }> = [
  { id: "eco", title: "经济型", base: 12, perKm: 1.9 },
  { id: "comfort", title: "舒适型", base: 15, perKm: 2.5 },
  { id: "business", title: "商务型", base: 22, perKm: 3.4 },
];

/** 高德坐标串：`lng,lat`（注意经度在前）。 */
type Coord = string;

async function amapGetJson(url: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function amapPostJson(
  url: string,
  token: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { __httpStatus: res.status, ...data };
  } catch {
    return null;
  }
}

export class AmapRideProvider implements BookingProvider {
  readonly key = "amap";
  readonly domain = "ride" as const;
  readonly label = "高德打车（企业版聚合）";

  constructor(private readonly config: Pick<BookingConfig, "rideAmapWebKey" | "rideAmapEnterpriseBaseUrl" | "rideAmapEnterpriseToken">) {}

  availability(): { ok: boolean; reason?: string } {
    if (!this.config.rideAmapWebKey) {
      return { ok: false, reason: "未配置 RIDE_AMAP_WEB_KEY / AMAP_WEB_KEY（高德 Web 服务 key）" };
    }
    return { ok: true };
  }

  private enterpriseReady(): boolean {
    return Boolean(this.config.rideAmapEnterpriseBaseUrl && this.config.rideAmapEnterpriseToken);
  }

  private async geocode(address: string, city?: string): Promise<Coord | null> {
    const params = new URLSearchParams({
      key: this.config.rideAmapWebKey,
      address,
    });
    if (city) params.set("city", city);
    const data = await amapGetJson(`${GEOCODE_URL}?${params.toString()}`);
    if (!data || data.status !== "1") return null;
    const geocodes = data.geocodes as Array<{ location?: string }> | undefined;
    const location = geocodes?.[0]?.location;
    return location && /^\d+\.\d+,\d+\.\d+$/.test(location) ? location : null;
  }

  private coordFromClient(location: { longitude: number; latitude: number }): Coord {
    return `${location.longitude.toFixed(6)},${location.latitude.toFixed(6)}`;
  }

  /**
   * 半自动唤起链接（2026-09-18）：把起终点灌进高德叫车/导航页。
   * 真实代下单卡企业资质（见 book），资质开通前这是最短的"真实成交"路径——
   * Agent 查好真实路线与预估价，用户点链接唤起高德（Web/手机浏览器均可打开，
   * callnative=1 时手机端直接拉起高德 App 续行），不必重新输入起终点。
   */
  private buildHandoffUrl(origin: Coord, destination: Coord, pickupLabel: string, dropoffLabel: string): string {
    const params = new URLSearchParams({
      from: `${origin},${pickupLabel}`,
      to: `${destination},${dropoffLabel}`,
      mode: "car",
      coordinate: "gaode",
      callnative: "1",
      src: "nextbot",
    });
    return `https://uri.amap.com/navigation?${params.toString()}`;
  }

  async search(
    query: BookingSearchQuery,
    ctx: BookingProviderContext,
  ): Promise<BookingProviderResult<{ options: BookingOption[]; note?: string }>> {
    if (!this.availability().ok) {
      return { ok: false, error: this.availability().reason ?? "高德打车不可用" };
    }
    const pickupText = typeof query.params.pickup === "string" ? query.params.pickup.trim() : "";
    const dropoffText = typeof query.params.dropoff === "string" ? query.params.dropoff.trim() : "";
    if (!dropoffText) return { ok: false, error: "缺少 dropoff（目的地）", retryable: true };

    // 起点：显式地址 → 客户端 GPS 坐标
    let origin: Coord | null = null;
    let pickupLabel = pickupText;
    if (pickupText) {
      origin = await this.geocode(pickupText, query.city);
    } else if (ctx.location || query.location) {
      const loc = ctx.location ?? query.location;
      if (loc) {
        origin = this.coordFromClient(loc);
        pickupLabel = loc.label ?? "当前位置（GPS）";
      }
    }
    const destination = await this.geocode(dropoffText, query.city);
    if (!origin) {
      return {
        ok: false,
        error: "无法定位起点：请提供 pickup 地址，或确保客户端已上报 GPS 定位",
        retryable: true,
      };
    }
    if (!destination) {
      return { ok: false, error: `无法地理编码目的地「${dropoffText}」，请换更具体的地址`, retryable: true };
    }

    const dirParams = new URLSearchParams({
      key: this.config.rideAmapWebKey,
      origin,
      destination,
    });
    const dir = await amapGetJson(`${DIRECTION_URL}?${dirParams.toString()}`);
    if (!dir || dir.status !== "1") {
      return { ok: false, error: "高德路径规划失败（key 配额或网络）", retryable: true };
    }
    const paths = (dir.route as { paths?: Array<{ distance?: number; duration?: number }> } | undefined)?.paths;
    const path = paths?.[0];
    const distanceKm = path?.distance != null ? path.distance / 1000 : null;
    const durationMin = path?.duration != null ? Math.round(path.duration / 60) : null;
    if (distanceKm == null) {
      return { ok: false, error: "高德路径规划未返回距离", retryable: true };
    }

    const handoffUrl = this.buildHandoffUrl(origin, destination, pickupLabel, dropoffText);
    const options: BookingOption[] = FARE_TIERS.map((t) => {
      const amount = Math.round(t.base + t.perKm * distanceKm);
      return {
        id: t.id,
        provider: this.key,
        title: `${t.title}（预估 ¥${amount}）`,
        description: `${t.title} · ${distanceKm.toFixed(1)}km${durationMin ? ` · 车程约 ${durationMin} 分钟` : ""} · ${pickupLabel} → ${dropoffText}`,
        amountCny: amount,
        currency: "CNY" as const,
        etaMinutes: 5,
        durationMinutes: durationMin,
        extra: {
          carType: t.id,
          distanceKm: Number(distanceKm.toFixed(1)),
          origin,
          destination,
          estimate: true,
          estimateNote: "按本地费率表估算的预估价，非平台实时报价，以实际接单为准",
          handoffUrl,
        },
      };
    });
    return {
      ok: true,
      options,
      note: this.enterpriseReady()
        ? "价格为预估值；确认下单后将调用高德打车企业版 API 真实下单"
        : "价格为预估值；真实代下单需企业版资质（未配置 RIDE_AMAP_ENTERPRISE_BASE_URL/TOKEN）。" +
          "每个报价已附 handoffUrl 唤起链接，可引导用户一键打开高德 App 续行下单",
    };
  }

  async book(
    draft: BookingDraft,
    ctx: BookingProviderContext,
  ): Promise<BookingProviderResult<BookingProviderBookPayload>> {
    if (!this.enterpriseReady()) {
      const origin = typeof draft.params.origin === "string" ? draft.params.origin : "";
      const destination = typeof draft.params.destination === "string" ? draft.params.destination : "";
      const handoffHint =
        origin && destination
          ? "可改用报价时附带的 handoffUrl 唤起链接，让用户一键打开高德 App 完成下单。"
          : "可让用户重新报价（ride 报价附带 handoffUrl 唤起链接），一键打开高德 App 完成下单。";
      return {
        ok: false,
        error:
          "高德打车企业版下单接口未配置：需企业资质开通（lbs.amap.com 网约车开放平台）并设置 " +
          "RIDE_AMAP_ENTERPRISE_BASE_URL + RIDE_AMAP_ENTERPRISE_TOKEN。当前仅支持估价查询。" +
          handoffHint,
        retryable: false,
      };
    }
    // 起点/终点坐标由 BookingService 从报价 option.extra（origin/destination）
    // 并入 draft.params，避免下单时二次地理编码。
    const origin = typeof draft.params.origin === "string" ? draft.params.origin : undefined;
    const destination = typeof draft.params.destination === "string" ? draft.params.destination : undefined;
    if (!origin || !destination) {
      return { ok: false, error: "下单缺少起点/目的地坐标（请先 ride 报价再下单）", retryable: true };
    }
    const data = await amapPostJson(`${this.config.rideAmapEnterpriseBaseUrl}/order/create`, this.config.rideAmapEnterpriseToken, {
      origin,
      destination,
      carType: draft.optionId,
      passengerPhone: typeof draft.params.passengerPhone === "string" ? draft.params.passengerPhone : undefined,
      quoteId: draft.optionId,
      actorId: ctx.actorId,
    });
    if (!data) return { ok: false, error: "高德打车企业版下单请求失败（网络/超时）", retryable: true };
    const status = data.__httpStatus;
    const orderId = typeof data.orderId === "string" ? data.orderId : undefined;
    if (status !== 200 || !orderId) {
      return {
        ok: false,
        error: `高德打车下单失败：${String(data.message ?? data.errorMsg ?? `HTTP ${status}`)}`,
        retryable: true,
      };
    }
    return {
      ok: true,
      providerOrderId: orderId,
      status: "confirmed",
      paymentUrl: typeof data.payUrl === "string" ? data.payUrl : null,
      message: "高德打车已下单（企业版）",
      tracking: (data.driver as Record<string, unknown> | undefined) ?? undefined,
    };
  }

  async getStatus(
    ref: BookingProviderRef,
    _ctx: BookingProviderContext,
  ): Promise<BookingProviderResult<BookingProviderStatusPayload>> {
    if (!this.enterpriseReady()) {
      return { ok: false, error: "高德打车企业版未配置，无法查询真实订单" };
    }
    const data = await amapPostJson(`${this.config.rideAmapEnterpriseBaseUrl}/order/query`, this.config.rideAmapEnterpriseToken, {
      orderId: ref.providerOrderId,
    });
    if (!data) return { ok: false, error: "订单查询失败（网络/超时）", retryable: true };
    if (data.__httpStatus !== 200) {
      return { ok: false, error: `订单查询失败：HTTP ${String(data.__httpStatus)}`, retryable: true };
    }
    const raw = typeof data.status === "string" ? data.status : "";
    const mapped =
      raw === "completed" || raw === "finished"
        ? "completed"
        : raw === "cancelled"
          ? "cancelled"
          : raw === "in_trip" || raw === "in_progress"
            ? "in_progress"
            : "confirmed";
    return {
      ok: true,
      status: mapped,
      message: typeof data.message === "string" ? data.message : undefined,
      tracking: (data.driver as Record<string, unknown> | undefined) ?? undefined,
    };
  }

  async cancel(
    ref: BookingProviderRef,
    reason: string | undefined,
    _ctx: BookingProviderContext,
  ): Promise<BookingProviderResult<{ message?: string }>> {
    if (!this.enterpriseReady()) {
      return { ok: false, error: "高德打车企业版未配置，无法取消真实订单" };
    }
    const data = await amapPostJson(`${this.config.rideAmapEnterpriseBaseUrl}/order/cancel`, this.config.rideAmapEnterpriseToken, {
      orderId: ref.providerOrderId,
      reason,
    });
    if (!data) return { ok: false, error: "取消请求失败（网络/超时）", retryable: true };
    if (data.__httpStatus !== 200) {
      return { ok: false, error: `取消失败：HTTP ${String(data.__httpStatus)}`, retryable: true };
    }
    return { ok: true, message: "高德打车订单已取消" };
  }
}
