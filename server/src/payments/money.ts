/**
 * 金额定点工具：模块内一律整数分，边界转元。
 *
 * 与 webpay-amount.ts 的 BigInt 方案互补：网页收款单笔上限可到 1 亿元，
 * 需要 BigInt；统一支付模块的业务金额在 0.01 ~ 100 万元区间，用 number 分
 * 足够且与台账 REAL 元字段互转不丢精度（≤ 2^53 分 = 9e13 元）。
 */

export const MAX_AMOUNT_CENTS = 100_000_000; // 100 万元上限，超出视为异常输入

/** 元 → 分。非法/超范围返回 null（调用方必须显式处理，不做兜底猜测）。 */
export function amountToCents(value: unknown): number | null {
  if (typeof value === "string") value = value.trim();
  if (value === "" || value === null || value === undefined) return null;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const cents = Math.round(n * 100);
  if (cents < 1 || cents > MAX_AMOUNT_CENTS) return null;
  // 不接受超过两位小数的输入（0.005 元这类「半分」无法结算，宁可拒绝）
  if (Math.abs(n * 100 - cents) > 1e-6) return null;
  return cents;
}

/** 分 → 元（保留两位的 number）。 */
export function centsToAmount(cents: number): number {
  return Math.round(cents) / 100;
}

/** 分 → 元字符串（"12.30"），用于渠道 API 的金额字段。 */
export function centsToAmountString(cents: number): string {
  return (Math.round(cents) / 100).toFixed(2);
}

/** 元字符串/数字等值比较（容忍 "12.3" 与 "12.30"）。 */
export function amountEquals(a: unknown, b: unknown): boolean {
  const ca = amountToCents(a);
  const cb = amountToCents(b);
  return ca !== null && cb !== null && ca === cb;
}
