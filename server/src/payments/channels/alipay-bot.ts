import type { AlipayBotService } from "../../services/alipay-bot-service.js";
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
 * 支付宝 AI 支付渠道（钱包授权 + 收银台代付）。
 *
 * 这是唯一「代用户付款」的通道：用户在支付宝 App 内扫码授权自己的钱包，
 * 之后 agent 通过 alipay-bot CLI 提交商家收银台链接，用户在支付宝内确认
 * 后从本人账户扣款。agent 不持有任何支付凭证。
 *
 * 现实约束（必须显式暴露，不许静默降级）：
 *   - CLI 二进制在 `server/alipay-bot-cli/runtime/dist`，该目录缺失时渠道
 *     直接标记不可用，由门面返回可执行的修复提示；
 *   - 每个用户必须单独扫码授权（钱包按 actorId 隔离），未授权时返回
 *     `requires_authorization` 语义给上层，而不是抛错。
 */

/** 从 CLI 输出提取支付宝查询单号（outShakeNo）。 */
export function extractOutShakeNo(stdout: string): string {
  if (!stdout) return "";
  const jsonMatch = /"(?:outShakeNo|out_shake_no|orderNo|order_no)"\s*:\s*"([^"]+)"/.exec(stdout);
  if (jsonMatch) return jsonMatch[1];
  const textMatch = /(?:订单号|查询单号|支付单号)[:：]\s*([A-Za-z0-9_-]{6,})/.exec(stdout);
  return textMatch ? textMatch[1] : "";
}

/** 支付状态启发式判定（CLI 输出非结构化，按关键词分类）。 */
export function classifyPaymentStatus(stdout: string): "paid" | "failed" | "pending" | "unknown" {
  const text = stdout ?? "";
  if (/支付成功|已成功支付|付款成功|交易成功|TRADE_SUCCESS|"success"\s*:\s*true/i.test(text)) return "paid";
  if (/支付失败|付款失败|交易失败|已关闭|已超时|TRADE_(CLOSED|FAILED)/i.test(text)) return "failed";
  if (/待支付|等待(用户)?(支付|付款)|二维码|请扫|WAIT_BUYER_PAY/i.test(text)) return "pending";
  return "unknown";
}

export class AlipayBotChannel implements PaymentChannel {
  readonly id = "alipay_bot" as const;
  readonly label = "支付宝 AI 支付（钱包代付）";
  readonly direction = "pay" as const;
  readonly audience = "all" as const;

  constructor(private readonly service: AlipayBotService) {}

  availability(): ChannelAvailability {
    const available = this.service.isAvailable();
    return {
      channel: this.id,
      label: this.label,
      direction: this.direction,
      audience: this.audience,
      available,
      mode: "live",
      ...(available
        ? {}
        : {
            reason:
              "支付宝 AI 支付 CLI 未就绪（server/alipay-bot-cli/runtime/dist/cli.js 缺失）。" +
              "补齐 CLI runtime/dist 后无需改代码即可启用；在此之前代付能力只能走商户资质渠道。",
          }),
      capabilities: { qr: false, redirect: false, refund: false, needsCashierUrl: true },
    };
  }

  async create(input: ChannelCreateInput): Promise<ChannelCreateResult> {
    if (!this.service.isAvailable()) {
      return { ok: false, status: "failed", error: this.availability().reason ?? "渠道不可用" };
    }
    const cashierUrl = input.cashierUrl?.trim() ?? "";
    if (!cashierUrl) {
      return {
        ok: false,
        status: "failed",
        error: "代付渠道需要商家收银台链接/订单串（cashierUrl）；请先用下单能力拿到支付页链接",
      };
    }
    const sessionId = input.sessionId?.trim() ?? "";
    if (!sessionId) {
      return { ok: false, status: "failed", error: "缺少真实业务会话 ID（sessionId）" };
    }

    const wallet = this.service.forUser(input.actorId);
    let walletStatus;
    try {
      walletStatus = await wallet.checkWallet();
    } catch (err) {
      return {
        ok: false,
        status: "failed",
        error: `支付宝钱包状态查询失败：${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (walletStatus.code !== 200) {
      return {
        ok: false,
        status: "failed",
        error:
          walletStatus.status === "not_opened"
            ? "该用户支付宝钱包尚未授权：请先在应用内完成 alipay.apply-wallet → 用户扫码 → alipay.bind-wallet"
            : `支付宝钱包不可用：${walletStatus.message || walletStatus.status}`,
      };
    }

    const summary = `服务内容：${input.subject}，支付金额：¥${(input.amountCents / 100).toFixed(2)}，支付对象：${input.merchant ?? "商户"}`;
    const result = await wallet.submitPayment(sessionId, cashierUrl, summary);
    const outShakeNo = extractOutShakeNo(result.stdout);
    const status = classifyPaymentStatus(result.stdout);
    if (!result.ok && status !== "paid" && status !== "pending") {
      return { ok: false, status: "failed", error: result.error ?? "发起支付宝支付失败", raw: result.stdout };
    }
    if (status === "paid") {
      return {
        ok: true,
        status: "paid",
        paidAt: new Date().toISOString(),
        ...(outShakeNo ? { channelOrderId: outShakeNo } : {}),
        raw: result.stdout,
      };
    }
    return {
      ok: true,
      status: "pending",
      ...(outShakeNo ? { channelOrderId: outShakeNo } : {}),
      payUrl: cashierUrl,
      raw: result.stdout,
    };
  }

  async query(ref: ChannelPaymentRef): Promise<ChannelQueryResult> {
    if (!ref.channelOrderId) return { state: "unknown", error: "缺少支付宝查询单号（outShakeNo）" };
    const result = await this.service
      .forUser(ref.actorId)
      .queryPaymentStatus({ outShakeNo: ref.channelOrderId });
    const status = classifyPaymentStatus(result.stdout);
    if (status === "paid") {
      return { state: "paid", paidAt: new Date().toISOString(), amountCents: ref.amountCents, raw: result.stdout };
    }
    if (status === "failed") return { state: "failed", raw: result.stdout };
    if (status === "pending") return { state: "pending", raw: result.stdout };
    return { state: "unknown", error: result.error, raw: result.stdout };
  }

  async refund(): Promise<ChannelRefundResult> {
    return {
      ok: false,
      status: "error",
      error: "支付宝 AI 支付不支持程序化退款：退款需用户在支付宝 App 内向商户发起，或由商户侧原路退回",
    };
  }
}
