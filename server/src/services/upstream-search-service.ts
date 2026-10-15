import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { InfoHubService, InfoSearchItem } from "./info-hub-service.js";
import {
  applySearchFreshness,
  formatSearchFreshnessNote,
  getSearchAnchorNow,
  SearchCache,
} from "./search-enhancements.js";
import { searchImagesViaSearchApi, type ImageApiItem } from "./search-api-provider.js";
import { ArticleFallbackService, isArticleImageFallbackEnabled } from "./article-fallback-service.js";
import type { ImageGenerationService } from "./image-generation-service.js";

const execFileAsync = promisify(execFile);

export type CommandResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number;
};

export type UnifiedSearchItem = {
  title: string;
  url: string;
  snippet: string;
  source: string;
  platform: string;
};

export type MediaSearchItem = {
  type: "image" | "video";
  title: string;
  pageUrl: string;
  mediaUrl?: string;
  thumbnailUrl?: string;
  source: string;
  snippet?: string;
  width?: number;
  height?: number;
  duration?: string;
  /** 对比分组元数据（由 searchImagesBatch 注入，供前端分组渲染） */
  compareSide?: "A" | "B";
  compareLabel?: string;
  compareGroup?: string;
};

export class UpstreamSearchService {
  // 社交平台搜索结果缓存（3 分钟 TTL，避免重复调用 mcporter）
  private readonly socialCache = new SearchCache<{ provider: string; raw: string; notes: string[] }>({
    maxSize: 50,
    ttlMs: 3 * 60 * 1000,
  });

  // 泛网页搜索 query 级缓存（短 TTL）。
  // 同一 query 在短窗口内被重复搜索（Agent 重问/变体重叠/fetch 前判断）时直接命中，
  // 省一次 API/爬取网络请求，也避免把同一批结果反复注入给 LLM 造成 token 重复消耗。
  private readonly webQueryCache = new SearchCache<{
    provider: string;
    items: InfoSearchItem[];
    fetchedAt: string;
    searchDateLocal: string;
    notes: string[];
  }>({
    maxSize: 120,
    ttlMs: 30 * 1000,
  });

  private imageStorageService?: ImageGenerationService;

  private readonly now: () => Date;
  private readonly articleFallback: ArticleFallbackService;

  constructor(
    private readonly infoHubService: InfoHubService,
    opts: { now?: () => Date } = {},
  ) {
    // 统一时间源：按项目约定用注入的 now，服务内不直接读系统时钟。
    this.now = opts.now ?? (() => new Date());
    this.articleFallback = new ArticleFallbackService({ now: this.now });
  }

  setImageStorageService(service: ImageGenerationService): void {
    this.imageStorageService = service;
  }

  async searchUnified(input: {
    query: string;
    limit?: number;
    platform?: string;
  }): Promise<{
    provider: string;
    platform: string;
    items: UnifiedSearchItem[];
    notes: string[];
  }> {
    const query = String(input.query ?? "").trim();
    const limit = clamp(Number(input.limit ?? 12), 1, 25);
    const platform = String(input.platform ?? "auto").trim().toLowerCase();
    if (!query) {
      return { provider: "none", platform, items: [], notes: ["query 不能为空"] };
    }

    if (platform === "web") {
      const web = await this.searchWeb(query, limit);
      return {
        provider: web.provider,
        platform,
        items: web.items.map((x) => ({ ...x, platform: "web" })),
        notes: web.notes,
      };
    }
    if (platform === "weibo") {
      const hit = await this.searchWeibo(query, limit);
      return {
        provider: hit.provider,
        platform,
        items: rawToItems(hit.raw, "weibo", "weibo"),
        notes: hit.notes,
      };
    }
    if (platform === "xiaohongshu") {
      const hit = await this.searchXiaohongshu(query, limit);
      return {
        provider: hit.provider,
        platform,
        items: rawToItems(hit.raw, "xiaohongshu", "xiaohongshu"),
        notes: hit.notes,
      };
    }
    if (platform === "wechat") {
      const hit = await this.searchWechat(query, limit);
      return {
        provider: hit.provider,
        platform,
        items: rawToItems(hit.raw, "wechat", "wechat"),
        notes: hit.notes,
      };
    }
    if (platform === "douyin") {
      const hit = await this.searchDouyin(query, limit);
      return {
        provider: hit.provider,
        platform,
        items: rawToItems(hit.raw, "douyin", "douyin"),
        notes: hit.notes,
      };
    }
    if (platform === "github") {
      const hit = await this.searchGithubRepos(query, limit);
      return {
        provider: hit.provider,
        platform,
        items: hit.items.map((x) => ({
          title: x.fullName,
          url: x.url,
          snippet: x.description,
          source: "GitHub",
          platform: "github",
        })),
        notes: hit.notes,
      };
    }

    const notes: string[] = [];
    const merged: UnifiedSearchItem[] = [];
    const seen = new Set<string>();
    const pushItems = (items: UnifiedSearchItem[]) => {
      for (const item of items) {
        const key = item.url.trim().toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        merged.push(item);
      }
    };

    // 并行化：web 搜索 + 社交平台搜索同时发起，避免串行等待
    const isChinese = hasChinese(query) || /微博|小红书|公众号|抖音|b站|国内/.test(query.toLowerCase());
    const socialPromise = isChinese
      ? Promise.all([
          this.searchWeibo(query, Math.min(8, limit)),
          this.searchXiaohongshu(query, Math.min(8, limit)),
          this.searchWechat(query, Math.min(8, limit)),
        ])
      : null;

    const web = await this.searchWeb(query, limit);
    notes.push(...web.notes);
    pushItems(web.items.map((x) => ({ ...x, platform: "web" })));

    // 等待社交平台结果（已与 web 并行执行）
    if (socialPromise) {
      const [weibo, xhs, wechat] = await socialPromise;
      notes.push(...weibo.notes, ...xhs.notes, ...wechat.notes);
      pushItems(rawToItems(weibo.raw, "weibo", "weibo"));
      pushItems(rawToItems(xhs.raw, "xiaohongshu", "xiaohongshu"));
      pushItems(rawToItems(wechat.raw, "wechat", "wechat"));
    }

    return {
      provider: `auto:${web.provider}`,
      platform: "auto",
      items: merged.slice(0, limit),
      notes: dedupeText(notes),
    };
  }

  async searchWeb(query: string, limit = 12): Promise<{
    provider: string;
    items: InfoSearchItem[];
    fetchedAt: string;
    searchDateLocal: string;
    notes: string[];
  }> {
    const keyword = String(query ?? "").trim();
    if (!keyword) {
      return {
        provider: "none",
        items: [],
        fetchedAt: new Date().toISOString(),
        searchDateLocal: getSearchAnchorNow().label,
        notes: ["query 不能为空"],
      };
    }
    const boundedLimit = clamp(limit, 1, 25);
    const anchor = getSearchAnchorNow();
    const cacheKey = `${keyword.toLowerCase()}|${boundedLimit}`;
    const cached = this.webQueryCache.get(cacheKey);
    if (cached) {
      return {
        ...cached,
        notes: [...cached.notes, "命中 30s 搜索缓存"],
      };
    }
    const raw = await this.infoHubService.search(keyword, boundedLimit);
    const fresh = applySearchFreshness(raw, { query: keyword });
    const maxAgeDays = Number(process.env.SEARCH_MAX_ITEM_AGE_DAYS ?? 120);
    const providerUsed = inferSearchProvider(fresh.items);
    const result = {
      provider: providerUsed,
      items: fresh.items,
      fetchedAt: anchor.iso,
      searchDateLocal: anchor.label,
      notes: [
        providerUsed === "domestic-bing-cn"
          ? "必应中国 RSS + 国内科技 RSS"
          : providerUsed.startsWith("api:")
            ? `搜索 API(${providerUsed}) 直出（API 结果不与爬虫混排）`
            : `搜索 API(${providerUsed}) + 国内引擎兜底（相关性过滤）`,
        formatSearchFreshnessNote({ anchor, droppedStale: fresh.droppedStale, maxAgeDays }),
      ],
    };
    this.webQueryCache.set(cacheKey, result);
    return result;
  }

