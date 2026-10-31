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
 * 拼多多适配器。
 *
 * 搜索页：https://mobile.yangkeduo.com/search_result.html?search_key=<query>
 * 订单页：https://mobile.pinduoduo.com/orders
 *
 * 搜索页必须带登录态：未登录会被 302 到 login.html?from=<搜索页>，登录后自动回跳。
 * 旧路径 search_goods.html 已废弃（302 → portal.html?redirect_from=...，不出搜索结果）。
 *
 * 注意：拼多多 Web 端反爬强、常强制跳 App，页面结构变动频繁。
 * 本适配器为尽力而为：多组选择器兜底，全部失效时返回明确错误（不引入视觉兜底）。
 */
export class PddAdapter implements ShoppingPlatformAdapter {
  readonly platform = "pdd";

  searchUrl(query: string, _filters?: SearchFilters): string {
    const q = encodeURIComponent(query);
    return `https://mobile.yangkeduo.com/search_result.html?search_key=${q}`;
  }

  orderListUrl(): string {
    return "https://mobile.pinduoduo.com/orders";
  }

  async extractProducts(page: Page, limit: number): Promise<ProductSummary[]> {
    try {
      await page.waitForSelector("[class*='goods'], [class*='product'], [class*='search-item'], .item", {
        timeout: 10_000,
      }).catch(() => {});

      const raw = await page.evaluate((maxLimit: number) => {
        const seen = new Set<string>();
        const out: Array<{ title: string; price?: string; url?: string; shop?: string }> = [];
        const nodes = document.querySelectorAll("[class*='goods-item'], [class*='product-item'], [class*='search-item'], .item");
        for (const node of Array.from(nodes)) {
          if (out.length >= maxLimit) break;
          const titleEl = node.querySelector("[class*='title'], h3, h4") as HTMLElement | null;
          const priceEl = node.querySelector("[class*='price']") as HTMLElement | null;
          const shopEl = node.querySelector("[class*='shop'], [class*='store']") as HTMLElement | null;
          const linkEl = node.querySelector("a[href]") as HTMLAnchorElement | null;
          const title = (titleEl?.innerText ?? "").trim();
          if (!title || seen.has(title)) continue;
          seen.add(title);
          out.push({
            title,
            price: (priceEl?.innerText ?? "").replace(/[^\d.]/g, "") || undefined,
            url: linkEl?.href ?? undefined,
            shop: (shopEl?.innerText ?? "").trim() || undefined,
          });
        }
        return out;
      }, limit);

      return raw.map((r) => ({
        title: r.title,
        price: r.price ? Number.parseFloat(r.price) : undefined,
        currency: r.price ? "CNY" : undefined,
        url: r.url,
        shop: r.shop,
      }));
    } catch {
      return [];
    }
  }

  async navigateToCheckout(page: Page, product: ProductSummary, quantity: number): Promise<CheckoutSnapshot> {
    try {
      if (product.url) {
        await page.goto(product.url, { waitUntil: "domcontentloaded", timeout: 15_000 });
        await page.waitForTimeout(2_500);
      }

      const buyNowSelectors = [
        "button:has-text('单独购买')",
        "button:has-text('立即购买')",
        "a:has-text('立即购买')",
        '[class*="buyNow"]',
        '[class*="buy-btn"]',
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
          /* try next selector */
        }
      }
      if (!clicked) {
        return { ok: false, error: "未找到「立即购买/单独购买」按钮（页面结构可能变更）", retryable: false };
      }

      await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {});
      await page.waitForTimeout(2_000);

      const snapshot = await page.evaluate(() => {
        const titleEl = document.querySelector("[class*='title'], [class*='goods-name']") as HTMLElement | null;
        const priceEl = document.querySelector("[class*='price'], [class*='totalPrice']") as HTMLElement | null;
        const addrEl = document.querySelector("[class*='address'], [class*='addr']") as HTMLElement | null;
        return {
          title: (titleEl?.innerText ?? "").trim(),
          priceText: (priceEl?.innerText ?? "").replace(/[^\d.]/g, ""),
          addr: (addrEl?.innerText ?? "").trim().slice(0, 200),
        };
      });

