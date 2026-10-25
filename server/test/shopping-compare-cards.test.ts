/**
 * 比价卡升级链路测试（2026-10-24）：
 *   1. shopping.compare.prices builder：缩略图（imageUrl）+ 整行可点（url）
 *      + 疑似同款标注 + 决策页入口行
 *   2. shopping.compare.watch builder：建档/列表卡
 *   3. shopping.compare.research builder：可点来源清单 + disclaimer
 *   4. ShoppingCompareService：CompareGroup 代表图透传 + onCompareResult →
 *      decisionPageUrl 回填
 *   5. 决策页存储 + 路由（POST 直投 / 页面取数 / 过期兜底）
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Fastify from "fastify";

import { buildToolCard } from "../src/services/tool-card-registry.js";
import {
  ShoppingCompareService,
  groupSameProducts,
  type TaggedProduct,
} from "../src/services/shopping-compare-service.js";
import type { ShoppingOrderService } from "../src/services/shopping-order-service.js";
import type { ToolContext } from "../src/tools/tool-registry.js";
import {
  getShoppingDecisionPage,
  recordShoppingDecisionPage,
} from "../src/services/shopping-decision-store.js";
import { registerShoppingDecisionRoutes } from "../src/routes/http/shopping-decision.js";

/* ─────────────── 1. compare.prices builder ─────────────── */

function compareResultFixture(): Record<string, unknown> {
  return {
    ok: true,
    query: "Sony WH-1000XM5",
    groups: [
      {
        matchType: "exact",
        confidence: 1,
        minPriceCny: 1869,
        imageUrl: "https://img.example.com/xm5.jpg",
        offers: [
          {
            platform: "拼多多", title: "Sony WH-1000XM5 头戴降噪耳机", priceCny: 1869,
            shop: "百亿补贴", url: "https://pdd.com/xm5", imageUrl: "https://img.example.com/xm5.jpg",
          },
          { platform: "京东", title: "Sony WH-1000XM5 头戴降噪耳机", priceCny: 1899, url: "https://jd.com/xm5" },
        ],
      },
      {
        matchType: "similar",
        confidence: 0.72,
        minPriceCny: 1999,
        offers: [
          { platform: "抖音", title: "索尼 WH-1000XM5 头戴式耳机 国行", priceCny: 1999, url: "https://dy.com/x" },
        ],
      },
    ],
    bestOffer: { platform: "拼多多", priceCny: 1869, url: "https://pdd.com/xm5" },
  };
}

test("compare.prices 卡：行带缩略图与可点链接，疑似同款标注，决策页行", () => {
  const p = buildToolCard("shopping.compare.prices", {
    ...compareResultFixture(),
    decisionPageUrl: "/shopping/decision-page?id=abc123",
  });
  assert.ok(p);
  assert.equal(p.cardType, "");
  assert.ok(p.title.includes("比价结果"));
  // 两组报价 + 1 行决策页入口
  assert.equal(p.items.length, 3);
  const row0 = p.items[0]!;
  assert.ok(row0.text.includes("¥1869"), `实际：${row0.text}`);
  assert.ok(row0.text.includes("[拼多多]"));
  assert.ok(row0.text.includes("等2家"), `应标注组内报价数：${row0.text}`);
  assert.equal(row0.url, "https://pdd.com/xm5");
  assert.equal(row0.thumbnailUrl, "https://img.example.com/xm5.jpg");
  const row1 = p.items[1]!;
  assert.ok(row1.text.includes("疑似同款"));
  assert.equal(row1.url, "https://dy.com/x");
  // 无图的组不产出 thumbnailUrl 字段
  assert.equal(row1.thumbnailUrl, undefined);
  const dpRow = p.items[2]!;
  assert.ok(dpRow.text.includes("决策页"));
  assert.equal(dpRow.url, "/shopping/decision-page?id=abc123");
  assert.ok(p.footer!.includes("¥1869 来自 拼多多"));
});

