import { randomUUID } from "crypto";

import type { Page } from "playwright";

import { resolveActorId } from "../agent/actor-id.js";
import { redactCredentials } from "../security/redact.js";
import type { AuditService } from "./audit-service.js";
import type { AlipayBotService } from "./alipay-bot-service.js";
import type { BrowserSessionService } from "./browser-session-service.js";
import { BROWSER_SESSION_SITES, type BrowserSessionSiteId } from "./browser-session-sites.js";
import type { ImportedBrowserCookie } from "./browser-session-types.js";
import {
  localDateKey,
  mapPlatformStatusText,
  newShoppingOrderId,
  type ShoppingOrderStore,
  type StoredShoppingOrder,
} from "./shopping-order-store.js";
import {
  ShoppingBrowserExecutor,
  ShoppingPageUnavailableError,
  type ShoppingPageLease,
} from "./shopping-platforms/browser-executor.js";
import { detectLoginPage, getLoginWaitMs, waitForLogin } from "./shopping-platforms/login-gate.js";
import { QrAssistService } from "./qr-assist-service.js";
import { getShoppingPlatformAdapter, listSupportedPlatforms } from "./shopping-platforms/index.js";
import type {
  CheckoutSnapshot,
  OrderStatus,
  ProductSummary,
  SearchFilters,
  ShoppingPlatformAdapter,
} from "./shopping-platforms/index.js";
import { SharedBrowserCdpGateway } from "./shared-browser/cdp-gateway.js";
import { SharedBrowserCoordinator } from "./shared-browser-coordinator.js";
import type { ToolContext } from "../tools/tool-registry.js";

/** 单笔金额上限（CNY）。可用 SHOPPING_ORDER_MAX_AMOUNT_<平台大写>_CNY 按平台覆盖（演出票等高价类目调高）。 */
function getMaxAmountCny(platform?: string): number {
  if (platform) {
    const perPlatform = Number.parseInt(
      process.env[`SHOPPING_ORDER_MAX_AMOUNT_${platform.toUpperCase()}_CNY`] ?? "",
      10,
    );
    if (Number.isFinite(perPlatform) && perPlatform > 0) return perPlatform;
  }
  const v = Number.parseInt(process.env.SHOPPING_ORDER_MAX_AMOUNT_CNY ?? "5000", 10);
  return Number.isFinite(v) && v > 0 ? v : 5000;
}

/** 单日累计下单预算（CNY），阶段一校验：当日已提交金额 + 本单总价 不得超此阈值。 */
function getDailyBudgetCny(): number {
  const v = Number.parseInt(process.env.SHOPPING_ORDER_DAILY_BUDGET_CNY ?? "10000", 10);
  return Number.isFinite(v) && v > 0 ? v : 10000;
}

/** 确认 token TTL（毫秒）。 */
function getConfirmationTtlMs(): number {
  const v = Number.parseInt(process.env.SHOPPING_ORDER_CONFIRMATION_TTL_MS ?? "300000", 10);
  return Number.isFinite(v) && v > 0 ? v : 300_000;
}

/** Playwright Cookie → ImportedBrowserCookie（过滤非法 value；expires≤0 的会话 Cookie 存 undefined）。 */
function toImportedCookies(
  raw: Array<{
    name: string;
    value: string;
    domain?: string;
    path?: string;
    expires?: number;
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: string;
  }>,
): ImportedBrowserCookie[] {
  return raw
    .filter((c) => c.name && c.value && !/[;,\s"\\]/.test(c.value))
    .map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain || undefined,
      path: c.path || undefined,
      expires: typeof c.expires === "number" && c.expires > 0 ? c.expires : undefined,
      httpOnly: c.httpOnly || undefined,
      secure: c.secure || undefined,
      sameSite: c.sameSite || undefined,
    }));
}

/** 阶段一存活的 Playwright Page + 上下文，供阶段二复用。 */
interface ActiveSession {
  platform: string;
  actorId: string;
  item: string;
  quantity: number;
  snapshot: CheckoutSnapshot;
  // 持有 page 与 context 的关闭句柄
  close: () => Promise<void>;
  closed: boolean;
  expiresAt: number;
}

/** 两阶段确认的待确认记录。 */
interface PendingConfirmation {
  token: string;
  platform: string;
  actorId: string;
  item: string;
  quantity: number;
  snapshot: CheckoutSnapshot;
  session?: ActiveSession;
  expiresAt: number;
}

/** 服务返回的通用结构。 */
export type ShoppingOrderResult =
  | { ok: true; summary: string } & Record<string, unknown>
  | {
      ok: false;
      error: string;
      retryable?: boolean;
      /** 订单无收银台链接时置位，引导用户去平台 App 支付 */
      needManualPayment?: boolean;
      paymentUrl?: string;
      /** 登录等待超时/需要登录时携带二维码截图地址（供卡片渲染与 LLM 转述） */
      loginRequired?: { platform: string; imageUrl: string };
    };

/**
 * 购物/下单编排服务。
 *
 * 页面执行策略（内置浏览器优先 + 无头兜底）：
 * - 客户端在线且开启调试端口时，经 CDP 在用户可见的内置浏览器（WebView2）里
 *   新开标签页执行——登录态即用户自身，免 Cookie 导入，操作全程可见可接管；
 * - 否则回退服务端无头 Chromium + 已导入授权 Cookie；
 * - 无 Cookie 且二维码可呈现（聊天在线）时，允许匿名打开 + 扫码登录门：
 *   检测到登录页 → 截二维码推送聊天 → 等待扫码（SHOPPING_LOGIN_WAIT_MS，
 *   默认 120s）→ 自动继续原流程。
 *
 * 安全护栏：
 * - 平台白名单（getAdapter 返回 null 即拒绝）
 * - 金额上限（SHOPPING_ORDER_MAX_AMOUNT_CNY 默认 5000）
 * - 两阶段确认 token 5 分钟 TTL
 * - 审计日志（每次操作落 AuditService，含 browserMode）
 */
export class ShoppingOrderService {
  private readonly pendingConfirmations = new Map<string, PendingConfirmation>();
  /** 定期清理过期 token + 关闭存活 Page */
  private cleanupTimer: NodeJS.Timeout | null = null;
  /** 页面获取器（内置浏览器优先 + 无头兜底）；未注入时以缺省依赖构造（单测兼容） */
  private readonly browserExecutor: ShoppingBrowserExecutor;
  /** 通用二维码/图片推送（登录页截图等）；未注入时按 imageStore 构造（单测兼容） */
  private readonly qrAssist: QrAssistService;

