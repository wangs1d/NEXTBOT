/**
 * 出口闸行为测试（2026-10-22 v3 架构：决策权归模型，服务端只核对账目）。
 *
 * 架构背景：
 *   - 请求层恒 tool_choice="auto"：全项目不再存在任何非 auto 的 tool_choice
 *     （required / 具名工具均已删除，续波也不收紧请求）；
 *   - 判定权归模型：**不再**用「话题词表 + 完成态措辞」反推「该不该调工具」。
 *     原 no_attempt_but_claimed 双词面闸已删除——它把决策权从模型手里抢走，
 *     且靠固定文案匹配（「已经…了」）误伤面大；
 *   - 出口只核对两类**服务端事实**：
 *     ① queued_without_content：本轮只完成了派发（produces:"queued"），
 *        没有任何 content 类结果 → 报状态续波一次（派发 ≠ 完成）；
 *     ② explicit_action_no_attempt：显式外部动作（打电话/报位置）整轮没有
 *        对应工具的执行记录 → 报事实续波一次并点名工具。
 *   - 误判代价 = 一次可逆 round trip；两次都不调则放行，宁可如实说没办。
 *
 * 用 mock LLM client（脚本化 chunk 流）+ 真实 executeTool 执行器驱动，
 * 运行在生产默认的静态架构（AGENT_TOOL_ARCH=static）上。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatCompletionTool } from "openai/resources/chat/completions";

const BENCH_DATA_DIR = mkdtempSync(join(tmpdir(), "tool-loop-claim-gate-"));
process.env.PA_DATA_DIR = BENCH_DATA_DIR;
process.env.AGENT_TOOL_ARCH = "static";
process.env.AGENT_TOKENJUICE_ENABLED = "0";

const { streamCompletionWithTools } = await import(
  "../src/external-model/openai-compatible-tool-loop.js"
);

/* ---------------- mock LLM client（脚本化 chunk 流） ---------------- */

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

/* ---------------- 场景数据 ---------------- */

function tool(name: string, desc: string): ChatCompletionTool {
  return {
    type: "function",
    function: {
      name,
      description: desc,
      parameters: {
        type: "object",
        properties: { text: { type: "string" }, query: { type: "string" } },
      },
    },
  };
}

const TOOLS: ChatCompletionTool[] = [
  tool("message.send", "给指定联系人发送文字消息"),
  tool("search_web", "联网搜索公开网页信息（标题/摘要/链接）"),
  tool("phone.call_user", "拨打语音电话给指定联系人"),
  tool("task.dispatch", "把需要后台长时间跑的复杂任务派出去（只排队，不产出结果）"),
];

function makeMessages(userText: string) {
  return [
    { role: "system", content: "你是用户的私人助理，回答风格短句口语化。" },
    { role: "user", content: userText },
  ];
}

function makeCtx(results?: Record<string, Record<string, unknown>>) {
  const executed: Array<{ name: string; args: Record<string, unknown>; ok: boolean }> = [];
  return {
    ctx: {
      executeTool: async (name: string, args: Record<string, unknown>) => {
        executed.push({ name, args, ok: true });
        return { ok: true, result: results?.[name] ?? { delivered: true, items: [] } };
      },
    },
    executed,
  };
}

/* ---------------- A. 词面闸已删：零工具直答不被打回（能力收敛，如实记录） ---------------- */

test("A. 零工具直答「已经发给妈妈了」→ 单次 auto 收尾，不再有措辞闸", async () => {
  // 2026-10-22 有意的能力收敛：原 no_attempt_but_claimed 需要「话题词表 +
  // 完成态措辞」双词面条件命中，误伤面大且等于用固定文案反推意图，已删除。
  // 这条能力的兜底不是本闸，而是：①prompt 的诚实约束（没调工具不许说已办）；
  // ②显式外部动作仍走事实型闸（见 E）；③agent-core 的 TurnOutcomeGate 照常。
  const { client, requests } = makeFakeClient([textChunks("好的，已经帮你发给妈妈了，让她放心。")]);

  const { ctx, executed } = makeCtx();
  const out = await streamCompletionWithTools(
    client,
    "deepseek-chat",
    makeMessages("给妈妈发消息说我马上到家") as never,
    () => {},
    ctx,
    { tools: TOOLS as never, maxRounds: 4, audit: { sessionId: "claim-gate-a" } } as never,
  );

  assert.equal(requests.length, 1, `不得因措辞续波，实际 ${requests.length} 次调用`);
  assert.equal(requests[0].tool_choice ?? "auto", "auto", "全流程 tool_choice 必须是 auto");
  assert.equal(executed.length, 0, "不得替模型补调工具");
  assert.ok(out.includes("妈妈"), `应原样交付模型回复，实际: ${out.slice(0, 60)}`);
});

