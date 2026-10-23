/**
 * POI 媒体库（单例）
 *
 * 定位：把 POI 的「图片 / 评论 / 视频」从请求路径上的实时抓取改为本地资产 + 离线回填。
 *
 * 优先级（行程装配时）：
 *   本地上传实拍(user) > 精选图库(curated) > Wikimedia 离线回填(wikimedia) > 占位图
 *
 * 存储：每个 POI 一个 JSON 元数据文件（data/travel-media/<slug>-<hash>.json），
 *       上传的图片二进制落盘 data/travel-media/assets/<slug>-<hash>/，经 HTTP 路由静态服务。
 *       内存 Map 加速，懒加载 + 写穿持久化。
 *
 * poiKey：type + 归一化名称（确定性），同一 POI 在缓存/上传/回填间靠它对齐。
 *        名称归一化忽略大小写/空白/常见中英文标点；坐标轻微漂移不影响命中。
 */
import { getDataDir } from "../../config/data-dir.js";
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import http from 'http';
import https from 'https';

import { travelPoiDb } from './travel-poi-db.js';

const IMAGE_UA = 'TravelPlanner3D/1.0 (Educational Project)';

export type PoiMediaType = 'attraction' | 'hotel' | 'restaurant';

export interface MediaImage {
  /** 原始外链：本地化后保留 —— 溯源、外链失效时回溯、代理兜底都要它。
   *  判重必须同时看 url 与 originUrl：本地化后 url 变成本机路径，
   *  而调用方下次拿到的仍是外链，只判 url 会把同一张图反复下载 + 重复登记。*/
  originUrl?: string;
  /** 内容指纹（sha256 前 16 位）；本地文件按它命名，同图不同链只存一份 */
  sha256?: string;
  /** 展示 URL（本地资源走 /travel/media/assets/...，外部为完整 URL） */
  url: string;
  /** user=用户本地上传实拍 / curated=精选图库 / wikimedia=离线回填 */
  source: 'user' | 'curated' | 'wikimedia' | 'web';
  uploader?: string;
  takenAt?: string;
  createdAt: string;
}

export interface MediaReview {
  id: string;
  author: string;
  rating: number;
  text: string;
  images?: string[];
  visitedDate?: string;
  createdAt: string;
  source: 'user' | 'imported';
}

export interface MediaVideo {
  platform: string;
  title: string;
  author: string;
  durationSeconds?: number;
  thumbnailUrl?: string;
  playPageUrl: string;
  createdAt: string;
}

export interface PoiMediaEntry {
  poiKey: string;
  type: PoiMediaType;
  name: string;
  latitude?: number;
  longitude?: number;
  images: MediaImage[];
  updatedAt: string;
}

export interface PoiMediaAggregate {
  ratingAvg: number;
  ratingCount: number;
  reviewCount: number;
  imageCount: number;
  userImageCount: number;
  videoCount: number;
}

/** 图片来源展示优先级：越大越优先 */
const SOURCE_PRIORITY: Record<MediaImage['source'], number> = { user: 3, curated: 2, web: 1, wikimedia: 1 };

/**
 * 下载出口的图片归一化（2026-10-12，为「安装包/磁盘体积」而加）。
 *
 * 问题：本地化原本**原样保存上游字节**，上游给的是原图 —— 实测 assets 存量
 * 1970 张 / 762MB，最大单张 9.3MB。这份 data/ 一旦被整目录拷进 staging
 * 就会直接变成安装包体积。
 *
 * 做法：所有落盘路径共用这一道出口，统一转码——
 *   · rotate() 先按 EXIF 摆正（不摆正 resize 会按错误方向缩放）
 *   · 限宽 1280px 不放大（行程卡与详情页最大显示宽度远小于此）
 *   · 一律重编码 JPEG q76 mozjpeg；GIF/SVG 不动（转码会毁掉动图与矢量）
 *
 * 实测收益：最大 60 份样本 137MB → 9.2MB（14.9x）。
 * sharp 取不到时原样返回——体积优化不是正确性依赖，宁可大也不丢图。
 */
const MAX_IMAGE_EDGE_PX = 1280;
const REENCODE_JPEG_QUALITY = 76;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
// sharp 的默认导出在 ESM interop 下是构造器，而 `typeof import('sharp')` 是模块
// 命名空间（两者类型不兼容），这里刻意用 any：只是内部可选依赖的调用，
// 真取不到时下面有 catch 兜底，类型精度换不来东西。
let sharpMod: any = undefined;

