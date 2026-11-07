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

/**
 * 商品详情页的一个规格维度（如「颜色」「存储容量」）及其全部可选项。
 *
 * 2026-11-06 用户要求：「把商家提供的所有组合、能够选择的都呈现给用户」。
 * 所以这里返回的是**维度 + 全部选项**（含无货项），而不是替用户挑好的结果——
 * 哪些能点、哪些已售罄由页面自己标（disabled），不做服务端裁剪。
 */
export interface ProductSpecGroup {
  /** 维度名（页面原文，如「颜色」「版本」「尺码」） */
  key: string;
  options: ProductSpecOption[];
}

export interface ProductSpecOption {
  /** 选项文案（页面原文） */
  label: string;
  /** 页面标了无货/不可选 */
  disabled?: boolean;
  /** 页面默认选中 */
  selected?: boolean;
}

/** 结算页快照（阶段一返回）。 */export interface CheckoutSnapshot {
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

/** 平台类目：商品比价的缺省平台只取 general（综合电商）。 */
export type ShoppingPlatformCategory = "general" | "local-life" | "ticketing";

/**
 * 取价所需登录态（必填，同 category 一样是编译期约束）：
 *   - anonymous：无需登录即可读到真实价格（苏宁/什么值得买）；
 *   - login    ：无登录态会被拦到登录页（淘宝/京东/拼多多…）。
 *
 * 手机端没有可视浏览器，比价缺省集合只放 anonymous 平台——否则一开跑就
 * 全是登录交接、一个价也拿不到（2026-11-06 无头实测）。带登录能力的平台
 * 在用户已有授权 Cookie 时仍会补进缺省集合。
 */
export type ShoppingAuthMode = "anonymous" | "login";

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
   * 平台类目（必填）：比价缺省平台列表由此派生（listDefaultComparePlatforms），
   * 不再维护独立的手写平台数组——新增 adapter 时漏标类目会直接编译失败。
   * general=综合电商（淘宝/京东/拼多多…）；local-life=外卖闪购/到店（美团/点评）；
   * ticketing=演出票务（大麦/猫眼）。
   */
  category: ShoppingPlatformCategory;

  /**
   * 取价所需登录态（必填）：anonymous=匿名可读真实价；login=必须登录。
   * 比价缺省集合据此收窄（见 listDefaultComparePlatforms）。
   */
  authMode: ShoppingAuthMode;

  /**
   * 有没有真实结算流程（默认 true）。情报站（什么值得买）只报价、没有
   * 自己的购物车/结算页，置 false——候选卡据此把主按钮换成「只报价」，
   * 其余平台（含需扫码登录的）都能在卡内走完 登录→结算。
   */
  supportsCheckout?: boolean;

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

  /**
   * 可选：在商品详情页读出**全部**规格维度与选项（不裁剪、不替用户挑）。
   *
   * 返回空数组表示「这个商品没有可拆的规格」或「这个平台页面读不出来」——
   * 调用方据此直接去结算，不给用户一个空的规格页。读不到就如实说读不到，
   * 不编造「颜色：黑/白」这种页面里没有的选项。
   */
  extractSpecs?(page: Page): Promise<ProductSpecGroup[]>;

  /**
   * 可选：按用户选中的规格在详情页点选一遍（key→label），再进结算。
   * 失败时调用方退回默认 SKU 并在卡面说明「按默认规格结算」。
   */
  applySpecs?(page: Page, picked: Record<string, string>): Promise<{ ok: boolean; error?: string }>;
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
