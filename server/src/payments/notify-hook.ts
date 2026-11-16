import type { PaymentChannelId } from "./types.js";

/**
 * 支付通知 → 意图收敛的最小桥。
 *
 * 为什么不让路由直接依赖 UnifiedPaymentService：
 *   - webpay / 支付宝通知路由是自包含的（不拿 deps），引入门面会形成环；
 *   - 通知只是「提示有变化」，真正的事实仍由主动查单确认，所以桥断了也不影响
 *     正确性——15s 对账循环会兜底，这里只负责把时延从「十几秒」压到「一次往返」。
 *
 * 约定：handler 永远做异步查单，绝不用通知里的字段直接改本地状态。
 */

export type PaymentNotifyHandler = (
  channelId: PaymentChannelId,
  channelOrderId: string,
) => void;

let handler: PaymentNotifyHandler | null = null;

export function setPaymentNotifyHandler(next: PaymentNotifyHandler | null): void {
  handler = next;
}

/** 发一条通知事件（channelOrderId 为空则忽略）。永不抛错。 */
export function emitPaymentNotify(channelId: PaymentChannelId, channelOrderId: string | null | undefined): void {
  const id = channelOrderId?.trim();
  if (!id || !handler) return;
  try {
    handler(channelId, id);
  } catch (err) {
    console.error("[payment-notify] handler failed:", err instanceof Error ? err.message : err);
  }
}