  async searchImages(query: string, limit = 4, actorId = "anonymous"): Promise<{
    provider: string;
    mediaType: "image";
    items: MediaSearchItem[];
    notes: string[];
  }> {
    const keyword = String(query ?? "").trim();
    if (!keyword) {
      return { provider: "bing-images", mediaType: "image", items: [], notes: ["query 不能为空"] };
    }
    // 单次默认 4、上限 8：单 call 不应铺一整面图墙；
    // LLM 需要更多张时应拆成多个细粒度 query 并行搜（如多个地点/多个主题各搜一次），
    // 由前端 renderBlocks 把「每段文字→对应一组照片」自然交错。
    const boundedLimit = clamp(limit, 1, 8);

    // 优先走已接入的搜索 API（search-images-via-search-api）拿真实图源 URL；
    // 与正文搜索 searchWeb 同源策略：API 优先，爬图片网页仅作兜底。
    const apiItems = await searchImagesViaSearchApi(keyword, boundedLimit);
    if (apiItems.length > 0) {
      const items = await this.materializeImageResults(
        apiItems.map((it) => ({
          type: "image" as const,
          title: it.title,
          pageUrl: it.pageUrl || it.mediaUrl,
          mediaUrl: it.mediaUrl,
          thumbnailUrl: it.thumbnailUrl,
          source: it.source || "SearchApi",
        })),
        actorId,
        boundedLimit,
      );
      if (items.length > 0) {
        return {
          provider: "search-api-images",
          mediaType: "image",
          items,
          notes: [`搜索 API 图片搜索优先（已转存 PNG）；pageUrl 保留原始来源页`],
        };
      }
    }

    // API 未接入/缺 key/失败/空结果 → 回退到爬 cn.bing.com 图片网页兜底。
    const url = `https://cn.bing.com/images/search?q=${encodeURIComponent(keyword)}&form=HDRSC2`;
    const html = await this.fetchText(url, IMAGE_FETCH_TIMEOUT_MS);
    const rawItems = parseBingImageResults(html, boundedLimit);
    const items = await this.materializeImageResults(rawItems, actorId, boundedLimit);
    if (items.length > 0) {
      return {
        provider: "bing-images",
        mediaType: "image",
        items,
        notes: ["mediaUrl/thumbnailUrl 已转存为服务端本地 PNG；pageUrl 保留原始来源页"],
      };
    }

    // 兜底（默认开，ARTICLE_IMAGE_FALLBACK=0 可关）：搜索引擎对人物/主题类查询往往
    // 只返回**文章链接**而不给图片直链。此时改从文章页里抠真实图链，
    // 再走同一套 materializeImageResults 转存——不另起下载链路。
    if (isArticleImageFallbackEnabled()) {
      const harvested = await this.harvestImagesFromArticles(keyword, boundedLimit);
      const fallbackItems = harvested.length
        ? await this.materializeImageResults(harvested, actorId, boundedLimit)
        : [];
      if (fallbackItems.length > 0) {
        return {
          provider: "article-fallback-images",
          mediaType: "image",
          items: fallbackItems,
          notes: ["搜索 API 与图片页均未命中；已改从文章页抠取真实图链（带 Referer 回源）"],
        };
      }
    }

    return {
      provider: "bing-images",
      mediaType: "image",
      items: [],
      notes: ["未能把图片结果转存为 PNG，已避免返回普通网页链接"],
    };
  }

