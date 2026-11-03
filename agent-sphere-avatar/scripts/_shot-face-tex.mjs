/** 抓脸部屏调试页（纯 2D 绘制，用于和参考图逐像素对照） */
import { chromium } from "playwright-core";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = "E:/ws-project/NextBot/.scratch/face";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  args: ["--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 760, height: 760 }, deviceScaleFactor: 1 });

for (const expr of process.argv.slice(2).length ? process.argv.slice(2) : ["focused"]) {
  await page.goto(`http://127.0.0.1:5199/face-debug.html?expr=${expr}`, { waitUntil: "networkidle0" });
  await page.waitForFunction("window.__ready === true");
  const el = await page.$("#c");
  writeFileSync(join(OUT, `tex-${expr}.png`), await el.screenshot());
  console.log("→", `tex-${expr}.png`);
}

await browser.close();
