/**
 * POI 打卡视频回填（travel 视频下放）：行程落盘后按站点搜索真实相关视频，
 * 每个 POI 只留 1 条最优播放页，URL 落盘不下载文件（省存储）。
 *
 * 相关性门禁（从严，防无关召回，宁缺毋滥）：
 * 1. 域名白名单：只收真实可打开的播放页（B站/抖音/小红书/YouTube）；
 *    搜索侧给的聚合页/广告位/无法直开的链接一律剔除
 * 2. 标题硬门禁：标题（归一化后）必须包含 POI 名——「成都 宽窄巷子」搜出
 *    「成都美食推荐」这类弱相关直接丢
 * 3. 命中候选打分取 top1：POI 名出现越早越相关 > 含目的地 > 打卡/攻略类词加分；
 *    过滤后无候选 → 该站不带视频（绝不硬凑）
 *
 * 消费零 LLM：搜索走 UpstreamSearchService.searchVideos（B站 API/Bing 视频/
 * 社交中转三源），过滤与排序全是确定性规则，不占对话 token。
 */

import type { StoredTravelPlan, TravelPlanStopVideo } from "../skills/travel-planning/travel-plan-store.js";

/** 视频搜索候选（与 UpstreamSearchService.MediaSearchItem 的最小结构面） */
export type VideoCandidate = {
  title?: string;
  pageUrl?: string;
  duration?: string;
  source?: string;
};

/** 播放页域名白名单（真实可打开的视频站点） */
const VIDEO_HOST_RE =
  /:\/\/([^/]+\.)?(bilibili\.com|b23\.tv|douyin\.com|iesdouyin\.com|xiaohongshu\.com|xhslink\.com|youtube\.com|youtu\.be)\//i;

/** 标题里这些词视为「打卡/攻略向」内容（微加分，不作门禁） */
const GUIDE_WORD_RE = /(打卡|攻略|vlog|游玩|旅行|旅游|航拍|一日游|必去|路线|discovery)/i;

