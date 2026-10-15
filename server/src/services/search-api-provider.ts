import type { InfoSearchItem } from "./info-hub-service.js";
import { createAnySearchProvider, resetAnySearchImageProbeForTests } from "./search-providers/anysearch.js";
import {
  createBingProvider,
  createJinaProvider,
  createSerperProvider,
  createTavilyProvider,
} from "./search-providers/thirdparty.js";

/**
 * 搜索 API 抽象层：提供方无关的统一搜索入口。
 *
 * 分层结构（上层调用方只依赖本文件的门面与归一化结果类型）：
 *
 *   上层（domestic-web-providers / upstream-search-service / 各工具链）
 *     └─ searchViaSearchApi / searchImagesViaSearchApi（本文件门面）
 *          └─ SearchProvider 契约（注册表解析出的具体实现）
 *               ├─ search-providers/anysearch.ts   主后端：运营方自运营的 AnySearch
 *               └─ search-providers/thirdparty.ts  备选：tavily / serper / bing / jina
 *
 * 搜索后端由本项目运营方统一提供（当前为 AnySearch）：外接 API 与本地部署
 * 只是同一实现的不同端点（ANYSEARCH_ENDPOINT），上层与契约均不感知；更换
 * 后端形态/换实现只动 search-providers/ 与环境变量，上层零改动。新后端接
 * 入 = 实现一份 SearchProvider 契约 + registerSearchProvider 注册一行。
 *
 * 行为约定：
 *   - 未配置（SEARCH_API_PROVIDER=none / 缺 key）→ null（网页）/ []（图片），调用方走多引擎爬网页兜底
 *   - 已配置但请求失败 → []（优雅降级）
 *   - 成功 → 去重归一化后的 InfoSearchItem[] / ImageApiItem[]（不超过 limit）
 */

export type SearchApiProviderType = "tavily" | "serper" | "bing" | "jina" | "anysearch" | "none";

export type SearchApiConfig = {
  provider: SearchApiProviderType;
  /** 通用 key（Tavily / Serper / Bing / AnySearch） */
  apiKey: string;
  /** Jina 专属 key（可空，免费额度无需 key） */
  jinaKey: string;
  /** Bing 自定义端点（可选） */
  bingEndpoint: string;
  /** AnySearch zone（cn | intl） */
  anysearchZone: string;
  /** AnySearch 偏好语言（如 zh-CN） */
  anysearchLang: string;
  /** 单次请求超时（ms） */
  timeoutMs: number;
};

/** 图片搜索条目（归一化结果，与提供方无关）。 */
export type ImageApiItem = {
  title: string;
  mediaUrl: string;
  thumbnailUrl?: string;
  pageUrl?: string;
  source?: string;
};

/**
 * 搜索提供方契约：上层只见契约不见实现。
 *   - name：结果 source 标注与日志用
 *   - requiresApiKey：false = 无 key 可用（如 Jina 免费额度）
 *   - searchWeb：必选能力，失败/空 → []
 *   - searchImages：可选能力，未实现时门面回退爬图片网页兜底
 */
export type SearchProvider = {
  readonly name: string;
  readonly requiresApiKey: boolean;
  searchWeb(keyword: string, limit: number): Promise<InfoSearchItem[]>;
  searchImages?(keyword: string, limit: number): Promise<ImageApiItem[]>;
};

export type SearchProviderFactory = (cfg: SearchApiConfig) => SearchProvider;

// 搜索 API 超时：必须小于 search_web 的工具执行预算（TOOL_TIMEOUT_SEARCH_MS，默认
// 6500ms）。曾默认 8000ms > 6500ms——AnySearch 慢响应时整个 search_web 在 6.5s 被外层
// 击杀（轨迹日志实证「工具执行超时(6500ms)」），API 结果与爬虫兜底全部丢失。
// 默认 5000ms 给 API，剩余预算留给爬虫兜底；SEARCH_API_TIMEOUT_MS 可调。
const SEARCH_API_TIMEOUT_MS =
  Number.parseInt(process.env.SEARCH_API_TIMEOUT_MS ?? "5000", 10) || 5000;
const DEFAULT_BING_ENDPOINT = "https://api.cognitive.microsoft.com/bing/v7.0/search";

// ─────────────────────────────────────────────────────────────────────────────
// 提供方注册表：内置实现注册于文件尾部；新后端（如本地部署的搜索服务）在此注册。
// ─────────────────────────────────────────────────────────────────────────────

const providerFactories = new Map<SearchApiProviderType, SearchProviderFactory>();

/** 注册搜索后端实现。重复注册按覆盖处理（便于测试与本地替换）。 */
export function registerSearchProvider(type: SearchApiProviderType, factory: SearchProviderFactory): void {
  providerFactories.set(type, factory);
}

function normalizeProvider(raw: string | undefined): SearchApiProviderType {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "tavily" || v === "serper" || v === "bing" || v === "jina" || v === "anysearch") return v;
  return "none";
}

