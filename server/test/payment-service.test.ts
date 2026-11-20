import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import assert from "node:assert/strict";
import test from "node:test";
import { PaymentService } from "../src/services/payment-service.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";
import { registerPaymentTools } from "../src/tools/payment-tools.js";
import type { ToolContext } from "../src/tools/tool-registry.js";

// 订单台账是落盘的（SQLite）：重定向到临时目录，避免测试订单污染开发数据。
// 台账在首次下单时才打开，模块加载后再设环境变量同样生效。
process.env.PAYMENT_LEDGER_DB = join(mkdtempSync(join(tmpdir(), "pa-payment-test-")), "orders.db");

function makeContext(overrides?: Partial<ToolContext>): ToolContext {
  return {
    sessionId: "test-session-001",
    userId: "test-user-001",
    ...overrides,
  };
}

test("PaymentService - create wechat mock order", async () => {
  const service = new PaymentService();

  const result = await service.createOrder({
    amount: 29.90,
    description: "测试商品 - 微信支付",
    provider: "wechat",
    method: "native",
  });

  assert.equal(result.ok, true);
  assert.equal(result.provider, "wechat");
  assert.equal(result.amount, 29.90);
  assert.equal(result.description, "测试商品 - 微信支付");
  assert.equal(result.status, "pending");
  assert.ok(result.outTradeNo.length > 0);
  assert.ok(result.payUrl);
  assert.ok(result.qrCodeText);
});

test("PaymentService - create alipay mock order", async () => {
  const service = new PaymentService();

  const result = await service.createOrder({
    amount: 99.00,
    description: "测试商品 - 支付宝",
    provider: "alipay",
    method: "native",
  });

  assert.equal(result.ok, true);
  assert.equal(result.provider, "alipay");
  assert.equal(result.amount, 99.00);
  assert.equal(result.status, "pending");
  assert.ok(result.outTradeNo.length > 0);
});

test("PaymentService - custom outTradeNo", async () => {
  const service = new PaymentService();

  const result = await service.createOrder({
    amount: 1.00,
    description: "自定义订单号",
    provider: "wechat",
    method: "native",
    outTradeNo: "MY-ORDER-001",
  });

  assert.equal(result.ok, true);
  assert.equal(result.outTradeNo, "MY-ORDER-001");
});

test("PaymentService - reject zero amount", async () => {
  const service = new PaymentService();

  const result = await service.createOrder({
    amount: 0,
    description: "零金额订单",
    provider: "wechat",
    method: "native",
  });

  assert.equal(result.ok, false);
  assert.ok(result.error);
});

test("PaymentService - reject negative amount", async () => {
  const service = new PaymentService();

  const result = await service.createOrder({
    amount: -10,
    description: "负金额订单",
    provider: "alipay",
    method: "native",
  });

  assert.equal(result.ok, false);
  assert.ok(result.error);
});

test("PaymentService - mock complete payment flow", async () => {
  const service = new PaymentService();

  const order = await service.createOrder({
    amount: 50.00,
    description: "模拟完整支付流程",
    provider: "wechat",
    method: "native",
  });

  assert.equal(order.ok, true);
  const outTradeNo = order.outTradeNo;

  let query = await service.queryOrder(outTradeNo, "wechat");
  assert.equal(query.tradeState, "NOTPAY");
  assert.equal(query.tradeStateDesc, "待支付");

  service.mockCompletePayment(outTradeNo);

  query = await service.queryOrder(outTradeNo, "wechat");
  assert.equal(query.tradeState, "SUCCESS");
  assert.equal(query.tradeStateDesc, "支付成功");
  assert.equal(query.amount, 50.00);
});

test("PaymentService - mock close payment", async () => {
  const service = new PaymentService();

  const order = await service.createOrder({
    amount: 25.00,
    description: "支付关闭测试",
    provider: "alipay",
    method: "native",
  });

  service.mockClosePayment(order.outTradeNo);

  const query = await service.queryOrder(order.outTradeNo, "alipay");
  assert.equal(query.tradeState, "TRADE_CLOSED");
  assert.equal(query.tradeStateDesc, "已关闭");
});

