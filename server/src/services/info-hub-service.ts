import { getDataDir } from "../config/data-dir.js";
import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { randomUUID } from "crypto";

import {
  fetchDomesticNews,
  searchWebMultiEngine,
  type DomesticFetchOptions,
} from "./domestic-web-providers.js";
import { fetchWebPageEnhanced, extractWithReadability, decodeWithEncoding } from "./web-fetch-enhancer.js";
import { composeArticleRead } from "./article-fallback-service.js";
import {
  SearchCache,
  RssHealthMonitor,
  classifySearchIntent,
  SessionSearchCache,
  sortByQuality,
  applySearchFreshness,
  withRetry,
} from "./search-enhancements.js";

export type InfoSearchItem = {
  title: string;
  url: string;
  snippet: string;
  source: string;
  publishedAt?: string;
};

export type WebLinkItem = {
  text: string;
  url: string;
  sameHost: boolean;
};

export type SiteNavigateHop = {
  depth: number;
  url: string;
  title: string;
  summary: string;
  matched: boolean;
};

export type TrackedTopic = {
  topicId: string;
  sessionId: string;
  name: string;
  keywords: string[];
  createdAt: string;
  updatedAt: string;
  enabled: boolean;
  lastRunAt?: string;
  lastResult?: InfoSearchItem[];
  scheduleTaskId?: string;
};

type PersistedInfoHub = {
  topics?: TrackedTopic[];
};

export class InfoHubService {
  private readonly topics = new Map<string, TrackedTopic>();
  // 真实浏览器 UA，避免被反爬识别（IT之家/36氪 等会拒绝自定义 UA）
  private readonly userAgent =
    process.env.WEB_FETCH_USER_AGENT ??
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
  // 搜索结果缓存（LRU + TTL）
  private readonly searchCache = new SearchCache<InfoSearchItem[]>({
    maxSize: Number(process.env.SEARCH_CACHE_SIZE ?? 200),
    ttlMs: Number(process.env.SEARCH_CACHE_TTL_MS ?? 5 * 60 * 1000),
  });
  // RSS 源健康检查
  private readonly rssHealth = new RssHealthMonitor();
  // 同会话跨查询复用
  private readonly sessionCache = new SessionSearchCache();
  // 网页内容缓存（LRU + TTL 10 分钟）——只保留「html + text」这一份：
  // 结构化抽取需要 HTML，仅有纯文本的缓存已无消费方（readWebpage 已改走此路径）。
  private readonly pageContentCacheFull = new SearchCache<{ html: string; text: string }>({
    maxSize: 50,
    ttlMs: 10 * 60 * 1000,
  });

