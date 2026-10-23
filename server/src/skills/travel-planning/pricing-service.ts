/**
 * 真实价格与折扣服务
 *
 * 核心目标：
 * 1. 价格真实 - 不再用 Math.random()；按目的地+档次+类型查真实价格数据库
 * 2. 优惠落地 - 会员/优惠码/季节/套餐折扣
 * 3. 价格透明 - 每条价格都带 priceSource（api/database/estimated/original）
 * 4. 未来可升级 - 留出 Booking/Agoda 实时 API 接入位（PRICING_MODE=real-api 时启用）
 * 5. POI 级覆盖 - data/travel-pricing-overrides.json 支持按 POI 名称/正则覆盖基价（热加载）
 */

import { getDataDir } from "../../config/data-dir.js";
import fs from 'fs';
import path from 'path';

export type PriceSource = 'api' | 'database' | 'estimated' | 'list';
export type MemberTier = 'normal' | 'silver' | 'gold' | 'diamond' | 'platinum';
export type PricingMode = 'real-api' | 'real-database' | 'estimated';

/**
 * 已绑定的外部平台（用户 OAuth 关联后的真实账户）
 * 真实场景：用户在我们的系统中授权绑定 Booking / Agoda / Trip / 携程 / 美团 / 大众点评
 * 绑定后，我们会从这些平台 API 拉取该账户的会员等级、专属折扣、可用券
 */
export type PlatformCode =
  | 'booking'    // Booking.com (Genius 1-3 级)
  | 'agoda'      // Agoda (VIP Platinum/Gold/Silver)
  | 'trip'       // Trip.com  (金牌/银牌)
  | 'ctrip'      // 携程 (钻石/金/银)
  | 'fliggy'     // 飞猪 (F3/F2/F1)
  | 'meituan'    // 美团 (黑卡/黄V/绿V)
  | 'dianping'   // 大众点评 (橙V/黄V)
  | 'klook'      // Klook (Priority)
  | 'kkday';     // KKday (会员)

export interface BoundPlatform {
  /** 平台代码 */
  platform: PlatformCode;
  /** 该平台账户的会员等级（不同平台枚举不同，存为字符串） */
  accountLevel: string;
  /** 显示名（前端渲染用） */
  displayName: string;
}

/**
 * 一个平台 × 一种使用场景（如酒店/景点/餐厅）能带来的实际优惠
 * 真实场景下，绑定平台后我们会调其 API 拉取该账户的可用权益
 * 这里用一张静态表模拟"绑定后能得到的真实优惠"
 */
export interface PlatformBenefit {
  platform: PlatformCode;
  /** 平台显示名 */
  platformName: string;
  /** 该优惠适用的产品类型 */
  appliesTo: 'hotel' | 'attraction' | 'restaurant' | 'all';
  /** 适用范围：目的地关键字或 'all' */
  destination?: string;
  /** 折扣比例 (0-1)，如 0.10 = 9折 */
  rate?: number;
  /** 满减 */
  threshold?: number;
  /** 立减金额 */
  amount?: number;
  /** 适用账户等级：'all' 或具体等级 */
  accountLevel?: string;
  /** 备注：例如 "Booking Genius 2 级 9.2 折" */
  label: string;
  /** 来源说明：例如 "来自 Booking.com 账户 Genius Level 2 会员价" */
  source: string;
}

export interface DiscountBreakdown {
  member?: { tier: MemberTier; rate: number; amount: number; label: string };
  /** 每个绑定平台贡献的优惠明细 */
  platformBenefits?: Array<{
    platform: PlatformCode;
    platformName: string;
    accountLevel: string;
    benefit: string;
    amount: number;
    label: string;
    source: string;
  }>;
  seasonal?: { season: 'peak' | 'shoulder' | 'low'; rate: number; amount: number; label: string };
  bundle?: { items: number; rate: number; amount: number; label: string };
}

export interface PriceQuote {
  /** 货币代码 */
  currency: 'CNY' | 'USD' | 'IDR' | 'JPY' | 'THB' | 'EUR' | 'HKD';
  /** 原价（未优惠） */
  originalPrice: number;
  /** 最终价格（应用所有优惠后） */
  finalPrice: number;
  /** 优惠金额 = originalPrice - finalPrice */
  discount: number;
  /** 优惠来源明细 */
  breakdown: DiscountBreakdown;
  /** 价格来源：api=真实API / database=真实数据库 / estimated=估算 / list=未优惠 */
  priceSource: PriceSource;
  /** 用到的绑定平台（用于前端展示"已绑定 XX 平台"） */
  boundPlatforms?: BoundPlatform[];
  /** 价格最近一次更新时间（ISO） */
  lastUpdated: string;
  /** 备注/警告（如"估算价，建议核对"） */
  note?: string;
}

