/**
 * ObservationPack（obs_recall）测试 —— 借鉴 NVlabs/SoL-Pi 的结果句柄化机制。
 *
 * 覆盖：
 *  - ObservationPack 单元：归档阈值、分页读回（含 surrogate pair 安全）、
 *    参数归一、未知句柄可恢复错误、容量 FIFO 淘汰、会话级复用
 *  - archiveIfWorthwhile：只有「真的省了很多字符」才归档
 *  - compactor：compactToolOutputForLlm 返回 rawText（归档数据源）
 *  - foldOldWaveToolChains：旧波折叠行追加 obs_recall 句柄标注
 *  - 假 client 端到端：压缩点附读回提示 → obs_recall 在循环层被拦截执行
 *    （不进 ToolRegistry）→ 分页结果回填 → 旧波折叠携带句柄标注
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

// ---------- ObservationPack 单元 ----------

describe("ObservationPack 存储与读回", () => {
  test("归档阈值：小结果不归档，大结果返回稳定句柄", async () => {
    const { ObservationPack } = await import(
      "../src/external-model/observation-pack.js"
    );
    const pack = new ObservationPack();
    assert.equal(pack.archive("search_web", "call_a", "太短".repeat(10)), null);
    const big = JSON.stringify({ payload: "x".repeat(3000) });
    const obs = pack.archive("search_web", "call_a", big);
    assert.ok(obs, "大结果应归档");
    assert.equal(obs!.id, "obs_1");
    assert.equal(obs!.chars, big.length);
    assert.equal(obs!.toolCallId, "call_a");
    assert.equal(pack.idForToolCall("call_a"), "obs_1");
    // 第二条句柄递增
    const obs2 = pack.archive("fetch_web", "call_b", big);
    assert.equal(obs2!.id, "obs_2");
  });

  test("分页读回：默认/自定义 offset+limit、nextOffset 到末尾为 null", async () => {
    const { ObservationPack } = await import(
      "../src/external-model/observation-pack.js"
    );
    const pack = new ObservationPack();
    const text = "abcdefghij".repeat(500); // 5000 字符
    pack.archive("t", "call", text);

    const page0 = pack.recall({ id: "obs_1" });
    assert.ok(page0.ok);
    assert.equal(page0.result.offset, 0);
    assert.equal(page0.result.returnedChars, 4000);
    assert.equal(page0.result.nextOffset, 4000);
    assert.equal(page0.result.totalChars, 5000);
    assert.equal(page0.result.text, text.slice(0, 4000));

    const page1 = pack.recall({ id: "obs_1", offset: 4000, limit: 4000 });
    assert.ok(page1.ok);
    assert.equal(page1.result.returnedChars, 1000);
    assert.equal(page1.result.nextOffset, null, "到末尾 nextOffset 应为 null");
    assert.equal(page1.result.text, text.slice(4000));
    // 全文重建无损
    assert.equal(page0.result.text + page1.result.text, text);
  });

  test("参数归一：offset 越界/负数、limit 超上限均钳制", async () => {
    const { ObservationPack } = await import(
      "../src/external-model/observation-pack.js"
    );
    const pack = new ObservationPack();
    pack.archive("t", "call", "y".repeat(2500));
    const atEnd = pack.recall({ id: "obs_1", offset: 99999 });
    assert.ok(atEnd.ok);
    assert.equal(atEnd.result.text, "");
    assert.equal(atEnd.result.nextOffset, null);
    const neg = pack.recall({ id: "obs_1", offset: -5, limit: 999999 });
    assert.ok(neg.ok);
    assert.equal(neg.result.offset, 0);
    assert.ok(neg.result.returnedChars <= 12000, "limit 应钳制到上限");
    const floats = pack.recall({ id: "obs_1", offset: 1.5, limit: -3 });
    assert.ok(floats.ok);
    assert.equal(floats.result.offset, 1, "小数 offset 按整数截断处理");
    assert.equal(floats.result.returnedChars, 2499, "非法 limit 回落默认 4000，从 offset 到末尾");
  });

  test("surrogate pair 安全：分页边界落在 emoji 中间时回退，全文重建无损", async () => {
    const { ObservationPack } = await import(
      "../src/external-model/observation-pack.js"
    );
    const pack = new ObservationPack();
    const text = "a".repeat(3999) + "😀" + "b".repeat(2000);
    pack.archive("t", "call", text);
    const pages: string[] = [];
    let offset = 0;
    for (let i = 0; i < 10; i++) {
      const page = pack.recall({ id: "obs_1", offset, limit: 4000 });
      assert.ok(page.ok);
      pages.push(page.result.text);
      if (page.result.nextOffset === null) break;
      offset = page.result.nextOffset;
      // 每页都应可安全编码（没有劈开的半个代理项）
      assert.doesNotThrow(() => Buffer.from(page.result.text, "utf8"));
    }
    assert.equal(pages.join(""), text, "分页读回应无损重建全文");
  });

  test("未知/缺失句柄：可恢复错误并列出可用句柄", async () => {
    const { ObservationPack } = await import(
      "../src/external-model/observation-pack.js"
    );
    const pack = new ObservationPack();
    pack.archive("t", "call", "z".repeat(2500));
    const missing = pack.recall({});
    assert.equal(missing.ok, false);
    assert.match(missing.error, /id/);
    const stale = pack.recall({ id: "obs_99" });
    assert.equal(stale.ok, false);
    assert.match(stale.error, /obs_99/);
    assert.match(stale.error, /obs_1/, "错误信息应列出可用句柄");
    assert.match(stale.error, /重新调用原工具/);
  });

  test("容量上限：条数超限 FIFO 淘汰最旧条目，读回失效句柄报可恢复错误", async () => {
    const { ObservationPack } = await import(
      "../src/external-model/observation-pack.js"
    );
    const pack = new ObservationPack();
    const big = "w".repeat(2500);
    for (let i = 0; i < 33; i++) {
      const obs = pack.archive("t", `call_${i}`, big);
      assert.ok(obs, `第 ${i} 条应归档成功（FIFO 淘汰保证长会话可用）`);
    }
    assert.equal(pack.size, 32, "条数应钳制在上限");
    assert.equal(pack.idForToolCall("call_0"), undefined, "最旧条目应被淘汰");
    assert.equal(pack.idForToolCall("call_32"), "obs_33");
    const evicted = pack.recall({ id: "obs_1" });
    assert.equal(evicted.ok, false);
    const newest = pack.recall({ id: "obs_33" });
    assert.ok(newest.ok);
  });

  test("单条超总字符上限：放弃归档（返回 null），不破坏既有条目", async () => {
    const { ObservationPack } = await import(
      "../src/external-model/observation-pack.js"
    );
    const pack = new ObservationPack();
    pack.archive("t", "call_keep", "k".repeat(2500));
    const oversized = pack.archive("t", "call_huge", "H".repeat(500_000));
    assert.equal(oversized, null);
    assert.equal(pack.size, 1);
    assert.ok(pack.recall({ id: "obs_1" }).ok, "既有条目不受影响");
  });

  test("会话级复用默认关闭：同 session 每轮独立实例；显式开启才复用", async () => {
    const mod = await import("../src/external-model/observation-pack.js");
    mod.resetObservationPacksForTest();
    const prev = process.env.OBS_PACK_CROSS_TURN;
    try {
      delete process.env.OBS_PACK_CROSS_TURN;
      const perTurnA = mod.getObservationPack("sess-1");
      const perTurnB = mod.getObservationPack("sess-1");
      assert.notEqual(perTurnA, perTurnB, "默认按轮丢弃：同 session 两次调用应是独立实例");

      process.env.OBS_PACK_CROSS_TURN = "1";
      const sharedA = mod.getObservationPack("sess-1");
      const sharedB = mod.getObservationPack("sess-1");
      assert.equal(sharedA, sharedB, "显式开启跨轮复用时同 session 返回同一实例");
      mod.releaseObservationPack("sess-1");
      assert.notEqual(mod.getObservationPack("sess-1"), sharedA, "释放后应生成新实例");
    } finally {
      if (prev === undefined) delete process.env.OBS_PACK_CROSS_TURN;
      else process.env.OBS_PACK_CROSS_TURN = prev;
      mod.resetObservationPacksForTest();
    }
  });
});

// ---------- archiveIfWorthwhile 阈值 ----------

describe("archiveIfWorthwhile 归档阈值", () => {
  test("压缩节省不足时不归档；足够时归档并生成读回提示", async () => {
    const { ObservationPack, archiveIfWorthwhile, buildObservationRecallHint } =
      await import("../src/external-model/observation-pack.js");
    const pack = new ObservationPack();
    const rawText = JSON.stringify({ payload: "x".repeat(4000) });
    // 几乎无损：saved < 600 → 不归档
    assert.equal(
      archiveIfWorthwhile(pack, "t", "call", rawText, rawText.slice(0, rawText.length - 100)),
      null,
    );
    // 大幅压缩：归档成功
    const obs = archiveIfWorthwhile(pack, "search_web", "call_9", rawText, "压缩摘要");
    assert.ok(obs);
    const hint = buildObservationRecallHint(obs!);
    assert.match(hint, /obs_recall\(id="obs_1"/);
    assert.match(hint, /原文 \d+ 字符/);
    // rawText 缺省安全
    assert.equal(archiveIfWorthwhile(pack, "t", "call", undefined, ""), null);
  });
});

// ---------- compactor rawText ----------

describe("compactToolOutputForLlm rawText", () => {
  test("返回压缩前完整原文（ObservationPack 归档数据源）", async () => {
    const { compactToolOutputForLlm } = await import("../src/tokenjuice/compactor.js");
    const result = {
      items: Array.from({ length: 40 }, (_, i) => ({
        title: `条目${i}` + "详".repeat(120),
        url: `https://example.com/${i}`,
      })),
    };
    const out = await compactToolOutputForLlm({
      toolName: "search_web",
      ok: true,
      result,
      preferredMaxChars: 1500,
    });
    assert.equal(out.rawText, JSON.stringify(result));
    assert.ok(out.compactBytes < out.rawBytes, "压缩后应更小");
    assert.ok(out.content.length < out.rawText!.length);
  });
});

// ---------- foldOldWaveToolChains 句柄标注 ----------

describe("foldOldWaveToolChains obs 句柄标注", () => {
  const assistantWithCalls = (id: string, name: string): ChatCompletionMessageParam =>
    ({
      role: "assistant",
      content: null,
      tool_calls: [
        { id, type: "function", function: { name, arguments: "{}" } },
      ],
    }) as unknown as ChatCompletionMessageParam;

  test("旧链被折叠的归档结果追加句柄标注，当前链与非归档结果不受影响", async () => {
    const { foldOldWaveToolChains } = await import(
      "../src/external-model/openai-compatible-tool-loop.js"
    );
    const msgs: ChatCompletionMessageParam[] = [
      { role: "user", content: "查一下" },
      assistantWithCalls("call_0", "search_web"),
      { role: "tool", tool_call_id: "call_0", content: "x".repeat(300) },
      { role: "user", content: "换个角度再查" },
      assistantWithCalls("call_1", "search_web"),
      { role: "tool", tool_call_id: "call_1", content: "y".repeat(300) },
    ] as unknown as ChatCompletionMessageParam[];
    const resolver = (callId: string) => (callId === "call_0" ? "obs_1" : undefined);
    const folded = foldOldWaveToolChains(msgs, 160, resolver) as ChatCompletionMessageParam[];
    const texts = folded.map((m) => (typeof m.content === "string" ? m.content : ""));
    const annotated = texts.find((t) => t.includes("【历史工具结果摘要"));
    assert.ok(annotated, "旧链应折叠为摘要消息");
    assert.match(annotated!, /\[obs_recall id="obs_1" 可分页读回原文\]/);
    assert.ok(
      !annotated!.includes("obs_2"),
      "非归档结果不应生成句柄标注",
    );
    // 当前波次链原样保留（含 call_1 的完整 tool 消息）
    const currentTool = folded.find(
      (m) => (m as { tool_call_id?: string }).tool_call_id === "call_1",
    );
    assert.ok(currentTool, "当前波次 tool 消息应原样保留");
    // 不传 resolver 时行为与旧版一致（无标注）
    const plain = foldOldWaveToolChains(msgs) as ChatCompletionMessageParam[];
    const plainFold = plain
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .find((t) => t.includes("【历史工具结果摘要"));
    assert.ok(plainFold && !plainFold.includes("obs_recall"), "不传 resolver 无标注");
  });
});

// ---------- 假 client 端到端 ----------

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
  return { client, requests, get calls() { return callIndex; } };
}

/** 从请求的 messages 中取全部 string content（绕开 JSON.stringify 的引号转义干扰）。 */
function messageContents(request: Record<string, unknown>): string[] {
  const msgs = (request?.messages ?? []) as Array<{ content?: unknown }>;
  return msgs
    .map((m) => (typeof m.content === "string" ? m.content : ""))
    .filter((c) => c.length > 0);
}

