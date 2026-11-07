import type { Page } from "playwright";

import {
  adapterError,
  type CancelResult,
  type CheckoutSnapshot,
  type OrderStatus,
  type ProductSummary,
  type SearchFilters,
  type ShoppingPlatformAdapter,
} from "./types.js";

/**
 * 什么值得买（SMZDM）比价情报适配器（免登录取价）。
 *
 * 定位要讲清楚：它**不是商城**，是「好价爆料」聚合站——每条是某个商城
 * （京东/天猫/拼多多百亿补贴…）的历史或当前爆料价，不是结算页实时价。
 * 因此：
 *   - shop 字段留空（爆料条目不一定标商城，不猜）；
 *   - 不支持下单/物流（显式报错，引导回原商城）；
 *   - 比价卡 footer 会额外标注「爆料价参考」，避免被读成官方实时价。
 *
 * 搜索页：https://search.smzdm.com/?c=home&s={keyword}
 */
const CARD_SELECTOR = "li.feed-row-wide, .feed-block";

export class SmzdmAdapter implements ShoppingPlatformAdapter {
  readonly platform = "smzdm";
  readonly category = "general" as const;
  readonly authMode = "anonymous" as const;

  searchUrl(query: string, _filters?: SearchFilters): string {
    return `https://search.smzdm.com/?c=home&s=${encodeURIComponent(query)}`;
  }

  orderListUrl(): string {
    return "https://www.smzdm.com/";
  }

  async extractProducts(page: Page, limit: number): Promise<ProductSummary[]> {
    try {
      await page.waitForSelector(CARD_SELECTOR, { timeout: 12_000 }).catch(() => {});
      const raw = await page.evaluate(
        ({ maxLimit, cardSelector }: { maxLimit: number; cardSelector: string }) => {
          const seen = new Set<string>();
          const out: Array<{ title: string; price?: string; url?: string; image?: string; itemId?: string }> = [];
          for (const node of Array.from(document.querySelectorAll(cardSelector))) {
            if (out.length >= maxLimit) break;
            // 标题必须取 h5 里那个「纯标题」的 a[title]，不能取 h5.innerText
            // ——h5 里还嵌着 .z-highlight 的价格文本，拼进去会把价格当标题。
            const titleLink = node.querySelector(
              ".feed-block-title a[title], h5 a[title]",
            ) as HTMLAnchorElement | null;
            const title = (titleLink?.getAttribute("title") ?? titleLink?.textContent ?? "")
              .replace(/\s+/g, " ")
              .trim();
            if (!title || seen.has(title)) continue;

            const priceText = (node.querySelector(".z-highlight") as HTMLElement | null)?.innerText ?? "";
            const priceMatch = priceText.match(/\d+(?:\.\d+)?/);

            const linkEl = (node.querySelector("a[href*='smzdm.com/p/']") as HTMLAnchorElement | null) ?? titleLink;
            const url = linkEl?.href || undefined;

            const imgEl = node.querySelector("img") as HTMLImageElement | null;
            const rawImg =
              imgEl?.getAttribute("src") || imgEl?.getAttribute("data-src") || imgEl?.getAttribute("data-original") || "";
            const image = /^(https?:)?\/\//.test(rawImg)
              ? rawImg.startsWith("//")
                ? `https:${rawImg}`
                : rawImg
              : undefined;

            seen.add(title);
            out.push({
              title,
              price: priceMatch?.[0],
              url,
              image,
              itemId: url?.match(/smzdm\.com\/p\/(\d+)/)?.[1],
            });
          }
          return out;
        },
        { maxLimit: limit, cardSelector: CARD_SELECTOR },
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
      error: "什么值得买是比价情报站，不能直接下单：请按爆料页里的商城链接到原平台购买",
      retryable: false,
    };
  }

  readonly supportsCheckout = false;

  async submitOrder(_page: Page): Promise<{ ok: boolean; error?: string; retryable?: boolean }> {
    return { ok: false, error: "什么值得买不支持下单", retryable: false };
  }

  async readOrderStatus(_page: Page, _orderId?: string): Promise<OrderStatus[]> {
    return [];
  }

  async cancelOrder(_page: Page, _orderId?: string): Promise<CancelResult> {
    return { ok: false, error: adapterError(new Error("什么值得买不支持下单/取消"), "什么值得买").error, retryable: false };
  }
}
