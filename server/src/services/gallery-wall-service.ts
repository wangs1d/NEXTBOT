import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import type { ImageAsset, PictureKit } from "@nextbot/picture";

/**
 * 3D 照片墙「贴墙」服务（B 面数据管线）——沙龙照片墙版。
 *
 * 职责：把图库（@nextbot/picture，data/pictures）里的照片整理成
 * 3D 时间走廊的布局 JSON。挂法是「簇即墙」：一个事件簇密集铺满一面墙
 * （沙龙式密贴，按原始比例错落大小），墙与墙之间留空白 + 月份门洞过渡。
 *
 * 情绪价值三件套：
 *   - 墙主：每面墙自动选一张代表照（caption/收藏/清晰度加权，用户可覆盖）
 *     大幅带框挂视觉中心，其余小尺寸密贴环绕；
 *   - 今日之图：每天一张照片独占对墙 C 位（优先「往年同日」，确定性轮换）；
 *   - 零维护：上传即自动上墙，无需任何手动布置。
 *
 * 设计要点：布局计算纯确定性（同输入同输出，每次现算）；地点/氛围短句
 * 来自视觉分析管线（photo-analysis-service）。
 */

// ──────────────────────────── 类型（wire = /gallery-wall/layout）────────────────────────────

export interface WallPhoto {
  id: string;
  /** 中清缩略图（墙上看） */
  thumbUrl: string;
  /** 原图（点开放大用） */
  fileUrl: string;
  width: number;
  height: number;
  /** 挂墙后的画幅尺寸（米，含比例/限幅/墙主放大） */
  hangWidth: number;
  hangHeight: number;
  /** 是否本面墙的「墙主」（大幅视觉中心） */
  isOwner: boolean;
  /** 展示时间（takenAt 优先，缺省 createdAt），ISO 或 null */
  time: string | null;
  /** 视觉分析的一句氛围短句 */
  caption: string | null;
  /** 视觉分析推断的地点 */
  place: string | null;
  tags: string[];
  /** 走廊内位置 [x, y, z]，米 */
  pos: [number, number, number];
  /** 挂墙侧：1 = 走廊 +z 侧，-1 = -z 侧（3D 页据此定朝向） */
  side: 1 | -1;
}

export interface WallEvent {
  id: string;
  /** 确定性标题：「9月12日 下午 · 大理古城」（地点来自视觉分析，可缺） */
  title: string;
  start: string;
  end: string;
  place: string | null;
  photoCount: number;
  /** 墙主照片 id（自动选或用户覆盖） */
  ownerPhotoId: string;
  /** 这面墙的横向范围（米），供洗墙射灯/光晕定位 */
  wallStartX: number;
  wallEndX: number;
  /** 挂墙侧 */
  side: 1 | -1;
  photos: WallPhoto[];
}

export interface WallMark {
  /** 年月地标：「2026年9月」 */
  label: string;
  x: number;
}

/** 今日之图：独占对墙 C 位的每日一照 */
export interface TodayPhoto extends WallPhoto {
  /** 选它的理由：「一年前的今天」/「3年前的今天」/「今日之图」 */
  reason: string;
}

export interface WallLayout {
  version: 1;
  generatedAt: string;
  photoCount: number;
  events: WallEvent[];
  marks: WallMark[];
  span: { startX: number; endX: number };
  /** 今日之图（挂在最新一面墙的正对墙 C 位；库空时为 null） */
  todayPhoto: TodayPhoto | null;
  /** 待视觉分析照片数（墙页提示芯片，>0 时引导用户显式触发分析） */
  pendingAnalysis: number;
}

// ──────────────────────────── 布局常量 ────────────────────────────

/** 事件分簇阈值：间隔超过 3 小时视为不同事件 */
export const EVENT_GAP_MS = 3 * 60 * 60 * 1000;
/** 单簇上限（超长活动拆簇，避免一面墙挤 200 张） */
export const MAX_CLUSTER_SIZE = 30;
/** 密贴呼吸缝（米）：沙龙墙照片之间的间隙 */
const HANG_GAP = 0.05;
/** 墙段左右内边距（米） */
const WALL_PADDING = 0.25;
/** 墙段之间的空白（米）：门洞过渡区 */
const WALL_GAP_BASE = 4.6;
const WALL_GAP_GROWTH = 1.2;
/** 照片离走廊中线的距离＝展墙位置（米） */
const SIDE_OFFSET = 2.7;
/** 普通照片挂高中心（米）+ 沙龙式错落幅度 */
const BASE_Y = 1.62;
const SALON_JITTER = 0.15;
/** 墙主挂高（米）：视觉中心 */
const OWNER_Y = 1.6;

