import type { InfoHubService } from "./info-hub-service.js";
import type { ToolContext } from "../tools/tool-registry.js";
import type { UpstreamSearchService, UnifiedSearchItem } from "./upstream-search-service.js";
import { geocodeCity, type WeatherBrief, type WeatherService } from "./weather-service.js";
import { resolveUserGeo } from "./user-location-service.js";
import { assertVisionPullUrlAllowed } from "../vision/url-allow.js";

export type InternetDepth = "quick" | "normal" | "deep";
export type InternetTimeWindow = "15m" | "1h" | "6h" | "24h" | "7d";
export type InternetModality = "web" | "social" | "weather" | "map" | "image" | "video" | "official";

export type InternetEvidence = {
  id: string;
  source: string;
  platform: string;
  url?: string;
  title?: string;
  text: string;
  media?: {
    kind: "image" | "video" | "mixed";
    pageUrl?: string;
    imageUrls: string[];
    videoUrls: string[];
    note: string;
  };
  publishedAt?: string;
  fetchedAt: string;
  claims: string[];
  freshnessScore: number;
  sourceReliability: number;
  relevanceScore: number;
  confidence: number;
};

export type InternetIntelligenceResult = {
  ok: boolean;
  mode: "research" | "live_check" | "verify";
  intent: string;
  goal: string;
  generatedAt: string;
  tokenPolicy: {
    compressed: true;
    maxEvidence: number;
    maxTextCharsPerEvidence: number;
    maxMediaUrlsPerEvidence: number;
    estimatedResultTokens: number;
  };
  coverage: {
    sourcesTried: string[];
    sourcesWithEvidence: string[];
    evidenceCount: number;
    fetchedPageCount: number;
    notes: string[];
  };
  conclusion: {
    summary: string;
    confidence: number;
    stance?: "supported" | "mixed" | "insufficient";
    gaps: string[];
  };
  evidence: InternetEvidence[];
};

type SearchProvider = Pick<UpstreamSearchService, "searchUnified">;
type PageProvider = Pick<InfoHubService, "readWebpage">;
type WeatherProvider = Pick<WeatherService, "getBrief">;

export type InternetIntelligenceDeps = {
  search: SearchProvider;
  pages: PageProvider;
  weather: WeatherProvider;
};

export type InternetResearchInput = {
  goal: string;
  depth?: InternetDepth;
  timeWindow?: InternetTimeWindow;
  maxEvidence?: number;
  fetchTopPages?: boolean;
  includeSources?: InternetModality[];
};

export type InternetLiveCheckInput = InternetResearchInput & {
  target?: string;
  locationName?: string;
  latitude?: number;
  longitude?: number;
  timezone?: string;
};

export type InternetVerifyInput = {
  claim: string;
  depth?: InternetDepth;
  maxEvidence?: number;
};

type Budget = {
  searchLimit: number;
  maxEvidence: number;
  fetchPages: number;
  mediaPages: number;
  maxTextChars: number;
  queryCount: number;
};

const DEFAULT_TIMEZONE = "Asia/Shanghai";
const MAX_RESULT_TOKENS = 1800;

export class InternetIntelligenceService {
  constructor(private readonly deps: InternetIntelligenceDeps) {}

  async research(input: InternetResearchInput): Promise<InternetIntelligenceResult> {
    const goal = cleanText(input.goal);
    if (!goal) return emptyResult("research", "general", "", "goal is required");

    const intent = classifyInternetIntent(goal);
    const budget = resolveBudget(input.depth, input.maxEvidence);
    const queries = buildQueries(goal, intent, input.timeWindow, budget.queryCount);
    const fetchedAt = new Date().toISOString();

    const searchEvidence = await this.searchEvidence(queries, budget, goal);
    const [pageEvidence, mediaEvidence] = await Promise.all([
      this.fetchPageEvidence(searchEvidence, {
        enabled: input.fetchTopPages ?? input.depth === "deep",
        count: budget.fetchPages,
        goal,
        fetchedAt,
      }),
      this.extractMediaEvidence(searchEvidence, budget, goal),
    ]);
    const evidence = rankEvidence([...mediaEvidence, ...searchEvidence, ...pageEvidence], goal).slice(0, budget.maxEvidence);

    return this.buildResult({
      mode: "research",
      intent,
      goal,
      evidence,
      budget,
      sourcesTried: ["web", "social", "page", "image", "video"],
      fetchedPageCount: pageEvidence.length,
      notes: [],
    });
  }

