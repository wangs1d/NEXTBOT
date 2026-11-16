import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PaymentAuthorizationService } from "../src/payments/authorization-service.js";
import { ChannelRegistry } from "../src/payments/channels/index.js";
import { MockChannel } from "../src/payments/channels/mock.js";
import { UnifiedPaymentStore } from "../src/payments/store.js";
import { UnifiedPaymentService } from "../src/payments/unified-payment-service.js";
import type { PaymentChannelId } from "../src/payments/types.js";

/**
 * 统一支付模块单测：授权闸门、额度、幂等、确认令牌、状态机、退款。
 *
 * 全链路只用 mock 渠道（不触网、不碰真实资金），但走的是与生产完全相同的
 * 门面/授权/台账路径——这正是「支付闭环」最需要被钉死的部分：
 * 没有授权不能付、超限不能付、额度内也要按免确认阈值决定是否再问一遍。
 */

let workDir: string;
let seq = 0;
const stores: UnifiedPaymentStore[] = [];

function makeDbPath(): string {
  seq += 1;
  return join(workDir, `unified-${seq}.db`);
}

function makeService(overrides?: {
  mock?: MockChannel;
  channels?: ChannelRegistry;
  baseUrl?: string;
}): { service: UnifiedPaymentService; store: UnifiedPaymentStore; auth: PaymentAuthorizationService } {
  const store = new UnifiedPaymentStore(makeDbPath());
  stores.push(store);
  const auth = new PaymentAuthorizationService(store);
  const channels = overrides?.channels ?? new ChannelRegistry([overrides?.mock ?? new MockChannel()]);
  const service = new UnifiedPaymentService({
    store,
    authorizations: auth,
    channels,
    baseUrl: () => overrides?.baseUrl ?? "http://127.0.0.1:3999",
  });
  return { service, store, auth };
}

function grant(
  service: UnifiedPaymentService,
  params: {
    actorId: string;
    channel?: PaymentChannelId;
    perTxCny?: number;
    dailyCny?: number;
    monthlyCny?: number;
    autoApproveCny?: number;
    categories?: string[];
  },
): string {
  const result = service.createAuthorization({
    actorId: params.actorId,
    channel: params.channel ?? "mock",
    accepted: true,
    limits: {
      perTxCny: params.perTxCny ?? 500,
      dailyCny: params.dailyCny ?? 1000,
      monthlyCny: params.monthlyCny ?? 5000,
      autoApproveCny: params.autoApproveCny ?? 0,
    },
    categories: params.categories ?? ["*"],
    source: "test",
  });
  assert.equal(result.ok, true, result.error);
  return String((result.authorization as { id: string }).id);
}

before(() => {
  workDir = mkdtempSync(join(tmpdir(), "nextbot-unified-pay-"));
  process.env.PAYMENT_MOCK_ENABLED = "1";
  // 全局护栏放到足够宽，避免用例被默认单笔 1000 元拦截（护栏另有专门用例）
  process.env.PAYMENT_MAX_SINGLE_CNY = "100000";
  process.env.PAYMENT_DAILY_BUDGET_CNY = "0";
  process.env.PAYMENT_ALLOWED_CATEGORIES = "*";
});

beforeEach(() => {
  process.env.PAYMENT_MAX_SINGLE_CNY = "100000";
  process.env.PAYMENT_DAILY_BUDGET_CNY = "0";
  process.env.PAYMENT_ALLOWED_CATEGORIES = "*";
});

after(() => {
  // 先关库再删目录：WAL 句柄没释放时 Windows 会 EBUSY
  for (const store of stores) store.close();
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* 临时目录清理失败不影响用例结论 */
  }
});

