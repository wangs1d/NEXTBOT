import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  searchWebMultiEngine,
  searchBaiduChina,
  type DomesticFetchOptions,
} from "../src/services/domestic-web-providers.js";
import { RssHealthMonitor } from "../src/services/search-enhancements.js";
import { UpstreamSearchService, type InfoHubService } from "../src/services/upstream-search-service.js";

const opts: DomesticFetchOptions = {
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) test/1.0",
  timeoutMs: 3000,
};

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** 用 URL 分发返回 HTML 的假 fetch；未匹配统一返回空字符串（模拟抓取失败）。 */
function stubFetch(urlHandler: (url: string) => string): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    return new Response(urlHandler(url) ?? "", { status: 200 });
  }) as unknown as typeof fetch;
}

// ---- 只信 anysearch：API 不可用时不回落百度/搜狗，直接返回空 ----
test("多引擎：API 不可用时不调用百度/搜狗兜底，直接返回空", async () => {
  let baiduHitCount = 0;
  stubFetch((url) => {
    if (url.includes("baidu.com/s")) {
      baiduHitCount++;
      return '<html><body><a href="https://baike.example.com/alpha">航天电子主营业务介绍</a></body></html>';
    }
    if (url.includes("sogou.com/web") || url.includes("html.duckduckgo.com")) return "";
    return "";
  });

  const items = await searchWebMultiEngine("航天电子 最新动态", 8, opts);
  assert.equal(baiduHitCount, 0, "只信 anysearch：不得调用百度兜底");
  assert.equal(items.length, 0, "API 不可用时应返回空，不给兜底结果");
});

