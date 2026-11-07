/**
 * 时间渲染统一时区的单测（2026-11-05 时间感知重构）。
 *
 * 修的问题：`[ts:]` 帧与【对话时间轴】此前全部用服务器进程时区渲染，而
 * system 的【当前时间】块用用户时区——同一份 prompt 里两个钟并存，用户在
 * 境外时模型算「昨天/刚才」必错。
 *
 * 锁死的语义：
 *   1. 传了 timezone 就按 IANA 规则渲染（含 DST），同一 UTC 时刻在不同时区
 *      必须得到不同的日期/小时；
 *   2. 不传 timezone 时保持旧行为（本机时区），逐字节兼容既有线程与缓存；
 *   3. 非法时区不得抛异常（历史脏值不能击穿 prompt 装配）；
 *   4. 时间轴的「今天/昨天」分组按用户时区，而不是服务器时区。
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMessageTimestampPrefix,
  buildTimestampFreeLlmView,
  wallClock,
} from "../src/external-model/chat-thread-store.js";
import { tagMessageTimestampMeta } from "../src/external-model/chat-thread-ts-meta.js";

test("wallClock 按 IANA 时区换算：同一 UTC 时刻得到不同墙钟", () => {
  const at = new Date(Date.UTC(2026, 10, 5, 16, 30, 0));

  const shanghai = wallClock(at, "Asia/Shanghai");
  assert.equal(shanghai.year, 2026);
  assert.equal(shanghai.month, 11);
  assert.equal(shanghai.day, 6); // 北京已过零点
  assert.equal(shanghai.hour, 0);
  assert.equal(shanghai.minute, 30);

  const newYork = wallClock(at, "America/New_York");
  assert.equal(newYork.day, 5);
  assert.equal(newYork.hour, 11); // EST = UTC-5
  assert.equal(newYork.minute, 30);
});

test("wallClock 处理夏令时：纽约冬夏偏移不同", () => {
  const winter = wallClock(new Date(Date.UTC(2026, 0, 15, 17, 0, 0)), "America/New_York");
  const summer = wallClock(new Date(Date.UTC(2026, 6, 15, 17, 0, 0)), "America/New_York");
  assert.equal(winter.hour, 12); // EST -5
  assert.equal(summer.hour, 13); // EDT -4
});

test("wallClock 遇到非法时区退回本机口径且不抛异常", () => {
  const at = new Date(Date.UTC(2026, 10, 5, 16, 30, 0));
  const fallback = wallClock(at, "UTC+8");
  const local = wallClock(at);
  assert.equal(fallback.year, local.year);
  assert.equal(fallback.hour, local.hour);
});

test("时间戳帧按用户时区渲染（跨日边界）", () => {
  const at = new Date(Date.UTC(2026, 10, 5, 16, 30, 0));
  const now = new Date(Date.UTC(2026, 10, 5, 16, 40, 0));

  assert.ok(buildMessageTimestampPrefix(at, now, "Asia/Shanghai").includes("2026-11-06 00:30:00"));
  assert.ok(buildMessageTimestampPrefix(at, now, "America/New_York").includes("2026-11-05 11:30:00"));
  // 星期几同样跟着时区走：北京已跨到 11-06（周五），纽约还是 11-05（周四）
  assert.ok(buildMessageTimestampPrefix(at, now, "Asia/Shanghai").includes("周五"));
  assert.ok(buildMessageTimestampPrefix(at, now, "America/New_York").includes("周四"));
});

test("时间轴的今天/昨天分组按用户时区判定", () => {
  const messages = [
    { role: "user", content: "早上好" },
    { role: "assistant", content: "早" },
  ] as Parameters<typeof buildTimestampFreeLlmView>[0];
  // 消息发生在 UTC 11-05 02:00（北京 11-05 10:00）
  const msgAt = Date.UTC(2026, 10, 5, 2, 0, 0);
  tagMessageTimestampMeta(messages[0]!, new Date(msgAt));
  tagMessageTimestampMeta(messages[1]!, new Date(msgAt + 60_000));
  // 「现在」= UTC 11-05 16:30（北京 11-06 00:30）→ 对北京用户是「昨天」
  const now = new Date(Date.UTC(2026, 10, 5, 16, 30, 0));

  const view = buildTimestampFreeLlmView(messages, { now, timezone: "Asia/Shanghai" });
  const timeline = view.messages.find(
    (m) => m.role === "system" && typeof m.content === "string" && m.content.includes("对话时间轴"),
  );
  assert.ok(timeline, "应注入对话时间轴块");
  const text = String(timeline!.content);
  assert.ok(text.includes("2026-11-05"), "分日行应使用用户时区的日期");
  assert.ok(text.includes("（昨天）"), "对北京用户，UTC 11-05 02:00 是昨天");
  assert.ok(text.includes("2026-11-05 10:00:00"), "时间轴正文应按用户时区渲染小时");
});

test("不传时区时保持旧口径（服务器本地），不引入行为变化", () => {
  const at = new Date(Date.UTC(2026, 10, 5, 16, 30, 0));
  const now = new Date(Date.UTC(2026, 10, 5, 16, 40, 0));
  const legacy = buildMessageTimestampPrefix(at, now);
  const explicitLocal = buildMessageTimestampPrefix(at, now, undefined);
  assert.equal(legacy, explicitLocal);
  // 旧口径的日期部分应与本机 getFullYear/getMonth/getDate 一致
  const expectedDay = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(
    at.getDate(),
  ).padStart(2, "0")}`;
  assert.ok(legacy.includes(expectedDay));
});
