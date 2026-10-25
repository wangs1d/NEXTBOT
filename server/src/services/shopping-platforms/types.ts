import type { Page } from "playwright";

/** 搜索过滤条件（可选）。 */
export interface SearchFilters {
  /** 价格上限（CNY） */
  maxPrice?: number;
  /** 排序方式：default/price_asc/price_desc/sales */
  sort?: "default" | "price_asc" | "price_desc" | "sales";
  /** 返回结果条数上限，默认 5 */
  limit?: number;
}

/** 商品摘要（搜索结果项）。 */
export interface ProductSummary {
  title: string;
  price?: number;
  currency?: string;
  url?: string;
  shop?: string;
  itemId?: string;
  /**
   * 商品主图（浏览器抓取的平台图源：淘宝 white_image/pict_url、京东 imageInfo、
   * 拼多多 goods_image_url）。推荐线以它为「产品主体图」第一优先级；
   * Playwright adapter 未提取该字段时留空。
   */
  imageUrl?: string;
}

/** 结算页快照（阶段一返回）。 */
export interface CheckoutSnapshot {
  ok: boolean;
  /** 商品名 */
  itemTitle?: string;
  /** 单价 */
  unitPrice?: number;
  /** 数量 */
  quantity?: number;
  /** 总价（含运费等） */
  totalPrice?: number;
  currency?: string;
  /** 收货地址摘要 */
  addressSummary?: string;
  /** 结算页截图（PNG base64，不含 data: 前缀） */
  screenshotBase64?: string;
  /** 页面 URL（结算页 URL） */
  checkoutUrl?: string;
  error?: string;
  retryable?: boolean;
}

/** 订单状态。 */
export interface OrderStatus {
  orderId?: string;
  status?: string;
  statusDesc?: string;
  /** 物流信息摘要 */
  logisticsSummary?: string;
  /** 商品名 */
  itemTitle?: string;
  /** 总价 */
  totalPrice?: number;
  /** 下单时间 */
  createdAt?: string;
}

/** 取消订单结果。 */
export interface CancelResult {
  ok: boolean;
  orderId?: string;
  error?: string;
  retryable?: boolean;
}

/**
 * 购物平台适配器接口。
 *
 * 每个平台（taobao/jd/meituan/...）实现此接口，封装该平台的 URL 模板与 Playwright 选择器。
 * 选择器会随平台改版失效，实现内需 try/catch + 多组选择器兜底，
 * 失败时返回 `{ ok: false, error: "页面结构变更，请更新 adapter", retryable: false }`。
 *
 * 参考架构：`social-outreach-service.ts` 的 `SocialPlatformAdapter`。
 */
export interface ShoppingPlatformAdapter {
  /** 平台标识，与 `BROWSER_SESSION_SITES` 的 siteId 对齐 */
  platform: string;

  /**
   * 生成搜索 URL。
   * @param query 搜索关键词
   * @param filters 可选过滤条件（maxPrice/sort 可能无法在 URL 层面体现，由 extractProducts 二次过滤）
   */
  searchUrl(query: string, filters?: SearchFilters): string;

  /** 订单列表页 URL */
  orderListUrl(): string;

  /**
   * 在已打开搜索页的 Playwright Page 上读取商品列表。
   * 调用前 service 已 `page.goto(searchUrl)` 并等待渲染。
   */
  extractProducts(page: Page, limit: number): Promise<ProductSummary[]>;

  /**
   * 从当前商品页或搜索结果走到结算页（**不点最终提交订单按钮**）。
   * @param product 搜索结果中的目标商品（或由 service 重新打开 item.url）
   * @param quantity 购买数量
   * @returns 结算页快照（含截图与订单摘要）
   */
  navigateToCheckout(page: Page, product: ProductSummary, quantity: number): Promise<CheckoutSnapshot>;

  /**
   * 点击提交订单按钮，返回订单号。
   * 调用前页面应已处于结算页（由 navigateToCheckout 到达）。
   * **只点提交订单按钮，不点立即支付按钮**。
   * @returns paymentUrl：提交后落在的收银台/支付页 URL（若有），供用户手动
   *          支付或支付宝收银台通道代付（仅 cashier/qr.alipay.com 可代付）。
   */
  submitOrder(page: Page): Promise<{ ok: boolean; orderId?: string; error?: string; retryable?: boolean; paymentUrl?: string }>;

  /**
   * 在订单列表页读取订单状态。
   * @param orderId 可选，指定订单号；不传则返回最近订单
   */
  readOrderStatus(page: Page, orderId?: string): Promise<OrderStatus[]>;

  /** 取消指定订单。调用前页面应已处于订单详情或订单列表页。 */
  cancelOrder(page: Page, orderId: string): Promise<CancelResult>;
}

/** adapter 内部通用错误归一化。 */
export function adapterError(err: unknown, context: string): { ok: false; error: string; retryable: boolean } {
  const message = err instanceof Error ? err.message : String(err);
  const retryable = /timeout|navigation|wait|selector.*not found/i.test(message);
  return {
    ok: false,
    error: `${context}失败：${message}${retryable ? "（可重试）" : "（页面结构可能变更，请更新 adapter）"}`,
    retryable,
  };
}