  constructor(
    private readonly deps: {
      browserSessionService: BrowserSessionService;
      audit?: AuditService;
      /** 本地订单表（落库 + 单日预算统计）。未注入时退化为纯平台侧下单（无本地记录）。 */
      store?: ShoppingOrderStore;
      /** 支付宝钱包通道（shopping.pay.* 收银台代付）。未注入时 pay 工具返回明确错误。 */
      alipayBot?: AlipayBotService;
      /** 页面获取器。缺省用新建 coordinator/gateway（shared 不可用 → 直接走无头）。 */
      browserExecutor?: ShoppingBrowserExecutor;
      /** 图片落盘（登录/支付二维码截图）。缺省时只推 URL 不可用，依赖浏览器可见性。 */
      imageStore?: { savePng(actorId: string, png: Buffer): Promise<string> };
      /** 通用二维码推送服务。缺省时按 imageStore 构造。 */
      qrAssist?: QrAssistService;
      /**
       * 「保存登录态」征询通道（2026-10-25 用户拍板：存 Cookie 须用户同意）。
       * 未表态时经此向客户端弹征询条；缺省时跳过捕获（宁可不存）。
       */
      askSaveLoginConsent?: (actorId: string, siteId: string, siteLabel: string) => void;
    },
  ) {
    this.browserExecutor =
      deps.browserExecutor ??
      new ShoppingBrowserExecutor({
        coordinator: new SharedBrowserCoordinator(),
        gateway: new SharedBrowserCdpGateway(),
        browserSessionService: deps.browserSessionService,
      });
    this.qrAssist = deps.qrAssist ?? new QrAssistService({ imageStore: deps.imageStore });
    // 每 60 秒清理一次过期确认 + 关闭存活 Page
    this.cleanupTimer = setInterval(() => this.cleanupExpired(), 60_000);
    this.cleanupTimer.unref?.();
  }

  /** 主动销毁：关闭所有存活 Page。 */
  async dispose(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    for (const pending of this.pendingConfirmations.values()) {
      if (pending.session && !pending.session.closed) {
        await pending.session.close().catch(() => {});
      }
    }
    this.pendingConfirmations.clear();
  }

  /** 列出已实现的平台（供 handler 做参数校验）。 */
  listSupportedPlatforms(): string[] {
    return listSupportedPlatforms();
  }

  // ============ 页面租约 + 登录门（内置浏览器优先 + 无头兜底） ============

  /** 平台显示名（京东/淘宝/…），未收录时回退 platform 标识。 */
  private platformLabel(platform: string): string {
    return BROWSER_SESSION_SITES[platform as BrowserSessionSiteId]?.label ?? platform;
  }

  /**
   * 统一页面执行壳：获取租约（shared 优先/无头兜底）→ 稳定等待 → 登录门 → run → 释放。
   * Cookie 软获取：有则注入（headless 免扫码），未导入/未授权不再硬拒（内置浏览器路径不需要）。
   */
  private async withShoppingPage(
    ctx: ToolContext,
    platform: string,
    targetUrl: string,
    run: (page: Page, mode: "shared" | "headless") => Promise<ShoppingOrderResult>,
    opts: {
      interactiveLogin?: boolean;
      /** 跳过内置浏览器路径（多平台比价的非首位平台，防排队拖死工具预算）。 */
      preferHeadless?: boolean;
      /** 页面获取不可用时的自定义兜底（如 track 回退本地订单记录）。 */
      onUnavailable?: (err: ShoppingPageUnavailableError) => ShoppingOrderResult;
    } = {},
  ): Promise<ShoppingOrderResult> {
    const actorId = resolveActorId(ctx);
    let cookies: ImportedBrowserCookie[] = [];
    const cookieResult = await this.getCookieAndSiteId(actorId, platform);
    if (cookieResult.ok) cookies = cookieResult.cookies;

    const interactiveLogin = opts.interactiveLogin ?? ctx.pushMediaCards != null;
    let lease: ShoppingPageLease;
    try {
      lease = await this.browserExecutor.acquirePage(actorId, platform, targetUrl, {
        cookies,
        interactiveLogin,
        disableSharedBrowser: opts.preferHeadless === true,
      });
    } catch (err) {
      if (err instanceof ShoppingPageUnavailableError) {
        return opts.onUnavailable
          ? opts.onUnavailable(err)
          : { ok: false, error: err.message, retryable: false };
      }
      throw err;
    }

    try {
      // 落页稳定后再过登录门（SPA/跳转需要时间）
      await lease.page.waitForTimeout(2_500).catch(() => {});
      const gate = await this.ensureLoggedIn(ctx, lease, platform, targetUrl);
      if (gate) return gate;
      const result = await run(lease.page, lease.mode);
      // 登录态捕获（一次登录一直使用）：shared=用户本人在内置浏览器的登录态（视为授权）；
      // headless=运行期平台刷新的 Cookie 回写更新（授权只升不降，不删除）。
      await this.persistLoginCookies(
        ctx,
        lease.page,
        platform,
        targetUrl,
        lease.mode === "shared" ? "shared_login" : "headless_refresh",
        lease.mode === "shared" ? { agentAllowed: true } : {},
      );
      return result;
    } finally {
      await lease.release();
    }
  }

  /**
   * 登录门：命中登录页 → 截二维码落盘 → 经 ctx.pushMediaCards 推聊天卡片
   * （shared 模式浏览器本身也可见）→ 等待扫码后自动继续。
   * 无需登录返回 null；等待超时返回结构化失败（含 loginRequired.imageUrl）。
   */
  private async ensureLoggedIn(
    ctx: ToolContext,
    lease: ShoppingPageLease,
    platform: string,
    targetUrl: string,
  ): Promise<ShoppingOrderResult | null> {
    // 两次检测：部分平台（如京东）登录跳转由 JS 延迟触发，落页稳定后再补检一次
    let det = await detectLoginPage(platform, lease.page);
    if (!det.isLogin) {
      await lease.page.waitForTimeout(1_500).catch(() => {});
      det = await detectLoginPage(platform, lease.page);
    }
    if (!det.isLogin) return null;

    const label = this.platformLabel(platform);
    // 通用二维码推送：登录页截图 → 落盘 → 聊天卡片（best-effort）
    const imageUrl = await this.qrAssist.pushPageCard(
      ctx,
      {
        title: `请扫码登录${label}`,
        caption: `扫码后自动继续，最长等待 ${Math.round(getLoginWaitMs() / 1000)} 秒`,
      },
      lease.page,
    );

    await this.audit(ctx, "login_gate", platform, {
      mode: lease.mode,
      reason: det.reason,
      imageUrl,
      pushed: Boolean(imageUrl),
    });

    const wait = await waitForLogin(platform, lease.page, targetUrl);
    if (!wait.ok) {
      return {
        ok: false,
        error:
          `${wait.error}。请扫码登录${label}后重试` +
          (lease.mode === "headless" && !imageUrl ? "（二维码无法呈现：客户端不在线且图片服务未装配）" : ""),
        retryable: true,
        ...(imageUrl ? { loginRequired: { platform, imageUrl } } : {}),
      };
    }

    // 扫码登录成功：立即捕获登录态（一次登录一直使用——之后无头兜底免重复扫码）
    await this.persistLoginCookies(ctx, lease.page, platform, targetUrl, "scan_login", {
      agentAllowed: true,
    });
    return null;
  }