async function loadSharp(): Promise<any> {
  if (sharpMod !== undefined) return sharpMod;
  try {
    sharpMod = (await import('sharp')).default;
  } catch {
    sharpMod = null;
  }
  return sharpMod;
}

async function normalizeDownloadedImage(
  img: { buf: Buffer; mime: string },
): Promise<{ buf: Buffer; mime: string }> {
  if (/image\/gif|image\/svg/i.test(img.mime)) return img;
  // 已经足够小的图不再折腾：重编码未必更小，纯亏画质
  if (img.buf.length <= 120 * 1024) return img;
  const sharp = await loadSharp();
  if (!sharp) return img;
  try {
    const out = await sharp(img.buf)
      .rotate()
      .resize({ width: MAX_IMAGE_EDGE_PX, withoutEnlargement: true })
      .jpeg({ quality: REENCODE_JPEG_QUALITY, mozjpeg: true })
      .toBuffer();
    // 只有确实变小才采用重编码结果
    return out.length < img.buf.length ? { buf: out, mime: 'image/jpeg' } : img;
  } catch {
    return img; // 字节损坏/格式不认得：保留原图让上层按原逻辑处理
  }
}
const MAX_IMAGES_PER_POI = 12;

/** 名称归一化：去空白 + 常见标点，转小写 */
function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[\s·•・()（）\-—_'"「」『』【】,，。.、!！?？:：;；]/g, '')
    .trim();
}

/** poiKey：type:归一化名（确定性，供路由/存储对齐） */
export function poiKeyOf(type: PoiMediaType, name: string): string {
  return `${type}:${normalizeName(name)}`;
}

/** poiKey → 确定性文件名（slug + 8位hash，避免中文/特殊字符进路径） */
function fileNameFor(poiKey: string): string {
  const hash = crypto.createHash('sha1').update(poiKey).digest('hex').slice(0, 8);
  const slug = normalizeName(poiKey.replace(/^[a-z]+:/, '')).replace(/[^a-z0-9\u4e00-\u9fa5]/g, '').slice(0, 40) || 'poi';
  return `${slug}-${hash}`;
}

class TravelMediaStore {
  private root: string;
  private assetsRoot: string;
  private mem = new Map<string, PoiMediaEntry>();

  constructor() {
    this.root = path.join(getDataDir(), 'travel-media');
    this.assetsRoot = path.join(this.root, 'assets');
    this.ensureDir(this.root);
    this.ensureDir(this.assetsRoot);
  }

  get stats(): { entries: number } {
    return { entries: this.mem.size };
  }

  /** 读取 POI 媒体（不存在返回 null，不落盘创建） */
  get(type: PoiMediaType, name: string): PoiMediaEntry | null {
    const key = poiKeyOf(type, name);
    const hit = this.mem.get(key);
    if (hit) return hit;
    const loaded = this.loadFromStore(key);
    if (loaded) this.mem.set(key, loaded);
    return loaded;
  }

  /**
   * 只取展示 URL 列表（规划装配的热点路径；video/review 已下线，媒体只剩照片）。
   * 与 get() 的区别：get() 会把整个 entry（含元数据）读进内存缓存，
   * 装配时只需要 url 字符串。
   */
  imageUrls(type: PoiMediaType, name: string, source?: MediaImage['source']): string[] {
    const images = this.get(type, name)?.images ?? [];
    return (source ? images.filter((i) => i.source === source) : images).map((i) => i.url);
  }

  /** 聚合统计（供排序/前端徽标，无媒体时返回 null） */
  aggregate(type: PoiMediaType, name: string): PoiMediaAggregate | null {
    const entry = this.get(type, name);
    if (!entry) return null;
    const rated: Array<MediaReview & { rating: number }> = [];
    const ratingAvg = rated.length
      ? rated.reduce((s, r) => s + r.rating, 0) / rated.length
      : 0;
    return {
      ratingAvg,
      ratingCount: rated.length,
      reviewCount: 0,
      imageCount: entry.images.length,
      userImageCount: entry.images.filter((i) => i.source === 'user').length,
      videoCount: 0,
    };
  }

