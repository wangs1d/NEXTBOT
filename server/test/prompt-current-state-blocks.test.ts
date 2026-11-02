/**
 * 当下状态块 + 顺嘴搭车块的 prompt 链路单测（2026-10-01 P0/P0.5/P1/P2）。
 *
 * 覆盖三环：
 *   1. prompt-assembler 渲染：【当下状态】/【顺嘴机会】块出现在分层 system prompt
 *   2. runtime-kernel 白名单：minimal/dynamic 模式不剥新字段（剥离=顺嘴失明）
 *   3. 顺嘴纪律：落在【当下状态】块内，不在人格正文里
 */
import assert from "node:assert/strict";
import test from "node:test";

import { buildLayeredSystemPrompt } from "../src/agent/prompt-builder.js";
import { RuntimeKernel } from "../src/agent/runtime-kernel.js";

const BASE_SYSTEM = "你是用户的私人 Agent。";

test("assembler 渲染【当下状态】与【顺嘴机会】块（动态层）", () => {
  const prompt = buildLayeredSystemPrompt(BASE_SYSTEM, {
    currentUserState: "用户此刻：屏幕焦点=打游戏（已9分钟）；在线状态=挂机（已3分钟）。",
    turnAside: "【顺嘴机会】\n（后台攒下的一件小事…）\n最近三天入睡偏晚",
  });
  assert.ok(prompt.includes("【当下状态】"), "应包含当下状态块");
  assert.ok(prompt.includes("屏幕焦点=打游戏"), "当下状态正文应完整注入");
  assert.ok(prompt.includes("【顺嘴机会】"), "应包含顺嘴机会块");
  assert.ok(prompt.includes("最近三天入睡偏晚"), "顺嘴事实应完整注入");
});

test("无当下状态/顺嘴时零注入（不出现空块标题）", () => {
  const prompt = buildLayeredSystemPrompt(BASE_SYSTEM, {});
  assert.ok(!prompt.includes("【当下状态】"));
  assert.ok(!prompt.includes("【顺嘴机会】"));
});

test("runtime-kernel dynamic 模式保留 currentUserState/turnAside", () => {
  const kernel = new RuntimeKernel();
  kernel.update({ enabled: true, promptMode: "dynamic" });
  const sanitized = kernel.sanitizePromptMemory(
    {
      currentUserState: "用户此刻：屏幕焦点=写代码（已2小时）。",
      turnAside: "【顺嘴机会】\nx",
    },
    kernel.planTurn("在吗", {
      currentUserState: "用户此刻：屏幕焦点=写代码（已2小时）。",
      turnAside: "【顺嘴机会】\nx",
    }),
  );
  assert.ok(sanitized?.currentUserState, "dynamic 模式不剥当下状态");
  assert.ok(sanitized?.turnAside, "dynamic 模式不剥顺嘴机会");
});

test("runtime-kernel minimal 模式保留 currentUserState/turnAside", () => {
  const kernel = new RuntimeKernel();
  kernel.update({ enabled: true, promptMode: "minimal" });
  const memory = {
    currentUserState: "用户此刻：屏幕焦点=写代码（已2小时）。",
    turnAside: "【顺嘴机会】\nx",
  };
  const sanitized = kernel.sanitizePromptMemory(memory, kernel.planTurn("在吗", memory));
  assert.ok(sanitized?.currentUserState, "minimal 模式不剥当下状态（剥=顺嘴失明）");
  assert.ok(sanitized?.turnAside, "minimal 模式不剥顺嘴机会");
});

test("顺嘴纪律随【当下状态】块进 prompt（人格正文不带规则清单）", () => {
  const prompt = buildLayeredSystemPrompt(BASE_SYSTEM, {
    persona: "【人格】\n有什么说什么。",
    // formatCurrentStatePrompt 的产出（生产同形）：状态行 + 一行纪律
    currentUserState:
      "用户此刻：屏幕焦点=打游戏（已40分钟）；在线状态=活跃在线。\n（顺嘴要贴此刻状态；他在专注或娱乐中时不给作息/休息类建议）",
  });
  assert.ok(prompt.includes("顺嘴要贴此刻状态"), "此刻状态的顺嘴纪律");
  assert.ok(prompt.includes("不给作息/休息类建议"), "专注/娱乐中不给作息建议");
  // 人格正文只剩 soul 措辞，不再承担纪律条目
  assert.equal(prompt.includes("顺嘴关心贴此刻"), false);
});
