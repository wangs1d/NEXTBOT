/**
 * Foursquare Places API v3（国际目的地 POI 源，替代 OSM Overpass）。
 *
 * 为什么换掉 Overpass：OSM 是地图贡献数据，中国及热门旅游区脏 POI 反复踩坑
 * （居民小区挂 tourism=hotel、单位食堂挂 amenity=restaurant、纯乱码单 token 名），
 * 且镜像在大陆网络下超时/429 频发。Foursquare 是消费级场馆数据（名称/分类/评分/
 * 照片/营业时间均经平台校验），免费额度充足（每月 $200 等值），国内可直连。
 *
 * 注册: https://developer.foursquare.com → New Project → API Key
 * 文档: https://docs.foursquare.com/data-products/docs/places-api-overview
 * 环境变量: FSQ_API_KEY
 */

import type { RawPOI } from './poi-cache-manager.js';

const FSQ_API_KEY = (process.env.FSQ_API_KEY || '').trim();
const FSQ_SEARCH_BASE = 'https://api.foursquare.com/v3/places/search';
const FSQ_REQUEST_TIMEOUT_MS = 10_000;

export function isFoursquareConfigured(): boolean {
  return FSQ_API_KEY.length > 0;
}

/** Foursquare 类别 ID（官方分类树 https://docs.foursquare.com/data-products/docs/categories） */
const FSQ_CATEGORIES: Record<'attraction' | 'hotel' | 'restaurant' | 'cafe', string> = {
  // Landmarks and Outdoors（地标/公园/观景/户外）
  attraction: '16000',
  // Travel and Transportation → Hotel
  hotel: '19012',
  // Dining and Drinking → Restaurant
  restaurant: '13065',
  // Dining and Drinking → Coffee Shop（茶歇/午休条目）
  cafe: '13032',
};

interface FsqPlace {
  fsq_id: string;
  name?: string;
  geocodes?: { main?: { latitude?: number; longitude?: number } };
  location?: { formatted_address?: string; locality?: string; region?: string };
  categories?: Array<{ id: number; name: string }>;
  rating?: number; // 0~10
  photos?: Array<{ prefix?: string; suffix?: string; width?: number; height?: number }>;
  hours?: { display?: string; open_now?: boolean };
  tel?: string;
  website?: string;
  price?: number; // 1~4
  distance?: number;
}

/**
 * 搜索国际目的地 POI（景点/酒店/餐厅/咖啡厅），返回与高德链路同构的 RawPOI。
 * 失败/未配置返回空数组（由上层走知识库真实 POI 兜底，绝不合成占位）。
 */
export async function searchFoursquarePois(
  center: { latitude: number; longitude: number },
  kind: 'attraction' | 'hotel' | 'restaurant' | 'cafe',
  radius = 25_000,
  limit = 40,
): Promise<RawPOI[]> {
  if (!FSQ_API_KEY) {
    console.warn('[Foursquare] 未配置 FSQ_API_KEY，跳过国际 POI 搜索');
    return [];
  }

  const params = new URLSearchParams({
    ll: `${center.latitude},${center.longitude}`,
    radius: String(Math.min(radius, 100_000)),
    categories: FSQ_CATEGORIES[kind],
    // rating 榜首未必是旅游相关（可以是冷门高分店），相关度默认序更稳；
    // 候选池足够深由编排层优选。
    sort: 'RELEVANCE',
    limit: '50',
    fields: 'fsq_id,name,geocodes,location,categories,rating,photos,hours,tel,website,price,distance',
  });

  try {
    const res = await fetch(`${FSQ_SEARCH_BASE}?${params.toString()}`, {
      headers: {
        Authorization: FSQ_API_KEY,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(FSQ_REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[Foursquare] HTTP ${res.status} kind=${kind}`);
      return [];
    }
    const data = (await res.json()) as { results?: FsqPlace[] };
    const places = data.results ?? [];
    console.log(`[Foursquare] ${kind} 搜到 ${places.length} 个 (r=${radius}m)`);

    return places.flatMap((p): RawPOI[] => {
      const name = (p.name || '').trim();
      const lat = p.geocodes?.main?.latitude;
      const lon = p.geocodes?.main?.longitude;
      if (!name || typeof lat !== 'number' || typeof lon !== 'number') return [];
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) return [];
      // 平台评分 0~10 → 本地 0~5 口径；无评分给中性 4.0（编排层有各自回退）
      const rating = typeof p.rating === 'number' && p.rating > 0
        ? Math.round((p.rating / 2) * 10) / 10
        : 4.0;
      // 照片：真实平台照片，取 400x300 中图；无照片也照收（阶段2有补图链路）
      const images = (p.photos || [])
        .filter(ph => ph.prefix && ph.suffix)
        .slice(0, 3)
        .map(ph => `${ph.prefix}400x300${ph.suffix}`);
      return [{
        id: `fsq-${p.fsq_id}`,
        name,
        latitude: lat,
        longitude: lon,
        address: p.location?.formatted_address || [p.location?.locality, p.location?.region].filter(Boolean).join(', ') || name,
        type: kind,
        rating,
        tags: (p.categories || []).map(c => c.name).filter(Boolean),
        images,
        raw: { source: 'foursquare', tel: p.tel, website: p.website, price: p.price, hours: p.hours?.display },
      }];
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[Foursquare] 搜索失败 kind=${kind}: ${msg}`);
    return [];
  }
}
