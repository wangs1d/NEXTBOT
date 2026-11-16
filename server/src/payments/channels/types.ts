import type {
  ChannelAudience,
  ChannelAvailability,
  ChannelDirection,
  PaymentChannelId,
} from "../types.js";

/**
 * 渠道适配器契约。
 *
 * 门面（UnifiedPaymentService）只认这个接口：新增渠道（微信 JSAPI、云闪付、
 * 数字人民币…）只需实现 + 注册，不改状态机、不动工具签名、不碰授权逻辑。
 *
 * 硬约定：
 *   - create 必须幂等：同一 intentId 重复调用不得产生第二笔渠道单（渠道侧用
 *     intent 的 channelOrderId 判定，已存在直接复用）；
 *   - query 只在渠道返回明确终态时给 paid/closed，其余一律 pending/unknown——
 *     「查不到」不等于「失败」，更不等于「成功」；
 *   - 任何适配器都不得自行把意图标记为已支付，只返回渠道事实。
 */

export interface ChannelCreateInput {
  intentId: string;
  actorId: string;
  amountCents: number;
  subject: string;
  category: string;
  bizDomain: string;
  bizRefId?: string;
  merchant?: string;
  /** 代付渠道必需：商家收银台链接 / 订单串 */
  cashierUrl?: string;
  /** 支付宝 AI 支付需要真实会话 ID */
  sessionId?: string;
  /** 站内收银台页地址（收款渠道生成二维码时用） */
  checkoutUrl?: string;
  /** 支付完成后回跳地址（手机网站支付必需：付完回到付款页自动确认） */
  returnUrl?: string;
}

export interface ChannelCreateResult {
  ok: boolean;
  channelOrderId?: string;
  status: "pending" | "paid" | "failed";
  payUrl?: string;
  paymentHtml?: string;
  paidAt?: string;
  error?: string;
  raw?: unknown;
}

export interface ChannelPaymentRef {
  intentId: string;
  /** 归属用户：钱包/账户按用户隔离的渠道（如支付宝 AI 支付）必须用它定位钱包 */
  actorId: string;
  channelOrderId: string | null;
  amountCents: number;
  subject: string;
}

export interface ChannelQueryResult {
  state: "pending" | "paid" | "closed" | "failed" | "unknown";
  paidAt?: string;
  amountCents?: number;
  payer?: string;
  error?: string;
  raw?: unknown;
}

export interface ChannelRefundResult {
  ok: boolean;
  status: "success" | "pending" | "error";
  refundedCents?: number;
  error?: string;
  raw?: unknown;
}

export interface PaymentChannel {
  readonly id: PaymentChannelId;
  readonly label: string;
  readonly direction: ChannelDirection;
  /** 适用终端；缺省 all。付款页在手机上不展示 desktop-only 渠道，反之亦然。 */
  readonly audience?: ChannelAudience;
  availability(): ChannelAvailability;
  create(input: ChannelCreateInput): Promise<ChannelCreateResult>;
  query(ref: ChannelPaymentRef): Promise<ChannelQueryResult>;
  refund?(ref: ChannelPaymentRef, refundCents: number, reason?: string): Promise<ChannelRefundResult>;
}
