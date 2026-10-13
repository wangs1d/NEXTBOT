/**
 * 旅游 POI 专属数据库（SQLite 单文件：data/travel-poi.db）
 *
 * 定位：把旅游 POI 及其「真实数据」（照片/视频/评论）从分散的 JSON 文件
 * 收敛为一个可查询的本地专属库。任何抓过一次的数据自动落库（自增长），
 * 后续查询只走本地，不再重复出网。
 *
 * 表结构：
 *   cities     目的地缓存条目（poi-cache 的目的地级载体）：中心坐标 + 统计
 *   pois       POI 行（目的地内景点/酒店/餐厅）：name_norm 可查、payload 存 raw/images/splatUrl
 *   media_pois 媒体条目头（type:归一化名 粒度，与旧 poiKey 对齐）
 *   media      媒体行：image | review | video，payload_json 存各自结构
 *
 * 存储引擎：Node 24 内置 node:sqlite（DatabaseSync），零外部依赖。
 * 迁移：首次启动把旧 data/poi-cache/*.json 与 data/travel-media/*.json
 *       导入本库，成功后旧目录重命名为 *.migrated（assets 资源目录保留原地）。
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import path from 'path';

export interface DbCityRow {
  slug: string;
  destination: string;
  center_lat: number | null;
  center_lng: number | null;
  created_at: string;
  last_accessed_at: string;
  access_count: number;
}

export interface DbPoiRow {
  city_slug: string;
  poi_id: string;
  type: string;
  name: string;
  name_norm: string;
  latitude: number | null;
  longitude: number | null;
  address: string | null;
  rating: number | null;
  tags_json: string | null;
  payload_json: string | null;
  updated_at: string;
}

export interface DbMediaPoiRow {
  poi_key: string;
  type: string;
  name: string;
  latitude: number | null;
  longitude: number | null;
  updated_at: string;
}

export interface DbMediaRow {
  poi_key: string;
  kind: 'image' | 'review' | 'video';
  item_id: string;
  payload_json: string;
  created_at: string;
}

/** SQLite 本地读写无并发竞争，BEGIN IMMEDIATE 串行化批量写即可 */
class TravelPoiDb {
  private db: DatabaseSync;
  readonly dbPath: string;

  constructor() {
    const dataDir = path.join(process.cwd(), 'data');
    this.dbPath = path.join(dataDir, 'travel-poi.db');
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.migrateSchema();
    this.migrateLegacyJson();
  }