  private get persistPath(): string {
    return process.env.INFO_TRACKING_FILE ?? join(getDataDir(), "info-tracking.json");
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.persistPath, "utf8");
      const data = JSON.parse(raw) as PersistedInfoHub;
      this.topics.clear();
      for (const topic of data.topics ?? []) {
        if (topic?.topicId && topic?.sessionId) {
          this.topics.set(topic.topicId, topic);
        }
      }
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") return;
      throw e;
    }
  }

  async persist(): Promise<void> {
    const dir = dirname(this.persistPath);
    await mkdir(dir, { recursive: true });
    await writeFile(
      this.persistPath,
      JSON.stringify({ topics: Array.from(this.topics.values()) }, null, 2),
      "utf8",
    );
  }

  listTopicsBySession(sessionId: string): TrackedTopic[] {
    return Array.from(this.topics.values())
      .filter((t) => t.sessionId === sessionId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async createTopic(input: {
    sessionId: string;
    name: string;
    keywords: string[];
    scheduleTaskId?: string;
  }): Promise<TrackedTopic> {
    const now = new Date().toISOString();
    const topic: TrackedTopic = {
      topicId: randomUUID(),
      sessionId: input.sessionId,
      name: input.name.trim(),
      keywords: input.keywords.map((k) => k.trim()).filter(Boolean),
      createdAt: now,
      updatedAt: now,
      enabled: true,
      scheduleTaskId: input.scheduleTaskId,
    };
    this.topics.set(topic.topicId, topic);
    await this.persist();
    return topic;
  }

  async setEnabled(topicId: string, enabled: boolean): Promise<TrackedTopic> {
    const topic = this.topics.get(topicId);
    if (!topic) {
      throw new Error("追踪话题不存在");
    }
    topic.enabled = enabled;
    topic.updatedAt = new Date().toISOString();
    this.topics.set(topicId, topic);
    await this.persist();
    return topic;
  }

  async runTopic(topicId: string): Promise<{ topic: TrackedTopic; items: InfoSearchItem[] }> {
    const topic = this.topics.get(topicId);
    if (!topic) throw new Error("追踪话题不存在");
    const query = topic.keywords.join(" ");
    const [news, docs] = await Promise.all([
      this.fetchNews(query, 6),
      this.search(query, 6),
    ]);
    const merged = dedupeByUrl([...news, ...docs]).slice(0, 10);
    topic.lastRunAt = new Date().toISOString();
    topic.lastResult = merged;
    topic.updatedAt = topic.lastRunAt;
    this.topics.set(topicId, topic);
    await this.persist();
    return { topic, items: merged };
  }

  async search(query: string, limit = 12, sessionId?: string): Promise<InfoSearchItem[]> {
    const keyword = query.trim();
    if (!keyword) return [];
    const boundedLimit = Number.isFinite(limit) ? Math.max(1, Math.min(25, limit)) : 12;

    // 意图识别：影响搜索策略
    const intent = classifySearchIntent(keyword);
    const effectiveLimit = Math.max(boundedLimit, intent.suggestedLimit ?? 0);
    const __t0 = Date.now(); // [DEBUG] 测试搜索耗时

    // 1. 会话内复用（相似查询直接返回之前结果）
    if (sessionId) {
      const reusable = this.sessionCache.findReusable(sessionId, keyword);
      if (reusable && reusable.length > 0) {
        return reusable.slice(0, effectiveLimit);
      }
    }

    // 2. 缓存命中检查（相同 query 直接返回）
    const cacheKey = `${keyword}:${effectiveLimit}`;
    const cached = this.searchCache.getWithStats(cacheKey);
    if (cached) {
      return cached;
    }

    // 3. 实际搜索：搜索 API（AnySearch）直出——搜到多少用多少，不设任何
    //    「数量不足补足」阶段。API 不可用/失败时由 searchWebMultiEngine 内部
    //    走百度/搜狗应急兜底（逐条过相关性闸门，全不相关返回空）。
    //
    // 2026-09-12 精简：搜索链路里的「官方/科技 RSS 整源拉取」「必应 relaxed
    // 扩搜」「动态源发现」全部移除。实测：RSS 整源拉取返回的是与 query 无关的
    // 当前通用热点（每轮被相关性闸门 100% 丢弃）却能动拖 17s+；必应对多词
    // 中文 query 只按首字匹配、返回「刘姓起源」类垃圾；动态发现爬新闻首页
    // 无上界再拖 10s+。三者纯延迟零收益。整源新闻仍由 fetchNews/trackTopic
    // （新闻页/话题跟踪功能）提供，与 search() 无关。
    const domesticOpts: DomesticFetchOptions = { userAgent: this.userAgent, rssHealth: this.rssHealth };
    const isNewsKeyword = intent.intent === "latest" || intent.requiresFreshWeb;
    const merged = await searchWebMultiEngine(keyword, effectiveLimit, domesticOpts);
    console.error(`[DEBUG-search] 首轮耗时=${Date.now() - __t0}ms items=${merged.length} keyword=${keyword.slice(0,20)}`);

    // 质量评分排序：相关性(50%) + 权威度(30%) + 时效性(20%)
    const scored = sortByQuality(merged, keyword);
    const result = applySearchFreshness(scored, { query: keyword }).items.slice(0, effectiveLimit);

    // 4. 写入缓存 + 会话记录
    // 时效性查询缓存时间更短（1 分钟），非时效性查询用默认 TTL
    const ttlOverride = isNewsKeyword ? 60 * 1000 : undefined;
    this.searchCache.set(cacheKey, result, ttlOverride);
    if (sessionId) {
      this.sessionCache.record(sessionId, keyword, result);
    }

    return result;
  }

  async fetchNews(topic: string, limit = 8): Promise<InfoSearchItem[]> {
    const query = topic.trim();
    if (!query) return [];
    // 增强后的国内新闻：必应 + 科技 RSS + 官方媒体 RSS（已内置并行 + 新鲜度排序 + 健康检查）
    return fetchDomesticNews(query, limit, { userAgent: this.userAgent, rssHealth: this.rssHealth });
  }

  /**
   * 读取网页正文。
   *
   * 2026-10-14 起接入文章页结构化抽取：标题改为优先用抽取结果（论坛/门户的
   * og:title 常是站点口号，抽取层会降级到 <h1>），并补齐 publishedAt / author /
   * paragraphs。**content 仍以通用正文文本兜底**——只有抽取确实拿到成规模正文时才
   * 采用清洗后的版本（见 composeArticleRead 的安全阀），避免非 <p> 排版的页面被掏空。
   */
  async readWebpage(url: string): Promise<{
    title: string;
    content: string;
    summary: string;
    publishedAt?: string;
    author?: string;
    paragraphs?: string[];
  }> {
    const normalizedUrl = this.normalizeUrl(url);
    const { html, text } = await this.readPageContent(normalizedUrl);
    const read = composeArticleRead(html, normalizedUrl, text);
    const title = read.title || inferTitleFromText(read.content) || "Untitled";
    const summary = summarizePlainText(read.content);
    return {
      title,
      content: read.content,
      summary,
      ...(read.publishedAt ? { publishedAt: read.publishedAt } : {}),
      ...(read.author ? { author: read.author } : {}),
      ...(read.paragraphs ? { paragraphs: read.paragraphs } : {}),
    };
  }

  async inspectWebpage(url: string): Promise<{
    title: string;
    summary: string;
    contentPreview: string;
    links: WebLinkItem[];
    sameHostLinks: WebLinkItem[];
  }> {
    const normalizedUrl = this.normalizeUrl(url);
    const { html, text } = await this.readPageContent(normalizedUrl);
    const title = extractTagText(html, "title") || inferTitleFromText(text) || "Untitled";
    const content = text;
    const summary = summarizePlainText(content);
    const links = extractLinks(html, normalizedUrl).slice(0, 30);
    const sameHostLinks = links.filter((x) => x.sameHost).slice(0, 20);
    return {
      title,
      summary,
      contentPreview: content.slice(0, 1200),
      links,
      sameHostLinks,
    };
  }

  async navigateSite(input: {
    startUrl: string;
    goalKeywords?: string[];
    maxDepth?: number;
    maxPages?: number;
    sameHostOnly?: boolean;
  }): Promise<{
    ok: true;
    startUrl: string;
    visitedCount: number;
    found: boolean;
    foundUrl?: string;
    foundTitle?: string;
    goalKeywords: string[];
    hops: SiteNavigateHop[];
  }> {
    const startUrl = this.normalizeUrl(input.startUrl);
    const start = new URL(startUrl);
    const sameHostOnly = input.sameHostOnly ?? true;
    const maxDepth = Math.min(Math.max(Number(input.maxDepth ?? 2) || 2, 0), 5);
    const maxPages = Math.min(Math.max(Number(input.maxPages ?? 20) || 20, 1), 80);
    const goalKeywords = (input.goalKeywords ?? ["注册", "register", "sign up"])
      .map((s) => String(s).trim().toLowerCase())
      .filter(Boolean);

    const queue: Array<{ url: string; depth: number }> = [{ url: startUrl, depth: 0 }];
    const seen = new Set<string>();
    const hops: SiteNavigateHop[] = [];
    let foundUrl: string | undefined;
    let foundTitle: string | undefined;

    while (queue.length > 0 && seen.size < maxPages) {
      const current = queue.shift()!;
      if (seen.has(current.url)) continue;
      seen.add(current.url);
      let html = "";
      try {
        html = await this.fetchHtml(current.url);
      } catch {
        continue;
      }
      const title = extractTagText(html, "title") || "Untitled";
      // 优先用 Readability 提取正文（质量更高），失败时降级到正则
      let content = "";
      try {
        const readabilityResult = extractWithReadability(html, current.url);
        content = readabilityResult.text.length >= 100 ? readabilityResult.text : htmlToText(html);
      } catch {
        content = htmlToText(html);
      }
      const summary = summarizePlainText(content);
      const links = extractLinks(html, current.url);
      const haystack = `${title}\n${summary}\n${content.slice(0, 2500)}`.toLowerCase();
      const matched = goalKeywords.some((k) => haystack.includes(k));
      hops.push({ depth: current.depth, url: current.url, title, summary, matched });
      if (matched) {
        foundUrl = current.url;
        foundTitle = title;
        break;
      }
      if (current.depth >= maxDepth) continue;
      for (const link of links) {
        if (sameHostOnly && !link.sameHost) continue;
        if (!sameHostOnly) {
          try {
            const u = new URL(link.url);
            if (u.protocol !== "http:" && u.protocol !== "https:") continue;
          } catch {
            continue;
          }
        } else {
          try {
            const u = new URL(link.url);
            if (u.host !== start.host) continue;
          } catch {
            continue;
          }
        }
        if (seen.has(link.url)) continue;
        queue.push({ url: link.url, depth: current.depth + 1 });
      }
    }

    return {
      ok: true,
      startUrl,
      visitedCount: seen.size,
      found: Boolean(foundUrl),
      foundUrl,
      foundTitle,
      goalKeywords,
      hops,
    };
  }

  private normalizeUrl(url: string): string {
    const raw = String(url || "").trim();
    if (!raw) throw new Error("url 不能为空");
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      throw new Error("url 格式非法");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("仅支持 http/https");
    }
    return parsed.toString();
  }

  private async fetchHtml(url: string): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          "user-agent": this.userAgent,
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
        },
      });
      if (!response.ok) {
        throw new Error(`网页读取失败: ${response.status} ${response.statusText}`);
      }
      const buffer = await response.arrayBuffer();
      const contentType = response.headers.get("content-type") ?? "";
      // 复用 web-fetch-enhancer 的编码检测逻辑（支持 GBK/GB2312）
      return decodeWithEncoding(buffer, contentType);
    } finally {
      clearTimeout(timer);
    }
  }

  private async readPageContent(url: string): Promise<{ html: string; text: string }> {
    // 缓存命中：直接返回（TTL 10 分钟）
    const cached = this.pageContentCacheFull.get(url);
    if (cached) return cached;

    const result = await withRetry(() =>
      fetchWebPageEnhanced(
        url,
        { userAgent: this.userAgent, timeoutMs: 10_000 },
        (html) => htmlToText(html),
      ),
    );
    const data = {
      html: result.html,
      text: result.text.slice(0, 10000),
    };
    this.pageContentCacheFull.set(url, data);
    return data;
  }
}

