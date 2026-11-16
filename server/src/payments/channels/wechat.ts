import type { PaymentService } from "../../services/payment-service.js";
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
 * 微信支付 Native 渠道（商户号 v3 收款）。
 *
 * 复用既有 PaymentService（服务层已实现 v3 签名、下单、查单）。凭证齐备
 * （WECHAT_PAY_APP_ID / WECHAT_PAY_MCH_ID / WECHAT_PAY_API_KEY +
 * WECHAT_PAY_PRIVATE_KEY / WECHAT_PAY_CERT_SERIAL_NO）时 mode=live；
 * 缺失时渠道不可用——不再像旧路径那样静默回落到进程内 mock 单，
 * 否则「下单成功」会被误当真实收款。
 */
export class WechatChannel implements PaymentChannel {
  readonly id = "wechat" as const;
  readonly label = "微信支付（商户号）";
  readonly direction = "collect" as const;
  readonly audience = "all" as const;

  constructor(private readonly service: PaymentService) {}

  availability(): ChannelAvailability {
    const live = this.service.modeFor("wechat") === "live";
    return {
      channel: this.id,
      label: this.label,
      direction: this.direction,
      audience: this.audience,
      available: live,
      mode: live ? "live" : "mock",
      ...(live
        ? {}
        : {
            reason:
              "微信支付未配置：需要 WECHAT_PAY_MODE=live 且 WECHAT_PAY_APP_ID / WECHAT_PAY_MCH_ID / WECHAT_PAY_API_KEY / WECHAT_PAY_PRIVATE_KEY / WECHAT_PAY_CERT_SERIAL_NO 齐备",
          }),
      capabilities: { qr: true, redirect: false, refund: false, needsCashierUrl: false },
    };
  }

  async create(input: ChannelCreateInput): Promise<ChannelCreateResult> {
    if (!this.availability().available) {
      return { ok: false, status: "failed", error: this.availability().reason ?? "渠道不可用" };
    }
    const notifyBase = process.env.PAYMENT_NOTIFY_BASE_URL?.trim() ?? "";
    const result = await this.service.createOrder({
      amount: input.amountCents / 100,
      description: input.subject,
      actorId: input.actorId,
      provider: "wechat",
      method: "native",
      ...(notifyBase ? { notifyUrl: `${notifyBase}/api/payment/notify/wechat` } : {}),
      metadata: { category: input.category, bizDomain: input.bizDomain, intentId: input.intentId },
    });
    if (!result.ok) {
      return { ok: false, status: "failed", error: result.error ?? "微信支付下单失败" };
    }
    return {
      ok: true,
      channelOrderId: result.outTradeNo,
      status: result.status === "paid" ? "paid" : "pending",
      ...(result.payUrl ? { payUrl: result.payUrl } : {}),
      raw: result.rawResponse,
    };
  }

  async query(ref: ChannelPaymentRef): Promise<ChannelQueryResult> {
    if (!ref.channelOrderId) return { state: "unknown", error: "缺少微信支付订单号" };
    const result = await this.service.queryOrder(ref.channelOrderId, "wechat", ref.actorId);
    if (!result.ok) return { state: "unknown", error: result.error };
    switch (result.tradeState) {
      case "SUCCESS":
        return {
          state: "paid",
          paidAt: result.payTime,
          amountCents: Math.round(result.amount * 100),
          payer: result.payerInfo,
        };
      case "CLOSED":
      case "REVOKED":
        return { state: "closed" };
      case "PAYERROR":
        return { state: "failed" };
      case "REFUND":
        return { state: "paid" };
      default:
        return { state: "pending" };
    }
  }

  async refund(): Promise<ChannelRefundResult> {
    return {
      ok: false,
      status: "error",
      error: "微信支付退款尚未接入统一模块（v3 退款接口待接入），请走商户平台人工退款",
    };
  }
}
