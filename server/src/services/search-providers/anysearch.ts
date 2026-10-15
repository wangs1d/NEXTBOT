import type { InfoSearchItem } from "../info-hub-service.js";
import type { ImageApiItem, SearchApiConfig, SearchProvider } from "../search-api-provider.js";
import { isObj, requestJson, str, toItems, withSource } from "./shared.js";

/**
 * AnySearch 提供方实现（本项目运营方自运营的统一搜索后端）。
 *
 * 同一份实现同时服务「外接 API」与「本地部署」两种形态：端点由
 * ANYSEARCH_ENDPOINT 指定（默认官方 API），上层与契约均不感知部署位置。
 * 发行安装包默认指向云端代理（运营方 ECS，key 只存云端），因此本实现
 * 无 key 也可用（requiresApiKey=false）；直连官方端点而无 key 时由上游
 * 401 → 空结果 → 调用方降级爬虫兜底，行为仍正确。
 *
 * 网页搜索：POST /v1/search，Bearer 认证，返回 data.results[{ title, url, snippet, content }]，
 * 含清洗后的正文，对中文与垂直领域友好。
 *
 * 图片搜索：无独立端点，而是 /v1/search + tag={domain}.{sub_domain} 的垂直路由。
 * tag 由 GET /v1/sub-domains?domain=image 能力自发现（服务端灰度开放），
 * 或 ANYSEARCH_IMAGE_TAG 显式指定；未开放时返回 [] → 调用方回退必应爬页兜底。
 */

const ANYSEARCH_ENDPOINT =
  (process.env.ANYSEARCH_ENDPOINT ?? "").trim() || "https://api.anysearch.com/v1/search";
// 能力拓扑查询端点：与搜索端点同源（/v1/search → /v1/sub-domains）
const ANYSEARCH_SUB_DOMAINS_ENDPOINT = ANYSEARCH_ENDPOINT.replace(/\/v1\/search$/, "/v1/sub-domains");

const ANYSEARCH_IMAGE_PROBE_TTL_MS = 10 * 60 * 1000;
const ANYSEARCH_IMAGE_PROBE_TIMEOUT_MS = 2_500;
const ANYSEARCH_IMAGE_PROBE_DOMAINS = ["image", "images", "photo"] as const;
let anysearchImageProbe: { at: number; tag: string | null } | null = null;

/** 仅供测试：清空 AnySearch 图片能力探测缓存，隔离用例间的模块级状态。 */
export function resetAnySearchImageProbeForTests(): void {
  anysearchImageProbe = null;
}

/** AnySearch 请求头：无 key（云端代理形态）时不带 authorization 头。 */
function anysearchHeaders(cfg: SearchApiConfig): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
  return headers;
}

async function resolveAnySearchImageTag(cfg: SearchApiConfig): Promise<string | null> {
  const forced = (process.env.ANYSEARCH_IMAGE_TAG ?? "").trim();
  if (forced) return forced.toLowerCase() === "off" ? null : forced;

  if (anysearchImageProbe && Date.now() - anysearchImageProbe.at < ANYSEARCH_IMAGE_PROBE_TTL_MS) {
    return anysearchImageProbe.tag;
  }
  let tag: string | null = null;
  for (const domain of ANYSEARCH_IMAGE_PROBE_DOMAINS) {
    const json = await requestJson(
      `${ANYSEARCH_SUB_DOMAINS_ENDPOINT}?domain=${domain}`,
      { method: "GET", headers: anysearchHeaders(cfg) },
      ANYSEARCH_IMAGE_PROBE_TIMEOUT_MS,
    );
    if (!isObj(json)) break; // 端点不可达同样视为不可用：连续探测最多 3×2.5s 会拖垮本次调用预算
    if (json.code !== 0) break; // 能力拓扑服务端明确拒绝（未开放），无需再试其他域名
    const data = json.data;
    if (!isObj(data) || !Array.isArray(data.domains)) continue;
    const entry = data.domains.filter(isObj).find((d) => str(d.domain) === domain);
    const subs = entry && Array.isArray(entry.sub_domains) ? entry.sub_domains.filter(isObj) : [];
    const first = subs.map((s) => str(s.sub_domain)).find(Boolean);
    if (first) {
      tag = `${domain}.${first}`;
      break;
    }
  }
  anysearchImageProbe = { at: Date.now(), tag };
  if (!tag) {
    console.warn(
      `[SearchApi] AnySearch 图片垂直能力未开放（探测 ${ANYSEARCH_IMAGE_PROBE_DOMAINS.join("/")} 域均不可用），` +
        `search_images 暂走必应爬页兜底；能力开放后 ${Math.round(ANYSEARCH_IMAGE_PROBE_TTL_MS / 60_000)} 分钟内自动切换，` +
        `或设 ANYSEARCH_IMAGE_TAG=<tag> 强制启用`,
    );
  }
  return tag;
}

