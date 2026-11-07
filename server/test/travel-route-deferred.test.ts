/**
 * 延迟目录 + agent 自主调用：路线能力（2026-11-05）。
 *
 * 需求：高德接入后，用户问「我这过去多远/多久」「几点出门」时，agent 要能自己
 * 找到工具并调出**路程（distanceKm）与出行时间（durationMin）**，而不是凭印象估。
 *
 * 本测试锁三条：
 *   1. travel.compute-route / travel.departure-advice 属延迟目录（非核心常驻），
 *      经 tool_discover 按需拉出——不进 CORE_TOOL_LIBRARY；
 *   2. 中文口语 query 能稳定召回（BM25 top-1 + 意图先验直取），且不被叫车/规划抢走；
 *   3. 走 ToolRegistry.execute（= agent 主循环那条路）真的返回 durationMin/distanceKm。
 *
 * 运行：npx tsx --test test/travel-route-deferred.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 数据目录与检索管线必须在动态 import 之前钉死（索引/神经开关在 import 时定型）
process.env.NEXTBOT_DATA_DIR = mkdtempSync(join(tmpdir(), "pa-route-deferred-"));
process.env.AGENT_TOOL_SEARCH_EMBEDDING = "off";
process.env.AGENT_NEURAL_SIDECAR_URL = "http://127.0.0.1:1";
process.env.AGENT_NEURAL_EMBED_ENABLED = "off";
process.env.AGENT_NEURAL_RERANK_ENABLED = "off";
process.env.AGENT_NEURAL_INTENT_ENABLED = "off";

const { getBuiltinAgentChatTools } = await import(
  "../src/external-model/openai-compatible-tool-loop.js"
);
const { prepareToolsWithToolSearch, topToolMatchesForQuery, priorDirectMatchesForQuery } =
  await import("../src/tools/tool-search/index.js");
const { executeToolSearchBridge } = await import("../src/tools/tool-search/index.js");
const { isCoreToolRegistryName } = await import("../src/tools/tool-search/core-tool-library.js");
const { skillManifestToChatTool } = await import("../src/skills/skill-openai-bridge.js");
const { createTravelPlanningBuiltinSkills } = await import(
  "../src/skills/travel-planning/travel-planning-skills.js"
);
const { createTravelCommuteBuiltinSkills } = await import(
  "../src/skills/travel-planning/travel-commute-skills.js"
);
const { RIDE_HAILING_CHAT_TOOLS } = await import(
  "../src/tools/capability-modules/ride-hailing/chat-tools.js"
);
const { ToolRegistry } = await import("../src/tools/tool-registry.js");
const { SkillManager } = await import("../src/skills/skill-manager.js");

const ROUTE = "travel.compute-route";
const DEPART = "travel.departure-advice";

const travelSkills = createTravelPlanningBuiltinSkills({ travelPlanningService: {} });
const commuteSkills = createTravelCommuteBuiltinSkills({
  travelPlanningService: {},
  weatherService: {},
});

/** 真实工具集近似：内置工具 + 旅行技能 + 打车（召回排名要在有竞争者的语料里看） */
const ALL_TOOLS = [
  ...getBuiltinAgentChatTools(),
  ...travelSkills.map((s) => skillManifestToChatTool(s.metadata)),
  ...commuteSkills.map((s) => skillManifestToChatTool(s.metadata)),
  ...RIDE_HAILING_CHAT_TOOLS,
];

// ======================== 1. 延迟目录归属 ========================

test("路线两件套属延迟目录（未进 CORE_TOOL_LIBRARY），核心注入里看不到", () => {
  for (const name of [ROUTE, DEPART]) {
    assert.equal(isCoreToolRegistryName(name), false, `${name} 不应是核心常驻工具`);
  }

  const coreTools = ALL_TOOLS.filter(
    (t) => t.type === "function" && isCoreToolRegistryName(t.function.name),
  );
  const prepared = prepareToolsWithToolSearch(coreTools, ALL_TOOLS);
  const deferredNames = new Set(prepared.deferredCatalog.entries.map((e) => e.registryName));

  assert.ok(deferredNames.has(ROUTE), "compute-route 必须在延迟目录中");
  assert.ok(deferredNames.has(DEPART), "departure-advice 必须在延迟目录中");
  assert.ok(prepared.deferredToolCount > 0, "延迟目录不应为空");
});

// ======================== 2. 召回 ========================

test("中文口语 query 的 BM25 top-1 命中对应路线工具", () => {
  const cases: Array<[string, string]> = [
    ["我从这儿到国贸要多久", ROUTE],
    ["去首都机场多远", ROUTE],
    ["开车过去多长时间", ROUTE],
    ["这地方离我几公里", ROUTE],
    ["明天八点的飞机几点出门", DEPART],
    ["现在去机场来得及吗", DEPART],
    ["九点前要到公司几点走", DEPART],
  ];
  for (const [query, expected] of cases) {
    const top = topToolMatchesForQuery(query, ALL_TOOLS, 3);
    assert.ok(top.length > 0, `「${query}」零召回`);
    assert.equal(top[0]!.name, expected, `「${query}」top1=${top[0]!.name}`);
  }
});

test("意图先验直取：路线工具在 discover 之前就能被点名", () => {
  assert.ok(
    priorDirectMatchesForQuery("我从这儿到国贸要多久", ALL_TOOLS, 2).some((m) => m.name === ROUTE),
  );
  assert.ok(
    priorDirectMatchesForQuery("明天八点的飞机几点出门", ALL_TOOLS, 2).some((m) => m.name === DEPART),
  );
});

