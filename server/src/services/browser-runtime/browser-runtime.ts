import type { Browser, BrowserContext, Page } from "playwright";

import type { BrowserSessionService } from "../browser-session-service.js";
import { BROWSER_SESSION_SITES, type BrowserSessionSiteId } from "../browser-session-sites.js";
import type { ImportedBrowserCookie } from "../browser-session-types.js";
import type { SharedBrowserCoordinator } from "../shared-browser-coordinator.js";
import { SharedBrowserCdpGateway } from "../shared-browser/cdp-gateway.js";

/**
 * 通用浏览器页面运行时（所有浏览器能力的公共执行层）。
 *
 * 三条执行路径：
 *   1. 用户可见的内置浏览器（WebView2 over CDP）——登录态即用户本人，免 Cookie
 *      导入，全程可见可接管，是交互式任务的默认通道；
 *   2. 服务端**常驻** Chromium（本文件维护的进程级单例）——手机端/后台任务用，
 *      按 actor+站点复用 context，不再每次任务冷启动一个浏览器；
 *   3. 独立一次性实例——仅用于必须完全隔离的场景（一次性匿名抓取等）。
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
  /** 释放页面：shared 只释放面板队列（页面留痕）；headless 关 page（浏览器常驻） */
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

/** 无头页面打开参数（agent_browser 等直接要页面的调用方用）。 */
export type OpenHeadlessPageOptions = {
  siteId?: string;
  cookies?: ImportedBrowserCookie[];
  viewport?: { width: number; height: number };
  waitUntil?: "load" | "domcontentloaded" | "networkidle";
  timeout?: number;
  /** 复用 context 的键前缀（缺省按 actorId+siteId）。会话需要独占状态时传入。 */
  contextKey?: string;
};

export class BrowserRuntime {
  constructor(private readonly deps: BrowserRuntimeDeps) {}

  // ─── 进程级常驻浏览器（2026-11-19）──────────────────────────────────────
  //
  // 为什么必须常驻（用户 2026-11-19 投诉「内置浏览器启动太慢、看不到界面，
  // 难道每次都要重启？」）：
  //   · 冷启动链 = chromium.launch(340ms~1.2s) + newContext + newPage + 首屏导航，
  //     单看每步都不大，串起来就是手机端「点了没反应」的 3~5 秒；
  //   · 平台风控（京东/苏宁/什么值得买）把「每次全新无痕实例」当爬虫，直接跳
  //     risk_handler 或弹安全验证；
  //   · 每次任务新建实例会让内存反复涨落，云端 2C/1.7G 上尤其伤。
  // 现在复刻真人形态：**一个 chromium 进程开着一直用**，按 actor+站点复用
  // context（Cookie 自然累积），页面用完只关 page，空闲 10 分钟才整体回收。

  private persistentBrowser: Browser | null = null;
  private persistentLaunching: Promise<Browser> | null = null;
  private readonly pageContexts = new Map<string, BrowserContext>();
  /** 正在创建的 context（并发预检时同 key 只建一次，避免泄漏）。 */
  private readonly contextCreating = new Map<string, Promise<{ ctx: BrowserContext; created: boolean }>>();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** 空闲多久整体回收（毫秒）。常驻不等于永久占用，静默期照样让位给系统。 */
  private static readonly IDLE_CLOSE_MS = 45 * 60_000;
  /** context 上限（每用户每站点一个）：防内存随用户数线性增长。 */
  private static readonly MAX_CONTEXTS = 6;

  /** 常驻浏览器实例（崩溃自动重建）。 */
  private async getPersistentBrowser(pw: typeof import("playwright")): Promise<Browser> {
    if (this.persistentBrowser?.isConnected()) {
      this.touchIdle();
      return this.persistentBrowser;
    }
    if (!this.persistentLaunching) {
      this.persistentLaunching = pw.chromium
        .launch({
          headless: true,
          args: [
            "--disable-blink-features=AutomationControlled",
            "--disable-dev-shm-usage",
            "--no-sandbox",
          ],
        })
        .then((b) => {
          this.persistentBrowser = b;
          this.persistentLaunching = null;
          // 进程意外退出时清掉引用，下次自动重建
          b.on("disconnected", () => {
            if (this.persistentBrowser === b) this.persistentBrowser = null;
          });
          return b;
        })
        .catch((err) => {
          this.persistentLaunching = null;
          throw err;
        });
    }
    return this.persistentLaunching;
  }

