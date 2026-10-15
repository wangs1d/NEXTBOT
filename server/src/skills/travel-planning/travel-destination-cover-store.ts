/**
 * 目的地代表性封面库（单例）
 *
 * 定位：行程卡海报区背景必须是「目的地本身最具代表性的真实照片」（如
 * 杭州→西湖全景、北京→故宫）。这张照片是目的地级别的形象照，与任何单个
 * POI 都不同——挂到某个景点名下会造成「张冠李戴」，因此独立成库按目的地
 * 缓存，不进 POI 媒体库。
 *
 * 来源（由 TravelPlanningService 解析后写入）：
 *   wikipedia-lead = 维基百科条目主图（pageimages，百科选定的条目代表照）
 *   wikimedia      = 地理锚定 / Commons 文本搜索的实拍（兜底）
 *   vlm-pick       = 多候选经视觉模型终审选出（2026-09-28 起，见
 *                    PlanningService.resolveDestinationCover 的候选池+打分+终审）
 *
 * 旧图升级（supersede）：封面重新解析出更好的图时，把旧 URL/旧资产目录登记
 * 到升级映射；/travel/media/remote 与 /travel/media/assets 两个出口查映射后
 * 改发当前封面——已烤死在历史聊天快照/行程 JSON 里的旧封面自动换新，无需
 * 改写任何存量数据。
 *
 * 存储：data/travel-media/destination-covers.json 单文件（低频写，同步刷盘），
 * 进程内 Map + 懒加载；30 天 TTL（目的地形象照稳定，过期后重新解析）。
 * v2 文件形状：{ version:2, covers, superseded, coverDirs }；兼容读取 v1 平铺
 * 形状（整体即 covers）。
 * TRAVEL_MEDIA_STORE_DIR 环境变量可覆盖存储根目录（与 POI 媒体库一致，测试用）。
 */
import fs from 'fs';
import path from 'path';

export type DestinationCoverSource = 'wikipedia-lead' | 'wikimedia' | 'vlm-pick';

export interface DestinationCover {
  url: string;
  source: DestinationCoverSource;
}

interface CoverRecord {
  url: string;
  source: DestinationCoverSource;
  ts: number;
}

interface StoreFileV2 {
  version: 2;
  covers: Record<string, CoverRecord>;
  /** 旧封面 URL（远程 wikimedia）→ 目的地归一键 */
  superseded: Record<string, string>;
  /** 目的封面对象目录名（fileNameFor(dest-cover-xxx)）→ 目的地归一键 */
  coverDirs: Record<string, string>;
}

/** 封面有效期：目的地形象照基本不变，长缓存即可；过期后下次规划重新解析 */
const COVER_TTL_MS = 30 * 24 * 3600 * 1000;

/** 缓存键归一化：忽略大小写/空白/括号注记，剥尾部行政区划后缀（「杭州市」≈「杭州」） */
function normalizeDest(destination: string): string {
  return destination
    .toLowerCase()
    .replace(/[（(].*?[)）]/g, '')
    .replace(/\s+/g, '')
    .replace(/(特别行政区|自治州|地区|市|县|盟)$/, '');
}

/** 目的地封面对象的本地资产 URL 前缀（/travel/media/assets/<dir>/<file>） */
const COVER_ASSET_DIR_RE = /^\/travel\/media\/assets\/([^/]+)\/[^/]+$/;

