/**
 * 酒店动态筛选契约测试（2026-11-02，修复「三亚只回青旅」问题）。
 *
 * 要守住的三条：
 *   1. 无筛选 = 无假设：默认 no_rank（平台相关度），绝不写死 price_asc——
 *      那会把 ¥24 青旅客栈顶到最前，海边度假酒店永远进不了名单
 *   2. 用户说了什么就透传什么：靠海→key-words、大东海→poi-name、
 *      价格区间→max-price、民宿→hotel-types、便宜→price_asc，原样进 CLI 参数
 *   3. 两个酒店源（FlyAI API / 内置浏览器补价）共用同一拼参函数，
 *      筛选条件对两者同等生效；tier 只在显式给出时映射星级
 */

import test from "node:test";
import assert from "node:assert/strict";

import type { ToolContext } from "../src/tools/tool-registry.js";
import type { FlyAiRunner } from "../src/services/booking/quote/flyai-quote-source.js";
import type { BrowserRunner } from "../src/services/booking/quote/browser-quote-source.js";
import {
  createFlyAiHotelSource,
  flyAiHotelSearchArgs,
} from "../src/services/booking/quote/flyai-quote-source.js";
import { createFliggyHotelWebSource } from "../src/services/booking/quote/hotel-web-price-source.js";
import type { QuoteRequest } from "../src/services/booking/quote/quote-source.js";

const ctx = { sessionId: "dyn-filters", userId: "u-dyn" } as ToolContext;

const BASE: QuoteRequest = {
  type: "hotel",
  city: "三亚",
  checkInDate: "2026-11-03",
  checkOutDate: "2026-11-04",
};

/** 捕获 flyai 实参的桩（返回一条可报价项，让源走完整链路）。 */
function capturingFlyaiStub(captured: string[][]): FlyAiRunner {
  return async (args) => {
    captured.push([...args]);
    return {
      ok: true,
      stdout: JSON.stringify({
        status: 0,
        message: "success",
        systemMessage: "",
        data: { itemList: [{ name: "亚特兰蒂斯酒店", price: "¥1288", shId: "1001" }] },
      }),
      stderr: "",
    };
  };
}

function argsOf(captured: string[][]): Record<string, string> {
  const m: Record<string, string> = {};
  for (let i = 0; i < captured[0].length; i++) {
    const a = captured[0][i];
    if (a.startsWith("--")) m[a] = captured[0][i + 1] ?? "";
  }
  return m;
}

// ── flyAiHotelSearchArgs：拼参契约 ──

test("无筛选：默认 no_rank，不携带任何星级/价格/关键词假设", () => {
  const args = flyAiHotelSearchArgs(BASE);
  assert.ok(!args.includes("price_asc"), "通用查询绝不默认价格升序");
  assert.ok(args.includes("--sort") && args[args.indexOf("--sort") + 1] === "no_rank");
  assert.ok(!args.includes("--hotel-stars"), "用户没提档次不应加星级筛选");
  assert.ok(!args.includes("--key-words") && !args.includes("--poi-name") && !args.includes("--max-price"));
  // 日期照带
  assert.ok(args.includes("--check-in-date") && args.includes("2026-11-03"));
});

test("用户原话筛选逐项透传（靠海/大东海/价格区间/民宿/便宜）", () => {
  const args = flyAiHotelSearchArgs({
    ...BASE,
    filters: {
      keywords: "靠海",
      poiName: "大东海",
      maxPrice: 300,
      hotelTypes: "hotel,homestay",
      sort: "price_asc",
    },
  });
  assert.ok(args.includes("--key-words") && args.includes("靠海"));
  assert.ok(args.includes("--poi-name") && args.includes("大东海"));
  assert.ok(args.includes("--max-price") && args.includes("300"));
  assert.ok(args.includes("--hotel-types") && args.includes("hotel,homestay"));
  assert.ok(args.includes("--sort") && args[args.indexOf("--sort") + 1] === "price_asc", "用户要便宜才按价格升序");
});

test("定向酒店名与特色关键词合并进 key-words", () => {
  const args = flyAiHotelSearchArgs({
    ...BASE,
    hotelName: "亚特兰蒂斯",
    filters: { keywords: "海景房" },
  });
  const kw = args[args.indexOf("--key-words") + 1];
  assert.ok(kw.includes("亚特兰蒂斯") && kw.includes("海景房"));
});

test("星级：显式 hotelStars 优先；tier 仅在显式给出时映射（budget→1,2 / mid→3,4 / luxury→5）", () => {
  const explicit = flyAiHotelSearchArgs({ ...BASE, tier: "luxury", filters: { hotelStars: "4,5" } });
  assert.ok(explicit.includes("4,5"), "显式星级优先于 tier 推导");

  const fromTier = flyAiHotelSearchArgs({ ...BASE, tier: "luxury" });
  assert.ok(fromTier.includes("--hotel-stars") && fromTier.includes("5"));

  const noTier = flyAiHotelSearchArgs(BASE);
  assert.ok(!noTier.includes("--hotel-stars"), "tier 缺省 = 不假设档次");
});

test("非法/未知 sort 回退 no_rank，不把脏值传给 CLI", () => {
  const args = flyAiHotelSearchArgs({
    ...BASE,
    filters: { sort: "cheapest_first" as never },
  });
  assert.ok(args.includes("no_rank"));
});

// ── FlyAI API 源：筛选条件真实进入 CLI 调用 ──

test("API 源：filters 原样进入 flyai search-hotel 实参", async () => {
  const captured: string[][] = [];
  const source = createFlyAiHotelSource(capturingFlyaiStub(captured));
  const res = await source.fetch({
    ...BASE,
    filters: { keywords: "靠海", maxPrice: 300, sort: "price_asc" },
  }, ctx);
  assert.equal(res.ok, true);
  const m = argsOf(captured);
  assert.equal(m["--key-words"], "靠海");
  assert.equal(m["--max-price"], "300");
  assert.equal(m["--sort"], "price_asc");
});

// ── 浏览器补价源：同一筛选条件生效 ──

const TRIAL_MSG = "*当前为体验模式，部分搜索结果可能受限，请前往 飞猪AI开放平台 获取正式API Key。*";

test("浏览器补价源：体验模式名单按用户筛选条件取（复用同一拼参）", async () => {
  const captured: string[][] = [];
  const browser: BrowserRunner = {
    open: async () => ({ ok: true, sessionId: "s1" }),
    extractText: async () => ({
      ok: true,
      text: "亚特兰蒂斯酒店\n海景房 ¥1288\n标准间 ¥1188",
    }),
    close: async () => ({ ok: true }),
  };
  const source = createFliggyHotelWebSource({
    flyai: capturingFlyaiStub(captured),
    browser,
    settleMs: 0,
  });
  const res = await source.fetch({
    ...BASE,
    filters: { poiName: "海棠湾", hotelStars: "5", sort: "price_desc" },
  }, ctx);
  assert.equal(res.ok, true, res.ok ? "" : res.error);
  const m = argsOf(captured);
  assert.equal(m["--poi-name"], "海棠湾", "补价名单必须按用户要的商圈取");
  assert.equal(m["--hotel-stars"], "5");
  assert.equal(m["--sort"], "price_desc");
  assert.ok(!m["--sort"] || m["--sort"] !== "price_asc");
});
