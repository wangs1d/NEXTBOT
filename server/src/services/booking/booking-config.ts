/**
 * 预订层配置（env 驱动，风格对齐 config/payment-config.ts）。
 *
 *   BOOKING_MODE                    live | mock（默认 mock：仅注册模拟 Provider，
 *                                   所有结果带 simulated=true，不会真实下单）
 *   BOOKING_MAX_AMOUNT_CNY          单笔上限（默认 1000；超限拒绝提交）
 *   BOOKING_DAILY_BUDGET_CNY        单日累计上限（默认 500；0 = 不限）
 *   BOOKING_CONFIRMATION_TTL_MS     两阶段确认 token TTL（默认 5 分钟）
 *   RIDE_AMAP_WEB_KEY               高德 Web 服务 key（复用 AMAP_WEB_KEY；
 *                                   路线距离/时长 → 本地费率表估价）
 *   RIDE_AMAP_ENTERPRISE_BASE_URL   高德打车企业版 open API base（企业资质开通后
 *                                   配置；不配则仅支持估价，下单返回明确错误）
 *   RIDE_AMAP_ENTERPRISE_TOKEN      高德打车企业版鉴权 token
 *   RESTAURANT_POI_CACHE_TTL_MS     餐厅真实 POI 检索缓存 TTL（默认 7 天）
 */

export interface BookingConfig {
  mode: "live" | "mock";
  /** 单笔金额上限（CNY） */
  maxAmountCny: number;
  /** 单日累计上限（CNY）；0 = 不限 */
  dailyBudgetCny: number;
  /** 两阶段确认 token TTL（毫秒） */
  confirmationTtlMs: number;
  /** 高德 Web 服务 key（估价用；缺省回退 AMAP_WEB_KEY） */
  rideAmapWebKey: string;
  /** 高德 Web 服务 key（餐厅真实 POI 检索用；与 ride 同源，独立命名便于分开授权） */
  amapWebKey: string;
  /** 餐厅 POI 检索缓存 TTL（毫秒） */
  restaurantPoiCacheTtlMs: number;
  /** 高德打车企业版 base URL（空 = 未接入真实下单） */
  rideAmapEnterpriseBaseUrl: string;
  rideAmapEnterpriseToken: string;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const v = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

function parseNonNegativeInt(raw: string | undefined, fallback: number): number {
  const v = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

function parseMode(raw: string | undefined): "live" | "mock" {
  const v = raw?.trim().toLowerCase();
  return v === "live" ? "live" : "mock";
}

export function getBookingConfig(env: NodeJS.ProcessEnv = process.env): BookingConfig {
  return {
    mode: parseMode(env.BOOKING_MODE),
    maxAmountCny: parsePositiveInt(env.BOOKING_MAX_AMOUNT_CNY, 1000),
    dailyBudgetCny: parseNonNegativeInt(env.BOOKING_DAILY_BUDGET_CNY, 500),
    confirmationTtlMs: parsePositiveInt(env.BOOKING_CONFIRMATION_TTL_MS, 300_000),
    rideAmapWebKey: env.RIDE_AMAP_WEB_KEY?.trim() || env.AMAP_WEB_KEY?.trim() || "",
    amapWebKey: env.AMAP_WEB_KEY?.trim() || env.RIDE_AMAP_WEB_KEY?.trim() || "",
    restaurantPoiCacheTtlMs: parsePositiveInt(env.RESTAURANT_POI_CACHE_TTL_MS, 7 * 24 * 60 * 60 * 1000),
    rideAmapEnterpriseBaseUrl: env.RIDE_AMAP_ENTERPRISE_BASE_URL?.trim() || "",
    rideAmapEnterpriseToken: env.RIDE_AMAP_ENTERPRISE_TOKEN?.trim() || "",
  };
}
