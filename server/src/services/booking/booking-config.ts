/**
 * 预订层配置（env 驱动，风格对齐 config/payment-config.ts）。
 *
 *   BOOKING_MODE                    live | mock（默认 mock：仅注册模拟 Provider，
 *                                   所有结果带 simulated=true，不会真实下单）
 *   BOOKING_MAX_AMOUNT_CNY          单笔上限（默认 0 = 不限；所有下单均需用户在
 *                                   确认卡上明确同意，硬限额只在显式配置时生效）
 *   BOOKING_DAILY_BUDGET_CNY        单日累计上限（默认 0 = 不限）
 *   BOOKING_CONFIRMATION_TTL_MS     两阶段确认 token TTL（默认 5 分钟）
 *   AMAP_WEB_KEY                    高德 Web 服务 key（餐厅真实 POI 检索）
 *   RESTAURANT_POI_CACHE_TTL_MS     餐厅真实 POI 检索缓存 TTL（默认 7 天）
 */

export interface BookingConfig {
  mode: "live" | "mock";
  /** 单笔金额上限（CNY）；0 = 不限（默认）。下单本就需用户确认卡同意。 */
  maxAmountCny: number;
  /** 单日累计上限（CNY）；0 = 不限（默认） */
  dailyBudgetCny: number;
  /** 两阶段确认 token TTL（毫秒） */
  confirmationTtlMs: number;
  /** 高德 Web 服务 key（餐厅真实 POI 检索用；缺省回退 AMAP_WEB_KEY） */
  amapWebKey: string;
  /** 餐厅 POI 检索缓存 TTL（毫秒） */
  restaurantPoiCacheTtlMs: number;
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
    maxAmountCny: parseNonNegativeInt(env.BOOKING_MAX_AMOUNT_CNY, 0),
    dailyBudgetCny: parseNonNegativeInt(env.BOOKING_DAILY_BUDGET_CNY, 0),
    confirmationTtlMs: parsePositiveInt(env.BOOKING_CONFIRMATION_TTL_MS, 300_000),
    amapWebKey: env.AMAP_WEB_KEY?.trim() || "",
    restaurantPoiCacheTtlMs: parsePositiveInt(env.RESTAURANT_POI_CACHE_TTL_MS, 7 * 24 * 60 * 60 * 1000),
  };
}
