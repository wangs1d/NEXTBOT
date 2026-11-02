import test from "node:test";
import assert from "node:assert/strict";

import {
  assembleLayeredSections,
  GLOBAL_MEMORY_RULE,
} from "../src/agent/prompt-assembler.js";
import {
  buildPersonaMoodBlock,
} from "../src/agent/persona-core.js";
import {
  buildToneGuidance,
  defaultEmotionState,
} from "../src/services/user-personalization/emotion-tone.js";
import { RuntimeKernel } from "../src/agent/runtime-kernel.js";
import type { AgentPromptMemoryContext } from "../src/external-model/types.js";

function chatMemory(overrides: Partial<AgentPromptMemoryContext> = {}): AgentPromptMemoryContext {
  return {
    modeRoleGuidance: "你现在是对话里那个\"人\"本人。",
    replyStyleMode: "chat",
    toneGuidance: "本轮长度控制：以短回复为主。",
    ...overrides,
  };
}

function sectionsOf(memory: AgentPromptMemoryContext) {
  return assembleLayeredSections(memory);
}

test("chat 模式把唯一人格正文（memory.persona）注入稳定层", () => {
  const persona = "【人格】\n我是 NEXTBOT，一个球形小机器人。\n有什么说什么。";
  const { stablePrefix } = sectionsOf(chatMemory({ persona }));
  const block = stablePrefix.find((b) => b.startsWith("【人格】"));
  assert.ok(block, "人格正文必须注入稳定层");
  assert.equal(block, persona);
  // 人格只有这一份：旧的静态/灵魂分层块不得复现
  assert.equal(stablePrefix.some((b) => b.startsWith("【人格·静态")), false);
  assert.equal(stablePrefix.some((b) => b.startsWith("【灵魂")), false);
  // 旧【说话方式】两块（管家底色/伙伴面）整体废弃
  assert.equal(stablePrefix.some((b) => b.startsWith("【说话方式")), false);
});

test("task 模式 mood 由 personaMood 承担（serious），适配块只剩模式行", () => {
  const { stablePrefix, dynamicContext } = sectionsOf(
    chatMemory({
      personaMood: buildPersonaMoodBlock("serious"),
      toneGuidance: "本轮长度控制：以短回复为主。",
    }),
  );
  assert.equal(
    stablePrefix.some((b) => b.startsWith("【说话方式")), false,
  );
  const mood = dynamicContext.find((b) => b.startsWith("【人格·状态"));
  assert.ok(mood, "serious mood 应沉动态层");
  assert.ok(mood.includes("零调侃"));
  // 语气/情绪/关系行不再进【本轮说话适配】（mood 块已承担）
  const guide = dynamicContext.find((b) => b.startsWith("【本轮说话适配】"));
  assert.ok(guide);
  assert.equal(guide.includes("模式："), true);
  assert.equal(guide.includes("语气："), false);
});

test("适配小节全空时不再输出空壳【本轮说话适配】块", () => {
  const { dynamicContext } = sectionsOf({ replyStyleMode: "chat" });
  assert.equal(
    dynamicContext.some((b) => b.startsWith("【本轮说话适配】")),
    false,
  );
});

test("buildToneGuidance 默认路径静默：balanced + 中性情绪不产出重复基准的行", () => {
  const state = defaultEmotionState(); // balanced, recent=[]
  assert.equal(buildToneGuidance(state), "");
});

test("buildToneGuidance 偏离默认时给出方向行，且不再输出情绪轨迹元信息", () => {
  const formal = defaultEmotionState();
  formal.preferredTone = "formal";
  const formalGuide = buildToneGuidance(formal);
  assert.equal(formalGuide.includes("保持正式"), true);

  const low = defaultEmotionState();
  low.recent = ["negative", "negative"];
  const lowGuide = buildToneGuidance(low);
  assert.equal(lowGuide.includes("语气放柔"), true);
  assert.equal(lowGuide.includes("情绪轨迹"), false);
});

test("minimal 模式保留 replyStyleMode，buildSessionSystem 不再携带风格指针行", () => {
  const kernel = new RuntimeKernel();
  kernel.update({ enabled: true, promptMode: "minimal" });

  const memory = chatMemory({ memorySummary: "Has two meetings today." });
  const plan = kernel.planTurn("在吗", memory);
  const sanitized = kernel.sanitizePromptMemory(memory, plan);

  assert.equal(sanitized?.replyStyleMode, "chat");
  assert.equal(sanitized?.modeRoleGuidance, memory.modeRoleGuidance);

  const sessionSystem = kernel.buildSessionSystem() ?? "";
  // 2026-10-06 活人感治理 B：身份块压缩后的英文锚点（~150tok / 4 行）
  assert.equal(sessionSystem.includes("personal butler and close friend"), true);
  assert.equal(sessionSystem.includes("Reply style follows"), false);

  // 单一人格出口防回退：minimal 模式不得剥离人格正文与 mood
  const personaMemory = chatMemory({
    persona: "【人格】\n有什么说什么。",
    personaMood: "【人格·状态：日常调侃】\n默认带一点吐槽。",
  });
  const personaSanitized = kernel.sanitizePromptMemory(
    personaMemory,
    kernel.planTurn("在吗", personaMemory),
  );
  assert.equal(personaSanitized?.persona, personaMemory.persona);
  assert.equal(personaSanitized?.personaMood, personaMemory.personaMood);
});

assert.ok(GLOBAL_MEMORY_RULE.length > 0);