describe("统一支付：授权闸门", () => {
  it("没有授权时不下单，返回授权页地址", async () => {
    const { service } = makeService();
    const result = await service.createIntent({
      actorId: "u_no_auth",
      amount: 12.5,
      subject: "买杯咖啡",
      bizDomain: "dining",
    });
    assert.equal(result.ok, false);
    assert.equal(result.nextAction, "authorize");
    assert.equal(result.intent?.status, "requires_authorization");
    assert.match(String(result.authorizationUrl), /\/payment\/authorize\?/);
    assert.match(String(result.authorizationUrl), /actorId=u_no_auth/);
    assert.equal(result.intent?.payUrl, null);
  });

  it("授权后同一意图可继续（resume），不再要求重新下单", async () => {
    const { service } = makeService();
    const created = await service.createIntent({
      actorId: "u_resume",
      amount: 20,
      subject: "打车",
      bizDomain: "ride",
      idempotencyKey: "ride-1",
    });
    assert.equal(created.nextAction, "authorize");

    grant(service, { actorId: "u_resume", autoApproveCny: 0 });
    const resumed = await service.resumeIntent(String(created.intent?.id), "u_resume");
    assert.equal(resumed.nextAction, "confirm");
    assert.equal(resumed.intent?.status, "requires_confirm");
    assert.ok(resumed.confirmToken);
  });

  it("撤销授权后不再放行新支付", async () => {
    const { service } = makeService();
    const authId = grant(service, { actorId: "u_revoke" });
    assert.equal(service.revokeAuthorization(authId, "u_revoke"), true);
    const result = await service.createIntent({
      actorId: "u_revoke",
      amount: 9.9,
      subject: "寄件",
      bizDomain: "express",
    });
    assert.equal(result.nextAction, "authorize");
  });

  it("授权必须由用户明确同意（accepted=false 直接拒绝）", () => {
    const { service } = makeService();
    const result = service.createAuthorization({
      actorId: "u_consent",
      channel: "mock",
      accepted: false,
    });
    assert.equal(result.ok, false);
    assert.match(String(result.error), /同意/);
  });
});

describe("统一支付：额度与类别", () => {
  it("超过单笔上限即拦截，且不产生渠道单", async () => {
    const { service } = makeService();
    grant(service, { actorId: "u_tx", perTxCny: 50, dailyCny: 500, monthlyCny: 500 });
    const result = await service.createIntent({
      actorId: "u_tx",
      amount: 80,
      subject: "买书",
      bizDomain: "shopping",
    });
    assert.equal(result.nextAction, "blocked");
    assert.equal(result.intent?.status, "blocked");
    assert.match(String(result.intent?.failureReason), /超出授权上限/);
  });

  it("pending 单也占用日额度，防止连开多单绕过", async () => {
    const { service } = makeService();
    grant(service, { actorId: "u_day", perTxCny: 100, dailyCny: 100, monthlyCny: 1000, autoApproveCny: 100 });

    const first = await service.createIntent({
      actorId: "u_day",
      amount: 60,
      subject: "第一单",
      bizDomain: "delivery",
    });
    assert.equal(first.nextAction, "pay");

    const second = await service.createIntent({
      actorId: "u_day",
      amount: 60,
      subject: "第二单",
      bizDomain: "delivery",
    });
    assert.equal(second.nextAction, "blocked");
    assert.match(String(second.intent?.failureReason), /今日已用/);
  });

  it("类别不在授权范围内则拦截", async () => {
    const { service } = makeService();
    grant(service, { actorId: "u_cat", categories: ["travel"], autoApproveCny: 100 });
    const result = await service.createIntent({
      actorId: "u_cat",
      amount: 30,
      subject: "网购",
      bizDomain: "shopping",
    });
    assert.equal(result.nextAction, "blocked");
    assert.match(String(result.intent?.failureReason), /未覆盖/);
  });

  it("管理员全局护栏仍然生效（单笔上限）", async () => {
    process.env.PAYMENT_MAX_SINGLE_CNY = "50";
    const { service } = makeService();
    grant(service, { actorId: "u_guard", perTxCny: 1000, autoApproveCny: 1000 });
    const result = await service.createIntent({
      actorId: "u_guard",
      amount: 80,
      subject: "超额消费",
      bizDomain: "shopping",
    });
    assert.equal(result.nextAction, "blocked");
    assert.match(String(result.intent?.failureReason), /支付护栏/);
  });
});

