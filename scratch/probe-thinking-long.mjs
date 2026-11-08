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
const NAMES = ["search_web","read_url","weather_query","calendar_list","calendar_create","reminder_create","note_save","memory_search","memory_write","profile_update","shopping_search","shopping_order","travel_plan","image_search","image_generate","file_read","file_write","shell_run","tool_discover","device_control","activity_timeline","picture_gallery","contact_lookup","mail_send","transport_route"];
const tools = NAMES.map((n) => ({ type: "function", function: { name: n, description: `NextBot capability ${n}. 当用户需要 ${n} 时调用。`, parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } } }));
const filler = "【记忆片段】用户偏好极简黑白界面；上次讨论到注册页 mockup 的 orb 高光位置；用户位于兴义市梦乐城附近；用户希望回复更像朋友、少客套。".repeat(120);
const SYSTEM = `你是 NEXTBOT（球球）。口语、短句、有温度。用「你」。不编造实时信息。闲聊轮不调用工具、不堆要点。\n${filler}\n当前时间：2026-11-05 17:30。`;
console.log("system chars =", SYSTEM.length, " tools =", tools.length);
async function run(name, extra) {
  const t0 = Date.now();
  let firstRaw = null, firstText = null, reasonChars = 0, textChars = 0, usage = null;
  const s = await client.chat.completions.create({ model: env.ZHIPU_MODEL ?? "glm-5.3-flash", messages: [{ role: "system", content: SYSTEM }, { role: "user", content: "好累呀 每天都要优化你 现在推广也推广不出去" }], stream: true, stream_options: { include_usage: true }, tools, ...extra });
  for await (const c of s) {
    if (c.usage) usage = c.usage;
    const d = c.choices?.[0]?.delta;
    if (!d) continue;
    if (d.reasoning_content) { if (firstRaw === null) firstRaw = Date.now() - t0; reasonChars += d.reasoning_content.length; }
    if (d.content) { if (firstRaw === null) firstRaw = Date.now() - t0; if (firstText === null) firstText = Date.now() - t0; textChars += d.content.length; }
  }
  console.log(`${name.padEnd(24)} firstRaw=${String(firstRaw).padStart(6)}ms firstText=${String(firstText).padStart(6)}ms total=${String(Date.now()-t0).padStart(6)}ms reasonChars=${String(reasonChars).padStart(5)} textChars=${String(textChars).padStart(4)} rtokens=${usage?.completion_tokens_details?.reasoning_tokens ?? "?"}`);
}
await run("longctx + effort=low", { reasoning_effort: "low" });
await run("longctx + effort=high", { reasoning_effort: "high" });
