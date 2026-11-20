import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";

import { registerRechargeRoutes } from "../src/routes/http/recharge.js";
import type { HttpRouteDeps } from "../src/routes/http/types.js";
import { getWebpayStore } from "../src/services/webpay/webpay-store.js";
import {
  getSiteSessionStore,
  SITE_SESSION_COOKIE,
} from "../src/services/recharge/site-session-store.js";

/**
 * 统一充值支付接口（POST /api/recharge/payments）：网页与 App 共用。
 *
 * - Bearer → App，显式 channel=app 返回支付宝客户端订单串；
 * - Cookie + CSRF → 网页，桌面 UA 返回 page 收银台表单；
 * - 手机 UA / Bearer 未指定 channel → wap 浏览器收银台。
 *
 * 只验证「身份 → 通道选择 → 下单 → 查单 → 入账」这一层，不真付款。
 */

let workDir: string;
let app: FastifyInstance;

function rawBase64Der(pem: string): string {
  return pem.split("\n").filter((line) => !line.includes("-----")).join("");
}

before(async () => {
  workDir = mkdtempSync(join(tmpdir(), "recharge-app-test-"));
  process.env.WEBPAY_LEDGER_DB = join(workDir, "orders.db");
  process.env.RECHARGE_SESSION_DB = join(workDir, "site-sessions.db");
  const pair = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKeyPem = pair.privateKey.export({ type: "pkcs1", format: "pem" }) as string;
  const publicDer = pair.publicKey.export({ type: "spki", format: "der" }) as Buffer;
  const configPath = join(workDir, ".alipay-sandbox.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      appId: "2026000000000002",
      appPrivatePkcsKey: rawBase64Der(privateKeyPem),
      alipayPublicKey: publicDer.toString("base64"),
    }),
    "utf8",
  );
  process.env.WEBPAY_SANDBOX_CONFIG = configPath;

  app = Fastify();
  registerRechargeRoutes(app, {
    accessAuthService: {
      verifyToken: (token: string) => {
        if (token === "payer-token") {
          return { userId: "payer@example.com", tokenId: "tok-payer", expiresAt: Date.now() + 60_000 };
        }
        if (token === "other-token") {
          return { userId: "other@example.com", tokenId: "tok-other", expiresAt: Date.now() + 60_000 };
        }
        return null;
      },
    },
    emailOtpService: null,
    emailSmsService: null,
  } as unknown as HttpRouteDeps);
  await app.ready();
});

after(async () => {
  await app.close();
  getWebpayStore().close();
  getSiteSessionStore().close();
  delete process.env.WEBPAY_LEDGER_DB;
  delete process.env.RECHARGE_SESSION_DB;
  delete process.env.WEBPAY_SANDBOX_CONFIG;
  rmSync(workDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

describe("统一充值支付接口", () => {
  const desktopUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36";

  function siteCookie(email: string): string {
    const token = getSiteSessionStore().create(email);
    return `${SITE_SESSION_COOKIE}=${encodeURIComponent(token)}`;
  }

  it("收银台能力：支付宝可用、微信未开通", async () => {
    const res = await app.inject({ method: "GET", url: "/api/recharge/config" });
    assert.equal(res.statusCode, 200);
    const data = res.json();
    assert.equal(data.payConfigured, true);
    assert.equal(data.providers.alipay, true);
    assert.equal(data.providers.wechat, false);
  });

  it("没有任何凭证时 401", async () => {
    const me = await app.inject({ method: "GET", url: "/api/recharge/me" });
    assert.equal(me.statusCode, 401);
    const order = await app.inject({
      method: "POST",
      url: "/api/recharge/payments",
      payload: { amount: "1" },
    });
    assert.equal(order.statusCode, 401);
  });

  it("Bearer 直接返回登录账号与余额", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/recharge/me",
      headers: { authorization: "Bearer payer-token" },
    });
    assert.equal(res.statusCode, 200);
    const data = res.json();
    assert.equal(data.ok, true);
    assert.match(data.masked, /\*\*\*/);
    assert.equal(data.balance, "0.00");
  });

  it("Bearer 未指定 channel 时默认 wap 浏览器收银台", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/recharge/payments",
      headers: { authorization: "Bearer payer-token" },
      payload: { amount: "1" },
    });
    assert.equal(res.statusCode, 200);
    const data = res.json();
    assert.ok(String(data.outTradeNo).startsWith("WP"));
    assert.equal(data.channel, "wap");
    assert.equal(data.amount, "1.00");
    assert.match(String(data.paymentUrl), /alipay\.trade\.wap\.pay/);
    assert.match(String(data.paymentUrl), /QUICK_WAP_WAY/);
  });

  it("显式 channel=app 时返回支付宝客户端订单串", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/recharge/payments",
      headers: { authorization: "Bearer payer-token" },
      payload: { amount: "1", channel: "app" },
    });
    assert.equal(res.statusCode, 200);
    const data = res.json();
    assert.equal(data.ok, true);
    assert.equal(data.channel, "app");
    assert.equal(data.paymentUrl, null);
    assert.match(String(data.orderStr), /alipay\.trade\.app\.pay/);
    assert.match(String(data.orderStr), /QUICK_MSECURITY_PAY/);
  });

  it("网页 Cookie 会话 + 桌面 UA 返回电脑收银台表单", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/recharge/payments",
      headers: {
        cookie: siteCookie("payer@example.com"),
        "x-requested-with": "nextbot-recharge",
        "user-agent": desktopUA,
      },
      payload: { amount: "1" },
    });
    assert.equal(res.statusCode, 200);
    const data = res.json();
    assert.equal(data.channel, "page");
    assert.match(String(data.paymentHtml), /alipay\.trade\.page\.pay/);
    assert.match(String(data.paymentHtml), /FAST_INSTANT_TRADE_PAY/);
  });

  it("网页 Cookie 会话缺少 CSRF 头时 403", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/recharge/payments",
      headers: {
        cookie: siteCookie("payer@example.com"),
        "user-agent": desktopUA,
      },
      payload: { amount: "1" },
    });
    assert.equal(res.statusCode, 403);
  });

  it("查单只认本人订单；支付确认后余额同步入账", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/recharge/payments",
      headers: { authorization: "Bearer payer-token" },
      payload: { amount: "5", channel: "app" },
    });
    const outTradeNo = created.json().outTradeNo as string;

    const stranger = await app.inject({
      method: "GET",
      url: `/api/recharge/payments/${outTradeNo}`,
      headers: { authorization: "Bearer other-token" },
    });
    assert.equal(stranger.statusCode, 404);

    // 模拟异步通知/查单确认支付：余额在同一事务内入账
    getWebpayStore().markPaidIdempotently(
      outTradeNo,
      "TRADE-APP-1",
      "buyer@example.com",
      new Date().toISOString(),
    );

    const queried = await app.inject({
      method: "GET",
      url: `/api/recharge/payments/${outTradeNo}`,
      headers: { authorization: "Bearer payer-token" },
    });
    assert.equal(queried.statusCode, 200);
    const data = queried.json();
    assert.equal(data.status, "paid");
    assert.equal(data.amount, "5.00");
    assert.equal(data.balance, "5.00");
  });

  it("金额非法时拒绝下单", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/recharge/payments",
      headers: { authorization: "Bearer payer-token" },
      payload: { amount: "0" },
    });
    assert.equal(res.statusCode, 400);
  });
});
