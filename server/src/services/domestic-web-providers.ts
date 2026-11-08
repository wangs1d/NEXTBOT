import type { InfoSearchItem } from "./info-hub-service.js";
import { searchViaSearchApi } from "./search-api-provider.js";
import {
  applySearchFreshness,
  prependRecencyQueryVariants,
  type RssHealthMonitor,
} from "./search-enhancements.js";

const BING_CN_SEARCH = "https://cn.bing.com/search";
const DEFAULT_TIMEOUT_MS = 6_000;
const MAX_QUERY_VARIANTS = 6;

const DOMESTIC_TECH_RSS_FEEDS: Array<{ source: string; url: string }> = [
  { source: "36氪", url: "https://36kr.com/feed" },
  { source: "IT之家", url: "https://www.ithome.com/rss/" },
];

// 国内官方/主流媒体 RSS 源（实时性高，分钟级更新）
// 用于 fetchDomesticNews，补充必应 RSS 的实时性不足
// 分类覆盖：滚动新闻（综合）+ 重要新闻 + 国内 + 国际 + 财经 + 社会
const DOMESTIC_NEWS_RSS_FEEDS: Array<{ source: string; url: string }> = [
  { source: "中国新闻网滚动", url: "http://www.chinanews.com/rss/scroll-news.xml" },
  { source: "中国新闻网要闻", url: "http://www.chinanews.com/rss/importnews.xml" },
  { source: "中国新闻网国内", url: "http://www.chinanews.com/rss/china.xml" },
  { source: "中国新闻网国际", url: "http://www.chinanews.com/rss/world.xml" },
  { source: "中国新闻网财经", url: "http://www.chinanews.com/rss/finance.xml" },
  { source: "中国新闻网社会", url: "http://www.chinanews.com/rss/society.xml" },
  { source: "人民网时政", url: "http://www.people.com.cn/rss/politics.xml" },
  { source: "人民网国际", url: "http://www.people.com.cn/rss/world.xml" },
  { source: "人民网科技", url: "http://www.people.com.cn/rss/IT.xml" },
  // 注：环球网 rss.huanqiu.com 和联合早报 www.zaobao.com/rss/* 实测已失效（返回 HTML 而非 RSS XML），暂不接入
  // 央视网 news.cctv.com/rss/* 也已失效（404）
];

// HTML 新闻源（无 RSS，通过爬取列表页提取）
// URL 中的日期模式用于提取发布时间：
//   央视网: /2026/07/13/ARTIxxx.shtml
//   联合早报: /news/china/story20260712-9352905
//   新浪: /2026-07-13/doc-xxx.shtml
//   中国日报: /a/202607/13/WSxxx.html
//   光明网/中青网: /2026-07/13/content_xxx.htm(l)
//   海外网: /n/2026/0701/cxxx-xxx.html
const DOMESTIC_NEWS_HTML_FEEDS: Array<{ source: string; url: string; baseUrl: string }> = [
  // 精简到 6 个核心源（原 13 个），减少并行 fan-out 同时保持覆盖面
  // 央视网（官方媒体，首页覆盖最全）
  { source: "央视网", url: "https://news.cctv.com/", baseUrl: "https://news.cctv.com" },
  // 联合早报（境外华文媒体）
  { source: "联合早报", url: "https://www.zaobao.com.sg/news/china", baseUrl: "https://www.zaobao.com.sg" },
  // 新浪（门户，综合覆盖面广）
  { source: "新浪", url: "https://news.sina.com.cn/", baseUrl: "https://news.sina.com.cn" },
  // 网易（门户）
  { source: "网易", url: "https://news.163.com/", baseUrl: "https://news.163.com" },
  // 中国日报（官方媒体）
  { source: "中国日报", url: "https://cn.chinadaily.com.cn/", baseUrl: "https://cn.chinadaily.com.cn" },
  // 光明网（官方媒体）
  { source: "光明网", url: "https://news.gmw.cn/", baseUrl: "https://news.gmw.cn" },
];

/**
 * 网站域名注册表（用于动态源发现）
 * 当预定义源结果不足时，从已有搜索结果中识别网站域名，自动爬取相关页面。
 *
 * 分类策略：
 *   - news：新闻网站，爬取首页列表页（拿到比必应索引更新的新闻）
 *   - tech：技术社区，爬取搜索结果中的具体页面，提取相关文章链接
 *   - qa：问答网站，爬取搜索结果中的具体页面，提取相关问题链接
 *   - wiki：百科网站，爬取搜索结果中的具体页面，提取相关词条链接
 */
type SiteCategory = "news" | "tech" | "qa" | "wiki";

type SiteEntry = {
  domain: string;
  source: string;
  category: SiteCategory;
  /** 新闻类：首页 URL（列表页）；其他类：留空 */
  homepage?: string;
  baseUrl: string;
};

