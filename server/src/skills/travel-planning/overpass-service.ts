/**
 * OSM Overpass 实时 POI 发现（国际目的地免 key 实时源，2026-10-27 复活）。
 *
 * 定位变化：2026-10-15 曾整体退役（当时是唯一国际源，脏 POI 直接糊用户脸）；
 * 现在 Foursquare 为主源（消费级数据，需 FSQ_API_KEY），本模块负责「没配 key /
 * Foursquare 空结果」时的实时发现——景点必须先查清当地真有什么，而不是落到
 * 知识库硬编码几条（2026-10-26 巴厘岛事故的用户诉求）。
 *
 * 退役原因的针对性防御（脏 POI 三板斧）：
 *   - 类目标签白名单（tourism/historic/leisure/amenity 精确枚举，不用裸关键词）
 *   - 名称可信度过滤（isPlausiblePoiName，与主服务同一份黑名单）
 *   - 无名元素丢弃、同名去重（OSM 常有 node/way 双份同名 POI）
 * 评分绝不伪造：OSM 无评分数据，rating 留空由排序层按「缺分沉底」处理。
 *
 * API: https://overpass-api.de（免费、无需 key）；镜像并行竞速，首个成功者胜出。
 */

import type { RawPOI } from './poi-cache-manager.js';
import { isPlausiblePoiName } from './poi-name-filter.js';

const OSM_OVERPASS_BASES = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.openstreetmap.fr/api/interpreter',
  'https://overpass.osm.ch/api/interpreter',
  // 2026-10-27 补充：de 的 status 端点 406、private.coffee 429、osm.jp 传输层最快——
  // 镜像可用性随时段波动，多备几个提高网络窗口期的命中概率
  'https://overpass.osm.jp/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const OVERPASS_REQUEST_TIMEOUT_MS = 20_000;
const USER_AGENT = 'TravelPlanner3D/1.0 (Educational Project)';

/**
 * 熔断：所有镜像全挂后 10 分钟内直接跳过（返回空走下一级兜底）。
 * 大陆网络对主流镜像超时频发（2026-10-27 实测全挂），不熔断会让一次规划的
 * Step 2.4 宽域重搜/茶歇池等后续调用各白等一个超时窗口。
 */
let unavailableUntil = 0;

type OverpassKind = 'attraction' | 'hotel' | 'restaurant' | 'cafe';

/**
 * 类目 → Overpass QL 主体的标签白名单。
 * 只取元素本体+中心点（way 自带 center）；历史版本带「(._; >;) out skel qt」
 * 递归子节点，响应放大几十倍曾让镜像全部 500/超时，解析端也只读 center/tags。
 */
function overpassBody(kind: OverpassKind, radius: number, lat: number, lon: number): string {
  const around = `around:${radius},${lat},${lon}`;
  const nodeWay = (filter: string) =>
    `node${filter}(${around});way${filter}(${around});`;
  switch (kind) {
    case 'attraction':
      // tourism 白名单：OSM tourism 标签庞杂（含 hotel/信息牌等），不加约束会把
      // 旅馆、观景信息牌当景点；historic 覆盖古迹类；leisure 只收公园花园。
      return [
        nodeWay('["tourism"~"^(attraction|museum|gallery|viewpoint|zoo|aquarium|theme_park|water_park)$"]'),
        nodeWay('["historic"~"^(monument|castle|ruins|archaeological_site|memorial|city_gate|citywalls|fort)$"]'),
        nodeWay('["leisure"~"^(park|garden)$"]'),
      ].join('');
    case 'hotel':
      // 全类型覆盖：只查 tourism=hotel 时民宿占比高的目的地会拿空结果
      return nodeWay('["tourism"~"^(hotel|guest_house|hostel|motel|resort)$"]');
    case 'restaurant':
      // 与 Foursquare 口径对齐（13065 Restaurant 不含咖啡店）：cafe 归茶歇池
      return nodeWay('["amenity"~"^(restaurant|fast_food|food_court)$"]');
    case 'cafe':
      return nodeWay('["amenity"~"^(cafe|coffee_shop|tea_house)$"]');
  }
}

