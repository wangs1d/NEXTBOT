import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";

import { parseAmountToCents, centsToAmount, amountEquals } from "../src/services/webpay/webpay-amount.js";
import { WebpayStore, getWebpayStore } from "../src/services/webpay/webpay-store.js";
import { WebpayService } from "../src/services/webpay/webpay-service.js";
import { registerWebpayRoutes } from "../src/routes/http/webpay.js";
import { loadWebpayConfig } from "../src/config/webpay-config.js";

/**
 * 网页收款单元测试：金额定点语义、持久幂等、通知验签与业务校验、退款护栏。
 * 密钥为测试专用一次性 RSA 对（非任何支付宝应用密钥），仅用于本地签名/验签回路。
 * 不触网：涉及网关的路径（查单/退款执行）由沙箱联调覆盖。
 */

let workDir: string;
let store: WebpayStore;
let service: WebpayService;
let privateKeyPem: string;
let appId: string;

function rawBase64Der(pem: string): string {
  return pem.split("\n").filter((line) => !line.includes("-----")).join("");
}

function signNotify(params: Record<string, string>): string {
  const content = Object.keys(params)
    .filter((k) => k !== "sign" && k !== "sign_type" && params[k] !== "")
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  return crypto.createSign("RSA-SHA256").update(content, "utf8").sign(privateKeyPem, "base64");
}

function paidNotifyParams(outTradeNo: string, amount: string): Record<string, string> {
  const params: Record<string, string> = {
    notify_type: "trade_status_sync",
    notify_id: `notify-${outTradeNo}-1`,
    notify_time: "2026-11-09 12:00:00",
    app_id: appId,
    charset: "utf-8",
    version: "1.0",
    sign_type: "RSA2",
    trade_no: `TN${outTradeNo}`,
    out_trade_no: outTradeNo,
    trade_status: "TRADE_SUCCESS",
    total_amount: amount,
    receipt_amount: amount,
    buyer_pay_amount: amount,
    gmt_payment: "2026-11-09 12:00:00",
  };
  params.sign = signNotify(params);
  return params;
}

function seedPaidOrder(outTradeNo: string, amount: string): void {
  const now = new Date().toISOString();
  store.createOrder({
    outTradeNo, subject: "测试商品", totalAmount: amount, status: "pending",
    tradeNo: null, appId, env: "sandbox", accountId: null, buyerLogonId: null,
    createdAt: now, updatedAt: now, paidAt: null, refundedAmount: "0.00",
    lastQueryAt: null, lastQueryStatus: null,
  });
  assert.equal(service.handleNotify(paidNotifyParams(outTradeNo, amount)), "success");
}

before(() => {
  workDir = mkdtempSync(join(tmpdir(), "webpay-test-"));
  process.env.WEBPAY_LEDGER_DB = join(workDir, "orders.db");
  const pair = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  privateKeyPem = pair.privateKey.export({ type: "pkcs1", format: "pem" }) as string;
  const publicDer = pair.publicKey.export({ type: "spki", format: "der" }) as Buffer;
  appId = "2026000000000001";
  const fixture = {
    appId,
    appPrivatePkcsKey: rawBase64Der(privateKeyPem),
    alipayPublicKey: publicDer.toString("base64"),
  };
  const configPath = join(workDir, ".alipay-sandbox.json");
  writeFileSync(configPath, JSON.stringify(fixture), "utf8");
  process.env.WEBPAY_SANDBOX_CONFIG = configPath;
  store = new WebpayStore();
  service = new WebpayService();
});