test("PaymentService - alipay mock query before pay", async () => {
  const service = new PaymentService();

  const order = await service.createOrder({
    amount: 100.00,
    description: "支付宝查询测试",
    provider: "alipay",
    method: "h5",
  });

  const query = await service.queryOrder(order.outTradeNo, "alipay");
  assert.equal(query.tradeState, "WAIT_BUYER_PAY");
  assert.equal(query.tradeStateDesc, "待支付");
});

test("PaymentService - get mock orders", async () => {
  const service = new PaymentService();

  await service.createOrder({
    amount: 10.00,
    description: "订单1",
    provider: "wechat",
    method: "native",
  });

  await service.createOrder({
    amount: 20.00,
    description: "订单2",
    provider: "alipay",
    method: "native",
  });

  const orders = service.getMockOrders();
  assert.ok(orders.length >= 2);
});

test("PaymentService - outTradeNo unique generation", async () => {
  const service = new PaymentService();

  const r1 = await service.createOrder({
    amount: 1, description: "d1", provider: "wechat", method: "native",
  });
  const r2 = await service.createOrder({
    amount: 1, description: "d2", provider: "wechat", method: "native",
  });

  assert.notEqual(r1.outTradeNo, r2.outTradeNo);
});

test("Payment tools - create_order with wechat", async () => {
  const registry = new ToolRegistry();
  const service = new PaymentService();
  registerPaymentTools(registry, service);

  const result = await registry.execute(
    "payment.create_order",
    {
      provider: "wechat",
      method: "native",
      amount: 39.90,
      description: "微信支付测试商品",
    },
    makeContext()
  );

  assert.equal(result.ok, true);
  const data = result.result;
  assert.ok(data.outTradeNo);
  assert.equal(data.provider, "wechat");
  assert.equal(data.amount, 39.90);
  assert.equal(data.status, "pending");
  assert.ok(data.qrCodeDataUrl);
});

test("Payment tools - create_order with alipay", async () => {
  const registry = new ToolRegistry();
  const service = new PaymentService();
  registerPaymentTools(registry, service);

  const result = await registry.execute(
    "payment.create_order",
    {
      provider: "alipay",
      method: "h5",
      amount: 199.00,
      description: "支付宝H5测试商品",
    },
    makeContext()
  );

  assert.equal(result.ok, true);
  const data = result.result;
  assert.equal(data.provider, "alipay");
  assert.equal(data.method, "h5");
  assert.equal(data.amount, 199.00);
});

test("Payment tools - create_order with invalid provider", async () => {
  const registry = new ToolRegistry();
  const service = new PaymentService();
  registerPaymentTools(registry, service);

  const result = await registry.execute(
    "payment.create_order",
    {
      provider: "paypal",
      method: "native",
      amount: 100,
      description: "无效提供商",
    },
    makeContext()
  );

  assert.equal(result.ok, false);
});

test("Payment tools - create_order with zero amount", async () => {
  const registry = new ToolRegistry();
  const service = new PaymentService();
  registerPaymentTools(registry, service);

  const result = await registry.execute(
    "payment.create_order",
    {
      provider: "wechat",
      method: "native",
      amount: 0,
      description: "零金额",
    },
    makeContext()
  );

  assert.equal(result.ok, false);
});

test("Payment tools - query_order flow", async () => {
  const registry = new ToolRegistry();
  const service = new PaymentService();
  registerPaymentTools(registry, service);

  const order = await service.createOrder({
    amount: 88.00,
    description: "查询测试",
    provider: "wechat",
    method: "native",
  });

  const result = await registry.execute(
    "payment.query_order",
    {
      outTradeNo: order.outTradeNo,
      provider: "wechat",
    },
    makeContext()
  );

  assert.equal(result.ok, true);
  const data = result.result;
  assert.equal(data.tradeState, "NOTPAY");
});

test("Payment tools - list_methods", async () => {
  const registry = new ToolRegistry();
  const service = new PaymentService();
  registerPaymentTools(registry, service);

  const result = await registry.execute(
    "payment.list_methods",
    {},
    makeContext()
  );

  assert.equal(result.ok, true);
  const data = result.result;
  assert.ok(Array.isArray(data.methods));
  assert.equal(data.methods.length, 2);
  assert.equal(data.methods[0].provider, "wechat");
  assert.equal(data.methods[1].provider, "alipay");
  assert.equal(data.defaultProvider, "wechat");
});
