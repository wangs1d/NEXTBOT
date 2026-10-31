/**
 * 平台搜索页诊断探针：真实 Playwright 开三平台搜索页，dump 最终 URL / 标题 /
 * 正文摘要 / adapter 选择器命中数——区分「登录墙拦截」vs「页面改版选择器失效」。
 * 用法：cd server && npx tsx scripts/shopping-compare-page-probe.ts
 */
import { chromium } from "playwright";

const QUERY = "伊利纯牛奶 250ml*24盒";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const targets = [
  {
    platform: "taobao",
    url: `https://s.taobao.com/search?q=${encodeURIComponent(QUERY)}&sort=price-asc`,
    cookieDomain: ".taobao.com",
    selectors: ['[class*="Card--doubleCardWrapper"]', '[class*="Content--contentInner"]', ".items .item", '[data-spm="dlist"]'],
  },
  {
    platform: "jd",
    url: `https://search.jd.com/Search?keyword=${encodeURIComponent(QUERY)}&enc=utf-8&psort=3`,
    cookieDomain: ".jd.com",
    selectors: ['[class*="gl-item"]', "li.gl-item", '[data-sku]'],
  },
  {
    platform: "pdd",
    url: `https://mobile.yangkeduo.com/search_result.html?search_key=${encodeURIComponent(QUERY)}`,
    cookieDomain: ".yangkeduo.com",
    selectors: [".product-item", '[class*="goods"]', '[class*="search-result"]'],
  },
];

const browser = await chromium.launch({ headless: true, args: ["--disable-blink-features=AutomationControlled"] });
for (const t of targets) {
  const context = await browser.newContext({ userAgent: UA, locale: "zh-CN" });
  await context.addCookies([
    { name: "t", value: "e2e-anonymous-probe", domain: t.cookieDomain, path: "/", secure: true },
  ]);
  const page = await context.newPage();
  try {
    await page.goto(t.url, { waitUntil: "domcontentloaded", timeout: 20_000 });
    await page.waitForTimeout(4_000);
    const finalUrl = page.url();
    const title = await page.title();
    const bodyText = (await page.evaluate(() => document.body?.innerText.slice(0, 400) ?? "")).replace(/\s+/g, " ");
    const selectorHits: Record<string, number> = {};
    for (const sel of t.selectors) {
      selectorHits[sel] = await page.locator(sel).count();
    }
    const priceish = await page.evaluate(() => {
      const m = document.body?.innerText.match(/[¥￥]\s?\d+(\.\d+)?/g);
      return m ? m.slice(0, 8) : [];
    });
    console.log(`\n──── ${t.platform} ────`);
    console.log(`finalURL: ${finalUrl}`);
    console.log(`title: ${title}`);
    console.log(`selectorHits: ${JSON.stringify(selectorHits)}`);
    console.log(`价格样文本: ${JSON.stringify(priceish)}`);
    console.log(`body摘要: ${bodyText.slice(0, 260)}`);
  } catch (err) {
    console.log(`\n──── ${t.platform} ────\n异常: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    await context.close();
  }
}
await browser.close();
