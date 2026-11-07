import type { Page } from "playwright";

import type { ProductSpecGroup, ProductSpecOption } from "./types.js";

/**
 * 商品详情页规格抽取（维度 + 全部选项）。
 *
 * 为什么单独抽出来：各平台的详情页结构差异极大，但「一组维度 + 若干可点选项」
 * 这个形状是共同的。选择器表驱动后，一个平台改版只需要改表，不用碰逻辑；
 * 读不出来就返回空数组，调用方直接去结算——绝不编造页面上没有的选项。
 *
 * 硬约束（用户 2026-11-06 要求）：**呈现商家提供的全部组合**。所以
 *   · 无货项照样返回，标 disabled，不悄悄剔掉；
 *   · 不做「合并同款」「只留推荐款」这类裁剪；
 *   · 维度顺序保持页面原序。
 *
 * 实现注记：页面脚本一律走**字符串**形式的 page.evaluate。tsx/esbuild 的
 * keepNames 会给闭包里的箭头函数注入 `__name` helper，函数体被序列化进浏览器
 * 后找不到 `__name`，直接抛 ReferenceError（实测：京东详情页必炸）。
 */
export interface SpecSelectors {
  /** 组容器选择器（多个用逗号分隔，按序命中第一个） */
  group: string;
  /** 组名（在组容器内取） */
  label: string;
  /** 选项（在组容器内取） */
  option: string;
  /** 组名也可从组容器的属性取（如京东的 data-type） */
  labelAttr?: string;
  /** 表示「无货/不可选」的 class 关键字 */
  disabledHints?: string[];
}

export const SPEC_SELECTORS: Record<string, SpecSelectors> = {
  // 京东：item.jd.com 详情页的规格区
  jd: {
    group: "#choose-attrs .li, .Ptable .Ptable-item",
    label: ".dt, .p-name, dt",
    option: "#choose-attrs .item, .Ptable .p-value a",
    labelAttr: "data-type",
    disabledHints: ["disabled", "gray", "unselectable", "no-stock"],
  },
  // 苏宁：product.suning.com 详情页
  suning: {
    group: ".li-item, .cs-param li, .item-wrap .li",
    label: ".dt, .name, .kd-name",
    option: ".item, .val a, .option-list a",
    disabledHints: ["disabled", "gray", "none", "soldout"],
  },
  // 淘宝/天猫（需登录态才看得到规格区）
  taobao: {
    group: ".skuWrapper .skuProp, .tb-sku .skuProp",
    label: ".skuPropName, .sku-prop-name, dt",
    option: ".skuPropItem, .sku-prop-value a, dd a",
    disabledHints: ["disabled", "no-stock", "unable"],
  },
  pdd: {
    group: ".sku-item-wrap .sku-item, .goods-sku .sku-item",
    label: ".sku-item-name, .sku-name",
    option: ".sku-value-item, .sku-value",
    disabledHints: ["disabled", "soldout", "no-stock"],
  },
};

const SCROLL_SCRIPT = `(() => {
  const body = document.body;
  if (!body) return;
  window.scrollTo(0, Math.max(body.scrollHeight * 0.5, 400));
})()`;

/** 生成「读规格」的页面脚本（字符串，避免 __name 注入问题）。 */
function buildExtractScript(sel: SpecSelectors): string {
  return `(() => {
  const sel = ${JSON.stringify(sel)};
  const norm = (t) => (t == null ? "" : String(t).replace(/\\s+/g, " ").trim());
  const out = [];
  const seen = new Set();
  const nodes = Array.from(document.querySelectorAll(sel.group));
  for (const node of nodes) {
    if (!node || !node.querySelector) continue;
    const labelEl = sel.label ? node.querySelector(sel.label) : null;
    let key = norm(labelEl ? labelEl.textContent : "");
    if (!key && sel.labelAttr) key = norm(node.getAttribute(sel.labelAttr));
    if (!key || /^(规格|参数|商品详情|选择|已选)$/.test(key)) continue;
    if (seen.has(key)) continue;
    const optNodes = Array.from(node.querySelectorAll(sel.option));
    const options = [];
    const optSeen = new Set();
    for (const opt of optNodes) {
      if (opt === labelEl) continue;
      const text = norm(opt.textContent);
      if (!text || text.length > 24) continue;
      if (optSeen.has(text)) continue;
      optSeen.add(text);
      const cls = String(opt.className || "").toLowerCase();
      const hints = sel.disabledHints || [];
      const disabled = hints.some((h) => cls.indexOf(h) >= 0) || opt.hasAttribute("disabled");
      const selected = /(^|\\s)(selected|active|cur)(\\s|$)/i.test(cls);
      const o = { label: text };
      if (disabled) o.disabled = true;
      if (selected) o.selected = true;
      options.push(o);
    }
    if (options.length < 2) continue;
    if (!options.some((o) => !o.disabled)) continue;
    seen.add(key);
    out.push({ key: key, options: options });
    if (out.length >= 6) break;
  }
  return out;
})()`;
}

