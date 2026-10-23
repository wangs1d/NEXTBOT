// prompt-assembler 分层契约测试（2026-09-23 缓存修复回归）。
//
// 背景：sessionRecap 曾被放在稳定层（假设"会话内不变"），但滚动 recap 随
// thread 裁剪持续追加——稳定前缀每轮被打穿，工具循环 prefix cache 命中率
// 实测仅 37%。契约：随对话轮增长的内容必须在动态层；稳定层跨轮逐字节相等。
import assert from "node:assert/strict";
import test from "node:test";

import { assembleSystemPrompt } from "../src/agent/prompt-assembler.js";
import type { AgentPromptMemoryContext } from "../src/external-model/types.js";

function buildMemory(turn: number): AgentPromptMemoryContext {
  return {
    personalityCore: "你是可靠的私人管家。",
    userFacts: "【用户事实库】\n所在城市：杭州",
    memorySummary: "持久记忆：用户在做 NextBot 项目。",
    // 滚动 recap：随轮追加（模拟 thread 裁剪后 recap 增行）
    sessionRecap: `[session-recap] 第 ${turn} 轮前的摘要行。`,
    recentConversationHistory: `用户：第 ${turn} 轮消息`,
    currentTime: `2026-09-23 11:${String(10 + turn).padStart(2, "0")}`,
  } as AgentPromptMemoryContext;
}

test("sessionRecap 不进稳定层（随轮增长内容必须沉底）", () => {
  const { stableSystemPrompt, dynamicSystemPrompt } = assembleSystemPrompt("你是助理。", buildMemory(1));
  assert.ok(!stableSystemPrompt.includes("session-recap"), "稳定层不得包含 sessionRecap");
  assert.ok(stableSystemPrompt.includes("持久记忆"), "memorySummary 仍在稳定层");
  assert.ok(dynamicSystemPrompt?.includes("会话回顾"), "sessionRecap 在动态层短期上下文家族");
});

test("跨轮稳定层逐字节相等（prefix cache 前提）", () => {
  const t1 = assembleSystemPrompt("你是助理。", buildMemory(1));
  const t2 = assembleSystemPrompt("你是助理。", buildMemory(2));
  assert.equal(
    t1.stableSystemPrompt,
    t2.stableSystemPrompt,
    "仅 recap/时间变化的相邻两轮，稳定层必须逐字节相等",
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
