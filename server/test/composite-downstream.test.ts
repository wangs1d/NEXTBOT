import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveCompositeAction,
  resolveEffectiveToolName,
} from "../src/external-model/composite-chat-tools.js";
import { extractMediaCards } from "../src/services/tool-result-processor.js";

/**
 * 复合工具下游语义回归（2026-11-12）。
 *
 * 背景：44 个细分执行器收编进 11 个复合工具后，媒体卡/搜索卡/状态/预算等下游
 * 仍按旧执行器名匹配，导致「搜图只回文本、没有照片」。这里锁住两条不变量：
 * 1. 复合调用能还原出真实执行器名（含旧工具名当 action 的兼容写法）；
 * 2. 媒体卡提取必须用还原后的名字，直接用复合名必须拿不到卡（证明归一是必需的）。
 */
test("复合名归一：web_search 的 action 映射到真实执行器", () => {
  assert.equal(resolveEffectiveToolName("web_search", { action: "web" }), "search_web");
  assert.equal(resolveEffectiveToolName("web_search", { action: "deep" }), "deep_search");
  assert.equal(resolveEffectiveToolName("web_search", { action: "images" }), "search_images");
  assert.equal(
    resolveEffectiveToolName("web_search", { action: "images_batch" }),
    "search_images_batch",
  );
  assert.equal(resolveEffectiveToolName("web_search", { action: "videos" }), "search_videos");
  assert.equal(resolveEffectiveToolName("web_search", { action: "hot" }), "hot_rankings");
  assert.equal(resolveEffectiveToolName("web_search", { action: "weather" }), "weather.get_local");
  assert.equal(resolveEffectiveToolName("web_search", { action: "quote" }), "market.quote");
});

test("复合名归一：漏填 action 落默认分支，非复合工具原样返回", () => {
  assert.equal(resolveEffectiveToolName("web_search", {}), "search_web");
  assert.equal(resolveEffectiveToolName("web_fetch", {}), "fetch_web");
  assert.equal(resolveEffectiveToolName("calendar", { action: "create" }), "calendar");
  assert.equal(resolveEffectiveToolName("image.generate", {}), "image.generate");
});

test("旧工具名当 action 传入时归一（兼容旧提示词习惯）", () => {
  assert.equal(resolveCompositeAction("web_search", { action: "search_images" }), "images");
  assert.equal(resolveCompositeAction("web_search", { action: "search_web" }), "web");
  assert.equal(resolveCompositeAction("web_fetch", { action: "fetch_web" }), "read");
});

test("显式非法 action 不再静默降级，返回 null 交由 handler 报错", () => {
  assert.equal(resolveCompositeAction("web_search", { action: "nonsense" }), null);
  assert.equal(resolveCompositeAction("web_fetch", { action: "nonsense" }), null);
});

test("媒体卡提取：必须用还原后的执行器名，复合名直接调用拿不到卡", () => {
  const result = {
    items: [
      {
        title: "平潭蓝眼泪",
        thumbnailUrl: "https://example.com/a-thumb.png",
        mediaUrl: "https://example.com/a.png",
        pageUrl: "https://example.com/a",
      },
    ],
  };
  const effective = resolveEffectiveToolName("web_search", { action: "images" });
  assert.equal(effective, "search_images");
  assert.ok(
    extractMediaCards(effective, result).length > 0,
    "还原后的 search_images 应产出媒体卡",
  );
  assert.equal(
    extractMediaCards("web_search", result).length,
    0,
    "直接用复合名不应产出媒体卡（这正是修复前的故障形态）",
  );
});