  /**
   * 登录态捕获（「一次登录一直使用」）：把当前页面上下文中该平台域的 Cookie
   * 加密落库。按 targetUrl 限定范围——shared 模式经 CDP 连的是用户真实浏览器
   * profile，不限定范围会抓到所有站点的 Cookie。授权语义见
   * BrowserSessionService.updateCookiesFromLogin（只升不降）。失败静默：
   * 捕获是增强不是依赖，不影响主流程。
   */
  private async persistLoginCookies(
    ctx: ToolContext,
    page: Page,
    platform: string,
    targetUrl: string,
    source: "scan_login" | "shared_login" | "headless_refresh",
    opts: { agentAllowed?: boolean } = {},
  ): Promise<void> {
    // 保存须用户同意（与主流做法一致）：deny=不存；未表态=弹征询条 + 本轮不存
    //（同意后下一轮起静默保存）。捕获失败/被拒都不影响主流程。
    const consentActor = resolveActorId(ctx);
    const consent = await this.deps.browserSessionService.getCaptureConsent(consentActor, platform);
    if (consent === "deny") return;
    if (consent === "ask") {
      this.deps.askSaveLoginConsent?.(consentActor, platform, this.platformLabel(platform));
      return;
    }
    try {
      const raw = await page.context().cookies(targetUrl);
      const mapped = toImportedCookies(raw);
      if (mapped.length === 0) return;
      await this.deps.browserSessionService.updateCookiesFromLogin(
        resolveActorId(ctx),
        platform,
        mapped,
        opts,
      );
      await this.audit(ctx, "cookies_persisted", platform, { source, count: mapped.length });
    } catch {
      /* 捕获失败不影响主流程（下次成功执行会再捕获） */
    }
  }

  async searchProduct(
    ctx: ToolContext,
    platform: string,
    query: string,
    filters?: SearchFilters,
    innerOpts?: { preferHeadless?: boolean },
  ): Promise<ShoppingOrderResult> {
    const adapter = this.requireAdapter(platform);
    if (!adapter) {
      return { ok: false, error: `平台「${platform}」暂不支持。已实现：${listSupportedPlatforms().join("/")}` };
    }
    const limit = Math.min(Math.max(filters?.limit ?? 5, 1), 10);

    return this.withShoppingPage(ctx, platform, adapter.searchUrl(query, filters), async (page, mode) => {
      try {
        const products = await adapter.extractProducts(page, limit);

        // 二次过滤：maxPrice
        const filtered = filters?.maxPrice
          ? products.filter((p) => p.price == null || p.price <= (filters.maxPrice as number))
          : products;

        await this.audit(ctx, "search", platform, {
          query,
          limit,
          resultCount: filtered.length,
          browserMode: mode,
        });

        if (filtered.length === 0) {
          return {
            ok: true,
            summary: `在${platform}搜索「${query}」未找到商品（可能登录态失效或页面结构变更）`,
            products: [],
            platform,
            query,
            hint: "若无结果，请在客户端内置浏览器登录该平台后重试，或确认 Cookie 未过期且已授权 agentAllowed=true",
          };
        }

        return {
          ok: true,
          summary: `在${platform}搜索「${query}」找到 ${filtered.length} 个商品`,
          products: filtered,
          platform,
          query,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          ok: false,
          error: redactCredentials(`搜索失败：${message}${message.includes("Executable doesn't exist") ? "（请在 server 目录执行: npx playwright install chromium）" : ""}`),
          retryable: /timeout|navigation/i.test(message),
        };
      }
    }, { preferHeadless: innerOpts?.preferHeadless === true });
  }

  async placeOrder(
    ctx: ToolContext,
    platform: string,
    item: string,
    quantity: number,
    confirm: boolean,
    confirmationToken?: string,
  ): Promise<ShoppingOrderResult> {
    const actorId = resolveActorId(ctx);

    // 阶段二：confirm=true + token
    if (confirm) {
      return this.executePlaceStage2(ctx, platform, confirmationToken);
    }

    // 阶段一：confirm=false
    return this.executePlaceStage1(ctx, platform, item, quantity);
  }

