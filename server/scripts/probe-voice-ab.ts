/**
 * 语感 A/B 真链探针（参照 probe-confirm-round.ts 骨架）。
 *
 * 同一生产同源 system prompt（kernel 薄身份 + finalize 后缀 + 【人格】 +
 * 职责块 + mood），仅切换一个变量做前后对比：
 *  - before 臂：不注入【人格】正文（soul 缺席的裸形态），带工具说明与办事职责块
 *  - after   臂：注入 buildPersonaPrompt() 的唯一人格正文，纯闲聊零工具 +
 *    CHAT_LEISURE 职责块 + chatLaneSampling
 *
 * 用法：npx tsx scripts/probe-voice-ab.ts [--repeats=1] [--arm=after|both] [--tags=称呼,闲聊] [--custom=p1|p2]
 */
import "dotenv/config";
import { loadServerEnv } from "../src/config/load-server-env.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

loadServerEnv();

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repeats = Number.parseInt(process.argv.find((a) => a.startsWith("--repeats="))?.slice(10) ?? "1", 10) || 1;
// 定点回归：--arm=after|both（缺省 both）、--tags=tag1,tag2（只跑指定题）、
// --custom=p1|p2（临时题，不进冻结语感集）
const armArg = (process.argv.find((a) => a.startsWith("--arm="))?.slice(6) ?? "both") as "both" | "after" | "before";
const tagsArg = process.argv.find((a) => a.startsWith("--tags="))?.slice(7) ?? "";
const tagFilter = new Set(tagsArg.split(",").map((t) => t.trim()).filter(Boolean));
const customArg = process.argv.find((a) => a.startsWith("--custom="))?.slice(9) ?? "";
// --provider=minimax|openai|moonshot-kimi：临时切外部模型（必须在 resolve-provider
// import 之前赋值，dotenv 加载完后的最终值）
const providerArg = process.argv.find((a) => a.startsWith("--provider="))?.slice(11) ?? "";

const { createExternalChatProviderFromEnv } = await import("../src/external-model/resolve-provider.js");
const { getRuntimeKernel } = await import("../src/agent/runtime-kernel.js");
const { FOREGROUND_ROLE_GUIDANCE, CHAT_LEISURE_ROLE_GUIDANCE } = await import("../src/agent/lane-role-guidance.js");
const { buildPersonaMoodBlock, resolvePersonaMood } = await import("../src/agent/persona-core.js");
const { buildPersonaPrompt } = await import("../src/agent/soul-store.js");
const { finalizeChatSystemPrompt } = await import("../src/agent/prompt-builder.js");
const { buildLaneCoreTools } = await import("../src/external-model/lane-tool-sets.js");
const { getBuiltinAgentChatTools } = await import("../src/external-model/openai-compatible-tool-loop.js");
const { TASK_DISPATCH_TOOL_DEFINITION } = await import("../src/tools/task-dispatch-tool.js");
const { TASK_CANCEL_TOOL_DEFINITION, TASK_STATUS_TOOL_DEFINITION } = await import("../src/tools/task-plane-tools.js");
const { PERCEPTION_OVERVIEW_TOOL_DEFINITION } = await import("../src/tools/perception-tools.js");
const { ToolRegistry } = await import("../src/tools/tool-registry.js");
const { InfoHubService } = await import("../src/services/info-hub-service.js");
const { UpstreamSearchService } = await import("../src/services/upstream-search-service.js");

