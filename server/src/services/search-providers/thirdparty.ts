import type { InfoSearchItem } from "../info-hub-service.js";
import type { ImageApiItem, SearchApiConfig, SearchProvider } from "../search-api-provider.js";
import { isObj, requestJson, str, toItems, withSource } from "./shared.js";

/**
 * 第三方搜索提供方实现（tavily / serper / bing / jina）。
 *
 * 与 AnySearch 实现同一 SearchProvider 契约，作为主后端不可用时的备选切换项；
 * 相互独立、可整体替换，新增备选后端 = 在本文件（或平级新文件）实现契约 + 门面注册一行。
 */

// ─────────────────────────────────────────────────────────────────────────────
// Tavily
// ─────────────────────────────────────────────────────────────────────────────

function createTavilyProvider(cfg: SearchApiConfig): SearchProvider {
  return {
    name: "Tavily",
    requiresApiKey: true,
    async searchWeb(keyword, limit): Promise<InfoSearchItem[]> {
      const body = {
        api_key: cfg.apiKey,
        query: keyword,
        search_depth: "advanced" as const,
        max_results: Math.max(limit, 5),
        include_answer: false,
        include_raw_content: false,
      };
      const json = await requestJson(
        "https://api.tavily.com/search",
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
        cfg.timeoutMs,
      );
      if (!isObj(json)) return [];
      const results = Array.isArray(json.results) ? (json.results as unknown[]) : [];
      const mapped = results
        .filter(isObj)
        .map((r) => ({
          title: str(r.title),
          url: str(r.url),
          snippet: str(r.content),
          date: str(r.published_date),
        }));
      return toItems(mapped, "Tavily", limit);
    },
    async searchImages(keyword, limit): Promise<ImageApiItem[]> {
      const json = await requestJson(
        "https://api.tavily.com/search",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            api_key: cfg.apiKey,
            query: keyword,
            max_results: Math.max(limit, 5),
            include_answer: false,
            include_raw_content: false,
            include_images: true,
          }),
        },
        cfg.timeoutMs,
      );
      if (!isObj(json)) return [];
      const images = Array.isArray(json.images) ? (json.images as unknown[]) : [];
      const out: ImageApiItem[] = [];
      const seen = new Set<string>();
      for (const img of images) {
        const url = str(img);
        const low = url.toLowerCase();
        if (!url || !/^https?:\/\//i.test(url) || seen.has(low)) continue;
        seen.add(low);
        out.push({ title: keyword, mediaUrl: url, thumbnailUrl: url });
        if (out.length >= limit) break;
      }
      return out.length > 0 ? withSource(out, "Tavily") : [];
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Serper（Google 代理）
// ─────────────────────────────────────────────────────────────────────────────

function createSerperProvider(cfg: SearchApiConfig): SearchProvider {
  return {
    name: "Serper",
    requiresApiKey: true,
    async searchWeb(keyword, limit): Promise<InfoSearchItem[]> {
      const json = await requestJson(
        "https://google.serper.dev/search",
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": cfg.apiKey },
          body: JSON.stringify({ q: keyword, num: Math.max(limit, 10), gl: "cn", hl: "zh-cn" }),
        },
        cfg.timeoutMs,
      );
      if (!isObj(json)) return [];
      const organic = Array.isArray(json.organic) ? (json.organic as unknown[]) : [];
      const mapped = organic.filter(isObj).map((r) => ({
        title: str(r.title),
        url: str(r.link),
        snippet: str(r.snippet),
        date: str(r.date),
      }));
      return toItems(mapped, "Serper", limit);
    },
    async searchImages(keyword, limit): Promise<ImageApiItem[]> {
      const json = await requestJson(
        "https://google.serper.dev/images",
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": cfg.apiKey },
          body: JSON.stringify({ q: keyword, num: Math.max(limit, 10), gl: "cn", hl: "zh-cn" }),
        },
        cfg.timeoutMs,
      );
      if (!isObj(json)) return [];
      const images = Array.isArray(json.images) ? (json.images as unknown[]) : [];
      const out: ImageApiItem[] = [];
      const seen = new Set<string>();
      for (const item of images) {
        if (!isObj(item)) continue;
        const mediaUrl = str(item.imageUrl);
        const low = mediaUrl.toLowerCase();
        if (!mediaUrl || !/^https?:\/\//i.test(mediaUrl) || seen.has(low)) continue;
        seen.add(low);
        out.push({
          title: str(item.title) || keyword,
          mediaUrl,
          thumbnailUrl: str(item.thumbnailUrl) || mediaUrl,
          pageUrl: str(item.link),
        });
        if (out.length >= limit) break;
      }
      return out.length > 0 ? withSource(out, "Serper") : [];
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Bing Web Search API
// ─────────────────────────────────────────────────────────────────────────────

function createBingProvider(cfg: SearchApiConfig): SearchProvider {
  return {
    name: "Bing API",
    requiresApiKey: true,
    async searchWeb(keyword, limit): Promise<InfoSearchItem[]> {
      const url = `${cfg.bingEndpoint}?q=${encodeURIComponent(keyword)}&count=${Math.max(limit, 10)}&mkt=zh-CN`;
      const json = await requestJson(
        url,
        { method: "GET", headers: { "ocp-apim-subscription-key": cfg.apiKey } },
        cfg.timeoutMs,
      );
      if (!isObj(json)) return [];
      const webPages = json.webPages;
      if (!isObj(webPages)) return [];
      const value = Array.isArray(webPages.value) ? (webPages.value as unknown[]) : [];
      const mapped = value.filter(isObj).map((r) => ({
        title: str(r.name),
        url: str(r.url),
        snippet: str(r.snippet),
        date: str(r.datePublished),
      }));
      return toItems(mapped, "Bing API", limit);
    },
    async searchImages(keyword, limit): Promise<ImageApiItem[]> {
      // 由已配置的 Bing 搜索端点推导图片端：`.../search` → `.../images/search`
      const imageEndpoint = cfg.bingEndpoint.replace(/\/search$/, "/images/search");
      const url = `${imageEndpoint}?q=${encodeURIComponent(keyword)}&count=${Math.max(limit, 10)}&mkt=zh-CN`;
      const json = await requestJson(
        url,
        { method: "GET", headers: { "ocp-apim-subscription-key": cfg.apiKey } },
        cfg.timeoutMs,
      );
      if (!isObj(json)) return [];
      const value = Array.isArray(json.value) ? (json.value as unknown[]) : [];
      const out: ImageApiItem[] = [];
      const seen = new Set<string>();
      for (const item of value) {
        if (!isObj(item)) continue;
        const mediaUrl = str(item.contentUrl);
        const low = mediaUrl.toLowerCase();
        if (!mediaUrl || !/^https?:\/\//i.test(mediaUrl) || seen.has(low)) continue;
        seen.add(low);
        out.push({
          title: str(item.name) || keyword,
          mediaUrl,
          thumbnailUrl: str(item.thumbnailUrl) || mediaUrl,
          pageUrl: str(item.hostPageUrl),
        });
        if (out.length >= limit) break;
      }
      return out.length > 0 ? withSource(out, "Bing API") : [];
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Jina（免费搜索端点；无 key 也有基础额度，提供 key 可提额）
// ─────────────────────────────────────────────────────────────────────────────

function createJinaProvider(cfg: SearchApiConfig): SearchProvider {
  return {
    name: "Jina",
    requiresApiKey: false,
    async searchWeb(keyword, limit): Promise<InfoSearchItem[]> {
      const url = `https://s.jina.ai/${encodeURIComponent(keyword)}`;
      const headers: Record<string, string> = {
        accept: "application/json",
        "x-respond-with": "no-content",
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      };
      if (cfg.jinaKey) headers.authorization = `Bearer ${cfg.jinaKey}`;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
      try {
        const response = await fetch(url, { headers, signal: controller.signal });
        if (!response.ok) return [];
        const text = await response.text();
        if (!text) return [];
        // s.jina.ai 返回 JSON Lines：每行一个 JSON 对象，含 url / title / description
        const items: Array<{ title?: string; url?: string; snippet?: string; date?: string }> = [];
        for (const line of text.split("\n")) {
          const t = line.trim();
          if (!t) continue;
          try {
            const obj = JSON.parse(t) as Record<string, unknown>;
            if (!obj || typeof obj !== "object") continue;
            items.push({ title: str(obj.title), url: str(obj.url), snippet: str(obj.description), date: str(obj.date) });
          } catch {
            // 跳过不可解析行
          }
        }
        return toItems(items, "Jina", limit);
      } catch (e) {
        console.warn(
          `[SearchApi] Jina 请求异常/超时(${cfg.timeoutMs}ms) -> query  err=${(e as Error)?.message ?? e}`,
        );
        return [];
      } finally {
        clearTimeout(timer);
      }
    },
    // Jina 无图片搜索端点 → 不实现 searchImages，门面回退到爬图片网页兜底。
  };
}

export { createBingProvider, createJinaProvider, createSerperProvider, createTavilyProvider };