  /**
   * 文章页兜底：用同一关键词跑一次正文搜索拿到文章 URL，再从文章页抠图链。
   *
   * 只在「search-api 图片源」与「bing 图片页」都未命中时进入，预算独立且短
   * （ARTICLE_FALLBACK_TIMEOUT_MS），并且到点即停——不能拖垮整次 search_images。
   */
  private async harvestImagesFromArticles(keyword: string, limit: number): Promise<MediaSearchItem[]> {
    const deadlineAt = this.now().getTime() + ARTICLE_FALLBACK_TIMEOUT_MS;
    try {
      const web = await this.searchWeb(keyword, ARTICLE_FALLBACK_MAX_ARTICLES * 2);
      const urls = [...new Set((web.items ?? []).map((it) => it.url).filter((u) => /^https?:\/\//.test(u)))]
        .slice(0, ARTICLE_FALLBACK_MAX_ARTICLES);
      if (urls.length === 0) return [];
      const candidates = await this.articleFallback.harvestImageCandidates(urls, {
        deadlineAt,
        maxConcurrency: 2,
        maxImages: clamp(limit * 4, 8, 32),
      });
      if (this.now().getTime() >= deadlineAt) return [];
      return candidates.slice(0, limit * 3).map((c) => ({
        type: "image" as const,
        title: keyword,
        pageUrl: c.articleUrl,
        mediaUrl: c.url,
        thumbnailUrl: c.url,
        source: "article-fallback",
      }));
    } catch {
      return [];
    }
  }

  /**
   * 对比式批量图片搜索（代码层实现，不依赖 LLM prompt 编排）。
   *
   * 一次调用按「对比维度 × 两侧」并行出图，返回分组结构 mediaGroups：
   *   - query 含 `A vs B`/`A对比B`/`A和B对比` 时自动拆成 sideA/sideB 两侧；
   *   - dimensions 提供多个维度（水屋/沙屋/餐厅…）时，每个维度生成
   *     `${sideA} ${维度}` 与 `${sideB} ${维度}` 两组并行搜索；
   *   - 未提供 dimensions 时退化为单组：用两侧公共子串推断维度标题。
   *
   * 每一张图都打上 compareSide / compareLabel / compareGroup 标记，
   * 前端据此按维度分组、左右两侧分栏渲染（对比图不再混作一张九宫格）。
   */
  async searchImagesBatch(
    query: string,
    dimensions: string[] | undefined,
    limitPerGroup: number,
    actorId: string,
  ): Promise<{
    provider: string;
    mediaType: "image";
    items: MediaSearchItem[];
    mediaGroups?: Array<{
      title: string;
      sideA: string;
      sideB?: string;
      itemsA: MediaSearchItem[];
      itemsB: MediaSearchItem[];
    }>;
    notes: string[];
  }> {
    const keyword = String(query ?? "").trim();
    if (!keyword) {
      return { provider: "none", mediaType: "image", items: [], mediaGroups: [], notes: ["query 不能为空"] };
    }

    // 1) 解析两侧：query 内带对比连接词则拆成 A/B，否则整句作为单侧
    const pair = splitCompareQuery(keyword);
    const sideA = pair?.sideA ?? keyword;
    const sideB = pair?.sideB;

    // 2) 组装分组规格：dimensions 优先；否则单组 + LCS 推断维度标题
    const dimList = (dimensions ?? [])
      .map((d) => String(d ?? "").trim())
      .filter((d) => d && d.length <= 20)
      .slice(0, MAX_COMPARE_GROUPS);
    const groups: Array<{ title: string; qA: string; qB?: string }> = [];
    if (dimList.length > 0) {
      for (const dim of dimList) {
        groups.push({
          title: dim,
          qA: `${sideA} ${dim}`.trim(),
          qB: sideB ? `${sideB} ${dim}`.trim() : undefined,
        });
      }
    } else {
      const dim = pair ? cleanDimension(longestCommonSubstring(sideA, sideB ?? "")) : "";
      groups.push({ title: dim, qA: sideA, qB: sideB });
    }

    // 3) 每侧保留张数（对比图追求"分类清、不混排"，单侧限制更小）
    const perSide = Math.max(1, Math.min(limitPerGroup, MAX_IMAGES_PER_SIDE));

    // 4) 所有组 × 两侧并行搜索（组间并行，受 12s 工具超时约束；搜索内部自带转存预算）
    const settled = await Promise.allSettled(
      groups.map(async (g) => {
        const [a, b] = await Promise.all([
          this.searchImages(g.qA, perSide, actorId),
          g.qB ? this.searchImages(g.qB, perSide, actorId) : Promise.resolve(null),
        ]);
        return { g, a, b };
      }),
    );

    const mediaGroups: Array<{
      title: string;
      sideA: string;
      sideB?: string;
      itemsA: MediaSearchItem[];
      itemsB: MediaSearchItem[];
    }> = [];
    const flatItems: MediaSearchItem[] = [];
    const oneSidedDims: string[] = [];
    for (const r of settled) {
      if (r.status !== "fulfilled") continue;
      const { g, a, b } = r.value;
      const itemsA = tagCompareSide(a?.items ?? [], "A", sideA, g.title);
      const itemsB = tagCompareSide(b?.items ?? [], "B", sideB ?? "", g.title);
      if (itemsA.length === 0 && itemsB.length === 0) continue;
      // 容错标注：某维度仅搜到单侧图片时，记录维度名供 notes 透出（前端分栏显示空侧）
      if (itemsA.length === 0 || itemsB.length === 0) {
        oneSidedDims.push(g.title);
      }
      mediaGroups.push({ title: g.title, sideA, sideB, itemsA, itemsB });
      flatItems.push(...itemsA, ...itemsB);
    }

    // 5) 兜底：全组失败 → 退化单侧搜索，保证至少出图
    if (mediaGroups.length === 0) {
      const fallback = await this.searchImages(sideA, perSide, actorId);
      if (fallback.items.length > 0) {
        const dim = pair ? cleanDimension(longestCommonSubstring(sideA, sideB ?? "")) : "";
        mediaGroups.push({
          title: dim,
          sideA,
          sideB,
          itemsA: tagCompareSide(fallback.items, "A", sideA, dim),
          itemsB: [],
        });
        flatItems.push(...fallback.items);
      }
    }

    const notes: string[] = [
      `已按 ${mediaGroups.length} 个维度分组对比出图，每侧各取 ${perSide} 张`,
    ];
    if (oneSidedDims.length > 0) {
      notes.push(
        `维度「${oneSidedDims.join("、")}」仅搜到单侧图片，另一侧暂无图`,
      );
    }

    return {
      provider: pair ? "compare-batch" : "image-batch",
      mediaType: "image",
      items: flatItems,
      mediaGroups,
      notes,
    };
  }

  async searchVideos(query: string, limit = 8): Promise<{
    provider: string;
    mediaType: "video";
    items: MediaSearchItem[];
    notes: string[];
  }> {
    const keyword = String(query ?? "").trim();
    if (!keyword) {
      return { provider: "none", mediaType: "video", items: [], notes: ["query 不能为空"] };
    }
    const boundedLimit = clamp(limit, 1, 12);

    // 三源并行（2026-09-13 根修「搜出来的视频不对」）：
    //  - Bing 视频页直抓：改版后 mmeta/vrhm 只剩推广位携带，服务端直抓的有机结果
    //    常为 0-1 条且混着广告位视频（真实测试：搜「刘浩存」首位是「新笔记本设置」），
    //    解析后按查询词相关性门禁剔除推广位；
    //  - B站公开搜索接口：无需登录直出播放页+真实缩略图+时长，覆盖质量稳定；
    //  - 社交平台中转：与 search_web 的微博/抖音源同口径——平台 MCP 未配置时用
    //    site: 限定搜索过滤出视频播放页直链（抖音/微博/腾讯视频/西瓜），实测
    //    产出稀疏但真实，作为第三源补充（任一源失败不拖垮其余源）。
    // 各源按比例分配名额：B站源质量最高（真实缩略图+时长）占大头，中转源
    // 留出固定份额——否则先到源带满 limit 名额，后到源永远进不了最终列表。
    const biliLimit = Math.max(3, Math.ceil(boundedLimit * 0.75));
    const relayLimit = Math.max(2, Math.ceil(boundedLimit * 0.5));
    const [bingParsed, biliItems, relayItems] = await Promise.all([
      this.fetchText(`https://cn.bing.com/videos/search?q=${encodeURIComponent(keyword)}`, 10_000)
        .then((html) => parseBingVideoResults(html, boundedLimit, keyword))
        .catch(() => [] as MediaSearchItem[]),
      this.searchBilibiliVideos(keyword, biliLimit).catch(() => [] as MediaSearchItem[]),
      Promise.race([
        this.searchSocialVideoRelay(keyword, relayLimit),
        new Promise<MediaSearchItem[]>((resolve) => setTimeout(() => resolve([]), 9_000)),
      ]).catch(() => [] as MediaSearchItem[]),
    ]);

    // 合并名额（2026-10-02 根修）：Bing 视频源产出几乎全是抖音页，而抖音页当前
    // 解析不出可播流（yby6 MCP 上游恒失败）——若让 Bing 先带满 limit，B站候选会被
    // 整段挤掉，「按内容找视频」只能回一堆点不开的链接。现在给 Bing/中转各留固定
    // 份额，B站源在名额内优先占位，剩余额度再由 Bing 补满（保召回也保可播）。
    const bingQuota = Math.max(2, Math.round(boundedLimit * 0.35));
    const relayQuota = Math.max(1, Math.round(boundedLimit * 0.15));
    const merged = dedupeMediaByPageUrl([
      ...bingParsed.slice(0, bingQuota),
      ...biliItems,
      ...relayItems.slice(0, relayQuota),
      ...bingParsed.slice(bingQuota),
      ...relayItems.slice(relayQuota),
    ]).slice(0, boundedLimit);
    if (merged.length >= Math.min(3, boundedLimit)) {
      const sources = [
        bingParsed.length > 0 ? "bing-videos" : null,
        biliItems.length > 0 ? "bilibili-api" : null,
        relayItems.length > 0 ? "social-relay" : null,
      ].filter(Boolean);
      return {
        provider: sources.join("+") || "none",
        mediaType: "video",
        items: merged,
        notes: ["返回 pageUrl 可打开播放页；thumbnailUrl 可用于对话内预览"],
      };
    }

    // 仍不足 → 网页搜索兜底：只收播放页直链。旧版还按「标题含 视频/bilibili/播放」
    // 放行，把 B站搜索页/个人空间/豆瓣豆列/X主页等非视频页全混进了结果
    // （真实测试实证），现在必须 URL 命中视频播放页特征才收。
    const web = await this.searchWeb(`${keyword} 视频 OR site:bilibili.com OR site:youtube.com`, boundedLimit);
    const fallback = web.items
      .filter((item) => isLikelyVideoUrl(item.url))
      .slice(0, boundedLimit)
      .map((item) => ({
        type: "video" as const,
        title: item.title,
        pageUrl: item.url,
        source: inferMediaSource(item.url, item.source),
        snippet: item.snippet,
      }));
    const items = dedupeMediaByPageUrl([...merged, ...fallback]).slice(0, boundedLimit);
    const sources = [
      bingParsed.length > 0 ? "bing-videos" : null,
      biliItems.length > 0 ? "bilibili-api" : null,
      relayItems.length > 0 ? "social-relay" : null,
      fallback.length > 0 ? "web-fallback" : null,
    ].filter(Boolean);
    return {
      provider: sources.join("+") || "none",
      mediaType: "video",
      items,
      notes:
        items.length > 0
          ? ["视频直抓结果较少，已补充视频播放页网页结果"]
          : ["各视频源均未返回结果"],
    };
  }

  /** B站公开搜索接口（无需登录）：search_type=video 直出播放页/缩略图/时长。 */
  private async searchBilibiliVideos(keyword: string, limit: number): Promise<MediaSearchItem[]> {
    // search_type=video 已限定视频域，关键词尾缀「视频」冗余，且实测同一 IP 无
    // cookie 直查带尾缀词更易触发风控 412（「刘浩存 视频」稳定 412，「刘浩存」放行）
    const bareKeyword = keyword.replace(/\s*视频\s*$/, "").trim() || keyword;
    const cookie = await resolveBilibiliCookie();
    const url = `https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=${encodeURIComponent(bareKeyword)}`;
    // 不带 referer/cookie 会被风控拦（412），必须带站内搜索来源与首页种下的 cookie
    const text = await this.fetchText(url, 8_000, "https://search.bilibili.com/", cookie);
    const json = tryParseJson<BilibiliVideoSearchResponse>(text);
    const list =
      json?.code === 0 && Array.isArray(json?.data?.result) ? json.data.result : [];
    return list
      .slice(0, limit)
      .map((it) => {
        const rawPage = it.arcurl || (it.bvid ? `https://www.bilibili.com/video/${it.bvid}` : "");
        // B站返回 http:// 链接与 // 协议相对图址，统一升 https 避免前端混合内容拦截
        const pageUrl = rawPage.replace(/^http:\/\//, "https://");
        const rawPic = typeof it.pic === "string" && it.pic.trim() ? it.pic.trim() : "";
        const thumbnailUrl = rawPic
          ? rawPic.startsWith("//")
            ? `https:${rawPic}`
            : rawPic.replace(/^http:\/\//, "https://")
          : undefined;
        const item: MediaSearchItem = {
          type: "video",
          // 标题/摘要里的 <em class="keyword"> 高亮标签用空串剥离（stripTags 的
          // 空格替换会在中文标题里留下「周星驰 电影 片段」式假空格）
          title:
            decodeHtmlEntities(String(it.title ?? "").replace(/<[^>]+>/g, "")).trim() ||
            "B站视频",
          pageUrl,
          mediaUrl: pageUrl,
          thumbnailUrl,
          duration: typeof it.duration === "string" && it.duration ? it.duration : undefined,
          source: "哔哩哔哩",
          snippet: decodeHtmlEntities(String(it.description ?? "").replace(/<[^>]+>/g, "")).slice(0, 200),
        };
        return item;
      })
      .filter((it) => /^https?:\/\//i.test(it.pageUrl));
  }

  /**
   * 社交平台视频中转（与 search_web 的微博/抖音平台源同口径）：
   * 平台搜索 MCP 未配置、无登录态时，用 site: 限定搜索过滤出视频播放页直链。
   * 实测产出稀疏（每查询 1-2 条真实直链）且混大量站外结果，靠 URL 白名单过滤，
   * 只作为主源（B站/Bing）之外的补充。
   */
  private async searchSocialVideoRelay(keyword: string, limit: number): Promise<MediaSearchItem[]> {
    const web = await this.searchWeb(
      `${keyword} 视频 OR site:douyin.com OR site:weibo.com OR site:v.qq.com OR site:ixigua.com`,
      limit,
    );
    return web.items
      // 中转结果混大量站外/主页噪声，比 isLikelyVideoUrl 更严：必须是播放页直链
      // （抖音必须 /video/，排除用户主页；B站必须 /video/；微博必须 tv 页）
      .filter((item) => SOCIAL_VIDEO_PAGE_RE.test(item.url))
      .slice(0, limit)
      .map((item) => ({
        type: "video" as const,
        title: item.title,
        pageUrl: item.url,
        source: inferMediaSource(item.url, item.source),
        snippet: item.snippet,
      }));
  }

  async readWeb(url: string): Promise<{ title: string; content: string; summary: string }> {
    return this.infoHubService.readWebpage(url);
  }

  async searchGithubRepos(query: string, limit = 10): Promise<{
    provider: string;
    items: Array<{ fullName: string; description: string; url: string; stars?: number }>;
    notes: string[];
  }> {
    const keyword = String(query ?? "").trim();
    if (!keyword) {
      return { provider: "none", items: [], notes: ["query 不能为空"] };
    }
    const boundedLimit = clamp(limit, 1, 20);
    const args = [
      "search",
      "repos",
      keyword,
      "--limit",
      String(boundedLimit),
      "--json",
      "nameWithOwner,description,url,stargazerCount",
    ];
    const run = await this.runCommand(resolveBin("gh"), args, 15000);
    if (!run.ok) {
      return {
        provider: "gh",
        items: [],
        notes: [formatFailure("gh", run)],
      };
    }
    try {
      const parsed = JSON.parse(run.stdout) as Array<{
        nameWithOwner?: string;
        description?: string;
        url?: string;
        stargazerCount?: number;
      }>;
      const items = parsed
        .filter((x) => x.url && x.nameWithOwner)
        .map((x) => ({
          fullName: x.nameWithOwner ?? "",
          description: x.description ?? "",
          url: x.url ?? "",
          stars: Number.isFinite(x.stargazerCount) ? x.stargazerCount : undefined,
        }));
      return { provider: "gh", items, notes: [] };
    } catch {
      return {
        provider: "gh",
        items: [],
        notes: ["gh 输出解析失败，请先本地验证 `gh search repos` 命令"],
      };
    }
  }

  async searchReddit(query: string, limit = 10): Promise<{
    provider: string;
    raw: string;
    notes: string[];
  }> {
    const keyword = String(query ?? "").trim();
    if (!keyword) return { provider: "rdt", raw: "", notes: ["query 不能为空"] };
    const boundedLimit = clamp(limit, 1, 20);
    const run = await this.runCommand(resolveBin("rdt"), ["search", keyword, "--limit", String(boundedLimit)], 20000);
    if (!run.ok) {
      return { provider: "rdt", raw: "", notes: [formatFailure("rdt", run)] };
    }
    return { provider: "rdt", raw: run.stdout.slice(0, 12000), notes: [] };
  }

  async readYoutube(url: string): Promise<{
    provider: string;
    title: string;
    channel: string;
    durationSeconds?: number;
    description: string;
    notes: string[];
  }> {
    const rawUrl = String(url ?? "").trim();
    if (!rawUrl) {
      return { provider: "youtube-oembed", title: "", channel: "", description: "", notes: ["url 不能为空"] };
    }
    // 使用 YouTube oEmbed 公开接口获取标题/作者/封面（无需登录、无外部二进制依赖）
    try {
      const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(rawUrl)}&format=json`;
      const text = await this.fetchText(oembedUrl, 10_000);
      const parsed = JSON.parse(text) as {
        title?: string;
        author_name?: string;
        thumbnail_url?: string;
      };
      if (parsed.title) {
        return {
          provider: "youtube-oembed",
          title: parsed.title ?? "",
          channel: parsed.author_name ?? "",
          description: parsed.thumbnail_url ? `封面: ${parsed.thumbnail_url}` : "",
          notes: [],
        };
      }
      return {
        provider: "youtube-oembed",
        title: "",
        channel: "",
        description: "",
        notes: ["oEmbed 未返回标题，可能链接无效或视频受限"],
      };
    } catch {
      return {
        provider: "youtube-oembed",
        title: "",
        channel: "",
        description: "",
        notes: ["YouTube oEmbed 解析失败，请确认链接可公开访问"],
      };
    }
  }

  async searchWeibo(query: string, limit = 10): Promise<{
    provider: string;
    raw: string;
    notes: string[];
  }> {
    const keyword = String(query ?? "").trim();
    if (!keyword) return { provider: "weibo", raw: "", notes: ["query 不能为空"] };
    const boundedLimit = clamp(limit, 1, 20);
    const cacheKey = `weibo:${keyword}:${boundedLimit}`;
    const cached = this.socialCache.get(cacheKey);
    if (cached) return cached;
    const attempts = [
      `weibo.search_weibo_content(keyword: ${JSON.stringify(keyword)}, limit: ${boundedLimit})`,
      `weibo.search_content(keyword: ${JSON.stringify(keyword)}, limit: ${boundedLimit})`,
    ];
    const run = await this.callMcporterAttempts(attempts, 12_000);
    if (!run.ok) {
      return this.relayPlatform("weibo", keyword, boundedLimit, run.note);
    }
    const result = { provider: "weibo", raw: run.stdout.slice(0, 12000), notes: [] };
    this.socialCache.set(cacheKey, result);
    return result;
  }

  async readBilibili(url: string): Promise<{
    provider: string;
    title: string;
    channel: string;
    durationSeconds?: number;
    description: string;
    notes: string[];
  }> {
    const rawUrl = String(url ?? "").trim();
    if (!rawUrl) {
      return { provider: "bilibili-api", title: "", channel: "", description: "", notes: ["url 不能为空"] };
    }
    // 使用 B站公开信息接口（无需登录、无外部二进制依赖）
    const bvid = rawUrl.match(/[bB][vV][0-9A-Za-z]{8,}/)?.[0];
    if (!bvid) {
      return { provider: "bilibili-api", title: "", channel: "", description: "", notes: ["链接中未找到 bvid"] };
    }
    try {
      const text = await this.fetchText(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, 10_000);
      const parsed = JSON.parse(text) as {
        code?: number;
        data?: {
          title?: string;
          desc?: string;
          pic?: string;
          duration?: number;
          owner?: { name?: string };
        };
      };
      const data = parsed.data;
      if (data?.title) {
        return {
          provider: "bilibili-api",
          title: data.title ?? "",
          channel: data.owner?.name ?? "",
          durationSeconds: Number.isFinite(data.duration) ? data.duration : undefined,
          description: String(data.desc ?? "").slice(0, 5000),
          notes: data.pic ? [`封面: ${data.pic}`] : [],
        };
      }
      return {
        provider: "bilibili-api",
        title: "",
        channel: "",
        description: "",
        notes: ["B站接口未返回视频信息，可能视频已删除或需要登录"],
      };
    } catch {
      return {
        provider: "bilibili-api",
        title: "",
        channel: "",
        description: "",
        notes: ["B站接口解析失败，请确认链接有效"],
      };
    }
  }

  async searchXiaohongshu(query: string, limit = 10): Promise<{
    provider: string;
    raw: string;
    notes: string[];
  }> {
    const keyword = String(query ?? "").trim();
    if (!keyword) return { provider: "xiaohongshu", raw: "", notes: ["query 不能为空"] };
    const boundedLimit = clamp(limit, 1, 20);
    const cacheKey = `xhs:${keyword}:${boundedLimit}`;
    const cached = this.socialCache.get(cacheKey);
    if (cached) return cached;
    const attempts = [
      `xiaohongshu.search_feeds(keyword: ${JSON.stringify(keyword)}, limit: ${boundedLimit})`,
      `xhs.search_feeds(keyword: ${JSON.stringify(keyword)}, limit: ${boundedLimit})`,
    ];
    const run = await this.callMcporterAttempts(attempts, 15_000);
    if (!run.ok) {
      return this.relayPlatform("xiaohongshu", keyword, boundedLimit, run.note);
    }
    const result = { provider: "xiaohongshu", raw: run.stdout.slice(0, 12000), notes: [] };
    this.socialCache.set(cacheKey, result);
    return result;
  }

  /**
   * B站视频评论（真实观众留言）。
   *
   * 为什么拿它当 POI 口碑源：中文 UGC 里结构化评论几乎都要登录态
   * （小红书 / 大众点评 / 携程），而 B站公开视频的评论区带首页 cookie + 站内
   * Referer 即可读——且「某地点相关视频下的评论」本来就是去过的人说的话，
   * 与 POI 的相关性天然成立。评论区关掉或视频太冷门时返回空数组。
   *
   * @param videoUrl 视频播放页（av 号；BV 号会先经 view 接口换算）
   */
  async searchBilibiliReplies(
    videoUrl: string,
    limit = 6,
  ): Promise<Array<{ author: string; text: string; like: number; pageUrl: string }>> {
    const aid = await resolveBilibiliAid(videoUrl);
    if (!aid) return [];
    const bounded = Math.max(1, Math.min(20, limit));
    try {
      const cookie = await resolveBilibiliCookie();
      const res = await fetch(
        `https://api.bilibili.com/x/v2/reply?type=1&oid=${aid}&sort=2&ps=${bounded}&pn=1`,
        {
          headers: {
            "user-agent": process.env.WEB_FETCH_USER_AGENT ?? BILIBILI_UA,
            referer: `https://www.bilibili.com/video/av${aid}`,
            ...(cookie ? { cookie } : {}),
          },
          signal: AbortSignal.timeout(8_000),
        },
      );
      const json = (await res.json()) as {
        code?: number;
        data?: { replies?: Array<{ member?: { uname?: string }; content?: { message?: string }; like?: number }> };
      };
      if (json.code !== 0) return [];
      return (json.data?.replies ?? [])
        .map((r) => ({
          author: r.member?.uname?.trim() || "B站用户",
          // B站表情是 [妙啊] / [呲牙] 这类方括号标签，直接摘出来读起来像乱码；
          // 视频本身的弹幕式短评也偏噪声，所以正文门槛放到 6 字。
          text: String(r.content?.message ?? "")
            .replace(/\[[^[\]]{1,12}\]/g, "")
            .replace(/\s+/g, " ")
            .trim(),
          like: r.like ?? 0,
          pageUrl: `https://www.bilibili.com/video/av${aid}`,
        }))
        .filter((r) => r.text.length >= 6);
    } catch {
      return [];
    }
  }

  async searchWechat(query: string, limit = 10): Promise<{
    provider: string;
    raw: string;
    notes: string[];
  }> {
    const keyword = String(query ?? "").trim();
    if (!keyword) return { provider: "wechat", raw: "", notes: ["query 不能为空"] };
    const boundedLimit = clamp(limit, 1, 20);
    const cacheKey = `wechat:${keyword}:${boundedLimit}`;
    const cached = this.socialCache.get(cacheKey);
    if (cached) return cached;
    const attempts = [
      `wechat.search_articles(keyword: ${JSON.stringify(keyword)}, limit: ${boundedLimit})`,
      `wechat.search_wechat_articles(keyword: ${JSON.stringify(keyword)}, limit: ${boundedLimit})`,
    ];
    const run = await this.callMcporterAttempts(attempts, 15_000);
    if (!run.ok) {
      return this.relayPlatform("wechat", keyword, boundedLimit, run.note);
    }
    const result = { provider: "wechat", raw: run.stdout.slice(0, 12000), notes: [] };
    this.socialCache.set(cacheKey, result);
    return result;
  }

  async searchDouyin(query: string, limit = 10): Promise<{
    provider: string;
    raw: string;
    notes: string[];
  }> {
    const keyword = String(query ?? "").trim();
    if (!keyword) return { provider: "douyin", raw: "", notes: ["query 不能为空"] };
    const boundedLimit = clamp(limit, 1, 20);
    const cacheKey = `douyin:${keyword}:${boundedLimit}`;
    const cached = this.socialCache.get(cacheKey);
    if (cached) return cached;
    const attempts = [
      `douyin.search(keyword: ${JSON.stringify(keyword)}, limit: ${boundedLimit})`,
      `douyin.search_videos(keyword: ${JSON.stringify(keyword)}, limit: ${boundedLimit})`,
    ];
    const run = await this.callMcporterAttempts(attempts, 15_000);
    if (!run.ok) {
      return this.relayPlatform("douyin", keyword, boundedLimit, run.note);
    }
    const result = { provider: "douyin", raw: run.stdout.slice(0, 12000), notes: [] };
    this.socialCache.set(cacheKey, result);
    return result;
  }

  async checkUpstreamHealth(): Promise<{
    bins: Record<string, { ok: boolean; detail: string }>;
    mcpHints: Record<string, string>;
  }> {
    const targets: Array<{ key: string; bin: string }> = [
      { key: "mcporter", bin: resolveBin("mcporter") },
      { key: "gh", bin: resolveBin("gh") },
      { key: "rdt", bin: resolveBin("rdt") },
    ];
    const bins: Record<string, { ok: boolean; detail: string }> = {};
    for (const t of targets) {
      const run = await this.runCommand(t.bin, ["--version"], 6000);
      bins[t.key] = run.ok
        ? { ok: true, detail: (run.stdout || run.stderr || "ok").split(/\r?\n/)[0] ?? "ok" }
        : { ok: false, detail: (run.stderr || run.stdout || "not found").slice(0, 200) };
    }
    return {
      bins,
      mcpHints: {
        weibo: "需要 mcporter 中存在 weibo server alias",
        xiaohongshu: "需要 mcporter 中存在 xiaohongshu 或 xhs server alias",
        wechat: "需要 mcporter 中存在 wechat server alias",
        douyin: "需要 mcporter 中存在 douyin server alias",
      },
    };
  }

  // ---- 平台未配置 MCP 时的公开网页兜底 ----
  // 实测：微博/小红书/抖音的「正文/笔记」在无登录态下均无法直接抓取（访客验证/签名/动态渲染），
  // 且 Bing 中国忽略 `site:` 语法、DuckDuckGo 超时——通用搜索引擎拿不到真实平台域名页面。
  // 因此兜底必须做「平台域名过滤」，只保留命中平台域名的条目，命中不了就诚实返回空，
  // 避免把搜索引擎的泛结果（如财经/知乎页）错标为该平台来源（来源欺骗）。
  private async relayPlatform(
    platform: "weibo" | "xiaohongshu" | "wechat" | "douyin",
    keyword: string,
    limit: number,
    reason: string,
  ): Promise<{ provider: string; raw: string; notes: string[] }> {
    const MATCH: Record<"weibo" | "xiaohongshu" | "wechat" | "douyin", RegExp> = {
      weibo: /(^|\.)weibo\.(com|cn)$/i,
      xiaohongshu: /(^|\.)xiaohongshu\.com$/i,
      wechat: /(^|\.)(mp\.)?weixin\.qq\.com$/i,
      douyin: /(^|\.)douyin\.com$/i,
    };
    const SUFFIX: Record<"weibo" | "xiaohongshu" | "wechat" | "douyin", string> = {
      weibo: "weibo.com",
      xiaohongshu: "xiaohongshu.com",
      wechat: "mp.weixin.qq.com",
      douyin: "douyin.com",
    };
    const baseNote = `${platform} 未配置 MCP（${reason}），且无登录态无法直接抓取正文`;

    // 先用多引擎做 `site:` 限定并过滤出平台域名条目
    const relayQuery = `${keyword} site:${SUFFIX[platform]}`;
    const web = await this.searchWeb(relayQuery, limit);
    const matched = web.items.filter((it) => {
      try {
        return MATCH[platform].test(new URL(it.url).hostname);
      } catch {
        return false;
      }
    });
    if (matched.length > 0) {
      // 格式：相邻行 {标题}\n{url}\n{摘要}，兼容 rawToItems 的「上一行/下一行」解析
      const raw = matched.map((it) => `${it.title || ""}\n${it.url}\n${(it.snippet || "").slice(0, 220)}`).join("\n");
      return {
        provider: `${platform}-relay`,
        raw,
        notes: [`${baseNote}，已返回被搜索引擎收录的 ${platform} 页面（间接结果，可能不完整）`],
      };
    }

    // 抖音：定向搜索不可得时，官方热榜接口可拿到（word_list），作为「抖音信息」的可得来源
    if (platform === "douyin") {
      const hot = await this.fetchDouyinHotSearch(Math.max(5, limit));
      if (hot.length > 0) {
        const raw = hot.map((it) => `${it.title}\n${it.url}\n${it.snippet}`).join("\n");
        return {
          provider: "douyin-hot",
          raw,
          notes: [`${baseNote}，已返回抖音官方热榜（非关键词精确结果，仅热点话题）`],
        };
      }
    }

    return {
      provider: `${platform}-relay`,
      raw: "",
      notes: [`${baseNote}；公开搜索引擎也未返回该平台域名页面，建议配置 mcporter 的 ${platform} server 以获取完整结果`],
    };
  }

  /** 抖音官方热榜公开接口（实测 word_list 可拿，无登录态）；公开给语料管线脚本复用 */
  async fetchDouyinHotSearch(limit: number): Promise<UnifiedSearchItem[]> {
    const text = await this.fetchText(
      "https://www.douyin.com/aweme/v1/web/hot/search/list/?device_platform=webapp",
      6000,
    );
    if (!text) return [];
    try {
      const data = JSON.parse(text) as { data?: { word_list?: Array<{ word?: string; hot_value?: number; sentence?: string }> } };
      const list = data?.data?.word_list ?? [];
      return list
        .slice(0, limit)
        .map((w) => {
          const word = String(w?.word ?? "").trim();
          if (!word) return null;
          const hotValue = Number.isFinite(w?.hot_value) ? `（热度 ${w?.hot_value}）` : "";
          return {
            title: `#${word}${hotValue}`,
            url: `https://www.douyin.com/search/${encodeURIComponent(word)}`,
            snippet: String(w?.sentence ?? w?.word ?? "").slice(0, 120) || "抖音热榜",
            source: "抖音热榜",
            platform: "douyin" as const,
          };
        })
        .filter((x): x is { title: string; url: string; snippet: string; source: string; platform: "douyin" } => x !== null);
    } catch {
      return [];
    }
  }

  private async callMcporterAttempts(
    callExprList: string[],
    timeoutMs: number,
  ): Promise<{ ok: true; stdout: string } | { ok: false; note: string }> {
    for (const callExpr of callExprList) {
      const run = await this.runCommand(resolveBin("mcporter"), ["call", callExpr], timeoutMs);
      if (run.ok) {
        return { ok: true, stdout: run.stdout };
      }
    }
    return { ok: false, note: "mcporter 调用失败，请确认已安装并完成对应平台 MCP 配置" };
  }

  private async runCommand(command: string, args: string[], timeoutMs: number): Promise<CommandResult> {
    try {
      const { stdout, stderr } = await execFileAsync(command, args, {
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024 * 6,
        windowsHide: true,
      });
      return { ok: true, stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), code: 0 };
    } catch (e) {
      const err = e as NodeJS.ErrnoException & {
        code?: string | number;
        stdout?: string;
        stderr?: string;
      };
      const code = typeof err.code === "number" ? err.code : 1;
      if (err.code === "ENOENT") {
        return {
          ok: false,
          stdout: "",
          stderr: `${command} 未安装或不在 PATH 中`,
          code,
        };
      }
      return {
        ok: false,
        stdout: String(err.stdout ?? ""),
        stderr: String(err.stderr ?? err.message ?? "命令执行失败"),
        code,
      };
    }
  }

  private async fetchText(
    url: string,
    timeoutMs: number,
    referer?: string,
    cookie?: string,
  ): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers: Record<string, string> = {
        "user-agent":
          process.env.WEB_FETCH_USER_AGENT ??
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
      };
      if (referer) headers.referer = referer;
      if (cookie) headers.cookie = cookie;
      const response = await fetch(url, {
        signal: controller.signal,
        headers,
        redirect: "follow",
      });
      if (!response.ok) return "";
      return await response.text();
    } catch {
      return "";
    } finally {
      clearTimeout(timer);
    }
  }

  private async materializeImageResults(
    items: MediaSearchItem[],
    actorId: string,
    limit: number,
  ): Promise<MediaSearchItem[]> {
    // 来源闸（2026-10-15 同兴山庄实证）：图搜「住宅区/山庄/小区名」高频返回
    // 百度地图位置截图与图库水印图，转存后顶着 POI 名义展示给用户。三条搜索
    // 路径（search-api / bing 图片页 / 文章页抠图）统一在此单点拦截。
    const usable = items.filter((it) => !isBlockedImageSource(it));
    if (usable.length < items.length) {
      console.log(`[UpstreamSearch] 图片来源闸拦截 ${items.length - usable.length} 张（地图截图/水印图库）`);
    }
    items = usable;

    const storage = this.imageStorageService;
    if (!storage) return items.slice(0, limit);
    const out: MediaSearchItem[] = [];
    // 硬预算：整个转存阶段必须在预算内返回（无论是否全部完成），
    // 否则整次 search_images 会在外圈 12s 工具超时里被整体 kill、items 归零，
    // 导致前端媒体卡片无法注入、照片展示不出来。这里返回"已达成的部分结果"即可。
    const deadline = Date.now() + IMAGE_MATERIALIZE_BUDGET_MS;
    let cursor = 0;

    const workers = Array.from({ length: IMAGE_MATERIALIZE_CONCURRENCY }, async () => {
      while (out.length < limit) {
        if (Date.now() >= deadline) return;
        const idx = cursor++;
        const item = items[idx];
        if (!item) return;
        const remoteUrl = item.mediaUrl || item.thumbnailUrl;
        if (!remoteUrl) continue;
        const remaining = deadline - Date.now();
        if (remaining <= 0) return;
        try {
          // 用剩余预算作为本次下载的截断超时，确保并发任务不会越过预算、
          // Promise.all 能及时收尾，避免整体超时导致 items 丢失。
          const pngUrl = await storage.downloadAndStorePng(remoteUrl, actorId, remaining);
          out.push({
            ...item,
            mediaUrl: pngUrl,
            thumbnailUrl: pngUrl,
            snippet: [item.snippet, "已转存为 PNG"].filter(Boolean).join("；"),
          });
        } catch {
          // 某些外站图片会防盗链或格式不受支持，跳过该候选，继续转存下一张。
        }
      }
    });

    await Promise.all(workers);
    return out;
  }
}

// 图片转存的并发数（并行下载，避免逐张串行拖垮 12s 工具超时）
const IMAGE_MATERIALIZE_CONCURRENCY = 3;
// 图片转存阶段的硬预算：在此时间内返回已达成的部分 items，
// 保证 search_images 在工具超时前正常 resolve，前端能拿到媒体卡片。
const IMAGE_MATERIALIZE_BUDGET_MS = 6_500;
// 图片结果页抓取超时：配合转存预算，保证"抓取 + 转存"总耗时 < 12s 工具预算。
const IMAGE_FETCH_TIMEOUT_MS = 5_000;
// 文章页兜底（搜索引擎只返回文章链接时）的硬预算：只在上述两条路径都失败后追加，
// 且到点即停，避免把问题从"搜不到图"变成"整次 search_images 超时"。
const ARTICLE_FALLBACK_TIMEOUT_MS = 5_000;
// 兜底最多读几篇文章（并发 2）；文章页往往能一次给出多张图。
const ARTICLE_FALLBACK_MAX_ARTICLES = 4;

function clamp(input: number, min: number, max: number): number {
  if (!Number.isFinite(input)) return min;
  return Math.max(min, Math.min(max, Math.floor(input)));
}

// ─────────────────────────────────────────────────────────────────────────────
// 图片来源闸（2026-10-15 同兴山庄实证）
// 图搜「住宅小区/山庄/单位名」高频返回两类垃圾图：地图位置截图（软件生成，
// 无实拍价值）与图库水印预览图（站标水印+编号）。与旅游封面链的
// STOCK_WATERMARK_HOST_SUFFIXES（travel-planning-service.ts）同族语义，此处
// 作用于通用图搜转存链，host 级 + 标题词双闸。
// ─────────────────────────────────────────────────────────────────────────────

/** 地图/位置示意图站：图搜 POI 名高频命中其位置截图页 */
const MAP_SCREENSHOT_HOST_SUFFIXES = [
  'map.baidu.com',   // 百度地图（同兴山庄位置截图实证）
  'map.qq.com',      // 腾讯地图
  'ditu.amap.com',   // 高德地图
  'map.amap.com',
  'autonavi.com',    // 高德图床
  'bdimg.com',       // 百度地图静态图床
  'mapbar.com',
] as const;

/** 图库水印站（与封面链 STOCK_WATERMARK_HOST_SUFFIXES 同族，独立维护防跨模块耦合） */
const WATERMARK_STOCK_HOST_SUFFIXES = [
  '699pic.com',      // 摄图网（贵阳封面实证）
  'nipic.com',       // 昵图网（同兴山庄水印图实证，水印写 www.nipic.cn）
  'nipic.cn',
  'vcg.com',         // 视觉中国
  'gettyimages.com',
  'ibaotu.com',
  '51yuansu.com',
  'gaoding.com',
  '818ps.com',
  'photophoto.cn',
  'quanjing.com',
  'dfic.cn',         // 东方 IC
] as const;

/** 标题特征词（软件图/示意图；裸「地图」不收防误杀「地图鱼」等实拍主题） */
const IMAGE_TITLE_BLOCKED_WORDS = [
  '百度地图', '高德地图', '腾讯地图', '搜狗地图', '北斗地图',
  '位置示意图', '卫星地图', '卫星图', '街景地图', '电子地图', '导航地图', '交通地图',
] as const;

/**
 * 判定图搜候选是否为垃圾来源（地图截图/水印图库）。
 * pageUrl / mediaUrl / thumbnailUrl 任一命中黑名单 host 即拒——地图截图常以
 * 来源页（pageUrl）而非图片直链暴露地图域。
 */
function isBlockedImageSource(item: {
  title?: string;
  pageUrl?: string;
  mediaUrl?: string;
  thumbnailUrl?: string;
}): boolean {
  const urls = [item.pageUrl, item.mediaUrl, item.thumbnailUrl]
    .filter((u): u is string => typeof u === 'string' && /^https?:\/\//.test(u));
  for (const u of urls) {
    try {
      const host = new URL(u).hostname.toLowerCase();
      const blocked = [...MAP_SCREENSHOT_HOST_SUFFIXES, ...WATERMARK_STOCK_HOST_SUFFIXES]
        .some((s) => host === s || host.endsWith(`.${s}`));
      if (blocked) return true;
    } catch { /* 非法 URL 不因它拒，交给下载层 */ }
  }
  const title = String(item.title ?? '');
  return IMAGE_TITLE_BLOCKED_WORDS.some((w) => title.includes(w));
}

// ─────────────────────────────────────────────────────────────────────────────
// 对比式批量图片搜索：代码层拆「A vs B」两侧 + 多维度分组（不依赖 LLM prompt）
// ─────────────────────────────────────────────────────────────────────────────

/** 对比分组数量上限（受 12s 工具超时约束，避免并行搜索过多拖垮整体） */
const MAX_COMPARE_GROUPS = 3;
/** 单侧最多保留图片张数 */
const MAX_IMAGES_PER_SIDE = 3;
/** 维度标题里需要剔除的噪音词 */
const DIMENSION_FILTER_WORDS = [
  "图片", "照片", "图", "长什么样", "长啥样", "怎么样", "什么样", "样子",
  "对比", "比較", "比较", "哪个好", "怎么选", "选择", "选哪个", "看看", "有哪些", "推荐",
];

/**
 * 从 query 中识别成对对比结构：`A vs B` / `A对比B` / `A比较B` / `A pk B` /
 * `A和B对比` / `A与B对比`。需要显式对比连接词，避免误拆普通并列（"鱼和薯条"）。
 * 返回 null 表示非成对 query。
 */
function splitCompareQuery(query: string): { sideA: string; sideB: string } | null {
  const q = String(query ?? "").trim().replace(/\s+/g, " ");
  if (!q) return null;

  // 1) 中置对比连接词：A vs B / A对比B / A比较B / A pk B
  const mid = q.match(
    /^(.*?)\s+(?:vs|VS|pk|PK|对比|比較|比较)(?:\s*[:：]\s*|\s+)(.*)$/,
  );
  if (mid && mid[1].trim() && mid[2].trim()) {
    return { sideA: mid[1].trim(), sideB: mid[2].trim() };
  }

  // 2) 尾部对比结构：A和B对比 / A与B比较（连接词在句末）
  const tail = q.match(
    /^(.*?)(?:和|与)(.*?)(?:对比|比較|比较|PK|pk|哪个好|怎么选|选哪个|选择)(?:\s*)$/,
  );
  if (tail && tail[1].trim() && tail[2].trim()) {
    return { sideA: tail[1].trim(), sideB: tail[2].trim() };
  }

  return null;
}

/**
 * 最长公共子串：用于从「马尔代夫水屋 vs 印尼水屋」这类成对 query 中
 * 提取两侧公共的维度词（如「水屋」）。query 短（<40 字符），O(n³) 可接受。
 */
function longestCommonSubstring(a: string, b: string): string {
  if (!a || !b) return "";
  let best = "";
  const n = a.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j <= n; j++) {
      const sub = a.slice(i, j);
      if (sub.trim().length > best.length && b.includes(sub)) {
        best = sub;
      }
    }
  }
  return best.trim();
}