// ── 20 题语感集（方案 E 留档；每版本同集回归，防悄悄回退）──
type Case = { tag: string; text: string; expect: string };
const CASES: Case[] = [
  { tag: "称呼", text: "以后叫我王哥", expect: "顺着接住称呼，像熟人" },
  { tag: "闲聊", text: "周末好无聊", expect: "接话茬给方向，不说教" },
  { tag: "疲惫", text: "今天加班到现在才吃上饭", expect: "先关心吃饭，短" },
  { tag: "吐槽", text: "游戏输了一晚上", expect: "接梗损一句，不上价值" },
  { tag: "情绪", text: "感觉最近啥都不顺", expect: "先接情绪再给角度" },
  { tag: "好奇", text: "哈哈哈你看这个截图", expect: "要图，口吻起哄" },
  { tag: "求助", text: "你说我这项目还有戏吗", expect: "有立场，反问卡点" },
  { tag: "深夜", text: "好困但是不想睡", expect: "损一句带收尾" },
  { tag: "惊吓", text: "刚才吓死我了", expect: "先问人没事吧" },
  { tag: "天气", text: "今天天气真好", expect: "带行动建议，不平铺" },
  { tag: "周一", text: "又是周一", expect: "一句共苦，不灌鸡汤" },
  { tag: "搞笑", text: "刚看到一个特别好笑的视频", expect: "要看，口气松" },
  { tag: "想家", text: "有点想家了", expect: "落在具体动作上" },
  { tag: "考试", text: "明天要考试好紧张", expect: "接住紧张，给一句实用的" },
  { tag: "戒烟", text: "我终于把烟戒了", expect: "捧场 + 给替代方案" },
  { tag: "存钱", text: "最近存不下钱", expect: "给一个抓手，不开课" },
  { tag: "放假", text: "好想放假", expect: "短共情 + 盘计划" },
  { tag: "鸽子", text: "我朋友放我鸽子", expect: "站用户这边，损事不损人" },
  { tag: "正事·零梗", text: "明天早上8点提醒我吃药", expect: "当场办妥一两句确认，零梗零玩笑" },
  { tag: "梗诱导·克制", text: "来点网络热梗听听", expect: "可给一两个，不堆梗不报菜名" },
];

function buildToolContext() {
  const infoHub = new InfoHubService();
  const upstream = new UpstreamSearchService(infoHub);
  const registry = new ToolRegistry() as any;
  const stub = async (name: string) => ({ ok: false, result: { error: `probe: ${name} 未接执行器` } });
  for (const name of [
    "calendar.create", "calendar.create", "calendar.create",
    "clock.get_current_time", "clock.get_user_location", "search_web", "search_images",
    "calendar.list_tasks", "task.dispatch", "task.status", "task.cancel",
  ]) {
    registry.register(name, stub.bind(null, name));
  }
  const calls: Array<{ name: string; ok: boolean }> = [];
  const toolCtx = {
    executeTool: async (name: string, args: Record<string, unknown>) => {
      let r: { ok: boolean; result: Record<string, unknown> };
      try {
        const out = await registry.execute(name, args, { actorId: "voice-probe" });
        r = { ok: Boolean(out?.ok), result: (out?.result ?? {}) as Record<string, unknown> };
      } catch (err) {
        r = { ok: false, result: { error: err instanceof Error ? err.message : String(err) } };
      }
      calls.push({ name, ok: r.ok });
      return r;
    },
  };
  return { toolCtx, calls };
}

type Row = { arm: string; tag: string; user: string; reply: string; tools: string[]; chars: number };