  /** 追加图片（URL 或 dataUrl，dataUrl 自动落盘到 assets）。返回最终图片记录。 */
  addImage(
    type: PoiMediaType,
    name: string,
    input: { url?: string; dataUrl?: string; source?: MediaImage['source']; uploader?: string; takenAt?: string },
    coords?: { latitude: number; longitude: number },
  ): { ok: boolean; image?: MediaImage; error?: string } {
    let url = input.url?.trim() || '';
    if (!url && input.dataUrl) {
      const saved = this.saveDataUrl(type, name, input.dataUrl);
      if (!saved.ok) return { ok: false, error: saved.error };
      url = saved.url!;
    }
    if (!url) return { ok: false, error: '缺少 url 或 dataUrl' };

    const entry = this.getOrCreate(type, name, coords);
    const image: MediaImage = {
      url,
      source: input.source ?? 'user',
      uploader: input.uploader,
      takenAt: input.takenAt,
      createdAt: new Date().toISOString(),
    };
    // 同 URL 去重
    if (entry.images.some((i) => i.url === url)) return { ok: true, image };
    entry.images.push(image);
    this.sortImages(entry);
    entry.images = entry.images.slice(0, MAX_IMAGES_PER_POI);
    this.persist(entry);
    return { ok: true, image };
  }

  /** 离线回填批量挂图（wikimedia 来源，低优先级） */
  attachBackfilledImages(
    type: PoiMediaType,
    name: string,
    urls: string[],
    coords?: { latitude: number; longitude: number },
  ): void {
    if (!urls.length) return;
    const entry = this.getOrCreate(type, name, coords);
    const existing = new Set(entry.images.map((i) => i.url));
    for (const url of urls) {
      if (existing.has(url)) continue;
      existing.add(url);
      entry.images.push({ url, source: 'wikimedia', createdAt: new Date().toISOString() });
    }
    this.sortImages(entry);
    entry.images = entry.images.slice(0, MAX_IMAGES_PER_POI);
    this.persist(entry);
  }

  // ======================== 内部 ========================

  private getOrCreate(type: PoiMediaType, name: string, coords?: { latitude: number; longitude: number }): PoiMediaEntry {
    const key = poiKeyOf(type, name);
    let entry: PoiMediaEntry | null | undefined = this.mem.get(key);
    if (!entry) {
      entry = this.loadFromStore(key);
    }
    if (!entry) {
      entry = {
        poiKey: key,
        type,
        name,
        latitude: coords?.latitude,
        longitude: coords?.longitude,
        images: [],
        updatedAt: new Date().toISOString(),
      };
    }
    if (coords) {
      entry.latitude = coords.latitude;
      entry.longitude = coords.longitude;
    }
    this.mem.set(key, entry);
    return entry;
  }

  /** 更新图片元数据（来源/拍摄时间/上传者）。改 source 会影响展示优先级。 */
  updateImage(
    type: PoiMediaType,
    name: string,
    url: string,
    patch: { source?: MediaImage['source']; takenAt?: string; uploader?: string },
  ): MediaImage | null {
    const entry = this.get(type, name);
    const img = entry?.images.find((i) => i.url === url);
    if (!entry || !img) return null;
    if (patch.source !== undefined) img.source = patch.source;
    if (patch.takenAt !== undefined) img.takenAt = patch.takenAt;
    if (patch.uploader !== undefined && patch.uploader.trim()) img.uploader = patch.uploader.trim().slice(0, 60);
    this.sortImages(entry);
    this.persist(entry);
    return img;
  }

  /** 删除图片（本机资产文件一并清理）。返回是否命中。 */
  removeImage(type: PoiMediaType, name: string, url: string): boolean {
    const entry = this.get(type, name);
    if (!entry) return false;
    const before = entry.images.length;
    entry.images = entry.images.filter((i) => i.url !== url);
    if (entry.images.length === before) return false;
    // 本机资产才删文件：外链条目没有对应本地文件
    if (url.startsWith('/travel/media/assets/')) {
      try {
        const rel = url.replace('/travel/media/assets/', '');
        const abs = path.join(this.assetsRoot, rel);
        // 目录穿越防护：解析后必须仍在 assets 根内
        if (abs.startsWith(this.assetsRoot) && fs.existsSync(abs)) fs.unlinkSync(abs);
      } catch { /* 删除失败不阻塞记录清理 */ }
    }
    this.persist(entry);
    return true;
  }