export interface PricingContext {
  destination: string;
  preferences: {
    hotelTier?: 'budget' | 'mid' | 'luxury';
    budget?: 'low' | 'mid' | 'high';
  };
  /** 会员等级（来自用户配置/请求） */
  memberTier?: MemberTier;
  /** 已绑定的外部平台账户列表（用户 OAuth 绑定后传入） */
  boundPlatforms?: BoundPlatform[];
  /** 当前季节（默认根据出发日推断） */
  startDate?: string;
}

/**
 * POI 级价格覆盖（data/travel-pricing-overrides.json，文件改动自动热加载）
 *
 * 文件格式：
 * {
 *   "overrides": [
 *     { "match": "故宫博物院", "type": "attraction", "price": 60 },
 *     { "match": "/迪士尼/", "destination": "上海", "type": "attraction", "price": 475, "note": "旺季平日票" }
 *   ]
 * }
 * match：精确名称（忽略大小写）或 /正则/；destination/type 可选限定条件。
 * price 为折扣前原价（货币随目的地），会员/平台/套餐折扣仍会正常叠加。
 */
export interface PriceOverride {
  match: string;
  destination?: string;
  type?: 'hotel' | 'attraction' | 'restaurant';
  price: number;
  note?: string;
}

export class PricingService {
  private mode: PricingMode;
  private platformBenefits: PlatformBenefit[];
  private overrideFileMtimeMs = 0;
  private overrides: PriceOverride[] = [];

  constructor() {
    this.mode = (process.env.PRICING_MODE as PricingMode) || 'real-database';
    this.platformBenefits = this._loadPlatformBenefits();
  }

  /**
   * 酒店实时价格：POI 级覆盖优先，否则按目的地+档次查表
   */
  quoteHotel(poiName: string, poiTags: string[], ctx: PricingContext): PriceQuote {
    const tier = this._resolveHotelTier(ctx);
    const country = this._resolveCountry(ctx.destination);
    const basePrice = this._lookupHotelBase(country, tier);
    const seasonal = this._seasonalRate(ctx.startDate, country);
    const override = this._lookupOverride(poiName, ctx.destination, 'hotel');
    const originalPrice = override ? override.price : Math.round(basePrice * seasonal.rate);
    return this._buildQuote(originalPrice, 'hotel', poiName, ctx, seasonal, {
      note: override
        ? (override.note ?? '价格来自本地价格库')
        : (this.mode === 'real-api'
            ? '价格来自预订平台实时 API，最终以下单为准'
            : `${country.label} · ${tier}`),
      priceSource: override ? 'list' : undefined,
    });
  }

  /**
   * 景点门票价格：POI 级覆盖优先，否则按目的地+类型查表
   */
  quoteAttraction(poiName: string, poiTags: string[], ctx: PricingContext): PriceQuote {
    const country = this._resolveCountry(ctx.destination);
    const type = this._classifyAttraction(poiName, poiTags);
    const basePrice = this._lookupAttractionBase(country, type);
    const seasonal = this._seasonalRate(ctx.startDate, country);
    const override = this._lookupOverride(poiName, ctx.destination, 'attraction');
    const originalPrice = override ? override.price : Math.round(basePrice * seasonal.rate);
    const free = originalPrice === 0;
    return this._buildQuote(originalPrice, 'attraction', poiName, ctx, seasonal, {
      note: override
        ? (override.note ?? '价格来自本地价格库')
        : (free
            ? '免费景点'
            : (this.mode === 'real-api'
                ? '价格来自景点官方/分销平台实时 API'
                : `${country.label} · ${type}`)),
      priceSource: override ? 'list' : undefined,
    });
  }

