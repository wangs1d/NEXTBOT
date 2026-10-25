import type { Browser, Page } from "playwright";

/**
 * 共用浏览器可信输入网关（CDP 桥）。
 *
 * 客户端开启 WebView2 remote-debugging-port 并经 browser.bridge.info 上报
 * 端点后，本网关用 Playwright connectOverCDP 直连**用户正在看的那个浏览器**，
 * 派发 isTrusted=true 的真实输入事件（带轨迹），过注入式点击（合成事件）
 * 过不了的风控。DOM 感知仍走注入运行时——"注入读 + CDP 写"分工。
 *
 * 安全约束（缺一不用）：
 *   - 端口只绑 127.0.0.1（客户端保证）
 *   - 由用户在客户端显式开启（SharedBrowserHost.remoteDebugPort，默认关闭）
 *   - 服务端总开关 SHARED_BROWSER_CDP_ENABLED=1（部署方控制），默认关闭
 *   - 客户端断连即清端点（coordinator.unbindIfSocket）
 *
 * 已知限制：服务端与客户端须同机或可达客户端 localhost（私有化部署通常满足；
 * 远程部署时 CDP 端口不可达，工具层自动回退注入路径）。
 */
/** 复用页面识别与释放规则见 openPage/closePage 注释。 */
export class SharedBrowserCdpGateway {
  private browser?: Browser;
  private endpoint = "";
  private connecting?: Promise<boolean>;

  constructor(
    private readonly enabled: boolean =
      process.env.SHARED_BROWSER_CDP_ENABLED === "1",
  ) {}

  /** 服务端总开关是否打开（未打开时 trusted 工具直接回退注入路径）。 */
  get available(): boolean {
    return this.enabled;
  }