  async liveCheck(input: InternetLiveCheckInput, ctx?: ToolContext): Promise<InternetIntelligenceResult> {
    const target = cleanText(input.target ?? input.goal);
    if (!target) return emptyResult("live_check", "live_situation", "", "target is required");

    const budget = resolveBudget(input.depth, input.maxEvidence);
    const queries = buildQueries(target, "live_situation", input.timeWindow ?? "6h", budget.queryCount);
    const [searchEvidence, weatherEvidence] = await Promise.all([
      this.searchEvidence(queries, budget, target),
      this.weatherEvidence(input, ctx),
    ]);
    const mediaEvidence = await this.extractMediaEvidence(searchEvidence, budget, target);
    const evidence = rankEvidence([...weatherEvidence, ...mediaEvidence, ...searchEvidence], target).slice(0, budget.maxEvidence);

    return this.buildResult({
      mode: "live_check",
      intent: "live_situation",
      goal: target,
      evidence,
      budget,
      sourcesTried: ["weather", "web", "social", "image", "video"],
      fetchedPageCount: 0,
      notes: weatherEvidence.length === 0 ? ["weather skipped: no usable coordinates or place resolution"] : [],
    });
  }

  async verify(input: InternetVerifyInput): Promise<InternetIntelligenceResult> {
    const claim = cleanText(input.claim);
    if (!claim) return emptyResult("verify", "verification", "", "claim is required");

    const budget = resolveBudget(input.depth, input.maxEvidence);
    const queries = buildQueries(claim, "verification", "7d", Math.min(2, budget.queryCount));
    const evidence = rankEvidence(await this.searchEvidence(queries, budget, claim), claim).slice(0, budget.maxEvidence);
    const result = this.buildResult({
      mode: "verify",
      intent: "verification",
      goal: claim,
      evidence,
      budget,
      sourcesTried: ["web", "social"],
      fetchedPageCount: 0,
      notes: [],
    });
    result.conclusion.stance = evidence.length >= 2 ? "supported" : evidence.length === 1 ? "mixed" : "insufficient";
    return result;
  }

  private async searchEvidence(
    queries: string[],
    budget: Budget,
    goal: string,
  ): Promise<InternetEvidence[]> {
    const settled = await Promise.allSettled(
      queries.map((query) =>
        withDeadline(
          this.deps.search.searchUnified({ query, limit: budget.searchLimit, platform: "auto" }),
          18_000,
        ),
      ),
    );
    const items: UnifiedSearchItem[] = [];
    for (const entry of settled) {
      if (entry.status !== "fulfilled") continue;
      items.push(...entry.value.items);
    }
    const deduped = dedupeItems(items);
    const fetchedAt = new Date().toISOString();
    return deduped.map((item, index) => itemToEvidence(item, index, goal, budget.maxTextChars, fetchedAt));
  }

