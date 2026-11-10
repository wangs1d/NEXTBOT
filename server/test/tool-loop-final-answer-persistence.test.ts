/**
 * 工具轮最终答案落库契约测试（2026-10-22 根修·重复调工具事故回归）。
 *
 * 病根：schema-less 汇总（runSchemaLessSummary 的探测收尾 + 预算耗尽兜底）只
 * return 文本、从不 push 进循环 messages → 回写后线程停在 assistant(tool_calls)
 * → tool*；holdAnswer="after_tool_use" 又把汇总文本流式关掉（streamedVisible 空）
 * → provider 兜底失效 → foldCompletedToolChains 折成「[动作台账]…本轮未生成可见
 * 回复」→ 下一轮模型看到「问了但没回复」把工具重新调一遍。
 *
 * 契约：任何收尾路径结束时，messages 终态必须含 assistant(content)=最终答案，
 * fold 后线程是干净的「问 → 答」对，绝不出现「未生成可见回复」台账。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DATA_DIR = mkdtempSync(join(tmpdir(), "tool-loop-answer-persist-"));
process.env.PA_DATA_DIR = DATA_DIR;
process.env.AGENT_TOKENJUICE_ENABLED = "0";
process.env.AGENT_TOOL_ARCH = "legacy";

const { streamCompletionWithTools } = await import(
  "../src/external-model/openai-compatible-tool-loop.js"
);
const { foldCompletedToolChains } = await import("../src/external-model/chat-thread-store.js");
const { resetLlmUsageAuditForTest } = await import("../src/services/llm-token-audit.js");

type AnyChunk = Record<string, unknown>;
type AnyMsg = Record<string, unknown>;

const ACK = "好的，我马上查。";
const FINAL_ANSWER = "查到了。兴义今天小雨，气温 15-20 度，记得带伞。";
const SYSTEM = "你是私人助理。";
const USER = "今天兴义天气怎么样";

function ackThenToolChunks(ack: string): AnyChunk[] {
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
                  name: "weather_get_local",
                  arguments: JSON.stringify({ city: "兴义" }),
                },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
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
  const calls: unknown[] = [];
  const client = {
    chat: {
      completions: {
        create: async (req: unknown) => {
          calls.push(req);
          const chunks = script[Math.min(i, script.length - 1)];
          i += 1;
          return (async function* () {
            for (const c of chunks) yield c;
          })();
        },
      },
    },
  };
  return { client: client as never, calls };
}

const TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "weather_get_local",
      description: "获取本地天气实况。",
      parameters: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
    },
  },
] as never;

const OK_CTX = {
  executeTool: async () => ({
    ok: true,
    result: { weatherText: "小雨", todayRangeC: "15-20", humidityPct: 85 },
  }),
} as never;

/** 模拟 provider 回写：视图边界后的新增消息并入线程（与 abstract-chat-provider 同构）。 */
function writebackLikeProvider(view: AnyMsg[]): AnyMsg[] {
  const boundary = 2; // system + user 为线程既有
  return [...view.slice(0, boundary), ...view.slice(boundary)];
}

test("探测汇总收尾（工具全成功捷径）：最终答案必须进 messages 终态", async () => {
  resetLlmUsageAuditForTest();

  const { client } = makeFakeClient([ackThenToolChunks(ACK), textChunks(FINAL_ANSWER)]);
  const view: AnyMsg[] = [
    { role: "system", content: SYSTEM },
    { role: "user", content: USER },
  ];
  const out = await streamCompletionWithTools(
    client,
    "deepseek-chat",
    view as never,
    () => {},
    OK_CTX,
    { tools: TOOLS, maxRounds: 4, holdAnswer: "after_tool_use", audit: { sessionId: "persist-probe" } },
  );

  assert.ok(out.includes("15-20"), `返回值应含答案本体，实际: ${out.slice(0, 80)}`);

  // ★ 核心契约：messages 终态最后一条 = assistant(content)=最终答案
  const last = view[view.length - 1];
  assert.equal(last.role, "assistant", "messages 终态最后一条必须是 assistant");
  assert.ok(
    String(last.content ?? "").includes("15-20"),
    `assistant 正文应含最终答案，实际: ${JSON.stringify(last.content)?.slice(0, 120)}`,
  );
});

test("探测汇总收尾 + fold：线程是干净问→答对，无「未生成可见回复」台账", async () => {
  resetLlmUsageAuditForTest();

  const { client } = makeFakeClient([ackThenToolChunks(ACK), textChunks(FINAL_ANSWER)]);
  const view: AnyMsg[] = [
    { role: "system", content: SYSTEM },
    { role: "user", content: USER },
  ];
  await streamCompletionWithTools(
    client,
    "deepseek-chat",
    view as never,
    () => {},
    OK_CTX,
    { tools: TOOLS, maxRounds: 4, holdAnswer: "after_tool_use", audit: { sessionId: "persist-fold" } },
  );

  const thread = writebackLikeProvider(view);
  const changed = foldCompletedToolChains(thread as never, new Date());
  const dump = JSON.stringify(thread);

  assert.ok(changed, "已完成的工具链应被折叠");
  assert.ok(!dump.includes("[动作台账]"), `fold 后不得残留动作台账，实际: ${dump.slice(0, 400)}`);
  assert.ok(!dump.includes("未生成可见回复"), "fold 后不得出现「未生成可见回复」——它会让下一轮重复调工具");
  const answerMsg = thread.find(
    (m) => m.role === "assistant" && String(m.content ?? "").includes("15-20"),
  );
  assert.ok(answerMsg, "fold 后线程应保留含最终答案的 assistant 消息（问→答对完整）");
});

test("预算耗尽：收尾叙述保底波一次——如实交付，不把编造答案写回 messages", async () => {
  resetLlmUsageAuditForTest();

  // maxRounds=1：波 1 执行完工具后预算耗尽。2026-11-08 起不再调用
  // runSchemaLessSummary(false)——那一步脱离人格与当前轮事实编叙事，已整体删除。
  // 2026-11-09 收尾叙述保底波：预算耗尽且整轮零正文 → 授予一次叙述波
  // （不注入任何指令），模型如实说明结果/卡点；仍不把不存在的答案写回 messages。
  const { client, calls } = makeFakeClient([
    ackThenToolChunks(ACK),
    textChunks("这会儿天气数据没拿到，稍后再问我一次。"),
  ]);
  const view: AnyMsg[] = [
    { role: "system", content: SYSTEM },
    { role: "user", content: USER },
  ];
  const out = await streamCompletionWithTools(
    client,
    "deepseek-chat",
    view as never,
    () => {},
    OK_CTX,
    { tools: TOOLS, maxRounds: 1, holdAnswer: "after_tool_use", audit: { sessionId: "persist-exhaust" } },
  );

  assert.equal(calls.length, 2, "预算波 1 次 + 收尾叙述保底波 1 次（有界，不失控）");
  assert.equal(
    out,
    "这会儿天气数据没拿到，稍后再问我一次。",
    "保底波如实交付，不返回编造答案",
  );
  assert.ok(
    !view.some((m) => m.role === "assistant" && String(m.content ?? "").includes("15-20")),
    "不得把不存在的 assistant 答案写回 messages",
  );
});
