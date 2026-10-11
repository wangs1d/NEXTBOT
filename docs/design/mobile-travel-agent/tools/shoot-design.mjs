/* ============================================================================
   设计稿实拍：渲染 docs/design/mobile-travel-agent/ 下的手机端页面，截各屏评审图。
   数据来自 plan-data.js（由 tools/build-plan.mjs 从服务端真实行程仓库生成）。
   产出：shot-*.png（分屏）+ mockup.png（评审长图）

   用法：
     node docs/design/mobile-travel-agent/tools/build-plan.mjs   # 先刷新真实数据
     node docs/design/mobile-travel-agent/tools/shoot-design.mjs
   前置：playwright 装在仓库根 node_modules。
   ========================================================================== */
import { chromium } from "playwright";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dir = resolve(here, "..");
const shot = (n) => join(dir, n);
const file = (n) => pathToFileURL(join(dir, n)).href;

const browser = await chromium.launch();

const mctx = await browser.newContext({
  viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
});
const p = await mctx.newPage();
p.on("pageerror", (e) => console.error("PAGEERR:", e.message));
await p.goto(file("mobile-home.html"), { waitUntil: "load" });
await p.waitForTimeout(6000);   // 等真实实拍图加载
console.log("home:", await p.evaluate(() => (window.PLAN ? window.PLAN.city + ' / ' + (curStops()[state.cur] || {}).name : '(no plan)')));
console.log("手动信号控件?", await p.evaluate(() => document.querySelectorAll('.signal, .signal-row').length));
await p.screenshot({ path: shot("shot-home.png") });

// 实时信号：改为 Agent 侧感知后推入
await p.evaluate(() => window.PA_TRAVEL_SIGNAL("rain", "雨要来了，接下来两站换成室内，<b>时间锚点不动</b>。"));
await p.waitForTimeout(1200);
console.log("signal:", await p.evaluate(() => document.getElementById('moodText').textContent + ' | ' + document.getElementById('signalHintText').textContent));
await p.screenshot({ path: shot("shot-signal.png") });

await p.click("#mapBtn");
await p.waitForTimeout(6000);
await p.screenshot({ path: shot("shot-map.png") });

await p.click("#mapSheetBtn");
await p.waitForTimeout(1200);
await p.screenshot({ path: shot("shot-sheet.png") });

const p2 = await mctx.newPage();
p2.on("pageerror", (e) => console.error("PAGEERR2:", e.message));
// 详情页挑一个真实仓库里自带实拍的站（d0s2 崇圣寺三塔）；无实拍的站会回落 noimg 渐变
await p2.goto(file("mobile-detail.html") + "?stop=d0s2&day=0", { waitUntil: "load" });
await p2.waitForTimeout(6000);
console.log("detail:", await p2.evaluate(() => (window.PLAN ? (curStops()[state.cur] || {}).name : '(no plan)')));
await p2.screenshot({ path: shot("shot-detail.png") });

// 评审长图
const dctx = await browser.newContext({ viewport: { width: 1780, height: 1400 }, deviceScaleFactor: 2 });
const p3 = await dctx.newPage();
p3.on("pageerror", (e) => console.error("PAGEERR3:", e.message));
await p3.goto(file("mockup.html"), { waitUntil: "load" });
await p3.waitForTimeout(5000);
await p3.screenshot({ path: shot("mockup.png"), fullPage: true });

await browser.close();
console.log("done");
