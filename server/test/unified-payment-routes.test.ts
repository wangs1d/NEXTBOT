import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";

import { PaymentAuthorizationService } from "../src/payments/authorization-service.js";
import { ChannelRegistry } from "../src/payments/channels/index.js";
import { MockChannel } from "../src/payments/channels/mock.js";
import { UnifiedPaymentStore } from "../src/payments/store.js";
import {
  UnifiedPaymentService,
  setUnifiedPaymentService,
} from "../src/payments/unified-payment-service.js";
import { registerUnifiedPaymentRoutes } from "../src/routes/http/payment-unified.js";

/**
 * 统一支付 HTTP 面：授权页可打开、授权可创建/撤销、意图可下单/查询/完付。
 * 用 Fastify inject 走真实路由（不监听端口），验证装配与响应形状。
 */

let app: FastifyInstance;
let store: UnifiedPaymentStore;
let workDir: string;

before(async () => {
  workDir = mkdtempSync(join(tmpdir(), "nextbot-unified-routes-"));
  process.env.PAYMENT_MOCK_ENABLED = "1";
  process.env.PAYMENT_MAX_SINGLE_CNY = "100000";
  process.env.PAYMENT_DAILY_BUDGET_CNY = "0";
  process.env.PAYMENT_ALLOWED_CATEGORIES = "*";

  store = new UnifiedPaymentStore(join(workDir, "routes.db"));
  const service = new UnifiedPaymentService({
    store,
    authorizations: new PaymentAuthorizationService(store),
    channels: new ChannelRegistry([new MockChannel()]),
    baseUrl: () => "http://127.0.0.1:3998",
  });
  setUnifiedPaymentService(service);

  app = Fastify();
  registerUnifiedPaymentRoutes(app);
  await app.ready();
});

after(async () => {
  await app.close();
  setUnifiedPaymentService(null);
  store.close();
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* Windows 上 WAL 句柄释放有延迟，清不掉不影响结论 */
  }
});