const SITE_REGISTRY: SiteEntry[] = [
  // === 新闻类（爬取首页列表） ===
  { domain: "sina.com.cn", source: "新浪", category: "news", homepage: "https://news.sina.com.cn/", baseUrl: "https://news.sina.com.cn" },
  { domain: "163.com", source: "网易", category: "news", homepage: "https://news.163.com/", baseUrl: "https://news.163.com" },
  { domain: "cctv.com", source: "央视网", category: "news", homepage: "https://news.cctv.com/", baseUrl: "https://news.cctv.com" },
  { domain: "chinanews.com.cn", source: "中国新闻网", category: "news", homepage: "http://www.chinanews.com/", baseUrl: "http://www.chinanews.com" },
  { domain: "people.com.cn", source: "人民网", category: "news", homepage: "http://www.people.com.cn/", baseUrl: "http://www.people.com.cn" },
  { domain: "chinadaily.com.cn", source: "中国日报", category: "news", homepage: "https://cn.chinadaily.com.cn/", baseUrl: "https://cn.chinadaily.com.cn" },
  { domain: "gmw.cn", source: "光明网", category: "news", homepage: "https://news.gmw.cn/", baseUrl: "https://news.gmw.cn" },
  { domain: "cyol.com", source: "中青网", category: "news", homepage: "http://news.cyol.com/", baseUrl: "http://news.cyol.com" },
  { domain: "zaobao.com.sg", source: "联合早报", category: "news", homepage: "https://www.zaobao.com.sg/news/china", baseUrl: "https://www.zaobao.com.sg" },
  { domain: "ifeng.com", source: "凤凰网", category: "news", homepage: "https://news.ifeng.com/", baseUrl: "https://news.ifeng.com" },
  { domain: "xinhuanet.com", source: "新华网", category: "news", homepage: "http://www.xinhuanet.com/", baseUrl: "http://www.xinhuanet.com" },
  { domain: "eastday.com", source: "东方网", category: "news", homepage: "https://news.eastday.com/", baseUrl: "https://news.eastday.com" },
  { domain: "haiwainet.cn", source: "海外网", category: "news", homepage: "https://opinion.haiwainet.cn/", baseUrl: "https://opinion.haiwainet.cn" },
  { domain: "cri.cn", source: "国际在线", category: "news", homepage: "https://news.cri.cn/", baseUrl: "https://news.cri.cn" },
  { domain: "ce.cn", source: "中国经济网", category: "news", homepage: "http://www.ce.cn/", baseUrl: "http://www.ce.cn" },
  { domain: "youth.cn", source: "中国青年网", category: "news", homepage: "https://www.youth.cn/", baseUrl: "https://www.youth.cn" },
  { domain: "cnr.cn", source: "央广网", category: "news", homepage: "https://news.cnr.cn/", baseUrl: "https://news.cnr.cn" },
  { domain: "thepaper.cn", source: "澎湃新闻", category: "news", homepage: "https://www.thepaper.cn/", baseUrl: "https://www.thepaper.cn" },

  // === 技术社区（爬取具体页面，提取相关文章链接） ===
  { domain: "csdn.net", source: "CSDN", category: "tech", baseUrl: "https://www.csdn.net" },
  { domain: "juejin.cn", source: "掘金", category: "tech", baseUrl: "https://juejin.cn" },
  { domain: "cnblogs.com", source: "博客园", category: "tech", baseUrl: "https://www.cnblogs.com" },
  { domain: "segmentfault.com", source: "SegmentFault", category: "tech", baseUrl: "https://segmentfault.com" },
  { domain: "oschina.net", source: "开源中国", category: "tech", baseUrl: "https://www.oschina.net" },
  { domain: "developer.mozilla.org", source: "MDN", category: "tech", baseUrl: "https://developer.mozilla.org" },
  { domain: "stackoverflow.com", source: "Stack Overflow", category: "tech", baseUrl: "https://stackoverflow.com" },
  { domain: "github.com", source: "GitHub", category: "tech", baseUrl: "https://github.com" },
  { domain: "runoob.com", source: "菜鸟教程", category: "tech", baseUrl: "https://www.runoob.com" },

  // === 问答类（爬取具体页面，提取相关问题链接） ===
  { domain: "zhihu.com", source: "知乎", category: "qa", baseUrl: "https://www.zhihu.com" },
  { domain: "quora.com", source: "Quora", category: "qa", baseUrl: "https://www.quora.com" },

  // === 百科类（爬取具体页面，提取相关词条链接） ===
  { domain: "baike.baidu.com", source: "百度百科", category: "wiki", baseUrl: "https://baike.baidu.com" },
  { domain: "zh.wikipedia.org", source: "维基百科", category: "wiki", baseUrl: "https://zh.wikipedia.org" },
  { domain: "baike.so.com", source: "360百科", category: "wiki", baseUrl: "https://baike.so.com" },
];

/** 从 URL 提取主域名（去掉 www. 前缀） */
function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** 匹配域名到网站注册表条目 */
function matchSiteDomain(host: string): SiteEntry | undefined {
  for (const site of SITE_REGISTRY) {
    if (host === site.domain || host.endsWith("." + site.domain)) {
      return site;
    }
  }
  return undefined;
}

