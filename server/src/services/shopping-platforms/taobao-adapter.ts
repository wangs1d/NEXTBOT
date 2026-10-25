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
 * 淘宝/天猫适配器。
 *
 * 搜索页：https://s.taobao.com/search?q=<query>
 * 订单页：https://buyertrade.taobao.com/trade/itemlist/list_bought_items.htm
 *
 * 注意：淘宝页面结构会随改版变化，本适配器使用多组选择器兜底。
 * 选择器全部失效时返回明确错误，不引入 VLM 视觉兜底（后续增强项）。
 */
export class TaobaoAdapter implements ShoppingPlatformAdapter {
  readonly platform: string = "taobao";

  searchUrl(query: string, filters?: SearchFilters): string {
    const q = encodeURIComponent(query);
    let sort = "";
    if (filters?.sort === "price_asc") sort = "&sort=price-asc";
    else if (filters?.sort === "price_desc") sort = "&sort=price-desc";
    else if (filters?.sort === "sales") sort = "&sort=sale-desc";
    return `https://s.taobao.com/search?q=${q}${sort}`;
  }

  orderListUrl(): string {
    return "https://buyertrade.taobao.com/trade/itemlist/list_bought_items.htm";
  }

  async extractProducts(page: Page, limit: number): Promise<ProductSummary[]> {
    // 注意：evaluate 回调体内**禁止出现任何函数表达式/箭头函数**——tsx 的
    // esbuild keepNames 会给内部函数注入 __name() 辅助调用，序列化到浏览器
    // 执行时 ReferenceError（2026-10 实测踩坑；字符串形式在 connectOverCDP
    // 下又恒返 undefined，只能用「纯语句」函数体）。
    try {
      // 等待商品卡片渲染（含 2026-10 改版后的 doubleCard--<hash> 哈希类）
      await page.waitForSelector(
        '[class*="Card--doubleCardWrapper"], [class*="Content--contentInner"], .items .item, [class*="doubleCard"], a[href*="item.htm"], a[href*="detail.tmall.com"]',
        { timeout: 10_000 },
      ).catch(() => {});

      const raw = await page.evaluate(
        (maxLimit: number) => {
          const selectors = [
            '[class*="Card--doubleCardWrapper"]',
            '[class*="Content--contentInner"]',
            '[class*="doubleCard"]',
            ".items .item",
            '[data-spm="dlist"]',
          ];
          const seen = new Set<string>();
          const out: Array<{ title: string; price?: string; url?: string; shop?: string; itemId?: string }> = [];
          for (const sel of selectors) {
            const nodes = document.querySelectorAll(sel);
            if (nodes.length === 0) continue;
            for (const node of Array.from(nodes)) {
              if (out.length >= maxLimit) break;
              const titleEl = node.querySelector(
                '[class*="Title--title"], .title, h4, [class*="title" i]',
              );
              const priceEl = node.querySelector(
                '[class*="Price--price"], .price, [class*="priceInt"], [class*="price" i]',
              );
              const linkEl = node.querySelector("a[href]");
              const shopEl = node.querySelector(
                '[class*="Shop--shopName"], .shop, [class*="shopName"], [class*="shop" i]',
              );
              const title = String((titleEl as HTMLElement | null)?.innerText ?? "").trim();
              if (!title || seen.has(title)) continue;
              seen.add(title);
              const url = (linkEl as HTMLAnchorElement | null)?.href;
              const itemIdMatch = url ? /[?&]id=(\d+)/.exec(url) : null;
              // 价格取文本里第一个数字（「¥\n2899\n2000+ 人付款」→ 2899）
              const priceMatch = /\d[\d,]*(?:\.\d+)?/.exec(
                String((priceEl as HTMLElement | null)?.innerText ?? ""),
              );
              out.push({
                title,
                price: priceMatch ? priceMatch[0].replace(/,/g, "") : undefined,
                url,
                shop: String((shopEl as HTMLElement | null)?.innerText ?? "").trim() || undefined,
                itemId: itemIdMatch?.[1],
              });
            }
            if (out.length >= maxLimit) break;
          }
          // 链接锚定兜底（2026-10 搜索页改版：卡片/字段 class 全部换哈希，
          // 上面的容器选择器可能全部失配）。锚定 item.htm / detail.tmall 链接，
          // 向上找卡片容器；字段用大小写不敏感的 class 子串 + 叶子文本兜底，
          // 不依赖任何具体类名。
          if (out.length === 0) {
            const anchors = document.querySelectorAll(
              'a[href*="item.htm"], a[href*="detail.tmall.com"]',
            );
            for (const link of Array.from(anchors)) {
              if (out.length >= maxLimit) break;
              let card: HTMLElement | null = link as HTMLElement;
              for (let i = 0; i < 8 && card; i++) {
                card = card.parentElement;
                if (!card) break;
                const cls = String(card.className || "");
                if (/doubleCard|Card|item/i.test(cls) && card.querySelector("a[href]") === link) {
                  break;
                }
              }
              const scope = card ?? (link as HTMLElement);
              const titleEl2 = scope.querySelector('[class*="title" i]') as HTMLElement | null;
              const title2 = String(titleEl2?.innerText ?? (link as HTMLElement).innerText ?? "")
                .trim()
                .replace(/\s+/g, " ");
              if (!title2 || title2.length < 4 || seen.has(title2)) continue;
              seen.add(title2);
              let priceEl2: HTMLElement | null = scope.querySelector(
                '[class*="priceInt"], [class*="price" i]',
              ) as HTMLElement | null;
              if (!priceEl2) {
                const leaves = scope.querySelectorAll("*");
                for (const n of Array.from(leaves)) {
                  if (
                    n.children.length === 0 &&
                    /^\s*¥?\s*\d{2,5}(\.\d+)?\s*$/.test(String(n.textContent ?? ""))
                  ) {
                    priceEl2 = n as HTMLElement;
                    break;
                  }
                }
              }
              const shopEl2 = scope.querySelector(
                '[class*="shopName"], [class*="shop" i]',
              ) as HTMLElement | null;
              const itemIdMatch2 = /[?&]id=(\d+)/.exec((link as HTMLAnchorElement).href);
              const priceMatch2 = /\d[\d,]*(?:\.\d+)?/.exec(
                String(priceEl2?.innerText ?? priceEl2?.textContent ?? ""),
              );
              out.push({
                title: title2,
                price: priceMatch2 ? priceMatch2[0].replace(/,/g, "") : undefined,
                url: (link as HTMLAnchorElement).href,
                shop: String(shopEl2?.innerText ?? "").trim() || undefined,
                itemId: itemIdMatch2?.[1],
              });
            }
          }
          return out;
        },
        limit,
      );

      return raw.map((r) => ({
        title: r.title,
        price: r.price ? Number.parseFloat(r.price) : undefined,
        currency: r.price ? "CNY" : undefined,
        url: r.url,
        shop: r.shop,
        itemId: r.itemId,
      }));
    } catch (err) {
      console.log("[TaobaoAdapter] extractProducts 异常:", err instanceof Error ? err.message : err);
      return [];
    }
  }