const SEARCH_TOOL_SCHEMA = {
  type: "function" as const,
  function: {
    name: "search_web",
    description: "联网搜索",
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
};

function bigSearchResult(seed: string) {
  return {
    ok: true,
    query: seed,
    items: Array.from({ length: 30 }, (_, i) => ({
      title: `${seed}-条目${i}` + "容".repeat(150),
      snippet: `${seed} 摘要${i}` + "要".repeat(200),
      url: `https://example.com/${seed}/${i}`,
    })),
  };
}

describe("obs_recall 端到端（假 client 驱动真实 tool loop）", () => {
  test("压缩点附读回提示 → obs_recall 循环层拦截执行并分页回填", async () => {
    const { streamCompletionWithTools } = await import(
      "../src/external-model/openai-compatible-tool-loop.js"
    );
    const { OBS_RECALL_CHAT_TOOL } = await import(
      "../src/external-model/builtin-chat-tools.js"
    );
    const executed: string[] = [];
    const script: FakeChunk[][] = [
      // wave0 PLAN：调 search_web
      [toolCallChunk(0, "call_0", "search_web", '{"query":"上海房价"}'), chunkFinishToolCalls()],
      // wave0 后充分性探测：报结果不足 → 升级 replan
      [contentChunk("NEED_MORE_TOOLS")],
      // wave1 replan：读回 obs_1 第一页
      [
        toolCallChunk(0, "call_1", "obs_recall", '{"id":"obs_1","offset":0,"limit":4000}'),
        chunkFinishToolCalls(),
      ],
      // wave1 后探测：基于读回原文收尾
      [contentChunk("已根据读回的原文补齐细节：\n结论更新完毕。", "stop")],
    ];
    const { client, requests } = makeFakeClient(script);
    const finalText = await streamCompletionWithTools(
      client as never,
      "test-model",
      [{ role: "user", content: "上海房价详细盘点" } as never],
      () => {},
      {
        executeTool: async (name) => {
          executed.push(name);
          if (name === "search_web") return { ok: true, result: bigSearchResult("sh") };
          throw new Error(`obs_recall 不应进入 ToolRegistry 执行器，实际收到: ${name}`);
        },
      } as never,
      { maxRounds: 4, tools: [SEARCH_TOOL_SCHEMA, OBS_RECALL_CHAT_TOOL] },
    );

    assert.match(finalText, /结论更新完毕/);
    assert.deepEqual(executed, ["search_web"], "只有 search_web 进了执行器");
    // wave1 replan 请求应包含压缩点的读回提示
    const replanContents = messageContents(requests[2]).join("\n");
    assert.match(replanContents, /obs_recall\(id="obs_1"/, "压缩后 tool 消息应附读回提示");
    // 最终探测请求应包含 obs_recall 的分页结果（4000 字符 + nextOffset）
    // （消息尾部还拼了充分性提示，先截出 JSON 主体再解析）
    const recallMsg = messageContents(requests[3]).find((c) => c.includes('"nextOffset"'));
    assert.ok(recallMsg, "最终请求应包含 obs_recall 的分页结果消息");
    const recallJson = recallMsg!.slice(0, recallMsg!.lastIndexOf("}") + 1);
    const recallResult = JSON.parse(recallJson) as {
      ok: boolean;
      id: string;
      tool: string;
      totalChars: number;
      returnedChars: number;
      nextOffset: number | null;
      text: string;
    };
    assert.equal(recallResult.ok, true);
    assert.equal(recallResult.id, "obs_1");
    assert.equal(recallResult.tool, "search_web");
    assert.equal(recallResult.returnedChars, 4000);
    assert.equal(recallResult.nextOffset, 4000);
    assert.ok(recallResult.totalChars > 4000);
  });

  test("多波 replan：旧波折叠摘要携带 obs_recall 句柄标注", async () => {
    const { streamCompletionWithTools } = await import(
      "../src/external-model/openai-compatible-tool-loop.js"
    );
    const { OBS_RECALL_CHAT_TOOL } = await import(
      "../src/external-model/builtin-chat-tools.js"
    );
    const script: FakeChunk[][] = [
      [toolCallChunk(0, "call_0", "search_web", '{"query":"q1"}'), chunkFinishToolCalls()],
      [contentChunk("NEED_MORE_TOOLS")],
      [toolCallChunk(0, "call_1", "search_web", '{"query":"q2"}'), chunkFinishToolCalls()],
      [contentChunk("NEED_MORE_TOOLS")],
      // wave2 replan：wave0 链此时应被折叠并携带句柄标注
      [contentChunk("两轮结果已收齐：\n整理如下。", "stop")],
    ];
    const { client, requests } = makeFakeClient(script);
    await streamCompletionWithTools(
      client as never,
      "test-model",
      [{ role: "user", content: "多角度对比盘点" } as never],
      () => {},
      {
        executeTool: async (name, args) => {
          if (name === "search_web") {
            return { ok: true, result: bigSearchResult((args as { query: string }).query) };
          }
          return { ok: false, result: { error: "unexpected" } };
        },
      } as never,
      { maxRounds: 4, tools: [SEARCH_TOOL_SCHEMA, OBS_RECALL_CHAT_TOOL] },
    );
    // wave2 的 replan 请求中，wave0 链应被折叠且带句柄标注
    const wave2Contents = messageContents(requests[4]).join("\n");
    assert.match(wave2Contents, /【历史工具结果摘要/);
    assert.match(wave2Contents, /\[obs_recall id="obs_1" 可分页读回原文\]/);
  });
});