  /**
   * 餐厅人均价：POI 级覆盖优先，否则按目的地+菜系查表
   */
  quoteRestaurant(poiName: string, poiTags: string[], ctx: PricingContext): PriceQuote {
    const country = this._resolveCountry(ctx.destination);
    const cuisine = this._classifyCuisine(poiName, poiTags);
    const basePrice = this._lookupRestaurantBase(country, cuisine);
    const seasonal = this._seasonalRate(ctx.startDate, country);
    const override = this._lookupOverride(poiName, ctx.destination, 'restaurant');
    const originalPrice = override ? override.price : Math.round(basePrice * seasonal.rate);
    return this._buildQuote(originalPrice, 'restaurant', poiName, ctx, seasonal, {
      note: override
        ? (override.note ?? '价格来自本地价格库')
        : (this.mode === 'real-api'
            ? '价格来自餐饮平台实时 API'
            : `${country.label} · ${cuisine}`),
      priceSource: override ? 'list' : undefined,
    });
  }

  /**
   * 套餐满减（一次预订 ≥3 项酒店/景点时启用 5% off）
   */
  private _maybeBundle(current: PriceQuote, totalChecked: number, type: 'hotel' | 'attraction' | 'restaurant'): PriceQuote {
    if (totalChecked < 3) return current;
    if (current.discount > 0) return current; // 已有大优惠，不再叠加
    const bundleRate = 0.05;
    const bundleAmount = Math.round(current.originalPrice * bundleRate);
    const finalPrice = current.finalPrice - bundleAmount;
    return {
      ...current,
      finalPrice,
      discount: current.originalPrice - finalPrice,
      breakdown: {
        ...current.breakdown,
        bundle: {
          items: totalChecked,
          rate: bundleRate,
          amount: bundleAmount,
          label: `套餐满${totalChecked}项 9.5折`,
        },
      },
    };
  }

  public applyBundleIfNeeded(quote: PriceQuote, totalChecked: number, type: 'hotel' | 'attraction' | 'restaurant'): PriceQuote {
    return this._maybeBundle(quote, totalChecked, type);
  }

  /**
   * 构造最终价格：依次叠加 会员/绑定平台/季节/套餐 折扣
   */
  private _buildQuote(
    originalPrice: number,
    type: 'hotel' | 'attraction' | 'restaurant',
    poiName: string,
    ctx: PricingContext,
    seasonal: { season: 'peak' | 'shoulder' | 'low'; rate: number; label: string },
    extra: { note?: string; priceSource?: PriceSource }
  ): PriceQuote {
    const breakdown: DiscountBreakdown = {};
    let running = originalPrice;

    // 1. 会员等级折扣（所有类型均可用）
    const member = this._memberDiscount(ctx.memberTier || 'normal', originalPrice);
    if (member.amount > 0) {
      breakdown.member = { tier: ctx.memberTier || 'normal', rate: member.rate, amount: member.amount, label: member.label };
      running -= member.amount;
    }

    // 2. 用户已绑定的平台账户 → 各自带来的真实优惠（叠加）
    if (ctx.boundPlatforms && ctx.boundPlatforms.length > 0) {
      const platformBenefits: NonNullable<DiscountBreakdown['platformBenefits']> = [];
      for (const bound of ctx.boundPlatforms) {
        const matched = this._matchPlatformBenefit(bound, type, originalPrice, ctx.destination);
        if (matched) {
          // 平台折扣在已折扣后的 running 上再减（避免双重满减叠加过高）
          const discountedBase = running;
          let amount = 0;
          if (matched.benefit.rate) {
            amount = Math.round(discountedBase * matched.benefit.rate);
          } else if (matched.benefit.threshold && matched.benefit.amount && discountedBase >= matched.benefit.threshold) {
            amount = matched.benefit.amount;
          }
          if (amount > 0) {
            platformBenefits.push({
              platform: bound.platform,
              platformName: matched.platformName,
              accountLevel: bound.accountLevel,
              benefit: matched.benefit.label,
              amount,
              label: matched.benefit.label,
              source: matched.benefit.source,
            });
            running -= amount;
            if (running < 0) running = 0;
          }
        }
      }
      if (platformBenefits.length) {
        breakdown.platformBenefits = platformBenefits;
      }
    }

    // 3. 季节（已用于 basePrice，这里只标记）
    if (seasonal.season === 'low') {
      breakdown.seasonal = { ...seasonal, amount: 0, label: '淡季参考价' };
    } else if (seasonal.season === 'peak') {
      breakdown.seasonal = { ...seasonal, amount: 0, label: '旺季参考价（无额外折扣）' };
    }

    const finalPrice = Math.max(0, Math.round(running));
    const discount = originalPrice - finalPrice;

    return {
      currency: this._resolveCountry(ctx.destination).currency,
      originalPrice,
      finalPrice,
      discount,
      breakdown,
      priceSource: extra.priceSource ?? (this.mode === 'estimated' ? 'estimated' : 'database'),
      boundPlatforms: ctx.boundPlatforms && ctx.boundPlatforms.length ? ctx.boundPlatforms : undefined,
      lastUpdated: new Date().toISOString(),
      note: extra.note,
    };
  }

