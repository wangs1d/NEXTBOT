import test from "node:test";
import assert from "node:assert/strict";

import {
  buildPersonaMoodBlock,
  resolvePersonaMood,
  resolveRelationshipTier,
} from "../src/agent/persona-core.js";
import { assembleLayeredSections } from "../src/agent/prompt-assembler.js";
import type { AgentPromptMemoryContext } from "../src/external-model/types.js";

test("rapport → 关系档位换算（<0.3→0，0.3~0.6→1，>0.6→2，缺省→1）", () => {
  assert.equal(resolveRelationshipTier(0.1), 0);
  assert.equal(resolveRelationshipTier(0.29), 0);
  assert.equal(resolveRelationshipTier(0.3), 1);
  assert.equal(resolveRelationshipTier(0.5), 1);
  assert.equal(resolveRelationshipTier(0.6), 1);
  assert.equal(resolveRelationshipTier(0.61), 2);
  assert.equal(resolveRelationshipTier(0.9), 2);
  assert.equal(resolveRelationshipTier(undefined), 1);
});

test("mood 解析互斥：任务面 > 情绪低落 > R0 > 被打趣 > R2 起劲 > 日常调侃", () => {
  const base = { tier: 2 as const };
  assert.equal(resolvePersonaMood({ ...base, isTaskPlane: true }), "serious");
  assert.equal(resolvePersonaMood({ ...base, valence: -0.6 }), "empathy");
  assert.equal(resolvePersonaMood({ tier: 0 }), "base");
  assert.equal(resolvePersonaMood({ ...base, userText: "你是不是又卡了" }), "playful");
  assert.equal(
    resolvePersonaMood({ ...base, valence: 0.5, arousal: 0.7 }),
    "roasting",
  );
  assert.equal(resolvePersonaMood({ tier: 1 }), "casual_wit");
});

test("mood 动态块：每个 mood 都有内容且含状态标题", () => {
  for (const mood of [
    "base",
    "casual_wit",
    "roasting",
    "playful",
    "empathy",
    "serious",
  ] as const) {
    const block = buildPersonaMoodBlock(mood);
    assert.ok(block.startsWith("【人格·状态"), `${mood} 块缺标题`);
    assert.ok(block.length > 10, `${mood} 块为空`);
  }
  assert.ok(buildPersonaMoodBlock("casual_wit").includes("接正事"));
  assert.ok(buildPersonaMoodBlock("serious").includes("零调侃"));
});

test("装配：persona（唯一人格正文）进稳定层，personaMood 沉动态层", () => {
  const memory: AgentPromptMemoryContext = {
    modeRoleGuidance: "对话脑。",
    persona: "【人格】\n你是用户的私人管家兼搭档。",
    personaMood: "【人格·状态：日常调侃】\n默认带一点吐槽。",
    toneGuidance: "本轮长度控制：以短回复为主。",
    emotionState: "情绪：紧张",
    relationshipGuidance: "本轮调子：松弛",
  };
  const { stablePrefix, dynamicContext } = assembleLayeredSections(memory);
  assert.ok(stablePrefix.some((b) => b.startsWith("【人格】")));
  assert.ok(dynamicContext.some((b) => b.startsWith("【人格·状态")));
  // 人格正文只有一份：稳定层不得出现第二个人格块
  assert.equal(stablePrefix.filter((b) => b.startsWith("【人格")).length, 1);
  // 旧【人格·静态】/【说话方式】系列已废
  assert.equal(stablePrefix.some((b) => b.startsWith("【人格·静态")), false);
  assert.equal(stablePrefix.some((b) => b.startsWith("【说话方式")), false);
  // 语气/情绪/关系行不再进【本轮说话适配】（由 mood 块承担）
  const guide = dynamicContext.find((b) => b.startsWith("【本轮说话适配】"));
  assert.ok(guide);
  assert.ok(guide.includes("模式："));
  assert.equal(guide.includes("语气："), false);
  assert.equal(guide.includes("情绪："), false);
  assert.equal(guide.includes("关系："), false);
});

test("装配：无 persona 字段时不输出空壳，旧字段兜底不炸", () => {
  const { stablePrefix, dynamicContext } = assembleLayeredSections({
    memorySummary: "x",
  } as AgentPromptMemoryContext);
  assert.equal(stablePrefix.some((b) => b.startsWith("【人格")) , false);
  assert.equal(dynamicContext.some((b) => b.startsWith("【人格·状态")), false);
});

test("mood gate：R2 起劲但学到的容忍度低 → 降回日常调侃", () => {
  const excited = { tier: 2 as const, valence: 0.5, arousal: 0.7 };
  assert.equal(resolvePersonaMood({ ...excited, humorTolerance: 0.8 }), "roasting");
  assert.equal(resolvePersonaMood({ ...excited, humorTolerance: 0.2 }), "casual_wit");
  // 缺省按中性 0.5，保持原行为
  assert.equal(resolvePersonaMood(excited), "roasting");
});