after(() => {
  store.close();
  getWebpayStore().close();
  delete process.env.WEBPAY_LEDGER_DB;
  delete process.env.WEBPAY_SANDBOX_CONFIG;
  rmSync(workDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

describe("金额定点语义", () => {
  it("解析合法金额", () => {
    assert.equal(parseAmountToCents("0.01"), 1n);
    assert.equal(parseAmountToCents("88.8"), 8880n);
    assert.equal(parseAmountToCents("100"), 10000n);
    assert.equal(parseAmountToCents(0.01), 1n);
  });
  it("拒绝非法金额", () => {
    assert.equal(parseAmountToCents("1.001"), null);
    assert.equal(parseAmountToCents("-1"), null);
    assert.equal(parseAmountToCents("abc"), null);
    assert.equal(parseAmountToCents(""), null);
    assert.equal(parseAmountToCents(null), null);
  });
  it("元分互转与等值比较", () => {
    assert.equal(centsToAmount(8880n), "88.80");
    assert.ok(amountEquals("88.8", "88.80"));
    assert.ok(!amountEquals("88.80", "88.81"));
  });
});

describe("配置加载", () => {
  it("读取沙箱文件并固定 PKCS#1 字段与沙箱网关", () => {
    const config = loadWebpayConfig();
    assert.ok(config);
    assert.equal(config.env, "sandbox");
    assert.equal(config.appId, appId);
    assert.equal(config.gateway, "https://openapi-sandbox.dl.alipaydev.com/gateway.do");
    assert.equal(config.notifyUrl, "");
  });
  it("文件缺失且无生产环境变量时未配置", () => {
    const prev = process.env.WEBPAY_SANDBOX_CONFIG;
    process.env.WEBPAY_SANDBOX_CONFIG = join(workDir, "missing.json");
    assert.equal(loadWebpayConfig(), null);
    process.env.WEBPAY_SANDBOX_CONFIG = prev;
  });
  it("notify_url 含空格/HTML 标签或非 HTTPS 时整体省略", () => {
    process.env.WEBPAY_NOTIFY_URL = "https://example.com/notify url";
    assert.equal(loadWebpayConfig()?.notifyUrl, "");
    process.env.WEBPAY_NOTIFY_URL = "https://example.com/<tag>";
    assert.equal(loadWebpayConfig()?.notifyUrl, "");
    process.env.WEBPAY_NOTIFY_URL = "http://example.com/notify";
    assert.equal(loadWebpayConfig()?.notifyUrl, "");
    process.env.WEBPAY_NOTIFY_URL = "https://example.com/notify";
    assert.equal(loadWebpayConfig()?.notifyUrl, "https://example.com/notify");
    delete process.env.WEBPAY_NOTIFY_URL;
  });
});

describe("下单", () => {
  it("pageExec 生成自动提交表单，product_code 固定，省略 notifyUrl", () => {
    const result = service.createOrder({ amount: "0.01", subject: "沙箱测试商品" });
    assert.ok(result.outTradeNo.startsWith("WP"));
    assert.match(result.paymentHtml, /<form/);
    assert.match(result.paymentHtml, /alipay\.trade\.page\.pay/);
    assert.match(result.paymentHtml, /FAST_INSTANT_TRADE_PAY/);
    assert.match(result.paymentHtml, /submit/);
    assert.ok(!result.paymentHtml.includes("notify_url"));
    assert.match(result.paymentHtml, /return_url/);
    const order = store.getOrder(result.outTradeNo);
    assert.ok(order);
    assert.equal(order.status, "pending");
    assert.equal(order.totalAmount, "0.01");
  });
  it("非法金额与空标题被拒绝", () => {
    assert.throws(() => service.createOrder({ amount: "0", subject: "x" }));
    assert.throws(() => service.createOrder({ amount: "1.001", subject: "x" }));
    assert.throws(() => service.createOrder({ amount: "1", subject: "" }));
  });
});

describe("异步通知", () => {
  it("验签通过的付款通知幂等标记已支付", () => {
    const outTradeNo = "WPTESTNOTIFY001";
    const now = new Date().toISOString();
    store.createOrder({
      outTradeNo, subject: "通知测试", totalAmount: "10.00", status: "pending",
      tradeNo: null, appId, env: "sandbox", buyerLogonId: null,
      createdAt: now, updatedAt: now, paidAt: null, refundedAmount: "0.00",
      lastQueryAt: null, lastQueryStatus: null,
    });
    const params = paidNotifyParams(outTradeNo, "10.00");
    assert.equal(service.handleNotify(params), "success");
    assert.equal(store.getOrder(outTradeNo)?.status, "paid");
    // 重复通知：事件幂等 + 状态幂等
    assert.equal(service.handleNotify(params), "success");
    assert.equal(store.getOrder(outTradeNo)?.status, "paid");
  });
  it("金额不符返回 fail", () => {
    const outTradeNo = "WPTESTNOTIFY002";
    const now = new Date().toISOString();
    store.createOrder({
      outTradeNo, subject: "通知测试", totalAmount: "10.00", status: "pending",
      tradeNo: null, appId, env: "sandbox", buyerLogonId: null,
      createdAt: now, updatedAt: now, paidAt: null, refundedAmount: "0.00",
      lastQueryAt: null, lastQueryStatus: null,
    });
    assert.equal(service.handleNotify(paidNotifyParams(outTradeNo, "99.00")), "fail");
    assert.equal(store.getOrder(outTradeNo)?.status, "pending");
  });
  it("篡改签名返回 fail", () => {
    const params = paidNotifyParams("WPTESTNOTIFY003", "10.00");
    params.total_amount = "0.01";
    assert.equal(service.handleNotify(params), "fail");
  });
  it("退款事件不误判为付款成功", () => {
    const outTradeNo = "WPTESTNOTIFY004";
    seedPaidOrder(outTradeNo, "10.00");
    const params = paidNotifyParams(outTradeNo, "10.00");
    params.trade_status = "TRADE_CLOSED";
    params.gmt_refund = "2026-11-09 13:00:00";
    params.refund_fee = "10.00";
    params.out_biz_no = "refund-biz-001";
    params.notify_id = `notify-${outTradeNo}-refund`;
    params.sign = signNotify(params);
    assert.equal(service.handleNotify(params), "success");
    assert.equal(store.getOrder(outTradeNo)?.status, "paid");
  });
  it("未知 app_id 返回 fail", () => {
    const params = paidNotifyParams("WPTESTNOTIFY005", "10.00");
    params.app_id = "9999";
    assert.equal(service.handleNotify(params), "fail");
  });
});

describe("退款护栏（不触网）", () => {
  it("未支付订单不可退款", async () => {
    const result = await service.refund({ outTradeNo: "WPTESTREFUND001", refundAmount: "1.00" });
    assert.equal(result.ok, false);
  });
  it("累计退款不能超过实付金额", async () => {
    const outTradeNo = "WPTESTREFUND002";
    seedPaidOrder(outTradeNo, "10.00");
    const result = await service.refund({ outTradeNo, refundAmount: "10.01" });
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /累计退款/);
  });
  it("同一 out_request_no 重试参数必须一致", async () => {
    const outTradeNo = "WPTESTREFUND003";
    seedPaidOrder(outTradeNo, "10.00");
    const now = new Date().toISOString();
    store.createRefund({
      outRequestNo: "RF001", outTradeNo, refundAmount: "6.00", status: "pending",
      fundChange: null, reason: "", createdAt: now, updatedAt: now, lastQueryAt: null,
    });
    const result = await service.refund({ outTradeNo, refundAmount: "5.00", outRequestNo: "RF001" });
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /参数不一致/);
  });
  it("在途退款占用额度，叠加新退款不得超额", async () => {
    const outTradeNo = "WPTESTREFUND004";
    seedPaidOrder(outTradeNo, "10.00");
    const now = new Date().toISOString();
    store.createRefund({
      outRequestNo: "RFINFLIGHT", outTradeNo, refundAmount: "6.00", status: "pending",
      fundChange: null, reason: "", createdAt: now, updatedAt: now, lastQueryAt: null,
    });
    const result = await service.refund({ outTradeNo, refundAmount: "5.00" });
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /累计退款/);
  });
});

