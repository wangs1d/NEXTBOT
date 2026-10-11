/**
 * TurnUnderstanding 真实路由探针（2026-10-10 词表判定退役配套）：
 * 验证 L1 路由 LLM 与意图同体产出的 understanding 标记质量，以及
 * 消费链（parseUnderstanding → recall-gate）对每条用例的实际处理结果。
 *
 * 核心回归：「你叫我什么？」曾被 AMBIGUOUS_FOLLOWUP_RE 缺 ^ 锚误判成追问轮，
 * 追问锚点注入带偏模型 + 手写行程检测误触发强制规划。新契约下这句话应产出
 * 全 false 标记（或无 understanding）→ 零注入零补跑。
 *
 * 用法（server 目录下）：
 *   node --import tsx test/tmp-probe/probe-turn-understanding.ts
 *
 * 真实外网调用（路由 LLM 一次/用例，快模型，费用可忽略）。
 */
import "../../src/config/load-server-env.js";
import { createExternalChatProviderFromEnv } from "../../src/external-model/resolve-provider.js";
import { routeTurnByLlm } from "../../src/agent/llm-task-router.js";
import { parseUnderstanding } from "../../src/agent/route-llm-call.js";
import { shouldRecallLongTerm } from "../../src/agent/recall-gate.js";

const CASES = [
  "你叫我什么？", // 核心回归：独立新问题，应零标记
  "在吗",
  "然后呢",
  "那个方案呢",
  "上次说的那个餐厅叫什么",
  "记住我下周三要开会",
  "帮我看看明天的日程",
  "帮我规划一个去成都的三日游",
];

async function main(): Promise<void> {
  const mainProvider = createExternalChatProviderFromEnv();
  console.log(
    `路由 provider（跟随主模型）: ${(mainProvider as { id?: string } | null)?.id ?? "null"}\n`,
  );

  for (const text of CASES) {
    const t0 = Date.now();
    try {
      const d = await routeTurnByLlm(mainProvider as never, "probe-turn-understanding", text);
      const ms = Date.now() - t0;
      // RouteDecision 已携带解析好的 understanding（routeTurnByLlm 从 call.understanding 透传）
      const u = d.understanding;
      const gate = shouldRecallLongTerm({ text, threadMessageCount: 10, understanding: u ?? undefined });
      const uDesc = u
        ? `fu=${u.isFollowUp} ref=${u.reference} recall=${u.recallIntent} mem=${u.memoryInstruction} fact=${u.personalFact} sch=${u.scheduleQuery} travel=${u.travelQuery}`
        : "undefined(零注入)";
      console.log(
        `"${text}" → ${d.intent}@${d.confidence?.toFixed(2)} ${ms}ms\n  understanding: ${uDesc}\n  recall-gate: ${gate.trigger ? gate.reason : "off"}\n`,
      );
    } catch (e) {
      console.log(`"${text}" → 异常 ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
