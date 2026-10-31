/**
 * 飞猪酒店「浏览器补价」源：flyai CLI 出名单，内置浏览器出实价。
 *
 * 为什么要有这一层：未配 FLYAI_API_KEY 时 flyai 处于体验模式，酒店名/地址/
 * 主图/详情链接都是真的，只有价格被脱敏成「¥2x」——按不造假原则一律不采信。
 * 而飞猪/携程酒店页对匿名无头浏览器直接跳登录（实测 0 条价格），只有用户
 * 自己登录过的内置浏览器才看得见实价。于是：
 *   flyai search-hotel → 真实 shId 名单 → 逐个开 hotel_detail2.htm 读页面价。
 *
 * 诚实边界：
 *   - 只在体验模式（API 给不出实价）时才去开浏览器，API 有实价即让位不重复取数
 *   - 解析不到就不报价（ok:false 带原因），绝不把「¥2x」当价格、绝不估一个数
 *   - 报价标 priceSource=scraped，note 说明是页面代查
 */

import type { ToolContext } from "../../../tools/tool-registry.js";
import { callFlyAi, strOf, isTrialMode, type FlyAiRunner } from "./flyai-quote-source.js";
import type { BrowserRunner } from "./browser-quote-source.js";
import type { QuoteRequest, QuoteSource, QuoteSourceResult, TravelQuote } from "./quote-source.js";

const SOURCE_ID = "fliggy.hotel.web";
const SOURCE_LABEL = "飞猪·内置浏览器代查";
/** 内置浏览器同一时刻只有一个面板页，串行开页——查太多家会把一轮拖到几分钟。 */
const DEFAULT_MAX_HOTELS = 4;
const DEFAULT_SETTLE_MS = 4_000;

export interface FliggyHotelWebSourceDeps {
  flyai: FlyAiRunner;
  browser: BrowserRunner;
  /** 单次最多代查几家酒店 */
  maxHotels?: number;
  /** 开页后等 SPA 渲染的毫秒数 */
  settleMs?: number;
}

/** 飞猪酒店详情页（链接形态取自 flyai detailUrl 解码后的真实落地地址）。 */
export function fliggyHotelDetailUrl(shId: string, req: QuoteRequest): string {
  const params = new URLSearchParams({ shid: shId, fli_newpage: "1" });
  const checkIn = (req.checkInDate ?? "").slice(0, 10);
  const checkOut = (req.checkOutDate ?? "").slice(0, 10);
  if (checkIn) params.set("checkIn", checkIn);
  if (checkOut) params.set("checkOut", checkOut);
  return `https://hotel.fliggy.com/hotel_detail2.htm?${params.toString()}`;
}

export interface ParsedDetailPrice {
  /** 每晚价格（CNY）；未解析到为 null */
  priceCny: number | null;
  /** 页面停在登录页（用户内置浏览器未登录淘宝/飞猪） */
  loginRequired: boolean;
}

/**
 * 从详情页正文解析每晚价。
 *
 * 取「酒店名之后」出现的最小 ¥ 金额：详情页在酒店名之后才是房型报价列表，
 * 首屏上方的会员/优惠券金额不算房价。酒店名不在页面里视为没落到正确页面，
 * 一律不报价（宁可没有，不可张冠李戴）。
 */
export function parseFliggyHotelDetailPrice(text: string, hotelName: string): ParsedDetailPrice {
  const loginPage = /登录淘宝|密码登录|短信登录|扫码登录/.test(text) && !/¥|￥/.test(text);
  if (loginPage) return { priceCny: null, loginRequired: true };
  const nameAt = hotelName ? text.indexOf(hotelName) : -1;
  if (hotelName && nameAt < 0) return { priceCny: null, loginRequired: false };
  const region = nameAt >= 0 ? text.slice(nameAt) : text;
  let min = Number.POSITIVE_INFINITY;
  for (const m of region.matchAll(/[¥￥]\s*(\d{2,5})(?![\d.])/g)) {
    const v = Number(m[1]);
    if (Number.isFinite(v) && v >= 50 && v <= 99_999) min = Math.min(min, v);
  }
  return {
    priceCny: Number.isFinite(min) ? min : null,
    loginRequired: /登录淘宝|密码登录|短信登录|扫码登录/.test(text),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => {
    const t = setTimeout(r, ms);
    t.unref?.();
  });
}

