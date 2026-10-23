/**
 * 工具调用链路加固回归测试（2026-09-11 链路重构）。
 *
 * 用假 OpenAI client（脚本化 chunk 流）驱动真实的 streamCompletionWithTools，
 * 端到端覆盖：
 *  - 阶段0-1：超时 timer 清理、超时后残留守卫（无 unhandledRejection）
 *  - 阶段0-2：工具抛异常不再被谎报为「超时」，且确定性重试生效
 *  - 阶段0-3：截断 JSON 参数最小修复；不可修复时回填 TOOL_ARGS_MALFORMED 且不执行
 *  - 阶段2-3：工具波次前导话流式透出（在工具执行前推送）
 *  - 阶段2-2：超时结果携带 TOOL_TIMEOUT 错误码
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  isToolExecutionTimeoutError,
  streamCompletionWithTools,
  tryRepairTruncatedJsonObject,
} from "../src/external-model/openai-compatible-tool-loop.js";
import type { ChatToolExecutionContext } from "../src/external-model/types.js";
import { TurnBudget } from "../src/agent/turn-budget.js";
import { reportChatToolDrift } from "../src/tools/chat-tool-drift.js";
import {
  classifyToolFailure,
  UnifiedErrorCode,
} from "@nextbot/agent-protocol";

// ---------- 假 LLM client（脚本化 chunk 流） ----------

type FakeChunk = Record<string, unknown>;

function contentChunk(text: string, finish: string | null = null): FakeChunk {
  return { choices: [{ delta: { content: text }, finish_reason: finish }] };
}

function toolCallChunk(
  index: number,
  id: string,
  name: string,
  args: string,
): FakeChunk {
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

function makeCtx(
  executeTool: ChatToolExecutionContext["executeTool"],
  sinks: {
    toolStarts?: string[];
    toolResults?: Array<{ toolName: string; ok: boolean; result: Record<string, unknown> }>;
  } = {},
): ChatToolExecutionContext {
  return {
    executeTool,
    ...(sinks.toolStarts ? {
      onToolExecuteStart: (info) => sinks.toolStarts!.push(info.toolName),
    } : {}),
    ...(sinks.toolResults ? {
      onToolExecuted: (info) =>
        sinks.toolResults!.push({ toolName: info.toolName, ok: info.ok, result: info.result }),
    } : {}),
  };
}

const WEATHER_TOOL_SCHEMA = {
  type: "function" as const,
  function: {
    name: "test.query",
    description: "测试查询工具",
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
};

const API_TOOL_NAME = "test_query";
const FINAL_ANSWER = "根据查询结果：晴，28 度。";

/** 波次脚本：第一波调 test_query（arguments 可指定），第二波给最终回答。 */
function twoWaveScript(wave1Args: string, preamble = "我帮您查一下天气。"): FakeChunk[][] {
  return [
    [
      contentChunk(preamble),
      toolCallChunk(0, "call_1", API_TOOL_NAME, wave1Args),
      chunkFinishToolCalls(),
    ],
    [contentChunk(FINAL_ANSWER, "stop")],
  ];
}

function chunkFinishToolCalls(): FakeChunk {
  return { choices: [{ delta: {}, finish_reason: "tool_calls" }] };
}

function baseMessages() {
  return [{ role: "user", content: "今天天气怎么样" } as const];
}

// ---------- 端到端场景 ----------

