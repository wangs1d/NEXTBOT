import { randomBytes } from "node:crypto";
import QRCode from "qrcode";

import { getPaymentGuardrailConfig } from "../config/payment-config.js";
import type { AlipayBotService } from "../services/alipay-bot-service.js";
import type { PaymentService } from "../services/payment-service.js";
import { authorizationPageUrl, resolvePublicBaseUrl } from "./base-url.js";
import {
  PaymentAuthorizationService,
  normalizeCategory,
} from "./authorization-service.js";
import { ChannelRegistry } from "./channels/index.js";
import { centsToAmount, centsToAmountString, amountToCents } from "./money.js";
import { setPaymentNotifyHandler } from "./notify-hook.js";
import { getUnifiedPaymentStore, type UnifiedPaymentStore } from "./store.js";
import type {
  BizDomain,
  ChannelAvailability,
  CreateIntentInput,
  CreateIntentResult,
  NextAction,
  PaymentAuthorization,
  PaymentChannelId,
  PaymentIntent,
  PaymentIntentView,
} from "./types.js";
import { providerOf } from "./types.js";

/**
 * 统一支付门面 —— Agent 侧唯一入口。
 *
 * 对外只暴露「意图（intent）」一套语义：
 *   createIntent → 需要授权？需要确认？直接收款？被拦截？
 *   confirmIntent → 用户确认后执行
 *   queryIntent  → 向渠道核对真实状态并推进
 *   refundIntent → 原路退款（渠道支持时）
 *
 * 内部把「授权、护栏、渠道、状态机、事件、二维码、对账」串起来。任何一步
 * 不确定都停在可解释的状态，绝不把未知当成功——支付模块最贵的 bug 是假成功。
 */

const CONFIRM_TTL_MS = 10 * 60 * 1000;
const RECONCILE_INTERVAL_MS = 15_000;
const MAX_PENDING_AGE_MS = 24 * 60 * 60 * 1000;

function newIntentId(): string {
  return `pi_${randomBytes(9).toString("hex")}`;
}

function newConfirmToken(): string {
  return randomBytes(16).toString("hex");
}

function nowIso(): string {
  return new Date().toISOString();
}