export function createFliggyHotelWebSource(deps: FliggyHotelWebSourceDeps): QuoteSource {
  const maxHotels = deps.maxHotels ?? DEFAULT_MAX_HOTELS;
  const settleMs = deps.settleMs ?? DEFAULT_SETTLE_MS;
  return {
    id: SOURCE_ID,
    label: SOURCE_LABEL,
    supports: (t) => t === "hotel",
    // 串行开 N 家详情页，远超聚合器默认单源超时；浏览器源自己报预算
    timeoutMs: maxHotels * (settleMs + 15_000) + 20_000,
    async fetch(req: QuoteRequest, ctx: ToolContext): Promise<QuoteSourceResult> {
      const city = (req.city || req.to || "").trim();
      if (!city) return { ok: true, quotes: [], note: `${SOURCE_LABEL} 不处理该查询（缺 city）` };

      const args = ["search-hotel", "--dest-name", city, "--sort", "price_asc"];
      if (req.checkInDate) args.push("--check-in-date", req.checkInDate.slice(0, 10));
      if (req.checkOutDate) args.push("--check-out-date", req.checkOutDate.slice(0, 10));
      if (req.hotelName) args.push("--key-words", req.hotelName);

      const res = await callFlyAi(deps.flyai, args);
      if ("error" in res) return { ok: false, error: `${SOURCE_LABEL}：${res.error}` };
      if (!isTrialMode(res.systemMessage)) {
        return { ok: true, quotes: [], note: "飞猪 API 已给出实价，无需浏览器代查" };
      }

      const targets = res.items
        .map((item) => ({ name: strOf(item, "name"), shId: strOf(item, "shId") }))
        .filter((t) => t.name && t.shId)
        .slice(0, maxHotels);
      if (targets.length === 0) {
        return { ok: false, error: `${SOURCE_LABEL}：飞猪未返回可代查的酒店（体验模式结果受限）` };
      }

      const nights = Math.max(
        1,
        Math.round(
          (Date.parse((req.checkOutDate ?? "").slice(0, 10)) -
            Date.parse((req.checkInDate ?? "").slice(0, 10))) /
            86_400_000 || 1,
        ),
      );
      const quotes: TravelQuote[] = [];
      let lastError = "";
      let sawLoginWall = false;
      for (const target of targets) {
        const url = fliggyHotelDetailUrl(target.shId, req);
        const opened = await deps.browser.open(ctx, url);
        if (!opened.ok || typeof opened.sessionId !== "string") {
          lastError = typeof opened.error === "string" ? opened.error : "开页失败";
          break;
        }
        const sessionId = opened.sessionId;
        try {
          await sleep(settleMs);
          const extracted = await deps.browser.extractText(ctx, sessionId);
          const text = typeof extracted.text === "string" ? extracted.text : "";
          if (!extracted.ok || !text) {
            lastError = typeof extracted.error === "string" ? extracted.error : "空页面";
            continue;
          }
          const parsed = parseFliggyHotelDetailPrice(text, target.name);
          if (parsed.loginRequired) sawLoginWall = true;
          if (parsed.priceCny == null) continue;
          quotes.push({
            source: SOURCE_ID,
            sourceLabel: SOURCE_LABEL,
            type: "hotel",
            name: target.name,
            to: city,
            checkInDate: req.checkInDate,
            amountCny: parsed.priceCny,
            nights,
            currency: "CNY",
            priceSource: "scraped",
            note: "飞猪详情页代查（内置浏览器登录态），以页面实价为准",
            fetchedAt: Date.now(),
          });
        } finally {
          await deps.browser.close(ctx, sessionId).catch(() => {});
        }
      }

      if (quotes.length === 0) {
        const why = sawLoginWall
          ? "飞猪详情页要求登录：请在内置浏览器登录淘宝/飞猪后重试"
          : lastError || "未从飞猪详情页解析到报价（页面结构变化或结果受限）";
        return { ok: false, error: `${SOURCE_LABEL}：${why}` };
      }
      return { ok: true, quotes };
    },
  };
}
