// 入口闸契约：只挡注定不需要的（一次性口令/营销/账号流水），失败即放行。
import assert from "node:assert/strict";
import { test } from "node:test";

import { createIntelGate } from "../src/proactivity/intel/intel-gate.js";

const T0 = Date.UTC(2026, 9, 28, 9, 0, 0);

function gate(vipSenders: string[] = []) {
  return createIntelGate({ vipSenders, nowFn: () => T0 });
}

test("gate：验证码/一次性口令挡在外面；没有数字的「验证码登录已开启」放行", () => {
  const g = gate();
  const otp = g.check({
    source: "email",
    title: "【GitHub】验证码",
    text: "你的验证码是 614209，15 分钟内有效。",
  });
  assert.equal(otp.allow, false);
  assert.equal(otp.allow === false && otp.category, "otp");

  const notice = g.check({
    source: "email",
    title: "验证码登录已开启",
    text: "你现在可以使用验证码登录，无需密码。",
  });
  assert.equal(notice.allow, true);
});

test("gate：营销邮件挡住，事务性邮件正文提到「优惠」不误杀", () => {
  const g = gate();
  const promo = g.check({ source: "email", title: "限时特惠 全场五折", text: "点击领取优惠券" });
  assert.equal(promo.allow, false);
  assert.equal(promo.allow === false && promo.category, "marketing");

  const unsub = g.check({
    source: "email",
    title: "本周精选",
    text: "新品到货与优惠，点此退订。",
  });
  assert.equal(unsub.allow, false);

  const transaction = g.check({
    source: "email",
    title: "您的订单已发货",
    text: "订单金额 ¥199，随单赠送优惠券一张，已附在包裹内。",
  });
  assert.equal(transaction.allow, true);
});

test("gate：账号流水通知挡住；安全语境（新设备/异常）放行给模型", () => {
  const g = gate();
  const registered = g.check({ source: "email", title: "注册成功", text: "欢迎加入我们。" });
  assert.equal(registered.allow, false);
  assert.equal(registered.allow === false && registered.category, "noise");

  const security = g.check({
    source: "email",
    title: "新设备登录提醒",
    text: "检测到陌生设备登录成功，如非本人请立即改密。",
  });
  assert.equal(security.allow, true);
});

test("gate：VIP 白名单（地址与域名）直通", () => {
  const g = gate(["boss@example.com", "@company.com"]);
  const a = g.check({ source: "email", from: "Boss <boss@example.com>", title: "限时特惠", text: "全场五折" });
  assert.equal(a.allow, true);
  const b = g.check({ source: "email", from: "hr@company.com", title: "注册成功", text: "欢迎加入" });
  assert.equal(b.allow, true);
});

test("gate：计数与样本可复核", () => {
  const g = gate();
  g.check({ source: "email", title: "验证码 123456", text: "5 分钟内有效" });
  g.check({ source: "email", title: "限时优惠", text: "退订" });
  g.check({ source: "email", title: "普通邮件", text: "正文" });
  const stats = g.stats();
  assert.equal(stats.checked, 3);
  assert.equal(stats.allowed, 1);
  assert.equal(stats.blocked, 2);
  assert.equal(stats.byCategory.otp, 1);
  assert.equal(stats.byCategory.marketing, 1);
  assert.equal(stats.samples.length, 2);
});