/** 剥掉 Commons imageinfo 附带的 utm 跟踪尾参（?utm_source=... 到串尾） */
function stripUtm(url: string): string {
  return url.replace(/\?utm_source=[^#]*$/, '');
}

class TravelDestinationCoverStore {
  private file: string;
  private mem = new Map<string, CoverRecord>();
  private superseded = new Map<string, string>();
  private coverDirs = new Map<string, string>();
  private loaded = false;

  constructor() {
    const root = process.env.TRAVEL_MEDIA_STORE_DIR || path.join(process.cwd(), 'data', 'travel-media');
    this.file = path.join(root, 'destination-covers.json');
  }

  /** 读取目的地封面（未过期才返回；命中不区分来源——代表性照是稳定事实） */
  get(destination: string): DestinationCover | null {
    this.ensureLoaded();
    const hit = this.mem.get(normalizeDest(destination));
    if (!hit || !hit.url) return null;
    if (Date.now() - hit.ts > COVER_TTL_MS) return null;
    return { url: hit.url, source: hit.source };
  }

  /** 读取目的地封面（无视 TTL）：升级映射登记时需要拿到「被换下的旧图」 */
  peek(destination: string): DestinationCover | null {
    this.ensureLoaded();
    const hit = this.mem.get(normalizeDest(destination));
    return hit?.url ? { url: hit.url, source: hit.source } : null;
  }

  /**
   * 驱逐目的地封面（强制刷新用）：移除并返回旧记录（无视 TTL）；无记录返回
   * null。superseded/coverDirs 升级映射刻意保留——刷新换新图后，历史卡片烤死
   * 的旧资产目录/旧远程 URL 仍能改发当前封面。
   */
  evict(destination: string): DestinationCover | null {
    this.ensureLoaded();
    const key = normalizeDest(destination);
    const hit = this.mem.get(key);
    if (!hit) return null;
    this.mem.delete(key);
    this.persist();
    return { url: hit.url, source: hit.source };
  }

  set(destination: string, cover: DestinationCover): void {
    const url = cover.url?.trim();
    if (!url) return;
    this.ensureLoaded();
    this.mem.set(normalizeDest(destination), { url, source: cover.source, ts: Date.now() });
    this.persist();
  }

  /**
   * 登记「旧封面已升级」：oldUrl 是被换下的旧封面地址（远程 URL 或本地资产
   * URL）。之后两个静态出口命中该地址时改发当前封面。
   * 远程 URL 统一剥掉 Commons imageinfo 的 utm 跟踪尾参后存键（存量卡片烤的
   * URL 带不带 utm 都能命中）。
   */
  markSuperseded(destination: string, oldUrl: string): void {
    const url = oldUrl?.trim();
    if (!url || url.startsWith('/travel/media/assets/destcover')) return;
    this.ensureLoaded();
    this.superseded.set(stripUtm(url), normalizeDest(destination));
    this.persist();
  }

  /** 登记目的地的封面对象目录：该目录下任何文件的请求都路由到当前封面 */
  registerCoverDir(destination: string, localAssetUrl: string): void {
    const m = COVER_ASSET_DIR_RE.exec(localAssetUrl?.trim() ?? '');
    if (!m) return;
    this.ensureLoaded();
    this.coverDirs.set(m[1]!, normalizeDest(destination));
    this.persist();
  }

  /**
   * 旧封面地址 → 当前封面。命中（且当前封面与请求的不同）返回当前封面；
   * 未命中返回 null（出口按原样服务）。
   */
  resolveSuperseded(url: string): DestinationCover | null {
    const u = url?.trim();
    if (!u) return null;
    this.ensureLoaded();
    // 远程旧 URL：查升级映射（utm 尾参归一 + 原样双查，兼容新旧登记形态）
    let destKey = this.superseded.get(stripUtm(u)) ?? this.superseded.get(u);
    // 本地封面对象目录：目录级路由（目录内任何历史文件都换发当前封面）
    if (!destKey) {
      const m = COVER_ASSET_DIR_RE.exec(u);
      if (m && this.coverDirs.has(m[1]!)) destKey = this.coverDirs.get(m[1]!);
    }
    if (!destKey) return null;
    const current = this.mem.get(destKey);
    if (!current?.url || current.url === u) return null;
    return { url: current.url, source: current.source };
  }

  get stats(): { entries: number } {
    this.ensureLoaded();
    return { entries: this.mem.size };
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!fs.existsSync(this.file)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf-8')) as Partial<StoreFileV2> & Record<string, CoverRecord>;
      if (raw && (raw as StoreFileV2).version === 2) {
        for (const [key, rec] of Object.entries(raw.covers ?? {})) {
          if (rec && typeof rec.url === 'string' && rec.url) this.mem.set(key, rec);
        }
        for (const [url, dest] of Object.entries(raw.superseded ?? {})) {
          if (typeof dest === 'string' && dest) this.superseded.set(url, dest);
        }
        for (const [dir, dest] of Object.entries(raw.coverDirs ?? {})) {
          if (typeof dest === 'string' && dest) this.coverDirs.set(dir, dest);
        }
        return;
      }
      // v1 平铺形状：整体即 covers
      const flat = raw as unknown as Record<string, CoverRecord>;
      for (const [key, rec] of Object.entries(flat)) {
        if (rec && typeof rec.url === 'string' && rec.url) this.mem.set(key, rec);
      }
    } catch (err) {
      console.warn('[DestinationCoverStore] 封面缓存读取失败（忽略重建）:', err instanceof Error ? err.message : err);
    }
  }

  private persist(): void {
    const payload: StoreFileV2 = {
      version: 2,
      covers: Object.fromEntries(this.mem),
      superseded: Object.fromEntries(this.superseded),
      coverDirs: Object.fromEntries(this.coverDirs),
    };
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(payload, null, 2), 'utf-8');
    } catch (err) {
      console.warn('[DestinationCoverStore] 封面缓存写入失败:', err instanceof Error ? err.message : err);
    }
  }
}

export const destinationCoverStore = new TravelDestinationCoverStore();
