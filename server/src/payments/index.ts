/**
 * 统一支付模块公共出口。
 *
 * 外部只需要：
 *   - UnifiedPaymentService / initUnifiedPaymentService / getUnifiedPaymentService
 *   - 类型（types.ts）
 * 其它（store / channel 适配器）是实现细节，业务方不要直接依赖。
 */

export * from "./types.js";
export {
  UnifiedPaymentService,
  initUnifiedPaymentService,
  getUnifiedPaymentService,
  setUnifiedPaymentService,
  type UnifiedPaymentServiceOptions,
  type RefundIntentResult,
} from "./unified-payment-service.js";
export { PaymentAuthorizationService, defaultLimits, AUTHORIZATION_CONSENT_VERSION } from "./authorization-service.js";
export { ChannelRegistry } from "./channels/index.js";
export { UnifiedPaymentStore, getUnifiedPaymentStore, setUnifiedPaymentStore } from "./store.js";
export { resolvePublicBaseUrl, authorizationPageUrl } from "./base-url.js";
export { amountToCents, centsToAmount, centsToAmountString } from "./money.js";
