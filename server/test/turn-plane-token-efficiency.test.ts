/**
 * 双面架构 token 效率契约测试（2026-09-05）。
 *
 * 在保证任务质量的前提下消除冗余 token：
 *   1. 对话面 prompt 不含任何工具 schema（toolExposureProfile="none" → 零工具）；
 *   2. 对话面（零工具轮）不触发出口自检——不空烧续波预算；
 *   3. 任务面预算由 TurnPlan 决定（单点查询 2 波封顶），不是一律 4 波；
 *   4. 升级重放已删除：纠错在原轨迹内续波，不再整轮重跑一遍。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatCompletionTool } from "openai/resources/chat/completions";

const DATA_DIR = mkdtempSync(join(tmpdir(), "turn-plane-token-"));
process.env.PA_DATA_DIR = DATA_DIR;
process.env.AGENT_TOKENJUICE_ENABLED = "0";

const { resolveChatToolPlanForStream } = await import(
  "../src/external-model/resolve-chat-tools.js"
);
const { streamCompletionWithTools } = await import(
  "../src/external-model/openai-compatible-tool-loop.js"
);

test("对话面零工具：toolExposureProfile=none → 可见工具为空（prompt 无工具 schema）", () => {
  // 模拟 agent-core 对话面分支的 stream options 形状
  const plan = resolveChatToolPlanForStream("帮我查一下刘浩存最近的动态", {
    toolExposureProfile: "none",
  } as never);
  assert.equal(
    plan.visibleTools.length,
    0,
    "对话面可见工具必须为 0——工具 schema 是对话轮最大的无效 token 来源",
  );
});

/* ---------------- 零工具轮不触发出口自检 ---------------- */

type AnyChunk = Record<string, unknown>;

function textChunks(text: string): AnyChunk[] {
  const mid = Math.ceil(text.length / 2);
  return [
    { choices: [{ delta: { content: text.slice(0, mid) }, finish_reason: null }] },
    { choices: [{ delta: { content: text.slice(mid) }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: "stop" }] },
  ];
}

test("零工具轮不触发出口自检：含搜索意图的直答不空烧续波", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const client = {
    chat: {
      completions: {
        create: async (req: Record<string, unknown>) => {
          calls.push(req);
          return (async function* () {
            for (const c of textChunks("这个我暂时没查到可靠消息。")) yield c;
          })();
        },
      },
    },
  };
  const out = await streamCompletionWithTools(
    client as never,
    "deepseek-chat",
    [
      { role: "system", content: "你是私人助理" },
      { role: "user", content: "刘浩存最近的消息" },
    ] as never,
    () => {},
    { executeTool: async () => ({ ok: true, result: {} }) } as never,
    {
      tools: [] as never, // 对话面：零工具
      maxRounds: 3,
      extraBody: { fastProfile: true },
      audit: { sessionId: "token-zero-tool" },
    },
  );
  assert.equal(calls.length, 1, `零工具轮应恰好 1 次 LLM 调用，实际 ${calls.length}`);
  assert.ok(!out.includes("__ESCALATE_TO_COMPLEX__"), "不得返回升级哨兵");
});

/* ---------------- 任务面预算由 TurnPlan 决定 ---------------- */

function tool(name: string): ChatCompletionTool {
  return {
    type: "function",
    function: {
      name,
      description: "联网搜索公开网页信息",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
  };
}

function makeScriptedClient(limit: number, requests: Array<Record<string, unknown>>) {
  let i = 0;
  return {
    chat: {
      completions: {
        create: async (req: Record<string, unknown>) => {
          requests.push(req);
          const isToolRound = i < limit;
          i += 1;
          if (isToolRound) {
            return (async function* () {
              yield {
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: `c-${i}`,
                          type: "function",
                          function: { name: "search_web", arguments: JSON.stringify({ query: "比特币 价格" }) },
                        },
                      ],
                    },
                    finish_reason: null,
                  },
                ],
              };
              yield { choices: [{ delta: {}, finish_reason: "tool_calls" }] };
            })();
          }
          return (async function* () {
            for (const c of textChunks("比特币现在约 6 万美元一枚。")) yield c;
          })();
        },
      },
    },
  };
}

test("任务面单点查询预算封顶：realtime 轮（budget=2）最多消耗预算内波次，不跑满 4 波", async () => {
  // budget=2：波次耗尽后走 schema-less summary 收尾（无 schema 的最终汇总）。
  // 断言：带 schema 的规划轮 ≤ budget（不旧硬编码的 4 波）。
  // 2026-11-09 收尾叙述保底波：预算耗尽且零正文时额外授予一次叙述波（有界 +1），
  // 本 mock 每波都想调工具、从不叙述 → 保底波后仍只发调用，如实空收尾。
  const requests: Array<Record<string, unknown>> = [];
  const client = makeScriptedClient(99, requests); // 模型每波都想调工具
  const ctx = {
    executeTool: async () => ({
      ok: true,
      result: { items: [{ title: "BTC", url: "https://e.com", snippet: "6万美元" }] },
    }),
  };
  await streamCompletionWithTools(
    client as never,
    "deepseek-chat",
    [
      { role: "system", content: "你是私人助理" },
      { role: "user", content: "现在比特币多少钱" },
    ] as never,
    () => {},
    ctx as never,
    {
      tools: [tool("search_web")] as never,
      maxRounds: 2, // ← realtime_lookup 的 TurnPlan.budget
      extraBody: { fastProfile: true },
      audit: { sessionId: "token-budget-cap" },
    },
  );
  // maxRounds=2 + 失败换路预算只在有失败时追加（这里全部成功，不追加）
  // → 波次 2 + 充分性探测 1 = 3 次调用；绝不能出现 4+ 波的失控循环
  assert.ok(
    requests.length <= 5,
    `单点查询的 LLM 调用应封顶在预算内（budget 波 + 每波探测 + 保底波 1 次），实际 ${requests.length}`,
  );
  const schemaRounds = requests.filter((r) => Array.isArray(r.tools)).length;
  assert.ok(
    schemaRounds <= 3,
    `带 schema 的规划轮应 ≤ 3（budget=2 + 保底波 1 次），实际 ${schemaRounds}`,
  );
});
