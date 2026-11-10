import crypto from "node:crypto";
import { AlipaySdk } from "alipay-sdk";
import type { AlipaySdkCommonResult, IPageExecuteParams } from "alipay-sdk";
import { loadWebpayConfig, type WebpayConfig } from "../../config/webpay-config.js";
import { amountEquals, centsToAmount, parseAmountToCents } from "./webpay-amount.js";
import { getWebpayStore, type WebpayOrderRow, type WebpayRefundRow } from "./webpay-store.js";

/**
 * AI 网页应用收款（alipay.trade.page.pay）业务服务。
 *
 * 支付结果事实源只有两种：验签通过的异步通知、响应验签通过的主动查单。
 * 同步回跳参数与前端输入都不作为支付成功依据。
 * 后台对账循环持续查询未决订单/退款——买家关掉页面也不影响最终状态收敛。
 */

export class WebpayNotConfiguredError extends Error {
  constructor() {
    super("网页收款未配置：请先完成沙箱配置或由用户注入生产环境变量");
    this.name = "WebpayNotConfiguredError";
  }
}

export interface WebpayCreateResult {
  outTradeNo: string;
  paymentHtml: string;
}

export interface WebpayQueryResult {
  order: WebpayOrderRow;
  /** PAID | PENDING_PAYMENT | CLOSED | UNKNOWN */
  businessState: "PAID" | "PENDING_PAYMENT" | "CLOSED" | "UNKNOWN";
  tradeStatus: string;
}

function generateOutTradeNo(): string {
  return `WP${Date.now().toString(36)}${crypto.randomBytes(6).toString("hex")}`.toUpperCase().slice(0, 32);
}

function mapTradeState(tradeStatus: string | undefined): WebpayQueryResult["businessState"] {
  if (tradeStatus === "TRADE_SUCCESS" || tradeStatus === "TRADE_FINISHED") return "PAID";
  if (tradeStatus === "WAIT_BUYER_PAY") return "PENDING_PAYMENT";
  if (tradeStatus === "TRADE_CLOSED") return "CLOSED";
  return "UNKNOWN";
}

/** 付款成功通知：成功状态且不是退款/关单/分账事件 */
function isPaidTradeNotification(params: Record<string, string>): boolean {
  const paid = params.trade_status === "TRADE_SUCCESS" || params.trade_status === "TRADE_FINISHED";
  return paid && !params.out_biz_no && !params.gmt_refund && !params.refund_fee;
}

function sellerMatches(config: WebpayConfig, params: Record<string, string>): boolean {
  if (!config.sellerId && !config.sellerEmail) return true;
  return Boolean(
    (config.sellerId && params.seller_id === config.sellerId)
    || (config.sellerEmail && params.seller_email === config.sellerEmail),
  );
}

export class WebpayService {
  private reconcileTimer: NodeJS.Timeout | null = null;

  private requireConfig(): WebpayConfig {
    const config = loadWebpayConfig();
    if (!config) throw new WebpayNotConfiguredError();
    return config;
  }

  private sdkFor(config: WebpayConfig): AlipaySdk {
    return new AlipaySdk({
      appId: config.appId,
      privateKey: config.privateKey,
      keyType: "PKCS1",
      alipayPublicKey: config.alipayPublicKey,
      gateway: config.gateway,
      signType: "RSA2",
      charset: "utf-8",
      camelcase: false,
      timeout: 15_000,
    });
  }

  /** 下单：pageExec 生成自动提交表单 HTML（本地签名，无网络请求） */
  createOrder(input: { amount: unknown; subject: unknown; accountId?: string; returnUrl?: string }): WebpayCreateResult {
    const config = this.requireConfig();
    const cents = parseAmountToCents(input.amount);
    if (cents === null || cents < 1n || cents > 10_000_000_000n) {
      throw new Error("金额非法：需为 0.01 ~ 100000000 元、最多两位小数");
    }
    const subject = typeof input.subject === "string" ? input.subject.trim() : "";
    if (!subject || subject.length > 256) throw new Error("订单标题必填且不超过 256 字");

    const outTradeNo = generateOutTradeNo();
    const totalAmount = centsToAmount(cents);
    const now = new Date().toISOString();
    getWebpayStore().createOrder({
      outTradeNo,
      subject,
      totalAmount,
      status: "pending",
      tradeNo: null,
      appId: config.appId,
      env: config.env,
      accountId: input.accountId?.trim() || null,
      buyerLogonId: null,
      createdAt: now,
      updatedAt: now,
      paidAt: null,
      refundedAmount: "0.00",
      lastQueryAt: null,
      lastQueryStatus: null,
    });

    const params: IPageExecuteParams = {
      returnUrl: input.returnUrl?.trim() || `${config.baseUrl}/webpay/return`,
      bizContent: {
        out_trade_no: outTradeNo,
        total_amount: totalAmount,
        subject,
        product_code: "FAST_INSTANT_TRADE_PAY",
        timeout_express: "15m",
      },
    };
    // 无公网 HTTPS 通知地址时整体省略 notifyUrl，由主动查单兜底
    if (config.notifyUrl) params.notifyUrl = config.notifyUrl;
    const paymentHtml = this.sdkFor(config).pageExec("alipay.trade.page.pay", "POST", params);
    return { outTradeNo, paymentHtml };
  }