/** 挂墙尺寸：按原始比例错落（墙主大幅，成员小一档），统一限幅 */
function hangSize(width: number, height: number, owner: boolean): { w: number; h: number } {
  const aspect = width > 0 && height > 0 ? width / height : 1.5;
  const base = owner ? 1.42 : 0.94;
  let h = Math.min(base * (aspect < 0.9 ? 1.12 : 1), owner ? 1.62 : 1.16);
  let w = h * aspect;
  const maxW = owner ? 2.1 : 1.38;
  if (w > maxW) {
    w = maxW;
    h = w / aspect;
  }
  return { w: round2(w), h: round2(h) };
}

/** 墙主评分：caption/收藏/评分/清晰度加权 + 确定性底噪（无并列歧义） */
function ownerScore(a: ImageAsset): number {
  let s = hashUnit("owner" + a.id);
  if (a.analysis?.caption) s += 2;
  if (a.tags.includes("收藏")) s += 2.5;
  if (a.rating) s += a.rating / 50;
  s += Math.min(1.5, Math.min(a.width, a.height) / 800);
  return s;
}

/** 今日之图：优先「往年同日」（取最近一年），否则当日确定性轮换一张 */
export function pickTodayPhoto(
  assets: ImageAsset[],
  now: Date = new Date(),
): { asset: ImageAsset; reason: string } | null {
  if (assets.length === 0) return null;
  const mmdd = (ts: number): string => {
    const d = new Date(ts);
    return `${d.getMonth() + 1}-${d.getDate()}`;
  };
  const todayKey = mmdd(now.getTime());
  const thisYear = now.getFullYear();
  const sameDay = assets
    .filter((a) => {
      const ts = photoTimeMs(a);
      if (ts === null) return false;
      return mmdd(ts) === todayKey && new Date(ts).getFullYear() < thisYear;
    })
    .sort((a, b) => (photoTimeMs(b) ?? 0) - (photoTimeMs(a) ?? 0));
  const best = sameDay[0];
  if (best) {
    const years = thisYear - new Date(photoTimeMs(best)!).getFullYear();
    return { asset: best, reason: years === 1 ? "一年前的今天" : `${years}年前的今天` };
  }
  // 当日确定性轮换：按 (id + 日期串) 哈希排序取一位，每天不同、同日不变
  const dateStr = `${thisYear}-${now.getMonth() + 1}-${now.getDate()}`;
  const sorted = [...assets].sort(
    (a, b) => hashUnit(a.id + dateStr) - hashUnit(b.id + dateStr),
  );
  return { asset: sorted[Math.floor(hashUnit("today" + dateStr) * sorted.length)] ?? sorted[0]!, reason: "今日之图" };
}

// ──────────────────────────── 工具函数 ────────────────────────────

/** 字符串 → 0..1 确定性抖动（同 id 永远同位置，重启不跳） */
function hashUnit(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 1000 / 1000;
}

/** 照片时间戳：takenAt 优先，回退 createdAt；都解析不了返回 null */
export function photoTimeMs(asset: Pick<ImageAsset, "takenAt" | "createdAt">): number | null {
  for (const raw of [asset.takenAt, asset.createdAt]) {
    if (!raw) continue;
    const ts = Date.parse(raw);
    if (Number.isFinite(ts)) return ts;
  }
  return null;
}

const TIME_SEGMENT_LABELS: Array<{ from: number; to: number; label: string }> = [
  { from: 5, to: 8, label: "清晨" },
  { from: 8, to: 11, label: "上午" },
  { from: 11, to: 13, label: "中午" },
  { from: 13, to: 17, label: "下午" },
  { from: 17, to: 19, label: "傍晚" },
  { from: 19, to: 23, label: "夜间" },
  { from: 23, to: 24, label: "深夜" },
  { from: 0, to: 5, label: "深夜" },
];

function timeSegmentLabel(ts: number): string {
  const hour = new Date(ts).getHours();
  for (const seg of TIME_SEGMENT_LABELS) {
    if (hour >= seg.from && hour < seg.to) return seg.label;
  }
  return "";
}

function formatEventTitle(ts: number, place: string | null): string {
  const d = new Date(ts);
  const seg = timeSegmentLabel(ts);
  let title = `${d.getMonth() + 1}月${d.getDate()}日${seg ? ` ${seg}` : ""}`;
  if (place) title += ` · ${place}`;
  return title;
}

/**
 * 按时间分簇：间隔 > EVENT_GAP_MS 切新簇，单簇超 MAX_CLUSTER_SIZE 强制拆分。
 * 无时间戳的照片排在最后，自成一簇（标题用「未记录时间」）。
 * 供贴墙布局与 picture.memories 记忆回顾共用同一聚类口径。
 */
