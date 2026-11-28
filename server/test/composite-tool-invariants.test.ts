/**
 * 复合工具结构不变量巡检（2026-11-21 防复发）。
 *
 * 背景：`agent-capabilities` prompt 断链已由 capability-prompt-tool-name.test.ts 锁住；
 * 但「天气卡只回文字 / 语音气泡丢失」两次事故的更深层病灶是——复合工具的
 * **结构契约**没有任何守卫，靠人工记忆维护，漏一个就出一个 bug：
 *   - 白名单写了幽灵名（工具改名/删掉后残留），保险变空转；
 *   - 白名单成员没真正进入模型可见面（过滤逻辑变了），加了等于没加；
 *   - defaultAction 写成不存在的 action，漏填 action 时兜底崩；
 *   - action/tool 别名表碰撞或漂移，归一到错误执行器（下游按真实名消费 → 静默丢卡）；
 *   - 有人为「省 token」删掉 schema description 里的原工具名 —— 检索 BM25/embedding
 *     以 schema 文本为索引，少一个原名就等于少一个入口，模型再也召回不到；
 *   - schema 的 action enum 与 spec 不同步，模型填了合法 action 却被判非法。
 *
 * 本测试把上述全部做成不变量。以后任何人新增/修改复合工具，只要结构漂移，
 * `npm test --workspace=server` 立刻红，无需等用户报 bug。
 */
process.env.AGENT_TOOL_SEARCH_ENABLED = "on";
process.env.AGENT_NEURAL_EMBED_ENABLED = "off";
process.env.AGENT_NEURAL_RERANK_ENABLED = "off";
process.env.AGENT_NEURAL_INTENT_ENABLED = "off";

import assert from "node:assert/strict";
import { test } from "node:test";

const {
  COMPOSITE_ACTION_SPECS,
  COMPOSITE_ABSORBED_TOOL_NAMES,
  COMPOSITE_CHAT_TOOLS,
  COMPOSITE_SPECS,
  DIRECTLY_EXPOSED_COMPOSITE_TOOLS,
  normalizeCompositeAction,
  resolveEffectiveToolName,
} = await import("../src/external-model/composite-chat-tools.js");
const { getBuiltinAgentChatTools } = await import(
  "../src/external-model/openai-compatible-tool-loop.js"
);

const visibleNames = new Set(
  getBuiltinAgentChatTools()
    .filter((t) => t.type === "function")
    .map((t) => t.function.name),
);

test("白名单成员必须真实存在于被收编集合（幽灵名防护）", () => {
  const ghosts = [...DIRECTLY_EXPOSED_COMPOSITE_TOOLS].filter(
    (name) => !COMPOSITE_ABSORBED_TOOL_NAMES.has(name),
  );
  assert.deepEqual(
    ghosts,
    [],
    `DIRECTLY_EXPOSED_COMPOSITE_TOOLS 里有不存在的工具名：${ghosts.join(", ")}。` +
      `工具改名/删除后必须同步白名单，否则保险空转。`,
  );
});

test("白名单成员必须真正进入模型可见面（假保险防护）", () => {
  const notVisible = [...DIRECTLY_EXPOSED_COMPOSITE_TOOLS].filter((name) => !visibleNames.has(name));
  assert.deepEqual(
    notVisible,
    [],
    `白名单成员未进入模型可见工具面：${notVisible.join(", ")}。` +
      `检查 getBuiltinAgentChatTools 是否真的放行了 DIRECTLY_EXPOSED_COMPOSITE_TOOLS。`,
  );
});

test("每个复合的 defaultAction 必须是它自己声明的合法 action", () => {
  const broken: string[] = [];
  for (const spec of COMPOSITE_ACTION_SPECS) {
    const actions = new Set(spec.actions.map((a) => a.action));
    if (!actions.has(spec.defaultAction)) {
      broken.push(`${spec.name}.defaultAction=${spec.defaultAction}`);
    }
  }
  assert.deepEqual(
    broken,
    [],
    `defaultAction 指向不存在的分支，漏填 action 时会崩：${broken.join(", ")}`,
  );
});