describe("tool-loop 加固（假 client 端到端）", () => {
  test("阶段2-3：工具波次前导话在工具执行前流式推送", async () => {
    const { client } = makeFakeClient(twoWaveScript(JSON.stringify({ query: "天气" })));
    const ordered: string[] = [];
    const deltas: string[] = [];
    const ctxOrdered: ChatToolExecutionContext = {
      executeTool: async () => {
        ordered.push("tool-exec");
        return { ok: true, result: { weather: "晴" } };
      },
      onToolExecuteStart: () => ordered.push("tool-start"),
    };
    await streamCompletionWithTools(
      client as never,
      "test-model",
      [...baseMessages()],
      (d) => {
        deltas.push(d);
        ordered.push(`delta:${d}`);
      },
      ctxOrdered,
      { maxRounds: 2, tools: [WEATHER_TOOL_SCHEMA] },
    );
    assert.ok(ordered.some((e) => e === "tool-exec"), "工具应被执行");
    const deltaIdx = ordered.findIndex((e) => e.startsWith("delta:我帮您查一下天气。"));
    const toolIdx = ordered.indexOf("tool-exec");
    assert.ok(deltaIdx >= 0, `前导话应流式推送（deltas=${JSON.stringify(deltas)}）`);
    assert.ok(deltaIdx < toolIdx, "前导话必须在工具执行之前推送");
    // 前导话只推一次：不应再次出现在最终回复流里
    assert.equal(
      deltas.filter((d) => d.includes("我帮您查一下")).length,
      1,
      "前导话不应重复出现在最终回复",
    );
  });

  test("阶段0-3：截断 JSON 参数被最小修复并正常执行", async () => {
    const { client } = makeFakeClient(twoWaveScript('{"query": "今天天气'));
    const executed: Array<{ name: string; args: Record<string, unknown> }> = [];
    const ctx = makeCtx(async (name, args) => {
      executed.push({ name, args });
      return { ok: true, result: { weather: "晴" } };
    });
    await streamCompletionWithTools(
      client as never,
      "test-model",
      [...baseMessages()],
      () => {},
      ctx,
      { maxRounds: 2, tools: [WEATHER_TOOL_SCHEMA] },
    );
    assert.equal(executed.length, 1, `工具应恰好执行一次（实际 ${executed.length}）`);
    assert.equal(executed[0].name, "test.query");
    assert.deepEqual(executed[0].args, { query: "今天天气" }, "修复后的参数应完整可用");
  });

  test("阶段0-3：不可修复的参数不执行，回填 TOOL_ARGS_MALFORMED", async () => {
    // {"query": → 孤键截断，补齐后仍非合法 JSON → 走可恢复错误路径
    const { client } = makeFakeClient(twoWaveScript('{"query":'));
    const executed: string[] = [];
    const toolResults: Array<{ toolName: string; ok: boolean; result: Record<string, unknown> }> = [];
    const ctx = makeCtx(
      async (name) => {
        executed.push(name);
        return { ok: true, result: {} };
      },
      { toolResults },
    );
    await streamCompletionWithTools(
      client as never,
      "test-model",
      [...baseMessages()],
      () => {},
      ctx,
      { maxRounds: 2, tools: [WEATHER_TOOL_SCHEMA] },
    );
    assert.equal(executed.length, 0, "参数不合法时绝不应执行工具");
    assert.equal(toolResults.length, 1);
    assert.equal(toolResults[0].ok, false);
    assert.equal(toolResults[0].result.errorCode, UnifiedErrorCode.ToolArgsMalformed);
    assert.match(String(toolResults[0].result.error), /不是合法 JSON/);
  });

  test("阶段0-2：工具抛异常不再谎报为超时，且确定性重试一次", async () => {
    const { client } = makeFakeClient(twoWaveScript(JSON.stringify({ query: "天气" })));
    let attempts = 0;
    const toolResults: Array<{ toolName: string; ok: boolean; result: Record<string, unknown> }> = [];
    const ctx = makeCtx(
      async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("网络断了（真实故障）");
        return { ok: true, result: { weather: "晴" } };
      },
      { toolResults },
    );
    await streamCompletionWithTools(
      client as never,
      "test-model",
      [...baseMessages()],
      () => {},
      ctx,
      { maxRounds: 2, tools: [WEATHER_TOOL_SCHEMA] },
    );
    assert.equal(attempts, 2, "非超时失败应确定性重试 1 次（旧代码误标 timeout 会跳过重试）");
    assert.equal(toolResults[0].ok, true, "重试成功后应视为成功");
  });

  test("阶段0-1/2-2：真超时标记 TOOL_TIMEOUT、不重试、无 unhandledRejection", async () => {
    const prevTimeout = process.env.TOOL_EXECUTION_TIMEOUT_MS;
    process.env.TOOL_EXECUTION_TIMEOUT_MS = "150";
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      // 模型赢了 race（工具 600ms 后落定）而 timer 在 150ms 先触发：
      // 旧代码输掉的 timeout promise 在工具落定后 reject → unhandledRejection + timer 泄漏。
      const { client } = makeFakeClient(twoWaveScript(JSON.stringify({ query: "天气" })));
      let attempts = 0;
      const toolResults: Array<{ toolName: string; ok: boolean; result: Record<string, unknown> }> = [];
      const ctx = makeCtx(
        async () => {
          attempts += 1;
          await new Promise((r) => setTimeout(r, 600));
          return { ok: true, result: { weather: "晴" } };
        },
        { toolResults },
      );
      const text = await streamCompletionWithTools(
        client as never,
        "test-model",
        [...baseMessages()],
        () => {},
        ctx,
        { maxRounds: 2, tools: [WEATHER_TOOL_SCHEMA] },
      );
      assert.equal(attempts, 1, "超时不应重试（时间预算已烧完）");
      assert.equal(toolResults[0].ok, false);
      assert.equal(toolResults[0].result.errorCode, UnifiedErrorCode.ToolTimeout);
      assert.match(String(toolResults[0].result.error), /超时/);
      assert.ok(text.includes(FINAL_ANSWER) || text.length > 0, "第二轮应正常收尾");
      // 等待底层工具残留落定 + 原 timer 应已清除（600ms > 150ms timer）
      await new Promise((r) => setTimeout(r, 700));
      assert.equal(unhandled.length, 0, `不应有 unhandledRejection（${JSON.stringify(unhandled)}）`);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      if (prevTimeout === undefined) delete process.env.TOOL_EXECUTION_TIMEOUT_MS;
      else process.env.TOOL_EXECUTION_TIMEOUT_MS = prevTimeout;
    }
  });

  test("阶段2-4：预算击杀不再静默——[tool-budget] 击杀 + 落定日志成对出现", async () => {
    // 事故教训（2026-10-12 行程卡缺席）：击杀此前只静默吞掉，导致 `ok=false + ms≈预算`
    // 与「工具真的跑了 30s 才失败」在日志里无法区分，bug 藏了半个月。这两条日志把
    // 「预算不够 vs 能力不行」变成可判定证据——本测试锁死它们不能又被删掉。
    const prevTimeout = process.env.TOOL_EXECUTION_TIMEOUT_MS;
    process.env.TOOL_EXECUTION_TIMEOUT_MS = "150";
    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warns.push(args.map(String).join(" "));
    };
    try {
      const { client } = makeFakeClient(twoWaveScript(JSON.stringify({ query: "天气" })));
      const ctx = makeCtx(
        async () => {
          await new Promise((r) => setTimeout(r, 600));
          return { ok: true, result: { weather: "晴" } };
        },
        { toolResults: [] },
      );
      await streamCompletionWithTools(
        client as never,
        "test-model",
        [...baseMessages()],
        () => {},
        ctx,
        { maxRounds: 2, tools: [WEATHER_TOOL_SCHEMA] },
      );
      assert.ok(
        warns.some((w) => /\[tool-budget\] 击杀 tool=.*预算=150ms/.test(w)),
        `应有击杀日志，实际: ${JSON.stringify(warns)}`,
      );
      // 等后台残留落定 → 落定日志给出「真实耗时 vs 预算」的判定锚点
      await new Promise((r) => setTimeout(r, 800));
      assert.ok(
        warns.some((w) => /\[tool-budget\] 击杀后真实完成 .*实际=\d+ms 预算=150ms/.test(w)),
        `应有落定日志（预算不足 vs 能力不行的判定锚点），实际: ${JSON.stringify(warns)}`,
      );
    } finally {
      console.warn = origWarn;
      if (prevTimeout === undefined) delete process.env.TOOL_EXECUTION_TIMEOUT_MS;
      else process.env.TOOL_EXECUTION_TIMEOUT_MS = prevTimeout;
    }
  });
});

