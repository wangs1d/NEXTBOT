import type { AlipayBotService } from "../../services/alipay-bot-service.js";
import type { PaymentService } from "../../services/payment-service.js";
import type { ChannelAvailability, ChannelDirection, PaymentChannelId } from "../types.js";
import { AlipayBotChannel } from "./alipay-bot.js";
import { AlipayQrChannel } from "./alipay-qr.js";
import { AlipaySandboxChannel } from "./alipay-sandbox.js";
import { AlipayWapChannel } from "./alipay-wap.js";
import { MockChannel } from "./mock.js";
import type { PaymentChannel } from "./types.js";
import { WechatChannel } from "./wechat.js";

export * from "./types.js";
export {
  AlipayBotChannel,
  AlipayQrChannel,
  AlipaySandboxChannel,
  AlipayWapChannel,
  MockChannel,
  WechatChannel,
};

/**
 * 渠道注册表：可用性查询 + 自动选路。
 *
 * 选路顺序是**业务语义**，不是随意排序：
 *   - 需要代付（有商家收银台链接）→ 只能 pay 方向渠道（支付宝 AI 支付）；
 *   - 站内收款 → 优先真实/沙箱通道（支付宝网页收款、微信商户号），
 *     最后才是 mock；mock 命中时上层必须显著标注「模拟」。
 * 指定渠道时不做降级：不可用就如实报错，避免用户以为走了支付宝其实走了 mock。
 */
export class ChannelRegistry {
  private readonly channels: Map<PaymentChannelId, PaymentChannel>;

  constructor(channels: PaymentChannel[]) {
    this.channels = new Map(channels.map((c) => [c.id, c]));
  }

  static createDefault(deps: { alipayBotService: AlipayBotService; paymentService: PaymentService }): ChannelRegistry {
    return new ChannelRegistry([
      // 收款：电脑扫码 / 手机网站支付，各自只在自己的端出现；
      // 网页收银台（page.pay）是电脑端兜底，手机端不展示（手机付不了这个页面）。
      new AlipayQrChannel(),
      new AlipayWapChannel(),
      new AlipaySandboxChannel(),
      new AlipayBotChannel(deps.alipayBotService),
      new WechatChannel(deps.paymentService),
      new MockChannel(),
    ]);
  }

  get(id: PaymentChannelId): PaymentChannel | null {
    return this.channels.get(id) ?? null;
  }

  availability(): ChannelAvailability[] {
    return Array.from(this.channels.values()).map((c) => c.availability());
  }

  availabilityOf(id: PaymentChannelId): ChannelAvailability | null {
    return this.get(id)?.availability() ?? null;
  }

  /**
   * 自动选路：返回第一个可用渠道。
   * @param direction 资金方向
   * @param allowMock 是否允许落到 mock（仅开发/测试；由调用方按环境决定）
   */
  pick(direction: ChannelDirection, allowMock: boolean): PaymentChannel | null {
    const order: PaymentChannelId[] =
      direction === "pay"
        ? ["alipay_bot", "mock"]
        : ["alipay_qr", "alipay_sandbox", "wechat", "mock"];
    for (const id of order) {
      const channel = this.channels.get(id);
      if (!channel) continue;
      // 方向必须匹配：mock 只能收款，不能假装能代付（否则代付会静默变成假单）
      if (channel.direction !== direction) continue;
      if (channel.id === "mock" && !allowMock) continue;
      if (channel.availability().available) return channel;
    }
    return null;
  }
}