test("别名归一必须自洽：action 名精确归一，原名归一到同一执行器", () => {
  // action 名是主键，必须精确归一回自己（否则模型填 action=xxx 会被判非法/串到别的分支）。
  // 原工具名/下划线名只需归一到「声明了同一执行器的某个 action」——
  // finance 的 auto_fetch_on/off/status 靠 forwardAction 共用 finance.bills.auto_fetch，
  // 原名归一到其中任一个都会执行同一执行器，是合法共享，不算碰撞。
  // 真正的漂移 = 原名归一到了一个 tool 不同的 action（下游按真实名消费会错判）。
  const problems: string[] = [];
  const toolByAction = new Map<string, string>();
  for (const spec of COMPOSITE_ACTION_SPECS) {
    for (const { action, tool } of spec.actions) toolByAction.set(`${spec.name}:${action}`, tool);

    for (const { action, tool } of spec.actions) {
      // 主键：action 名必须精确归一回自己
      const byOwnName = normalizeCompositeAction(spec.name, action);
      if (byOwnName !== action) {
        problems.push(`${spec.name}: action 名 "${action}" 归一为 ${byOwnName}（应归一回自己）`);
      }
      // 兼容名：原名和下划线名归一到的 action，其执行器必须仍是 tool
      for (const raw of [tool, tool.replace(/\./g, "_")]) {
        const got = normalizeCompositeAction(spec.name, raw);
        const gotTool = got ? toolByAction.get(`${spec.name}:${got}`) : undefined;
        if (gotTool !== tool) {
          problems.push(
            `${spec.name}: 原名 "${raw}" 归一为 action=${got}（执行器 ${gotTool}），应为 ${tool}`,
          );
        }
      }
    }
  }
  assert.deepEqual(problems, [], `复合别名表漂移：\n${problems.join("\n")}`);
});

test("resolveEffectiveToolName 必须与 spec 声明的 tool 一致（下游按真实名消费）", () => {
  const broken: string[] = [];
  for (const spec of COMPOSITE_ACTION_SPECS) {
    for (const { action, tool } of spec.actions) {
      const effective = resolveEffectiveToolName(spec.name, { action });
      if (effective !== tool) {
        broken.push(`${spec.name}(action=${action}) → ${effective}，声明为 ${tool}`);
      }
    }
  }
  assert.deepEqual(
    broken,
    [],
    `复合归一结果与声明执行器不一致，下游卡片/气泡会静默丢失：\n${broken.join("\n")}`,
  );
});

test("白名单工具的复合等价路径必须归一到同一执行器（双入口不分裂）", () => {
  // weather.get_local 等既有「白名单直连」又有「复合 action」两条路，
  // 必须归一到同一真实执行器，否则两条路产出的回执名不同、下游只认其中一个。
  const drift: string[] = [];
  for (const tool of DIRECTLY_EXPOSED_COMPOSITE_TOOLS) {
    for (const spec of COMPOSITE_ACTION_SPECS) {
      for (const { action, tool: declared } of spec.actions) {
        if (declared !== tool) continue;
        const effective = resolveEffectiveToolName(spec.name, { action });
        if (effective !== tool) {
          drift.push(`${tool}: ${spec.name}(action=${action}) 归一为 ${effective}`);
        }
      }
    }
  }
  assert.deepEqual(drift, [], `白名单双入口归一分裂：\n${drift.join("\n")}`);
});

test("复合 schema description 必须保留每个原工具名（检索入口防护）", () => {
  // buildSchema 注释明确：检索以 schema 文本为索引，少一个原名就少一个入口。
  // 这条防止将来有人为「省 token」把原名从 description 里删掉 —— 那会让
  // 「天气」这类能力在工具搜索层召回不到，等价于天气事故的深层复发。
  const missing: string[] = [];
  const schemaByName = new Map(
    COMPOSITE_CHAT_TOOLS.filter((t) => t.type === "function").map((t) => [
      t.function.name,
      t.function.description ?? "",
    ]),
  );
  for (const spec of COMPOSITE_ACTION_SPECS) {
    const description = schemaByName.get(spec.name);
    if (description === undefined) {
      missing.push(`${spec.name}: schema 缺失`);
      continue;
    }
    for (const { tool } of spec.actions) {
      if (!description.includes(tool)) missing.push(`${spec.name}: description 缺少原名 ${tool}`);
    }
  }
  assert.deepEqual(
    missing,
    [],
    `复合 schema 丢了原工具名，工具搜索层召回不到：\n${missing.join("\n")}`,
  );
});

