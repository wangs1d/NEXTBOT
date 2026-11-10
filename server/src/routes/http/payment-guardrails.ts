// HTTP 路由：支付护栏视图 + 代付回执（用户侧）
//
//   GET /api/payment/status           支付通道就绪状态（wechat/alipay 各自的
//                                     mode + 凭证是否齐备；无任何用户数据，
//                                     运维/部署自检用）
//   GET /api/payment/guardrails        当前护栏（单笔上限/日预算/类别授权）+ 今日已用
//   GET /api/payment/orders?limit=     最近代付订单（回执时间线，来自支付台账）
//
// 护栏的修改走服务端 .env（PAYMENT_MAX_SINGLE_CNY / PAYMENT_DAILY_BUDGET_CNY /
// PAYMENT_ALLOWED_CATEGORIES），内测期保持配置即文档；拦截原因会随下单错误
// 返回给 Agent，由 Agent 向用户解释。
import type { FastifyInstance } from "fastify";

import { resolveActorId } from "../../agent/actor-id.js";
import { getPaymentConfig, getPaymentGuardrailConfig } from "../../config/payment-config.js";
import { getPaymentOrderLedger } from "../../services/payment-order-ledger.js";
import { PaymentService } from "../../services/payment-service.js";

export function registerPaymentGuardrailRoutes(app: FastifyInstance): void {
  // 支付通道就绪自检（2026-11-10）：配置完 WECHAT_PAY_*/ALIPAY_* 后一眼确认
  // 是否真的切到 live——mock 是默认值，凭证缺失也会静默回落 mock，肉眼从
  // .env 根本看不出实际生效的是哪档。只暴露模式布尔值，不含任何密钥。
  app.get("/api/payment/status", async () => {
    const config = getPaymentConfig();
    const paymentService = new PaymentService();
    return {
      ok: true,
      wechat: {
        configured: Boolean(config.wechatAppId && config.wechatMchId),
        mode: paymentService.modeFor("wechat"),
      },
      alipay: {
        configured: Boolean(config.alipayAppId && config.alipayPrivateKey),
        mode: paymentService.modeFor("alipay"),
      },
      notifyBaseUrlSet: Boolean(config.paymentNotifyBaseUrl),
      guardrails: getPaymentGuardrailConfig(),
    };
  });

  app.get("/api/payment/guardrails", async (request) => {
    const q = request.query as { userId?: string; sessionId?: string };
    const actorId = resolveActorId({ userId: q.userId, sessionId: q.sessionId ?? "" });
    const guardrails = getPaymentGuardrailConfig();
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    const todayUsed = getPaymentOrderLedger().sumAmountSince(dayStart.toISOString(), actorId);
    return { ok: true, guardrails, todayUsedCny: Math.round(todayUsed * 100) / 100 };
  });

  app.get("/api/payment/orders", async (request) => {
    const query = request.query as { limit?: string; userId?: string; sessionId?: string };
    const limit = Math.min(Math.max(Number(query.limit) > 0 ? Number(query.limit) : 50, 1), 200);
    const actorId = resolveActorId({ userId: query.userId, sessionId: query.sessionId ?? "" });
    const orders = getPaymentOrderLedger().list(limit, actorId);
    return { ok: true, count: orders.length, orders };
  });
}