describe("统一支付：免确认额度与确认令牌", () => {
  it("额度内（≤ 免确认）直接出收款单", async () => {
    const { service } = makeService();
    grant(service, { actorId: "u_auto", autoApproveCny: 20 });
    const result = await service.createIntent({
      actorId: "u_auto",
      amount: 20,
      subject: "咖啡",
      bizDomain: "dining",
    });
    assert.equal(result.nextAction, "pay");
    assert.equal(result.intent?.status, "pending");
    assert.ok(result.intent?.payUrl);
    assert.equal(result.confirmToken, undefined);
  });

  it("超免确认额度必须确认，令牌错误/过期不放行", async () => {
    const { service, store } = makeService();
    grant(service, { actorId: "u_confirm", autoApproveCny: 10 });
    const created = await service.createIntent({
      actorId: "u_confirm",
      amount: 90,
      subject: "订酒店",
      bizDomain: "travel",
    });
    assert.equal(created.nextAction, "confirm");
    const intentId = String(created.intent?.id);
    // 付款页地址带确认令牌：用户在这一页选付款方式、点「确认付款」
    assert.match(String(created.payPageUrl), /\/payment\/pay\?/);
    assert.match(String(created.payPageUrl), /t=/);

    const wrong = await service.confirmIntent({ intentId, actorId: "u_confirm", confirmToken: "deadbeef" });
    assert.equal(wrong.ok, false);
    assert.match(String(wrong.error), /令牌无效/);

    // 人为把确认有效期推到过去：过期令牌同样不放行
    store.updateIntent(intentId, {
      confirm_expires_at: new Date(Date.now() - 1_000).toISOString(),
    });
    const expired = await service.confirmIntent({
      intentId,
      actorId: "u_confirm",
      confirmToken: String(created.confirmToken),
    });
    assert.equal(expired.ok, false);
    assert.match(String(expired.error), /确认已过期/);
  });

  it("确认前撤销授权：确认令牌不能绕过撤销", async () => {
    const { service } = makeService();
    const authId = grant(service, { actorId: "u_revoke_confirm", autoApproveCny: 0 });
    const created = await service.createIntent({
      actorId: "u_revoke_confirm",
      amount: 40,
      subject: "撤销后确认",
      bizDomain: "shopping",
    });
    assert.equal(created.nextAction, "confirm");
    assert.equal(service.revokeAuthorization(authId, "u_revoke_confirm"), true);

    const result = await service.confirmIntent({
      intentId: String(created.intent?.id),
      actorId: "u_revoke_confirm",
      confirmToken: String(created.confirmToken),
    });
    assert.equal(result.nextAction, "authorize");
    assert.equal(result.intent?.status, "requires_authorization");
  });

  it("付款页：没有确认令牌不解锁扣款，带令牌才出码", async () => {
    const { service } = makeService();
    grant(service, { actorId: "u_paypage", autoApproveCny: 0 });
    const created = await service.createIntent({
      actorId: "u_paypage",
      amount: 15,
      subject: "付款页",
      bizDomain: "other",
    });
    const intentId = String(created.intent?.id);

    const noToken = await service.payIntent({ intentId, actorId: "u_paypage" });
    assert.equal(noToken.nextAction, "confirm");
    assert.match(String(noToken.error), /确认令牌/);

    const paid = await service.payIntent({
      intentId,
      actorId: "u_paypage",
      confirmToken: String(created.confirmToken),
    });
    assert.equal(paid.nextAction, "pay");
    assert.equal(paid.intent?.status, "pending");
  });

  it("确认后进入 pending（已出收款单）", async () => {
    const { service } = makeService();
    grant(service, { actorId: "u_confirm_ok", autoApproveCny: 10 });
    const created = await service.createIntent({
      actorId: "u_confirm_ok",
      amount: 90,
      subject: "订酒店",
      bizDomain: "travel",
    });
    const ok = await service.confirmIntent({
      intentId: String(created.intent?.id),
      actorId: "u_confirm_ok",
      confirmToken: String(created.confirmToken),
    });
    assert.equal(ok.ok, true, ok.error);
    assert.equal(ok.intent?.status, "pending");
    assert.notEqual(ok.intent?.payUrl, null);
  });

  it("确认令牌一次性：已执行后再次确认被拒", async () => {
    const { service } = makeService();
    grant(service, { actorId: "u_once", autoApproveCny: 0 });
    const created = await service.createIntent({
      actorId: "u_once",
      amount: 5,
      subject: "小额",
      bizDomain: "other",
    });
    const token = String(created.confirmToken);
    const intentId = String(created.intent?.id);
    const first = await service.confirmIntent({ intentId, actorId: "u_once", confirmToken: token });
    assert.equal(first.ok, true);
    const second = await service.confirmIntent({ intentId, actorId: "u_once", confirmToken: token });
    assert.equal(second.ok, false);
    assert.match(String(second.error), /不需要确认/);
  });
});