  private async executePlaceStage1(
    ctx: ToolContext,
    platform: string,
    item: string,
    quantity: number,
  ): Promise<ShoppingOrderResult> {
    const actorId = resolveActorId(ctx);
    const adapter = this.requireAdapter(platform);
    if (!adapter) {
      return { ok: false, error: `平台「${platform}」暂不支持。已实现：${listSupportedPlatforms().join("/")}` };
    }
    const qty = Math.min(Math.max(quantity, 1), 99);

    // item 可以是商品 URL 或关键词描述。
    // 若是 URL，直接作为 product.url；否则需要先搜索拿到 product。
    let product: ProductSummary;
    if (/^https?:\/\//i.test(item)) {
      product = { title: "用户指定商品", url: item };
    } else {
      // 先搜索找到第一个匹配商品
      const searchResult = await this.searchProduct(ctx, platform, item, { limit: 1 });
      if (!searchResult.ok) return searchResult;
      const products = (searchResult as { products?: ProductSummary[] }).products ?? [];
      if (products.length === 0) {
        return {
          ok: false,
          error: `在${platform}未找到「${item}」相关商品，无法下单`,
          retryable: true,
        };
      }
      product = products[0];
    }

    let cookies: ImportedBrowserCookie[] = [];
    const cookieResult = await this.getCookieAndSiteId(actorId, platform);
    if (cookieResult.ok) cookies = cookieResult.cookies;

    const firstUrl = product.url ?? adapter.searchUrl(item);
    let lease: ShoppingPageLease;
    try {
      lease = await this.browserExecutor.acquirePage(actorId, platform, firstUrl, {
        cookies,
        interactiveLogin: ctx.pushMediaCards != null,
      });
    } catch (err) {
      if (err instanceof ShoppingPageUnavailableError) {
        return { ok: false, error: err.message, retryable: false };
      }
      throw err;
    }

    // 阶段一成功时租约转交 ActiveSession（阶段二/过期时释放）；其余路径 finally 释放
    let keepAlive = false;
    try {
      await lease.page.waitForTimeout(2_500).catch(() => {});
      const gate = await this.ensureLoggedIn(ctx, lease, platform, firstUrl);
      if (gate) return gate;

      const snapshot = await adapter.navigateToCheckout(lease.page, product, qty);
      if (!snapshot.ok) {
        return { ok: false, error: snapshot.error ?? "走到结算页失败", retryable: snapshot.retryable };
      }

      // 单笔金额上限校验（平台覆盖优先，演出票等高价类目用 SHOPPING_ORDER_MAX_AMOUNT_<平台>_CNY 调高）
      if (snapshot.totalPrice != null && snapshot.totalPrice > getMaxAmountCny(platform)) {
        await this.audit(ctx, "place_blocked_amount", platform, {
          item, quantity: qty, totalPrice: snapshot.totalPrice, limit: getMaxAmountCny(platform),
        });
        return {
          ok: false,
          error: `订单总价 ¥${snapshot.totalPrice} 超过上限 ¥${getMaxAmountCny(platform)}，已拒绝提交。可调整 SHOPPING_ORDER_MAX_AMOUNT_CNY 或 SHOPPING_ORDER_MAX_AMOUNT_${platform.toUpperCase()}_CNY 环境变量。`,
          retryable: false,
        };
      }

      // 单日预算校验（当日已提交金额 + 本单总价）
      if (this.deps.store && snapshot.totalPrice != null) {
        const dateKey = localDateKey(new Date());
        const used = await this.deps.store.sumAmountOnDate(actorId, dateKey);
        if (used + snapshot.totalPrice > getDailyBudgetCny()) {
          await this.audit(ctx, "place_blocked_daily_budget", platform, {
            item, quantity: qty, totalPrice: snapshot.totalPrice, usedToday: used, dailyBudget: getDailyBudgetCny(),
          });
          return {
            ok: false,
            error: `今日已下单 ¥${used}，加上本单 ¥${snapshot.totalPrice} 将超过单日预算 ¥${getDailyBudgetCny()}，已拒绝提交。可调整 SHOPPING_ORDER_DAILY_BUDGET_CNY 环境变量。`,
            retryable: false,
          };
        }
      }

      // 生成确认 token，保留存活 Page（租约由 session.close 在阶段二/过期时释放）
      const token = randomUUID();
      const session: ActiveSession = {
        platform,
        actorId,
        item,
        quantity: qty,
        snapshot,
        closed: false,
        expiresAt: Date.now() + getConfirmationTtlMs(),
        close: async () => {
          if (session.closed) return;
          session.closed = true;
          await lease.release().catch(() => {});
        },
      };
      const pending: PendingConfirmation = {
        token,
        platform,
        actorId,
        item,
        quantity: qty,
        snapshot,
        session,
        expiresAt: session.expiresAt,
      };
      this.pendingConfirmations.set(token, pending);

      await this.audit(ctx, "place_stage1", platform, {
        item, quantity: qty, totalPrice: snapshot.totalPrice, token, browserMode: lease.mode,
      });

      const summaryParts: string[] = [
        `即将在${platform}下单`,
        snapshot.itemTitle ? `商品：${snapshot.itemTitle}` : "",
        `数量：${snapshot.quantity ?? qty}`,
        snapshot.totalPrice != null ? `总价：¥${snapshot.totalPrice}` : "",
        snapshot.addressSummary ? `收货：${snapshot.addressSummary}` : "",
      ].filter(Boolean);

      // 登录态捕获（一次登录一直使用）：与本页执行的其他路径同语义
      await this.persistLoginCookies(
        ctx,
        lease.page,
        platform,
        firstUrl,
        lease.mode === "shared" ? "shared_login" : "headless_refresh",
        lease.mode === "shared" ? { agentAllowed: true } : {},
      );

      keepAlive = true;
      return {
        ok: true,
        summary: summaryParts.join("，"),
        needsConfirmation: true,
        confirmationToken: token,
        platform,
        itemTitle: snapshot.itemTitle,
        unitPrice: snapshot.unitPrice,
        quantity: snapshot.quantity,
        totalPrice: snapshot.totalPrice,
        currency: snapshot.currency,
        addressSummary: snapshot.addressSummary,
        screenshotBase64: snapshot.screenshotBase64,
        checkoutUrl: snapshot.checkoutUrl,
        expiresInMs: getConfirmationTtlMs(),
        hint: "请向用户复述上述摘要，得到明确同意后，带 confirm=true + confirmationToken 再调用本工具完成提交",
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: redactCredentials(`走到结算页失败：${message}`), retryable: /timeout|navigation/i.test(message) };
    } finally {
      if (!keepAlive) await lease.release().catch(() => {});
    }
  }

