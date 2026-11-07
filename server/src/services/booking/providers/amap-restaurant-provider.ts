/**
 * 高德餐厅 Provider —— restaurant 域的真实门店检索（读链路）。
 *
 * search 走高德 Web 服务：有定位用 place/around（按距离升序），只给城市用
 * place/text。返回真实店名/距离/评分/人均/地址/电话；平台没给的字段留空，
 * 不补中位数、不补占位名。
 *
 * book/getStatus/cancel 明确不支持：高德侧没有占座能力，返回带出路的错误
 * 而不是假装下单（与 AmapRideProvider 未配企业版时同一口径）。
 *
 * 配额：个人认证「基础搜索服务」5000 次/月（关键字/周边/多边形/ID 合并计），
 * 故按「定位网格 + 城市 + 关键词 + 半径」缓存，默认 7 天。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { getDataDir } from "../../../config/data-dir.js";
import { gcj02ToWgs84 } from "../../../skills/travel-planning/coord-transform.js";
import type { ClientLocationWire } from "../../../types/client-location.js";
import type { BookingConfig } from "../booking-config.js";
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

const AROUND_URL = "https://restapi.amap.com/v3/place/around";
const TEXT_URL = "https://restapi.amap.com/v3/place/text";
const NEARBY_RADIUS_M = 5000;
const RESULT_LIMIT = 12;
const FALLBACK_KEYWORDS = "美食";

interface AmapPoi {
  id?: unknown;
  name?: unknown;
  type?: unknown;
  keytag?: unknown;
  typecode?: unknown;
  location?: unknown;
  distance?: unknown;
  address?: unknown;
  business_area?: unknown;
  tel?: unknown;
  biz_ext?: { cost?: unknown; rating?: unknown; open_time?: unknown; opentime2?: unknown };
}

/** 高德空值统一成 `[]`（不是 ""），先归一再判空。 */
function amapStr(v: unknown): string {
  if (Array.isArray(v)) return v.length === 0 ? "" : v.map((x) => String(x)).join(";");
  return v === undefined || v === null ? "" : String(v).trim();
}

