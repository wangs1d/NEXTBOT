/**
 * 必应图片检索（共享工具）
 *
 * 按地点名称抓取真实照片直链（必应图片 async 接口的 murl 字段，国内可达、无需 Key）。
 * 两个消费方：
 * - /travel-poi/details（页面补图，travel-map.ts）
 * - 行程媒体回填的必应兜底（travel-planning-service.ts：Wikimedia 盖不住的
 *   长尾 POI——酒店/小馆——由必应补，再经 media store 落地为本机资产）
 */

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

export async function fetchText(url: string, timeoutMs = 9000): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": BROWSER_UA },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/** 从必应图片 async 接口的 HTML 里解析照片直链（murl 字段，去重后最多 limit 条） */
export function parseBingMurls(html: string, limit = 6): string[] {
  const decoded = html.replace(/&quot;/g, '"');
  const urls = [...decoded.matchAll(/"murl":"(https?:\/\/[^"]+)"/g)].map((m) => m[1]);
  return [...new Set(urls)].slice(0, limit);
}

/** 必应图片：抓取该地点名称的真实照片直链（murl 字段，去重后最多 limit 条） */
export async function fetchBingPhotoUrls(name: string, limit = 6): Promise<string[]> {
  const html = await fetchText(
    `https://cn.bing.com/images/async?q=${encodeURIComponent(name)}&first=0&count=8&mmasync=1`,
  );
  return parseBingMurls(html, limit);
}
