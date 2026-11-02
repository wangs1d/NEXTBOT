import assert from "node:assert/strict";
import test from "node:test";

import {
  buildLayeredSystemPrompt,
  buildLayeredSystemPromptSections,
  finalizeChatSystemPrompt,
  TRUTHFULNESS_SYSTEM_SUFFIX_MARKER,
} from "../src/agent/prompt-builder.js";
import { formatNarrativeRecallPrompt } from "../src/agent/prompt-context-builder.js";
import type { AgentPromptMemoryContext } from "../src/external-model/types.js";

const BASE_SYSTEM = "你是用户的私人 Agent。";

test("finalizeChatSystemPrompt 始终注入事实可靠性约束", () => {
  const legacy = finalizeChatSystemPrompt(BASE_SYSTEM, { tools: true });
  assert.ok(
    legacy.includes(TRUTHFULNESS_SYSTEM_SUFFIX_MARKER),
    "普通工具模式应包含事实可靠性约束",
  );
  assert.ok(
    legacy.includes("禁止编造城市、天气、价格"),
    "应明确禁止编造位置、天气等事实",
  );

  const minimal = finalizeChatSystemPrompt(BASE_SYSTEM, { suppressRuntimeSuffixes: true });
  assert.ok(
    minimal.includes(TRUTHFULNESS_SYSTEM_SUFFIX_MARKER),
    "minimal 模式也应包含事实可靠性约束",
  );

  const minimalTiny = finalizeChatSystemPrompt(BASE_SYSTEM, {
    suppressRuntimeSuffixes: true,
    functionalSuffixes: false,
  });
  assert.ok(
    minimalTiny.includes(TRUTHFULNESS_SYSTEM_SUFFIX_MARKER),
    "极致省 token 模式也不能跳过事实可靠性约束",
  );
});

test("buildLayeredSystemPrompt 把 recentConversationHistory 并入【短期上下文】家族块且完整注入", () => {
  // 模拟 thread 较短时 agent-core 产出的最近 6 轮对话（多行，远超 4 行）
  const recentConversationHistory = [
    "用户：帮我查一下北京明天的天气",
    "Agent：北京明天晴，最高 28 度。",
    "用户：那上海呢",
    "Agent：上海明天多云，最高 26 度。",
    "用户：后天呢",
    "Agent：后天两地都有雨。",
  ].join("\n");

  const memory: AgentPromptMemoryContext = { recentConversationHistory };
  const prompt = buildLayeredSystemPrompt(BASE_SYSTEM, memory);

  // 家族合并后进入【短期上下文】块，以「最近对话」小节标签呈现
  assert.ok(prompt.includes("【短期上下文】"), "应包含【短期上下文】家族块标题");
  assert.ok(
    prompt.includes("最近对话："),
    "recentConversationHistory 应作为【短期上下文】的「最近对话」小节注入",
  );

  // "非用户最新指令"提示存在（全局记忆规则 + 短期上下文头部免责，防止 LLM 把回顾误读为最新指令）
  assert.ok(
    prompt.includes("不是用户的最新指令"),
    "应包含「不是用户的最新指令」提示，防止 LLM 把回顾误读为最新指令",
  );

  // 关键回归：每一行对话都应完整出现在 prompt 中（不被 slice(0,4) 丢弃）
  for (const line of recentConversationHistory.split("\n")) {
    assert.ok(
      prompt.includes(line),
      `最近对话行应完整保留（修复前会被 formatNarrativeRecallPrompt 的 slice(0,4) 丢弃）：${line}`,
    );
  }
});

test("buildLayeredSystemPrompt 把 workingMemorySummary 并入【短期上下文】家族块", () => {
  const workingMemorySummary = [
    "活跃目标：查询天气",
    "已知槽位：城市=北京",
    "待办：明天出门带伞",
  ].join("\n");

  const memory: AgentPromptMemoryContext = { workingMemorySummary };
  const prompt = buildLayeredSystemPrompt(BASE_SYSTEM, memory);

  assert.ok(prompt.includes("【短期上下文】"), "应包含【短期上下文】家族块标题");
  assert.ok(
    prompt.includes("工作记忆："),
    "workingMemorySummary 应作为【短期上下文】的「工作记忆」小节注入",
  );
  assert.ok(prompt.includes("活跃目标：查询天气"), "工作记忆内容应完整保留");
  assert.ok(prompt.includes("待办：明天出门带伞"), "工作记忆待办项应完整保留");
});