  private async fetchPageEvidence(
    seed: InternetEvidence[],
    opts: {
      enabled: boolean;
      count: number;
      goal: string;
      fetchedAt: string;
    },
  ): Promise<InternetEvidence[]> {
    if (!opts.enabled || opts.count <= 0) return [];
    const urls = seed
      .filter((item) => item.platform === "web" && item.url)
      .slice(0, opts.count)
      .map((item) => item.url!);
    const settled = await Promise.allSettled(
      urls.map((url) => withDeadline(this.deps.pages.readWebpage(url), 15_000)),
    );
    const evidence: InternetEvidence[] = [];
    for (let i = 0; i < settled.length; i++) {
      const entry = settled[i];
      if (entry.status !== "fulfilled") continue;
      const page = entry.value;
      const text = summarizeText(`${page.summary}\n${page.content}`, 420);
      evidence.push({
        id: `page:${i + 1}`,
        source: "page",
        platform: "web",
        url: urls[i],
        title: summarizeText(page.title, 120),
        text,
        fetchedAt: opts.fetchedAt,
        claims: extractClaims(`${page.title}. ${page.summary || text}`),
        freshnessScore: 0.45,
        sourceReliability: 0.72,
        relevanceScore: relevanceScore(`${page.title}\n${text}`, opts.goal),
        confidence: 0,
      });
    }
    return evidence.map((item) => ({
      ...item,
      confidence: combineConfidence(item),
    }));
  }

  private async extractMediaEvidence(
    seed: InternetEvidence[],
    budget: Budget,
    goal: string,
  ): Promise<InternetEvidence[]> {
    if (budget.mediaPages <= 0) return [];
    const candidates = seed
      .filter((item) => item.url && shouldInspectForMedia(item))
      .slice(0, budget.mediaPages);
    const settled = await Promise.allSettled(
      candidates.map((item) => extractMediaFromUrl(item.url!, goal)),
    );
    const out: InternetEvidence[] = [];
    const fetchedAt = new Date().toISOString();
    for (let i = 0; i < settled.length; i++) {
      const entry = settled[i];
      if (entry.status !== "fulfilled" || entry.value.total === 0) continue;
      const media = entry.value;
      const source = candidates[i];
      const kind = media.imageUrls.length > 0 && media.videoUrls.length > 0
        ? "mixed"
        : media.videoUrls.length > 0
          ? "video"
          : "image";
      const text = summarizeText(
        [
          `${kind} evidence extracted from ${source.source}`,
          media.title ? `page title: ${media.title}` : "",
          `${media.imageUrls.length} image candidate(s), ${media.videoUrls.length} video candidate(s)`,
        ].filter(Boolean).join(". "),
        budget.maxTextChars,
      );
      const evidence: InternetEvidence = {
        id: `media:${i + 1}`,
        source: source.source,
        platform: kind === "video" ? "video" : kind === "image" ? "image" : "media",
        url: media.pageUrl,
        title: summarizeText(media.title || source.title || "Media evidence", 120),
        text,
        media: {
          kind,
          pageUrl: media.pageUrl,
          imageUrls: media.imageUrls.slice(0, 3),
          videoUrls: media.videoUrls.slice(0, 2),
          note: "Media URLs are public page metadata candidates, not private content and not VLM-interpreted yet.",
        },
        fetchedAt,
        claims: extractClaims(text),
        freshnessScore: source.freshnessScore,
        sourceReliability: Math.max(0.45, source.sourceReliability - 0.05),
        relevanceScore: Math.max(source.relevanceScore, relevanceScore(`${media.title}\n${text}`, goal)),
        confidence: 0,
      };
      evidence.confidence = combineConfidence(evidence);
      out.push(evidence);
    }
    return out;
  }

  private async weatherEvidence(input: InternetLiveCheckInput, ctx?: ToolContext): Promise<InternetEvidence[]> {
    const located = await resolveWeatherLocation(input, ctx);
    if (!located) return [];
    try {
      const weather = await withDeadline(
        this.deps.weather.getBrief(located.latitude, located.longitude, located.timezone, located.label),
        12_000,
      );
      return [weatherToEvidence(weather)];
    } catch {
      return [];
    }
  }

