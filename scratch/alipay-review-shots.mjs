import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const OUT = "E:/ws-project/NextBot/shots/alipay-review";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
const ctx = browser.contexts()[0];
const page = ctx.pages()[0] ?? (await ctx.newPage());

const chromePid = Number(process.env.CHROME_PID || 0);
if (!chromePid) throw new Error("CHROME_PID not set");

export async function shot(name, url) {
  await page.goto(url, { waitUntil: "networkidle", timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(1200);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
  execFileSync("powershell", [
    "-NoProfile", "-ExecutionPolicy", "Bypass",
    "-File", "E:/ws-project/NextBot/scratch/shot-window-pid.ps1",
    "-Out", join(OUT, name + ".png"),
    "-TargetPid", String(chromePid),
  ], { stdio: "inherit" });
}

await shot("01-home", "https://nextbot.top/");
await shot("02-pricing", "https://nextbot.top/recharge/pricing");
await shot("03-recharge", "https://nextbot.top/recharge");

console.log("done");
