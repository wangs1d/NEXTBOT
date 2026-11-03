/**
 * 桌宠新装扮验收截图：跑真实 overlay 页面（vite dev），
 * 出正面 / 3/4 侧 / 实际桌宠尺寸三张，方便与参考图对照。
 *
 * 用法：npx vite --port 5199 另开一个终端，然后 node scripts/_shot-outfit.mjs
 */
import { chromium } from "playwright-core";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = "E:/ws-project/NextBot/.scratch/outfit";
const URL = process.env.SHOT_URL ?? "http://127.0.0.1:5199/overlay.html";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 900, height: 700 }, deviceScaleFactor: 2 });
page.on("pageerror", (e) => console.warn("[pageerror]", e.message));

await page.goto(URL, { waitUntil: "load" });
await page.waitForTimeout(400);
await page.evaluate(() => {
  document.documentElement.style.background = "transparent";
  document.body.style.background = "transparent";
  document.querySelectorAll(".mode-shell > :not(.overlay-pet-pane)").forEach((el) => (el.style.display = "none"));
  const c = document.querySelector("canvas");
  if (c) c.style.background = "transparent";
});
await page.waitForTimeout(4200);

const box = await page.evaluate(() => {
  const c = document.querySelector("canvas");
  const r = c.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
});

const shoot = async (name) => {
  writeFileSync(join(OUT, `${name}.png`), await page.screenshot());
  console.log("→", name);
};
await shoot("overlay-full");

// 拖拽旋转 ≈30°（useSphereUserDrag: rotY = dx * 0.014）
const cx = box.x + box.width / 2;
const cy = box.y + box.height / 2;
await page.mouse.move(cx, cy);
await page.mouse.down();
for (let i = 1; i <= 10; i += 1) await page.mouse.move(cx + i * 4.5, cy);
await page.mouse.up();
await page.waitForTimeout(900);
await shoot("overlay-side");

await browser.close();
