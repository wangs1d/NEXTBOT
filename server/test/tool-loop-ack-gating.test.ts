/**
 * 「先一句话后结果」闸门测试（2026-10-11）。
 *
 * 用户可见契约：复杂任务轮 = 模型先流式说出一句确认语（调工具前自然说出的那句话），
 * 工具执行完成后只流式最终结果；模型决定调工具之后继续吐出的思考/伴随文本
 * 一律不得透出到前端流，也不存在"已说出去的话被整段覆盖"的回吞。
 *
 * 覆盖三层：
 *   1. consumeNormalizedStream 的 onToolCallDeltaSeen 流中时点（首个 tool_call 增量
 *      即触发，早于流结束、早于其后的 content delta）；
 *   2. tool-loop 波内直推闸门：关闸后的 content 不再直推（工具波丢弃）；
 *   3. firstAckSentence 单句确认语截断（非流式波前导话兜底推送用）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 必须在动态 import 业务模块前设置（审计落盘目录 / 架构开关运行时读取 env）
const DATA_DIR = mkdtempSync(join(tmpdir(), "tool-loop-ack-gating-"));
process.env.PA_DATA_DIR = DATA_DIR;
process.env.AGENT_TOKENJUICE_ENABLED = "0";
process.env.AGENT_TOOL_ARCH = "legacy";

const { consumeNormalizedStream } = await import("../src/external-model/stream-chat-helpers.js");
const { streamCompletionWithTools, firstAckSentence } = await import(
  "../src/external-model/openai-compatible-tool-loop.js"
);
const { resetLlmUsageAuditForTest } = await import("../src/services/llm-token-audit.js");

/* ---------------- 1. consumer 流中钩子时点 ---------------- */

test("onToolCallDeltaSeen 在首个 tool_call 增量时触发一次，早于其后的 content delta", async () => {
  const events: string[] = [];
  await consumeNormalizedStream(
    (async function* () {
      yield { content: "好的，我马上查。" };
      yield {
        toolCalls: [{ index: 0, id: "call_1", name: "t", argumentsChunk: "{}" }],
      };
      yield { content: "关闸后的思考文本" };
      yield { finishReason: "tool_calls" };
    })(),
    {
      onContentDelta: (d) => events.push(`content:${d}`),
      onToolCallDeltaSeen: () => events.push("gate"),
    },
  );
  assert.deepEqual(events, [
    "content:好的，我马上查。",
    "gate",
    "content:关闸后的思考文本",
  ]);
});

test("无工具调用的纯文本波不触发 onToolCallDeltaSeen", async () => {
  let seen = 0;
  await consumeNormalizedStream(
    (async function* () {
      yield { content: "在呢。" };
      yield { finishReason: "stop" };
    })(),
    {
      onContentDelta: () => {},
      onToolCallDeltaSeen: () => {
        seen += 1;
      },
    },
  );
  assert.equal(seen, 0);
});

/* ---------------- 2. tool-loop 波内直推闸门 ---------------- */

type AnyChunk = Record<string, unknown>;
type ChatMessage = { role: string; content: string };

const FINAL_ANSWER =
  "查到了。特斯拉 2026 年 Q2 交付 46.6 万辆（环比 +8%），股价 312.4 美元（+3.2%）。";
const POST_GATE_THINKING = "用户要的是交付数据和股价，我需要分两路查，先交付后行情。";

/** 工具波：先说确认语 → 发 tool_call 增量（关闸点）→ 继续吐思考文本。 */
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
                id: "call_g1",
                type: "function",
                function: { name: "bench_search", arguments: JSON.stringify({ query: "特斯拉 2026 Q2 交付" }) },
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
        create: async (req: Record<string, unknown>) => {
          const chunks = script[Math.min(i, script.length - 1)];
          i += 1;
          void req;
          return (async function* () {
            for (const c of chunks) yield c;
          })();
        },
      },
    },
  };
  return client as never;
}

