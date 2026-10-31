/**
 * 内置浏览器报价执行器：把报价栈的 BrowserRunner 桥到用户可见的内置浏览器。
 *
 * 为什么需要它：商家站点（携程酒店/飞猪酒店）对匿名无头直接跳登录页，实测
 * 0 条价格；而内置浏览器就是用户自己的登录态（免 Cookie 导入、可人工接管）。
 * 这里只走可见浏览器一条路，不静默降级到无头——无头抓不到时如实报错，
 * 由调用方转告用户「打开内置浏览器并登录该站点后重试」。
 */

import type { Page } from "playwright";
import { resolveActorId } from "../../../agent/actor-id.js";
import type { ToolContext } from "../../../tools/tool-registry.js";
import type { BrowserResultLike, BrowserRunner } from "./browser-quote-source.js";

/** 可见浏览器开页器（ShoppingBrowserExecutor 的结构子集）。 */
export interface SharedPageOpener {
  canUseSharedBrowser(actorId: string): boolean;
  tryOpenSharedPage(
    actorId: string,
    targetUrl: string,
  ): Promise<{ page: Page; release: () => Promise<void> } | null>;
}

const UNAVAILABLE = "内置浏览器不可用（客户端未在线或未开启浏览器调试端口）";

export function createSharedBrowserRunner(opener: SharedPageOpener): BrowserRunner {
  const leases = new Map<string, { page: Page; release: () => Promise<void> }>();
  let seq = 0;

  return {
    async open(ctx: ToolContext, url: string): Promise<BrowserResultLike> {
      const actorId = resolveActorId(ctx);
      if (!actorId || !opener.canUseSharedBrowser(actorId)) {
        return { ok: false, error: UNAVAILABLE };
      }
      const lease = await opener.tryOpenSharedPage(actorId, url).catch(() => null);
      if (!lease) {
        return { ok: false, error: "内置浏览器打开页面失败（面板未能创建或导航超时）" };
      }
      const sessionId = `shared-${Date.now()}-${seq++}`;
      leases.set(sessionId, lease);
      return { ok: true, sessionId };
    },

    async extractText(
      _ctx: ToolContext,
      sessionId: string,
      _selector?: string,
    ): Promise<BrowserResultLike> {
      const lease = leases.get(sessionId);
      if (!lease) return { ok: false, error: `浏览器会话不存在：${sessionId}` };
      try {
        const text = (await lease.page.evaluate("document.body.innerText")) as unknown;
        return typeof text === "string" && text.trim()
          ? { ok: true, sessionId, text }
          : { ok: false, error: "页面正文为空（可能仍在加载或被拦截）" };
      } catch (e) {
        return { ok: false, error: `读取页面文本失败：${e instanceof Error ? e.message : String(e)}` };
      }
    },

    async close(_ctx: ToolContext, sessionId: string): Promise<unknown> {
      const lease = leases.get(sessionId);
      leases.delete(sessionId);
      if (!lease) return { ok: true };
      await lease.release().catch(() => {});
      return { ok: true };
    },
  };
}
