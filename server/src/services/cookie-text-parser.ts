import type { ImportedBrowserCookie } from "./browser-session-types.js";

/**
 * 用户粘贴的 Cookie 文本 → ImportedBrowserCookie[]（2026-11-21）。
 *
 * 手动导入是扫码授权被平台风控拦死后的替代登录入口：用户在**自己**的浏览器
 * 里登录平台，导出 Cookie 粘贴进来。真实用户手里的格式五花八门，这里宽容
 * 支持三种：
 *   1. Header 串：`k=v; k2=v2`（可带 `Cookie:` 前缀、可多行）——F12 里直接
 *      复制请求标头得到的就是这种，占绝大多数；
 *   2. JSON 数组：`[{ name, value, domain, ... }]`——Cookie 导出插件
 *      （EditThisCookie 等）的格式；
 *   3. 单条 JSON 对象。
 *
 * 域名刻意留空：header 串本身不含域名；`normalizeCookies` 不过滤无域名项，
 * `toPlaywrightCookies` 会用目标页 host 兜底，注入与落库两条路都能走。
 */
export type CookieTextParseResult =
  | { ok: true; cookies: ImportedBrowserCookie[] }
  | { ok: false; error: string };

export function parseCookieHeaderText(raw: string): CookieTextParseResult {
  const text = (raw ?? "").trim();
  if (!text) {
    return { ok: false, error: "粘贴的内容是空的" };
  }

  // JSON 形态
  if (text.startsWith("[") || text.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, error: "看着像 JSON 但解析失败——请粘贴完整的 JSON 数组，或改粘「k=v; k2=v2」整串" };
    }
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    const cookies: ImportedBrowserCookie[] = [];
    for (const item of arr) {
      if (!item || typeof item !== "object") continue;
      const o = item as Record<string, unknown>;
      const name = String(o.name ?? "").trim();
      const value = String(o.value ?? "");
      if (!name) continue;
      cookies.push({
        name,
        value,
        ...(typeof o.domain === "string" && o.domain ? { domain: o.domain } : {}),
        ...(typeof o.path === "string" && o.path ? { path: o.path } : {}),
        ...(typeof o.expires === "number" ? { expires: o.expires } : {}),
        ...(typeof o.httpOnly === "boolean" ? { httpOnly: o.httpOnly } : {}),
        ...(typeof o.secure === "boolean" ? { secure: o.secure } : {}),
        ...(typeof o.sameSite === "string" && o.sameSite ? { sameSite: o.sameSite } : {}),
      });
    }
    if (cookies.length === 0) {
      return { ok: false, error: "JSON 里没有解析到任何 cookie（每条需要 name 和 value 字段）" };
    }
    return { ok: true, cookies };
  }

  // Header 串形态
  const body = text.replace(/^cookie\s*:\s*/i, "");
  const cookies: ImportedBrowserCookie[] = [];
  for (const seg of body.split(/[;\n]+/)) {
    const part = seg.trim();
    if (!part) continue;
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!name) continue;
    cookies.push({ name, value });
  }
  if (cookies.length === 0) {
    return {
      ok: false,
      error: "没解析到任何 cookie。请粘贴「k=v; k2=v2」这样的整串（F12 请求标头里的 Cookie），或 Cookie 导出插件的 JSON 数组",
    };
  }
  return { ok: true, cookies };
}