// ---- 百度解析：合法的绝对链接 + 足够长的标题才算一条 ----
test("百度结果解析：提取绝对链接与标题，过滤导航噪音", async () => {
  stubFetch((url) => {
    if (!url.includes("baidu.com/s")) return "";
    return [
      '<html><body>',
      '<div class="result"><a href="https://news.example.com/a">航天电子获机构密集调研</a></div>',
      '<a href="#">首页</a>',
      '<div class="result"><a href="javascript:void(0)">点击</a></div>',
      '<a href="https://news.example.com/b">航天电子 11 月以来股价走势</a>',
      '</body></html>',
    ].join("");
  });

  const items = await searchBaiduChina("航天电子", 8, opts);
  assert.ok(Array.isArray(items), "应返回数组");
  for (const item of items) {
    assert.match(item.url, /^https?:\/\//, "链接应为绝对 http(s)");
    assert.ok(item.title.length >= 6, "标题应足够长以过滤导航噪音");
  }
});

// ---- RssHealthMonitor：连续失败指数冷却 + 超阈值永久降级 + 成功恢复 ----
test("RssHealthMonitor：低阈值降级冷却指数拉长、高阈值永久降级、成功即恢复", () => {
  const monitor = new RssHealthMonitor({ failureThreshold: 3, cooldownMs: 1000, permanentThreshold: 8 });
  assert.ok(monitor.isAvailable("src"), "初始可用");

  // 连续 3 次失败 → 降级
  monitor.recordFailure("src");
  monitor.recordFailure("src");
  monitor.recordFailure("src");
  assert.equal(monitor.isAvailable("src"), false, "达到阈值后应降级");

  // 永久降级：连续 8 次失败后即使冷却期过去也不恢复
  for (let i = 0; i < 8; i++) monitor.recordFailure("src");
  assert.equal(monitor.isAvailable("src"), false, "死源应永久降级");

  // 一次成功即恢复正常
  monitor.recordSuccess("src");
  assert.equal(monitor.isAvailable("src"), true, "成功后应恢复");
});

// ---- RssHealthMonitor：瞬时 1-2 次失败不应过早降级 ----
test("RssHealthMonitor：瞬时失败不误伤健康源", () => {
  const monitor = new RssHealthMonitor({ failureThreshold: 3, cooldownMs: 1000 });
  monitor.recordFailure("a");
  monitor.recordFailure("a");
  assert.equal(monitor.isAvailable("a"), true, "未达阈值前仍可用");
});

// ---- 抖音热榜兜底：mcporter 未配置时用官方热榜接口返回热点 ----
test("抖音兜底：mcporter 不可用时返回官方热榜（douyin-hot）", async () => {
  // stub InfoHub：search 返回空（模拟搜索引擎对 site: 无平台域名命中）
  const infoHub = {
    search: async () => [] as unknown[],
  } as unknown as InfoHubService;
  const svc = new UpstreamSearchService(infoHub);

  // fetch stub：仅抖音热榜 URL 返回 word_list，其余返回空
  stubFetch((url) => {
    if (url.includes("/aweme/v1/web/hot/search/list/")) {
      return JSON.stringify({
        data: { word_list: [{ word: "测试热点", hot_value: 999, sentence: "热点描述" }] },
      });
    }
    return "";
  });

  // mcporter 未安装 → execFile ENOENT → 触发 relay 兜底，命中抖音热榜
  const hit = await svc.searchDouyin("随便什么关键词", 8);
  assert.equal(hit.provider, "douyin-hot", "应降级为抖音热榜");
  assert.match(hit.raw, /测试热点/, "热词应出现在 raw 中");
  assert.match(hit.raw, /https:\/\/www\.douyin\.com\/search\//, "热词应带抖音搜索页链接");
});

// ---- 搜索 API provider：未配置时返回 null（走爬网页兜底） ----
test("搜索 API：未配置 SEARCH_API_PROVIDER 时返回 null", async () => {
  const savedProvider = process.env.SEARCH_API_PROVIDER;
  const savedKey = process.env.SEARCH_API_KEY;
  delete process.env.SEARCH_API_PROVIDER;
  delete process.env.SEARCH_API_KEY;
  try {
    const { searchViaSearchApi } = await import("../src/services/search-api-provider.js");
    assert.equal(await searchViaSearchApi("航天电子", 8), null, "未配置应返回 null 以走爬网页兜底");
  } finally {
    if (savedProvider !== undefined) process.env.SEARCH_API_PROVIDER = savedProvider;
    else delete process.env.SEARCH_API_PROVIDER;
    if (savedKey !== undefined) process.env.SEARCH_API_KEY = savedKey;
    else delete process.env.SEARCH_API_KEY;
  }
});

// ---- 搜索 API provider：Tavily 解析 ----
test("搜索 API：Tavily 返回结构化结果", async () => {
  const savedProvider = process.env.SEARCH_API_PROVIDER;
  const savedKey = process.env.SEARCH_API_KEY;
  process.env.SEARCH_API_PROVIDER = "tavily";
  process.env.SEARCH_API_KEY = "tvly-test";
  try {
    stubFetch((url) => {
      if (url.includes("api.tavily.com/search")) {
        return JSON.stringify({
          results: [
            { title: "航天电子最新动态", url: "https://news.example.com/1", content: "摘要内容", published_date: "2026-08-19" },
            { title: "航天电子业绩说明", url: "https://news.example.com/2", content: "另一摘要", published_date: "" },
            { title: "非法记录", url: "not-a-url", content: "x" },
          ],
        });
      }
      return "";
    });
    const { searchViaSearchApi } = await import("../src/services/search-api-provider.js");
    const items = await searchViaSearchApi("航天电子", 5);
    assert.ok(Array.isArray(items), "应返回数组");
    assert.equal(items!.length, 2, "应过滤掉非法 URL");
    assert.equal(items![0].source, "Tavily");
    assert.equal(items![0].publishedAt, "2026-08-19");
  } finally {
    if (savedProvider !== undefined) process.env.SEARCH_API_PROVIDER = savedProvider;
    else delete process.env.SEARCH_API_PROVIDER;
    if (savedKey !== undefined) process.env.SEARCH_API_KEY = savedKey;
    else delete process.env.SEARCH_API_KEY;
  }
});

// ---- 搜索 API provider：Serper / Bing 解析 ----
test("搜索 API：Serper 与 Bing 解析一致", async () => {
  const savedProvider = process.env.SEARCH_API_PROVIDER;
  const savedKey = process.env.SEARCH_API_KEY;
  process.env.SEARCH_API_KEY = "k-test";
  try {
    const { searchViaSearchApi } = await import("../src/services/search-api-provider.js");

    process.env.SEARCH_API_PROVIDER = "serper";
    stubFetch((url) => {
      if (url.includes("serper.dev/search")) {
        return JSON.stringify({ organic: [{ title: "A", link: "https://a.example", snippet: "s1", date: "" }] });
      }
      return "";
    });
    const serper = await searchViaSearchApi("查询", 5);
    assert.equal(serper![0].source, "Serper");

    process.env.SEARCH_API_PROVIDER = "bing";
    stubFetch((url) => {
      if (url.includes("api.cognitive.microsoft.com")) {
        return JSON.stringify({ webPages: { value: [{ name: "B", url: "https://b.example", snippet: "s2", datePublished: "" }] } });
      }
      return "";
    });
    const bing = await searchViaSearchApi("查询", 5);
    assert.equal(bing![0].source, "Bing API");
  } finally {
    if (savedProvider !== undefined) process.env.SEARCH_API_PROVIDER = savedProvider;
    else delete process.env.SEARCH_API_PROVIDER;
    if (savedKey !== undefined) process.env.SEARCH_API_KEY = savedKey;
    else delete process.env.SEARCH_API_KEY;
  }
});

// ---- 实时热点榜单：多平台聚合，失败平台不影响其他平台 ----
test("热点榜单：微博+B站成功、知乎失败时仍返回前两者", async () => {
  const { fetchHotRankings } = await import("../src/services/hot-rankings.js");
  stubFetch((url) => {
    if (url.includes("weibo.com/ajax/side/hotSearch")) {
      return JSON.stringify({
        data: { realtime: [{ word: "测试热点A", num: 12345, is_hot: true }] },
      });
    }
    if (url.includes("bilibili.com/x/web-interface/ranking")) {
      return JSON.stringify({
        data: { list: [{ title: "测试视频B", bvid: "BV1xx411" }] },
      });
    }
    return ""; // 知乎失败 → 空响应
  });

  const onlyWeibo = await fetchHotRankings(20, ["weibo", "zhihu", "bilibili"]);
  assert.equal(onlyWeibo.fetchedSources.length, 2, "知乎失败不应计入 fetchedSources");
  assert.ok(onlyWeibo.fetchedSources.includes("weibo"));
  assert.ok(onlyWeibo.fetchedSources.includes("bilibili"));
  assert.ok(onlyWeibo.notes.some((n) => n.includes("知乎")), "应有知乎不可用说明");
  const weibo = onlyWeibo.items.find((it) => it.platform === "weibo");
  assert.ok(weibo, "应包含微博热点");
  assert.equal(weibo!.title, "测试热点A");
  assert.match(weibo!.url!, /s\.weibo\.com/, "微博应带搜索跳转链接");
  const b = onlyWeibo.items.find((it) => it.platform === "bilibili");
  assert.equal(b!.url, "https://www.bilibili.com/video/BV1xx411");
});

test("热点榜单：全部失败时 items 为空且给出说明", async () => {
  const { fetchHotRankings } = await import("../src/services/hot-rankings.js");
  stubFetch(() => "");
  const empty = await fetchHotRankings(10, ["weibo", "baidu"]);
  assert.equal(empty.items.length, 0, "全部失败应返回空数组");
  assert.equal(empty.fetchedSources.length, 0);
  assert.ok(empty.notes.length >= 2, "每个失败平台应有一条说明");
});

// ---- token/性能：searchWeb query 级缓存（重复 query 命中，不再走底层） ----
test("searchWeb：相同 query+limit 命中 30s 缓存，只调一次底层", async () => {
  const { UpstreamSearchService } = await import("../src/services/upstream-search-service.js");
  const infoHub = {
    search: async () => {
      count++;
      return [
        { title: "结果A", url: "https://a.example/x", snippet: "s1", source: "A" },
      ] as Array<Record<string, unknown>>;
    },
  } as unknown as { search: () => Promise<unknown[]> };
  let count = 0;
  const svc = new UpstreamSearchService(infoHub);
  const r1 = await svc.searchWeb("航天 最新", 5);
  const r2 = await svc.searchWeb("航天 最新", 5);
  assert.equal(count, 1, "第二次应命中缓存，不再调用底层");
  assert.equal(r1.items.length, r2.items.length);
  assert.match(JSON.stringify(r2), /缓存/, "缓冲命中应有标识 note");
});