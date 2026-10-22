/**
 * 桌宠附加面板真实渲染回归（Playwright）。
 *
 * 验证的是"面板长在桌宠身上"这件事：
 *  - 面板与球体在同一个窗口坐标系里（panel.right ≈ pane.left）
 *  - 计时板：走秒 / 暂停冻结 / 继续 / 关闭后槽位归零
 *  - 打卡卡：三项真实数据 / 彩带 / 无评语时不留空白块
 *
 * 用法：先 `npm run build`，再 `node scripts/visual-test-pet-panels.mjs`
 */

import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const BASE = process.env.PET_PANEL_BASE ?? "http://127.0.0.1:8778";
const SHOT_DIR = resolve(".workbuddy/tmp/pet-panels");
const PET_W = 372;
const FOCUS_SLOT = 170;
const OFFWORK_SLOT = 224;

mkdirSync(SHOT_DIR, { recursive: true });

const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ deviceScaleFactor: 2 });
const page = await ctx.newPage();

const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e.message)));

async function openPanel(panel, viewportWidth) {
  await page.setViewportSize({ width: viewportWidth, height: 464 });
  await page.goto(`${BASE}/overlay.html?panel=${panel}`, { waitUntil: "load" });
  await page.waitForSelector(".pet-panel", { timeout: 20000 });
  await page.waitForTimeout(900);
}

// ───────────────────────── 专注计时板 ─────────────────────────
await openPanel("focus", PET_W + FOCUS_SLOT);

const focusGeom = await page.evaluate(() => {
  const slot = document.querySelector(".overlay-attach-slot").getBoundingClientRect();
  const pane = document.querySelector(".overlay-pet-pane").getBoundingClientRect();
  const panel = document.querySelector(".pet-panel").getBoundingClientRect();
  const tether = document.querySelector(".pet-panel__tether").getBoundingClientRect();
  return {
    slot: { l: slot.left, w: slot.width },
    pane: { l: pane.left, w: pane.width },
    panel: { l: panel.left, r: panel.right, w: panel.width, t: panel.top, b: panel.bottom },
    tetherW: tether.width,
  };
});

check(
  "计时板在桌宠同一窗口坐标系内（紧贴 pane 左侧）",
  Math.abs(focusGeom.panel.r - focusGeom.pane.l) <= 8,
  `panel.right=${focusGeom.panel.r.toFixed(1)} pane.left=${focusGeom.pane.l}`,
);
check("计时板尺寸克制（≤180×130）", focusGeom.panel.w <= 180 && focusGeom.panel.b - focusGeom.panel.t <= 130, `${focusGeom.panel.w}×${(focusGeom.panel.b - focusGeom.panel.t).toFixed(0)}`);
check("面板与球之间有接线（不是两块孤立的东西）", focusGeom.tetherW >= 100, `tether=${focusGeom.tetherW.toFixed(0)}px`);

const t0 = await page.textContent(".focus-timer__time");
await page.waitForTimeout(2200);
const t1 = await page.textContent(".focus-timer__time");
check("拉出来即在计时", t0 !== t1, `${t0?.trim()} → ${t1?.trim()}`);

await page.click(".focus-timer");
await page.waitForTimeout(300);
const paused = await page.textContent(".focus-timer__time");
await page.waitForTimeout(1600);
const paused2 = await page.textContent(".focus-timer__time");
check("点板面暂停后时间冻结", paused === paused2, `${paused?.trim()} → ${paused2?.trim()}`);

await page.click(".focus-timer");
await page.waitForTimeout(1800);
const resumed = await page.textContent(".focus-timer__time");
check("再点继续计时", resumed !== paused2, `${paused2?.trim()} → ${resumed?.trim()}`);

await page.screenshot({ path: `${SHOT_DIR}/1-focus-live.png` });

