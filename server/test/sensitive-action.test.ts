/**
 * 敏感动作分级测试（2026-09-24，铁律二：外部副作用默认 handoff）。
 */
import assert from "node:assert/strict";
import test from "node:test";

const { classifyToolSensitivity, classifyTextSensitivity } = await import(
  "../src/security/sensitive-action.js"
);

test("工具分档：外部副作用前缀 → act_external", () => {
  for (const name of [
    "shopping.order.place",
    "shopping.order.confirm",
    "email_sms.send_email",
    "phone_call.start",
    "message.send",
    // 2026-10-21 表对齐真实工具名（旧表漏掉 → 被误判 act_internal，handoff/自动推进失守）
    "messages.reply",
    "world.link.send_message",
    "email.send",
    "phone.dial",
    "phone.call_user",
    "smart_home.control_device",
    "smart_home.scene",
    "alipay.submit-payment",
    "alipay.proxy-trade",
  ]) {
    assert.equal(classifyToolSensitivity(name), "act_external", name);
  }
});

test("工具分档：alipay 只读/查询族不升档", () => {
  assert.equal(classifyToolSensitivity("alipay.query-payment"), "act_internal");
  assert.equal(classifyToolSensitivity("alipay.check-wallet"), "act_internal");
  assert.equal(classifyToolSensitivity("alipay.merchant-list"), "act_internal");
});

test("工具分档：只读前缀 → read；未知工具 → act_internal", () => {
  assert.equal(classifyToolSensitivity("shopping.compare.prices"), "read");
  assert.equal(classifyToolSensitivity("weather.get"), "read");
  assert.equal(classifyToolSensitivity("calendar.create_event"), "act_internal");
});

test("文本分档：外部动作词命中 → act_external", () => {
  for (const text of [
    "在淘宝下单买一箱牛奶",
    "把报价单发送给张总",
    "联系卖家砍价到 500 以下",
    "帮我支付这笔账单",
  ]) {
    assert.equal(classifyTextSensitivity(text), "act_external", text);
  }
});

test("文本分档：只读/内部动作", () => {
  assert.equal(classifyTextSensitivity("查一下东站周边两居室房源"), "read");
  assert.equal(classifyTextSensitivity("搜索并整理 5 个候选房源"), "read");
  assert.equal(classifyTextSensitivity("创建日程：周四下午看房"), "act_internal");
  assert.equal(classifyTextSensitivity("记一笔今天的中介联系方式"), "act_internal");
});

test("文本分档：外部词优先于只读词（先查后下单整体升档）", () => {
  assert.equal(classifyTextSensitivity("查到最低价后直接下单购买"), "act_external");
});

test("文本分档：未知描述兜底 act_internal（绝不自动触外部）", () => {
  assert.equal(classifyTextSensitivity("把简历再润色一遍"), "act_internal");
});
