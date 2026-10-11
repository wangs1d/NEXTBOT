/**
 * travel_planning 确定性预执行循环测试（2026-10-10 P1）。
 *
 * 契约：travel_planning 轮由代码在工具循环开场直接执行 travel.plan-itinerary
 * （非 query 形参数 {input,destination,days}——预执行器 2026-10-10 扩面），
 * 行程草案以 assistant(tool_calls)+tool 协议进上下文，模型只叙述。
 * 夹具形态与 tool-loop-media-gate-static.test.ts 的确定性预执行测试同源。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BENCH_DATA_DIR = mkdtempSync(join(tmpdir(), "travel-preexec-"));
process.env.PA_DATA_DIR = BENCH_DATA_DIR;
process.env.AGENT_TOOL_ARCH = "static";
process.env.AGENT_TOKENJUICE_ENABLED = "0";

const { streamCompletionWithTools } = await import(
  "../src/external-model/openai-compatible-tool-loop.js"
);

type AnyChunk = Record<string, unknown>;

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
  const requests: Array<Record<string, unknown>> = [];
  const client = {
    chat: {
      completions: {
        create: async (req: Record<string, unknown>) => {
          requests.push(req);
          const chunks = script[Math.min(i, script.length - 1)];
          i += 1;
          return (async function* () {
            for (const c of chunks) yield c;
          })();
        },
      },
    },
  };
  return { client: client as never, requests };
}

const MESSAGES = [
  { role: "system", content: "你是用户的私人助理，回答风格短句口语化。" },
  { role: "user", content: "帮我规划一下去马尔代夫游玩一个星期左右的行程" },
] as never;

const TOOLS = [
  {
    type: "function",
    function: {
      name: "travel.plan-itinerary",
      description: "生成旅游行程规划：按天拆分景点/酒店/餐厅，含交通与价格汇总",
      parameters: {
        type: "object",
        properties: {
          input: { type: "string" },
          destination: { type: "string" },
          days: { type: "number" },
        },
        required: ["input"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_web",
      description: "联网搜索公开网页信息（标题/摘要/链接）",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
  },
] as never;

const DET_ARGS = {
  input: "帮我规划一下去马尔代夫游玩一个星期左右的行程",
  destination: "马尔代夫",
  days: 7,
};

test("确定性预执行：非 query 形参数（travel.plan-itinerary）开场真执行并进上下文", async () => {
  const { client, requests } = makeFakeClient([
    textChunks("行程草案出来了，我按天给你讲。"),
  ]);
  const executed: Array<{ name: string; args: Record<string, unknown> }> = [];
  const executedViaCallback: Array<{ name: string; ok: boolean }> = [];
  const out = await streamCompletionWithTools(
    client,
    "MiniMax-M3",
    MESSAGES,
    () => {},
    {
      executeTool: async (name: string, args: Record<string, unknown>) => {
        executed.push({ name, args });
        return {
          ok: true,
          result: {
            ok: true,
            planId: "plan-test-1",
            destination: "马尔代夫",
            days: [
              { day: 1, summary: "马累入住，环礁浅水" },
              { day: 2, summary: "水屋+浮潜" },
            ],
          },
        };
      },
      onToolExecuted: (info: { toolName: string; ok: boolean }) => {
        executedViaCallback.push({ name: info.toolName, ok: info.ok });
      },
    } as never,
    {
      tools: TOOLS,
      maxRounds: 4,
      turnIntent: "travel_planning",
      deterministicToolCalls: [{ name: "travel.plan-itinerary", args: DET_ARGS }],
      audit: { sessionId: "travel-deterministic" },
    } as never,
  );

  // 行程在循环开场就被确定性执行（不经模型），参数原样透传
  assert.deepEqual(
    executed.map((e) => e.name),
    ["travel.plan-itinerary"],
    `预执行应恰好执行一次 travel.plan-itinerary，实际: ${JSON.stringify(executed.map((e) => e.name))}`,
  );
  assert.deepEqual(executed[0]?.args, DET_ARGS);
  // 回调照常触发 → chat-user-message 的行程卡附卡链路（resolveTravelReceipt）不受影响
  assert.deepEqual(
    executedViaCallback,
    [{ name: "travel.plan-itinerary", ok: true }],
    "onToolExecuted 应触发（行程卡依赖它）",
  );
  // 模型叙述轮看到的是真实行程草案，单轮收尾
  assert.equal(requests.length, 1, `预执行后模型单轮收尾即可，实际 ${requests.length} 次调用`);
  // 预执行以 assistant(tool_calls)+tool 形态进 wave 0 上下文（注册表名带点号）
  const wave0 = JSON.stringify(requests[0]?.messages ?? []);
  assert.ok(wave0.includes("det_"), "预执行调用应以 assistant tool_calls 形态进上下文");
  assert.ok(wave0.includes("travel.plan-itinerary"), "注册表名应出现在 tool 消息中");
  assert.ok(wave0.includes("马尔代夫"), "行程草案应进入 wave 0 供模型叙述");
  assert.ok(out.includes("行程草案"), `应返回正常回答，实际: ${out.slice(0, 60)}`);
});

test("空参预执行跳过 → 出口闸对 travel_planning 续波兜底", async () => {
  const { client, requests } = makeFakeClient([
    textChunks("好想去啊，我给你讲讲马尔代夫吧。"),
    textChunks("缺目的地，你想去哪？"),
  ]);
  const executed: Array<{ name: string }> = [];
  await streamCompletionWithTools(
    client,
    "MiniMax-M3",
    MESSAGES,
    () => {},
    {
      executeTool: async (name: string) => {
        executed.push({ name });
        return { ok: true, result: { ok: true } };
      },
    } as never,
    {
      tools: TOOLS,
      maxRounds: 4,
      turnIntent: "travel_planning",
      deterministicToolCalls: [{ name: "travel.plan-itinerary", args: {} }],
      audit: { sessionId: "travel-deterministic-skip" },
    } as never,
  );

  assert.equal(executed.length, 0, "空参应跳过预执行");
  // 预执行跳过 → travel_planning + 零工具直答 → 出口闸 travel_intent_never_attempted 续波
  assert.ok(
    JSON.stringify(requests[1]?.messages ?? []).includes("travel.plan-itinerary"),
    "续波指令应引导模型调用 travel.plan-itinerary",
  );
  assert.equal(requests.length, 2, `出口闸应续波一次，实际 ${requests.length} 次调用`);
});