export type DomesticFetchOptions = {
  userAgent: string;
  timeoutMs?: number;
  /** RSS 健康监控器（可选，传入后会自动记录成功/失败并降级不健康源） */
  rssHealth?: RssHealthMonitor;
};

/**
 * 必应中国搜索（并行变体 + 快速返回）。query 由 LLM 按语义组织、原样透传：
 * 不做拆短变体、实体提取、锚点过滤等机械断句处理（历史版本把这些做在服务端，
 * 曾把「金色亮片抹胸鱼尾·红毯杀手」切碎成噪音查询并误删正确结果，2026-09 删除）。
 * 时效性话题由 prependRecencyQueryVariants 在完整 query 基础上追加年月/「最新」。
 */
export async function searchBingChina(
  query: string,
  limit: number,
  opts: DomesticFetchOptions,
): Promise<InfoSearchItem[]> {
  const keyword = query.trim();
  if (!keyword) return [];

  const variants = prependRecencyQueryVariants([keyword], keyword)
    .slice(0, MAX_QUERY_VARIANTS)
    .map((v) => v.trim())
    .filter(Boolean);
  if (variants.length === 0) return [];

  const batches = await fetchBingVariantBatch(variants, limit, opts);
  // 合并去重后只调用一次 applySearchFreshness（避免冗余排序）
  return applySearchFreshness(dedupeByUrl(batches.flat()), { query: keyword }).items.slice(0, limit);
}

/** 兼容别名：与 searchBingChina 一致（历史上是「跳过相关性过滤」的宽松版，现在主路径即宽松）。 */
export async function searchBingChinaRelaxed(
  query: string,
  limit: number,
  opts: DomesticFetchOptions,
): Promise<InfoSearchItem[]> {
  return searchBingChina(query, limit, opts);
}

// ============================================================
// 多引擎降级链：必应为主，百度/搜狗/DuckDuckGo 兜底（消除单点故障）
// 任一引擎失败都会返回空数组，整体优雅降级，不会 throw。
// ============================================================

const BAIDU_SEARCH = "https://www.baidu.com/s";
const SOGOU_SEARCH = "https://www.sogou.com/web";

/** 百度网页搜索：解析 c-container / result 结果块中的标题链接与摘要。 */
export async function searchBaiduChina(
  query: string,
  limit: number,
  opts: DomesticFetchOptions,
): Promise<InfoSearchItem[]> {
  const keyword = query.trim();
  if (!keyword) return [];
  const url = `${BAIDU_SEARCH}?wd=${encodeURIComponent(keyword)}&rn=${clampInt(limit, 1, 20)}`;
  const html = await fetchText(url, opts);
  if (!html) return [];
  return extractSearchLinks(html, "百度").slice(0, limit);
}

/** 搜狗网页搜索：解析 vrwrap 结果块。 */
export async function searchSogouChina(
  query: string,
  limit: number,
  opts: DomesticFetchOptions,
): Promise<InfoSearchItem[]> {
  const keyword = query.trim();
  if (!keyword) return [];
  const url = `${SOGOU_SEARCH}?query=${encodeURIComponent(keyword)}`;
  const html = await fetchText(url, opts);
  if (!html) return [];
  // 搜狗 qrcode/跳转链接去噪：保留可读 URL
  return extractSearchLinks(html, "搜狗").slice(0, limit);
}

/* DuckDuckGo HTML 端点已删除（2026-09-12）：从部署网络实测恒返回 0 条
 * （该端点在境内网络不可达），只贡献超时延迟，无任何结果价值。 */

/**
 * 从搜索结果 HTML 中兜底提取「标题 + 链接」对（面向多引擎统一解析）。
 * 同时从 #content 附近的 <a>:href 里解析标题文本，尽可能保留摘要。
 */
