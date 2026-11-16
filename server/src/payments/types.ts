/**
 * 统一支付模块 —— 领域模型。
 *
 * 设计目标（2026-11-13）：把此前并存的四条支付路径
 *   1) payment-service.ts（微信/支付宝商户网关，native/h5）
 *   2) services/webpay（支付宝沙箱网页收款 alipay.trade.page.pay）
 *   3) alipay-bot CLI（支付宝 AI 支付：钱包授权 + 收银台代付）
 *   4) shopping/booking 内联代付（shopping.pay.submit / booking.travel-pay）
 * 收敛成「一个支付意图（intent）+ 一份用户授权（authorization）+ 可插拔渠道」。
 *
 * 三条不变量：
 *   - 金额一律用整数分（cents）在模块内流转，只在边界转元，杜绝 0.1+0.2 类误差；
 *   - 状态只由「渠道事实」推进（查单/异步通知），前端回跳与用户口头确认都不算数；
 *   - 没有有效授权就没有扣款——授权是资金动作的前置条件，不是提示文案。
 */

/** 支付渠道。新增渠道只需实现 PaymentChannel 并注册，不动门面与工具。 */
export type PaymentChannelId =
  | "alipay_qr"
  | "alipay_wap"
  | "alipay_sandbox"
  | "alipay_bot"
  | "wechat"
  | "mock";

/** 渠道适用的终端形态：电脑扫码 / 手机拉起支付宝，各自只展示合适的渠道。 */
export type ChannelAudience = "all" | "desktop" | "mobile";

/**
 * 支付provider：用户授权按它发放，而不是按「扫码/手机网站」这种传输形态。
 * 用户在授权页同意的是「可以用支付宝代付」，换一种支付宝付款方式不该再要一次授权。
 */
export type PaymentProvider = "alipay" | "wechat" | "mock";

export function providerOf(channel: PaymentChannelId): PaymentProvider {
  if (channel === "wechat") return "wechat";
  if (channel === "mock") return "mock";
  return "alipay";
}

export const PROVIDER_CHANNELS: Record<PaymentProvider, PaymentChannelId[]> = {
  alipay: ["alipay_qr", "alipay_wap", "alipay_sandbox", "alipay_bot"],
  wechat: ["wechat"],
  mock: ["mock"],
};

/** 渠道运行档位：live=真实资金，sandbox=官方沙箱，mock=本地模拟（绝不来自真实渠道）。 */
export type ChannelMode = "live" | "sandbox" | "mock";

/**
 * 渠道资金方向：
 *   - collect：向用户收款（用户付给商户/我们）
 *   - pay：代用户付款（从用户已授权的支付账户扣款给第三方商户）
 * 两者不能混用：代付必须有用户授权，收款不需要。
 */
export type ChannelDirection = "collect" | "pay";

export type AuthorizationStatus = "active" | "revoked" | "expired";

/**
 * 支付意图状态机：
 *
 *   requires_authorization ──(用户完成授权)──▶ requires_confirm ──(用户确认)──▶ pending ──(渠道确认)──▶ paid
 *            │                                      │                              │                   │
 *            │                                      └──────────(额度内免确认)──────▶│                   └─▶ refunded
 *            └──▶ blocked（超限/类别未授权，不可扣款）                              └─▶ closed / failed
 */
export type IntentStatus =
  | "requires_authorization"
  | "requires_confirm"
  | "pending"
  | "paid"
  | "closed"
  | "refunded"
  | "failed"
  | "blocked";

/** 业务域：决定授权类别匹配，也决定入账归类。 */
export type BizDomain =
  | "travel" // 机票/火车票/酒店
  | "ride" // 叫车
  | "delivery" // 跑腿/外卖
  | "dining" // 餐饮
  | "express" // 寄件
  | "utility" // 水电燃气/话费
  | "shopping" // 网购
  | "recharge" // 站内充值/订阅
  | "service" // 上门服务/预约
  | "other";

/**
 * 用户授权额度（元）。
 * 0 表示「该项不限制」，但 autoApproveCny = 0 表示「任何金额都要二次确认」——
 * 这两个 0 语义相反，容易写错，故显式区分文档。
 */
export interface PaymentLimits {
  /** 单笔上限（元）；0 = 不限 */
  perTxCny: number;
  /** 日累计上限（元）；0 = 不限 */
  dailyCny: number;
  /** 月累计上限（元）；0 = 不限 */
  monthlyCny: number;
  /** 免确认单笔额度（元）：金额 ≤ 该值直接扣款；0 = 全部需用户确认 */
  autoApproveCny: number;
}

