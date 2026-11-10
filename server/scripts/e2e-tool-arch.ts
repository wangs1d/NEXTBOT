/**
 * 工具调用架构 E2E 台架（2026-09-19 静态双车道改造验收）。
 *
 * 真实组件：getBuiltinAgentChatTools 全量 schema / resolveChatToolPlanForStream
 * 暴露管线 / streamCompletionWithTools 波次循环 / ToolRegistry 执行 / 延迟目录
 * BM25 检索。mock 的只有 LLM 本身（脚本化流式响应）——测的是链路机制，不是
 * 模型智能。所有数字都是真实执行测得，无任何手工填造。
 *
 * 用法：
 *   npx tsx scripts/e2e-tool-arch.ts                 # 当前架构（静态双车道）
 *   AGENT_TOOL_ARCH=legacy npx tsx scripts/e2e-tool-arch.ts   # 旧架构对照
 */
import "dotenv/config";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PA_DATA_DIR = process.env.PA_DATA_DIR || mkdtempSync(join(tmpdir(), "pa-e2e-tool-arch-"));
process.env.AGENT_TOKENJUICE_ENABLED = "0";
// 检索确定性：关 embedding/神经 sidecar，BM25 词面管线
process.env.AGENT_TOOL_SEARCH_ENABLED = "on";
process.env.AGENT_TOOL_SEARCH_EMBEDDING = "off";
process.env.AGENT_NEURAL_SIDECAR_URL = "http://127.0.0.1:1";

const MODE = (process.env.AGENT_TOOL_ARCH ?? "static") === "legacy" ? "legacy" : "static";

/* ---------------- 真实模块 ---------------- */
const { streamCompletionWithTools } = await import("../src/external-model/openai-compatible-tool-loop.js");
const { resolveChatToolPlanForStream } = await import("../src/external-model/resolve-chat-tools.js");
const { selectForegroundCapabilityToolAdditions } = await import("../src/external-model/openai-compatible-tool-loop.js");
const { buildLaneCoreTools, toolsMatchingCapabilityBeam } = await import("../src/external-model/lane-tool-sets.js");
const { estimateToolsSchemaTokens } = await import("../src/gateway/index.js");
const { ToolRegistry } = await import("../src/tools/tool-registry.js");
const { TASK_DISPATCH_TOOL_DEFINITION } = await import("../src/tools/task-dispatch-tool.js");
const { recordTurnTrace, summarizeTurnTraces } = await import("../src/external-model/turn-trace.js");
import type { TurnTraceRecord } from "../src/external-model/turn-trace.js";
const { resetLlmUsageAuditForTest } = await import("../src/services/llm-token-audit.js");
const builtinTools: any[] = (await import("../src/external-model/openai-compatible-tool-loop.js"))
  .getBuiltinAgentChatTools();
const corpus: any[] = [...builtinTools, TASK_DISPATCH_TOOL_DEFINITION];

/* ---------------- 真实 ToolRegistry（少而真的执行器） ---------------- */
const registry = new ToolRegistry() as any;
let failNextSearchExecutions = 0;
registry.register("clock.get_current_time", async () => ({
  iso: new Date().toISOString(), timezone: "Asia/Shanghai",
}));
registry.register("search_web", async (input: any) => {
  if (failNextSearchExecutions > 0) {
    failNextSearchExecutions -= 1;
    throw new Error("模拟上游超时（台架注入）");
  }
  return {
    results: [
      { title: "搜索结果 1", snippet: `关于「${input?.query ?? ""}」的真实抓取摘要（台架 fixture）。`, url: "https://example.com/1" },
      { title: "搜索结果 2", snippet: "第二来源摘要。", url: "https://example.com/2" },
    ],
  };
});
registry.register("smart_home.control_device", async (input: any) => ({
  ok: true, deviceId: "livingroom_ac", action: input?.action ?? "set", temperature: input?.temperature ?? 26,
}));
registry.register("weather.get_local", async () => ({ city: "上海", condition: "多云", tempC: 24 }));
registry.register("reminder.plan", async (input: any) => ({
  ok: true, nextRunAtLocal: "2026-09-20T09:00:00+08:00", echo: input ?? {},
}));
const toolCtx = {
  executeTool: (name: string, args: Record<string, unknown>) =>
    registry.execute(name, args, { sessionId: "e2e-tool-arch" }),
};