  private buildResult(input: {
    mode: InternetIntelligenceResult["mode"];
    intent: string;
    goal: string;
    evidence: InternetEvidence[];
    budget: Budget;
    sourcesTried: string[];
    fetchedPageCount: number;
    notes: string[];
  }): InternetIntelligenceResult {
    const sourcesWithEvidence = Array.from(new Set(input.evidence.map((item) => item.platform)));
    const gaps = buildGaps(input.evidence, input.sourcesTried);
    // 缺失来源显式标注 + 稀缺时提示可能原因，便于上层/用户定位
    const notes = [...input.notes];
    if (input.evidence.length === 0) {
      notes.push("所有来源均未返回有效证据，可能被反爬/限流/源失效，或社交 MCP(weibo/小红书)未配置");
    } else if (input.evidence.length < 2) {
      notes.push("可用证据较少，建议加深搜索层级(deep)或调整时间窗后重试");
    }
    const avgConfidence = input.evidence.length
      ? round(input.evidence.reduce((sum, item) => sum + item.confidence, 0) / input.evidence.length)
      : 0;
    const topClaims = input.evidence.flatMap((item) => item.claims).slice(0, 3);
    const summary = topClaims.length
      ? topClaims.join(" ")
      : "Insufficient fresh evidence found.";
    const result: InternetIntelligenceResult = {
      ok: true,
      mode: input.mode,
      intent: input.intent,
      goal: input.goal,
      generatedAt: new Date().toISOString(),
      tokenPolicy: {
        compressed: true,
        maxEvidence: input.budget.maxEvidence,
        maxTextCharsPerEvidence: input.budget.maxTextChars,
        maxMediaUrlsPerEvidence: 5,
        estimatedResultTokens: 0,
      },
      coverage: {
        sourcesTried: input.sourcesTried,
        sourcesWithEvidence,
        evidenceCount: input.evidence.length,
        fetchedPageCount: input.fetchedPageCount,
        notes,
      },
      conclusion: {
        summary,
        confidence: avgConfidence,
        stance: input.evidence.length >= 2 ? "supported" : input.evidence.length === 1 ? "mixed" : "insufficient",
        gaps,
      },
      evidence: input.evidence,
    };
    result.tokenPolicy.estimatedResultTokens = estimateTokens(JSON.stringify(result));
    if (result.tokenPolicy.estimatedResultTokens > MAX_RESULT_TOKENS) {
      result.evidence = result.evidence.slice(0, Math.max(1, input.budget.maxEvidence - 2));
      result.tokenPolicy.estimatedResultTokens = estimateTokens(JSON.stringify(result));
    }
    return result;
  }
}

function resolveBudget(depth: InternetDepth = "normal", maxEvidence?: number): Budget {
  const base: Record<InternetDepth, Budget> = {
    quick: { searchLimit: 6, maxEvidence: 5, fetchPages: 0, mediaPages: 1, maxTextChars: 220, queryCount: 1 },
    normal: { searchLimit: 12, maxEvidence: 10, fetchPages: 1, mediaPages: 3, maxTextChars: 280, queryCount: 3 },
    deep: { searchLimit: 18, maxEvidence: 16, fetchPages: 3, mediaPages: 5, maxTextChars: 340, queryCount: 4 },
  };
  const selected = { ...base[depth] };
  if (maxEvidence != null && Number.isFinite(maxEvidence)) {
    selected.maxEvidence = Math.max(1, Math.min(selected.maxEvidence, Math.floor(maxEvidence)));
  }
  return selected;
}

type ExtractedMedia = {
  pageUrl: string;
  title: string;
  imageUrls: string[];
  videoUrls: string[];
  total: number;
};