  /** 主动查单（响应验签）：幂等回写本地订单；待支付/未知不算失败也不判成功 */
  async queryOrder(outTradeNo: string): Promise<WebpayQueryResult | null> {
    const store = getWebpayStore();
    const order = store.getOrder(outTradeNo);
    if (!order) return null;
    if (order.status === "paid" || order.status === "refunded") {
      return { order, businessState: "PAID", tradeStatus: "TRADE_SUCCESS" };
    }
    if (order.status === "closed") {
      return { order, businessState: "CLOSED", tradeStatus: "TRADE_CLOSED" };
    }
    const config = this.requireConfig();
    const result = await this.sdkFor(config).exec("alipay.trade.query", {
      bizContent: { out_trade_no: outTradeNo },
    }, { validateSign: true });

    if (result.code !== "10000") {
      // 买家尚未打开支付表单时网关查无此单：保持待支付，由对账循环继续追踪
      const notExist = result.sub_code === "ACQ.TRADE_NOT_EXIST";
      store.recordQuery(outTradeNo, notExist ? "TRADE_NOT_EXIST" : "UNKNOWN");
      return {
        order: store.getOrder(outTradeNo)!,
        businessState: notExist ? "PENDING_PAYMENT" : "UNKNOWN",
        tradeStatus: notExist ? "WAIT_BUYER_PAY" : "UNKNOWN",
      };
    }
    const tradeStatus = String(result.trade_status ?? "");
    store.recordQuery(outTradeNo, tradeStatus || "UNKNOWN");
    const businessState = mapTradeState(tradeStatus);
    if (
      businessState === "PAID"
      && String(result.out_trade_no ?? "") === outTradeNo
      && amountEquals(order.totalAmount, result.total_amount)
    ) {
      store.markPaidIdempotently(outTradeNo, String(result.trade_no ?? ""), String(result.buyer_logon_id ?? "") || null, String(result.send_pay_date ?? "") || new Date().toISOString());
    } else if (businessState === "CLOSED") {
      store.markClosed(outTradeNo);
    }
    return { order: store.getOrder(outTradeNo)!, businessState, tradeStatus };
  }

  /** 关闭未付款交易；生产环境必须显式 confirm（不主动发起真实生产关单） */
  async closeOrder(outTradeNo: string, confirm: boolean): Promise<{ ok: boolean; error?: string }> {
    const config = this.requireConfig();
    const store = getWebpayStore();
    const order = store.getOrder(outTradeNo);
    if (!order) return { ok: false, error: "订单不存在" };
    if (order.status !== "pending") return { ok: false, error: `订单状态 ${order.status}，不可关闭` };
    if (config.env === "production" && confirm !== true) {
      return { ok: false, error: "生产关单需显式确认目标交易（confirm=true）" };
    }
    const result = await this.sdkFor(config).exec("alipay.trade.close", {
      bizContent: { out_trade_no: outTradeNo },
    }, { validateSign: true });
    if (result.code === "10000") {
      store.markClosed(outTradeNo);
      return { ok: true };
    }
    if (result.sub_code === "ACQ.TRADE_NOT_EXIST") {
      // 表单从未提交，网关无交易可关；本地保持待支付（买家仍可能提交已生成的表单）
      return { ok: false, error: "网关暂无此交易（买家未提交支付表单），无需关闭" };
    }
    return { ok: false, error: String(result.sub_msg || result.msg || "关闭失败") };
  }