  /**
   * 把 `/travel/media/assets/<dir>/<file>` 解析为绝对路径，并做目录穿越防护。
   * 静态路由直接用它：拒绝任何 `..` 或解析后跳出 assets 根的请求。
   */
  resolveAssetPath(dir: string, fileName: string): string | null {
    if (!dir || !fileName) return null;
    if (dir.includes('..') || fileName.includes('..')) return null;
    if (dir.includes('/') || dir.includes('\\') || fileName.includes('/') || fileName.includes('\\')) {
      return null;
    }
    const full = path.join(this.assetsRoot, dir, fileName);
    const resolved = path.resolve(full);
    // startsWith 有前缀陷阱（/assets-evil 也会命中 /assets），补分隔符判断
    return resolved.startsWith(this.assetsRoot + path.sep) ? resolved : null;
  }

  /** 图片按来源优先级稳定排序（本地上传在前，同级按时间倒序） */
  private sortImages(entry: PoiMediaEntry): void {
    entry.images.sort((a, b) => {
      const p = SOURCE_PRIORITY[b.source] - SOURCE_PRIORITY[a.source];
      if (p !== 0) return p;
      return b.createdAt.localeCompare(a.createdAt);
    });
  }

  private saveDataUrl(type: PoiMediaType, name: string, dataUrl: string): { ok: boolean; url?: string; error?: string } {
    const m = /^data:(image\/(png|jpe?g|webp|gif));base64,(.+)$/i.exec(dataUrl.trim());
    if (!m) return { ok: false, error: 'dataUrl 需为 image/png|jpeg|webp|gif 的 base64 编码' };
    const ext = m[1]!.includes('jpeg') || m[1]!.includes('jpg') ? 'jpg' : m[1]!.toLowerCase().split('/')[1]!.replace('jpeg', 'jpg');
    let buf: Buffer;
    try {
      buf = Buffer.from(m[3]!, 'base64');
    } catch {
      return { ok: false, error: 'base64 解码失败' };
    }
    if (buf.length === 0) return { ok: false, error: '图片内容为空' };
    if (buf.length > 10 * 1024 * 1024) return { ok: false, error: '图片超过 10MB 上限' };

    const dirName = fileNameFor(poiKeyOf(type, name));
    const dir = path.join(this.assetsRoot, dirName);
    this.ensureDir(dir);
    const fileName = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
    fs.writeFileSync(path.join(dir, fileName), buf);
    return { ok: true, url: `/travel/media/assets/${dirName}/${fileName}` };
  }

  /** 内容寻址的本地化目录名（poiKey 的 sha1 前 12 位，确定性可重算） */
  private localDirFor(poiKey: string): string {
    return `poi-${crypto.createHash('sha1').update(poiKey).digest('hex').slice(0, 12)}`;
  }

  /**
   * 把一张远程图抓成本机资产并返回落盘后的展示 URL（内容寻址，sha256 去重）。
   * 已是本机路径时原样返回；下载失败返回 null（调用方保留外链）。
   */
  private async localizeOne(
    url: string,
    poiKey: string,
    timeoutMs: number,
  ): Promise<{ url: string; sha: string } | null> {
    if (!/^https?:/i.test(url)) return null;
    const dir = this.localDirFor(poiKey);
    const dirAbs = path.join(this.assetsRoot, dir);
    const downloaded = await this.downloadImage(url, timeoutMs);
    if (!downloaded) return null;
    // 内容寻址：文件名 = sha256(字节)[:16]。注意判重不能只看展示 url ——
    // 本地化后 url 是本机路径、调用方下次拿到的仍是外链，只判 url 会反复下载。
    const sha = crypto.createHash('sha256').update(downloaded.buf).digest('hex').slice(0, 16);
    const file = `${sha}.${mimeToExt(downloaded.mime)}`;
    try {
      this.ensureDir(dirAbs);
      const full = path.join(dirAbs, file);
      if (!fs.existsSync(full)) fs.writeFileSync(full, downloaded.buf);
    } catch {
      return null;
    }
    return { url: `/travel/media/assets/${dir}/${file}`, sha };
  }