function dedupeByUrl(items: InfoSearchItem[]): InfoSearchItem[] {
  const seen = new Set<string>();
  const out: InfoSearchItem[] = [];
  for (const item of items) {
    if (!item.url) continue;
    const key = item.url.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function extractTagText(html: string, tagName: string): string {
  const regex = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "i");
  const match = html.match(regex);
  if (!match) return "";
  return decodeHtmlEntities(match[1]).trim();
}

function htmlToText(html: string): string {
  // 1. 移除 HTML 注释
  let cleaned = html.replace(/<!--[\s\S]*?-->/g, " ");

  // 2. 移除噪音标签（导航、页脚、侧边栏、广告等非正文区域）
  const NOISE_TAGS = [
    "nav", "footer", "aside",
    "noscript", "svg", "canvas", "iframe", "object", "embed",
    "template", "dialog", "modal", "popup",
    "script", "style",
  ];
  for (const tag of NOISE_TAGS) {
    cleaned = cleaned.replace(new RegExp(`<${tag}[\\s\\S]*?<\\/${tag}>`, "gi"), " ");
  }

  // 3. 移除常见广告/推广区域（通过 class/id 属性识别）
  // 匹配包含广告关键词的 div/section/aside 标签块
  const adKeywords = "ad[s]?|banner|sponsor|promo|widget|sidebar|cookie[- ]?consent|newsletter|social[- ]?share|related[- ]?post|comment|disqus";
  cleaned = cleaned.replace(
    new RegExp(`<(div|section|aside)[^>]*(?:class|id)[^>]*(${adKeywords})[^>]*>[\\s\\S]*?<\\/\\1>`, "gi"),
    " ",
  );
  // 匹配任意标签中含广告关键词的 class/id 属性
  cleaned = cleaned.replace(
    new RegExp(`<[^>]+(?:class|id)[^>]*["']\\s*(${adKeywords})\\s*["'][^>]*>[\\s\\S]*?<\\/[^>]+>`, "gi"),
    " ",
  );

  // 4. 保留语义化内容标签的文本，其余标签替换为空格
  const CONTENT_TAGS = new Set([
    "main", "article", "section",
    "h1", "h2", "h3", "h4", "h5", "h6",
    "p", "li", "td", "th", "dd", "dt",
    "blockquote", "pre", "code", "figcaption", "caption",
    "span", "a", "strong", "em", "b", "i", "u", "mark", "time",
    "label", "option", "summary", "details",
  ]);

  let result = "";
  const tagRegex = /<\/?([a-zA-Z][a-zA-Z0-9]*)[^>]*>/g;
  let lastIndex = 0;
  let match;

  while ((match = tagRegex.exec(cleaned)) !== null) {
    // 标签前的纯文本
    if (match.index > lastIndex) {
      result += cleaned.slice(lastIndex, match.index);
    }
    const tagName = match[1].toLowerCase();
    const isClosingTag = match[0].startsWith("</");

    // 内容标签：闭合时加换行分隔
    if (CONTENT_TAGS.has(tagName)) {
      if (isClosingTag && /^(p|h[1-6]|li|tr|dd|dt|figcaption|caption|blockquote|pre)$/.test(tagName)) {
        result += "\n";
      } else if (!isClosingTag && /^(h[1-6])$/.test(tagName)) {
        result += "\n"; // 标题前换行
      }
      // 其他内容标签内的文本自然保留
    } else {
      // 非内容标签替换为空格
      result += " ";
    }
    lastIndex = match.index + match[0].length;
  }

  // 处理末尾剩余文本
  if (lastIndex < cleaned.length) {
    result += cleaned.slice(lastIndex);
  }

  return decodeHtmlEntities(result)
    .replace(/[ \t]+/g, " ")       // 多空格/制表符合并
    .replace(/\n[ \t]+\n/g, "\n")   // 空行中的空格清理
    .replace(/\n{3,}/g, "\n\n")     // 超过2个连续空行压缩为2个
    .trim();
}

function summarizePlainText(text: string): string {
  const chunks = text.split(/[。！？.!?]/).map((s) => s.trim()).filter(Boolean);
  if (chunks.length === 0) return "";
  return chunks.slice(0, 3).join("。");
}

/* extractQueryMatchFragments / filterItemsByQueryKeywords 已删除（2026-09-12）：
 * 它们服务的「RSS 整源拉取 / 扩搜 / 动态发现」阶段已整体移出搜索链路
 * （与 query 无关的通用热点被实测 100% 丢弃），相关性过滤现在由
 * domestic-web-providers 的 filterByQueryFragments 在兜底引擎结果上执行。 */

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function extractLinks(html: string, baseUrl: string): WebLinkItem[] {
  const out: WebLinkItem[] = [];
  const seen = new Set<string>();
  const base = new URL(baseUrl);
  const re = /<a\s+[^>]*href=(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null = null;
  while ((m = re.exec(html))) {
    const hrefRaw = decodeHtmlEntities(m[2] ?? "").trim();
    if (!hrefRaw) continue;
    let abs: URL;
    try {
      abs = new URL(hrefRaw, base);
    } catch {
      continue;
    }
    if (abs.protocol !== "http:" && abs.protocol !== "https:") continue;
    abs.hash = "";
    const url = abs.toString();
    if (seen.has(url)) continue;
    seen.add(url);
    const text = decodeHtmlEntities((m[3] ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
    out.push({
      text: text || "(no-text-link)",
      url,
      sameHost: abs.host === base.host,
    });
  }
  return out;
}

function inferTitleFromText(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);
  if (lines.length === 0) return "";
  if (/^title:/i.test(lines[0])) return lines[0].replace(/^title:/i, "").trim();
  return lines[0].slice(0, 120);
}

