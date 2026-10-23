/**
 * 缓存前缀断裂点探针（2026-09-29）。
 *
 * 背景：主链路审计显示工具轮（main_chat_tools）缓存命中率仅 ~29%，闲聊轮 ~58%。
 * 本探针用「真实装配函数 + 真实 chat 车道工具集」组装生产同构请求，对真实端点
 * 连发成对请求，二分定位前缀在哪一环断裂：
 *
 *   L0 对照组     ：完全相同的请求连发两次 —— 验证端点前缀缓存可用 + 测量口径
 *   L1 理想世界   ：turn2 请求里 turn1 的 user 消息带尾巴（= 历史存了尾巴）——
 *                   期望 turn2 命中 ≈ sys+tools+u1(+tail)+a1
 *   L2 现实（干净史）：turn1 请求带尾巴，turn2 重放干净版 u1（= 当前生产行为，
 *                   尾巴只在请求时克隆注入、不落史）—— 期望命中在 u1 尾部截断，
 *                   a1 全价重发
 *   L3 工具集变化 ：同 L2 但 turn2 的 tools 多一个工具 —— 量化工具数组在
 *                   缓存前缀里的位置（断裂则说明 tools 排在 system 之前）
 *   L4 稳定层改写 ：同 L1 但 turn2 的稳定 system 中段一个字段被改写 —— 量化
 *                   「稳定层其实不稳」（如理解档案被画像抽取逐轮更新）的代价
 *
 * 全程真实 API（deepseek-flash + OPENAI_* 配置，与生产同一客户端形态：
 * stream + include_usage + thinking:disabled + prompt_cache_key）。
 *
 * 用法：npx tsx scripts/probe-cache-prefix.ts
 * 纯观测：不改任何文件，不写审计。
 */
import { loadServerEnv } from "../src/config/load-server-env.js";
import OpenAI from "openai";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";

import {
  preparePromptCachePlan,
  applyPromptCacheMessages,
} from "../src/external-model/prefix-cache.js";
import { getBuiltinAgentChatTools, prepareToolsForChatApi } from "../src/external-model/openai-compatible-tool-loop.js";
import { buildLaneCoreTools } from "../src/external-model/lane-tool-sets.js";
import { prepareToolsWithToolSearch } from "../src/tools/tool-search/index.js";
import type { AgentPromptMemoryContext } from "../src/external-model/types.js";

const MODEL = process.env.PROBE_MODEL?.trim() || "deepseek-flash";
const SLEEP_MS = 1_500;
const MAX_TOKENS = 16;
/** 每次运行的随机 nonce：掺进 L4/A/B 腿的内容，避免与历史运行的同字节请求
 *  在 DeepSeek 服务端缓存里整条命中（exact-match），污染「前缀断裂」测量。 */
const RUN_NONCE = Math.random().toString(36).slice(2, 8);

const rep = (s: string, n: number) => Array(n).fill(s).join("");

/** 仿生产量级的记忆上下文（尺寸对齐 bench-lane-cache-tokens 的合成档案）。 */
function buildMemory(turn: number): AgentPromptMemoryContext {
  return {
    personalityCore: rep("你是一个可靠的私人管家，办事优先、表达克制。", 20),
    persona: rep("对话自然、先结论后解释，不堆砌客套。", 20),
    values: rep("诚实、克制、办事优先。", 15),
    abilities: rep("联网检索、日程管理、代码沙箱、智能家居控制。", 15),
    userUnderstanding: `【用户理解档案】\n${rep("用户偏好简洁直接的回复，反感客套垫话。", 25)}`,
    userFacts: `【用户事实库】\n所在城市：杭州；作息：晚睡；${rep("事实条目内容。", 40)}`,
    userProfileSummary: rep("用户是开发者，常调研 AI 产品与前端框架。", 20),
    memoryInventory: rep("记忆条目索引。", 60),
    relationshipMemory: rep("关系背景：多年搭档式协作。", 30),
    lifeThemeMemory: rep("生活主题：工作密集期。", 20),
    memorySummary: rep("持久记忆：用户在做 NextBot 项目。", 30),
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
    currentTime: `2026-09-29 14:${String(10 + turn).padStart(2, "0")} 周二`,
  } as AgentPromptMemoryContext;
}

