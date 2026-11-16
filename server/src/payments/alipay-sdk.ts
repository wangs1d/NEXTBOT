import { AlipaySdk } from "alipay-sdk";

import { alipayAccountReady, type AlipayAccount } from "./alipay-account.js";

/**
 * 支付宝 SDK 的最小接口 + 工厂（扫码/手机网站/网页收款共用）。
 *
 * 抽出来是为了两件事：
 *   1. 三个渠道用同一份凭证、同一套签名参数，不会出现「一个能下单一个报签名错」；
 *   2. 测试可以注入桩，不触网地覆盖请求参数与返回码分支。
 */

export interface AlipaySdkLike {
  exec(
    method: string,
    params: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  /** 生成跳转页（GET 返回带签名的 URL，POST 返回自动提交表单） */
  pageExec?(method: string, httpMethod: "GET" | "POST", params: Record<string, unknown>): string;
  checkNotifySignV2?(params: Record<string, string>): boolean;
}

export function createAlipaySdk(account: AlipayAccount | null): AlipaySdkLike | null {
  if (!alipayAccountReady(account)) return null;
  return new AlipaySdk({
    appId: account.appId,
    privateKey: account.privateKey,
    keyType: "PKCS1",
    alipayPublicKey: account.alipayPublicKey,
    gateway: account.gateway,
    signType: "RSA2",
    charset: "utf-8",
    camelcase: false,
    timeout: 15_000,
  }) as unknown as AlipaySdkLike;
}

/** 支付宝交易查询（三个渠道共用）：返回统一状态。 */
export async function alipayQueryTrade(
  sdk: AlipaySdkLike,
  outTradeNo: string,
): Promise<{
  state: "pending" | "paid" | "closed" | "unknown";
  paidAt?: string;
  payer?: string;
  amountCents?: number;
  error?: string;
  raw?: unknown;
}> {
  try {
    const result = await sdk.exec(
      "alipay.trade.query",
      { bizContent: { out_trade_no: outTradeNo } },
      { validateSign: true },
    );
    const code = String(result.code ?? "");
    if (code !== "10000") {
      // 买家还没打开收银台时网关可能查无此单：保持 pending，交给对账循环
      if (result.sub_code === "ACQ.TRADE_NOT_EXIST") return { state: "pending", raw: result };
      return {
        state: "unknown",
        error: String(result.sub_msg ?? result.msg ?? "支付宝查单失败"),
        raw: result,
      };
    }
    const tradeStatus = typeof result.trade_status === "string" ? result.trade_status : undefined;
    const state =
      tradeStatus === "TRADE_SUCCESS" || tradeStatus === "TRADE_FINISHED"
        ? "paid"
        : tradeStatus === "TRADE_CLOSED"
          ? "closed"
          : tradeStatus === "WAIT_BUYER_PAY"
            ? "pending"
            : "unknown";
    const totalAmount = typeof result.total_amount === "string" ? result.total_amount : undefined;
    return {
      state,
      ...(state === "paid"
        ? {
            paidAt: typeof result.send_pay_date === "string" ? result.send_pay_date : new Date().toISOString(),
            payer: typeof result.buyer_logon_id === "string" ? result.buyer_logon_id : undefined,
            ...(totalAmount ? { amountCents: Math.round(Number(totalAmount) * 100) } : {}),
          }
        : {}),
      raw: result,
    };
  } catch (err) {
    return { state: "unknown", error: err instanceof Error ? err.message : String(err) };
  }
}

/** 支付宝退款（三个渠道共用）：同一订单同一金额复用同一 out_request_no。 */
export async function alipayRefundTrade(
  sdk: AlipaySdkLike,
  params: { outTradeNo: string; refundCents: number; reason?: string },
): Promise<{ ok: boolean; status: "success" | "pending" | "error"; error?: string; raw?: unknown }> {
  const outRequestNo = `RF${params.outTradeNo}${params.refundCents}`.slice(0, 60);
  try {
    const result = await sdk.exec(
      "alipay.trade.refund",
      {
        bizContent: {
          out_trade_no: params.outTradeNo,
          refund_amount: (Math.round(params.refundCents) / 100).toFixed(2),
          out_request_no: outRequestNo,
          ...(params.reason ? { refund_reason: params.reason.slice(0, 256) } : {}),
        },
      },
      { validateSign: true },
    );
    const code = String(result.code ?? "");
    if (code !== "10000") {
      return {
        ok: false,
        status: "error",
        error: String(result.sub_msg ?? result.msg ?? "支付宝退款失败"),
        raw: result,
      };
    }
    // fund_change=Y 才是资金已退；N 表示受理未确认，留 pending 不假报成功
    return result.fund_change === "Y"
      ? { ok: true, status: "success", raw: result }
      : { ok: true, status: "pending", raw: result };
  } catch (err) {
    return { ok: false, status: "error", error: err instanceof Error ? err.message : String(err) };
  }
}