  /** 连接/重连客户端上报的 CDP 端点。失败返回 false（不抛错）。 */
  async connect(endpoint: string): Promise<boolean> {
    if (!this.enabled || !endpoint) return false;
    if (this.browser && this.endpoint === endpoint && this.browser.isConnected()) {
      return true;
    }
    this.connecting ??= this._connect(endpoint).finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  async _connect(endpoint: string): Promise<boolean> {
    try {
      await this.close();
      const { chromium } = await import("playwright");
      this.browser = await chromium.connectOverCDP(endpoint, { timeout: 5000 });
      this.endpoint = endpoint;
      return true;
    } catch {
      this.browser = undefined;
      this.endpoint = "";
      return false;
    }
  }

  /** 取最近活动的页面（无页面返回 null）。 */
  private async activePage(): Promise<Page | null> {
    const browser = this.browser;
    if (!browser || !browser.isConnected()) return null;
    const contexts = browser.contexts();
    if (contexts.length === 0) return null;
    const pages = contexts.flatMap((c) => c.pages());
    if (pages.length === 0) return null;
    return pages[pages.length - 1];
  }

  /** Agent 曾导航过的页面（closePage 后保留现场不关闭——「留痕」）。 */
  private readonly agentTouchedPages = new WeakSet<Page>();

  /** 面板页占用队列：并发流程（多平台比价）串行使用同一个可见页，
   *  **绝不 newPage 兜底**——WebView2 下 CDP 新建 target 会生成独立原生
   *  弹窗窗口（2026-10-25 用户实测「弹出独立浏览器界面」的根因）。 */
  private panelChain: Promise<void> = Promise.resolve();

  /**
   * 在用户可见的内置浏览器里打开目标 URL。
   *
   * WebView2 与桌面 Chromium 不同：CDP 新建的 target 不绑定任何 Flutter
   * 控制器、用户**看不见**（还会生成独立弹窗窗口）。因此这里只用面板
   * 现有可见页导航（行迹等宿主页面绝不碰），并发时排队等上一个流程释放；
   * 任务结束后页面**留在现场**（不回主页不关闭——「留痕」），closePage
   * 只做队列释放。
   */
  async openPage(url: string, opts: { timeoutMs?: number } = {}): Promise<Page | null> {
    const timeout = opts.timeoutMs ?? 20_000;
    // 排队：等上一个持有者释放（closePage），最多等 90s，超时放弃让调用方
    // 走 headless+Cookie 兜底（无 Cookie 时如实报不可用，不弹窗）。
    const prev = this.panelChain;
    let release!: () => void;
    this.panelChain = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gotSlot = await Promise.race([
      prev.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 90_000)),
    ]);
    if (!gotSlot) return null;
    try {
      const browser = this.browser;
      if (!browser || !browser.isConnected()) return null;
      const context = browser.contexts()[0];
      if (!context) return null;
      // 面板页 = 行迹等宿主页面之外的目标（优先主页态，其次任意面板目标）
      const panelPage =
        context.pages().find((p) => !p.isClosed() && p.url() === "about:blank") ??
        context.pages().find((p) => !p.isClosed() && !p.url().includes("travel-map"));
      if (!panelPage) return null;
      // 弹窗拦截（每个页面只装一次）：window.open 与 target=_blank 一律改为
      // 当前页内导航，根除「独立浏览器窗口」。注意初始化函数体内不用任何
      // 函数表达式（tsx esbuild keepNames 会注入 __name 导致浏览器端
      // ReferenceError，实测踩坑）——这里用具名函数声明。
      if (!this.agentTouchedPages.has(panelPage)) {
        await panelPage
          .addInitScript(() => {
            function __sbOpen(u: string | undefined): null {
              try {
                if (u) window.location.href = String(u);
              } catch (e) {
                /* ignore */
              }
              return null;
            }
            window.open = __sbOpen as typeof window.open;
            function __sbClick(e: MouseEvent): void {
              const t = e.target as HTMLElement | null;
              const a = t && t.closest ? (t.closest('a[target="_blank"]') as HTMLAnchorElement | null) : null;
              if (a && a.href) {
                e.preventDefault();
                window.location.href = a.href;
              }
            }
            document.addEventListener("click", __sbClick, true);
          })
          .catch(() => {});
        this.agentTouchedPages.add(panelPage);
      }
      await panelPage.goto(url, { waitUntil: "domcontentloaded", timeout });
      return panelPage;
    } catch {
      release();
      return null;
    }
    // 成功路径不 release——closePage（lease 释放时）负责；页面留痕不回主页。
  }

  /**
   * 释放 openPage 拿到的页面租约。**留痕语义：不导航回主页、不关闭**——
   * Agent 打开的页面留在面板里供用户回看；只释放面板占用队列。
   */
  async closePage(page: Page): Promise<void> {
    void page;
    this.panelChain = this.panelChain.then(() => {});
  }

  /** 可信点击（Playwright 定位引擎 + 真实输入事件）。 */
  async click(opts: {
    text?: string;
    selector?: string;
    timeoutMs?: number;
  }): Promise<{ ok: boolean; error?: string }> {
    const page = await this.activePage();
    if (!page) return { ok: false, error: "CDP 桥未连接或无活动页面" };
    const timeout = opts.timeoutMs ?? 8000;
    try {
      const locator = opts.text
        ? page.getByText(opts.text, { exact: false }).first()
        : opts.selector
          ? page.locator(opts.selector).first()
          : null;
      if (!locator) return { ok: false, error: "缺少 text/selector" };
      await locator.click({ timeout });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: `可信点击失败：${String(e).slice(0, 200)}` };
    }
  }

  /** 可信输入（真实键盘事件；对受控组件/风控表单更友好）。 */
  async type(opts: {
    text: string;
    selector?: string;
    submit?: boolean;
    timeoutMs?: number;
  }): Promise<{ ok: boolean; error?: string }> {
    const page = await this.activePage();
    if (!page) return { ok: false, error: "CDP 桥未连接或无活动页面" };
    const timeout = opts.timeoutMs ?? 8000;
    try {
      const locator = opts.selector
        ? page.locator(opts.selector).first()
        : page.locator("input:visible, textarea:visible").first();
      await locator.click({ timeout });
      await locator.fill(opts.text, { timeout });
      if (opts.submit) await locator.press("Enter", { timeout });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: `可信输入失败：${String(e).slice(0, 200)}` };
    }
  }

  async close(): Promise<void> {
    try {
      if (this.browser?.isConnected()) await this.browser.close();
    } catch {
      // ignore
    }
    this.browser = undefined;
    this.endpoint = "";
  }
}
