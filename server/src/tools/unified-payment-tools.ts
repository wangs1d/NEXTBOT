import { resolveActorId } from "../agent/actor-id.js";
import { defaultLimits, defaultAuthorizationDays } from "../payments/authorization-service.js";
import { authorizationPageUrl } from "../payments/base-url.js";
import type {
  BizDomain,
  CreateIntentResult,
  PaymentChannelId,
} from "../payments/types.js";
import type { UnifiedPaymentService } from "../payments/unified-payment-service.js";
import type { QrAssistService } from "../services/qr-assist-service.js";
import type { ToolRegistry } from "./tool-registry.js";

/**
 * 统一支付工具族（Agent 可见面）。
 *
 * 与既有工具的关系：
 *   - `payment.create_order` / `payment.query_order`（商户收款码）保持原样，继续可用；
 *   - `booking.travel-pay` / `shopping.pay.submit`（钱包收银台代付）保持原样；
 *   - 本工具族是**新增的统一入口**：一次调用走完「授权判定 → 额度/护栏 → 确认 →
 *     渠道下单 → 二维码/收银台」，业务侧只需要给金额、事由和业务单据号。
 *
 * 工具只负责「把状态如实讲清楚」：nextAction 决定 Agent 下一句说什么，
 * 不猜、不圆场、不把 awaiting 说成已支付。
 */

const BIZ_DOMAINS: readonly BizDomain[] = [
  "travel",
  "ride",
  "delivery",
  "dining",
  "express",
  "utility",
  "shopping",
  "recharge",
  "service",
  "other",
];