  /**
   * 退款：新退款用新 out_request_no；同一笔重试必须复用原编号原参数。
   * fund_change != Y 时结果未决，留 pending 由退款查询确认。
   */
  async refund(input: {
    outTradeNo: string;
    refundAmount: unknown;
    outRequestNo?: string;
    reason?: string;
  }): Promise<{ ok: boolean; outRequestNo: string; status: string; error?: string }> {
    const config = this.requireConfig();
    const store = getWebpayStore();
    const order = store.getOrder(input.outTradeNo);
    if (!order) return { ok: false, outRequestNo: "", status: "error", error: "订单不存在" };
    if (order.status !== "paid" && order.status !== "refunded") {
      return { ok: false, outRequestNo: "", status: "error", error: "订单未支付，不可退款" };
    }
    const cents = parseAmountToCents(input.refundAmount);
    if (cents === null || cents < 1n) {
      return { ok: false, outRequestNo: "", status: "error", error: "退款金额非法" };
    }
    const totalCents = parseAmountToCents(order.totalAmount)!;
    const refundedCents = parseAmountToCents(order.refundedAmount) ?? 0n;

    let outRequestNo = input.outRequestNo?.trim() || "";
    if (outRequestNo) {
      const existing = store.getRefund(outRequestNo);
      if (existing) {
        // 同一退款重试：金额与原请求必须一致，防止换金额重复退
        if (existing.outTradeNo !== input.outTradeNo || !amountEquals(existing.refundAmount, input.refundAmount)) {
          return { ok: false, outRequestNo, status: "error", error: "out_request_no 已存在且参数不一致" };
        }
        if (existing.status === "success") {
          return { ok: true, outRequestNo, status: "success" };
        }
      }
    } else {
      outRequestNo = generateOutTradeNo().replace(/^WP/, "RF");
    }
    // 在途（pending）退款同样占用额度，防止多笔未决退款叠加超额
    const inFlightCents = store.listPendingRefundsForOrder(input.outTradeNo)
      .filter((r) => r.outRequestNo !== outRequestNo)
      .reduce((sum, r) => sum + (parseAmountToCents(r.refundAmount) ?? 0n), 0n);
    if (refundedCents + inFlightCents + cents > totalCents) {
      return { ok: false, outRequestNo, status: "error", error: "累计退款超过订单实付金额" };
    }
    const refundAmount = centsToAmount(cents);
    const reason = typeof input.reason === "string" ? input.reason.slice(0, 256) : "";
    if (!store.getRefund(outRequestNo)) {
      const now = new Date().toISOString();
      store.createRefund({
        outRequestNo, outTradeNo: input.outTradeNo, refundAmount,
        status: "pending", fundChange: null, reason, createdAt: now, updatedAt: now, lastQueryAt: null,
      });
    }
    const result = await this.sdkFor(config).exec("alipay.trade.refund", {
      bizContent: {
        out_trade_no: input.outTradeNo,
        refund_amount: refundAmount,
        out_request_no: outRequestNo,
        ...(reason ? { refund_reason: reason } : {}),
      },
    }, { validateSign: true });
    if (result.code === "10000" && result.fund_change === "Y") {
      this.confirmRefundSuccess(outRequestNo, input.outTradeNo, refundAmount, "Y");
      return { ok: true, outRequestNo, status: "success" };
    }
    if (result.code === "10000") {
      // 受理成功但资金变化未确认：同一 out_request_no 走退款查询
      return { ok: true, outRequestNo, status: "pending" };
    }
    return { ok: false, outRequestNo, status: "pending", error: String(result.sub_msg || result.msg || "退款请求失败") };
  }

  /** 退款查询：仅 REFUND_SUCCESS 认退款成功；距退款请求至少 10 秒 */
  async queryRefund(outTradeNo: string, outRequestNo: string): Promise<{ ok: boolean; status: string; raw?: AlipaySdkCommonResult; error?: string }> {
    const config = this.requireConfig();
    const store = getWebpayStore();
    const refund = store.getRefund(outRequestNo);
    if (!refund || refund.outTradeNo !== outTradeNo) return { ok: false, status: "error", error: "退款记录不存在" };
    if (refund.status === "success") return { ok: true, status: "success" };
    store.touchRefundQuery(outRequestNo);
    const result = await this.sdkFor(config).exec("alipay.trade.fastpay.refund.query", {
      bizContent: { out_trade_no: outTradeNo, out_request_no: outRequestNo },
    }, { validateSign: true });
    if (result.code !== "10000") {
      return { ok: false, status: "pending", error: String(result.sub_msg || result.msg || "退款查询失败") };
    }
    if (result.refund_status === "REFUND_SUCCESS") {
      this.confirmRefundSuccess(outRequestNo, outTradeNo, refund.refundAmount, "Y");
      return { ok: true, status: "success", raw: result };
    }
    return { ok: true, status: "pending", raw: result };
  }

