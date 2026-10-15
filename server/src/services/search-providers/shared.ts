import type { InfoSearchItem } from "../info-hub-service.js";

/**
 * 搜索提供方共享工具：HTTP 请求 + 结果归一化。
 *
 * 本目录内各提供方实现（anysearch / thirdparty）共用；不依赖任何提供方，
 * 也不反向依赖门面模块（search-api-provider.ts），避免运行时循环导入。
 */

/** 各提供方原始结果条目的宽松形态，统一由 toItems 归一化校验。 */
export type RawSearchItem = {
  title?: string;
  url?: string;
  snippet?: string;
  date?: string;
};

export function isObj(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

export function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** 带 AbortController 超时的 JSON 请求。任何失败（HTTP 非 2xx/空体/坏 JSON/超时）→ null，由调用方降级。 */
export async function requestJson(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const label = `${init.method ?? "GET"} ${url}`;
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      console.warn(`[SearchApi] 请求失败 HTTP ${response.status} ${response.statusText} -> ${label}`);
      return null;
    }
    const text = await response.text();
    if (!text) {
      console.warn(`[SearchApi] 响应为空 -> ${label}`);
      return null;
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      console.warn(`[SearchApi] 响应非合法 JSON -> ${label}  body=${text.slice(0, 120)}`);
      return null;
    }
  } catch (e) {
    console.warn(`[SearchApi] 请求异常/超时(${timeoutMs}ms) -> ${label}  err=${(e as Error)?.message ?? e}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 原始条目 → 归一化 InfoSearchItem：过滤无标题/非法 URL，按 URL 去重，截断到 limit。 */
export function toItems(
  items: RawSearchItem[],
  source: string,
  limit: number,
): InfoSearchItem[] {
  const out: InfoSearchItem[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const title = (item.title ?? "").trim();
    const url = (item.url ?? "").trim();
    if (!title || !url || !/^https?:\/\//i.test(url)) continue;
    const key = url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      title: title.slice(0, 180),
      url,
      // 2026-09-03：220→400 字符。原上限只够一两句话，LLM 拿不到细节只能潦草收尾。
      snippet: (item.snippet ?? "").slice(0, 400),
      source,
      publishedAt: item.date,
    });
    if (out.length >= limit) break;
  }
  return out;
}

/** 给结果条目补 source 标注（已有则保留）。 */
export function withSource<T extends { source?: string }>(items: T[], source: string): T[] {
  return items.map((it) => ({ ...it, source: it.source || source }));
}
