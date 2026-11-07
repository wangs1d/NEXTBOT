import assert from "node:assert/strict";
import test from "node:test";

import {
  classifySearchIntent,
  prependRecencyQueryVariants,
  shouldBoostQueryRecency,
} from "../src/services/search-enhancements.js";

test("latest and research queries get broader suggested limits", () => {
  assert.equal(classifySearchIntent("今天A股最新消息").suggestedLimit, 16);
  assert.equal(classifySearchIntent("帮我调研一下刘浩存的作品和经历").suggestedLimit, 14);
});

test("recency variants are prepended before base variants", () => {
  const variants = prependRecencyQueryVariants(["刘浩存", "刘浩存 动态"], "刘浩存最近动态");

  assert.equal(variants[0]?.includes("年"), true);
  assert.equal(variants[1]?.includes("最新"), true);
  assert.equal(variants.includes("刘浩存"), true);
});

test("timeless definition queries do not get forced recency variants", () => {
  assert.equal(shouldBoostQueryRecency("OpenAI 是什么"), false);
  assert.deepEqual(
    prependRecencyQueryVariants(["OpenAI 是什么"], "OpenAI 是什么"),
    ["OpenAI 是什么"],
  );
});

// ---------------------------------------------------------------------------
// 时效推断强化（2026-11-06）：相对时间 / 无年份日期 / URL 8 位日期 / 日期写回
// ---------------------------------------------------------------------------

import {
  applySearchFreshness,
  formatSearchFreshnessNote,
  getSearchAnchorNow,
  inferPublishedAtMsFromText,
  inferPublishedAtMsFromUrl,
} from "../src/services/search-enhancements.js";

const NOW = new Date(2026, 10, 6, 12, 0, 0).getTime(); // 2026-11-06 12:00 本地

test("文本推断：相对时间形态（X小时前/X天前/昨天/今天）", () => {
  const h3 = inferPublishedAtMsFromText("美股收盘：三大指数重挫 3小时前", NOW);
  assert.ok(h3 != null && Math.abs(h3 - (NOW - 3 * 3_600_000)) < 60_000);
  const d2 = inferPublishedAtMsFromText("某公司发布新品 2天前", NOW);
  assert.ok(d2 != null && Math.abs(d2 - (NOW - 2 * 86_400_000)) < 60_000);
  const yest = inferPublishedAtMsFromText("11月5日昨夜美股暴跌（昨天 23:10 发布）", NOW);
  assert.ok(yest != null && yest > NOW - 2 * 86_400_000 && yest <= NOW);
  const today = inferPublishedAtMsFromText("今日A股收盘综述", NOW);
  assert.ok(today != null && today > NOW - 86_400_000);
});

test("文本推断：无年份日期按当前年推断，未来月份归上一年", () => {
  // 当前 2026-11：11月5日 → 2026-11-05
  const thisYear = inferPublishedAtMsFromText("创业板指 11月5日 收盘", NOW);
  assert.ok(thisYear != null);
  const d1 = new Date(thisYear!);
  assert.equal(d1.getFullYear(), 2026);
  assert.equal(d1.getMonth(), 10);
  assert.equal(d1.getDate(), 5);
  // 当前 2026-11：12月30日（今年还没到）→ 2025-12-30
  const lastYear = inferPublishedAtMsFromText("年度盘点 12月30日", NOW);
  assert.ok(lastYear != null && new Date(lastYear!).getFullYear() === 2025);
  // 完整年份优先：1949年10月1日 不被无年份推断污染
  const full = inferPublishedAtMsFromText("回顾1949年10月1日大典", NOW);
  assert.ok(full != null && new Date(full!).getFullYear() === 1949);
});

test("URL 推断：斜杠分段式与连续 8 位日期", () => {
  assert.ok(inferPublishedAtMsFromUrl("https://finance.example.com/2026/11/05/abc.html"));
  assert.ok(inferPublishedAtMsFromUrl("https://news.example.com/news20261105001.html"));
  assert.ok(inferPublishedAtMsFromUrl("https://x.example.com/article/2026-11-05/9.html"));
  // 非日期 8 位数（非法月/日）不误判
  assert.equal(inferPublishedAtMsFromUrl("https://x.example.com/id/20261399001.html"), undefined);
});

test("applySearchFreshness：推断日期写回 publishedAt 且按时间倒序", () => {
  const items = [
    { title: "2023年的旧文 2023-05-18", url: "https://a.example.com/x", snippet: "", source: "t" },
    { title: "美股收盘三大指数重挫", url: "https://b.example.com/2026/11/05/y.html", snippet: "11月5日", source: "t" },
    { title: "盘中快讯", url: "https://c.example.com/z", snippet: "2小时前", source: "t" },
    { title: "完全无日期的内容", url: "https://d.example.com/w", snippet: "没有时间线索的段落", source: "t" },
  ];
  const out = applySearchFreshness(items, { query: "美股 最新 收盘", nowMs: NOW });
  assert.equal(out.datedCount, 3); // 含被丢旧的 2023 旧文（计数发生在丢旧前）
  // 新→旧：2小时前(11-06) → 11-05 → 无日期垫底；2023 旧文被 120 天丢旧剔除
  assert.equal(out.items.length, 3);
  assert.equal(out.items[0]?.title, "盘中快讯");
  assert.equal(out.items[1]?.title, "美股收盘三大指数重挫");
  assert.equal(out.items[2]?.title, "完全无日期的内容");
  // 推断日期写回，模型可见
  assert.equal(out.items[1]?.publishedAt, "2026-11-05");
  assert.equal(out.items[0]?.publishedAt, "2026-11-06");
  assert.equal(out.items[2]?.publishedAt, undefined);
  // 已有显式日期的条目不被覆盖
  const explicit = applySearchFreshness(
    [{ title: "显式日期条目", url: "https://e.example.com/2026/01/01/a.html", snippet: "", source: "t", publishedAt: "2020-01-01" }],
    { query: "q", nowMs: NOW },
  );
  assert.equal(explicit.items[0]?.publishedAt, "2020-01-01");
});

test("formatSearchFreshnessNote：0 条有日期时如实降级，不再假称时间序", () => {
  const anchor = getSearchAnchorNow();
  const honest = formatSearchFreshnessNote({ anchor, droppedStale: 0, maxAgeDays: 120, datedCount: 0, total: 8 });
  assert.ok(honest.includes("未标注发布时间"), honest);
  assert.ok(!honest.includes("已按发布时间"), honest);
  const normal = formatSearchFreshnessNote({ anchor, droppedStale: 0, maxAgeDays: 120, datedCount: 5, total: 8 });
  assert.ok(normal.includes("已按发布时间从新到旧排序"), normal);
});
