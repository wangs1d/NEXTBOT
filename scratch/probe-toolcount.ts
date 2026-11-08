import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const OpenAI = require("../node_modules/openai/index.js");
const env: Record<string, string> = {};
for (const line of fs.readFileSync(path.resolve("server/.env.local"), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m) env[m[1]] = m[2];
}
const client = new OpenAI({ apiKey: env.ZHIPU_API_KEY, baseURL: env.ZHIPU_BASE_URL ?? "https://open.bigmodel.cn/api/paas/v4", timeout: 180000, maxRetries: 0 });
const MODEL = env.ZHIPU_MODEL ?? "glm-5.3-flash";
const mk = (n: string) => ({ type: "function", function: { name: n, description: `NextBot capability ${n}. 用户需要 ${n} 时调用。`, parameters: { type: "object", properties: { query: { type: "string", description: "自然语言请求" } }, required: ["query"] } } });
const SYSTEM = "你是 NEXTBOT（球球），住在用户桌面上的球形机器人。口语、短句、有温度，像朋友不像客服，用「你」。先接住情绪再给信息。闲聊不调用工具、不堆要点清单。当前时间 2026-11-05 18:00。";
const USER = "好累呀 每天都要优化你 现在推广也推广不出去";
async function run(n: number) {
  const tools = Array.from({ length: n }, (_, i) => mk("tool_" + i));
  const t0 = Date.now();
  let firstText: number | null = null, usage: any = null;
  const s = await client.chat.completions.create({ model: MODEL, messages: [{ role: "system", content: SYSTEM }, { role: "user", content: USER }], stream: true, stream_options: { include_usage: true }, ...(n ? { tools } : {}), reasoning_effort: "high" });
  for await (const c of s) {
    if (c.usage) usage = c.usage;
    const d = c.choices?.[0]?.delta;
    if (d?.content && firstText === null) firstText = Date.now() - t0;
  }
  return { firstText, cached: usage?.prompt_tokens_details?.cached_tokens ?? 0 };
}
for (const n of [0, 8, 17, 23, 25]) {
  const a = await run(n); const b = await run(n);
  const mid = [a.firstText, b.firstText].filter((x): x is number => typeof x === "number").sort((x, y) => x - y);
  console.log(`工具 ${String(n).padStart(2)} 个 → 首字中位 ${String(mid[0] ?? "-").padStart(5)}ms  (${a.firstText}/${b.firstText}, cached ${a.cached}/${b.cached})`);
}
