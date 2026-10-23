/**
 * 车道/缓存/主动性 token 基准（2026-09-23 优化前后对比用）。
 *
 * 全部场景零 LLM 调用，直接 import 真实装配代码测量：
 *   S1 system prompt 分层体积 + 跨轮稳定前缀占比（缓存命中率代理指标）
 *   S2 task 车道可见工具规模（static arch：Core ∪ 能力束 ∪ 桥，及 router-first 后形态）
 *   S3 chat 车道可见工具规模（对照组）
 *   （S4 主动性评估基准已随 LLM 通用路径拆除而移除——决策零 LLM，无可测对象）
 *
 * 对脚本防御性兼容新旧代码：优化后删除/变动的导出走 try-import 降级为 n/a。
 * token 折算与 llm-token-audit 同源（estimateTokensForText）。
 *
 * 用法：npx tsx scripts/bench-lane-cache-tokens.ts [--json out.json]
 */
import "dotenv/config";
import { writeFileSync } from "node:fs";
import { estimateTokensForText } from "../src/services/llm-token-audit.js";
import { assembleSystemPrompt } from "../src/agent/prompt-assembler.js";
import type { AgentPromptMemoryContext } from "../src/external-model/types.js";
import type { ChatCompletionTool } from "openai/resources/chat/completions";

const jsonOut: Record<string, unknown> = {};
const toolChars = (tools: ChatCompletionTool[]): number => JSON.stringify(tools).length;

