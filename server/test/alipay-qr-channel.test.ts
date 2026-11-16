import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PaymentAuthorizationService } from "../src/payments/authorization-service.js";
import {
  AlipayQrChannel,
  qrOutTradeNo,
  verifyAlipayNotify,
  type AlipaySdkLike,
} from "../src/payments/channels/alipay-qr.js";
import { ChannelRegistry } from "../src/payments/channels/index.js";
import { UnifiedPaymentStore } from "../src/payments/store.js";
import { UnifiedPaymentService } from "../src/payments/unified-payment-service.js";
import type { AlipayAccount } from "../src/payments/alipay-account.js";

/**
 * 支付宝扫码渠道（alipay.trade.precreate）单测。
 *
 * SDK 全部用桩：不触网、不依赖沙箱凭证，但请求参数、返回码分支、
 * 「查无此单不等于失败」的语义与生产路径完全一致。
 */

const account: AlipayAccount = {
  appId: "9021000000000000",
  privateKey: "test-private-key",
  alipayPublicKey: "test-public-key",
  gateway: "https://openapi-sandbox.dl.alipaydev.com/gateway.do",
  sellerId: "2088000000000000",
  sellerEmail: "seller@sandbox.com",
  env: "sandbox",
};

type Call = { method: string; params: Record<string, unknown> };

function makeSdk(handler: (method: string) => Record<string, unknown>): { sdk: AlipaySdkLike; calls: Call[] } {
  const calls: Call[] = [];
  const sdk: AlipaySdkLike = {
    async exec(method, params) {
      calls.push({ method, params });
      return handler(method);
    },
  };
  return { sdk, calls };
}

describe("支付宝扫码渠道", () => {
  it("未配置账户时明确不可用", () => {
    const channel = new AlipayQrChannel(() => null, () => null);
    const availability = channel.availability();
    assert.equal(availability.available, false);
    assert.match(String(availability.reason), /未配置/);
  });

  it("已配置时模式为 sandbox，具备二维码与退款能力", () => {
    const channel = new AlipayQrChannel(() => null, () => account);
    const availability = channel.availability();
    assert.equal(availability.available, true);
    assert.equal(availability.mode, "sandbox");
    assert.equal(availability.capabilities.qr, true);
    assert.equal(availability.capabilities.refund, true);
  });

  it("下单：传递金额/标题/单品码，返回支付宝短链", async () => {
    const { sdk, calls } = makeSdk(() => ({ code: "10000", qr_code: "https://qr.alipay.com/abc123" }));
    const channel = new AlipayQrChannel(() => sdk, () => account);
    const result = await channel.create({
      intentId: "pi_0123456789abcdef",
      actorId: "u_qr",
      amountCents: 1234,
      subject: "扫码测试",
      category: "other",
      bizDomain: "other",
    });
    assert.equal(result.ok, true);
    assert.equal(result.status, "pending");
    assert.equal(result.payUrl, "https://qr.alipay.com/abc123");
    assert.equal(result.channelOrderId, qrOutTradeNo("pi_0123456789abcdef"));
    assert.equal(calls[0]?.method, "alipay.trade.precreate");
    const biz = (calls[0]?.params.bizContent ?? {}) as Record<string, unknown>;
    assert.equal(biz.total_amount, "12.34");
    assert.equal(biz.subject, "扫码测试");
    assert.equal(biz.product_code, "FACE_TO_FACE_PAYMENT");
  });

  it("下单失败：透出支付宝的 sub_msg，不编造成功", async () => {
    const { sdk } = makeSdk(() => ({ code: "40004", sub_msg: "业务处理失败：金额非法" }));
    const channel = new AlipayQrChannel(() => sdk, () => account);
    const result = await channel.create({
      intentId: "pi_bad",
      actorId: "u_qr",
      amountCents: 1,
      subject: "坏单",
      category: "other",
      bizDomain: "other",
    });
    assert.equal(result.ok, false);
    assert.match(String(result.error), /金额非法/);
  });

  it("查单：TRADE_SUCCESS 视为已支付，带金额与付款人", async () => {
    const { sdk } = makeSdk(() => ({
      code: "10000",
      trade_status: "TRADE_SUCCESS",
      total_amount: "12.34",
      buyer_logon_id: "buyer***@sandbox.com",
      send_pay_date: "2026-11-13 22:00:00",
    }));
    const channel = new AlipayQrChannel(() => sdk, () => account);
    const result = await channel.query({
      intentId: "pi_x",
      actorId: "u_qr",
      channelOrderId: "NIX",
      amountCents: 1234,
      subject: "查单",
    });
    assert.equal(result.state, "paid");
    assert.equal(result.amountCents, 1234);
    assert.equal(result.payer, "buyer***@sandbox.com");
    assert.equal(result.paidAt, "2026-11-13 22:00:00");
  });

  it("查单：未扫码（TRADE_NOT_EXIST）保持 pending，不判失败", async () => {
    const { sdk } = makeSdk(() => ({ code: "40004", sub_code: "ACQ.TRADE_NOT_EXIST" }));
    const channel = new AlipayQrChannel(() => sdk, () => account);
    const result = await channel.query({
      intentId: "pi_y",
      actorId: "u_qr",
      channelOrderId: "NIY",
      amountCents: 100,
      subject: "查单",
    });
    assert.equal(result.state, "pending");
  });

  it("查单：其它错误码不透成 pending 假象", async () => {
    const { sdk } = makeSdk(() => ({ code: "40004", sub_code: "ACQ.SYSTEM_ERROR", sub_msg: "系统繁忙" }));
    const channel = new AlipayQrChannel(() => sdk, () => account);
    const result = await channel.query({
      intentId: "pi_z",
      actorId: "u_qr",
      channelOrderId: "NIZ",
      amountCents: 100,
      subject: "查单",
    });
    assert.equal(result.state, "unknown");
    assert.match(String(result.error), /系统繁忙/);
  });

  it("退款：fund_change=Y 记成功，N 记 pending（不假报已退）", async () => {
    const paid = makeSdk(() => ({ code: "10000", fund_change: "Y" }));
    const okChannel = new AlipayQrChannel(() => paid.sdk, () => account);
    const ok = await okChannel.refund(
      { intentId: "pi_r", actorId: "u_qr", channelOrderId: "NIR", amountCents: 500, subject: "退" },
      200,
      "部分退",
    );
    assert.equal(ok.ok, true);
    assert.equal(ok.status, "success");

    const pending = makeSdk(() => ({ code: "10000", fund_change: "N" }));
    const pendingChannel = new AlipayQrChannel(() => pending.sdk, () => account);
    const wait = await pendingChannel.refund(
      { intentId: "pi_r2", actorId: "u_qr", channelOrderId: "NIR2", amountCents: 500, subject: "退" },
      200,
    );
    assert.equal(wait.ok, true);
    assert.equal(wait.status, "pending");
  });

  it("通知验签：app_id 不匹配直接拒绝", () => {
    const sdk: AlipaySdkLike = { exec: async () => ({}), checkNotifySignV2: () => true };
    assert.equal(verifyAlipayNotify({ app_id: "other", out_trade_no: "NI1" }, { account, sdk }), false);
    assert.equal(verifyAlipayNotify({ app_id: account.appId, out_trade_no: "NI1" }, { account, sdk }), true);
  });
});

