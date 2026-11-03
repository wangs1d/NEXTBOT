/**
 * 购物取数自愈管线（2026-11-02）。
 *
 * 对齐主流 agentic browser 的错误恢复共识（Playwright MCP / browser-use 的
 * 「失败 → 重新快照 → 换策略重试」模式），把 adapter 取数从「一次 CSS 抓空即放弃」
 * 升级为三层递进：
 *
 *   1. css        —— 平台 adapter 现有选择器（快路径，命中即返回）
 *   2. css_retry  —— 滚动触发懒加载后重试一次（很多「抓空」只是图/卡未渲染完）
 *   3. semantic   —— 语义锚点抽取：不依赖 class 名，锚定商品详情页 URL 模式 +
 *                    ¥ 价格模式 + 链接文本/图片 alt，平台改版后大概率仍然存活
 *   4. vision     —— 视觉兜底（可插拔）：截图交视觉模型抽结构化 JSON。
 *                    仅在调用方注入 visionExtract 且 SHOPPING_VISION_HEALING=1 时启用；
 *                    主流共识是视觉只做兜底（token 贵 20~50 倍且可能幻觉），不做主路径。
 *
 * 每层尝试记录进 attempts，随审计落盘（观测哪一层在救场，指导选择器维护）。
 */
import type { Page } from "playwright";

import type { ProductSummary } from "./types.js";

/** 单层尝试标识（审计与测试用） */
export type HealAttempt = "css" | "css_retry" | "semantic" | "vision";

/** 各平台商品详情页 URL 锚点（正则 source，注入 evaluate 后重建） */
const ITEM_URL_ANCHORS: Record<string, string> = {
  jd: "item\\.jd\\.com/\\d+|[?&]sku=\\d+",
  taobao: "item\\.htm|detail\\.tmall\\.com|[?&]id=\\d{6,}",
  tmall: "detail\\.tmall\\.com|item\\.htm|[?&]id=\\d{6,}",
  pdd: "goods_id=\\d+|goods\\.html",
  meituan: "/poi/\\d+|/product/\\d+|meituan\\.com/(poi|item)",
  douyin: "haohuo\\.jinritemai\\.com|goods/\\d+",
  dianping: "dianping\\.com/shop/\\d+",
};

/** 滚动一屏触发懒加载再回顶（与各 adapter 的 scrollSearchResults 同策略，纯语句） */
export async function scrollAndSettle(page: Page): Promise<void> {
  await page
    .evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);
    })
    .catch(() => {});
  await page.waitForTimeout(800);
  await page
    .evaluate(() => {
      window.scrollTo(0, 0);
    })
    .catch(() => {});
  await page.waitForTimeout(300);
}

export interface SelfHealOptions {
  /** 第一层：平台 adapter 的 CSS 选择器抽取 */
  cssExtract: () => Promise<ProductSummary[]>;
  /** 第三层：语义锚点抽取（缺省用本模块的 anchor 实现） */
  semanticExtract?: () => Promise<ProductSummary[]>;
  /** 第四层：视觉兜底（未注入则跳过） */
  visionExtract?: () => Promise<ProductSummary[]>;
}

export interface SelfHealResult {
  products: ProductSummary[];
  /** 实际走过的层（含空结果的层），审计用 */
  attempts: HealAttempt[];
}

/**
 * 三层递进取数。任何一层拿到 ≥1 条即返回；全部落空返回空数组 + 全部 attempts。
 * 单层异常不中断管线（自愈的意义就在于此）。
 */
export async function extractWithSelfHeal(page: Page, opts: SelfHealOptions): Promise<SelfHealResult> {
  const attempts: HealAttempt[] = [];
  const tryLayer = async (name: HealAttempt, fn: () => Promise<ProductSummary[]>): Promise<ProductSummary[] | null> => {
    attempts.push(name);
    try {
      const products = await fn();
      if (products.length > 0) return products;
      return null;
    } catch {
      return null;
    }
  };

  // 1. CSS 快路径
  const cssHit = await tryLayer("css", opts.cssExtract);
  if (cssHit) return { products: cssHit, attempts };

  // 2. 懒加载自愈：滚动后再试一次 CSS
  await scrollAndSettle(page);
  const cssRetryHit = await tryLayer("css_retry", opts.cssExtract);
  if (cssRetryHit) return { products: cssRetryHit, attempts };

  // 3. 语义锚点（平台无关）
  const semantic = opts.semanticExtract ?? (() => semanticExtractProducts(page, "", 10));
  const semanticHit = await tryLayer("semantic", semantic);
  if (semanticHit) return { products: semanticHit, attempts };

  // 4. 视觉兜底（可插拔，未注入跳过）
  if (opts.visionExtract) {
    const visionHit = await tryLayer("vision", opts.visionExtract);
    if (visionHit) return { products: visionHit, attempts };
  }

  return { products: [], attempts };
}

