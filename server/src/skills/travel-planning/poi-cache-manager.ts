/**
 * POI 缓存管理器
 *
 * 策略：文件持久化 + 内存加速
 * - 首次搜索某目的地 → 调外部API → 存入JSON文件 + 内存
 * - 后续访问 → 直接读内存（毫秒级）
 * - 服务重启后 → 从文件恢复到内存（不丢失数据）
 * - 所有用户共享同一份缓存（全局受益）
 */

import { travelPoiDb, type DbPoiRow } from './travel-poi-db.js';

/** POI 缓存 TTL：过期条目仍可用（stale-while-revalidate），由服务层触发后台刷新。
 *  可用环境变量 POI_CACHE_TTL_MS 覆盖（默认 7 天）。 */
const POI_CACHE_TTL_MS =
  Number(process.env.POI_CACHE_TTL_MS) > 0
    ? Number(process.env.POI_CACHE_TTL_MS)
    : 7 * 24 * 60 * 60 * 1000;

/** 单个目的地的缓存条目 */
export interface CacheEntry {
  /** 目的地名称 */
  destination: string;
  /** 搜索关键词（用于去重） */
  queryKey: string;
  /** 缓存的POI数据 */
  data: {
    attractions: RawPOI[];
    hotels: RawPOI[];
    restaurants: RawPOI[];
  };
  /** 中心坐标 */
  center: { latitude: number; longitude: number };
  /** 创建时间 */
  createdAt: string;
  /** 最后访问时间 */
  lastAccessedAt: string;
  /** 访问次数（用于统计热门目的地） */
  accessCount: number;
}

/** 原始POI数据结构 */
export interface RawPOI {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  address: string;
  type: string;
  rating?: number;
  tags?: string[];
  /** 已抓取的真实图片（POI 稳定属性，随缓存落盘，行程规划直接复用） */
  images?: string[];
  /** 3D 高斯溅射（3DGS）沉浸式实景素材 URL（.ply/.splat/.ksplat） */
  splatUrl?: string;
  raw?: Record<string, unknown>;
}

/** 落库用的 POI 行（与 travelPoiDb.replacePois 的入参形状一致） */
interface PoiRowInput {
  poiId: string;
  type: string;
  name: string;
  latitude: number;
  longitude: number;
  address: string;
  rating?: number;
  tags?: string[];
  payload: Record<string, unknown>;
}

export class POICacheManager {
  private memoryCache: Map<string, CacheEntry> = new Map();
  private maxMemoryEntries: number = 100; // 内存最多缓存100个目的地

  constructor() {
    // 持久化层已从「每城市一个 JSON 文件」切到 SQLite（travel-poi.db）：
    // 权威源、可查询、可审计（每次写入带 created_at/updated_at，刷新服务据此
    // 决定刷谁）。旧 JSON 由 travelPoiDb 构造时一次性导入、目录改名 *.migrated
    // 保留（可回滚），因此这里不再扫文件。
    this.restoreFromStore();
  }

  // ======================== 公共接口 ========================

  /**
   * 获取缓存（命中返回数据，未命中返回null）
   */
  get(destination: string): CacheEntry | null {
    const key = this.normalizeKey(destination);
    const entry = this.memoryCache.get(key);

    if (entry) {
      entry.lastAccessedAt = new Date().toISOString();
      entry.accessCount++;
      return entry;
    }

    // 内存没有 → 从 SQLite 读（顺带把 lastAccessedAt/accessCount 落库）
    return this.loadFromStore(key);
  }

  /**
   * 写入缓存（同时写内存和文件）
   */
  set(
    destination: string,
    data: CacheEntry['data'],
    center: CacheEntry['center']
  ): CacheEntry {
    const key = this.normalizeKey(destination);
    const now = new Date().toISOString();

    const entry: CacheEntry = {
      destination,
      queryKey: key,
      data,
      center,
      createdAt: now,
      lastAccessedAt: now,
      accessCount: 1,
    };

    // 写入内存
    this.evictIfNeeded();
    this.memoryCache.set(key, entry);

    // 落库（SQLite 权威源，供重启/其他调用方/刷新服务使用）
    this.persist(key, entry);

    console.log(`[POICache] 已缓存: ${destination} (景点${data.attractions.length} 酒店${data.hotels.length} 餐厅${data.restaurants.length})`);
    return entry;
  }

  /**
   * 检查是否有缓存
   */
  has(destination: string): boolean {
    const key = this.normalizeKey(destination);
    if (this.memoryCache.has(key)) return true;
    try {
      return travelPoiDb.getCity(key) != null;
    } catch {
      return false;
    }
  }

  /**
   * 是否已过 TTL（数据可能陈旧）。条目无有效时间戳时视为过期。
   * 过期不等于不可用：调用方应「先用旧数据 + 触发后台刷新」。
   */
  isStale(entry: CacheEntry): boolean {
    const ts = Date.parse(entry.createdAt || '');
    if (!Number.isFinite(ts)) return true;
    return Date.now() - ts > POI_CACHE_TTL_MS;
  }

