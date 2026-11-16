import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import formbody from "@fastify/formbody";

import { resolveActorId } from "../../agent/actor-id.js";
import { serverRoot } from "../../config/paths.js";
import { defaultAuthorizationDays, defaultLimits } from "../../payments/authorization-service.js";
import { verifyAlipayNotify } from "../../payments/channels/alipay-qr.js";
import { emitPaymentNotify } from "../../payments/notify-hook.js";
import {
  getIntentPaymentHtml,
  getUnifiedPaymentService,
} from "../../payments/unified-payment-service.js";
import type { PaymentChannelId } from "../../payments/types.js";

/**
 * 统一支付 HTTP 面。
 *
 *   GET  /payment/authorize                 授权页（用户在浏览器/客户端打开）
 *   GET  /payment/intent/:id/checkout       收银台页（支付宝自动提交表单）
 *   GET  /api/payment/channels              渠道可用性诊断
 *   GET  /api/payment/authorizations        当前用户授权列表 + 默认额度
 *   POST /api/payment/authorizations        创建授权（必须 accepted=true）
 *   DELETE /api/payment/authorizations/:id  撤销授权
 *   POST /api/payment/intents               创建支付意图（等同 payment.pay）
 *   GET  /api/payment/intents/:id           查询（默认向渠道核对）
 *   POST /api/payment/intents/:id/confirm   确认并执行
 *   POST /api/payment/intents/:id/refund    退款
 *
 * 认证口径与项目其它本地接口一致（userId/sessionId → actorId）。授权页会授予
 * 代付额度，属于高敏操作：部署到公网时必须由网关加登录态校验，不能裸奔。
 */

const webRoot = join(serverRoot(), "web", "payment");

function sendPage(name: string): string | null {
  const file = join(webRoot, name);
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}

function actorFrom(body: Record<string, unknown>): string {
  const userId = typeof body.userId === "string" ? body.userId : undefined;
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
  return resolveActorId({ userId, sessionId });
}

