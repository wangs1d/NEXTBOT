/**
 * 显式「计划→执行」编排（2026-10-21 token 收敛）。
 *
 * 断言三组行为：
 * 1. 触发门槛：只有复杂任务才额外出计划调用，简单直办/单步查询不触发；开关默认开启；
 * 2. 规划轮收敛：不带工具、不带全量 system/画像，单独打 task_plane_plan stage；
 * 3. 计划落定后清空规划会话，执行轮仍拿完整工具面（baseStreamOpts）。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { requiresExplicitPlan } from "../src/agent/simple-task.js";
import {
  isPlanExecuteLoopEnabled,
  parseExecutionPlan,
  runPlanExecuteLoop,
  shouldPlanExecute,
} from "../src/agent/plan-execute-loop.js";
import type { ExternalChatProvider, AgentStreamOptions } from "../src/external-model/types.js";

test("requiresExplicitPlan：简单直办与单步查询不触发", () => {
  assert.equal(requiresExplicitPlan("现在几点了"), false);
  assert.equal(requiresExplicitPlan("帮我查一下明天北京天气"), false);
  assert.equal(requiresExplicitPlan("提醒我 10 分钟后叫醒我"), false);
});

test("requiresExplicitPlan：多步/多分句/长任务触发", () => {
  assert.equal(requiresExplicitPlan("先查一下三亚的天气，然后帮我规划三天行程"), true);
  assert.equal(
    requiresExplicitPlan("帮我订机票，再看下酒店价格，最后整理一份预算清单"),
    true,
  );
  assert.equal(
    requiresExplicitPlan(
      "我需要你去调研一下国内新能源车企最近三年的销量变化、主要车型的价格区间以及各家的智驾方案差异，" +
        "再结合我的预算给出购买建议",
    ),
    true,
  );
});

test("shouldPlanExecute：默认开启，AGENT_PLAN_EXECUTE_LOOP=0 关闭", () => {
  const saved = process.env.AGENT_PLAN_EXECUTE_LOOP;
  try {
    delete process.env.AGENT_PLAN_EXECUTE_LOOP;
    assert.equal(isPlanExecuteLoopEnabled(), true, "默认应开启");
    assert.equal(shouldPlanExecute("先查天气，然后规划行程"), true);
    assert.equal(shouldPlanExecute("现在几点了"), false, "简单任务仍不加计划调用");

    process.env.AGENT_PLAN_EXECUTE_LOOP = "0";
    assert.equal(isPlanExecuteLoopEnabled(), false);
    assert.equal(shouldPlanExecute("先查天气，然后规划行程"), false);
  } finally {
    if (saved === undefined) delete process.env.AGENT_PLAN_EXECUTE_LOOP;
    else process.env.AGENT_PLAN_EXECUTE_LOOP = saved;
  }
});

test("parseExecutionPlan：契约不变（goal + steps）", () => {
  const plan = parseExecutionPlan(
    '{"goal":"规划三亚三日行程","steps":[{"id":"1","intent":"查天气","suggestedTools":["weather.get_local"]},{"id":"2","intent":"排行程"}]}',
  );
  assert.ok(plan);
  assert.equal(plan.goal, "规划三亚三日行程");
  assert.equal(plan.steps.length, 2);
  assert.deepEqual(plan.steps[0]?.suggestedTools, ["weather.get_local"]);
});

test("规划轮收敛：无工具/无全量 system，执行轮保留工具面，计划后清空规划会话", async () => {
  const calls: Array<{
    hasTools: boolean;
    opts: AgentStreamOptions | undefined;
    systemOverride: string | undefined;
  }> = [];
  let clears = 0;
  const provider = {
    id: "mock",
    clearSession: () => {
      clears += 1;
    },
    streamCompletion: async (
      _sid: string,
      _turn: unknown,
      _onDelta: unknown,
      tools: unknown,
      opts: AgentStreamOptions | undefined,
    ) => {
      calls.push({
        hasTools: Boolean(tools),
        opts,
        systemOverride: opts?.systemPromptOverride,
      });
      return calls.length === 1
        ? '{"goal":"规划三日行程","steps":[{"id":"1","intent":"查天气"},{"id":"2","intent":"排行程"}]}'
        : "done";
    },
  } as unknown as ExternalChatProvider;

  const baseStreamOpts: AgentStreamOptions = {
    promptContext: { memory: "用户画像：喜欢海边" } as AgentStreamOptions["promptContext"],
    chatToolsBuiltin: [
      {
        type: "function",
        function: { name: "weather.get_local", description: "查天气", parameters: { type: "object", properties: {} } },
      },
    ],
    chatToolsExtra: [
      {
        type: "function",
        function: { name: "travel.plan-itinerary", description: "规划行程", parameters: { type: "object", properties: {} } },
      },
    ],
    maxThreadMessages: 20,
  };

  const result = await runPlanExecuteLoop({
    provider,
    planSessionId: "pe-test",
    userText: "先查一下三亚的天气，然后帮我规划三天行程",
    toolCtx: {} as never,
    baseStreamOpts,
  });

  assert.equal(calls.length, 2, "复杂任务 = 1 次计划 + 1 次执行");
  // 规划轮：无工具、紧凑 system、无画像记忆、独立审计 stage
  assert.equal(calls[0]?.hasTools, false);
  assert.match(calls[0]?.systemOverride ?? "", /任务规划器/);
  assert.ok((calls[0]?.systemOverride ?? "").length < 1200, "规划 system 必须紧凑");
  assert.equal(calls[0]?.opts?.promptContext, undefined, "规划轮不注入全量画像/记忆");
  assert.deepEqual(calls[0]?.opts?.chatToolsBuiltin, []);
  assert.deepEqual(calls[0]?.opts?.chatToolsExtra, []);
  assert.equal(calls[0]?.opts?.auditStage, "task_plane_plan");
  // 执行轮：工具面原样保留（计划步 suggestedTools 之外仍可经桥召回）
  assert.equal(calls[1]?.hasTools, true);
  assert.equal(calls[1]?.opts?.chatToolsExtra?.length, 1);
  assert.equal(calls[1]?.opts?.systemPromptOverride, undefined);
  // 规划会话在计划落定后清空（开头 + 计划后各一次）
  assert.equal(clears, 2);
  assert.equal(result.modelCalls, 2);
  assert.equal(result.plan?.steps.length, 2);
});