/* ---------------- B. 该闲聊闲聊：非祈使闲聊轮 auto 单次收尾 ---------------- */

test("B. 「这首歌讲的是什么啊」→ auto 单次收尾（无祈使结构，请求层不扳机）", async () => {
  const { client, requests } = makeFakeClient([
    textChunks("这首歌讲的是离别，旋律一起就想起毕业那年。"),
  ]);

  const { ctx, executed } = makeCtx();
  const out = await streamCompletionWithTools(
    client,
    "deepseek-chat",
    makeMessages("这首歌讲的是什么啊") as never,
    () => {},
    ctx,
    { tools: TOOLS as never, maxRounds: 4, audit: { sessionId: "claim-gate-b" } } as never,
  );

  assert.equal(requests.length, 1, `应单次调用收尾，实际 ${requests.length} 次调用`);
  assert.equal(requests[0].tool_choice, "auto", "非祈使闲聊轮不得被请求层扳机");
  assert.equal(executed.length, 0, "闲聊轮不应执行任何工具");
  assert.ok(out.includes("离别"), `应返回正常回答，实际: ${out.slice(0, 60)}`);
});

/* ---------------- B2. 对账闸精度：有办事信号但无宣称词面 → 不误报续波 ---------------- */

test("B2. 办事信号轮零工具但回复无宣称词面 → 不续波（对账闸只抓违约事实）", async () => {
  // 请求层恒 auto（模型自决，mock 直答不调工具）。
  // 对账闸条件之一（宣称词面）不满足 → 不得续波——这是它零误报的边界。
  const { client, requests } = makeFakeClient([
    textChunks("新闻这事我知道的不多，不敢跟你瞎编。"),
  ]);

  const { ctx, executed } = makeCtx();
  await streamCompletionWithTools(
    client,
    "deepseek-chat",
    makeMessages("帮我查查最新的新闻") as never,
    () => {},
    ctx,
    { tools: TOOLS as never, maxRounds: 4, audit: { sessionId: "claim-gate-b2" } } as never,
  );

  assert.equal(requests[0].tool_choice, "auto", "请求层恒 auto，不做事前预判");
  assert.equal(requests.length, 1, `无宣称词面不得续波，实际 ${requests.length} 次调用`);
  assert.equal(executed.length, 0, "不得执行任何工具");
});

/* ---------------- C. 词面闸已删：搜索宣称不被打回（与 A 同一条收敛） ---------------- */

test("C. 零工具直答「搜了一圈」→ 单次 auto 收尾，不再有措辞闸", async () => {
  const { client, requests } = makeFakeClient([textChunks("我搜了一圈，最近没什么新消息。")]);

  const { ctx, executed } = makeCtx();
  await streamCompletionWithTools(
    client,
    "deepseek-chat",
    makeMessages("帮我查查成龙最近的新闻") as never,
    () => {},
    ctx,
    { tools: TOOLS as never, maxRounds: 4, audit: { sessionId: "claim-gate-c" } } as never,
  );

  assert.equal(requests.length, 1, `不得因措辞续波，实际 ${requests.length} 次调用`);
  assert.equal(requests[0].tool_choice ?? "auto", "auto", "全流程 tool_choice 必须是 auto");
  assert.equal(executed.length, 0, "不得替模型补调工具");
});

/* ---------------- D. 闲聊轮不被误伤 ---------------- */

test("D. 闲聊轮含「已经定了」但无办事信号 → 不续波（词面必须配事实对账）", async () => {
  const { client, requests } = makeFakeClient([
    textChunks("定了，三百块。"),
  ]);

  const { ctx, executed } = makeCtx();
  await streamCompletionWithTools(
    client,
    "deepseek-chat",
    makeMessages("哈哈这个价格已经定了吗") as never,
    () => {},
    ctx,
    { tools: TOOLS as never, maxRounds: 4, audit: { sessionId: "claim-gate-d" } } as never,
  );

  assert.equal(requests.length, 1, `无办事怀疑信号不得续波，实际 ${requests.length} 次调用`);
  assert.equal(executed.length, 0, "闲聊轮不应执行任何工具");
});