const DIRECT_IMAGE_RE = /\.(?:jpe?g|png|webp|gif)(?:[?#].*)?$/i;
const DIRECT_VIDEO_RE = /\.(?:mp4|webm|mov|m3u8)(?:[?#].*)?$/i;

function shouldInspectForMedia(item: InternetEvidence): boolean {
  const hay = `${item.platform} ${item.source} ${item.title ?? ""} ${item.text} ${item.url ?? ""}`.toLowerCase();
  if (DIRECT_IMAGE_RE.test(item.url ?? "") || DIRECT_VIDEO_RE.test(item.url ?? "")) return true;
  if (/(image|photo|picture|video|shorts|reel|vlog|youtube|youtu\.be|bilibili|douyin|xiaohongshu|xhs|weibo|instagram|tiktok|twitter|x\.com)/i.test(hay)) {
    return true;
  }
  if (/(\u56fe\u7247|\u7167\u7247|\u89c6\u9891|\u5b9e\u62cd|\u73b0\u573a|\u76f4\u64ad|\u5c0f\u7ea2\u4e66|\u6296\u97f3|\u5fae\u535a)/u.test(hay)) {
    return true;
  }
  return item.platform !== "web";
}

async function extractMediaFromUrl(url: string, goal: string): Promise<ExtractedMedia> {
  const pageUrl = normalizeHttpUrl(url);
  if (DIRECT_IMAGE_RE.test(pageUrl)) {
    return { pageUrl, title: "", imageUrls: [pageUrl], videoUrls: [], total: 1 };
  }
  if (DIRECT_VIDEO_RE.test(pageUrl)) {
    return { pageUrl, title: "", imageUrls: [], videoUrls: [pageUrl], total: 1 };
  }

  const html = await fetchHtmlHead(pageUrl);
  if (!html) return { pageUrl, title: "", imageUrls: [], videoUrls: [], total: 0 };
  const title = extractHtmlTitle(html);
  const imageUrls = normalizeMediaUrls(
    [
      ...extractMetaContent(html, ["og:image", "og:image:url", "twitter:image", "twitter:image:src"]),
      ...extractJsonLikeUrls(html, ["thumbnailUrl", "image"]),
      ...extractTagSrcs(html, "img"),
      ...extractDirectMediaUrls(html, DIRECT_IMAGE_RE),
    ],
    pageUrl,
  ).slice(0, 8);
  const videoUrls = normalizeMediaUrls(
    [
      ...extractMetaContent(html, ["og:video", "og:video:url", "og:video:secure_url", "twitter:player"]),
      ...extractJsonLikeUrls(html, ["contentUrl", "embedUrl"]),
      ...extractTagSrcs(html, "video"),
      ...extractTagSrcs(html, "source"),
      ...extractDirectMediaUrls(html, DIRECT_VIDEO_RE),
    ],
    pageUrl,
  ).slice(0, 5);

  const relevantImageUrls = preferRelevantUrls(imageUrls, goal).slice(0, 5);
  const relevantVideoUrls = preferRelevantUrls(videoUrls, goal).slice(0, 3);
  return {
    pageUrl,
    title,
    imageUrls: relevantImageUrls,
    videoUrls: relevantVideoUrls,
    total: relevantImageUrls.length + relevantVideoUrls.length,
  };
}

function normalizeHttpUrl(raw: string): string {
  const url = new URL(raw);
  assertVisionPullUrlAllowed(url);
  url.hash = "";
  return url.toString();
}

async function fetchHtmlHead(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        accept: "text/html,application/xhtml+xml,*/*;q=0.8",
        "user-agent": "Nextbot-MediaSensor/1.0",
      },
    });
    if (!res.ok) return "";
    const contentType = res.headers.get("content-type") ?? "";
    if (!/text\/html|application\/xhtml\+xml|application\/json|\*/i.test(contentType)) return "";
    const reader = res.body?.getReader();
    if (!reader) return "";
    const chunks: Uint8Array[] = [];
    let total = 0;
    const maxBytes = 256 * 1024;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) break;
      chunks.push(value);
      const preview = Buffer.concat(chunks).toString("utf8");
      if (/<\/head>/i.test(preview) && preview.length > 4096) break;
    }
    return Buffer.concat(chunks).toString("utf8");
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

function extractHtmlTitle(html: string): string {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? decodeHtml(match[1].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim().slice(0, 160) : "";
}

function extractMetaContent(html: string, keys: string[]): string[] {
  const out: string[] = [];
  for (const key of keys) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`<meta\\s+[^>]*(?:property|name)=["']${escaped}["'][^>]*content=["']([^"']+)["'][^>]*>`, "gi");
    for (const match of html.matchAll(re)) out.push(decodeHtml(match[1]));
    const reContentFirst = new RegExp(`<meta\\s+[^>]*content=["']([^"']+)["'][^>]*(?:property|name)=["']${escaped}["'][^>]*>`, "gi");
    for (const match of html.matchAll(reContentFirst)) out.push(decodeHtml(match[1]));
  }
  return out;
}