  private migrateSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT
      );
      CREATE TABLE IF NOT EXISTS cities (
        slug TEXT PRIMARY KEY,
        destination TEXT NOT NULL,
        center_lat REAL,
        center_lng REAL,
        created_at TEXT NOT NULL,
        last_accessed_at TEXT NOT NULL,
        access_count INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS pois (
        city_slug TEXT NOT NULL,
        poi_id TEXT NOT NULL,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        name_norm TEXT NOT NULL,
        latitude REAL,
        longitude REAL,
        address TEXT,
        rating REAL,
        tags_json TEXT,
        payload_json TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (city_slug, poi_id)
      );
      CREATE INDEX IF NOT EXISTS idx_pois_city ON pois(city_slug);
      CREATE INDEX IF NOT EXISTS idx_pois_name ON pois(name_norm);
      CREATE TABLE IF NOT EXISTS media_pois (
        poi_key TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        latitude REAL,
        longitude REAL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS media (
        poi_key TEXT NOT NULL,
        kind TEXT NOT NULL,
        item_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (poi_key, kind, item_id)
      );
      CREATE INDEX IF NOT EXISTS idx_media_poi ON media(poi_key);
    `);
  }

  // ======================== 通用访问 ========================

  getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  /** 事务包裹（同步 fn，出错 ROLLBACK 后重抛） */
  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const result = fn();
      this.db.exec('COMMIT;');
      return result;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK;');
      } catch { /* 已自动回滚时忽略 */ }
      throw err;
    }
  }

  // ======================== cities + pois（目的地级 POI 缓存） ========================

  getCity(slug: string): DbCityRow | null {
    return (this.db.prepare('SELECT * FROM cities WHERE slug = ?').get(slug) as DbCityRow | undefined) ?? null;
  }

  upsertCity(row: {
    slug: string;
    destination: string;
    centerLat: number;
    centerLng: number;
    createdAt: string;
    lastAccessedAt: string;
    accessCount: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO cities (slug, destination, center_lat, center_lng, created_at, last_accessed_at, access_count)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(slug) DO UPDATE SET
           destination = excluded.destination,
           center_lat = excluded.center_lat,
           center_lng = excluded.center_lng,
           last_accessed_at = excluded.last_accessed_at,
           access_count = excluded.access_count`,
      )
      .run(row.slug, row.destination, row.centerLat, row.centerLng, row.createdAt, row.lastAccessedAt, row.accessCount);
  }

  /** 触达统计（get 命中时调用） */
  touchCity(slug: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare('UPDATE cities SET last_accessed_at = ?, access_count = access_count + 1 WHERE slug = ?')
      .run(now, slug);
  }

  listCities(): DbCityRow[] {
    return this.db.prepare('SELECT * FROM cities ORDER BY access_count DESC').all() as unknown as DbCityRow[];
  }

  deleteCity(slug: string): void {
    this.tx(() => {
      this.db.prepare('DELETE FROM pois WHERE city_slug = ?').run(slug);
      this.db.prepare('DELETE FROM cities WHERE slug = ?').run(slug);
    });
  }

  listPois(slug: string): DbPoiRow[] {
    return this.db.prepare('SELECT * FROM pois WHERE city_slug = ? ORDER BY rowid').all(slug) as unknown as DbPoiRow[];
  }

  replacePois(
    slug: string,
    rows: Array<{
      poiId: string;
      type: string;
      name: string;
      latitude: number;
      longitude: number;
      address: string;
      rating?: number;
      tags?: string[];
      payload: Record<string, unknown>;
    }>,
  ): void {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(
      `INSERT INTO pois (city_slug, poi_id, type, name, name_norm, latitude, longitude, address, rating, tags_json, payload_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(city_slug, poi_id) DO UPDATE SET
         type = excluded.type, name = excluded.name, name_norm = excluded.name_norm,
         latitude = excluded.latitude, longitude = excluded.longitude, address = excluded.address,
         rating = excluded.rating, tags_json = excluded.tags_json, payload_json = excluded.payload_json,
         updated_at = excluded.updated_at`,
    );
    const norm = (s: string) => s.toLowerCase().replace(/\s+/g, '');
    this.tx(() => {
      this.db.prepare('DELETE FROM pois WHERE city_slug = ?').run(slug);
      for (const r of rows) {
        stmt.run(
          slug,
          r.poiId,
          r.type,
          r.name,
          norm(r.name),
          r.latitude,
          r.longitude,
          r.address,
          r.rating ?? null,
          r.tags ? JSON.stringify(r.tags) : null,
          JSON.stringify(r.payload),
          now,
        );
      }
    });
  }

  /** 单 POI 补图（回填落库：photos 是 POI 稳定属性，抓一次永久复用）。type 为单数（attraction/hotel/restaurant） */
  updatePoiImages(slug: string, type: string, poiId: string, images: string[]): boolean {
    const row = this.db
      .prepare('SELECT payload_json FROM pois WHERE city_slug = ? AND type = ? AND poi_id = ?')
      .get(slug, type, poiId) as { payload_json: string } | undefined;
    if (!row) return false;
    try {
      const payload = JSON.parse(row.payload_json) as { images?: string[] };
      payload.images = images;
      this.db
        .prepare('UPDATE pois SET payload_json = ?, updated_at = ? WHERE city_slug = ? AND type = ? AND poi_id = ?')
        .run(JSON.stringify(payload), new Date().toISOString(), slug, type, poiId);
      return true;
    } catch {
      return false;
    }
  }

  /** 跨目的地按名称找 POI（专属库检索入口） */
  findPoisByName(nameNorm: string, limit = 50): DbPoiRow[] {
    return this.db
      .prepare('SELECT * FROM pois WHERE name_norm = ? LIMIT ?')
      .all(nameNorm, limit) as unknown as DbPoiRow[];
  }

  /**
   * 库占用字节数。
   *
   * WAL 模式下新写入先进 `-wal`，主库文件可能长期只有 4KB（checkpoint 前），
   * 只统计主文件会把几 MB 的库报成 4KB。三个文件一起算才是真实占用。
   */
  dbSizeBytes(): number {
    let total = 0;
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        total += fs.statSync(`${this.dbPath}${suffix}`).size;
      } catch { /* 文件不存在：跳过 */ }
    }
    return total;
  }

  // ======================== media（POI 级 图/评/视频） ========================

  /** 媒体条目总数（stats 用） */
  countMediaPois(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM media_pois').get() as { n: number } | undefined;
    return row?.n ?? 0;
  }

  /** 全部媒体 POI 的键（存量本地化/刷新任务遍历用） */
  listMediaPoiKeys(): string[] {
    const rows = this.db
      .prepare('SELECT poi_key FROM media_pois ORDER BY updated_at DESC')
      .all() as Array<{ poi_key: string }>;
    return rows.map((r) => r.poi_key);
  }

  getMediaPoi(poiKey: string): DbMediaPoiRow | null {
    return (
      (this.db.prepare('SELECT * FROM media_pois WHERE poi_key = ?').get(poiKey) as DbMediaPoiRow | undefined) ?? null
    );
  }

  upsertMediaPoi(row: {
    poiKey: string;
    type: string;
    name: string;
    latitude?: number;
    longitude?: number;
  }): void {
    const now = new Date().toISOString();
    const existing = this.getMediaPoi(row.poiKey);
    if (existing) {
      this.db
        .prepare('UPDATE media_pois SET latitude = COALESCE(?, latitude), longitude = COALESCE(?, longitude), updated_at = ? WHERE poi_key = ?')
        .run(row.latitude ?? null, row.longitude ?? null, now, row.poiKey);
    } else {
      this.db
        .prepare('INSERT INTO media_pois (poi_key, type, name, latitude, longitude, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(row.poiKey, row.type, row.name, row.latitude ?? null, row.longitude ?? null, now);
    }
  }

  listMedia(poiKey: string, kind: DbMediaRow['kind']): DbMediaRow[] {
    return this.db
      .prepare('SELECT * FROM media WHERE poi_key = ? AND kind = ? ORDER BY rowid')
      .all(poiKey, kind) as unknown as DbMediaRow[];
  }

  listAllMedia(poiKey: string): DbMediaRow[] {
    return this.db
      .prepare('SELECT * FROM media WHERE poi_key = ? ORDER BY rowid')
      .all(poiKey) as unknown as DbMediaRow[];
  }

  /** 同 (poi_key, kind, item_id) 冲突时忽略（幂等写入） */
  insertMedia(row: {
    poiKey: string;
    kind: DbMediaRow['kind'];
    itemId: string;
    payload: Record<string, unknown>;
    createdAt: string;
  }): void {
    this.db
      .prepare('INSERT OR IGNORE INTO media (poi_key, kind, item_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(row.poiKey, row.kind, row.itemId, JSON.stringify(row.payload), row.createdAt);
  }

  upsertMedia(row: {
    poiKey: string;
    kind: DbMediaRow['kind'];
    itemId: string;
    payload: Record<string, unknown>;
    createdAt: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO media (poi_key, kind, item_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(poi_key, kind, item_id) DO UPDATE SET payload_json = excluded.payload_json`,
      )
      .run(row.poiKey, row.kind, row.itemId, JSON.stringify(row.payload), row.createdAt);
  }

  deleteMedia(poiKey: string, kind: DbMediaRow['kind'], itemId: string): boolean {
    const r = this.db.prepare('DELETE FROM media WHERE poi_key = ? AND kind = ? AND item_id = ?').run(poiKey, kind, itemId);
    return Number(r.changes) > 0;
  }

  // ======================== 旧 JSON 一次性迁移 ========================

  /** 已迁移则跳过；成功后旧目录改名 *.migrated（assets 保留原地不动） */
  private migrateLegacyJson(): void {
    if (this.getMeta('legacy_json_migrated') === '1') return;
    let importedCities = 0;
    let importedPois = 0;
    let importedMedia = 0;

    // 1) poi-cache/*.json → cities + pois
    const poiCacheDir = path.join(process.cwd(), 'data', 'poi-cache');
    if (fs.existsSync(poiCacheDir)) {
      for (const file of fs.readdirSync(poiCacheDir).filter((f) => f.endsWith('.json'))) {
        try {
          const raw = JSON.parse(fs.readFileSync(path.join(poiCacheDir, file), 'utf-8')) as {
            destination?: string;
            queryKey?: string;
            center?: { latitude: number; longitude: number };
            createdAt?: string;
            lastAccessedAt?: string;
            accessCount?: number;
            data?: { attractions?: unknown[]; hotels?: unknown[]; restaurants?: unknown[] };
          };
          const destination = raw.destination;
          const center = raw.center;
          if (!destination || !center) continue;
          const slug = raw.queryKey || Buffer.from(destination.toLowerCase().replace(/\s+/g, '-'), 'utf-8').toString('hex').slice(0, 64);
          const now = new Date().toISOString();
          this.upsertCity({
            slug,
            destination,
            centerLat: center.latitude,
            centerLng: center.longitude,
            createdAt: raw.createdAt || now,
            lastAccessedAt: raw.lastAccessedAt || raw.createdAt || now,
            accessCount: raw.accessCount ?? 1,
          });
          const rows: Parameters<TravelPoiDb['replacePois']>[1] = [];
          for (const listKey of ['attractions', 'hotels', 'restaurants'] as const) {
            const list = (raw.data?.[listKey] ?? []) as Array<Record<string, unknown>>;
            for (const p of list) {
              if (typeof p?.id !== 'string' || typeof p?.name !== 'string') continue;
              rows.push({
                poiId: p.id,
                type: listKey.slice(0, -1), // attractions → attraction
                name: p.name,
                latitude: Number(p.latitude) || 0,
                longitude: Number(p.longitude) || 0,
                address: typeof p.address === 'string' ? p.address : '',
                rating: typeof p.rating === 'number' ? p.rating : undefined,
                tags: Array.isArray(p.tags) ? (p.tags as string[]) : undefined,
                payload: p,
              });
            }
          }
          this.replacePois(slug, rows);
          importedCities++;
          importedPois += rows.length;
        } catch (err) {
          console.warn(`[TravelPoiDb] 迁移 poi-cache/${file} 失败:`, err instanceof Error ? err.message : err);
        }
      }
      this.renameMigrated(poiCacheDir);
    }

    // 2) travel-media/*.json → media_pois + media
    //    注意：assets/ 上传资源目录保留原地（URL 指向不变），只迁走元数据 JSON
    const mediaDir = path.join(process.cwd(), 'data', 'travel-media');
    if (fs.existsSync(mediaDir)) {
      for (const file of fs.readdirSync(mediaDir).filter((f) => f.endsWith('.json'))) {
        try {
          const raw = JSON.parse(fs.readFileSync(path.join(mediaDir, file), 'utf-8')) as {
            poiKey?: string;
            type?: string;
            name?: string;
            latitude?: number;
            longitude?: number;
            images?: Array<Record<string, unknown>>;
            reviews?: Array<Record<string, unknown>>;
            videos?: Array<Record<string, unknown>>;
          };
          if (!raw.poiKey || !raw.type || !raw.name) continue;
          this.upsertMediaPoi({
            poiKey: raw.poiKey,
            type: raw.type,
            name: raw.name,
            latitude: raw.latitude,
            longitude: raw.longitude,
          });
          for (const img of raw.images ?? []) {
            if (typeof img.url !== 'string') continue;
            this.insertMedia({
              poiKey: raw.poiKey,
              kind: 'image',
              itemId: img.url,
              payload: img,
              createdAt: typeof img.createdAt === 'string' ? img.createdAt : new Date().toISOString(),
            });
            importedMedia++;
          }
          for (const rev of raw.reviews ?? []) {
            if (typeof rev.id !== 'string') continue;
            this.insertMedia({
              poiKey: raw.poiKey,
              kind: 'review',
              itemId: rev.id,
              payload: rev,
              createdAt: typeof rev.createdAt === 'string' ? rev.createdAt : new Date().toISOString(),
            });
            importedMedia++;
          }
          for (const vid of raw.videos ?? []) {
            if (typeof vid.playPageUrl !== 'string') continue;
            this.insertMedia({
              poiKey: raw.poiKey,
              kind: 'video',
              itemId: vid.playPageUrl,
              payload: vid,
              createdAt: typeof vid.createdAt === 'string' ? vid.createdAt : new Date().toISOString(),
            });
            importedMedia++;
          }
          // 元数据 JSON 改名标记已迁移（目录与 assets 保留）
          try {
            fs.renameSync(path.join(mediaDir, file), path.join(mediaDir, `${file}.migrated`));
          } catch { /* 改名失败不阻塞 */ }
        } catch (err) {
          console.warn(`[TravelPoiDb] 迁移 travel-media/${file} 失败:`, err instanceof Error ? err.message : err);
        }
      }
    }

    this.setMeta('legacy_json_migrated', '1');
    if (importedCities > 0 || importedMedia > 0) {
      console.log(
        `[TravelPoiDb] 旧 JSON 迁移完成: ${importedCities} 个目的地 / ${importedPois} 个POI / ${importedMedia} 条媒体 → ${this.dbPath}`,
      );
    }
  }

  private renameMigrated(dir: string): void {
    try {
      fs.renameSync(dir, `${dir}.migrated`);
    } catch (err) {
      // 改名失败不阻塞（meta 已标记，不会重复导入）
      console.warn(`[TravelPoiDb] 旧目录改名失败: ${dir}`, err instanceof Error ? err.message : err);
    }
  }
}

/** 全局单例：旅游 POI 专属库 */
export const travelPoiDb = new TravelPoiDb();
