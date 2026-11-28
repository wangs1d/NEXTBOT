import assert from "node:assert/strict";
import test from "node:test";

import { planMemoryRecall } from "../src/agent/recall-planner.js";
import type { TurnUnderstanding } from "../src/agent/task-router.js";

function understanding(patch: Partial<TurnUnderstanding>): TurnUnderstanding {
  return { isFollowUp: false, ...patch } as TurnUnderstanding;
}

test("Recall Planner：门控关闭时零通道、零候选", () => {
  const plan = planMemoryRecall({ text: "你好" });
  assert.equal(plan.trigger, false);
  assert.deepEqual(plan.channels, []);
  assert.equal(plan.finalN, 0);
  assert.deepEqual(plan.skipReasons, ["recall_gate_off"]);
});

test("Recall Planner：记忆指令启用核心通道并分配预算", () => {
  const plan = planMemoryRecall({
    text: "我之前说过喜欢什么",
    understanding: understanding({ recallIntent: true }),
  });
  assert.equal(plan.trigger, true);
  assert.equal(plan.reason, "memory_cue");
  assert.ok(plan.channels.includes("event"));
  assert.ok(plan.channels.includes("tailFacts"));
  assert.ok(plan.channels.includes("profile"));
  assert.equal(plan.candidateK.agentic, 8);
  assert.equal(plan.finalN, 6);
  assert.equal(plan.budgetChars, 1200);
  assert.equal(plan.conflictPolicy, "authority_then_recency");
});

test("Recall Planner：个人事实只走事实相关通道", () => {
  const plan = planMemoryRecall({
    text: "我住在哪里",
    understanding: understanding({ personalFact: true }),
  });
  assert.deepEqual(plan.channels, ["agentic", "lifeModel", "relationship", "tailFacts", "profile"]);
  assert.equal(plan.channels.includes("event"), false);
  assert.equal(plan.channels.includes("association"), false);
});

test("Recall Planner：长会话指代升级不扫事件与长尾", () => {
  const plan = planMemoryRecall({
    text: "那个后来怎么样了",
    threadMessageCount: 30,
    understanding: understanding({ isFollowUp: true }),
  });
  assert.equal(plan.reason, "anaphora_escalation");
  assert.deepEqual(plan.channels, ["agentic", "narrative", "association"]);
});

test("Recall Planner：显式工具召回与单域召回使用同一计划", () => {
  const explicit = planMemoryRecall({ text: "咖啡", force: true });
  assert.equal(explicit.reason, "explicit_recall");
  assert.ok(explicit.channels.includes("agentic"));

  const domain = planMemoryRecall({ text: "关系", domain: "relationship", force: true });
  assert.deepEqual(domain.channels, ["relationship"]);
  assert.equal(domain.conflictPolicy, "single_source");
});
