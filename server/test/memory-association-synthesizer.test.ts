import assert from "node:assert/strict";
import test from "node:test";

import {
  parseAssociationsFromLlmOutput,
  createMemoryAssociationSynthesizer,
} from "../src/brain/memory-cognitive/memory-association-synthesizer.js";

// ── LLM 输出解析 ─────────────────────────────────────────────

test("parseAssociationsFromLlmOutput: 解析标准 JSON 数组", () => {
  const output = JSON.stringify({
    associations: [
      { conclusion: "用户每次出差前都会预订同一家酒店", confidence: 0.8, reasoning: "记忆1与记忆3的时间线重合" },
      { conclusion: "用户出差与素食偏好叠加时倾向选择沙拉", confidence: 0.6, reasoning: "记忆2与记忆4" },
    ],
  });
  const result = parseAssociationsFromLlmOutput(output);
  assert.equal(result.length, 2);
  assert.equal(result[0]!.conclusion, "用户每次出差前都会预订同一家酒店");
  assert.ok(Math.abs(result[0]!.confidence - 0.8) < 1e-9);
  assert.equal(result[1]!.confidence, 0.6);
});

test("parseAssociationsFromLlmOutput: 容忍代码块围栏", () => {
  const output = "```json\n" + JSON.stringify({ associations: [{ conclusion: "结论A结论A结论A", confidence: 0.9, reasoning: "r" }] }) + "\n```";
  const result = parseAssociationsFromLlmOutput(output);
  assert.equal(result.length, 1);
  assert.equal(result[0]!.conclusion, "结论A结论A结论A");
});

test("parseAssociationsFromLlmOutput: 容忍前后多余文本（提取 JSON 块）", () => {
  const output =
    "好的，以下是分析结果：\n" +
    JSON.stringify({ associations: [{ conclusion: "结论B结论B结论B", confidence: 0.7, reasoning: "r" }] });
  const result = parseAssociationsFromLlmOutput(output);
  assert.equal(result.length, 1);
});

test("parseAssociationsFromLlmOutput: 无关联输出空数组", () => {
  assert.deepEqual(parseAssociationsFromLlmOutput(JSON.stringify({ associations: [] })), []);
});

test("parseAssociationsFromLlmOutput: 非法 JSON 返回空数组", () => {
  assert.deepEqual(parseAssociationsFromLlmOutput("不是 JSON"), []);
  assert.deepEqual(parseAssociationsFromLlmOutput(""), []);
});

test("parseAssociationsFromLlmOutput: confidence clamp 到 [0,1] 且超界容忍", () => {
  const output = JSON.stringify({
    associations: [
      { conclusion: "超界置信度结论一", confidence: 1.7, reasoning: "r" },
      { conclusion: "负置信度结论二", confidence: -0.3, reasoning: "r" },
    ],
  });
  const result = parseAssociationsFromLlmOutput(output);
  assert.equal(result.length, 2);
  assert.equal(result[0]!.confidence, 1, ">1 应 clamp 到 1");
  assert.equal(result[1]!.confidence, 0, "<0 应 clamp 到 0");
});

test("parseAssociationsFromLlmOutput: 去重（相同结论前缀只保留一条）", () => {
  const output = JSON.stringify({
    associations: [
      { conclusion: "重复结论应该只保留一条", confidence: 0.8, reasoning: "a" },
      { conclusion: "重复结论应该只保留一条，但后面不同", confidence: 0.7, reasoning: "b" },
    ],
  });
  const result = parseAssociationsFromLlmOutput(output);
  assert.equal(result.length, 1);
});

test("parseAssociationsFromLlmOutput: 过短结论被过滤", () => {
  const output = JSON.stringify({
    associations: [{ conclusion: "太短", confidence: 0.9, reasoning: "r" }],
  });
  assert.deepEqual(parseAssociationsFromLlmOutput(output), []);
});

// ── 工厂降级 ─────────────────────────────────────────────

test("createMemoryAssociationSynthesizer: 无 API key 返回 null（静默降级）", () => {
  // 工厂回退链：入参 key → resolvePrimaryLlmClientConfig（跟随主对话 provider）→ OPENAI_API_KEY。
  // 本机 .env 若配了 MINIMAX/MOONSHOT key，空白入参会被回退救活——测试显式置
  // EXTERNAL_MODEL_PROVIDER=none 禁用主 LLM binding，只测「完全无 key」分支。
  const prev = {
    openai: process.env.OPENAI_API_KEY,
    provider: process.env.EXTERNAL_MODEL_PROVIDER,
  };
  delete process.env.OPENAI_API_KEY;
  process.env.EXTERNAL_MODEL_PROVIDER = "none";
  try {
    assert.equal(createMemoryAssociationSynthesizer(), null);
    assert.equal(createMemoryAssociationSynthesizer("   "), null);
  } finally {
    if (prev.openai !== undefined) process.env.OPENAI_API_KEY = prev.openai;
    if (prev.provider !== undefined) process.env.EXTERNAL_MODEL_PROVIDER = prev.provider;
    else delete process.env.EXTERNAL_MODEL_PROVIDER;
  }
});

test("createMemoryAssociationSynthesizer: 有 API key 返回实例", () => {
  const synth = createMemoryAssociationSynthesizer("sk-test");
  assert.ok(synth, "有 key 应创建实例");
  assert.equal(synth.enabled, true);
});
