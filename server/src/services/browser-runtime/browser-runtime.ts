import type { Browser, BrowserContext, Page } from "playwright";

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
  /**
   * 允许「无 Cookie 也开浏览器」（匿名可读的站点，如苏宁/什么值得买搜索页）。
   * 缺省 false：无 Cookie 且不能交互登录时直接抛 no_cookie，不白起浏览器。
   */
  allowAnonymous?: boolean;
};

export type BrowserRuntimeDeps = {
  coordinator: SharedBrowserCoordinator;
  gateway: SharedBrowserCdpGateway;
  browserSessionService: BrowserSessionService;
};

export class BrowserRuntime {
  constructor(private readonly deps: BrowserRuntimeDeps) {}

  /**
   * 云端常驻匿名浏览器（手机端/后台取数用的「内置浏览器」）。
   *
   * 为什么不能每次都 chromium.launch：一是慢（每次 1s 冷启动），二是**平台风控**——
   * 每次全新无痕实例、每次零 Cookie 访问，苏宁/什么值得买这类站点会当成爬虫弹
   * 安全验证（实测：第二次搜索就被要求验证）。真机上是「一个浏览器开着一直用」，
   * 这里就复刻这个形态：浏览器常驻、按站点复用 context（Cookie 自然累积），
   * 页面用完只关 page，空闲 90s 才整体回收。
   *
   * 安全边界：只用于**无登录态**（cookies 为空）的匿名站点；带用户 Cookie 的
   * 取价仍走独立实例，避免跨用户串号。
   */
  private anonBrowser: Browser | null = null;
  private anonLaunching: Promise<Browser> | null = null;
  private readonly anonContexts = new Map<string, BrowserContext>();
  private anonIdleTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly ANON_IDLE_MS = 90_000;

  /**
   * 带登录 Cookie 的无头浏览器池（按用户隔离）。
   *
   * 旧实现每次 acquire 都 chromium.launch —— 冷启动约 1s，而比价一轮要经历
   * 「登录墙预检 → 截二维码 → 取价」三次 acquire，等于冷启动三次；串行三平台
   * 时用户看到的就是「开浏览器特别慢」。这里按 actorId 复用浏览器实例（不同
   * 用户绝不共享），每次仍新建独立 context 并注入该用户的 Cookie，隔离语义
   * 不变；空闲 2 分钟回收。
   */
  private readonly userBrowsers = new Map<
    string,
    { browser: Browser; refs: number; idle: ReturnType<typeof setTimeout> | null }
  >();
  private readonly userLaunching = new Map<string, Promise<Browser>>();
  private static readonly USER_IDLE_MS = 120_000;

  private async getUserBrowser(
    pw: typeof import("playwright"),
    actorId: string,
  ): Promise<Browser> {
    const existing = this.userBrowsers.get(actorId);
    if (existing?.browser.isConnected()) return existing.browser;
    const launching = this.userLaunching.get(actorId);
    if (launching) return launching;
    const p = pw.chromium
      .launch({ headless: true, args: ["--disable-blink-features=AutomationControlled"] })
      .then((browser) => {
        this.userBrowsers.set(actorId, { browser, refs: 0, idle: null });
        this.userLaunching.delete(actorId);
        return browser;
      })
      .catch((err) => {
        this.userLaunching.delete(actorId);
        throw err;
      });
    this.userLaunching.set(actorId, p);
    return p;
  }

  private acquireUserRef(actorId: string): void {
    const entry = this.userBrowsers.get(actorId);
    if (!entry) return;
    entry.refs += 1;
    if (entry.idle) {
      clearTimeout(entry.idle);
      entry.idle = null;
    }
  }

  private releaseUserRef(actorId: string, browser?: Browser): void {
    const entry = this.userBrowsers.get(actorId);
    if (!entry) return;
    // 浏览器实例被替换过（崩溃重连）：旧 context 的释放不能扣新实例的引用。
    if (browser != null && entry.browser !== browser) return;
    entry.refs = Math.max(0, entry.refs - 1);
    if (entry.refs > 0) return;
    if (entry.idle) clearTimeout(entry.idle);
    const scheduledBrowser = entry.browser;
    entry.idle = setTimeout(() => {
      const latest = this.userBrowsers.get(actorId);
      // 池里可能已经换成了新实例：别把后来者的浏览器误关掉。
      if (!latest || latest.refs > 0 || latest.browser !== scheduledBrowser) return;
      this.userBrowsers.delete(actorId);
      void latest.browser.close().catch(() => {});
    }, BrowserRuntime.USER_IDLE_MS);
    entry.idle.unref?.();
  }

  /** 空闲回收：没有在跑的页面就关掉整个浏览器，别长期占内存。 */
  private touchAnonIdle(): void {
    if (this.anonIdleTimer) clearTimeout(this.anonIdleTimer);
    this.anonIdleTimer = setTimeout(() => {
      void this.closeAnonBrowser();
    }, BrowserRuntime.ANON_IDLE_MS);
    // 定时器不应该吊住进程
    this.anonIdleTimer.unref?.();
  }

  private async closeAnonBrowser(): Promise<void> {
    this.anonIdleTimer = null;
    for (const ctx of this.anonContexts.values()) {
      await ctx.close().catch(() => {});
    }
    this.anonContexts.clear();
    const b = this.anonBrowser;
    this.anonBrowser = null;
    await b?.close().catch(() => {});
  }

