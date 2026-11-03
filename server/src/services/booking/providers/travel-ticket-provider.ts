import type {
  BookingDraft,
  BookingOption,
  BookingProvider,
  BookingProviderBookPayload,
  BookingProviderContext,
  BookingProviderRef,
  BookingProviderResult,
  BookingProviderStatusPayload,
  BookingSearchQuery,
} from "../booking-provider.js";
import { pricingService, type PricingContext } from "../../../skills/travel-planning/pricing-service.js";
import type { QuoteAggregator, QuoteRequest, TravelQuote } from "../quote/index.js";

/**
 * travel 域预订 Provider —— 机票 / 火车票 / 酒店的「Agent 代办 + 真实支付」闭环。
 *
 * 与 ride/home_service/restaurant 模拟 Provider 的差别：本 provider 是
 * 预订闭环的真实履约链路，真实性边界如下（必须如实向用户转述）：
 *
 *   - 价格：hotel 用 PricingService（本地价格库 / POI 覆盖，quote 自带
 *     priceSource 标注）；flight / train 缺实时报价 API 时以调用方给的
 *     basePriceCny 为基准，priceSource=estimated，提示以平台实价为准
 *   - 下单：book 创建「待支付」订单（pending_payment）。若调用方带
 *     cashierUrl（商家收银台链接 / 支付订单串）直接作为 paymentUrl 透出
 *   - 支付：真实扣款走支付宝 AI 支付通道 —— booking.travel-pay skill 用
 *     当前用户自己的钱包（alipay.check-wallet → submit-payment →
 *     query-payment 轮询）完成支付后把订单推进为 confirmed
 *   - 出票：booking.travel-issue 确认出票后订单进入 in_progress，票务写
 *     入 travelTicketStore 票夹（到站监控 / 接站 / 到站打车闭环的数据源）
 */

export type TravelBookingType = "flight" | "train" | "hotel";

interface TravelProviderOrderState {
  status: "pending_payment" | "confirmed" | "in_progress" | "completed" | "cancelled" | "failed";
  ticketId?: string;
  paidAt?: string;
  issuedAt?: string;
  tracking?: Record<string, unknown>;
}

function newTravelOrderId(now = new Date()): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `tt_${now.getTime().toString(36)}_${rand}`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function str(input: Record<string, unknown>, key: string): string {
  const v = input[key];
  return typeof v === "string" ? v.trim() : "";
}