// 关闭 → 槽位回收
await page.click(".pet-panel__close", { force: true });
await page.waitForTimeout(500);
const afterClose = await page.evaluate(() => ({
  panel: !!document.querySelector(".pet-panel"),
  slotW: document.querySelector(".overlay-attach-slot").getBoundingClientRect().width,
}));
check("关闭后 DOM 与槽位都回收", !afterClose.panel && afterClose.slotW === 0, `slot=${afterClose.slotW}`);

// ───────────────────────── 下班打卡卡 ─────────────────────────
await openPanel("offwork", PET_W + OFFWORK_SLOT);

const card = await page.evaluate(() => {
  const pane = document.querySelector(".overlay-pet-pane").getBoundingClientRect();
  const el = document.querySelector(".pet-panel").getBoundingClientRect();
  const rows = [...document.querySelectorAll(".offwork-card__row")].map((r) => r.innerText.replace(/\s+/g, " "));
  return {
    paneLeft: pane.left,
    right: el.right,
    w: el.width,
    h: el.height,
    top: el.top,
    rows,
    time: document.querySelector(".offwork-card__time")?.textContent,
    confetti: document.querySelectorAll(".offwork-card__confetti i").length,
    hasLineBlock: !!document.querySelector(".offwork-card__line"),
  };
});

check("打卡卡同样紧贴桌宠", Math.abs(card.right - card.paneLeft) <= 8, `card.right=${card.right} pane.left=${card.paneLeft}`);
check("打卡时刻可配置", card.time === "18:30", String(card.time));
check("三项数据齐全", card.rows.length === 3, card.rows.join(" | "));
check("彩带存在", card.confetti >= 18, `${card.confetti} 片`);

await page.screenshot({ path: `${SHOT_DIR}/2-offwork-live.png` });

// 无 LLM 时不应留一块空白
await page.waitForTimeout(4200);
const lineGone = await page.evaluate(() => {
  const node = document.querySelector(".offwork-card__line");
  if (!node) return "removed";
  return node.textContent?.trim() === "···" ? "loading" : "text";
});
check("无评语时不占空白块", lineGone === "removed", String(lineGone));

// ───────────────────────── 抽出动画中间帧 + 对外入口 ─────────────────────────
await page.setViewportSize({ width: PET_W + FOCUS_SLOT, height: 464 });
// 不带 panel 参数：先让入场动画走完，再通过对外入口触发，才截得到"掏出"的过程
await page.goto(`${BASE}/overlay.html`, { waitUntil: "load" });
await page.waitForTimeout(2600);
check("对外入口存在（球形动画完成后由球体回调）", await page.evaluate(() => typeof window.__paiPet?.openFocus === "function"));

await page.evaluate(() => window.__paiPet.openFocus());
const samples = [];
let shot = false;
for (let i = 0; i < 9; i += 1) {
  await page.waitForTimeout(34);
  const s = await page.evaluate(() => {
    const el = document.querySelector(".pet-panel__body");
    if (!el) return null;
    const m = getComputedStyle(el).transform;
    const n = m.match(/matrix\(([^)]+)\)/);
    return n ? Number.parseFloat(n[1].split(",")[0]) : null;
  });
  if (s != null) samples.push(s);
  if (!shot && s != null && s < 0.95) {
    shot = true;
    await page.screenshot({ path: `${SHOT_DIR}/3-draw-mid.png` });
  }
}
if (!shot) await page.screenshot({ path: `${SHOT_DIR}/3-draw-mid.png` });
const minScale = samples.length ? Math.min(...samples) : null;
check(
  "抽出动画从球侧由小展开（能采到 scale < 0.95 的中间态）",
  minScale != null && minScale < 0.95,
  `samples=[${samples.map((v) => v.toFixed(2)).join(", ")}]`,
);

check("无未捕获 JS 错误", pageErrors.length === 0, pageErrors.slice(0, 3).join(" / "));

await browser.close();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.log("FAILURES:", failed.map((f) => f.name).join(", "));
  process.exit(1);
}