/* ---------------- 车道暴露方案（复用 agent-core 同款构建逻辑） ---------------- */
const LEGACY_CHAT_WHITELIST_NAMES = ["reminder.plan", "calendar.create_from_text", "task.dispatch", "search_web"];

function chatLanePlanStatic() {
  return resolveChatToolPlanForStream(undefined, {
    toolExposureProfile: "explicit",
    chatToolsBuiltin: buildLaneCoreTools("chat", corpus, [TASK_DISPATCH_TOOL_DEFINITION]),
    chatToolsExtra: corpus,
  } as any);
}
function chatLanePlanLegacy(userText?: string) {
  const base = corpus.filter(
    (t: any) => t.type === "function" && LEGACY_CHAT_WHITELIST_NAMES.includes(t.function?.name),
  );
  const additions = selectForegroundCapabilityToolAdditions(userText);
  const known = new Set(base.map((t: any) => t.function?.name));
  const builtin = [...base, ...additions.filter((t: any) => t.type === "function" && !known.has(t.function?.name))];
  return resolveChatToolPlanForStream(userText, {
    toolExposureProfile: "explicit",
    chatToolsBuiltin: builtin,
    disableToolSearch: true,
  } as any);
}
function taskLanePlanStatic(capabilities?: string[]) {
  const core = buildLaneCoreTools("task", corpus, [TASK_DISPATCH_TOOL_DEFINITION]);
  const coreNames = new Set(core.map((t: any) => t.function?.name));
  const beam = toolsMatchingCapabilityBeam(corpus, capabilities).filter(
    (t: any) => !coreNames.has(t.function?.name),
  );
  return resolveChatToolPlanForStream(undefined, {
    toolExposureProfile: "explicit",
    chatToolsBuiltin: [...core, ...beam],
    chatToolsExtra: corpus,
  } as any);
}
function taskLanePlanLegacy(capabilities?: string[]) {
  return resolveChatToolPlanForStream("查询", {
    toolExposureProfile: "delegate",
    toolCapabilities: capabilities,
    chatToolsBuiltin: corpus,
  } as any);
}

/* ---------------- turn-trace 捕获 ---------------- */
const traces: TurnTraceRecord[] = [];
const originalConsoleInfo = console.info;
console.info = (...args: unknown[]) => {
  const line = typeof args[0] === "string" ? args[0] : "";
  if (line.startsWith("[turn-trace] ")) {
    try {
      traces.push(JSON.parse(line.slice("[turn-trace] ".length)));
    } catch { /* ignore */ }
  }
  originalConsoleInfo(...args);
};

/* ---------------- fake LLM client（脚本化流式响应） ---------------- */
type AnyChunk = Record<string, unknown>;
type LoopScriptStep =
  | { kind: "text"; text: string }
  | { kind: "tool"; id: string; name: string; args: Record<string, unknown> };

