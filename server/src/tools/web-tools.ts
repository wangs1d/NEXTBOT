import type { InfoHubService } from "../services/info-hub-service.js";
import type { UpstreamSearchService } from "../services/upstream-search-service.js";
import type { VideoGrabService } from "../services/video-grab-service.js";
import type { ToolRegistry } from "./tool-registry.js";
import { enrichVideosWithPlayable } from "./video-tools.js";
import { resolveActorId } from "../agent/actor-id.js";
import { mediaTurnFromContext } from "../services/library-meta.js";
import { fetchHotRankings, type HotRankSource } from "../services/hot-rankings.js";

function toBoundedLimit(input: unknown, fallback: number): number {
  const limit = Number(input ?? fallback);
  if (!Number.isFinite(limit)) return fallback;
  return Math.max(1, Math.min(25, Math.floor(limit)));
}

/** 截断正文，控制返回 token 量。 */
function trimContent(text: string, maxChars: number): string {
  const t = text.trim();
  if (t.length <= maxChars) return t;
  return t.slice(0, maxChars) + "\n…[正文过长已截断]";
}

export function registerWebTools(
  toolRegistry: ToolRegistry,
  infoHubService: InfoHubService,
  upstreamSearchService: UpstreamSearchService,
  videoGrabService?: VideoGrabService,
): void {
  toolRegistry.register("search_web", async (input) => {
    const query = String(input.query ?? "").trim();
    const limit = toBoundedLimit(input.limit, 12);
    if (!query) return { provider: "none", items: [], notes: ["query 不能为空"] };
    return upstreamSearchService.searchWeb(query, limit);
  });

  toolRegistry.register("search_images", async (input, context) => {
    // 查询词原样透传：纯人名约束只针对「爬必应图片页」这一层（2026-11-09 用户
    // 口径），净化做在 upstream-search-service 的必应分支里——接入真正的图片
    // 搜索 API 后查询词应保持完整，不在工具层裁剪。
    const query = String(input.query ?? "").trim();
    // 默认 4、上限 8：贴合「少而精+图文混排」的产品诉求。
    // 需要多张时应让 LLM 拆成多个细粒度 query 并行搜，
    // 由前端 renderBlocks 把每段文字对应的照片自然交错展示。
    const limit = toBoundedLimit(input.limit, 4);
    if (!query) return { provider: "none", mediaType: "image", items: [], notes: ["query 不能为空"] };
    return upstreamSearchService.searchImages(
      query,
      limit,
      resolveActorId(context),
      context.sessionId,
      mediaTurnFromContext(context),
    );
  });

  /**
   * 对比式批量图片搜索：一次调用按「多个对比维度 + 每维度两侧」并行出图。
   *
   * 适用：用户要「A 和 B 对比」且希望**多方面对比**（水屋/沙屋/餐厅/泳池/潜水…），
   * 或要「每个维度两侧都要图」。本工具在**代码层**自动把用户意图拆成多组 query：
   *   - 多维度：自动拆多个维度（水屋/沙屋/餐厅…），并注入 prompt 引导 LLM 明确维度清单
   *   - 每维度两侧：维度 query 内含 `A vs B`/`A对比B` 时自动拆成两侧并行搜索
   * 返回分组结构 mediaGroups：每个 group 含维度标题 + 该维度下两侧（sideA/sideB）的图片列表。
   *
   * 不匹配任何对比/多面意图时退化为普通 search_images（items 为平铺结果）。
   */
  toolRegistry.register("search_images_batch", async (input, context) => {
    const query = String(input.query ?? "").trim();
    const actorId = resolveActorId(context);
    if (!query) {
      return { provider: "none", mediaType: "image", items: [], mediaGroups: [], notes: ["query 不能为空"] };
    }
    const limitPerGroup = Math.max(1, Math.min(4, Math.floor(Number(input.limit_per_group ?? 3)) || 3));
    // 多维对比维度列表（如 ["持久度","价格","色号"]）；缺省时由服务端按 LCS/对比词推断
    const dimensions = (Array.isArray(input.dimensions) ? input.dimensions : [])
      .map((d: unknown) => String(d).trim())
      .filter((d: string) => d.length > 0);
    return upstreamSearchService.searchImagesBatch(
      query,
      dimensions.length > 0 ? dimensions : undefined,
      limitPerGroup,
      actorId,
      context.sessionId,
      mediaTurnFromContext(context),
    );
  });

  toolRegistry.register("search_videos", async (input) => {
    const query = String(input.query ?? "").trim();
    const limit = toBoundedLimit(input.limit, 8);
    if (!query) return { provider: "none", mediaType: "video", items: [], notes: ["query 不能为空"] };
    const search = await upstreamSearchService.searchVideos(query, limit);
    // 装配了视频抓取服务时对候选做可播流解析（与 video.find 同链路）——模型无论选
    // 哪个视频工具，带 videoUrl 的条目都能被确定性附成内联播放卡（2026-10-02 根修：
    // 模型习惯性选 search_videos 导致「看视频」只出链接列表）。
    if (!videoGrabService) return search;
    const { items, playable } = await enrichVideosWithPlayable(search, videoGrabService, 3);
    return {
      ...search,
      items,
      notes: [
        ...search.notes,
        ...(playable.length > 0
          ? ["items 中带 videoUrl 的条目可内联播放（前端会自动渲染播放卡）"]
          : []),
      ],
    };
  });

  toolRegistry.register("fetch_web", async (input) => {
    const url = String(input.url ?? "").trim();
    if (!url) return { title: "", content: "", summary: "url 不能为空" };
    const includeLinks = input.include_links === true;
    const result = await infoHubService.readWebpage(url);
    // 空正文兜底：readWebpage 在反爬/需登录页面会返回空壳 {title:"Untitled",content:"",summary:""}，
    // 原样返回会被压缩成空 JSON 泄漏给用户。这里补一句语义化说明，让 LLM 能如实向用户交代。
    const enriched = result.content?.trim()
      ? result
      : {
          ...result,
          summary:
            result.summary?.trim() || "页面内容为空或无法读取（可能被反爬拦截或需登录），未能获取到正文。",
        };
    // 如果需要链接，额外调用 inspectWebpage 补充
    if (includeLinks) {
      const inspect = await infoHubService.inspectWebpage(url);
      return { ...enriched, links: inspect.links, sameHostLinks: inspect.sameHostLinks };
    }
    return enriched;
  });

  /**
   * 深度搜索：一次调用完成「搜索 + 抓取 Top 网页正文」。
   * 先按 query 搜索，再并行读取前 fetch_pages 条结果的完整正文（去噪后纯文本），
   * 一条结果同时带 snippet 与 content。避免 Agent 先 search_web 拿到链接、
   * 再逐个 fetch_web 的来回跳跃，贴近扣子的「搜索含正文」体验。
   */
  toolRegistry.register("deep_search", async (input) => {
    const query = String(input.query ?? "").trim();
    if (!query) return { results: [], notes: ["query 不能为空"] };
    const searchLimit = toBoundedLimit(input.limit, 8);
    const maxPages = Math.max(1, Math.min(10, Math.floor(Number(input.fetch_pages ?? 3)) || 3));
    const contentLimit = Math.max(800, Math.min(6000, Math.floor(Number(input.content_limit ?? 2200)) || 2200));

    const res = await upstreamSearchService.searchWeb(query, searchLimit);

    const toRead = res.items.filter((item) => item.url && /^https?:\/\//i.test(item.url)).slice(0, maxPages);
    if (toRead.length === 0) {
      return { query, provider: res.provider, results: res.items, notes: ["未找到可深读的有效链接，只有摘要"] };
    }

    const readResults = await Promise.allSettled(toRead.map((item) => infoHubService.readWebpage(item.url!)));

    const results: Array<{
      title: string;
      url: string;
      source?: string;
      snippet: string;
      content: string;
      summary: string;
    }> = [];
    for (let i = 0; i < toRead.length; i++) {
      const item = toRead[i];
      const entry = readResults[i];
      const page = entry.status === "fulfilled" ? entry.value : null;
      results.push({
        title: page?.title || item.title,
        url: item.url!,
        source: item.source,
        snippet: item.snippet || "",
        content: page ? trimContent(page.content, contentLimit) : "",
        summary: page?.summary || "",
      });
    }

    // 未被深读的剩余条目标记只有 snippet
    for (const item of res.items.slice(maxPages)) {
      if (!item.url) continue;
      results.push({
        title: item.title,
        url: item.url,
        source: item.source,
        snippet: item.snippet || "",
        content: "",
        summary: "",
      });
    }

    return { query, provider: res.provider, results };
  });

  /**
   * 实时热点榜单：聚合微博/百度/知乎/B站 当前热门话题。
   */
  toolRegistry.register("hot_rankings", async (input) => {
    const limit = Math.max(1, Math.min(60, Math.floor(Number(input.limit ?? 20)) || 20));
    const rawPlatforms = Array.isArray(input.platforms)
      ? input.platforms.map((p) => String(p).trim().toLowerCase()).filter(Boolean)
      : [];
    const allowed = new Set<HotRankSource>(["weibo", "baidu", "zhihu", "bilibili"]);
    const platforms = rawPlatforms.filter((p) => allowed.has(p as HotRankSource)) as HotRankSource[];
    const result = await fetchHotRankings(limit, platforms);
    return {
      items: result.items,
      fetchedSources: result.fetchedSources,
      notes: result.notes,
    };
  });

  // Backward compatibility: keep historical aliases on built-in path.
  toolRegistry.register("info.search", async (input) => {
    const query = String(input.query ?? "").trim();
    const limit = toBoundedLimit(input.limit, 12);
    if (!query) return { items: [] };
    const items = await infoHubService.search(query, limit);
    return { items };
  });

  toolRegistry.register("info.read_webpage", async (input) => {
    const url = String(input.url ?? "").trim();
    if (!url) return { title: "", content: "", summary: "url 不能为空" };
    return infoHubService.readWebpage(url);
  });

  toolRegistry.register("info.inspect_webpage", async (input) => {
    const url = String(input.url ?? "").trim();
    if (!url) return { title: "", summary: "url 不能为空", contentPreview: "", links: [], sameHostLinks: [] };
    return infoHubService.inspectWebpage(url);
  });

  toolRegistry.register("info.navigate_site", async (input) => {
    const startUrl = String(input.startUrl ?? "").trim();
    if (!startUrl) return { ok: false, error: "startUrl 不能为空" };
    const goalKeywords = Array.isArray(input.goalKeywords)
      ? input.goalKeywords.map((k) => String(k).trim()).filter(Boolean)
      : undefined;
    const maxDepth = Number(input.maxDepth);
    const maxPages = Number(input.maxPages);
    const sameHostOnly = input.sameHostOnly !== false;
    return infoHubService.navigateSite({
      startUrl,
      goalKeywords,
      maxDepth: Number.isFinite(maxDepth) ? maxDepth : undefined,
      maxPages: Number.isFinite(maxPages) ? maxPages : undefined,
      sameHostOnly,
    });
  });
}
