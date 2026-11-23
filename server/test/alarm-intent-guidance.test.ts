/**
 * 闹钟意图引导契约（2026-11-23 定稿）。
 *
 * 背景：闹钟能力不是独立工具，而是 calendar(action=create) 的 alarmIntent 字段。
 * 判定权归模型（alarmIntent 唯一开关），所以「引导口径」直接决定用户明确要闹钟时
 * 会不会漏传 true —— 漏传就静默退化成普通日程提醒（只弹窗、不响铃）。
 *
 * 2026-11-23 演进：
 *   上午口径 = 仅睡觉叫醒（「宁缺勿滥」，导致「明确说闹钟」也被挡成弹窗）；
 *   下午用户实测反馈「我明确要求用闹钟还是弹窗」→ 放宽为「用户明确说闹钟/叫醒/响铃
 *   就建真闹钟」，只有没提闹钟字样的纯提醒才不传。此文件锁下午口径。
 */
process.env.AGENT_TOOL_SEARCH_ENABLED = "on";
process.env.AGENT_NEURAL_EMBED_ENABLED = "off";
process.env.AGENT_NEURAL_RERANK_ENABLED = "off";
process.env.AGENT_NEURAL_INTENT_ENABLED = "off";

import assert from "node:assert/strict";
import { test } from "node:test";

const { buildCoreCapabilitySections } = await import("../src/agent/agent-capabilities.js");
const { getBuiltinAgentChatTools } = await import(
  "../src/external-model/openai-compatible-tool-loop.js"
);

function calendarSchema(): {
  createDescription: string;
  alarmIntentDescription: string;
} {
  const tools = getBuiltinAgentChatTools();
  const calendar = tools.find((t) => t.type === "function" && t.function?.name === "calendar");
  assert.ok(calendar, "calendar 复合工具必须在可见工具面上");
  const fn = calendar!.function!;
  const props = (fn.parameters as { properties?: Record<string, { description?: string }> })
    ?.properties;
  const alarmIntent = props?.alarmIntent?.description ?? "";
  return {
    createDescription: fn.description ?? "",
    alarmIntentDescription: alarmIntent,
  };
}

const promptLines = buildCoreCapabilitySections(null as never, undefined, undefined)
  .flatMap((s) => s.lines)
  .join("\n");

test("schema: alarmIntent 明确「用户说闹钟/叫醒/响铃就传 true」", () => {
  const { alarmIntentDescription } = calendarSchema();
  assert.match(alarmIntentDescription, /用户明确要用闹钟\/叫醒\/响铃时传 true/);
  for (const keyword of ["闹钟", "叫醒", "叫我起床", "响铃", "定个"]) {
    assert.ok(
      alarmIntentDescription.includes(keyword),
      `alarmIntent 描述须列出叫醒关键词「${keyword}」供模型识别`,
    );
  }
});

test("schema: alarmIntent 点出漏传后果（退化成只弹窗）", () => {
  const { alarmIntentDescription } = calendarSchema();
  assert.match(alarmIntentDescription, /不传会退化成普通日程提醒|只弹窗不会响铃/);
  assert.match(alarmIntentDescription, /真响铃.*语音叫醒|语音叫醒/);
});

test("schema: alarmIntent 只把纯提醒排除，不再排除「定个闹钟」", () => {
  const { alarmIntentDescription } = calendarSchema();
  assert.match(alarmIntentDescription, /定个X点的闹钟/);
  assert.match(alarmIntentDescription, /只有纯提醒不传/);
  assert.doesNotMatch(
    alarmIntentDescription,
    /没有睡觉语境的表述.*不传|范围仅限睡觉叫醒|宁缺勿滥/,
    "旧窄口径文案不得复活——它会把用户明确要的闹钟挡成弹窗",
  );
});

test("schema: calendar create 段写明要闹钟必须传 alarmIntent=true", () => {
  const { createDescription } = calendarSchema();
  assert.match(createDescription, /明早七点叫我起床|定个8点闹钟|用闹钟提醒我/);
  assert.match(createDescription, /必须传 alarmIntent=true/);
  assert.match(createDescription, /别漏传/);
});

test("prompt: 能力段给出明确要闹钟 → alarmIntent=true 的指引", () => {
  assert.match(promptLines, /用户明确要闹钟就用手机本地闹钟/);
  assert.match(promptLines, /alarmIntent=true/);
  assert.match(promptLines, /只弹窗不响铃/);
  assert.doesNotMatch(promptLines, /范围仅限叫醒\/起床语境|「定个闹钟」等普通提醒不传/);
});
