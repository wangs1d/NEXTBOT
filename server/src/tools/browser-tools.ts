import { resolveActorId } from "../agent/actor-id.js";
import { startBrowserPreviewStream } from "../services/browser-preview-stream.js";
import type { BrowserSessionService } from "../services/browser-session-service.js";
import { fetchPageWithCookies } from "../services/browser-page-fetch.js";
import { isBrowserSessionSiteId, type BrowserSessionSiteId } from "../services/browser-session-sites.js";
import type { ToolRegistry } from "./tool-registry.js";

export function registerBrowserTools(
  registry: ToolRegistry,
  browserSessionService: BrowserSessionService,
): void {
  registry.register("browser.session.list", async (_input, ctx) => {
    const actorId = resolveActorId(ctx);
    const sites = await browserSessionService.listStatuses(actorId);
    const catalog = await browserSessionService.listSiteCatalog();
    return {
      ok: true,
      sites,
      catalog,
      importHint:
        "用户须在客户端调用 POST /integrations/browser-sessions/import 导入 Cookie（浏览器扩展导出 JSON），再用 POST .../consent 设置 agentAllowed。",
    };
  });

  registry.register("browser.fetch_page", async (input, ctx) => {
    const actorId = resolveActorId(ctx);
    const url = String(input.url ?? "").trim();
    if (!url) return { ok: false, error: "缺少 url" };
    if (!/^https:\/\//i.test(url)) {
      return { ok: false, error: "仅支持 https URL" };
    }

    let siteId: BrowserSessionSiteId | null = null;
    const rawSite = String(input.siteId ?? "").trim();
    if (rawSite) {
      if (!isBrowserSessionSiteId(rawSite)) {
        return { ok: false, error: `未知 siteId: ${rawSite}` };
      }
      siteId = rawSite;
    } else {
      siteId = browserSessionService.resolveSiteForUrl(url);
    }
    if (!siteId) {
      return {
        ok: false,
        error: "URL 不在支持的站点列表（携程/淘宝/京东/去哪儿/飞猪）",
      };
    }

    browserSessionService.assertUrlAllowedForSite(url, siteId);

    let cookies;
    try {
      cookies = await browserSessionService.getCookiesForAgent(actorId, siteId);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, error: message, siteId };
    }

    const result = await fetchPageWithCookies(url, cookies, {
      // 云端浏览器画面（2026-11-14）：手机端没有可见浏览器，抓页过程也推到悬浮窗。
      onPage: (page) =>
        startBrowserPreviewStream(ctx, page, { mode: "headless", sessionId: `fetch-${siteId}` }).stop,
    });
    return {
      ok: result.ok,
      siteId,
      url: result.url,
      title: result.title,
      textPreview: result.textPreview,
      priceHints: result.priceHints,
      engine: result.engine,
      error: result.error,
      disclaimer:
        "价格为页面抓取线索，可能含会员/券后价；下单与支付须用户本人确认。",
    };
  });
}
