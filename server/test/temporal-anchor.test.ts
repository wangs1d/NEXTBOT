/**
 * 注入层时间锚（2026-10-09）回归测试。
 *
 * 事故：10-08 22:07 用户说「好饿」，10-09 21:38 agent 回复「刚才你说好饿」——
 * recap 行自带绝对时间标签却被当「现事」承接。根因是「距今多久」这一步从未
 * 送到模型面前。本文件锁定修复：
 *  - A. recap 行年龄标注 + 时间锚提示（仅视图层，存储不动）；
 *  - B. 工作记忆摘要带更新时长与陈旧提示；
 *  - C. 顺嘴机会 hint 带「发生于」；
 *  - D. followup 触发器收窄（日常短语不再误入队）；
 *  - E. 未闭环旧项识别与衰减（decayStaleOpenLoops，纯函数）；
 *  - F. 分类索引视图（indexifyRecapForLlm）：瞬时条目跨天从注入视图剔除
 *    （原话素材不常驻，治「刚才你说好饿」）、持久未闭环加策略位「勿主动提」。
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

import {
  annotateRecapLinesWithAge,
  formatRecapAgeLabel,
} from "../src/services/conversation-rolling-summarizer.js";

const { buildTimestampFreeLlmView } = await import(
  "../src/external-model/chat-thread-store.js"
);
const { formatTurnAsidePrompt } = await import(
  "../src/proactivity/turn-aside-queue.js"
);
const { WorkingMemoryCortex } = await import("../src/brain/working-memory-cortex.js");
const { detectConversationProactiveHook } = await import(
  "../src/proactivity/triggers/conversation-triggers.js"
);
const { decayStaleOpenLoops, isUnclosedOpenLoop } = await import(
  "../src/services/conversation-rolling-summarizer.js"
);

const NOW = new Date(2026, 9, 9, 21, 38, 0); // 2026-10-09 21:38（事故当刻）

/* ── A1. 年龄标签 ─────────────────────────────────────────────── */

test("A 年龄标签：日粒度（今天 / 约N天前 / 约N周前 / 约N个月前）", () => {
  assert.equal(formatRecapAgeLabel(new Date(2026, 9, 9, 22, 7), NOW), "今天");
  assert.equal(formatRecapAgeLabel(new Date(2026, 9, 8, 22, 7), NOW), "约1天前");
  assert.equal(formatRecapAgeLabel(new Date(2026, 9, 6, 9, 0), NOW), "约3天前");
  assert.equal(formatRecapAgeLabel(new Date(2026, 8, 29, 9, 0), NOW), "约1周前");
  assert.equal(formatRecapAgeLabel(new Date(2026, 8, 1, 9, 0), NOW), "约1个月前");
});

/* ── A2. 行级标注 ─────────────────────────────────────────────── */

test("A recap 行标注：带绝对标签行追加年龄，标记/标题/无标签行不动", () => {
  const content = [
    "[session-recap]",
    "Earlier conversation recap:",
    "- [2026/10/08 周四 22:07] 用户表示\"好饿\"，尚未决定今晚吃什么。",
    "- [2026/10/09 09:12] 用户确认了交付时间。",
    "- 无标签的早期事实",
    "[关键钉] 不可忘的事实（逐字保留，禁止改写或遗忘）：",
    "- [2026/10/08 22:07] 用户明说要记住的事",
  ].join("\n");
  const out = annotateRecapLinesWithAge(content, NOW);
  assert.ok(out.includes("[2026/10/08 周四 22:07]（约1天前）用户表示\"好饿\""), `昨日行应标约1天前：\n${out}`);
  assert.ok(out.includes("[2026/10/09 09:12]（今天）用户确认了交付时间"), `今日行应标今天：\n${out}`);
  assert.ok(out.includes("[2026/10/08 22:07]（约1天前）用户明说要记住的事"), "关键钉行同样标注");
  assert.ok(out.includes("- 无标签的早期事实"), "无标签行原样保留");
  assert.ok(out.includes("[session-recap]"), "标记行原样保留");
  assert.ok(out.includes("Earlier conversation recap:"), "标题原样保留");
});

test("A 行级标注：幂等（已标注行不再叠加）", () => {
  const once = annotateRecapLinesWithAge(
    "- [2026/10/08 周四 22:07] 用户表示好饿",
    NOW,
  );
  const twice = annotateRecapLinesWithAge(once, NOW);
  assert.equal(twice, once);
  assert.equal((twice.match(/约1天前/g) ?? []).length, 1);
});

/* ── A3. 视图隔离 + 时间锚提示 ────────────────────────────────── */

