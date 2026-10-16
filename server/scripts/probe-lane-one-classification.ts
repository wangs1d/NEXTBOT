/**
 * 任务面「一次分类，处处消费」真链探针（2026-10-01 装配收敛配套）。
 *
 * 四轮真实 LLM（路由真调 + 生产同源工具循环），A/B 两装配对照：
 *   new（改后）：轻任务束确定性投影 / full 轮 travel 恒注入（生产现行为）
 *   old（改前）：任务轮一律纯桥（chatToolsBuiltin=[]，router-first 2026-09-23 形态，
 *                travel 靠 BM25 召回 + discover 往返）
 *   S1 realtime_lookup：断言改后首波直调真搜、零 discover 往返
 *   S2 media_retrieval：断言 search_images 首波直调
 *   S3 multi_step_task：断言 travel.plan-itinerary 恒可见且被真调（大理轮回归）
 *   S4 chat 对照：零工具直答
 * A/B 各自跑全场景，对比 waves / discover 往返 / LLM 输入 token（llm-token-audit 差分）。
 * 断言只对 new 变体强制；old 变体仅记录观察值。
 *
 * 唯一合成点：travel.plan-itinerary 返回固定行程骨架（大理轮事故断言的是
 * 「可见且被调用」，行程内容生产链另有真链覆盖）；search 族走真实上游。
 * 装配段镜像 agent-core 2026-10-01 分支（同函数同顺序），断言以 turn-trace 行为准。
 *
 * 用法：npx tsx scripts/probe-lane-one-classification.ts
 */
import "dotenv/config";
import { loadServerEnv } from "../src/config/load-server-env.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

loadServerEnv();

const scriptDir = dirname(fileURLToPath(import.meta.url));

const { createExternalChatProviderFromEnv } = await import("../src/external-model/resolve-provider.js");
const { routeTurnByLlm } = await import("../src/agent/llm-task-router.js");
const { toolsMatchingCapabilityBeam, slimToolSchema } = await import(
  "../src/external-model/lane-tool-sets.js"
);
const { dominantDomainForQuery } = await import("../src/tools/tool-search/index.js");
const { toolsInDomain } = await import("../src/tools/tool-search/tool-category.js");
const { getBuiltinAgentChatTools } = await import("../src/external-model/openai-compatible-tool-loop.js");
const { ToolRegistry } = await import("../src/tools/tool-registry.js");
const { InfoHubService } = await import("../src/services/info-hub-service.js");
const { UpstreamSearchService } = await import("../src/services/upstream-search-service.js");
const { createTravelPlanningBuiltinSkills } = await import(
  "../src/skills/travel-planning/travel-planning-skills.js"
);
const { skillManifestToChatTool } = await import("../src/skills/skill-openai-bridge.js");
import type { ChatCompletionTool } from "openai/resources/chat/completions";

/** travel 规划族进生产语料走 bootstrap 注册链；探针同源构造（manifest→chat tool）。 */
function buildTravelChatTools(): ChatCompletionTool[] {
  const skills = createTravelPlanningBuiltinSkills({ travelPlanningService: {} } as never);
  return skills.map((s) =>
    skillManifestToChatTool({ ...s.metadata, enabled: true, trusted: true } as never),
  );
}

// ── trace 捕获：截获 console.info 抓 [turn-trace] / [tool-search] / 预召回行 ──
type TraceRec = Record<string, unknown>;
const turnTraces: TraceRec[] = [];
const toolSearchLines: string[] = [];
const origInfo = console.info;
console.info = (...args: unknown[]) => {
  const line = args.map(String).join(" ");
  if (line.startsWith("[turn-trace] ")) {
    try {
      turnTraces.push(JSON.parse(line.slice("[turn-trace] ".length)) as TraceRec);
    } catch {
      /* 忽略非 JSON 行 */
    }
    return;
  }
  if (line.startsWith("[tool-search] ")) toolSearchLines.push(line);
  origInfo(...args);
};

function toolName(t: ChatCompletionTool): string {
  return t.type === "function" ? (t.function?.name ?? "") : "";
}