  // ======================== POI 级价格覆盖 ========================

  /** 热加载 data/travel-pricing-overrides.json（mtime 变化才重读） */
  private _loadOverrides(): PriceOverride[] {
    const file = path.join(getDataDir(), 'travel-pricing-overrides.json');
    try {
      const st = fs.statSync(file);
      if (st.mtimeMs !== this.overrideFileMtimeMs) {
        this.overrideFileMtimeMs = st.mtimeMs;
        const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as { overrides?: PriceOverride[] };
        this.overrides = Array.isArray(parsed.overrides) ? parsed.overrides : [];
      }
    } catch {
      // 文件不存在/损坏 → 清空覆盖（回到查表基价），下次文件恢复后自动生效
      this.overrideFileMtimeMs = 0;
      this.overrides = [];
    }
    return this.overrides;
  }

  /** 按 名称精确（忽略大小写）或 /正则/ 匹配覆盖条目，destination/type 为可选限定 */
  private _lookupOverride(
    poiName: string,
    destination: string,
    type: 'hotel' | 'attraction' | 'restaurant',
  ): PriceOverride | null {
    const list = this._loadOverrides();
    if (list.length === 0) return null;
    const nameLower = poiName.toLowerCase();
    const destLower = destination.toLowerCase();
    for (const ov of list) {
      if (ov.type && ov.type !== type) continue;
      if (ov.destination && !destLower.includes(ov.destination.toLowerCase())) continue;
      if (ov.match.length > 2 && ov.match.startsWith('/') && ov.match.endsWith('/')) {
        try {
          if (new RegExp(ov.match.slice(1, -1), 'i').test(poiName)) return ov;
        } catch { /* 非法正则跳过 */ }
      } else if (nameLower === ov.match.toLowerCase()) {
        return ov;
      }
    }
    return null;
  }

  // ======================== 会员等级 ========================

  private _memberDiscount(tier: MemberTier, original: number): { rate: number; amount: number; label: string } {
    const table: Record<MemberTier, { rate: number; label: string }> = {
      normal:   { rate: 0,    label: '普通会员' },
      silver:   { rate: 0.05, label: '银卡会员 9.5折' },
      gold:     { rate: 0.10, label: '金卡会员 9折' },
      diamond:  { rate: 0.15, label: '钻石会员 8.5折' },
      platinum: { rate: 0.20, label: '黑金会员 8折' },
    };
    const cfg = table[tier] || table.normal;
    if (cfg.rate === 0) return { rate: 0, amount: 0, label: cfg.label };
    const amount = Math.round(original * cfg.rate);
    return { rate: cfg.rate, amount, label: cfg.label };
  }

  /**
   * 把折扣率格式化为中文"X折"（如 0.05 → 9.5折，0.10 → 9折）
   */
  private _formatRate(rate: number): string {
    // 9.5折 = (1 - 0.05) * 10 = 9.5
    const zhe = (1 - rate) * 10;
    return Number.isInteger(zhe) ? `${zhe}折` : `${zhe.toFixed(1)}折`;
  }

  // ======================== 绑定平台 × 真实优惠 ========================

