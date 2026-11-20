/**
 * 方案 A：统一预订服务抽象层 —— Provider 接口与领域类型。
 *
 * 所有预订类服务（网约车 / 家政 / 餐厅 / 未来的机票火车票）实现同一
 * `BookingProvider` 接口（search / book / getStatus / cancel，家政额外
 * reschedule），由 `BookingService` 统一编排：
 *
 *   - 统一走 ask_first 分支：book / cancel 两阶段确认（金融 + 不可逆操作，
 *     下单前必须用户确认卡同意）；金额硬限额默认关闭，可经
 *     BOOKING_MAX_AMOUNT_CNY / BOOKING_DAILY_BUDGET_CNY 显式开启
 *   - booking 结果统一写入承诺板（commitment board）跟踪状态
 *   - 支付边界：Agent 只下单，不代付。Provider 可返回 paymentUrl，
 *     由用户手动完成支付（「下单到支付页面」模式）
 *
 * 与相近能力的边界：
 *   - shopping.order.place：电商购物，走浏览器 adapter，不复用本层
 *   - alipay.*：支付通道，不是预订编排
 */

import type { ClientLocationWire } from "../../types/client-location.js";
import type { ToolContext } from "../../tools/tool-registry.js";

/** 预订域（新增域时在此扩展，并同步 agent-capabilities.ts 的域清单）。 */
export type BookingDomain = "ride" | "home_service" | "restaurant" | "travel";

/**
 * 订单状态生命周期：
 *   pending_payment → confirmed → in_progress → completed
 *   任意非终态 → cancelled / failed
 */
export type BookingOrderStatus =
  | "pending_payment"
  | "confirmed"
  | "in_progress"
  | "completed"
  | "cancelled"
  | "failed";

export const BOOKING_TERMINAL_STATUSES: ReadonlySet<BookingOrderStatus> = new Set([
  "completed",
  "cancelled",
  "failed",
]);

/** search 返回的可选项（车型报价 / 家政套餐 / 餐厅时段）。 */
export interface BookingOption {
  /** 传给 book 的选项 id（provider 内唯一） */
  id: string;
  /** 所属 provider key */
  provider: string;
  /** 展示名，如「经济型（预估 ¥45）」「深度保洁 4 小时」 */
  title: string;
  description?: string;
  /** 预估金额（CNY）；null = 到店/以平台为准 */
  amountCny: number | null;
  currency: "CNY";
  /** ride：接驾预计分钟数 */
  etaMinutes?: number | null;
  /** 服务时长（分钟） */
  durationMinutes?: number | null;
  /** 报价/时段有效期（ISO） */
  validUntil?: string | null;
  /** 预约服务时间（ISO，家政/餐厅） */
  scheduleAt?: string | null;
  /** 模拟模式结果标记（BOOKING_MODE=mock；必须如实转告用户） */
  simulated?: boolean;
  /** 域特定补充（车型等级 / 套餐内容 / 可订时段等） */
  extra?: Record<string, unknown>;
}

/** search 入参：公共字段 + 域特定 params（由 provider 解释）。 */
export interface BookingSearchQuery {
  domain: BookingDomain;
  city?: string;
  /** 客户端 GPS 定位（ride 起点 / 附近推荐） */
  location?: ClientLocationWire | null;
  /** 期望服务时间（ISO）：用车时间 / 上门时间 / 到店时间 */
  scheduleAt?: string | null;
  /**
   * 域特定参数：
   *   ride          → pickup / dropoff
   *   home_service  → serviceType / address
   *   restaurant    → query / cuisine / covers / dineAt
   */
  params: Record<string, unknown>;
}

/** book 阶段二提交给 provider 的订单草稿（由阶段一的 option + 入参组装）。 */
export interface BookingDraft {
  domain: BookingDomain;
  provider: string;
  optionId: string;
  title: string;
  amountCny: number | null;
  /** 服务发生时间（ISO）；用于承诺板 deadline */
  scheduleAt?: string | null;
  /** 服务时长（分钟，来自 option）；用于日程区间与冲突预检 */
  durationMinutes?: number | null;
  /** 复述给用户的摘要（阶段一返回原文） */
  summary: string;
  /** 域特定下单参数（同 BookingSearchQuery.params） */
  params: Record<string, unknown>;
}

/** provider 侧订单引用（本地订单持久化后回查用）。 */
export interface BookingProviderRef {
  provider: string;
  providerOrderId: string;
}

/** 结构化失败码（如 PICKUP_UNRESOLVED）：上层据此做确定性动作（推选点卡），不只靠 error 文本猜 */
export type BookingProviderResult<T> = { ok: true } & T | { ok: false; error: string; retryable?: boolean; code?: string };

export interface BookingProviderBookPayload {
  providerOrderId?: string;
  status?: BookingOrderStatus;
  /** 平台支付链接：Agent 不代付，交用户手动支付 */
  paymentUrl?: string | null;
  message?: string;
  /** 动态信息（司机/车牌/服务商联系人） */
  tracking?: Record<string, unknown>;
}

export interface BookingProviderStatusPayload {
  status?: BookingOrderStatus;
  message?: string;
  tracking?: Record<string, unknown>;
}

/** provider 调用上下文（actor 已解析）。 */
export interface BookingProviderContext {
  actorId: string;
  location?: ClientLocationWire | null;
  /** 原始工具上下文（报价聚合层等需要透传给检索/HTTP 能力时使用） */
  toolContext?: ToolContext;
}

/**
 * 统一预订 Provider 接口。
 *
 * 实现约束：
 *   - 所有方法不得抛异常（错误以 `{ ok: false, error, retryable? }` 返回；
 *     BookingService 会兜底 catch，但 provider 应自行消化）
 *   - 金额一律 CNY 元（number，与 shopping-order 约定一致）
 *   - 不可逆 / 花钱操作（book/cancel）的真正执行只发生在阶段二——
 *     两阶段编排在 BookingService，provider 无需关心 token
 */
export interface BookingProvider {
  /** 注册 key（如 "simulated" / "amap"），book 入参用 provider 指定 */
  readonly key: string;
  readonly domain: BookingDomain;
  /** 展示名（「高德打车（企业版）」「模拟网约车（沙盒）」） */
  readonly label: string;
  /** 是否可用：缺 API key / 企业资质时返回原因，search/book 前检查 */
  availability(): { ok: boolean; reason?: string };
  search(
    query: BookingSearchQuery,
    ctx: BookingProviderContext,
  ): Promise<BookingProviderResult<{ options: BookingOption[]; note?: string }>>;
  book(draft: BookingDraft, ctx: BookingProviderContext): Promise<BookingProviderResult<BookingProviderBookPayload>>;
  getStatus(
    ref: BookingProviderRef,
    ctx: BookingProviderContext,
  ): Promise<BookingProviderResult<BookingProviderStatusPayload>>;
  cancel(
    ref: BookingProviderRef,
    reason: string | undefined,
    ctx: BookingProviderContext,
  ): Promise<BookingProviderResult<{ message?: string }>>;
  /** 家政等支持改期（可选能力） */
  reschedule?(
    ref: BookingProviderRef,
    scheduleAt: string,
    ctx: BookingProviderContext,
  ): Promise<BookingProviderResult<{ message?: string }>>;
}