  /**
   * 获取所有已缓存的目的地列表
   */
  listCachedDestinations(): Array<{
    destination: string;
    accessCount: number;
    createdAt: string;
    poiCount: number;
  }> {
    const result: Array<{ destination: string; accessCount: number; createdAt: string; poiCount: number }> = [];
    try {
      // 以库为准：内存只装最近 100 个，库里有全量
      for (const city of travelPoiDb.listCities()) {
        const mem = this.memoryCache.get(city.slug);
        result.push({
          destination: city.destination,
          accessCount: city.access_count,
          createdAt: city.created_at,
          poiCount: mem
            ? mem.data.attractions.length + mem.data.hotels.length + mem.data.restaurants.length
            : travelPoiDb.listPois(city.slug).length,
        });
      }
    } catch {
      // 库不可用（极端情况）：退回内存视图，不抛错
      for (const [, entry] of this.memoryCache) {
        result.push({
          destination: entry.destination,
          accessCount: entry.accessCount,
          createdAt: entry.createdAt,
          poiCount: entry.data.attractions.length + entry.data.hotels.length + entry.data.restaurants.length,
        });
      }
    }
    // 按访问次数排序（热点目的地优先，刷新服务也按这个顺序刷）
    return result.sort((a, b) => b.accessCount - a.accessCount);
  }

  /**
   * 清除指定目的地的缓存
   */
  invalidate(destination: string): boolean {
    const key = this.normalizeKey(destination);
    const inMemory = this.memoryCache.delete(key);
    let inDb = false;
    try {
      inDb = travelPoiDb.getCity(key) != null;
      travelPoiDb.deleteCity(key);
    } catch { /* 库不可用：至少内存已清 */ }
    return inMemory || inDb;
  }

  /**
   * 为某目的地下的单个 POI 关联/更新真实图片（内存 + 文件持久化）。
   *
   * 图片是 POI 的稳定属性：行程规划时抓取一次即落盘，后续同目的地的
   * 规划直接复用，无需重复请求图片源（省 ~8s 网络等待）。
   */
  updatePOIImages(
    destination: string,
    type: 'attraction' | 'hotel' | 'restaurant',
    poiId: string,
    images: string[],
  ): void {
    if (!images.length) return;
    const key = this.normalizeKey(destination);
    const entry = this.memoryCache.get(key) ?? this.loadFromStore(key);
    if (!entry) return;
    const listKey = `${type}s` as keyof CacheEntry['data'];
    const poi = entry.data[listKey].find((p) => p.id === poiId);
    if (!poi) return;
    poi.images = images;
    this.persist(key, entry);
  }

  /**
   * 获取缓存统计信息
   */
  getStats(): {
    memoryEntries: number;
    fileEntries: number;
    totalSizeBytes: number;
    topDestinations: Array<{ destination: string; accessCount: number }>;
  } {
    // 字段名沿用 fileEntries/totalSizeBytes（healthCheck 在消费），语义已切到
    // SQLite：分别表示「库里持久化的目的地数」与「库文件字节数」。
    let persistedEntries = 0;
    let dbBytes = 0;
    try {
      persistedEntries = travelPoiDb.listCities().length;
      dbBytes = travelPoiDb.dbSizeBytes();
    } catch { /* 库不可用：返回内存视图 */ }

    const topDestinations = this.listCachedDestinations()
      .slice(0, 10)
      .map(d => ({ destination: d.destination, accessCount: d.accessCount }));

    return {
      memoryEntries: this.memoryCache.size,
      fileEntries: persistedEntries,
      totalSizeBytes: dbBytes,
      topDestinations,
    };
  }

  // ======================== 私有方法 ========================

  private normalizeKey(destination: string): string {
    // 使用安全的ASCII编码：先标准化（小写+去空格），再用Buffer转hex
    const normalized = destination.toLowerCase().replace(/\s+/g, '-');
    return Buffer.from(normalized, 'utf-8').toString('hex').slice(0, 64);
  }

  // ── 持久化层（SQLite / travel-poi.db）────────────────────────────
  // 设计要点：POI 的完整原始对象存进 pois.payload_json（图片/评分/标签都在里面），
  // 结构化列只用于查询与排序。所以「补图」不需要单独的迁移脚本——payload 一变
  // 整行就跟着更新。

  private persist(key: string, entry: CacheEntry): void {
    try {
      travelPoiDb.upsertCity({
        slug: key,
        destination: entry.destination,
        centerLat: entry.center?.latitude ?? 0,
        centerLng: entry.center?.longitude ?? 0,
        createdAt: entry.createdAt,
        lastAccessedAt: entry.lastAccessedAt,
        accessCount: entry.accessCount,
      });
      travelPoiDb.replacePois(key, this.toPoiRows(entry));
    } catch (err) {
      // 写库失败不影响本次请求：内存里仍有数据，只是重启后会丢
      console.warn(`[POICache] 写库失败（内存仍可用）: ${key}`, err instanceof Error ? err.message : err);
    }
  }