      const screenshotBase64 = (await page.screenshot({ type: "png", fullPage: false }).catch(() => null))?.toString("base64") ?? undefined;
      const unitPrice = snapshot.priceText ? Number.parseFloat(snapshot.priceText) : undefined;
      return {
        ok: true,
        itemTitle: snapshot.title || product.title,
        unitPrice,
        quantity,
        totalPrice: unitPrice ? Math.round(unitPrice * quantity * 100) / 100 : undefined,
        currency: unitPrice ? "CNY" : undefined,
        addressSummary: snapshot.addr || undefined,
        screenshotBase64,
        checkoutUrl: page.url(),
      };
    } catch (err) {
      return adapterError(err, "拼多多走到结算页");
    }
  }

  async submitOrder(page: Page): Promise<{ ok: boolean; orderId?: string; error?: string; retryable?: boolean; paymentUrl?: string }> {
    try {
      const submitSelectors = [
        "button:has-text('提交订单')",
        "button:has-text('确认订单')",
        '[class*="submit"]',
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
          /* try next selector */
        }
      }
      if (!clicked) {
        return { ok: false, error: "未找到「提交订单」按钮", retryable: false };
      }

      await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {});
      await page.waitForTimeout(2_000);

      const urlOrderId = page.url().match(/[?&]order_sn=(\w+)/)?.[1] ?? page.url().match(/\/order\/(\w+)/)?.[1];
      let orderId = urlOrderId;
      if (!orderId) {
        orderId = await page.evaluate(() => {
          const text = document.body?.innerText ?? "";
          const m = text.match(/订单号[：:]\s*([A-Za-z0-9]{6,})/);
          return m?.[1];
        });
      }

      const onPaymentPage = /pay|cashier/i.test(page.url());
      return {
        ok: true,
        orderId,
        paymentUrl: onPaymentPage ? page.url() : undefined,
        error: !orderId ? "订单可能已提交，请到订单列表确认" : undefined,
      };
    } catch (err) {
      const e = adapterError(err, "拼多多提交订单");
      return { ok: false, error: e.error, retryable: e.retryable };
    }
  }

  async readOrderStatus(page: Page, orderId?: string): Promise<OrderStatus[]> {
    try {
      await page.waitForSelector("[class*='order-item'], [class*='order-card'], tbody tr", { timeout: 10_000 }).catch(() => {});
      return await page.evaluate((targetId?: string) => {
        const rows = document.querySelectorAll("[class*='order-item'], [class*='order-card'], tbody tr");
        const out: Array<{
          orderId?: string; status?: string; statusDesc?: string; logisticsSummary?: string;
          itemTitle?: string; totalPrice?: number; createdAt?: string;
        }> = [];
        for (const row of Array.from(rows)) {
          const idEl = row.querySelector("[class*='order-id'], [class*='order-no']") as HTMLElement | null;
          const statusEl = row.querySelector("[class*='status']") as HTMLElement | null;
          const itemEl = row.querySelector("[class*='title'], [class*='goods-name']") as HTMLElement | null;
          const priceEl = row.querySelector("[class*='price'], [class*='amount']") as HTMLElement | null;
          const id = (idEl?.innerText ?? "").replace(/[^\w]/g, "") || undefined;
          if (targetId && id !== targetId) continue;
          const priceText = (priceEl?.innerText ?? "").replace(/[^\d.]/g, "");
          out.push({
            orderId: id,
            status: (statusEl?.innerText ?? "").trim() || undefined,
            statusDesc: (statusEl?.innerText ?? "").trim() || undefined,
            itemTitle: (itemEl?.innerText ?? "").trim() || undefined,
            totalPrice: priceText ? Number.parseFloat(priceText) : undefined,
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
      const cancelBtn = page.locator(`text=${orderId}`).locator("xpath=ancestor::*[contains(@class,'order') or self::tr]").locator("button:has-text('取消'), a:has-text('取消')").first();
      if ((await cancelBtn.count()) > 0) {
        await cancelBtn.click({ timeout: 5_000 });
        const confirmBtn = page.locator("button:has-text('确定'), button:has-text('确认取消')");
        if ((await confirmBtn.count()) > 0) {
          await confirmBtn.first().click({ timeout: 5_000 });
        }
        await page.waitForTimeout(2_000);
        return { ok: true, orderId };
      }
      return { ok: false, orderId, error: "未找到对应订单的取消按钮", retryable: false };
    } catch (err) {
      const e = adapterError(err, "拼多多取消订单");
      return { ok: false, orderId, error: e.error, retryable: e.retryable };
    }
  }
}
