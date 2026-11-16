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
 * 支付宝扫码支付渠道（alipay.trade.precreate 当面付）。
 *
 * 它是**电脑端**的首选收款方式：
 *   - 一次请求就拿到 `qr_code`（alipay:// 短链），用户用支付宝直接扫；
 *   - 交易在下单时就已创建，查单/退款语义干净；
 *   - 与手机网站支付/网页收款共用同一份凭证，不会出现两套配置。
 *
 * 手机端不要用这条：自己扫不了自己的屏幕，手机走 alipay_wap（手机网站支付）。
 */

export type { AlipaySdkLike };

/** 渠道单号：由意图派生，天然幂等（同一意图重试不会产生第二笔交易）。 */
export function qrOutTradeNo(intentId: string): string {
  return `NI${intentId.replace(/^pi_/i, "").toUpperCase()}`.slice(0, 32);
}

/**
 * 验签支付宝异步通知（三个渠道共用同一应用，验签逻辑一致）。
 * 只做签名与 app_id 归属校验；金额/状态一律不采信，由后续主动查单确认。
 *
 * @param deps 仅测试注入用；生产走默认（沙箱文件 / 环境变量 + 真实 SDK）
 */
export function verifyAlipayNotify(
  params: Record<string, string>,
  deps?: { account?: ReturnType<typeof loadAlipayAccount>; sdk?: AlipaySdkLike | null },
): boolean {
  const account = deps && "account" in deps ? deps.account ?? null : loadAlipayAccount();
  if (!alipayAccountReady(account)) return false;
  if (params.app_id && params.app_id !== account.appId) return false;
  const sdk = deps && "sdk" in deps ? deps.sdk ?? null : createAlipaySdk(account);
  if (!sdk?.checkNotifySignV2) return false;
  try {
    return sdk.checkNotifySignV2(params);
  } catch {
    return false;
  }
}

export class AlipayQrChannel implements PaymentChannel {
  readonly id = "alipay_qr" as const;
  readonly label = "支付宝扫码支付";
  readonly direction = "collect" as const;
  readonly audience = "desktop" as const;

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
        capabilities: { qr: true, redirect: false, refund: true, needsCashierUrl: false },
      };
    }
    return {
      channel: this.id,
      label: this.label,
      direction: this.direction,
      audience: this.audience,
      available: true,
      mode: account.env === "production" ? "live" : "sandbox",
      capabilities: { qr: true, redirect: false, refund: true, needsCashierUrl: false },
    };
  }

  async create(input: ChannelCreateInput): Promise<ChannelCreateResult> {
    const sdk = this.sdkFactory();
    if (!sdk) return { ok: false, status: "failed", error: this.availability().reason ?? "支付宝账户未配置" };

    const account = this.accountLoader();
    const notifyBase = process.env.PAYMENT_NOTIFY_BASE_URL?.trim().replace(/\/+$/, "") ?? "";
    const outTradeNo = qrOutTradeNo(input.intentId);
    try {
      // 注意：alipay-sdk 对「值为 undefined 的顶层参数」会直接抛
      // Cannot convert undefined or null to object，notifyUrl 必须按需省略
      const params: Record<string, unknown> = {
        bizContent: {
          out_trade_no: outTradeNo,
          total_amount: centsToAmountString(input.amountCents),
          subject: input.subject.slice(0, 256),
          product_code: "FACE_TO_FACE_PAYMENT",
          timeout_express: "30m",
          ...(account?.sellerId ? { seller_id: account.sellerId } : {}),
        },
      };
      if (notifyBase) params.notifyUrl = `${notifyBase}/api/payment/notify/alipay`;
      const result = await sdk.exec("alipay.trade.precreate", params, { validateSign: true });
      const code = String(result.code ?? "");
      if (code !== "10000") {
        return {
          ok: false,
          status: "failed",
          error: String(result.sub_msg ?? result.msg ?? `支付宝下单失败（${code || "无返回码"}）`),
          raw: result,
        };
      }
      const qrCode = typeof result.qr_code === "string" ? result.qr_code : "";
      if (!qrCode) {
        return { ok: false, status: "failed", error: "支付宝未返回二维码（qr_code 为空）", raw: result };
      }
      return {
        ok: true,
        channelOrderId: outTradeNo,
        status: "pending",
        payUrl: qrCode,
        raw: result,
      };
    } catch (err) {
      return {
        ok: false,
        status: "failed",
        error: `支付宝扫码下单异常：${err instanceof Error ? err.message : String(err)}`,
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