/**
 * 语义锚点抽取：不依赖任何 class 名。
 * 锚定商品详情链接 → 向上找含 ¥ 价格的卡片容器 → 标题取链接文本/图片 alt →
 * 主图取容器内首个 http(s) 真图。注意 evaluate 体内禁止函数表达式
 * （esbuild __name 注入坑，2026-10 实测），全量纯语句。
 */
export async function semanticExtractProducts(
  page: Page,
  platform: string,
  limit: number,
): Promise<ProductSummary[]> {
  const anchorSource = ITEM_URL_ANCHORS[platform] ?? "item\\.(htm|html|aspx)|/product(s)?/\\d+|goods_id=\\d+";
  const raw = await page
    .evaluate(
      ({ anchorSource, maxLimit }: { anchorSource: string; maxLimit: number }) => {
        const anchorRe = new RegExp(anchorSource, "i");
        const priceRe = /(?:¥|￥)\s?([1-9][\d,]*(?:\.\d+)?)/;
        const seen = new Set<string>();
        const out: Array<{ title: string; price?: number; url?: string; image?: string }> = [];
        const anchors = document.querySelectorAll("a[href]");
        for (const a of Array.from(anchors)) {
          if (out.length >= maxLimit) break;
          const href = (a as HTMLAnchorElement).href || "";
          if (!anchorRe.test(href)) continue;
          // 向上找含价格的卡片容器（≤8 层）
          let card: HTMLElement | null = a as HTMLElement;
          let priceText = "";
          for (let i = 0; i < 8 && card; i++) {
            card = card.parentElement;
            if (!card) break;
            const m = priceRe.exec(String(card.innerText ?? ""));
            if (m) {
              priceText = m[1].replace(/,/g, "");
              break;
            }
          }
          const scope = card ?? (a as HTMLElement);
          let title = String((a as HTMLElement).innerText ?? "").trim().replace(/\s+/g, " ");
          if (title.length < 4) {
            const alt = scope.querySelector("img[alt]");
            title = String(alt?.getAttribute("alt") ?? "").trim();
          }
          if (!title || title.length < 4 || seen.has(title)) continue;
          seen.add(title);
          let image = "";
          const imgs = scope.querySelectorAll("img");
          for (const im of Array.from(imgs)) {
            const u =
              im.getAttribute("src") ||
              im.getAttribute("data-src") ||
              im.getAttribute("data-lazy-img") ||
              "";
            if (/^https?:\/\//.test(u) && !/\.svg(\?|$)/i.test(u)) {
              image = u;
              break;
            }
          }
          const price = priceText ? Number.parseFloat(priceText) : undefined;
          out.push({
            title: title.slice(0, 120),
            price: price != null && Number.isFinite(price) && price > 0 ? price : undefined,
            url: href,
            image: image || undefined,
          });
        }
        return out;
      },
      { anchorSource, maxLimit: Math.min(Math.max(limit, 1), 10) },
    )
    .catch(() => []);
  return raw.map((r) => ({
    title: r.title,
    ...(r.price != null ? { price: r.price, currency: "CNY" } : {}),
    ...(r.url ? { url: r.url } : {}),
    ...(r.image ? { imageUrl: r.image } : {}),
  }));
}

/**
 * 视觉模型回执 → 商品列表（纯函数，可单测）。
 * 宽容解析：截取首个 JSON 数组（容忍 ```json 围栏/前后说明文字），逐条校验：
 * title 非空 ≥2 字符；price 为 0 < p ≤ 1000 万 的数字或数字字符串；按 title 去重。
 */
export function parseVisionProducts(jsonText: string, limit: number): ProductSummary[] {
  const text = String(jsonText ?? "");
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const seen = new Set<string>();
  const out: ProductSummary[] = [];
  for (const item of parsed) {
    if (out.length >= Math.min(Math.max(limit, 1), 10)) break;
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const title = String(rec.title ?? rec.name ?? "").trim();
    if (title.length < 2 || seen.has(title)) continue;
    const priceRaw = rec.price ?? rec.priceCny;
    const price =
      typeof priceRaw === "number"
        ? priceRaw
        : typeof priceRaw === "string" && /^[\d.]+$/.test(priceRaw)
          ? Number.parseFloat(priceRaw)
          : NaN;
    if (!Number.isFinite(price) || price <= 0 || price > 10_000_000) continue;
    seen.add(title);
    const url = typeof rec.url === "string" && rec.url.trim() ? rec.url.trim() : undefined;
    const imageUrl = typeof rec.imageUrl === "string" && rec.imageUrl.trim() ? rec.imageUrl.trim() : undefined;
    out.push({
      title: title.slice(0, 120),
      price,
      currency: "CNY",
      ...(url ? { url } : {}),
      ...(imageUrl ? { imageUrl } : {}),
    });
  }
  return out;
}