test("A 视图层：recap 视图带年龄与提示行，且不改动原消息（存储隔离）", () => {
  const recapContent =
    "[session-recap]\nEarlier conversation recap:\n- [2026/10/08 周四 22:28] 用户希望规划兴义周末路线，尚待确认。";
  const msgs: ChatCompletionMessageParam[] = [
    { role: "system", content: "sys" },
    { role: "assistant", content: recapContent },
    { role: "user", content: "周末的事情就先不管了" },
  ];
  const view = buildTimestampFreeLlmView(msgs, { now: NOW }).messages;
  const recapView = view.find(
    (m) => typeof m.content === "string" && m.content.includes("[session-recap]"),
  );
  assert.ok(recapView, "视图应保留 recap 消息");
  const text = String(recapView!.content);
  assert.ok(text.includes("（约1天前）"), `recap 视图应含年龄标注：\n${text}`);
  assert.ok(text.includes("距今超过 1 小时不得说"), `recap 视图应含时间锚提示：\n${text}`);
  // 存储隔离：原线程对象的 recap 内容一字未改
  assert.equal(msgs[1]!.content, recapContent, "存储层 recap 不得被就地改写");
  // recap 不参与对话时间轴（旧契约不回退）
  assert.ok(!view.some((m) => typeof m.content === "string" && m.content.includes("【对话时间轴")));
});

/* ── B. 工作记忆时间锚 ────────────────────────────────────────── */

test("B 工作记忆摘要：槽位带更新时长，整体陈旧时给过时提示", () => {
  const cortex = new WorkingMemoryCortex();
  const actor = "u-anchor";
  const fresh = cortex.load(actor);
  fresh.slots.push({
    key: "主题_天气",
    value: "问过明天的天气",
    importance: "medium",
    createdAt: new Date().toISOString(),
    lastTouchedAt: new Date().toISOString(),
    touchCount: 1,
  });
  cortex.save(actor, fresh);
  const freshSummary = cortex.toSummary(actor);
  assert.match(freshSummary, /更新于刚刚|更新于\d+分钟前/, `新鲜槽位应带更新时间：\n${freshSummary}`);
  assert.ok(!freshSummary.includes("可能过时"), "新鲜工作记忆不应带过时提示");

  // 换一个"很久前"的槽位：应同时出现年龄与过时提示
  const old = new Date(Date.now() - 26 * 60 * 60_000).toISOString();
  const stale = cortex.load("u-stale");
  stale.slots.push({
    key: "主题_饮食",
    value: "用户表示好饿",
    importance: "medium",
    createdAt: old,
    lastTouchedAt: old,
    touchCount: 1,
  });
  cortex.save("u-stale", stale);
  const staleSummary = cortex.toSummary("u-stale");
  assert.match(staleSummary, /更新于\d+天前|更新于\d+小时前/, `旧槽位应带年龄：\n${staleSummary}`);
  assert.ok(staleSummary.includes("可能过时"), `陈旧工作记忆应带过时提示：\n${staleSummary}`);
});

/* ── C. 顺嘴机会时间锚 ────────────────────────────────────────── */

test("C 顺嘴机会：块正文带「发生于 X 前」与不得说「刚才」纪律", () => {
  const createdAt = NOW.getTime() - 3 * 60 * 60_000; // 3 小时前
  const block = formatTurnAsidePrompt(
    {
      id: "aside-1",
      actorId: "u1",
      kind: "followup",
      title: "跟进简历结果",
      hint: "HR 说这周出结果",
      importance: "medium",
      createdAt,
      expiresAt: createdAt + 2 * 60 * 60_000,
    },
    NOW.getTime(),
  );
  assert.match(block, /【顺嘴机会】/);
  assert.match(block, /发生于3 小时前/, `应带发生时长：\n${block}`);
  assert.match(block, /不要用「刚才\/刚刚」/);
  assert.match(block, /HR 说这周出结果/);
});

/* ── D. followup 触发器收窄 ───────────────────────────────────── */

test("D 触发器收窄：日常短语不再误入队，明确约定仍触发", () => {
  assert.equal(detectConversationProactiveHook("这个周末带孩子回老家"), null);
  assert.equal(detectConversationProactiveHook("晚上再说吧，先去忙了"), null);
  assert.equal(detectConversationProactiveHook("下周有空再说"), null);
  assert.equal(detectConversationProactiveHook("过几天他应该就回我了"), null);
  const hook = detectConversationProactiveHook("HR 说等结果，帮我盯着点");
  assert.ok(hook, "明确等待/约定线索仍应触发");
  assert.equal(hook!.kind, "followup");
});

/* ── E. recap 未闭环旧项时效衰减 ──────────────────────────────── */