describe("HTTP 路由", () => {
  it("页面与下单/通知/查单全链路（fastify inject）", async () => {
    const app = Fastify();
    registerWebpayRoutes(app);
    await app.ready();

    const checkout = await app.inject({ method: "GET", url: "/webpay/checkout" });
    assert.equal(checkout.statusCode, 200);
    assert.match(checkout.body, /收银台/);

    // 不带支付参数的精确 return_url：200 中性页面壳
    const ret = await app.inject({ method: "GET", url: "/webpay/return" });
    assert.equal(ret.statusCode, 200);
    assert.match(ret.body, /正在确认支付结果/);

    const created = await app.inject({
      method: "POST", url: "/api/webpay/orders",
      payload: { amount: "0.01", subject: "路由测试" },
    });
    assert.equal(created.statusCode, 200);
    const { outTradeNo, paymentHtml } = created.json();
    assert.ok(paymentHtml.includes("<form"));

    const notify = await app.inject({
      method: "POST", url: "/api/webpay/notify",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams(paidNotifyParams(outTradeNo, "0.01")).toString(),
    });
    assert.equal(notify.statusCode, 200);
    assert.equal(notify.body, "success");

    // 已支付订单查单短路本地状态，不触网
    const queried = await app.inject({ method: "GET", url: `/api/webpay/orders/${outTradeNo}` });
    assert.equal(queried.statusCode, 200);
    assert.equal(queried.json().businessState, "PAID");

    const missing = await app.inject({ method: "GET", url: "/api/webpay/orders/WPNOSUCHORDER" });
    assert.equal(missing.statusCode, 404);

    await app.close();
  });
});