/** 用户支付授权（一份 = 一个用户对一个渠道的授权）。 */
export interface PaymentAuthorization {
  id: string;
  actorId: string;
  channel: PaymentChannelId;
  status: AuthorizationStatus;
  limits: PaymentLimits;
  /** 允许代付的业务类别（BizDomain 或 "*"） */
  categories: string[];
  /** 授权书版本与摘要：留痕用，变更授权需重新同意 */
  consentVersion: string;
  consentText: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
}

/** 支付意图（统一订单）。 */
export interface PaymentIntent {
  id: string;
  actorId: string;
  /** 调用方幂等键：同一 (actorId, key) 只会产生一个 intent */
  idempotencyKey: string | null;
  bizDomain: BizDomain;
  /** 业务侧单据号（bkg_* / shop_* / 账单 id …），用于业务回调对账 */
  bizRefId: string | null;
  merchant: string | null;
  subject: string;
  amountCents: number;
  category: string;
  channel: PaymentChannelId;
  authorizationId: string | null;
  status: IntentStatus;
  confirmToken: string | null;
  confirmExpiresAt: string | null;
  /** 渠道侧单号（支付宝 out_trade_no / 微信 out_trade_no / 收银台 outShakeNo） */
  channelOrderId: string | null;
  payUrl: string | null;
  /** 支付宝网页收款的自动提交表单（服务端生成并签名，含有效期） */
  paymentHtml: string | null;
  qrCodeDataUrl: string | null;
  /** 代付渠道的商家收银台链接（用户确认后执行时才用到；不对外暴露） */
  cashierUrl: string | null;
  failureReason: string | null;
  refundedCents: number;
  createdAt: string;
  updatedAt: string;
  paidAt: string | null;
}

/** 对外（客户端 / Agent）可见的意图视图：不泄露 confirmToken（除非显式下发）。 */
export interface PaymentIntentView {
  id: string;
  status: IntentStatus;
  actorId: string;
  bizDomain: BizDomain;
  bizRefId: string | null;
  merchant: string | null;
  subject: string;
  amount: number;
  category: string;
  channel: PaymentChannelId;
  channelLabel: string;
  mode: ChannelMode;
  payUrl: string | null;
  qrCodeDataUrl: string | null;
  refundedAmount: number;
  failureReason: string | null;
  createdAt: string;
  paidAt: string | null;
}

/** 渠道能力与可用性（诊断/前端选择用）。 */
export interface ChannelAvailability {
  channel: PaymentChannelId;
  label: string;
  direction: ChannelDirection;
  available: boolean;
  mode: ChannelMode;
  /** 适用终端（缺省 all）：付款页据此在电脑/手机上只展示合适的付款方式 */
  audience?: ChannelAudience;
  /** 不可用时的具体原因（会原样透给 Agent 与运维，不含密钥） */
  reason?: string;
  capabilities: {
    qr: boolean;
    redirect: boolean;
    refund: boolean;
    /** 是否需要商家收银台链接（代付渠道） */
    needsCashierUrl: boolean;
  };
}

/** createIntent 的入参（金额为元，边界处转分）。 */
export interface CreateIntentInput {
  actorId: string;
  amount: number;
  subject: string;
  category?: string;
  bizDomain?: BizDomain;
  bizRefId?: string;
  merchant?: string;
  /** auto = 按可用性自动选（默认）；指定渠道时不可用会直接报错，不静默降级 */
  channel?: "auto" | PaymentChannelId;
  /** 代付渠道必需：商家收银台链接 / 订单串 */
  cashierUrl?: string;
  idempotencyKey?: string;
  /** 支付宝 AI 支付需要真实业务会话 ID（禁止占位） */
  sessionId?: string;
  /** 站内 checkout 页基址（默认取 webpay baseUrl） */
  baseUrl?: string;
}

/** 统一的「下一步动作」：Agent 据此说一句、或引导用户点一下。 */
export type NextAction =
  | "authorize" // 需要用户先在授权页授权
  | "confirm" // 需要用户在对话里确认（超免确认额度）
  | "pay" // 已生成收款码/收银台，等用户付款
  | "paid" // 已完成
  | "blocked" // 被授权额度/类别拦截
  | "error";

export interface CreateIntentResult {
  ok: boolean;
  nextAction: NextAction;
  /** 意图视图；仅在「完全没有可用渠道/参数非法」这类未落库的错误下为 null */
  intent: PaymentIntentView | null;
  /** nextAction=authorize 时的授权页地址 */
  authorizationUrl?: string;
  /** 付款页地址：用户在这里选付款方式、点「确认付款」 */
  payPageUrl?: string;
  /** nextAction=confirm 时的一次性确认令牌（下发给 Agent，由用户确认后回传） */
  confirmToken?: string;
  confirmExpiresAt?: string;
  /** 面向用户的一句话（Agent 可直接转述，不编造） */
  message: string;
  error?: string;
}
