import type { Page } from "playwright";

import type { BrowserSessionService } from "../browser-session-service.js";
import type { BrowserSessionSiteId } from "../browser-session-sites.js";
import type { ImportedBrowserCookie } from "../browser-session-types.js";
import type { SharedBrowserCoordinator } from "../shared-browser-coordinator.js";
import { SharedBrowserCdpGateway } from "../shared-browser/cdp-gateway.js";

/**
 * 购物流程页面获取器。
 *
 * 策略：
 *   1. Playwright+Cookie 主通道——服务端无头 Chromium + 已导入授权的 Cookie，
 *      比价等多平台取数默认走这条（无头可并行，不抢唯一的内置浏览器面板）。
 *      无 Cookie 且允许交互式登录时以匿名态打开（由调用方走扫码登录门）。
 *   2. shared 兜底——无头不可用（无 Cookie/Playwright 缺失/启动失败）且客户端
 *      在线并开启调试端口时，经 CDP 直连用户可见的 WebView2 内置浏览器新开
 *      标签页执行（登录态即用户自身，免 Cookie 导入；可随时人工接管）。
 *
 * 下单/支付等需要用户看着的交互式流程不传 preferHeadless，仍以 shared 优先。
 *
 * 平台适配器（ShoppingPlatformAdapter）只依赖 Playwright Page——CDP 连接
 * WebView2 拿到的 Page 同样支持 evaluate/截图，适配器零改动跑在两条路径上。
 */

/** Playwright 动态加载（避免在未安装时启动失败）。 */
export async function loadPlaywright(): Promise<typeof import("playwright") | null> {
  try {
    return await import("playwright");
  } catch {
    return null;
  }
}

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

/** 把 ImportedBrowserCookie 转成 Playwright addCookies 格式。 */
export function toPlaywrightCookies(
  pageUrl: string,
  cookies: ImportedBrowserCookie[],
): Array<{
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}> {
  let defaultHost = "";
  try {
    defaultHost = new URL(pageUrl).hostname;
  } catch {
    /* ignore */
  }
  return cookies.map((c) => {
    const domain = (c.domain ?? defaultHost).replace(/^\./, "");
    const sameSite = normalizeSameSite(c.sameSite);
    return {
      name: c.name,
      value: c.value,
      domain: domain.startsWith(".") ? domain : `.${domain}`,
      path: c.path ?? "/",
      expires: c.expires,
      httpOnly: c.httpOnly,
      secure: c.secure,
      sameSite,
    };
  });
}

function normalizeSameSite(raw?: string): "Strict" | "Lax" | "None" | undefined {
  if (!raw) return undefined;
  const s = raw.toLowerCase();
  if (s === "strict") return "Strict";
  if (s === "lax") return "Lax";
  if (s === "none") return "None";
  return undefined;
}

/** 页面获取失败的区分型错误（kind 决定给用户的指引文案）。 */
export class ShoppingPageUnavailableError extends Error {
  constructor(
    readonly kind: "no_cookie" | "no_playwright",
    message: string,
  ) {
    super(message);
    this.name = "ShoppingPageUnavailableError";
  }
}

export type ShoppingPageLease = {
  page: Page;
  /** shared=用户可见的内置浏览器；headless=服务端无头兜底 */
  mode: "shared" | "headless";
  /** 释放页面：shared 只关自己开的标签页；headless 关整个浏览器实例 */
  release: () => Promise<void>;
};

export type AcquireShoppingPageOptions = {
  /** headless 兜底时注入的授权 Cookie（shared 模式用用户自身登录态，忽略）。 */
  cookies?: ImportedBrowserCookie[];
  /**
   * 允许「无 Cookie 匿名打开 + 扫码登录」交互式兜底。仅当二维码能呈现给用户
   * （聊天在线 ctx.pushMediaCards 或内置浏览器可见）时开启；false 且无 Cookie
   * 时直接抛 no_cookie（不启动浏览器）。
   */
  interactiveLogin?: boolean;
  /** Playwright+Cookie 优先，内置浏览器兜底（比价/后台取数用，可无头并行）。 */
  preferHeadless?: boolean;
};

export type ShoppingBrowserExecutorDeps = {
  coordinator: SharedBrowserCoordinator;
  gateway: SharedBrowserCdpGateway;
  browserSessionService: BrowserSessionService;
};

export class ShoppingBrowserExecutor {
  constructor(private readonly deps: ShoppingBrowserExecutorDeps) {}