describe("统一支付：幂等 / 状态机 / 退款", () => {
  it("同一幂等键同金额复用同一意图；金额不同直接拒绝", async () => {
    const { service } = makeService();
    grant(service, { actorId: "u_idem", autoApproveCny: 100 });
    const a = await service.createIntent({
      actorId: "u_idem",
      amount: 30,
      subject: "跑腿",
      bizDomain: "delivery",
      idempotencyKey: "delivery-001",
    });
    const b = await service.createIntent({
      actorId: "u_idem",
      amount: 30,
      subject: "跑腿",
      bizDomain: "delivery",
      idempotencyKey: "delivery-001",
    });
    assert.equal(a.intent?.id, b.intent?.id);

    const c = await service.createIntent({
      actorId: "u_idem",
      amount: 31,
      subject: "跑腿",
      bizDomain: "delivery",
      idempotencyKey: "delivery-001",
    });
    assert.equal(c.ok, false);
    assert.match(String(c.error), /金额不一致/);
  });

  it("mock 渠道：查询不产生假成功，标记支付后才算 paid", async () => {
    const { service } = makeService();
    grant(service, { actorId: "u_state", autoApproveCny: 100 });
    const created = await service.createIntent({
      actorId: "u_state",
      amount: 18,
      subject: "洗衣",
      bizDomain: "service",
    });
    const intentId = String(created.intent?.id);
    const before = await service.queryIntent(intentId, "u_state");
    assert.equal(before.nextAction, "pay");
    assert.equal(before.intent?.status, "pending");

    const paid = service.mockMarkPaid(intentId);
    assert.equal(paid.nextAction, "paid");
    assert.equal(paid.intent?.status, "paid");
    assert.ok(paid.intent?.paidAt);

    const again = service.mockMarkPaid(intentId);
    assert.equal(again.intent?.status, "paid");
  });

  it("退款：部分退、全额退、超额拒绝", async () => {
    const { service } = makeService();
    grant(service, { actorId: "u_refund", autoApproveCny: 100 });
    const created = await service.createIntent({
      actorId: "u_refund",
      amount: 60,
      subject: "预约保洁",
      bizDomain: "service",
    });
    const intentId = String(created.intent?.id);
    service.mockMarkPaid(intentId);

    const over = await service.refundIntent({ intentId, actorId: "u_refund", amount: 80 });
    assert.equal(over.ok, false);

    const part = await service.refundIntent({ intentId, actorId: "u_refund", amount: 20 });
    assert.equal(part.ok, true);
    assert.equal(part.refundedAmount, 20);
    assert.equal(part.status, "partial_refunded");

    const rest = await service.refundIntent({ intentId, actorId: "u_refund" });
    assert.equal(rest.ok, true);
    assert.equal(rest.refundedAmount, 60);
    assert.equal(rest.status, "refunded");
    assert.equal(rest.intent?.status, "refunded");
  });

  it("未支付订单不可退款", async () => {
    const { service } = makeService();
    grant(service, { actorId: "u_unpaid", autoApproveCny: 100 });
    const created = await service.createIntent({
      actorId: "u_unpaid",
      amount: 10,
      subject: "话费",
      bizDomain: "utility",
    });
    const result = await service.refundIntent({
      intentId: String(created.intent?.id),
      actorId: "u_unpaid",
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, "not_paid");
  });

  it("跨用户不可见：别人的意图查不到、确认不了", async () => {
    const { service } = makeService();
    grant(service, { actorId: "u_owner", autoApproveCny: 0 });
    const created = await service.createIntent({
      actorId: "u_owner",
      amount: 12,
      subject: "午餐",
      bizDomain: "dining",
    });
    const intentId = String(created.intent?.id);
    const peek = await service.queryIntent(intentId, "u_other");
    assert.equal(peek.ok, false);
    assert.equal(service.getIntentView(intentId, "u_other"), null);
  });
});

describe("统一支付：金额与渠道校验", () => {
  it("非法金额（0、负数、三位小数）直接拒绝且不落库", async () => {
    const { service } = makeService();
    grant(service, { actorId: "u_amount" });
    for (const amount of [0, -1, 1.234]) {
      const result = await service.createIntent({
        actorId: "u_amount",
        amount,
        subject: "测试",
        bizDomain: "other",
      });
      assert.equal(result.ok, false);
      assert.equal(result.intent, null);
      assert.match(String(result.error), /金额非法/);
    }
  });

  it("指定不可用渠道时如实报错，不静默降级到 mock", async () => {
    const { service } = makeService();
    grant(service, { actorId: "u_channel" });
    const result = await service.createIntent({
      actorId: "u_channel",
      amount: 10,
      subject: "测试",
      channel: "wechat",
    });
    assert.equal(result.ok, false);
    assert.match(String(result.error), /不可用|未知支付渠道/);
  });

  it("代付场景没有可用代付渠道时明确报错（不静默降级为 mock 收款）", async () => {
    const { service } = makeService();
    grant(service, { actorId: "u_cashier", autoApproveCny: 100 });
    const result = await service.createIntent({
      actorId: "u_cashier",
      amount: 88,
      subject: "商家收银台代付",
      bizDomain: "travel",
      cashierUrl: "https://cashier.alipay.com/standard/xxx",
    });
    assert.equal(result.ok, false);
    assert.match(String(result.error), /没有可用的代付渠道|代付/);
  });

  it("没有可用渠道时报错并列出原因", async () => {
    const { service } = makeService({ channels: new ChannelRegistry([]) });
    const result = await service.createIntent({
      actorId: "u_no_channel",
      amount: 10,
      subject: "测试",
    });
    assert.equal(result.ok, false);
    assert.match(String(result.error), /没有可用的收款渠道/);
  });
});
