import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AlipayAccount } from "../src/payments/alipay-account.js";
import { PaymentAuthorizationService } from "../src/payments/authorization-service.js";
import { AlipayWapChannel, wapOutTradeNo } from "../src/payments/channels/alipay-wap.js";
import { ChannelRegistry } from "../src/payments/channels/index.js";
import type { PaymentChannel } from "../src/payments/channels/types.js";
import type { AlipaySdkLike } from "../src/payments/alipay-sdk.js";
import { UnifiedPaymentStore } from "../src/payments/store.js";
import { UnifiedPaymentService } from "../src/payments/unified-payment-service.js";

/**
 * 手机网站支付（alipay.trade.wap.pay）与「同 provider 换通道」：
 *   - 手机端点「打开支付宝付款」拿到的必须是签好名的收银台地址；
 *   - 电脑扫码授权过，手机换 wap 不该再要一次授权，但额度必须连着算。
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

describe("支付宝手机网站支付渠道", () => {
  it("下单：GET 跳转地址带 QUICK_WAP_WAY / return_url / quit_url", async () => {
    const calls: Array<{ method: string; httpMethod: string; params: Record<string, unknown> }> = [];
    const sdk: AlipaySdkLike = {
      exec: async () => ({}),
      pageExec(method, httpMethod, params) {
        calls.push({ method, httpMethod, params });
        return "https://openapi-sandbox.dl.alipaydev.com/gateway.do?method=alipay.trade.wap.pay&sign=x";
      },
    };
    const channel = new AlipayWapChannel(() => sdk, () => account);
    const result = await channel.create({
      intentId: "pi_abcdef0123456789",
      actorId: "u_wap",
      amountCents: 12850,
      subject: "梦乐城火锅双人餐",
      category: "dining",
      bizDomain: "dining",
      returnUrl: "http://127.0.0.1:3000/payment/pay?intentId=pi_abcdef0123456789",
    });

    assert.equal(result.ok, true);
    assert.equal(result.status, "pending");
    assert.equal(result.channelOrderId, wapOutTradeNo("pi_abcdef0123456789"));
    assert.match(String(result.payUrl), /^https:\/\/openapi-sandbox/);

    const call = calls[0];
    assert.equal(call?.method, "alipay.trade.wap.pay");
    assert.equal(call?.httpMethod, "GET");
    const biz = (call?.params.bizContent ?? {}) as Record<string, unknown>;
    assert.equal(biz.product_code, "QUICK_WAP_WAY");
    assert.equal(biz.total_amount, "128.50");
    assert.equal(biz.quit_url, "http://127.0.0.1:3000/payment/pay?intentId=pi_abcdef0123456789");
    assert.equal(call?.params.returnUrl, "http://127.0.0.1:3000/payment/pay?intentId=pi_abcdef0123456789");
  });

  it("SDK 不支持页面跳转时如实失败（不造一个假链接）", async () => {
    const channel = new AlipayWapChannel(() => ({ exec: async () => ({}) }), () => account);
    const result = await channel.create({
      intentId: "pi_x",
      actorId: "u",
      amountCents: 100,
      subject: "测试",
      category: "other",
      bizDomain: "other",
    });
    assert.equal(result.ok, false);
    assert.match(String(result.error), /不支持页面跳转|未配置/);
  });

  it("渠道可用性标注为手机端", () => {
    const channel = new AlipayWapChannel(() => null, () => account);
    assert.equal(channel.availability().audience, "mobile");
    assert.equal(channel.availability().available, true);
  });
});

describe("同 provider 换通道：复用授权但不复用额度", () => {
  let workDir: string;
  let store: UnifiedPaymentStore;
  let service: UnifiedPaymentService;

  const qrStub: PaymentChannel = {
    id: "alipay_qr",
    label: "扫码桩",
    direction: "collect",
    audience: "desktop",
    availability: () => ({
      channel: "alipay_qr",
      label: "扫码桩",
      direction: "collect",
      audience: "desktop",
      available: true,
      mode: "sandbox",
      capabilities: { qr: true, redirect: false, refund: true, needsCashierUrl: false },
    }),
    create: async () => ({ ok: true, status: "pending", channelOrderId: "NI_STUB", payUrl: "https://qr.alipay.com/stub" }),
    query: async () => ({ state: "pending" }),
  };
  const wapStub: PaymentChannel = {
    id: "alipay_wap",
    label: "手机站桩",
    direction: "collect",
    audience: "mobile",
    availability: () => ({
      channel: "alipay_wap",
      label: "手机站桩",
      direction: "collect",
      audience: "mobile",
      available: true,
      mode: "sandbox",
      capabilities: { qr: false, redirect: true, refund: true, needsCashierUrl: false },
    }),
    create: async () => ({ ok: true, status: "pending", channelOrderId: "NW_STUB", payUrl: "https://openapi-sandbox.stub" }),
    query: async () => ({ state: "pending" }),
  };

  before(() => {
    workDir = mkdtempSync(join(tmpdir(), "nextbot-wap-"));
    process.env.PAYMENT_MAX_SINGLE_CNY = "100000";
    process.env.PAYMENT_DAILY_BUDGET_CNY = "0";
    process.env.PAYMENT_ALLOWED_CATEGORIES = "*";
    store = new UnifiedPaymentStore(join(workDir, "wap.db"));
    service = new UnifiedPaymentService({
      store,
      authorizations: new PaymentAuthorizationService(store),
      channels: new ChannelRegistry([qrStub, wapStub]),
      baseUrl: () => "http://127.0.0.1:3993",
    });
  });

  after(() => {
    store.close();
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* Windows 上 WAL 句柄释放有延迟 */
    }
  });

  it("只在电脑扫码渠道授权过，手机切 wap 付款不会要求重新授权", async () => {
    const auth = service.createAuthorization({
      actorId: "u_cross",
      channel: "alipay_qr",
      accepted: true,
      limits: { perTxCny: 100, dailyCny: 100, monthlyCny: 500, autoApproveCny: 0 },
      categories: ["*"],
    });
    assert.equal(auth.ok, true, auth.error);

    const created = await service.createIntent({
      actorId: "u_cross",
      amount: 30,
      subject: "跨通道付款",
      bizDomain: "other",
    });
    assert.equal(created.nextAction, "confirm");
    const token = String(created.confirmToken);

    const paid = await service.payIntent({
      intentId: String(created.intent?.id),
      actorId: "u_cross",
      confirmToken: token,
      channel: "alipay_wap",
    });
    assert.equal(paid.nextAction, "pay", paid.error);
    assert.equal(paid.intent?.channel, "alipay_wap");
    assert.equal(paid.intent?.status, "pending");
  });

  it("换通道不重置额度：扫码 60 + 手机 60 超过日限额 100 会被拦", async () => {
    service.createAuthorization({
      actorId: "u_budget",
      channel: "alipay_qr",
      accepted: true,
      limits: { perTxCny: 100, dailyCny: 100, monthlyCny: 500, autoApproveCny: 100 },
      categories: ["*"],
    });

    const first = await service.createIntent({
      actorId: "u_budget",
      amount: 60,
      subject: "扫码付",
      bizDomain: "other",
    });
    assert.equal(first.nextAction, "pay");

    const second = await service.createIntent({
      actorId: "u_budget",
      amount: 60,
      subject: "手机付",
      bizDomain: "other",
      channel: "alipay_wap",
    });
    assert.equal(second.nextAction, "blocked");
    assert.match(String(second.intent?.failureReason), /今日已用/);
  });
});
