// 提炼与时间渲染契约：目录行一行、详情去引用/去页脚；时间存绝对时刻、读时相对化。
import assert from "node:assert/strict";
import { test } from "node:test";

import { extractBrief, extractDetail, stripQuotedAndFooter } from "../src/proactivity/intel/intel-refine.js";
import { formatDistance, formatRelativeClock, formatWhen } from "../src/proactivity/intel/intel-time.js";

test("refine：目录行=主题+首句，引用历史与退订尾巴被削掉", () => {
  const text = [
    "你好，明天的评审改到十一点，会议室不变。",
    "请提前十分钟到。",
    "",
    "在 2026年10月27日 写道：",
    "> 明天十点评审",
    "",
    "退订 | 取消订阅",
  ].join("\n");
  const brief = extractBrief("Re: 评审安排", text);
  assert.equal(brief, "评审安排｜明天的评审改到十一点，会议室不变");
  const detail = extractDetail({ title: "Re: 评审安排", text, from: "张伟 <z@example.com>", source: "email" });
  assert.match(detail, /来自：张伟/);
  assert.match(detail, /会议室不变/);
  assert.doesNotMatch(detail, /十点评审/);
  assert.doesNotMatch(detail, /退订/);
});

test("refine：引用分隔线与 > 引用都会截断正文", () => {
  assert.equal(stripQuotedAndFooter("第一段\n\n-----原始邮件-----\n旧内容"), "第一段");
  assert.equal(stripQuotedAndFooter("第一段\n> 引用"), "第一段");
});

test("time：存绝对时刻，跨天渲染成昨天/明天，距离给「还有/已过」", () => {
  const now = new Date(2026, 9, 28, 10, 32, 0).getTime();
  const yesterday = new Date(2026, 9, 27, 21, 5, 0).getTime();
  const tomorrow = new Date(2026, 9, 29, 9, 0, 0).getTime();
  assert.equal(formatRelativeClock(now, now), "今天 10:32");
  assert.equal(formatRelativeClock(yesterday, now), "昨天 21:05");
  assert.equal(formatRelativeClock(tomorrow, now), "明天 09:00");
  assert.equal(formatDistance(tomorrow, now), "还有 22 小时");
  assert.equal(formatDistance(now - 8 * 60_000, now), "已过 8 分钟");
  assert.equal(formatWhen(tomorrow, now), "明天 09:00（还有 22 小时）");
});
