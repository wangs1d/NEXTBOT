/**
 * 展示路由金样本回归测试。
 *
 * 语料：test/fixtures/display-routing-corpus.ts（来源与维护说明见该文件头）。
 * 全量评测（准确率/混淆矩阵）用 `npm run eval:routing`；本测试保证每条
 * 金样本不回归——任何权重/阈值/正则调整导致样本翻车都会在这里炸出来。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { routeDisplayEffect } from "../src/services/display-effect-router.js";
import { classifyRenderHint } from "../src/services/render-hint-service.js";
import { DISPLAY_EFFECT_TYPES } from "@nextbot/agent-protocol";
import { CARD_CORPUS, HINT_CORPUS } from "./fixtures/display-routing-corpus.js";

test("contract drift: corpus expectations only use contracted display effect types", () => {
  const contracted = new Set<string>(DISPLAY_EFFECT_TYPES);
  for (const c of CARD_CORPUS) {
    assert.ok(
      contracted.has(c.expected),
      `样本「${c.name}」的期望值 ${c.expected} 不在契约包 DISPLAY_EFFECT_TYPES 中`,
    );
  }
});

for (const c of CARD_CORPUS) {
  test(`card corpus: ${c.name}`, () => {
    assert.equal(routeDisplayEffect(c.input), c.expected);
  });
}

for (const h of HINT_CORPUS) {
  test(`hint corpus: ${h.name}`, () => {
    const hint = classifyRenderHint(h.text, { toolName: h.toolName, userText: h.userText });
    assert.equal(hint.type, h.expected);
  });
}