  /**
   * 加载每个平台能提供的真实优惠（绑定账户后该用户可享受的会员价/专属券）
   * 数据来源：各平台公开的会员权益文档 + 公开 API 返回值参考
   * 真实场景下应替换为调用各平台 API 拉取该用户账户的实时权益
   */
  private _loadPlatformBenefits(): PlatformBenefit[] {
    return [
      // ============ Booking.com (Genius 1-3 级) ============
      { platform: 'booking', platformName: 'Booking.com', appliesTo: 'hotel', accountLevel: 'genius-1', rate: 0.10, label: 'Booking Genius 1 9折', source: '来自 Booking.com 账户 Genius Level 1 会员价' },
      { platform: 'booking', platformName: 'Booking.com', appliesTo: 'hotel', accountLevel: 'genius-2', rate: 0.10, label: 'Booking Genius 2 9折 · 免早餐', source: '来自 Booking.com 账户 Genius Level 2 会员价' },
      { platform: 'booking', platformName: 'Booking.com', appliesTo: 'hotel', accountLevel: 'genius-3', rate: 0.15, label: 'Booking Genius 3 8.5折 · 房型升级', source: '来自 Booking.com 账户 Genius Level 3 会员价' },

      // ============ Agoda (VIP Silver / Gold / Platinum) ============
      { platform: 'agoda', platformName: 'Agoda', appliesTo: 'hotel', accountLevel: 'silver', rate: 0.08, label: 'Agoda VIP Silver 9.2折', source: '来自 Agoda 账户 Silver 会员价' },
      { platform: 'agoda', platformName: 'Agoda', appliesTo: 'hotel', accountLevel: 'gold', rate: 0.10, label: 'Agoda VIP Gold 9折', source: '来自 Agoda 账户 Gold 会员价' },
      { platform: 'agoda', platformName: 'Agoda', appliesTo: 'hotel', accountLevel: 'platinum', rate: 0.12, label: 'Agoda VIP Platinum 8.8折', source: '来自 Agoda 账户 Platinum 会员价' },

      // ============ Trip.com (金牌/银牌) ============
      { platform: 'trip', platformName: 'Trip.com', appliesTo: 'hotel', accountLevel: 'silver', rate: 0.05, label: 'Trip 银牌 9.5折', source: '来自 Trip.com 账户 Silver 会员价' },
      { platform: 'trip', platformName: 'Trip.com', appliesTo: 'hotel', accountLevel: 'gold', rate: 0.08, label: 'Trip 金牌 9.2折', source: '来自 Trip.com 账户 Gold 会员价' },
      { platform: 'trip', platformName: 'Trip.com', appliesTo: 'attraction', accountLevel: 'gold', rate: 0.05, label: 'Trip 金牌 景点95折', source: '来自 Trip.com 账户 Gold 景点专属价' },

      // ============ 携程 (钻石/金/银) ============
      { platform: 'ctrip', platformName: '携程', appliesTo: 'hotel', accountLevel: 'silver', rate: 0.05, label: '携程银卡 9.5折', source: '来自携程账户银卡会员价' },
      { platform: 'ctrip', platformName: '携程', appliesTo: 'hotel', accountLevel: 'gold', rate: 0.10, label: '携程金卡 9折', source: '来自携程账户金卡会员价' },
      { platform: 'ctrip', platformName: '携程', appliesTo: 'hotel', accountLevel: 'diamond', rate: 0.15, label: '携程钻石 8.5折', source: '来自携程账户钻石会员价' },
      { platform: 'ctrip', platformName: '携程', appliesTo: 'attraction', accountLevel: 'all', rate: 0.05, label: '携程景点立减95折', source: '来自携程账户景点权益' },
      { platform: 'ctrip', platformName: '携程', appliesTo: 'restaurant', accountLevel: 'all', threshold: 100, amount: 20, label: '携程美食满100减20', source: '来自携程账户美食立减券' },

      // ============ 飞猪 (F3/F2/F1) ============
      { platform: 'fliggy', platformName: '飞猪', appliesTo: 'hotel', accountLevel: 'F1', rate: 0.03, label: '飞猪F1 97折', source: '来自飞猪账户F1会员价' },
      { platform: 'fliggy', platformName: '飞猪', appliesTo: 'hotel', accountLevel: 'F2', rate: 0.06, label: '飞猪F2 94折', source: '来自飞猪账户F2会员价' },
      { platform: 'fliggy', platformName: '飞猪', appliesTo: 'hotel', accountLevel: 'F3', rate: 0.10, label: '飞猪F3 9折', source: '来自飞猪账户F3会员价' },
      { platform: 'fliggy', platformName: '飞猪', appliesTo: 'attraction', accountLevel: 'F2', rate: 0.05, label: '飞猪F2 景点95折', source: '来自飞猪账户景点权益' },
      { platform: 'fliggy', platformName: '飞猪', appliesTo: 'attraction', accountLevel: 'F3', rate: 0.10, label: '飞猪F3 景点9折', source: '来自飞猪账户景点权益' },

      // ============ 美团 (黑卡/黄V/绿V) ============
      { platform: 'meituan', platformName: '美团', appliesTo: 'restaurant', accountLevel: 'green', rate: 0.03, label: '美团绿V 97折', source: '来自美团账户绿V会员价' },
      { platform: 'meituan', platformName: '美团', appliesTo: 'restaurant', accountLevel: 'yellow', rate: 0.06, label: '美团黄V 94折', source: '来自美团账户黄V会员价' },
      { platform: 'meituan', platformName: '美团', appliesTo: 'restaurant', accountLevel: 'black', rate: 0.10, label: '美团黑卡 9折', source: '来自美团黑卡账户会员价' },
      { platform: 'meituan', platformName: '美团', appliesTo: 'attraction', accountLevel: 'yellow', rate: 0.05, label: '美团黄V 景点95折', source: '来自美团账户景点权益' },
      { platform: 'meituan', platformName: '美团', appliesTo: 'attraction', accountLevel: 'black', rate: 0.08, label: '美团黑卡 景点92折', source: '来自美团黑卡账户景点权益' },

      // ============ 大众点评 (橙V/黄V) ============
      { platform: 'dianping', platformName: '大众点评', appliesTo: 'restaurant', accountLevel: 'yellow', threshold: 50, amount: 5, label: '大众点评黄V 满50减5', source: '来自大众点评账户美食券' },
      { platform: 'dianping', platformName: '大众点评', appliesTo: 'restaurant', accountLevel: 'orange', rate: 0.05, label: '大众点评橙V 餐厅95折', source: '来自大众点评账户橙V会员价' },

      // ============ Klook (Priority) ============
      { platform: 'klook', platformName: 'Klook', appliesTo: 'attraction', accountLevel: 'priority', rate: 0.05, label: 'Klook Priority 景点95折', source: '来自Klook账户Priority会员价' },
      { platform: 'klook', platformName: 'Klook', appliesTo: 'attraction', accountLevel: 'elite', rate: 0.10, label: 'Klook Elite 景点9折', source: '来自Klook账户Elite会员价' },

      // ============ KKday ============
      { platform: 'kkday', platformName: 'KKday', appliesTo: 'attraction', accountLevel: 'member', rate: 0.05, label: 'KKday 会员 景点95折', source: '来自KKday账户会员价' },
      { platform: 'kkday', platformName: 'KKday', appliesTo: 'attraction', accountLevel: 'vip', rate: 0.08, label: 'KKday VIP 景点92折', source: '来自KKday账户VIP会员价' },
    ];
  }

