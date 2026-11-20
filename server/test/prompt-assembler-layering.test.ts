// prompt-assembler 分层契约测试（2026-09-23 缓存修复回归）。
//
// 契约：随对话轮增长的内容必须在动态层；稳定层跨轮逐字节相等。
// 账号级 sessionRecap 已下线，「会话回顾」不再存在——会话连续性由会话级
// STM（workbench/最近对话/今日日志）承担。
import assert from "node:assert/strict";
import test from "node:test";

import { assembleSystemPrompt } from "../src/agent/prompt-assembler.js";
import { buildClientSurfacesBlock } from "../src/agent/prompt-context-builder.js";
import type { AgentPromptMemoryContext } from "../src/external-model/types.js";

function buildMemory(turn: number): AgentPromptMemoryContext {
  return {
    persona: "【人格】\n你是可靠的私人管家。",
    userFacts: "【用户事实库】\n所在城市：杭州",
    recentConversationHistory: `用户：第 ${turn} 轮消息`,
    currentTime: `2026-09-23 11:${String(10 + turn).padStart(2, "0")}`,
  } as AgentPromptMemoryContext;
}

test("随轮增长的内容不进稳定层（短期上下文必须沉底）", () => {
  const { stableSystemPrompt, dynamicSystemPrompt } = assembleSystemPrompt("你是助理。", buildMemory(1));
  assert.ok(!stableSystemPrompt.includes("会话回顾"), "账号级会话回顾已下线，不得出现在任何层");
  assert.ok(dynamicSystemPrompt?.includes("最近对话"), "短期上下文家族在动态层");
});

test("memory_summary 已下线：即使旧数据残留也不注入【持久记忆】", () => {
  const memory = {
    ...buildMemory(1),
    memorySummary: "持久记忆：用户在做 NextBot 项目。",
  } as AgentPromptMemoryContext;
  const { stableSystemPrompt, dynamicSystemPrompt } = assembleSystemPrompt("你是助理。", memory);
  assert.ok(!stableSystemPrompt.includes("持久记忆"));
  assert.ok(!dynamicSystemPrompt?.includes("持久记忆"));
});

test("事件回忆只进动态层（每轮随话题变）", () => {
  const memory = {
    ...buildMemory(1),
    eventRecall: "【事件回忆】\n- 2026/10/28 15:37 比价 小米15 → 最低 ¥1884（taobao） [完成]",
  } as AgentPromptMemoryContext;
  const { stableSystemPrompt, dynamicSystemPrompt } = assembleSystemPrompt("你是助理。", memory);
  assert.ok(!stableSystemPrompt.includes("事件回忆"), "稳定层不得包含事件回忆");
  assert.ok(dynamicSystemPrompt?.includes("事件回忆"), "事件回忆在动态层");
  assert.ok(dynamicSystemPrompt?.includes("小米15"), "回忆行完整进入 prompt");
});

test("跨轮稳定层逐字节相等（prefix cache 前提）", () => {
  const t1 = assembleSystemPrompt("你是助理。", buildMemory(1));
  const t2 = assembleSystemPrompt("你是助理。", buildMemory(2));
  assert.equal(
    t1.stableSystemPrompt,
    t2.stableSystemPrompt,
    "仅短期上下文/时间变化的相邻两轮，稳定层必须逐字节相等",
  );
  assert.notEqual(t1.fullSystemPrompt, t2.fullSystemPrompt, "动态层随轮变化（否则断言无意义）");
});

// 2026-09-24 晨报 [RENDER_HINT:brief] 事故回归：展示形式协议只属于聊天面，
// ephemeral 工具调用（简报润色/摘要/改写）的 system 不得携带协议。
test("includeRenderProtocol=false 时不注入展示形式协议（ephemeral 工具调用）", () => {
  const withMemory = assembleSystemPrompt("你是助理。", buildMemory(1), {
    includeRenderProtocol: false,
  });
  assert.ok(
    !withMemory.fullSystemPrompt.includes("RENDER_HINT"),
    "带记忆上下文时协议也不得注入",
  );
  const ephemeral = assembleSystemPrompt("写一段今早的简报播报稿。", undefined, {
    includeRenderProtocol: false,
  });
  assert.ok(!ephemeral.fullSystemPrompt.includes("RENDER_HINT"), "ephemeral 调用不带协议");
  // 默认（聊天面）行为不变：协议仍在
  const chatDefault = assembleSystemPrompt("写一段今早的简报播报稿。", undefined);
  assert.ok(chatDefault.fullSystemPrompt.includes("RENDER_HINT"), "默认仍注入协议");
});

// 内置浏览器当前页：客户端已上报、服务端已留存的界面事实。随上报变化 ⇒ 动态层。
test("clientSurfaces 只进动态层（随上报变化）", () => {
  const memory = {
    ...buildMemory(1),
    clientSurfaces: "【用户界面】内置浏览器面板当前页：www.fliggy.com/hotel/detail（最近一次上报 12 分钟前）",
  } as AgentPromptMemoryContext;
  const { stableSystemPrompt, dynamicSystemPrompt } = assembleSystemPrompt("你是助理。", memory);
  assert.ok(!stableSystemPrompt.includes("用户界面"), "稳定层不得包含界面状态");
  assert.ok(dynamicSystemPrompt?.includes("内置浏览器面板当前页"), "当前页进动态层");
});

test("buildClientSurfacesBlock：去 query/hash、带龄期、无上报不注入", () => {
  const now = Date.parse("2026-10-31T12:00:00Z");
  const block = buildClientSurfacesBlock(
    "https://www.fliggy.com/hotel/detail?id=1&token=abc#reviews",
    now - 42_000,
    now,
  );
  assert.equal(
    block,
    "【用户界面】内置浏览器面板当前页：www.fliggy.com/hotel/detail（最近一次上报 42 秒前）",
  );
  assert.ok(!block?.includes("token"), "query/hash 不进 prompt");
  assert.match(buildClientSurfacesBlock("https://example.com", now - 5 * 60_000, now) ?? "", /5 分钟前/);
  assert.match(buildClientSurfacesBlock("https://example.com", now - 3 * 3600_000, now) ?? "", /3 小时前/);
  assert.equal(buildClientSurfacesBlock("about:blank", now, now), undefined);
  assert.equal(buildClientSurfacesBlock("", now, now), undefined);
  // 汇报时刻未知：不写龄期，也不编一个「几万小时前」
  assert.equal(
    buildClientSurfacesBlock("https://example.com/", 0, now),
    "【用户界面】内置浏览器面板当前页：example.com",
  );
});