  /** 内置浏览器路径是否可用（客户端在线 + CDP 总开关 + 端点已上报）。 */
  canUseSharedBrowser(actorId: string): boolean {
    return (
      this.deps.gateway.available &&
      this.deps.coordinator.hasExecutor(actorId) &&
      this.deps.coordinator.cdpEndpoint(actorId) !== ""
    );
  }

  /**
   * 仅尝试内置浏览器路径（不做 headless 兜底），供支付收银台等"只在用户可见
   * 浏览器里打开"的场景；不可用/失败返回 null（调用方自行回退）。
   */
  async tryOpenSharedPage(actorId: string, targetUrl: string): Promise<ShoppingPageLease | null> {
    if (!this.canUseSharedBrowser(actorId)) return null;
    const endpoint = this.deps.coordinator.cdpEndpoint(actorId);
    const connected = await this.deps.gateway.connect(endpoint).catch(() => false);
    if (!connected) return null;
    const page = await this.deps.gateway.openPage(targetUrl).catch(() => null);
    if (!page) return null;
    // 感知：CDP 抓取期间点亮客户端面板的「Agent 正在操作浏览器」状态条
    this.deps.coordinator.notifyBrowserBusy?.(actorId, true, "页面任务");
    return {
      page,
      mode: "shared",
      release: () => {
        this.deps.coordinator.notifyBrowserBusy?.(actorId, false, "");
        return this.deps.gateway.closePage(page);
      },
    };
  }

  /**
   * 获取一个已导航到 targetUrl 的页面租约。
   * 全部路径不可用时抛 ShoppingPageUnavailableError（或 Playwright 缺失）。
   */
  async acquirePage(
    actorId: string,
    platform: string,
    targetUrl: string,
    opts: AcquireShoppingPageOptions = {},
  ): Promise<ShoppingPageLease> {
    // 1) 比价/后台取数：Playwright+Cookie 主通道（无头并行，不抢面板）。
    //    无头不可用（无 Cookie/Playwright 缺失/启动失败）才回落可见浏览器。
    if (opts.preferHeadless === true) {
      try {
        return await this.acquireHeadlessPage(platform, targetUrl, opts);
      } catch (err) {
        const shared = await this.tryOpenSharedPage(actorId, targetUrl).catch(() => null);
        if (shared) return shared;
        throw err;
      }
    }

    // 2) 交互式流程（下单/支付）：用户可见的内置浏览器优先（WebView2 over CDP）
    const shared = await this.tryOpenSharedPage(actorId, targetUrl).catch(() => null);
    if (shared) return shared;

    // 3) 无头兜底（CDP 连接/开页失败 → 静默降级，客户端可能刚断开/端口失效）
    return this.acquireHeadlessPage(platform, targetUrl, opts);
  }

  /** 服务端无头 Chromium + 已授权 Cookie。 */
  private async acquireHeadlessPage(
    platform: string,
    targetUrl: string,
    opts: AcquireShoppingPageOptions,
  ): Promise<ShoppingPageLease> {
    const cookies = opts.cookies ?? [];
    if (cookies.length === 0 && !opts.interactiveLogin) {
      throw new ShoppingPageUnavailableError(
        "no_cookie",
        `未导入 ${platform} 的 Cookie，且无法交互式登录（客户端内置浏览器不在线）。` +
          `可在客户端内置浏览器登录${platform}后重试（无需 Cookie），或导入 Cookie 并授权：` +
          `POST /integrations/browser-sessions/import + POST /integrations/browser-sessions/consent（agentAllowed=true）`,
      );
    }

    const pw = await loadPlaywright();
    if (!pw) {
      throw new ShoppingPageUnavailableError(
        "no_playwright",
        "Playwright 未安装。请在 server 目录执行: npx playwright install chromium",
      );
    }

    const { chromium } = pw;
    const browser = await chromium.launch({
      headless: true,
      args: ["--disable-blink-features=AutomationControlled"],
    });
    try {
      const context = await browser.newContext({ userAgent: USER_AGENT, locale: "zh-CN" });
      if (cookies.length > 0) {
        await context.addCookies(toPlaywrightCookies(targetUrl, cookies));
      }
      const page = await context.newPage();
      await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 15_000 });
      return {
        page,
        mode: "headless",
        release: async () => {
          await browser.close().catch(() => {});
        },
      };
    } catch (err) {
      await browser.close().catch(() => {});
      throw err;
    }
  }
}
