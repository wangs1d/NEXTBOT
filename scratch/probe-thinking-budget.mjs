// 探针 4：验证三个假设
//  H1 思考预算(thinking.budget)是否可设上限
//  H2 工具面是否同时放大 prefill 和 reasoning 长度
//  H3 同一档位的方差有多大
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const OpenAI = require("../node_modules/openai/index.js");

const env = {};
for (const line of fs.readFileSync(path.resolve("server/.env.local"), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m) env[m[1]] = m[2];
}
const client = new OpenAI({
  apiKey: env.ZHIPU_API_KEY,
  baseURL: env.ZHIPU_BASE_URL ?? "https://open.bigmodel.cn/api/paas/v4",
  timeout: 180000,
  maxRetries: 0,
});
const MODEL = env.ZHIPU_MODEL ?? "glm-5.3-flash";

const NAMES = ["search_web","read_url","weather_query","calendar_list","calendar_create","reminder_create","note_save","memory_search","memory_write","profile_update","shopping_search","shopping_order","travel_plan","image_search","image_generate","file_read","file_write","shell_run","tool_discover","device_control","activity_timeline","picture_gallery","contact_lookup","mail_send","transport_route"];
const tools = NAMES.map((n) => ({ type: "function", function: { name: n, description: `NextBot capability ${n}. 用户需要 ${n} 时调用。`, parameters: { type: "object", properties: { query: { type: "string", description: "自然语言请求" } }, required: ["query"] } } }));

const SYSTEM = "你是 NEXTBOT（球球），住在用户桌面上的球形机器人。口语、短句、有温度，像朋友不像客服，用「你」。先接住情绪再给信息。闲聊不调用工具、不堆要点清单。当前时间 2026-11-05 17:40。";
const USER = "好累呀 每天都要优化你 现在推广也推广不出去";

async function run(label, { useTools, extra, maxTokens = 800 }) {
  const t0 = Date.now();
  let firstRaw = null, firstText = null, reasonChars = 0, text = "", usage = null;
  try {
    const s = await client.chat.completions.create({
      model: MODEL,
      messages: [{ role: "system", content: SYSTEM }, { role: "user", content: USER }],
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: maxTokens,
      ...(useTools ? { tools } : {}),
      ...extra,
    });
    for await (const c of s) {
      if (c.usage) usage = c.usage;
      const d = c.choices?.[0]?.delta;
      if (!d) continue;
      if (d.reasoning_content) { if (firstRaw === null) firstRaw = Date.now() - t0; reasonChars += d.reasoning_content.length; }
      if (d.content) { if (firstRaw === null) firstRaw = Date.now() - t0; if (firstText === null) firstText = Date.now() - t0; text += d.content; }
    }
    const rt = usage?.completion_tokens_details?.reasoning_tokens ?? "?";
    console.log(`\n[${label}] firstText=${firstText}ms total=${Date.now()-t0}ms rtokens=${rt} reasonChars=${reasonChars} textChars=${text.length}`);
    console.log(`   → ${text.replace(/\n/g, " ").slice(0, 130)}`);
  } catch (e) {
    console.log(`\n[${label}] ERROR ${e?.status ?? ""} ${String(e?.message).slice(0, 200)}`);
  }
}

console.log("=== H1: 思考预算能不能设上限 ===");
await run("budget_tokens=512 (thinking.enabled)", { useTools: false, extra: { thinking: { type: "enabled", budget_tokens: 512 } } });
await run("budget_tokens=1024", { useTools: false, extra: { thinking: { type: "enabled", budget_tokens: 1024 } } });

console.log("\n=== H2: 工具面对 reasoning 长度的影响（同 high 档） ===");
await run("no-tools  high #1", { useTools: false, extra: { reasoning_effort: "high" } });
await run("no-tools  high #2", { useTools: false, extra: { reasoning_effort: "high" } });
await run("25-tools  high #1", { useTools: true, extra: { reasoning_effort: "high" } });
await run("25-tools  high #2", { useTools: true, extra: { reasoning_effort: "high" } });

console.log("\n=== H3: 默认档（不传参数）的方差 ===");
await run("default #1", { useTools: false, extra: {} });
await run("default #2", { useTools: false, extra: {} });
await run("default #3", { useTools: false, extra: {} });
