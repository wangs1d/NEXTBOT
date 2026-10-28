/**
 * Wikidata SPARQL 实时景点发现（国际目的地免 key 实时源，2026-10-27 接入）。
 *
 * 为什么是它：免 key、免费、全球覆盖，且大陆网络实测可直连（1.8s 返回巴厘岛
 * 20 条真实景点）；数据来自维基百科词条的 P31/P625 结构化标注，真实性与 OSM
 * 同源但经词条收录门槛过滤——「景点先查清当地真有什么」的免 key 主路径。
 * Overpass 在大陆网络下镜像全挂（2026-10-27 实测），本源在其之前生效。
 *
 * 质量防线：
 *   - P31 实例类白名单（tourist attraction/museum/temple/beach/park…子类闭包）
 *   - wikibase:sitelinks >= 3：过滤孤儿条目与缺标签的 Q占位项
 *   - 按 sitelinks 降序 = 词条语言版本数 = 知名度代理，热门景点排前
 *   - 缺标签（label 为 Qxxxxx）丢弃、同名去重（Wikidata 本身存在重复词条）
 *
 * 局限：只有景点/地标，无酒店餐厅（那是 Foursquare/Overpass 的活）；无评分。
 *
 * API: https://query.wikidata.org（WDQS，免费无需 key，UA 需带联系方式）
 */

import type { RawPOI } from './poi-cache-manager.js';

const WDQS_ENDPOINT = 'https://query.wikidata.org/sparql';
const WDQS_TIMEOUT_MS = 12_000;
const WDQS_ATTEMPTS = 2; // wikimedia 对大陆网络时通时断（2026-10-27 实测：上午 1.8s 通、午间超时、傍晚 2.9s 通），失败重试一次抓窗口
const WDQS_RETRY_DELAY_MS = 1_200;
const USER_AGENT = 'TravelPlanner3D/1.0 (Educational Project; contact: dev@example.com)';

/** 实例类白名单（P31/P279* 子类闭包）：只收旅游吸引物，不收居民区/基础设施 */
const ATTRACTION_CLASSES = [
  'wd:Q570116', // tourist attraction
  'wd:Q33506', // museum
  'wd:Q44539', // temple（子类含 Hindu/Buddhist temple）
  'wd:Q23413', // castle
  'wd:Q16560', // palace
  'wd:Q4989906', // monument
  'wd:Q40080', // beach
  'wd:Q34038', // waterfall
  'wd:Q22698', // park
  'wd:Q46169', // national park
  'wd:Q167346', // botanical garden
  'wd:Q43501', // zoo
  'wd:Q15327', // aquarium
  'wd:Q217599', // theme park
  'wd:Q483062', // water park
  'wd:Q839954', // archaeological site
  'wd:Q131681', // hot spring
  'wd:Q174782', // shopping mall（旅游区商业地标）
];

function buildAroundQuery(lon: number, lat: number, radiusKm: number, limit: number): string {
  const classUnion = ATTRACTION_CLASSES.map((c) => `{ ?item wdt:P31/wdt:P279* ${c} }`).join(' union ');
  return `
SELECT ?item ?itemLabel ?coord ?sitelinks WHERE {
  SERVICE wikibase:around {
    ?item wdt:P625 ?coord .
    bd:serviceParam wikibase:center "Point(${lon} ${lat})"^^geo:wktLiteral .
    bd:serviceParam wikibase:radius "${radiusKm}" .
  }
  ${classUnion}
  ?item wikibase:sitelinks ?sitelinks .
  FILTER(?sitelinks >= 3)
  SERVICE wikibase:label { bd:serviceParam wikibase:language "zh,en". }
}
ORDER BY DESC(?sitelinks)
LIMIT ${limit}`;
}

export async function searchWikidataAttractions(
  center: { latitude: number; longitude: number },
  radiusKm = 25,
  limit = 30,
): Promise<RawPOI[]> {
  const query = buildAroundQuery(center.longitude, center.latitude, radiusKm, Math.min(limit * 2, 60));
  let lastErr = '';
  for (let attempt = 1; attempt <= WDQS_ATTEMPTS; attempt++) {
    const t0 = Date.now();
    try {
      const res = await fetch(`${WDQS_ENDPOINT}?format=json&query=${encodeURIComponent(query)}`, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/sparql-results+json' },
        signal: AbortSignal.timeout(WDQS_TIMEOUT_MS),
      });
      if (!res.ok) {
        lastErr = `HTTP ${res.status}`;
        console.warn(`[Wikidata] HTTP ${res.status}（第 ${attempt} 次尝试）`);
      } else {
        const pois = parseWikidataResponse(await res.json(), limit);
        console.log(`[Wikidata] 景点搜到 ${pois.length} 个 (r=${radiusKm}km, ${Date.now() - t0}ms${attempt > 1 ? ', 重试后' : ''})`);
        return pois;
      }
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
      console.warn(`[Wikidata] 请求失败（第 ${attempt} 次）: ${lastErr}`);
    }
    if (attempt < WDQS_ATTEMPTS) await new Promise((r) => setTimeout(r, WDQS_RETRY_DELAY_MS));
  }
  console.warn(`[Wikidata] 重试 ${WDQS_ATTEMPTS} 次后仍失败: ${lastErr}`);
  return [];
}

function parseWikidataResponse(
  json: { results?: { bindings?: Array<Record<string, { value?: string }>> } },
  limit: number,
): RawPOI[] {
  const rows = json.results?.bindings ?? [];
  const pois: RawPOI[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const name = (row.itemLabel?.value ?? '').trim();
    // 缺标签条目（label 回落为 QID 形态）对行程毫无意义
    if (!name || /^Q\d+$/.test(name)) continue;
    const k = name.toLowerCase();
    if (seen.has(k)) continue; // Wikidata 存在同一景点多条目（实测 Blanco 美术馆 ×3）
    seen.add(k);
    // coord 形如 "Point(115.189 -8.409)"（WKT：经度在前）
    const m = /Point\(([-\d.]+) ([-\d.]+)\)/.exec(row.coord?.value ?? '');
    if (!m) continue;
    const lon = parseFloat(m[1]!);
    const lat = parseFloat(m[2]!);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const qid = (row.item?.value ?? '').split('/').pop() ?? name;
    pois.push({
      id: `wd-${qid}`,
      name,
      latitude: lat,
      longitude: lon,
      address: name,
      type: 'attraction',
      // 真实数据保证：Wikidata 无评分字段，留空绝不造分
      tags: ['attraction'],
      raw: { source: 'wikidata', qid, sitelinks: parseInt(row.sitelinks?.value ?? '0', 10) },
    });
    if (pois.length >= limit) break;
  }
  return pois;
}
