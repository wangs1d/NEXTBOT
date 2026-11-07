/**
 * 兼容出口：页面获取已上收到通用浏览器层 `services/browser-runtime/`。
 *
 * 购物流程仍通过 ShoppingBrowserExecutor 取页，但内部就是 BrowserRuntime
 * （内置浏览器优先 / 无头+Cookie 兜底 / 面板租约同一套），不再单独维护一份。
 */
import type { ImportedBrowserCookie } from "../browser-session-types.js";
import {
  BrowserRuntime,
  type BrowserPageLease,
  type BrowserRuntimeDeps,
  loadPlaywright,
  toPlaywrightCookies,
} from "../browser-runtime/browser-runtime.js";

export { loadPlaywright, toPlaywrightCookies };
// 类名兼容（值/类型双导出）：旧代码里 `instanceof ShoppingPageUnavailableError` 与
// `as ShoppingPageUnavailableError` 都继续可用。
export { BrowserPageUnavailableError as ShoppingPageUnavailableError } from "../browser-runtime/browser-runtime.js";

export type ShoppingPageLease = BrowserPageLease;
export type ShoppingBrowserExecutorDeps = BrowserRuntimeDeps;

export type AcquireShoppingPageOptions = {
  /** headless 兜底时注入的授权 Cookie（shared 模式用用户自身登录态，忽略）。 */
  cookies?: ImportedBrowserCookie[];
  /** 允许「无 Cookie 匿名打开 + 扫码登录」交互式兜底。 */
  interactiveLogin?: boolean;
  /** Playwright+Cookie 优先，内置浏览器兜底（比价/后台取数用）。 */
  preferHeadless?: boolean;
  /** 匿名站点允许无 Cookie 直接开无头浏览器（苏宁/什么值得买等免登录取价源）。 */
  allowAnonymous?: boolean;
};

/** 购物侧的薄封装：保留旧签名 (actorId, platform, targetUrl, opts)。 */
export class ShoppingBrowserExecutor {
  private readonly runtime: BrowserRuntime;

  constructor(deps: ShoppingBrowserExecutorDeps) {
    this.runtime = new BrowserRuntime(deps);
  }

  canUseSharedBrowser(actorId: string): boolean {
    return this.runtime.canUseSharedBrowser(actorId);
  }

  tryOpenSharedPage(actorId: string, targetUrl: string): Promise<ShoppingPageLease | null> {
    return this.runtime.tryOpenSharedPage(actorId, targetUrl);
  }

  acquirePage(
    actorId: string,
    platform: string,
    targetUrl: string,
    opts: AcquireShoppingPageOptions = {},
  ): Promise<ShoppingPageLease> {
    return this.runtime.acquirePage(actorId, targetUrl, {
      siteId: platform,
      cookies: opts.cookies,
      interactiveLogin: opts.interactiveLogin,
      preferHeadless: opts.preferHeadless,
      allowAnonymous: opts.allowAnonymous,
    });
  }
}
