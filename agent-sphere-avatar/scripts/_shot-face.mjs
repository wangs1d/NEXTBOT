/**
 * 脸部屏验收截图：正面 + 多个表情 + 一次眨眼的帧序列（用来验收「丝滑连贯」）。
 *
 * 用法：npx vite --port 5199 另开终端，然后 node scripts/_shot-face.mjs
 */
import { chromium } from "playwright-core";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const OUT = "E:/ws-project/NextBot/.scratch/face";
const URL = process.env.SHOT_URL ?? "http://127.0.0.1:5199/overlay.html";
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 900, height: 700 }, deviceScaleFactor: 2 });
page.on("pageerror", (e) => console.warn("[pageerror]", e.message));

await page.goto(URL, { waitUntil: "load" });
await page.waitForTimeout(300);
await page.evaluate(() => {
  document.documentElement.style.background = "transparent";
  document.body.style.background = "transparent";
  document.querySelectorAll(".mode-shell > :not(.overlay-pet-pane)").forEach((el) => (el.style.display = "none"));
  const c = document.querySelector("canvas");
  if (c) c.style.background = "transparent";
});
await page.waitForTimeout(4200);
// 关掉自动眨眼，避免抓静帧时眼睛正闭到一半
await page.evaluate(() => window.__dg2FaceRig?.setAutoBlink(false));
await page.waitForTimeout(600);

const shoot = async (name) => {
  writeFileSync(join(OUT, `${name}.png`), await page.screenshot());
  console.log("→", name);
};

await shoot("00-focused");

for (const expr of ["idle", "listening", "thinking", "happy", "alert", "sleepy"]) {
  await page.evaluate((e) => window.__dg2FaceRig?.setExpression(e), expr);
  await page.waitForTimeout(900);
  await shoot(`expr-${expr}`);
}

// 眨眼帧序列：先回 focused，再逐帧抓
await page.evaluate(() => window.__dg2FaceRig?.setExpression("focused"));
await page.waitForTimeout(700);
await page.evaluate(() => window.__dg2FaceRig?.blink());
for (let i = 0; i < 7; i += 1) {
  await page.waitForTimeout(35);
  writeFileSync(join(OUT, `blink-${i}.png`), await page.screenshot());
}
console.log("→ blink frames");

// 表情过渡帧（focused → happy），验收弹簧插值的连贯性
await page.evaluate(() => window.__dg2FaceRig?.setExpression("focused"));
await page.waitForTimeout(800);
await page.evaluate(() => window.__dg2FaceRig?.setExpression("happy"));
for (let i = 0; i < 8; i += 1) {
  await page.waitForTimeout(45);
  writeFileSync(join(OUT, `morph-${i}.png`), await page.screenshot());
}
console.log("→ morph frames");

await browser.close();
