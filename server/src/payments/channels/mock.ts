import { randomBytes } from "node:crypto";

import type { ChannelAvailability } from "../types.js";
import type {
  ChannelCreateInput,
  ChannelCreateResult,
  ChannelPaymentRef,
  ChannelQueryResult,
  ChannelRefundResult,
  PaymentChannel,
} from "./types.js";

/**
 * 本地模拟渠道：只用于开发联调与自动化测试。
 *
 * 与既有 PaymentService 的 mock 模式一致的做法——不落真实台账、不触网，
 * 但这里更进一步：mock 渠道在 UI/工具回执里必须显式标注 mode=mock，
 * 避免「模拟支付成功」被当成真实到账（历史上这是最贵的假成功）。
 */
export class MockChannel implements PaymentChannel {
  readonly id = "mock" as const;
  readonly label = "模拟支付（仅开发）";
  readonly direction = "collect" as const;
  readonly audience = "all" as const;

  private readonly paid = new Set<string>();
  private readonly closed = new Set<string>();

  availability(): ChannelAvailability {
    const disabledByEnv = process.env.PAYMENT_MOCK_ENABLED?.trim() === "0";
    const productionDefaultOff = process.env.NODE_ENV === "production" && process.env.PAYMENT_MOCK_ENABLED?.trim() !== "1";
    const available = !disabledByEnv && !productionDefaultOff;
    return {
      channel: this.id,
      label: this.label,
      direction: this.direction,
      audience: this.audience,
      available,
      mode: "mock",
      ...(available ? {} : { reason: "模拟支付已关闭（生产环境默认关闭；开发可用 PAYMENT_MOCK_ENABLED=1 打开）" }),
      capabilities: { qr: false, redirect: true, refund: true, needsCashierUrl: false },
    };
  }

  async create(input: ChannelCreateInput): Promise<ChannelCreateResult> {
    const channelOrderId = `MOCK${randomBytes(6).toString("hex").toUpperCase()}`;
    return {
      ok: true,
      channelOrderId,
      status: "pending",
      payUrl: `mockpay://intent/${input.intentId}`,
    };
  }

  async query(ref: ChannelPaymentRef): Promise<ChannelQueryResult> {
    if (this.paid.has(ref.intentId)) {
      return { state: "paid", paidAt: new Date().toISOString(), amountCents: ref.amountCents, payer: "mock" };
    }
    if (this.closed.has(ref.intentId)) return { state: "closed" };
    return { state: "pending" };
  }

  async refund(ref: ChannelPaymentRef, refundCents: number): Promise<ChannelRefundResult> {
    if (!this.paid.has(ref.intentId)) {
      return { ok: false, status: "error", error: "模拟订单未支付，不可退款" };
    }
    return { ok: true, status: "success", refundedCents: refundCents };
  }

  /** 测试/联调用：把某个意图标记为已支付（不是真实资金）。 */
  markPaid(intentId: string): void {
    this.paid.add(intentId);
  }

  markClosed(intentId: string): void {
    this.closed.add(intentId);
  }
}