test("修复后：narrativeRecall 被压缩为 6 条，recentConversationHistory 仍完整保留", () => {
  // 模拟 agent-core 修复后的分离结构：narrativeRecall 只含召回条目
  const recallItems = [
    "用户偏好素食",
    "用户下周要出差",
    "用户养了一只猫",
    "用户在学吉他",
    "用户最近关注 AI",
    "用户周末通常去爬山",
    "用户还有第 7 条会被截断的记忆",
  ].join("\n");

  const recentConversationHistory = "用户：那个事情怎么样了\nAgent：还在处理中。";

  // formatNarrativeRecallPrompt 只保留前 6 条召回条目（当前设计上限）
  const formattedRecall = formatNarrativeRecallPrompt(recallItems);
  assert.ok(formattedRecall, "召回格式化后应有内容");
  assert.equal(
    (formattedRecall!.match(/- r\d+\|/g) || []).length,
    6,
    "formatNarrativeRecallPrompt 应只保留 6 条召回条目",
  );
  assert.ok(!formattedRecall!.includes("第 7 条"), "超出上限的召回条目应被截断");

  // 关键：recentConversationHistory 作为独立字段，不经过 formatNarrativeRecallPrompt
  const memory: AgentPromptMemoryContext = {
    narrativeRecall: formattedRecall,
    recentConversationHistory,
  };
  const prompt = buildLayeredSystemPrompt(BASE_SYSTEM, memory);

  // 召回块存在且只有 6 条
  assert.ok(prompt.includes("【记忆图联想检索】"), "应包含【记忆图联想检索】块");
  assert.ok(prompt.includes("NR|hits=6"), "召回块应标注 hits=6");

  // 最近对话并入【短期上下文】家族块完整存在（关键回归点）
  assert.ok(prompt.includes("【短期上下文】"), "应包含【短期上下文】家族块");
  assert.ok(
    prompt.includes("那个事情怎么样了"),
    "最近对话内容应完整保留，不被召回条目的条目上限截断影响",
  );
});

test("buildLayeredSystemPromptSections 把短期上下文家族块归入 dynamicContext", () => {
  const memory: AgentPromptMemoryContext = {
    workingMemorySummary: "活跃目标：测试",
    recentConversationHistory: "用户：你好",
  };
  const sections = buildLayeredSystemPromptSections(memory);

  // 人格正文（persona 字段）由上游注入，本用例未设故稳定层应无【人格】块；
  // 短期上下文仍必须留在 dynamicContext
  assert.equal(
    sections.stablePrefix.some((s) => s.includes("工作记忆") || s.includes("短期上下文")),
    false,
    "短期上下文不应进 stablePrefix（非稳定身份层）",
  );
  assert.equal(
    sections.stablePrefix.some((s) => s.startsWith("【人格")),
    false,
    "未注入 persona 时稳定层不应出现人格块",
  );
  assert.ok(
    sections.dynamicContext.some((s) => s.includes("工作记忆：")),
    "workingMemorySummary 应在 dynamicContext 的【短期上下文】家族块中",
  );
  assert.ok(
    sections.dynamicContext.some((s) => s.includes("最近对话：")),
    "recentConversationHistory 应在 dynamicContext 的【短期上下文】家族块中",
  );
});

test("回归：formatNarrativeRecallPrompt 仍会丢弃靠后的多行块（证明旧 bug 机制，为何需要独立块）", () => {
  // 模拟修复前的错误拼接：召回条目 + [最近对话] 块混在同一个字符串
  const mixedRecall = [
    "用户偏好素食",
    "用户下周要出差",
    "用户养了一只猫",
    "用户在学吉他",
    "用户最近关注 AI",
    "",
    "[最近对话]",
    "用户：那个事情怎么样了",
  ].join("\n");

  const formatted = formatNarrativeRecallPrompt(mixedRecall);

  // 修复前的 bug：条目上限截断只保留前 6 条非空行，靠后的 [最近对话] 正文被丢弃
  assert.ok(formatted, "格式化后应有内容");
  assert.ok(
    !formatted!.includes("那个事情怎么样了"),
    "修复前：混入 narrativeRecall 的 [最近对话] 行会被条目上限截断丢弃（这是旧 bug）",
  );
  assert.equal(
    (formatted!.match(/- r\d+\|/g) || []).length,
    6,
    "只保留前 6 条召回条目",
  );
});
