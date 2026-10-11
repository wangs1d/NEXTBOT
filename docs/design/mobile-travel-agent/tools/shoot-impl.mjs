/* ============================================================================
   接入后手机实拍：手机 UA 打开 /travel-map（服务端按 UA 分流到竖屏版），
   直接吃服务端真实行程仓库（?planId=，Agent 生成后落盘的真实行程），截五屏
   → 本目录 impl-*.png。全程无灌数、无占位数据。

   用法：
     node docs/design/mobile-travel-agent/tools/shoot-impl.mjs [planId]
     （不传 planId 时自动取仓库里最新一份真实行程）
   前置：本机 server 在 127.0.0.1:3000 运行；playwright 装在仓库根 node_modules。
   ========================================================================== */
import { chromium } from "playwright";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const designDir = resolve(here, "..");
const API = process.env.PA_API_BASE || "http://127.0.0.1:3000";
const shot = (name) => join(designDir, name);

let planId = process.argv[2];
if (!planId) {
  const list = (await (await fetch(`${API}/travel/plans`)).json()).plans || [];
  if (!list.length) throw new Error("真实行程仓库为空：先在应用里让 Agent 生成一份行程");
  planId = list.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0].planId;
}
console.log("planId:", planId);

const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: UA,
});
const p = await ctx.newPage();
const notes = [];
p.on("pageerror", (e) => notes.push("PAGEERR: " + e.message));
p.on("console", (m) => { if (m.type() === "error") notes.push("CONSOLE: " + m.text()); });
p.on("response", (r) => { if (r.status() >= 400) notes.push(`HTTP ${r.status()} ${r.url().slice(0, 110)}`); });

await p.goto(`${API}/travel-map?planId=${planId}`, { waitUntil: "load", timeout: 60000 });
await p.waitForTimeout(9000);   // 等真实实拍（/travel-poi/details）回填 + 远程图加载
console.log("home:", await p.evaluate(() =>
  `${document.getElementById('dayName').textContent} / ${document.getElementById('nowName').textContent} / ${document.getElementById('nowTime').textContent}`));
console.log("hint:", await p.evaluate(() => document.getElementById('signalHintText').textContent));
console.log("有手动信号控件?", await p.evaluate(() => document.querySelectorAll('.signal, .signal-row').length));
await p.screenshot({ path: shot("impl-1-home.png") });

await p.click("#nowCard");
await p.waitForTimeout(1600);
console.log("detail:", await p.evaluate(() =>
  `${document.getElementById('dName').textContent} | chips=${document.getElementById('dChips').children.length} | 贴士=${document.getElementById('dTips').children.length} | 信息=${document.getElementById('dInfo').children.length}`));
await p.screenshot({ path: shot("impl-2-detail.png") });

await p.click("#dMapBtn");
await p.waitForTimeout(6000);
console.log("map:", await p.evaluate(() =>
  (document.getElementById('mlWrap').classList.contains('on') ? 'maplibre' : 'svg') + " | " + document.getElementById('mapNowName').textContent));
await p.screenshot({ path: shot("impl-3-map.png") });

await p.click("#mapSheetBtn");
await p.waitForTimeout(1000);
console.log("sheet rows:", await p.evaluate(() => document.querySelectorAll('#sheetList .s-row').length));
await p.screenshot({ path: shot("impl-4-sheet.png") });

await p.click("#sheetClose");
await p.click("#mapClose");
await p.waitForTimeout(700);
// 实时信号改为 Agent 侧推入（页面无手动上报）：模拟宿主推送
await p.evaluate(() => window.__travelPanel.applySignal("rain", "雨要来了，接下来两站换成室内，<b>时间锚点不动</b>。"));
await p.waitForTimeout(1000);
console.log("signal:", await p.evaluate(() =>
  `${document.getElementById('moodText').textContent} | hint=${document.getElementById('signalHintText').textContent} | bubble=${document.getElementById('bubble').classList.contains('show')}`));
await p.screenshot({ path: shot("impl-5-signal.png") });

console.log(notes.length ? "NOTES:\n" + [...new Set(notes)].slice(0, 6).join("\n") : "clean: no errors");
await browser.close();
