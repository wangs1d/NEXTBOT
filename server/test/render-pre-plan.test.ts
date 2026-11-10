/**
 * 生成前预决策验收（P3，2026-11-07）。
 *
 * 锁定四件事：
 *   1. phase=pre 的 detect 读 ctx.text 会被运行期硬守卫拦下并记入 failures；
 *   2. 场景边界真正进 prompt（此前 promptFragment 在出口产生，时序上不可能生效）；
 *   3. 与 synthesis-strategy 已注入的指令精确去重（天气轮输出零变化）；
 *   4. 生成前命中的 scene id 与出口计划一致，不再两处各猜一次场景。
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  sceneRegistry,
  SceneRegistry,
  planPreRenderScene,
  buildSceneBoundaryBlock,
  planRenderScene,
} from "../src/render/scenes/index.js";
import {
  WEATHER_CARD_BOUNDARY,
  TOMORROW_PREVIEW_BOUNDARY,
  DIGEST_ROUNDUP_BOUNDARY,
} from "../src/render/scenes/prompts.js";
import { WEATHER_CARD_INSTRUCTION } from "../src/agent/synthesis-strategy.js";
import type { RenderScene } from "../src/render/scenes/types.js";

const WEATHER_RECEIPT = {
  ok: true,
  summary: "明天中雨",
  weatherText: "中雨",
  todayRangeC: "18–24",
  locationLabel: "上海",
};

const DIGEST = {
  date: "2026-11-07",
  tomorrowSchedule: [{ title: "09:00 站会" }, { title: "14:00 评审" }],
};

test("pre 时序守卫：detect 读 ctx.text 立即被隔离，不影响其它场景", () => {
  const registry = new SceneRegistry();
  const bad: RenderScene = {
    id: "bad_pre",
    label: "偷看正文",
    priority: 95,
    phase: "pre",
    produces: { promptBoundary: "不该被注入的边界" },
    detect: (ctx) => ({ reason: `读到 ${ctx.text.length} 字` }),
    plan: () => ({ sceneId: "bad_pre", label: "偷看正文", cards: [], reason: "x" }),
  };
  const good: RenderScene = {
    id: "good_pre",
    label: "只看回执",
    priority: 90,
    phase: "pre",
    produces: { promptBoundary: "合法的边界" },
    detect: (ctx) => (ctx.effects?.length ? { reason: "有回执" } : null),
    plan: () => ({ sceneId: "good_pre", label: "只看回执", cards: [], reason: "x" }),
  };
  registry.register(bad);
  registry.register(good);
  const result = registry.pre({ text: "模型正文", effects: [{ tool: "x", status: "ok" }] });
  assert.ok(result.failures.some((f) => f.startsWith("bad_pre:") && f.includes("ctx.text")));
  assert.ok(result.matched.includes("good_pre"));
  assert.ok(!result.matched.includes("bad_pre"));
  assert.deepEqual(result.boundaries, ["合法的边界"]);
});

test("天气轮：场景边界与 strategy 同源，去重后 prompt 零变化", () => {
  const pre = planPreRenderScene({
    userText: "明天天气怎么样",
    toolResults: [{ toolName: "weather.get", ok: true, result: WEATHER_RECEIPT }],
  });
  assert.ok(pre.matched.includes("weather"));
  assert.ok(pre.boundaries.includes(WEATHER_CARD_BOUNDARY));
  assert.equal(WEATHER_CARD_INSTRUCTION, WEATHER_CARD_BOUNDARY, "同源常量不许漂移");
  assert.equal(buildSceneBoundaryBlock(pre, WEATHER_CARD_INSTRUCTION), "");
  // 若 strategy 本轮没注入（例如天气混检索轮），边界必须补上
  assert.match(buildSceneBoundaryBlock(pre, ""), /天气轮/);
});

test("盘点轮：边界真正进 prompt，并带上条目事实", () => {
  const pre = planPreRenderScene({
    userText: "最近有什么新消息",
    toolResults: [
      {
        toolName: "news.latest",
        ok: true,
        result: {
          items: [
            { title: "第一条", snippet: "内容甲" },
            { title: "第二条", snippet: "内容乙" },
          ],
        },
      },
    ],
  });
  assert.ok(pre.matched.includes("digest_roundup"));
  assert.ok(pre.boundaries.some((b) => b.startsWith(DIGEST_ROUNDUP_BOUNDARY)));
  assert.ok(pre.boundaries.some((b) => b.includes("- 第一条")), "条目事实必须进 prompt");
  assert.match(buildSceneBoundaryBlock(pre, ""), /盘点轮/);
  // 出口计划必须命中同一场景（不再两处各猜一次）
  const post = planRenderScene({
    text: "随手写的正文",
    userText: "最近有什么新消息",
    effects: [
      {
        tool: "news.latest",
        status: "ok",
        result: {
          items: [
            { title: "第一条", snippet: "内容甲" },
            { title: "第二条", snippet: "内容乙" },
          ],
        },
      },
    ],
  });
  assert.ok(post.matched.some((m) => m.sceneId === "digest_roundup"));
});

test("明日预览：数据面在生成前注入即可命中，边界进 prompt", () => {
  const pre = planPreRenderScene({
    userText: "明天有什么安排",
    payloads: { eveningDigest: DIGEST, tomorrowPreview: true },
  });
  assert.ok(pre.matched.includes("tomorrow_preview"));
  assert.ok(pre.boundaries.some((b) => b.startsWith(TOMORROW_PREVIEW_BOUNDARY)));
  assert.ok(pre.boundaries.some((b) => b.includes("09:00 站会")), "行程事实必须进 prompt");
  assert.match(buildSceneBoundaryBlock(pre, ""), /明日预览/);
});

test("无数据面时明日预览不误命中；post 场景不参与生成前决策", () => {
  const pre = planPreRenderScene({ userText: "明天有什么安排" });
  assert.ok(!pre.matched.includes("tomorrow_preview"));
  assert.ok(!pre.matched.includes("result_card"), "result_card 依赖模型正文，只能 post");
  assert.equal(pre.failures.length, 0);
  assert.ok(sceneRegistry.get("result_card")?.phase === "post");
  assert.ok(sceneRegistry.get("markdown")?.phase === "pre");
});

test("恒返回门：畸形输入不抛异常，pre-plan 永远给得出结果", () => {
  const malformed = [
    {},
    { userText: undefined, toolResults: undefined, payloads: null },
    { userText: "盘点", toolResults: [{ toolName: "x", ok: false, result: null }] },
  ];
  for (const input of malformed) {
    const pre = planPreRenderScene(input as never);
    assert.ok(Array.isArray(pre.matched));
    assert.ok(Array.isArray(pre.boundaries));
    assert.ok(Array.isArray(pre.failures));
    assert.equal(typeof buildSceneBoundaryBlock(pre, ""), "string");
  }
});
