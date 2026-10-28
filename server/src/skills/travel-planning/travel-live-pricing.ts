/**
 * 行程实时计价（2026-10-25）
 *
 * 背景：行程里的价格长期由 PricingService 的静态基价表给出（默认酒店 280/560/1480、
 * 景点 60、餐饮 100），同一目的地每条价格完全一样——用户一眼看出是假数据。
 * 本模块把真实数据源接进规划链路：
 *   - 景点门票：飞猪 FlyAI search-poi 的 ticketInfo.price（附景点官方简介）
 *   - 酒店房价：飞猪 FlyAI search-hotel（同名酒店实时价；同名查不到时用同城同档
 *     在售酒店价格中位数，卡面明确标注「市场均价」而不是冒充该酒店报价）
 *   - 餐饮人均：高德 POI 的 biz_ext.cost（真实人均消费，规划取数时已落库）
 *   - 往返大交通：飞猪 FlyAI search-flight / search-train（去程+返程总价）
 *
 * 拿不到就返回 null，由上层标「待核价」并从合计中剔除——绝不回退到编造价格。
 * 所有查询按 key 缓存（酒店/交通 10 分钟、景点 30 分钟），并做同 key 并发去重。
 */

import {
  callFlyAi,
  createDefaultFlyAiRunner,
  isRecord,
  parsePriceCny,
  strOf,
  type FlyAiRunner,
} from "../../services/booking/quote/flyai-quote-source.js";
import { transferHubCandidates } from "./travel-origin.js";

export type LivePriceKind = "exact" | "market" | "free";

export interface LiveAttractionPrice {
  /** 门票价；null=查不到（待核价） */
  amount: number | null;
  /** 免费景点（0 元且来源明确） */
  free: boolean;
  /** 飞猪返回的景点简介（真实文案，可直接展示） */
  description?: string;
  note: string;
}

export type HotelTier = "budget" | "mid" | "luxury";

/**
 * 酒店真实房价的两种成因，刻意做成判别联合：
 * exact 是本店报价（可展示、可计入合计），market 是同城同档中位数
 * （只是预算参考，字段名不叫 amount，防止任何展示层把它当本店报价）。
 */
export type LiveHotelPrice =
  | {
      kind: "exact";
      amount: number;
      note: string;
      /** 飞猪住客评分（0-5，平台未返回时不填） */
      rating?: number;
      bookingUrl?: string;
    }
  | {
      kind: "market";
      /** 同城同档在售酒店价格中位数——不是任何一家的报价 */
      reference: number;
      sampleSize: number;
      tier: HotelTier;
      note: string;
    };

export interface LiveTransportPrice {
  /** 往返总价（单人） */
  amount: number;
  mode: "flight" | "train";
  label: string;
  note: string;
  /** 转机经停枢纽（无直飞按枢纽两段计价时有值） */
  viaHub?: string;
}

const runner = createDefaultFlyAiRunner();

const CACHE_TTL_MS = {
  attraction: 30 * 60_000,
  hotel: 10 * 60_000,
  transport: 10 * 60_000,
  failure: 60_000,
};

type CacheEntry<T> = { ts: number; value: T; ttl: number };
const cache = new Map<string, CacheEntry<unknown>>();
const inFlight = new Map<string, Promise<unknown>>();