/* ---------------- E. 显式动作未执行 → required 续波并指名工具 ---------------- */

test("E. 「给老婆打个电话」零工具（回复也不宣称办过）→ 显式动作对账续波真执行", async () => {
  // 这是事前指定门退役后的等价保证：模型在 auto 下没打、回复也避开了
  // 「已经…」式宣称（"一会儿给她打过去"），对账闸仍靠服务端执行记录抓住它。
  const { client, requests } = makeFakeClient([
    textChunks("好，那我一会儿给她打过去。"),
    toolCallChunks([{ id: "call_e1", name: "phone.call_user", args: { contact: "老婆" } }]),
    textChunks("电话已经拨出去了，她那边在响。"),
  ]);

  const { ctx, executed } = makeCtx();
  const out = await streamCompletionWithTools(
    client,
    "deepseek-chat",
    makeMessages("帮我给老婆打个电话") as never,
    () => {},
    ctx,
    { tools: TOOLS as never, maxRounds: 4, audit: { sessionId: "claim-gate-e" } } as never,
  );

  assert.equal(requests[0].tool_choice, "auto", "请求层不再指定具体工具");
  assert.equal(
    requests[1]?.tool_choice ?? "auto",
    "auto",
    "续波也不收紧请求（required 已删除），靠 system 指令点名工具",
  );
  assert.equal(
    executed.some((e) => e.name === "phone.call_user" && e.ok),
    true,
    `续波后应真实执行 phone.call_user，实际: ${JSON.stringify(executed)}`,
  );
  const injected = requests.some((r) =>
    JSON.stringify(r.messages ?? []).includes("phone.call_user"),
  );
  assert.ok(injected, "续波指令应指名 phone.call_user");
  assert.ok(out.includes("拨出去"), `应返回基于真实执行的收尾，实际: ${out.slice(0, 60)}`);
});

/* ---------------- F. 派发 ≠ 完成：queued 不算结果，续波后真查 ---------------- */

test("F. 只调 task.dispatch 就收尾 → 完成度闸判 queued 无内容，续波后真实查询", async () => {
  // 这是 2026-10-22 完成语义契约的核心场景（search_movies 的历史失败形态）：
  // 模型把活派给后台并回「已经让后台去查了」。服务端账目里只有若干 queued
  // 记录、没有任何 content 结果 → 出口报状态续波一次（不收紧 tool_choice）。
  // 注意：闸只报事实（"还没有拿到能回答用户的内容"），不下命令，
  // 「当场查完」与「如实说稍后才有」都是合法出口。
  const { client, requests } = makeFakeClient([
    toolCallChunks([{ id: "call_f1", name: "task.dispatch", args: { goal: "查最近值得看的新电影" } }]),
    textChunks("已经让后台去查了，稍后告诉你。"),
    toolCallChunks([{ id: "call_f2", name: "search_web", args: { query: "近期 新电影 推荐" } }]),
    textChunks("查到了，这周上映的这几部值得看。"),
  ]);

  const { ctx, executed } = makeCtx({
    "task.dispatch": { produces: "queued", taskId: "task-1", summary: "已排队" },
    search_web: { results: [{ title: "新片速览", url: "https://example.com/a" }] },
  });
  const out = await streamCompletionWithTools(
    client,
    "deepseek-chat",
    makeMessages("帮我查一下最近有什么值得看的新电影") as never,
    () => {},
    ctx,
    { tools: TOOLS as never, maxRounds: 6, audit: { sessionId: "claim-gate-f" } } as never,
  );
  assert.ok(requests.length >= 3, `应至少续波一次，实际 ${requests.length} 次调用`);
  for (const [i, r] of requests.entries()) {
    assert.equal(r.tool_choice ?? "auto", "auto", `第 ${i} 波 tool_choice 必须仍是 auto`);
  }
  assert.equal(
    executed.some((e) => e.name === "task.dispatch"),
    true,
    `应先派发，实际: ${JSON.stringify(executed.map((e) => e.name))}`,
  );
  assert.equal(
    executed.some((e) => e.name === "search_web"),
    true,
    `续波后应真实查询，实际: ${JSON.stringify(executed.map((e) => e.name))}`,
  );
  const injected = requests.some((r) => JSON.stringify(r.messages ?? []).includes("只完成了派发"));
  assert.ok(injected, "续波前应注入「只完成了派发」的状态说明");
  assert.ok(out.includes("查到了"), `应返回基于真实查询的收尾，实际: ${out.slice(0, 60)}`);
});