test("compare.prices 卡：无图无链接的旧形态回执仍出卡（向后兼容）", () => {
  const p = buildToolCard("shopping.compare.prices", {
    query: "戴森 V8",
    groups: [
      {
        matchType: "exact",
        offers: [{ platform: "京东", title: "戴森 V8 Fluffy", priceCny: 1899, shop: "京东自营" }],
      },
    ],
  });
  assert.ok(p);
  assert.equal(p.items.length, 1);
  assert.equal(p.items[0]!.url, undefined);
  assert.equal(p.items[0]!.thumbnailUrl, undefined);
  // 无决策页存档时不追加入口行
  assert.ok(!p.items[0]!.text.includes("决策页"));
});

test("order.search 卡：单平台搜索与比价卡同版式（缩略图+可点行+最低价 footer）", () => {
  const p = buildToolCard("shopping.order.search", {
    ok: true,
    query: "小米 15",
    platform: "taobao",
    summary: "在taobao搜索「小米 15」找到 2 个商品",
    products: [
      { title: "小米15 御中版 12+256", price: 3799, shop: "能良数码官方旗舰店", url: "https://item.taobao.com/item.htm?id=1" },
      { title: "小米15 御中版 16+512", price: 4099, shop: "能良数码官方旗舰店", url: "https://item.taobao.com/item.htm?id=2" },
    ],
  });
  assert.ok(p);
  assert.equal(p.cardType, "");
  assert.ok(p.title!.includes("搜索结果：小米 15 · taobao"));
  assert.equal(p.items.length, 2);
  assert.ok(p.items[0]!.text.includes("¥3799"));
  assert.equal(p.items[0]!.url, "https://item.taobao.com/item.htm?id=1");
  assert.ok(p.footer!.includes("最低 ¥3799"));
});

/* ─────────────── 2. compare.watch builder ─────────────── */

test("compare.watch 卡：add 建档 → 标题已建档 + 每条监控一行", () => {
  const p = buildToolCard("shopping.compare.watch", {
    ok: true,
    action: "add",
    summary: "已开始监控",
    count: 2,
    watches: [
      { watchId: "w1", query: "Sony WH-1000XM5", platform: "拼多多", targetPrice: 1700, lastPriceCny: 1869 },
      { watchId: "w2", query: "AirPods Pro", platform: "京东", targetPrice: 1500, lastPriceCny: null },
    ],
  });
  assert.ok(p);
  assert.equal(p.title, "降价监控 · 已建档");
  assert.equal(p.items.length, 2);
  assert.ok(p.items[0]!.text.includes("「Sony WH-1000XM5」@拼多多 目标 ≤¥1700（当前 ¥1869）"));
  assert.ok(p.items[1]!.text.includes("（待首次复查）"));
  assert.ok(p.footer!.includes("每 60 分钟"));
});

test("compare.watch 卡：空列表 / 失败回执 → null（回退文本路由）", () => {
  assert.equal(buildToolCard("shopping.compare.watch", { ok: true, action: "list", count: 0, watches: [] }), null);
  assert.equal(
    buildToolCard("shopping.compare.watch", { ok: false, error: "平台不支持", watches: [] }),
    null,
  );
});

/* ─────────────── 3. compare.research builder ─────────────── */

test("compare.research 卡：来源清单可点 + disclaimer footer + search_result 卡型", () => {
  const p = buildToolCard("shopping.compare.research", {
    ok: true,
    topic: "好医保 vs 平安e生保",
    summary: "检索到 2 条资料",
    sources: [
      {
        title: "百万医疗险横向测评（2026 版）",
        snippet: "从保费/保额/免赔额/续保四个维度对比",
        url: "https://example.com/review",
        source: "测评站",
      },
      { title: "好医保长期医疗条款摘要", url: "https://example.com/t1", source: "官方" },
      { title: "重复来源应去重", url: "https://example.com/review", source: "测评站" },
      { title: "", url: "", source: "" },
    ],
    disclaimer: "以上为网页调研结果，仅供参考。",
  });
  assert.ok(p);
  assert.equal(p.cardType, "search_result");
  assert.equal(p.title, "调研对比：好医保 vs 平安e生保");
  assert.equal(p.items.length, 2, "重复 url 与空条目应被过滤");
  assert.equal(p.items[0]!.url, "https://example.com/review");
  assert.ok(p.items[0]!.text.includes("四个维度"));
  assert.ok(p.footer!.includes("仅供参考"));
});