function extractTagSrcs(html: string, tag: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tag}\\s+[^>]*(?:src|poster)=["']([^"']+)["'][^>]*>`, "gi");
  for (const match of html.matchAll(re)) out.push(decodeHtml(match[1]));
  return out;
}

function extractJsonLikeUrls(html: string, keys: string[]): string[] {
  const out: string[] = [];
  for (const key of keys) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`["']${escaped}["']\\s*:\\s*(?:"([^"]+)"|\\[([^\\]]+)\\])`, "gi");
    for (const match of html.matchAll(re)) {
      if (match[1]) out.push(decodeHtml(match[1]));
      if (match[2]) {
        for (const nested of match[2].matchAll(/"([^"]+)"/g)) out.push(decodeHtml(nested[1]));
      }
    }
  }
  return out;
}

function extractDirectMediaUrls(html: string, re: RegExp): string[] {
  const out: string[] = [];
  const urlRe = /https?:\/\/[^\s"'<>\\]+/gi;
  for (const match of html.matchAll(urlRe)) {
    const url = decodeHtml(match[0]).replace(/[),.;]+$/, "");
    if (re.test(url)) out.push(url);
  }
  return out;
}

function normalizeMediaUrls(rawUrls: string[], pageUrl: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of rawUrls) {
    const cleaned = cleanText(raw);
    if (!cleaned || cleaned.startsWith("data:") || cleaned.startsWith("blob:")) continue;
    try {
      const url = new URL(cleaned, pageUrl);
      if (url.protocol !== "http:" && url.protocol !== "https:") continue;
      url.hash = "";
      const normalized = url.toString();
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      out.push(normalized);
    } catch {
      continue;
    }
  }
  return out;
}

function preferRelevantUrls(urls: string[], goal: string): string[] {
  const tokens = extractTokens(goal).slice(0, 6);
  return urls
    .map((url, index) => ({
      url,
      score: tokens.filter((token) => url.toLowerCase().includes(token)).length - index * 0.001,
    }))
    .sort((a, b) => b.score - a.score)
    .map((item) => item.url);
}

