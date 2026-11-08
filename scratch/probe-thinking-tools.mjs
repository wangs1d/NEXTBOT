// 探针 2：模拟真实工具轮（长 system + 多工具），看 GLM 各 effort 档的思考开销
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

const TOOL_NAMES = [
  "search_web", "read_url", "weather.query", "calendar.list", "calendar.create",
  "reminder.create", "note.save", "memory.search", "memory.write", "profile.update",
  "shopping.search", "shopping.order", "travel.plan", "image.search", "image.generate",
  "file.read", "file.write", "shell.run", "tool_discover", "device.control",
];

const tools = TOOL_NAMES.map((n) => ({
  type: "function",
  function: {
    name: n.replace(/[.\-]/g, "_"),
    description: `NextBot capability: ${n}. Use when the user asks for ${n.replace(/[._]/g, " ")}.`,
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "natural language request" } },
      required: ["query"],
    },
  },
}));

// 约 2.5k 字的 system，模拟真实人设 + 记忆 + 协议层
const SYSTEM = `你是 NEXTBOT（小名「球球」），一个住在用户桌面上的球形机器人伙伴。
说话风格：口语、短句、有温度，像朋友而不是客服；不说「请多指教」这类客套话；用「你」不用「您」。
你不是搜索框：先接住情绪，再给信息和行动。
当前时间：2026-11-05 17:30（Asia/Shanghai）。
用户档案：男，贵州兴义，独立开发者，正在推进 NEXTBOT 桌面端；偏好极简黑白视觉；讨厌被敷衍。
禁止事项：不编造实时信息；不把内部思考过程说出口；不在闲聊轮堆砌要点清单。
渲染协议：闲聊轮不输出卡片标记；需要出卡片时使用约定标记。
工具使用：仅当用户需要外部事实或副作用动作时调用工具；闲聊轮不要调用任何工具。
` + "（协议说明占位，模拟真实 prefix 长度）".repeat(60);

const USER = "好累呀 每天都要优化你 现在推广也推广不出去";

const CASES = [
  { name: "tools + effort=low(现行)", extra: { reasoning_effort: "low" } },
  { name: "tools + 无参数(默认high)", extra: {} },
  { name: "tools + effort=high", extra: { reasoning_effort: "high" } },
  { name: "no-tools + effort=low", extra: { reasoning_effort: "low" }, tools: false },
];

async function run(c) {
  const t0 = Date.now();
  let firstRaw = null;
  let firstText = null;
  let reasonChars = 0;
  let textChars = 0;
  let usage = null;
  const stream = await client.chat.completions.create({
    model: env.ZHIPU_MODEL ?? "glm-5.3-flash",
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: USER },
    ],
    stream: true,
    stream_options: { include_usage: true },
    ...(c.tools === false ? {} : { tools }),
    ...c.extra,
  });
  for await (const chunk of stream) {
    if (chunk.usage) usage = chunk.usage;
    const d = chunk.choices?.[0]?.delta;
    if (!d) continue;
    if (d.reasoning_content) {
      if (firstRaw === null) firstRaw = Date.now() - t0;
      reasonChars += d.reasoning_content.length;
    }
    if (d.content) {
      if (firstRaw === null) firstRaw = Date.now() - t0;
      if (firstText === null) firstText = Date.now() - t0;
      textChars += d.content.length;
    }
  }
  console.log(
    `${c.name.padEnd(28)} firstRaw=${String(firstRaw).padStart(5)}ms firstText=${String(firstText).padStart(5)}ms total=${String(Date.now() - t0).padStart(5)}ms reasonChars=${String(reasonChars).padStart(5)} textChars=${String(textChars).padStart(4)} rtokens=${usage?.completion_tokens_details?.reasoning_tokens ?? "?"}`,
  );
}

for (const c of CASES) {
  try { await run(c); } catch (e) {
    console.log(`${c.name.padEnd(28)} ERROR ${e?.status ?? ""} ${String(e?.message).slice(0, 140)}`);
  }
}