  private async executePlaceStage2(
    ctx: ToolContext,
    platform: string,
    confirmationToken?: string,
  ): Promise<ShoppingOrderResult> {
    if (!confirmationToken) {
      return { ok: false, error: "阶段二缺少 confirmationToken" };
    }
    const pending = this.pendingConfirmations.get(confirmationToken);
    if (!pending) {
      return { ok: false, error: "确认 token 无效或已过期，请重新发起下单（confirm=false）", retryable: true };
    }
    if (Date.now() > pending.expiresAt) {
      this.pendingConfirmations.delete(confirmationToken);
      if (pending.session && !pending.session.closed) {
        await pending.session.close().catch(() => {});
      }
      return { ok: false, error: "确认已过期，请重新发起下单（confirm=false）", retryable: true };
    }
    if (pending.platform !== platform) {
      return { ok: false, error: `平台不匹配：token 属于 ${pending.platform}，但请求平台为 ${platform}` };
    }

    const adapter = this.requireAdapter(platform);
    if (!adapter) {
      return { ok: false, error: `平台「${platform}」暂不支持` };
    }

    try {
      // 优先复用阶段一存活 Page
      let submitResult;
      if (pending.session && !pending.session.closed) {
        // 阶段一保留的 context 已关闭，但 Page 还在？实际上 context.close 会关闭 page。
        // 这里改为：阶段二重新获取页面，重新走到结算页，再提交。
        // （保持简单：不复用 Page，因为 context/page 生命周期管理复杂，重建更稳）
        await pending.session.close().catch(() => {});
      }

      let cookies: ImportedBrowserCookie[] = [];
      const cookieResult = await this.getCookieAndSiteId(pending.actorId, platform);
      if (cookieResult.ok) cookies = cookieResult.cookies;

      const product: ProductSummary = {
        title: pending.snapshot.itemTitle ?? pending.item,
        url: pending.snapshot.checkoutUrl,
      };
      const firstUrl = product.url ?? adapter.searchUrl(pending.item);
      let lease: ShoppingPageLease;
      try {
        lease = await this.browserExecutor.acquirePage(pending.actorId, platform, firstUrl, {
          cookies,
          interactiveLogin: ctx.pushMediaCards != null,
        });
      } catch (err) {
        if (err instanceof ShoppingPageUnavailableError) {
          this.pendingConfirmations.delete(confirmationToken!);
          return { ok: false, error: err.message, retryable: false };
        }
        throw err;
      }

      try {
        await lease.page.waitForTimeout(2_500).catch(() => {});
        const gate = await this.ensureLoggedIn(ctx, lease, platform, firstUrl);
        if (gate) {
          this.pendingConfirmations.delete(confirmationToken!);
          return gate;
        }

        // 若 checkoutUrl 存在且仍有效，直接 goto 结算页；否则重新走 navigateToCheckout
        if (pending.snapshot.checkoutUrl && /^https:\/\//i.test(pending.snapshot.checkoutUrl)) {
          if (lease.page.url() !== pending.snapshot.checkoutUrl) {
            await lease.page
              .goto(pending.snapshot.checkoutUrl, { waitUntil: "domcontentloaded", timeout: 15_000 })
              .catch(() => {});
            await lease.page.waitForTimeout(2_000).catch(() => {});
          }
        } else {
          const reSnap = await adapter.navigateToCheckout(lease.page, product, pending.quantity);
          if (!reSnap.ok) {
            this.pendingConfirmations.delete(confirmationToken!);
            return { ok: false, error: reSnap.error ?? "重新走到结算页失败", retryable: reSnap.retryable };
          }
        }

        submitResult = await adapter.submitOrder(lease.page);

        // 登录态捕获（一次登录一直使用）：提交后平台的最新 Cookie 回写更新
        await this.persistLoginCookies(
          ctx,
          lease.page,
          platform,
          firstUrl,
          lease.mode === "shared" ? "shared_login" : "headless_refresh",
          lease.mode === "shared" ? { agentAllowed: true } : {},
        );
      } finally {
        await lease.release().catch(() => {});
      }

      this.pendingConfirmations.delete(confirmationToken);

      await this.audit(ctx, "place_stage2", platform, {
        item: pending.item,
        quantity: pending.quantity,
        totalPrice: pending.snapshot.totalPrice,
        orderId: submitResult.orderId,
        ok: submitResult.ok,
      });

      if (!submitResult.ok) {
        return { ok: false, error: submitResult.error ?? "提交订单失败", retryable: submitResult.retryable };
      }

      // 落库（本地订单表是查历史/对账/单日预算的依据；平台未回吐单号时也记录）
      let localOrderId: string | undefined;
      if (this.deps.store) {
        const now = new Date();
        const stored = await this.deps.store.create({
          orderId: newShoppingOrderId(now),
          actorId: pending.actorId,
          platform,
          platformOrderId: submitResult.orderId ?? null,
          title: pending.snapshot.itemTitle ?? pending.item,
          quantity: pending.snapshot.quantity ?? pending.quantity,
          amountCny: pending.snapshot.totalPrice ?? null,
          currency: pending.snapshot.currency,
          status: "pending_payment",
          addressSummary: pending.snapshot.addressSummary ?? null,
          paymentUrl: submitResult.paymentUrl ?? null,
          checkoutUrl: pending.snapshot.checkoutUrl ?? null,
          note: submitResult.error ?? null,
          dateKey: localDateKey(now),
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        });
        localOrderId = stored.orderId;
      }

      await this.audit(ctx, "place_persisted", platform, {
        localOrderId, orderId: submitResult.orderId, totalPrice: pending.snapshot.totalPrice,
      });

      return {
        ok: true,
        summary: `已在${platform}提交订单${submitResult.orderId ? `（订单号 ${submitResult.orderId}）` : ""}${submitResult.error ? `；${submitResult.error}` : ""}。订单待支付`,
        platform,
        orderId: submitResult.orderId,
        localOrderId,
        itemTitle: pending.snapshot.itemTitle,
        totalPrice: pending.snapshot.totalPrice,
        currency: pending.snapshot.currency,
        paymentUrl: submitResult.paymentUrl,
        note: submitResult.error ?? "订单已提交、未支付。可用 shopping.pay.check 查询支付状态；若拿到支付宝收银台链接可用 shopping.pay.submit 代付，否则请在平台 App 内完成支付。",
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: redactCredentials(`提交订单失败：${message}`), retryable: /timeout|navigation/i.test(message) };
    }
  }

