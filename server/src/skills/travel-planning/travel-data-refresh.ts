/**
 * 旅行数据维护服务
 *
 * 解决的问题（2026-10-12）：数据以前只有「散落的 JSON + 被动 TTL」，
 * 没有任何地方能回答「这个城市的图什么时候抓的、抓了几张、有多少还是外链」，
 * 也没有入口能主动更新。本服务把这三件事补齐：
 *
 *  1. **存量本地化**：把媒体库里仍指向第三方外链的图片抓成本机资产（内容寻址）。
 *     历史数据（本地化能力上线前抓的）因此自动补齐，弱网/离线也能出图。
 *  2. **状态快照**：城市/POI/图片/本地化率/最后更新时间 —— 可查询、可审计。
 *  3. **按目的地重抓**：对缺图的 POI 再跑一轮抓取（走 PlanningService 的多源链路）。
 *
 * 设计：只编排，不重复实现能力——本地化在 travelMediaStore，抓取在 PlanningService，
 * 落库在 travelPoiDb。这里负责「遍历谁、并发多少、统计什么」。
 */
import { travelPoiDb } from './travel-poi-db.js';
import { travelMediaStore, type PoiMediaType } from './travel-media-store.js';

export interface LocalizeSummary {
  /** 扫描到的媒体 POI 数 */
  scannedPois: number;
  /** 逐条检查的外链图片数 */
  checkedImages: number;
  /** 成功落盘本机 */
  localizedImages: number;
  /** 下载失败（保留外链） */
  failedImages: number;
  elapsedMs: number;
}

export interface DataSnapshot {
  cities: number;
  pois: number;
  mediaPois: number;
  images: number;
  /** 已本地化的图片数（url 指向 /travel/media/assets/） */
  localImages: number;
  /** 本地化率（0~1） */
  localizedRatio: number;
  /** 最近一次媒体写入时间（ISO，空串表示还没有媒体数据） */
  lastMediaUpdateAt: string;
  /** 库里访问最多的前 5 个目的地 */
  topDestinations: Array<{ destination: string; accessCount: number; poiCount: number }>;
  dbBytes: number;
}

/** 补全函数（由 bootstrap 注入 PlanningService.backfillMediaForPoi，避免本模块反向依赖服务层） */
export type PoiMediaFetcher = (
  name: string,
  type: PoiMediaType,
  latitude?: number,
  longitude?: number,
) => Promise<{ images: number; videos: number; reviews: number }>;

/** 一次补全任务新增的媒体数量
 *  videos/reviews 恒为 0：视频与评论能力已于 2026-10-12 下线，字段保留只为
 *  不必改调用方（backfillMediaForPoi 的返回结构里也有这两个恒 0 字段）。 */
export interface MediaAdded {
  images: number;
  videos: number;
  reviews: number;
}

class TravelDataRefreshService {
  private fetcher: PoiMediaFetcher | null = null;
  private running = false;

  /** 注入媒体补全实现（bootstrap 里接 PlanningService.backfillMediaForPoi） */
  setMediaFetcher(fn: PoiMediaFetcher): void {
    this.fetcher = fn;
  }