  async navigateToCheckout(page: Page, product: ProductSummary, quantity: number): Promise<CheckoutSnapshot> {
    try {
      // 1. 打开商品详情页
      if (product.url) {
        await page.goto(product.url, { waitUntil: "domcontentloaded", timeout: 15_000 });
        await page.waitForTimeout(2_500);
      }

      // 2. 点"立即购买"（多组选择器兜底）
      const buyNowSelectors = [
        '[class*="Button--primary"] [class*="buyNow"]',
        "button:has-text('立即购买')",
        "a:has-text('立即购买')",
        '[class*="ActionBtn--buyNow"]',
        ".tb-btn-buy a",
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
        return { ok: false, error: "未找到「立即购买」按钮（页面结构可能变更）", retryable: false };
      }

      // 3. 等待结算页加载
      await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {});
      await page.waitForTimeout(2_000);

      // 4. 设置数量（若 quantity > 1）
      if (quantity > 1) {
        const qtySelectors = [
          '[class*="Quantity--quantity"] input',
          'input[class*="qty"]',
          '[class*="number"] input',
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

      // 5. 读取订单摘要
      const snapshot = await page.evaluate(() => {
        const titleEl = document.querySelector('[class*="Item--itemTitle"], .item-title, [class*="title"]') as HTMLElement | null;
        const priceEl = document.querySelector('[class*="Price--price"], [class*="totalPrice"], .price, [class*="orderPrice"]') as HTMLElement | null;
        const addrEl = document.querySelector('[class*="Address--address"], .address, [class*="addressInfo"]') as HTMLElement | null;
        const qtyEl = document.querySelector('[class*="Quantity--quantity"] input, input[class*="qty"]') as HTMLInputElement | null;
        const title = (titleEl?.innerText ?? "").trim();
        const priceText = (priceEl?.innerText ?? "").replace(/[^\d.]/g, "");
        const addr = (addrEl?.innerText ?? "").trim().slice(0, 200);
        const qty = qtyEl?.value ? Number.parseInt(qtyEl.value, 10) : undefined;
        return { title, priceText, addr, qty };
      });

      // 6. 截图
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
      return adapterError(err, "淘宝走到结算页");
    }
  }

  async submitOrder(page: Page): Promise<{ ok: boolean; orderId?: string; error?: string; retryable?: boolean; paymentUrl?: string }> {
    try {
      // 点"提交订单"按钮（多组选择器兜底）—— 不点"立即支付"
      const submitSelectors = [
        '[class*="go-btn"]',
        "button:has-text('提交订单')",
        "button:has-text('确认订单')",
        '[class*="submitOrder"]',
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
          /* try next */
        }
      }
      if (!clicked) {
        return { ok: false, error: "未找到「提交订单」按钮（页面结构可能变更）", retryable: false };
      }

      // 等待提交结果页加载
      await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {});
      await page.waitForTimeout(2_000);

      // 从 URL 或页面文本提取订单号
      const urlOrderId = page.url().match(/[?&]orderId=(\d+)/)?.[1] ?? page.url().match(/\/order\/(\d+)/)?.[1];
      let orderId = urlOrderId;
      if (!orderId) {
        orderId = await page.evaluate(() => {
          const text = document.body?.innerText ?? "";
          const m = text.match(/订单号[：:]\s*(\d{8,})/) ?? text.match(/orderId[=:]\s*"?(\d{8,})"?/);
          return m?.[1];
        });
      }

      // 检测是否进入支付页（提交成功但需用户支付）
      const onPaymentPage = /pay\.taobao|cashier\.taobao/i.test(page.url());
      return {
        ok: true,
        orderId,
        paymentUrl: onPaymentPage ? page.url() : undefined,
        error: onPaymentPage && !orderId ? "订单已提交，请在客户端完成支付" : undefined,
      };
    } catch (err) {
      const e = adapterError(err, "淘宝提交订单");
      return { ok: false, error: e.error, retryable: e.retryable };
    }
  }

  async readOrderStatus(page: Page, orderId?: string): Promise<OrderStatus[]> {
    try {
      await page.waitForSelector('[class*="bought-item"], .order-item, tbody tr', { timeout: 10_000 }).catch(() => {});
      return await page.evaluate((targetId?: string) => {
        const rows = document.querySelectorAll('[class*="bought-item"], .order-item, tbody tr');
        const out: Array<{
          orderId?: string; status?: string; statusDesc?: string; logisticsSummary?: string;
          itemTitle?: string; totalPrice?: number; createdAt?: string;
        }> = [];
        for (const row of Array.from(rows)) {
          const idEl = row.querySelector('[class*="orderNo"], [class*="orderId"]') as HTMLElement | null;
          const statusEl = row.querySelector('[class*="status"], .order-status') as HTMLElement | null;
          const itemEl = row.querySelector('[class*="title"], .item-title') as HTMLElement | null;
          const priceEl = row.querySelector('[class*="price"], .amount') as HTMLElement | null;
          const timeEl = row.querySelector('[class*="time"], .create-time') as HTMLElement | null;
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
      // 找到目标订单行的"取消订单"按钮
      const cancelBtn = page.locator(`text=${orderId}`).locator("xpath=ancestor::*[contains(@class,'order') or self::tr]").locator("button:has-text('取消订单'), a:has-text('取消订单')").first();
      if ((await cancelBtn.count()) > 0) {
        await cancelBtn.click({ timeout: 5_000 });
        // 确认弹窗
        const confirmBtn = page.locator("button:has-text('确定'), button:has-text('确认取消')");
        if ((await confirmBtn.count()) > 0) {
          await confirmBtn.first().click({ timeout: 5_000 });
        }
        await page.waitForTimeout(2_000);
        return { ok: true, orderId };
      }
      return { ok: false, orderId, error: "未找到对应订单的取消按钮（订单可能已完成或已取消）", retryable: false };
    } catch (err) {
      const e = adapterError(err, "淘宝取消订单");
      return { ok: false, orderId, error: e.error, retryable: e.retryable };
    }
  }
}

/**
 * 天猫适配器——复用淘宝逻辑（同属阿里体系，页面结构相似）。
 * 若天猫页面结构与淘宝差异变大，再独立实现。
 */
export class TmallAdapter extends TaobaoAdapter {
  override readonly platform = "tmall";

  override searchUrl(query: string, filters?: SearchFilters): string {
    const q = encodeURIComponent(query);
    let sort = "";
    if (filters?.sort === "price_asc") sort = "&sort=s-asc";
    else if (filters?.sort === "price_desc") sort = "&sort=s-desc";
    else if (filters?.sort === "sales") sort = "&sort=d-asc";
    return `https://list.tmall.com/search_product.htm?q=${q}${sort}`;
  }

  override orderListUrl(): string {
    return "https://www.tmall.com/purchase/order_list.htm";
  }
}
