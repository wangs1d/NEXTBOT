// 媒体意图零工具直答 · 出口闸豁免收窄回归（2026-10-10 马尔代夫搜图轮实证）。
//
// 事故：media_retrieval 轮投机检索注入了**文字**证据（search_web 结果，AnySearch
// 超时后国内引擎兜底 2 条）→ turnEvidenceInjected=true → 出口闸的「证据已注入」
// 豁免放行了零工具直答轮，模型凭想象把「水屋/海底/航拍」描述了一遍，用户一张图
// 都收不到（logs/autostart/server-2026-10-09.log L109601 turn-trace: toolCalls=[]）。
//
// 修复：豁免只留给 realtime_lookup（文字证据 = 答的就是刚检索到的事实，豁免成立）；
// media_retrieval 轮零工具直答一律续波补搜——注入的证据永远是文字，不可能是照片。
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BENCH_DATA_DIR = mkdtempSync(join(tmpdir(), "media-gate-static-"));
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

function toolCallChunks(calls: Array<{ id: string; name: string; args: object }>): AnyChunk[] {
  const chunks: AnyChunk[] = [];
  calls.forEach((c, i) => {
    chunks.push({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: i,
                id: c.id,
                type: "function",
                function: { name: c.name, arguments: JSON.stringify(c.args) },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    });
  });
  chunks.push({ choices: [{ delta: {}, finish_reason: "tool_calls" }] });
  return chunks;
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

function makeCtx() {
  const executed: Array<{ name: string; ok: boolean }> = [];
  return {
    executed,
    ctx: {
      executeTool: async (name: string) => {
        executed.push({ name, ok: true });
        return {
          ok: true,
          result: {
            provider: "search-api-images",
            mediaType: "image",
            items: [{ title: "马尔代夫水屋", mediaUrl: "https://example.com/a.png" }],
          },
        };
      },
    },
  };
}

const MESSAGES = [
  { role: "system", content: "你是用户的私人助理，回答风格短句口语化。" },
  { role: "user", content: "搜索几张马尔代夫的照片" },
] as never;

const TOOLS = [
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
  {
    type: "function",
    function: {
      name: "search_images",
      description: "图片搜索：按关键词返回真实图片列表",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
  },
] as never;

// 复刻事故轮模型行为：零工具直答，凭想象描述马尔代夫有哪些画面
const IMAGINED_REPLY =
  "水屋+泻湖：经典海岛氛围；海底/浮潜：珊瑚礁+热带鱼；航拍全景：俯瞰蓝宝石。要不要挑个侧偏好？";

test("媒体意图 + 文字证据已注入 + 零工具 → 出口闸仍续波强制补搜（事故回归）", async () => {
  const { client, requests } = makeFakeClient([
    // wave 0：模型零工具直答（复刻事故轮）
    textChunks(IMAGINED_REPLY),
    // wave 1（media_intent_never_attempted 续波）：模型补调 search_images
    toolCallChunks([{ id: "call_m1", name: "search_images", args: { query: "马尔代夫 水屋" } }]),
    // wave 2：正常收尾
    textChunks("照片来了，都在下面。"),
  ]);
  const { ctx, executed } = makeCtx();
  const out = await streamCompletionWithTools(
    client,
    "MiniMax-M3",
    MESSAGES,
    () => {},
    ctx,
    {
      tools: TOOLS,
      maxRounds: 4,
      turnIntent: "media_retrieval",
      turnEvidenceInjected: true, // 投机文字证据已注入——不得豁免媒体轮
      audit: { sessionId: "media-gate-regression" },
    } as never,
  );

  assert.equal(
    executed.some((e) => e.name === "search_images" && e.ok),
    true,
    `续波后 search_images 应被真实执行，实际: ${JSON.stringify(executed)}`,
  );
  const gateInjected = requests.some((r) =>
    JSON.stringify(r.messages ?? []).includes("媒体检索意图"),
  );
  assert.ok(gateInjected, "应注入 media_intent_never_attempted 续波指令");
  assert.ok(!out.includes("要不要挑个侧偏好"), "凭想象直答的原文不得作为最终回复透出");
});

test("realtime 意图 + 证据已注入 + 零工具 → 豁免保留，单次调用收尾", async () => {
  const { client, requests } = makeFakeClient([
    textChunks("现在北京 12 度，晴，微风。"),
  ]);
  const { ctx, executed } = makeCtx();
  await streamCompletionWithTools(
    client,
    "MiniMax-M3",
    [
      { role: "system", content: "你是用户的私人助理。" },
      { role: "user", content: "北京现在多少度" },
    ] as never,
    () => {},
    ctx,
    {
      tools: TOOLS,
      maxRounds: 4,
      turnIntent: "realtime_lookup",
      turnEvidenceInjected: true,
      audit: { sessionId: "realtime-exempt-kept" },
    } as never,
  );

  assert.equal(requests.length, 1, `realtime 轮证据已注入应豁免（单次收尾），实际 ${requests.length} 次调用`);
  assert.equal(executed.length, 0, "不得强制补搜");
});

// ─────────────────────────────────────────────────────────────────────────────
// 根治路径（2026-10-10）：确定性媒体预执行——搜图不再依赖模型配合
// ─────────────────────────────────────────────────────────────────────────────

test("确定性预执行：模型全程不调工具，照片也已真搜并进入上下文与回调", async () => {
  // 模型脚本：wave 0 直接收尾叙述（复刻"模型偷懒"形态）——预执行结果已在上下文里
  const { client, requests } = makeFakeClient([
    textChunks("照片来了，都在下面。"),
  ]);
  const { ctx, executed } = makeCtx();
  const executedViaCallback: Array<{ name: string; ok: boolean }> = [];
  const out = await streamCompletionWithTools(
    client,
    "MiniMax-M3",
    MESSAGES,
    () => {},
    {
      executeTool: async (name: string, args: Record<string, unknown>) => {
        executed.push({ name, ok: true });
        return {
          ok: true,
          result: {
            provider: "search-api-images",
            mediaType: "image",
            items: [{ title: String(args.query ?? ""), mediaUrl: "https://example.com/a.png" }],
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
      turnIntent: "media_retrieval",
      turnEvidenceInjected: true,
      deterministicToolCalls: [{ name: "search_images", args: { query: "马尔代夫", limit: 6 } }],
      audit: { sessionId: "media-deterministic" },
    } as never,
  );

  // 照片在循环开场就被确定性执行（不经模型）
  assert.deepEqual(
    executed.map((e) => e.name),
    ["search_images"],
    `预执行应恰好执行一次 search_images，实际: ${JSON.stringify(executed)}`,
  );
  // 回调照常触发 → chat-user-message 的 mediaCards 聚合 / 边说边出图链路不受影响
  assert.deepEqual(
    executedViaCallback,
    [{ name: "search_images", ok: true }],
    "onToolExecuted 应触发（mediaCards 聚合依赖它）",
  );
  // 模型叙述轮看到的是真实结果，收尾不再被出口闸续波（实质成功 ≥1）
  assert.equal(requests.length, 1, `预执行后模型单轮收尾即可，实际 ${requests.length} 次调用`);
  assert.ok(out.includes("照片来了"), `应返回正常回答，实际: ${out.slice(0, 60)}`);
  // 预执行的 assistant(tool_calls)+tool 消息对确实进入了 wave 0 请求
  const wave0 = JSON.stringify(requests[0]?.messages ?? []);
  assert.ok(wave0.includes("det_"), "预执行调用应以 assistant tool_calls 形态进上下文");
  assert.ok(wave0.includes("马尔代夫"), "预执行结果应进入 wave 0 上下文供模型叙述");
});

test("确定性预执行去重：模型 wave 0 发同参 search_images 不重复执行", async () => {
  const { client } = makeFakeClient([
    toolCallChunks([{ id: "call_d1", name: "search_images", args: { query: "马尔代夫", limit: 6 } }]),
    textChunks("都在下面。"),
  ]);
  const { ctx, executed } = makeCtx();
  await streamCompletionWithTools(
    client,
    "MiniMax-M3",
    MESSAGES,
    () => {},
    ctx,
    {
      tools: TOOLS,
      maxRounds: 4,
      turnIntent: "media_retrieval",
      deterministicToolCalls: [{ name: "search_images", args: { query: "马尔代夫", limit: 6 } }],
      audit: { sessionId: "media-deterministic-dedupe" },
    } as never,
  );

  assert.equal(
    executed.filter((e) => e.name === "search_images").length,
    1,
    `同参调用应被轮级去重挡住，实际执行: ${JSON.stringify(executed)}`,
  );
});

test("不可见工具/空查询 → 预执行跳过不报错", async () => {
  const { client, requests } = makeFakeClient([textChunks("好的。")]);
  const { ctx, executed } = makeCtx();
  await streamCompletionWithTools(
    client,
    "MiniMax-M3",
    MESSAGES,
    () => {},
    ctx,
    {
      tools: TOOLS,
      maxRounds: 4,
      turnIntent: "media_retrieval",
      deterministicToolCalls: [
        { name: "video_grab", args: { query: "x" } }, // 不在可见集
        { name: "search_images", args: { query: "" } }, // 空查询
      ],
      audit: { sessionId: "media-deterministic-skip" },
    } as never,
  );

  assert.equal(executed.length, 0, "不可见/空查询都应跳过");
  // 预执行全部跳过 → 回到出口闸兜底：媒体意图 + 零工具 → 续波补搜（1 次续波）
  assert.equal(requests.length, 2, `预执行跳过后出口闸应续波兜底，实际 ${requests.length} 次调用`);
});
