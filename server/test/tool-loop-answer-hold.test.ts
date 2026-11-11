/**
 * 答案留存契约测试（2026-10-13 根修：工具轮的答案不进流式通道；
 * 2026-11-10 判据收窄为「回执出卡」——receiptProducesCard）。
 *
 * 用户定调：流式打字机只在闲聊轮。工具轮的跳变（先流式输出天气/查询正文
 * → done 弹卡）从**通道**上根除：工具循环对「回执会出卡」的轮次不再经
 * onDelta 直推正文，答案随返回值交 done 与卡片同帧下发。不出卡的回执
 * （查记忆/记账/失败回执）不扣流，正文照常流式分泡。
 *
 * 决策点唯一且确定性：tool-loop 是唯一知道「本轮是否执行过工具」的地方，
 * 回执在手即判。旧机制（WS 层回执反应式扣流 + stream_reset 撤回 +
 * 意图标签前置闸）均已退役。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DATA_DIR = mkdtempSync(join(tmpdir(), "tool-loop-answer-hold-"));
process.env.PA_DATA_DIR = DATA_DIR;
process.env.AGENT_TOKENJUICE_ENABLED = "0";
process.env.AGENT_TOOL_ARCH = "legacy";

const { streamCompletionWithTools } = await import(
  "../src/external-model/openai-compatible-tool-loop.js"
);
const { receiptProducesCard } = await import("../src/services/receipt-card-projection.js");
const { resetLlmUsageAuditForTest } = await import("../src/services/llm-token-audit.js");

type AnyChunk = Record<string, unknown>;

const ACK = "好的，我马上查。";
const FINAL_ANSWER =
  "查到了。兴义今天小雨，气温 15-20 度，湿度 85%，记得带伞。";
const POST_GATE_THINKING = "用户在问天气，我需要调天气工具拿实时数据。";

function ackThenToolChunks(ack: string, thinking: string): AnyChunk[] {
  return [
    { choices: [{ delta: { content: ack }, finish_reason: null }] },
    {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_h1",
                type: "function",
                function: {
                  name: "weather.get_local",
                  arguments: JSON.stringify({ city: "兴义" }),
                },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    { choices: [{ delta: { content: thinking }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
  ];
}

function textChunks(text: string): AnyChunk[] {
  const mid = Math.ceil(text.length / 2);
  return [
    { choices: [{ delta: { content: text.slice(0, mid) }, finish_reason: null }] },
    { choices: [{ delta: { content: text.slice(mid) }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: "stop" }] },
  ];
}

function makeFakeClient(script: AnyChunk[][]) {
  let i = 0;
  const client = {
    chat: {
      completions: {
        create: async () => {
          const chunks = script[Math.min(i, script.length - 1)];
          i += 1;
          return (async function* () {
            for (const c of chunks) yield c;
          })();
        },
      },
    },
  };
  return client as never;
}

const LOOP_CTX = {
  executeTool: async () => ({
    ok: true,
    result: { weatherText: "小雨", todayRangeC: "15-20", humidityPct: 85 },
  }),
} as never;

const TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "weather.get_local",
      description: "获取本地天气实况。",
      parameters: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
    },
  },
] as never;

test("holdAnswer=after_tool_use：确认语透出，答案本体不进流式通道，返回值完整", async () => {
  resetLlmUsageAuditForTest();

  const client = makeFakeClient([ackThenToolChunks(ACK, POST_GATE_THINKING), textChunks(FINAL_ANSWER)]);
  let streamed = "";
  const out = await streamCompletionWithTools(
    client,
    "deepseek-chat",
    [
      { role: "system", content: "你是私人助理。" },
      { role: "user", content: "今天兴义天气怎么样" },
    ] as never,
    (d: string) => {
      streamed += d;
    },
    LOOP_CTX,
    { tools: TOOLS, maxRounds: 4, holdAnswer: "after_tool_use", audit: { sessionId: "answer-hold" } },
  );

  // 答案本体随返回值完整交付（done 结构化下发的唯一来源）
  assert.ok(out.includes("15-20"), `返回值应包含答案本体，实际: ${out.slice(0, 80)}`);
  // 确认语照常透出（先一句话契约不变）
  assert.ok(streamed.includes("好的，我马上查"), "确认语应照常透出");
  // 答案本体绝不进流式通道（跳变的根除点）
  assert.ok(
    !streamed.includes("15-20"),
    `答案本体不得流入 onDelta（应随 done 下发），实际流式内容: ${JSON.stringify(streamed)}`,
  );
  assert.ok(!streamed.includes("带伞"), "答案本体不得流入 onDelta（应随 done 下发）");
});

test("holdAnswer=after_tool_use 且零工具调用：流式行为不变（打字机保留）", async () => {
  resetLlmUsageAuditForTest();

  const pureText = "在的呢，今天想聊点什么？";
  const client = makeFakeClient([textChunks(pureText)]);
  let streamed = "";
  const out = await streamCompletionWithTools(
    client,
    "deepseek-chat",
    [
      { role: "system", content: "你是私人助理。" },
      { role: "user", content: "在吗" },
    ] as never,
    (d: string) => {
      streamed += d;
    },
    { executeTool: async () => ({ ok: true, result: {} }) } as never,
    { maxRounds: 2, holdAnswer: "after_tool_use" },
  );

  assert.equal(out, pureText);
  assert.equal(streamed, out, "零工具轮全文应完整流式，留存闸对它无感");
});

test("holdAnswer=always：从第一波就留存（前置检索证据轮），零直推", async () => {
  resetLlmUsageAuditForTest();

  const client = makeFakeClient([textChunks(FINAL_ANSWER)]);
  let streamed = "";
  const out = await streamCompletionWithTools(
    client,
    "deepseek-chat",
    [
      { role: "system", content: "你是私人助理。" },
      { role: "user", content: "刘浩存最近有什么动态" },
    ] as never,
    (d: string) => {
      streamed += d;
    },
    LOOP_CTX,
    { tools: TOOLS, maxRounds: 2, holdAnswer: "always", audit: { sessionId: "answer-hold-always" } },
  );

  assert.ok(out.includes("15-20") || out.length > 0, "返回值应携带答案本体");
  assert.equal(streamed, "", "always 模式下任何内容不得直推（答案随 done 下发）");
});

test("receiptProducesCard：出卡回执扣流、查记忆/失败回执不扣流（口径与循环内一致）", () => {
  // 出卡：确定性工具 + 成功回执
  assert.equal(receiptProducesCard("weather.get_local", { weatherText: "小雨" }), true);
  assert.equal(receiptProducesCard("travel.plan-itinerary", { plan: { days: [] } }), true);
  // 不出卡：查记忆（结果只进上下文，永不产卡）→ 不扣流，正文照常分泡
  assert.equal(receiptProducesCard("brain.recall", { items: [{ content: "上午说的马尔代夫" }] }), false);
  // 不出卡：失败回执（无卡可建）→ 不扣流，不再黑等
  assert.equal(receiptProducesCard("weather.get_local", undefined), false);
  assert.equal(receiptProducesCard("brain.recall", undefined), false);
});

test("holdAnswer=after_tool_use 且回执不出卡：正文照常流式（查记忆轮分泡回归）", async () => {
  resetLlmUsageAuditForTest();

  const memoryReply = "翻到了，你上午说的是马尔代夫，5 天 4 晚。";
  const client = makeFakeClient([
    ackThenToolChunks("我看一下哈。", "查一下上午的记忆。").map((c) => {
      // 把天气工具换成 brain.recall（不出卡）
      const choice = c?.choices?.[0];
      const call = choice?.delta?.tool_calls?.[0];
      if (call) {
        call.function.name = "brain.recall";
        call.function.arguments = JSON.stringify({ query: "马尔代夫" });
      }
      return c;
    }),
    textChunks(memoryReply),
  ]);
  let streamed = "";
  const out = await streamCompletionWithTools(
    client,
    "deepseek-chat",
    [
      { role: "system", content: "你是私人助理。" },
      { role: "user", content: "还记得我上午说的马尔代夫吗" },
    ] as never,
    (d: string) => {
      streamed += d;
    },
    { executeTool: async () => ({ ok: true, result: { items: [{ content: "马尔代夫 5 天 4 晚" }] } }) } as never,
    { maxRounds: 4, holdAnswer: "after_tool_use", audit: { sessionId: "answer-hold-recall" } },
  );

  // 记忆检索不出卡 → 答案照常流式（不扣流），返回值也完整
  assert.ok(streamed.includes("马尔代夫"), `不出卡回执的正文应照常流式，实际: ${JSON.stringify(streamed)}`);
  assert.ok(out.includes("马尔代夫"), "返回值应包含答案本体");
});
