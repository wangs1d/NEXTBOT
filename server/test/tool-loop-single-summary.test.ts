/**
 * Plan-and-Execute 工具编排（openai-compatible-tool-loop）基准与行为测试：
 *   A. 并行规划 + 探测通过：单批多工具 → 无 schema 汇总收尾（2 次调用，token 最省路径）
 *   B. 纯对话：无工具调用 → 1 次调用直接返回
 *   C. 失败确定性重试：首次失败自动重试 1 次成功 → 探测通过收尾
 *   D. 持续失败 → replan 波次：带 schema 的重规划，模型基于知识回答
 *   E. 探测升级：NEED_MORE_TOOLS → replan 继续取数 → 最终汇总
 *   F. 轮内去重缓存：同工具+同参数的重复调用只真实执行 1 次
 *   G. fast 单波失败：波次耗尽 → 兜底无 schema 汇总（不劣化）
 * 用 mock LLM client（脚本化 chunk 流）驱动，通过 llm-token-audit 的 NDJSON
 * 逐调用记录统计 inputChars/outputChars，供 token 对比。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 必须在动态 import 业务模块前设置：审计落盘目录 / tokenjuice 开关均在运行时读取 env
const BENCH_DATA_DIR = mkdtempSync(join(tmpdir(), "tool-loop-bench-"));
process.env.PA_DATA_DIR = BENCH_DATA_DIR;
process.env.AGENT_TOKENJUICE_ENABLED = "0";
// 本文件验证的是 replan/汇总/去重等波次机制基线（AGENT_TOOL_ARCH=legacy 行为）。
// 静态架构下「尝试全败」会触发单一出口检查多续一波（有意的行为差异），
// 该行为的验收在 scripts/e2e-tool-arch.ts 台架里做。
process.env.AGENT_TOOL_ARCH = "legacy";

const { streamCompletionWithTools, safeTruncateDigest, trimHistoryForSummary, selectRelevantTools } = await import(
  "../src/external-model/openai-compatible-tool-loop.js"
);
const { resetLlmUsageAuditForTest } = await import("../src/services/llm-token-audit.js");

/* ---------------- mock LLM client（脚本化 chunk 流） ---------------- */

type AnyChunk = Record<string, unknown>;
type ChatMessage = { role: string; content: string };

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

/** 把脚本化流式 chunks 合并成非流式 ChatCompletion 形态（规划轮 stream:false 用）。 */
function nonStreamingResponse(chunks: AnyChunk[]) {
  let content = "";
  let reasoning = "";
  let finishReason: string | null = null;
  const byIndex = new Map<number, Record<string, unknown>>();
  for (const c of chunks) {
    const choice = c.choices?.[0] as
      | { delta?: Record<string, unknown>; finish_reason?: string | null }
      | undefined;
    const delta = (choice?.delta ?? {}) as Record<string, unknown>;
    if (typeof delta.content === "string") content += delta.content;
    if (typeof (delta as { reasoning_content?: string }).reasoning_content === "string") {
      reasoning += (delta as { reasoning_content: string }).reasoning_content;
    }
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls as Array<Record<string, unknown>>) {
        const idx = (tc.index as number) ?? 0;
        let acc = byIndex.get(idx);
        if (!acc) {
          acc = { id: tc.id, type: "function", function: { name: "", arguments: "" } };
          byIndex.set(idx, acc);
        }
        if (tc.id) acc.id = tc.id;
        const fn = (tc.function ?? {}) as Record<string, unknown>;
        if (typeof fn.name === "string") (acc.function as { name: string }).name += fn.name;
        if (typeof fn.arguments === "string") (acc.function as { arguments: string }).arguments += fn.arguments;
      }
    }
  }
  const msg: Record<string, unknown> = { role: "assistant", content: content || null };
  if (reasoning) msg.reasoning_content = reasoning;
  if (byIndex.size > 0) msg.tool_calls = [...byIndex.values()];
  return {
    id: "chatcmpl-fake",
    object: "chat.completion",
    created: 1,
    model: "fake",
    choices: [
      { index: 0, message: msg, finish_reason: finishReason ?? "stop", logprobs: null },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
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
          if (req.stream === false) {
            // 规划轮非流式：返回 ChatCompletion 形态对象
            return nonStreamingResponse(chunks);
          }
          return (async function* () {
            for (const c of chunks) yield c;
          })();
        },
      },
    },
  };
  return { client: client as never, requests };
}

