import type { Page } from "playwright";

import type { ImportedBrowserCookie } from "./browser-session-types.js";

export type BrowserPageFetchResult = {
  ok: boolean;
  url: string;
  title: string;
  textPreview: string;
  priceHints: string[];
  engine: "playwright" | "fetch";
  error?: string;
};

export type BrowserPageFetchOptions = {
  waitMs?: number;
  /**
   * 页面已导航完成时的钩子（2026-11-14）：调用方可在这里挂预览推流等旁路能力。
   * 返回的清理函数在页面关闭前调用。
   */
  onPage?: (page: Page) => void | (() => void);
};

const PRICE_PATTERNS = [
  /¥\s*[\d,]+(?:\.\d{1,2})?/g,
  /[\d,]{2,}(?:\.\d{1,2})?\s*元/g,
  /"price"\s*:\s*"?([\d.]+)"?/gi,
  /data-price=["']([\d.]+)["']/gi,
];

export async function fetchPageWithCookies(
  url: string,
  cookies: ImportedBrowserCookie[],
  opts?: BrowserPageFetchOptions,
): Promise<BrowserPageFetchResult> {
  const playwright = await tryLoadPlaywright();
  if (playwright) {
    return playwrightFetch(url, cookies, opts?.waitMs ?? 12_000, opts?.onPage);
  }
  return fetchWithCookieHeader(url, cookies);
}

async function tryLoadPlaywright(): Promise<typeof import("playwright") | null> {
  try {
    return await import("playwright");
  } catch {
    return null;
  }
}

async function playwrightFetch(
  url: string,
  cookies: ImportedBrowserCookie[],
  waitMs: number,
  onPage?: (page: Page) => void | (() => void),
): Promise<BrowserPageFetchResult> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-blink-features=AutomationControlled"],
  });
  try {
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      locale: "zh-CN",
    });
    await context.addCookies(playwrightCookies(url, cookies));
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: waitMs });
    // 页面已落定：挂上旁路（推流等），清理函数在关页前调用。
    const cleanup = onPage?.(page);
    try {
      await page.waitForTimeout(Math.min(4_000, waitMs / 3));
      const title = (await page.title()) || "";
      const text = await page.evaluate(() => document.body?.innerText ?? "");
      const textPreview = text.replace(/\s+/g, " ").trim().slice(0, 8_000);
      return {
        ok: true,
        url,
        title,
        textPreview,
        priceHints: extractPriceHints(textPreview),
        engine: "playwright",
      };
    } finally {
      cleanup?.();
      await context.close();
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      url,
      title: "",
      textPreview: "",
      priceHints: [],
      engine: "playwright",
      error: message.includes("Executable doesn't exist")
        ? `${message} — 请在 server 目录执行: npx playwright install chromium`
        : message,
    };
  } finally {
    await browser.close();
  }
}

function playwrightCookies(
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

async function fetchWithCookieHeader(
  url: string,
  cookies: ImportedBrowserCookie[],
): Promise<BrowserPageFetchResult> {
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        cookie: cookieHeader,
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "zh-CN,zh;q=0.9",
      },
    });
    const html = await response.text();
    const title = extractHtmlTitle(html);
    const textPreview = htmlToText(html).slice(0, 8_000);
    return {
      ok: response.ok,
      url,
      title,
      textPreview,
      priceHints: extractPriceHints(textPreview + "\n" + html.slice(0, 20_000)),
      engine: "fetch",
      error: response.ok ? undefined : `HTTP ${response.status}`,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      url,
      title: "",
      textPreview: "",
      priceHints: [],
      engine: "fetch",
      error: message,
    };
  } finally {
    clearTimeout(timer);
  }
}

export function extractPriceHints(text: string): string[] {
  const found = new Set<string>();
  for (const re of PRICE_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null = null;
    while ((m = re.exec(text))) {
      const hit = (m[0] || m[1] || "").trim();
      if (hit.length >= 2 && hit.length <= 32) found.add(hit);
      if (found.size >= 24) break;
    }
    if (found.size >= 24) break;
  }
  return [...found];
}

function extractHtmlTitle(html: string): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? decodeHtmlEntities(m[1].replace(/<[^>]+>/g, "").trim()) : "";
}

function htmlToText(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
