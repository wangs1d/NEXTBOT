import assert from "node:assert/strict";
import test from "node:test";

import { compileMemoryContext } from "../src/agent/memory-context-compiler.js";
import type { AgentPromptMemoryContext } from "../src/external-model/types.js";

test("跨源去重：事实先认领，画像同值不再出现", () => {
  const memory: AgentPromptMemoryContext = {
    userFacts: "【用户档案·结构化事实】\n（说明行）\n- 所在城市：杭州\n- 职业：独立开发者",
    userProfileSummary: "【用户长期画像】\n- 所在城市：杭州\n- 宠物：一只猫",
  };
  const { memory: out, dedupedLines } = compileMemoryContext(memory);
  assert.equal(dedupedLines, 1);
  assert.match(out.memoryCurrentState ?? "", /所在城市：杭州/);
  assert.match(out.memoryCurrentState ?? "", /宠物：一只猫/);
  assert.equal((out.memoryCurrentState ?? "").match(/所在城市：杭州/g)?.length, 1);
  assert.equal(out.userFacts, undefined, "候选源编译后清空");
  assert.equal(out.userProfileSummary, undefined);
  assert.doesNotMatch(out.memoryCurrentState ?? "", /说明行/);
});

test("历史/计划行不进当前状态", () => {
  const memory: AgentPromptMemoryContext = {
    userFacts:
      "【用户档案·结构化事实】\n- 称呼：王哥\n- 城市：〔历史〕杭州\n- 旅行：〔计划〕三亚（2026-12-01 起）",
  };
  const { memory: out } = compileMemoryContext(memory);
  assert.match(out.memoryCurrentState ?? "", /称呼：王哥/);
  assert.doesNotMatch(out.memoryCurrentState ?? "", /杭州|三亚/);
});

test("在办最多 3 条，按紧迫度并带龄期", () => {
  const now = Date.parse("2026-11-20T10:00:00Z");
  const memory: AgentPromptMemoryContext = {
    memoryOpenLoops:
      "- 牙医复诊（2026-11-18）\n- 交房租（已逾期 2 天，截止 11/18）\n- 订机票\n- 第四条不该出现",
  };
  const { memory: out } = compileMemoryContext(memory, now);
  const lines = (out.memoryPending ?? "").split("\n").filter((l) => l.startsWith("- "));
  assert.equal(lines.length, 3);
  assert.ok(lines.some((l) => /已逾期 2 天/.test(l)));
  assert.ok(lines.some((l) => /牙医复诊/.test(l) && /2 天前/.test(l)));
  assert.equal(out.memoryOpenLoops, undefined);
});

test("按需回忆最多 5 行，总预算 1200", () => {
  const now = Date.parse("2026-11-20T10:00:00Z");
  const memory: AgentPromptMemoryContext = {
    eventRecall: Array.from({ length: 8 }, (_, i) => `- 2026/11/${10 + i} 查过比价 ${i}`).join("\n"),
    narrativeRecall: `- 旧事：${"很长的叙事".repeat(200)}`,
    userFacts: "- 称呼：王哥\n- 城市：兴义",
    memoryOpenLoops: "- 交房租\n- 订机票\n- 牙医复诊\n- 第四件",
  };
  const { memory: out, chars, budgetChars } = compileMemoryContext(memory, now);
  const recallLines = (out.memoryRecall ?? "").split("\n").filter((l) => l.startsWith("- "));
  assert.ok(recallLines.length <= 5);
  assert.ok(chars <= budgetChars);
  assert.equal(budgetChars, 1200);
  assert.ok(chars <= 1200);
  assert.match(out.memoryCurrentState ?? "", /称呼：王哥/);
});

test("输入对象不被修改", () => {
  const memory: AgentPromptMemoryContext = {
    userFacts: "- 所在城市：杭州",
    userProfile: "- 所在城市：杭州",
  };
  compileMemoryContext(memory);
  assert.match(memory.userProfile ?? "", /所在城市：杭州/);
  assert.match(memory.userFacts ?? "", /所在城市：杭州/);
});
test("长尾召回块进按需回忆，检索序号前缀被剥掉", () => {
  const memory: AgentPromptMemoryContext = {
    tailFactsRecall:
      "【相关长尾记忆】\n（用户过去表达过的偏好）\n- 用户喜欢自助餐（11/20 记录）",
    narrativeRecall: "NR|hits=1\n- r7|用户习惯去游泳和健身",
  };
  const { memory: out } = compileMemoryContext(memory);
  assert.match(out.memoryRecall ?? "", /用户喜欢自助餐/);
  assert.doesNotMatch(out.memoryRecall ?? "", /自助餐（11\/20/);
  assert.match(out.memoryRecall ?? "", /用户习惯去游泳和健身/);
  assert.doesNotMatch(out.memoryRecall ?? "", /r7\|/);
  assert.equal(out.tailFactsRecall, undefined);
});
