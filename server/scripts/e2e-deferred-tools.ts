/**
 * 延迟目录工具调用专项台架（2026-09-19）。
 *
 * 回答一个问题：不在静态 Core 清单里的长尾工具，改前/改后怎么被调用、成功率如何。
 * 每个工具测三条通道 + legacy 对照：
 *   A. 预召回 top-1（无往返）：prepareTools 按 userText 注入
 *   B. 请求卡转正（1 往返）：模型输出 <tool_request> → BM25 检索 → 轮内转正 → 原生调用
 *   C. discover 桥召回质量：tool_discover top-3 是否覆盖目标（两代架构共用的底层）
 *   D. legacy chat 对照：4 工具白名单下目标工具是否可见
 * 所有执行走真实 ToolRegistry；mock 的只有 LLM 脚本（请求卡后自动调用"本轮新转正的工具"）。
 */
import "dotenv/config";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PA_DATA_DIR = process.env.PA_DATA_DIR || mkdtempSync(join(tmpdir(), "pa-e2e-deferred-"));
process.env.AGENT_TOKENJUICE_ENABLED = "0";
process.env.AGENT_TOOL_SEARCH_ENABLED = "on";
process.env.AGENT_TOOL_SEARCH_EMBEDDING = "off";
process.env.AGENT_NEURAL_SIDECAR_URL = "http://127.0.0.1:1";

const { getBuiltinAgentChatTools, streamCompletionWithTools, selectForegroundCapabilityToolAdditions } =
  await import("../src/external-model/openai-compatible-tool-loop.js");
const { resolveChatToolPlanForStream } = await import("../src/external-model/resolve-chat-tools.js");
const { buildLaneCoreTools } = await import("../src/external-model/lane-tool-sets.js");
const { prepareTools, executeBridge } = await import("../src/gateway/index.js");
const { ToolRegistry } = await import("../src/tools/tool-registry.js");
const { TASK_DISPATCH_TOOL_DEFINITION } = await import("../src/tools/task-dispatch-tool.js");

const corpus: any[] = [...getBuiltinAgentChatTools(), TASK_DISPATCH_TOOL_DEFINITION];

// 7 个跨域延迟工具（均不在静态 chat Core 清单中）+ 触达它们的自然语句
const CASES: Array<{ tool: string; userText: string }> = [
  { tool: "calendar.update_task", userText: "帮我改一下后天的日程安排" },
  { tool: "geofence.create", userText: "到家的时候提醒我拿快递" },
  { tool: "care.set_important_date", userText: "记住我妈生日是5月20号" },
  { tool: "commitment.create", userText: "我答应了周五给你资料，帮我记一下这个承诺" },
  { tool: "vision.see_device", userText: "帮我看一下门口摄像头画面" },
  { tool: "wallet.transfer", userText: "给张三转500块钱" },
  { tool: "device.list", userText: "看看我现在有哪些绑定的在线设备" },
];

const registry = new ToolRegistry() as any;
for (const c of CASES) {
  registry.register(c.tool, async (input: any) => ({ ok: true, echo: input ?? {}, via: c.tool }));
}
const toolCtx = {
  executeTool: (name: string, args: Record<string, unknown>) =>
    registry.execute(name, args, { sessionId: "e2e-deferred" }),
};

function chatPlanStatic() {
  return resolveChatToolPlanForStream(undefined, {
    toolExposureProfile: "explicit",
    chatToolsBuiltin: buildLaneCoreTools("chat", corpus, [TASK_DISPATCH_TOOL_DEFINITION]),
    chatToolsExtra: corpus,
  } as any);
}
function chatPlanLegacy(userText?: string) {
  const LEGACY = ["reminder.plan", "calendar.create_from_text", "task.dispatch", "search_web"];
  const base = corpus.filter((t: any) => t.type === "function" && LEGACY.includes(t.function?.name));
  const additions = selectForegroundCapabilityToolAdditions(userText);
  const known = new Set(base.map((t: any) => t.function?.name));
  return resolveChatToolPlanForStream(userText, {
    toolExposureProfile: "explicit",
    chatToolsBuiltin: [...base, ...additions.filter((t: any) => t.type === "function" && !known.has(t.function?.name))],
    disableToolSearch: true,
  } as any);
}

const visibleNames = (plan: any) =>
  new Set(plan.visibleTools.map((t: any) => t.function?.name).filter(Boolean));

/* ────────── A. 预召回 top-1（无往返，静态架构专属） ────────── */
console.log("\n=== A. 预召回 top-1 注入（静态架构新增通道） ===");
let prerecallHit = 0;
for (const c of CASES) {
  const prepared = await prepareTools(chatPlanStatic().visibleTools, chatPlanStatic().searchableTools, { userText: c.userText });
  const hit = visibleNames(prepared).has(c.tool);
  if (hit) prerecallHit += 1;
  console.log(`  ${hit ? "✔" : "－"} ${c.tool}  userText="${c.userText}"`);
}
console.log(`  预召回直达率：${prerecallHit}/${CASES.length}`);

