import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import assert from "node:assert/strict";
import test from "node:test";
import { PaymentService } from "../src/services/payment-service.js";
import {
  getPaymentOrderLedger,
} from "../src/services/payment-order-ledger.js";
import {
  getPaymentGuardrailConfig,
} from "../src/config/payment-config.js";
import { listCapabilityStatuses } from "../src/services/capability-readiness-service.js";

// 台账落盘重定向到临时目录；护栏配置每次调用现读 env，先设好再测。
process.env.PAYMENT_LEDGER_DB = join(mkdtempSync(join(tmpdir(), "pa-guardrail-test-")), "orders.db");

test("支付护栏 - 默认配置开启且类别全放行", () => {
  const g = getPaymentGuardrailConfig({});
  assert.equal(g.maxSingleAmountCny, 1000);
  assert.equal(g.dailyBudgetCny, 3000);
  assert.deepEqual(g.allowedCategories, ["*"]);
});

test("支付护栏 - env 覆盖与 0=不限", () => {
  const g = getPaymentGuardrailConfig({
    PAYMENT_MAX_SINGLE_CNY: "50",
    PAYMENT_DAILY_BUDGET_CNY: "0",
    PAYMENT_ALLOWED_CATEGORIES: "travel,food",
  });
  assert.equal(g.maxSingleAmountCny, 50);
  assert.equal(g.dailyBudgetCny, 0);
  assert.deepEqual(g.allowedCategories, ["travel", "food"]);
});

test("支付护栏 - 超单笔上限被拦截且错误信息写给用户", async () => {
  const service = new PaymentService();
  const result = await service.createOrder({
    amount: 100000,
    description: "超出护栏的测试单",
    provider: "wechat",
    method: "native",
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, "error");
  assert.match(result.error ?? "", /单笔上限/);
  assert.match(result.error ?? "", /PAYMENT_MAX_SINGLE_CNY/);
});

test("支付护栏 - 类别未授权被拦截", async () => {
  const previous = process.env.PAYMENT_ALLOWED_CATEGORIES;
  process.env.PAYMENT_ALLOWED_CATEGORIES = "travel";
  try {
    const service = new PaymentService();
    const result = await service.createOrder({
      amount: 30,
      description: "未授权类别的测试单",
      provider: "alipay",
      method: "native",
      metadata: { category: "shopping" },
    });
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /未授权代付/);
    assert.match(result.error ?? "", /PAYMENT_ALLOWED_CATEGORIES/);
  } finally {
    if (previous === undefined) delete process.env.PAYMENT_ALLOWED_CATEGORIES;
    else process.env.PAYMENT_ALLOWED_CATEGORIES = previous;
  }
});

test("支付护栏 - 日预算累计拦截（台账只累计真实订单，第二笔触顶）", async () => {
  const previous = process.env.PAYMENT_DAILY_BUDGET_CNY;
  process.env.PAYMENT_DAILY_BUDGET_CNY = "100";
  try {
    // 台账只记真实订单（mock 单不落库）：预置一笔 60 元 live 订单代表今日已花费
    const now = new Date().toISOString();
    getPaymentOrderLedger().record({
      outTradeNo: "BUDGET-SEED-1",
      actorId: "budget-actor@test.local",
      provider: "alipay",
      method: "native",
      amount: 60,
      description: "日预算预置真实订单",
      mode: "live",
      status: "pending",
      createdAt: now,
      updatedAt: now,
      paidAt: null,
    });
    const service = new PaymentService();
    const blocked = await service.createOrder({
      amount: 60,
      description: "日预算第二笔（预置 60 + 本次 60 > 100）",
      provider: "wechat",
      method: "native",
      actorId: "budget-actor@test.local",
    });
    assert.equal(blocked.ok, false);
    assert.match(blocked.error ?? "", /日预算|当日/);
  } finally {
    if (previous === undefined) delete process.env.PAYMENT_DAILY_BUDGET_CNY;
    else process.env.PAYMENT_DAILY_BUDGET_CNY = previous;
  }
});

test("能力就绪 - 状态清单结构完整且对话核心可判就绪", () => {
  process.env.MOONSHOT_API_KEY = process.env.MOONSHOT_API_KEY ?? "test-key";
  const { configSource, capabilities } = listCapabilityStatuses();
  assert.equal(configSource, "byok");
  assert.ok(capabilities.length >= 10);
  const ids = new Set(capabilities.map((c) => c.id));
  for (const expected of ["chat_core", "travel_booking", "ride_hailing", "shopping_payment"]) {
    assert.ok(ids.has(expected), `缺少能力域 ${expected}`);
  }
  const chat = capabilities.find((c) => c.id === "chat_core")!;
  assert.equal(chat.state, "ready");
  const experimental = capabilities.filter((c) => c.experimental);
  assert.ok(experimental.length >= 2, "实验徽标应覆盖至少瑞幸/美团等实验能力");
  // 每项缺配置时必须带可执行的配置提示
  for (const c of capabilities) {
    if (c.state === "needs_config") assert.ok(c.hints.length > 0, `${c.id} 缺配置提示`);
  }
});

test("能力就绪 - platform 模式下全部就绪且来源切换", () => {
  const previous = process.env.CAPABILITY_CONFIG_MODE;
  process.env.CAPABILITY_CONFIG_MODE = "platform";
  try {
    const { configSource, capabilities } = listCapabilityStatuses();
    assert.equal(configSource, "platform");
    assert.ok(capabilities.every((c) => c.state === "ready"));
  } finally {
    if (previous === undefined) delete process.env.CAPABILITY_CONFIG_MODE;
    else process.env.CAPABILITY_CONFIG_MODE = previous;
  }
});