/* ---------------- 场景数据 ---------------- */

const SYSTEM_PROMPT =
  "你是一个私人智能助理，负责陪伴式对话与生活/信息事务处理。你需要理解用户意图，" +
  "在需要外部信息时调用工具，日常闲聊时直接口语化回答。回答风格：短句、自然、不端着。" +
  "当前时间为 2026-08-26 晚上。用户位于上海。不要编造数据，工具结果优先。".repeat(6);

const HISTORY: ChatMessage[] = [
  { role: "user", content: "上次说好帮我盯着特斯拉的交付数据，出新的了吗".slice(0, 0) + "在吗" },
  {
    role: "assistant",
    content: "在的。上次聊到你想换车，重点关注 Model Y 的交付节奏和二手残值，我帮你记着呢。",
  },
  { role: "user", content: "嗯，最近还想看看它的股价走得怎么样" },
  {
    role: "assistant",
    content: "行，股价和交付数据一起看更全面。你要看的时候说一声，我拉最新数据给你。",
  },
];

const USER_TEXT = "帮我查一下特斯拉最新的交付数据和股价，顺便看看有没有相关图片";

const FINAL_ANSWER_NEW =
  "查到了。特斯拉 2026 年 Q2 交付 46.6 万辆（环比 +8%），股价 312.4 美元（+3.2%），" +
  "图片挑了两张官方交付现场的，都在上面。";

const RETRY_ANSWER =
  "刚才第一次查询超时了，我换了个源。特斯拉 2026 年 Q2 交付 46.6 万辆，股价 312.4 美元。";

function fakeTool(name: string, desc: string) {
  return {
    type: "function" as const,
    function: {
      name,
      description: desc,
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "查询关键词" },
          limit: { type: "number", description: "返回条数上限，默认 5" },
        },
        required: ["query"],
      },
    },
  };
}

// 6 个可见工具，描述体量接近真实场景（schema 是规划调用固定重发的成本）
const FAKE_TOOLS = [
  fakeTool(
    "bench_search",
    "联网搜索：输入查询词返回实时网页搜索结果（标题/摘要/链接），适合新闻、行情、事实核查类问题。".repeat(
      3,
    ),
  ),
  fakeTool(
    "bench_fetch",
    "网页正文抓取：给定 URL 抓取并清洗正文，返回纯文本内容，用于深读搜索结果中的具体页面。".repeat(
      3,
    ),
  ),
  fakeTool(
    "bench_images",
    "图片搜索：按关键词返回真实图片直链列表（最多 10 张），适合配图、看图类需求；禁止编造图片来源。".repeat(
      3,
    ),
  ),
  fakeTool(
    "bench_weather",
    "天气查询：按城市返回今明两天天气、气温与出行建议，数据来自气象聚合接口。".repeat(3),
  ),
  fakeTool(
    "bench_calendar",
    "日程管理：创建/查询/修改日程事件，支持自然语言时间解析（明天下午三点、下周五等）。".repeat(3),
  ),
  fakeTool(
    "bench_notes",
    "速记本：把用户口述的待办、灵感、购物清单落盘保存，支持追加与勾销。".repeat(3),
  ),
];

const TOOL_RESULT_TEXT =
  "特斯拉 2026 年第二季度共交付 466,140 辆汽车，高于市场预期的 44.8 万辆；其中 Model Y 贡献约 28.9 万辆。" +
  "上海超级工厂本季度出口 11.7 万辆，环比增长 12%。股价方面，TSLA 本周累计上涨 3.2%，收于 312.4 美元，" +
  "市盈率 58.4。分析师平均目标价 328 美元。Cybertruck 产能爬坡至每周 2,400 辆。能源存储业务装机 9.4 GWh 创新高。".repeat(
    2,
  );

function makeMessages(): ChatMessage[] {
  return [
    { role: "system", content: SYSTEM_PROMPT },
    ...HISTORY,
    { role: "user", content: USER_TEXT },
  ];
}

