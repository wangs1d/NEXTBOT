import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { serverRoot } from "../../config/paths.js";
import { loadWebpayConfig } from "../../config/webpay-config.js";
import { WebpayNotConfiguredError, getWebpayService } from "../../services/webpay/webpay-service.js";
import { getWebpayStore } from "../../services/webpay/webpay-store.js";
import { centsToAmount, parseAmountToCents } from "../../services/webpay/webpay-amount.js";
import {
  getSiteSessionStore,
  hashSiteSessionToken,
  readSiteSessionToken,
  SITE_SESSION_COOKIE,
  SITE_SESSION_MAX_AGE_SECONDS,
} from "../../services/recharge/site-session-store.js";
import { getApiTokenStore } from "../../services/recharge/api-token-store.js";
import { readApiPrices, resolveApiGatewayConfig } from "../../services/recharge/api-billing.js";
import { AccessAuthService } from "../../services/access-auth-service.js";
import { isEmailOtpEnforced } from "./accounts.js";
import type { HttpRouteDeps } from "./types.js";

/**
 * 官网额度充值：金额直接计入当前登录账号（邮箱），接口调用同账号授权。
 *
 * - /recharge              充值页（未登录时页内完成邮箱 OTP 登录）
 * - /recharge/success      支付回跳结果页（状态以服务端查单为准）
 * - /recharge/pricing      计费方式
 * - /recharge/return       支付宝同步回跳 → 转结果页（回跳参数不判成功）
 * - /api/recharge/*        配置/会话/下单/查单/余额/流水
 *
 * 到账只发生在验签通知或主动查单确认 paid 时，入账与订单状态同事务。
 */

const pageRoot = join(serverRoot(), "public", "recharge");
const CSRF_HEADER = "x-requested-with";
const CSRF_HEADER_VALUE = "nextbot-recharge";

/** 充值金额区间：1 元 ~ 100000 元（与页面胶囊 + 自定义输入口径一致） */
const MIN_CENTS = 100n;
const MAX_CENTS = 10_000_000n;

function servePage(name: string): string | null {
  const file = join(pageRoot, name);
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}

function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) return "***";
  const local = email.slice(0, at);
  const head = local.length > 5 ? local.slice(0, 5) : local.slice(0, 1);
  return `${head}***${email.slice(at)}`;
}

function resolveSessionEmail(req: FastifyRequest): string | null {
  const token = readSiteSessionToken(req.headers.cookie);
  if (!token) return null;
  return getSiteSessionStore().resolve(hashSiteSessionToken(token));
}

function sessionCookie(req: FastifyRequest, token: string): string {
  const secure = req.protocol === "https" ? "; Secure" : "";
  return `${SITE_SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=${SITE_SESSION_MAX_AGE_SECONDS}`;
}

function hasCsrfHeader(req: FastifyRequest): boolean {
  return String(req.headers[CSRF_HEADER] ?? "") === CSRF_HEADER_VALUE;
}

function orderStatusText(state: string): "paid" | "pending" | "closed" {
  if (state === "PAID") return "paid";
  if (state === "CLOSED") return "closed";
  return "pending";
}

function maskFor(email: string): { email: string; masked: string } {
  return { email, masked: maskEmail(email) };
}

/**
 * 手机浏览器必须走手机网站支付（alipay.trade.wap.pay）。
 * 电脑收银台（page.pay）在手机浏览器里付不了款（只出二维码/提示换电脑）。
 */
function isMobileClient(req: FastifyRequest): boolean {
  return /android|iphone|ipad|ipod|mobile|windows phone|harmonyos/i.test(
    String(req.headers["user-agent"] ?? ""),
  );
}

/**
 * App 内购额度用的身份：Bearer access token（登录时签发，无需再做邮箱验证码）。
 *
 * 与官网充值页的 Cookie 会话相互独立，但记账主体同为登录邮箱；token 的
 * userId 不是邮箱形态时一律拒绝（额度只能记到邮箱账号）。
 */