async function cached<T>(key: string, ttl: number, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key) as CacheEntry<T> | undefined;
  if (hit && Date.now() - hit.ts < hit.ttl) return hit.value;
  const running = inFlight.get(key) as Promise<T> | undefined;
  if (running) return running;
  const task = fn()
    .then((value) => {
      cache.set(key, { ts: Date.now(), value, ttl });
      return value;
    })
    .catch((err) => {
      cache.set(key, { ts: Date.now(), value: null as unknown as T, ttl: CACHE_TTL_MS.failure });
      throw err;
    })
    .finally(() => {
      inFlight.delete(key);
    });
  inFlight.set(key, task);
  return task;
}

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[（(][^）)]*[）)]/g, "")
    .replace(/[\s·・.,，。:：\-—_/\\|'"“”‘’]/g, "")
    .trim();
}

function sameName(a: string, b: string): boolean {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const [short, long] = na.length <= nb.length ? [na, nb] : [nb, na];
  return short.length >= 4 && long.includes(short);
}

function median(values: number[]): number | null {
  const nums = values.filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  if (nums.length === 0) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 === 1 ? nums[mid]! : Math.round((nums[mid - 1]! + nums[mid]!) / 2);
}

// ──────────────────────────── 景点门票 ────────────────────────────

/**
 * 按「城市 + 景点名」查真实门票价与官方简介。
 * 飞猪 search-poi 对多数景区返回 ticketInfo.price（如「¥49」）；免费景区
 * 通过 freePoiStatus=FREE 判定。查不到 amount=null，由上层标待核价。
 */
export async function lookupAttractionPrice(
  name: string,
  city: string,
): Promise<LiveAttractionPrice> {
  const key = `attraction|${city}|${name}`;
  try {
    return await cached(key, CACHE_TTL_MS.attraction, async () => {
      const res = await callFlyAi(runner, ["search-poi", "--city-name", city, "--keyword", name]);
      if ("error" in res) {
        return { amount: null, free: false, note: "实时票价查询失败，待核价" };
      }
      const match =
        res.items.find((it) => sameName(strOf(it, "name"), name)) ?? res.items[0];
      if (!match) return { amount: null, free: false, note: "飞猪未收录，待核价" };
      const description = strOf(match, "description") || undefined;
      const ticket = isRecord(match.ticketInfo) ? match.ticketInfo : null;
      const amount = ticket ? parsePriceCny(ticket.price) : NaN;
      if (Number.isFinite(amount) && amount >= 0) {
        return {
          amount: Math.round(amount),
          free: amount === 0,
          ...(description ? { description } : {}),
          note: amount === 0 ? "免费景点" : "飞猪实时票价，以下单页为准",
        };
      }
      if (strOf(match, "freePoiStatus").toUpperCase() === "FREE") {
        return {
          amount: 0,
          free: true,
          ...(description ? { description } : {}),
          note: "免费景点",
        };
      }
      if (strOf(match, "freePoiStatus").toUpperCase() === "UNKNOWN") {
        return {
          amount: null,
          free: false,
          ...(description ? { description } : {}),
          note: "飞猪未公布票价，待核价",
        };
      }
      return {
        amount: null,
        free: false,
        ...(description ? { description } : {}),
        note: "需购票但未取到实时价，待核价",
      };
    });
  } catch {
    return { amount: null, free: false, note: "实时票价查询失败，待核价" };
  }
}

// ──────────────────────────── 酒店房价 ────────────────────────────

const HOTEL_TIER_STARS: Record<HotelTier, string> = {
  budget: "1,2",
  mid: "3,4",
  luxury: "5",
};

interface HotelItem {
  name: string;
  price: number;
  star: string;
  /** 飞猪平台住客评分（0-5）；未返回即不填，绝不兜底成默认分 */
  rating?: number;
  bookingUrl?: string;
}

async function searchHotels(
  city: string,
  opts: { stars?: string; keywords?: string; checkIn?: string; checkOut?: string },
): Promise<HotelItem[]> {
  const args = ["search-hotel", "--dest-name", city, "--hotel-types", "hotel", "--sort", "price_asc"];
  if (opts.stars) args.push("--hotel-stars", opts.stars);
  if (opts.keywords) args.push("--key-words", opts.keywords);
  if (opts.checkIn) args.push("--check-in-date", opts.checkIn);
  if (opts.checkOut) args.push("--check-out-date", opts.checkOut);
  const key = `hotel-list|${args.join("|")}`;
  return cached(key, CACHE_TTL_MS.hotel, async () => {
    const res = await callFlyAi(runner, args);
    if ("error" in res) return [];
    const out: HotelItem[] = [];
    for (const item of res.items) {
      const name = strOf(item, "name");
      const price = parsePriceCny(item.price ?? item.adultPrice);
      if (!name || !Number.isFinite(price) || price <= 0) continue;
      // rate 优先、score 兜底：与 flyai-quote-source 的酒店评分同一口径
      const rating = parsePriceCny(item.rate ?? item.score);
      out.push({
        name,
        price: Math.round(price),
        star: strOf(item, "star"),
        ...(Number.isFinite(rating) && rating > 0 ? { rating } : {}),
        bookingUrl: strOf(item, "detailUrl") || undefined,
      });
    }
    return out;
  });
}

/**
 * 查某家酒店的真实房价：先同名精确搜索，命中即用该酒店实时价；
 * 未命中则用同城同档（由 POI 的 keytag/星级推导）在售酒店价格中位数，
 * 并明确标注为市场均价——不冒充单个酒店报价。
 */
export async function lookupHotelPrice(
  name: string,
  city: string,
  opts: {
    tier?: HotelTier;
    checkIn?: string;
    checkOut?: string;
  } = {},
): Promise<LiveHotelPrice | null> {
  const key = `hotel|${city}|${name}|${opts.tier ?? ""}|${opts.checkIn ?? ""}|${opts.checkOut ?? ""}`;
  try {
    return await cached(key, CACHE_TTL_MS.hotel, async () => {
      const exact = await searchHotels(city, {
        keywords: name,
        checkIn: opts.checkIn,
        checkOut: opts.checkOut,
      });
      const hit = exact.find((h) => sameName(h.name, name));
      if (hit) {
        return {
          kind: "exact" as const,
          amount: hit.price,
          note: "飞猪实时房价，以下单页为准",
          ...(hit.rating ? { rating: hit.rating } : {}),
          ...(hit.bookingUrl ? { bookingUrl: hit.bookingUrl } : {}),
        };
      }
      const tier = opts.tier ?? "mid";
      const pool = await searchHotels(city, {
        stars: HOTEL_TIER_STARS[tier],
        checkIn: opts.checkIn,
        checkOut: opts.checkOut,
      });
      const medianPrice = median(pool.map((h) => h.price));
      if (medianPrice == null || pool.length < 3) return null;
      return {
        kind: "market" as const,
        reference: medianPrice,
        sampleSize: pool.length,
        tier,
        note: `未取到该酒店实时价，按同城同档 ${pool.length} 家在售酒店中位数参考`,
      };
    });
  } catch {
    return null;
  }
}

// ──────────────────────────── 餐饮人均 ────────────────────────────

/** 高德 POI 的人均消费（biz_ext.cost），返回 null 表示未公布。 */
export function restaurantCostOf(raw: unknown): number | null {
  if (!isRecord(raw)) return null;
  const biz = isRecord(raw.biz_ext) ? raw.biz_ext : null;
  if (!biz) return null;
  return parseCostValue(biz.cost ?? raw.cost);
}

function parseCostValue(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
  if (typeof value === "string") {
    const m = value.replace(/,/g, "").match(/(\d+(?:\.\d+)?)/);
    if (m?.[1]) {
      const n = Number(m[1]);
      return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
    }
  }
  return null;
}

// ──────────────────────────── 往返大交通 ────────────────────────────

interface TransportOption {
  mode: "flight" | "train";
  amount: number;
  label: string;
  /** 单程最短耗时（分钟） */
  durationMin: number;
  /** 转机经停枢纽（两段拼接选项时有值） */
  viaHub?: string;
  /** 转机两段明细（拼进 note，如实标注） */
  legsNote?: string;
}

async function searchTransportOption(
  cmd: "search-flight" | "search-train",
  mode: "flight" | "train",
  origin: string,
  destination: string,
  startDate?: string,
  endDate?: string,
  runnerFn: FlyAiRunner = runner,
): Promise<TransportOption | null> {
  const args = [cmd, "--origin", origin, "--destination", destination, "--sort-type", "3"];
  if (startDate) args.push("--dep-date", startDate);
  if (endDate) args.push("--back-date", endDate);
  const key = `${mode}|${args.join("|")}`;
  return cached(key, CACHE_TTL_MS.transport, async () => {
    const res = await callFlyAi(runnerFn, args);
    if ("error" in res || res.items.length === 0) return null;
    let best: TransportOption | null = null;
    for (const item of res.items) {
      const price = parsePriceCny(
        mode === "flight"
          ? (item.ticketPrice ?? item.adultPrice ?? item.price)
          : (item.price ?? item.ticketPrice ?? item.adultPrice),
      );
      if (!Number.isFinite(price) || price <= 0) continue;
      const journeys = Array.isArray(item.journeys) ? item.journeys : [];
      const first = isRecord(journeys[0]) ? journeys[0] : null;
      const segments = first && Array.isArray(first.segments) ? first.segments : [];
      const seg = isRecord(segments[0]) ? segments[0] : null;
      const durationMin = Number(strOf(first, "totalDuration") || strOf(seg, "duration")) || 0;
      const code = strOf(seg, "marketingTransportNo");
      const carrier = strOf(seg, "marketingTransportName");
      const label =
        mode === "flight"
          ? `往返机票${code ? `（${carrier} ${code}）` : ""}`
          : `往返火车票${code ? `（${code}）` : ""}`;
      const candidate: TransportOption = {
        mode,
        amount: Math.round(price),
        label,
        durationMin,
      };
      if (!best || candidate.amount < best.amount) best = candidate;
    }
    return best;
  });
}

/**
 * 无直飞时的转机方案：按枢纽候选（省会优先）并行查「出发地→枢纽」「枢纽→目的地」
 * 两段各自往返实价，两段都查到才成选项——绝不编造价格。耗时计 90 分钟候机估计。
 */
async function lookupTransferOptions(args: {
  origin: string;
  destination: string;
  startDate?: string;
  endDate?: string;
  originRegion?: string;
  runnerFn: FlyAiRunner;
}): Promise<TransportOption[]> {
  const hubs = transferHubCandidates(args.origin, args.originRegion);
  if (hubs.length === 0) return [];
  const results = await Promise.all(
    hubs.map(async (hub): Promise<TransportOption | null> => {
      const [leg1, leg2] = await Promise.all([
        searchTransportOption(
          "search-flight",
          "flight",
          args.origin,
          hub,
          args.startDate,
          args.endDate,
          args.runnerFn,
        ).catch(() => null),
        searchTransportOption(
          "search-flight",
          "flight",
          hub,
          args.destination,
          args.startDate,
          args.endDate,
          args.runnerFn,
        ).catch(() => null),
      ]);
      if (!leg1 || !leg2) return null;
      return {
        mode: "flight",
        viaHub: hub,
        amount: leg1.amount + leg2.amount,
        label: `转机往返机票（经${hub}）`,
        durationMin: leg1.durationMin + leg2.durationMin + 90,
        legsNote: `${args.origin}—${hub} ${leg1.label.replace(/（.*?）/g, "")}、${hub}—${args.destination} ${leg2.label.replace(/（.*?）/g, "")}`,
      };
    }),
  );
  return results.filter((o): o is TransportOption => o !== null);
}

// ──────────────────────── 大交通多选项（预订选择卡，2026-10-27） ────────────────────────

/** 单段（去程/返程）真实时刻明细（来自飞猪 journeys[].segments[]，不臆造）。 */
export interface TransportLegDetail {
  from: string;
  to: string;
  /** 出发/到达日期（YYYY-MM-DD；与请求日期不一致时如实带出） */
  date?: string;
  /** 出发/到达时刻（HH:mm） */
  dep?: string;
  arr?: string;
  /** ISO 时刻（2026-10-30T17:40:00），接驳提醒/TransferSegment 直接消费 */
  depISO?: string;
  arrISO?: string;
  /** 出发/到达机场车站（如「萧山国际机场」） */
  fromStation?: string;
  toStation?: string;
  /** 段耗时（分钟） */
  durationMin?: number;
}

/** 预订选择卡的大交通选项：车次/航班、真实时刻与票价（价取不到如实置 null）。 */
export interface TransportOptionDetail {
  mode: "flight" | "train";
  /** 车次号（G123）或航班号（EU2260）；多段中转取第一段号 */
  no?: string;
  /** 航司简称/车型（成都航/普快） */
  carrier?: string;
  /** 去程（出发地 → 目的地） */
  outbound?: TransportLegDetail;
  /** 返程（目的地 → 出发地；查了返程日期才有） */
  inbound?: TransportLegDetail;
  /** 往返总价（单人）；null=平台未公布（体验模式脱敏），上层如实标「待核价」 */
  amount: number | null;
  /** 去程耗时（分钟） */
  durationMin?: number;
  /** 飞猪下单页 */
  bookingUrl?: string;
  /** 转机经停枢纽（两段拼接选项时有值） */
  viaHub?: string;
}

function isoOf(dateTime: string): string | undefined {
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}):\d{2}$/.exec(dateTime.trim());
  return m ? `${m[1]}T${m[2]}:00` : undefined;
}