// ── 真实执行器：search 族走生产上游；travel 是唯一合成点 ──
function buildToolContext() {
  const infoHub = new InfoHubService();
  const upstream = new UpstreamSearchService(infoHub);
  const registry = new ToolRegistry() as any;
  registry.register("search_web", async (input: any) =>
    upstream.searchWeb(String(input?.query ?? ""), Math.min(8, Number(input?.limit) || 8)));
  registry.register("search_images", async (input: any) =>
    upstream.searchImages(String(input?.query ?? ""), Math.min(6, Number(input?.limit) || 4), "lane-probe"));
  registry.register("fetch_web", async () => ({ ok: false, result: { error: "probe: fetch_web 未接" } }));
  registry.register("deep_search", async (input: any) =>
    upstream.searchWeb(String(input?.query ?? ""), Math.min(8, Number(input?.limit) || 8)));
  registry.register("travel.plan-itinerary", async () => ({
    ok: true,
    result: {
      destination: "大理",
      days: 2,
      itinerary: [
        { day: 1, items: ["洱海生态廊道", "大理古城"] },
        { day: 2, items: ["崇圣寺三塔", "喜洲古镇"] },
      ],
    },
  }));
  // 域卡让模型"看见"全族并按名直呼——桩须同族齐备（生产这些工具都有真执行器），
  // 否则直呼全 fail 会诱发重试循环，测的是桩不是架构。
  for (const [n, r] of [
    ["travel.search-poi", { ok: true, result: { pois: [{ name: "洱海生态廊道", rating: 4.7 }, { name: "崇圣寺三塔", rating: 4.6 }] } }],
    ["travel.destination-info", { ok: true, result: { destination: "大理", best_season: "3-5月", tips: "紫外线强，注意防晒" } }],
    ["travel.compute-route", { ok: true, result: { distance_km: 35, duration_min: 55 } }],
  ] as const) {
    registry.register(n, async () => r);
  }
  const stub = async (name: string) => ({ ok: false, result: { error: `probe: ${name} 未接执行器` } });
  for (const name of [
    "hot_rankings", "internet.research", "info.inspect_webpage", "info.navigate_site",
    "weather.get_local", "reminder.plan", "calendar.create_from_text", "calendar.list_tasks",
    "messages.overview", "messages.reply", "world.link.send_message", "clock.get_current_time",
    "clock.get_user_location", "browser.session.list", "code.run", "code.write_file",
    "code.read_file", "brain.recall", "agent.query_capabilities", "self.list_custom_skills",
    "perception.overview", "wallet.get_balance", "wallet.get_transactions", "surface.show",
    "task.dispatch", "task.status", "task.cancel", "obs_recall",
  ]) {
    registry.register(name, () => stub(name));
  }
  return registry;
}

type ScenarioResult = {
  case: string;
  userText: string;
  intent?: string;
  capabilities?: string[];
  visibleFirstWave: string[];
  toolCalls: string[];
  waves: number;
  okCalls: number;
  bridgeRounds: number;
  replyHead: string;
  assertions: { name: string; pass: boolean; detail: string }[];
};

