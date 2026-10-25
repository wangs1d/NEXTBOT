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
} from "../../services/booking/quote/flyai-quote-source.js";

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

export interface LiveHotelPrice {
  amount: number;
  kind: "exact" | "market";
  note: string;
  bookingUrl?: string;
}

export interface LiveTransportPrice {
  /** 往返总价（单人） */
  amount: number;
  mode: "flight" | "train";
  label: string;
  note: string;
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

const HOTEL_TIER_STARS: Record<"budget" | "mid" | "luxury", string> = {
  budget: "1,2",
  mid: "3,4",
  luxury: "5",
};

interface HotelItem {
  name: string;
  price: number;
  star: string;
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
      out.push({
        name,
        price: Math.round(price),
        star: strOf(item, "star"),
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
    tier?: "budget" | "mid" | "luxury";
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
          amount: hit.price,
          kind: "exact" as const,
          note: "飞猪实时房价，以下单页为准",
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
        amount: medianPrice,
        kind: "market" as const,
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
}

async function searchTransportOption(
  cmd: "search-flight" | "search-train",
  mode: "flight" | "train",
  origin: string,
  destination: string,
  startDate?: string,
  endDate?: string,
): Promise<TransportOption | null> {
  const args = [cmd, "--origin", origin, "--destination", destination, "--sort-type", "3"];
  if (startDate) args.push("--dep-date", startDate);
  if (endDate) args.push("--back-date", endDate);
  const key = `${mode}|${args.join("|")}`;
  return cached(key, CACHE_TTL_MS.transport, async () => {
    const res = await callFlyAi(runner, args);
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
 * 往返大交通最低价（单人）。机票与火车并行查询，按「耗时 ≤12h 的选项中取最低价」
 * 选型：火车 38 小时这种极端行程即使便宜也不作为默认推荐。
 * 缺出发地/日期查不到 → null，上层如实标「未含」。
 */
export async function lookupTransportPrice(args: {
  origin?: string;
  destination: string;
  startDate?: string;
  endDate?: string;
}): Promise<LiveTransportPrice | null> {
  const origin = (args.origin ?? "").trim();
  const destination = (args.destination ?? "").trim();
  if (!origin || !destination || normalizeName(origin) === normalizeName(destination)) return null;
  try {
    const [flight, train] = await Promise.all([
      searchTransportOption("search-flight", "flight", origin, destination, args.startDate, args.endDate),
      searchTransportOption("search-train", "train", origin, destination, args.startDate, args.endDate),
    ]);
    const reasonable = [flight, train].filter(
      (o): o is TransportOption => !!o && (o.durationMin === 0 || o.durationMin <= 12 * 60),
    );
    const pool = reasonable.length > 0 ? reasonable : [flight, train].filter((o): o is TransportOption => !!o);
    if (pool.length === 0) return null;
    const chosen = pool.reduce((a, b) => (a.amount <= b.amount ? a : b));
    const alternatives = pool
      .filter((o) => o !== chosen)
      .map((o) => `${o.label.replace(/（.*?）/g, "")} ¥${o.amount}`);
    const hours = chosen.durationMin > 0 ? Math.round(chosen.durationMin / 60) : 0;
    const durationNote = hours > 0 ? `，单程约 ${hours} 小时` : "";
    return {
      amount: chosen.amount,
      mode: chosen.mode,
      label: chosen.label,
      note:
        `单价按 1 人计，${args.endDate ? "往返" : "单程"}总价${durationNote}` +
        (alternatives.length ? `；另一方案：${alternatives.join("、")}` : "") +
        "，以下单页为准",
    };
  } catch {
    return null;
  }
}