  /**
   * 存量本地化：遍历媒体库，把 url 仍是 http(s) 外链的图片抓成本机资产。
   *
   * 幂等：已是本机资产的条目直接跳过，所以可以放心重复跑（启动后自动跑一次，
   * 之后靠手动入口）。
   */
  async localizePendingImages(opts: { limit?: number; concurrency?: number } = {}): Promise<LocalizeSummary> {
    const started = Date.now();
    const limit = opts.limit ?? 400;
    const concurrency = Math.max(1, Math.min(opts.concurrency ?? 3, 8));
    const keys = travelPoiDb.listMediaPoiKeys().slice(0, limit);
    const summary: LocalizeSummary = {
      scannedPois: 0,
      checkedImages: 0,
      localizedImages: 0,
      failedImages: 0,
      elapsedMs: 0,
    };

    let cursor = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const idx = cursor++;
        if (idx >= keys.length) return;
        const key = keys[idx]!;
        const head = travelPoiDb.getMediaPoi(key);
        if (!head) continue;
        try {
          const r = await travelMediaStore.materializeEntryImages(head.type as PoiMediaType, head.name);
          if (r.checked > 0) summary.scannedPois++;
          summary.checkedImages += r.checked;
          summary.localizedImages += r.localized;
          summary.failedImages += r.failed;
        } catch {
          summary.failedImages++;
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, keys.length || 1) }, () => worker()));
    summary.elapsedMs = Date.now() - started;
    return summary;
  }

  /**
* 按目的地补全 POI 媒体：照片（缺失才补）。
 * 2026-10-12：视频与评论能力下线，媒体只剩照片一类。
   */
  async refreshDestination(
    destination: string,
    opts: { limit?: number; concurrency?: number } = {},
  ): Promise<{ destination: string; attempted: number; filled: number; added: MediaAdded }> {
    const fetcher = this.fetcher;
    const empty: MediaAdded = { images: 0, videos: 0, reviews: 0 };
    const matched = travelPoiDb
      .listCities()
      .filter((c) => c.destination === destination || c.slug === destination);
    if (!fetcher || matched.length === 0) {
      return { destination, attempted: 0, filled: 0, added: empty };
    }
    const city = matched[0]!;
    const pois = travelPoiDb.listPois(city.slug);
    const limit = opts.limit ?? 60;
    const concurrency = Math.max(1, Math.min(opts.concurrency ?? 3, 8));
    // 不做「缺图才补」的预筛：判据在 fetcher 内部做，预筛会把 POI 挡在补全之外。
    const targets = pois.slice(0, limit);

    const added: MediaAdded = { images: 0, videos: 0, reviews: 0 };
    let filled = 0;
    let cursor = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const idx = cursor++;
        if (idx >= targets.length) return;
        const poi = targets[idx]!;
        try {
          const r = await fetcher(
            poi.name,
            poi.type as PoiMediaType,
            poi.latitude ?? undefined,
            poi.longitude ?? undefined,
          );
          added.images += r.images;
          if (r.images > 0) filled++;
        } catch {
          /* 单点失败不影响其余 */
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, targets.length || 1) }, () => worker()));
    return { destination: city.destination, attempted: targets.length, filled, added };
  }

  /** 数据健康快照（可查询、可审计） */
  snapshot(): DataSnapshot {
    const cities = travelPoiDb.listCities();
    let pois = 0;
    const topDestinations = cities
      .map((c) => {
        const count = travelPoiDb.listPois(c.slug).length;
        pois += count;
        return { destination: c.destination, accessCount: c.access_count, poiCount: count };
      })
      .sort((a, b) => b.accessCount - a.accessCount)
      .slice(0, 5);

    let images = 0;
    let localImages = 0;
    let lastMediaUpdateAt = '';
    for (const key of travelPoiDb.listMediaPoiKeys()) {
      const head = travelPoiDb.getMediaPoi(key);
      if (head && head.updated_at > lastMediaUpdateAt) lastMediaUpdateAt = head.updated_at;
      for (const row of travelPoiDb.listAllMedia(key)) {
        if (row.kind !== 'image') continue;
        images++;
        try {
          const payload = row.payload_json ? (JSON.parse(row.payload_json) as { url?: string }) : null;
          // 判据：展示 URL 不是 http(s) 即视为本机资产（与 localize 的写入形状一致）
          if (payload?.url && !/^https?:/i.test(payload.url)) localImages++;
        } catch {
          /* 脏数据不计入本地化 */
        }
      }
    }

    return {
      cities: cities.length,
      pois,
      mediaPois: travelPoiDb.countMediaPois(),
      images,
      localImages,
      localizedRatio: images > 0 ? localImages / images : 0,
      lastMediaUpdateAt,
      topDestinations,
      dbBytes: travelPoiDb.dbSizeBytes(),
    };
  }

  /** 是否已有一次本地化在跑（防重复触发） */
  get isRunning(): boolean {
    return this.running;
  }

  /**
   * 启动后的自动维护：延迟跑一次存量本地化。
   * 延迟是为了不跟启动期的其它初始化抢网络/CPU；失败静默（下次启动或手动再跑）。
   */
  scheduleStartupLocalize(delayMs = 45_000): void {
    if ((process.env.TRAVEL_DATA_AUTO_LOCALIZE ?? 'on').toLowerCase() === 'off') return;
    const timer = setTimeout(() => {
      void this.runExclusive(() => this.localizePendingImages());
    }, delayMs);
    timer.unref?.();
  }

  /** 互斥执行：同一时间只允许一个维护任务（避免启动任务与手动触发叠加） */
  async runExclusive<T>(fn: () => Promise<T>): Promise<T | null> {
    if (this.running) return null;
    this.running = true;
    try {
      return await fn();
    } catch (err) {
      console.warn('[TravelData] 维护任务失败:', err instanceof Error ? err.message : err);
      return null;
    } finally {
      this.running = false;
    }
  }
}

export const travelDataRefresh = new TravelDataRefreshService();