/** 清洗维度标题：剔除「图片/对比/哪个好」等噪音词，压缩空白。 */
function cleanDimension(dim: string): string {
  if (!dim) return "";
  let out = dim.trim();
  for (const w of DIMENSION_FILTER_WORDS) {
    out = out.split(w).join(" ");
  }
  return out.replace(/\s+/g, " ").trim();
}

/** 给每张图打上对比分组元数据（供前端按维度分组、左右分栏渲染）。 */
function tagCompareSide(
  items: MediaSearchItem[],
  side: "A" | "B",
  label: string,
  group: string,
): MediaSearchItem[] {
  return items.map((it) => ({
    ...it,
    compareSide: side,
    compareLabel: label,
    compareGroup: group,
  }));
}

/**
 * 依据返回结果中的来源(source)推断实际使用的搜索提供方。
 * 搜索 API 命中时，其 result 的 source 会带 API 名（search-api-provider 的 toItems 传入）。
 * 用此判断 API 是否真正生效，避免 provider 恒为爬虫名的可观测盲区。
 */
function inferSearchProvider(items: InfoSearchItem[]): string {
  const apiSources = ["Tavily", "Serper", "Bing API", "Jina", "AnySearch"];
  const present = new Set<string>();
  for (const item of items) {
    if (item.source) present.add(item.source);
  }
  // 若 API 来源确实出现在结果里，优先标记为 api:xxx；否则视为未走 API，保持国内爬虫名。
  for (const name of apiSources) {
    if (present.has(name)) return `api:${name.toLowerCase().replace(/\s+/g, "-")}`;
  }
  return "domestic-bing-cn";
}

