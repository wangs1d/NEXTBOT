/** 导出连帧（眨眼 + 表情过渡），用于验收「丝滑连贯」 */
import { chromium } from "playwright-core";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const OUT = "E:/ws-project/NextBot/.scratch/face/film";
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  args: ["--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 760, height: 760 } });
await page.goto("http://127.0.0.1:5199/face-debug.html?film=1", { waitUntil: "networkidle0" });
await page.waitForFunction("window.__ready === true");

const steps = [
  { expr: "focused", ms: 700 },
  { expr: "focused", ms: 260, blink: true },
  { expr: "happy", ms: 620 },
  { expr: "happy", ms: 520 },
  { expr: "thinking", ms: 620 },
  { expr: "thinking", ms: 520 },
  { expr: "focused", ms: 620 },
];
const fps = 24;
const frames = await page.evaluate(
  ([s, f]) => window.__film(s, f),
  [steps, fps],
);
frames.forEach((dataUrl, i) => {
  const b64 = dataUrl.split(",")[1];
  writeFileSync(join(OUT, `f${String(i).padStart(3, "0")}.png`), Buffer.from(b64, "base64"));
});
console.log("frames:", frames.length, "fps:", fps);
await browser.close();