function makeCtx(opts?: { failAll?: boolean; failFirstN?: number }) {
  const executed: Array<{ name: string; args: Record<string, unknown> }> = [];
  return {
    ctx: {
      executeTool: async (name: string, args: Record<string, unknown>) => {
        executed.push({ name, args });
        if (opts?.failAll) {
          return { ok: false, result: { error: "工具执行失败 (upstream 500)" } };
        }
        if (opts?.failFirstN !== undefined && executed.length <= opts.failFirstN) {
          return { ok: false, result: { error: "工具执行失败 (upstream 500)" } };
        }
        return { ok: true, result: { content: TOOL_RESULT_TEXT, source: "mock" } };
      },
    },
    executed,
  };
}

function readAudit(sessionId: string) {
  const path = join(BENCH_DATA_DIR, "llm-token-audit.ndjson");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    // tool_result_compaction 是工具压缩遥测（非 LLM 调用，2026-09-17 WP0 引入），
    // 不计入 LLM 调用次数
    .filter((r) => r.sessionId === sessionId && r.stage !== "tool_result_compaction");
}

function sumTokens(recs: Array<Record<string, unknown>>) {
  const input = recs.reduce((s, r) => s + (r.inputTokens as number), 0);
  const output = recs.reduce((s, r) => s + (r.outputTokens as number), 0);
  const inputChars = recs.reduce((s, r) => s + (r.inputChars as number), 0);
  return { calls: recs.length, inputChars, inputTokens: input, outputTokens: output, totalTokens: input + output };
}

/* ---------------- 基准用例 ---------------- */

test("A. 并行规划 + 探测通过：2 次 LLM 调用，汇总不带 schema", async () => {
  resetLlmUsageAuditForTest();

  const { client, requests } = makeFakeClient([
    // wave 0（PLAN）：单批并行 3 个工具（信息 + 图片一次规划完）
    toolCallChunks([
      { id: "call_a1", name: "bench_search", args: { query: "特斯拉 2026 Q2 交付数据" } },
      { id: "call_a2", name: "bench_search", args: { query: "TSLA 股价 本周" } },
      { id: "call_a3", name: "bench_images", args: { query: "特斯拉 交付 现场" } },
    ]),
    // 充分性探测（SUMMARIZE，无 tools 参数）：最终回答
    textChunks(FINAL_ANSWER_NEW),
  ]);

  let streamed = "";
  const { ctx } = makeCtx();
  const out = await streamCompletionWithTools(
    client,
    "deepseek-chat",
    makeMessages() as never,
    (d: string) => {
      streamed += d;
    },
    ctx,
    {
      tools: FAKE_TOOLS as never,
      maxRounds: 4,
      audit: { sessionId: "bench-plan" },
    },
  );

  assert.ok(out.includes("46.6"), `最终回答应包含事实锚点，实际: ${out.slice(0, 80)}`);
  assert.equal(streamed, out, "汇总应完整流式推送给前端");
  const recs = readAudit("bench-plan");
  assert.equal(recs.length, 2, "应为 2 次 LLM 调用（规划 + 无 schema 汇总）");
  // 硬证据：第 2 次请求是汇总调用，请求体不带 tools（不重发 schema）
  assert.ok(requests.length >= 2, "至少发出 2 次请求");
  assert.ok(Array.isArray(requests[0].tools), "规划请求应携带工具 schema");
  assert.equal(requests[1].tools, undefined, "汇总调用请求体不应携带 tools schema");

  const agg = sumTokens(recs);
  // eslint-disable-next-line no-console
  console.log(`[BENCH-A] ${JSON.stringify(agg)} perCall=${JSON.stringify(recs.map((r) => r.inputTokens))}`);
});

test("B. 纯对话：无工具调用 → 1 次调用直接返回", async () => {
  resetLlmUsageAuditForTest();

  const { client, requests } = makeFakeClient([
    textChunks("在的，你说。"),
  ]);

  const { ctx, executed } = makeCtx();
  const out = await streamCompletionWithTools(
    client,
    "deepseek-chat",
    // 2026-09-05 出口自检统一后：纯对话文本（无外部信息/媒体诉求）直答 1 次即收尾；
    // 若用户文本含 查/搜/股价/图片 等诉求而模型零工具直答，会被出口自检续波拦截
    //（见 tool-loop-exit-arbiter.test.ts 场景 A/D）。
    [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: "在吗" },
    ] as never,
    () => {},
    ctx,
    { tools: FAKE_TOOLS as never, maxRounds: 4, audit: { sessionId: "bench-chat" } },
  );

  assert.equal(out, "在的，你说。");
  assert.equal(executed.length, 0, "不应执行任何工具");
  assert.equal(requests.length, 1, "纯对话应为 1 次 LLM 调用");
  assert.equal(readAudit("bench-chat").length, 1);
});