test("E 未闭环识别：只有明确的未完成信号才算 open loop", () => {
  assert.equal(isUnclosedOpenLoop("- [2026/10/08 22:07] 用户表示\"好饿\"，尚未决定今晚吃什么。"), true);
  assert.equal(isUnclosedOpenLoop("用户还没吃完晚饭"), true);
  assert.equal(isUnclosedOpenLoop("简历投递结果待定"), true);
  assert.equal(isUnclosedOpenLoop("用户确认了交付时间"), false);
  assert.equal(isUnclosedOpenLoop("用户已把简历投出去了"), false);
  assert.equal(isUnclosedOpenLoop(""), false);
});

test("E 时效衰减：跨天未闭环 → 追加降级指令；当天/已闭环不动", () => {
  const content = [
    "- [2026/10/08 周四 22:07] 用户表示\"好饿\"，尚未决定今晚吃什么。",
    "- [2026/10/09 09:12] 用户还没决定午饭吃什么。",
    "- [2026/10/09 09:20] 用户确认了交付时间。",
  ].join("\n");
  const out = decayStaleOpenLoops(content, NOW);
  assert.ok(out.split("\n")[0]!.includes("该事项已跨天仍未闭环"), `跨天未闭环行应降级：\n${out}`);
  assert.ok(!out.split("\n")[1]!.includes("该事项已跨天"), "当天未闭环项不降级（可能今天就办）");
  assert.ok(!out.split("\n")[2]!.includes("该事项已跨天"), "已闭环项不降级");
});

test("E 时效衰减：幂等（重复调用不叠加指令）", () => {
  const once = decayStaleOpenLoops("- [2026/10/08 22:07] 还没定今晚吃什么", NOW);
  const twice = decayStaleOpenLoops(once, NOW);
  assert.equal(twice, once);
  assert.equal((twice.match(/该事项已跨天仍未闭环/g) ?? []).length, 1);
});

test("E 时效衰减：RECAP_STALE_LOOP_DROP_DAYS 可把超期旧项从视图剔除", () => {
  const prev = process.env.RECAP_STALE_LOOP_DROP_DAYS;
  try {
    delete process.env.RECAP_STALE_LOOP_DROP_DAYS;
    const kept = decayStaleOpenLoops("- [2026/10/01 周四 10:00] 还没定要不要报名", NOW);
    assert.ok(kept.includes("还没定要不要报名"), "默认不丢弃，只降级");

    process.env.RECAP_STALE_LOOP_DROP_DAYS = "3";
    const dropped = decayStaleOpenLoops(
      "- [2026/10/01 周四 10:00] 还没定要不要报名\n- [2026/10/08 22:07] 尚未决定今晚吃什么",
      NOW,
    );
    assert.ok(!dropped.includes("还没定要不要报名"), "超过 3 天的未闭环行从视图剔除");
    assert.ok(dropped.includes("尚未决定今晚吃什么"), "3 天内的仍保留（降级）");
  } finally {
    if (prev === undefined) delete process.env.RECAP_STALE_LOOP_DROP_DAYS;
    else process.env.RECAP_STALE_LOOP_DROP_DAYS = prev;
  }
});

test("E 视图层：recap 视图对跨天未闭环项带策略位，存储不动", () => {
  const recapContent =
    "[session-recap]\nEarlier conversation recap:\n- [2026/10/08 周四 22:07] 用户希望规划兴义周末路线，尚待确认。";
  const msgs: ChatCompletionMessageParam[] = [
    { role: "system", content: "sys" },
    { role: "assistant", content: recapContent },
    { role: "user", content: "周末的事情就先不管了" },
  ];
  const view = buildTimestampFreeLlmView(msgs, { now: NOW }).messages;
  const text = String(
    view.find((m) => typeof m.content === "string" && m.content.includes("[session-recap]"))!.content,
  );
  assert.ok(text.includes("策略:勿主动提"), `视图应含策略位：\n${text}`);
  assert.ok(text.includes("（约1天前）"), "年龄标注仍在");
  assert.equal(msgs[1]!.content, recapContent, "存储层 recap 不得被就地改写");
});

/* ── F. recap 分类索引视图：瞬时 TTL 剔除 + 冷索引 + 策略位 ────── */

const {
  indexifyRecapForLlm,
  isTransientRecapTopic,
} = await import("../src/services/conversation-rolling-summarizer.js");

