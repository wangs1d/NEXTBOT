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
 * 京东适配器。
 *
 * 搜索页：https://search.jd.com/Search?keyword=<query>
 * 订单页：https://order.jd.com/center/list.action
 */
const CARD_SELECTOR = ".gl-item, [class*='product-item'], [data-sku]";

export class JdAdapter implements ShoppingPlatformAdapter {
  readonly platform = "jd";

  searchUrl(query: string, filters?: SearchFilters): string {
    const q = encodeURIComponent(query);
    let sort = "";
    if (filters?.sort === "price_asc") sort = "&psort=3";
    else if (filters?.sort === "price_desc") sort = "&psort=2";
    else if (filters?.sort === "sales") sort = "&psort=1";
    return `https://search.jd.com/Search?keyword=${q}&enc=utf-8${sort}`;
  }

  orderListUrl(): string {
    return "https://order.jd.com/center/list.action";
  }

  async extractProducts(page: Page, limit: number): Promise<ProductSummary[]> {
    try {
      await this.scrollSearchResults(page);
      await page.waitForSelector(CARD_SELECTOR, { timeout: 10_000 }).catch(() => {});

      const raw = await page.evaluate(
        ({ maxLimit, cardSelector }: { maxLimit: number; cardSelector: string }) => {
          const seen = new Set<string>();
          const out: Array<{ title: string; price?: string; url?: string; shop?: string; itemId?: string }> = [];
          const nodes = document.querySelectorAll(cardSelector);
          for (const node of Array.from(nodes)) {
            if (out.length >= maxLimit) break;
            const titleEl = node.querySelector(
              "[class*='goods_title'], .p-name a, .p-name, [class*='p-name']",
            ) as HTMLElement | null;
            const title = (titleEl?.innerText ?? titleEl?.getAttribute("title") ?? "").trim();
            if (!title || seen.has(title)) continue;
            seen.add(title);

            const priceEl = node.querySelector("[class*='price']") as HTMLElement | null;
            const priceMatch = (priceEl?.innerText ?? "").match(/\d+(?:\.\d+)?/);

            const sku = (node as HTMLElement).getAttribute("data-sku") ?? "";
            const linkEl = node.querySelector("a[href*='item.jd.com']") as HTMLAnchorElement | null;
            const url = linkEl?.href ?? (sku ? `https://item.jd.com/${sku}.html` : undefined);
            const itemIdMatch = url?.match(/item\.jd\.com\/(\d+)/) ?? url?.match(/[?&]sku=(\d+)/);
            const shopEl = node.querySelector("[class*='shop'], .p-shop a") as HTMLElement | null;
            out.push({
              title,
              price: priceMatch?.[0],
              url,
              shop: (shopEl?.innerText ?? "").trim() || undefined,
              itemId: itemIdMatch?.[1] ?? (sku || undefined),
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
        shop: r.shop,
        itemId: r.itemId,
      }));
    } catch {
      return [];
    }
  }

  private async scrollSearchResults(page: Page): Promise<void> {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
    await page.waitForTimeout(600);
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  }

  async navigateToCheckout(page: Page, product: ProductSummary, quantity: number): Promise<CheckoutSnapshot> {
    try {
      if (product.url) {
        await page.goto(product.url, { waitUntil: "domcontentloaded", timeout: 15_000 });
        await page.waitForTimeout(2_500);
      }

      // 京东"立即购买"按钮
      const buyNowSelectors = [
        '#InitCartUrl, .btn-special1',
        "a:has-text('立即购买')",
        "button:has-text('立即购买')",
        '[class*="buyNow"]',
      ];
      let clicked = false;
      for (const sel of buyNowSelectors) {
        try {
          const el = page.locator(sel).first();
          if ((await el.count()) > 0 && (await el.isVisible().catch(() => false))) {
            await el.click({ timeout: 5_000 });
            clicked = true;
            break;
          }
        } catch {
          /* try next */
        }
      }
      if (!clicked) {
        return { ok: false, error: "未找到「立即购买」按钮（页面结构可能变更）", retryable: false };
      }

      await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {});
      await page.waitForTimeout(2_000);

      // 设置数量
      if (quantity > 1) {
        const qtySelectors = ['.buy_num input, #buyNum, input[class*="quantity"]'];
        for (const sel of qtySelectors) {
          try {
            const inp = page.locator(sel).first();
            if ((await inp.count()) > 0) {
              await inp.fill(String(quantity), { timeout: 3_000 });
              break;
            }
          } catch {
            /* try next */
          }
        }
      }

      const snapshot = await page.evaluate(() => {
        const titleEl = document.querySelector('.p-name, [class*="itemTitle"], [class*="title"]') as HTMLElement | null;
        const priceEl = document.querySelector('.p-price, [class*="totalPrice"], [class*="orderPrice"]') as HTMLElement | null;
        const addrEl = document.querySelector('[class*="address"], .addr-info, [class*="addressInfo"]') as HTMLElement | null;
        const qtyEl = document.querySelector('.buy_num input, #buyNum, input[class*="quantity"]') as HTMLInputElement | null;
        return {
          title: (titleEl?.innerText ?? "").trim(),
          priceText: (priceEl?.innerText ?? "").replace(/[^\d.]/g, ""),
          addr: (addrEl?.innerText ?? "").trim().slice(0, 200),
          qty: qtyEl?.value ? Number.parseInt(qtyEl.value, 10) : undefined,
        };
      });

      const screenshotBase64 = (await page.screenshot({ type: "png", fullPage: false }).catch(() => null))?.toString("base64") ?? undefined;
      const unitPrice = snapshot.priceText ? Number.parseFloat(snapshot.priceText) : undefined;
      const qty = snapshot.qty ?? quantity;
      return {
        ok: true,
        itemTitle: snapshot.title || product.title,
        unitPrice,
        quantity: qty,
        totalPrice: unitPrice ? Math.round(unitPrice * qty * 100) / 100 : undefined,
        currency: unitPrice ? "CNY" : undefined,
        addressSummary: snapshot.addr || undefined,
        screenshotBase64,
        checkoutUrl: page.url(),
      };
    } catch (err) {
      return adapterError(err, "京东走到结算页");
    }
  }

  async submitOrder(page: Page): Promise<{ ok: boolean; orderId?: string; error?: string; retryable?: boolean; paymentUrl?: string }> {
    try {
      const submitSelectors = [
        '#order-submit, .checkout-submit',
        "button:has-text('提交订单')",
        "a:has-text('提交订单')",
        '[class*="submitOrder"]',
      ];
      let clicked = false;
      for (const sel of submitSelectors) {
        try {
          const el = page.locator(sel).first();
          if ((await el.count()) > 0 && (await el.isVisible().catch(() => false))) {
            await el.click({ timeout: 5_000 });
            clicked = true;
            break;
          }
        } catch {
          /* try next */
        }
      }
      if (!clicked) {
        return { ok: false, error: "未找到「提交订单」按钮（页面结构可能变更）", retryable: false };
      }

      await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {});
      await page.waitForTimeout(2_000);

      const urlOrderId = page.url().match(/[?&]orderId=(\d+)/)?.[1] ?? page.url().match(/\/order\/(\d+)/)?.[1];
      let orderId = urlOrderId;
      if (!orderId) {
        orderId = await page.evaluate(() => {
          const text = document.body?.innerText ?? "";
          const m = text.match(/订单号[：:]\s*(\d{8,})/) ?? text.match(/orderId[=:]\s*"?(\d{8,})"?/);
          return m?.[1];
        });
      }

      const onPaymentPage = /pay\.jd\.com|cashier\.jd/i.test(page.url());
      return {
        ok: true,
        orderId,
        paymentUrl: onPaymentPage ? page.url() : undefined,
        error: onPaymentPage && !orderId ? "订单已提交，请在客户端完成支付" : undefined,
      };
    } catch (err) {
      const e = adapterError(err, "京东提交订单");
      return { ok: false, error: e.error, retryable: e.retryable };
    }
  }