  async trackOrder(
    ctx: ToolContext,
    platform: string,
    orderId?: string,
  ): Promise<ShoppingOrderResult> {
    const actorId = resolveActorId(ctx);
    const adapter = this.requireAdapter(platform);
    if (!adapter) {
      return { ok: false, error: `平台「${platform}」暂不支持。已实现：${listSupportedPlatforms().join("/")}` };
    }

    // 本地订单解析：orderId 支持本地 so_* 单号或平台单号
    let localOrder: StoredShoppingOrder | null = null;
    let platformOrderId = orderId;
    if (this.deps.store && orderId) {
      if (orderId.startsWith("so_")) {
        const found = await this.deps.store.get(orderId);
        if (!found || found.actorId !== actorId) {
          return { ok: false, error: `本地订单 ${orderId} 不存在` };
        }
        if (found.platform !== platform) {
          return { ok: false, error: `订单 ${orderId} 属于平台 ${found.platform}，与请求平台 ${platform} 不符` };
        }
        localOrder = found;
        platformOrderId = found.platformOrderId ?? undefined;
      } else {
        localOrder = await this.deps.store.findByPlatformOrder(actorId, platform, orderId);
      }
    }

    return this.withShoppingPage(
      ctx,
      platform,
      adapter.orderListUrl(),
      async (page, mode) => {
        try {
          await page.waitForTimeout(500).catch(() => {});

          const orders: OrderStatus[] = await adapter.readOrderStatus(page, platformOrderId);

          await this.audit(ctx, "track", platform, { orderId, resultCount: orders.length, browserMode: mode });

          if (orders.length === 0) {
            // 平台侧没查到：本地有记录则兜底
            if (localOrder) {
              return this.localOrderResult(platform, localOrder, "平台订单页未查到该订单（可能状态页改版或订单已归档），以下为本地记录");
            }
            return {
              ok: true,
              summary: orderId ? `未在${platform}找到订单 ${orderId}` : `在${platform}未找到订单`,
              orders: [],
              platform,
            };
          }

          // 状态回写本地（能识别的状态词才更新，避免覆盖为 null）
          if (localOrder && this.deps.store) {
            for (const o of orders) {
              if (o.orderId && o.orderId === localOrder.platformOrderId) {
                const mapped = mapPlatformStatusText(o.status ?? o.statusDesc);
                if (mapped) await this.deps.store.update(localOrder.orderId, { status: mapped });
                break;
              }
            }
          }

          // 关联本地单号到返回项
          const enriched = orders.map((o) => ({
            ...o,
            localOrderId:
              localOrder && o.orderId && o.orderId === localOrder.platformOrderId ? localOrder.orderId : undefined,
          }));

          return {
            ok: true,
            summary: `查询到 ${orders.length} 个${platform}订单`,
            orders: enriched,
            platform,
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (localOrder) {
            return this.localOrderResult(platform, localOrder, `平台查询失败（${message}），以下为本地记录`);
          }
          return { ok: false, error: `查询订单失败：${message}`, retryable: /timeout|navigation/i.test(message) };
        }
      },
      {
        onUnavailable: (err) => {
          // 页面获取不可用（无 Cookie 且内置浏览器不在线）：有本地记录时兜底返回本地快照
          if (localOrder) {
            return this.localOrderResult(platform, localOrder, "平台 Cookie 未导入/未授权且内置浏览器不在线，以下为本地记录（非实时）");
          }
          return { ok: false, error: err.message, retryable: false };
        },
      },
    );
  }

  /** 本地订单快照兜底返回（平台侧不可用时）。 */
  private localOrderResult(platform: string, order: StoredShoppingOrder, note: string): ShoppingOrderResult {
    return {
      ok: true,
      summary: `${note}：${order.title}（${order.status}${order.amountCny != null ? `/¥${order.amountCny}` : ""}）`,
      orders: [
        {
          orderId: order.platformOrderId ?? order.orderId,
          status: order.status,
          statusDesc: order.status,
          itemTitle: order.title,
          totalPrice: order.amountCny ?? undefined,
          createdAt: order.createdAt,
          logisticsSummary: order.note ?? undefined,
        } satisfies OrderStatus,
      ],
      platform,
      localOrderId: order.orderId,
      paymentUrl: order.paymentUrl,
      note,
    };
  }

  /** 列出本地订单（shopping.order.list 工具；纯本地读，零副作用）。 */
  async listOrders(
    ctx: ToolContext,
    opts: { platform?: string; includeFinished?: boolean; limit?: number } = {},
  ): Promise<ShoppingOrderResult> {
    const actorId = resolveActorId(ctx);
    if (!this.deps.store) {
      return { ok: false, error: "本地订单表未启用（未注入 ShoppingOrderStore）" };
    }
    const orders = await this.deps.store.listByActor(actorId, {
      platform: opts.platform,
      includeFinished: opts.includeFinished ?? true,
      limit: Math.min(Math.max(opts.limit ?? 10, 1), 50),
    });
    if (orders.length === 0) return { ok: true, summary: "暂无本地订单记录", orders: [], count: 0 };
    return {
      ok: true,
      summary: `共 ${orders.length} 条本地订单`,
      count: orders.length,
      orders: orders.map((o) => ({
        localOrderId: o.orderId,
        platform: o.platform,
        orderId: o.platformOrderId,
        title: o.title,
        quantity: o.quantity,
        amountCny: o.amountCny,
        status: o.status,
        paymentUrl: o.paymentUrl,
        createdAt: o.createdAt,
      })),
    };
  }

  async cancelOrder(
    ctx: ToolContext,
    platform: string,
    orderId: string,
    confirm: boolean,
    confirmationToken?: string,
  ): Promise<ShoppingOrderResult> {
    const actorId = resolveActorId(ctx);

    // 阶段二
    if (confirm) {
      const pending = confirmationToken ? this.pendingConfirmations.get(confirmationToken) : null;
      if (!pending) {
        return { ok: false, error: "取消确认 token 无效或已过期，请重新发起取消（confirm=false）", retryable: true };
      }
      if (Date.now() > pending.expiresAt) {
        this.pendingConfirmations.delete(confirmationToken!);
        if (pending.session && !pending.session.closed) await pending.session.close().catch(() => {});
        return { ok: false, error: "确认已过期，请重新发起取消", retryable: true };
      }
      // 取消不需要保留 Page，直接执行
      this.pendingConfirmations.delete(confirmationToken!);
      return this.executeCancel(ctx, platform, orderId);
    }

    // 阶段一：生成 token 返回确认摘要
    const token = randomUUID();
    this.pendingConfirmations.set(token, {
      token,
      platform,
      actorId,
      item: orderId,
      quantity: 1,
      snapshot: { ok: true, itemTitle: orderId },
      expiresAt: Date.now() + getConfirmationTtlMs(),
    });

    await this.audit(ctx, "cancel_stage1", platform, { orderId, token });

    return {
      ok: true,
      summary: `即将在${platform}取消订单 ${orderId}`,
      needsConfirmation: true,
      confirmationToken: token,
      platform,
      orderId,
      expiresInMs: getConfirmationTtlMs(),
      hint: "请向用户确认后，带 confirm=true + confirmationToken 再调用本工具完成取消",
    };
  }

  private async executeCancel(
    ctx: ToolContext,
    platform: string,
    orderId: string,
  ): Promise<ShoppingOrderResult> {
    const adapter = this.requireAdapter(platform);
    if (!adapter) return { ok: false, error: `平台「${platform}」暂不支持` };

    return this.withShoppingPage(ctx, platform, adapter.orderListUrl(), async (page, mode) => {
      try {
        await page.waitForTimeout(500).catch(() => {});

        const result = await adapter.cancelOrder(page, orderId);

        await this.audit(ctx, "cancel_stage2", platform, {
          orderId, ok: result.ok, error: result.error, browserMode: mode,
        });

        // 平台取消成功 → 同步本地订单状态（按本地单号或平台单号匹配）
        if (result.ok && this.deps.store) {
          const actorId2 = resolveActorId(ctx);
          const local = orderId.startsWith("so_")
            ? await this.deps.store.get(orderId)
            : await this.deps.store.findByPlatformOrder(actorId2, platform, orderId);
          if (local && local.actorId === actorId2) {
            await this.deps.store.update(local.orderId, { status: "cancelled" });
          }
        }

        if (!result.ok) {
          return { ok: false, error: result.error ?? "取消订单失败", retryable: result.retryable };
        }
        return {
          ok: true,
          summary: `已在${platform}取消订单 ${orderId}`,
          platform,
          orderId,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, error: `取消订单失败：${message}`, retryable: /timeout|navigation/i.test(message) };
      }
    });
  }

  // ============ 支付（shopping.pay.*） ============

  /** 支付宝收银台链接判定（alipay-bot 收银台通道只接受 alipay.com 域的收银台链接）。 */
  private isAlipayCashierUrl(url: string): boolean {
    return /^https:\/\//i.test(url) && /(cashier|qr)\.alipay\.com/i.test(url);
  }

  /**
   * 发起收银台代付（shopping.pay.submit）。
   *
   * 只支持「下单时捕获到支付宝收银台链接」的本地订单：经用户本人支付宝钱包
   * （alipay-bot）拉起收银台，实际扣款由用户在支付宝 App 内确认。
   * 无收银台链接（绝大多数平台订单）→ 明确引导用户去平台 App 支付。
   */
  async payOrder(ctx: ToolContext, orderId: string): Promise<ShoppingOrderResult> {
    const actorId = resolveActorId(ctx);
    if (!this.deps.store) return { ok: false, error: "本地订单表未启用，无法按本地单号支付" };
    const order = orderId.startsWith("so_")
      ? await this.deps.store.get(orderId)
      : null;
    if (!order || order.actorId !== actorId) {
      return { ok: false, error: `本地订单 ${orderId} 不存在（支付只支持本地单号 so_*，可先用 shopping.order.list 查询）` };
    }
    if (order.status === "paid" || order.status === "shipped" || order.status === "completed") {
      return { ok: true, summary: `订单 ${order.orderId} 已是 ${order.status} 状态，无需重复支付`, orderId: order.orderId, status: order.status };
    }
    if (order.status === "cancelled" || order.status === "failed") {
      return { ok: false, error: `订单 ${order.orderId} 已 ${order.status}，无法支付` };
    }
    if (!order.paymentUrl) {
      return {
        ok: false,
        error:
          `订单 ${order.orderId} 没有捕获到支付宝收银台链接。` +
          `请在 ${order.platform} App 内完成支付（订单号 ${order.platformOrderId ?? "见平台订单页"}），完成后可用 shopping.pay.check 同步状态`,
        needManualPayment: true,
      };
    }
    if (!this.isAlipayCashierUrl(order.paymentUrl)) {
      return {
        ok: false,
        error:
          "订单的支付链接不是支付宝收银台（该平台使用自有收银台），agent 无法代付。" +
          "请在平台 App 内完成支付，完成后可用 shopping.pay.check 同步状态",
        paymentUrl: order.paymentUrl,
        needManualPayment: true,
      };
    }

    // 内置浏览器在线 → 直接在用户可见浏览器打开收银台（收银台二维码页面本身可见；
    // 聊天侧由 shopping.pay.submit 的确定性附卡出「支付确认」按钮卡，不走图片卡）
    const sharedLease = await this.browserExecutor.tryOpenSharedPage(actorId, order.paymentUrl).catch(() => null);
    if (sharedLease) {
      try {
        await sharedLease.page.waitForTimeout(3_000).catch(() => {});
      } finally {
        await sharedLease.release().catch(() => {});
      }

      await this.audit(ctx, "pay_shared_cashier", order.platform, {
        localOrderId: order.orderId,
        platformOrderId: order.platformOrderId,
        browserMode: "shared",
      });

      return {
        ok: true,
        summary:
          `已在内置浏览器打开「${order.title}」的支付宝收银台，请在浏览器内或支付宝 App 完成支付`,
        orderId: order.orderId,
        platform: order.platform,
        amountCny: order.amountCny,
        paymentUrl: order.paymentUrl,
        browserMode: "shared",
        hint: "支付完成后用 shopping.pay.check 确认状态并同步订单",
      };
    }

    if (!this.deps.alipayBot) {
      return { ok: false, error: "内置浏览器不在线且支付宝钱包服务未装配（alipayBot 未注入），请在平台 App 内完成支付" };
    }

    try {
      const sessionId = randomUUID();
      const intentSummary =
        `服务内容：支付${order.platform}订单「${order.title}」，` +
        `支付金额：${order.amountCny != null ? `¥${order.amountCny}` : "以收银台为准"}，支付对象：${order.platform}平台商户`;
      const res = await this.deps.alipayBot.submitPayment(sessionId, order.paymentUrl, intentSummary);
      await this.audit(ctx, "pay_submit", order.platform, {
        localOrderId: order.orderId, platformOrderId: order.platformOrderId, ok: res.ok, error: res.error,
      });
      if (!res.ok) {
        return {
          ok: false,
          error: `支付宝代付发起失败：${res.error ?? res.stderr?.slice(0, 200) ?? "未知错误"}（请确认已开通并绑定本人支付宝钱包，或在平台 App 内手动支付）`,
        };
      }
      // 通用二维码推送：CLI 产出的收银台二维码实时推到聊天流（headless 场景
      // 用户看不到浏览器页面，聊天里的二维码是唯一支付入口；best-effort）
      let qrImageUrl: string | undefined;
      if (Array.isArray(res.media) && res.media.length > 0) {
        qrImageUrl =
          (await this.qrAssist
            .pushQrImage(
              ctx,
              {
                title: `请扫码支付（${order.platform}订单）`,
                caption: `¥${order.amountCny ?? "以收银台为准"} · ${order.title}`,
              },
              { filePath: String(res.media[0]) },
            )
            .catch(() => null)) ?? undefined;
      }
      return {
        ok: true,
        summary:
          `已为你拉起「${order.title}」的支付宝收银台（¥${order.amountCny ?? "以收银台为准"}），请在支付宝 App 内确认支付` +
          `${qrImageUrl ? "，二维码已推送到聊天" : ""}`,
        orderId: order.orderId,
        platform: order.platform,
        amountCny: order.amountCny,
        ...(qrImageUrl ? { qrImageUrl } : {}),
        stdout: res.stdout.slice(0, 800),
        hint: "支付完成后用 shopping.pay.check 确认状态并同步订单",
      };
    } catch (err) {
      return { ok: false, error: `支付宝代付失败：${err instanceof Error ? err.message : String(err)}` };
    }
  }

  /**
   * 查询订单支付状态（shopping.pay.check）。
   * 支持本地单号 so_* 或平台单号；有支付宝收银台链接时先查钱包支付状态，
   * 有平台单号时再经浏览器刷新平台侧状态，最后回写本地订单表。
   */
  async checkPayment(ctx: ToolContext, orderId: string): Promise<ShoppingOrderResult> {
    const actorId = resolveActorId(ctx);
    if (!this.deps.store) return { ok: false, error: "本地订单表未启用" };
    let order: StoredShoppingOrder | null = orderId.startsWith("so_")
      ? await this.deps.store.get(orderId)
      : null;
    if (!order) {
      // 平台单号：遍历该 actor 全部订单匹配
      const all = await this.deps.store.listByActor(actorId, { limit: 100 });
      order = all.find((o) => o.platformOrderId === orderId.trim()) ?? null;
    }
    if (!order || order.actorId !== actorId) {
      return { ok: false, error: `本地订单 ${orderId} 不存在（可用 shopping.order.list 查询本地订单）` };
    }

    // 1) 支付宝收银台支付状态
    let alipayPaid: boolean | null = null;
    let alipayDetail: string | undefined;
    if (order.paymentUrl && this.isAlipayCashierUrl(order.paymentUrl) && this.deps.alipayBot) {
      try {
        const res = await this.deps.alipayBot.queryPaymentStatus({ launchUrl: order.paymentUrl });
        const text = `${res.stdout} ${res.json ? JSON.stringify(res.json) : ""}`;
        if (/已支付|支付成功|TRADE_SUCCESS|paid/i.test(text)) alipayPaid = true;
        else if (/未支付|等待|PENDING|WAIT/i.test(text)) alipayPaid = false;
        alipayDetail = res.stdout.slice(0, 300);
      } catch (err) {
        alipayDetail = `钱包查询失败：${err instanceof Error ? err.message : String(err)}`;
      }
    }

    // 2) 平台侧实时状态（浏览器刷新；失败不阻塞）
    let platformRefreshed: OrderStatus[] | undefined;
    if (order.platformOrderId) {
      const trackRes = await this.trackOrder(ctx, order.platform, order.platformOrderId);
      if (trackRes.ok) {
        platformRefreshed = (trackRes as { orders?: OrderStatus[] }).orders;
      }
    }

    // 3) 状态判定 + 回写
    let finalStatus: StoredShoppingOrder["status"] = order.status;
    if (alipayPaid === true) finalStatus = "paid";
    else if (platformRefreshed && platformRefreshed.length > 0) {
      const matched = platformRefreshed.find((o) => o.orderId === order!.platformOrderId) ?? platformRefreshed[0];
      const mapped = mapPlatformStatusText(matched?.status ?? matched?.statusDesc);
      if (mapped) finalStatus = mapped;
    }
    if (finalStatus !== order.status) {
      await this.deps.store.update(order.orderId, { status: finalStatus });
    }

    await this.audit(ctx, "pay_check", order.platform, { localOrderId: order.orderId, status: finalStatus });

    return {
      ok: true,
      summary: `订单「${order.title}」当前状态：${finalStatus}${alipayPaid === true ? "（支付宝已确认支付）" : ""}`,
      localOrderId: order.orderId,
      platform: order.platform,
      platformOrderId: order.platformOrderId,
      status: finalStatus,
      amountCny: order.amountCny,
      paymentUrl: order.paymentUrl,
      alipayDetail,
      platformOrders: platformRefreshed,
    };
  }

  // ============ 内部工具 ============

  private requireAdapter(platform: string): ShoppingPlatformAdapter | null {
    return getShoppingPlatformAdapter(platform);
  }

  private async getCookieAndSiteId(
    actorId: string,
    platform: string,
  ): Promise<
    | { ok: true; cookies: ImportedBrowserCookie[]; siteId: BrowserSessionSiteId }
    | { ok: false; error: string; retryable?: boolean }
  > {
    // platform 与 siteId 同名（taobao/jd/meituan/tmall/...）
    const siteId = platform as BrowserSessionSiteId;
    try {
      const cookies = await this.deps.browserSessionService.getCookiesForAgent(actorId, siteId);
      if (cookies.length === 0) {
        return {
          ok: false,
          error:
            `未导入 ${platform} 的 Cookie。可在客户端内置浏览器登录后重试（无需 Cookie）；` +
            `或导入并授权 Cookie：POST /integrations/browser-sessions/import + POST /consent（agentAllowed=true）`,
        };
      }
      return { ok: true, cookies, siteId };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return {
        ok: false,
        error: message.includes("未授权") || message.includes("agentAllowed")
          ? message
          : `获取 ${platform} Cookie 失败：${message}`,
      };
    }
  }

  private async audit(
    ctx: ToolContext,
    action: string,
    platform: string,
    extra: Record<string, unknown>,
  ): Promise<void> {
    if (!this.deps.audit) return;
    try {
      await this.deps.audit.record({
        ts: new Date().toISOString(),
        category: "shopping_order",
        action,
        platform,
        actorId: resolveActorId(ctx),
        sessionId: ctx.sessionId,
        chatUserMessageId: ctx.chatUserMessageId,
        ...extra,
      });
    } catch {
      /* 审计失败不影响主流程 */
    }
  }

  private cleanupExpired(): void {
    const now = Date.now();
    for (const [token, pending] of this.pendingConfirmations.entries()) {
      if (now > pending.expiresAt) {
        if (pending.session && !pending.session.closed) {
          pending.session.close().catch(() => {});
        }
        this.pendingConfirmations.delete(token);
      }
    }
  }
}