describe("统一支付路由", () => {
  it("授权页可直接打开（品牌化 HTML）", async () => {
    const res = await app.inject({ method: "GET", url: "/payment/authorize?actorId=u_route&channel=mock" });
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers["content-type"]), /text\/html/);
    assert.match(res.body, /支付授权/);
    assert.match(res.body, /NEXTBOT/);
  });

  it("渠道诊断接口返回 mock 可用", async () => {
    const res = await app.inject({ method: "GET", url: "/api/payment/channels" });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { ok: boolean; channels: Array<{ channel: string; available: boolean }> };
    assert.equal(body.ok, true);
    const mock = body.channels.find((c) => c.channel === "mock");
    assert.ok(mock);
    assert.equal(mock?.available, true);
  });

  it("创建授权 → 下单 → 查询 → 模拟完付 全链路", async () => {
    const authRes = await app.inject({
      method: "POST",
      url: "/api/payment/authorizations",
      payload: {
        userId: "u_route",
        channel: "mock",
        accepted: true,
        perTxCny: 100,
        dailyCny: 200,
        monthlyCny: 500,
        autoApproveCny: 100,
        categories: ["*"],
      },
    });
    assert.equal(authRes.statusCode, 200, authRes.body);
    const authBody = authRes.json() as { ok: boolean; authorization: { id: string; status: string } };
    assert.equal(authBody.ok, true);
    assert.equal(authBody.authorization.status, "active");

    const payRes = await app.inject({
      method: "POST",
      url: "/api/payment/intents",
      payload: { userId: "u_route", amount: 30, subject: "路由联调", bizDomain: "other" },
    });
    assert.equal(payRes.statusCode, 200, payRes.body);
    const payBody = payRes.json() as {
      ok: boolean;
      nextAction: string;
      intent: { id: string; status: string; mode: string };
    };
    assert.equal(payBody.nextAction, "pay");
    assert.equal(payBody.intent.status, "pending");
    assert.equal(payBody.intent.mode, "mock");

    const queryRes = await app.inject({
      method: "GET",
      url: `/api/payment/intents/${payBody.intent.id}?userId=u_route&sync=0`,
    });
    assert.equal(queryRes.statusCode, 200);

    const doneRes = await app.inject({
      method: "POST",
      url: `/api/payment/intents/${payBody.intent.id}/mock-pay`,
    });
    assert.equal(doneRes.statusCode, 200, doneRes.body);
    const doneBody = doneRes.json() as { nextAction: string; intent: { status: string } };
    assert.equal(doneBody.nextAction, "paid");
    assert.equal(doneBody.intent.status, "paid");

    const refundRes = await app.inject({
      method: "POST",
      url: `/api/payment/intents/${payBody.intent.id}/refund`,
      payload: { userId: "u_route", amount: 10, reason: "测试部分退款" },
    });
    assert.equal(refundRes.statusCode, 200, refundRes.body);
    const refundBody = refundRes.json() as { ok: boolean; refundedAmount: number };
    assert.equal(refundBody.ok, true);
    assert.equal(refundBody.refundedAmount, 10);
  });

  it("撤销授权后下单回到 requires_authorization", async () => {
    const list = await app.inject({ method: "GET", url: "/api/payment/authorizations?userId=u_revoke_route" });
    assert.equal(list.statusCode, 200);

    const created = await app.inject({
      method: "POST",
      url: "/api/payment/authorizations",
      payload: {
        userId: "u_revoke_route",
        channel: "mock",
        accepted: true,
        perTxCny: 50,
        dailyCny: 100,
        monthlyCny: 100,
        autoApproveCny: 10,
      },
    });
    const id = (created.json() as { authorization: { id: string } }).authorization.id;

    const revoked = await app.inject({
      method: "DELETE",
      url: `/api/payment/authorizations/${id}?userId=u_revoke_route`,
    });
    assert.equal(revoked.statusCode, 200);

    const payRes = await app.inject({
      method: "POST",
      url: "/api/payment/intents",
      payload: { userId: "u_revoke_route", amount: 20, subject: "撤销后支付" },
    });
    const body = payRes.json() as { nextAction: string };
    assert.equal(body.nextAction, "authorize");
  });

  it("收银台页只回显渠道落库的表单，不存在则 404", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/payment/intents",
      payload: { userId: "u_checkout", amount: 0.01, subject: "收银台" },
    });
    // 该用户未授权，先授权再下单
    await app.inject({
      method: "POST",
      url: "/api/payment/authorizations",
      payload: {
        userId: "u_checkout",
        channel: "mock",
        accepted: true,
        perTxCny: 10,
        dailyCny: 10,
        monthlyCny: 10,
        autoApproveCny: 10,
      },
    });
    const paid = await app.inject({
      method: "POST",
      url: "/api/payment/intents",
      payload: { userId: "u_checkout", amount: 0.01, subject: "收银台" },
    });
    const intentId = (paid.json() as { intent: { id: string } }).intent.id;
    // mock 渠道不产出表单：此时应 404（不能凭空造一个收银台）
    const missing = await app.inject({ method: "GET", url: `/payment/intent/${intentId}/checkout` });
    assert.equal(missing.statusCode, 404);

    // 模拟支付宝网页收款渠道把签名表单落库后的读回
    store.updateIntent(intentId, { payment_html: "<html><body>alipay-form-marker</body></html>" });
    const ok = await app.inject({ method: "GET", url: `/payment/intent/${intentId}/checkout` });
    assert.equal(ok.statusCode, 200);
    assert.match(ok.body, /alipay-form-marker/);
    assert.equal(created.statusCode, 200);
  });

  it("付款页可打开（金额确认 + 付款方式 + 确认付款按钮）", async () => {
    const res = await app.inject({ method: "GET", url: "/payment/pay?intentId=pi_x&actorId=u_page" });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /确认付款/);
    assert.match(res.body, /付款方式/);
    assert.match(res.body, /NEXTBOT/);
  });

  it("付款页接口：prepare 发新令牌，pay 带令牌后进入待付", async () => {
    await app.inject({
      method: "POST",
      url: "/api/payment/authorizations",
      payload: {
        userId: "u_page",
        channel: "mock",
        accepted: true,
        perTxCny: 100,
        dailyCny: 100,
        monthlyCny: 100,
        autoApproveCny: 0,
      },
    });
    const created = await app.inject({
      method: "POST",
      url: "/api/payment/intents",
      payload: { userId: "u_page", amount: 25, subject: "付款页联调" },
    });
    const intent = (created.json() as { intent: { id: string } }).intent;

    // 不带令牌直接付款 → 拒绝，并提示回付款页确认（不能靠接口裸调扣款）
    const noToken = await app.inject({
      method: "POST",
      url: `/api/payment/intents/${intent.id}/pay`,
      payload: { userId: "u_page" },
    });
    const noTokenBody = noToken.json() as { nextAction: string; error?: string };
    assert.equal(noTokenBody.nextAction, "confirm");
    assert.match(String(noTokenBody.error), /确认令牌/);

    // prepare 取新令牌
    const prepared = await app.inject({
      method: "POST",
      url: `/api/payment/intents/${intent.id}/prepare`,
      payload: { userId: "u_page" },
    });
    const token = (prepared.json() as { confirmToken: string }).confirmToken;
    assert.ok(token);

    // 带令牌 + 选定付款方式 → 进入待付（出码）
    const paid = await app.inject({
      method: "POST",
      url: `/api/payment/intents/${intent.id}/pay`,
      payload: { userId: "u_page", confirmToken: token, channel: "mock" },
    });
    const body = paid.json() as { nextAction: string; intent: { status: string } };
    assert.equal(body.nextAction, "pay");
    assert.equal(body.intent.status, "pending");
  });

  it("付款页换付款方式时按新渠道重新判授权，不沿用旧授权", async () => {
    await app.inject({
      method: "POST",
      url: "/api/payment/authorizations",
      payload: {
        userId: "u_switch",
        channel: "mock",
        accepted: true,
        perTxCny: 100,
        dailyCny: 100,
        monthlyCny: 100,
        autoApproveCny: 100,
      },
    });
    const created = await app.inject({
      method: "POST",
      url: "/api/payment/intents",
      payload: { userId: "u_switch", amount: 10, subject: "切渠道" },
    });
    const intent = (created.json() as { intent: { id: string } }).intent;
    const res = await app.inject({
      method: "POST",
      url: `/api/payment/intents/${intent.id}/pay`,
      payload: { userId: "u_switch", channel: "alipay_qr", confirmToken: "x" },
    });
    const body = res.json() as { nextAction: string };
    // 本机没配支付宝凭证 → error；配了 → authorize（新渠道无授权）。都不允许静默扣款
    assert.ok(["error", "authorize"].includes(body.nextAction), JSON.stringify(body));
  });

  it("未同意授权时拒绝创建（accepted 必须为 true）", async () => {    const res = await app.inject({
      method: "POST",
      url: "/api/payment/authorizations",
      payload: { userId: "u_no_consent", channel: "mock", accepted: false },
    });
    assert.equal(res.statusCode, 400);
  });
});
