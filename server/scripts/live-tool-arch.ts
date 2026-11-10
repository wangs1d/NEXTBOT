/**
 * 真实 LLM 小样本验证（2026-09-19 静态双车道改造）。
 *
 * 与 e2e-tool-arch.ts 的区别：LLM 不再 mock——用 OPENAI_API_KEY 打真实端点，
 * 验证"静态暴露 + 请求卡 + 出口检查"在真实模型行为下工具是否被正常调用。
 * 每次 run 都采集 [turn-trace] 真实记录；同一场景重复 3 次测一致性。
 *
 * 用法：
 *   npx tsx scripts/live-tool-arch.ts --model gpt-4o-mini --repeat 3
 *   npx tsx scripts/live-tool-arch.ts --base-url https://api.deepseek.com/v1 \
 *     --api-key-env OPENAI_API_KEY --model deepseek-chat
 */
import "dotenv/config";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PA_DATA_DIR = process.env.PA_DATA_DIR || mkdtempSync(join(tmpdir(), "pa-live-tool-arch-"));
process.env.AGENT_TOKENJUICE_ENABLED = "0";
process.env.AGENT_TOOL_SEARCH_ENABLED = "on";
process.env.AGENT_TOOL_SEARCH_EMBEDDING = "off";
process.env.AGENT_NEURAL_SIDECAR_URL = "http://127.0.0.1:1";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}
const MODEL = arg("model", "gpt-4o-mini");
const REPEAT = Math.max(1, Number(arg("repeat", "3")));
const BASE_URL = arg("base-url", process.env.OPENAI_BASE_URL || "");
const API_KEY = process.env[arg("api-key-env", "OPENAI_API_KEY")] || "";

const { getBuiltinAgentChatTools } = await import("../src/external-model/openai-compatible-tool-loop.js");
const { streamCompletionWithTools, selectForegroundCapabilityToolAdditions } = await import("../src/external-model/openai-compatible-tool-loop.js");
const { resolveChatToolPlanForStream } = await import("../src/external-model/resolve-chat-tools.js");
const { buildLaneCoreTools, toolsMatchingCapabilityBeam } = await import("../src/external-model/lane-tool-sets.js");
const { ToolRegistry } = await import("../src/tools/tool-registry.js");
const { TASK_DISPATCH_TOOL_DEFINITION } = await import("../src/tools/task-dispatch-tool.js");
const { recordTurnTrace, summarizeTurnTraces } = await import("../src/external-model/turn-trace.js");
import type { TurnTraceRecord } from "../src/external-model/turn-trace.js";
import OpenAI from "openai";

const corpus: any[] = [...getBuiltinAgentChatTools(), TASK_DISPATCH_TOOL_DEFINITION];

const registry = new ToolRegistry() as any;
registry.register("clock.get_current_time", async () => ({
  iso: new Date().toISOString(), timezone: "Asia/Shanghai",
}));
registry.register("search_web", async (input: any) => ({
  results: [
    { title: "结果 1", snippet: `「${input?.query ?? ""}」的抓取摘要（live 台架 fixture，非真实互联网数据）。`, url: "https://example.com/1" },
  ],
}));
registry.register("smart_home.control_device", async (input: any) => ({
  ok: true, deviceId: "livingroom_ac", temperature: input?.temperature ?? 26,
}));
registry.register("calendar.create", async (input: any) => ({
  ok: true, nextRunAtLocal: "2026-09-20T09:00:00+08:00", echo: input ?? {},
}));
registry.register("weather.get_local", async () => ({ city: "上海", condition: "多云", tempC: 24 }));
registry.register("smart_home.list_devices", async () => ({
  devices: [{ id: "livingroom_ac", name: "客厅空调", type: "air_conditioner", online: true }],
}));
const toolCtx = {
  executeTool: (name: string, args: Record<string, unknown>) =>
    registry.execute(name, args, { sessionId: "live-tool-arch" }),
};

// 生产同款前台角色指引（含工具纪律与请求卡协议）——live 验证必须镜像生产 prompt，
// 否则测的是"极简 prompt 下的模型"而非生产链路。
const { FOREGROUND_ROLE_GUIDANCE } = await import("../src/services/agent-core.js") as any;

// AGENT_TOOL_ARCH=legacy 时跑旧暴露链路（4 工具白名单 + 零延迟目录 / delegate 能力束裁剪），
// 与静态架构同条件对照。
const ARCH = (process.env.AGENT_TOOL_ARCH ?? "static") === "legacy" ? "legacy" : "static";
const LEGACY_CHAT_WHITELIST_NAMES = ["calendar.create", "calendar.create", "task.dispatch", "search_web"];