test("负例不误召：叫车/行程规划不会被路线工具抢走", () => {
  const prior = priorDirectMatchesForQuery("帮我叫个车去机场", ALL_TOOLS, 2);
  assert.equal(prior.some((m) => m.name === ROUTE), false, "叫车不该命中 compute-route");

  const planTop = topToolMatchesForQuery("帮我规划去成都玩5天", ALL_TOOLS, 3);
  assert.equal(planTop[0]!.name, "travel.plan-itinerary", `top1=${planTop[0]!.name}`);
});

test("tool_discover 能把这个延迟工具连同可调 schema 一起交给模型", async () => {
  const coreTools = ALL_TOOLS.filter(
    (t) => t.type === "function" && isCoreToolRegistryName(t.function.name),
  );
  const prepared = prepareToolsWithToolSearch(coreTools, ALL_TOOLS);

  const discovered = await executeToolSearchBridge(
    "tool_discover",
    { query: "我从这儿到国贸要多久", limit: 5 },
    prepared.deferredCatalog,
  );
  const payload = JSON.stringify(discovered);
  assert.ok(payload.includes(ROUTE), `discover 结果缺 ${ROUTE}: ${payload.slice(0, 400)}`);
  // 模型要能看出「只填 to 就能调」——起点是可选项，不该被当成必填
  const match = (discovered as { result?: { matches?: Array<Record<string, unknown>> } }).result
    ?.matches?.find((m) => m.name === ROUTE) as
    | { requiredParameters?: string[]; parameterNames?: string[] }
    | undefined;
  assert.ok(match, "discover 结果里没有 compute-route 的条目");
  assert.deepEqual(match!.requiredParameters, ["to"], "required 应只有 to");
  assert.ok(match!.parameterNames?.includes("from"), "参数表里要能看到 from（可选）");
});

// ======================== 3. 真的调出结果 ========================

type FetchLike = typeof globalThis.fetch;

function stubAmap(): { urls: string[]; restore: () => void } {
  const original = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    urls.push(url);
    const u = new URL(url);
    const body = u.pathname.endsWith("/v3/geocode/geo")
      ? { status: "1", geocodes: [{ location: "116.461,39.908" }] }
      : { status: "1", route: { paths: [{ duration: "1500", distance: "7200" }] } };
    return { ok: true, json: async () => body } as Response;
  }) as FetchLike;
  return { urls, restore: () => { globalThis.fetch = original; } };
}

test("ToolRegistry.execute：agent 主循环那条路能拿到 durationMin 与 distanceKm", async () => {
  const prevKey = process.env.AMAP_WEB_KEY;
  process.env.AMAP_WEB_KEY = "test-amap-key";
  const stub = stubAmap();
  try {
    const registry = new ToolRegistry();
    const skillManager = new SkillManager();
    for (const s of [...travelSkills, ...commuteSkills]) skillManager.register(s);
    registry.setSkillManager(skillManager);

    const { ok, result } = await registry.execute(
      ROUTE,
      { to: "国贸地铁站" },
      {
        sessionId: "route-deferred-test",
        clientLocation: { latitude: 39.9042, longitude: 116.4074, label: "北京市 · 东城区" },
      },
    );

    assert.equal(ok, true, JSON.stringify(result));
    assert.equal(typeof result.durationMin, "number");
    assert.equal(typeof result.distanceKm, "number");
    assert.equal(result.durationMin, 25, "1500s → 25 分钟");
    assert.equal(result.distanceKm, 7.2);
    assert.equal(result.routeSource, "amap");
    assert.equal(result.originSource, "current-location");
    assert.equal(result.mode, "driving");
    assert.ok(stub.urls.some((u) => u.includes("/v3/direction/driving")), "应真正请求高德驾车路径");
  } finally {
    stub.restore();
    if (prevKey === undefined) delete process.env.AMAP_WEB_KEY;
    else process.env.AMAP_WEB_KEY = prevKey;
  }
});

test("ToolRegistry.execute：出发建议同样返回耗时与最晚出发时刻", async () => {
  const prevKey = process.env.AMAP_WEB_KEY;
  process.env.AMAP_WEB_KEY = "test-amap-key";
  const stub = stubAmap();
  try {
    const registry = new ToolRegistry();
    const skillManager = new SkillManager();
    for (const s of [...travelSkills, ...commuteSkills]) skillManager.register(s);
    registry.setSkillManager(skillManager);

    const { ok, result } = await registry.execute(
      DEPART,
      { to: "国贸地铁站", arriveBy: "2026-11-06 09:00" },
      {
        sessionId: "route-deferred-test",
        clientLocation: { latitude: 39.9042, longitude: 116.4074, label: "北京市 · 东城区" },
      },
    );

    assert.equal(ok, true, JSON.stringify(result));
    assert.equal(result.durationMin, 25);
    assert.equal(result.distanceKm, 7.2);
    // 09:00 - 25 分钟 - 10 分钟缓冲
    assert.equal(result.suggestedDeparture, "08:25");
    assert.match(String(result.advice), /25 分钟/);
  } finally {
    stub.restore();
    if (prevKey === undefined) delete process.env.AMAP_WEB_KEY;
    else process.env.AMAP_WEB_KEY = prevKey;
  }
});