  private confirmRefundSuccess(outRequestNo: string, outTradeNo: string, refundAmount: string, fundChange: string): void {
    const store = getWebpayStore();
    const refund = store.getRefund(outRequestNo);
    if (!refund || refund.status === "success") return;
    store.setRefundResult(outRequestNo, "success", fundChange);
    const order = store.getOrder(outTradeNo);
    if (!order) return;
    const newTotal = (parseAmountToCents(order.refundedAmount) ?? 0n) + parseAmountToCents(refundAmount)!;
    const totalCents = parseAmountToCents(order.totalAmount)!;
    store.recordRefundSuccess(outTradeNo, centsToAmount(newTotal), newTotal >= totalCents);
  }

  /**
   * 异步通知：验签 → 归属/金额校验 → 事件幂等 → 付款成功幂等标记。
   * 任何失败返回 "fail" 让支付宝重推；成功（含重复通知）返回 "success"。
   */
  handleNotify(params: Record<string, string>): "success" | "fail" {
    let config: WebpayConfig;
    try {
      config = this.requireConfig();
    } catch {
      return "fail";
    }
    if (!params.app_id || params.app_id !== config.appId) return "fail";
    const sdk = this.sdkFor(config);
    if (!sdk.checkNotifySignV2(params)) return "fail";

    const store = getWebpayStore();
    const order = store.getOrder(String(params.out_trade_no ?? ""));
    if (!order) return "fail";
    if (order.appId !== params.app_id) return "fail";
    if (!amountEquals(order.totalAmount, params.total_amount)) return "fail";
    if (!sellerMatches(config, params)) return "fail";

    const notifyId = String(params.notify_id ?? "");
    const tradeStatus = String(params.trade_status ?? "");
    if (!notifyId || !tradeStatus) return "fail";
    const inserted = store.insertNotifyOnce(
      notifyId, tradeStatus, order.outTradeNo,
      params.trade_no ? String(params.trade_no) : null,
      JSON.stringify(params),
    );
    if (!inserted) return "success";

    if (isPaidTradeNotification(params)) {
      store.markPaidIdempotently(
        order.outTradeNo,
        String(params.trade_no ?? ""),
        String(params.buyer_logon_id ?? "") || null,
        String(params.gmt_payment ?? "") || new Date().toISOString(),
      );
    }
    // 退款/关单等非付款事件：已落事件表，不改变订单为已支付
    return "success";
  }

  /** 同步回跳参数验签：只用于定位订单，绝不据此判定支付成功 */
  verifyReturnParams(params: Record<string, string>): { valid: boolean; outTradeNo: string } {
    let config: WebpayConfig;
    try {
      config = this.requireConfig();
    } catch {
      return { valid: false, outTradeNo: "" };
    }
    if (params.app_id !== config.appId) return { valid: false, outTradeNo: "" };
    const valid = this.sdkFor(config).checkNotifySignV2(params);
    return { valid, outTradeNo: valid ? String(params.out_trade_no ?? "") : "" };
  }

  /** 后台对账：未决订单持续查单、未决退款延迟查询；用户关页不影响收敛 */
  startReconciliation(): void {
    if (this.reconcileTimer) return;
    this.reconcileTimer = setInterval(() => {
      void this.reconcileOnce().catch((err) => {
        console.error("[webpay] reconcile failed:", err instanceof Error ? err.message : err);
      });
    }, 15_000);
    this.reconcileTimer.unref();
  }

  async reconcileOnce(): Promise<void> {
    if (!loadWebpayConfig()) return;
    const store = getWebpayStore();
    const now = Date.now();
    for (const order of store.listPendingOrders()) {
      const created = Date.parse(order.createdAt);
      if (now - created < 10_000) continue;
      // 超过 24h 的未决单不在循环里追（仍可由显式查单恢复），避免无限累积网关调用
      if (now - created > 24 * 3_600_000) continue;
      try {
        await this.queryOrder(order.outTradeNo);
      } catch (err) {
        console.error("[webpay] reconcile query failed:", order.outTradeNo, err instanceof Error ? err.message : err);
      }
    }
    for (const refund of store.listPendingRefunds()) {
      if (now - Date.parse(refund.createdAt) < 10_000) continue;
      try {
        await this.queryRefund(refund.outTradeNo, refund.outRequestNo);
      } catch (err) {
        console.error("[webpay] reconcile refund failed:", refund.outRequestNo, err instanceof Error ? err.message : err);
      }
    }
  }
}

let sharedService: WebpayService | null = null;

export function getWebpayService(): WebpayService {
  if (!sharedService) {
    sharedService = new WebpayService();
    sharedService.startReconciliation();
  }
  return sharedService;
}