test("C. 失败确定性重试：首次失败自动重试 1 次成功 → 探测通过收尾", async () => {
  resetLlmUsageAuditForTest();

  const { client } = makeFakeClient([
    // wave 0（PLAN）
    toolCallChunks([{ id: "call_c1", name: "bench_search", args: { query: "特斯拉 交付" } }]),
    // 探测（重试成功后 allSucceeded → 无 schema 汇总）
    textChunks(RETRY_ANSWER),
  ]);

  const { ctx, executed } = makeCtx({ failFirstN: 1 });
  const out = await streamCompletionWithTools(
    client,
    "deepseek-chat",
    makeMessages() as never,
    () => {},
    ctx,
    { tools: FAKE_TOOLS as never, maxRounds: 4, audit: { sessionId: "bench-retry" } },
  );

  assert.ok(out.includes("46.6"), `重试成功后应给出答案，实际: ${out.slice(0, 80)}`);
  assert.equal(executed.length, 2, "失败应触发 1 次确定性重试（共 2 次执行）");
  const recs = readAudit("bench-retry");
  assert.equal(recs.length, 2, "应为 2 次 LLM 调用（规划 + 汇总）");
});

test("D. 持续失败 → replan 波次：带 schema 重规划，模型基于知识回答", async () => {
  resetLlmUsageAuditForTest();

  const { client, requests } = makeFakeClient([
    // wave 0（PLAN）：工具调用
    toolCallChunks([{ id: "call_d1", name: "bench_search", args: { query: "特斯拉 交付" } }]),
    // wave 1（REPLAN）：重试也失败 → 模型直接给出基于知识的回答
    textChunks(RETRY_ANSWER),
  ]);

  const { ctx, executed } = makeCtx({ failAll: true });
  const out = await streamCompletionWithTools(
    client,
    "deepseek-chat",
    makeMessages() as never,
    () => {},
    ctx,
    { tools: FAKE_TOOLS as never, maxRounds: 2, audit: { sessionId: "bench-fail" } },
  );

  assert.ok(out.includes("46.6"), `失败后模型应基于知识回答，实际: ${out.slice(0, 80)}`);
  // 2026-09-19 重试增强：非超时失败确定性重试至多 2 次（第二次 500ms 退避），
  // 持续失败 = 首次 + 2 次重试 = 3 次真实执行
  assert.equal(executed.length, 3, "失败重试 2 次仍失败（共 3 次执行，replan 不重复执行同参数工具）");
  const recs = readAudit("bench-fail");
  assert.equal(recs.length, 2, "失败路径 = 规划 + replan，共 2 次调用");
  // replan 是带 schema 的循环轮（历史增长 + schema 仍在）
  assert.ok(Array.isArray(requests[1].tools), "replan 请求应携带工具 schema");
  assert.ok(
    (recs[1].inputChars as number) > (recs[0].inputChars as number),
    "replan 输入应大于首轮（历史增长 + schema 仍在）",
  );

  // eslint-disable-next-line no-console
  console.log(`[BENCH-D] ${JSON.stringify(sumTokens(recs))}`);
});

