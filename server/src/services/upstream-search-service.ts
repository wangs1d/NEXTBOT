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
import { filterByQueryFragments, primaryRelevanceRatio } from "./domestic-web-providers.js";
import { rerankImagesByVlm } from "./image-relevance-vlm.js";
import { filterUnseenMedia, rememberShownMedia } from "./media-shown-ledger.js";
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

  constructor(private readonly infoHubService: InfoHubService) {}

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
        formatSearchFreshnessNote({
          anchor,
          droppedStale: fresh.droppedStale,
          maxAgeDays,
          datedCount: fresh.datedCount,
          total: fresh.items.length,
        }),
      ],
    };
    this.webQueryCache.set(cacheKey, result);
    return result;
  }

  async searchImages(query: string, limit = 4, actorId = "anonymous", sessionId = ""): Promise<{
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
    // 候选池放大 5 倍：远程图防盗链 / 格式不支持时转存层会跳过并继续取下一张，
    // 池子太浅会出现「整批下载失败 → 0 张图」，用户拿不到任何照片。
    // 转存层一旦凑够 boundedLimit 张即停止，放大池子只增加解析量、不增加下载量。
    const candidateLimit = boundedLimit * 5;

    // ① 搜索 API 图片主路（配置可用时优先，仍是唯一「正式」图源）
    const apiItems = await searchImagesViaSearchApi(keyword, boundedLimit);
    if (apiItems.length > 0) {
      const ranked = rankImageCandidates(
        apiItems.map((it) => ({
          type: "image" as const,
          title: it.title,
          pageUrl: it.pageUrl || it.mediaUrl,
          mediaUrl: it.mediaUrl,
          thumbnailUrl: it.thumbnailUrl,
          source: it.source || "SearchApi",
        })),
        keyword,
      );
      // 「再来几张」去重（2026-11-09）：同会话已展示过的原图不再重复下发
      const fresh = filterUnseenMedia(sessionId, ranked).slice(0, boundedLimit);
      const items = await this.materializeImageResults(fresh, actorId, boundedLimit, sessionId);
      if (items.length > 0) {
        rememberShownMedia(sessionId, fresh.slice(0, items.length));
        const { items: reranked } = await rerankImagesByVlm(items, keyword);
        return {
          provider: "search-api-images",
          mediaType: "image",
          items: reranked,
          notes: ["搜索 API 图片搜索优先（已转存 PNG）；pageUrl 保留原始来源页"],
        };
      }
    }

    // ② Bing 图片页兜底：同一个 query 并行打 cn / cn-async / www 三个端点，
    //    按文本相关性择优合并。query 质量由模型在工具层负责（builtin-chat-tools
    //    的 search_images query 描述约束为短实体词），本层不改写。
    //
    //    兜底前的 query 形态硬闸（2026-11-09 实测）：cn.bing.com 中文图片索引只对
    //    两类 query 有可靠召回——① 单实体词（100%）；② 非人物普通名词组合（100%）。
    //    「人名+任何修饰词」哪怕 2 个词段也 0% 可用（17/17 全灭，引擎用随机填充
    //    顶满页面）。因此只允许短 query 进入抓取：去空白 ≤16 字且词段 ≤2；
    //    超限直接拒绝并在 notes 说明，让模型改发单一实体词重试。
    const querySegments = keyword.split(/[\s,，、。；;:：/|?？!！]+/).filter((s) => s.trim().length > 0);
    if (keyword.replace(/\s+/g, "").length > 16 || querySegments.length > 2) {
      const hint = querySegments[0] ?? "";
      return {
        provider: "bing-images",
        mediaType: "image",
        items: [],
        notes: [
          `query 过长已拒绝（${querySegments.length} 个词段 / ${keyword.length} 字）：Bing 中文图片搜索只对单一实体词与普通名词组合有可靠召回，人名+修饰词组合只会返回随机无关填充`,
          `要继续出图：用「${hint}」（仅此一词，不带任何修饰）重新调用一次即可拿到该主体的照片；普通事物可用「事物 场景」两词组合`,
        ],
      };
    }

    const batches = await this.fetchBingImageBatches(keyword, candidateLimit);
    const scored = batches
      .map((b) => {
        const items = rankImageCandidates(b.items, b.query);
        return { ...b, items, ratio: imageRelevanceRatio(b.items, b.query) };
      })
      .filter((b) => b.items.length > 0)
      .sort((a, b) => b.ratio - a.ratio || b.items.length - a.items.length);

    if (scored.length === 0) {
      return {
        provider: "bing-images",
        mediaType: "image",
        items: [],
        notes: ["搜索 API 与必应图片页多端点均未命中；文章页抠图兜底已关闭（避免无关站点配图混入）"],
      };
    }

    const winner = scored[0]!;
    // 分级相关率守卫（2026-11-09）：入口形态闸无法区分「人名+修饰」与「普通名词
    // 组合」（那是语义判断），但两者在结果层签名完全不同——普通名词组合实测
    // 100% 候选命中，人名+修饰实测恒为 0。因此多词 query 要求 ≥50% 候选命中才
    // 交付，单实体词保持零相关守卫。低于阈值一律拒绝交付，让模型改词重试。
    const minRatio = imageBatchGuardRatio(querySegments.length);
    if (winner.ratio <= minRatio) {
      const hint = querySegments[0] ?? "";
      return {
        provider: `bing-images:${winner.label}`,
        mediaType: "image",
        items: [],
        notes: [
          `多端点结果与 query 的相关率 ${Math.round(winner.ratio * 100)}% 低于交付阈值 ${Math.round(minRatio * 100)}%（判定为搜索引擎召回失效/随机填充），已拒绝交付`,
          `要继续出图：用「${hint}」（仅此一词，不带任何修饰）重新调用一次即可拿到该主体的照片`,
        ],
      };
    }
    const merged = dedupeMediaItems(scored.flatMap((b) => b.items));
    // 「再来几张」去重（2026-11-09）：同一 query 每次抓回的结果集是稳定的，
    // 逐轮展示必须扣掉本会话已给过的原图，否则「再来几张」会重复同一批。
    const unseen = filterUnseenMedia(sessionId, merged);
    if (merged.length > 0 && unseen.length === 0) {
      return {
        provider: `bing-images:${winner.label}`,
        mediaType: "image",
        items: [],
        notes: [
          `该查询词下的图片已全部展示过（本会话共 ${merged.length} 张），没有新的可给；` +
            `换一个更具体的方向（活动名/造型/年份/场景）再搜才有新图`,
        ],
      };
    }
    const picked = unseen.slice(0, boundedLimit + 3);
    const items = await this.materializeImageResults(picked, actorId, boundedLimit, sessionId);
    if (items.length === 0) {
      return {
        provider: "bing-images",
        mediaType: "image",
        items: [],
        notes: ["已找到图片候选但全部转存失败（防盗链/格式），本次未返回图片"],
      };
    }

    // 记账：本批候选已交付（下一轮「再来几张」不再重复）
    rememberShownMedia(sessionId, picked);

    // ③ 像素级复核：独立视觉模型只做重排，不删图；失败/超时原序返回，
    //    保证「一定能拿到图片」不因复核链路而破功。
    const vlm = await rerankImagesByVlm(items, keyword);
    return {
      provider: `bing-images:${winner.label}`,
      mediaType: "image",
      items: vlm.items,
      notes: [
        "mediaUrl/thumbnailUrl 已转存为服务端本地 PNG；pageUrl 保留原始来源页",
        `多端点择优：${scored.length} 批候选，采用 ${winner.label} 端点（相关度 ${winner.ratio.toFixed(2)}）`,
        ...(vlm.applied ? [] : ["视觉复核未启用或不可用，已按文本相关性顺序交付"]),
      ],
    };
  }

  /**
   * 并行抓取 Bing 图片结果页：同一个 query 同时打 cn 搜索页 / cn 异步接口 /
   * www 国际版三个端点。所有请求同时发起，整体耗时 ≈ 单端点超时，结果按端点
   * 标注供上层做文本相关性择优；单端点失败不影响其他端点。
   */
  private async fetchBingImageBatches(
    keyword: string,
    candidateLimit: number,
  ): Promise<Array<{ label: string; query: string; items: MediaSearchItem[] }>> {
    // query 质量由模型负责（工具描述已约束为短实体词）；本层只把同一个 query
    // 并行打到 cn 搜索页 / cn 异步接口 / www 国际版三个端点，整体耗时 ≈ 单端点超时，
    // 按文本相关度择优——单端点被风控/改版打掉时其余端点仍能出货。
    const enc = encodeURIComponent(keyword);
    const targets: Array<{ label: string; url: string }> = [
      { label: "cn", url: `https://cn.bing.com/images/search?q=${enc}&form=HDRSC2` },
      { label: "cn-async", url: `https://cn.bing.com/images/async?q=${enc}&first=0&count=20&relp=20&lostate=r&mmasync=1` },
      { label: "www", url: `https://www.bing.com/images/search?q=${enc}&form=HDRSC2` },
    ];

    const settled = await Promise.allSettled(
      targets.map(async (t) => ({
        label: t.label,
        query: keyword,
        items: parseBingImageResults(await this.fetchText(t.url, IMAGE_FETCH_TIMEOUT_MS), candidateLimit),
      })),
    );
    const out: Array<{ label: string; query: string; items: MediaSearchItem[] }> = [];
    for (const s of settled) {
      if (s.status === "fulfilled" && s.value.items.length > 0) out.push(s.value);
    }
    if (out.length === 0) {
      console.warn(`[UpstreamSearch] Bing 图片多端点全部未出货 -> query="${keyword.slice(0, 40)}"`);
    }
    return out;
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
    sessionId = "",
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
          this.searchImages(g.qA, perSide, actorId, sessionId),
          g.qB ? this.searchImages(g.qB, perSide, actorId, sessionId) : Promise.resolve(null),
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
      const fallback = await this.searchImages(sideA, perSide, actorId, sessionId);
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

    // 两源并行（2026-09-13 根修「搜出来的视频不对」；2026-11-09 移除 Bing 视频页源：
    // 实测对当前页面结构解析产出恒为 0 条，纯白耗 10s 预算，页面抓取链整体退役）：
    //  - B站公开搜索接口：无需登录直出播放页+真实缩略图+时长，覆盖质量稳定（主力）；
    //  - 社交平台中转：与 search_web 的微博/抖音源同口径——平台 MCP 未配置时用
    //    site: 限定搜索过滤出视频播放页直链（抖音/微博/腾讯视频/西瓜），实测
    //    产出稀疏但真实，作为补充（任一源失败不拖垮其余源）。
    // B站源占大头，中转源留出固定份额——否则先到源带满 limit 名额，后到源永远进不了最终列表。
    const biliLimit = Math.max(3, Math.ceil(boundedLimit * 0.75));
    const relayLimit = Math.max(2, Math.ceil(boundedLimit * 0.5));
    const [biliItems, relayItems] = await Promise.all([
      this.searchBilibiliVideos(keyword, biliLimit).catch(() => [] as MediaSearchItem[]),
      Promise.race([
        this.searchSocialVideoRelay(keyword, relayLimit),
        new Promise<MediaSearchItem[]>((resolve) => setTimeout(() => resolve([]), 9_000)),
      ]).catch(() => [] as MediaSearchItem[]),
    ]);

    const relayQuota = Math.max(1, Math.round(boundedLimit * 0.15));
    const merged = dedupeMediaByPageUrl([
      ...biliItems,
      ...relayItems.slice(0, relayQuota),
      ...relayItems.slice(relayQuota),
    ]).slice(0, boundedLimit);
    if (merged.length >= Math.min(3, boundedLimit)) {
      const sources = [
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
    sessionId = "",
  ): Promise<MediaSearchItem[]> {
    // 来源闸（2026-10-15 同兴山庄实证）：图搜「住宅区/山庄/小区名」高频返回
    // 百度地图位置截图与图库水印图，转存后顶着 POI 名义展示给用户。三条搜索
    // 路径（search-api / Bing 图片页多端点）统一在此单点拦截。
    // 2026-11-08 改为软闸：水印图库站候选降权到队尾而不是直接删除——
    // 干净候选全部下载失败时仍能由队尾候选出货，保证用户拿得到图片；
    // 地图截图 / 装饰图 / 迷你图属于硬闸，仍然直接丢弃。
    const strict: MediaSearchItem[] = [];
    const relaxed: MediaSearchItem[] = [];
    for (const it of items) {
      if (!isBlockedImageSource(it)) strict.push(it);
      else if (!isBlockedImageSource(it, { allowWatermarkStock: true })) relaxed.push(it);
    }
    if (relaxed.length > 0) {
      console.log(`[UpstreamSearch] 图片来源闸降权 ${relaxed.length} 张（水印图库站，队尾保底）`);
    }
    items = [...strict, ...relaxed];

    const storage = this.imageStorageService;
    if (!storage) return items.slice(0, limit);
    const out: MediaSearchItem[] = [];
    // 硬预算：整个转存阶段必须在预算内返回（无论是否全部完成），
    // 否则整次 search_images 会在外圈 12s 工具超时里被整体 kill、items 归零，
    // 导致前端媒体卡片无法注入、照片展示不出来。这里返回"已达成的部分结果"即可。
    const deadline = Date.now() + IMAGE_MATERIALIZE_BUDGET_MS;
    let cursor = 0;
    const attempted = new Set<number>();

    const workers = Array.from({ length: IMAGE_MATERIALIZE_CONCURRENCY }, async () => {
      while (out.length < limit) {
        if (Date.now() >= deadline) return;
        const idx = cursor++;
        attempted.add(idx);
        const item = items[idx];
        if (!item) return;
        const remoteUrl = item.mediaUrl || item.thumbnailUrl;
        if (!remoteUrl) continue;
        const remaining = deadline - Date.now();
        if (remaining <= 0) return;
        try {
          // 用剩余预算作为本次下载的截断超时，确保并发任务不会越过预算、
          // Promise.all 能及时收尾，避免整体超时导致 items 丢失。
          const pngUrl = await storage.downloadAndStorePng(remoteUrl, actorId, remaining, sessionId);
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
    // 预算内没轮到的（大图/慢网）转后台补写：聊天里即便仍显示远程 URL，
    // 文件稍后也会落进 data/images/<actor>/，资料库照样能看到。
    const shortfall = Math.max(0, limit - out.length);
    const pending = shortfall > 0
      ? items.filter((_, idx) => !attempted.has(idx)).slice(0, shortfall)
      : [];
    if (pending.length > 0) void this.materializeInBackground(pending, actorId, sessionId);
    return out;
  }

  /** 预算外的转存补写：串行、单张限时，失败静默（只影响资料库收录，不影响本轮回复）。 */
  private async materializeInBackground(
    items: MediaSearchItem[],
    actorId: string,
    sessionId = "",
  ): Promise<void> {
    const storage = this.imageStorageService;
    if (!storage) return;
    for (const item of items) {
      const remoteUrl = item.mediaUrl || item.thumbnailUrl;
      if (!remoteUrl) continue;
      try {
        await storage.downloadAndStorePng(remoteUrl, actorId, 20_000, sessionId);
      } catch {
        // 防盗链/格式不支持：跳过
      }
    }
  }
}

// 图片转存的并发数（并行下载，避免逐张串行拖垮 12s 工具超时）
const IMAGE_MATERIALIZE_CONCURRENCY = 3;
// 图片转存阶段的硬预算：在此时间内返回已达成的部分 items，
// 保证 search_images 在工具超时前正常 resolve，前端能拿到媒体卡片。
// 2026-11-08：总预算按「抓取 3.5s + 转存 5s + VLM 复核 2.2s < 12s」重排。
const IMAGE_MATERIALIZE_BUDGET_MS = 5_000;
// 图片结果页抓取超时：cn / async / www 三个端点并行抓取，取相关性最高的一批，
// 因此这里约束的是「单端点」耗时而不是三个端点之和。
const IMAGE_FETCH_TIMEOUT_MS = 3_500;

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
  // 2026-11-08 事故链实证：长 query 跑偏时这些站的缩略图/水印图会被当成人物照
  'nximg.cn',        // 昵图网图床（灯塔摄影图水印）
  'ztupic.com',      // 众图网素材图
  'picoriline.com',  // 壁纸站（截图里灯塔图底部水印）
  'grok4ai.com',     // 垃圾站缩略图
  'weibomingzi.com', // 简笔画素材站
  '58pic.com',
  'ooopic.com',
  'tooopen.com',
] as const;

/** 图片 URL 路径里的装饰图/占位图特征（候选池已放大，误杀成本很低） */
const BAD_IMAGE_PATH_RE = /(?:logo|icon|avatar|qrcode|watermark|sprite|placeholder|loading|blank|spacer|noimage|default_)/i;

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
export function isBlockedImageSource(
  item: {
    title?: string;
    pageUrl?: string;
    mediaUrl?: string;
    thumbnailUrl?: string;
    width?: number;
    height?: number;
  },
  opts: { allowWatermarkStock?: boolean } = {},
): boolean {
  const urls = [item.pageUrl, item.mediaUrl, item.thumbnailUrl]
    .filter((u): u is string => typeof u === 'string' && /^https?:\/\//.test(u));
  for (const u of urls) {
    try {
      const parsed = new URL(u);
      const host = parsed.hostname.toLowerCase();
      const match = (list: readonly string[]) => list.some((s) => host === s || host.endsWith(`.${s}`));
      // 水印图库站是「软闸」：候选充足时降权到队尾，真没图时仍可放行保底。
      if (!opts.allowWatermarkStock && match(WATERMARK_STOCK_HOST_SUFFIXES)) return true;
      if (match(MAP_SCREENSHOT_HOST_SUFFIXES)) return true;
      if (BAD_IMAGE_PATH_RE.test(parsed.pathname)) return true;
    } catch { /* 非法 URL 不因它拒，交给下载层 */ }
  }
  // 明确的迷你图（Bing 会带 w/h；缺失尺寸时不误杀）
  const w = Number(item.width ?? 0);
  const h = Number(item.height ?? 0);
  if (w > 0 && h > 0 && (w < 180 || h < 180)) return true;
  const title = String(item.title ?? '');
  return IMAGE_TITLE_BLOCKED_WORDS.some((w2) => title.includes(w2));
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

// ─────────────────────────────────────────────────────────────────────────────
// 图片候选文本相关性软闸（2026-11-08）
//
// 实证：Bing 中文图片页对修饰词长 query 会整页跑偏（返回「红军长征路线图」
// 「林业局」甚至垃圾站缩略图），query 质量由模型在工具层负责（见
// builtin-chat-tools.ts 的 search_images query 描述约束），本层不做 query 改写。
// 这里只对候选按 CJK 片段命中做软排序与多端点择优，但**绝不因为过滤把结果
// 清空**（保底仍交付原候选），保证用户一定能拿到图片。
// 片段算法复用 domestic-web-providers 的 filterByQueryFragments，避免第二份实现漂移。
// ─────────────────────────────────────────────────────────────────────────────

function toRelevanceShape(items: MediaSearchItem[]): Array<{ title: string; snippet: string; url: string; i: number }> {
  return items.map((it, i) => ({
    title: it.title || "",
    snippet: it.snippet ?? "",
    url: it.pageUrl ?? "",
    i,
  }));
}

/** 一批候选与 query 的文本相关比例（0~1），用于多端点择优。 */
export function imageRelevanceRatio(items: MediaSearchItem[], query: string): number {
  if (items.length === 0) return 0;
  const shapes = toRelevanceShape(items);
  return filterByQueryFragments(shapes, query).length / shapes.length;
}

/**
 * Bing 图片兜底的分级交付阈值（按 query 词段数）。
 * 实测（2026-11-09 修饰词矩阵）：普通名词组合（「灯塔 风景」）100% 候选命中，
 * 「人名+修饰词」恒为 0 命中——以 0.5 为多词 query 的交付线可精确切分两类；
 * 单实体词实测恒 100%，保持零相关守卫即可。
 */
export function imageBatchGuardRatio(segmentCount: number): number {
  return segmentCount >= 2 ? 0.5 : 0;
}

/**
 * 相关性软闸：命中 query 片段的候选置顶；命中数 ≥2 时剔除零命中项（跑偏图）。
 * 命中不足时保留全部原候选，只做排序 —— 宁可相关度低，也不能让用户拿到 0 张图。
 */
export function rankImageCandidates(items: MediaSearchItem[], query: string): MediaSearchItem[] {
  if (items.length <= 1) return items;
  const hit = new Set(filterByQueryFragments(toRelevanceShape(items), query).map((s) => s.i));
  const scored = items.map((it, i) => ({ it, i, hit: hit.has(i) ? 1 : 0 }));
  const keep = hit.size >= 2 ? scored.filter((s) => s.hit === 1) : scored;
  return keep.sort((a, b) => b.hit - a.hit || a.i - b.i).map((s) => s.it);
}

/** 跨端点合并时按图片直链去重（保留首次出现，即相关度最高的批次）。 */
function dedupeMediaItems(items: MediaSearchItem[]): MediaSearchItem[] {
  const seen = new Set<string>();
  const out: MediaSearchItem[] = [];
  for (const it of items) {
    const key = (it.mediaUrl || it.thumbnailUrl || it.pageUrl || "").toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

export function parseBingImageResults(html: string, limit: number): MediaSearchItem[] {
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
