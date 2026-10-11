/**
 * chat 车道域信号预召回单测（2026-10-09 工具链根修）。
 *
 * 根因回归：travel 全族在延迟目录，chat 车道模型不主动 tool_discover 就手写
 * 行程（旅游卡缺席；profile.update / weather.get_local 同款教训，三次实证）。
 * 根修后 explicit 轮可见集 = chat Core ∪ buildDomainPreloadTools（BM25 域多数票
 * 命中域全族瘦身 schema）——「帮我规划…行程」这类轮次 travel.plan-itinerary
 * 确定性对模型可见，不再依赖模型自觉 discover。
 *
 * 注意：travel 技能族不在静态 builtin 注册表，生产由 bootstrap 注册链注入
 * sessionSkillTools（PromptContextBuilder.getChatSkillTools）。2026-10-10 P0-1
 * 教训：本文件曾手写 travel 六件套 schema push 进 corpus——测试构造了生产不存在
 * 的语料（生产 chat 车道当时根本没装配技能族），测试绿、线上失效。现改为
 * **真实装配链**取语料：SkillManager 注册真实 travel 技能定义 →
 * skillManifestToChatTool（生产同款桥），不再手写 schema。
 */
process.env.AGENT_TOOL_SEARCH_ENABLED = "on";
process.env.DESKTOP_VISUAL_ENABLED = "1";

import assert from "node:assert/strict";
import test from "node:test";

const { getBuiltinAgentChatTools } = await import(
  "../src/external-model/openai-compatible-tool-loop.js"
);
const {
  buildDomainPreloadTools,
  buildLaneCoreTools,
  CHAT_LANE_CORE_NAMES,
} = await import("../src/external-model/lane-tool-sets.js");
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

function toolName(t: ChatCompletionTool): string {
  return t.type === "function" ? t.function?.name ?? "" : "";
}

test("旅游轮根因回归：travel.plan-itinerary 确定性进可见集（无需模型自觉 discover）", () => {
  const coreNames = new Set(CHAT_LANE_CORE_NAMES);
  const preload = buildDomainPreloadTools("帮我规划一个周末去兴义玩的行程", corpus, coreNames);
  const names = preload.map(toolName);
  assert.ok(
    names.includes("travel.plan-itinerary"),
    `预载缺 travel.plan-itinerary，实际: ${names.join(",")}`,
  );
});

test("chat 车道装配口径：Core ∪ 预载无重名（与 buildChatLaneExplicitOpts 同构）", () => {
  const core = buildLaneCoreTools("chat", corpus);
  const coreNames = new Set(core.map(toolName).filter(Boolean));
  const preload = buildDomainPreloadTools("帮我规划一个周末去兴义玩的行程", corpus, coreNames);
  const union = [...core.map(toolName), ...preload.map(toolName)];
  assert.equal(new Set(union).size, union.length, "Core 与预载出现重名");
  assert.ok(preload.map(toolName).includes("travel.plan-itinerary"));
});

test("预载 schema 瘦身：字段级描述被剥掉（控 token，真实 manifest 参数）", () => {
  const preload = buildDomainPreloadTools("帮我规划一个周末去兴义玩的行程", corpus, new Set());
  assert.ok(preload.length > 0);
  // 真实技能 manifest 的参数 schema：瘦身卸任后任何字段级 description 都不该幸存
  let propCount = 0;
  for (const tool of preload) {
    const params = (tool.function?.parameters ?? {}) as {
      properties?: Record<string, unknown>;
    };
    for (const [propName, prop] of Object.entries(params.properties ?? {})) {
      propCount += 1;
      assert.equal(
        "description" in (prop as object),
        false,
        `${toolName(tool)}.${propName} 的字段级描述应被瘦身剥掉`,
      );
    }
  }
  assert.ok(propCount > 0, "真实技能参数应至少存在一个字段");
});

test("闲聊轮不注入：无强信号 → 空预载（零工具隔离语义不受影响）", () => {
  assert.deepEqual(buildDomainPreloadTools("嗯嗯好的", corpus), []);
  assert.deepEqual(buildDomainPreloadTools("哈哈哈哈哈", corpus), []);
  assert.deepEqual(buildDomainPreloadTools("", corpus), []);
});

test("去重：excludeNames 命中的工具不重复注入，且先排除后截断", () => {
  const synthetic = [
    fn("travel.plan-itinerary", "旅游行程规划：景点 门票 攻略"),
    fn("travel.search-poi", "景点搜索：景区 门票"),
    fn("travel.destination-info", "目的地信息：旅游 攻略"),
    fn("search_web", "联网搜索网页"),
  ];
  const exclude = new Set(["travel.plan-itinerary"]);
  const preload = buildDomainPreloadTools("帮我规划旅游行程看景点门票", synthetic, exclude);
  const names = preload.map(toolName);
  assert.equal(names.includes("travel.plan-itinerary"), false, "Core 已含的工具不应重复注入");
  assert.ok(names.includes("travel.search-poi"), `增量工具应注入: ${names.join(",")}`);
});

test("cap 生效：域族超过上限时截断", () => {
  const big = [fn("search_web", "联网搜索网页")];
  for (let i = 0; i < 20; i++) {
    big.push(fn(`fake.travel.tool${i}`, `旅游 行程 规划 景点 工具${i}`));
  }
  const preload = buildDomainPreloadTools("帮我规划旅游行程看景点", big, new Set(), 5);
  assert.ok(preload.length <= 5, `预载族规模超上限: ${preload.length}`);
});

test("确定性：同文本同语料恒同预载（前缀缓存前提）", () => {
  const coreNames = new Set(CHAT_LANE_CORE_NAMES);
  const a = buildDomainPreloadTools("帮我规划一个周末去兴义玩的行程", corpus, coreNames);
  const b = buildDomainPreloadTools("帮我规划一个周末去兴义玩的行程", corpus, coreNames);
  assert.deepEqual(a, b);
});

test("装配通道不变量（2026-10-10 P0-1 回归）：技能族只走 sessionSkillTools，builtin 注册表不含", () => {
  // 防回归契约：travel.*（技能工具）不在 getBuiltinAgentChatTools() 静态注册表，
  // 只经 PromptContextBuilder.getChatSkillTools(actorId)（= sessionSkillTools）
  // 进入语料。若有人把技能族塞进静态注册表或改了通道，此测试立刻暴露。
  const builtinNames = new Set(getBuiltinAgentChatTools().map(toolName));
  assert.equal(
    builtinNames.has("travel.plan-itinerary"),
    false,
    "travel.plan-itinerary 不应出现在静态 builtin 注册表（技能族只走 sessionSkillTools 通道）",
  );
  const skillNames = new Set(corpus.map(toolName));
  for (const n of [
    "travel.plan-itinerary", "travel.search-poi", "travel.destination-info",
    "travel.compute-route", "travel.get-itinerary", "travel.edit-itinerary",
  ]) {
    assert.ok(skillNames.has(n), `真实注册链语料缺 ${n}`);
  }
});