async function searchWeb(keyword: string, limit: number, cfg: SearchApiConfig): Promise<InfoSearchItem[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    const response = await fetch(ANYSEARCH_ENDPOINT, {
      method: "POST",
      headers: anysearchHeaders(cfg),
      body: JSON.stringify({
        query: keyword,
        max_results: Math.max(limit, 5),
        zone: cfg.anysearchZone === "intl" ? "intl" : "cn",
        language: cfg.anysearchLang,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      console.warn(
        `[SearchApi] AnySearch HTTP ${response.status} ${response.statusText} -> query="${keyword.slice(0, 40)}"`,
      );
      return [];
    }
    const text = await response.text();
    if (!text) {
      console.warn(`[SearchApi] AnySearch 响应为空 -> query="${keyword.slice(0, 40)}"`);
      return [];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      console.warn(`[SearchApi] AnySearch 响应非 JSON -> query="${keyword.slice(0, 40)}" body=${text.slice(0, 120)}`);
      return [];
    }
    if (!isObj(parsed)) return [];
    // 成功响应：code===0 且 data.results 为数组；非 0 视为业务失败
    const rec = parsed as Record<string, unknown>;
    if (rec.code !== 0) {
      console.warn(
        `[SearchApi] AnySearch 业务失败 code=${String(rec.code)} msg=${String(rec.message ?? "")} -> query="${keyword.slice(0, 40)}"`,
      );
      return [];
    }
    const data = rec.data;
    if (!isObj(data)) {
      console.warn(`[SearchApi] AnySearch 响应缺 data 字段 -> query="${keyword.slice(0, 40)}"`);
      return [];
    }
    const results = Array.isArray((data as Record<string, unknown>).results)
      ? ((data as Record<string, unknown>).results as unknown[])
      : [];
    const mapped = results.filter(isObj).map((r) => {
      const snippet = str(r.snippet);
      const content = str(r.content);
      return {
        title: str(r.title),
        url: str(r.url),
        snippet: snippet || content,
        // 尽力取发布时间：时效排序与证据块日期标注都依赖它；缺省保持空串
        date: str(r.publish_time) || str(r.publishedAt) || str(r.date) || str(r.publishTime) || str(r.time),
      };
    });
    return toItems(mapped, "AnySearch", limit);
  } catch (e) {
    // 静默吞异常曾让「API 实际不可达/超时」无任何日志，表现为 Agent 静默
    // 退到爬虫兜底、用户以为是没配 API（2026-09-12）。失败必须留痕。
    console.warn(
      `[SearchApi] AnySearch 请求异常/超时(${cfg.timeoutMs}ms) -> query="${keyword.slice(0, 40)}"  err=${(e as Error)?.message ?? e}`,
    );
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function searchImages(keyword: string, limit: number, cfg: SearchApiConfig): Promise<ImageApiItem[]> {
  const tag = await resolveAnySearchImageTag(cfg);
  if (!tag) return [];
  const json = await requestJson(
    ANYSEARCH_ENDPOINT,
    {
      method: "POST",
      headers: anysearchHeaders(cfg),
      body: JSON.stringify({
        query: keyword,
        // 官方约束 max_results 1–10
        max_results: Math.max(1, Math.min(10, limit)),
        tag,
        zone: cfg.anysearchZone === "intl" ? "intl" : "cn",
        language: cfg.anysearchLang,
      }),
    },
    cfg.timeoutMs,
  );
  if (!isObj(json)) return [];
  if (json.code !== 0) {
    console.warn(
      `[SearchApi] AnySearch 图片垂直失败 code=${String(json.code)} msg=${String(json.message ?? "")} tag=${tag} query="${keyword.slice(0, 40)}"`,
    );
    return [];
  }
  const data = json.data;
  if (!isObj(data) || !Array.isArray(data.results)) return [];
  const out: ImageApiItem[] = [];
  const seen = new Set<string>();
  for (const item of data.results) {
    if (!isObj(item)) continue;
    const rec = item as Record<string, unknown>;
    const mediaUrl =
      str(rec.image_url) || str(rec.imageUrl) || str(rec.media_url) || str(rec.mediaUrl) ||
      str(rec.thumbnail) || str(rec.thumbnail_url) || str(rec.url);
    const low = mediaUrl.toLowerCase();
    if (!mediaUrl || !/^https?:\/\//i.test(mediaUrl) || seen.has(low)) continue;
    seen.add(low);
    out.push({
      title: str(rec.title) || keyword,
      mediaUrl,
      thumbnailUrl:
        str(rec.thumbnail_url) || str(rec.thumbnailUrl) || str(rec.thumbnail) || mediaUrl,
      pageUrl: str(rec.page_url) || str(rec.pageUrl) || str(rec.source_url) || str(rec.link),
    });
    if (out.length >= limit) break;
  }
  return out.length > 0 ? withSource(out, "AnySearch") : [];
}

/** 创建 AnySearch 提供方实例（配置由门面从环境解析后注入）。 */
export function createAnySearchProvider(cfg: SearchApiConfig): SearchProvider {
  return {
    name: "AnySearch",
    // 无 key 可用：发行默认走云端代理（key 只存云端）；直连官方端点缺 key 时
    // 由上游 401 → 空结果降级，不在此前置拦截（拦截会把无 key 安装包判死）
    requiresApiKey: false,
    searchWeb: (keyword, limit) => searchWeb(keyword, limit, cfg),
    searchImages: (keyword, limit) => searchImages(keyword, limit, cfg),
  };
}
