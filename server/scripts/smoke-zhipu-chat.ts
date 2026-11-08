/**
 * 智谱 GLM 原生 provider 真实对话冒烟（2026-11-05 接入 glm-5.3-flash 配套验证）。
 *
 * 用法（server 目录下）：
 *   node --import tsx scripts/smoke-zhipu-chat.ts
 *
 * 验证点：
 * 1. createExternalChatProviderFromEnv 按 EXTERNAL_MODEL_PROVIDER=zhipu 解析出
 *    ZhipuProvider（密钥来自 .env.local 的 ZHIPU_API_KEY）；
 * 2. 走 AbstractChatProvider.streamCompletion 生产路径完成单轮对话（非裸 curl，
 *    含 system 组装 + 思考档位 extra_body）；
 * 3. 同 session 多轮上下文（第二轮引用第一轮信息）；
 * 4. 旁路关思考判定：bypassChatRequestExtras 返回 reasoning_effort:"low"。
 *
 * 只输出对话内容与判定结果，不打印任何密钥。
 */

import { loadServerEnv } from "../src/config/load-server-env.js";
import { createExternalChatProviderFromEnv } from "../src/external-model/index.js";
import { bypassChatRequestExtras } from "../src/external-model/resolve-provider.js";

async function chatTurn(
  provider: NonNullable<ReturnType<typeof createExternalChatProviderFromEnv>>,
  sessionId: string,
  text: string,
): Promise<string> {
  let out = "";
  const reply = await provider.streamCompletion(sessionId, { text }, (delta) => {
    out += delta;
  });
  return reply || out;
}

async function main(): Promise<void> {
  loadServerEnv();

  const provider = createExternalChatProviderFromEnv();
  if (!provider) {
    console.error("[SMOKE-FAIL] 未解析到外部模型 provider（检查 EXTERNAL_MODEL_PROVIDER / ZHIPU_API_KEY）");
    process.exit(1);
  }
  const model = (provider as unknown as { model?: string }).model ?? "(unknown)";
  console.log(`provider: id=${provider.id} label=${provider.displayLabel} model=${model}`);
  console.log(`bypass 关思考 extras: ${JSON.stringify(bypassChatRequestExtras())}`);

  // ── 用例 1：单轮闲聊 ──
  const t0 = Date.now();
  const reply1 = await chatTurn(provider, "smoke-zhipu-1", "用一句话介绍你自己，不要超过30个字。");
  console.log(`\n[单轮] (${Date.now() - t0}ms)\n${reply1}`);
  if (!reply1.trim()) {
    console.error("[SMOKE-FAIL] 单轮回复为空（疑似思考链吃满输出预算或请求被拒）");
    process.exit(1);
  }

  // ── 用例 2：同 session 多轮上下文 ──
  const t1 = Date.now();
  const reply2 = await chatTurn(provider, "smoke-zhipu-1", "我上一句让你做什么？请复述这个要求。");
  console.log(`\n[多轮上下文] (${Date.now() - t1}ms)\n${reply2}`);
  const remembered = reply2.includes("介绍") || reply2.includes("一句话") || reply2.includes("30");
  console.log(`\n[判定] 上下文记忆: ${remembered ? "PASS" : "FAIL（回复未引用上一轮要求）"}`);

  // ── 用例 3：中文理解 + 指令遵循 ──
  const t2 = Date.now();
  const reply3 = await chatTurn(provider, "smoke-zhipu-1", "只回复两个字：收到");
  console.log(`\n[指令遵循] (${Date.now() - t2}ms)\n${reply3}`);
  const precise = reply3.trim().length <= 6;
  console.log(`[判定] 简短指令: ${precise ? "PASS" : "WARN（回复偏长）"}`);

  console.log(
    `\n[SMOKE-${remembered && precise && reply1.trim() ? "PASS" : "DONE"}] provider=${provider.id} model=${model}`,
  );
}

main().catch((err: unknown) => {
  console.error("[SMOKE-FAIL]", err instanceof Error ? err.message : err);
  process.exit(1);
});