export function clusterAssetsByTime(assets: ImageAsset[]): ImageAsset[][] {
  const timed = assets
    .filter((a) => photoTimeMs(a) !== null)
    .sort((a, b) => (photoTimeMs(a) ?? 0) - (photoTimeMs(b) ?? 0));
  const untimed = assets.filter((a) => photoTimeMs(a) === null);

  const clusters: ImageAsset[][] = [];
  let current: ImageAsset[] = [];
  let prevTs: number | null = null;
  for (const asset of timed) {
    const ts = photoTimeMs(asset)!;
    const gapTooBig = prevTs !== null && ts - prevTs > EVENT_GAP_MS;
    if (current.length > 0 && (gapTooBig || current.length >= MAX_CLUSTER_SIZE)) {
      clusters.push(current);
      current = [];
    }
    current.push(asset);
    prevTs = ts;
  }
  if (current.length > 0) clusters.push(current);
  if (untimed.length > 0) clusters.push(untimed);
  return clusters;
}

// ──────────────────────────── 布局计算 ────────────────────────────

/**
 * 计算沙龙照片墙布局。输入图库全量资产，输出 3D 页直渲染的
 * 坐标化布局（无 LLM、确定性、幂等）。
 */
export function computeWallLayout(
  assets: ImageAsset[],
  opts: { pictureUrlPrefix?: string; ownerOverrides?: Record<string, string> } = {},
): WallLayout {
  const prefix = opts.pictureUrlPrefix ?? "";
  const overrides = opts.ownerOverrides ?? {};
  const clusters = clusterAssetsByTime(assets);
  const events: WallEvent[] = [];
  const marks: WallMark[] = [];
  const seenMonthKeys = new Set<string>();

  let cursor = 0;
  let prevEndTs: number | null = null;

  for (const cluster of clusters) {
    const startTs = photoTimeMs(cluster[0]!);
    const endTs = photoTimeMs(cluster[cluster.length - 1]!) ?? startTs;
    const place =
      cluster.map((a) => a.analysis?.place ?? null).find((p) => !!p && p.trim()) ?? null;

    if (prevEndTs !== null && startTs !== null) {
      const gapHours = Math.max(0, (startTs - prevEndTs) / 3_600_000);
      cursor += WALL_GAP_BASE + Math.min(6, WALL_GAP_GROWTH * Math.log2(1 + gapHours));
    }

    // 墙主：用户覆盖优先，否则评分选
    const eventId = `evt_${cluster[0]!.id.slice(0, 8)}`;
    const overrideId = overrides[eventId];
    const overrideAsset = overrideId ? cluster.find((a) => a.id === overrideId) : undefined;
    const owner = overrideAsset ?? [...cluster].sort((a, b) => ownerScore(b) - ownerScore(a))[0]!;

    // 密贴排布：按时间顺序，画幅边贴边（呼吸缝 0.14m）
    const hangList = cluster.map((a) => ({
      asset: a,
      isOwner: a.id === owner.id,
      ...hangSize(a.width, a.height, a.id === owner.id),
    }));
    const totalWidth =
      hangList.reduce((sum, item) => sum + item.w, 0) + HANG_GAP * (hangList.length - 1);
    const wallStartX = cursor;
    const wallEndX = cursor + totalWidth + WALL_PADDING * 2;

    // 年月地标：每个（年,月）第一次出现时落标
    if (startTs !== null) {
      const d = new Date(startTs);
      const key = `${d.getFullYear()}-${d.getMonth()}`;
      if (!seenMonthKeys.has(key)) {
        seenMonthKeys.add(key);
        marks.push({ label: `${d.getFullYear()}年${d.getMonth() + 1}月`, x: round2(wallStartX) });
      }
    }

    const side: 1 | -1 = events.length % 2 === 0 ? 1 : -1;
    let x = wallStartX + WALL_PADDING;
    const photos: WallPhoto[] = hangList.map((item) => {
      const cx = x + item.w / 2;
      x += item.w + HANG_GAP;
      const y = item.isOwner ? OWNER_Y : BASE_Y + (hashUnit("salon" + item.asset.id) - 0.5) * 2 * SALON_JITTER;
      return {
        id: item.asset.id,
        thumbUrl: `${prefix}/picture/assets/${item.asset.id}/thumbnail/medium`,
        fileUrl: `${prefix}/picture/assets/${item.asset.id}/file`,
        width: item.asset.width,
        height: item.asset.height,
        hangWidth: item.w,
        hangHeight: item.h,
        isOwner: item.isOwner,
        time: item.asset.takenAt ?? item.asset.createdAt,
        caption: item.asset.analysis?.caption ?? null,
        place: item.asset.analysis?.place ?? null,
        tags: [...item.asset.tags],
        pos: [round2(cx), round2(y), round2(side * SIDE_OFFSET)],
        side,
      };
    });

    events.push({
      id: eventId,
      title: startTs !== null ? formatEventTitle(startTs, place) : "未记录时间",
      start: startTs !== null ? new Date(startTs).toISOString() : "",
      end: endTs !== null ? new Date(endTs).toISOString() : "",
      place,
      photoCount: photos.length,
      ownerPhotoId: owner.id,
      wallStartX: round2(wallStartX),
      wallEndX: round2(wallEndX),
      side,
      photos,
    });

    cursor = wallEndX;
    prevEndTs = endTs;
  }

  // 今日之图：挂在最新一面墙的正对墙 C 位（开屏即见）
  const latest = events[events.length - 1];
  let todayPhoto: TodayPhoto | null = null;
  const pick = pickTodayPhoto(assets);
  if (pick && latest) {
    const oppositeSide: 1 | -1 = latest.side === 1 ? -1 : 1;
    const centerX = (latest.wallStartX + latest.wallEndX) / 2;
    const size = hangSize(pick.asset.width, pick.asset.height, true);
    todayPhoto = {
      id: pick.asset.id,
      thumbUrl: `${prefix}/picture/assets/${pick.asset.id}/thumbnail/medium`,
      fileUrl: `${prefix}/picture/assets/${pick.asset.id}/file`,
      width: pick.asset.width,
      height: pick.asset.height,
      hangWidth: size.w,
      hangHeight: size.h,
      isOwner: true,
      time: pick.asset.takenAt ?? pick.asset.createdAt,
      caption: pick.asset.analysis?.caption ?? null,
      place: pick.asset.analysis?.place ?? null,
      tags: [...pick.asset.tags],
      pos: [round2(centerX), 1.6, round2(oppositeSide * SIDE_OFFSET)],
      side: oppositeSide,
      reason: pick.reason,
    };
  }

  const spanEnd = events.length > 0 ? events[events.length - 1]!.wallEndX : 0;

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    photoCount: assets.length,
    events,
    marks,
    span: { startX: 0, endX: round2(spanEnd) },
    todayPhoto,
    pendingAnalysis: assets.filter((a) => !a.analysis?.analyzedAt).length,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ──────────────────────────── 服务封装（路由直接消费）────────────────────────────

/** 墙主覆盖台账：eventId → photoId（用户「设为墙主」落盘） */
interface OwnerOverrides {
  version: 1;
  map: Record<string, string>;
}

export class GalleryWallService {
  private overrides: OwnerOverrides = { version: 1, map: {} };
  private overridesLoaded = false;

  constructor(
    private readonly pictureKit: PictureKit,
    private readonly pictureRoot: string,
  ) {}

  private get overridesPath(): string {
    return `${this.pictureRoot}/wall-owners.json`;
  }

  private async loadOverrides(): Promise<Record<string, string>> {
    // 每次读盘（文件极小；保证多实例/重启后覆盖一致），读失败用内存兜底
    if (existsSync(this.overridesPath)) {
      try {
        const raw = JSON.parse(await readFile(this.overridesPath, "utf8")) as OwnerOverrides;
        if (raw.version === 1 && raw.map) this.overrides.map = raw.map;
      } catch {
        // 台账损坏 → 沿用内存
      }
    }
    return this.overrides.map;
  }

  /** 全量贴墙布局（每次现算） */
  async layout(): Promise<WallLayout> {
    const map = await this.loadOverrides();
    return computeWallLayout(this.pictureKit.store.listAll(), { ownerOverrides: map });
  }

  /**
   * 「设为墙主」：把 photoId 所在墙的墙主覆盖为它，落盘后返回 eventId。
   * 照片不存在返回 null。
   */
  async setOwnerForPhoto(photoId: string): Promise<string | null> {
    const map = await this.loadOverrides();
    const current = await this.layout();
    for (const event of current.events) {
      if (event.photos.some((p) => p.id === photoId)) {
        map[event.id] = photoId;
        const tmp = `${this.overridesPath}.tmp`;
        await writeFile(tmp, JSON.stringify({ version: 1, map } satisfies OwnerOverrides, null, 2), "utf8");
        const { rename } = await import("node:fs/promises");
        await rename(tmp, this.overridesPath);
        return event.id;
      }
    }
    return null;
  }

  get assetRoot(): string {
    return this.pictureRoot;
  }
}
