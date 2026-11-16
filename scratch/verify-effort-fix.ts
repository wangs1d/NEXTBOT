// 验证：修复后的 zhipuThinkingExtras 在真实请求上的首字差异
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { zhipuThinkingExtras } from "../server/src/external-model/provider-profiles.js";

const require = createRequire(import.meta.url);
const OpenAI = require("../node_modules/openai/index.js");
const env: Record<string, string> = {};
for (const line of fs.readFileSync(path.resolve("server/.env.local"), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m) env[m[1]] = m[2];
}
const client = new OpenAI({ apiKey: env.ZHIPU_API_KEY, baseURL: env.ZHIPU_BASE_URL ?? "https://open.bigmodel.cn/api/paas/v4", timeout: 180000, maxRetries: 0 });
const MODEL = env.ZHIPU_MODEL ?? "glm-5.3-flash";
const SYSTEM = "你是 NEXTBOT（球球），住在用户桌面上的球形机器人。口语、短句、有温度，像朋友不像客服，用「你」。先接住情绪再给信息。闲聊不调用工具。";
const USER = "好累呀 每天都要优化你 现在推广也推广不出去";

delete process.env.ZHIPU_REASONING_EFFORT;
const fixed = zhipuThinkingExtras(MODEL, false);
const legacy = {}; // 修复前的行为：思考开启时下发空对象
console.log("修复后下发的参数:", JSON.stringify(fixed), "| 修复前:", JSON.stringify(legacy), "\n");

async function run(label: string, extra: Record<string, unknown>) {
  const t0 = Date.now();
  let firstText: number | null = null, usage: any = null, text = "";
  const s = await client.chat.completions.create({
    model: MODEL,
    messages: [{ role: "system", content: SYSTEM }, { role: "user", content: USER }],
    stream: true, stream_options: { include_usage: true }, ...extra,
  });
  for await (const c of s) {
    if (c.usage) usage = c.usage;
    const d = c.choices?.[0]?.delta;
    if (d?.content) { if (firstText === null) firstText = Date.now() - t0; text += d.content; }
  }
  console.log(`${label.padEnd(12)} firstText=${String(firstText).padStart(6)}ms total=${String(Date.now()-t0).padStart(6)}ms rtok=${String(usage?.completion_tokens_details?.reasoning_tokens ?? "?").padStart(4)} text=${text.length}`);
}

for (const [label, extra] of [["修复前({})", legacy], ["修复后(high)", fixed], ["修复前({})", legacy], ["修复后(high)", fixed]] as const) {
  await run(label, extra);
}