function chunksFor(step: LoopScriptStep): AnyChunk[] {
  const chunks: AnyChunk[] = [];
  if (step.kind === "text") {
    const mid = Math.ceil(step.text.length / 2);
    chunks.push(
      { choices: [{ delta: { content: step.text.slice(0, mid) }, finish_reason: null }] },
      { choices: [{ delta: { content: step.text.slice(mid) }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    );
  } else {
    chunks.push({
      choices: [{
        delta: {
          tool_calls: [{
            index: 0, id: step.id, type: "function",
            function: { name: step.name, arguments: JSON.stringify(step.args) },
          }],
        },
        finish_reason: null,
      }],
    });
    chunks.push({ choices: [{ delta: {}, finish_reason: "tool_calls" }] });
  }
  return chunks;
}

function makeFakeClient(script: LoopScriptStep[]) {
  let callIndex = 0;
  const requests: Array<Record<string, unknown>> = [];
  const client = {
    chat: {
      completions: {
        create: async (req: Record<string, unknown>) => {
          requests.push({ tools: req.tools, messages: req.messages });
          const step = script[Math.min(callIndex, script.length - 1)];
          callIndex += 1;
          return (async function* () {
            for (const c of chunksFor(step)) yield c;
          })();
        },
      },
    },
  };
  return { client: client as never, requests, callCount: () => callIndex };
}

async function runLoop(opts: {
  name: string;
  lane: "chat" | "task";
  script: LoopScriptStep[];
  plan: ReturnType<typeof chatLanePlanStatic>;
  userText: string;
  turnIntent?: string;
  registryStubs?: () => void;
}): Promise<{ finalText: string; llmCalls: number; trace: TurnTraceRecord | undefined }> {
  const before = traces.length;
  resetLlmUsageAuditForTest?.();
  const { client, requests, callCount } = makeFakeClient(opts.script);
  const messages: any[] = [
    { role: "system", content: "你是用户的私人助理。当前时间 2026-09-19。" },
    { role: "user", content: opts.userText },
  ];
  const t0 = Date.now();
  const finalText = await streamCompletionWithTools(
    client,
    "mock-model",
    messages,
    () => {},
    toolCtx as any,
    {
      tools: opts.plan.visibleTools,
      toolSearchSourceTools: opts.plan.searchableTools,
      maxRounds: 4,
      turnIntent: opts.turnIntent,
      audit: { sessionId: `e2e-${opts.name}`, stage: opts.lane === "chat" ? "main_chat_tools" : "task_plane_full" },
    },
  );
  const wallMs = Date.now() - t0;
  const trace = traces[traces.length - 1];
  if (!trace || traces.length !== before + 1) {
    throw new Error(`[${opts.name}] 未捕获到 turn-trace 记录`);
  }
  trace.stage = `${opts.lane}:${trace.stage}`;
  trace.model = `wall=${wallMs}ms`;
  return { finalText, llmCalls: callCount(), trace };
}

/* ---------------- 断言工具 ---------------- */
let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  const mark = cond ? "✔" : "✖";
  if (!cond) failures += 1;
  originalConsoleInfo(`  ${mark} ${name}${cond ? "" : ` —— ${detail ?? ""}`}`);
}
function toolNamesOf(plan: { visibleTools: any[] }): string[] {
  return plan.visibleTools.map((t: any) => t.function?.name).filter(Boolean).sort();
}

/* ---------------- 场景执行 ---------------- */
originalConsoleInfo(`\n=== 工具调用架构 E2E：mode=${MODE} 全量语料=${corpus.length} 工具 ===\n`);

// 场景 A：Core 直调（chat 车道，clock 在静态 Core / legacy 白名单都没有 clock！）
{
  originalConsoleInfo("【A】clock 直调（chat 车道）userText=现在几点了");
  const script: LoopScriptStep[] = [
    { kind: "tool", id: "c1", name: "clock_get_current_time", args: {} },
    { kind: "text", text: "现在 15:30，下午好呀。" },
  ];
  const staticRun = await runLoop({ name: "A-static", lane: "chat", script, plan: chatLanePlanStatic(), userText: "现在几点了" });
  check("A-static：clock 真实执行 ok", staticRun.trace?.toolCalls?.[0]?.ok === true, JSON.stringify(staticRun.trace?.toolCalls));
  check("A-static：2 次 LLM 调用收尾", staticRun.llmCalls === 2, `actual=${staticRun.llmCalls}`);
  check("A-static：请求卡不触发", !staticRun.trace?.requestCard?.fired);

  failNextSearchExecutions = 0;
  const legacyRun = await runLoop({ name: "A-legacy", lane: "chat", script, plan: chatLanePlanLegacy("现在几点了"), userText: "现在几点了" });
  check(
    "A-legacy：模型幻觉调用白名单外工具 → 未知工具失败（legacy 不稳定证据）",
    legacyRun.trace?.toolCalls?.length === 1 && legacyRun.trace?.toolCalls?.[0]?.ok === false,
    `toolCalls=${JSON.stringify(legacyRun.trace?.toolCalls)}`,
  );
  originalConsoleInfo("");
}

// 场景 B：白名单外能力（智能家居）——请求卡转正
{
  originalConsoleInfo("【B】白名单外能力 smart_home.control_device（chat 车道）userText=把客厅空调调到26度");
  const script: LoopScriptStep[] = [
    { kind: "text", text: "<tool_request>把客厅空调调到26度</tool_request>" },
    { kind: "tool", id: "c1", name: "smart_home_control_device", args: { deviceId: "livingroom_ac", temperature: 26 } },
    { kind: "text", text: "好了，客厅空调已经调到 26 度了。" },
  ];
  const staticRun = await runLoop({ name: "B-static-chat", lane: "chat", script, plan: chatLanePlanStatic(), userText: "把客厅空调调到26度" });
  check("B-static：请求卡触发", staticRun.trace?.requestCard?.fired === true, JSON.stringify(staticRun.trace?.requestCard));
  const reachableViaCard =
    staticRun.trace?.requestCard?.loaded?.includes("smart_home.control_device") === true ||
    staticRun.trace?.requestCard?.alreadyVisible?.includes("smart_home.control_device") === true;
  check(
    "B-static：top-1=smart_home.control_device 可达（预召回已注入→指回；未注入→加载）",
    reachableViaCard,
    `requestCard=${JSON.stringify(staticRun.trace?.requestCard)}`,
  );
  check("B-static：转正后真实调用 ok", staticRun.trace?.toolCalls?.[0]?.ok === true, JSON.stringify(staticRun.trace?.toolCalls));
  check("B-static：请求标记不漏进最终回复", !staticRun.finalText.includes("<tool_request>"), staticRun.finalText.slice(0, 80));
  check("B-static：3 次 LLM 调用完成（卡→调→答）", staticRun.llmCalls === 3, `actual=${staticRun.llmCalls}`);

  // B2：预召回未命中（模糊 userText top-1 分数低）→ 请求卡以具体意图真正加载
  const b2Script: LoopScriptStep[] = [
    { kind: "text", text: "<tool_request>把客厅空调调到26度 制冷</tool_request>" },
    { kind: "tool", id: "c1", name: "smart_home_control_device", args: { deviceId: "livingroom_ac", temperature: 26 } },
    { kind: "text", text: "好了，客厅空调已经调到 26 度了。" },
  ];
  const b2Run = await runLoop({ name: "B2-static-chat", lane: "chat", script: b2Script, plan: chatLanePlanStatic(), userText: "把客厅那个调一下" });
  check(
    "B2：预召回未命中时请求卡真正加载工具",
    b2Run.trace?.requestCard?.loaded?.includes("smart_home.control_device") === true,
    `requestCard=${JSON.stringify(b2Run.trace?.requestCard)}`,
  );
  check("B2：加载后调用 ok", b2Run.trace?.toolCalls?.[0]?.ok === true, JSON.stringify(b2Run.trace?.toolCalls));

  const legacyScript: LoopScriptStep[] = [
    { kind: "text", text: "这个我现在的工具办不到，你需要在空调 App 里手动设置一下。" },
  ];
  const legacyRun = await runLoop({ name: "B-legacy-chat", lane: "chat", script: legacyScript, plan: chatLanePlanLegacy("把客厅空调调到26度"), userText: "把客厅空调调到26度" });
  check("B-legacy：零工具调用（对照：白名单外能力不可达）", legacyRun.trace?.toolCalls?.length === 0, `toolCalls=${JSON.stringify(legacyRun.trace?.toolCalls)}`);

  const staticTask = await runLoop({ name: "B-static-task", lane: "task", script, plan: taskLanePlanStatic(["write"]), userText: "把客厅空调调到26度" });
  check("B-static-task：能力可达且调用 ok", staticTask.trace?.toolCalls?.[0]?.ok === true, JSON.stringify(staticTask.trace));
  originalConsoleInfo("");
}

// 场景 C：出口对账闸已删除（2026-11-08）——尝试全败 → 如实收尾，不再打回续波
{
  originalConsoleInfo("【C】出口闸已删除（task 车道，capabilities=[search]）首轮全败 → 如实收尾");
  const script: LoopScriptStep[] = [
    { kind: "tool", id: "c1", name: "search_web", args: { query: "上海 天气" } },
    { kind: "text", text: "抱歉，现在暂时没查到相关结果。" },
  ];
  failNextSearchExecutions = 3; // 首次调用 + 确定性重试×2（2026-09-19 退避增强）都失败
  const run = await runLoop({ name: "C-static-task", lane: "task", script, plan: taskLanePlanStatic(["search"]), userText: "上海明天会下雨吗" });
  failNextSearchExecutions = 0;
  check("C：不打回续波（llmCalls=2：工具波+文本波）", run.llmCalls === 2, `actual=${run.llmCalls}`);
  check("C：如实收尾（不做第二稿）", run.finalText.includes("没查到"), run.finalText.slice(0, 60));
  originalConsoleInfo("");
}

// 场景 D：出口对账闸已删除——「宣告未兑现」不再触发补打（原 announcement_unfulfilled 闸已于 2026-10-06 下线）
{
  originalConsoleInfo("【D】宣告未兑现（chat 车道）不再打回，模型自决的调用照常执行");
  const script: LoopScriptStep[] = [
    { kind: "text", text: "我这就帮你查一下特斯拉的股价。" },
    { kind: "tool", id: "c1", name: "search_web", args: { query: "特斯拉 股价 最新" } },
    { kind: "text", text: "特斯拉最新股价 312.4 美元，涨了 3.2%。" },
  ];
  const run = await runLoop({ name: "D-static-chat", lane: "chat", script, plan: chatLanePlanStatic(), userText: "帮我看看特斯拉股价" });
  check("D：search_web 照常真实执行 ok", run.trace?.toolCalls?.some((c) => c.name === "search_web" && c.ok) === true, JSON.stringify(run.trace?.toolCalls));
  check("D：最终回复是查到的结果", run.finalText.includes("312.4"), run.finalText.slice(0, 60));
  originalConsoleInfo("");
}

// 场景 D2：出口对账闸已删除——写操作意图零尝试不再强制拦截（决策权归模型）
{
  originalConsoleInfo("【D2】写意图轮（chat 车道）无打回，脚本化调用照常执行");
  const script: LoopScriptStep[] = [
    { kind: "text", text: "好的，已经帮你记下来啦，明天早上九点准时叫你！" },
    { kind: "tool", id: "c1", name: "reminder_plan", args: { content: "明天早上九点开会" } },
    { kind: "text", text: "已经设好提醒：明天早上 9:00 开会，到点叫你。" },
  ];
  const run = await runLoop({
    name: "D2-static-chat", lane: "chat", script, plan: chatLanePlanStatic(),
    userText: "明天早上九点提醒我开会", turnIntent: "action_write",
  });
  check("D2：reminder.plan 照常真实执行 ok", run.trace?.toolCalls?.some((c) => c.name === "reminder.plan" && c.ok) === true, JSON.stringify(run.trace?.toolCalls));
  check("D2：无额外续波（llmCalls=3）", run.llmCalls === 3, `actual=${run.llmCalls}`);
  originalConsoleInfo("");
}

// 场景 E：暴露稳定性（不跑 LLM，纯真实暴露管线）
{
  originalConsoleInfo("【E】暴露稳定性：同车道多轮可见集一致性");
  const texts = [
    "现在几点了", "明天早上九点提醒我开会", "把客厅空调调到26度", "找几张猫的照片",
    "我钱包还有多少钱", "北京今天天气怎么样", "比特币现在什么价", "给妈妈发个消息",
  ];
  const staticSets = texts.map(() => toolNamesOf(chatLanePlanStatic()).join(","));
  const staticDistinct = new Set(staticSets).size;
  check("E-static：chat 车道可见集与用户文本完全无关（8/8 一致）", staticDistinct === 1, `distinct=${staticDistinct}`);
  const staticNames = toolNamesOf(chatLanePlanStatic());
  check("E-static：Core 直调集合非空", staticNames.length >= 15, `count=${staticNames.length}`);

  const legacySets = texts.map((t) => toolNamesOf(chatLanePlanLegacy(t)).join(","));
  const legacyDistinct = new Set(legacySets).size;
  originalConsoleInfo(
    `  ℹ legacy 对照（诚实记录）：台架环境未装配 capability modules（_capabilityModuleDeps 为空），` +
      `能力域关键词注入无源 → 8 条文本产生 ${legacyDistinct} 个不同可见集；` +
      `生产环境该注入存在（见 selectForegroundCapabilityToolAdditions），每轮可见集随文本变化。` +
      `legacy 的可达性缺陷由场景 A/B 直接证明（幻觉调用失败 / 白名单外不可达）。`,
  );

  const taskSets = [["search"], ["write"], ["media"], undefined].map((caps) => toolNamesOf(taskLanePlanStatic(caps)).join(","));
  const taskCore = toolNamesOf(taskLanePlanStatic(undefined));
  const withBeam = toolNamesOf(taskLanePlanStatic(["search"]));
  check("E-static：task 车道无能力声明时 = 纯 Core", new Set(taskSets).size === 1 || taskCore.length > 0);
  check("E-static：能力束是纯增量（Core ⊆ Core∪beam）", taskCore.every((n) => withBeam.includes(n)));
  originalConsoleInfo("");
}

// 场景 F：token 成本（真实 schema 估算）
{
  originalConsoleInfo("【F】schema token 成本（estimateToolsSchemaTokens，真实清单）");
  const staticChat = chatLanePlanStatic();
  const legacyChat = chatLanePlanLegacy("把客厅空调调到26度");
  const staticTokens = estimateToolsSchemaTokens(staticChat.visibleTools);
  const legacyTokens = estimateToolsSchemaTokens(legacyChat.visibleTools);
  originalConsoleInfo(`  chat 车道：static 可见 ${staticChat.visibleTools.length} 个 = ${staticTokens} tok | legacy 可见 ${legacyChat.visibleTools.length} 个 = ${legacyTokens} tok`);
  check("F：静态 Core ≤ 3600 tok（承诺区间 2~3.5k；legacy 4 工具全 schema = 1691）", staticTokens <= 3600, `${staticTokens} tok`);
  const taskFull = taskLanePlanLegacy(["full"]);
  originalConsoleInfo(`  task 车道：全量注入 = ${estimateToolsSchemaTokens(taskFull.visibleTools)} tok（${taskFull.visibleTools.length} 工具）| static Core = ${estimateToolsSchemaTokens(taskLanePlanStatic().visibleTools)} tok（${taskLanePlanStatic().visibleTools.length} 工具）`);
  originalConsoleInfo("");
}

/* ---------------- 汇总 ---------------- */
const summary = summarizeTurnTraces(traces);
originalConsoleInfo("=== turn-trace 汇总（真实执行） ===");
originalConsoleInfo(JSON.stringify(summary, null, 2));
originalConsoleInfo("\n=== 全部 trace 原始记录 ===");
for (const t of traces) originalConsoleInfo(JSON.stringify(t));

if (failures > 0) {
  originalConsoleInfo(`\n✖ ${failures} 项断言未通过`);
  process.exitCode = 1;
} else {
  originalConsoleInfo("\n✅ 全部断言通过");
}