function amapNum(v: unknown): number | null {
  const n = Number(amapStr(v));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** 定位网格：约 110m 一档（3 位小数），避免 GPS 抖动把缓存打散。 */
function gridOf(lat: number, lng: number): string {
  return `${lat.toFixed(3)},${lng.toFixed(3)}`;
}

interface CacheEntry {
  at: number;
  pois: AmapPoi[];
}

export interface AmapRestaurantProviderOptions {
  /** 缓存落盘路径；null = 只走内存（单测用） */
  cachePath?: string | null;
  now?: () => number;
  fetchImpl?: (url: string) => Promise<Response>;
}

export class AmapRestaurantProvider implements BookingProvider {
  readonly key = "amap";
  readonly domain = "restaurant" as const;
  readonly label = "高德地图餐厅（真实门店）";

  private readonly webKey: string;
  private readonly ttlMs: number;
  private readonly cachePath: string | null;
  private readonly now: () => number;
  private readonly fetchImpl: (url: string) => Promise<Response>;
  private readonly cache = new Map<string, CacheEntry>();
  private diskLoaded = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: BookingConfig, opts: AmapRestaurantProviderOptions = {}) {
    this.webKey = config.amapWebKey;
    this.ttlMs = config.restaurantPoiCacheTtlMs;
    this.cachePath =
      opts.cachePath === undefined ? join(getDataDir(), "booking", "restaurant-poi-cache.json") : opts.cachePath;
    this.now = opts.now ?? (() => Date.now());
    this.fetchImpl = opts.fetchImpl ?? ((url) => fetch(url, { signal: AbortSignal.timeout(10_000) }));
  }

  availability(): { ok: boolean; reason?: string } {
    return this.webKey
      ? { ok: true }
      : { ok: false, reason: "未配置 AMAP_WEB_KEY，无法检索真实门店（restaurant.search 会回退模拟库）" };
  }

  async search(
    query: BookingSearchQuery,
    ctx: BookingProviderContext,
  ): Promise<BookingProviderResult<{ options: BookingOption[]; note?: string }>> {
    const params = query.params ?? {};
    const cuisine = amapStr(params.cuisine);
    const keyword = amapStr(params.query);
    const keywords = [cuisine, keyword].filter(Boolean).join(" ") || FALLBACK_KEYWORDS;
    const covers = Math.max(1, Number(params.covers) || 2);
    const dineAt = amapStr(params.dineAt) || amapStr(query.scheduleAt) || null;

    const center = await this.resolveCenter(query.location ?? ctx.location ?? null, ctx);
    const city = amapStr(query.city);
    if (!center && !city) {
      return {
        ok: false,
        error: "附近餐厅检索需要当前定位（或指定城市）。请让用户授权定位后重试，或把 city 填成明确城市名。",
        retryable: true,
      };
    }

    // 可选半径覆盖（沿线餐厅检索按当天路线半径取数；缺省仍是周边 5km）
    const requestedRadius = Number(params.radiusM);
    const radius =
      Number.isFinite(requestedRadius) && requestedRadius > 0
        ? Math.min(Math.max(Math.round(requestedRadius), 100), NEARBY_RADIUS_M)
        : NEARBY_RADIUS_M;
    const cacheKey = center
      ? `${gridOf(center.latitude, center.longitude)}|${city}|${keywords}|${radius}`
      : `city:${city}|${keywords}`;

    let pois = this.cacheGet(cacheKey);
    let fromCache = pois !== null;
    if (pois === null) {
      const url = center
        ? `${AROUND_URL}?key=${encodeURIComponent(this.webKey)}` +
          `&location=${encodeURIComponent(`${center.longitude},${center.latitude}`)}` +
          `&radius=${radius}&offset=${RESULT_LIMIT}&page=1&extensions=all` +
          `&keywords=${encodeURIComponent(keywords)}`
        : `${TEXT_URL}?key=${encodeURIComponent(this.webKey)}` +
          `&keywords=${encodeURIComponent(keywords)}` +
          `&types=${encodeURIComponent("050000")}&city=${encodeURIComponent(city)}` +
          `&citylimit=true&offset=${RESULT_LIMIT}&page=1&extensions=all`;
      const fetched = await this.fetchPois(url);
      if (!fetched.ok) return fetched;
      pois = fetched.pois;
      this.cacheSet(cacheKey, pois);
    }

    const options: BookingOption[] = pois
      .filter((p) => /^餐饮服务/.test(amapStr(p.type)))
      .filter((p) => amapStr(p.name))
      .slice(0, RESULT_LIMIT)
      .map((p) => this.toOption(p, covers, dineAt));

    if (options.length === 0) {
      return {
        ok: true,
        options: [],
        note: `高德在${center ? `当前位置 ${radius / 1000}km 内` : `${city}`}没有匹配「${keywords}」的餐饮门店。` +
          "如实告知用户换个关键词或放宽距离，不要改用其它品类充数。",
      };
    }

    return {
      ok: true,
      options,
      note:
        `数据来源：高德地图开放平台真实门店（${center ? `半径 ${radius / 1000}km，按距离升序` : `城市检索：${city}`}）` +
        `；关键词「${keywords}」命中 ${options.length} 家${fromCache ? "（缓存）" : ""}。` +
        "人均/电话/营业时间平台未给的就是空，留空即可，不要估算补齐。",
    };
  }

  async book(
    _draft: BookingDraft,
    _ctx: BookingProviderContext,
  ): Promise<BookingProviderResult<BookingProviderBookPayload>> {
    return {
      ok: false,
      error:
        "高德只提供真实门店检索，没有占座通道，本 Agent 不能替你订位。" +
        "请把 restaurant.search 结果里每家店的 extra.tel 电话给用户致电订座（无电话则建议到店或导航前往）。",
      retryable: false,
    };
  }

  async getStatus(
    _ref: BookingProviderRef,
    _ctx: BookingProviderContext,
  ): Promise<BookingProviderResult<BookingProviderStatusPayload>> {
    return { ok: false, error: "高德餐厅检索不产生订单，无状态可查。", retryable: false };
  }

  async cancel(
    _ref: BookingProviderRef,
    _reason: string | undefined,
    _ctx: BookingProviderContext,
  ): Promise<BookingProviderResult<{ message?: string }>> {
    return { ok: false, error: "高德餐厅检索不产生订单，无需取消。", retryable: false };
  }

  // ------------------------------------------------------------------ //

  /** 中心点：客户端定位 → 没有则向客户端要一次（真实周边搜索没有中心点就没意义）。 */
  private async resolveCenter(
    loc: ClientLocationWire | null,
    ctx: BookingProviderContext,
  ): Promise<ClientLocationWire | null> {
    if (loc && Number.isFinite(loc.latitude) && Number.isFinite(loc.longitude)) return loc;
    const asked = await ctx.toolContext?.requestLocation?.("附近餐厅推荐需要当前位置");
    return asked && Number.isFinite(asked.latitude) && Number.isFinite(asked.longitude) ? asked : null;
  }

  private async fetchPois(url: string): Promise<
    { ok: true; pois: AmapPoi[] } | { ok: false; error: string; retryable: boolean }
  > {
    let body: { status?: unknown; info?: unknown; pois?: unknown };
    try {
      const res = await this.fetchImpl(url);
      if (!res.ok) return { ok: false, error: `高德检索失败（HTTP ${res.status}）`, retryable: true };
      body = (await res.json()) as typeof body;
    } catch (e) {
      return { ok: false, error: `高德检索请求异常：${e instanceof Error ? e.message : String(e)}`, retryable: true };
    }
    if (String(body.status) !== "1" || !Array.isArray(body.pois)) {
      return {
        ok: false,
        error: `高德未返回门店（${amapStr(body.info) || "status!=1"}）`,
        retryable: true,
      };
    }
    return { ok: true, pois: body.pois as AmapPoi[] };
  }

  private toOption(p: AmapPoi, covers: number, dineAt: string | null): BookingOption {
    const name = amapStr(p.name);
    const keytag = amapStr(p.keytag);
    const perCapita = amapNum(p.biz_ext?.cost);
    const rating = amapNum(p.biz_ext?.rating);
    const distanceM = amapNum(p.distance);
    const address = amapStr(p.address);
    const tel = amapStr(p.tel);
    const openTime = amapStr(p.biz_ext?.opentime2) || amapStr(p.biz_ext?.open_time);
    const lngLat = amapStr(p.location).split(",");
    const lng = Number(lngLat[0]);
    const lat = Number(lngLat[1]);
    const hasCoord = Number.isFinite(lat) && Number.isFinite(lng);
    // 高德给的是 GCJ-02，全链路单边 WGS-84（与 travel POI 同一口径），
    // 原始火星坐标留在 extra 里供高德侧导航/深链回查
    const wgs = hasCoord ? gcj02ToWgs84(lat, lng) : null;

    const titleParts = [name, keytag, perCapita ? `人均 ¥${perCapita}` : ""].filter(Boolean);
    const descParts = [
      distanceM ? `距 ${distanceM >= 1000 ? `${(distanceM / 1000).toFixed(1)} 公里` : `${distanceM} 米`}` : "",
      rating ? `评分 ${rating}` : "",
      address,
    ].filter(Boolean);

    return {
      id: `amap-${amapStr(p.id) || name}`,
      provider: this.key,
      title: titleParts.join(" · "),
      description: descParts.join(" · "),
      // 预估消费 = 人均 × 人数（到店付）；平台没给人均就是 null，不猜
      amountCny: perCapita ? Math.round(perCapita * covers) : null,
      currency: "CNY",
      scheduleAt: dineAt,
      simulated: false,
      extra: {
        amapPoiId: amapStr(p.id),
        name,
        keytag,
        amapType: amapStr(p.type),
        typecode: amapStr(p.typecode),
        rating,
        perCapita,
        distanceMeters: distanceM,
        address,
        businessArea: amapStr(p.business_area),
        tel,
        openTime,
        covers,
        payAtStore: true,
        latitude: wgs?.latitude ?? null,
        longitude: wgs?.longitude ?? null,
        gcj02: hasCoord ? { latitude: lat, longitude: lng } : null,
      },
    };
  }

  // ------------------------------- 缓存 ------------------------------- //

  private cacheGet(key: string): AmapPoi[] | null {
    this.loadDisk();
    const hit = this.cache.get(key);
    if (!hit) return null;
    if (this.now() - hit.at >= this.ttlMs) {
      this.cache.delete(key);
      return null;
    }
    return hit.pois;
  }

  private cacheSet(key: string, pois: AmapPoi[]): void {
    this.cache.set(key, { at: this.now(), pois });
    this.saveDisk();
  }

  private loadDisk(): void {
    if (this.diskLoaded) return;
    this.diskLoaded = true;
    if (!this.cachePath) return;
    try {
      if (!existsSync(this.cachePath)) return;
      const parsed = JSON.parse(readFileSync(this.cachePath, "utf-8")) as Record<string, CacheEntry>;
      for (const [k, v] of Object.entries(parsed)) {
        if (v && typeof v.at === "number" && Array.isArray(v.pois) && this.now() - v.at < this.ttlMs) {
          this.cache.set(k, v);
        }
      }
    } catch {
      /* 损坏缓存当不存在 */
    }
  }

  private saveDisk(): void {
    if (!this.cachePath || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      try {
        mkdirSync(dirname(this.cachePath!), { recursive: true });
        const out: Record<string, CacheEntry> = {};
        for (const [k, v] of this.cache) out[k] = v;
        writeFileSync(this.cachePath!, JSON.stringify(out), "utf-8");
      } catch {
        /* 写失败不影响主流程（内存仍有） */
      }
    }, 1000);
    this.saveTimer.unref?.();
  }
}
