import assert from "node:assert/strict";
import test from "node:test";

import { isDirectFactQuery } from "../src/agent/direct-fact-query.js";
import { UserPersonalizationService } from "../src/services/user-personalization/user-personalization-service.js";

test("direct fact query detection stays narrow to factual lookups", () => {
  assert.equal(isDirectFactQuery("她现在在哪"), true);
  assert.equal(isDirectFactQuery("今天有没有确切消息"), true);
  assert.equal(isDirectFactQuery("分析一下她最近为什么这么火"), false);
});

test("personalization suppresses follow-up guidance for direct fact queries", async () => {
  const service = new UserPersonalizationService(null, null);
  const actorId = "direct-fact-user";

  (service as any).fallbackState.set(`${actorId}:user_style_profile`, {
    banterLevel: 0.4,
    playfulTolerance: 0.5,
    cuteTolerance: 0.4,
    teasingTolerance: 0.4,
    followUpTolerance: 0.92,
    expressiveTolerance: 0.4,
    careStyle: "gentle",
    motivationStyle: "steady",
    initiativeStyle: "balanced",
    lastUpdatedAt: new Date().toISOString(),
  });

  const slice = await service.getPromptSlice(actorId, "她今天在哪？有没有确切消息");

  // 单一事实查询：长度控制行收成「结论 + 1句依据」且明确压掉顺手追问
  assert.equal(slice.toneGuidance?.includes("结论 + 1句依据"), true);
  assert.equal(slice.toneGuidance?.includes("不要顺手追问"), true);
  // 2026-09-06 风格重构：关系块不再输出"可以/不要追问"这类说教行（即便 followUpTolerance 很高）
  assert.equal(slice.relationshipGuidance?.includes("顺手追问"), false);
});

test("personalization projects user register as observation data, not coaching", async () => {
  const service = new UserPersonalizationService(null, null);
  const actorId = "chatty-user";

  (service as any).fallbackState.set(`${actorId}:user_style_profile`, {
    banterLevel: 0.4,
    playfulTolerance: 0.5,
    cuteTolerance: 0.4,
    teasingTolerance: 0.4,
    followUpTolerance: 0.92,
    expressiveTolerance: 0.4,
    careStyle: "gentle",
    motivationStyle: "steady",
    initiativeStyle: "balanced",
    lastUpdatedAt: new Date().toISOString(),
  });

  const userText = "最近有点无聊，陪我聊两句";
  const slice = await service.getPromptSlice(actorId, userText);

  // 隐性跟随：给"对方语感"数据行（字数/语气），让模型自己模仿
  assert.equal(slice.relationshipGuidance?.includes("对方语感："), true);
  assert.equal(
    slice.relationshipGuidance?.includes(`这条约 ${userText.replace(/\s+/g, "").length} 字`),
    true,
  );
  // 旧版容忍度说教行与三条结尾总结句全部退场
  for (const legacy of [
    "回答完可以顺手追问半句",
    "先别硬凹风格",
    "无论怎么个性化",
    "不要把用户硬归类",
    "优先贴近用户当前说话方式",
  ]) {
    assert.equal(slice.relationshipGuidance?.includes(legacy), false, `legacy coaching leaked: ${legacy}`);
  }
  // toneGuidance 不再携带与【回复指南】基准行重复的"基础回复纪律"，也不再混入触达调度信息
  assert.equal(slice.toneGuidance?.includes("基础回复纪律"), false);
  assert.equal(slice.toneGuidance?.includes("较适合主动互动的时间帧"), false);
  assert.equal(slice.toneGuidance?.includes("Preferred proactive contact"), false);
  assert.equal(slice.toneGuidance?.includes("long-term behavior tendency"), false);
});

// 2026-10-13 根修：AssistantRewriterService（真人腔 LLM 改写器）已整体删除——
// 「已流式送出的文本即最终稿」，出口不再做任何二次改稿（含直答事实轮豁免逻辑）。