function formatFailure(name: string, run: CommandResult): string {
  const msg = run.stderr || run.stdout || "无错误输出";
  return `${name} 调用失败(${run.code}): ${msg.slice(0, 300)}`;
}

function rawToItems(raw: string, source: string, platform: string): UnifiedSearchItem[] {
  const lines = String(raw ?? "")
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);
  const out: UnifiedSearchItem[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/https?:\/\/\S+/i);
    if (!m) continue;
    const url = m[0];
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({
      title: lines[i - 1]?.slice(0, 180) || url,
      url,
      snippet: lines[i + 1]?.slice(0, 220) || "",
      source,
      platform,
    });
  }
  return out;
}

function hasChinese(text: string): boolean {
  return /[\u4e00-\u9fa5]/.test(text);
}

function dedupeText(items: string[]): string[] {
  const set = new Set<string>();
  for (const item of items) {
    const s = item.trim();
    if (s) set.add(s);
  }
  return Array.from(set);
}

function parseBingImageResults(html: string, limit: number): MediaSearchItem[] {
  const out: MediaSearchItem[] = [];
  const seen = new Set<string>();
  const attrRe = /\bm=(["'])([\s\S]*?)\1/gi;
  let m: RegExpExecArray | null = null;
  while ((m = attrRe.exec(html))) {
    const decoded = decodeHtmlEntities(m[2] ?? "");
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(decoded);
    } catch {
      continue;
    }
    const mediaUrl = pickString(data.murl);
    const thumbnailUrl = pickString(data.turl);
    const pageUrl = pickString(data.purl) || mediaUrl;
    if (!pageUrl || (!mediaUrl && !thumbnailUrl)) continue;
    const key = (mediaUrl || pageUrl).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      type: "image",
      title: pickString(data.t) || pickString(data.desc) || "图片结果",
      pageUrl,
      mediaUrl,
      thumbnailUrl,
      source: inferMediaSource(pageUrl, "Bing Images"),
      width: pickNumber(data.w),
      height: pickNumber(data.h),
    });
    if (out.length >= limit) break;
  }
  return out;
}

