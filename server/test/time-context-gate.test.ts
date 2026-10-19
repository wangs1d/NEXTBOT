// 按需时间上下文闸 + 时间轴视图选项回归（2026-10-06「时间戳不常驻 prompt」根修）。
//
// 契约：
//  - 闲聊轮（「我就存」「今天好累」）：不放行——LLM 视图无【对话时间轴】块、
//    promptMemory 无【当前时间】块；正文 [ts:] 帧剥离照常（防复述根修不回退）。
//  - 显式时间轮（几点/多久/八点半/提醒我）：放行，两块时间信息照旧注入。
//  - 会话保持：命中后 10 分钟内相邻轮不抖动。
//  - kill switch AGENT_TIME_CONTEXT_ON_DEMAND=0 恢复每轮必注入。
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

const BENCH_DATA_DIR = mkdtempSync(join(tmpdir(), "time-context-gate-"));
process.env.PA_DATA_DIR = BENCH_DATA_DIR;

const {
  turnRequestsTimeContext,
  resolveTimeContextAccess,
  resetTimeContextHoldForTests,
} = await import("../src/agent/time-context-gate.js");
const { buildTimestampFreeLlmView, buildMessageTimestampPrefix } = await import(
  "../src/external-model/chat-thread-store.js"
);

const NOW = new Date(2026, 9, 6, 12, 0, 0);

function user(text: string): ChatCompletionMessageParam {
  return { role: "user", content: `${buildMessageTimestampPrefix(new Date(2026, 9, 1, 20, 0, 0), NOW)}\n${text}` };
}
function assistant(text: string): ChatCompletionMessageParam {
  return { role: "assistant", content: `${buildMessageTimestampPrefix(new Date(2026, 9, 1, 20, 1, 0), NOW)}\n${text}` };
}

test("显式时间信号放行", () => {
  const open = [
    "现在几点了",
    "今天几号",
    "明天星期几",
    "这个项目用了多久了",
    "八点半叫我起床",
    "两点差一刻有个会",
    "下午3点提醒我拿快递",
    "19:30 还来得及吗",
    "what time is it",
  ];
  for (const t of open) {
    assert.equal(turnRequestsTimeContext(t), true, `应放行：${t}`);
  }
});

test("闲聊轮不放行（默认关）", () => {
  const closed = [
    "我就存",
    "今天好累",
    "这一点你说得对",
    "有一点想哭",
    "哈哈哈笑死",
    "帮我看下这张照片",
    "刘浩存就是我老婆 不行？",
  ];
  for (const t of closed) {
    assert.equal(turnRequestsTimeContext(t), false, `应不放行：${t}`);
  }
});

test("会话保持：命中后保持期内相邻轮不抖动，过期后回落", () => {
  resetTimeContextHoldForTests();
  const key = "hold-case@qq.com";
  assert.equal(resolveTimeContextAccess(key, "明天三点提醒我开会", NOW), true);
  // 保持期内闲聊轮仍放行
  assert.equal(resolveTimeContextAccess(key, "好", new Date(NOW.getTime() + 60_000)), true);
  assert.equal(resolveTimeContextAccess(key, "哈哈哈", new Date(NOW.getTime() + 5 * 60_000)), true);
  // 过期（>10min 无命中）回落
  assert.equal(
    resolveTimeContextAccess(key, "对了帮我看个东西", new Date(NOW.getTime() + 20 * 60_000)),
    false,
  );
});

test("kill switch：AGENT_TIME_CONTEXT_ON_DEMAND=0 恢复每轮放行", () => {
  resetTimeContextHoldForTests();
  process.env.AGENT_TIME_CONTEXT_ON_DEMAND = "0";
  try {
    assert.equal(resolveTimeContextAccess("kill-switch@qq.com", "我就存"), true);
  } finally {
    delete process.env.AGENT_TIME_CONTEXT_ON_DEMAND;
  }
  resetTimeContextHoldForTests();
});

test("includeTimeline=false：时间轴块不注入，[ts:] 帧剥离照常", () => {
  const msgs = [user("早上好"), assistant("早"), user("帮我找图")];
  const view = buildTimestampFreeLlmView(msgs, { includeTimeline: false }).messages;
  const texts = view.map((m) => (typeof m.content === "string" ? m.content : ""));
  assert.ok(texts.every((t) => !t.includes("[ts:")), "剥离不回退");
  assert.ok(!texts.some((t) => t.includes("对话时间轴")), "时间轴块不应注入");
  assert.equal(texts[texts.length - 1], "帮我找图");
});

test("includeTimeline 缺省=true：旧行为不变（时间轴照注入）", () => {
  const msgs = [user("早上好"), assistant("早"), user("帮我找图")];
  const view = buildTimestampFreeLlmView(msgs).messages;
  assert.ok(
    view.some((m) => m.role === "system" && typeof m.content === "string" && m.content.includes("对话时间轴")),
    "缺省应注入时间轴",
  );
});

// ============================================================
// 2026-10-19 时间认知：回忆类轮次也要放行时间轴
// ============================================================

test("回忆/过去时态放行：谈旧事时需要知道各句话发生在什么时候", () => {
  const open = [
    "我以前住在浙江",
    "之前那个项目怎么样了",
    "原来我在杭州待了三年",
    "去年搬家的时候你还帮我找过房子",
    "上次说的那个餐厅叫什么",
    "小时候我特别怕黑",
    "后来换工作了就很少联系了",
  ];
  for (const t of open) {
    assert.equal(turnRequestsTimeContext(t), true, `应放行：${t}`);
  }
});

test("时间轴带会话跨度：截断后仍知道这段对话从什么时候开始", () => {
  const msgs = [
    user("早上好"),
    assistant("早"),
    user("帮我找图"),
  ];
  const view = buildTimestampFreeLlmView(msgs).messages;
  const timeline = view.find(
    (m) => m.role === "system" && typeof m.content === "string" && m.content.includes("对话时间轴"),
  );
  assert.ok(timeline);
  assert.ok(
    String(timeline!.content).includes("本段对话跨度"),
    "跨天/跨周会话需要一条跨度锚，防把旧对话当今天",
  );
});
