/**
 * 接续建议结构化通道（2026-11-17 根修）：模型经 suggest_next_steps 工具提交
 * 建议，正文不再依赖 NEXT_UP 文本标记。本测试守住三件事：参数规范化、
 * 车道常驻可见、提示词契约。
 */
import assert from "node:assert/strict";
import test from "node:test";

const {
  SUGGEST_NEXT_STEPS_TOOL_DEFINITION,
  SUGGEST_NEXT_STEPS_TOOL_NAME,
  normalizeNextStepItems,
  readSuggestedNextSteps,
} = await import("../src/tools/next-steps-tools.js");
const {
  CHAT_LANE_CORE_NAMES,
  TASK_LANE_ROUTER_FIRST_LIGHT_NAMES,
  buildLaneCoreTools,
  buildTaskLaneRouterFirstLightTools,
} = await import("../src/external-model/lane-tool-sets.js");
const { RENDER_PROTOCOL_PROMPT } = await import(
  "../src/services/render-protocol-prompt.js"
);

test("工具定义：名称与参数契约稳定", () => {
  assert.equal(SUGGEST_NEXT_STEPS_TOOL_NAME, "suggest_next_steps");
  assert.equal(SUGGEST_NEXT_STEPS_TOOL_DEFINITION.type, "function");
  assert.equal(
    SUGGEST_NEXT_STEPS_TOOL_DEFINITION.function.name,
    "suggest_next_steps",
  );
  assert.deepEqual(
    SUGGEST_NEXT_STEPS_TOOL_DEFINITION.function.parameters?.required,
    ["items"],
  );
});

test("规范化：去编号/引号/结尾标点，去重限量", () => {
  const items = normalizeNextStepItems([
    "1. 看看深圳这几天的交通管制。",
    "-「再查查APEC深圳的详细安排」",
    "看看深圳这几天的交通管制",
    "   ",
    "把行程改成三天",
    "第四条应该被截掉",
  ]);
  assert.deepEqual(items, [
    "看看深圳这几天的交通管制",
    "再查查APEC深圳的详细安排",
    "把行程改成三天",
  ]);
});

test("规范化：超长条目丢弃，非字符串忽略", () => {
  assert.deepEqual(
    normalizeNextStepItems(["一".repeat(41), 123, null, "正常一条"]),
    ["正常一条"],
  );
});

test("readSuggestedNextSteps 只读 items 字段", () => {
  assert.deepEqual(readSuggestedNextSteps({ ok: true, items: ["A", "B"] }), [
    "A",
    "B",
  ]);
  assert.deepEqual(readSuggestedNextSteps({ ok: true, summary: "x" }), []);
  assert.deepEqual(readSuggestedNextSteps(null), []);
});

test("chat / task 车道常驻可见该工具", () => {
  assert.ok(CHAT_LANE_CORE_NAMES.includes(SUGGEST_NEXT_STEPS_TOOL_NAME));
  assert.ok(
    TASK_LANE_ROUTER_FIRST_LIGHT_NAMES.includes(SUGGEST_NEXT_STEPS_TOOL_NAME),
  );
  const corpus = [SUGGEST_NEXT_STEPS_TOOL_DEFINITION];
  const chatVisible = buildLaneCoreTools("chat", corpus).map((t) =>
    t.type === "function" ? t.function.name : "",
  );
  assert.ok(chatVisible.includes(SUGGEST_NEXT_STEPS_TOOL_NAME));
  const taskLight = buildTaskLaneRouterFirstLightTools(corpus).map((t) =>
    t.type === "function" ? t.function.name : "",
  );
  assert.ok(taskLight.includes(SUGGEST_NEXT_STEPS_TOOL_NAME));
});

test("提示词改为结构化通道，不再教模型手写标记", () => {
  assert.ok(RENDER_PROTOCOL_PROMPT.includes("suggest_next_steps"));
  assert.ok(!RENDER_PROTOCOL_PROMPT.includes("[NEXT_UP_START]"));
  assert.ok(!RENDER_PROTOCOL_PROMPT.includes("[NEXT_UP_END]"));
});
