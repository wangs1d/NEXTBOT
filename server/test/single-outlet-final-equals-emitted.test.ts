/**
 * 正文单一出口契约（2026-11-26 统一管道根修）。
 *
 * 病根：定稿文本由另一条整串净化链产出，与流式链（逐 delta 净化 + 繁转简）是两套
 * 过滤器——两份文本对不上，WS 层只好比对补差，把已上屏的 markdown 整段再追加一遍。
 *
 * 契约：定稿文本 === 经 onDelta 放出的全部文本的拼接；流末必须冲刷净化器缓冲，
 * 无句末标点的末句不得丢失。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DATA_DIR = mkdtempSync(join(tmpdir(), "single-outlet-"));
process.env.PA_DATA_DIR = DATA_DIR;
process.env.AGENT_TOKENJUICE_ENABLED = "0";
process.env.AGENT_TOOL_ARCH = "legacy";

const { streamCompletionWithTools } = await import(
  "../src/external-model/openai-compatible-tool-loop.js"
);
const { resetLlmUsageAuditForTest } = await import("../src/services/llm-token-audit.js");

type AnyChunk = Record<string, unknown>;

const TABLE_REPLY =
  "| 品种 | 涨跌 |\n| --- | --- |\n| 沪金 | +1.2% |\n| 沪银 | +0.8% |\n\n" +
  "整体偏强，注意仓位。今晚数据出来前建议观望";

function textChunks(text: string, size: number): AnyChunk[] {
  const chunks: AnyChunk[] = [];
  for (let i = 0; i < text.length; i += size) {
    chunks.push({ choices: [{ delta: { content: text.slice(i, i + size) }, finish_reason: null }] });
  }
  chunks.push({ choices: [{ delta: {}, finish_reason: "stop" }] });
  return chunks;
}

function makeFakeClient(script: AnyChunk[][]) {
  let i = 0;
  return {
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
  } as never;
}

const TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "weather_get_local",
      description: "获取本地天气实况。",
      parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
    },
  },
] as never;

const OK_CTX = {
  executeTool: async () => ({ ok: true, result: { weatherText: "小雨" } }),
} as never;

function freshView(): Record<string, unknown>[] {
  return [
    { role: "system", content: "你是私人助理。" },
    { role: "user", content: "今天行情怎么样" },
  ];
}

for (const size of [1, 3, 7, 40]) {
  test(`纯文本波：定稿 === onDelta 拼接，末句不丢（chunk=${size}）`, async () => {
    resetLlmUsageAuditForTest();
    const deltas: string[] = [];
    const out = await streamCompletionWithTools(
      makeFakeClient([textChunks(TABLE_REPLY, size)]),
      "deepseek-chat",
      freshView() as never,
      (d: string) => deltas.push(d),
      OK_CTX,
      { tools: TOOLS, maxRounds: 4, audit: { sessionId: `single-outlet-${size}` } },
    );

    const emitted = deltas.join("");
    assert.equal(out, emitted.trim(), "定稿必须是已放出文本本身");
    assert.ok(emitted.includes("| 品种 | 涨跌 |"), "表头应已放出");
    assert.ok(out.endsWith("建议观望"), `无句末标点的末句不得丢失，实际结尾: ${out.slice(-20)}`);
    assert.equal(out.split("| 品种 | 涨跌 |").length - 1, 1, "正文不得重复放出");
  });
}

test("工具波后最终波：定稿 === 最终波已放出文本，工具波前导语不混入", async () => {
  resetLlmUsageAuditForTest();
  const deltas: string[] = [];
  const ack = "好的，我看看。";
  const final = "查到了。今天小雨，气温 15-20 度";
  const ackThenTool: AnyChunk[] = [
    { choices: [{ delta: { content: ack }, finish_reason: null }] },
    {
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, id: "call_1", type: "function", function: { name: "weather_get_local", arguments: "{}" } },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
  ];
  const out = await streamCompletionWithTools(
    makeFakeClient([ackThenTool, textChunks(final, 4)]),
    "deepseek-chat",
    freshView() as never,
    (d: string) => deltas.push(d),
    OK_CTX,
    { tools: TOOLS, maxRounds: 4, audit: { sessionId: "single-outlet-tool" } },
  );

  assert.equal(deltas.join(""), ack + final, "onDelta 放出 = 前导语 + 最终回复，各一次");
  assert.equal(out, final, "定稿只含最终回复");
  assert.ok(out.endsWith("15-20 度"), "末句不丢");
});
