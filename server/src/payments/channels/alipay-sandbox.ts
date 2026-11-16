import { loadWebpayConfig } from "../../config/webpay-config.js";
import { getWebpayService, WebpayService } from "../../services/webpay/webpay-service.js";
import { centsToAmountString } from "../money.js";
import type { ChannelAvailability } from "../types.js";
import type {
  ChannelCreateInput,
  ChannelCreateResult,
  ChannelPaymentRef,
  ChannelQueryResult,
  ChannelRefundResult,
  PaymentChannel,
} from "./types.js";

/**
 * 支付宝网页收款渠道（alipay.trade.page.pay）。
 *
 * 复用既有 WebpayService：下单在本地签名生成自动提交表单，支付结果只认
 * 异步通知验签与主动查单验签（同步回跳不作为依据）。沙箱配置来自
 * 项目根 `.alipay-sandbox.json`，生产来自 WEBPAY_ALIPAY_* 环境变量。
 *
 * 方向是 collect（用户付给商户）：它是当前唯一能真实跑通「下单 → 付款 →
 * 验签 → 到账 → 退款」全链路的渠道，因此统一模块用它承载站内收款/充值类
 * 业务，也用它做端到端验收。
 */
export class AlipaySandboxChannel implements PaymentChannel {
  readonly id = "alipay_sandbox" as const;
  readonly label = "支付宝网页收款";
  readonly direction = "collect" as const;
  readonly audience = "desktop" as const;

  constructor(private readonly serviceFactory: () => WebpayService = getWebpayService) {}

  availability(): ChannelAvailability {
    let config: ReturnType<typeof loadWebpayConfig> = null;
    try {
      config = loadWebpayConfig();
    } catch {
      config = null;
    }
    if (!config) {
      return {
        channel: this.id,
        label: this.label,
        direction: this.direction,
        audience: this.audience,
        available: false,
        mode: "sandbox",
        reason:
          "支付宝网页收款未配置：需项目根 .alipay-sandbox.json（沙箱）或环境变量 WEBPAY_ALIPAY_APP_ID / WEBPAY_ALIPAY_PRIVATE_KEY / WEBPAY_ALIPAY_PUBLIC_KEY（生产）",
        capabilities: { qr: true, redirect: true, refund: true, needsCashierUrl: false },
      };
    }
    return {
      channel: this.id,
      label: this.label,
      direction: this.direction,
      audience: this.audience,
      available: true,
      mode: config.env === "production" ? "live" : "sandbox",
      capabilities: { qr: true, redirect: true, refund: true, needsCashierUrl: false },
    };
  }

  async create(input: ChannelCreateInput): Promise<ChannelCreateResult> {
    if (!this.availability().available) {
      return { ok: false, status: "failed", error: this.availability().reason ?? "渠道不可用" };
    }
    try {
      const { outTradeNo, paymentHtml } = this.serviceFactory().createOrder({
        amount: centsToAmountString(input.amountCents),
        subject: input.subject,
        accountId: input.actorId,
      });
      return {
        ok: true,
        channelOrderId: outTradeNo,
        status: "pending",
        paymentHtml,
        ...(input.checkoutUrl ? { payUrl: input.checkoutUrl } : {}),
      };
    } catch (err) {
      return {
        ok: false,
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async query(ref: ChannelPaymentRef): Promise<ChannelQueryResult> {
    if (!ref.channelOrderId) return { state: "unknown", error: "缺少渠道单号" };
    try {
      const result = await this.serviceFactory().queryOrder(ref.channelOrderId);
      if (!result) return { state: "unknown", error: "渠道订单不存在" };
      const paidAt = result.order.paidAt ?? undefined;
      switch (result.businessState) {
        case "PAID":
          return {
            state: "paid",
            paidAt,
            amountCents: Math.round(Number(result.order.totalAmount) * 100),
            payer: result.order.buyerLogonId ?? undefined,
            raw: result,
          };
        case "CLOSED":
          return { state: "closed", raw: result };
        case "PENDING_PAYMENT":
          return { state: "pending", raw: result };
        default:
          return { state: "unknown", raw: result };
      }
    } catch (err) {
      return { state: "unknown", error: err instanceof Error ? err.message : String(err) };
    }
  }

  async refund(ref: ChannelPaymentRef, refundCents: number, reason?: string): Promise<ChannelRefundResult> {
    if (!ref.channelOrderId) return { ok: false, status: "error", error: "缺少渠道单号" };
    try {
      const result = await this.serviceFactory().refund({
        outTradeNo: ref.channelOrderId,
        refundAmount: centsToAmountString(refundCents),
        reason,
      });
      if (result.status === "success") {
        return { ok: true, status: "success", refundedCents: refundCents, raw: result };
      }
      if (result.status === "pending") {
        return { ok: true, status: "pending", refundedCents: refundCents, raw: result };
      }
      return { ok: false, status: "error", error: result.error ?? "退款失败", raw: result };
    } catch (err) {
      return { ok: false, status: "error", error: err instanceof Error ? err.message : String(err) };
    }
  }
}