function legDetailOf(seg: Record<string, unknown> | null): TransportLegDetail | undefined {
  if (!seg) return undefined;
  const depISO = isoOf(strOf(seg, "depDateTime"));
  const arrISO = isoOf(strOf(seg, "arrDateTime"));
  const fromStation = strOf(seg, "depStationName");
  const toStation = strOf(seg, "arrStationName");
  const duration = Number(strOf(seg, "duration")) || 0;
  return {
    from: strOf(seg, "depCityName") || fromStation,
    to: strOf(seg, "arrCityName") || toStation,
    ...(depISO ? { date: depISO.slice(0, 10), depISO } : {}),
    ...(arrISO ? { arrISO } : {}),
    ...(depISO ? { dep: depISO.slice(11, 16) } : {}),
    ...(arrISO ? { arr: arrISO.slice(11, 16) } : {}),
    ...(fromStation ? { fromStation } : {}),
    ...(toStation ? { toStation } : {}),
    ...(duration > 0 ? { durationMin: duration } : {}),
  };
}

/** 飞猪 itemList 单条 → 预订卡选项（journeys[0]=去程、journeys[1]=返程）。 */
function transportDetailFromItem(
  mode: "flight" | "train",
  item: Record<string, unknown>,
): TransportOptionDetail | null {
  const journeys = Array.isArray(item.journeys) ? item.journeys : [];
  const first = isRecord(journeys[0]) ? journeys[0] : null;
  const outSegs = first && Array.isArray(first.segments) ? first.segments : [];
  const outbound = legDetailOf(isRecord(outSegs[0]) ? outSegs[0] : null);
  if (!outbound) return null;
  const second = isRecord(journeys[1]) ? journeys[1] : null;
  const inSegs = second && Array.isArray(second.segments) ? second.segments : [];
  const inbound = legDetailOf(isRecord(inSegs[0]) ? inSegs[0] : null);
  const firstSeg = isRecord(outSegs[0]) ? outSegs[0] : null;
  const priceRaw =
    mode === "flight"
      ? (item.ticketPrice ?? item.adultPrice ?? item.price)
      : (item.price ?? item.ticketPrice ?? item.adultPrice);
  const amount = parsePriceCny(priceRaw);
  const no = strOf(firstSeg, "marketingTransportNo");
  const carrier = strOf(firstSeg, "marketingTransportName");
  const durationMin =
    Number(strOf(first, "totalDuration") || strOf(firstSeg, "duration")) || undefined;
  const bookingUrl = strOf(item, "jumpUrl") || undefined;
  return {
    mode,
    ...(no ? { no } : {}),
    ...(carrier ? { carrier } : {}),
    outbound,
    ...(inbound ? { inbound } : {}),
    amount: Number.isFinite(amount) && amount > 0 ? Math.round(amount) : null,
    ...(durationMin && durationMin > 0 ? { durationMin } : {}),
    ...(bookingUrl ? { bookingUrl } : {}),
  };
}

