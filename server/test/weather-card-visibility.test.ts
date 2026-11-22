/**
 * 天气卡「只回文字」根因回归（2026-11-21）。
 *
 * 根因：天气工具被复合工具 web_search 收编后不再对模型暴露，而 prompt 4️⃣ 却仍写
 * `weather.get_local`。模型看不到语义明确的入口，常把天气查询落到 web_search 的
 * web 分支（或直接凭知识作答）→ 本轮没有 effectiveTool=weather.get_local 的回执 →
 * weather.scene.ts detect 不命中 → done 只剩文字，用户看不到天气卡。
 *
 * 锁定三条：
 *   1. weather.get_local 必须直接对模型可见（与语音细分工具同一例外机制）；
 *   2. 复合路径 web_search(action=weather) 仍归一到同一执行器（两条路等价）；
 *   3. 拿到真实天气回执后，唯一渲染出口必须产出 cardType=weather 的信封块。
 */
process.env.AGENT_TOOL_SEARCH_ENABLED = "on";
process.env.AGENT_NEURAL_EMBED_ENABLED = "off";
process.env.AGENT_NEURAL_RERANK_ENABLED = "off";
process.env.AGENT_NEURAL_INTENT_ENABLED = "off";

import assert from "node:assert/strict";
import { test } from "node:test";

const { getBuiltinAgentChatTools } = await import(
  "../src/external-model/openai-compatible-tool-loop.js"
);
const { resolveEffectiveToolName } = await import(
  "../src/external-model/composite-chat-tools.js"
);
const { renderTurn } = await import("../src/render/index.js");

test("可见性：weather.get_local 必须直接暴露给 LLM", () => {
  const names = new Set(
    getBuiltinAgentChatTools()
      .filter((t) => t.type === "function")
      .map((t) => t.function.name),
  );
  assert.ok(
    names.has("weather.get_local"),
    "天气工具被复合收编会让模型只拿到 web_search，回执为空 → 天气卡恒不出",
  );
  assert.ok(names.has("web_search"), "复合入口仍保留，作为等价路径");
});

test("复合路径：web_search(action=weather) 归一到 weather.get_local", () => {
  assert.equal(
    resolveEffectiveToolName("web_search", { action: "weather", city: "兴义" }),
    "weather.get_local",
  );
  assert.equal(
    resolveEffectiveToolName("web_search", { action: "web", query: "天气" }),
    "search_web",
    "关键词不再改写 action：选错分支就拿不到天气回执，这正是可见性修复要防的场景",
  );
});

test("出卡：天气回执经唯一渲染出口产出 weather 卡块", () => {
  const result = renderTurn(
    {
      text: "明天有小雨，出门带把伞。",
      userText: "明天天气怎么样",
      effects: [
        {
          tool: "weather.get_local",
          status: "ok",
          result: {
            ok: true,
            weatherText: "小雨",
            todayRangeC: "18–24℃",
            summary: "兴义 · 明天天气",
            focusDay: "tomorrow",
            tomorrowRangeC: "18–24℃",
          },
        },
      ],
    },
    "cards-only",
  );
  const cardBlocks = result.envelope.blocks.filter((b) => b.type === "card");
  assert.ok(cardBlocks.length > 0, "有天气回执就必须有卡块");
  assert.ok(
    cardBlocks.some((b) => b.cardType === "weather" || b.card?.cardType === "weather"),
    `卡块必须是 weather 类型，实际=${JSON.stringify(cardBlocks)}`,
  );
});