function longestCommonPrefix(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

// ── S1: system prompt 分层与跨轮稳定性 ──
function buildMemory(turn: number): AgentPromptMemoryContext {
  const rep = (s: string, n: number) => Array(n).fill(s).join("");
  return {
    personalityCore: rep("你是一个可靠的私人管家。", 20),
    persona: rep("对话自然、先结论后解释。", 20),
    values: rep("诚实、克制、办事优先。", 15),
    abilities: rep("联网检索、日程管理、代码沙箱。", 15),
    userUnderstanding: `【用户理解档案】\n${rep("用户偏好简洁直接的回复。", 25)}`,
    userFacts: `【用户事实库】\n所在城市：杭州；作息：晚睡；${rep("事实条目。", 40)}`,
    userProfileSummary: rep("用户是开发者，常调研 AI 产品。", 20),
    memoryInventory: rep("记忆条目索引。", 60),
    relationshipMemory: rep("关系背景。", 30),
    lifeThemeMemory: rep("生活主题。", 20),
    memorySummary: rep("持久记忆：用户在做 NextBot 项目。", 30),
    // sessionRecap 随轮增长（模拟滚动 recap 追加行）
    sessionRecap: `[ts:09:00] 早上讨论了构建问题。[ts:10:30] 优化了工具路由。`.repeat(turn),
    skillIndex: rep("- skill_demo：演示技能。", 12),
    interestList: "刘浩存、AI 产品、Flutter。",
    personaStatic: `【人格·静态】\n你是用户的私人管家兼搭档。能干、嘴欠、但绝对靠得住。`,
    personaMood: `【人格·状态：日常调侃】\n默认带一点吐槽，一句到位不堆砌。`,
    semanticIntent: "查询/检索类",
    scheduleSnapshot: "今日 14:00 例会；19:00 健身。",
    taskContext: rep("任务上下文。", 30),
    narrativeRecall: rep("联想记忆片段。", 25),
    workingMemorySummary: rep("工作记忆摘要。", 15),
    recentConversationHistory: `[ts:11:${String(10 + turn).padStart(2, "0")}] 用户：第 ${turn} 轮消息内容示例。`,
    journalRecall: rep("今日日志。", 10),
    dailyDigest: rep("今日摘要。", 10),
    userProfile: rep("画像块。", 15),
    memoryPreferences: rep("偏好：先结论。", 10),
    memoryFacts: rep("事实块。", 10),
    memoryCommitments: "承诺：明天交付基准脚本。",
    memoryOpenLoops: "未完成：文档补全。",
    currentTime: `2026-09-23 11:${String(10 + turn).padStart(2, "0")} 周三`,
  } as AgentPromptMemoryContext;
}

function benchS1(): void {
  const t1 = assembleSystemPrompt("你是私人助理。", buildMemory(1));
  const t2 = assembleSystemPrompt("你是私人助理。", buildMemory(2));
  const stableSame = t1.stableSystemPrompt === t2.stableSystemPrompt;
  const full1 = t1.fullSystemPrompt;
  const full2 = t2.fullSystemPrompt;
  const lcp = longestCommonPrefix(full1, full2);
  const row = {
    stableChars: t1.stableSystemPrompt.length,
    stableTokens: estimateTokensForText(t1.stableSystemPrompt),
    dynamicChars: (t1.dynamicSystemPrompt ?? "").length,
    dynamicTokens: estimateTokensForText(t1.dynamicSystemPrompt ?? ""),
    fullChars: full1.length,
    fullTokens: estimateTokensForText(full1),
    /** 跨轮稳定前缀占整条 system 的比例（越接近 1 缓存越友好） */
    crossTurnStableRatio: Math.round((lcp / full1.length) * 1000) / 1000,
    stableLayerCrossTurnEqual: stableSame,
  };
  jsonOut.S1_systemPrompt = row;
  console.log("\n── S1 system prompt（分层 + 跨轮稳定性）──");
  console.log(`  稳定层: ${row.stableChars} 字 / ${row.stableTokens} tok`);
  console.log(`  动态层: ${row.dynamicChars} 字 / ${row.dynamicTokens} tok`);
  console.log(`  全条:   ${row.fullChars} 字 / ${row.fullTokens} tok`);
  console.log(`  跨轮稳定前缀占比: ${(row.crossTurnStableRatio * 100).toFixed(1)}%（稳定层逐字节相等: ${stableSame}）`);
}

// ── S2/S3: 车道可见工具 ──
async function benchLanes(): Promise<void> {
  const { getBuiltinAgentChatTools } = await import(
    "../src/external-model/openai-compatible-tool-loop.js"
  );
  const laneMod = await import("../src/external-model/lane-tool-sets.js");
  const { prepareToolsWithToolSearch } = await import("../src/tools/tool-search/index.js");
  const corpus: ChatCompletionTool[] = [...getBuiltinAgentChatTools()];

  const measure = (name: string, visible: ChatCompletionTool[], deferredCount: number) => {
    const chars = toolChars(visible);
    const row = {
      visibleCount: visible.length,
      visibleChars: chars,
      visibleTokens: estimateTokensForText(JSON.stringify(visible)),
      deferredCount,
    };
    jsonOut[name] = row;
    console.log(
      `  ${name}: 可见 ${row.visibleCount} 个 / ${row.visibleChars} 字 / ${row.visibleTokens} tok（deferred ${deferredCount}）`,
    );
  };

  console.log("\n── S2/S3 车道可见工具 ──");

  // chat 车道（对照组，本轮优化不动它）
  const chatCore = laneMod.buildLaneCoreTools("chat", corpus);
  const chatPrepared = prepareToolsWithToolSearch(chatCore, corpus);
  measure("S3_chat_lane_visible", chatPrepared.visibleTools, chatPrepared.deferredToolCount);

  // task 车道 light 档（capabilities=["search"]，能力束增量）
  // 2026-09-23 后：与 agent-core 的静态双车道装配同源——router-first 时可见
  // 候选为空（桥工具由 prepareToolsWithToolSearch 自动注入），core 模式回退旧路径。
  const routerFirst = laneMod.isTaskLaneRouterFirst?.() ?? false;
  const taskCore = laneMod.buildLaneCoreTools("task", corpus, []);
  const beam = laneMod.toolsMatchingCapabilityBeam(
    corpus,
    ["search"],
  ).filter((d) => d.type !== "function" || !taskCore.some((c) => c.type === "function" && c.function?.name === d.function?.name));
  const taskCandidates = routerFirst ? [] : [...taskCore, ...beam];
  const taskPrepared = prepareToolsWithToolSearch(taskCandidates, corpus);
  measure(
    routerFirst ? "S2_task_lane_light_visible(router_first)" : "S2_task_lane_light_visible",
    taskPrepared.visibleTools,
    taskPrepared.deferredToolCount,
  );

  // task 车道 pro 档（capabilities=["full"]）
  const taskProCandidates = routerFirst ? [] : taskCore;
  const taskProPrepared = prepareToolsWithToolSearch(taskProCandidates, corpus);
  measure(
    routerFirst ? "S2_task_lane_pro_visible(router_first)" : "S2_task_lane_pro_visible",
    taskProPrepared.visibleTools,
    taskProPrepared.deferredToolCount,
  );
}

async function main(): Promise<void> {
  console.log("═══ 车道/缓存/主动性 token 基准 ═══");
  benchS1();
  await benchLanes();
  const outIdx = process.argv.indexOf("--json");
  if (outIdx > 0 && process.argv[outIdx + 1]) {
    writeFileSync(process.argv[outIdx + 1], JSON.stringify(jsonOut, null, 1));
    console.log(`\nJSON 已写入 ${process.argv[outIdx + 1]}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
