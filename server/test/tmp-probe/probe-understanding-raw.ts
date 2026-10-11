/**
 * understanding 原始输出探针：直接调 classifyIntentByLlm 看路由 LLM 的
 * raw JSON 里有没有 understanding 字段。
 * 用法（server 目录）：node --import tsx test/tmp-probe/probe-understanding-raw.ts
 */
import "../../src/config/load-server-env.js";
import { createExternalChatProviderFromEnv } from "../../src/external-model/resolve-provider.js";
import { classifyIntentByLlm } from "../../src/agent/route-llm-call.js";

const CASES = ["你叫我什么？", "然后呢", "记住我下周三要开会", "帮我规划一个去成都的三日游"];

async function main(): Promise<void> {
  const mainProvider = createExternalChatProviderFromEnv();
  for (const text of CASES) {
    const call = await classifyIntentByLlm(mainProvider as never, "probe-understanding-raw", text);
    if (!call.ok) {
      console.log(`"${text}" → 调用失败 ${call.reason}\n`);
      continue;
    }
    console.log(`"${text}"\n  raw: ${call.raw}\n`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