function decodeHtml(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function classifyInternetIntent(text: string): string {
  const q = text.toLowerCase();
  if (/(verify|fact check|true|false|\u771f\u5047|\u6838\u5b9e|\u9a8c\u8bc1)/i.test(q)) return "verification";
  if (/(live|current|now|today|\u73b0\u5728|\u5f53\u524d|\u4eca\u5929|\u521a\u521a|\u73b0\u573a|\u5b9e\u65f6)/i.test(q)) return "live_situation";
  if (/(price|stock|quote|market|\u80a1\u4ef7|\u4ef7\u683c|\u884c\u60c5|\u62a5\u4ef7)/i.test(q)) return "market_watch";
  if (/(official|policy|law|notice|\u5b98\u65b9|\u653f\u7b56|\u6cd5\u89c4|\u516c\u544a)/i.test(q)) return "official_truth";
  if (/(review|feedback|reddit|weibo|xhs|\u8bc4\u4ef7|\u53e3\u7891|\u5fae\u535a|\u5c0f\u7ea2\u4e66|\u8206\u60c5)/i.test(q)) return "social_signal";
  return "deep_research";
}

function buildQueries(
  goal: string,
  intent: string,
  timeWindow: InternetTimeWindow | undefined,
  maxCount: number,
): string[] {
  const base = cleanText(goal);
  const variants = [base];
  const fresh = intent === "live_situation" || intent === "market_watch" || timeWindow != null;
  if (fresh && maxCount > 1) {
    variants.push(`${base} ${new Date().getFullYear()} latest`);
  } else if (maxCount > 1) {
    variants.push(`${base} analysis`);
  }
  // 不再生成 site:weibo.com / site:xiaohongshu.com 变体，
  // 因为 searchUnified(platform:"auto") 已在内部原生搜索微博+小红书+微信，
  // 避免每个变体都触发一次完整的 searchUnified API 调用链。
  return Array.from(new Set(variants.map((item) => item.trim()).filter(Boolean))).slice(0, maxCount);
}

async function resolveWeatherLocation(
  input: InternetLiveCheckInput,
  ctx?: ToolContext,
): Promise<{ latitude: number; longitude: number; timezone: string; label: string } | null> {
  const lat = Number(input.latitude);
  const lon = Number(input.longitude);
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    return {
      latitude: lat,
      longitude: lon,
      timezone: input.timezone || DEFAULT_TIMEZONE,
      label: input.locationName || `${lat.toFixed(4)}, ${lon.toFixed(4)}`,
    };
  }
  if (input.locationName) {
    const geo = await geocodeCity(input.locationName);
    if (geo) {
      return {
        latitude: geo.latitude,
        longitude: geo.longitude,
        timezone: input.timezone || DEFAULT_TIMEZONE,
        label: [geo.name, geo.admin1, geo.country].filter(Boolean).join(" "),
      };
    }
  }
  // 消息自带位置基本断供（客户端不随聊天消息带 GPS）：先走按需实时定位
  // （LocationCoordinator 60s 新鲜缓存优先，否则下发 agent.location_request），
  // 再兜底 resolveUserGeo 原路径，否则联网情报的地理上下文在真实链路里常为空。
  const live = await ctx?.requestLocation?.();
  const userGeo = live
    ? await resolveUserGeo({ clientLocation: live })
    : await resolveUserGeo({
        clientIp: ctx?.clientIp,
        clientLocation: ctx?.clientLocation,
      });
  if (userGeo?.latitude != null && userGeo.longitude != null) {
    return {
      latitude: userGeo.latitude,
      longitude: userGeo.longitude,
      timezone: userGeo.timezone || DEFAULT_TIMEZONE,
      label: [userGeo.district, userGeo.city, userGeo.region, userGeo.country].filter(Boolean).join(" "),
    };
  }
  return null;
}

function itemToEvidence(
  item: UnifiedSearchItem,
  index: number,
  goal: string,
  maxTextChars: number,
  fetchedAt: string,
): InternetEvidence {
  const text = summarizeText(`${item.snippet || ""}`, maxTextChars);
  const platform = item.platform || "web";
  const evidence: InternetEvidence = {
    id: `${platform}:${index + 1}`,
    source: item.source || platform,
    platform,
    url: item.url,
    title: summarizeText(item.title, 120),
    text,
    fetchedAt,
    claims: extractClaims(`${item.title}. ${item.snippet}`),
    freshnessScore: 0.5,
    sourceReliability: reliabilityScore(item.source, platform),
    relevanceScore: relevanceScore(`${item.title}\n${item.snippet}`, goal),
    confidence: 0,
  };
  evidence.confidence = combineConfidence(evidence);
  return evidence;
}

function weatherToEvidence(weather: WeatherBrief): InternetEvidence {
  const text = summarizeText(
    `${weather.summaryLine} Rain peak ${weather.peakRainPct}%. Wind ${weather.windKmh} km/h. ${weather.clothingAdvice}`,
    300,
  );
  const evidence: InternetEvidence = {
    id: "weather:1",
    source: weather.source,
    platform: "weather",
    title: `Weather: ${weather.locationLabel}`,
    text,
    fetchedAt: new Date().toISOString(),
    claims: extractClaims(text),
    freshnessScore: 1,
    sourceReliability: 0.9,
    relevanceScore: 0.75,
    confidence: 0,
  };
  evidence.confidence = combineConfidence(evidence);
  return evidence;
}