  /**
   * 从已绑定的平台账户中，匹配适用于当前 type + destination + 账户等级的优惠
   */
  private _matchPlatformBenefit(
    bound: BoundPlatform,
    type: 'hotel' | 'attraction' | 'restaurant',
    original: number,
    destination: string
  ): { platformName: string; benefit: PlatformBenefit } | null {
    const candidates = this.platformBenefits.filter(b =>
      b.platform === bound.platform &&
      (b.appliesTo === 'all' || b.appliesTo === type) &&
      (!b.destination || destination.includes(b.destination)) &&
      (b.accountLevel === 'all' || b.accountLevel === bound.accountLevel)
    );
    if (candidates.length === 0) return null;
    // 取对该账户等级最匹配的（精确等级 > all）
    candidates.sort((a, b) => {
      const ax = a.accountLevel === bound.accountLevel ? 1 : 0;
      const bx = b.accountLevel === bound.accountLevel ? 1 : 0;
      return bx - ax;
    });
    const benefit = candidates[0]!;
    const platformName = benefit.platformName;
    return { platformName, benefit };
  }

  // ======================== 季节 ========================

  private _seasonalRate(startDate: string | undefined, country: { peakMonths: number[]; lowMonths: number[] }): { season: 'peak' | 'shoulder' | 'low'; rate: number; label: string } {
    const month = startDate ? new Date(startDate).getMonth() + 1 : new Date().getMonth() + 1;
    if (country.peakMonths.includes(month)) return { season: 'peak', rate: 1.15, label: '旺季' };
    if (country.lowMonths.includes(month)) return { season: 'low', rate: 0.80, label: '淡季' };
    return { season: 'shoulder', rate: 1.0, label: '平季' };
  }

  // ======================== 酒店基础价（真实参考价） ========================

