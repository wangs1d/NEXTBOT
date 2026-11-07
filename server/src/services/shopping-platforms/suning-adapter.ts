import type { Page } from "playwright";

import { applySpecGroups, extractSpecGroups } from "./spec-extract.js";
import {
  adapterError,
  type CancelResult,
  type CheckoutSnapshot,
  type OrderStatus,
  type ProductSpecGroup,
  type ProductSummary,
  type SearchFilters,
  type ShoppingPlatformAdapter,
} from "./types.js";

/**
 * 苏宁易购适配器（免登录取价）。
 *
 * 为什么单独接：淘宝/天猫/京东/拼多多在**无登录态**下全部被拦到登录页
 * （2026-11-06 无头实测：京东 search/item 全站跳 passport，拼多多跳 login，
 * 淘宝搜索页只出导航壳）。手机端没有可视浏览器，缺省比价必须有一批
 * 「不登录就能读到真实价格和主图」的源，否则整条链路一开跑就只剩登录交接。
 * 苏宁搜索页在匿名态下正常返回商品、价格与主图，是当前最可靠的实时价源。
 *
 * 搜索页：https://search.suning.com/{keyword}/
 * 只做只读取价；下单/物流能力未实现（显式报错，不编造）。
 */
const CARD_SELECTOR = ".product-box, .item-wrap, [class*='product-box']";
const PRICE_SELECTOR = ".def-price, .price, [class*='def-price']";
const TITLE_SELECTOR = ".title-selling-point, .title, [class*='title-selling']";

export class SuningAdapter implements ShoppingPlatformAdapter {
  readonly platform = "suning";
  readonly category = "general" as const;
  readonly authMode = "anonymous" as const;

  searchUrl(query: string, _filters?: SearchFilters): string {
    return `https://search.suning.com/${encodeURIComponent(query)}/`;
  }

  orderListUrl(): string {
    return "https://order.suning.com/orderList.do";
  }

  async extractProducts(page: Page, limit: number): Promise<ProductSummary[]> {
    try {
      await page.waitForSelector(CARD_SELECTOR, { timeout: 12_000 }).catch(() => {});
      // 首屏只渲染一半，滚到底触发懒加载后再回顶（与京东 adapter 同法）
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
      await page.waitForTimeout(700);
      await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});

      const raw = await page.evaluate(
        ({
          maxLimit,
          cardSelector,
          priceSelector,
          titleSelector,
        }: {
          maxLimit: number;
          cardSelector: string;
          priceSelector: string;
          titleSelector: string;
        }) => {
          const seen = new Set<string>();
          const out: Array<{ title: string; price?: string; url?: string; image?: string; itemId?: string }> = [];
          for (const node of Array.from(document.querySelectorAll(cardSelector))) {
            if (out.length >= maxLimit) break;
            const titleEl = node.querySelector(titleSelector) as HTMLElement | null;
            const title = (titleEl?.innerText ?? titleEl?.getAttribute("title") ?? "")
              .replace(/\s+/g, " ")
              .trim();
            if (!title || seen.has(title)) continue;

            const priceText = (node.querySelector(priceSelector) as HTMLElement | null)?.innerText ?? "";
            const priceMatch = priceText.match(/\d+(?:\.\d+)?/);

            const linkEl = node.querySelector(
              "a[href*='product.suning.com'], a[href*='m.suning.com']",
            ) as HTMLAnchorElement | null;
            const url = linkEl?.href || undefined;
            // 同款不同链接的去重键：标题已足够（同页重复卡多是同链接）
            seen.add(title);

            let image: string | undefined;
            for (const imgEl of Array.from(node.querySelectorAll("img"))) {
              const u =
                imgEl.getAttribute("src") ||
                imgEl.getAttribute("data-src") ||
                imgEl.getAttribute("data-lazy-img") ||
                "";
              if (/^(https?:)?\/\//.test(u) && !/\.svg(\?|$)/i.test(u)) {
                image = u.startsWith("//") ? `https:${u}` : u;
                break;
              }
            }
            // URL 形如 //product.suning.com/{供应商码}/{sku}.html —— sku 是最后一段
            const itemId = url?.match(/product\.suning\.com\/\d+\/(\d+)\.html/)?.[1];
            out.push({ title, price: priceMatch?.[0], url, image, itemId });
          }
          return out;
        },
        {
          maxLimit: limit,
          cardSelector: CARD_SELECTOR,
          priceSelector: PRICE_SELECTOR,
          titleSelector: TITLE_SELECTOR,
        },
      );

      return raw.map((r) => ({
        title: r.title,
        price: r.price ? Number.parseFloat(r.price) : undefined,
        currency: r.price ? "CNY" : undefined,
        url: r.url,
        ...(r.itemId ? { itemId: r.itemId } : {}),
        ...(r.image ? { imageUrl: r.image } : {}),
      }));
    } catch {
      return [];
    }
  }

  async navigateToCheckout(_page: Page, _product: ProductSummary, _quantity: number): Promise<CheckoutSnapshot> {
    return {
      ok: false,
      error: "苏宁目前只支持只读取价，暂不支持在平台内下单（请在苏宁 App 内自行下单）",
      retryable: false,
    };
  }

  /// 结算未实现（2026-11-06 用户定稿：不做苏宁，按主流平台做）——
  /// 候选卡据此不给苏宁条目「下单」按钮。
  readonly supportsCheckout = false;

  async submitOrder(_page: Page): Promise<{ ok: boolean; error?: string; retryable?: boolean }> {
    return { ok: false, error: "苏宁暂不支持代下单", retryable: false };
  }

  async readOrderStatus(_page: Page, _orderId?: string): Promise<OrderStatus[]> {
    return [];
  }

  async cancelOrder(_page: Page, _orderId: string): Promise<CancelResult> {
    return { ok: false, error: adapterError(new Error("苏宁暂不支持代取消订单"), "苏宁").error, retryable: false };
  }

  /** 详情页规格：把商家给的全部维度与选项原样读出（无货项标 disabled，不裁剪）。 */
  async extractSpecs(page: Page): Promise<ProductSpecGroup[]> {
    return extractSpecGroups(page, this.platform);
  }

  async applySpecs(
    page: Page,
    picked: Record<string, string>,
  ): Promise<{ ok: boolean; error?: string }> {
    const r = await applySpecGroups(page, this.platform, picked);
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  }
}