/* ────────── C. discover 桥召回质量（top-3，两代架构共用底层） ────────── */
console.log("\n=== C. tool_discover 桥 top-3 召回（延迟目录底层检索） ===");
let bridgeHit = 0;
{
  const prepared = await prepareTools(chatPlanStatic().visibleTools, chatPlanStatic().searchableTools, {});
  for (const c of CASES) {
    const res = await executeBridge("tool_discover", { query: c.userText, limit: 3 }, prepared.deferredCatalog);
    const names: string[] = ((res.result as any)?.matches ?? []).map((m: any) => m.name);
    const hit = names.includes(c.tool);
    if (hit) bridgeHit += 1;
    console.log(`  ${hit ? "✔" : "－"} ${c.tool}  top3=[${names.join(", ")}]`);
  }
  console.log(`  top-3 覆盖率：${bridgeHit}/${CASES.length}`);
}

/* ────────── B. 请求卡转正（静态架构） vs D. legacy chat 对照 ────────── */
console.log("\n=== B/D. 请求卡转正（静态） vs legacy 白名单可达性 ===");

async function runCardPath(c: { tool: string; userText: string }): Promise<{ fired: boolean; loaded: string[]; callOk: boolean; visible: boolean }> {
  const plan = chatPlanStatic();
  const before = visibleNames(plan);
  let step = 0;
  let prevTools = new Set<string>();
  const chunksFor = (kind: "card" | "call" | "text", payload: any) => {
    if (kind === "call") {
      return [
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: payload, arguments: "{}" } }] }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      ];
    }
    return [
      { choices: [{ delta: { content: payload }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ];
  };
  const client: any = {
    chat: { completions: { create: async (req: any) => {
      const names = new Set((req.tools ?? []).map((t: any) => t.function?.name));
      const newlyLoaded = [...names].filter((n) => !prevTools.has(n) && !before.has(n) && !["tool_discover", "tool_call"].includes(n));
      prevTools = names;
      step += 1;
      if (step === 1) return (async function* () { for (const ch of chunksFor("card", `<tool_request>${c.userText}</tool_request>`)) yield ch; })();
      if (newlyLoaded.length > 0) return (async function* () { for (const ch of chunksFor("call", newlyLoaded[0])) yield ch; })();
      return (async function* () { for (const ch of chunksFor("text", "办好了。")) yield ch; })();
    } } },
  };
  const { recordTurnTrace: _skip } = { recordTurnTrace: null } as any;
  let captured: any;
  const origInfo = console.info;
  console.info = (...a: unknown[]) => {
    const line = typeof a[0] === "string" ? a[0] : "";
    if (line.startsWith("[turn-trace] ")) { try { captured = JSON.parse(line.slice(13)); } catch { /* */ } }
    origInfo(...a);
  };
  try {
    await streamCompletionWithTools(
      client, "m",
      [{ role: "system", content: "s" }, { role: "user", content: c.userText }] as any,
      () => {}, toolCtx as any,
      { tools: plan.visibleTools, toolSearchSourceTools: plan.searchableTools, maxRounds: 4, audit: { sessionId: `deferred-${c.tool}`, stage: "main_chat_tools" } } as any,
    );
  } finally {
    console.info = origInfo;
  }
  return {
    fired: captured?.requestCard?.fired === true,
    loaded: captured?.requestCard?.loaded ?? [],
    alreadyVisible: captured?.requestCard?.alreadyVisible ?? [],
    callOk: captured?.toolCalls?.some((t: any) => t.name === c.tool && t.ok) === true,
    visible: before.has(c.tool),
  };
}

let cardReachable = 0;
let legacyReachable = 0;
let targetTop1 = 0;
for (const c of CASES) {
  const legacyPlan = chatPlanLegacy(c.userText);
  const legacyVisible = visibleNames(legacyPlan).has(c.tool);
  if (legacyVisible) legacyReachable += 1;
  const r = await runCardPath(c);
  // 到达 = 请求卡链路把"某个可用工具"交给模型（真实调用 ok，或 top-1 已在可见集被指回）
  const reachable = r.callOk || (r.fired && (r.loaded.length > 0 || (r.alreadyVisible?.length ?? 0) > 0));
  if (reachable) cardReachable += 1;
  // 目标命中 = 检索层 top-1 恰好是目标工具（检索精度，独立于链路）
  if (r.loaded[0] === c.tool || r.alreadyVisible?.[0] === c.tool) targetTop1 += 1;
  console.log(
    `  ${reachable ? "✔" : "✖"} ${c.tool}  卡触发=${r.fired} 转正=[${r.loaded.join(",") || "-"}] ` +
    `指回=[${(r.alreadyVisible ?? []).join(",") || "-"}] 调用=${r.callOk ? "ok" : "-"} | 目标命中=${r.loaded[0] === c.tool || r.alreadyVisible?.[0] === c.tool ? "是" : "否"} | legacy可见=${legacyVisible}`,
  );
}
console.log(`\n=== 汇总（真实执行） ===`);
console.log(`链路到达率（卡链路交付出可用工具）：${cardReachable}/${CASES.length}`);
console.log(`检索 top-1 目标命中率：${targetTop1}/${CASES.length}（不足部分 = BM25 词面检索精度问题，见报告）`);
console.log(`legacy chat 可见率：${legacyReachable}/${CASES.length}（0 通道 = 只能靠 task.dispatch 派后台）`);
console.log(`预召回直达：${prerecallHit}/${CASES.length}（零往返） | discover 桥 top-3：${bridgeHit}/${CASES.length}（一次往返）`);
