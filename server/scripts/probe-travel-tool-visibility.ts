/**
 * 探针：对话面（chat 车道）可见集装配——修复前 vs 修复后（2026-10-10 P0-1）。
 *
 * 修复前：buildChatLaneExplicitOpts 的 chatToolsExtra: corpusSafe（纯 builtin）
 * 覆盖 promptContextBuilder 产出的 sessionSkillTools → 全部技能族在对话面
 * 既不可见、也进不了延迟目录。
 * 修复后：语料并集 = builtin ∪ sessionSkillTools（真实注册链装配，与生产
 * PromptContextBuilder.getChatSkillTools 同源）。
 *
 * 用真实 SkillManager 注册全部内建技能（与 bootstrap 同链），回答
 * 「其他懒加载工具是否同病」：列出修复前后对话面语料差集 = 全部受影响技能族。
 * 只读，不写盘。
 */
process.env.AGENT_TOOL_SEARCH_ENABLED = "on";

const { getBuiltinAgentChatTools } = await import(
  "../src/external-model/openai-compatible-tool-loop.js"
);
const { buildDomainPreloadTools, buildLaneCoreTools, isToolRecallEnabled, dedupeToolsByName } =
  await import("../src/external-model/lane-tool-sets.js");
const { SkillManager } = await import("../src/skills/skill-manager.js");
const { skillManifestToChatTool } = await import("../src/skills/skill-openai-bridge.js");

const toolName = (t: unknown): string => {
  const f = (t as { function?: { name?: string } }).function;
  return f?.name ?? "";
};

// ── 真实装配链：全部内建技能注册（bootstrap 同链，跨技能族） ──
const skillManager = new SkillManager();
const registerFns = [
  ["travel-planning", "../src/skills/travel-planning/travel-planning-skills.js", "registerTravelPlanningBuiltinSkills"],
  ["booking-travel", "../src/skills/builtin/booking-travel-skills.js", null],
  ["merchant-order", "../src/skills/builtin/merchant-order-skills.js", null],
  ["alipay-payment", "../src/skills/builtin/alipay-payment-skills.js", null],
  ["picture", "../src/skills/builtin/picture-skills.js", null],
  ["habit-loop", "../src/skills/builtin/habit-loop-skills.js", null],
  ["arrival-concierge", "../src/skills/builtin/arrival-concierge-skills.js", null],
  ["finance-ingest", "../src/skills/builtin/finance-ingest-skills.js", null],
  ["virtual-phone", "../src/skills/builtin/virtual-phone-skills.js", null],
  ["agent-world-identity", "../src/skills/builtin/agent-world-identity-skills.js", null],
] as const;

for (const [label, modPath, fnName] of registerFns) {
  try {
    const mod: Record<string, unknown> = await import(modPath);
    // 常见导出名：registerXxxBuiltinSkills((skill)=>..., deps)；find 返回键名，取值才是函数
    const key =
      (fnName && mod[fnName] ? fnName : undefined) ??
      Object.keys(mod).find((k) => /^register.*BuiltinSkills$/.test(k) && typeof mod[k] === "function");
    if (key && typeof mod[key] === "function") {
      (mod[key] as (register: (s: unknown) => void, deps: unknown) => void)(
        (skill: unknown) => skillManager.register(skill as never),
        // 各技能族 Deps 不同，这里只为让 manifest 进注册表拿 schema；
        // Deps 不满足时该族跳过（列出来即说明该族存在但注册失败）。
        new Proxy({}, { get: () => new Proxy(() => {}, { get: () => () => {} }) }),
      );
    } else {
      console.log(`  [skip] ${label}: 未找到 register*BuiltinSkills 导出`);
    }
  } catch (e) {
    console.log(`  [fail] ${label}: ${(e as Error).message.slice(0, 80)}`);
  }
}

const builtin = getBuiltinAgentChatTools();
const skillTools = skillManager.list(true).map(skillManifestToChatTool);
const merged = dedupeToolsByName([...builtin, ...skillTools]);

console.log("── 语料规模 ──");
console.log("builtin 静态注册表 =", builtin.length);
console.log("sessionSkillTools（真实注册链）=", skillTools.length);
console.log("修复后对话面语料（并集）=", merged.length);

const skillFamilies = new Map<string, string[]>();
for (const t of skillTools) {
  const name = toolName(t);
  const family = name.split(".")[0] ?? name;
  if (!skillFamilies.has(family)) skillFamilies.set(family, []);
  skillFamilies.get(family)!.push(name);
}
console.log("── 修复前在对话面失踪的全部技能族（= 用户问的「其他懒加载工具」）──");
for (const [family, names] of skillFamilies) {
  const inBuiltin = builtin.some((t) => toolName(t) === names[0]);
  console.log(
    `  ${family}: ${names.length} 个${inBuiltin ? "（同时在 builtin，未受影响）" : "（修复前对话面全族失踪）"}`,
  );
}

// ── 域预载验证（修复后语料口径） ──
const core = buildLaneCoreTools("chat", merged, []);
const coreNames = new Set(core.map(toolName));
console.log("── 域预载验证（修复后语料）──");
console.log("isToolRecallEnabled =", isToolRecallEnabled());
const queries = [
  "帮我规划一下去马尔代夫游玩一个星期左右的行程",
  "帮我点一份外卖，用支付宝付款",
  "帮我搜一下刘浩存最近的照片",
  "记一下我每天早上要喝水的习惯",
];
for (const q of queries) {
  const preload = buildDomainPreloadTools(q, merged, coreNames);
  console.log(`  「${q.slice(0, 18)}…」→ ${JSON.stringify(preload.map(toolName))}`);
}