test("F 瞬时识别：身体/饮食/休息当下状态算瞬时，持续事项不算", () => {
  assert.equal(isTransientRecapTopic("- [2026/10/08 22:07] 用户表示\"好饿\"，尚未决定今晚吃什么。"), true);
  assert.equal(isTransientRecapTopic("用户还没决定午饭吃什么"), true);
  assert.equal(isTransientRecapTopic("用户说太累了想早点休息"), true);
  assert.equal(isTransientRecapTopic("用户希望规划兴义周末路线，尚待确认"), false);
  assert.equal(isTransientRecapTopic("用户在忙装修的事，尚未开工"), false, "「在忙X」是持续事项");
  assert.equal(isTransientRecapTopic("用户确认了交付时间"), false);
});

test("F 分类索引：瞬时跨天剔除（原话素材不常驻）、当日在途保留", () => {
  const content = [
    "- [2026/10/08 周四 22:07] 用户表示\"好饿\"，尚未决定今晚吃什么。",
    "- [2026/10/09 09:12] 用户还没决定午饭吃什么。",
  ].join("\n");
  const out = indexifyRecapForLlm(content, NOW);
  assert.ok(!out.includes("好饿"), `跨天瞬时条目应从视图剔除：\n${out}`);
  assert.ok(out.includes("还没决定午饭吃什么"), "当日在途瞬时条目保留");
  assert.ok(out.includes("[时效索引]"), "有剔除时应补聚合说明行");
});

test("F 分类索引：持久未闭环跨天加策略位；已闭环/关键钉原样", () => {
  const content = [
    "- [2026/10/08 周四 22:28] 用户希望规划兴义周末路线，尚待确认。",
    "- [2026/10/08 20:00] 用户确认了交付时间。",
    "- [2026/10/08 22:07] 用户明说要记住的事。",
  ].join("\n");
  const out = indexifyRecapForLlm(content, NOW);
  assert.ok(out.includes("策略:勿主动提"), `跨天未闭环持久项应带策略位：\n${out}`);
  assert.ok(out.includes("兴义周末路线"), "持久条目本体保留（冷索引）");
  assert.ok(out.includes("用户确认了交付时间"), "已闭环项原样保留");
  assert.ok(out.includes("用户明说要记住的事"), "关键钉/事实项原样保留");
  assert.ok(!out.includes("[时效索引]"), "无剔除时不插聚合说明");
});

test("F 分类索引：幂等（重复调用字节不变）", () => {
  const content = [
    "- [2026/10/08 周四 22:07] 用户表示\"好饿\"，尚未决定今晚吃什么。",
    "- [2026/10/08 周四 22:28] 用户希望规划兴义周末路线，尚待确认。",
  ].join("\n");
  const once = indexifyRecapForLlm(content, NOW);
  const twice = indexifyRecapForLlm(once, NOW);
  assert.equal(twice, once, "二次加工必须字节恒定（prefix cache 保障）");
});

test("F 分类索引：RECAP_TRANSIENT_TTL_DAYS=0 关闭瞬时剔除", () => {
  const prev = process.env.RECAP_TRANSIENT_TTL_DAYS;
  try {
    process.env.RECAP_TRANSIENT_TTL_DAYS = "0";
    const content = "- [2026/10/08 周四 22:07] 用户表示\"好饿\"，尚未决定今晚吃什么。";
    const out = indexifyRecapForLlm(content, NOW);
    assert.ok(out.includes("好饿"), "TTL=0 时瞬时条目不剔除（回退旧行为）");
  } finally {
    if (prev === undefined) delete process.env.RECAP_TRANSIENT_TTL_DAYS;
    else process.env.RECAP_TRANSIENT_TTL_DAYS = prev;
  }
});

test("F 视图集成：事故回放——「好饿」不再出现在注入视图，持久项带策略位", () => {
  const recapContent = [
    "[session-recap]",
    "Earlier conversation recap:",
    "- [2026/10/08 周四 22:07] 用户表示\"好饿\"，尚未决定今晚吃什么。",
    "- [2026/10/08 周四 22:28] 用户希望规划兴义周末路线，尚待确认。",
  ].join("\n");
  const msgs: ChatCompletionMessageParam[] = [
    { role: "system", content: "sys" },
    { role: "assistant", content: recapContent },
    { role: "user", content: "周末的事情就先不管了" },
  ];
  const view = buildTimestampFreeLlmView(msgs, { now: NOW }).messages;
  const text = String(
    view.find((m) => typeof m.content === "string" && m.content.includes("[session-recap]"))!.content,
  );
  assert.ok(!text.includes("好饿"), `事故原话不得再出现在注入视图：\n${text}`);
  assert.ok(text.includes("[时效索引]"), "应补聚合说明（可检索性提示）");
  assert.ok(text.includes("兴义周末路线") && text.includes("策略:勿主动提"), "持久未闭环项以冷索引+策略位留存");
  assert.equal(msgs[1]!.content, recapContent, "存储层 recap 不得被就地改写");
});