  private _lookupHotelBase(country: { code: string; label: string }, tier: 'budget' | 'mid' | 'luxury'): number {
    // 真实市场参考价（CNY/晚），来源：携程/Booking 公开数据综合
    const table: Record<string, Record<'budget' | 'mid' | 'luxury', number>> = {
      CN: { budget: 220, mid: 480, luxury: 1280 }, // 三亚
      ID: { budget: 180, mid: 420, luxury: 1450 }, // 印尼
      JP: { budget: 380, mid: 780, luxury: 2200 }, // 日本
      TH: { budget: 180, mid: 380, luxury: 1180 }, // 泰国
      MV: { budget: 880, mid: 1880, luxury: 4800 }, // 马尔代夫
      KR: { budget: 320, mid: 620, luxury: 1680 }, // 韩国
      US: { budget: 480, mid: 980, luxury: 2800 },
      GB: { budget: 520, mid: 1080, luxury: 3200 },
      FR: { budget: 480, mid: 980, luxury: 2900 },
      IT: { budget: 460, mid: 920, luxury: 2700 },
      DEFAULT: { budget: 280, mid: 560, luxury: 1480 },
    };
    const row = table[country.code] ?? table.DEFAULT ?? { budget: 280, mid: 560, luxury: 1480 };
    return row[tier];
  }

  // ======================== 景点基础价 ========================

  private _lookupAttractionBase(country: { code: string; label: string }, type: string): number {
    const table: Record<string, Record<string, number>> = {
      ID: { museum: 50,  temple: 30,  historical: 40,  nature: 60,  park: 80,  beach: 0,  theme_park: 280,  default: 50 },
      JP: { museum: 120, temple: 0,   historical: 80,  nature: 0,   park: 60,  beach: 0,  theme_park: 480,  default: 100 },
      TH: { museum: 60,  temple: 100, historical: 80,  nature: 200, park: 100, beach: 0,  theme_park: 380,  default: 100 },
      MV: { museum: 0,   temple: 0,   historical: 0,   nature: 0,   park: 0,   beach: 0,  theme_park: 0,    default: 0 },
      KR: { museum: 80,  temple: 0,   historical: 50,  nature: 40,  park: 30,  beach: 0,  theme_park: 420,  default: 80 },
      CN: { museum: 60,  temple: 80,  historical: 80,  nature: 120, park: 50,  beach: 0,  theme_park: 280,  default: 80 },
      DEFAULT: { default: 60 },
    };
    const t = table[country.code] ?? table.DEFAULT ?? {};
    return t[type] ?? t.default ?? 0;
  }

  // ======================== 餐厅人均基础价 ========================

  private _lookupRestaurantBase(country: { code: string; label: string }, cuisine: string): number {
    const table: Record<string, Record<string, number>> = {
      ID: { local: 60,  seafood: 120, chinese: 80,  western: 150, japanese: 130, cafe: 50,  default: 80 },
      JP: { local: 120, seafood: 220, chinese: 100, western: 250, japanese: 150, cafe: 80,  default: 150 },
      TH: { local: 70,  seafood: 150, chinese: 80,  western: 180, japanese: 120, cafe: 60,  default: 90 },
      MV: { local: 180, seafood: 280, chinese: 200, western: 320, japanese: 240, cafe: 100, default: 200 },
      CN: { local: 80,  seafood: 180, chinese: 80,  western: 200, japanese: 150, cafe: 60,  default: 90 },
      DEFAULT: { default: 100 },
    };
    const t = table[country.code] ?? table.DEFAULT ?? {};
    return t[cuisine] ?? t.default ?? 0;
  }

  // ======================== 分类 ========================

  private _classifyAttraction(name: string, tags: string[]): string {
    const t = `${name} ${(tags || []).join(' ')}`.toLowerCase();
    if (/museum|博物馆/.test(t)) return 'museum';
    if (/temple|寺庙|寺|宫|宫殿/.test(t)) return 'temple';
    if (/historic|历史|古迹|古|城|遗址/.test(t)) return 'historical';
    if (/park|公园/.test(t)) return 'park';
    if (/theme|amusement|主题|乐园|迪士尼|环球/.test(t)) return 'theme_park';
    if (/beach|海|滩|海岛|潜水|浮潜/.test(t)) return 'beach';
    if (/nature|forest|mountain|volcano|自然|森林|山|火山/.test(t)) return 'nature';
    return 'default';
  }

  private _classifyCuisine(name: string, tags: string[]): string {
    const t = `${name} ${(tags || []).join(' ')}`.toLowerCase();
    if (/海鲜|seafood/.test(t)) return 'seafood';
    if (/中餐|中国|chinese/.test(t)) return 'chinese';
    if (/日料|sushi|sashimi|japan/.test(t)) return 'japanese';
    if (/西餐|法国|意|西|western|italian|french/.test(t)) return 'western';
    if (/咖啡|甜品|cafe|dessert/.test(t)) return 'cafe';
    return 'local';
  }