  private toPoiRows(entry: CacheEntry): PoiRowInput[] {
    const rows: PoiRowInput[] = [];
    for (const listKey of ['attractions', 'hotels', 'restaurants'] as const) {
      for (const p of entry.data[listKey] ?? []) {
        if (!p?.id || !p?.name) continue;
        rows.push({
          poiId: p.id,
          type: listKey.slice(0, -1), // attractions → attraction
          name: p.name,
          latitude: Number(p.latitude) || 0,
          longitude: Number(p.longitude) || 0,
          address: p.address ?? '',
          rating: typeof p.rating === 'number' ? p.rating : undefined,
          tags: Array.isArray(p.tags) ? p.tags : undefined,
          payload: p as unknown as Record<string, unknown>,
        });
      }
    }
    return rows;
  }

  private poiFromRow(row: DbPoiRow): RawPOI {
    let tags: string[] | undefined;
    if (row.tags_json) {
      try { tags = JSON.parse(row.tags_json) as string[]; } catch { /* 脏数据忽略 */ }
    }
    return {
      id: row.poi_id,
      name: row.name,
      latitude: row.latitude ?? 0,
      longitude: row.longitude ?? 0,
      address: row.address ?? '',
      type: row.type,
      rating: row.rating ?? undefined,
      tags,
    };
  }

  /**
   * 从库读回一个目的地。
   * @param bump 是否累计访问计数（恢复启动快照时不累计，否则每次重启都虚增）
   */
  private readCity(key: string, opts: { cache: boolean; bump: boolean }): CacheEntry | null {
    try {
      const city = travelPoiDb.getCity(key);
      if (!city) return null;
      const rows = travelPoiDb.listPois(key);
      if (rows.length === 0) return null;

      const data: CacheEntry['data'] = { attractions: [], hotels: [], restaurants: [] };
      for (const row of rows) {
        let poi: RawPOI;
        if (row.payload_json) {
          try {
            poi = JSON.parse(row.payload_json) as RawPOI;
          } catch {
            poi = this.poiFromRow(row);
          }
        } else {
          poi = this.poiFromRow(row);
        }
        const listKey = `${row.type}s` as keyof CacheEntry['data'];
        if (Array.isArray(data[listKey])) (data[listKey] as RawPOI[]).push(poi);
      }

      const entry: CacheEntry = {
        destination: city.destination,
        queryKey: key,
        data,
        center: { latitude: city.center_lat ?? 0, longitude: city.center_lng ?? 0 },
        createdAt: city.created_at,
        lastAccessedAt: opts.bump ? new Date().toISOString() : city.last_accessed_at,
        accessCount: opts.bump ? city.access_count + 1 : city.access_count,
      };

      if (opts.cache) {
        this.evictIfNeeded();
        this.memoryCache.set(key, entry);
      }
      if (opts.bump) travelPoiDb.touchCity(key);
      return entry;
    } catch (err) {
      console.warn(`[POICache] 读库失败: ${key}`, err instanceof Error ? err.message : err);
      return null;
    }
  }

  /** 内存未命中时从库补齐（并累计一次访问） */
  private loadFromStore(key: string): CacheEntry | null {
    return this.readCity(key, { cache: true, bump: true });
  }

  /** 服务启动时从库恢复到内存（只装满内存上限，库里保留全量） */
  private restoreFromStore(): void {
    let count = 0;
    try {
      for (const city of travelPoiDb.listCities()) {
        if (this.memoryCache.size >= this.maxMemoryEntries) break;
        const entry = this.readCity(city.slug, { cache: false, bump: false });
        if (entry) {
          this.memoryCache.set(city.slug, entry);
          count++;
        }
      }
      if (count > 0) {
        console.log(`[POICache] 从 SQLite 恢复 ${count} 个目的地（${travelPoiDb.dbPath}）`);
      }
    } catch (err) {
      console.warn('[POICache] 从 SQLite 恢复失败:', err instanceof Error ? err.message : err);
    }
  }

  /** LRU淘汰：当内存超过上限时淘汰最久未访问的 */
  private evictIfNeeded(): void {
    if (this.memoryCache.size >= this.maxMemoryEntries) {
      let oldestKey: string | null = null;
      let oldestTime = Date.now();

      for (const [key, entry] of this.memoryCache) {
        const time = new Date(entry.lastAccessedAt).getTime();
        if (time < oldestTime) {
          oldestTime = time;
          oldestKey = key;
        }
      }

      if (oldestKey) {
        this.memoryCache.delete(oldestKey);
        console.log(`[POICache] LRU淘汰: ${oldestKey} (当前${this.memoryCache.size}/${this.maxMemoryEntries})`);
      }
    }
  }
}

// 全局单例
export const poiCache = new POICacheManager();