function dedupeItems(items: UnifiedSearchItem[]): UnifiedSearchItem[] {
  const seen = new Set<string>();
  const out: UnifiedSearchItem[] = [];
  for (const item of items) {
    const key = (item.url || `${item.platform}:${item.title}:${item.snippet}`).trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function rankEvidence(items: InternetEvidence[], goal: string): InternetEvidence[] {
  return items
    .map((item) => ({
      ...item,
      relevanceScore: item.relevanceScore || relevanceScore(`${item.title}\n${item.text}`, goal),
      confidence: combineConfidence(item),
    }))
    .sort((a, b) => b.confidence - a.confidence);
}

function reliabilityScore(source: string, platform: string): number {
  const s = `${source} ${platform}`.toLowerCase();
  if (platform === "weather") return 0.9;
  if (/(gov|official|edu|\u5b98\u65b9|\u4eba\u6c11|\u592e\u89c6|\u65b0\u534e|cctv|people|xinhua)/i.test(s)) return 0.88;
  if (/(news|media|\u65b0\u95fb|\u65e5\u62a5)/i.test(s)) return 0.75;
  if (/(weibo|xiaohongshu|xhs|douyin|wechat)/i.test(s)) return 0.58;
  return 0.66;
}

function relevanceScore(text: string, goal: string): number {
  const hay = text.toLowerCase();
  const tokens = extractTokens(goal);
  if (tokens.length === 0) return 0.4;
  const hits = tokens.filter((token) => hay.includes(token)).length;
  return round(Math.min(1, hits / Math.max(1, Math.min(tokens.length, 8)) + 0.15));
}

function combineConfidence(item: InternetEvidence): number {
  return round(0.38 * item.relevanceScore + 0.34 * item.sourceReliability + 0.28 * item.freshnessScore);
}

function extractTokens(text: string): string[] {
  const ascii = text
    .toLowerCase()
    .replace(/[^\u4e00-\u9fa5a-z0-9\s]/gi, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 2);
  const chinese = [...text.matchAll(/[\u4e00-\u9fa5]{2,8}/g)].map((match) => match[0].toLowerCase());
  return Array.from(new Set([...ascii, ...chinese])).slice(0, 16);
}

function extractClaims(text: string): string[] {
  const normalized = cleanText(text);
  if (!normalized) return [];
  const parts = normalized
    .split(/[.!?\n\u3002\uff01\uff1f]+/)
    .map((item) => summarizeText(item, 160))
    .filter((item) => item.length >= 8);
  return parts.slice(0, 2);
}

function summarizeText(text: string, maxChars: number): string {
  const cleaned = cleanText(text);
  return cleaned.length > maxChars ? `${cleaned.slice(0, Math.max(0, maxChars - 3))}...` : cleaned;
}

function cleanText(text: string): string {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

function buildGaps(evidence: InternetEvidence[], sourcesTried: string[]): string[] {
  const seen = new Set(evidence.map((item) => item.platform));
  const gaps = sourcesTried
    .filter((source) => !seen.has(source))
    .map((source) => `no ${source} evidence`);
  if (evidence.length < 2) gaps.push("not enough independent evidence for strong verification");
  return gaps.slice(0, 4);
}

async function withDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error("internet sensor timeout")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function emptyResult(
  mode: InternetIntelligenceResult["mode"],
  intent: string,
  goal: string,
  message: string,
): InternetIntelligenceResult {
  return {
    ok: false,
    mode,
    intent,
    goal,
    generatedAt: new Date().toISOString(),
    tokenPolicy: {
      compressed: true,
      maxEvidence: 0,
      maxTextCharsPerEvidence: 0,
      maxMediaUrlsPerEvidence: 0,
      estimatedResultTokens: estimateTokens(message),
    },
    coverage: {
      sourcesTried: [],
      sourcesWithEvidence: [],
      evidenceCount: 0,
      fetchedPageCount: 0,
      notes: [message],
    },
    conclusion: {
      summary: message,
      confidence: 0,
      stance: "insufficient",
      gaps: [message],
    },
    evidence: [],
  };
}
