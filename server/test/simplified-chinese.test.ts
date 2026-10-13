/**
 * 繁→简出口正规化测试（2026-10-11）。
 * 动机：真机 daily-chat-leak 探针 #6/#7 两轮把「兴义」泄成「興義」——
 * 文风级瑕疵，prompt 治理只降频不归零，出口确定性 1:1 映射兜底。
 * 锁三件事：① 映射表自身完整性（无歧义 1:1、无自映射）② 核心行为
 * （繁→简、简体零接触、协议块/URL 安全）③ 高频地名/日常词泄漏面
 * （贵州/兴义/梦乐城 是用户真实语境，回归时最先看）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  normalizeTraditionalToSimplified,
  t2sMapSize,
} from "../src/utils/simplified-chinese.ts";

test("映射表规模合理且无自映射/无坏 token", () => {
  const size = t2sMapSize();
  assert.ok(size >= 400, `映射表应 >= 400 项，实际 ${size}`);
});

test("核心泄漏面：地名与人名场景（真机实证案例）", () => {
  assert.equal(normalizeTraditionalToSimplified("興義").text, "兴义");
  assert.equal(normalizeTraditionalToSimplified("你在贵州興義市").text, "你在贵州兴义市");
  assert.equal(normalizeTraditionalToSimplified("歡迎來到貴陽夢樂城").text, "欢迎来到贵阳梦乐城");
});

test("纯简体/ASCII/空串零接触（正常回复一个字节不动）", () => {
  const plain = "这是纯简体中文，English mixed 123，不该被改动。";
  const r = normalizeTraditionalToSimplified(plain);
  assert.equal(r.text, plain);
  assert.equal(r.changed, false);
  assert.equal(normalizeTraditionalToSimplified("").changed, false);
  assert.equal(normalizeTraditionalToSimplified("https://example.com/兴义?a=1").text, "https://example.com/兴义?a=1");
});

test("替换是等长的（流式安全：逐 delta 替换不破坏分段）", () => {
  const raw = "簡體中文測試繁體字轉換";
  const out = normalizeTraditionalToSimplified(raw).text;
  assert.equal([...out].length, [...raw].length);
  assert.equal(out, "简体中文测试繁体字转换");
});

test("changed 标志：有繁体时 true，无繁体时 false", () => {
  assert.equal(normalizeTraditionalToSimplified("興義").changed, true);
  assert.equal(normalizeTraditionalToSimplified("兴义").changed, false);
});

test("协议块内的繁体同样被归一（卡片标题不漏繁体）", () => {
  const raw = '[AGENT_RESULT_CARD_START]\n{"title":"興義今日天气"}\n[AGENT_RESULT_CARD_END]';
  const out = normalizeTraditionalToSimplified(raw).text;
  assert.ok(out.includes("兴义今日天气"));
  assert.ok(!out.includes("興義"));
});

test("上下文歧义字不收（乾/著/藉/瞭/鬍 保持原样，避免误伤）", () => {
  const ambiguous = "乾隆的著作藉由瞭望台记录，长着胡须。";
  const r = normalizeTraditionalToSimplified(ambiguous);
  assert.equal(r.text, ambiguous);
  assert.equal(r.changed, false);
});