export async function searchOverpassPois(
  center: { latitude: number; longitude: number },
  kind: OverpassKind,
  radius = 25_000,
  limit = 30,
): Promise<RawPOI[]> {
  if (Date.now() < unavailableUntil) return [];
  const query =
    `[out:json][timeout:15];(${overpassBody(kind, radius, center.latitude, center.longitude)});out body center;`;
  const elements = await overpassQuery(query);
  const pois = elements
    .map((el) => toRawPoi(el, kind))
    .filter((p): p is RawPOI => p !== null);
  if (pois.length === 0) {
    // 空结果同样熔断：OSM 数据缺失的目的地（如 osm.ch 只覆盖瑞士）重试也是空
    unavailableUntil = Date.now() + 10 * 60_000;
    return [];
  }
  // 同名去重：OSM 对同一地物常有 node + way 两份（入口点 + 轮廓），双份会占坑
  const seen = new Set<string>();
  return pois.filter((p) => {
    const k = p.name.trim().toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, limit);
}

function toRawPoi(el: Record<string, unknown>, kind: OverpassKind): RawPOI | null {
  const tags = el.tags as Record<string, string> | undefined;
  const name = tags?.name || tags?.['name:zh'] || tags?.['name:en'] || '';
  if (!name || !isPlausiblePoiName(name)) return null;
  const elCenter = el.center as { lat?: unknown; lon?: unknown } | undefined;
  const lat = typeof el.lat === 'number' ? el.lat : parseFloat(String(el.lat ?? elCenter?.lat));
  const lon = typeof el.lon === 'number' ? el.lon : parseFloat(String(el.lon ?? elCenter?.lon));
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) return null;

  let address = '';
  if (tags?.['addr:city']) address += tags['addr:city'];
  if (tags?.['addr:street']) address += (address ? ', ' : '') + tags['addr:street'];

  return {
    id: `osm-${String(el.type ?? 'n')}-${String(el.id ?? name)}`,
    name,
    latitude: lat,
    longitude: lon,
    address: address || name,
    type: kind,
    // 真实数据保证：OSM 无评分字段，留空绝不造分
    tags: Object.keys(tags || {}).slice(0, 8),
    raw: { source: 'overpass', osm: tags },
  };
}

/** Overpass 通用查询（多镜像并行竞速 + 短超时；全挂返回空由上层走下一级兜底） */
async function overpassQuery(overpassQL: string): Promise<Array<Record<string, unknown>>> {
  const tryParseElements = async (res: Response): Promise<Array<Record<string, unknown>> | null> => {
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('json')) {
      const text = await res.text();
      console.warn(`[Overpass] 非JSON响应 (${res.status})，已忽略: ${text.slice(0, 120)}`);
      return null;
    }
    const json = await res.json() as { elements?: Array<Record<string, unknown>>; remark?: string };
    if (json.remark) console.warn(`[Overpass] API备注: ${json.remark}`);
    return json.elements || [];
  };

  // 并行请求所有镜像，首个成功（HTTP 200 + JSON + 有 elements）即胜出并 abort
  // 其余在途请求——Promise.any 要等全部成员 settle 才 reject，一个挂死镜像会
  // 拖满整个超时窗口（2026-10-12 的老教训，见下方逐镜像埋点）。
  const controller = new AbortController();
  const startedAt = Date.now();
  const timer = setTimeout(() => controller.abort(), OVERPASS_REQUEST_TIMEOUT_MS);
  try {
    const attempts = OSM_OVERPASS_BASES.map(async (base) => {
      const host = new URL(base).host;
      const mirrorStartedAt = Date.now();
      try {
        const res = await fetch(base, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
          body: `data=${encodeURIComponent(overpassQL)}`,
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const elements = await tryParseElements(res);
        if (!elements || elements.length === 0) throw new Error('空结果');
        console.info(`[Overpass] 镜像胜出 ${host} ${Date.now() - mirrorStartedAt}ms elements=${elements.length}`);
        return { base, elements };
      } catch (e: unknown) {
        const ms = Date.now() - mirrorStartedAt;
        const reason = (e as Error)?.message ?? String(e);
        const hanging = ms >= OVERPASS_REQUEST_TIMEOUT_MS * 0.8;
        const line =
          `[Overpass] 镜像失败 ${host} ${ms}ms ${reason}` +
          (hanging ? ' ← 挂死型（贴满超时），对并行竞速是纯拖累，应移除' : '');
        if (hanging) console.warn(line);
        else console.info(line);
        throw e;
      }
    });

    let winner: { base: string; elements: Array<Record<string, unknown>> };
    try {
      winner = await Promise.any(attempts);
    } catch {
      console.warn(
        `[Overpass] 所有镜像均不可用（本轮 ${Date.now() - startedAt}ms / 上限 ${OVERPASS_REQUEST_TIMEOUT_MS}ms）`,
      );
      return [];
    }
    controller.abort();
    return winner.elements;
  } finally {
    clearTimeout(timer);
  }
}