test("工具轮：确认语透出、关闸后思考文本不透出、最终结果完整流式", async () => {
  resetLlmUsageAuditForTest();

  const client = makeFakeClient([
    ackThenToolChunks("好的，我马上查。", POST_GATE_THINKING),
    textChunks(FINAL_ANSWER),
  ]);

  let streamed = "";
  const { streamCompletionWithTools: run } = await import(
    "../src/external-model/openai-compatible-tool-loop.js"
  );
  const out = await run(
    client,
    "deepseek-chat",
    [
      { role: "system", content: "你是私人助理。" },
      { role: "user", content: "帮我查一下特斯拉最新的交付数据" },
    ] as never,
    (d: string) => {
      streamed += d;
    },
    {
      executeTool: async () => ({
        ok: true,
        result: { content: "特斯拉 2026 年 Q2 交付 46.6 万辆，股价 312.4 美元。" },
      }),
    } as never,
    {
      tools: [
        {
          type: "function" as const,
          function: {
            name: "bench_search",
            description: "联网搜索：输入查询词返回实时搜索结果。",
            parameters: {
              type: "object",
              properties: { query: { type: "string", description: "查询关键词" } },
              required: ["query"],
            },
          },
        },
      ] as never,
      maxRounds: 4,
      audit: { sessionId: "ack-gating" },
    },
  );

  // 最终回复权威文本完整
  assert.ok(out.includes("46.6"), `最终回答应包含事实锚点，实际: ${out.slice(0, 80)}`);
  // 确认语已流式透出（先回一句话）
  assert.ok(
    streamed.includes("好的，我马上查"),
    `确认语应透出到前端流，实际: ${streamed.slice(0, 80)}`,
  );
  // 关闸后的思考文本绝不透出
  assert.ok(
    !streamed.includes("分两路查"),
    "关闸后的思考文本不得透出到前端流",
  );
  // 思考文本也不进最终回复文本
  assert.ok(!out.includes("分两路查"), "思考文本不得混入最终回复");
  // 最终结果照常流式（先确认语、后结果的节奏）
  assert.ok(streamed.includes("46.6"), "最终结果应流式推送给前端");
});

test("纯聊天轮（无工具调用）流式行为不变：全文逐 delta 直推", async () => {
  resetLlmUsageAuditForTest();

  const pureText = "在的呢，今天想聊点什么？";
  const client = makeFakeClient([textChunks(pureText)]);

  let streamed = "";
  const { streamCompletionWithTools: run } = await import(
    "../src/external-model/openai-compatible-tool-loop.js"
  );
  const out = await run(
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
    { maxRounds: 2 },
  );

  assert.equal(out, pureText);
  assert.equal(streamed, out, "纯聊天轮全文应完整流式，不受闸门影响");
});

/* ---------------- 3. firstAckSentence 单句截断 ---------------- */

test("firstAckSentence：取首句、超长软截断、空文本兜底", () => {
  // 正常首句
  assert.equal(firstAckSentence("好的，我马上查。稍等哦。"), "好的，我马上查。");
  // 无句末标点 → 全文
  assert.equal(firstAckSentence("我看下今天的日程"), "我看下今天的日程");
  // 首句超长 → 在 cap 内最后一个逗号处软截断
  const long = "好的呢，我先帮你把明天的日程、待办还有最近的快递都整理一遍，然后马上汇报给你哦。";
  const cut = firstAckSentence(long, 24);
  assert.ok(cut.length <= 24, `截断结果应不超过上限: ${cut}`);
  assert.ok(cut.endsWith("，") || cut.endsWith("、") || !/[。！？]$/.test(cut));
  // 无软断点 → 硬切
  const noComma = "这是一句没有任何逗号顿号分号并且特别长特别长特别长特别长特别长特别长特别长的句子。";
  assert.equal(firstAckSentence(noComma, 10).length, 10);
  // 空文本
  assert.equal(firstAckSentence("   "), "");
});