  /**
   * 开机预热：服务启动时先建好浏览器进程与渲染管线（打开 about:blank）。
   * 用户第一次真要浏览器时不用再吃冷启动——这是「常驻」的另一半价值。
   * best-effort：未装 Playwright / 内存不足都静默跳过。
   */
  async warmup(): Promise<boolean> {
    const pw = await loadPlaywright();
    if (!pw) return false;
    try {
      const browser = await this.getPersistentBrowser(pw);
      const ctx = await browser.newContext({ userAgent: USER_AGENT, locale: "zh-CN" });
      const page = await ctx.newPage();
      await page.goto("about:blank", { timeout: 5_000 }).catch(() => {});
      await page.close().catch(() => {});
      await ctx.close().catch(() => {});
      this.touchIdle();
      return true;
    } catch {
      return false;
    }
  }

  /** 空闲回收：没有活页面就关掉整个浏览器，别长期占内存。 */
  private touchIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.hasLivePages()) {
        this.touchIdle();
        return;
      }
      void this.closePersistentBrowser();
    }, BrowserRuntime.IDLE_CLOSE_MS);
    this.idleTimer.unref?.();
  }

  /** 是否还有未关闭的页面（有用就不回收）。 */
  private hasLivePages(): boolean {
    for (const ctx of this.pageContexts.values()) {
      if (ctx.isClosed()) continue;
      if (ctx.pages().some((p) => !p.isClosed())) return true;
    }
    return false;
  }

  /** 关闭常驻浏览器（空闲回收 / 进程退出）。 */
  async closePersistentBrowser(): Promise<void> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    for (const ctx of this.pageContexts.values()) {
      await ctx.close().catch(() => {});
    }
    this.pageContexts.clear();
    const b = this.persistentBrowser;
    this.persistentBrowser = null;
    await b?.close().catch(() => {});
  }

  /** 取（或建）actor+站点级 context；带 Cookie 时每次都覆盖成最新授权。 */
  private async getContext(
    browser: Browser,
    key: string,
    opts: { cookies?: ImportedBrowserCookie[]; url: string; viewport?: { width: number; height: number } },
  ): Promise<{ ctx: BrowserContext; created: boolean }> {
    // 并发预检会让同一站点的多个请求同时到达：没有锁的话会各自 newContext
    // 再互相覆盖（先建的那个 context 泄漏成僵尸，白吃内存）。同 key 复用同一次创建。
    const pending = this.contextCreating.get(key);
    if (pending) {
      const ready = await pending;
      return { ctx: ready.ctx, created: false };
    }

    let ctx = this.pageContexts.get(key);
    let created = false;
    if (!ctx || ctx.isClosed()) {
      const task = (async () => {
        const fresh = await browser.newContext({
          userAgent: USER_AGENT,
          locale: "zh-CN",
          viewport: opts.viewport ?? { width: 1280, height: 900 },
        });
        this.pageContexts.set(key, fresh);
        this.trimContexts();
        return fresh;
      })();
      this.contextCreating.set(key, task.then((c) => ({ ctx: c, created: true })));
      try {
        ctx = await task;
        created = true;
      } finally {
        this.contextCreating.delete(key);
      }
    }
    // Cookie 每轮同步一次：库里授权被更新/吊销时能立刻生效（只覆盖同名项）。
    if (opts.cookies && opts.cookies.length > 0) {
      await ctx.addCookies(toPlaywrightCookies(opts.url, opts.cookies)).catch(() => {});
    }
    return { ctx, created };
  }

  /** context 超上限：优先关最老且没有活页面的（Map 迭代即插入序）。 */
  private trimContexts(): void {
    while (this.pageContexts.size > BrowserRuntime.MAX_CONTEXTS) {
      let victimKey: string | null = null;
      for (const [key, ctx] of this.pageContexts) {
        if (ctx.isClosed() || ctx.pages().every((p) => p.isClosed())) {
          victimKey = key;
          break;
        }
      }
      if (!victimKey) victimKey = this.pageContexts.keys().next().value as string | undefined ?? null;
      if (!victimKey) return;
      const ctx = this.pageContexts.get(victimKey);
      this.pageContexts.delete(victimKey);
      void ctx?.close().catch(() => {});
    }
  }

  /**
   * 常驻浏览器里开一个页面（不关浏览器，只关 page）。
   * 供 agent_browser 这类「一次任务一个页面」的能力直接使用。
   */
  async openHeadlessPage(
    actorId: string,
    targetUrl: string,
    opts: OpenHeadlessPageOptions = {},
  ): Promise<BrowserPageLease> {
    const pw = await loadPlaywright();
    if (!pw) {
      throw new BrowserPageUnavailableError(
        "no_playwright",
        "Playwright 未安装。请在 server 目录执行: npm install playwright && npx playwright install chromium",
      );
    }
    const browser = await this.getPersistentBrowser(pw);
    const key = opts.contextKey ?? `u:${actorId}:${opts.siteId ?? "default"}`;
    const { ctx } = await this.getContext(browser, key, {
      cookies: opts.cookies,
      url: targetUrl,
      viewport: opts.viewport,
    });
    const page = await ctx.newPage();
    page.setDefaultTimeout(opts.timeout ?? 15_000);
    try {
      await page.goto(targetUrl, {
        waitUntil: opts.waitUntil ?? "domcontentloaded",
        timeout: opts.timeout ?? 30_000,
      });
    } catch (err) {
      await page.close().catch(() => {});
      throw err;
    }
    this.touchIdle();
    return {
      page,
      mode: "headless",
      release: async () => {
        await page.close().catch(() => {});
        this.touchIdle();
      },
    };
  }

  /**
   * 读取某用户某站点常驻 context 里的实时 Cookie（扫码登录后 Cookie 先落在
   * 这里，库里还是旧的）。
   *
   * 为什么要这个（2026-11-20）：多平台登录卡点「我扫好了」时只查库里的
   * Cookie——而扫码后的 Cookie 还在浏览器里没落库，于是永远显示「还没识别到
   * 登录」，用户以为扫码没用。这里把实时 Cookie 读出来交给上层落库。
   */
  async readContextCookies(
    actorId: string,
    siteId: string,
    url?: string,
  ): Promise<ImportedBrowserCookie[]> {
    const ctx = this.pageContexts.get(`u:${actorId}:${siteId}`);
    if (!ctx || ctx.isClosed()) return [];
    const raw = await ctx.cookies(url).catch(() => []);
    return raw.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      ...(c.expires && c.expires > 0 ? { expires: c.expires } : {}),
      httpOnly: c.httpOnly,
      secure: c.secure,
      sameSite: c.sameSite,
    }));
  }

  /** 关停（进程退出 / 测试收尾）。 */
  async dispose(): Promise<void> {
    await this.closePersistentBrowser();
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
    // 1) 批量取数：常驻 Chromium + Cookie 主通道（并行，不抢面板）。
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

  /**
   * 服务端无头路径（**复用常驻浏览器**，不再每次 launch）。
   *
   * 匿名站点与带 Cookie 站点共用同一个 chromium 进程，区别只在 context 的键：
   *   · 匿名：`anon:{siteId}`（无 Cookie，只吃站点自身种的匿名态）
   *   · 带授权：`u:{actorId}:{siteId}`（每用户独立，注入库中 Cookie，跨用户隔离）
   * release 只关 page——context 与登录态留着，下次同一用户同一站点直接续用
   * （这正是「登录一次，之后一直用」的物理基础）。
   */
  private async acquireHeadlessPage(
    actorId: string,
    siteId: string | undefined,
    targetUrl: string,
    cookies: ImportedBrowserCookie[],
    interactiveLogin: boolean,
    allowAnonymous = false,
  ): Promise<BrowserPageLease> {
    const anonymous = cookies.length === 0 && allowAnonymous;
    if (cookies.length === 0 && !interactiveLogin && !allowAnonymous) {
      const siteLabel = siteId
        ? (BROWSER_SESSION_SITES[siteId as BrowserSessionSiteId]?.label ?? siteId)
        : "该站点";
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
        "Playwright 未安装。请在 server 目录执行: npm install playwright && npx playwright install chromium",
      );
    }

    const browser = await this.getPersistentBrowser(pw);
    // 上下文键**必须带 actorId**（2026-11-20 修串号）：以前匿名走 `anon:site`
    // 全局共享，可用户一旦在这个页面扫码登录，这个 context 就带着他的 Cookie，
    // 下一个用户会直接进别人账号。匿名与登录只是「要不要注入库里的 Cookie」，
    // 上下文本身永远按人隔离。
    const key = `u:${actorId}:${siteId ?? "default"}`;
    const { ctx, created } = await this.getContext(browser, key, { cookies, url: targetUrl });
    // 新 context 先"暖站"再敲搜索页：冷启动直接打搜索接口是平台风控最爱拦的
    // 形态（什么值得买第二次冷搜就弹「安全验证」；京东直接甩 risk_handler）。
    // 先开首页拿站点自身的匿名 Cookie，再进目标页，行为接近真人。
    if (created) {
      const home = siteId
        ? BROWSER_SESSION_SITES[siteId as BrowserSessionSiteId]?.homeUrl
        : undefined;
      if (home) {
        const warm = await ctx.newPage();
        // 暖站只是拿站点 Cookie：domcontentloaded 就够，别等整页资源
        // （12s 超时在云端等于把首次任务又拖慢一轮，2026-11-20 收窄到 6s/500ms）
        await warm.goto(home, { waitUntil: "domcontentloaded", timeout: 6_000 }).catch(() => {});
        await warm.waitForTimeout(500).catch(() => {});
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
    this.touchIdle();
    return {
      page,
      mode: "headless",
      release: async () => {
        await page.close().catch(() => {});
        this.touchIdle();
      },
    };
  }
}
