/**
 * PII 脱敏。数字类模式必须带小数点边界（2026-10-24 真机事故）：
 * 旧写法 `\b\d{16,19}\b` 会把 JSON 里的长小数 `"distanceKm":3.1234567890123456`
 * 截成 `3.***BANK***`，历史回放的行程卡 JSON 因此解析失败、卡片整块降级成正文。
 * 小数点两侧不算 PII 边界——被 `.` 包住的数字串只是小数/版本号，不动。
 */
const phonePattern = /(?<![\d.])1\d{10}(?![\d.])/g;
const idPattern = /(?<![\d.])\d{17}[\dXx](?![\d.])/g;
const bankPattern = /(?<![\d.])\d{16,19}(?![\d.])/g;
const emailPattern = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const ipPattern = /(?<![\d.])\d{1,3}(?:\.\d{1,3}){3}(?![\d.])/g;

export function redactSensitiveText(input: string): string {
  return input
    .replace(emailPattern, "***EMAIL***")
    .replace(ipPattern, "***IP***")
    .replace(phonePattern, "***PHONE***")
    .replace(idPattern, "***ID***")
    .replace(bankPattern, "***BANK***");
}