function startOfDayIso(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

export interface UnifiedPaymentServiceOptions {
  store?: UnifiedPaymentStore;
  authorizations?: PaymentAuthorizationService;
  channels?: ChannelRegistry;
  baseUrl?: () => string;
  alipayBotService?: AlipayBotService;
  paymentService?: PaymentService;
}

export interface RefundIntentResult {
  ok: boolean;
  intent: PaymentIntentView | null;
  refundedAmount: number;
  status: string;
  message: string;
  error?: string;
}

export class UnifiedPaymentService {
  private readonly store: UnifiedPaymentStore;
  private readonly authorizations: PaymentAuthorizationService;
  private readonly channels: ChannelRegistry;
  private readonly baseUrl: () => string;
  private readonly paidListeners: Array<(intent: PaymentIntent) => void> = [];
  private reconcileTimer: NodeJS.Timeout | null = null;

  constructor(options: UnifiedPaymentServiceOptions = {}) {
    this.store = options.store ?? getUnifiedPaymentStore();
    this.authorizations = options.authorizations ?? new PaymentAuthorizationService(this.store);
    const deps = options;
    this.channels =
      options.channels ??
      (deps.alipayBotService && deps.paymentService
        ? ChannelRegistry.createDefault({
            alipayBotService: deps.alipayBotService,
            paymentService: deps.paymentService,
          })
        : new ChannelRegistry([]));
    this.baseUrl = options.baseUrl ?? resolvePublicBaseUrl;
    // 异步通知只当作「有变化」的信号：收到后主动查单，由渠道事实推进状态。
    // 通知丢了也不影响正确性（15s 对账循环兜底），只是慢一点。
    setPaymentNotifyHandler((channelId, channelOrderId) => {
      void this.syncByChannelOrderId(channelId, channelOrderId).catch((err) => {
        console.error("[unified-payment] notify sync failed:", err instanceof Error ? err.message : err);
      });
    });
  }

  /** 通知入口：按渠道单号找回意图并主动查单（不信任通知里的金额/状态字段）。 */
  async syncByChannelOrderId(channelId: PaymentChannelId, channelOrderId: string): Promise<void> {
    const intent = this.store.findIntentByChannelOrderId(channelId, channelOrderId);
    if (!intent || intent.status !== "pending") return;
    this.store.addEvent(intent.id, "notify_received", { channel: channelId, channelOrderId });
    await this.queryIntent(intent.id, intent.actorId);
  }

  /** 渠道可用性清单（诊断/授权页/工具回执共用）。 */
  listChannels(): ChannelAvailability[] {
    return this.channels.availability();
  }

  listAuthorizations(actorId: string): Record<string, unknown>[] {
    return this.authorizations.list(actorId).map((a) => this.authorizations.summarize(a));
  }

  createAuthorization(input: {
    actorId: string;
    channel: PaymentChannelId;
    limits?: { perTxCny?: number; dailyCny?: number; monthlyCny?: number; autoApproveCny?: number };
    categories?: string[];
    accepted: boolean;
    source?: string;
    validDays?: number;
  }): { ok: boolean; authorization?: Record<string, unknown>; error?: string } {
    const channel = this.channels.get(input.channel);
    if (!channel) return { ok: false, error: `未知支付渠道：${input.channel}` };
    if (!channel.availability().available) {
      return { ok: false, error: channel.availability().reason ?? "该渠道当前不可用，暂时无法授权" };
    }
    const created = this.authorizations.create(input);
    if (!created.ok || !created.authorization) return { ok: false, error: created.error };
    return { ok: true, authorization: this.authorizations.summarize(created.authorization) };
  }

  revokeAuthorization(id: string, actorId: string): boolean {
    return this.authorizations.revoke(id, actorId);
  }

  /** 支付成功回调：业务侧（出票、发货、账单核销）挂在这里，避免轮询业务表。 */
  onPaid(listener: (intent: PaymentIntent) => void): void {
    this.paidListeners.push(listener);
  }

  // ───────────────────────── 创建 / 推进 ─────────────────────────

  async createIntent(input: CreateIntentInput): Promise<CreateIntentResult> {
    const actorId = input.actorId?.trim() ?? "";
    if (!actorId) return this.fail("缺少用户标识（actorId），无法确定付款人");

    const amountCents = amountToCents(input.amount);
    if (amountCents === null) {
      return this.fail("金额非法：需为 0.01 ~ 1000000 元、最多两位小数");
    }
    const subject = (input.subject ?? "").trim();
    if (!subject) return this.fail("缺少支付事由（subject）");
    const bizDomain: BizDomain = input.bizDomain ?? "other";
    const category = normalizeCategory(input.category ?? bizDomain, bizDomain);
    const idempotencyKey = input.idempotencyKey?.trim() || null;

    if (idempotencyKey) {
      const existing = this.store.getIntentByIdempotency(actorId, idempotencyKey);
      if (existing) {
        if (existing.amountCents !== amountCents) {
          return this.fail(
            `幂等键 ${idempotencyKey} 已用于另一笔 ¥${centsToAmount(existing.amountCents)} 的支付，金额不一致，拒绝复用`,
          );
        }
        return this.advance(existing);
      }
    }

    const resolved = this.resolveChannel(input.channel ?? "auto", Boolean(input.cashierUrl?.trim()));
    if (!resolved.channel) return this.fail(resolved.error ?? "没有可用的支付渠道");

    const now = nowIso();
    const intent: PaymentIntent = {
      id: newIntentId(),
      actorId,
      idempotencyKey,
      bizDomain,
      bizRefId: input.bizRefId?.trim() ?? null,
      merchant: input.merchant?.trim() ?? null,
      subject,
      amountCents,
      category,
      channel: resolved.channel.id,
      authorizationId: null,
      status: "requires_authorization",
      confirmToken: null,
      confirmExpiresAt: null,
      channelOrderId: null,
      payUrl: null,
      paymentHtml: null,
      qrCodeDataUrl: null,
      cashierUrl: input.cashierUrl?.trim() ?? null,
      failureReason: null,
      refundedCents: 0,
      createdAt: now,
      updatedAt: now,
      paidAt: null,
    };

    const inserted = this.store.insertIntent(intent);
    if (!inserted.ok) {
      if (inserted.conflict) return this.advance(inserted.conflict);
      return this.fail("支付意图写入失败（存储不可用）");
    }
    this.store.addEvent(intent.id, "intent_created", {
      actorId,
      channel: intent.channel,
      amountCents,
      category,
      bizDomain,
      bizRefId: intent.bizRefId,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
    this.lastInputSessionId = input.sessionId?.trim() || null;
    return this.advance(intent);
  }

  /**
   * 支付宝 AI 支付的 submit-payment 需要真实业务会话 ID。会话是请求上下文，
   * 不属于订单本身，故只在内存里随最近一次 createIntent 传递；重启后旧单
   * 需要重新发起（用户本来也要重新确认）。
   */
  private lastInputSessionId: string | null = null;

  /** 用户确认后执行（一次性令牌，10 分钟有效）。 */
  /** 确认令牌是否仍有效（一次性、10 分钟）。 */
  private isConfirmTokenValid(intent: PaymentIntent, token: string | undefined): boolean {
    const t = token?.trim();
    if (!t || !intent.confirmToken || t !== intent.confirmToken) return false;
    if (!intent.confirmExpiresAt) return false;
    return Date.parse(intent.confirmExpiresAt) > Date.now();
  }

  /**
   * 授权通过后的最后一跳：再判一次授权/额度，然后执行渠道下单。
   *
   * 用户可能在确认有效期内撤销授权或调低额度，所以每次执行前都必须重判，
   * 否则「确认令牌」会变成绕过撤销的后门。渠道换了但 provider 没换时复用同一份授权。
   */
  private async proceedWithAuth(
    intent: PaymentIntent,
    auth: PaymentAuthorization,
  ): Promise<CreateIntentResult> {
    if (
      this.authorizations.statusOf(auth) !== "active" ||
      providerOf(auth.channel) !== providerOf(intent.channel)
    ) {
      return this.advance({ ...intent, authorizationId: null, status: "requires_authorization" });
    }
    const decision = this.authorizations.evaluate(auth, {
      amountCents: intent.amountCents,
      category: intent.category,
    });
    if (!decision.allowed) {
      const blocked = this.store.updateIntent(intent.id, {
        status: "blocked",
        confirm_token: null,
        confirm_expires_at: null,
        failure_reason: decision.reason ?? "超出授权范围",
        updated_at: nowIso(),
      });
      this.store.addEvent(intent.id, "blocked_on_confirm", { reason: decision.reason });
      return this.resultFromIntent(blocked ?? intent, "blocked", decision.reason);
    }
    return this.executeIntent({ ...intent, authorizationId: auth.id }, auth);
  }

  /** 用户确认后执行（一次性令牌，10 分钟有效）。 */
  async confirmIntent(params: {
    intentId: string;
    actorId: string;
    confirmToken: string;
  }): Promise<CreateIntentResult> {
    const intent = this.store.getIntent(params.intentId);
    if (!intent || intent.actorId !== params.actorId.trim()) {
      return this.fail("支付意图不存在或不属于当前用户");
    }
    if (intent.status === "paid") return this.resultFromIntent(intent, "paid");
    if (intent.status !== "requires_confirm") {
      return this.fail(`当前状态 ${intent.status} 不需要确认，请直接查询或重新发起`);
    }
    if (!intent.confirmToken || intent.confirmToken !== params.confirmToken.trim()) {
      return this.fail("确认令牌无效：请重新发起支付以获取新的确认");
    }
    if (!intent.confirmExpiresAt || Date.parse(intent.confirmExpiresAt) < Date.now()) {
      return this.fail("确认已过期（10 分钟有效），请重新发起支付");
    }
    const auth =
      this.authorizations.getActive(intent.actorId, intent.channel) ??
      (intent.authorizationId ? this.store.getAuthorization(intent.authorizationId) : null);
    if (!auth) {
      return this.advance({ ...intent, authorizationId: null, status: "requires_authorization" });
    }
    return this.proceedWithAuth(intent, auth);
  }

  /**
   * 恢复一笔停在「待授权 / 已拦截 / 待确认」的意图。
   *
   * 典型场景：用户刚在授权页点了同意，或调高了额度——此时同一个 intent
   * 应能继续往下走，而不是让用户重新下单（重下单会换单号、丢业务上下文）。
   */
  async resumeIntent(intentId: string, actorId: string): Promise<CreateIntentResult> {
    const intent = this.store.getIntent(intentId);
    if (!intent || intent.actorId !== actorId.trim()) {
      return this.fail("支付意图不存在或不属于当前用户");
    }
    return this.advance(intent);
  }

  /**
   * 付款页上的「确认付款」按钮：用户在页面上选好付款方式后点一下，才真正扣款。
   *
   * 换付款方式（如电脑扫码 ↔ 手机网站支付）不重新要授权：授权按 provider 发，
   * 都属于「支付宝」。但额度是跨通道累计的，换通道绕不过日限额。
   * 令牌仍是必需项：没有令牌就只能拿到新的确认（下一步由页面展示按钮）。
   */
  async payIntent(params: {
    intentId: string;
    actorId: string;
    confirmToken?: string;
    channel?: PaymentChannelId;
  }): Promise<CreateIntentResult> {
    let intent = this.store.getIntent(params.intentId);
    if (!intent || intent.actorId !== params.actorId.trim()) {
      return this.fail("支付意图不存在或不属于当前用户");
    }
    if (intent.status === "paid" || intent.status === "refunded") {
      return this.resultFromIntent(intent, "paid");
    }

    if (params.channel && params.channel !== intent.channel) {
      const channel = this.channels.get(params.channel);
      const availability = channel?.availability();
      if (!channel || !availability?.available) {
        return this.fail(
          `${availability?.label ?? params.channel}当前不可用：${availability?.reason ?? "原因未知"}`,
        );
      }
      const switched = this.store.updateIntent(intent.id, {
        channel: params.channel,
        updated_at: nowIso(),
      });
      this.store.addEvent(intent.id, "channel_switched", { from: intent.channel, to: params.channel });
      intent = switched ?? { ...intent, channel: params.channel };

      // 令牌仍有效 = 用户这一下就是确认 → 按新通道重新判授权后直接执行
      if (!this.isConfirmTokenValid(intent, params.confirmToken)) return this.advance(intent);
      const auth = this.authorizations.getActive(intent.actorId, intent.channel);
      if (!auth) {
        return this.advance({ ...intent, authorizationId: null, status: "requires_authorization" });
      }
      return this.proceedWithAuth(intent, auth);
    }

    if (intent.status === "pending") return this.resultFromIntent(intent, "pay");

    if (intent.status === "requires_confirm") {
      if (!params.confirmToken) {
        return this.resultFromIntent(intent, "confirm", "缺少确认令牌：请在付款页点「确认付款」重新获取");
      }
      return this.confirmIntent({
        intentId: intent.id,
        actorId: intent.actorId,
        confirmToken: params.confirmToken,
      });
    }

    // requires_authorization / blocked 等状态交给统一推进入口
    return this.advance(intent);
  }

  /**
   * 付款页打开时用：只把意图推进到「待确认 + 新令牌」，**不扣款**。
   *
   * 用户刚在授权页点完同意回到付款页时，库里的意图还停在 requires_authorization；
   * 这里重跑一次授权判定，让它变成可付款状态。页面加载不该替用户花钱，
   * 所以即使金额在免确认额度内，也只发令牌、等用户点「确认付款」。
   */
  async prepareIntent(intentId: string, actorId: string): Promise<CreateIntentResult> {
    const intent = this.store.getIntent(intentId);
    if (!intent || intent.actorId !== actorId.trim()) {
      return this.fail("支付意图不存在或不属于当前用户");
    }
    return this.advance(intent, { prepareOnly: true });
  }

  /** 查询并推进状态：默认向渠道核对（pending 时）；paid/closed 直接返回本地终态。 */
  async queryIntent(intentId: string, actorId: string, options?: { sync?: boolean }): Promise<CreateIntentResult> {
    const intent = this.store.getIntent(intentId);
    if (!intent || intent.actorId !== actorId.trim()) {
      return this.fail("支付意图不存在或不属于当前用户");
    }
    if (intent.status !== "pending" || options?.sync === false) {
      return this.resultFromIntent(intent);
    }
    const channel = this.channels.get(intent.channel);
    if (!channel) return this.resultFromIntent(intent, "error", "渠道已下线，无法查询支付结果");

    const queried = await channel.query({
      intentId: intent.id,
      actorId: intent.actorId,
      channelOrderId: intent.channelOrderId,
      amountCents: intent.amountCents,
      subject: intent.subject,
    });
    if (queried.state === "paid") {
      const duration = Date.now() - Date.parse(intent.createdAt);
      // 沙箱/真实渠道都可能给出早于下单的支付时间；只要金额一致就以渠道为准
      const paid = this.markPaid(intent, {
        paidAt: queried.paidAt ?? nowIso(),
        payer: queried.payer,
        amountCents: queried.amountCents,
      });
      this.store.addEvent(intent.id, "channel_query_paid", { afterMs: duration });
      return this.resultFromIntent(paid ?? intent, "paid");
    }
    if (queried.state === "closed") {
      const updated = this.store.updateIntent(intent.id, { status: "closed", updated_at: nowIso() });
      this.store.addEvent(intent.id, "channel_query_closed");
      return this.resultFromIntent(updated ?? intent, "error", "订单已关闭（超时未付款）");
    }
    if (queried.state === "failed") {
      const updated = this.store.updateIntent(intent.id, {
        status: "failed",
        failure_reason: queried.error ?? "渠道支付失败",
        updated_at: nowIso(),
      });
      this.store.addEvent(intent.id, "channel_query_failed", { error: queried.error });
      return this.resultFromIntent(updated ?? intent, "error", queried.error ?? "渠道支付失败");
    }
    return this.resultFromIntent(intent, "pay");
  }

  /** 原路退款（渠道支持时）。amount 省略 = 全额退剩余。 */
  async refundIntent(params: {
    intentId: string;
    actorId: string;
    amount?: number;
    reason?: string;
  }): Promise<RefundIntentResult> {
    const intent = this.store.getIntent(params.intentId);
    if (!intent || intent.actorId !== params.actorId.trim()) {
      return { ok: false, intent: null, refundedAmount: 0, status: "error", message: "支付意图不存在或不属于当前用户", error: "not_found" };
    }
    if (intent.status !== "paid" && intent.status !== "refunded") {
      return {
        ok: false,
        intent: this.viewOf(intent),
        refundedAmount: centsToAmount(intent.refundedCents),
        status: intent.status,
        message: "只有已支付的订单可以退款",
        error: "not_paid",
      };
    }
    const channel = this.channels.get(intent.channel);
    if (!channel?.refund) {
      return {
        ok: false,
        intent: this.viewOf(intent),
        refundedAmount: centsToAmount(intent.refundedCents),
        status: intent.status,
        message: `${channel?.label ?? intent.channel} 不支持程序化退款，请人工处理`,
        error: "refund_unsupported",
      };
    }
    const remaining = intent.amountCents - intent.refundedCents;
    if (remaining <= 0) {
      return {
        ok: true,
        intent: this.viewOf(intent),
        refundedAmount: centsToAmount(intent.refundedCents),
        status: "refunded",
        message: "该订单已全额退款",
      };
    }
    const refundCents = params.amount === undefined ? remaining : amountToCents(params.amount);
    if (refundCents === null || refundCents <= 0 || refundCents > remaining) {
      return {
        ok: false,
        intent: this.viewOf(intent),
        refundedAmount: centsToAmount(intent.refundedCents),
        status: intent.status,
        message: `退款金额非法：可退 ¥${centsToAmount(remaining)}`,
        error: "invalid_amount",
      };
    }

    const channelRef = {
      intentId: intent.id,
      actorId: intent.actorId,
      channelOrderId: intent.channelOrderId,
      amountCents: intent.amountCents,
      subject: intent.subject,
    };
    let result;
    try {
      result = await channel.refund(channelRef, refundCents, params.reason);
    } catch (err) {
      return {
        ok: false,
        intent: this.viewOf(intent),
        refundedAmount: centsToAmount(intent.refundedCents),
        status: intent.status,
        message: `退款请求异常：${err instanceof Error ? err.message : String(err)}`,
        error: "exception",
      };
    }
    if (!result.ok) {
      return {
        ok: false,
        intent: this.viewOf(intent),
        refundedAmount: centsToAmount(intent.refundedCents),
        status: intent.status,
        message: result.error ?? "退款失败",
        error: "channel_error",
      };
    }
    if (result.status === "pending") {
      this.store.addEvent(intent.id, "refund_pending", { refundCents, reason: params.reason });
      return {
        ok: true,
        intent: this.viewOf(intent),
        refundedAmount: centsToAmount(intent.refundedCents),
        status: "refund_pending",
        message: "退款已提交，支付宝确认资金退回后才会记为已退款；未到账前不假报成功",
      };
    }

    const newRefunded = Math.min(intent.amountCents, intent.refundedCents + refundCents);
    const updated = this.store.updateIntent(intent.id, {
      refunded_cents: newRefunded,
      status: newRefunded >= intent.amountCents ? "refunded" : "paid",
      updated_at: nowIso(),
    });
    this.store.addEvent(intent.id, "refund_success", { refundCents, reason: params.reason, totalRefunded: newRefunded });
    return {
      ok: true,
      intent: updated ? this.viewOf(updated) : this.viewOf(intent),
      refundedAmount: centsToAmount(newRefunded),
      status: newRefunded >= intent.amountCents ? "refunded" : "partial_refunded",
      message: `已退款 ¥${centsToAmount(refundCents)}，剩余可退 ¥${centsToAmount(intent.amountCents - newRefunded)}`,
    };
  }

  listIntents(actorId: string, limit = 50): PaymentIntentView[] {
    return this.store.listIntents(actorId.trim(), limit).map((i) => this.viewOf(i));
  }

  getIntentView(intentId: string, actorId: string): PaymentIntentView | null {
    const intent = this.store.getIntent(intentId);
    if (!intent || intent.actorId !== actorId.trim()) return null;
    return this.viewOf(intent);
  }

  /** 收银台表单 HTML（仅渠道产出过才有）；路由按 intent id 直取，不做归属校验。 */
  paymentHtmlOf(intentId: string): string | null {
    return this.store.getIntent(intentId)?.paymentHtml ?? null;
  }

  /** 联调/测试用：把意图标记为已支付（仅 mock 渠道，绝不用于真实渠道）。 */
  mockMarkPaid(intentId: string): CreateIntentResult {
    const intent = this.store.getIntent(intentId);
    if (!intent) return this.fail("支付意图不存在");
    if (intent.channel !== "mock") return this.fail("只有 mock 渠道支持模拟支付完成");
    // 同步 mock 渠道内部状态，让后续 query/refund 与本地状态一致
    const channel = this.channels.get("mock");
    const settle = (channel as { markPaid?: (id: string) => void } | null)?.markPaid;
    if (typeof settle === "function") settle.call(channel, intentId);
    const paid = this.markPaid(intent, { paidAt: nowIso(), payer: "mock" });
    return this.resultFromIntent(paid ?? intent, "paid");
  }

  // ───────────────────────── 内部：状态推进 ─────────────────────────

  /** 依据当前授权状态把意图推进到下一步（新建与幂等命中共用同一条路径）。 */
  private async advance(
    intent: PaymentIntent,
    options?: { prepareOnly?: boolean },
  ): Promise<CreateIntentResult> {
    if (intent.status === "paid" || intent.status === "refunded") {
      return this.resultFromIntent(intent, "paid");
    }
    if (intent.status === "pending") {
      return this.resultFromIntent(intent, "pay");
    }
    if (intent.status === "requires_confirm") {
      if (intent.confirmToken && intent.confirmExpiresAt && Date.parse(intent.confirmExpiresAt) > Date.now()) {
        return {
          ok: true,
          nextAction: "confirm",
          intent: this.viewOf(intent),
          confirmToken: intent.confirmToken,
          confirmExpiresAt: intent.confirmExpiresAt,
          payPageUrl: this.payPageUrlFor(intent, intent.confirmToken),
          message: `已准备支付 ¥${centsToAmount(intent.amountCents)}（${intent.subject}），等你确认后扣款；确认 10 分钟内有效`,
        };
      }
      // 令牌过期：走正常流程重新出确认
    }
    if (intent.status === "failed" || intent.status === "closed") {
      return this.resultFromIntent(intent, "error", intent.failureReason ?? "该支付已结束，请重新发起");
    }

    // 全局护栏（管理员硬边界）：在任何扣款动作之前
    const blocked = this.checkGlobalGuardrails(intent);
    if (blocked) {
      const updated = this.store.updateIntent(intent.id, {
        status: "blocked",
        failure_reason: blocked,
        updated_at: nowIso(),
      });
      this.store.addEvent(intent.id, "blocked", { reason: blocked });
      return this.resultFromIntent(updated ?? intent, "blocked", blocked);
    }

    const auth = this.authorizations.getActive(intent.actorId, intent.channel);
    if (!auth) {
      const updated = this.store.updateIntent(intent.id, {
        status: "requires_authorization",
        authorization_id: null,
        confirm_token: null,
        confirm_expires_at: null,
        failure_reason: null,
        updated_at: nowIso(),
      });
      const current = updated ?? intent;
      const payUrlForPage = this.payPageUrlFor(current);
      return {
        ok: false,
        nextAction: "authorize",
        intent: this.viewOf(current),
        authorizationUrl: authorizationPageUrl({
          actorId: intent.actorId,
          channel: intent.channel,
          amountCny: centsToAmount(intent.amountCents),
          subject: intent.subject,
          bizDomain: intent.bizDomain,
          returnTo: payUrlForPage,
        }),
        payPageUrl: payUrlForPage,
        message:
          `这笔 ¥${centsToAmount(intent.amountCents)} 的支付需要你的授权：` +
          `请打开授权页设置额度并同意后，我再发起扣款（未授权前不会产生任何扣款）`,
        error: "authorization_required",
      };
    }

    const decision = this.authorizations.evaluate(auth, {
      amountCents: intent.amountCents,
      category: intent.category,
    });
    if (!decision.allowed) {
      const updated = this.store.updateIntent(intent.id, {
        status: "blocked",
        authorization_id: auth.id,
        failure_reason: decision.reason ?? "超出授权范围",
        updated_at: nowIso(),
      });
      this.store.addEvent(intent.id, "blocked", { reason: decision.reason, authorizationId: auth.id });
      return this.resultFromIntent(updated ?? intent, "blocked", decision.reason);
    }

    // 付款页只做准备时不在这里执行渠道下单：发令牌、等用户点「确认付款」
    if (decision.needsConfirm || options?.prepareOnly) {
      const token = newConfirmToken();
      const expiresAt = new Date(Date.now() + CONFIRM_TTL_MS).toISOString();
      const updated = this.store.updateIntent(intent.id, {
        status: "requires_confirm",
        authorization_id: auth.id,
        confirm_token: token,
        confirm_expires_at: expiresAt,
        failure_reason: null,
        updated_at: nowIso(),
      });
      this.store.addEvent(intent.id, "confirm_required", {
        authorizationId: auth.id,
        amountCents: intent.amountCents,
      });
      const current = updated ?? intent;
      return {
        ok: true,
        nextAction: "confirm",
        intent: this.viewOf(current),
        confirmToken: token,
        confirmExpiresAt: expiresAt,
        payPageUrl: this.payPageUrlFor(current, token),
        message: decision.needsConfirm
          ? `已准备支付 ¥${centsToAmount(intent.amountCents)}（${intent.subject}）。` +
            `该金额超过免确认额度，需要你明确确认后才扣款；确认 10 分钟内有效`
          : `已准备支付 ¥${centsToAmount(intent.amountCents)}（${intent.subject}），点「确认付款」后立即扣款`,
      };
    }

    return this.executeIntent({ ...intent, authorizationId: auth.id }, auth);
  }

  private async executeIntent(intent: PaymentIntent, auth: PaymentAuthorization): Promise<CreateIntentResult> {
    const channel = this.channels.get(intent.channel);
    if (!channel) {
      return this.fail("渠道已下线，无法支付");
    }
    const checkoutUrl = `${this.baseUrl().replace(/\/+$/, "")}/payment/intent/${intent.id}/checkout`;
    const created = await channel.create({
      intentId: intent.id,
      actorId: intent.actorId,
      amountCents: intent.amountCents,
      subject: intent.subject,
      category: intent.category,
      bizDomain: intent.bizDomain,
      ...(intent.bizRefId ? { bizRefId: intent.bizRefId } : {}),
      ...(intent.merchant ? { merchant: intent.merchant } : {}),
      ...(intent.cashierUrl ? { cashierUrl: intent.cashierUrl } : {}),
      ...(this.lastInputSessionId ? { sessionId: this.lastInputSessionId } : {}),
      checkoutUrl,
      // 手机网站支付付完要回到付款页（页面会自动查单确认）
      returnUrl: this.payPageUrlFor(intent),
    });

    if (!created.ok) {
      const updated = this.store.updateIntent(intent.id, {
        status: "failed",
        authorization_id: auth.id,
        failure_reason: created.error ?? "渠道下单失败",
        updated_at: nowIso(),
      });
      this.store.addEvent(intent.id, "channel_create_failed", { error: created.error });
      return this.resultFromIntent(updated ?? intent, "error", created.error ?? "渠道下单失败");
    }

    if (created.status === "paid") {
      const paid = this.markPaid(intent, {
        paidAt: created.paidAt ?? nowIso(),
        channelOrderId: created.channelOrderId,
        payer: "channel",
      });
      return this.resultFromIntent(paid ?? intent, "paid");
    }

    const qrCodeDataUrl = await this.renderQr(created.payUrl);
    const updated = this.store.updateIntent(intent.id, {
      status: "pending",
      authorization_id: auth.id,
      confirm_token: null,
      confirm_expires_at: null,
      channel_order_id: created.channelOrderId ?? null,
      pay_url: created.payUrl ?? null,
      payment_html: created.paymentHtml ?? null,
      qr_code_data_url: qrCodeDataUrl,
      failure_reason: null,
      updated_at: nowIso(),
    });
    this.store.touchAuthorization(auth.id, nowIso());
    this.store.addEvent(intent.id, "channel_created", {
      channel: intent.channel,
      channelOrderId: created.channelOrderId,
    });
    const current = updated ?? intent;
    const mode = channel.availability().mode;
    return {
      ok: true,
      nextAction: "pay",
      intent: this.viewOf(current),
      payPageUrl: this.payPageUrlFor(current),
      message:
        mode === "mock"
          ? `【模拟支付】已生成模拟收款单 ¥${centsToAmount(intent.amountCents)}，不会产生真实扣款`
          : `收款单已生成：¥${centsToAmount(intent.amountCents)}（${intent.subject}）。请扫码或打开收银台完成支付`,
    };
  }

  private markPaid(
    intent: PaymentIntent,
    info: { paidAt: string; channelOrderId?: string; payer?: string; amountCents?: number },
  ): PaymentIntent | null {
    if (intent.status === "paid" || intent.status === "refunded") return intent;
    if (info.amountCents != null && info.amountCents !== intent.amountCents) {
      // 金额不一致：绝不标记成功，留待人工核对（渠道侧事实与本地意图不符）
      this.store.updateIntent(intent.id, {
        status: "failed",
        failure_reason: `渠道金额 ¥${centsToAmount(info.amountCents)} 与订单金额 ¥${centsToAmount(intent.amountCents)} 不一致，已拒绝自动入账`,
        updated_at: nowIso(),
      });
      this.store.addEvent(intent.id, "amount_mismatch", {
        expected: intent.amountCents,
        actual: info.amountCents,
      });
      return null;
    }
    const updated = this.store.updateIntent(intent.id, {
      status: "paid",
      paid_at: info.paidAt,
      confirm_token: null,
      confirm_expires_at: null,
      failure_reason: null,
      ...(info.channelOrderId ? { channel_order_id: info.channelOrderId } : {}),
      updated_at: nowIso(),
    });
    if (!updated) return null;
    if (intent.authorizationId) this.store.touchAuthorization(intent.authorizationId, nowIso());
    this.store.addEvent(intent.id, "paid", {
      paidAt: info.paidAt,
      payer: info.payer,
      amountCents: updated.amountCents,
      channel: updated.channel,
    });
    for (const listener of this.paidListeners) {
      try {
        listener(updated);
      } catch (err) {
        console.error("[unified-payment] paid listener failed:", err instanceof Error ? err.message : err);
      }
    }
    return updated;
  }

  // ───────────────────────── 内部：辅助 ─────────────────────────

  private resolveChannel(
    requested: "auto" | PaymentChannelId,
    needsCashier: boolean,
  ): { channel: ReturnType<ChannelRegistry["get"]>; error?: string } {
    if (requested !== "auto") {
      const channel = this.channels.get(requested);
      if (!channel) return { channel: null, error: `未知支付渠道：${requested}` };
      const availability = channel.availability();
      if (!availability.available) {
        return { channel: null, error: `${availability.label}当前不可用：${availability.reason ?? "原因未知"}` };
      }
      return { channel };
    }
    const direction = needsCashier ? "pay" : "collect";
    const picked = this.channels.pick(direction, this.allowMock());
    if (picked) return { channel: picked };
    const reasons = this.channels
      .availability()
      .filter((c) => c.direction === direction)
      .map((c) => `${c.label}：${c.reason ?? "不可用"}`)
      .join("；");
    return {
      channel: null,
      error:
        direction === "pay"
          ? `没有可用的代付渠道。${reasons || "请先配置代付通道"}`
          : `没有可用的收款渠道。${reasons || "请先配置支付通道"}`,
    };
  }

  private allowMock(): boolean {
    const flag = process.env.PAYMENT_MOCK_ENABLED?.trim();
    if (flag === "0") return false;
    if (process.env.NODE_ENV === "production") return flag === "1";
    return true;
  }

  private checkGlobalGuardrails(intent: PaymentIntent): string | null {
    const guardrail = getPaymentGuardrailConfig();
    const amountCny = centsToAmount(intent.amountCents);
    if (
      !guardrail.allowedCategories.includes("*") &&
      !guardrail.allowedCategories.includes(intent.category)
    ) {
      return (
        `支付护栏：业务类别「${intent.category}」未授权代付（当前放行：${guardrail.allowedCategories.join("、")}）。` +
        `需要管理员在 PAYMENT_ALLOWED_CATEGORIES 中放行`
      );
    }
    if (guardrail.maxSingleAmountCny > 0 && amountCny > guardrail.maxSingleAmountCny) {
      return `支付护栏：单笔上限 ¥${guardrail.maxSingleAmountCny}，本次 ¥${amountCny}。需要用户确认后调整 PAYMENT_MAX_SINGLE_CNY`;
    }
    if (guardrail.dailyBudgetCny > 0) {
      const used = centsToAmount(this.store.sumCommittedAllChannelsSince(intent.actorId, startOfDayIso()));
      if (used + amountCny > guardrail.dailyBudgetCny) {
        return (
          `支付护栏：今日累计 ¥${used.toFixed(2)} / 上限 ¥${guardrail.dailyBudgetCny}，本次 ¥${amountCny} 将超额。` +
          `需要用户确认后调整 PAYMENT_DAILY_BUDGET_CNY`
        );
      }
    }
    return null;
  }

  private async renderQr(payUrl: string | undefined): Promise<string | null> {
    if (!payUrl) return null;
    // mock:// 之类的非扫码地址不生成二维码，避免给用户一张扫不出东西的图
    if (!/^https?:\/\//i.test(payUrl) && !/^weixin:\/\//i.test(payUrl)) return null;
    try {
      return await QRCode.toDataURL(payUrl, {
        width: 320,
        margin: 2,
        color: { dark: "#000000", light: "#ffffff" },
      });
    } catch {
      return null;
    }
  }

  private viewOf(intent: PaymentIntent): PaymentIntentView {
    const channel = this.channels.get(intent.channel);
    return {
      id: intent.id,
      status: intent.status,
      actorId: intent.actorId,
      bizDomain: intent.bizDomain,
      bizRefId: intent.bizRefId,
      merchant: intent.merchant,
      subject: intent.subject,
      amount: centsToAmount(intent.amountCents),
      category: intent.category,
      channel: intent.channel,
      channelLabel: channel?.label ?? intent.channel,
      mode: channel?.availability().mode ?? "mock",
      payUrl: intent.payUrl,
      qrCodeDataUrl: intent.qrCodeDataUrl,
      refundedAmount: centsToAmount(intent.refundedCents),
      failureReason: intent.failureReason,
      createdAt: intent.createdAt,
      paidAt: intent.paidAt,
    };
  }

  private resultFromIntent(
    intent: PaymentIntent,
    nextAction?: NextAction,
    error?: string,
  ): CreateIntentResult {
    const action: NextAction =
      nextAction ??
      (intent.status === "paid" || intent.status === "refunded"
        ? "paid"
        : intent.status === "pending"
          ? "pay"
          : intent.status === "requires_confirm"
            ? "confirm"
            : intent.status === "requires_authorization"
              ? "authorize"
              : intent.status === "blocked"
                ? "blocked"
                : "error");
    const amount = centsToAmount(intent.amountCents);
    const message =
      error ??
      (action === "paid"
        ? `已确认支付成功 ¥${amount}`
        : action === "pay"
          ? `等待付款 ¥${amount}（${intent.subject}）`
          : action === "confirm"
            ? `等待你确认支付 ¥${amount}`
            : action === "authorize"
              ? `需要授权后才能支付 ¥${amount}`
              : action === "blocked"
                ? intent.failureReason ?? "支付被拦截"
                : "支付未完成");
    return {
      ok: intent.status !== "failed" && intent.status !== "blocked",
      nextAction: action,
      intent: this.viewOf(intent),
      payPageUrl: this.payPageUrlFor(intent),
      ...(action === "authorize"
        ? {
            authorizationUrl: authorizationPageUrl({
              actorId: intent.actorId,
              channel: intent.channel,
              amountCny: amount,
              subject: intent.subject,
              bizDomain: intent.bizDomain,
              returnTo: this.payPageUrlFor(intent),
            }),
          }
        : {}),
      message,
      ...(error ? { error } : {}),
    };
  }

  private payPageUrlFor(intent: PaymentIntent, token?: string | null): string {
    const base = this.baseUrl().replace(/\/+$/, "");
    const url = new URL(`${base}/payment/pay`);
    url.searchParams.set("intentId", intent.id);
    url.searchParams.set("actorId", intent.actorId);
    const t = token ?? (intent.status === "requires_confirm" ? intent.confirmToken : null);
    if (t) url.searchParams.set("t", t);
    return url.toString();
  }

  private fail(message: string): CreateIntentResult {
    return {
      ok: false,
      nextAction: "error",
      intent: null,
      message,
      error: message,
    };
  }

  // ───────────────────────── 对账 ─────────────────────────

  /** 后台对账：pending 意图持续向渠道核对，用户关页也不影响最终一致。 */
  startReconciliation(): void {
    if (this.reconcileTimer) return;
    this.reconcileTimer = setInterval(() => {
      void this.reconcileOnce().catch((err) => {
        console.error("[unified-payment] reconcile failed:", err instanceof Error ? err.message : err);
      });
    }, RECONCILE_INTERVAL_MS);
    this.reconcileTimer.unref();
  }

  stopReconciliation(): void {
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.reconcileTimer = null;
  }

  async reconcileOnce(): Promise<void> {
    const now = Date.now();
    for (const intent of this.store.listPendingIntents(50)) {
      const age = now - Date.parse(intent.createdAt);
      if (age < 10_000) continue;
      if (age > MAX_PENDING_AGE_MS) continue;
      if (intent.channel === "mock") continue;
      try {
        await this.queryIntent(intent.id, intent.actorId);
      } catch (err) {
        console.error(
          "[unified-payment] reconcile intent failed:",
          intent.id,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }
}

let sharedService: UnifiedPaymentService | null = null;

export function initUnifiedPaymentService(options: UnifiedPaymentServiceOptions): UnifiedPaymentService {
  if (!sharedService) {
    sharedService = new UnifiedPaymentService(options);
    sharedService.startReconciliation();
  }
  return sharedService;
}

export function getUnifiedPaymentService(): UnifiedPaymentService | null {
  return sharedService;
}

/**
 * 内部读取：渠道落库的收银台 HTML（含签名表单，体积大，不放进 intent view）。
 * 仅给收银台路由用——优先走已装配的门面（其 store 才是运行期真实库）。
 */
export function getIntentPaymentHtml(intentId: string): string | null {
  if (sharedService) return sharedService.paymentHtmlOf(intentId);
  const store = getUnifiedPaymentStore();
  return store.getIntent(intentId)?.paymentHtml ?? null;
}

export function setUnifiedPaymentService(service: UnifiedPaymentService | null): void {
  sharedService = service;
}

/** 金额格式化（工具回执统一用两位小数）。 */
export function formatAmount(cents: number): string {
  return centsToAmountString(cents);
}