const U1 = "帮我查一下这周末杭州的天气怎么样，顺便看看有什么值得去的展览。";
const A1 =
  "这周末杭州多云为主，周六 22~28℃，周日 21~26℃，周日傍晚可能有短时阵雨，户外安排建议放周六。" +
  "展览方面值得看的有三个：一是浙江美术馆的「山水之间」当代水墨展（免费，需公众号预约，周六下午场次人少）；" +
  "二是中国美院民艺博物馆的器物展（小众，适合慢慢看，周一是闭馆日）；三是天目里 B1OCK 的摄影季，" +
  "傍晚去正好接晚饭，附近就有你常去的那家面馆。要不要我把周六下午的美术馆行程加进日程，顺带把周日的安排留白？";
const U2 = "好啊，周六下午两点加到日程里，再设个提前一小时提醒。";

type UsageInfo = { promptTokens: number; cachedTokens: number; ms: number };

async function callOnce(
  client: OpenAI,
  messages: ChatCompletionMessageParam[],
  tools: ChatCompletionTool[],
  cacheKey: string | undefined,
  label: string,
): Promise<UsageInfo> {
  const t0 = Date.now();
  const stream = (await client.chat.completions.create(
    {
      model: MODEL,
      messages,
      tools,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: MAX_TOKENS,
      thinking: { type: "disabled" },
      ...(cacheKey ? { prompt_cache_key: cacheKey } : {}),
    } as unknown as Parameters<typeof client.chat.completions.create>[0],
  )) as unknown as AsyncIterable<{ usage?: Record<string, unknown> }>;
  let usage: Record<string, unknown> | undefined;
  for await (const chunk of stream) {
    if (chunk.usage) usage = chunk.usage;
  }
  const pt = Number(usage?.prompt_tokens ?? 0);
  const details = usage?.prompt_tokens_details as { cached_tokens?: number } | undefined;
  const ct = Number(details?.cached_tokens ?? (usage as { prompt_cache_hit_tokens?: number })?.prompt_cache_hit_tokens ?? 0);
  const info: UsageInfo = { promptTokens: pt, cachedTokens: ct, ms: Date.now() - t0 };
  console.log(
    `  ${label.padEnd(28)} prompt=${String(pt).padStart(6)}  cached=${String(ct).padStart(6)}  ` +
      `miss=${String(pt - ct).padStart(6)}  (${info.ms}ms)`,
  );
  return info;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function lcpChars(a: unknown, b: unknown): number {
  const sa = JSON.stringify(a);
  const sb = JSON.stringify(b);
  const n = Math.min(sa.length, sb.length);
  let i = 0;
  while (i < n && sa[i] === sb[i]) i++;
  return i;
}

async function main(): Promise<void> {
  loadServerEnv();
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  const baseURL = (process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").trim();
  if (!apiKey) {
    console.error("[probe] 缺 OPENAI_API_KEY，无法打真链");
    process.exit(1);
  }
  const client = new OpenAI({ apiKey, baseURL, timeout: 120_000, maxRetries: 0 });

  // ── 真实装配：chat 车道可见工具 + 生产同构 prompt plan ──
  const corpus = [...getBuiltinAgentChatTools()];
  const chatCore = buildLaneCoreTools("chat", corpus);
  const prepared = prepareToolsWithToolSearch(chatCore, corpus);
  // 生产同构：发送前过 prepareToolsForChatApi（点号转下划线 + schema 描述压缩）
  const visibleTools = prepareToolsForChatApi(prepared.visibleTools).apiTools;

  const plan1 = preparePromptCachePlan({
    providerId: "openai",
    model: MODEL,
    baseSystemPrompt: "你是用户的私人管家。",
    memory: buildMemory(1),
    tools: visibleTools,
    variant: "chat-tools",
  });
  const plan2 = preparePromptCachePlan({
    providerId: "openai",
    model: MODEL,
    baseSystemPrompt: "你是用户的私人管家。",
    memory: buildMemory(2),
    tools: visibleTools,
    variant: "chat-tools",
  });
  // L4 用：稳定层中段字段（userUnderstanding）被改写，其余不变
  const mem4 = { ...buildMemory(2), userUnderstanding: `【用户理解档案】\n${rep("用户偏好简洁直接的回复，反感客套垫话。", 25)}\n更新：最近在关注缓存优化。（nonce:${RUN_NONCE}）` };
  const plan4 = preparePromptCachePlan({
    providerId: "openai",
    model: MODEL,
    baseSystemPrompt: "你是用户的私人管家。",
    memory: mem4,
    tools: visibleTools,
    variant: "chat-tools",
  });

  const sys = plan1.requestSystemMessages;
  const tail1 = plan1.tailDynamicContext ?? "";
  const tail2 = plan2.tailDynamicContext ?? "";
  const tools2 = [...visibleTools];
  const tools3 = [
    ...visibleTools,
    {
      type: "function",
      function: {
        name: "dummy_beam_tool",
        description: "模拟 router-first 能力束逐轮变化的增量工具。",
        parameters: { type: "object", properties: { q: { type: "string" } } },
      },
    } as ChatCompletionTool,
  ];

  console.log(`# 缓存前缀断裂点探针  model=${MODEL}  endpoint=${new URL(baseURL).host}`);
  console.log(`# 可见工具 ${visibleTools.length} 个；稳定 system ${sys[0] ? String((sys[0] as { content?: string }).content ?? "").length : 0} 字；tail ${tail1.length}/${tail2.length} 字\n`);

  // ── L0 对照组：完全相同请求连发两次 ──
  const reqA = applyPromptCacheMessages(
    [
      { role: "user", content: U1 },
    ] as ChatCompletionMessageParam[],
    sys,
    tail1,
  );
  console.log("L0 对照组（同一请求连发两次，期望第 2 次 cached≈prompt）:");
  const l0a = await callOnce(client, reqA, visibleTools, plan1.promptCache?.prompt_cache_key, "L0 #1");
  await sleep(SLEEP_MS);
  const l0b = await callOnce(client, reqA, visibleTools, plan1.promptCache?.prompt_cache_key, "L0 #2 (同一请求)");
  await sleep(SLEEP_MS);

  // ── L1 理想世界：turn2 里 turn1 的 user 消息带尾巴（= 尾巴落史）──
  const reqL1_2 = [
    ...reqA,
    { role: "assistant", content: A1 },
    { role: "user", content: U2 },
  ] as ChatCompletionMessageParam[];
  const reqL1_2t = applyPromptCacheMessages(reqL1_2, sys, tail2);
  console.log("\nL1 理想世界（u1 连尾巴一起进 turn2 前缀，期望 cached≈sys+u1+tail+a1）:");
  await callOnce(client, reqA, visibleTools, plan1.promptCache?.prompt_cache_key, "L1 #1 (turn1)");
  await sleep(SLEEP_MS);
  const l1b = await callOnce(client, reqL1_2t, visibleTools, plan1.promptCache?.prompt_cache_key, "L1 #2 (turn2 带尾史)");
  await sleep(SLEEP_MS);

  // ── L2 现实：turn2 重放干净版 u1（= 当前生产行为：尾巴不落史）──
  const reqL2_2 = [
    { role: "system", content: (sys[0] as { content: string }).content },
    { role: "user", content: U1 },
    { role: "assistant", content: A1 },
    { role: "user", content: `${U2}${applyTailForProbe(tail2)}` },
  ] as ChatCompletionMessageParam[];
  console.log("\nL2 现实（u1 干净重放+新尾巴沉底，= 生产现状）:");
  await callOnce(client, reqA, visibleTools, plan1.promptCache?.prompt_cache_key, "L2 #1 (turn1)");
  await sleep(SLEEP_MS);
  const l2b = await callOnce(client, reqL2_2, visibleTools, plan1.promptCache?.prompt_cache_key, "L2 #2 (turn2 干净史)");
  await sleep(SLEEP_MS);

  // ── L3 工具集变化：同 L2 但 tools 多一个 ──
  console.log("\nL3 工具集变化（同 L2，turn2 多 1 个工具，量化 tools 在前缀中的位置）:");
  await callOnce(client, reqA, visibleTools, plan1.promptCache?.prompt_cache_key, "L3 #1 (turn1)");
  await sleep(SLEEP_MS);
  const l3b = await callOnce(client, reqL2_2, tools3, plan1.promptCache?.prompt_cache_key, "L3 #2 (turn2 工具+1)");
  await sleep(SLEEP_MS);

  // ── L4 稳定层改写：同 L1 但稳定 system 中段被改写 ──
  const reqL4_2 = [
    { role: "system", content: (plan4.requestSystemMessages[0] as { content: string }).content },
    { role: "user", content: `${U1}${applyTailForProbe(tail1)}` },
    { role: "assistant", content: A1 },
    { role: "user", content: `${U2}${applyTailForProbe(tail2)}` },
  ] as ChatCompletionMessageParam[];
  console.log("\nL4 稳定层改写（userUnderstanding 中段+一行，量化『稳定层其实不稳』）:");
  await callOnce(client, reqA, visibleTools, plan1.promptCache?.prompt_cache_key, "L4 #1 (turn1)");
  await sleep(SLEEP_MS);
  const l4b = await callOnce(client, reqL4_2, visibleTools, plan4.promptCache?.prompt_cache_key, "L4 #2 (稳定层被改)");

  // ── A/B 优化验证（2026-09-29 P0-1 落地后）：真实理解档案 store + 真实装配链 ──
  // LA 旧行为：grounded 寻址标记打在稳定层（随用户措辞逐轮移位）→ 复现根因
  // LB 新行为：字节稳定渲染 + turnAddressing 沉底 + 会话冻结 → 应恢复 ~97%
  const ab = await buildAbLegs(visibleTools);
  if (ab) {
    console.log("\nLA 旧行为（grounded 标记在稳定层移位，turn2 问不同话题）:");
    const la1 = await callOnce(client, ab.oldTurn1, visibleTools, undefined, "LA #1 (turn1 问老婆)");
    await sleep(SLEEP_MS);
    const la2 = await callOnce(client, ab.oldTurn2, visibleTools, undefined, "LA #2 (turn2 问工作)");
    await sleep(SLEEP_MS);
    console.log("\nLB 新行为（字节稳定稳定层 + 寻址沉底 + 会话冻结，同两轮）:");
    const lb1 = await callOnce(client, ab.newTurn1, visibleTools, undefined, "LB #1 (turn1 问老婆)");
    await sleep(SLEEP_MS);
    const lb2 = await callOnce(client, ab.newTurn2, visibleTools, undefined, "LB #2 (turn2 问工作)");
    console.log("\n═══ A/B 汇总（第 2 轮命中率 = 优化直接收益）═══");
    console.log(`LA 旧行为稳定层   : ${pctLocal(la2)}%  (cached=${la2.cachedTokens}/${la2.promptTokens})`);
    console.log(`LB 新行为稳定层   : ${pctLocal(lb2)}%  (cached=${lb2.cachedTokens}/${lb2.promptTokens})`);
    console.log(`  首轮对照: LA#1=${pctLocal(la1)}% LB#1=${pctLocal(lb1)}%（应相近，均为暖缓存后）`);
  }

  // ── 汇总 ──
  const pct = (u: UsageInfo) => (u.promptTokens > 0 ? Math.round((u.cachedTokens / u.promptTokens) * 100) : 0);
  console.log("\n═══ 汇总（第 2 次请求的命中率）═══");
  console.log(`L0 同请求重发     : ${pct(l0b)}%  (cached=${l0b.cachedTokens}/${l0b.promptTokens})`);
  console.log(`L1 尾巴落史(理想) : ${pct(l1b)}%  (cached=${l1b.cachedTokens}/${l1b.promptTokens})`);
  console.log(`L2 干净史(现状)   : ${pct(l2b)}%  (cached=${l2b.cachedTokens}/${l2b.promptTokens})`);
  console.log(`L3 现状+工具+1    : ${pct(l3b)}%  (cached=${l3b.cachedTokens}/${l3b.promptTokens})`);
  console.log(`L4 稳定层被改写   : ${pct(l4b)}%  (cached=${l4b.cachedTokens}/${l4b.promptTokens})`);
  console.log(`\n字符级 LCP: L2#2 vs L1#1 = ${lcpChars(reqL2_2, reqA)} 字（请求整体 JSON）`);
}

const pctLocal = (u: { promptTokens: number; cachedTokens: number }) =>
  u.promptTokens > 0 ? Math.round((u.cachedTokens / u.promptTokens) * 100) : 0;

/**
 * A/B 构造：真实 UserUnderstandingStore（内存 SQLite，两条理解：「老婆」「工作」）。
 * 两轮用户消息分别命中不同话题（"我老婆是谁" / "我是做什么工作的"）。
 * - 旧：renderForPrompt(actor, groundedSet)——寻址标记打在稳定层
 * - 新：renderForPrompt(actor) 字节稳定 + formatTurnAddressingBlock 沉底 +
 *   preparePromptCachePlan(sessionId) 会话冻结（真实新代码路径）
 */
async function buildAbLegs(visibleTools: ChatCompletionTool[]): Promise<{
  oldTurn1: ChatCompletionMessageParam[];
  oldTurn2: ChatCompletionMessageParam[];
  newTurn1: ChatCompletionMessageParam[];
  newTurn2: ChatCompletionMessageParam[];
} | null> {
  try {
    const { UserUnderstandingStore } = await import("../src/agentic-memory/user-understanding-store.js");
    const Database = (await import("better-sqlite3")).default;
    const { formatTurnAddressingBlock } = await import("../src/agent/prompt-context-builder.js");
    const db = new Database(":memory:");
    const store = new UserUnderstandingStore(db);
    const actor = "probe-ab-actor";
    const mkNote = (topic: string, note: string) => ({
      actorId: actor, topic, note, kind: "fact" as const, confidence: 0.9,
    });
    for (let i = 0; i < 8; i++) store.applyUnderstanding(mkNote(`话题${i}`, `用户对话题${i}的长期理解示例内容，含语境判断。`));
    store.applyUnderstanding(mkNote("老婆", `用户已婚，配偶喜欢看展（09/01 确认，nonce:${RUN_NONCE}）`));
    store.applyUnderstanding(mkNote("工作", "用户是独立开发者，主做 Flutter 应用（09/02 确认）"));

    const baseMemory = (understanding: string, addressing?: string) =>
      ({
        personalityCore: "你是一个可靠的私人管家，办事优先、表达克制。".repeat(12),
        persona: "对话自然、先结论后解释，不堆砌客套。".repeat(10),
        userUnderstanding: understanding,
        memorySummary: "持久记忆：用户在做 NextBot 项目。",
        ...(addressing ? { turnAddressing: addressing } : {}),
        semanticIntent: "档案问答",
        currentTime: "2026-09-29 23:30 周二",
      }) as AgentPromptMemoryContext;

    const U1 = "对了，我老婆是谁来着？你记不记得。";
    const A1 = "记得，你老婆爱看展——上个月你们刚去过浙江美术馆的当代水墨展，她评价挺高，说人少看得慢。";
    const U2 = "那我是做什么工作的？帮你回忆一下。";

    // 旧行为：grounded 标记打在稳定层（两轮命中不同话题 → 稳定层字节移位）
    const oldStable1 = store.renderForPrompt(actor, new Set(["老婆"]))!;
    const oldStable2 = store.renderForPrompt(actor, new Set(["工作"]))!;
    const oldTail = "【意图理解】\n档案问答\n【当前时间】\n2026-09-29 23:30 周二";
    const oldTurn1 = [
      { role: "system", content: oldStable1 },
      { role: "user", content: `${U1}${applyTailForProbe(oldTail)}` },
    ] as ChatCompletionMessageParam[];
    const oldTurn2 = [
      { role: "system", content: oldStable2 },
      { role: "user", content: `${U1}${applyTailForProbe(oldTail)}` },
      { role: "assistant", content: A1 },
      { role: "user", content: `${U2}${applyTailForProbe(oldTail)}` },
    ] as ChatCompletionMessageParam[];

    // 新行为：真实 preparePromptCachePlan（sessionId 冻照）两轮，寻址沉底
    const plan1 = preparePromptCachePlan({
      providerId: "openai",
      model: MODEL,
      baseSystemPrompt: "你是用户的私人管家。",
      memory: baseMemory(store.renderForPrompt(actor)!, formatTurnAddressingBlock(["老婆"], [])),
      tools: visibleTools,
      variant: "chat-tools",
      sessionId: `probe-ab-new-session-${RUN_NONCE}`,
    });
    const plan2 = preparePromptCachePlan({
      providerId: "openai",
      model: MODEL,
      baseSystemPrompt: "你是用户的私人管家。",
      memory: baseMemory(store.renderForPrompt(actor)!, formatTurnAddressingBlock([], ["职业"])),
      tools: visibleTools,
      variant: "chat-tools",
      sessionId: `probe-ab-new-session-${RUN_NONCE}`,
    });
    const newTurn1 = applyPromptCacheMessages(
      [{ role: "user", content: U1 }] as ChatCompletionMessageParam[],
      plan1.requestSystemMessages,
      plan1.tailDynamicContext,
    );
    const newTurn2 = applyPromptCacheMessages(
      [
        { role: "user", content: U1 },
        { role: "assistant", content: A1 },
        { role: "user", content: U2 },
      ] as ChatCompletionMessageParam[],
      plan2.requestSystemMessages,
      plan2.tailDynamicContext,
    );
    store.close();
    return { oldTurn1, oldTurn2, newTurn1, newTurn2 };
  } catch (err) {
    console.log(`[probe] A/B 构造失败（跳过）: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/** 探针版尾巴沉底（与 prefix-cache.applyTailDynamicContext 同构，独立实现避免额外导出）。 */
function applyTailForProbe(tail: string): string {
  return `\n\n[system-context]\n（本轮系统注入的上下文：记忆/时间/任务等，非用户消息正文，按 system 指令同等遵循）\n${tail}\n[/system-context]`;
}

main().catch((err) => {
  console.error("[probe] 失败:", err instanceof Error ? err.message : err);
  process.exit(1);
});
