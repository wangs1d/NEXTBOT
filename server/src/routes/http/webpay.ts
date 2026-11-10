import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import formbody from "@fastify/formbody";
import { serverRoot } from "../../config/paths.js";
import { loadWebpayConfig } from "../../config/webpay-config.js";
import {
  WebpayNotConfiguredError,
  getWebpayService,
} from "../../services/webpay/webpay-service.js";

/**
 * AI 网页应用收款 HTTP 面（自包含，无 deps）：
 * - /webpay/checkout  收银台演示页（沙箱付款人工入口）
 * - /webpay/return    同步回跳结果页（只展示，最终状态以服务端查单为准）
 * - /api/webpay/*     下单/查单/退款/退款查询/关闭/异步通知
 * 支付宝异步通知是 urlencoded 表单，formbody 只注册在通知路由的独立作用域。
 */

const webRoot = join(serverRoot(), "web", "webpay");

function sendPage(name: string): string | null {
  const file = join(webRoot, name);
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}

function failForError(err: unknown): { status: number; body: { ok: false; error: string } } {
  if (err instanceof WebpayNotConfiguredError) {
    return { status: 503, body: { ok: false, error: err.message } };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { status: 400, body: { ok: false, error: message } };
}

export function registerWebpayRoutes(app: FastifyInstance): void {
  const service = getWebpayService();

  app.get("/webpay/checkout", async (_req, reply) => {
    const html = sendPage("checkout.html");
    if (!html) return reply.code(500).send("checkout.html missing");
    reply.header("Cache-Control", "no-store");
    return reply.type("text/html; charset=utf-8").send(html);
  });

  app.get("/webpay/return", async (_req, reply) => {
    const html = sendPage("return.html");
    if (!html) return reply.code(500).send("return.html missing");
    reply.header("Cache-Control", "no-store");
    return reply.type("text/html; charset=utf-8").send(html);
  });

  app.get("/api/webpay/config-status", async () => {
    const config = loadWebpayConfig();
    return { ok: true, configured: Boolean(config), env: config?.env ?? null };
  });

  app.post("/api/webpay/orders", async (req, reply) => {
    const body = (req.body ?? {}) as { amount?: unknown; subject?: unknown };
    try {
      const result = service.createOrder({ amount: body.amount, subject: body.subject });
      return { ok: true, ...result };
    } catch (err) {
      const { status, body: errBody } = failForError(err);
      return reply.code(status).send(errBody);
    }
  });

  app.get("/api/webpay/orders/:outTradeNo", async (req, reply) => {
    const { outTradeNo } = req.params as { outTradeNo: string };
    try {
      const result = await service.queryOrder(outTradeNo);
      if (!result) return reply.code(404).send({ ok: false, error: "订单不存在" });
      return { ok: true, ...result };
    } catch (err) {
      const { status, body: errBody } = failForError(err);
      return reply.code(status).send(errBody);
    }
  });

  app.post("/api/webpay/orders/:outTradeNo/close", async (req, reply) => {
    const { outTradeNo } = req.params as { outTradeNo: string };
    const body = (req.body ?? {}) as { confirm?: unknown };
    try {
      const result = await service.closeOrder(outTradeNo, body.confirm === true);
      return reply.code(result.ok ? 200 : 409).send(result);
    } catch (err) {
      const { status, body: errBody } = failForError(err);
      return reply.code(status).send(errBody);
    }
  });

  app.post("/api/webpay/orders/:outTradeNo/refund", async (req, reply) => {
    const { outTradeNo } = req.params as { outTradeNo: string };
    const body = (req.body ?? {}) as { refundAmount?: unknown; outRequestNo?: unknown; reason?: unknown };
    try {
      const result = await service.refund({
        outTradeNo,
        refundAmount: body.refundAmount,
        outRequestNo: typeof body.outRequestNo === "string" ? body.outRequestNo : undefined,
        reason: typeof body.reason === "string" ? body.reason : undefined,
      });
      return reply.code(result.ok ? 200 : 409).send(result);
    } catch (err) {
      const { status, body: errBody } = failForError(err);
      return reply.code(status).send(errBody);
    }
  });

  app.get("/api/webpay/orders/:outTradeNo/refunds/:outRequestNo", async (req, reply) => {
    const { outTradeNo, outRequestNo } = req.params as { outTradeNo: string; outRequestNo: string };
    try {
      const result = await service.queryRefund(outTradeNo, outRequestNo);
      return reply.code(result.ok ? 200 : 409).send(result);
    } catch (err) {
      const { status, body: errBody } = failForError(err);
      return reply.code(status).send(errBody);
    }
  });

  /** 同步回跳参数验签：只用于定位订单，绝不据此判定支付成功 */
  app.post("/api/webpay/return/verify", async (req, reply) => {
    const body = (req.body ?? {}) as { params?: unknown };
    const params = body.params;
    if (!params || typeof params !== "object" || Array.isArray(params)) {
      return reply.code(400).send({ ok: false, error: "params required" });
    }
    const config = loadWebpayConfig();
    if (!config) return reply.code(503).send({ ok: false, valid: false, error: "支付未配置" });
    const flat: Record<string, string> = {};
    for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
      if (value != null) flat[key] = String(value);
    }
    const { valid, outTradeNo } = service.verifyReturnParams(flat);
    return { ok: true, valid, outTradeNo };
  });

  // 支付宝异步通知：application/x-www-form-urlencoded，独立作用域避免影响其他路由
  app.register(async (scope) => {
    await scope.register(formbody);
    scope.post("/api/webpay/notify", async (req, reply) => {
      const params = (req.body ?? {}) as Record<string, string>;
      const result = service.handleNotify(params);
      reply.header("Cache-Control", "no-store");
      return reply.type("text/plain; charset=utf-8").send(result);
    });
  });
}