const CHANNELS: readonly PaymentChannelId[] = [
  "alipay_qr",
  "alipay_wap",
  "alipay_sandbox",
  "alipay_bot",
  "wechat",
  "mock",
];

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function num(v: unknown): number | undefined {
  if (v === "" || v === null || v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** 统一支付结果 → 工具回执（附用户可读 summary 与下一步指引）。 */
function toToolResult(result: CreateIntentResult): Record<string, unknown> {
  const intent = result.intent;
  return {
    ok: result.ok,
    nextAction: result.nextAction,
    summary: result.message,
    intentId: intent?.id,
    status: intent?.status,
    amount: intent?.amount,
    subject: intent?.subject,
    channel: intent?.channel,
    channelLabel: intent?.channelLabel,
    mode: intent?.mode,
    bizDomain: intent?.bizDomain,
    bizRefId: intent?.bizRefId,
    payUrl: intent?.payUrl,
    qrCodeDataUrl: intent?.qrCodeDataUrl,
    authorizationUrl: result.authorizationUrl,
    payPageUrl: result.payPageUrl,
    confirmToken: result.confirmToken,
    confirmExpiresAt: result.confirmExpiresAt,
    failureReason: intent?.failureReason,
    ...(result.error ? { error: result.error } : {}),
    guidance:
      result.nextAction === "authorize"
        ? "把 authorizationUrl 原样发给用户：用户在授权页设置额度并点「同意授权」后会自动回到付款页；未授权前不会扣款"
        : result.nextAction === "confirm"
          ? "把 payPageUrl 发给用户：用户在页面里选支付宝、点「确认付款」后才会扣款；不要替用户确认，也不要在对话里替 TA 点"
          : result.nextAction === "pay"
            ? "把 payPageUrl（或二维码）发给用户完成付款；用户付完用 payment.pay_status 核对真实到账"
            : result.nextAction === "paid"
              ? "支付已确认，可继续业务下一步"
              : result.nextAction === "blocked"
                ? "如实告诉用户被拦原因，不要重试、不要拆单"
                : "如实告知用户失败原因",
  };
}

export function registerUnifiedPaymentTools(
  registry: ToolRegistry,
  payment: UnifiedPaymentService,
  qrAssist?: QrAssistService,
): void {
  registry.register(
    "payment.pay",
    async (input, context) => {
      const actorId = resolveActorId({ userId: context.userId, sessionId: context.sessionId });
      const channelRaw = str(input.channel) || "auto";
      const channel = channelRaw === "auto" ? "auto" : (channelRaw as PaymentChannelId);
      if (channel !== "auto" && !CHANNELS.includes(channel)) {
        throw new Error(`不支持的支付渠道：${channelRaw}。可选：auto / ${CHANNELS.join(" / ")}`);
      }
      const bizDomainRaw = str(input.bizDomain) as BizDomain;
      const bizDomain = BIZ_DOMAINS.includes(bizDomainRaw) ? bizDomainRaw : "other";

      const result = await payment.createIntent({
        actorId,
        amount: Number(input.amount),
        subject: str(input.subject),
        category: str(input.category) || undefined,
        bizDomain,
        bizRefId: str(input.bizRefId) || undefined,
        merchant: str(input.merchant) || undefined,
        channel,
        cashierUrl: str(input.cashierUrl) || undefined,
        idempotencyKey: str(input.idempotencyKey) || undefined,
        sessionId: context.sessionId,
      });

      const payload = toToolResult(result);

      // 收款码进聊天流：用户不用点链接也能扫
      if (result.nextAction === "pay" && result.intent?.qrCodeDataUrl && qrAssist) {
        try {
          const imageUrl = await qrAssist.pushQrImage(
            context,
            {
              title: `${result.intent.channelLabel} · 待支付 ¥${result.intent.amount}`,
              caption: `${result.intent.subject} · 订单 ${result.intent.id}`,
            },
            { dataUrl: result.intent.qrCodeDataUrl },
          );
          if (imageUrl) payload.qrImageUrl = imageUrl;
        } catch {
          // 推图失败不影响支付本身：dataURL 仍在回执里，客户端可自行渲染
        }
      }
      return payload;
    },
    {
      category: "wallet",
      toolset: "payment",
      sideEffect: "external",
      riskLevel: "high",
      requireHonestFailure: true,
      timeoutMs: 60_000,
    },
  );

  registry.register(
    "payment.pay_confirm",
    async (input, context) => {
      const actorId = resolveActorId({ userId: context.userId, sessionId: context.sessionId });
      const intentId = str(input.intentId);
      const confirmToken = str(input.confirmToken);
      if (!intentId) throw new Error("缺少支付意图 ID（intentId）");
      if (!confirmToken) throw new Error("缺少确认令牌（confirmToken）");
      const result = await payment.confirmIntent({ intentId, actorId, confirmToken });
      return toToolResult(result);
    },
    {
      category: "wallet",
      toolset: "payment",
      sideEffect: "external",
      riskLevel: "high",
      requireHonestFailure: true,
      timeoutMs: 60_000,
    },
  );

  registry.register(
    "payment.pay_resume",
    async (input, context) => {
      const actorId = resolveActorId({ userId: context.userId, sessionId: context.sessionId });
      const intentId = str(input.intentId);
      if (!intentId) throw new Error("缺少支付意图 ID（intentId）");
      const result = await payment.resumeIntent(intentId, actorId);
      return toToolResult(result);
    },
    {
      category: "wallet",
      toolset: "payment",
      sideEffect: "external",
      riskLevel: "high",
      requireHonestFailure: true,
      timeoutMs: 60_000,
    },
  );

  registry.register(
    "payment.pay_status",
    async (input, context) => {
      const actorId = resolveActorId({ userId: context.userId, sessionId: context.sessionId });
      const intentId = str(input.intentId);
      if (!intentId) throw new Error("缺少支付意图 ID（intentId）");
      const sync = input.sync !== false;
      const result = await payment.queryIntent(intentId, actorId, { sync });
      return toToolResult(result);
    },
    {
      category: "wallet",
      toolset: "payment",
      sideEffect: "none",
      riskLevel: "low",
      timeoutMs: 30_000,
    },
  );

  registry.register(
    "payment.refund",
    async (input, context) => {
      const actorId = resolveActorId({ userId: context.userId, sessionId: context.sessionId });
      const intentId = str(input.intentId);
      if (!intentId) throw new Error("缺少支付意图 ID（intentId）");
      const result = await payment.refundIntent({
        intentId,
        actorId,
        amount: num(input.amount),
        reason: str(input.reason) || undefined,
      });
      return {
        ok: result.ok,
        summary: result.message,
        intentId,
        status: result.status,
        refundedAmount: result.refundedAmount,
        intent: result.intent,
        ...(result.error ? { error: result.error } : {}),
      };
    },
    {
      category: "wallet",
      toolset: "payment",
      sideEffect: "external",
      riskLevel: "high",
      requireHonestFailure: true,
      timeoutMs: 60_000,
    },
  );

  registry.register(
    "payment.authorization_status",
    async (_input, context) => {
      const actorId = resolveActorId({ userId: context.userId, sessionId: context.sessionId });
      const channels = payment.listChannels();
      const authorizations = payment.listAuthorizations(actorId);
      const defaults = defaultLimits();
      const active = authorizations.filter((a) => a.status === "active");
      return {
        ok: true,
        actorId,
        summary: active.length
          ? `已授权 ${active.length} 个渠道：${active.map((a) => `${a.channel}（单笔上限 ¥${(a.limits as { perTxCny: number }).perTxCny || "不限"}）`).join("、")}`
          : "当前用户还没有任何支付授权：任何代付都会先返回授权页，由用户设置额度并同意",
        channels: channels.map((c) => ({
          channel: c.channel,
          label: c.label,
          direction: c.direction,
          available: c.available,
          mode: c.mode,
          reason: c.reason,
        })),
        authorizations,
        limitsDefaults: { ...defaults, validDays: defaultAuthorizationDays() },
        authorizationUrlHint: "需要新授权时用 payment.pay 返回的 authorizationUrl（已带角色与金额上下文）",
      };
    },
    { category: "wallet", toolset: "payment", sideEffect: "none", riskLevel: "low", timeoutMs: 15_000 },
  );

  registry.register(
    "payment.revoke_authorization",
    async (input, context) => {
      const actorId = resolveActorId({ userId: context.userId, sessionId: context.sessionId });
      const id = str(input.authorizationId);
      if (!id) throw new Error("缺少授权 ID（authorizationId）");
      const ok = payment.revokeAuthorization(id, actorId);
      return {
        ok,
        summary: ok ? "已撤销该支付授权，后续支付需要重新授权" : "撤销失败：授权不存在、不属于当前用户或已撤销",
        authorizationId: id,
      };
    },
    {
      category: "wallet",
      toolset: "payment",
      sideEffect: "write",
      riskLevel: "high",
      requireHonestFailure: true,
      timeoutMs: 15_000,
    },
  );

  registry.register(
    "payment.receipt",
    async (input, context) => {
      const actorId = resolveActorId({ userId: context.userId, sessionId: context.sessionId });
      const limit = num(input.limit) ?? 20;
      const intents = payment.listIntents(actorId, Math.floor(limit));
      const paid = intents.filter((i) => i.status === "paid" || i.status === "refunded");
      const totalPaid = Math.round(paid.reduce((sum, i) => sum + i.amount - i.refundedAmount, 0) * 100) / 100;
      return {
        ok: true,
        summary: paid.length
          ? `最近 ${intents.length} 笔支付中已支付 ${paid.length} 笔，合计 ¥${totalPaid}`
          : "暂无已完成的支付记录",
        actorId,
        totalPaid,
        items: intents.map((i) => ({
          intentId: i.id,
          status: i.status,
          amount: i.amount,
          subject: i.subject,
          bizDomain: i.bizDomain,
          merchant: i.merchant,
          channel: i.channel,
          mode: i.mode,
          refundedAmount: i.refundedAmount,
          createdAt: i.createdAt,
          paidAt: i.paidAt,
          bizRefId: i.bizRefId,
        })),
      };
    },
    { category: "wallet", toolset: "payment", sideEffect: "none", riskLevel: "low", timeoutMs: 15_000 },
  );

  registry.register(
    "payment.authorization_link",
    async (input, context) => {
      const actorId = resolveActorId({ userId: context.userId, sessionId: context.sessionId });
      const channel = (str(input.channel) || "alipay_sandbox") as PaymentChannelId;
      if (!CHANNELS.includes(channel)) throw new Error(`不支持的渠道：${channel}`);
      const url = authorizationPageUrl({
        actorId,
        channel,
        amountCny: num(input.amount),
        subject: str(input.subject) || undefined,
        bizDomain: str(input.bizDomain) || undefined,
      });
      return {
        ok: true,
        summary: "已生成支付授权页链接：发给用户，由其在页面上设置额度并点击同意",
        authorizationUrl: url,
        actorId,
        channel,
      };
    },
    { category: "wallet", toolset: "payment", sideEffect: "none", riskLevel: "low", timeoutMs: 10_000 },
  );
}