test("E. 探测升级：NEED_MORE_TOOLS → replan 继续取数 → 最终汇总", async () => {
  resetLlmUsageAuditForTest();

  const { client, requests } = makeFakeClient([
    // wave 0（PLAN）：搜索
    toolCallChunks([{ id: "call_e1", name: "bench_search", args: { query: "特斯拉 Q2 交付" } }]),
    // 探测：结果不足
    textChunks("NEED_MORE_TOOLS\n还需要深读具体页面"),
    // wave 1（REPLAN）：继续 fetch 深读
    toolCallChunks([{ id: "call_e2", name: "bench_fetch", args: { query: "https://example.com/tsla" } }]),
    // 探测：通过 → 最终回答
    textChunks(FINAL_ANSWER_NEW),
  ]);

  let streamed = "";
  const { ctx, executed } = makeCtx();
  const out = await streamCompletionWithTools(
    client,
    "deepseek-chat",
    makeMessages() as never,
    (d: string) => {
      streamed += d;
    },
    ctx,
    { tools: FAKE_TOOLS as never, maxRounds: 4, audit: { sessionId: "bench-escalate" } },
  );

  assert.ok(out.includes("46.6"), `升级取数后应给出答案，实际: ${out.slice(0, 80)}`);
  assert.ok(!streamed.includes("NEED_MORE_TOOLS"), "升级标记不得透出到前端流");
  assert.equal(streamed, out, "最终回答应完整流式推送");
  assert.equal(executed.length, 2, "应执行 2 个工具（search + fetch）");
  const recs = readAudit("bench-escalate");
  assert.equal(recs.length, 4, "应为 4 次调用：规划 + 探测 + replan + 探测");
  assert.ok(Array.isArray(requests[0].tools), "规划请求带 schema");
  assert.equal(requests[1].tools, undefined, "探测请求不带 schema");
  assert.ok(Array.isArray(requests[2].tools), "replan 请求带 schema");
  assert.equal(requests[3].tools, undefined, "最终汇总请求不带 schema");
});

test("F. 轮内去重缓存：同工具+同参数的重复调用只真实执行 1 次", async () => {
  resetLlmUsageAuditForTest();

  const { client } = makeFakeClient([
    // wave 0（PLAN）：LLM 重复发了两个完全相同的调用
    toolCallChunks([
      { id: "call_f1", name: "bench_search", args: { query: "特斯拉 交付" } },
      { id: "call_f2", name: "bench_search", args: { query: "特斯拉 交付" } },
    ]),
    // 探测：通过
    textChunks(FINAL_ANSWER_NEW),
  ]);

  const { ctx, executed } = makeCtx();
  const out = await streamCompletionWithTools(
    client,
    "deepseek-chat",
    makeMessages() as never,
    () => {},
    ctx,
    { tools: FAKE_TOOLS as never, maxRounds: 4, audit: { sessionId: "bench-dedupe" } },
  );

  assert.ok(out.includes("46.6"));
  assert.equal(executed.length, 1, "重复的工具调用应命中轮内去重缓存，只真实执行 1 次");
});

test("G. fast 单波失败：兜底汇总已删除——不编答案，返回空", async () => {
  resetLlmUsageAuditForTest();

  const { client, requests } = makeFakeClient([
    // wave 0（PLAN，maxRounds=1 唯一波次）
    toolCallChunks([{ id: "call_g1", name: "bench_search", args: { query: "特斯拉 交付" } }]),
  ]);

  const { ctx, executed } = makeCtx({ failAll: true });
  const out = await streamCompletionWithTools(
    client,
    "deepseek-chat",
    makeMessages() as never,
    () => {},
    ctx,
    { tools: FAKE_TOOLS as never, maxRounds: 1, audit: { sessionId: "bench-fast-fail" } },
  );

  assert.equal(out, "", "失败后不再有兜底汇总，本轮不返回编造答案");
  assert.equal(executed.length, 3, "失败重试 2 次（共 3 次执行，含 500ms 退避重试）");
  const recs = readAudit("bench-fast-fail");
  assert.equal(recs.length, 1, "只有规划波 1 次调用，不再有兜底汇总");
  assert.equal(requests.length, 1, "不得再发起第二次无 schema 汇总调用");
});

/* ---------------- 质量保护闸（省 token 不牺牲质量） ---------------- */

test("H1. safeTruncateDigest：截断点落在 URL 中间时延伸到 URL 结束（防规划脑补 URL）", () => {
  // URL 恰好跨过 160 字符截断点：必须把 URL 补完整，不能丢下半截
  const long =
    "特斯拉交付数据:" +
    "https://example.com/reports/tesla-q2-2026/delivery?page=1&region=global&sort=desc" +
    "其余内容省略".repeat(50);
  const digest = safeTruncateDigest(long, 30);
  assert.ok(
    digest.includes("https://example.com/reports/tesla-q2-2026/delivery?page=1&region=global&sort=desc"),
    `URL 必须完整保留，实际: ${digest}`,
  );
  // 无 URL 时普通截断
  const plain = safeTruncateDigest("x".repeat(200), 50);
  assert.equal(plain.length, 51, "普通文本按 maxChars 截断 + 省略号");
  assert.equal(safeTruncateDigest("short", 100), "short", "短文本不截断");
});