  /**
   * 新增图片时**同时本地化**：抓回本机再登记，返回实际登记的展示 URL 列表。
   * 与 materializeEntryImages 的区别：那个是补历史数据（url 已是外链的存量条目）。
   *
   * 判重键必须同时含 url 与 originUrl —— 本地化后展示 url 变了，但外链还在，
   * 下次回填拿到的是外链，只判展示 url 会把同一张图重复登记。
   */
  async localizeAndAttach(
    type: PoiMediaType,
    name: string,
    urls: string[],
    coords?: { latitude: number; longitude: number },
    timeoutMs = 12_000,
  ): Promise<string[]> {
    if (!urls.length) return [];
    const entry = this.getOrCreate(type, name, coords);
    const known = new Set<string>();
    for (const i of entry.images) {
      known.add(i.url);
      if (i.originUrl) known.add(i.originUrl);
    }
    const out: string[] = [];
    for (const raw of urls) {
      if (known.has(raw)) continue;
      const local = await this.localizeOne(raw, entry.poiKey, timeoutMs);
      if (local) {
        if (known.has(local.url)) continue;
        entry.images.push({
          url: local.url,
          originUrl: raw,
          sha256: local.sha,
          source: 'web',
          createdAt: new Date().toISOString(),
        });
        known.add(local.url);
        known.add(raw);
        out.push(local.url);
      } else {
        // 下载失败（防盗链/死链）时保留外链：宁可加载失败也别把图整个丢掉
        entry.images.push({ url: raw, source: 'web', createdAt: new Date().toISOString() });
        known.add(raw);
        out.push(raw);
      }
    }
    if (out.length > 0) {
      this.sortImages(entry);
      entry.images = entry.images.slice(0, MAX_IMAGES_PER_POI);
      this.persist(entry);
    }
    return out;
  }

  /**
   * 把历史条目里仍是第三方外链的图片抓成本机资产，**原地替换** url。
   * 原地而非新增：否则同一张图会在库里留下「外链条目 + 本地条目」两份。
   * 幂等：已是本机资产的条目直接跳过，可以放心重复跑（启动时自动跑一次）。
   */
  async materializeEntryImages(
    type: PoiMediaType,
    name: string,
    timeoutMs = 12_000,
  ): Promise<{ checked: number; localized: number; failed: number }> {
    const entry = this.get(type, name);
    let checked = 0;
    let localized = 0;
    let failed = 0;
    if (!entry || entry.images.length === 0) return { checked, localized, failed };

    for (const img of entry.images) {
      if (!/^https?:/i.test(img.url)) continue; // 已是本机资产
      checked++;
      const local = await this.localizeOne(img.originUrl ?? img.url, entry.poiKey, timeoutMs);
      if (!local) {
        failed++;
        continue;
      }
      img.originUrl = img.originUrl ?? img.url;
      img.url = local.url;
      img.sha256 = local.sha;
      localized++;
    }

    if (localized > 0) {
      this.sortImages(entry);
      this.persist(entry);
    }
    return { checked, localized, failed };
  }

