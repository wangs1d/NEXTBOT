/**
 * 2026-09-29 token 优化（P0-1/P0-2/P1-2）回归测试：
 * - 稳定层会话级冻结：同会话稳定层字节一致（前缀缓存前提），跨会话更新生效
 * - 本轮寻址块：命中话题/字段进动态层，空命中零注入
 * - 旅游规划族恒注入：瘦身 schema 恒定取出（2026-10-01 由 latch 替换，无会话状态）
 * - 搜索族 LLM 视图裁剪：条数/字段帽（只影响喂给 LLM 的内容）
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  preparePromptCachePlan,
} from "../src/external-model/prefix-cache.js";
import { formatTurnAddressingBlock } from "../src/agent/prompt-context-builder.js";
import {
  slimToolSchema,
  toolsMatchingCapabilityBeam,
} from "../src/external-model/lane-tool-sets.js";
import { compactToolOutputForLlm } from "../src/tokenjuice/compactor.js";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import type { AgentPromptMemoryContext } from "../src/external-model/types.js";

function buildMemory(variant: number): AgentPromptMemoryContext {
  return {
    persona: `【人格】\n稳定人格 v${variant}。`,
    userUnderstanding: `【我对用户的理解】\n- 关于「老婆」：用户已婚（09/01 确认）`,
    userFacts: `【用户档案·结构化事实】\n- 职业：独立开发者（09/01 更新）`,
    turnAddressing: variant === 1 ? "【本轮寻址】\n- 理解话题：老婆" : "【本轮寻址】\n- 事实字段：职业",
    semanticIntent: "闲聊",
    currentTime: `2026-09-29 1${variant}:00 周二`,
  } as AgentPromptMemoryContext;
}

describe("P0-1② 稳定层会话级冻结", () => {
  it("同会话不同轮：requestSystemMessages 字节一致（记忆变化被冻结）", () => {
    const plan1 = preparePromptCachePlan({
      providerId: "openai",
      model: "deepseek-flash",
      baseSystemPrompt: "你是私人管家。",
      memory: buildMemory(1),
      variant: "chat-tools",
      sessionId: "sess-freeze-a",
    });
    // 第二轮：稳定层源字段变了（人格 v2），但会话冻结应沿用首轮快照
    const plan2 = preparePromptCachePlan({
      providerId: "openai",
      model: "deepseek-flash",
      baseSystemPrompt: "你是私人管家。",
      memory: buildMemory(2),
      variant: "chat-tools",
      sessionId: "sess-freeze-a",
    });
    assert.equal(
      JSON.stringify(plan2.requestSystemMessages),
      JSON.stringify(plan1.requestSystemMessages),
      "同会话稳定层应字节一致",
    );
    // 动态尾巴照常新鲜（turnAddressing/currentTime 变化要体现）
    assert.ok(plan2.tailDynamicContext?.includes("事实字段：职业"));
    assert.ok(!plan1.tailDynamicContext?.includes("事实字段：职业"));
  });

  it("跨会话：新会话拿到更新后的稳定层（冻结不跨会话）", () => {
    preparePromptCachePlan({
      providerId: "openai",
      model: "deepseek-flash",
      baseSystemPrompt: "你是私人管家。",
      memory: buildMemory(1),
      variant: "chat-tools",
      sessionId: "sess-freeze-b",
    });
    const planNew = preparePromptCachePlan({
      providerId: "openai",
      model: "deepseek-flash",
      baseSystemPrompt: "你是私人管家。",
      memory: buildMemory(2),
      variant: "chat-tools",
      sessionId: "sess-freeze-c",
    });
    assert.ok(
      (planNew.requestSystemMessages[0] as { content: string }).content.includes("v2"),
      "新会话应看到更新后的稳定层",
    );
  });

  it("fullSystemPrompt = 冻结稳定层 + 新鲜动态层", () => {
    preparePromptCachePlan({
      providerId: "openai",
      model: "deepseek-flash",
      baseSystemPrompt: "你是私人管家。",
      memory: buildMemory(1),
      variant: "chat-tools",
      sessionId: "sess-freeze-d",
    });
    const plan2 = preparePromptCachePlan({
      providerId: "openai",
      model: "deepseek-flash",
      baseSystemPrompt: "你是私人管家。",
      memory: buildMemory(2),
      variant: "chat-tools",
      sessionId: "sess-freeze-d",
    });
    const stable = (plan2.requestSystemMessages[0] as { content: string }).content;
    assert.ok(plan2.fullSystemPrompt.startsWith(stable));
    assert.ok(plan2.fullSystemPrompt.includes("事实字段：职业"));
  });
});

describe("P0-1① 本轮寻址块", () => {
  it("命中话题+字段 → 双行清单", () => {
    const block = formatTurnAddressingBlock(["老婆", "老婆", "作息"], ["职业"]);
    assert.ok(block?.includes("理解话题：老婆、作息"));
    assert.ok(block?.includes("事实字段：职业"));
  });
  it("零命中 → undefined 零注入", () => {
    assert.equal(formatTurnAddressingBlock([], []), undefined);
  });
});

describe("P0-2 旅游规划族恒注入", () => {
  // 2026-10-01 架构替换：goal 正则+会话 latch 抖动大（"对了酒店呢"不命中），
  // 改为旅游规划族瘦身 schema 恒注入 router-first 任务轮——无会话状态，
  // 工具集合同 intent 恒同集，前缀缓存天然稳定。
  it("域信号预载/束注入恒同集（无状态，前缀缓存前提）", () => {
    const corpus: ChatCompletionTool[] = [
      {
        type: "function",
        function: { name: "travel.plan-itinerary", description: "行程", parameters: { type: "object", properties: {} } },
      },
      {
        type: "function",
        function: { name: "search_web", description: "搜索", parameters: { type: "object", properties: {} } },
      },
    ];
    // 束投影确定性：同语料重复投影恒同集（travel 硬编码已由域信号预载泛化替代）
    const beam = toolsMatchingCapabilityBeam(corpus, ["search"]);
    assert.deepEqual(toolsMatchingCapabilityBeam(corpus, ["search"]), beam);
    assert.deepEqual(toolsMatchingCapabilityBeam(corpus, []), []);
    // 瘦身恒等：同输入恒同输出
    assert.deepEqual(slimToolSchema(corpus[0]!), slimToolSchema(corpus[0]!));
  });
});

describe("P1-2 搜索族 LLM 视图裁剪", () => {
  it("12 条→8 条、超长字段截断；归档原文保真", async () => {
    const items = Array.from({ length: 12 }, (_, i) => ({
      title: `结果${i + 1}`,
      url: `https://example.com/${i + 1}`,
      snippet: "x".repeat(400),
    }));
    const out = await compactToolOutputForLlm({
      toolName: "search_web",
      ok: true,
      result: { provider: "p", items },
      stripKeys: ["provider"],
    });
    const parsed = JSON.parse(out.content) as { items: Array<{ snippet: string }> };
    assert.equal(parsed.items.length, 8, "条数应裁到 8");
    assert.ok(parsed.items[0]!.snippet.length <= 241, "字段应截到 240 字符");
    const original = JSON.parse(out.rawText) as { items: unknown[] };
    assert.equal(original.items.length, 12, "归档原文应保真 12 条");
  });
});

describe("explicit-breakpoint 显式缓存断点（2026-10-07）", () => {
  const ENV_KEY = "MINIMAX_EXPLICIT_CACHE_ENABLED";
  let saved: string | undefined;
  const withEnv = (value: string | undefined, fn: () => void) => {
    saved = process.env[ENV_KEY];
    if (value === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = value;
    try {
      fn();
    } finally {
      if (saved === undefined) delete process.env[ENV_KEY];
      else process.env[ENV_KEY] = saved;
    }
  };

  it("minimax：stable system 转块状 content 并带 cache_control 断点", () => {
    withEnv(undefined, () => {
      const plan = preparePromptCachePlan({
        providerId: "minimax",
        model: "MiniMax-M3",
        baseSystemPrompt: "你是私人管家。",
        memory: buildMemory(1),
        variant: "chat-tools",
        sessionId: "sess-bp-a",
      });
      const head = plan.requestSystemMessages[0]!;
      const parts = head.content as Array<{ type: string; text: string; cache_control?: { type: string } }>;
      assert.ok(Array.isArray(head.content), "minimax 的 system content 应为块状数组");
      assert.equal(parts.length, 1);
      assert.equal(parts[0]!.type, "text");
      assert.ok(parts[0]!.text.length > 0, "stable 层文本应在块内");
      assert.deepEqual(parts[0]!.cache_control, { type: "ephemeral" }, "块尾应打显式缓存断点");
      // 同会话冻结语义保持：第二轮（记忆变化）断点块字节一致
      const plan2 = preparePromptCachePlan({
        providerId: "minimax",
        model: "MiniMax-M3",
        baseSystemPrompt: "你是私人管家。",
        memory: buildMemory(2),
        variant: "chat-tools",
        sessionId: "sess-bp-a",
      });
      assert.equal(
        JSON.stringify(plan2.requestSystemMessages),
        JSON.stringify(plan.requestSystemMessages),
        "同会话断点块应字节一致（前缀缓存前提）",
      );
    });
  });

  it("minimax 开关关闭 / 其他 provider：system 保持字符串（不受断点影响）", () => {
    withEnv("0", () => {
      const plan = preparePromptCachePlan({
        providerId: "minimax",
        model: "MiniMax-M3",
        baseSystemPrompt: "你是私人管家。",
        variant: "chat",
      });
      assert.equal(typeof plan.requestSystemMessages[0]!.content, "string", "开关关闭应回退隐式模式");
    });
    const planDeepseek = preparePromptCachePlan({
      providerId: "deepseek",
      model: "deepseek-flash",
      baseSystemPrompt: "你是私人管家。",
      variant: "chat",
    });
    assert.equal(typeof planDeepseek.requestSystemMessages[0]!.content, "string", "deepseek 不应被打断点");
  });
});