  private async getAnonBrowser(pw: typeof import("playwright")): Promise<Browser> {
    if (this.anonBrowser?.isConnected()) return this.anonBrowser;
    if (!this.anonLaunching) {
      this.anonLaunching = pw.chromium
        .launch({ headless: true, args: ["--disable-blink-features=AutomationControlled"] })
        .then((b) => {
          this.anonBrowser = b;
          this.anonLaunching = null;
          return b;
        })
        .catch((err) => {
          this.anonLaunching = null;
          throw err;
        });
    }
    return this.anonLaunching;
  }

  /** 匿名站点的页面租约：复用常驻浏览器 + 站点级 context。 */
  private async acquireAnonPage(siteId: string | undefined, targetUrl: string): Promise<BrowserPageLease> {
    const pw = await loadPlaywright();
    if (!pw) {
      throw new BrowserPageUnavailableError("no_playwright", "Playwright 未安装。请在 server 目录执行: npx playwright install chromium");
    }
    const key = siteId ?? "default";
    const browser = await this.getAnonBrowser(pw);
    let ctx = this.anonContexts.get(key);
    let created = false;
    if (!ctx || ctx.isClosed()) {
      ctx = await browser.newContext({
        userAgent: USER_AGENT,
        locale: "zh-CN",
        viewport: { width: 1280, height: 900 },
      });
      this.anonContexts.set(key, ctx);
      created = true;
    }
    // 新 context 先"暖站"再敲搜索页：冷启动直接打搜索接口是风控最爱拦的形态
    // （什么值得买第二次冷搜就弹「安全验证」）。先开首页拿站点 Cookie，
    // 再进搜索页，行为接近真人。
    if (created) {
      const home = siteId
        ? BROWSER_SESSION_SITES[siteId as BrowserSessionSiteId]?.homeUrl
        : undefined;
      if (home) {
        const warm = await ctx.newPage();
        await warm.goto(home, { waitUntil: "domcontentloaded", timeout: 12_000 }).catch(() => {});
        await warm.waitForTimeout(900).catch(() => {});
        await warm.close().catch(() => {});
      }
    }
    const page = await ctx.newPage();
    try {
      await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 15_000 });
    } catch (err) {
      await page.close().catch(() => {});
      throw err;
    }
    this.touchAnonIdle();
    return {
      page,
      mode: "headless",
      release: async () => {
        await page.close().catch(() => {});
        this.touchAnonIdle();
      },
    };
  }

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
        return await this.acquireHeadlessPage(
          actorId,
          opts.siteId,
          targetUrl,
          opts.cookies ?? [],
          opts.interactiveLogin === true,
          opts.allowAnonymous === true,
        );
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
    return this.acquireHeadlessPage(
      actorId,
      opts.siteId,
      targetUrl,
      opts.cookies ?? [],
      opts.interactiveLogin === true,
      opts.allowAnonymous === true,
    );
  }

  /** 服务端无头 Chromium + 已授权 Cookie（浏览器按用户复用，context 每次新建）。 */
  private async acquireHeadlessPage(
    actorId: string,
    siteId: string | undefined,
    targetUrl: string,
    cookies: ImportedBrowserCookie[],
    interactiveLogin: boolean,
    allowAnonymous = false,
  ): Promise<BrowserPageLease> {
    // 匿名站点 + 无 Cookie → 走常驻浏览器（复用 context，压低风控与冷启动）。
    // 不看 interactiveLogin：匿名站点本来就该匿名访问，真弹登录也能在同一个
    // context 里截图推码，没有必须冷启动的理由。
    if (allowAnonymous && cookies.length === 0) {
      return this.acquireAnonPage(siteId, targetUrl);
    }
    const siteLabel = siteId
      ? (BROWSER_SESSION_SITES[siteId as BrowserSessionSiteId]?.label ?? siteId)
      : "该站点";
    if (cookies.length === 0 && !interactiveLogin && !allowAnonymous) {
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

    // 复用该用户的浏览器实例（冷启动只付一次），context 仍每次新建并注入
    // 本次 Cookie —— 页面/存储隔离与旧实现一致。
    const browser = await this.getUserBrowser(pw, actorId);
    this.acquireUserRef(actorId);
    let context: BrowserContext | null = null;
    try {
      context = await browser.newContext({ userAgent: USER_AGENT, locale: "zh-CN" });
      if (cookies.length > 0) {
        await context.addCookies(toPlaywrightCookies(targetUrl, cookies));
      }
      const page = await context.newPage();
      await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 15_000 });
      return {
        page,
        mode: "headless",
        release: async () => {
          await context?.close().catch(() => {});
          this.releaseUserRef(actorId, browser);
        },
      };
    } catch (err) {
      await context?.close().catch(() => {});
      this.releaseUserRef(actorId, browser);
      // 浏览器已崩溃/断开：清掉池里这只坏实例，别让后续请求继续撞它。
      if (!browser.isConnected()) {
        const entry = this.userBrowsers.get(actorId);
        if (entry?.browser === browser) this.userBrowsers.delete(actorId);
        await browser.close().catch(() => {});
      }
      throw err;
    }
  }
}