/** 导出供回归测试（Bing 视频页新/旧结构与推广位门禁） */
export function parseBingVideoResults(
  html: string,
  limit: number,
  query = "",
): MediaSearchItem[] {
  // 必应视频页结果解析（2026-09-13 根修）：
  //   0) 2026-09 新结构：结果单元是 <a class="mc_vtvc_link ..." href="播放页直链"
  //      aria-label="标题 来源: … · 时长: …">，内层 mc_vtvc_title（标题）/
  //      mc_bc_rc（时长）/ img（缩略图）。改版后 mmeta/vrhm 属性只剩推广位携带，
  //      旧解析因此只会命中广告位视频（真实测试：搜「刘浩存」首位是「新笔记本
  //      设置」推广视频）——新结构必须优先解析；
  //   1/2) 旧结构 mmeta/vrhm 兼容保留；
  //   3) 全部缺失时退回 <a> 链接启发式解析。
  // 直抓解析出的条目统一过查询词相关性门禁（见 gateVideoResultsByQuery）。
  const out: MediaSearchItem[] = [];
  const seen = new Set<string>();

  // 0) mc_vtvc_link 新结构
  for (const match of html.matchAll(/class="mc_vtvc_link/g)) {
    const classIdx = match.index ?? 0;
    const tagStart = html.lastIndexOf("<a", classIdx);
    const tagEnd = html.indexOf(">", classIdx);
    if (tagStart < 0 || tagEnd < 0) continue;
    const openTag = html.slice(tagStart, tagEnd + 1);
    const nextClass = html.indexOf('class="mc_vtvc_link', tagEnd + 1);
    const block = html.slice(tagEnd + 1, nextClass > 0 ? nextClass : tagEnd + 1 + 8000);
    const rawHref =
      /\bhref="([^"]+)"/.exec(openTag)?.[1] ??
      /\bourl="([^"]+)"/.exec(block)?.[1];
    if (!rawHref) continue;
    const pageUrl = decodeHtmlEntities(rawHref).trim();
    if (!/^https?:\/\//i.test(pageUrl)) continue;
    const key = pageUrl.toLowerCase();
    if (seen.has(key)) continue;
    const ariaLabel = decodeHtmlEntities(/\baria-label="([^"]*)"/.exec(openTag)?.[1] ?? "");
    const rawTitle = /class="mc_vtvc_title[^>]*>([\s\S]{0,500}?)<\/div>/.exec(block)?.[1] ?? "";
    const title =
      stripTags(rawTitle).trim() || ariaLabel.split(/\s*来源:/)[0].trim();
    const duration =
      /\bclass="mc_bc_rc[^"]*"[^>]*>\s*([0-9]{1,2}(?::[0-9]{2}){1,2})\s*</.exec(block)?.[1];
    const rawThumb =
      /data-src-hq="([^"]+)"/.exec(block)?.[1] ??
      /<img\b[^>]*\bsrc="([^"]+)"/.exec(block)?.[1];
    seen.add(key);
    out.push({
      type: "video",
      title: title || "视频结果",
      pageUrl,
      mediaUrl: pageUrl,
      thumbnailUrl: rawThumb ? absolutizeBingUrl(decodeHtmlEntities(rawThumb)) : undefined,
      duration,
      source: inferMediaSource(pageUrl, "Bing Videos"),
    });
    if (out.length >= limit) break;
  }

  // 1) mmeta：播放页 + 缩略图（aria-label 兜底标题跟在容器后的首个 <a> 上）
  const metaByKey = new Map<string, { pageUrl: string; thumbnailUrl?: string; ariaLabel?: string }>();
  const mmetaRe =
    /class="mc_vtvc[^"]*"[^>]*\smmeta="([^"]*)"[^>]*>\s*<a[^>]*aria-label="([^"]*)"/g;
  let m: RegExpExecArray | null = null;
  while ((m = mmetaRe.exec(html))) {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(decodeHtmlEntities(m[1] ?? ""));
    } catch {
      continue;
    }
    const pageUrl = pickString(data.purl) || pickString(data.murl) || pickString(data.pgurl);
    if (!pageUrl || !/^https?:\/\//i.test(pageUrl)) continue;
    const key = pageUrl.toLowerCase();
    if (metaByKey.has(key)) continue;
    metaByKey.set(key, {
      pageUrl,
      thumbnailUrl: pickString(data.turl),
      ariaLabel: m[2],
    });
  }

  // 2) vrhm：标题 + 时长（按播放页 URL 关联到 mmeta 条目）
  const titleByKey = new Map<string, { title?: string; duration?: string }>();
  const vrhmRe = /class="vrhdata"[^>]*\svrhm="([^"]*)"/g;
  while ((m = vrhmRe.exec(html))) {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(decodeHtmlEntities(m[1] ?? ""));
    } catch {
      continue;
    }
    const pageUrl = pickString(data.purl) || pickString(data.murl) || pickString(data.pgurl);
    if (!pageUrl) continue;
    const key = pageUrl.toLowerCase();
    if (titleByKey.has(key)) continue;
    titleByKey.set(key, { title: pickString(data.vt), duration: pickString(data.du) });
  }

  // 3) 合并输出：mmeta 有缩略图的条目优先；缺标题时用容器 aria-label 兜底
  for (const { pageUrl, thumbnailUrl, ariaLabel } of metaByKey.values()) {
    const key = pageUrl.toLowerCase();
    // 新结构（步骤 0）可能已收录同一播放页，跳过避免重复条目
    if (seen.has(key)) continue;
    const meta = titleByKey.get(key);
    const title =
      meta?.title ||
      decodeHtmlEntities(ariaLabel ?? "")
        .replace(/来源:.*$/, "")
        .replace(/·\s*时长.*$/, "")
        .trim()
        .slice(0, 160);
    seen.add(key);
    out.push({
      type: "video",
      title: title || "视频结果",
      pageUrl,
      mediaUrl: pageUrl,
      thumbnailUrl,
      duration: meta?.duration,
      source: inferMediaSource(pageUrl, "Bing Videos"),
    });
    if (out.length >= limit) break;
  }
  const gated = gateVideoResultsByQuery(out, query);
  if (gated.length > 0) return gated;

  // 兜底：mmeta/vrhm 都缺失时退回 <a> 链接启发式解析（结果质量差但聊胜于无）
  const blockRe = /<a\b[^>]*href=(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi;
  let a: RegExpExecArray | null = null;
  while ((a = blockRe.exec(html))) {
    const rawHref = decodeHtmlEntities(a[2] ?? "").trim();
    if (!rawHref || rawHref.startsWith("#") || rawHref.startsWith("javascript:")) continue;
    let pageUrl = rawHref;
    try {
      pageUrl = new URL(rawHref, "https://cn.bing.com/videos/search").toString();
    } catch {
      continue;
    }
    if (!isLikelyVideoUrl(pageUrl) && !/\/videos\//i.test(pageUrl)) continue;
    // 排除站内筛选/翻页链接（"全部/短视频/时长筛选"），只留外部播放页
    if (/cn\.bing\.com\/videos\/search/i.test(pageUrl)) continue;
    const chunk = a[0];
    const title = decodeHtmlEntities(stripTags(a[3] ?? "")).slice(0, 160) || "视频结果";
    // 优先取结果块自带的 data-thumbnail（真实缩略图地址），其次 <img> 的 src；
    // 两者都没有则该视频无真实缩略图（前端显示视频占位图标，不再把播放页/
    // 搜索页 URL 当作图片地址下发，避免前端 Image.network 加载 HTML 破图）。
    const dataThumb = chunk.match(/data-thumbnail=(["'])([^"']+)\1/i);
    const imgSrc = chunk.match(/<img\b[^>]*\bsrc=(["'])([^"']+)\1/i);
    const rawThumb = dataThumb?.[2] ?? imgSrc?.[2];
    const thumbnailUrl = rawThumb ? absolutizeBingUrl(decodeHtmlEntities(rawThumb)) : undefined;
    const key = pageUrl.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      type: "video",
      title,
      pageUrl,
      mediaUrl: pageUrl,
      thumbnailUrl,
      source: inferMediaSource(pageUrl, "Bing Videos"),
    });
    if (out.length >= limit) break;
  }
  return gateVideoResultsByQuery(out, query);
}

/**
 * 查询词相关性门禁：直抓页面上的推广位视频（小游戏/带货/推荐流）与查询词毫无
 * 字面交集，却带着缩略图和时长排在首位（真实测试实证），是「搜出来的视频不对」
 * 的直接来源。解析条目标题与查询词无任何 token 交集时剔除。只对 Bing 页面直抓
 * 解析的条目生效——网页搜索兜底由搜索引擎按相关性排序，不适用本门禁（中英文
 * 标题不一致会被误杀）。
 */
function gateVideoResultsByQuery(items: MediaSearchItem[], query: string): MediaSearchItem[] {
  const tokens = queryEntityTokens(query);
  if (tokens.length === 0) return items;
  return items.filter((it) => {
    const title = (it.title ?? "").toLowerCase();
    return tokens.some((tok) => title.includes(tok));
  });
}

/** 查询词 token：CJK 连续串（≥2 字）与拉丁词（小写化）。 */
function queryEntityTokens(query: string): string[] {
  const t = (query ?? "").toLowerCase();
  if (!t.trim()) return [];
  return [...t.matchAll(/[\u4e00-\u9fff]{2,}|[a-z0-9][a-z0-9'.+-]{1,}/g)].map((m) => m[0]);
}

// B站风控（HTTP 412）对无 cookie 的直查按词间歇触发：先访首页种下 buvid3 等
// cookie 再调接口即可放行（真实测试实证）。cookie 进程级缓存 30 分钟。
let biliCookieCache: { cookie: string; at: number } | null = null;

const BILIBILI_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/** 视频播放页 → av 号；BV 号先经 view 接口换算（B站评论接口只吃 oid=aid） */
async function resolveBilibiliAid(videoUrl: string): Promise<string | null> {
  const url = String(videoUrl ?? "");
  const av = /\/video\/av(\d+)/i.exec(url) ?? /[?&]aid=(\d+)/.exec(url);
  if (av) return av[1]!;
  const bv = /\/video\/(BV[0-9A-Za-z]{10})/.exec(url);
  if (!bv) return null;
  try {
    const res = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bv[1]}`, {
      headers: { "user-agent": BILIBILI_UA },
      signal: AbortSignal.timeout(6_000),
    });
    const json = (await res.json()) as { code?: number; data?: { aid?: number } };
    return json.code === 0 && json.data?.aid ? String(json.data.aid) : null;
  } catch {
    return null;
  }
}

async function resolveBilibiliCookie(): Promise<string> {
  if (biliCookieCache && Date.now() - biliCookieCache.at < 30 * 60 * 1000) {
    return biliCookieCache.cookie;
  }
  try {
    const res = await fetch("https://www.bilibili.com/", {
      headers: {
        "user-agent": process.env.WEB_FETCH_USER_AGENT ?? BILIBILI_UA,
      },
      redirect: "follow",
      signal: AbortSignal.timeout(5_000),
    });
    const cookie = res.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .filter(Boolean)
      .join("; ");
    if (cookie) biliCookieCache = { cookie, at: Date.now() };
    return cookie;
  } catch {
    return biliCookieCache?.cookie ?? "";
  }
}

function dedupeMediaByPageUrl(items: MediaSearchItem[]): MediaSearchItem[] {
  const seen = new Set<string>();
  const out: MediaSearchItem[] = [];
  for (const item of items) {
    const key = item.pageUrl.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function pickString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function pickNumber(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** B站公开视频搜索接口（search_type=video）响应 */
type BilibiliVideoSearchResponse = {
  code?: number;
  data?: {
    result?: Array<{
      title?: string;
      description?: string;
      arcurl?: string;
      bvid?: string;
      pic?: string;
      duration?: string;
      author?: string;
    }>;
  };
};

function tryParseJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function absolutizeBingUrl(raw: string): string | undefined {
  if (!raw) return undefined;
  try {
    return new URL(raw, "https://cn.bing.com").toString();
  } catch {
    return undefined;
  }
}

function isLikelyVideoUrl(url: string): boolean {
  return /(?:youtube\.com\/watch|youtu\.be\/|bilibili\.com\/video\/|v\.qq\.com|ixigua\.com|douyin\.com|kuaishou\.com|youku\.com|iqiyi\.com|mgtv\.com|weibo\.com\/tv|video\.weibo\.com|\/video\/)/i.test(url);
}

/** 社交平台中转源专用的播放页白名单（比 isLikelyVideoUrl 严：排除用户主页/发现页） */
const SOCIAL_VIDEO_PAGE_RE =
  /(?:youtube\.com\/watch|youtu\.be\/|bilibili\.com\/video\/|douyin\.com\/video\/|v\.qq\.com\/x\/|ixigua\.com\/\d|kuaishou\.com\/short-video\/|weibo\.com\/tv|video\.weibo\.com)/i;

function inferMediaSource(url: string, fallback: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    if (/youtube\.com|youtu\.be/.test(host)) return "YouTube";
    if (/bilibili\.com/.test(host)) return "Bilibili";
    if (/douyin\.com/.test(host)) return "抖音";
    if (/ixigua\.com/.test(host)) return "西瓜视频";
    if (/qq\.com/.test(host)) return "腾讯视频";
    if (/youku\.com/.test(host)) return "优酷";
    if (/iqiyi\.com/.test(host)) return "爱奇艺";
    if (/mgtv\.com/.test(host)) return "芒果TV";
    return host || fallback;
  } catch {
    return fallback;
  }
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) =>
      String.fromCodePoint(Number.parseInt(h, 16)),
    );
}

function resolveBin(defaultName: "mcporter" | "gh" | "rdt"): string {
  switch (defaultName) {
    case "mcporter":
      return process.env.MCPORTER_BIN?.trim() || "mcporter";
    case "gh":
      return process.env.GH_BIN?.trim() || "gh";
    case "rdt":
      return process.env.RDT_BIN?.trim() || "rdt";
    default:
      return defaultName;
  }
}