export function registerUnifiedPaymentRoutes(app: FastifyInstance): void {
  app.get("/payment/authorize", async (_req, reply) => {
    const html = sendPage("authorize.html");
    if (!html) return reply.code(500).send("authorize.html missing");
    reply.header("Cache-Control", "no-store");
    return reply.type("text/html; charset=utf-8").send(html);
  });

  /** 付款页：金额确认 + 选付款方式 + 「确认付款」按钮 + 扫码/轮询。 */
  app.get("/payment/pay", async (_req, reply) => {
    const html = sendPage("pay.html");
    if (!html) return reply.code(500).send("pay.html missing");
    reply.header("Cache-Control", "no-store");
    return reply.type("text/html; charset=utf-8").send(html);
  });

  /**
   * 收银台页：返回渠道下单时生成的自动提交表单。
   * 表单是本地签名产物、不含用户凭证；intent id 为 144bit 随机串不可枚举，
   * 扫码人可能不是发起人（代付/分享付款场景），故按 id 直取即可。
   */
  app.get("/payment/intent/:intentId/checkout", async (req, reply) => {
    const { intentId } = req.params as { intentId: string };
    const paymentHtml = getIntentPaymentHtml(intentId);
    if (!paymentHtml) {
      return reply.code(404).type("text/html; charset=utf-8").send(
        `<html><body style="background:#0b0b0c;color:#eee;font-family:system-ui;padding:48px">
           <h3>收银台不可用</h3>
           <p>该支付意图不存在，或渠道未生成可展示的收银台。</p>
         </body></html>`,
      );
    }
    reply.header("Cache-Control", "no-store");
    return reply.type("text/html; charset=utf-8").send(paymentHtml);
  });

  app.get("/api/payment/channels", async () => {
    const service = getUnifiedPaymentService();
    if (!service) return { ok: false, error: "支付服务未装配" };
    return { ok: true, channels: service.listChannels() };
  });

  app.get("/api/payment/authorizations", async (req) => {
    const service = getUnifiedPaymentService();
    if (!service) return { ok: false, error: "支付服务未装配" };
    const q = req.query as Record<string, unknown>;
    const actorId = actorFrom(q as Record<string, unknown>);
    return {
      ok: true,
      actorId,
      authorizations: service.listAuthorizations(actorId),
      limitsDefaults: { ...defaultLimits(), validDays: defaultAuthorizationDays() },
      channels: service.listChannels(),
    };
  });

  app.post("/api/payment/authorizations", async (req, reply) => {
    const service = getUnifiedPaymentService();
    if (!service) return reply.code(503).send({ ok: false, error: "支付服务未装配" });
    const body = (req.body ?? {}) as Record<string, unknown>;
    const actorId = actorFrom(body);
    const channel = String(body.channel ?? "").trim() as PaymentChannelId;
    if (!channel) return reply.code(400).send({ ok: false, error: "缺少渠道（channel）" });

    const result = service.createAuthorization({
      actorId,
      channel,
      accepted: body.accepted === true,
      limits: {
        perTxCny: Number(body.perTxCny),
        dailyCny: Number(body.dailyCny),
        monthlyCny: Number(body.monthlyCny),
        autoApproveCny: Number(body.autoApproveCny),
      },
      categories: Array.isArray(body.categories) ? body.categories.map((c) => String(c)) : undefined,
      validDays: body.validDays === undefined ? undefined : Number(body.validDays),
      source: typeof body.source === "string" ? body.source : "web",
    });
    if (!result.ok) return reply.code(400).send({ ok: false, error: result.error });
    return { ok: true, actorId, authorization: result.authorization };
  });

  app.delete("/api/payment/authorizations/:id", async (req, reply) => {
    const service = getUnifiedPaymentService();
    if (!service) return reply.code(503).send({ ok: false, error: "支付服务未装配" });
    const { id } = req.params as { id: string };
    const actorId = actorFrom((req.query ?? {}) as Record<string, unknown>);
    const ok = service.revokeAuthorization(id, actorId);
    return reply.code(ok ? 200 : 404).send({ ok, authorizationId: id });
  });

  app.post("/api/payment/intents", async (req, reply) => {
    const service = getUnifiedPaymentService();
    if (!service) return reply.code(503).send({ ok: false, error: "支付服务未装配" });
    const body = (req.body ?? {}) as Record<string, unknown>;
    const actorId = actorFrom(body);
    const result = await service.createIntent({
      actorId,
      amount: Number(body.amount),
      subject: String(body.subject ?? ""),
      category: typeof body.category === "string" ? body.category : undefined,
      bizDomain: typeof body.bizDomain === "string" ? (body.bizDomain as never) : undefined,
      bizRefId: typeof body.bizRefId === "string" ? body.bizRefId : undefined,
      merchant: typeof body.merchant === "string" ? body.merchant : undefined,
      channel: typeof body.channel === "string" ? (body.channel as never) : undefined,
      cashierUrl: typeof body.cashierUrl === "string" ? body.cashierUrl : undefined,
      idempotencyKey: typeof body.idempotencyKey === "string" ? body.idempotencyKey : undefined,
      sessionId: typeof body.sessionId === "string" ? body.sessionId : undefined,
    });
    return reply.code(result.ok || result.intent ? 200 : 400).send(result);
  });

  app.get("/api/payment/intents/:id", async (req, reply) => {
    const service = getUnifiedPaymentService();
    if (!service) return reply.code(503).send({ ok: false, error: "支付服务未装配" });
    const { id } = req.params as { id: string };
    const q = (req.query ?? {}) as Record<string, unknown>;
    const actorId = actorFrom(q);
    const result = await service.queryIntent(id, actorId, { sync: q.sync !== "0" && q.sync !== false });
    return reply.code(result.intent ? 200 : 404).send(result);
  });

  /**
   * 付款页点「确认付款」前调用：把意图推进到「待确认」并下发新的确认令牌。
   * 页面刷新/令牌过期后靠它取新令牌，不需要重新下单（换单会丢业务上下文）。
   */
  app.post("/api/payment/intents/:id/prepare", async (req, reply) => {
    const service = getUnifiedPaymentService();
    if (!service) return reply.code(503).send({ ok: false, error: "支付服务未装配" });
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await service.prepareIntent(id, actorFrom(body));
    return reply.code(result.intent ? 200 : 404).send(result);
  });

  /** 付款页的「确认付款」：带上用户选的付款方式，真正执行扣款/出码。 */
  app.post("/api/payment/intents/:id/pay", async (req, reply) => {
    const service = getUnifiedPaymentService();
    if (!service) return reply.code(503).send({ ok: false, error: "支付服务未装配" });
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await service.payIntent({
      intentId: id,
      actorId: actorFrom(body),
      confirmToken: typeof body.confirmToken === "string" ? body.confirmToken : undefined,
      channel: typeof body.channel === "string" ? (body.channel as PaymentChannelId) : undefined,
    });
    return reply.code(result.ok || result.intent ? 200 : 400).send(result);
  });

  app.post("/api/payment/intents/:id/confirm", async (req, reply) => {    const service = getUnifiedPaymentService();
    if (!service) return reply.code(503).send({ ok: false, error: "支付服务未装配" });
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await service.confirmIntent({
      intentId: id,
      actorId: actorFrom(body),
      confirmToken: String(body.confirmToken ?? ""),
    });
    return reply.code(result.ok ? 200 : 400).send(result);
  });

  app.post("/api/payment/intents/:id/refund", async (req, reply) => {
    const service = getUnifiedPaymentService();
    if (!service) return reply.code(503).send({ ok: false, error: "支付服务未装配" });
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await service.refundIntent({
      intentId: id,
      actorId: actorFrom(body),
      amount: body.amount === undefined ? undefined : Number(body.amount),
      reason: typeof body.reason === "string" ? body.reason : undefined,
    });
    return reply.code(result.ok ? 200 : 409).send(result);
  });

  /** 联调：把 mock 意图标记为已支付（生产环境禁用）。 */
  app.post("/api/payment/intents/:id/mock-pay", async (req, reply) => {
    if (process.env.NODE_ENV === "production") {
      return reply.code(403).send({ ok: false, error: "生产环境禁用模拟支付" });
    }
    const service = getUnifiedPaymentService();
    if (!service) return reply.code(503).send({ ok: false, error: "支付服务未装配" });
    const { id } = req.params as { id: string };
    const result = service.mockMarkPaid(id);
    return reply.code(result.ok ? 200 : 400).send(result);
  });

  /**
   * 支付宝异步通知（扫码渠道）。formbody 只注册在本作用域，避免影响其它路由。
   * 验签通过 → 触发主动查单（通知里的金额/状态不作为入账依据）→ 回 success。
   */
  app.register(async (scope) => {
    await scope.register(formbody);
    scope.post("/api/payment/notify/alipay", async (req, reply) => {
      const params = (req.body ?? {}) as Record<string, string>;
      reply.header("Cache-Control", "no-store");
      if (!verifyAlipayNotify(params)) {
        return reply.type("text/plain; charset=utf-8").send("fail");
      }
      emitPaymentNotify("alipay_qr", params.out_trade_no);
      return reply.type("text/plain; charset=utf-8").send("success");
    });
  });
}

/** 取渠道生成并落库的收银台 HTML（仅 alipay_sandbox 渠道会产出）。 */
