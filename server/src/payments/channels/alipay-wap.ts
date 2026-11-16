import { alipayAccountReady, loadAlipayAccount } from "../alipay-account.js";
import {
  alipayQueryTrade,
  alipayRefundTrade,
  createAlipaySdk,
  type AlipaySdkLike,
} from "../alipay-sdk.js";
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
 * 支付宝手机网站支付渠道（alipay.trade.wap.pay）。
 *
 * 手机端必须走这条，而不是把扫码短链硬当成深链：
 *   - wap.pay 自带签名收银台地址，打开即是「支付宝付款 ¥x」页面，
 *     提供「打开支付宝APP付款 / 继续浏览器付款」两条路，官方支持；
 *   - 付款完成后按 return_url 回跳付款页，页面查单自动确认；
 *   - 不要用 precreate 的二维码短链在手机上"点开当深链"——它能唤起
 *     alipays://，但那是给「扫码」设计的兜底路径，沙箱单在正式支付宝里无效。
 *
 * 与扫码渠道共用同一支付宝应用与同一套查单/退款实现。
 */

export function wapOutTradeNo(intentId: string): string {
  return `NW${intentId.replace(/^pi_/i, "").toUpperCase()}`.slice(0, 32);
}

export class AlipayWapChannel implements PaymentChannel {
  readonly id = "alipay_wap" as const;
  readonly label = "支付宝手机网站支付";
  readonly direction = "collect" as const;
  readonly audience = "mobile" as const;

  constructor(
    private readonly sdkFactory: () => AlipaySdkLike | null = () => createAlipaySdk(loadAlipayAccount()),
    private readonly accountLoader: typeof loadAlipayAccount = loadAlipayAccount,
  ) {}

  availability(): ChannelAvailability {
    const account = this.accountLoader();
    if (!alipayAccountReady(account)) {
      return {
        channel: this.id,
        label: this.label,
        direction: this.direction,
        audience: this.audience,
        available: false,
        mode: "sandbox",
        reason:
          "支付宝账户未配置：需要项目根 .alipay-sandbox.json（沙箱）或环境变量 WEBPAY_ALIPAY_APP_ID / WEBPAY_ALIPAY_PRIVATE_KEY / WEBPAY_ALIPAY_PUBLIC_KEY（生产）",
        capabilities: { qr: false, redirect: true, refund: true, needsCashierUrl: false },
      };
    }
    return {
      channel: this.id,
      label: this.label,
      direction: this.direction,
      audience: this.audience,
      available: true,
      mode: account.env === "production" ? "live" : "sandbox",
      capabilities: { qr: false, redirect: true, refund: true, needsCashierUrl: false },
    };
  }

  async create(input: ChannelCreateInput): Promise<ChannelCreateResult> {
    const sdk = this.sdkFactory();
    if (!sdk?.pageExec) {
      return { ok: false, status: "failed", error: this.availability().reason ?? "支付宝 SDK 不支持页面跳转" };
    }
    const account = this.accountLoader();
    const notifyBase = process.env.PAYMENT_NOTIFY_BASE_URL?.trim().replace(/\/+$/, "") ?? "";
    const returnUrl = input.returnUrl?.trim() || input.checkoutUrl?.trim() || "";
    const outTradeNo = wapOutTradeNo(input.intentId);

    try {
      const params: Record<string, unknown> = {
        bizContent: {
          out_trade_no: outTradeNo,
          total_amount: centsToAmountString(input.amountCents),
          subject: input.subject.slice(0, 256),
          product_code: "QUICK_WAP_WAY",
          // 用户中途退出时回到付款页，而不是停在支付宝空页
          ...(returnUrl ? { quit_url: returnUrl } : {}),
          ...(account?.sellerId ? { seller_id: account.sellerId } : {}),
        },
      };
      if (returnUrl) params.returnUrl = returnUrl;
      if (notifyBase) params.notifyUrl = `${notifyBase}/api/payment/notify/alipay`;

      const url = sdk.pageExec("alipay.trade.wap.pay", "GET", params);
      if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
        return { ok: false, status: "failed", error: "支付宝未返回可跳转的收银台地址" };
      }
      return {
        ok: true,
        channelOrderId: outTradeNo,
        status: "pending",
        payUrl: url,
      };
    } catch (err) {
      return {
        ok: false,
        status: "failed",
        error: `支付宝手机网站支付下单异常：${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  async query(ref: ChannelPaymentRef): Promise<ChannelQueryResult> {
    const sdk = this.sdkFactory();
    if (!sdk) return { state: "unknown", error: "支付宝账户未配置" };
    if (!ref.channelOrderId) return { state: "unknown", error: "缺少支付宝订单号" };
    return alipayQueryTrade(sdk, ref.channelOrderId);
  }

  async refund(ref: ChannelPaymentRef, refundCents: number, reason?: string): Promise<ChannelRefundResult> {
    const sdk = this.sdkFactory();
    if (!sdk) return { ok: false, status: "error", error: "支付宝账户未配置" };
    if (!ref.channelOrderId) return { ok: false, status: "error", error: "缺少支付宝订单号" };
    const result = await alipayRefundTrade(sdk, {
      outTradeNo: ref.channelOrderId,
      refundCents,
      ...(reason ? { reason } : {}),
    });
    if (!result.ok) return { ok: false, status: "error", error: result.error, raw: result.raw };
    return { ok: true, status: result.status, refundedCents: refundCents, raw: result.raw };
  }
}