/* ─────────────── 4. Service：代表图 + 决策页回填 ─────────────── */

function stubOrderService(
  productsByPlatform: Record<string, Array<{ title: string; price?: number; url?: string; imageUrl?: string; shop?: string }>>,
): ShoppingOrderService {
  return {
    listSupportedPlatforms: () => Object.keys(productsByPlatform),
    searchProduct: async (_ctx: unknown, platform: string) => ({
      ok: true,
      products: productsByPlatform[platform] ?? [],
    }),
  } as unknown as ShoppingOrderService;
}

function makeCtx(): ToolContext {
  return { sessionId: "test-cards", userId: "user-cards" };
}

test("groupSameProducts：组代表图取组内首个带 imageUrl 的报价", () => {
  const tagged: TaggedProduct[] = [
    { platform: "jd", product: { title: "Sony WH-1000XM5 头戴降噪耳机", price: 1899 } },
    {
      platform: "pdd",
      product: {
        title: "Sony WH-1000XM5 头戴降噪耳机",
        price: 1869,
        imageUrl: "https://img.example.com/xm5.jpg",
      },
    },
  ];
  const groups = groupSameProducts(tagged);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]!.imageUrl, "https://img.example.com/xm5.jpg");
});

test("comparePrices：onCompareResult 返回 id → 回执携带 decisionPageUrl", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "npc-"));
  try {
    const seen: Array<Record<string, unknown>> = [];
    const service = new ShoppingCompareService({
      shoppingOrderService: stubOrderService({
        pdd: [{ title: "Sony WH-1000XM5 头戴降噪耳机", price: 1869, url: "https://pdd.com/x", imageUrl: "https://img/x.jpg" }],
        jd: [{ title: "Sony WH-1000XM5 头戴降噪耳机", price: 1899, url: "https://jd.com/x" }],
      }),
      onCompareResult: (_actorId, payload) => {
        seen.push(payload as unknown as Record<string, unknown>);
        return "dp_test_id";
      },
      dataDir,
    });
    const res = await service.comparePrices(makeCtx(), "Sony WH-1000XM5");
    assert.ok(res.ok);
    assert.equal(seen.length, 1);
    const payload = seen[0]!;
    assert.equal(payload.query, "Sony WH-1000XM5");
    assert.ok(payload.groups);
    const typed = res as unknown as Record<string, unknown>;
    assert.equal(typed.decisionPageUrl, "/shopping/decision-page?id=dp_test_id");
    assert.ok(typed.fetchedAt);
    await service.flush(); // 价格历史异步落盘，先等写完再清临时目录
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("comparePrices：onCompareResult 抛异常不影响比价回执", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "npc-"));
  try {
    const service = new ShoppingCompareService({
      shoppingOrderService: stubOrderService({
        pdd: [{ title: "Sony WH-1000XM5", price: 1869 }],
      }),
      onCompareResult: () => {
        throw new Error("store down");
      },
      dataDir,
    });
    const res = await service.comparePrices(makeCtx(), "Sony WH-1000XM5");
    assert.ok(res.ok);
    assert.equal((res as unknown as Record<string, unknown>).decisionPageUrl, undefined);
    await service.flush();
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

/* ─────────────── 5. 决策页存储 + 路由 ─────────────── */

function decisionPayload(): Record<string, unknown> {
  return {
    actorId: "user-cards",
    query: "Sony WH-1000XM5",
    searchedPlatforms: ["pdd", "jd"],
    groups: [
      {
        matchType: "exact",
        minPriceCny: 1869,
        imageUrl: "https://img.example.com/xm5.jpg",
        offers: [
          { platform: "拼多多", title: "Sony WH-1000XM5", priceCny: 1869, url: "https://pdd.com/x" },
        ],
      },
    ],
    bestOffer: { platform: "拼多多", priceCny: 1869, url: "https://pdd.com/x" },
    fetchedAt: 1761270000000,
  };
}

test("决策页存储：record → get 幂等取回；未知 id → null", () => {
  const id = recordShoppingDecisionPage(decisionPayload() as Parameters<typeof recordShoppingDecisionPage>[0]);
  assert.ok(id.length >= 8);
  const got = getShoppingDecisionPage(id);
  assert.ok(got);
  assert.equal(got!.query, "Sony WH-1000XM5");
  assert.equal(getShoppingDecisionPage("no_such_id"), null);
});

test("决策页路由：POST 直投 → 页面 HTML 可载 → :id 取数渲染", async () => {
  const app = Fastify();
  registerShoppingDecisionRoutes(app);
  await app.ready();

  const post = await app.inject({
    method: "POST",
    url: "/shopping/decision-pages",
    payload: decisionPayload(),
  });
  assert.equal(post.statusCode, 200);
  const { id, url } = post.json() as { id: string; url: string };
  assert.ok(id);
  assert.equal(url, `/shopping/decision-page?id=${id}`);

  const page = await app.inject({ method: "GET", url: "/shopping/decision-page" });
  assert.equal(page.statusCode, 200);
  assert.match(page.headers["content-type"] as string, /text\/html/);
  assert.ok(page.body.includes("比价决策"), "页面标识");
  assert.ok(page.body.includes("/shopping/decision-pages/"), "页面要同源取数");

  const data = await app.inject({ method: "GET", url: `/shopping/decision-pages/${id}` });
  assert.equal(data.statusCode, 200);
  const json = data.json() as { query?: string; groups?: unknown[] };
  assert.equal(json.query, "Sony WH-1000XM5");
  assert.ok(Array.isArray(json.groups) && json.groups.length === 1);

  const missing = await app.inject({ method: "GET", url: "/shopping/decision-pages/does_not_exist" });
  assert.equal(missing.statusCode, 404);

  const badPost = await app.inject({
    method: "POST",
    url: "/shopping/decision-pages",
    payload: { noQuery: true },
  });
  assert.equal(badPost.statusCode, 400);

  await app.close();
});

test("决策页路由：POST /shopping/compare 只读触发（缺服务 503 / 缺 query 400 / 正常透传）", async () => {
  // 缺服务 → 503（比价服务未装配）
  const appNoDeps = Fastify();
  registerShoppingDecisionRoutes(appNoDeps);
  await appNoDeps.ready();
  const s503 = await appNoDeps.inject({
    method: "POST",
    url: "/shopping/compare",
    payload: { query: "x" },
  });
  assert.equal(s503.statusCode, 503);
  await appNoDeps.close();

  // 带服务：透传 query/platforms/actorId 到 comparePrices，回执原样返回
  const calls: Array<{ query: string; opts: Record<string, unknown>; ctx: unknown }> = [];
  const stubService = {
    comparePrices: async (ctx: unknown, query: string, opts: Record<string, unknown>) => {
      calls.push({ query, opts, ctx });
      return { ok: true, query, decisionPageUrl: "/shopping/decision-page?id=t1" };
    },
  } as unknown as ShoppingCompareService;
  const app = Fastify();
  registerShoppingDecisionRoutes(app, { shoppingCompareService: stubService });
  await app.ready();

  const missing = await app.inject({
    method: "POST",
    url: "/shopping/compare",
    payload: { noQuery: true },
  });
  assert.equal(missing.statusCode, 400);

  const okRes = await app.inject({
    method: "POST",
    url: "/shopping/compare",
    payload: { query: "iPhone 16 128G", platforms: ["jd", "taobao"], actorId: "u1", limit: 3 },
  });
  assert.equal(okRes.statusCode, 200);
  assert.equal(okRes.json().ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.query, "iPhone 16 128G");
  const opts = calls[0]!.opts as { platforms?: string[]; limit?: number };
  assert.deepEqual(opts.platforms, ["jd", "taobao"]);
  assert.equal(opts.limit, 3);
  const ctx = calls[0]!.ctx as { userId?: string };
  assert.equal(ctx.userId, "u1");

  await app.close();
});
