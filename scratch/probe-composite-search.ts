/**
 * 复合工具回归探针（手动运行）：npx tsx scratch/probe-composite-search.ts
 *
 * ① 直接过复合层执行 web_search / web_fetch 各 action（含别名与缺省 action）；
 * ② 真实模型 E2E：getBuiltinAgentChatTools() 全量工具面 + streamCompletionWithTools，
 *    看模型实际调什么工具、复合层是否把 action 正确分流到 AnySearch 链路。
 */
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(here, "../../.env") });
dotenv.config({ path: path.join(here, "../.env"), override: true });
dotenv.config({ path: path.join(here, "../.env.local"), override: true });

const { ToolRegistry } = await import("../server/src/tools/tool-registry.js");
const { registerWebTools } = await import("../server/src/tools/web-tools.js");
const { registerClockTools } = await import("../server/src/tools/clock-tools.js");
const { registerCompositeTools, resolveEffectiveToolName } = await import(
  "../server/src/external-model/composite-chat-tools.js"
);
const { InfoHubService } = await import("../server/src/services/info-hub-service.js");
const { UpstreamSearchService } = await import("../server/src/services/upstream-search-service.js");
const { streamCompletionWithTools, getBuiltinAgentChatTools } = await import(
  "../server/src/external-model/openai-compatible-tool-loop.js"
);
const OpenAI = (await import("openai")).default;

const registry = new ToolRegistry();
const infoHub = new InfoHubService();
const upstreamSearch = new UpstreamSearchService(infoHub);
registerWebTools(registry, infoHub, upstreamSearch);
registerClockTools(registry);
registerCompositeTools(registry);

const ctx = { sessionId: "probe-composite" };

function show(label: string, r: { ok: boolean; result: unknown }) {
  const res = (r.result ?? {}) as Record<string, unknown>;
  const items = (res.items ?? res.results ?? []) as Array<Record<string, unknown>>;
  const keys = Object.keys(res).slice(0, 10).join(",");
  const first = items[0]
    ? `首条: ${String(res.items ? items[0].title : items[0].text ?? items[0].url ?? "").slice(0, 60)}`
    : `keys=[${keys}] error=${String(res.error ?? "").slice(0, 120)}`;
  console.log(`${r.ok ? "✔" : "✖"} ${label} | ok=${r.ok} items=${items.length} | ${first}`);
}

console.log("════ ① 复合层直调（web_search 各 action 形态）════");
show("action=web 正常", await registry.execute("web_search", { action: "web", query: "刘浩存 最新消息", limit: 5 }, ctx));
show("无 action（缺省）", await registry.execute("web_search", { query: "今天 国际 新闻", limit: 5 }, ctx));
show("action=旧名 search_web（别名）", await registry.execute("web_search", { action: "search_web", query: "人工智能 新闻", limit: 5 }, ctx));
show("action=web_search（疑似模型误填）", await registry.execute("web_search", { action: "web_search", query: "测试", limit: 3 }, ctx));
show("action=search（疑似模型误填）", await registry.execute("web_search", { action: "search", query: "测试", limit: 3 }, ctx));
show("action=hot 热搜", await registry.execute("web_search", { action: "hot" }, ctx));
show("action=deep 深读", await registry.execute("web_search", { action: "deep", query: "最近 新能源 汽车 行业 动态" }, ctx));

console.log("\n════ ② web_fetch 复合层 ════");
show("action=read 缺省", await registry.execute("web_fetch", { url: "https://example.com" }, ctx));

console.log("\n════ ③ effectiveTool 解析 ════");
for (const [name, args] of [
  ["web_search", { action: "web", query: "x" }],
  ["web_search", { action: "images", query: "x" }],
  ["web_search", { query: "x" }],
  ["web_fetch", { action: "raw", url: "x" }],
] as Array<[string, Record<string, unknown>]>) {
  console.log(`${name} ${JSON.stringify(args)} → ${resolveEffectiveToolName(name, args)}`);
}

console.log("\n════ ④ 真实模型 E2E（全量 builtin 工具面）════");
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, baseURL: process.env.OPENAI_BASE_URL });
const model = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
console.log(`model=${model} provider=${process.env.EXTERNAL_MODEL_PROVIDER ?? "?"}`);

async function e2e(userText: string) {
  const executed: Array<{ name: string; ok: boolean; effective?: string; err?: string }> = [];
  const loopCtx = {
    executeTool: async (name: string, args: Record<string, unknown>) => {
      const r = await registry.execute(name, args, ctx);
      const res = (r.result ?? {}) as Record<string, unknown>;
      executed.push({
        name,
        ok: r.ok,
        effective: resolveEffectiveToolName(name, args),
        err: r.ok ? undefined : String(res.error ?? "").slice(0, 120),
      });
      return r;
    },
  };
  const out = await streamCompletionWithTools(
    client,
    model,
    [
      { role: "system", content: "你是用户的私人助理。涉及时事/新闻/近况必须先联网检索再回答。" },
      { role: "user", content: userText },
    ],
    () => {},
    loopCtx,
    { tools: getBuiltinAgentChatTools(), maxRounds: 3, audit: { sessionId: "probe-composite" } },
  );
  console.log(`\n── "${userText}"`);
  for (const e of executed) {
    console.log(`   调用 ${e.name} → effective=${e.effective} ok=${e.ok}${e.err ? ` err=${e.err}` : ""}`);
  }
  if (executed.length === 0) console.log("   （模型没有调用任何工具）");
  console.log(`   回答摘要: ${out.replace(/\s+/g, " ").slice(0, 200)}`);
  return executed;
}

await e2e("今天国内有什么大新闻？帮我搜一下");
await e2e("刘浩存最近有什么新动态");
