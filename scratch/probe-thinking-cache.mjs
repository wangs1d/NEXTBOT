// 探针 5：验证「显式 high vs 不传」的稳定性，以及 prefix cache 对工具面的敏感度
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
const client = new OpenAI({ apiKey: env.ZHIPU_API_KEY, baseURL: env.ZHIPU_BASE_URL ?? "https://open.bigmodel.cn/api/paas/v4", timeout: 180000, maxRetries: 0 });
const MODEL = env.ZHIPU_MODEL ?? "glm-5.3-flash";

const NAMES = ["search_web","read_url","weather_query","calendar_list","calendar_create","reminder_create","note_save","memory_search","memory_write","profile_update","shopping_search","shopping_order","travel_plan","image_search","image_generate","file_read","file_write","shell_run","tool_discover","device_control","activity_timeline","picture_gallery","contact_lookup","mail_send","transport_route"];
const mk = (n) => ({ type: "function", function: { name: n, description: `NextBot capability ${n}. 用户需要 ${n} 时调用。`, parameters: { type: "object", properties: { query: { type: "string", description: "自然语言请求" } }, required: ["query"] } } });
const TOOLS_25 = NAMES.map(mk);
const TOOLS_8 = NAMES.slice(0, 8).map(mk);

const SYSTEM = "你是 NEXTBOT（球球），住在用户桌面上的球形机器人。口语、短句、有温度，像朋友不像客服，用「你」。先接住情绪再给信息。闲聊不调用工具、不堆要点清单。当前时间 2026-11-05 17:40。";
const USER = "好累呀 每天都要优化你 现在推广也推广不出去";

async function run(label, { tools, extra, maxTokens = 800 }) {
  const t0 = Date.now();
  let firstText = null, reasonChars = 0, text = "", usage = null;
  try {
    const s = await client.chat.completions.create({
      model: MODEL,
      messages: [{ role: "system", content: SYSTEM }, { role: "user", content: USER }],
      stream: true, stream_options: { include_usage: true }, max_tokens: maxTokens,
      ...(tools ? { tools } : {}), ...extra,
    });
    for await (const c of s) {
      if (c.usage) usage = c.usage;
      const d = c.choices?.[0]?.delta; if (!d) continue;
      if (d.reasoning_content) reasonChars += d.reasoning_content.length;
      if (d.content) { if (firstText === null) firstText = Date.now() - t0; text += d.content; }
    }
    console.log(`${label.padEnd(30)} firstText=${String(firstText).padStart(6)}ms total=${String(Date.now()-t0).padStart(6)}ms rtok=${String(usage?.completion_tokens_details?.reasoning_tokens ?? "?").padStart(4)} cached=${usage?.prompt_tokens_details?.cached_tokens ?? "-"} text=${text.length}`);
  } catch (e) {
    console.log(`${label.padEnd(30)} ERROR ${e?.status ?? ""} ${String(e?.message).slice(0, 150)}`);
  }
}

console.log("=== 显式 high 稳定性（无工具）===");
for (let i = 1; i <= 3; i++) await run(`explicit high #${i}`, { extra: { reasoning_effort: "high" } });

console.log("\n=== 不传 effort（线上现状）===");
for (let i = 1; i <= 2; i++) await run(`default(auto) #${i}`, { extra: {} });

console.log("\n=== 工具面规模 × cache 命中（全 high）===");
for (let i = 1; i <= 3; i++) await run(`tools=25 #${i} (same set)`, { tools: TOOLS_25, extra: { reasoning_effort: "high" } });
for (let i = 1; i <= 2; i++) await run(`tools=8  #${i}`, { tools: TOOLS_8, extra: { reasoning_effort: "high" } });
await run(`tools=0  (baseline)`, { extra: { reasoning_effort: "high" } });
