/**
 * 目的地知识库（数据外置 loader）
 *
 * 数据文件：data/travel-knowledge/*.json（可用 TRAVEL_KNOWLEDGE_DIR 覆盖目录）
 *   - coordinates.json        已知目的地坐标表 [{name, keywords, center}]
 *   - poi-db.json             目的地真实 POI 包 [{keywords, data:{attractions|hotels|restaurants}}]
 *   - destination-info.json   目的地实用信息 [{destination, aliases, visa/currency/...}]
 *   - domestic-keywords.json  中国大陆目的地关键词（国内外数据源分流用）
 *
 * 设计动机：原先这四份数据以约 550 行字面量内联在 PlanningService 中，扩充目的地
 * 需要改代码。外置后：新增/修正目的地只需改 JSON（服务重启生效），代码只保留
 * 匹配与构造逻辑；数据与代码职责分离，也为 A1 服务拆分提供独立模块。
 */
import { getDataDir } from "../../config/data-dir.js";
import fs from 'fs';
import path from 'path';
import type { Coordinates } from './types.js';
import type { RawPOI } from './poi-cache-manager.js';

/** 目的地实用信息（与 PlanningService.TravelInfo 结构一致，避免循环依赖用结构类型） */
export interface KnownTravelInfo {
  destination: string;
  /** 匹配别名（服务端读取，不在下发给前端的字段中） */
  aliases?: string[];
  intro?: string;
  packing?: string[];
  visa: { required: boolean; type: string; notes?: string };
  currency: { name: string; code: string; symbol: string; rateToCNY?: number };
  timezone: { name: string; offset: string };
  language: string[];
  voltage: string;
  socket: string;
  bestSeason: { months: string[]; description: string };
  emergency: { police?: string; ambulance?: string; touristHotline?: string; chinaEmbassy?: string };
  customs: string[];
  tips: string[];
}

interface CoordinateEntry {
  name: string;
  keywords: string[];
  center: Coordinates;
}

interface PoiDbEntry {
  keywords: string[];
  data: {
    attractions: Array<{ name: string; lat: number; lon: number; tags: string[] }>;
    hotels: Array<{ name: string; lat: number; lon: number; tags: string[] }>;
    restaurants: Array<{ name: string; lat: number; lon: number; tags: string[] }>;
  };
}

function loadJson<T>(dir: string, file: string, fallback: T): T {
  try {
    const raw = fs.readFileSync(path.join(dir, file), 'utf-8');
    const parsed = JSON.parse(raw) as T;
    if (Array.isArray(parsed)) return parsed;
    console.warn(`[KnowledgeBase] ${file} 不是数组，使用空数据`);
    return fallback;
  } catch {
    console.warn(`[KnowledgeBase] ${file} 读取失败，使用空数据（目录: ${dir}）`);
    return fallback;
  }
}

class KnowledgeBase {
  private readonly dir: string;
  private readonly coordinates: CoordinateEntry[];
  private readonly poiDb: PoiDbEntry[];
  private readonly travelInfos: KnownTravelInfo[];
  private readonly domesticKeywords: string[];

  constructor() {
    this.dir = path.resolve(
      process.env.TRAVEL_KNOWLEDGE_DIR || path.join(getDataDir(), 'travel-knowledge'),
    );
    this.coordinates = loadJson<CoordinateEntry[]>(this.dir, 'coordinates.json', []);
    this.poiDb = loadJson<PoiDbEntry[]>(this.dir, 'poi-db.json', []);
    this.travelInfos = loadJson<KnownTravelInfo[]>(this.dir, 'destination-info.json', []);
    this.domesticKeywords = loadJson<string[]>(this.dir, 'domestic-keywords.json', []);
  }

  /** 数据目录（诊断/测试用） */
  get dataDir(): string {
    return this.dir;
  }

  /**
   * 判断目的地是否为国内（中国大陆）。
   * 基于关键词表判断，决定走高德（国内）还是 OSM（国外）数据源。
   */
  isDomesticDestination(destName: string): boolean {
    const lower = destName.toLowerCase().trim();
    return this.domesticKeywords.some(
      (k) => lower.includes(k.toLowerCase()) || destName.includes(k),
    );
  }

  /**
   * 已知目的地坐标表（Nominatim 不可用时的毫秒级兜底，也用于首询提速）。
   */
  findKnownCoordinates(query: string): { name: string; center: Coordinates } | null {
    const q = query.toLowerCase().replace(/\s+/g, '');
    for (const d of this.coordinates) {
      if (d.keywords.some((k) => q.includes(k))) {
        return { name: d.name, center: d.center };
      }
    }
    return null;
  }

  /** 目的地 POI 包（真实地点名 + 近似坐标；Overpass/高德全挂时的知识库兜底） */
  findKnownPOIs(destName: string): {
    attractions: RawPOI[];
    hotels: RawPOI[];
    restaurants: RawPOI[];
  } | null {
    const q = destName.toLowerCase().replace(/\s+/g, '');
    for (const entry of this.poiDb) {
      if (entry.keywords.some((k) => q.includes(k.toLowerCase()))) {
        const makePOI = (
          item: { name: string; lat: number; lon: number; tags: string[] },
          type: string,
        ): RawPOI => ({
          id: `known-${item.name}-${Date.now()}`,
          name: item.name,
          latitude: item.lat,
          longitude: item.lon,
          address: `${destName} · ${item.tags[0] || ''}`,
          type,
          // 真实数据保证：知识库不带评分就不设评分（undefined），排序时与
          // 本地评论聚合分自然融合，绝不生成随机分数冒充真实评分
          tags: item.tags,
          raw: { source: 'known-poi-db', destination: destName },
        });

        return {
          attractions: entry.data.attractions.map((a) => makePOI(a, 'attraction')),
          hotels: entry.data.hotels.map((h) => makePOI(h, 'hotel')),
          restaurants: entry.data.restaurants.map((r) => makePOI(r, 'restaurant')),
        };
      }
    }
    return null;
  }

  /** 目的地实用信息（签证/货币/时区/贴士等），按 destination + aliases 关键词命中 */
  findKnownTravelInfo(destName: string): KnownTravelInfo | null {
    const q = destName.toLowerCase();
    for (const info of this.travelInfos) {
      const keywords = [info.destination.toLowerCase(), ...(info.aliases ?? [])];
      if (keywords.some((k) => q.includes(k))) return info;
    }
    return null;
  }
}

export const knowledgeBase = new KnowledgeBase();
