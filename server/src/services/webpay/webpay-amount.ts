/** 金额十进制定点语义：内部一律以“分”(bigint)计算，对外展示为元两位小数字符串。 */

export function parseAmountToCents(value: unknown): bigint | null {
  if (value == null) return null;
  const text = String(value).trim();
  const match = text.match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) return null;
  return BigInt(match[1]) * 100n + BigInt((match[2] ?? "").padEnd(2, "0"));
}

export function centsToAmount(cents: bigint): string {
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
}

export function amountEquals(a: unknown, b: unknown): boolean {
  const centsA = parseAmountToCents(a);
  const centsB = parseAmountToCents(b);
  return centsA !== null && centsB !== null && centsA === centsB;
}