describe("支付宝扫码渠道接入统一模块：通知驱动收敛", () => {
  let workDir: string;
  let store: UnifiedPaymentStore;
  let service: UnifiedPaymentService;
  const paidState = { paid: false };

  before(() => {
    workDir = mkdtempSync(join(tmpdir(), "nextbot-alipay-qr-"));
    process.env.PAYMENT_MAX_SINGLE_CNY = "100000";
    process.env.PAYMENT_DAILY_BUDGET_CNY = "0";
    process.env.PAYMENT_ALLOWED_CATEGORIES = "*";

    const { sdk } = makeSdk((method) => {
      if (method === "alipay.trade.precreate") {
        return { code: "10000", qr_code: "https://qr.alipay.com/notify-test" };
      }
      if (!paidState.paid) return { code: "40004", sub_code: "ACQ.TRADE_NOT_EXIST" };
      return { code: "10000", trade_status: "TRADE_SUCCESS", total_amount: "8.80", buyer_logon_id: "b***@sandbox.com" };
    });

    store = new UnifiedPaymentStore(join(workDir, "qr.db"));
    const channels = new ChannelRegistry([new AlipayQrChannel(() => sdk, () => account)]);
    service = new UnifiedPaymentService({
      store,
      authorizations: new PaymentAuthorizationService(store),
      channels,
      baseUrl: () => "http://127.0.0.1:3997",
    });
  });

  after(() => {
    store.close();
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("下单 → 未付款查询仍 pending → 收到通知后查单变 paid", async () => {
    const auth = service.createAuthorization({
      actorId: "u_notify",
      channel: "alipay_qr",
      accepted: true,
      limits: { perTxCny: 50, dailyCny: 50, monthlyCny: 50, autoApproveCny: 50 },
      categories: ["*"],
    });
    assert.equal(auth.ok, true, auth.error);

    const created = await service.createIntent({
      actorId: "u_notify",
      amount: 8.8,
      subject: "通知收敛测试",
      bizDomain: "other",
    });
    assert.equal(created.nextAction, "pay");
    assert.equal(created.intent?.channel, "alipay_qr");
    const intentId = String(created.intent?.id);
    const channelOrderId = qrOutTradeNo(intentId);

    const beforePay = await service.queryIntent(intentId, "u_notify");
    assert.equal(beforePay.intent?.status, "pending");

    // 买家完成付款后支付宝推异步通知：路由只发「有变化」信号
    paidState.paid = true;
    await service.syncByChannelOrderId("alipay_qr", channelOrderId);

    const after = await service.queryIntent(intentId, "u_notify", { sync: false });
    assert.equal(after.intent?.status, "paid");
    assert.equal(after.nextAction, "paid");
  });
});