async function runScenario(
  label: string,
  userText: string,
  expect: { intent: string; capabilities: string[] },
  variant: "new" | "old",
): Promise<ScenarioResult> {
  const provider = createExternalChatProviderFromEnv();
  const registry = buildToolContext();
  const corpus: ChatCompletionTool[] = [...getBuiltinAgentChatTools(), ...buildTravelChatTools()];

  // 生产同源路由（真 LLM）
  const decision = await routeTurnByLlm(provider, `lane-probe::${label}`, userText);
  const turnPlan = {
    plane: decision.plane,
    capabilities: decision.capabilities,
    budget: decision.budget,
    tier: decision.tier,
  };

  // 装配段镜像 agent-core 2026-10-01 分支（同函数同顺序）；variant=old 复现
  // 改前形态：任务轮一律纯桥（可见集空，业务工具全在延迟目录）。
  let chatToolsBuiltin: ChatCompletionTool[];
  let mode: "chat" | "task";
  if (decision.plane === "chat") {
    mode = "chat";
    chatToolsBuiltin = [];
  } else if (variant === "old") {
    mode = "task";
    chatToolsBuiltin = [];
  } else if (decision.capabilities.length > 0 && !decision.capabilities.includes("full")) {
    mode = "task";
    chatToolsBuiltin = toolsMatchingCapabilityBeam(corpus, decision.capabilities).map(slimToolSchema);
  } else {
    mode = "task";
    // 镜像 agent-core 2026-10-01 S2 域信号预载
    const domain = dominantDomainForQuery(userText, corpus);
    chatToolsBuiltin = domain
      ? toolsInDomain(corpus, domain).slice(0, 12).map(slimToolSchema)
      : [];
  }

  const tracesBefore = turnTraces.length;
  const t0 = Date.now();
  let full = "";
  if (mode === "chat") {
    full = await provider.streamCompletion(`lane-probe::${label}`, { text: userText }, (d) => {
      full += d;
    });
  } else {
    full = await provider.streamCompletion(
      `lane-probe::${label}`,
      { text: userText },
      () => {},
      { executeTool: (name: string, args: Record<string, unknown>) =>
          (registry as any).execute(name, args, { sessionId: `lane-probe::${label}`, agentAccessMode: "standard" }) },
      {
        toolExposureProfile: "explicit",
        chatToolsBuiltin,
        chatToolsExtra: corpus,
        turnIntent: decision.intent,
        maxRounds: decision.budget || 3,
        audit: { sessionId: `lane-probe::${label}`, stage: "task_plane_light" },
      } as any,
    );
  }
  const wallMs = Date.now() - t0;

  const myTraces = turnTraces.slice(tracesBefore);
  const last = myTraces[myTraces.length - 1] ?? {};
  const calls = (last.toolCalls as { name: string; ok: boolean }[] | undefined) ?? [];
  const visible = chatToolsBuiltin.map(toolName);
  let bridgeRounds = 0;

  const assertions: ScenarioResult["assertions"] = [];
  const add = (name: string, pass: boolean, detail: string) => {
    if (variant === "new") assertions.push({ name, pass, detail });
  };

  add("intent", decision.intent === expect.intent, `route=${decision.intent}/${decision.confidence?.toFixed?.(2)}`);
  if (mode === "task") {
    if (variant === "new") {
      add(
        "capabilities",
        JSON.stringify([...decision.capabilities].sort()) === JSON.stringify([...expect.capabilities].sort()),
        `caps=${decision.capabilities.join("+")}`,
      );
    }
    const okCalls = calls.filter((c) => c.ok).length;
    if (variant === "new") {
      add("real_tool_ok", okCalls > 0, `calls=${calls.map((c) => `${c.name}:${c.ok ? "ok" : "fail"}`).join(",") || "none"}`);
    }
    const discoverRounds = calls.filter((c) => c.name === "tool_discover" || c.name === "tool_call").length;
    if (expect.capabilities.length > 0 && !expect.capabilities.includes("full")) {
      if (variant === "new") {
        add(
          "beam_visible_wave1",
          visible.length > 0 && discoverRounds === 0,
          `visible=${visible.join(",")} bridgeRounds=${discoverRounds}`,
        );
      }
    } else if (variant === "new") {
      // full 轮：travel 规划族恒注入 + 真被调用（大理轮回归）
      // 域信号预载校验：词面浓度达阈值（travel 5/5）时族必须可见（s3 原硬编码场景的泛化回归）
      add(
        "domain_preload",
        visible.includes("travel.plan-itinerary"),
        `visible=${visible.join(",")}`,
      );
      add("travel_called", calls.some((c) => c.name === "travel.plan-itinerary" && c.ok), `calls=${calls.map((c) => c.name).join(",")}`);
    }
    bridgeRounds = discoverRounds;
  } else if (variant === "new") {
    add("zero_tool_direct", calls.length === 0, `calls=${calls.length}`);
  }

  return {
    case: label,
    userText,
    intent: decision.intent,
    capabilities: decision.capabilities,
    visibleFirstWave: visible,
    toolCalls: calls.map((c) => `${c.name}:${c.ok ? "ok" : "fail"}`),
    waves: Number(last.waves ?? 0),
    okCalls: calls.filter((c) => c.ok).length,
    bridgeRounds,
    replyHead: full.slice(0, 120).replace(/\s+/g, " "),
    assertions,
  };
}

const CASES = [
  { label: "s1-realtime", text: "比特币现在什么价格", expect: { intent: "realtime_lookup", capabilities: ["search"] } },
  { label: "s2-media", text: "找几张柴犬的高清壁纸", expect: { intent: "media_retrieval", capabilities: ["media", "search"] } },
  { label: "s3-travel", text: "帮我规划一个大理两日游行程", expect: { intent: "multi_step_task", capabilities: ["full"] } },
  { label: "s4-chat", text: "最近工作有点累，唉", expect: { intent: "chat", capabilities: [] } },
];

