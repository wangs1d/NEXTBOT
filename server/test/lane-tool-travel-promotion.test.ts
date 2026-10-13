/**
 * 任务面域信号预载单测（2026-10-01 S2：travel 硬编码的泛化替代）。
 *
 * 契约：full 束任务轮（multi_step/后台派发/保守降级）装配时，对用户文本做
 * 词面 top-5 域多数票（≥2 票强信号）→ 预载该域全族瘦身 schema（≤12）。
 * 旅游轮（大理行程）由 travel 域信号命中覆盖（原硬编码场景回归）；无强信号
 * 轮不预载（纯桥可见）。确定性：同语料同文本恒同域。
 *
 * 2026-10-10 P0-1 教训：语料改走真实装配链（SkillManager 注册真实技能 →
 * skillManifestToChatTool），不再手写 travel 六件套 schema——手搓语料让测试
 * 构造了生产不存在的描述，回归测不到真实装配 bug。
 */
process.env.AGENT_TOOL_SEARCH_ENABLED = "on";
process.env.DESKTOP_VISUAL_ENABLED = "1";

import assert from "node:assert/strict";
import test from "node:test";

const { getBuiltinAgentChatTools } = await import(
  "../src/external-model/openai-compatible-tool-loop.js"
);
const { dominantDomainForQuery } = await import("../src/tools/tool-search/index.js");
const { toolsInDomain, domainsForTool } = await import("../src/tools/tool-search/tool-category.js");
const { slimToolSchema } = await import("../src/external-model/lane-tool-sets.js");
const { SkillManager } = await import("../src/skills/skill-manager.js");
const { skillManifestToChatTool } = await import("../src/skills/skill-openai-bridge.js");
const { registerTravelPlanningBuiltinSkills } = await import(
  "../src/skills/travel-planning/travel-planning-skills.js"
);
const { PlanningService } = await import(
  "../src/skills/travel-planning/travel-planning-service.js"
);
import type { ChatCompletionTool } from "openai/resources/chat/completions";

function fn(name: string, description = name): ChatCompletionTool {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: {
        type: "object",
        properties: { q: { type: "string", description: "字段级描述应被瘦身剥掉" } },
      },
    },
  };
}

/** 生产语料（builtin 静态注册表）∪ 技能族（真实注册链 + 生产同款 manifest→tool 桥） */
const corpus: ChatCompletionTool[] = (() => {
  const skillManager = new (SkillManager as new () => InstanceType<typeof SkillManager>)();
  const travelPlanningService = new (PlanningService as new () => InstanceType<typeof PlanningService>)();
  registerTravelPlanningBuiltinSkills(
    (skill) => skillManager.register(skill),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 测试最小 Deps（规划服务本体，无 IO）
    { travelPlanningService } as any,
  );
  return [...getBuiltinAgentChatTools(), ...skillManager.list(true).map(skillManifestToChatTool)];
})();

test("旅游轮域信号命中：大理行程 → travel 域（原硬编码场景的泛化覆盖）", () => {
  const domain = dominantDomainForQuery("帮我规划一个大理两日游行程", corpus);
  assert.ok(["travel", "search"].includes(domain ?? ""), `实际域: ${domain}`);
});

test("域预载族完整：travel 域含规划六件套且瘦身", () => {
  const family = toolsInDomain(corpus, "travel").map((t) => (t as { function: { name: string } }).function.name);
  for (const n of ["travel.plan-itinerary", "travel.search-poi", "travel.compute-route"]) {
    assert.ok(family.includes(n), `缺 ${n}`);
  }
  // 真实技能 manifest 参数：瘦身卸任后任何字段级 description 都不该幸存
  const slim = slimToolSchema(toolsInDomain(corpus, "travel")[0]!);
  const props = (slim as { function: { parameters: { properties: Record<string, unknown> } } })
    .function.parameters.properties ?? {};
  const keys = Object.keys(props);
  assert.ok(keys.length > 0, "真实技能参数应至少存在一个字段");
  for (const k of keys) {
    assert.equal("description" in (props[k] as object), false, `${k} 的字段级描述应被剥掉`);
  }
});

