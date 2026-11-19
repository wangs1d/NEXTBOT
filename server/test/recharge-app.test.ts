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

/**
 * App 内额度充值接口（/api/recharge/app/*）：Bearer 登录态直连，
 * 不再走官网 Cookie 会话与邮箱验证码；支付仍复用支付宝 wap 收银台。
 *
 * 只验证「身份 → 下单 → 查单 → 入账」这一层，不真付款（付款必须由用户在支付宝完成）。
 */

let workDir: string;
let app: FastifyInstance;

function rawBase64Der(pem: string): string {
  return pem.split("\n").filter((line) => !line.includes("-----")).join("");
}

before(async () => {
  workDir = mkdtempSync(join(tmpdir(), "recharge-app-test-"));
  process.env.WEBPAY_LEDGER_DB = join(workDir, "orders.db");
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
  delete process.env.WEBPAY_LEDGER_DB;
  delete process.env.WEBPAY_SANDBOX_CONFIG;
  rmSync(workDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

describe("App 内额度充值", () => {
  it("无 Bearer 凭证一律 401", async () => {
    const me = await app.inject({ method: "GET", url: "/api/recharge/app/me" });
    assert.equal(me.statusCode, 401);
    const order = await app.inject({
      method: "POST",
      url: "/api/recharge/app/orders",
      payload: { amount: "1" },
    });
    assert.equal(order.statusCode, 401);
  });

  it("Bearer 直接返回登录账号与余额，不再要求邮箱验证码", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/recharge/app/me",
      headers: { authorization: "Bearer payer-token" },
    });
    assert.equal(res.statusCode, 200);
    const data = res.json();
    assert.equal(data.ok, true);
    assert.match(data.masked, /\*\*\*/);
    assert.equal(data.balance, "0.00");
  });

  it("下单返回支付宝手机收银台地址并落本地订单", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/recharge/app/orders",
      headers: { authorization: "Bearer payer-token" },
      payload: { amount: "1" },
    });
    assert.equal(res.statusCode, 200);
    const data = res.json();
    assert.equal(data.ok, true);
    assert.ok(String(data.outTradeNo).startsWith("WP"));
    assert.equal(data.amount, "1.00");
    assert.match(String(data.paymentUrl), /alipay\.trade\.wap\.pay/);
    assert.match(String(data.paymentUrl), /QUICK_WAP_WAY/);
  });

  it("查单只认本人订单；支付确认后余额同步入账", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/recharge/app/orders",
      headers: { authorization: "Bearer payer-token" },
      payload: { amount: "5" },
    });
    const outTradeNo = created.json().outTradeNo as string;

    const stranger = await app.inject({
      method: "GET",
      url: `/api/recharge/app/orders/${outTradeNo}`,
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
      url: `/api/recharge/app/orders/${outTradeNo}`,
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
      url: "/api/recharge/app/orders",
      headers: { authorization: "Bearer payer-token" },
      payload: { amount: "0" },
    });
    assert.equal(res.statusCode, 400);
  });
});