  async readOrderStatus(page: Page, orderId?: string): Promise<OrderStatus[]> {
    try {
      await page.waitForSelector(".order-tb tbody tr, .order-list .order-item, [class*='order-item']", { timeout: 10_000 }).catch(() => {});
      return await page.evaluate((targetId?: string) => {
        const rows = document.querySelectorAll(".order-tb tbody tr, .order-list .order-item, [class*='order-item']");
        const out: Array<{
          orderId?: string; status?: string; statusDesc?: string; logisticsSummary?: string;
          itemTitle?: string; totalPrice?: number; createdAt?: string;
        }> = [];
        for (const row of Array.from(rows)) {
          const idEl = row.querySelector("[class*='order-id'], .number, [class*='orderId']") as HTMLElement | null;
          const statusEl = row.querySelector(".order-status, [class*='status']") as HTMLElement | null;
          const itemEl = row.querySelector(".p-name, [class*='title'], .goods-item") as HTMLElement | null;
          const priceEl = row.querySelector(".amount, [class*='price'], .total-price") as HTMLElement | null;
          const timeEl = row.querySelector(".deal-time, [class*='time']") as HTMLElement | null;
          const id = (idEl?.innerText ?? "").replace(/[^\d]/g, "") || undefined;
          if (targetId && id !== targetId) continue;
          const priceText = (priceEl?.innerText ?? "").replace(/[^\d.]/g, "");
          out.push({
            orderId: id,
            status: (statusEl?.innerText ?? "").trim() || undefined,
            statusDesc: (statusEl?.innerText ?? "").trim() || undefined,
            itemTitle: (itemEl?.innerText ?? "").trim() || undefined,
            totalPrice: priceText ? Number.parseFloat(priceText) : undefined,
            createdAt: (timeEl?.innerText ?? "").trim() || undefined,
          });
          if (out.length >= 10) break;
        }
        return out;
      }, orderId);
    } catch {
      return [];
    }
  }

  async cancelOrder(page: Page, orderId: string): Promise<CancelResult> {
    try {
      const cancelBtn = page.locator(`text=${orderId}`).locator("xpath=ancestor::*[contains(@class,'order') or self::tr]").locator("a:has-text('取消'), button:has-text('取消')").first();
      if ((await cancelBtn.count()) > 0) {
        await cancelBtn.click({ timeout: 5_000 });
        const confirmBtn = page.locator("button:has-text('确定'), .ui-dialog-ok");
        if ((await confirmBtn.count()) > 0) {
          await confirmBtn.first().click({ timeout: 5_000 });
        }
        await page.waitForTimeout(2_000);
        return { ok: true, orderId };
      }
      return { ok: false, orderId, error: "未找到对应订单的取消按钮", retryable: false };
    } catch (err) {
      const e = adapterError(err, "京东取消订单");
      return { ok: false, orderId, error: e.error, retryable: e.retryable };
    }
  }
}
