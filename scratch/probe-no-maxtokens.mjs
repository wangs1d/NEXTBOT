// 复测：不设 max_tokens，检验「显式 high vs 不传」的差异是否成立
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
const SYSTEM = "你是 NEXTBOT（球球），住在用户桌面上的球形机器人。口语、短句、有温度，像朋友不像客服，用「你」。先接住情绪再给信息。闲聊不调用工具、不堆要点清单。当前时间 2026-11-05 17:50。";
const USER = "好累呀 每天都要优化你 现在推广也推广不出去";
async function run(label, extra) {
  const t0 = Date.now();
  let firstText = null, text = "", reasonChars = 0, usage = null;
  try {
    const s = await client.chat.completions.create({
      model: MODEL,
      messages: [{ role: "system", content: SYSTEM }, { role: "user", content: USER }],
      stream: true, stream_options: { include_usage: true }, ...extra,
    });
    for await (const c of s) {
      if (c.usage) usage = c.usage;
      const d = c.choices?.[0]?.delta; if (!d) continue;
      if (d.reasoning_content) reasonChars += d.reasoning_content.length;
      if (d.content) { if (firstText === null) firstText = Date.now() - t0; text += d.content; }
    }
    console.log(`${label.padEnd(26)} firstText=${String(firstText).padStart(6)}ms total=${String(Date.now()-t0).padStart(6)}ms rtok=${String(usage?.completion_tokens_details?.reasoning_tokens ?? "?").padStart(4)} outTok=${usage?.completion_tokens ?? "?"} finish=${usage ? "" : "?"} text=${text.length}`);
  } catch (e) { console.log(`${label.padEnd(26)} ERROR ${e?.status ?? ""} ${String(e?.message).slice(0,150)}`); }
}
console.log("=== 无 max_tokens ===");
await run("explicit high #1", { reasoning_effort: "high" });
await run("explicit high #2", { reasoning_effort: "high" });
await run("default(auto) #1", {});
await run("default(auto) #2", {});
