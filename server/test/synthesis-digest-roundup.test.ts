import assert from "node:assert/strict";
import test from "node:test";

import { isDigestRoundupQuery, isDirectFactQuery } from "../src/agent/direct-fact-query.js";
import {
  assessDataQuality,
  collectToolDataFromResults,
  evaluateAndSelectStrategy,
} from "../src/agent/synthesis-strategy.js";

/**
 * 回归背景（2026-09-02「回复潦草」修复）：
 * search_web 返回 { provider, items }，策略评估器的字段列表没有 items，
 * 16 条结果被 JSON 兜底截到 500 字符 → 质量误判 medium → 注入求简指令；
 * 同时「最新动态」被 isDirectFactQuery 判成单一事实查询 → 「最多 3 句」。
 * 最终回答被 max_tokens 800 硬顶。三处叠加导致多来源搜索只产出潦草回复。
 */

/** 复刻 search_web 的真实返回形态：结果挂在 items 数组下 */
function searchWebResult(count: number): Record<string, unknown> {
  const items = Array.from({ length: count }, (_, i) => ({
    title: `刘浩存相关新闻第${i + 1}条：新剧开机与直播公主裙造型引热议`,
    url: `https://example.com/news/${i + 1}`,
    snippet:
      "8月30日刘浩存参加平台五周年全明星直播，珍珠发箍加蓬蓬公主裙造型被全网刷屏；" +
      "唐探系列衍生作品已在泰国开机，搭档肖央；工作室维权进展：5个侵权账号已公开道歉。",
    source: "娱乐媒体",
    publishedAt: "2026-08-30",
  }));
  return { provider: "anysearch", items, fetchedAt: "2026-09-02T10:00:00Z", notes: [] };
}

test("search_web 的 items 结果被完整计入数据质量评估（不再截断到 500 字符）", () => {
  const toolData = collectToolDataFromResults([
    { toolName: "search_web", ok: true, result: searchWebResult(16) },
  ]);
  assert.equal(toolData[0].isSearch, true);
  // 16 条 title+snippet+时间 拼接后必须远超 500 字符兜底
  assert.ok(toolData[0].length > 1500, `实际长度 ${toolData[0].length}`);

  const quality = assessDataQuality(toolData);
  // 单工具多来源的富结果应评为 high，而不是 medium
  assert.equal(quality.level, "high");
});

test("「最新动态」类盘点查询命中 digest_roundup 策略，但策略层不再教版式", () => {
  const directive = evaluateAndSelectStrategy(
    [{ toolName: "search_web", ok: true, result: searchWebResult(16) }],
    "刘浩存 最新动态 2026年9月",
  );
  assert.equal(directive.strategy, "digest_roundup");
  // 2026-11-05 架构收敛：版式归 render/scenes——strategy 名只作观测与场景路由，
  // 指令里只剩数据事实（几个来源），不许再出现编号步骤/分组/篇幅这类版式措辞。
  assert.ok(!directive.instruction.includes("按主题分组"));
  assert.ok(!directive.instruction.includes("总体印象"));
  assert.ok(!directive.instruction.includes("1."));
  assert.ok(directive.instruction.includes("数据够了"));
  assert.ok(
    directive.instruction.length < 80,
    `策略指令应只剩数据事实（当前 ${directive.instruction.length} 字）`,
  );
});

test("动态盘点类查询不再被判成单一事实查询，求证类措辞保持原判定", () => {
  assert.equal(isDigestRoundupQuery("刘浩存 最新动态 2026年9月"), true);
  assert.equal(isDirectFactQuery("刘浩存 最新动态 2026年9月"), false);
  assert.equal(isDirectFactQuery("她最近怎么样了"), false);

  // 单一事实求证保持 true（不破坏既有行为）
  assert.equal(isDirectFactQuery("她现在在哪"), true);
  assert.equal(isDirectFactQuery("今天有没有确切消息"), true);
  assert.equal(isDigestRoundupQuery("今天有没有确切消息"), false);
});
