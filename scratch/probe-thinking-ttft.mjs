// 一次性探针：测量思考型模型的 TTFT / 思考开销（不写入项目）
// 用法: node scratch/probe-thinking-ttft.mjs
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const OpenAI = require("../node_modules/openai/index.js");

const envPath = path.resolve("server/.env.local");
const env = {};
for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m) env[m[1]] = m[2];
}

const client = new OpenAI({
  apiKey: env.ZHIPU_API_KEY,
  baseURL: env.ZHIPU_BASE_URL ?? "https://open.bigmodel.cn/api/paas/v4",
  timeout: 120000,
  maxRetries: 0,
});

const MODEL = env.ZHIPU_MODEL ?? "glm-5.3-flash";

const PROMPT = "用户说：今天有点累，不想做饭了。用一句话回他，口语一点。";

const CASES = [
  { name: "effort=low (现行默认)", extra: { reasoning_effort: "low" } },
  { name: "无参数 (服务端默认 high)", extra: {} },
  { name: "thinking.enabled effort=low", extra: { thinking: { type: "enabled", effort: "low" } } },
  { name: "effort=high", extra: { reasoning_effort: "high" } },
];

async function run(c) {
  const t0 = Date.now();
  let firstText = null;
  let firstAny = null;
  let reasonChars = 0;
  let textChars = 0;
  let usage = null;
  const stream = await client.chat.completions.create({
    model: MODEL,
    messages: [{ role: "user", content: PROMPT }],
    stream: true,
    stream_options: { include_usage: true },
    ...c.extra,
  });
  for await (const chunk of stream) {
    const d = chunk.choices?.[0]?.delta;
    if (chunk.usage) usage = chunk.usage;
    if (!d) continue;
    if (d.reasoning_content) {
      if (firstAny === null) firstAny = Date.now() - t0;
      reasonChars += d.reasoning_content.length;
    }
    if (d.content) {
      if (firstText === null) firstText = Date.now() - t0;
      if (firstAny === null) firstAny = Date.now() - t0;
      textChars += d.content.length;
    }
  }
  const total = Date.now() - t0;
  console.log(
    `${c.name.padEnd(30)} firstAny=${String(firstAny).padStart(5)}ms firstText=${String(firstText).padStart(5)}ms total=${String(total).padStart(5)}ms reasonChars=${reasonChars} textChars=${textChars} usage=${JSON.stringify(usage?.completion_tokens_details ?? null)}`,
  );
}

for (const c of CASES) {
  try {
    await run(c);
  } catch (e) {
    console.log(`${c.name.padEnd(30)} ERROR ${e?.status ?? ""} ${String(e?.message).slice(0, 160)}`);
  }
}
