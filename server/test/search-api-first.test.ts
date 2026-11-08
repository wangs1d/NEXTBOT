/**
 * 搜索 API 优先契约测试（2026-09-12）。
 *
 * 背景：旧 searchWebMultiEngine 在 API 结果 < limit 时用必应爬虫「补足」，
 * 必应中国 RSS 对多词中文 query 只按首字匹配，返回「刘姓起源」类垃圾凑满
 * limit，混进结果集后在下游 quality 排序里还挤到真实结果前面（实测
 * 「刘浩存 泰国」query）。新契约：
 *   1. API 返回任何真实结果 → 原样直出，爬虫不再混入；
 *   2. API 未配置/失败/空 → 直接返回空，不再回落百度/搜狗兜底（2026-11-08 删除兜底）；
 *   3. API 结果整页与 query 零相关 → 丢弃并返回空（宁可爱模型说「没查到」，不给垃圾）。
 */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";

import {
  filterByQueryFragments,
  searchWebMultiEngine,
  type DomesticFetchOptions,
} from "../src/services/domestic-web-providers.js";

const opts: DomesticFetchOptions = {
  userAgent: "Mozilla/5.0 test/1.0",
  timeoutMs: 3000,
};

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function setApiEnv(): void {
  process.env.SEARCH_API_PROVIDER = "anysearch";
  process.env.SEARCH_API_KEY = "as_sk_test";
}

function clearApiEnv(): void {
  delete process.env.SEARCH_API_PROVIDER;
  delete process.env.SEARCH_API_KEY;
}

function anysearchOk(
  results: Array<{ title: string; url: string; snippet?: string; content?: string }>,
): Response {
  return new Response(
    JSON.stringify({ code: 0, message: "success", data: { results } }),
    { status: 200 },
  );
}

/** 百度结果页最小 HTML（与 extractSearchLinks 解析兼容）。 */
function baiduHtml(entries: Array<[string, string]>): string {
  return `<html><body>${entries
    .map(([url, title]) => `<div class="result"><a href="${url}">${title}</a></div>`)
    .join("")}</body></html>`;
}

test("API 优先：anysearch 有结果时爬虫不补足、结果全部来自 API", async () => {
  setApiEnv();
  let baiduCalled = 0;
  let bingCalled = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("api.anysearch.com")) {
      return anysearchOk([
        { title: "刘浩存泰国归来！亮相直播，公主造型状态满分", url: "https://example.com/a", snippet: "刘浩存结束泰国行程回国" },
        { title: "刘浩存带高压锅去泰国曼谷", url: "https://example.com/b", snippet: "刘浩存泰国 plog" },
      ]);
    }
    if (url.includes("cn.bing.com")) {
      bingCalled += 1;
      return new Response("刘姓起源", { status: 200 });
    }
    if (url.includes("baidu.com/s")) {
      baiduCalled += 1;
      return new Response("", { status: 200 });
    }
    return new Response("", { status: 200 });
  }) as unknown as typeof fetch;

  try {
    const items = await searchWebMultiEngine("刘浩存 泰国", 12, opts);
    assert.ok(items.length >= 2, "API 的 2 条都应保留");
    assert.equal(baiduCalled, 0, "API 有结果时不得调爬虫补足");
    assert.equal(bingCalled, 0, "必应已从主路移除");
    for (const it of items) {
      assert.equal(it.source, "AnySearch", `结果应全部来自 API，实际 ${it.source}`);
    }
  } finally {
    clearApiEnv();
  }
});

test("删除兜底：API 失败时不调百度/搜狗，直接返回空", async () => {
  setApiEnv();
  let baiduCalled = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("api.anysearch.com")) return new Response("server error", { status: 500 });
    if (url.includes("baidu.com/s")) {
      baiduCalled += 1;
      return new Response(
        baiduHtml([["https://news.example.com/real1", "刘浩存泰国归来！亮相直播"]]),
        { status: 200 },
      );
    }
    return new Response("", { status: 200 });
  }) as unknown as typeof fetch;

  try {
    const items = await searchWebMultiEngine("刘浩存 泰国", 8, opts);
    assert.equal(items.length, 0, "API 失败时应返回空，不得用兜底引擎填充");
    assert.equal(baiduCalled, 0, "只信 anysearch：不得请求百度兜底");
  } finally {
    clearApiEnv();
  }
});

test("零相关守卫：API 整页跑偏时丢弃并返回空（不回落爬虫）", async () => {
  setApiEnv();
  let baiduCalled = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("api.anysearch.com")) {
      return anysearchOk([
        { title: "刘姓（中国姓氏）_百度百科", url: "https://baike.example.com/liu" },
        { title: "刘的意思,刘的解释,刘的拼音", url: "https://zidian.example.com/liu" },
      ]);
    }
    if (url.includes("baidu.com/s")) {
      baiduCalled += 1;
      return new Response("", { status: 200 });
    }
    return new Response("", { status: 200 });
  }) as unknown as typeof fetch;

  try {
    const items = await searchWebMultiEngine("刘浩存 泰国", 8, opts);
    assert.equal(items.length, 0, "整页零相关时应返回空，由模型如实说没查到");
    assert.equal(baiduCalled, 0, "只信 anysearch：不得请求百度兜底");
  } finally {
    clearApiEnv();
  }
});

test("filterByQueryFragments：bigram 级匹配，纯符号 query 不过滤", () => {
  const items = [
    { title: "刘浩存泰国归来", snippet: "", url: "https://a.example.com" },
    { title: "刘姓起源", snippet: "", url: "https://b.example.com" },
  ];
  const kept = filterByQueryFragments(items, "刘浩存 泰国");
  assert.deepEqual(kept.map((i) => i.title), ["刘浩存泰国归来"]);
  const passthrough = filterByQueryFragments(items, "!!??");
  assert.equal(passthrough.length, 2, "query 无可用片段时应原样返回");
});