async function runVariant(variant: "new" | "old"): Promise<ScenarioResult[]> {
  const { getLlmUsageSummary } = await import("../src/services/llm-token-audit.js");
  const auditBefore = getLlmUsageSummary().reduce(
    (acc, s) => ({ calls: acc.calls + s.apiCalls, input: acc.input + (s.apiInputTokens ?? 0) }),
    { calls: 0, input: 0 },
  );
  const results: ScenarioResult[] = [];
  for (const c of CASES) {
    results.push(await runScenario(c.label, c.text, c.expect, variant));
  }
  const after = getLlmUsageSummary().reduce(
    (acc, s) => ({ calls: acc.calls + s.apiCalls, input: acc.input + (s.apiInputTokens ?? 0) }),
    { calls: 0, input: 0 },
  );
  // 变体级差分挂在每行第一项（聚合值单独输出）
  (results as (ScenarioResult & { variantLlmCalls?: number; variantLlmInputTokens?: number })[])[0].variantLlmCalls =
    after.calls - auditBefore.calls;
  (results as (ScenarioResult & { variantLlmInputTokens?: number })[])[0].variantLlmInputTokens =
    after.input - auditBefore.input;
  return results;
}

async function main() {
  const oldRows = await runVariant("old");
  const newRows = await runVariant("new");
  const allPass = newRows.every((r) => r.assertions.every((a) => a.pass));
  const cmp = CASES.map((c) => {
    const o = oldRows.find((r) => r.case === c.label)!;
    const n = newRows.find((r) => r.case === c.label)!;
    return {
      case: c.label,
      waves: `${o.waves} -> ${n.waves}`,
      bridgeRounds: `${o.bridgeRounds} -> ${n.bridgeRounds}`,
      tools: `${o.toolCalls.length} -> ${n.toolCalls.length}`,
      okCalls: `${o.okCalls} -> ${n.okCalls}`,
    };
  });
  const o0 = oldRows[0] as ScenarioResult & { variantLlmCalls?: number; variantLlmInputTokens?: number };
  const n0 = newRows[0] as ScenarioResult & { variantLlmCalls?: number; variantLlmInputTokens?: number };
  console.log(`[lane-probe] A/B 对比（old -> new）:`);
  for (const row of cmp) {
    console.log(
      `  ${row.case}: waves ${row.waves} | 桥往返 ${row.bridgeRounds} | 工具调用 ${row.tools} | 成功 ${row.okCalls}`,
    );
  }
  console.log(
    `  变体级 LLM: apiCalls ${o0.variantLlmCalls} -> ${n0.variantLlmCalls} | inputTokens ${o0.variantLlmInputTokens} -> ${n0.variantLlmInputTokens}`,
  );
  const summary = {
    label: "lane-one-classification-probe",
    allPass,
    toolSearchTrace: toolSearchLines,
    comparison: cmp,
    variantAggregate: {
      old: { llmApiCalls: o0.variantLlmCalls, inputTokens: o0.variantLlmInputTokens },
      new: { llmApiCalls: n0.variantLlmCalls, inputTokens: n0.variantLlmInputTokens },
    },
    rows: { old: oldRows, new: newRows },
  };
  const outDir = join(scriptDir, "results");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `lane-classification-probe-${Date.now()}.json`);
  writeFileSync(outPath, JSON.stringify(summary, null, 2), "utf8");
  for (const r of newRows) {
    const fails = r.assertions.filter((a) => !a.pass);
    console.log(
      `[lane-probe] new ${r.case}: intent=${r.intent} waves=${r.waves} tools=[${r.toolCalls.join(",") || "-"}] ` +
        `${fails.length === 0 ? "PASS" : "FAIL " + fails.map((f) => `${f.name}(${f.detail})`).join(";")}`,
    );
  }
  console.log(`\n[lane-probe] 总判定：${allPass ? "ALL PASS" : "HAS FAIL"}；明细 → ${outPath}`);
  console.info = origInfo;
  process.exit(allPass ? 0 : 1);
}

main().catch((err) => {
  console.error("[lane-probe] 探针异常:", err);
  process.exit(2);
});
