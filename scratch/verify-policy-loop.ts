// 端到端验证：拿档位 → 真实请求 → 写样本 → 再拿档位
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { zhipuThinkingExtras } from "../server/src/external-model/provider-profiles.js";
import { recordThinkingLatency, resolveThinkingEffort, snapshotThinkingStats, resetThinkingStatsForTest, effortSentFrom } from "../server/src/external-model/thinking-policy.js";

const require = createRequire(import.meta.url);
const OpenAI = require("../node_modules/openai/index.js");
const env: Record<string, string> = {};
for (const line of fs.readFileSync(path.resolve("server/.env.local"), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m) env[m[1]] = m[2];
}
const client = new OpenAI({ apiKey: env.ZHIPU_API_KEY, baseURL: env.ZHIPU_BASE_URL ?? "https://open.bigmodel.cn/api/paas/v4", timeout: 180000, maxRetries: 0 });
const MODEL = env.ZHIPU_MODEL ?? "glm-5.3-flash";

resetThinkingStatsForTest();
delete process.env.ZHIPU_REASONING_EFFORT;

const before = resolveThinkingEffort("zhipu", MODEL, { envOverride: "ZHIPU_REASONING_EFFORT", fallback: "high" });
const extra = zhipuThinkingExtras(MODEL, false);
console.log("① 解析档位:", JSON.stringify(before), "→ 实际下发:", JSON.stringify(extra));

const t0 = Date.now();
let firstText: number | null = null;
const s = await client.chat.completions.create({
  model: MODEL,
  messages: [{ role: "system", content: "你是 NEXTBOT（球球），口语、短句、有温度，用「你」。" }, { role: "user", content: "今天跑了一天，有点不想说话了" }],
  stream: true, ...extra,
});
for await (const c of s) {
  const d = c.choices?.[0]?.delta;
  if (d?.content && firstText === null) firstText = Date.now() - t0;
}
const ttft = firstText ?? Date.now() - t0;
console.log("② 真机首字:", ttft + "ms", "| 归档档位:", effortSentFrom(extra));

for (let i = 0; i < 3; i += 1) recordThinkingLatency({ providerId: "zhipu", model: MODEL, effortSent: effortSentFrom(extra), ttftMs: ttft });

const after = resolveThinkingEffort("zhipu", MODEL, { envOverride: "ZHIPU_REASONING_EFFORT", fallback: "high" });
console.log("③ 学习后再次解析:", JSON.stringify(after));
console.log("④ 统计快照:", JSON.stringify(snapshotThinkingStats(), null, 0));
