/**
 * 去路由化语义锁（2026-10-21）：普通轮统一车道、热路径不再有前置意图路由。
 * 只锁结构性事实，不做模型行为断言（行为由真机探针覆盖）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { buildUnifiedLaneDecision, buildPlanContinuationDecision } from "../src/agent/task-router.js";

const agentCoreSrc = readFileSync(
  new URL("../src/services/agent-core.ts", import.meta.url),
  "utf8",
);
const chatHandlerSrc = readFileSync(
  new URL("../src/ws/handlers/chat-user-message.ts", import.meta.url),
  "utf8",
);

test("统一车道决策：对话面 + 可分段 + 零预算（工具由模型自决）", () => {
  const d = buildUnifiedLaneDecision();
  assert.equal(d.plane, "chat");
  assert.equal(d.segmentable, true);
  assert.deepEqual(d.capabilities, []);
  assert.equal(d.budget, 0);
  assert.deepEqual(d.reasons, ["unified_lane"]);
});

test("计划续跑仍是唯一的确定性 task 入口", () => {
  const d = buildPlanContinuationDecision();
  assert.equal(d.plane, "task");
  assert.equal(d.segmentable, false);
});

test("agent-core 热路径不再调用前置路由 LLM / 投机搜索", () => {
  assert.ok(!/routeTurnByLlm\s*\(/.test(agentCoreSrc), "agent-core 不应再调用 routeTurnByLlm");
  assert.ok(!/speculativeSearch/.test(agentCoreSrc), "agent-core 不应再有投机搜索");
  assert.ok(!/routeTurnForWs[\s\S]{0,400}routeTurnByLlm/.test(agentCoreSrc), "WS 路由入口不应再走 LLM 分类");
});

test("WS 处理器仍通过 routeTurnForWs 取决策（实现已改为零 LLM）", () => {
  assert.ok(/routeTurnForWs/.test(chatHandlerSrc));
  assert.ok(!/classifyIntentByLlm|llm-task-router/.test(chatHandlerSrc));
});