export function getSearchApiConfig(env: NodeJS.ProcessEnv = process.env): SearchApiConfig {
  return {
    provider: normalizeProvider(env.SEARCH_API_PROVIDER),
    apiKey: (env.SEARCH_API_KEY ?? "").trim(),
    jinaKey: (env.JINA_API_KEY ?? "").trim(),
    bingEndpoint: (env.BING_SEARCH_API_ENDPOINT ?? DEFAULT_BING_ENDPOINT).trim() || DEFAULT_BING_ENDPOINT,
    anysearchZone: (env.ANYSEARCH_ZONE ?? "cn").trim() || "cn",
    anysearchLang: (env.ANYSEARCH_LANG ?? "zh-CN").trim() || "zh-CN",
    timeoutMs: SEARCH_API_TIMEOUT_MS,
  };
}

/** 按配置从注册表实例化提供方；none/未注册 → null。key 校验由门面按场景完成。 */
export function resolveSearchProvider(cfg: SearchApiConfig): SearchProvider | null {
  if (cfg.provider === "none") return null;
  const factory = providerFactories.get(cfg.provider);
  if (!factory) return null;
  return factory(cfg);
}

// ─────────────────────────────────────────────────────────────────────────────
// 门面：上层唯一入口（签名与降级语义自抽象前保持不变）
// ─────────────────────────────────────────────────────────────────────────────

/** 通过搜索 API 搜索。未配置 → null；配置但失败 → []；成功 → 结果数组。 */
export async function searchViaSearchApi(
  query: string,
  limit: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<InfoSearchItem[] | null> {
  const keyword = query.trim();
  if (!keyword) return [];
  const cfg = getSearchApiConfig(env);
  const boundedLimit = Math.max(1, Math.min(20, Math.floor(limit) || 8));

  if (cfg.provider === "none") {
    console.warn(`[SearchApi] 未配置 SEARCH_API_PROVIDER(或值非法)，联网搜索走爬虫兜底 -> query="${keyword.slice(0, 40)}"`);
    return null;
  }
  const provider = resolveSearchProvider(cfg);
  if (!provider) return null;
  if (provider.requiresApiKey && !cfg.apiKey) {
    console.warn(`[SearchApi] provider=${cfg.provider} 已配置但缺少 SEARCH_API_KEY，走爬虫兜底 -> query="${keyword.slice(0, 40)}"`);
    return null;
  }

  console.log(`[SearchApi] 请求 ${cfg.provider}  查询="${keyword.slice(0, 40)}"  limit=${boundedLimit}`);
  const result = await provider.searchWeb(keyword, boundedLimit);
  // 可观测性：已配置的 API 返回 0 条（请求失败/业务失败/空结果）时显式告警。
  // 此前静默回退爬虫链，日志里完全看不出「配了 anysearch 却没走 anysearch」。
  if (result.length === 0) {
    console.warn(
      `[SearchApi] ${cfg.provider} 返回 0 条结果（请求失败/业务失败/空结果），回退爬虫链 -> query="${keyword.slice(0, 40)}"`,
    );
  }
  return result;
}

/**
 * 通过已接入的搜索 API 搜图。未配置 → []；配置但失败 → []；成功 → 图片项数组。
 * 与 searchViaSearchApi 同源：优先用接入的 provider 拿真实图源 URL，爬图片网页仅作兜底。
 */
export async function searchImagesViaSearchApi(
  query: string,
  limit: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ImageApiItem[]> {
  const keyword = query.trim();
  if (!keyword) return [];
  const cfg = getSearchApiConfig(env);
  const boundedLimit = Math.max(1, Math.min(12, Math.floor(limit) || 8));

  if (cfg.provider === "none") {
    console.warn(`[SearchApi] 未配置 SEARCH_API_PROVIDER(或值非法)，图片搜索走爬虫兜底 -> query="${keyword.slice(0, 40)}"`);
    return [];
  }
  const provider = resolveSearchProvider(cfg);
  if (!provider) return [];
  if (provider.requiresApiKey && !cfg.apiKey) {
    console.warn(`[SearchApi] provider=${cfg.provider} 已配置但缺少 SEARCH_API_KEY，图片搜索走爬虫兜底 -> query="${keyword.slice(0, 40)}"`);
    return [];
  }
  if (!provider.searchImages) {
    // 提供方无图片能力（如 Jina）→ 回退到爬图片网页兜底。
    return [];
  }

  console.log(`[SearchApi] 图片搜索 ${cfg.provider}  查询="${keyword.slice(0, 40)}"  limit=${boundedLimit}`);
  return provider.searchImages(keyword, boundedLimit);
}

// 内置提供方注册。AnySearch 为主后端（运营方统一提供），其余为备选。
registerSearchProvider("anysearch", createAnySearchProvider);
registerSearchProvider("tavily", createTavilyProvider);
registerSearchProvider("serper", createSerperProvider);
registerSearchProvider("bing", createBingProvider);
registerSearchProvider("jina", createJinaProvider);

export { resetAnySearchImageProbeForTests };