function extractSearchLinks(
  html: string,
  source: string,
): InfoSearchItem[] {
  const out: InfoSearchItem[] = [];
  const seen = new Set<string>();
  const re = /<a[^>]+href=(["'])([^"']+)\1[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null = null;
  while ((m = re.exec(html))) {
    const rawHref = decodeHtmlEntities(m[2] ?? "").trim();
    const text = decodeHtmlEntities((m[3] ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
    if (!rawHref || !text || text.length < 6) continue;
    if (/^\/+$/.test(rawHref) || rawHref.startsWith("#") || rawHref.startsWith("javascript:")) continue;
    // 仅接受绝对 http(s) 链接；相对链接缺少 base 无法可靠还原，跳过
    if (!/^https?:\/\//i.test(rawHref)) continue;
    const clean = rawHref.replace(/[),.;]+$/, "");
    if (seen.has(clean)) continue;
    seen.add(clean);
    out.push({ title: text.slice(0, 180), url: clean, snippet: "", source });
    if (out.length >= 30) break;
  }
  return out;
}

/**
 * 多引擎组合（API 优先 + 爬虫补全）：
 *   1) 先走稳定搜索 API（配置 SEARCH_API_PROVIDER 时），返回的结果无论多少都保留作基础集；
 *   2) 不足当时限用必应补全，必应还不够再用百度/搜狗/DDG 兜底；
 *   3) 合并去重、相关性过滤、按质量排序后返回。
 * 关键修复：API 只要有结果就不再整体丢弃（旧逻辑要求 >=need 才采用，少了就白查），
 * 用「API 结果 + 爬虫增量」混合拼接，避免 API 少数几条也被浪费。
 */
/**
 * query 匹配片段（CJK 二元切片 + 英文词级）。用于判定引擎返回条目与 query
 * 是否语义相关：必应中国 RSS 对多词中文 query（人名+地点等）经常只按首字
 * 匹配返回「刘姓起源」类垃圾，垃圾条目凑满 limit 会提前终结引擎链，导致
 * 百度/搜狗的真实结果永远没机会出场（2026-09-12 实测「刘浩存 泰国」）。
 * 二元切片下「刘姓起源」不包含「刘浩/浩存」片段，可被正确判为不相关。
 */
function extractEngineMatchFragments(query: string): string[] {
  const words = query
    .split(/[\s,，、。；;:：/|?？!！]+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 2);
  const cjkBigrams: string[] = [];
  for (const run of query.matchAll(/[\u4e00-\u9fff]{2,}/gu)) {
    const text = run[0];
    for (let i = 0; i + 2 <= text.length; i++) {
      cjkBigrams.push(text.slice(i, i + 2));
    }
  }
  const enWords = [...query.matchAll(/\b[a-z0-9]{2,}\b/gi)].map((m) => m[0].toLowerCase());
  return [...new Set([...words, ...cjkBigrams, ...enWords])].map((w) => w.toLowerCase());
}

function itemMatchesQueryFragments(
  item: { title: string; snippet?: string; url?: string },
  fragments: string[],
): boolean {
  if (fragments.length === 0) return true;
  const hay = `${item.title}\n${item.snippet ?? ""}\n${item.url ?? ""}`.toLowerCase();
  return fragments.some((f) => hay.includes(f));
}

/**
 * 必应主路相关性达标率：标题/摘要/URL 至少命中一个 query 片段的条目占比。
 * 返回 null 表示 query 无可用片段（纯符号），视为达标（保持原行为不过滤）。
 * 导出供回归测试使用（必应多词中文 query 降级为「刘姓」类垃圾的防线）。
 */
export function primaryRelevanceRatio(items: InfoSearchItem[], query: string): number | null {
  const fragments = extractEngineMatchFragments(query);
  if (fragments.length === 0) return null;
  if (items.length === 0) return 0;
  const relevant = items.filter((item) => itemMatchesQueryFragments(item, fragments)).length;
  return relevant / items.length;
}

/**
 * 兜底结果相关性过滤（导出供回归测试）：只保留标题/摘要/URL 与 query
 * 关键词片段（CJK 二元切片/英文词）命中的条目。query 无可用片段（纯符号）
 * 时不过滤原样返回。
 */
export function filterByQueryFragments<T extends { title: string; snippet?: string; url?: string }>(
  items: T[],
  query: string,
): T[] {
  const fragments = extractEngineMatchFragments(query);
  if (fragments.length === 0) return items;
  return items.filter((item) => itemMatchesQueryFragments(item, fragments));
}

export async function searchWebMultiEngine(
  query: string,
  limit: number,
  _opts: DomesticFetchOptions,
): Promise<InfoSearchItem[]> {
  const keyword = query.trim();
  if (!keyword) return [];
  const boundedLimit = clampInt(limit, 1, 25);

  // 「只信 anysearch」策略（2026-11-08）：搜索 API 是唯一来源，失败/空/零相关
  // 一律返回空，不再回落百度/搜狗爬虫。此前兜底会静默替换掉用户指定的源，
  // 实测把无关的「维普文献页」当成搜索结果（人物搜图事故链的起点）。
  const apiResults = await searchViaSearchApi(keyword, boundedLimit);
  if (!apiResults) {
    console.warn(
      `[Search] 搜索 API 未配置（SEARCH_API_PROVIDER=none/缺 key），按只信 anysearch 策略返回空 -> query="${keyword.slice(0, 30)}"`,
    );
    return [];
  }
  const apiItems = applySearchFreshness(apiResults, { query: keyword }).items.slice(0, boundedLimit);
  if (apiItems.length === 0) {
    console.warn(
      `[Search] 搜索 API 返回 0 条（请求失败/业务失败/空结果），按只信 anysearch 策略返回空 -> query="${keyword.slice(0, 30)}"`,
    );
    return [];
  }
  // 零相关守卫：整页与 query 片段零命中时视同失败（API 结果少比结果脏好）。
  // 垃圾结果模型会当真复述，比空结果危险得多；部分命中（≥1 条）不动，
  // 避免误杀改写型标题。
  if (filterByQueryFragments(apiItems, keyword).length === 0) {
    console.warn(
      `[Search] API ${apiItems.length} 条与 query 零相关（整页跑偏），丢弃返回空 -> query="${keyword.slice(0, 30)}"`,
    );
    return [];
  }
  return apiItems;
}

function clampInt(input: number, min: number, max: number): number {
  if (!Number.isFinite(input)) return min;
  return Math.max(min, Math.min(max, Math.floor(input)));
}

function calculateTimeoutPerVariant(totalBudgetMs: number, variantCount: number): number {
  const safeCount = Math.max(1, variantCount);
  const perVariant = Math.floor(totalBudgetMs / safeCount);
  const minPerVariant = 2_000;
  const maxPerVariant = 8_000;
  return Math.max(minPerVariant, Math.min(maxPerVariant, perVariant));
}

async function fetchBingVariantBatch(
  variants: string[],
  limit: number,
  opts: DomesticFetchOptions,
): Promise<InfoSearchItem[][]> {
  if (variants.length === 0) return [];
  const timeoutPerVariant = calculateTimeoutPerVariant(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, variants.length);
  const results = await Promise.allSettled(
    variants.map((variant) =>
      fetchBingChinaOnceWithTimeout(variant, limit, { ...opts, timeoutMs: timeoutPerVariant }),
    ),
  );
  return results
    .filter((result): result is PromiseFulfilledResult<InfoSearchItem[]> => result.status === "fulfilled")
    .map((result) => result.value)
    .filter((items) => items.length > 0);
}

async function fetchBingChinaOnceWithTimeout(
  keyword: string,
  limit: number,
  opts: DomesticFetchOptions,
): Promise<InfoSearchItem[]> {
  try {
    return await fetchBingChinaOnce(keyword, limit, opts);
  } catch {
    return [];
  }
}

async function fetchBingChinaOnce(
  keyword: string,
  limit: number,
  opts: DomesticFetchOptions,
): Promise<InfoSearchItem[]> {
  const rssUrl = `${BING_CN_SEARCH}?q=${encodeURIComponent(keyword)}&format=rss`;
  const xml = await fetchText(rssUrl, opts);
  if (xml) {
    const fromRss = parseRssItems(xml).map((item) => ({
      title: item.title,
      url: item.link,
      snippet: item.description.slice(0, 220),
      source: "必应中国",
      publishedAt: item.pubDate,
    }));
    if (fromRss.length > 0) return fromRss;
  }

  const htmlUrl = `${BING_CN_SEARCH}?q=${encodeURIComponent(keyword)}`;
  const html = await fetchText(htmlUrl, opts);
  if (!html) return [];
  return extractBingHtmlResults(html);
}

/** 国内科技 RSS 聚合；可按关键词过滤标题/摘要。 */
export async function fetchDomesticTechNews(
  topic: string,
  limit: number,
  opts: DomesticFetchOptions,
): Promise<InfoSearchItem[]> {
  // 健康检查：过滤降级源
  const feeds = opts.rssHealth
    ? opts.rssHealth.filterAvailable(DOMESTIC_TECH_RSS_FEEDS)
    : DOMESTIC_TECH_RSS_FEEDS;
  if (feeds.length === 0) return [];
  const perFeed = Math.max(3, Math.ceil(limit / feeds.length) + 2);

  const batches = await Promise.all(
    feeds.map(async (feed) => {
      const xml = await fetchText(feed.url, opts);
      const items = xml ? parseRssItems(xml) : [];
      // 抓取成功但解析为空（返回 HTML 错误页/死链）同样记为失败，避免死源长期占配额
      if (items.length === 0) {
        opts.rssHealth?.recordFailure(feed.source);
        return [] as InfoSearchItem[];
      }
      opts.rssHealth?.recordSuccess(feed.source);
      return items.map((item) => ({
        title: item.title,
        url: item.link,
        snippet: item.description.slice(0, 220),
        source: feed.source,
        publishedAt: item.pubDate,
      }));
    }),
  );

  // 不做关键词锚点过滤（机械断句代码已删除）；条目相关性由调用方的质量评分排序兜底
  return batches.flat().slice(0, limit);
}

/** 国内官方媒体 RSS 聚合 + HTML 列表爬取（中国新闻网/人民网 RSS + 央视网/新浪/网易/中国日报等 HTML）。 */
export async function fetchDomesticOfficialNews(
  topic: string,
  limit: number,
  opts: DomesticFetchOptions,
): Promise<InfoSearchItem[]> {
  // 健康检查：过滤降级源
  const feeds = opts.rssHealth
    ? opts.rssHealth.filterAvailable(DOMESTIC_NEWS_RSS_FEEDS)
    : DOMESTIC_NEWS_RSS_FEEDS;
  const rssPerFeed = Math.max(3, Math.ceil(limit / Math.max(1, feeds.length)) + 2);

  // 并行：RSS 源 + HTML 爬取源
  // HTML 源不提前 slice（列表页抓到的条目多，关键词过滤后才精准）
  const [rssBatches, htmlBatches] = await Promise.all([
    Promise.all(
      feeds.map(async (feed) => {
        const xml = await fetchText(feed.url, opts);
        const items = xml ? parseRssItems(xml) : [];
        // 抓取成功但解析为空（返回 HTML 错误页/死链）同样记为失败，避免死源长期占配额
        if (items.length === 0) {
          opts.rssHealth?.recordFailure(feed.source);
          return [] as InfoSearchItem[];
        }
        opts.rssHealth?.recordSuccess(feed.source);
        return items
          .slice(0, rssPerFeed)
          .map((item) => ({
            title: item.title,
            url: item.link,
            snippet: item.description.slice(0, 220),
            source: feed.source,
            publishedAt: item.pubDate,
          }));
      }),
    ),
    Promise.all(
      DOMESTIC_NEWS_HTML_FEEDS.map(async (feed) => {
        const html = await fetchText(feed.url, opts);
        if (!html) return [] as InfoSearchItem[];
        // 每个源最多保留 40 条（避免无日期旧新闻过多占用配额）
        return parseHtmlNewsList(html, feed.source, feed.baseUrl).slice(0, 40);
      }),
    ),
  ]);

  // 不做关键词锚点过滤（机械断句代码已删除）；条目相关性由调用方的质量评分排序兜底
  return [...rssBatches.flat(), ...htmlBatches.flat()].slice(0, limit);
}

/**
 * 从 HTML 列表页解析新闻条目。
 * 提取 <a> 标签中的新闻标题和链接，从 URL 中提取发布日期。
 *
 * 支持的 URL 日期格式：
 *   - 央视网: /2026/07/13/ARTIxxx.shtml
 *   - 联合早报: /news/china/story20260712-9352905
 *   - 新浪: /2026-07-13/doc-xxx.shtml
 *   - 中国日报: /a/202607/13/WSxxx.html
 *   - 光明网/中青网: /2026-07/13/content_xxx.htm(l)
 *   - 海外网: /n/2026/0701/cxxx-xxx.html
 */
function parseHtmlNewsList(html: string, source: string, baseUrl: string): InfoSearchItem[] {
  // 提取所有 <a href="...">文本</a>，文本长度 8-100
  const links = [...html.matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>([^<]{8,100})<\/a>/gi)];
  const items: InfoSearchItem[] = [];
  const seen = new Set<string>();

  for (const m of links) {
    const href = m[1];
    const text = m[2].replace(/<[^>]+>/g, "").trim();
    // 过滤导航类文本
    if (/^(首页|登录|注册|更多|关于|联系|广告|服务|评论|收藏|分享|打印|关闭|下一页|上一页)/.test(text)) continue;
    if (text.length < 10) continue;
    // 排除非新闻页面（图集/视频/专题/直播等）
    if (/\/(slide|photo|video|v\.|zt|special|live)\//i.test(href)) continue;
    // 只保留新闻详情页 URL（.html/.shtml/.htm 结尾，或包含 /article/、doc-、content_、/a/\d、/c\d+-）
    if (
      !/\.(html|shtml|htm)$/i.test(href) &&
      !/\/(story|article)\d*/i.test(href) &&
      !/\/doc-/i.test(href) &&
      !/\/content_/i.test(href) &&
      !/\/a\/\d{6}/i.test(href) &&
      !/\/c\d+-\d/i.test(href)
    ) continue;

    // 规范化 URL
    let url = href;
    if (href.startsWith("//")) url = "https:" + href;
    else if (href.startsWith("/")) url = baseUrl + href;
    else if (!/^https?:\/\//i.test(href)) continue;

    // 去重（同一 URL 只保留一次）
    if (seen.has(url)) continue;
    seen.add(url);

    // 从 URL 提取日期
    const publishedAt = extractDateFromUrl(href);

    items.push({
      title: text,
      url,
      snippet: text, // HTML 列表页通常无摘要，用标题代替
      source,
      publishedAt,
    });
  }

  return items;
}

/** 从新闻 URL 中提取发布日期 */
function extractDateFromUrl(url: string): string | undefined {
  // 央视网: /2026/07/13/ARTIxxx.shtml
  // 海外网: /n/2026/0701/cxxx-xxx.html（月日连在一起）
  const cctv = url.match(/\/(\d{4})\/(\d{2})\/(\d{2})\//);
  if (cctv) {
    const d = new Date(Number(cctv[1]), Number(cctv[2]) - 1, Number(cctv[3]));
    if (Number.isFinite(d.getTime())) return d.toISOString();
  }
  // 海外网: /n/2026/0701/cxxx-xxx.html
  const hww = url.match(/\/(\d{4})\/(\d{2})(\d{2})\//);
  if (hww) {
    const d = new Date(Number(hww[1]), Number(hww[2]) - 1, Number(hww[3]));
    if (Number.isFinite(d.getTime())) return d.toISOString();
  }
  // 新浪: /2026-07-13/doc-xxx.shtml
  const sina = url.match(/\/(\d{4})-(\d{2})-(\d{2})\//);
  if (sina) {
    const d = new Date(Number(sina[1]), Number(sina[2]) - 1, Number(sina[3]));
    if (Number.isFinite(d.getTime())) return d.toISOString();
  }
  // 中国日报: /a/202607/13/WSxxx.html
  const cd = url.match(/\/(\d{4})(\d{2})\/(\d{2})\//);
  if (cd) {
    const d = new Date(Number(cd[1]), Number(cd[2]) - 1, Number(cd[3]));
    if (Number.isFinite(d.getTime())) return d.toISOString();
  }
  // 光明网/中青网: /2026-07/13/content_xxx.htm
  const gmw = url.match(/\/(\d{4})-(\d{2})\/(\d{2})\//);
  if (gmw) {
    const d = new Date(Number(gmw[1]), Number(gmw[2]) - 1, Number(gmw[3]));
    if (Number.isFinite(d.getTime())) return d.toISOString();
  }
  // 联合早报: story20260712-9352905
  const zb = url.match(/story(\d{8})-/);
  if (zb) {
    const s = zb[1];
    const d = new Date(Number(s.slice(0, 4)), Number(s.slice(4, 6)) - 1, Number(s.slice(6, 8)));
    if (Number.isFinite(d.getTime())) return d.toISOString();
  }
  return undefined;
}

/**
 * 从具体页面中提取相关链接（用于技术/问答/百科类网站）。
 *
 * 与新闻类不同，技术文章/问答/百科没有"首页列表"，
 * 但页面正文通常包含相关文章/问题/词条的链接。
 * 爬取这些页面，提取同域名的相关链接，扩展搜索覆盖面。
 *
 * 每个页面最多提取 10 条相关链接，避免过多噪音。
 */
async function extractRelatedLinksFromPage(
  pageUrl: string,
  site: SiteEntry,
  topic: string,
  opts: DomesticFetchOptions,
): Promise<InfoSearchItem[]> {
  const html = await fetchText(pageUrl, opts);
  if (!html) return [];

  // 提取页面中所有 <a> 链接
  const links = [...html.matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>([^<]{8,100})<\/a>/gi)];
  const items: InfoSearchItem[] = [];
  const seen = new Set<string>();
  // 主题词匹配：只按 query 自身的空格/标点边界取词（LLM 写好的词单元），
  // 不做实体提取/中文再切分等机械断句；标题或链接含任一词即视为相关。
  const keywords = topic
    .split(/[\s,，、。；;:：/|]+/)
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length >= 2);
  const baseUrlHost = extractDomain(site.baseUrl);

  for (const m of links) {
    const href = m[1];
    const text = m[2].replace(/<[^>]+>/g, "").trim();
    // 过滤导航类文本
    if (/^(首页|登录|注册|更多|关于|联系|广告|服务|评论|收藏|分享|打印|关闭|下一页|上一页|下载|举报|反馈)/.test(text)) continue;
    if (text.length < 8) continue;

    // 规范化为绝对 URL
    let absUrl: string;
    try {
      absUrl = new URL(href, pageUrl).toString();
    } catch {
      continue;
    }

    // 只保留同域名的链接（避免外链噪音）
    const linkHost = extractDomain(absUrl);
    if (!linkHost || !linkHost.endsWith(baseUrlHost)) continue;

    if (seen.has(absUrl)) continue;
    seen.add(absUrl);

    // 排除与当前页面相同的 URL
    if (absUrl === pageUrl) continue;

    // 用关键词过滤（标题或链接文本包含主题关键词）
    if (keywords.length > 0) {
      const hay = `${text}\n${absUrl}`.toLowerCase();
      if (!keywords.some((k) => hay.includes(k))) continue;
    }

    items.push({
      title: text,
      url: absUrl,
      snippet: text,
      source: site.source,
      publishedAt: extractDateFromUrl(absUrl),
    });

    if (items.length >= 10) break; // 每个页面最多 10 条
  }

  return items;
}

/**
 * 动态源发现：从已有搜索结果中识别网站域名，自动爬取相关页面。
 *
 * 分类策略：
 *   - news（新闻）：爬取首页列表页，拿到比必应索引更新的新闻
 *   - tech/qa/wiki（技术/问答/百科）：爬取搜索结果中的具体页面，
 *     提取其中的相关链接（相关文章/问题/词条），扩展覆盖面
 *
 * 触发时机：search() 方法中，预定义源 + 必应结果不足时调用。
 */
export async function discoverHtmlSourcesFromResults(
  searchResults: InfoSearchItem[],
  topic: string,
  opts: DomesticFetchOptions,
): Promise<InfoSearchItem[]> {
  if (searchResults.length === 0) return [];

  // 1. 从已有搜索结果中识别网站域名
  //    对于非新闻类，同时记录该域名下的具体页面 URL（用于后续爬取）
  const discovered = new Map<string, SiteEntry>();
  const pageUrlsByDomain = new Map<string, string[]>();

  for (const item of searchResults) {
    const host = extractDomain(item.url);
    if (!host) continue;
    const match = matchSiteDomain(host);
    if (!match) continue;

    if (!discovered.has(match.domain)) {
      discovered.set(match.domain, match);
    }

    // 对于非新闻类，记录搜索结果中的具体页面 URL
    if (match.category !== "news") {
      const urls = pageUrlsByDomain.get(match.domain) ?? [];
      urls.push(item.url);
      pageUrlsByDomain.set(match.domain, urls);
    }
  }

  if (discovered.size === 0) return [];

  // 2. 排除已在预定义 HTML 源中的新闻域名（避免重复爬取）
  const predefinedDomains = new Set(
    DOMESTIC_NEWS_HTML_FEEDS.map((f) => extractDomain(f.baseUrl)),
  );

  // 3. 根据类别构建爬取任务
  const tasks: Promise<InfoSearchItem[]>[] = [];

  for (const [domain, site] of discovered) {
    if (site.category === "news") {
      // 新闻类：爬取首页列表页
      if (predefinedDomains.has(domain) || !site.homepage) continue;
      const homepage = site.homepage;
      tasks.push(
        (async () => {
          const html = await fetchText(homepage, opts);
          if (!html) return [] as InfoSearchItem[];
          return parseHtmlNewsList(html, site.source, site.baseUrl).slice(0, 40);
        })(),
      );
    } else {
      // 技术/问答/百科类：爬取搜索结果中的具体页面，提取相关链接
      const urls = (pageUrlsByDomain.get(domain) ?? []).slice(0, 2); // 每个域名最多爬 2 个页面
      for (const url of urls) {
        tasks.push(extractRelatedLinksFromPage(url, site, topic, opts));
      }
    }
  }

  if (tasks.length === 0) return [];

  // 4. 并行执行（最多 6 个任务，避免过多网络请求）
  const batches = await Promise.all(tasks.slice(0, 6));

  // 5. 合并返回（不做关键词锚点过滤，机械断句代码已删除）
  return batches.flat();
}

/** 国内新闻：必应 RSS + 科技 RSS + 官方媒体 RSS（实时性最优组合）。 */
export async function fetchDomesticNews(
  topic: string,
  limit: number,
  opts: DomesticFetchOptions,
): Promise<InfoSearchItem[]> {
  const keyword = topic.trim();
  if (!keyword) return [];

  const [bing, tech, official] = await Promise.all([
    searchBingChina(keyword, limit, opts),
    fetchDomesticTechNews(keyword, Math.min(6, limit), opts),
    fetchDomesticOfficialNews(keyword, Math.min(8, limit), opts),
  ]);
  // 官方媒体 RSS 排前面（实时性最高），然后必应，然后科技 RSS
  return applySearchFreshness(dedupeByUrl([...official, ...bing, ...tech]), { query: keyword }).items.slice(
    0,
    limit,
  );
}

async function fetchText(url: string, opts: DomesticFetchOptions): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // 网络瞬时抖动自动重试（最多 2 次，指数退避），消除单次失败导致的整体空结果
  let lastText = "";
  for (let attempt = 0; attempt <= 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          "user-agent": opts.userAgent,
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
        },
        redirect: "follow",
      });
      if (!response.ok) {
        lastText = "";
      } else {
        lastText = await response.text();
        if (lastText) return lastText;
      }
    } catch {
      lastText = "";
    } finally {
      clearTimeout(timer);
    }
    if (attempt < 2) await new Promise((r) => setTimeout(r, 120 * Math.pow(2, attempt)));
  }
  return lastText;
}

function dedupeByUrl(items: InfoSearchItem[]): InfoSearchItem[] {
  const seen = new Set<string>();
  const out: InfoSearchItem[] = [];
  for (const item of items) {
    const key = item.url.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function parseRssItems(xml: string): Array<{
  title: string;
  link: string;
  description: string;
  pubDate?: string;
}> {
  const items: Array<{ title: string; link: string; description: string; pubDate?: string }> = [];
  const blocks = xml.match(/<item>[\s\S]*?<\/item>/gi) ?? [];
  for (const block of blocks) {
    const title = extractXmlTag(block, "title");
    const link = extractXmlTag(block, "link");
    const description = extractXmlTag(block, "description");
    const pubDate = extractXmlTag(block, "pubDate");
    if (!title || !link) continue;
    items.push({ title, link, description, pubDate });
  }
  return items;
}

function extractXmlTag(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return m ? decodeHtmlEntities(m[1].replace(/<!\[CDATA\[|\]\]>/g, "")).trim() : "";
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

function extractBingHtmlResults(html: string): InfoSearchItem[] {
  const out: InfoSearchItem[] = [];
  const seen = new Set<string>();
  const blockRe = /<li[^>]*class="[^"]*b_algo[^"]*"[^>]*>([\s\S]*?)<\/li>/gi;
  let block: RegExpExecArray | null = null;
  while ((block = blockRe.exec(html))) {
    const chunk = block[1] ?? "";
    const linkMatch = chunk.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;
    const href = decodeHtmlEntities(linkMatch[1] ?? "").trim();
    const title = decodeHtmlEntities((linkMatch[2] ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
    if (!href || !title || href.startsWith("javascript:")) continue;
    let url: string;
    try {
      url = new URL(href, BING_CN_SEARCH).toString();
    } catch {
      continue;
    }
    if (seen.has(url)) continue;
    seen.add(url);
    const snippetMatch = chunk.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = snippetMatch
      ? decodeHtmlEntities((snippetMatch[1] ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()).slice(
          0,
          220,
        )
      : "";
    out.push({ title, url, snippet, source: "必应中国" });
  }
  return out;
}