function resolveBearerEmail(req: FastifyRequest, deps: HttpRouteDeps): string | null {
  const service = deps.accessAuthService;
  if (!service) return null;
  const raw = req.headers.authorization;
  const authorization = Array.isArray(raw) ? String(raw[0] ?? "") : String(raw ?? "");
  const token = AccessAuthService.extractToken({ authorization });
  if (!token) return null;
  const verified = service.verifyToken(token);
  if (!verified) return null;
  const email = verified.userId.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

export function registerRechargeRoutes(app: FastifyInstance, deps: HttpRouteDeps): void {
  const otpEnabled = isEmailOtpEnforced(deps);
  const otpService = deps.emailOtpService ?? null;
  const mailService = deps.emailSmsService ?? null;

  function page(name: string) {
    const html = servePage(name);
    if (!html) return { status: 500, body: `${name} missing` };
    return { status: 200, body: html };
  }

  /**
   * 本人订单快照：pending 时主动向网关查单收敛；非本人订单返回 null（对外按不存在）。
   * 官网 Cookie 会话与 App Bearer 会话共用这一套状态口径。
   */
  async function orderSnapshot(outTradeNo: string, email: string) {
    const store = getWebpayStore();
    const order = store.getOrder(outTradeNo);
    if (!order || order.accountId !== email) return null;
    let state = order.status === "paid" ? "PAID" : order.status === "closed" ? "CLOSED" : "PENDING_PAYMENT";
    if (order.status === "pending") {
      try {
        const queried = await getWebpayService().queryOrder(outTradeNo);
        if (queried) state = queried.businessState;
      } catch (err) {
        if (!(err instanceof WebpayNotConfiguredError)) {
          console.error("[recharge] query order failed:", outTradeNo, err instanceof Error ? err.message : err);
        }
      }
    }
    const latest = store.getOrder(outTradeNo) ?? order;
    return {
      outTradeNo,
      amount: latest.totalAmount,
      status: orderStatusText(state),
      paidAt: latest.paidAt,
      masked: maskEmail(email),
      balance: centsToAmount(BigInt(store.getRechargeBalanceCents(email))),
    };
  }

  app.get("/recharge", async (_req, reply) => {
    const p = page("recharge.html");
    reply.header("Cache-Control", "no-store");
    return reply.code(p.status).type("text/html; charset=utf-8").send(p.body);
  });

  app.get("/recharge/success", async (_req, reply) => {
    const p = page("success.html");
    reply.header("Cache-Control", "no-store");
    return reply.code(p.status).type("text/html; charset=utf-8").send(p.body);
  });

  app.get("/recharge/pricing", async (_req, reply) => {
    const p = page("pricing.html");
    reply.header("Cache-Control", "no-store");
    return reply.code(p.status).type("text/html; charset=utf-8").send(p.body);
  });

  /** 支付宝同步回跳：只用来定位订单，成功与否由结果页向服务端查单确认 */
  app.get("/recharge/return", async (req, reply) => {
    const query = (req.query ?? {}) as { out_trade_no?: unknown; outTradeNo?: unknown };
    const outTradeNo = String(query.out_trade_no ?? query.outTradeNo ?? "").trim();
    if (!outTradeNo) return reply.redirect("/recharge");
    return reply.redirect(`/recharge/success?outTradeNo=${encodeURIComponent(outTradeNo)}`);
  });

  app.get("/api/recharge/config", async () => {
    const config = loadWebpayConfig();
    return {
      ok: true,
      otpEnabled,
      payConfigured: Boolean(config),
      payEnv: config?.env ?? null,
    };
  });

  app.post("/api/recharge/session/start", async (req, reply) => {
    if (!hasCsrfHeader(req)) return reply.code(403).send({ ok: false, message: "CSRF check failed" });
    if (!otpEnabled || !otpService || !mailService) {
      return reply.code(503).send({ ok: false, message: "登录通道未开启：请稍后再试或联系服务方" });
    }
    const body = (req.body ?? {}) as { email?: unknown };
    const email = String(body.email ?? "");
    try {
      const result = await otpService.issue(email, {
        ip: req.ip,
        deliver: async (to, code) => {
          const sent = await mailService.sendEmail({
            to,
            subject: `NEXTBOT 额度充值登录验证码：${code}`,
            body: `你的 NEXTBOT 充值页登录验证码是 ${code}，10 分钟内有效。若非本人操作，请忽略本邮件。`,
          });
          if (!sent.ok) throw new Error(sent.error);
        },
      });
      if (!result.ok) {
        return reply.code(result.retryAfterSeconds ? 429 : 400).send({
          ok: false,
          message: result.error,
          ...(result.retryAfterSeconds ? { retryAfterSeconds: result.retryAfterSeconds } : {}),
        });
      }
      return { ok: true, resendAfterSeconds: result.resendAfterSeconds, ttlMinutes: result.ttlMinutes };
    } catch (err) {
      console.error("[recharge] otp send failed:", err instanceof Error ? err.message : err);
      return reply.code(502).send({ ok: false, message: "验证码邮件发送失败，请稍后重试" });
    }
  });

  app.post("/api/recharge/session/login", async (req, reply) => {
    if (!hasCsrfHeader(req)) return reply.code(403).send({ ok: false, message: "CSRF check failed" });
    if (!otpEnabled || !otpService) {
      return reply.code(503).send({ ok: false, message: "登录通道未开启：请稍后再试或联系服务方" });
    }
    const body = (req.body ?? {}) as { email?: unknown; code?: unknown };
    const email = String(body.email ?? "").trim().toLowerCase();
    const code = String(body.code ?? "").trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !/^\d{6}$/.test(code)) {
      return reply.code(400).send({ ok: false, message: "请填写邮箱与 6 位验证码" });
    }
    if (!otpService.verify(email, code, { consume: true })) {
      return reply.code(400).send({ ok: false, message: "验证码不正确或已过期，请重新获取" });
    }
    const token = getSiteSessionStore().create(email);
    reply.header("Set-Cookie", sessionCookie(req, token));
    const credential = getApiTokenStore().ensure(email);
    return {
      ok: true,
      ...maskFor(email),
      balance: centsToAmount(BigInt(getWebpayStore().getRechargeBalanceCents(email))),
      credential: credential.token,
      credentialCreated: credential.created,
    };
  });

  app.post("/api/recharge/session/logout", async (req, reply) => {
    if (!hasCsrfHeader(req)) return reply.code(403).send({ ok: false, message: "CSRF check failed" });
    const token = readSiteSessionToken(req.headers.cookie);
    if (token) getSiteSessionStore().revoke(hashSiteSessionToken(token));
    reply.header("Set-Cookie", `${SITE_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    return { ok: true };
  });

  app.get("/api/recharge/me", async (req, reply) => {
    const email = resolveSessionEmail(req);
    if (!email) return reply.code(401).send({ ok: false, message: "未登录" });
    const balanceCents = getWebpayStore().getRechargeBalanceCents(email);
    return { ok: true, ...maskFor(email), balance: centsToAmount(BigInt(balanceCents)) };
  });

  app.get("/api/recharge/ledger", async (req, reply) => {
    const email = resolveSessionEmail(req);
    if (!email) return reply.code(401).send({ ok: false, message: "未登录" });
    const rows = getWebpayStore().listRechargeLedger(email, 20);
    return {
      ok: true,
      items: rows.map((r) => ({
        outTradeNo: r.outTradeNo,
        amount: centsToAmount(BigInt(r.amountCents)),
        createdAt: r.createdAt,
      })),
    };
  });

  /** 计费口径（公开）：单价只在配置了真数时下发，未配置时 configured=false */
  app.get("/api/recharge/pricing", async (_req, reply) => {
    reply.header("Cache-Control", "no-store");
    const prices = readApiPrices();
    const cfg = resolveApiGatewayConfig();
    return {
      ok: true,
      configured: Boolean(prices),
      model: cfg.model || null,
      inputCentsPerMTok: prices?.inputCentsPerMTok ?? null,
      outputCentsPerMTok: prices?.outputCentsPerMTok ?? null,
    };
  });

  /** 调用凭据状态（明文只在签发/换发时返回一次） */
  app.get("/api/recharge/credential", async (req, reply) => {
    const email = resolveSessionEmail(req);
    if (!email) return reply.code(401).send({ ok: false, message: "未登录" });
    const info = getApiTokenStore().info(email);
    return {
      ok: true,
      hasCredential: Boolean(info),
      createdAt: info?.createdAt ?? null,
      lastUsedAt: info?.lastUsedAt ?? null,
    };
  });

  /** 换发调用凭据：吊销全部旧凭据后签发新的（明文只返回这一次） */
  app.post("/api/recharge/credential/rotate", async (req, reply) => {
    if (!hasCsrfHeader(req)) return reply.code(403).send({ ok: false, message: "CSRF check failed" });
    const email = resolveSessionEmail(req);
    if (!email) return reply.code(401).send({ ok: false, message: "未登录" });
    const token = getApiTokenStore().rotate(email);
    return { ok: true, credential: token };
  });

  /** 最近按 token 扣费的调用记录 */
  app.get("/api/recharge/usage", async (req, reply) => {
    const email = resolveSessionEmail(req);
    if (!email) return reply.code(401).send({ ok: false, message: "未登录" });
    const rows = getWebpayStore().listUsage(email, 20);
    return {
      ok: true,
      items: rows.map((r) => ({
        requestId: r.requestId,
        model: r.model,
        promptTokens: r.promptTokens,
        completionTokens: r.completionTokens,
        charged: centsToAmount(BigInt(r.chargedCents)),
        shortfallMicrocents: r.shortfallMicrocents,
        createdAt: r.createdAt,
      })),
    };
  });

  app.post("/api/recharge/orders", async (req, reply) => {
    if (!hasCsrfHeader(req)) return reply.code(403).send({ ok: false, message: "CSRF check failed" });
    const email = resolveSessionEmail(req);
    if (!email) return reply.code(401).send({ ok: false, message: "请先登录" });
    const body = (req.body ?? {}) as { amount?: unknown };
    const cents = parseAmountToCents(body.amount);
    if (cents === null || cents < MIN_CENTS || cents > MAX_CENTS) {
      return reply.code(400).send({ ok: false, message: "充值金额需为 1 ~ 100000 元、最多两位小数" });
    }
    const config = loadWebpayConfig();
    if (!config) return reply.code(503).send({ ok: false, message: "支付通道尚未配置" });
    try {
      const result = getWebpayService().createOrder({
        amount: centsToAmount(cents),
        subject: "NEXTBOT 额度充值",
        accountId: email,
        returnUrl: `${config.baseUrl}/recharge/return`,
        payMode: isMobileClient(req) ? "wap" : "page",
      });
      return {
        ok: true,
        outTradeNo: result.outTradeNo,
        amount: centsToAmount(cents),
        paymentHtml: result.paymentHtml,
        paymentUrl: result.paymentUrl ?? null,
      };
    } catch (err) {
      if (err instanceof WebpayNotConfiguredError) {
        return reply.code(503).send({ ok: false, message: "支付通道尚未配置" });
      }
      return reply.code(400).send({ ok: false, message: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/api/recharge/orders/:outTradeNo", async (req, reply) => {
    const email = resolveSessionEmail(req);
    if (!email) return reply.code(401).send({ ok: false, message: "未登录" });
    const { outTradeNo } = req.params as { outTradeNo: string };
    const snap = await orderSnapshot(outTradeNo, email);
    // 非本人订单按不存在处理，不泄露他人订单信息
    if (!snap) return reply.code(404).send({ ok: false, message: "订单不存在" });
    return { ok: true, ...snap };
  });

  // ── App 内购额度：Bearer 登录态直连，不再跳网页、不再重复邮箱验证码 ──
  // 支付仍走同一套支付宝 webpay 下单与验签记账，只是入口与 UI 在 App 内。

  app.get("/api/recharge/app/me", async (req, reply) => {
    const email = resolveBearerEmail(req, deps);
    if (!email) return reply.code(401).send({ ok: false, message: "登录已失效，请重新登录" });
    return {
      ok: true,
      ...maskFor(email),
      balance: centsToAmount(BigInt(getWebpayStore().getRechargeBalanceCents(email))),
    };
  });

  app.post("/api/recharge/app/orders", async (req, reply) => {
    const email = resolveBearerEmail(req, deps);
    if (!email) return reply.code(401).send({ ok: false, message: "登录已失效，请重新登录" });
    const body = (req.body ?? {}) as { amount?: unknown };
    const cents = parseAmountToCents(body.amount);
    if (cents === null || cents < MIN_CENTS || cents > MAX_CENTS) {
      return reply.code(400).send({ ok: false, message: "充值金额需为 1 ~ 100000 元、最多两位小数" });
    }
    const config = loadWebpayConfig();
    if (!config) return reply.code(503).send({ ok: false, message: "支付通道尚未配置" });
    try {
      const result = getWebpayService().createOrder({
        amount: centsToAmount(cents),
        subject: "NEXTBOT 额度充值",
        accountId: email,
        returnUrl: `${config.baseUrl}/recharge/return`,
        // App 内购固定走手机网站收银台：由系统浏览器拉起支付宝 App 完成支付
        payMode: "wap",
      });
      return {
        ok: true,
        outTradeNo: result.outTradeNo,
        amount: centsToAmount(cents),
        paymentUrl: result.paymentUrl ?? null,
      };
    } catch (err) {
      if (err instanceof WebpayNotConfiguredError) {
        return reply.code(503).send({ ok: false, message: "支付通道尚未配置" });
      }
      return reply.code(400).send({ ok: false, message: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/api/recharge/app/orders/:outTradeNo", async (req, reply) => {
    const email = resolveBearerEmail(req, deps);
    if (!email) return reply.code(401).send({ ok: false, message: "登录已失效，请重新登录" });
    const { outTradeNo } = req.params as { outTradeNo: string };
    const snap = await orderSnapshot(outTradeNo, email);
    if (!snap) return reply.code(404).send({ ok: false, message: "订单不存在" });
    return { ok: true, ...snap };
  });
}