test("H2. trimHistoryForSummary：指代早期对话时禁止裁剪（防引用丢失幻觉）", () => {
  const system = { role: "system", content: "sys" };
  const many: Array<{ role: string; content: string }> = [system];
  for (let i = 0; i < 12; i++) {
    many.push({ role: "user", content: `第${i}轮提问` });
    many.push({ role: "assistant", content: `第${i}轮回答` });
  }
  many.push({ role: "user", content: "刚才那个问题再深入一下" });

  // 带指代措辞 → 不裁剪，完整保留
  const guarded = trimHistoryForSummary(many as never, 4, "刚才那个问题再深入一下");
  assert.equal(guarded.length, many.length, "命中指代措辞时必须保留完整历史");
  assert.equal(guarded[0], system, "system 消息保留");

  // 无指代措辞 → 正常裁剪到最近 N 个用户回合 + 全部 system
  const trimmed = trimHistoryForSummary(many as never, 4, "帮我看下最新天气");
  const userCount = trimmed.filter((m) => m.role === "user").length;
  assert.equal(userCount, 4, "无指代时保留最近 4 个用户回合");
  assert.equal(trimmed[0], system, "裁剪后 system 仍置顶");
  assert.ok(trimmed.length < many.length, "确实发生了裁剪");

  // 短对话（低于阈值）→ 无操作
  const short = [system, { role: "user", content: "hi" }];
  assert.equal(trimHistoryForSummary(short as never, 4, "帮我看下最新天气").length, 2);
});

/* ---------------- 工具可见性路由（假搜索/串台防线的行为闸） ---------------- */

test("J. selectRelevantTools：搜索/记忆措辞召回对应工具，追问轮不召回长期记忆工具", () => {
  const all = [
    fakeTool("search_web", "联网搜索：输入查询词返回实时网页搜索结果，适合新闻、行情、事实核查。"),
    fakeTool("fetch_web", "网页正文抓取：给定 URL 抓取并清洗正文。"),
    fakeTool("brain.recall", "长期记忆检索：按语义检索历史对话记忆。"),
    fakeTool("brain.remember", "长期记忆写入：保存用户陈述的个人事实。"),
    fakeTool("clock.get_current_time", "获取当前时间。"),
    fakeTool("weather.get_local", "查询本地天气。"),
    fakeTool("wallet.get_balance", "查询钱包余额。"),
    fakeTool("schedule.create_task", "创建日程任务。"),
  ];
  const visibleNames = (text: string) =>
    selectRelevantTools(text, all as never).map(
      (t: { function: { name: string } }) => t.function.name,
    );

  // 1. 口语化搜索措辞 → search_web 必须可见（假搜索防线第一环）
  for (const text of ["帮我查查孙宇晨的八卦", "孙宇晨最近怎么样了", "吃个瓜，有什么爆料"]) {
    const visible = visibleNames(text);
    assert.ok(
      visible.includes("search_web"),
      `搜索措辞 "${text}" 必须召回 search_web，实际: ${visible.join(",")}`,
    );
  }

  // 2. 记忆措辞 → brain.recall 可见（记忆检索工具化：LLM 在 PLAN 阶段自主决定调用）
  for (const text of ["还记得我们上次聊的那个项目吗", "你上次提到的事我忘了"]) {
    const visible = visibleNames(text);
    assert.ok(
      visible.includes("brain.recall"),
      `记忆措辞 "${text}" 必须召回 brain.recall，实际: ${visible.join(",")}`,
    );
  }

  // 3. 任务追问轮 → 不召回 brain.recall（长期记忆不灌进任务轮，串台根治）
  for (const text of ["你确定？", "再帮我看看"]) {
    const visible = visibleNames(text);
    assert.ok(
      !visible.includes("brain.recall"),
      `追问 "${text}" 不得召回 brain.recall（防跨会话记忆串台），实际: ${visible.join(",")}`,
    );
  }
});

