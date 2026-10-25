/**
 * WAL PII 脱敏不得破坏结构化载荷（2026-10-24 真机事故）：
 * `"distanceKm":3.1234567890123456` 被银行卡正则截成 `3.***BANK***`，
 * 历史回放时行程卡 JSON 解析失败、卡片降级成纯文本。
 */
import assert from "node:assert/strict";
import test from "node:test";

const { redactSensitiveText } = await import("../src/utils/redact.js");

test("JSON 长小数原样保留（历史卡片可解析）", () => {
  const raw = '{"transportFromPrev":{"mode":"打车","durationMin":4,"distanceKm":3.1234567890123456}}';
  const out = redactSensitiveText(raw);
  assert.equal(out, raw);
  assert.doesNotThrow(() => JSON.parse(out));
});

test("多位小数（含 1 开头的 11 位小数）不被误判为手机号", () => {
  const raw = '{"x":1.12345678901,"y":0.123456789012345}';
  assert.equal(redactSensitiveText(raw), raw);
});

test("正文里的手机号/身份证/银行卡仍然脱敏", () => {
  const out = redactSensitiveText(
    "联系 13812345678，身份证 110101199003071234，卡号 6222020200112233445，邮箱 a.b@example.com",
  );
  assert.ok(!out.includes("13812345678"), out);
  assert.ok(!out.includes("110101199003071234"), out);
  assert.ok(!out.includes("6222020200112233445"), out);
  assert.ok(!out.includes("a.b@example.com"), out);
  assert.ok(out.includes("***PHONE***") && out.includes("***ID***") && out.includes("***BANK***"));
});