// ---------- 单元：截断 JSON 修复 ----------

describe("tryRepairTruncatedJsonObject", () => {
  test("补齐截断的字符串值与闭合括号", () => {
    assert.deepEqual(tryRepairTruncatedJsonObject('{"query": "今天天气'), { query: "今天天气" });
  });
  test("补齐嵌套对象", () => {
    assert.deepEqual(tryRepairTruncatedJsonObject('{"a": {"b": 1'), { a: { b: 1 } });
  });
  test("完整 JSON 原样通过", () => {
    assert.deepEqual(tryRepairTruncatedJsonObject('{"x": 1}'), { x: 1 });
  });
  test("孤键截断（无值）判负，不给脏参数", () => {
    assert.equal(tryRepairTruncatedJsonObject('{"query":'), null);
  });
  test("非对象输入判负", () => {
    assert.equal(tryRepairTruncatedJsonObject('[1,2'), null);
    assert.equal(tryRepairTruncatedJsonObject('hello'), null);
  });
});

// ---------- 单元：TurnBudget ----------

describe("TurnBudget", () => {
  test("默认预算内放行升级，超限拒绝", () => {
    const budget = new TurnBudget(3);
    budget.consumeMainPath(); // 主调用
    assert.equal(budget.tryUpgrade("gate-1"), true);
    assert.equal(budget.tryUpgrade("gate-2"), true);
    assert.equal(budget.tryUpgrade("gate-3"), false, "超过上限必须拒绝");
    assert.equal(budget.usedCount, 4);
  });
});