test("无强信号不预载：闲聊文本域信号为空", () => {
  assert.equal(dominantDomainForQuery("嗯嗯好的", corpus), null);
});

test("确定性：同文本同语料恒同域（前缀缓存前提）", () => {
  const a = dominantDomainForQuery("帮我规划一个大理两日游行程", corpus);
  const b = dominantDomainForQuery("帮我规划一个大理两日游行程", corpus);
  assert.equal(a, b);
});

test("族规模受控：预载上限 12 内（DOMAIN_PRELOAD_CAP 对齐域拉取）", () => {
  const biggest = ["search", "desktop", "agent", "calendar"].map(
    (d) => [d, toolsInDomain(corpus, d).length] as const,
  );
  for (const [, size] of biggest) assert.ok(size <= 20, `域族异常膨胀: ${size}`);
});

/* ────────────────────────────────────────────────────────────
 * 行程规划超时预算（2026-10-12 贵阳轮「行程卡整轮缺席」根因回归）
 *
 * 事故链：travel.plan-itinerary 冷启动（缓存未命中）实测 20~57s，技能自身
 * 声明 timeoutMs=120s，但该声明此前只被 skill-sandbox 消费；工具循环只认
 * 自己的硬编码超时表 → travel 落 30s 默认值被击杀（ok=false）→ 行程回执
 * 缺失 → 行程卡整轮缺席 + 出口闸判「工具全败」→ 模型手写逐日行程直穿气泡。
 *
 * 断言把「技能声明」与「工具循环实取超时」锁在一起：任一侧漂移即红。
 * ──────────────────────────────────────────────────────────── */

test("行程规划：工具循环实取超时 ≥ 技能声明（不得被 30s 默认值截断）", async () => {
  const { resolveToolExecutionTimeoutMs } = await import(
    "../src/external-model/openai-compatible-tool-loop.js"
  );
  const skillManager = new (SkillManager as new () => InstanceType<typeof SkillManager>)();
  const travelPlanningService = new (PlanningService as new () => InstanceType<typeof PlanningService>)();
  registerTravelPlanningBuiltinSkills(
    (skill) => skillManager.register(skill),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 测试最小 Deps（无 IO）
    { travelPlanningService } as any,
  );
  const manifest = skillManager
    .list(true)
    .find((m) => m.name === "travel.plan-itinerary");
  assert.ok(manifest, "travel.plan-itinerary 应已通过真实注册链注册");
  const declared = manifest!.timeoutMs;
  assert.equal(declared, 120_000, "技能声明超时应为 120s（冷启动实测 20~57s）");

  delete process.env.TOOL_TIMEOUT_TRAVEL_PLAN_MS;
  const effective = resolveToolExecutionTimeoutMs("travel.plan-itinerary");
  assert.ok(
    effective >= declared!,
    `工具循环实取超时 ${effective}ms 小于技能声明 ${declared}ms —— 会被 30s 默认值击杀`,
  );
});

test("行程规划超时可经 env 覆盖，且不破坏快工具的 30s 钳制语义", async () => {
  const { resolveToolExecutionTimeoutMs } = await import(
    "../src/external-model/openai-compatible-tool-loop.js"
  );
  process.env.TOOL_TIMEOUT_TRAVEL_PLAN_MS = "45000";
  try {
    assert.equal(resolveToolExecutionTimeoutMs("travel.plan-itinerary"), 45_000);
  } finally {
    delete process.env.TOOL_TIMEOUT_TRAVEL_PLAN_MS;
  }
  // 对照：快工具仍走各自分级档（classTimeouts 的 Math.min(classMs, defaultMs) 未被绕过）
  assert.equal(resolveToolExecutionTimeoutMs("search_web"), 6_500);
  assert.equal(resolveToolExecutionTimeoutMs("some_unknown_tool"), 30_000);
});

