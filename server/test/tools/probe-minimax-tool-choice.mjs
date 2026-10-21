import OpenAI from "openai";
import dotenv from "dotenv";
import { fileURLToPath } from "node:url";

dotenv.config({ path: new URL("../../.env", import.meta.url) });
dotenv.config({ path: new URL("../../.env.local", import.meta.url), override: true });

const client = new OpenAI({
  apiKey: process.env.MINIMAX_API_KEY,
  baseURL: (process.env.MINIMAX_BASE_URL ?? "https://api.minimaxi.com/v1").trim(),
  timeout: 120000,
  maxRetries: 0,
});
const model = (process.env.MINIMAX_MODEL ?? "MiniMax-M3").trim();

const tools = [
  {
    type: "function",
    function: {
      name: "search_images",
      description: "搜索图片",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "weather_get_local",
      description: "天气",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
];

async function run(label, toolChoice) {
  const t0 = Date.now();
  try {
    const r = await client.chat.completions.create({
      model,
      messages: [{ role: "user", content: "帮我搜索成龙最近的照片" }],
      tools,
      tool_choice: toolChoice,
      max_tokens: 256,
    });
    console.log(
      `[${label}] ${Date.now() - t0}ms finish=${r.choices?.[0]?.finish_reason} ` +
        `tool_calls=${JSON.stringify(r.choices?.[0]?.message?.tool_calls?.map((c) => c.function?.name) ?? [])} ` +
        `content=${(r.choices?.[0]?.message?.content ?? "").slice(0, 60)}`,
    );
  } catch (e) {
    console.log(`[${label}] ${Date.now() - t0}ms ERROR status=${e?.status} msg=${String(e?.message).slice(0, 220)}`);
  }
}

await run("required", "required");
await run("specific", { type: "function", function: { name: "search_images" } });
await run("auto", "auto");
console.log("file:", fileURLToPath(import.meta.url));