/**
 * 在已打开的商品详情页上抽规格。
 *
 * @param siteId 平台 id（查选择器表）
 * @returns 空数组 = 没读到（无规格 / 页面结构不符 / 懒加载未完成 / 验证页）
 */
export async function extractSpecGroups(
  page: Page,
  siteId: string,
): Promise<ProductSpecGroup[]> {
  const sel = SPEC_SELECTORS[siteId];
  if (!sel) return [];

  await page.evaluate(SCROLL_SCRIPT).catch(() => {});
  await page.waitForTimeout(600).catch(() => {});
  await page.evaluate("window.scrollTo(0, 0)").catch(() => {});

  const groups = await page
    .evaluate(buildExtractScript(sel))
    .catch(() => [] as ProductSpecGroup[]);
  return Array.isArray(groups) ? (groups as ProductSpecGroup[]) : [];
}

/** 生成「点规格」的页面脚本（字符串，同上）。 */
function buildApplyScript(sel: SpecSelectors, targets: Array<[string, string]>): string {
  return `(() => {
  const sel = ${JSON.stringify(sel)};
  const targets = ${JSON.stringify(targets)};
  const norm = (t) => (t == null ? "" : String(t).replace(/\\s+/g, " ").trim());
  let count = 0;
  const nodes = Array.from(document.querySelectorAll(sel.group));
  for (const node of nodes) {
    if (!node || !node.querySelector) continue;
    const labelEl = sel.label ? node.querySelector(sel.label) : null;
    let key = norm(labelEl ? labelEl.textContent : "");
    if (!key && sel.labelAttr) key = norm(node.getAttribute(sel.labelAttr));
    const hit = targets.find((t) => t[0] === key);
    if (!hit) continue;
    const want = hit[1];
    const optNodes = Array.from(node.querySelectorAll(sel.option));
    for (const opt of optNodes) {
      if (!opt) continue;
      if (norm(opt.textContent) !== want) continue;
      const cls = String(opt.className || "").toLowerCase();
      const hints = sel.disabledHints || [];
      if (hints.some((h) => cls.indexOf(h) >= 0)) continue;
      opt.click();
      count += 1;
      break;
    }
  }
  return count;
})()`;
}

/**
 * 按用户选中的规格在详情页点一遍（key→label）。
 *
 * 只点「有货且文案完全一致」的选项：宁可少点一个、退回默认规格，也不猜着点
 * 一个名字相近的——买错型号的代价远大于「规格没选上」。
 */
export async function applySpecGroups(
  page: Page,
  siteId: string,
  picked: Record<string, string>,
): Promise<{ ok: boolean; error?: string; applied: number }> {
  const sel = SPEC_SELECTORS[siteId];
  if (!sel) return { ok: false, error: "该平台暂无规格选择支持", applied: 0 };
  const targets = Object.entries(picked).filter(([, v]) => v && v.trim()) as Array<
    [string, string]
  >;
  if (targets.length === 0) return { ok: true, applied: 0 };

  const applied = await page
    .evaluate(buildApplyScript(sel, targets))
    .catch(() => 0);
  await page.waitForTimeout(600).catch(() => {});
  return { ok: Number(applied) > 0, applied: Number(applied) };
}