// ---------- 单元：注册漂移检测 ----------

describe("reportChatToolDrift", () => {
  test("schema 无执行器 → schemaOnly；别名归一后命中不算漂移", () => {
    const schemas = [
      { type: "function", function: { name: "calendar.create_from_text", parameters: {} } },
      { type: "function", function: { name: "self.list_custom_skills", parameters: {} } },
      { type: "function", function: { name: "tool_discover", parameters: {} } },
    ] as never[];
    const report = reportChatToolDrift({
      schemas,
      registeredToolNames: ["calendar.create_from_text", "skill.list", "search_web"],
    });
    assert.deepEqual(report.schemaOnly, [], "别名归一（self.list_custom_skills→skill.list）不应报漂移");
    assert.ok(report.executorOnly.includes("search_web"), "无 schema 的执行器应被点名");
  });
});

// ---------- 单元：错误码分类 ----------

describe("classifyToolFailure", () => {
  test("优先读结构化 errorCode", () => {
    assert.equal(
      classifyToolFailure({ errorCode: UnifiedErrorCode.ToolDenied, error: "x" }),
      UnifiedErrorCode.ToolDenied,
    );
  });
  test("无码时按超时标志/文本启发式兜底", () => {
    assert.equal(classifyToolFailure({ timeout: true }), UnifiedErrorCode.ToolTimeout);
    assert.equal(classifyToolFailure({ error: "未知工具: foo" }), UnifiedErrorCode.ToolUnknown);
    assert.equal(classifyToolFailure({ error: "随便" }), UnifiedErrorCode.ToolExecutionFailed);
  });
});

// ---------- 单元：类型化超时错误 ----------

describe("isToolExecutionTimeoutError", () => {
  test("仅类型化错误命中", () => {
    assert.equal(isToolExecutionTimeoutError(new Error("工具执行超时 (30ms)")), false, "普通 Error 不应误判");
    const err = new Error("x") as Error & { isToolExecutionTimeout?: boolean };
    err.isToolExecutionTimeout = true;
    assert.equal(isToolExecutionTimeoutError(err), true);
  });
});