test("复合 action 声明透传的 params 必须在 schema properties 里有定义", () => {
  // 防复发（2026-11-21 天气 focus 丢失事故）：action.params 声明「这个字段要透传给
  // 底层执行器」，但 properties 里忘定义 → 模型看不到该字段、也填不进来 → 回执收窄
  // 参数丢失（问「明天天气」带回今天+明天两套，卡片取今日、正文取明日，温度对不上）。
  // 这次的 focus 就是典型：desc/params 都没带它，properties 也没有。
  const drift: string[] = [];
  const schemaByName = new Map(
    COMPOSITE_CHAT_TOOLS.filter((t) => t.type === "function").map((t) => [
      t.function.name,
      t.function.parameters as { properties?: Record<string, unknown> },
    ]),
  );
  for (const spec of COMPOSITE_SPECS) {
    const properties = schemaByName.get(spec.name)?.properties ?? {};
    for (const [action, actionSpec] of Object.entries(spec.actions)) {
      for (const param of actionSpec.params ?? []) {
        if (!(param in properties)) {
          drift.push(`${spec.name}.${action}: params 声明 ${param}，但 properties 未定义`);
        }
      }
    }
  }
  assert.deepEqual(
    drift,
    [],
    `复合分支声明透传的参数没有 schema 定义，模型填不进来：\n${drift.join("\n")}`,
  );
});

test("天气复合分支必须暴露 focus（回执收窄参数，防今日/明日温度打架）", () => {
  // 2026-11-21 事故回归锁：问「明天天气」必须能把 focus=tomorrow 透传给 weather.get_local，
  // 否则回执同时含今日区间与明日区间——卡片取今日 todayRangeC、正文读明日字段，
  // 用户看到「文字 9-16 / 卡片 9-14」自相矛盾。
  const weatherSpec = COMPOSITE_SPECS.find((s) => s.name === "web_search");
  assert.ok(weatherSpec, "web_search 复合工具应存在");
  const weatherAction = weatherSpec!.actions.weather;
  assert.ok(weatherAction, "web_search.weather 分支应存在");
  assert.ok(
    weatherAction.params?.includes("focus"),
    "web_search.weather 的 params 必须声明 focus（要透传给执行器）",
  );
  const schema = COMPOSITE_CHAT_TOOLS.find(
    (t) => t.type === "function" && t.function.name === "web_search",
  );
  const props = (schema?.function.parameters as { properties?: Record<string, unknown> })?.properties;
  assert.ok(props && "focus" in props, "web_search schema 的 properties 必须定义 focus 字段");
  const focusProp = (props as Record<string, { enum?: string[] }>).focus;
  assert.deepEqual(
    focusProp?.enum?.slice().sort(),
    ["today", "tomorrow"],
    "web_search.focus 的 enum 必须含 today/tomorrow",
  );
});

test("复合 schema 的 action enum 必须与 spec 的 action 列表同步", () => {
  const drift: string[] = [];
  for (const tool of COMPOSITE_CHAT_TOOLS) {
    if (tool.type !== "function") continue;
    const params = tool.function.parameters as {
      properties?: { action?: { enum?: string[] } };
    };
    const enumValues = params?.properties?.action?.enum;
    const spec = COMPOSITE_ACTION_SPECS.find((s) => s.name === tool.function.name);
    if (!spec) {
      drift.push(`${tool.function.name}: 有 schema 无 spec`);
      continue;
    }
    const expected = spec.actions.map((a) => a.action);
    if (!enumValues || enumValues.length !== expected.length || expected.some((a) => !enumValues.includes(a))) {
      drift.push(`${spec.name}: enum=[${enumValues?.join(",") ?? "无"}] spec=[${expected.join(",")}]`);
    }
  }
  assert.deepEqual(drift, [], `复合 action enum 与 spec 漂移：\n${drift.join("\n")}`);
});
