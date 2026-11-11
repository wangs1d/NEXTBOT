/**
 * 延迟目录「discover 加载 schema → 原生 tool_calls」转正回归（2026-11-11）。
 *
 * 背景：tool_discover / tool_describe 的契约是「返回 schema，下一波模型直接按名
 * 调用」，但桥分支此前只把结果当文本回填，没把工具写进 API tools 数组。严格校验
 * function name 的 provider 下，模型下一波发不出这个调用，延迟目录实际不可用
 * （云端实证：`会话工具面已达上限 48，本次不追加：agent_browser.close`）。
 *
 * 这组用例用假 client 驱动真实 streamCompletionWithTools，断言：
 *  - discover(name/domain) 返回 schema 后，工具真的进入下一波请求的 tools 数组；
 *  - 该工具能被模型调用并执行；
 *  - 只返回名字、没有下发 schema 的 tool_search 不转正（避免无脑扩面）。
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { streamCompletionWithTools } from "../src/external-model/openai-compatible-tool-loop.js";
import type { ChatToolExecutionContext } from "../src/external-model/types.js";
import { AGENT_BROWSER_CHAT_TOOLS } from "../src/tools/capability-modules/agent-browser/chat-tools.js";
import { AGENT_BROWSER_INTENT_RULES } from "../src/tools/capability-modules/agent-browser/intent.js";
import { SHOPPING_COMPARE_CHAT_TOOLS } from "../src/tools/capability-modules/shopping-compare/chat-tools.js";
import { SHOPPING_COMPARE_INTENT_RULES } from "../src/tools/capability-modules/shopping-compare/intent.js";
import { buildDomainPreloadTools } from "../src/external-model/lane-tool-sets.js";
import { setExtraIntentRules } from "../src/tools/tool-search/intent-metadata.js";

type FakeChunk = Record<string, unknown>;

function contentChunk(text: string, finish: string | null = null): FakeChunk {
  return { choices: [{ delta: { content: text }, finish_reason: finish }] };
}

function toolCallChunk(index: number, id: string, name: string, args: string): FakeChunk {
  return {
    choices: [
      {
        delta: {
          tool_calls: [{ index, id, type: "function", function: { name, arguments: args } }],
        },
        finish_reason: null,
      },
    ],
  };
}

function chunkFinishToolCalls(): FakeChunk {
  return { choices: [{ delta: {}, finish_reason: "tool_calls" }] };
}

function makeFakeClient(script: FakeChunk[][]) {
  let callIndex = 0;
  const requests: Array<Record<string, unknown>> = [];
  const client = {
    chat: {
      completions: {
        async create(request: Record<string, unknown>) {
          requests.push(request);
          const chunks = script[Math.min(callIndex, script.length - 1)];
          callIndex += 1;
          return (async function* () {
            for (const c of chunks) yield c;
          })();
        },
      },
    },
  };
  return { client, requests };
}

function fnSchema(
  name: string,
  description: string,
  properties: Record<string, unknown> = {},
) {
  return {
    type: "function" as const,
    function: {
      name,
      description,
      parameters: { type: "object", properties, required: [] as string[] },
    },
  };
}

const CORE_TOOL = fnSchema("core.echo", "核心回显工具", {
  text: { type: "string" },
});

const BROWSER_TOOLS = [
  fnSchema("agent_browser", "复合浏览器工具：action=open/click/type/extract_text/screenshot/close", {
    action: { type: "string", enum: ["open", "extract_text", "screenshot", "close"] },
    url: { type: "string" },
  }),
];

const SHOPPING_TOOLS = [
  fnSchema("shopping.compare", "复合比价工具：action=prices/research/watch_*", {
    action: { type: "string", enum: ["prices", "research", "watch_add"] },
    query: { type: "string" },
  }),
  fnSchema("shopping.prepare_order", "准备下单草稿", { sku: { type: "string" } }),
  fnSchema("calendar", "创建日程", { title: { type: "string" } }),
];

const SOURCE_TOOLS = [CORE_TOOL, ...BROWSER_TOOLS, ...SHOPPING_TOOLS];

function baseMessages() {
  return [{ role: "user", content: "帮我打开网页看看价格" } as const];
}

function toolNamesOf(request: Record<string, unknown> | undefined): string[] {
  const tools = request?.tools;
  if (!Array.isArray(tools)) return [];
  return tools
    .map((t) => (t as { function?: { name?: unknown } })?.function?.name)
    .filter((n): n is string => typeof n === "string");
}

function makeCtx(sink: Array<{ name: string; args: Record<string, unknown> }>): ChatToolExecutionContext {
  return {
    executeTool: async (name, args) => {
      sink.push({ name, args: (args ?? {}) as Record<string, unknown> });
      return { ok: true, result: { done: true, tool: name } };
    },
  };
}

describe("真实语料的延迟目录召回（手机端浏览器/比价说法）", () => {
  const REAL_TOOLS = [...AGENT_BROWSER_CHAT_TOOLS, ...SHOPPING_COMPARE_CHAT_TOOLS];
  const namesOf = (tools: ReturnType<typeof buildDomainPreloadTools>) =>
    tools.map((t) => (t as { function: { name: string } }).function.name);

  test("域预载能召回 agent_browser 与 shopping.compare", () => {
    setExtraIntentRules([...AGENT_BROWSER_INTENT_RULES, ...SHOPPING_COMPARE_INTENT_RULES]);

    const browserPreload = namesOf(
      buildDomainPreloadTools("帮我在手机上打开这个网页看看价格", REAL_TOOLS, new Set()),
    );
    assert.ok(
      browserPreload.includes("agent_browser"),
      `浏览器说法应预载 agent_browser（实际 ${JSON.stringify(browserPreload)}）`,
    );

    const shoppingPreload = namesOf(
      buildDomainPreloadTools("帮我比价 iPhone 17", REAL_TOOLS, new Set()),
    );
    assert.ok(
      shoppingPreload.includes("shopping.compare"),
      `比价说法应预载 shopping.compare（实际 ${JSON.stringify(shoppingPreload)}）`,
    );
  });

  test("会话已冻结后，预载工具仍能经 growNames 进入可见集并被执行", async () => {
    // 第一轮：只有核心工具，模拟手机端冷启动/闲聊，冻结会话工具面。
    const first = makeFakeClient([[contentChunk("你好。", "stop")]]);
    await streamCompletionWithTools(
      first.client as never,
      "test-model",
      [...baseMessages()],
      () => {},
      makeCtx([]),
      {
        maxRounds: 1,
        tools: [CORE_TOOL],
        toolSearchSourceTools: SOURCE_TOOLS,
        audit: { stage: "main_chat_tools", sessionId: "test-grow-real-recall" },
      },
    );

    // 第二轮：真实域预载 + growNames，模拟用户这轮才说“打开网页”。
    const preload = buildDomainPreloadTools("帮我打开这个网页看看", REAL_TOOLS, new Set());
    const preloadNames = namesOf(preload);
    const second = makeFakeClient([
      [
        toolCallChunk(
          0,
          "call_open",
          "agent_browser",
          JSON.stringify({ action: "open", url: "https://example.com" }),
        ),
        chunkFinishToolCalls(),
      ],
      [contentChunk("已打开。", "stop")],
    ]);
    const executed: Array<{ name: string; args: Record<string, unknown> }> = [];

    await streamCompletionWithTools(
      second.client as never,
      "test-model",
      [...baseMessages()],
      () => {},
      makeCtx(executed),
      {
        maxRounds: 2,
        tools: [CORE_TOOL, ...preload],
        toolFaceGrowNames: preloadNames,
        toolSearchSourceTools: SOURCE_TOOLS,
        audit: { stage: "main_chat_tools", sessionId: "test-grow-real-recall" },
      },
    );

    assert.ok(
      toolNamesOf(second.requests[0]).includes("agent_browser"),
      `冻结会话里预载工具应经 growNames 进入 tools（实际 ${JSON.stringify(toolNamesOf(second.requests[0]))}）`,
    );
    assert.equal(executed[0]?.name, "agent_browser");
    assert.equal(executed[0]?.args.action, "open");
  });
});

describe("延迟目录 discover 转正（假 client 端到端）", () => {
  test("discover(name) 下发的 schema 真的进入下一波 tools 并可执行", async () => {
    const { client, requests } = makeFakeClient([
      [
        toolCallChunk(0, "call_d", "tool_discover", JSON.stringify({ name: "agent_browser" })),
        chunkFinishToolCalls(),
      ],
      [
        toolCallChunk(
          0,
          "call_o",
          "agent_browser",
          JSON.stringify({ action: "open", url: "https://example.com" }),
        ),
        chunkFinishToolCalls(),
      ],
      [contentChunk("已打开并读取页面。", "stop")],
    ]);
    const executed: Array<{ name: string; args: Record<string, unknown> }> = [];

    await streamCompletionWithTools(
      client as never,
      "test-model",
      [...baseMessages()],
      () => {},
      makeCtx(executed),
      {
        maxRounds: 3,
        tools: [CORE_TOOL],
        toolSearchSourceTools: SOURCE_TOOLS,
        audit: { stage: "main_chat_tools", sessionId: "test-discover-name" },
      },
    );

    assert.ok(
      !toolNamesOf(requests[0]).includes("agent_browser"),
      "首轮 agent_browser 必须还在延迟目录，不应预置",
    );
    assert.ok(
      toolNamesOf(requests[1]).includes("agent_browser"),
      `discover(name) 后下一波 tools 应包含 agent_browser（实际 ${JSON.stringify(toolNamesOf(requests[1]))}）`,
    );
    assert.deepEqual(
      executed.map((e) => e.name),
      ["agent_browser"],
      "转正后的工具应被真实执行",
    );
  });

  test("discover(domain) 把下发了 schema 的域成员一并转正", async () => {
    const { client, requests } = makeFakeClient([
      [
        toolCallChunk(0, "call_d", "tool_discover", JSON.stringify({ domain: "browser" })),
        chunkFinishToolCalls(),
      ],
      [
        toolCallChunk(
          0,
          "call_e",
          "agent_browser",
          JSON.stringify({ action: "extract_text" }),
        ),
        chunkFinishToolCalls(),
      ],
      [contentChunk("页面正文如下……", "stop")],
    ]);
    const executed: Array<{ name: string; args: Record<string, unknown> }> = [];

    await streamCompletionWithTools(
      client as never,
      "test-model",
      [...baseMessages()],
      () => {},
      makeCtx(executed),
      {
        maxRounds: 3,
        tools: [CORE_TOOL],
        toolSearchSourceTools: SOURCE_TOOLS,
        audit: { stage: "main_chat_tools", sessionId: "test-discover-domain" },
      },
    );

    const wave2 = toolNamesOf(requests[1]);
    assert.ok(
      wave2.includes("agent_browser"),
      `域拉取后同域 schema 成员应转正（实际 ${JSON.stringify(wave2)}）`,
    );
    assert.equal(executed[0]?.name, "agent_browser");
    assert.equal(executed[0]?.args.action, "extract_text");
  });

  test("会话工具面接近上限（47/48）时，discover 仍能用最后一个槽位转正", async () => {
    // 生产实证：手机端会话长跑后工具面 47 个，召回 agent_browser.close 被
    // 「已达上限 48，本次不追加」丢掉。这里冻结出 47 个（45 占位 + core + bridge），
    // 验证 discover 转正还能占满第 48 个槽位——不淘汰、不换位。
    const fillers = Array.from({ length: 45 }, (_, i) =>
      fnSchema(`filler_${i}`, `占位工具 ${i}`),
    );
    const first = makeFakeClient([[contentChunk("好。", "stop")]]);
    await streamCompletionWithTools(
      first.client as never,
      "test-model",
      [...baseMessages()],
      () => {},
      makeCtx([]),
      {
        maxRounds: 1,
        tools: [CORE_TOOL, ...fillers],
        toolSearchSourceTools: SOURCE_TOOLS,
        audit: { stage: "main_chat_tools", sessionId: "test-near-cap-promotion" },
      },
    );

    const second = makeFakeClient([
      [
        toolCallChunk(0, "call_d", "tool_discover", JSON.stringify({ name: "agent_browser" })),
        chunkFinishToolCalls(),
      ],
      [
        toolCallChunk(0, "call_c", "agent_browser", JSON.stringify({ action: "close" })),
        chunkFinishToolCalls(),
      ],
      [contentChunk("已关闭。", "stop")],
    ]);
    const executed: Array<{ name: string; args: Record<string, unknown> }> = [];

    await streamCompletionWithTools(
      second.client as never,
      "test-model",
      [...baseMessages()],
      () => {},
      makeCtx(executed),
      {
        maxRounds: 3,
        tools: [CORE_TOOL],
        toolSearchSourceTools: SOURCE_TOOLS,
        audit: { stage: "main_chat_tools", sessionId: "test-near-cap-promotion" },
      },
    );

    assert.ok(
      toolNamesOf(second.requests[1]).includes("agent_browser"),
      `47/48 时 discover 应占满最后一个槽位（实际 ${JSON.stringify(toolNamesOf(second.requests[1]))}）`,
    );
    assert.equal(executed[0]?.name, "agent_browser");
  });

  test("tool_search 只回名字、未下发 schema 时不转正", async () => {
    const { client, requests } = makeFakeClient([
      [
        toolCallChunk(0, "call_s", "tool_search", JSON.stringify({ query: "跨平台比价" })),
        chunkFinishToolCalls(),
      ],
      [contentChunk("先不下单，需要你确认。", "stop")],
    ]);

    await streamCompletionWithTools(
      client as never,
      "test-model",
      [...baseMessages()],
      () => {},
      makeCtx([]),
      {
        maxRounds: 2,
        tools: [CORE_TOOL],
        toolSearchSourceTools: SOURCE_TOOLS,
        audit: { stage: "main_chat_tools", sessionId: "test-search-no-schema" },
      },
    );

    const wave2 = toolNamesOf(requests[1]);
    assert.ok(
      !wave2.includes("shopping_compare"),
      `未下发 schema 的 search 不应转正（实际 ${JSON.stringify(wave2)}）`,
    );
  });
});