function chatPlanLegacy(userText?: string) {
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
function taskPlanLegacy(capabilities?: string[]) {
  return resolveChatToolPlanForStream("查询", {
    toolExposureProfile: "delegate",
    toolCapabilities: capabilities,
    chatToolsBuiltin: corpus,
  } as any);
}

if (!API_KEY || API_KEY.length < 10) {
  console.error("API key 未配置，无法做真实 LLM 验证");
  process.exit(1);
}
const client = new OpenAI({
  apiKey: API_KEY,
  ...(BASE_URL ? { baseURL: BASE_URL } : {}),
  timeout: 120_000,
  maxRetries: 1,
});

const traces: TurnTraceRecord[] = [];
const originalConsoleInfo = console.info;
console.info = (...args: unknown[]) => {
  const line = typeof args[0] === "string" ? args[0] : "";
  if (line.startsWith("[turn-trace] ")) {
    try { traces.push(JSON.parse(line.slice("[turn-trace] ".length))); } catch { /* ignore */ }
  }
  originalConsoleInfo(...args);
};

const chatPlanStatic = () =>
  resolveChatToolPlanForStream(undefined, {
    toolExposureProfile: "explicit",
    chatToolsBuiltin: buildLaneCoreTools("chat", corpus, [TASK_DISPATCH_TOOL_DEFINITION]),
    chatToolsExtra: corpus,
  } as any);
function taskPlanStatic(capabilities?: string[]) {
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

const SCENARIOS: Array<{
  name: string; lane: "chat" | "task"; userText: string;
  /** 期望被调用的工具集合：任一命中即算该场景的工具调用成功（都是合理的工具选择） */
  expectAny: string[]; caps?: string[]; turnIntent?: string;
}> = [
  { name: "core直调-时钟", lane: "chat", userText: "现在几点了？", expectAny: ["clock.get_current_time"], turnIntent: undefined },
  { name: "core直调-提醒", lane: "chat", userText: "明天早上九点提醒我开会", expectAny: ["calendar.create"], turnIntent: "action_write" },
  { name: "预召回+请求卡-智能家居", lane: "chat", userText: "把客厅空调调到26度", expectAny: ["smart_home.control_device"], turnIntent: "action_write" },
  { name: "task-天气/搜索", lane: "task", userText: "上海今天会下雨吗", expectAny: ["search_web", "weather.get_local"], caps: ["search"] },
];

const results: Array<Record<string, unknown>> = [];
for (const sc of SCENARIOS) {
  const plan =
    ARCH === "legacy"
      ? sc.lane === "chat"
        ? chatPlanLegacy(sc.userText)
        : taskPlanLegacy(sc.caps)
      : sc.lane === "chat"
        ? chatPlanStatic()
        : taskPlanStatic(sc.caps);
  const systemPrompt =
    sc.lane === "chat"
      ? `你是用户的私人助理。当前时间 2026-09-19 15:00，用户在上海。\n\n${FOREGROUND_ROLE_GUIDANCE}`
      : "你是用户的私人助理，负责完成用户交办的事务。当前时间 2026-09-19 15:00，用户在上海。要办事就调用工具真正完成，基于真实结果回复；办不到就如实说明，不要编造。";
  for (let i = 0; i < REPEAT; i++) {
    const before = traces.length;
    const t0 = Date.now();
    // 每轮整体硬超时：中转端点流式响应可能"头已到、身体挂住"，
    // SDK timeout 管不到 body 阶段，必须用 signal 贯穿整轮。
    const turnSignal = AbortSignal.timeout(150_000);
    try {
      const finalText = await streamCompletionWithTools(
        client as never,
        MODEL,
        [
          { role: "system", content: systemPrompt },
          { role: "user", content: sc.userText },
        ],
        () => {},
        toolCtx as never,
        {
          tools: plan.visibleTools,
          toolSearchSourceTools: plan.searchableTools,
          maxRounds: 4,
          signal: turnSignal,
          turnIntent: sc.turnIntent,
          audit: { sessionId: `live-${sc.name}-${i}`, stage: sc.lane === "chat" ? "main_chat_tools" : "task_plane_full" },
        } as any,
      );
      const trace = traces[traces.length - 1];
      const toolCalled = trace?.toolCalls?.some((c) => sc.expectAny.includes(c.name)) ?? false;
      const toolOk = trace?.toolCalls?.some((c) => sc.expectAny.includes(c.name) && c.ok) ?? false;
      results.push({
        scenario: sc.name, run: i,
        toolCalled, toolOk,
        waves: trace?.waves, calls: trace?.toolCalls?.length,
        requestCard: trace?.requestCard?.fired === true,
        durationMs: Date.now() - t0,
        finalTextHead: String(finalText).slice(0, 50),
      });
      void before;
    } catch (err) {
      results.push({ scenario: sc.name, run: i, error: String(err).slice(0, 200), durationMs: Date.now() - t0 });
    }
  }
}

originalConsoleInfo(`\n=== 真实 LLM 验证（model=${MODEL}, repeat=${REPEAT}） ===`);
for (const r of results) originalConsoleInfo(JSON.stringify(r));
const byScenario = new Map<string, typeof results>();
for (const r of results) {
  const list = byScenario.get(r.scenario as string) ?? [];
  list.push(r);
  byScenario.set(r.scenario as string, list);
}
originalConsoleInfo("\n=== 按场景汇总（真实数据） ===");
for (const [name, list] of byScenario) {
  const okCount = list.filter((r) => (r as any).toolOk).length;
  originalConsoleInfo(`  ${name}: 工具调用成功率 ${okCount}/${list.length}`);
}
originalConsoleInfo(`\ntrace 汇总: ${JSON.stringify(summarizeTurnTraces(traces))}`);
