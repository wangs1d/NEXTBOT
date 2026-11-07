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
 * 猫眼（演出/展览/赛事票务）适配器。
 *
 * 搜索页：https://www.maoyan.com/live/search?keyword=<query>
 * 订单页：https://www.maoyan.com/order
 *
 * 特殊约束与大麦一致：实名制演出不代填证件信息；强登录态；页面结构变动
 * 频繁（猫眼反爬强，无 Cookie 时大概率触发验证码），多组选择器兜底 + 诚实报错。
 */
export class MaoyanAdapter implements ShoppingPlatformAdapter {
  readonly platform = "maoyan";
  readonly category = "ticketing" as const;
  readonly authMode = "login" as const;

  searchUrl(query: string, _filters?: SearchFilters): string {
    const q = encodeURIComponent(query);
    return `https://www.maoyan.com/live/search?keyword=${q}`;
  }

  orderListUrl(): string {
    return "https://www.maoyan.com/order";
  }

  async extractProducts(page: Page, limit: number): Promise<ProductSummary[]> {
    try {
      await page.waitForSelector("[class*='item'], [class*='search-result'] a, [class*='live']", {
        timeout: 10_000,
      }).catch(() => {});

      const raw = await page.evaluate((maxLimit: number) => {
        const seen = new Set<string>();
        const out: Array<{ title: string; price?: string; url?: string; itemId?: string }> = [];
        const nodes = document.querySelectorAll("[class*='live-item'], [class*='search-result'] a[href*='show'], [class*='item']");
        for (const node of Array.from(nodes)) {
          if (out.length >= maxLimit) break;
          const titleEl = node.querySelector("[class*='title'], h3, h4") as HTMLElement | null;
          const priceEl = node.querySelector("[class*='price']") as HTMLElement | null;
          const linkEl = (node.tagName === "A" ? node : node.querySelector("a[href]")) as HTMLAnchorElement | null;
          const title = (titleEl?.innerText ?? "").trim();
          if (!title || seen.has(title)) continue;
          seen.add(title);
          const url = linkEl?.href ?? undefined;
          const itemIdMatch = url?.match(/\/show\/(\d+)/) ?? url?.match(/[?&]id=(\d+)/);
          out.push({
            title,
            price: (priceEl?.innerText ?? "").replace(/[^\d.]/g, "").split(".")[0] || undefined,
            url,
            itemId: itemIdMatch?.[1],
          });
        }
        return out;
      }, limit);

      return raw.map((r) => ({
        title: r.title,
        price: r.price ? Number.parseFloat(r.price) : undefined,
        currency: r.price ? "CNY" : undefined,
        url: r.url,
        itemId: r.itemId,
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
        "button:has-text('立即购买')",
        "a:has-text('立即购买')",
        "button:has-text('选座购买')",
        '[class*="buy"]',
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
        return {
          ok: false,
          error: "未找到「立即购买」按钮（未开售/已售罄/需选座/未登录均可能导致，请检查演出状态与登录态）",
          retryable: false,
        };
      }

      await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {});
      await page.waitForTimeout(2_500);

      const snapshot = await page.evaluate(() => {
        const titleEl = document.querySelector("[class*='title'], [class*='show-name']") as HTMLElement | null;
        const priceEl = document.querySelector("[class*='price'], [class*='amount']") as HTMLElement | null;
        const body = document.body?.innerText ?? "";
        const needRealName = /观演人|购票人|实名/.test(body);
        return {
          title: (titleEl?.innerText ?? "").trim(),
          priceText: (priceEl?.innerText ?? "").replace(/[^\d.]/g, ""),
          needRealName,
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
        addressSummary: snapshot.needRealName ? "实名制演出：使用你账号内已保存的观演人（如需新增观演人请先在 App 内添加）" : undefined,
        screenshotBase64,
        checkoutUrl: page.url(),
      };
    } catch (err) {
      return adapterError(err, "猫眼走到确认页");
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
        return { ok: false, error: "未找到「提交订单」按钮（页面结构可能变更）", retryable: false };
      }

      await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {});
      await page.waitForTimeout(2_500);

      const urlOrderId = page.url().match(/[?&]orderId=(\d+)/)?.[1] ?? page.url().match(/\/order\/(\d+)/)?.[1];
      let orderId = urlOrderId;
      if (!orderId) {
        orderId = await page.evaluate(() => {
          const text = document.body?.innerText ?? "";
          const m = text.match(/订单号[：:]\s*(\d{8,})/) ?? text.match(/orderId[=:]\s*"?(\d{8,})"?/);
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
      const e = adapterError(err, "猫眼提交订单");
      return { ok: false, error: e.error, retryable: e.retryable };
    }
  }

  async readOrderStatus(page: Page, orderId?: string): Promise<OrderStatus[]> {
    try {
      await page.waitForSelector("[class*='order-item'], [class*='order-card']", { timeout: 10_000 }).catch(() => {});
      return await page.evaluate((targetId?: string) => {
        const rows = document.querySelectorAll("[class*='order-item'], [class*='order-card']");
        const out: Array<{
          orderId?: string; status?: string; statusDesc?: string; logisticsSummary?: string;
          itemTitle?: string; totalPrice?: number; createdAt?: string;
        }> = [];
        for (const row of Array.from(rows)) {
          const idEl = row.querySelector("[class*='order-id'], [class*='order-no']") as HTMLElement | null;
          const statusEl = row.querySelector("[class*='status']") as HTMLElement | null;
          const itemEl = row.querySelector("[class*='title'], [class*='show-name']") as HTMLElement | null;
          const priceEl = row.querySelector("[class*='price'], [class*='amount']") as HTMLElement | null;
          const id = (idEl?.innerText ?? "").replace(/[^\d]/g, "") || undefined;
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
      return { ok: false, orderId, error: "未找到对应订单的取消按钮（演出票通常不支持无理由取消，请确认退改规则）", retryable: false };
    } catch (err) {
      const e = adapterError(err, "猫眼取消订单");
      return { ok: false, orderId, error: e.error, retryable: e.retryable };
    }
  }
}
