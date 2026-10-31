/**
 * 飞猪酒店「浏览器补价」源契约测试。
 *
 * 要守住的三条：
 *   1. API 能出实价时不去开浏览器（不重复取数、不抢面板）
 *   2. 解析不到就不报价，绝不把脱敏价「¥2x」当价格
 *   3. 内置浏览器不可用/未登录时如实报错，原因可直接转告用户
 */

import test from "node:test";
import assert from "node:assert/strict";

import type { ToolContext } from "../src/tools/tool-registry.js";
import type { FlyAiRunner } from "../src/services/booking/quote/flyai-quote-source.js";
import type { BrowserRunner } from "../src/services/booking/quote/browser-quote-source.js";
import {
  createFliggyHotelWebSource,
  fliggyHotelDetailUrl,
  parseFliggyHotelDetailPrice,
} from "../src/services/booking/quote/hotel-web-price-source.js";
import type { QuoteRequest } from "../src/services/booking/quote/quote-source.js";

const ctx = { sessionId: "hotel-web", userId: "u-web" } as ToolContext;

const REQ: QuoteRequest = {
  type: "hotel",
  city: "三亚",
  checkInDate: "2026-11-01",
  checkOutDate: "2026-11-02",
};

const TRIAL_MSG = "*当前为体验模式，部分搜索结果可能受限，请前往 飞猪AI开放平台 获取正式API Key。*";

function flyaiStub(systemMessage: string, items: Array<Record<string, unknown>>): FlyAiRunner {
  return async () => ({
    ok: true,
    stdout: JSON.stringify({ status: 0, message: "success", systemMessage, data: { itemList: items } }),
    stderr: "",
  });
}

const TRIAL_ITEMS = [
  { name: "漫旅途青年旅舍", price: "¥2x", shId: "74599021", detailUrl: "https://router.feizhu.com/x" },
  { name: "三亚浪迹天涯客栈", price: "¥3x", shId: "56471525" },
];

function browserStub(pages: Record<string, string>): {
  runner: BrowserRunner;
  opened: string[];
} {
  const opened: string[] = [];
  let seq = 0;
  const bySession = new Map<string, string>();
  return {
    opened,
    runner: {
      async open(_c, url) {
        opened.push(url);
        const id = `s${seq++}`;
        bySession.set(id, url);
        const text = pages[url];
        return text === undefined
          ? { ok: false, error: "内置浏览器不可用（客户端未在线或未开启浏览器调试端口）" }
          : { ok: true, sessionId: id };
      },
      async extractText(_c, sessionId) {
        const url = bySession.get(sessionId);
        return url && pages[url] !== undefined
          ? { ok: true, sessionId, text: pages[url] }
          : { ok: false, error: "空页面" };
      },
      async close() {
        return { ok: true };
      },
    },
  };
}

function detailUrl(shId: string): string {
  return fliggyHotelDetailUrl(shId, REQ);
}

test("详情页 URL 带 shid 与入住/退房日期", () => {
  const url = detailUrl("74599021");
  assert.ok(url.startsWith("https://hotel.fliggy.com/hotel_detail2.htm?"));
  assert.ok(url.includes("shid=74599021"));
  assert.ok(url.includes("checkIn=2026-11-01") && url.includes("checkOut=2026-11-02"));
});

test("API 已给实价时让位：不开浏览器、不重复取数", async () => {
  const browser = browserStub({});
  const source = createFliggyHotelWebSource({
    flyai: flyaiStub("", [{ name: "有价酒店", price: "¥399", shId: "1" }]),
    browser: browser.runner,
    settleMs: 0,
  });
  const res = await source.fetch(REQ, ctx);
  assert.equal(res.ok, true);
  assert.ok(res.ok && res.quotes.length === 0);
  assert.deepEqual(browser.opened, [], "非体验模式不应打开内置浏览器");
});

test("体验模式脱敏价 → 内置浏览器开详情页补出实价", async () => {
  const browser = browserStub({
    [detailUrl("74599021")]:
      "三亚酒店\n漫旅途青年旅舍\n经济型 · 凤凰路椰景蓝岸\n今日特价 ¥268 起\n房型\n海景大床房 ¥319\n标准间 ¥268",
    [detailUrl("56471525")]:
      "三亚浪迹天涯客栈\n解放路911号\n¥352 起",
  });
  const source = createFliggyHotelWebSource({
    flyai: flyaiStub(TRIAL_MSG, TRIAL_ITEMS),
    browser: browser.runner,
    settleMs: 0,
  });
  const res = await source.fetch(REQ, ctx);
  assert.equal(res.ok, true, res.ok ? "" : res.error);
  assert.ok(res.ok && res.quotes.length === 2);
  assert.ok(res.ok && res.quotes[0].amountCny === 268, "取酒店名之后的最低价");
  assert.ok(res.ok && res.quotes[0].priceSource === "scraped");
  assert.ok(res.ok && (res.quotes[0].note ?? "").includes("页面实价为准"));
  assert.equal(browser.opened.length, 2);
});

test("页面停在登录墙 → ok:false 并给出可转告的指引", async () => {
  const browser = browserStub({
    [detailUrl("74599021")]: "密码登录 短信登录 扫码登录 打开淘宝APP 扫一扫",
    [detailUrl("56471525")]: "密码登录 短信登录 扫码登录",
  });
  const source = createFliggyHotelWebSource({
    flyai: flyaiStub(TRIAL_MSG, TRIAL_ITEMS),
    browser: browser.runner,
    settleMs: 0,
  });
  const res = await source.fetch(REQ, ctx);
  assert.equal(res.ok, false);
  assert.ok(!res.ok && res.error.includes("登录"), res.ok ? "" : res.error);
});

test("内置浏览器不在线 → 如实报错，不回退去编一个价", async () => {
  const browser = browserStub({});
  const source = createFliggyHotelWebSource({
    flyai: flyaiStub(TRIAL_MSG, TRIAL_ITEMS),
    browser: browser.runner,
    settleMs: 0,
  });
  const res = await source.fetch(REQ, ctx);
  assert.equal(res.ok, false);
  assert.ok(!res.ok && res.error.includes("内置浏览器"), res.ok ? "" : res.error);
});

test("解析器：酒店名不在页面 / 只有脱敏价 → 一律不报价", () => {
  const noName = parseFliggyHotelDetailPrice("¥199 起 限时特惠", "漫旅途青年旅舍");
  assert.equal(noName.priceCny, null, "页面没有这家酒店 → 不张冠李戴");

  const masked = parseFliggyHotelDetailPrice("漫旅途青年旅舍\n¥2x 起", "漫旅途青年旅舍");
  assert.equal(masked.priceCny, null, "脱敏价不当作实价");

  const priced = parseFliggyHotelDetailPrice("漫旅途青年旅舍\n海景房 ¥428\n标准间 ¥268", "漫旅途青年旅舍");
  assert.equal(priced.priceCny, 268);
});

test("浏览器源自报超时预算，不被聚合器默认 20s 掐掉", () => {
  const source = createFliggyHotelWebSource({
    flyai: flyaiStub(TRIAL_MSG, TRIAL_ITEMS),
    browser: browserStub({}).runner,
    maxHotels: 4,
    settleMs: 4_000,
  });
  assert.ok((source.timeoutMs ?? 0) > 60_000, `实际 ${source.timeoutMs}`);
});