/** 文本归一化：去空白/中英文括号内注文/标点，小写（标题与 POI 名同口径对齐） */
export function normalizeVideoText(raw: string): string {
  return String(raw ?? "")
    .replace(/（[^）]*）|\([^)]*\)/g, "")
    .replace(/[\s\-—·：:，,。!！?？「」『』"'“”《》【】\[\]｜|]+/g, "")
    .toLowerCase();
}

/**
 * 从候选里挑 1 条最相关视频。无候选过门禁 → null（宁缺毋滥）。
 * 打分：POI 名在标题中出现越早分越高；含目的地加分；打卡/攻略词加分。
 */
export function pickTopVideo(
  items: VideoCandidate[],
  poiName: string,
  destination: string,
): TravelPlanStopVideo | null {
  const nameKey = normalizeVideoText(poiName);
  if (!nameKey) return null;
  const destKey = normalizeVideoText(destination);
  let best: { video: TravelPlanStopVideo; score: number } | null = null;
  for (const it of items ?? []) {
    const url = String(it?.pageUrl ?? "").trim();
    if (!url || !VIDEO_HOST_RE.test(url)) continue; // 门禁1：白名单播放页
    const title = String(it?.title ?? "").trim();
    const titleKey = normalizeVideoText(title);
    const idx = titleKey.indexOf(nameKey);
    if (idx < 0) continue; // 门禁2：标题必须含 POI 名
    let score = 100 - Math.min(idx, 50); // 门禁3起：出现越早越相关
    if (destKey && titleKey.includes(destKey)) score += 6;
    if (GUIDE_WORD_RE.test(title)) score += 2;
    if (!best || score > best.score) {
      best = {
        score,
        video: {
          url,
          title: title.slice(0, 80) || poiName,
          source: String(it?.source ?? "").slice(0, 30) || hostLabel(url),
          ...(it?.duration ? { duration: String(it.duration).slice(0, 16) } : {}),
        },
      };
    }
  }
  return best?.video ?? null;
}

function hostLabel(url: string): string {
  if (/bilibili\.com|b23\.tv/i.test(url)) return "bilibili";
  if (/douyin\.com|iesdouyin\.com/i.test(url)) return "douyin";
  if (/xiaohongshu\.com|xhslink\.com/i.test(url)) return "xiaohongshu";
  if (/youtube\.com|youtu\.be/i.test(url)) return "youtube";
  return "web";
}

export type TravelPoiVideoDeps = {
  /** 视频搜索口（装配层注入 UpstreamSearchService.searchVideos；测试可 mock） */
  searchVideos: (query: string, limit?: number) => Promise<{ items: VideoCandidate[] }>;
};

/** 单次搜索取多少候选（过滤后只留 1 条，候选多一点排序才有意义） */
const SEARCH_LIMIT = 6;
/** 回填并发（视频搜索三源并行本就重，行程内逐站限流） */
const CONCURRENCY = 2;

/**
 * POI 级结果缓存：poiKey → video|null（模块级进程缓存，跨行程/跨实例复用，
 * 同一 POI 进程生命周期内只搜一次；搜索失败清缓存下次重试）
 */
const poiVideoCache = new Map<string, TravelPlanStopVideo | null>();

export class TravelPoiVideoService {
  /** planId 防重：同一行程只跑一轮 */
  private inFlight = new Set<string>();

  constructor(
    private readonly deps: TravelPoiVideoDeps,
    private readonly store: {
      setStopVideos: (
        planId: string,
        day: number,
        stop: number,
        videos: TravelPlanStopVideo[],
      ) => boolean;
    },
  ) {}

  /**
   * 行程落盘后的后台回填（fire-and-forget，不阻塞规划）：
   * 只补景点（attraction）——打卡视频语义在景点，酒店/餐厅视频召回质量低；
   * 已有 videos 的站点跳过；命中即落盘 plan 冷层，前端下次拉行程可见。
   * env PA_TRAVEL_POI_VIDEO=0 可整体关闭。
   */
  backfillForPlan(plan: StoredTravelPlan): void {
    if (process.env.PA_TRAVEL_POI_VIDEO === "0") return;
    if (!plan?.planId || this.inFlight.has(plan.planId)) return;
    this.inFlight.add(plan.planId);
    const tasks: Array<{ day: number; stop: number; name: string }> = [];
    (plan.days ?? []).forEach((day, dayIdx) => {
      (day.items ?? []).forEach((item, stopIdx) => {
        if (item.type !== "attraction" || !item.name) return;
        if ((item.videos ?? []).length > 0) return;
        tasks.push({ day: dayIdx, stop: stopIdx, name: item.name });
      });
    });
    if (tasks.length === 0) {
      this.inFlight.delete(plan.planId);
      return;
    }
    const dest = plan.destination ?? "";
    console.log(`[TravelPoiVideo] 后台视频回填启动: ${dest}，${tasks.length} 个景点（不阻塞规划）`);
    void (async () => {
      let cursor = 0;
      const worker = async (): Promise<void> => {
        for (;;) {
          const idx = cursor++;
          if (idx >= tasks.length) return;
          const t = tasks[idx]!;
          const poiKey = `${dest}::${t.name}`;
          try {
            if (!poiVideoCache.has(poiKey)) {
              const res = await this.deps.searchVideos(`${dest} ${t.name}`, SEARCH_LIMIT);
              poiVideoCache.set(poiKey, pickTopVideo(res?.items ?? [], t.name, dest));
            }
            const video = poiVideoCache.get(poiKey) ?? null;
            if (video) {
              this.store.setStopVideos(plan.planId, t.day, t.stop, [video]);
            }
          } catch {
            // 单站失败不影响其余；清缓存下次行程重新尝试
            poiVideoCache.delete(poiKey);
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tasks.length) }, worker));
      this.inFlight.delete(plan.planId);
      console.log(`[TravelPoiVideo] 后台视频回填完成: ${dest}`);
    })();
  }
}