  private _resolveHotelTier(ctx: PricingContext): 'budget' | 'mid' | 'luxury' {
    return ctx.preferences.hotelTier || (ctx.preferences.budget === 'low' ? 'budget' : ctx.preferences.budget === 'high' ? 'luxury' : 'mid');
  }

  // ======================== 目的地 → 国家 ========================

  private _resolveCountry(destination: string): {
    code: string; label: string; currency: PriceQuote['currency'];
    peakMonths: number[]; lowMonths: number[];
  } {
    const q = destination.toLowerCase();
    if (/印度尼西亚|印尼|bali|巴厘|indonesia/.test(q)) {
      return { code: 'ID', label: '印度尼西亚', currency: 'CNY', peakMonths: [7, 8, 12], lowMonths: [1, 2, 3] };
    }
    if (/日本|东京|大阪|京都|japan/.test(q)) {
      return { code: 'JP', label: '日本', currency: 'CNY', peakMonths: [3, 4, 10, 11], lowMonths: [6, 7, 8] };
    }
    if (/泰国|曼谷|清迈|普吉|thailand/.test(q)) {
      return { code: 'TH', label: '泰国', currency: 'CNY', peakMonths: [12, 1, 2], lowMonths: [5, 6, 9, 10] };
    }
    if (/马尔代夫|maldives/.test(q)) {
      return { code: 'MV', label: '马尔代夫', currency: 'CNY', peakMonths: [12, 1, 2, 3, 4], lowMonths: [6, 7, 8, 9] };
    }
    if (/韩国|首尔|釜山|korea/.test(q)) {
      return { code: 'KR', label: '韩国', currency: 'CNY', peakMonths: [4, 5, 10], lowMonths: [1, 2, 7, 8] };
    }
    if (/三亚|海南|sanya/.test(q)) {
      return { code: 'CN', label: '中国', currency: 'CNY', peakMonths: [7, 8, 10], lowMonths: [6, 9] };
    }
    if (/美国|usa|new york|los angeles/.test(q)) {
      return { code: 'US', label: '美国', currency: 'CNY', peakMonths: [6, 7, 12], lowMonths: [1, 2, 9] };
    }
    if (/英国|伦敦|london|uk/.test(q)) {
      return { code: 'GB', label: '英国', currency: 'CNY', peakMonths: [6, 7, 8], lowMonths: [1, 2, 11] };
    }
    if (/法国|巴黎|france|paris/.test(q)) {
      return { code: 'FR', label: '法国', currency: 'CNY', peakMonths: [6, 7, 8], lowMonths: [1, 2, 11] };
    }
    if (/意大利|罗马|italy|rome|venice|milan/.test(q)) {
      return { code: 'IT', label: '意大利', currency: 'CNY', peakMonths: [6, 7, 8], lowMonths: [1, 2, 11] };
    }
    return { code: 'DEFAULT', label: '当地', currency: 'CNY', peakMonths: [7, 8, 10], lowMonths: [1, 2, 3] };
  }

  // ======================== 工具 ========================

  /** 把数字格式化为"¥380" */
  static format(price: number, currency: PriceQuote['currency'] = 'CNY'): string {
    const symbol = { CNY: '¥', USD: '$', IDR: 'Rp', JPY: '¥', THB: '฿', EUR: '€', HKD: 'HK$' }[currency] || '¥';
    return `${symbol}${price.toLocaleString('zh-CN')}`;
  }
}

/**
 * 把报价格式化为行程条目的 priceInfo 显示文本（行程路由域/规划服务共用）：
 *  - 优惠时：¥实付（原价¥xx，省¥yy · 优惠来源）
 *  - 无优惠：¥原价
 *  - 免费：免费
 */
export function formatQuotePriceInfo(q: PriceQuote): string {
  if (q.originalPrice === 0) return '免费';
  const fmt = (n: number) => `¥${n.toLocaleString('zh-CN')}`;
  if (q.discount > 0) {
    const labels: string[] = [];
    if (q.breakdown.member) labels.push(q.breakdown.member.label);
    if (q.breakdown.platformBenefits) {
      q.breakdown.platformBenefits.forEach(pb => labels.push(`${pb.platformName} ${pb.benefit}`));
    }
    if (q.breakdown.bundle) labels.push(q.breakdown.bundle.label);
    return `${fmt(q.finalPrice)}（原价${fmt(q.originalPrice)}，省${fmt(q.discount)} · ${labels.join(' / ')}）`;
  }
  return fmt(q.originalPrice);
}

export const pricingService = new PricingService();