async function runArm(
  provider: any,
  arm: "before" | "after",
): Promise<Row[]> {
  const kernel = getRuntimeKernel();
  const identity = kernel.buildSessionSystem() ?? "";
  const mood = buildPersonaMoodBlock(
    resolvePersonaMood({ tier: 2, isTaskPlane: false }),
  );
  // before 臂带工具说明（生产 tools:true 路径）；after 臂纯闲聊零工具（tools:false，
  // 与生产 chatLanePureChat 轮 provider 侧 finalizeOptions.tools=false 同源）。
  const baseSystem = finalizeChatSystemPrompt(identity, { tools: arm !== "after" });
  const parts = [baseSystem];
  // 唯一人格出口：after 臂注入 buildPersonaPrompt()，before 臂整块缺席
  if (arm === "after") parts.push(buildPersonaPrompt({}));
  // 职责块（2026-10-06 补注入，此前探针漏带导致职责治理测不出）：
  // before 臂 = 生产 FOREGROUND 版（办事导向）；after 臂纯闲聊 = CHAT_LEISURE 版。
  parts.push(arm === "after" ? CHAT_LEISURE_ROLE_GUIDANCE : FOREGROUND_ROLE_GUIDANCE);
  const systemPrompt = parts.filter(Boolean).join("\n\n");

  const tools = buildLaneCoreTools("chat", getBuiltinAgentChatTools() as any, [
    TASK_DISPATCH_TOOL_DEFINITION,
    TASK_STATUS_TOOL_DEFINITION,
    TASK_CANCEL_TOOL_DEFINITION,
    PERCEPTION_OVERVIEW_TOOL_DEFINITION,
  ] as any);

  const rows: Row[] = [];
  const customCases: Case[] = customArg
    .split("|")
    .map((t, i) => ({ tag: `自定义#${i + 1}`, text: t.trim(), expect: "临时题" }))
    .filter((c) => c.text);
  const cases = [
    ...(customCases.length > 0 ? customCases : CASES.filter((c) => tagFilter.size === 0 || tagFilter.has(c.tag))),
  ];
  for (const c of cases) {
    for (let i = 0; i < repeats; i += 1) {
      const { toolCtx, calls } = buildToolContext();
      const sessionId = `voice-probe-${arm}-${Date.now()}-${rows.length}`;
      const isTaskish = c.tag.startsWith("正事");
      const userText = `${isTaskish ? "【人格·状态：严肃】\n零调侃，直接办，先结果后过程。" : mood}\n\n${c.text}`;
      let reply = "";
      try {
        // after 臂模拟 agent-core 纯闲聊轮硬隔离（2026-10-06 生产置位同源）：
      // 零工具（toolExposureProfile "none"）+ chatLanePureChat（裁展示协议）。
      // before 臂保持工具+协议全量，对比"推销助手腔"的消失。
      const pureChat = arm === "after";
      reply = await provider.streamCompletion(
        sessionId,
        { text: userText },
        () => {},
        toolCtx as never,
        {
          turnIntent: "chat",
          // 探针自带完整 system（身份+人格+职责+协议），绕过 provider 内记忆拼装
          systemPromptOverride: systemPrompt,
          ...(pureChat
            ? {
                toolExposureProfile: "none",
                chatLanePureChat: true,
                chatLaneSampling: true,
              }
            : {
                toolExposureProfile: "explicit",
                chatToolsBuiltin: tools,
                chatToolsExtra: getBuiltinAgentChatTools() as any,
                toolLoop: { maxRounds: 2 },
              }),
        } as never,
      );
      } catch (err) {
        console.error(`[voice-probe] ${arm} ${c.tag}#${i} 失败：${err instanceof Error ? err.message : err}`);
      }
      provider.clearSession?.(sessionId);
      const toolsUsed = calls.map((x) => x.name).join(",");
      rows.push({ arm, tag: c.tag, user: c.text, reply: reply.trim(), tools: toolsUsed ? [toolsUsed] : [], chars: reply.trim().length });
      console.log(`\n──── [${arm}] ${c.tag} ────`);
      console.log(`用户：${c.text}`);
      console.log(`agent：${reply.trim() || "（空）"}`);
    }
  }
  return rows;
}

async function main(): Promise<void> {
  // provider 切换必须在所有动态 import（含 dotenv 副作用）之后、创建之前赋值，
  // 否则 loadServerEnv(override:true) 会用 .env.local 的值覆盖回来。
  if (providerArg) process.env.EXTERNAL_MODEL_PROVIDER = providerArg;
  const provider = createExternalChatProviderFromEnv();
  if (!provider?.isEnabled()) {
    console.error("[voice-probe] 外部模型 provider 未启用，无法探针");
    process.exit(1);
  }
  console.log(`[voice-probe] provider=${provider.id} repeats=${repeats} cases=${CASES.length} arms=${armArg}`);
  const runArms: Array<"before" | "after"> = armArg === "both" ? ["before", "after"] : [armArg];
  const allRows: Array<{ arm: string; rows: Row[] }> = [];
  for (const arm of runArms) {
    allRows.push({ arm, rows: await runArm(provider, arm) });
  }
  const before = allRows.find((r) => r.arm === "before")?.rows ?? [];
  const after = allRows.find((r) => r.arm === "after")?.rows ?? [];

  const outDir = join(scriptDir, "results");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `voice-ab-${Date.now()}.json`);
  writeFileSync(outPath, JSON.stringify({ cases: CASES, before, after }, null, 2), "utf8");
  console.log(`\n[voice-probe] 完成 before=${before.length} after=${after.length} 轮；明细 → ${outPath}`);
}

main().catch((err) => {
  console.error("[voice-probe] 探针异常", err);
  process.exit(1);
});
