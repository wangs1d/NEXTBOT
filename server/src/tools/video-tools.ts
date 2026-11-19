import type { UpstreamSearchService } from "../services/upstream-search-service.js";
import type { VideoGrabService } from "../services/video-grab-service.js";
import type { ToolRegistry } from "./tool-registry.js";

/** 可播放视频条目（video.find 返回；首条为最优先播放项） */
export type PlayableVideoItem = {
  title: string;
  author: string;
  platform: string;
  videoUrl: string;
  thumbnailUrl?: string;
  playPageUrl: string;
};

/** B 站候选判定：当前唯一稳定出流的源（见下方排序说明） */
function isBilibiliPage(url: string): boolean {
  return /bilibili\.com|b23\.tv/i.test(url);
}

/**
 * 搜索候选 → 并发解析可播放流，并把 videoUrl 写回**所有**解析成功的条目。
 *
 * search_videos 与 video.find 共用：模型无论选哪个视频工具，返回的 items 都带
 * 可内联播放的流（确定性收敛，不依赖模型选对工具）。
 *
 * 候选排序（2026-10-02 根修，方向反转）：**B 站优先**。
 *   旧版把非 B 站页提前（当时判定 B 站需登录才出流），实测已完全反转——
 *   B 站 view+playurl(platform=html5) 免登录稳定出 mp4，而抖音/小红书的第三方
 *   解析通道已下线，仅能返回播放页链接。旧排序下搜索候选
 *   大头是抖音页（Bing 视频源），6 个并发解析名额被抖音全占满 → B 站候选根本
 *   轮不到解析 → playable=0 → 「按内容找视频」退化成只回链接列表。现在 B 站先占
 *   5 个名额、其余平台补 3 个，8 个并发额度内两类都有机会出流。
 *
 * 回写范围：解析成功的**全部**条目都写回 videoUrl（不止 limit 条）——模型若转述
 * 第 2、3 条，前端同样能内联播放；`playable` 仍按 limit 截断供调用方取首选。
 */
export async function enrichVideosWithPlayable(
  search: Awaited<ReturnType<UpstreamSearchService["searchVideos"]>>,
  videoGrabService: VideoGrabService,
  playableLimit: number,
): Promise<{ items: typeof search.items; playable: PlayableVideoItem[] }> {
  const candidates = search.items
    .map((it) => String(it.pageUrl ?? "").trim())
    .filter(Boolean);
  if (candidates.length === 0) return { items: search.items, playable: [] };

  const bili = candidates.filter(isBilibiliPage);
  const others = candidates.filter((u) => !isBilibiliPage(u));
  const ordered = [...bili.slice(0, 5), ...others.slice(0, 3), ...bili.slice(5)].slice(0, 8);
  const settled = await Promise.all(
    ordered.map(async (pageUrl) => {
      try {
        const info = await videoGrabService.grab(pageUrl);
        if (!info.videoUrl) return null;
        const item: PlayableVideoItem = {
          title: info.title || "",
          author: info.author || "",
          platform: info.platform,
          videoUrl: info.videoUrl,
          thumbnailUrl: info.thumbnailUrl,
          playPageUrl: info.playPageUrl || pageUrl,
        };
        return item;
      } catch {
        return null;
      }
    }),
  );
  const resolved = settled.filter((it): it is PlayableVideoItem => it !== null);
  const playable = resolved.slice(0, playableLimit);

  // 把解析出的流按播放页地址写回搜索条目（同一地址才可信；跨条目乱配会文不对题）
  const items = search.items.map((it) => {
    const pageUrl = String(it.pageUrl ?? "").trim();
    const hit = resolved.find((p) => p.playPageUrl === pageUrl);
    return hit ? { ...it, videoUrl: hit.videoUrl } : it;
  });
  return { items, playable };
}

/**
 * 视频工具注册：
 *   - video.grab      根据分享/播放链接解析视频信息（抖音/小红书/B站等国内平台，适配器自动路由）
 *   - video.find      按内容找视频：搜索候选播放页 → 逐个解析出可内联播放的流（无需用户贴链接）
 *   - video.platforms 查看当前支持的平台（便于排查/健康检查）
 */
export function registerVideoTools(
  toolRegistry: ToolRegistry,
  videoGrabService: VideoGrabService,
  upstreamSearchService?: UpstreamSearchService,
): void {
  toolRegistry.register("video.grab", async (input) => {
    const url = String(input.url ?? "").trim();
    if (!url) {
      return { provider: "none", platform: "other", notes: ["url 不能为空"] };
    }
    const info = await videoGrabService.grab(url);
    return {
      provider: info.provider,
      platform: info.platform,
      title: info.title,
      author: info.author,
      durationSeconds: info.durationSeconds,
      description: info.description,
      videoUrl: info.videoUrl,
      thumbnailUrl: info.thumbnailUrl,
      playPageUrl: info.playPageUrl,
      notes: info.notes,
    };
  });

  toolRegistry.register("video.find", async (input) => {
    if (!upstreamSearchService) {
      return { provider: "none", items: [], notes: ["搜索服务未装配"] };
    }
    const query = String(input.query ?? "").trim();
    if (!query) {
      return { provider: "none", items: [], notes: ["query 不能为空"] };
    }
    const limit = Math.min(3, Math.max(1, Number(input.limit) || 2));

    // 1) 搜候选播放页（Bing 视频/B站/社交中转三源并行）→ 2) 并发解析可播放流
    const { items, playable } = await enrichVideosWithPlayable(
      await upstreamSearchService.searchVideos(query, 8),
      videoGrabService,
      limit,
    );
    return {
      provider: "video.find",
      items,
      notes:
        playable.length > 0
          ? ["items 中带 videoUrl 的条目可内联播放（首条最优先）"]
          : ["候选页均未解析出可播放视频流（平台反爬或需登录）"],
    };
  });

  toolRegistry.register("video.platforms", async () => {
    const health = await videoGrabService.checkHealth();
    return {
      platforms: health.platforms,
      mcporterAvailable: health.mcporterAvailable,
      notes: health.notes,
    };
  });
}
