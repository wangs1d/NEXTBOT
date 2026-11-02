/**
 * NEXT_UP 协议块剥离（2026-10-24 真机事故）：模型漏写下划线的
 * `[NEXT_UPSTART]` / `[NEXT_UPEND]` 变体必须和标准写法同样提取 + 剥除，
 * 否则建议块原样漏进用户气泡。
 */
import assert from "node:assert/strict";
import test from "node:test";

const { extractNextUpSuggestions } = await import("../src/services/reply-envelope.js");

test("标准写法：提取建议并从正文剥离", () => {
  const input = "行程排好了。\n[NEXT_UP_START]\n把行程改成3天\n换个酒店\n[NEXT_UP_END]\n";
  const { text, followups } = extractNextUpSuggestions(input);
  assert.deepEqual(followups, ["把行程改成3天", "换个酒店"]);
  assert.equal(text, "行程排好了。");
});

test("漏下划线变体：同样提取并剥除（真机截图同款）", () => {
  const input =
    "日期和人数你定一下。\n[NEXT_UPSTART]\n按两个人重算一遍预算\n帮我看下后海村附近住哪家\n把行程改成3天\n[NEXT_UPEND]";
  const { text, followups } = extractNextUpSuggestions(input);
  assert.deepEqual(followups, [
    "按两个人重算一遍预算",
    "帮我看下后海村附近住哪家",
    "把行程改成3天",
  ]);
  assert.equal(text, "日期和人数你定一下。");
  assert.ok(!text.includes("NEXT"));
});

test("变体残缺（只有 START）：打捞尾部建议并剥除", () => {
  const input = "先说结论。\n[NEXT_UPSTART]\n把行程改成3天";
  const { text, followups } = extractNextUpSuggestions(input);
  assert.deepEqual(followups, ["把行程改成3天"]);
  assert.equal(text, "先说结论。");
});

test("无建议块：正文原样返回", () => {
  const input = "杭州明天有雨，记得带伞。";
  const { text, followups } = extractNextUpSuggestions(input);
  assert.equal(text, input);
  assert.deepEqual(followups, []);
});

test("自造前缀（NOEXTUP_END）不得被当成建议条目（真机截图回归）", () => {
  const input =
    "价格我查了三家的底价。\n[NEXT_UP_START]\n补查京东和拼多多的价格\n问问4653那家的配置和保修\n[NOEXTUP_END]";
  const { text, followups } = extractNextUpSuggestions(input);
  assert.deepEqual(followups, [
    "补查京东和拼多多的价格",
    "问问4653那家的配置和保修",
  ]);
  assert.equal(text, "价格我查了三家的底价。");
  assert.ok(!text.includes("NOEXTUP"));
});

test("全角括号变体同样提取并剥除", () => {
  const input =
    "提醒建好了。\n【NEXT_UP_START】\n帮我把提醒提前一天\n【NOEXTUP_END】";
  const { text, followups } = extractNextUpSuggestions(input);
  assert.deepEqual(followups, ["帮我把提醒提前一天"]);
  assert.equal(text, "提醒建好了。");
});

test("配对 END 之后的正文保留（与流式 guard 语义一致）", () => {
  const input =
    "行程排好了。\n[NEXT_UP_START]\n把行程改成3天\n[NEXT_UP_END]\n需要我发到邮箱吗？";
  const { text, followups } = extractNextUpSuggestions(input);
  assert.deepEqual(followups, ["把行程改成3天"]);
  assert.equal(text, "行程排好了。\n需要我发到邮箱吗？");
});

test("孤立错写 END（无 START）也要从正文剥掉", () => {
  const input = "提醒建好了。\n[NOEXTUP_END]";
  const { text, followups } = extractNextUpSuggestions(input);
  assert.equal(text, "提醒建好了。");
  assert.deepEqual(followups, []);
});
