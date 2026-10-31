/**
 * 实时报价比价抽象层 —— 类型与源接口。
 *
 * 背景：travel 域（机票/火车票/酒店）此前没有真实报价来源：
 *   - flight/train 必须调用方给 basePriceCny（等于没有搜索）
 *   - hotel 只有本地价格库
 * 本抽象层把「报价来源」标准化：每个源实现 `QuoteSource`，由
 * `QuoteAggregator` 并行拉取、归一、比价。源分三类（诚实降级，不谎报）：
 *   - local：本地价格库（PricingService），priceSource=estimated/list
 *   - cli：官方/合作方 CLI 查询（如飞猪 flyai search-hotel/search-flight），priceSource=api
 *   - browser：浏览器代查商家站点（用户可见的内置浏览器 / 服务端无头），priceSource=scraped
 *
 * 设计约束：
 *   - 源失败/无数据返回 `{ ok: true, quotes: [] }`，不抛异常（聚合器兜底 catch）
 *   - 所有报价必须带 priceSource，透给用户的 note 必须如实说明来源
 *   - 新增报价源 = 实现本接口 + 注册进 QuoteAggregator，不动 provider
 */

import type { ToolContext } from "../../../tools/tool-registry.js";

/** 报价票种。 */
export type QuoteType = "flight" | "train" | "hotel";

/**
 * 价格来源（对齐 pricing-service 的 PriceSource 语义并扩展）：
 *   api      —— 真实 API（MCP/开放平台）
 *   database —— 本地真实数据库
 *   list     —— 价格库未优惠标价
 *   estimated—— 估算（本地费率表/基准价）
 *   scraped  —— 浏览器代查页面解析（以平台实价为准）
 */
export type QuotePriceSource = "api" | "database" | "list" | "estimated" | "scraped";

/** 比价请求（聚合器入参，provider 从 BookingSearchQuery.params 组装）。 */
export interface QuoteRequest {
  type: QuoteType;
  /** 出发城市/站（flight/train）；酒店可空 */
  from?: string;
  /** 到达城市/站（flight/train）；酒店=目的地城市 */
  to?: string;
  /** 城市（酒店必填） */
  city?: string;
  /** 航班号 / 车次（可选；有则定向报价） */
  code?: string;
  /** 出发日期时间（ISO 或 "YYYY-MM-DD HH:mm"） */
  departTime?: string;
  /** 入住日期（YYYY-MM-DD） */
  checkInDate?: string;
  /** 退房日期（YYYY-MM-DD） */
  checkOutDate?: string;
  /** 酒店名（可选，有则定向） */
  hotelName?: string;
  /** 酒店档次 */
  tier?: "budget" | "mid" | "luxury";
  /** 座位/舱位偏好 */
  seat?: string;
  /** 用户提供的基准价（flight/train 兜底估算用） */
  basePriceCny?: number;
}

/** 归一化报价（比价单元）。 */
export interface TravelQuote {
  /** 源标识（local / mcp.<alias> / browser.<site>） */
  source: string;
  /** 源展示名（「本地价格库」「滴滴」「浏览器代查·携程」） */
  sourceLabel: string;
  type: QuoteType;
  /** 航班号/车次/酒店名 */
  code?: string;
  name?: string;
  from?: string;
  to?: string;
  /** 出发时间（展示文本） */
  departTime?: string;
  /** 到达时间（展示文本） */
  arriveTime?: string;
  /** 舱位/席别/房型 */
  seat?: string;
  /** 入住日期（酒店，YYYY-MM-DD） */
  checkInDate?: string;
  /** 单价（CNY 元）；酒店=每晚 */
  amountCny: number;
  /** 晚数（酒店 >1 时总价 = amountCny × nights） */
  nights?: number;
  currency: "CNY";
  priceSource: QuotePriceSource;
  /** 来源说明（如实转告用户） */
  note?: string;
  /** 商家预订/收银台链接（如飞猪 detailUrl/jumpUrl）；可直接作 travel_booking.book 的 cashierUrl */
  bookingUrl?: string;
  /** 商品主图 URL（来源平台真实图，如飞猪 mainPic）；无真实图时不填，绝不拿占位图冒充 */
  mainPicUrl?: string;
  /** 平台评分（如飞猪 rate，0-5）；平台未返回时不填 */
  rating?: number;
  /** 报价抓取时间戳（ms） */
  fetchedAt: number;
}

/** 源返回。 */
export type QuoteSourceResult =
  | { ok: true; quotes: TravelQuote[]; note?: string }
  | { ok: false; error: string };

/**
 * 报价源接口。
 *
 * 实现约束：
 *   - `supports` 决定该源处理哪些票种（如滴滴 MCP 只支持 ride，不注册进 travel）
 *   - 不得抛异常；失败以 `{ ok: false, error }` 返回
 *   - 报价必须如实标注 priceSource，估算/代查必须带 note 说明
 */
export interface QuoteSource {
  readonly id: string;
  readonly label: string;
  supports(type: QuoteType): boolean;
  /** 本源超时（缺省用聚合器 timeoutMs）；浏览器代查这类慢源自行报预算 */
  readonly timeoutMs?: number;
  fetch(req: QuoteRequest, ctx: ToolContext): Promise<QuoteSourceResult>;
}

/** 单源比价结果（聚合器输出明细）。 */
export interface QuoteSourceOutcome {
  source: string;
  label: string;
  ok: boolean;
  error?: string;
  quotes: TravelQuote[];
}

/** 聚合结果。 */
export interface QuoteAggregate {
  ok: boolean;
  /** 归一并按价格升序的报价（比价列表） */
  quotes: TravelQuote[];
  /** 各源明细（含失败源，便于如实说明） */
  sources: QuoteSourceOutcome[];
  /** 汇总说明 */
  note?: string;
}

/** 聚合器选项。 */
export interface QuoteAggregatorOptions {
  /** 单源超时（默认 20s） */
  timeoutMs?: number;
  /** 最多返回报价数（默认 20） */
  maxQuotes?: number;
  now?: () => number;
}

/** 报价归一比较：价格升序，同源同级按名称稳定排序。 */
export function compareQuotes(a: TravelQuote, b: TravelQuote): number {
  const aTotal = a.nights && a.nights > 1 ? a.amountCny * a.nights : a.amountCny;
  const bTotal = b.nights && b.nights > 1 ? b.amountCny * b.nights : b.amountCny;
  if (aTotal !== bTotal) return aTotal - bTotal;
  return (a.name ?? a.code ?? "").localeCompare(b.name ?? b.code ?? "");
}