/** 同一车次/航班同日期同时刻去重（体验模式不同日期重复出现的班次只留一条）。 */
function dedupeDetails(list: TransportOptionDetail[]): TransportOptionDetail[] {
  const seen = new Set<string>();
  const out: TransportOptionDetail[] = [];
  for (const o of list) {
    const key = `${o.no ?? ""}|${o.outbound?.date ?? ""}|${o.outbound?.dep ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(o);
  }
  return out;
}

async function searchTransportOptionsDetail(
  cmd: "search-flight" | "search-train",
  mode: "flight" | "train",
  origin: string,
  destination: string,
  startDate?: string,
  endDate?: string,
  runnerFn: FlyAiRunner = runner,
  limit = 3,
): Promise<TransportOptionDetail[]> {
  const args = [cmd, "--origin", origin, "--destination", destination, "--sort-type", "3"];
  if (startDate) args.push("--dep-date", startDate);
  if (endDate) args.push("--back-date", endDate);
  const key = `${mode}-list|${args.join("|")}`;
  return cached(key, CACHE_TTL_MS.transport, async () => {
    const res = await callFlyAi(runnerFn, args);
    if ("error" in res) return [];
    const details = res.items
      .map((it) => transportDetailFromItem(mode, it))
      .filter((o): o is TransportOptionDetail => o !== null);
    const ranked = [...dedupeDetails(details)].sort((a, b) => {
      // 有实价者优先（价低在前）；都没价按原序（飞猪相关度）
      if (a.amount != null && b.amount != null) return a.amount - b.amount;
      if (a.amount != null) return -1;
      if (b.amount != null) return 1;
      return 0;
    });
    return ranked.slice(0, limit);
  });
}

/**
 * 往返大交通候选列表（预订选择卡数据源）：机票与火车各取前 N 条真实班次。
 * 出发地无直飞时补转机拼接选项（经枢纽两段实价合计，无逐段时刻——如实不编）。
 * 价格脱敏（体验模式）的选项保留但 amount=null，上层标「待核价」。
 */
export async function lookupTransportOptions(args: {
  origin: string;
  originRegion?: string;
  destination: string;
  startDate?: string;
  endDate?: string;
  runner?: FlyAiRunner;
  limit?: number;
}): Promise<{ flights: TransportOptionDetail[]; trains: TransportOptionDetail[] }> {
  const origin = (args.origin ?? "").trim();
  const destination = (args.destination ?? "").trim();
  if (!origin || !destination || normalizeName(origin) === normalizeName(destination)) {
    return { flights: [], trains: [] };
  }
  const runnerFn = args.runner ?? runner;
  const limit = args.limit ?? 3;
  try {
    const [flights, trains] = await Promise.all([
      searchTransportOptionsDetail(
        "search-flight", "flight", origin, destination, args.startDate, args.endDate, runnerFn, limit,
      ),
      searchTransportOptionsDetail(
        "search-train", "train", origin, destination, args.startDate, args.endDate, runnerFn, limit,
      ),
    ]);
    if (flights.length === 0) {
      const hubs = transferHubCandidates(origin, args.originRegion);
      const transfers = await Promise.all(
        hubs.map(async (hub): Promise<TransportOptionDetail | null> => {
          const [leg1, leg2] = await Promise.all([
            searchTransportOption("search-flight", "flight", origin, hub, args.startDate, args.endDate, runnerFn).catch(() => null),
            searchTransportOption("search-flight", "flight", hub, destination, args.startDate, args.endDate, runnerFn).catch(() => null),
          ]);
          if (!leg1 || !leg2) return null;
          // 两段都查到实价才合计；任一脱敏/缺失 → null（如实待核价）
          const totalAmount =
            leg1.amount != null && leg2.amount != null
              ? leg1.amount + leg2.amount
              : null;
          return {
            mode: "flight" as const,
            amount: totalAmount,
            ...(leg1.durationMin != null && leg2.durationMin != null
              ? { durationMin: leg1.durationMin + leg2.durationMin + 90 }
              : {}),
            ...(args.startDate ? { outbound: { from: origin, to: destination, date: args.startDate } as TransportLegDetail } : {}),
            viaHub: hub,
          };
        }),
      );
      const valid = transfers
        .filter((t): t is TransportOptionDetail => t !== null && t.amount != null)
        .sort((a, b) => (a.amount ?? 0) - (b.amount ?? 0))
        .slice(0, 2);
      flights.push(...valid);
    }
    return { flights: flights.slice(0, limit + 2), trains: trains.slice(0, limit) };
  } catch {
    return { flights: [], trains: [] };
  }
}

// ──────────────────────── 酒店多选项（预订选择卡） ────────────────────────

/** 预订选择卡的酒店选项：真实在售酒店与房价（脱敏/未命中时 amount=null）。 */
export interface HotelOptionDetail {
  name: string;
  /** 每晚价；null=平台未公布（体验模式脱敏），上层如实标「待核价」 */
  amount: number | null;
  rating?: number;
  /** 飞猪档次标签（舒适型/高档型…） */
  star?: string;
  address?: string;
  /** 位置卖点（interestsPoi，如「近宽窄巷子景区」） */
  near?: string;
  image?: string;
  bookingUrl?: string;
  /** 价格口径说明（实时价/待核价原因），卡面原样展示 */
  note?: string;
  /** 来自用户在筛选卡勾选的酒店（置顶展示） */
  fromPicks?: boolean;
}

function hotelOptionFromItem(item: Record<string, unknown>, opts?: { fromPicks?: boolean }): HotelOptionDetail | null {
  const name = strOf(item, "name");
  if (!name) return null;
  const price = parsePriceCny(item.price ?? item.adultPrice);
  const rating = parsePriceCny(item.rate ?? item.score);
  const detailUrl = strOf(item, "detailUrl") || undefined;
  return {
    name,
    amount: Number.isFinite(price) && price > 0 ? Math.round(price) : null,
    ...(Number.isFinite(rating) && rating > 0 ? { rating } : {}),
    ...(strOf(item, "star") ? { star: strOf(item, "star") } : {}),
    ...(strOf(item, "address") ? { address: strOf(item, "address") } : {}),
    ...(strOf(item, "interestsPoi") ? { near: strOf(item, "interestsPoi") } : {}),
    ...(strOf(item, "mainPic") ? { image: strOf(item, "mainPic") } : {}),
    ...(detailUrl ? { bookingUrl: detailUrl } : {}),
    ...(opts?.fromPicks ? { fromPicks: true } : {}),
  };
}

/**
 * 目的地酒店候选列表（预订选择卡数据源）：
 * 用户在筛选卡勾选的酒店先按名精确搜索（置顶、fromPicks），不足部分用
 * 同城同档在售酒店补齐。价格按住/退日期查；脱敏或未公布时 amount=null。
 */
export async function lookupHotelOptions(args: {
  city: string;
  /** 用户勾选的酒店/民宿名（优先精确询价，≤3） */
  names?: string[];
  checkIn?: string;
  checkOut?: string;
  tier?: HotelTier;
  /** 卡面总条数上限（含勾选置顶），默认 5 */
  limit?: number;
}): Promise<HotelOptionDetail[]> {
  const city = (args.city ?? "").trim();
  if (!city) return [];
  const limit = Math.max(3, args.limit ?? 5);
  try {
    const out: HotelOptionDetail[] = [];
    const seen = new Set<string>();
    const push = (o: HotelOptionDetail | null): void => {
      if (!o) return;
      const k = normalizeName(o.name);
      if (!k || seen.has(k)) return;
      seen.add(k);
      out.push(o);
    };
    const picks = (args.names ?? []).map((n) => n.trim()).filter(Boolean).slice(0, 3);
    const lists = await Promise.all([
      ...picks.map((name) =>
        searchHotels(city, { keywords: name, checkIn: args.checkIn, checkOut: args.checkOut }),
      ),
      searchHotels(city, {
        stars: HOTEL_TIER_STARS[args.tier ?? "mid"],
        checkIn: args.checkIn,
        checkOut: args.checkOut,
      }),
    ]);
    picks.forEach((name, i) => {
      const hit = lists[i]?.find((h) => sameName(h.name, name));
      if (!hit) return;
      const opt = hotelOptionFromItem({
        ...hit,
        // searchHotels 已折好 price/rating/star，直接复用字段名
        price: hit.price,
        rate: hit.rating,
      } as Record<string, unknown>);
      if (opt) push({ ...opt, fromPicks: true });
    });
    for (const it of lists[picks.length] ?? []) {
      if (out.length >= limit) break;
      push(hotelOptionFromItem({ ...it } as Record<string, unknown>));
    }
    // 有实价的排前面，勾选置顶的永远最先
    return out
      .slice(0, limit)
      .sort((a, b) => {
        if (a.fromPicks !== b.fromPicks) return a.fromPicks ? -1 : 1;
        if (a.amount != null && b.amount != null) return a.amount - b.amount;
        if (a.amount != null) return -1;
        if (b.amount != null) return 1;
        return 0;
      });
  } catch {
    return [];
  }
}

/**
 * 往返大交通最低价（单人）。机票与火车并行查询，按「耗时 ≤12h 的选项中取最低价」
 * 选型：火车 38 小时这种极端行程即使便宜也不作为默认推荐。
 * 出发地无直飞（直飞查询为空）时，自动按枢纽候选查两段转机实价并同池比价，
 * 如实标注「经 X 转机」；两段也查不到 → null，上层如实标「未含」。
 * 缺出发地/日期查不到 → null。
 */
export async function lookupTransportPrice(args: {
  origin?: string;
  originRegion?: string;
  destination: string;
  startDate?: string;
  endDate?: string;
  /** 测试注入：替换 flyai CLI runner */
  runner?: FlyAiRunner;
}): Promise<LiveTransportPrice | null> {
  const origin = (args.origin ?? "").trim();
  const destination = (args.destination ?? "").trim();
  if (!origin || !destination || normalizeName(origin) === normalizeName(destination)) return null;
  const runnerFn = args.runner ?? runner;
  try {
    const [flight, train] = await Promise.all([
      searchTransportOption("search-flight", "flight", origin, destination, args.startDate, args.endDate, runnerFn),
      searchTransportOption("search-train", "train", origin, destination, args.startDate, args.endDate, runnerFn),
    ]);
    let pool: TransportOption[] = [flight, train].filter((o): o is TransportOption => !!o);
    if (!flight) {
      const transfers = await lookupTransferOptions({
        origin,
        destination,
        startDate: args.startDate,
        endDate: args.endDate,
        originRegion: args.originRegion,
        runnerFn,
      });
      pool = [...pool, ...transfers];
    }
    const reasonable = pool.filter((o) => o.durationMin === 0 || o.durationMin <= 12 * 60);
    const candidates = reasonable.length > 0 ? reasonable : pool;
    if (candidates.length === 0) return null;
    const chosen = candidates.reduce((a, b) => (a.amount <= b.amount ? a : b));
    const alternatives = candidates
      .filter((o) => o !== chosen)
      .map((o) => `${o.label.replace(/（.*?）/g, "")}${o.viaHub ? `经${o.viaHub}` : ""} ¥${o.amount}`);
    const hours = chosen.durationMin > 0 ? Math.round(chosen.durationMin / 60) : 0;
    const durationNote = hours > 0 ? `，单程约 ${hours} 小时` : "";
    const transferNote = chosen.viaHub
      ? `${origin}无直飞${destination}航班，已按经${chosen.viaHub}转机计价（${chosen.legsNote ?? "两段单订"}），候机时间未含`
      : "";
    return {
      amount: chosen.amount,
      mode: chosen.mode,
      label: chosen.label,
      ...(chosen.viaHub ? { viaHub: chosen.viaHub } : {}),
      note:
        `单价按 1 人计，${args.endDate ? "往返" : "单程"}总价${durationNote}` +
        (transferNote ? `；${transferNote}` : "") +
        (alternatives.length ? `；另一方案：${alternatives.join("、")}` : "") +
        "，以下单页为准",
    };
  } catch {
    return null;
  }
}