  /**
   * 远程图片落盘 assets（2026-09-25 目的地封面专用）：抓取远程 URL 的图片字节
   * 写入本机 assets 目录，返回本地展示 URL（/travel/media/assets/...）。
   * 背景：封面/POI 图存远程 wikimedia URL 时，Flutter 客户端不走系统代理
   * 直连常被墙，海报永远停在渐变兜底。服务端代抓一次落盘，客户端走本机
   * server 秒开。失败返回 null（调用方回退远程 URL 或渐变兜底）。
   *
   * 2026-09-28 根修：抓取走「默认出口 + IPv6 定向」双路竞速。此前单路 fetch
   * 在国内 IPv4 出口对 wikimedia 图片 CDN 全部 connect timeout（API 通道
   * wikimediaJson 早已是双路，字节通道漏配），落盘从未成功过，所有封面/条目图
   * 都以远程 URL 下发 → 客户端一律加载失败 → 海报永远是渐变兜底。
   */
  async saveRemoteAsset(dirKey: string, remoteUrl: string, timeoutMs = 20_000): Promise<string | null> {
    if (!remoteUrl || !/^https?:\/\//i.test(remoteUrl)) return null;
    const downloaded = await this.downloadImage(remoteUrl, timeoutMs);
    if (!downloaded) return null;
    const ext = mimeToExt(downloaded.mime);
    const buf = downloaded.buf;
    if (buf.length < 2048 || buf.length > 10 * 1024 * 1024) return null;
    const dirName = fileNameFor(dirKey);
    const dir = path.join(this.assetsRoot, dirName);
    this.ensureDir(dir);
    const fileName = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
    fs.writeFileSync(path.join(dir, fileName), buf);
    return `/travel/media/assets/${dirName}/${fileName}`;
  }

  /**
   * 远程图磁盘缓存层（2026-09-28，存量数据兼容通道）：以 sha1(remoteUrl) 为
   * 确定性键落盘 assets/remote-cache/，命中直接回本地路径；未命中双路抓取后
   * 落盘。同 URL 并发请求只抓一次（in-flight 去重）。供 /travel/media/remote
   * 代理路由使用——历史行程/聊天快照里烤死的 wikimedia 远程 URL 由客户端
   * 重写到本机代理，无需改写任何存量 JSON。
   */
  async resolveOrFetchRemote(remoteUrl: string, timeoutMs = 20_000): Promise<{ file: string; mime: string } | null> {
    if (!remoteUrl || !/^https?:\/\//i.test(remoteUrl)) return null;
    const key = crypto.createHash('sha1').update(remoteUrl).digest('hex');
    const dir = path.join(this.assetsRoot, 'remote-cache');
    const hit = this.probeRemoteCache(dir, key);
    if (hit) return hit;
    const inflight = this.remoteFetchInFlight.get(key);
    if (inflight) return inflight;
    const task = (async (): Promise<{ file: string; mime: string } | null> => {
      const downloaded = await this.downloadImage(remoteUrl, timeoutMs);
      if (!downloaded || downloaded.buf.length < 2048 || downloaded.buf.length > 10 * 1024 * 1024) return null;
      this.ensureDir(dir);
      const file = path.join(dir, `${key}.${mimeToExt(downloaded.mime)}`);
      fs.writeFileSync(file, downloaded.buf);
      return { file, mime: downloaded.mime };
    })().finally(() => this.remoteFetchInFlight.delete(key));
    this.remoteFetchInFlight.set(key, task);
    return task;
  }

  /** 远程缓存命中探测：sha1 键 + 任意图片扩展名，命中返回绝对路径与 mime */
  private probeRemoteCache(dir: string, key: string): { file: string; mime: string } | null {
    for (const ext of ['jpg', 'png', 'webp', 'gif']) {
      const file = path.join(dir, `${key}.${ext}`);
      if (fs.existsSync(file)) {
        const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : 'image/jpeg';
        return { file, mime };
      }
    }
    return null;
  }

  private remoteFetchInFlight = new Map<string, Promise<{ file: string; mime: string } | null>>();

  /**
   * 图片字节下载：默认出口 fetch 与 IPv6 定向（node:https family=6）两路并发，
   * 任一路先拿到合法图片字节即用。与 travel-planning-service wikimediaJson
   * 同款双路结构（国内 IPv4 到 Wikimedia 常被重置/丢包，IPv6 可达；单路串行
   * 等失败会把延迟翻倍）。两路都落空返回 null，调用方按抓取失败处理。
   */
  private async downloadImage(url: string, timeoutMs: number): Promise<{ buf: Buffer; mime: string } | null> {
    const winner = await firstNonNull([
      this.downloadViaDefault(url, timeoutMs),
      this.downloadViaV6(url, timeoutMs),
    ]);
    if (!winner) return null;
    // 出口统一收口：所有落盘路径（本地化 / 存量物化 / 视频封面）共用这一道
    return normalizeDownloadedImage(winner);
  }

  /** 默认网络栈的 fetch：网络层失败或 HTTP ≥400 或非图片 MIME 返回 null */
  private async downloadViaDefault(url: string, timeoutMs: number): Promise<{ buf: Buffer; mime: string } | null> {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': IMAGE_UA },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return null;
      const mime = (res.headers.get('content-type') || '').toLowerCase();
      if (!mime.startsWith('image/')) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      return buf.length > 0 ? { buf, mime } : null;
    } catch {
      return null;
    }
  }

  /** IPv6 定向请求（family=6，跟随最多 3 跳重定向）：无 AAAA 记录或网络不通快速失败返回 null */
  private downloadViaV6(url: string, timeoutMs: number, redirectsLeft = 3): Promise<{ buf: Buffer; mime: string } | null> {
    return new Promise((resolve) => {
      let u: URL;
      try {
        u = new URL(url);
      } catch {
        return resolve(null);
      }
      const mod = u.protocol === 'http:' ? http : https;
      const req = mod.request(
        {
          host: u.hostname,
          family: 6,
          path: `${u.pathname}${u.search}`,
          method: 'GET',
          headers: { 'User-Agent': IMAGE_UA, Accept: 'image/*' },
          timeout: timeoutMs,
        },
        (res) => {
          const status = res.statusCode ?? 500;
          // 重定向逐跳跟进（仍限 family=6；目标主机无 IPv6 时本路自然落空，
          // 由默认出口路兜住——wikimedia 图片 CDN 各跳主机都有 AAAA）
          if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
            res.resume();
            if (redirectsLeft <= 0) return resolve(null);
            const next = new URL(res.headers.location, u).toString();
            return resolve(this.downloadViaV6(next, timeoutMs, redirectsLeft - 1));
          }
          if (status >= 400) {
            res.resume();
            return resolve(null);
          }
          const mime = (res.headers['content-type'] || '').toLowerCase();
          if (!mime.startsWith('image/')) {
            res.resume();
            return resolve(null);
          }
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const buf = Buffer.concat(chunks);
            resolve(buf.length > 0 ? { buf, mime } : null);
          });
          res.on('error', () => resolve(null));
        },
      );
      req.on('timeout', () => req.destroy());
      req.on('error', () => resolve(null));
      req.end();
    });
  }

  /**
   * 从 SQLite 读出 POI 媒体条目（权威源，2026-10-12 起；旧 JSON 由
   * travel-poi-db.migrateLegacyJson 一次性导入并改名 *.migrated）。
   * 结构化列只用于查询排序，图片的完整记录存在 media.payload_json 里。
   */
  private loadFromStore(poiKey: string): PoiMediaEntry | null {
    const head = travelPoiDb.getMediaPoi(poiKey);
    if (!head) return null;
    const entry: PoiMediaEntry = {
      poiKey,
      type: head.type as PoiMediaType,
      name: head.name,
      latitude: head.latitude ?? undefined,
      longitude: head.longitude ?? undefined,
      images: [],
      updatedAt: head.updated_at,
    };
    for (const row of travelPoiDb.listMedia(poiKey, 'image')) {
      try {
        entry.images.push(JSON.parse(row.payload_json) as MediaImage);
      } catch {
        /* 脏数据跳过：单条坏行不该让整个 POI 的图全丢 */
      }
    }
    return entry.images.length > 0 || head.updated_at ? entry : null;
  }

  private persist(entry: PoiMediaEntry): void {
    entry.updatedAt = new Date().toISOString();
    try {
      travelPoiDb.upsertMediaPoi({
        poiKey: entry.poiKey,
        type: entry.type,
        name: entry.name,
        latitude: entry.latitude,
        longitude: entry.longitude,
      });
      // 整表替换：media 行按 (poi_key, kind, item_id) 唯一，item_id 用 url
      for (const row of travelPoiDb.listMedia(entry.poiKey, 'image')) {
        travelPoiDb.deleteMedia(entry.poiKey, 'image', row.item_id);
      }
      for (const img of entry.images) {
        travelPoiDb.insertMedia({
          poiKey: entry.poiKey,
          kind: 'image',
          itemId: img.url,
          payload: img as unknown as Record<string, unknown>,
          createdAt: img.createdAt,
        });
      }
    } catch (err) {
      console.warn('[TravelMediaStore] 持久化失败:', err instanceof Error ? err.message : err);
    }
  }

  private ensureDir(dir: string): void {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
}

/** 任一路先拿到非空结果即胜出；全部落空返回 null（各路按契约不 reject） */
function firstNonNull<T>(ps: Array<Promise<T | null>>): Promise<T | null> {
  return new Promise((resolve) => {
    let pending = ps.length;
    let settled = false;
    for (const p of ps) {
      p.then((v) => {
        if (settled) return;
        if (v != null) {
          settled = true;
          resolve(v);
        } else if (--pending === 0) {
          settled = true;
          resolve(null);
        }
      });
    }
  });
}

/** 响应 MIME → 落盘扩展名（缺省 jpg） */
function mimeToExt(mime: string): string {
  if (mime.includes('png')) return 'png';
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('gif')) return 'gif';
  return 'jpg';
}

export const travelMediaStore = new TravelMediaStore();
