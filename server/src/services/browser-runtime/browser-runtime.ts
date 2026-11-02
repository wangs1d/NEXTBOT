import type { Page } from "playwright";

import type { BrowserSessionService } from "../browser-session-service.js";
import { BROWSER_SESSION_SITES, type BrowserSessionSiteId } from "../browser-session-sites.js";
import type { ImportedBrowserCookie } from "../browser-session-types.js";
import type { SharedBrowserCoordinator } from "../shared-browser-coordinator.js";
import { SharedBrowserCdpGateway } from "../shared-browser/cdp-gateway.js";

/**
 * 通用浏览器页面运行时（所有浏览器能力的公共执行层）。
 *
 * 两条执行路径，优先级按调用方语义决定：
 *   1. 用户可见的内置浏览器（WebView2 over CDP）——登录态即用户本人，免 Cookie
 *      导入，全程可见可接管，是交互式任务的默认通道；
 *   2. 服务端无头 Chromium + 已授权 Cookie——批量读价/后台任务用，不抢唯一面板。
 *
 * 购物、通用网页操作（agent_browser）、预订报价等能力都从这里拿 Page，不再各自
 * 启动 Playwright / 各自处理 Cookie 与面板租约。
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
export class BrowserPageUnavailableError extends Error {
  constructor(
    readonly kind: "no_cookie" | "no_playwright",
    message: string,
  ) {
    super(message);
    this.name = "BrowserPageUnavailableError";
  }
}

export type BrowserPageLease = {
  page: Page;
  /** shared=用户可见的内置浏览器；headless=服务端无头兜底 */
  mode: "shared" | "headless";
  /** 释放页面：shared 只释放面板队列（页面留痕）；headless 关整个浏览器实例 */
  release: () => Promise<void>;
};

export type AcquireBrowserPageOptions = {
  /** 站点 id（Cookie 注入、登录页启发式、错误文案）；缺省时按 URL 推断 */
  siteId?: string;
  /** headless 兜底时注入的授权 Cookie（shared 模式用用户自身登录态，忽略）。 */
  cookies?: ImportedBrowserCookie[];
  /**
   * 允许「无 Cookie 匿名打开 + 扫码登录」交互式兜底。仅当二维码能呈现给用户
   * （聊天在线 ctx.pushMediaCards 或内置浏览器可见）时开启；false 且无 Cookie
   * 时直接抛 no_cookie（不启动浏览器）。
   */
  interactiveLogin?: boolean;
  /** 无头优先（批量取数）：内置浏览器兜底。 */
  preferHeadless?: boolean;
};

export type BrowserRuntimeDeps = {
  coordinator: SharedBrowserCoordinator;
  gateway: SharedBrowserCdpGateway;
  browserSessionService: BrowserSessionService;
};

export class BrowserRuntime {
  constructor(private readonly deps: BrowserRuntimeDeps) {}

  /** 内置浏览器路径是否可用（客户端在线 + CDP 总开关 + 端点已上报）。 */
  canUseSharedBrowser(actorId: string): boolean {
    return (
      this.deps.gateway.available &&
      this.deps.coordinator.hasExecutor(actorId) &&
      this.deps.coordinator.cdpEndpoint(actorId) !== ""
    );
  }

  /**
   * 仅尝试内置浏览器路径（不做 headless 兜底），供「只在用户可见浏览器里打开」
   * 的场景；不可用/失败返回 null（调用方自行回退）。
   * waitSlotMs：面板被别的任务占用时的等锁上限（默认 90s；交互式短任务可调小）。
   */
  async tryOpenSharedPage(
    actorId: string,
    targetUrl: string,
    opts: { waitSlotMs?: number } = {},
  ): Promise<BrowserPageLease | null> {
    if (!this.canUseSharedBrowser(actorId)) return null;
    const endpoint = this.deps.coordinator.cdpEndpoint(actorId);
    const connected = await this.deps.gateway.connect(endpoint).catch(() => false);
    if (!connected) return null;
    // 先点亮「Agent 正在操作浏览器」→ 客户端据此打开内置浏览器面板并创建
    // WebView2；openPage 会等面板页出现再导航（面板没开时开不了页）。
    this.deps.coordinator.notifyBrowserBusy?.(actorId, true, "页面任务");
    const page = await this.deps.gateway
      .openPage(targetUrl, opts.waitSlotMs ? { waitSlotMs: opts.waitSlotMs } : {})
      .catch(() => null);
    if (!page) {
      this.deps.coordinator.notifyBrowserBusy?.(actorId, false, "");
      return null;
    }
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
   * 全部路径不可用时抛 BrowserPageUnavailableError（或 Playwright 缺失）。
   */
  async acquirePage(
    actorId: string,
    targetUrl: string,
    opts: AcquireBrowserPageOptions = {},
  ): Promise<BrowserPageLease> {
    // 1) 批量取数：Playwright+Cookie 主通道（无头并行，不抢面板）。
    if (opts.preferHeadless === true) {
      try {
        return await this.acquireHeadlessPage(opts.siteId, targetUrl, opts.cookies ?? [], opts.interactiveLogin === true);
      } catch (err) {
        const shared = await this.tryOpenSharedPage(actorId, targetUrl).catch(() => null);
        if (shared) return shared;
        throw err;
      }
    }

    // 2) 交互式流程：用户可见的内置浏览器优先（WebView2 over CDP）
    const shared = await this.tryOpenSharedPage(actorId, targetUrl).catch(() => null);
    if (shared) return shared;

    // 3) 无头兜底（CDP 连接/开页失败 → 静默降级，客户端可能刚断开/端口失效）
    return this.acquireHeadlessPage(opts.siteId, targetUrl, opts.cookies ?? [], opts.interactiveLogin === true);
  }

  /** 服务端无头 Chromium + 已授权 Cookie。 */
  private async acquireHeadlessPage(
    siteId: string | undefined,
    targetUrl: string,
    cookies: ImportedBrowserCookie[],
    interactiveLogin: boolean,
  ): Promise<BrowserPageLease> {
    const siteLabel = siteId
      ? (BROWSER_SESSION_SITES[siteId as BrowserSessionSiteId]?.label ?? siteId)
      : "该站点";
    if (cookies.length === 0 && !interactiveLogin) {
      throw new BrowserPageUnavailableError(
        "no_cookie",
        `未导入 ${siteLabel} 的 Cookie，且无法交互式登录（客户端内置浏览器不在线）。` +
          `可在客户端内置浏览器登录${siteLabel}后重试（无需 Cookie），或导入 Cookie 并授权：` +
          `POST /integrations/browser-sessions/import + POST /integrations/browser-sessions/consent（agentAllowed=true）`,
      );
    }

    const pw = await loadPlaywright();
    if (!pw) {
      throw new BrowserPageUnavailableError(
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
