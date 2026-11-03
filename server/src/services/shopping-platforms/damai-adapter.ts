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
 * 大麦适配器（演唱会/话剧/体育等演出票）。
 *
 * 搜索页：https://search.damai.cn/search.html?keyword=<query>
 * 详情页：https://detail.damai.cn/item.htm?id=<itemId>
 * 订单页：https://www.damai.cn/order/showOrderList
 *
 * 特殊约束：
 * - **实名制**：多数演出强实名（购票人身份证）。下单前 agent 必须向用户确认
 *   观演人已在用户的大麦账号「观影人」列表中；本适配器不代填证件信息。
 * - **强登录**：下单流程必须登录态 Cookie；未登录时结算按钮不可达，返回明确错误。
 * - 页面结构变动频繁（阿里系风控强），多组选择器兜底 + 诚实报错。
 */
export class DamaiAdapter implements ShoppingPlatformAdapter {
  readonly platform = "damai";
  readonly category = "ticketing" as const;

  searchUrl(query: string, _filters?: SearchFilters): string {
    const q = encodeURIComponent(query);
    return `https://search.damai.cn/search.html?keyword=${q}`;
  }

  orderListUrl(): string {
    return "https://www.damai.cn/order/showOrderList";
  }

  async extractProducts(page: Page, limit: number): Promise<ProductSummary[]> {
    try {
      await page.waitForSelector("[class*='item'], [class*='search-result'] a, [class*='performance']", {
        timeout: 10_000,
      }).catch(() => {});

      const raw = await page.evaluate((maxLimit: number) => {
        const seen = new Set<string>();
        const out: Array<{ title: string; price?: string; url?: string; shop?: string; itemId?: string }> = [];
        // 演出卡片：标题 + 时间/城市 + 价格区间（如「¥180-1280」取下限）
        const nodes = document.querySelectorAll("[class*='search-result'] a[href*='detail'], [class*='item__'], [class*='performance-item'], .item");
        for (const node of Array.from(nodes)) {
          if (out.length >= maxLimit) break;
          const titleEl = node.querySelector("[class*='title'], h3, h4") as HTMLElement | null;
          const priceEl = node.querySelector("[class*='price'], [class*='Price']") as HTMLElement | null;
          const linkEl = (node.tagName === "A" ? node : node.querySelector("a[href]")) as HTMLAnchorElement | null;
          const title = (titleEl?.innerText ?? "").trim();
          if (!title || seen.has(title)) continue;
          seen.add(title);
          const url = linkEl?.href ?? undefined;
          const itemIdMatch = url?.match(/[?&]id=(\d+)/);
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

      // 大麦购买按钮：「立即购买」「立即预订」「选座购买」（选座需人工，直接放弃）
      const buyNowSelectors = [
        "button:has-text('立即购买')",
        "a:has-text('立即购买')",
        "button:has-text('立即预订')",
        '[class*="buy-btn"]',
        '[class*="purchase"]',
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
          error: "未找到「立即购买/立即预订」按钮（未开售/已售罄/需选座/未登录均可能导致，请检查演出状态与登录态）",
          retryable: false,
        };
      }

      await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {});
      await page.waitForTimeout(2_500);

      // 数量（票数）选择
      if (quantity > 1) {
        const qtySelectors = [
          '[class*="number"] input',
          'input[class*="qty"]',
          '[class*="count"] input',
        ];
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
        const titleEl = document.querySelector('[class*="Item--itemTitle"], [class*="title"], .item-title') as HTMLElement | null;
        const priceEl = document.querySelector('[class*="price"], [class*="totalPrice"], [class*="amount"]') as HTMLElement | null;
        // 确认页的「观演人」区域（实名制凭证，有则提示）
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
      return adapterError(err, "大麦走到确认页");
    }
  }

  async submitOrder(page: Page): Promise<{ ok: boolean; orderId?: string; error?: string; retryable?: boolean; paymentUrl?: string }> {
    try {
      const submitSelectors = [
        "button:has-text('提交订单')",
        "button:has-text('确认订单')",
        "a:has-text('提交订单')",
        '[class*="submit"]',
        ".go-btn",
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

      const onPaymentPage = /pay|cashier|alipay/i.test(page.url());
      return {
        ok: true,
        orderId,
        paymentUrl: onPaymentPage ? page.url() : undefined,
        error: !orderId ? "订单可能已提交，请到订单列表确认" : undefined,
      };
    } catch (err) {
      const e = adapterError(err, "大麦提交订单");
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
          const itemEl = row.querySelector("[class*='title'], [class*='itemTitle']") as HTMLElement | null;
          const priceEl = row.querySelector("[class*='price'], [class*='amount']") as HTMLElement | null;
          const timeEl = row.querySelector("[class*='time']") as HTMLElement | null;
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
      const e = adapterError(err, "大麦取消订单");
      return { ok: false, orderId, error: e.error, retryable: e.retryable };
    }
  }
}