function numOrNull(input: Record<string, unknown>, key: string): number | null {
  const v = input[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

export class TravelTicketProvider implements BookingProvider {
  readonly key = "travel-agent";
  readonly domain = "travel" as const;
  readonly label = "旅行票务代办（支付宝 AI 支付）";

  /** providerOrderId → 状态（进程内；本地权威快照在 BookingOrderStore） */
  private readonly states = new Map<string, TravelProviderOrderState>();

  /**
   * 实时报价比价聚合器（可选注入）。
   * 有 → search 走多源比价（local 保底 + MCP/浏览器实时源）；
   * 无 → 回退本地价格库/基准价估算（原行为，测试与最小部署可用）。
   */
  private readonly quoteAggregator: QuoteAggregator | null;

  constructor(deps: { quoteAggregator?: QuoteAggregator | null } = {}) {
    this.quoteAggregator = deps.quoteAggregator ?? null;
  }

  availability(): { ok: boolean; reason?: string } {
    // 无外部 API 依赖：价格来自报价聚合层（本地价格库保底），支付走用户自己的支付宝钱包
    return { ok: true };
  }

  async search(
    query: BookingSearchQuery,
    ctx: BookingProviderContext,
  ): Promise<BookingProviderResult<{ options: BookingOption[]; note?: string }>> {
    const params = query.params ?? {};
    const type = this.resolveType(params.type);
    if (!type) {
      return { ok: false, error: "缺少 type（flight / train / hotel）", retryable: true };
    }

    // 聚合层可用 → 多源比价（local 源内部即原 PricingService/基准价逻辑）
    if (this.quoteAggregator && ctx.toolContext) {
      const req = this.buildQuoteRequest(type, query, params);
      const agg = await this.quoteAggregator.aggregate(req, ctx.toolContext);
      if (agg.ok) {
        return {
          ok: true,
          options: agg.quotes.map((q) => this.quoteToOption(q)),
          note: agg.note,
        };
      }
      // 聚合层无结果：如实回退（本地估算仍可能给出选项）
      const fallback =
        type === "hotel"
          ? await this.searchHotel(query, params)
          : await this.searchTransport(type, params);
      if (fallback.ok && fallback.options.length > 0) {
        const notes = [fallback.note, agg.note ? `比价源无结果：${agg.note}` : ""].filter(Boolean);
        return {
          ok: true,
          options: fallback.options,
          note: notes.join("；") || undefined,
        };
      }
      return fallback;
    }

    if (type === "hotel") {
      return this.searchHotel(query, params);
    }
    return this.searchTransport(type, params);
  }

  /** BookingSearchQuery.params → QuoteRequest（字段口径与原 searchHotel/searchTransport 对齐）。 */
  private buildQuoteRequest(
    type: "flight" | "train" | "hotel",
    query: BookingSearchQuery,
    params: Record<string, unknown>,
  ): QuoteRequest {
    if (type === "hotel") {
      const tierRaw = str(params, "tier");
      const sortRaw = str(params, "sort");
      const sort =
        sortRaw === "price_asc" || sortRaw === "price_desc" || sortRaw === "rate_desc" || sortRaw === "distance_asc"
          ? sortRaw
          : undefined;
      return {
        type: "hotel",
        city: str(params, "city") || query.city || "",
        to: str(params, "city") || query.city || "",
        hotelName: str(params, "hotelName") || str(params, "hotel") || undefined,
        checkInDate: str(params, "checkInDate") || str(params, "checkIn") || query.scheduleAt || "",
        checkOutDate: str(params, "checkOutDate") || str(params, "checkOut") || "",
        // 档次只在用户明确表达时生效——通用查询不默认按 mid 收窄结果
        ...(tierRaw === "budget" || tierRaw === "mid" || tierRaw === "luxury" ? { tier: tierRaw } : {}),
        // 用户当次表达的筛选原样透传（靠海/商圈/星级/民宿/价格上限/排序），没提就是 undefined
        filters: {
          keywords: str(params, "keywords") || undefined,
          poiName: str(params, "poiName") || undefined,
          hotelStars: str(params, "hotelStars") || undefined,
          hotelTypes: str(params, "hotelTypes") || undefined,
          maxPrice: numOrNull(params, "maxPrice") ?? undefined,
          ...(sort ? { sort } : {}),
        },
      };
    }
    return {
      type,
      code: str(params, "code") || str(params, type === "flight" ? "flightNo" : "trainNo") || undefined,
      from: str(params, "from") || str(params, "fromStation") || str(params, "fromCity") || undefined,
      to: str(params, "to") || str(params, "toStation") || str(params, "toCity") || undefined,
      departTime: str(params, "departTime") || query.scheduleAt || undefined,
      seat: str(params, "seat") || str(params, "seatClass") || undefined,
      basePriceCny: numOrNull(params, "basePriceCny") ?? numOrNull(params, "price") ?? undefined,
    };
  }

  /** TravelQuote → BookingOption（id 不含金额：两阶段确认会重新报价，价格波动时仍能按 id 匹配到最新价）。 */
  private quoteToOption(q: TravelQuote): BookingOption {
    const nights = q.nights && q.nights > 1 ? q.nights : 1;
    const amount = Math.round(q.amountCny * nights);
    const nameKey = q.code ?? q.name ?? "";
    return {
      id: `quote:${q.source}:${q.type}:${nameKey}:${q.seat ?? ""}:${q.checkInDate ?? q.departTime ?? ""}`.replace(/\s+/g, "_"),
      provider: this.key,
      title:
        q.type === "hotel"
          ? `${q.name ?? "酒店"}${q.seat ? `（${q.seat}）` : ""}${nights > 1 ? ` ${nights} 晚` : ""}`
          : `${q.type === "flight" ? "航班" : "车次"} ${nameKey}${q.from && q.to ? ` ${q.from}→${q.to}` : ""}${q.seat ? ` ${q.seat}` : ""}`,
      description: [
        q.departTime ? `出发 ${q.departTime}` : "",
        q.arriveTime ? `到达 ${q.arriveTime}` : "",
        q.note ?? "",
        nights > 1 ? `¥${q.amountCny}/晚 × ${nights} 晚` : "",
      ]
        .filter(Boolean)
        .join("，"),
      amountCny: amount,
      currency: "CNY",
      validUntil: null,
      scheduleAt: q.departTime || q.checkInDate || null,
      extra: {
        type: q.type,
        code: q.code,
        name: q.name,
        from: q.from,
        to: q.to,
        departTime: q.departTime,
        arriveTime: q.arriveTime,
        seat: q.seat,
        nights,
        quoteSource: q.source,
        quoteSourceLabel: q.sourceLabel,
        priceSource: q.priceSource,
        priceNote: q.note,
        bookingUrl: q.bookingUrl,
        mainPicUrl: q.mainPicUrl,
        rating: q.rating,
      },
    };
  }

  /** 酒店：价格走 PricingService（本地价格库 + POI 覆盖，来源标注在 quote.note）。 */
  private searchHotel(
    query: BookingSearchQuery,
    params: Record<string, unknown>,
  ): Promise<BookingProviderResult<{ options: BookingOption[]; note?: string }>> {
    const city = str(params, "city") || query.city || "";
    const hotelName = str(params, "hotelName") || str(params, "hotel") || `${city || "目的地"}酒店`;
    if (!city && !hotelName) {
      return Promise.resolve({ ok: false, error: "缺少 city 或 hotelName（酒店查询目的地）", retryable: true });
    }
    const checkIn = str(params, "checkInDate") || str(params, "checkIn") || query.scheduleAt || "";
    const checkOut = str(params, "checkOutDate") || str(params, "checkOut") || "";
    const tierRaw = str(params, "tier");
    const tier = tierRaw === "budget" || tierRaw === "luxury" ? tierRaw : "mid";

    const ctx: PricingContext = {
      destination: city || hotelName,
      preferences: { hotelTier: tier },
      startDate: checkIn || undefined,
    };
    const quote = pricingService.quoteHotel(hotelName, ["酒店"], ctx);
    const nights = this.nightsBetween(checkIn, checkOut);
    const perNight = quote.finalPrice;
    const amount = nights > 1 ? Math.round(perNight * nights) : perNight;
    const option: BookingOption = {
      id: `hotel:${hotelName}`,
      provider: this.key,
      title: `${hotelName}（${tier === "budget" ? "经济型" : tier === "luxury" ? "高档" : "舒适型"}）`,
      description: [
        checkIn ? `入住 ${checkIn}` : "",
        checkOut ? `退房 ${checkOut}` : "",
        nights > 1 ? `${nights} 晚` : "",
        quote.note ?? "",
      ].filter(Boolean).join("，"),
      amountCny: amount,
      currency: "CNY",
      validUntil: null,
      scheduleAt: checkIn || null,
      extra: {
        type: "hotel" as const,
        city,
        hotelName,
        checkInDate: checkIn || undefined,
        checkOutDate: checkOut || undefined,
        priceSource: quote.priceSource,
        perNightCny: perNight,
        priceNote: quote.note,
      },
    };
    return Promise.resolve({
      ok: true,
      options: [option],
      note: `价格来源：${quote.priceSource === "estimated" ? "估算（以平台实价为准）" : "本地价格库"}，最终以下单页为准`,
    });
  }

  /** 机票 / 火车票：无实时报价 API 时按调用方基准价估算，如实标注。 */
  private searchTransport(
    type: "flight" | "train",
    params: Record<string, unknown>,
  ): Promise<BookingProviderResult<{ options: BookingOption[]; note?: string }>> {
    const code = str(params, "code") || str(params, type === "flight" ? "flightNo" : "trainNo");
    if (!code) {
      return Promise.resolve({
        ok: false,
        error: `缺少 code（${type === "flight" ? "航班号如 MU5107" : "车次如 G1027"}）`,
        retryable: true,
      });
    }
    const from = str(params, "from") || str(params, "fromStation") || str(params, "fromCity");
    const to = str(params, "to") || str(params, "toStation") || str(params, "toCity");
    const departTime = str(params, "departTime") || "";
    const seat = str(params, "seat") || str(params, "seatClass") || (type === "flight" ? "经济舱" : "二等座");
    const basePrice = numOrNull(params, "basePriceCny") ?? numOrNull(params, "price");
    if (basePrice == null) {
      return Promise.resolve({
        ok: false,
        error: "缺少 basePriceCny（查询时未接入实时报价，需要用户提供基准票价，或先用搜索确认价格）",
        retryable: true,
      });
    }
    const label = type === "flight" ? "航班" : "车次";
    const option: BookingOption = {
      id: `${type}:${code}:${departTime}`,
      provider: this.key,
      title: `${label} ${code} ${from ? `${from}→${to}` : ""}${seat ? ` ${seat}` : ""}`.replace(/\s+/g, " ").trim(),
      description: [departTime ? `出发 ${departTime}` : "", "价格按你提供的基准价估算"].filter(Boolean).join("，"),
      amountCny: basePrice,
      currency: "CNY",
      scheduleAt: departTime || null,
      extra: {
        type,
        code,
        from,
        to,
        departTime: departTime || undefined,
        seat,
        priceSource: "estimated",
      },
    };
    return Promise.resolve({
      ok: true,
      options: [option],
      note: "票价为按基准价估算（未接实时报价 API），支付前会再向你确认金额",
    });
  }

  async book(draft: BookingDraft): Promise<BookingProviderResult<BookingProviderBookPayload>> {
    const params = isRecord(draft.params) ? draft.params : {};
    const cashierUrl = str(params, "cashierUrl") || str(params, "paymentLink");
    const providerOrderId = newTravelOrderId();
    const state: TravelProviderOrderState = {
      status: "pending_payment",
      tracking: { type: str(params, "type") || undefined, code: str(params, "code") || undefined },
    };
    this.states.set(providerOrderId, state);
    this.pruneStates();

    return {
      ok: true,
      providerOrderId,
      status: "pending_payment",
      paymentUrl: cashierUrl || null,
      message: cashierUrl
        ? "订单已创建（待支付）。可直接打开发起支付宝 AI 支付（booking.travel-pay），或把收银台链接交给用户手动支付"
        : "订单已创建（待支付）。需提供商家收银台链接/订单串后用 booking.travel-pay 发起支付宝 AI 支付（从用户本人支付宝真实扣款）",
      tracking: state.tracking,
    };
  }

  async getStatus(ref: BookingProviderRef): Promise<BookingProviderResult<BookingProviderStatusPayload>> {
    const state = this.states.get(ref.providerOrderId);
    if (!state) {
      // 进程重启后状态丢失：交由 BookingService 回退本地订单快照
      return { ok: true, message: "provider 状态不可用（本地快照为准）" };
    }
    return { ok: true, status: state.status, message: undefined, tracking: state.tracking };
  }

  async cancel(ref: BookingProviderRef, reason?: string): Promise<BookingProviderResult<{ message?: string }>> {
    const state = this.states.get(ref.providerOrderId);
    if (!state) {
      return { ok: true, message: "provider 无状态记录（订单可能来自重启前），以本地取消为准" };
    }
    if (state.status === "in_progress" || state.status === "completed") {
      return { ok: false, error: "订单已出票，退改需到原平台办理，Agent 不代办已出票订单的退改" };
    }
    state.status = "cancelled";
    return { ok: true, message: reason ? `已取消（${reason}）` : "已取消" };
  }

  // ------------------------------------------------------------------ //
  // 支付 / 出票推进（由 booking.travel-pay / booking.travel-issue 调用）
  // ------------------------------------------------------------------ //

  /** 支付成功推进：pending_payment → confirmed。 */
  markPaid(providerOrderId: string, paidAt = new Date().toISOString()): boolean {
    const state = this.states.get(providerOrderId);
    if (!state) return false;
    state.status = "confirmed";
    state.paidAt = paidAt;
    return true;
  }

  /** 出票确认推进：confirmed → in_progress，并携带票夹 ticketId。 */
  markIssued(providerOrderId: string, ticketId: string): boolean {
    const state = this.states.get(providerOrderId);
    if (!state) return false;
    state.status = "in_progress";
    state.issuedAt = new Date().toISOString();
    state.ticketId = ticketId;
    state.tracking = { ...state.tracking, ticketId };
    return true;
  }

  get(providerOrderId: string): TravelProviderOrderState | null {
    return this.states.get(providerOrderId) ?? null;
  }

  /** 进程内状态表封顶（重启即清，本地订单快照在 BookingOrderStore）。 */
  private pruneStates(): void {
    while (this.states.size > 500) {
      const oldest = this.states.keys().next().value;
      if (!oldest) break;
      this.states.delete(oldest);
    }
  }

  private nightsBetween(checkIn: string, checkOut: string): number {
    if (!checkIn || !checkOut) return 1;
    const a = Date.parse(checkIn.replace(" ", "T"));
    const b = Date.parse(checkOut.replace(" ", "T"));
    if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return 1;
    return Math.max(1, Math.round((b - a) / 86_400_000));
  }

  private resolveType(v: unknown): TravelBookingType | null {
    if (v === "flight" || v === "train" || v === "hotel") return v;
    return null;
  }
}
