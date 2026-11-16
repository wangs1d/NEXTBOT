/**
 * 经纬度 → 中文地址（国内优先 BigDataCloud；可选高德 AMAP_WEB_KEY）。
 * 不使用 IP 地理库。
 */

export type ReverseGeocodeHit = {
  city: string;
  /** 区/县，如「红花岗区」 */
  district: string;
  region: string;
  country: string;
  timezone: string;
  label: string;
  source: string;
  // ─── 精确位置（2026-11-14）────────────────────────────────────────
  // 只返回到 city/district 的逆地理等于「只知道在哪个市」——用户问「我在哪」
  // 时只能答到行政区，街区/小区尺度的信息全部丢失。高德 regeo（extensions=all）
  // 能给出完整门牌地址与最近 AOI/POI，这里原样保留，供 prompt/工具作答。
  /** 完整地址（高德 formatted_address，含省市区+街道+门牌） */
  address?: string;
  /** 街道/乡镇，如「下五屯街道」 */
  township?: string;
  /** 门牌所在道路（高德 streetNumber.street） */
  street?: string;
  /** 门牌号（高德 streetNumber.number） */
  streetNumber?: string;
  /** 最近地标/AOI 名称（如「九华苑」），无 AOI 时取最近 POI */
  poi?: string;
  /** 最近地标的类型（高德 type，分号分隔，如「商务住宅;住宅区;住宅小区」） */
  poiType?: string;
  /** 最近 AOI 名称（小区/园区/学校，比 POI 稳定；无 AOI 时缺省） */
  aoi?: string;
  /** 最近 AOI 类型（高德 type） */
  aoiType?: string;
  /** 最近地标距离（米） */
  poiDistanceMeters?: number;
};

const FETCH_TIMEOUT_MS = 8_000;

/**
 * 逆地理结果进程内缓存（2026-10-12 延迟优化）。
 *
 * 坐标取整到 4 位小数（≈11m）作键；地址/时区在分钟级不会变，同一位置在多轮
 * 对话里被反复反查纯属浪费——此前前端 `/geo/reverse`（每条消息一次）与每轮
 * prompt 装配各打一次外网，且两条路径都无缓存。TTL 30min、LRU 512 条封顶；
 * 只缓存成功结果（失败多为瞬态，不固化），并发同键用 in-flight 去重。
 *
 * 2026-11-14 由 3 位（≈110m）收紧到 4 位：结果里现在带门牌/小区级地址，
 * 110m 的取整会把隔壁小区的地址当成用户的——精度要求上来了，缓存键必须跟上。
 */
const GEO_CACHE_TTL_MS = 30 * 60 * 1000;
const GEO_CACHE_MAX = 512;
const geoCache = new Map<string, { at: number; hit: ReverseGeocodeHit }>();
const geoInflight = new Map<string, Promise<ReverseGeocodeHit | null>>();

function geoCacheKey(latitude: number, longitude: number): string {
  return `${latitude.toFixed(4)},${longitude.toFixed(4)}`;
}

/** 只读缓存（不触发网络）：prompt/工具补精确地址时用，拿不到就走原降级链。 */
export function peekReverseGeocodeCache(
  latitude: number,
  longitude: number,
): ReverseGeocodeHit | null {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  const cached = geoCache.get(geoCacheKey(latitude, longitude));
  if (!cached) return null;
  if (Date.now() - cached.at > GEO_CACHE_TTL_MS) return null;
  return cached.hit;
}

/** 测试钩子：清空缓存与 in-flight 表。 */
export function resetReverseGeocodeCacheForTest(): void {
  geoCache.clear();
  geoInflight.clear();
}

async function fetchJson(url: string, init?: RequestInit): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) {
      console.warn("[ReverseGeocode] HTTP 失败:", url, res.status);
      return null;
    }
    return (await res.json()) as unknown;
  } catch (error) {
    console.warn("[ReverseGeocode] 请求异常:", url, error);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** WGS-84 → GCJ-02（调用高德前需转换） */
export function wgs84ToGcj02(lat: number, lon: number): { latitude: number; longitude: number } {
  if (outOfChina(lat, lon)) return { latitude: lat, longitude: lon };
  const a = 6378245.0;
  const ee = 0.006693421622965943;
  let dLat = transformLat(lon - 105.0, lat - 35.0);
  let dLon = transformLon(lon - 105.0, lat - 35.0);
  const radLat = (lat / 180.0) * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - ee * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / (((a * (1 - ee)) / (magic * sqrtMagic)) * Math.PI);
  dLon = (dLon * 180.0) / ((a / sqrtMagic) * Math.cos(radLat) * Math.PI);
  return { latitude: lat + dLat, longitude: lon + dLon };
}

/**
 * GCJ-02 → WGS-84 近似逆变换（仅用于把高德坐标画到 WGS-84 底图上，
 * 误差米级，不用于导航计算）。取正向偏移量反推。
 */
export function gcj02ToWgs84(lat: number, lon: number): { latitude: number; longitude: number } {
  if (outOfChina(lat, lon)) return { latitude: lat, longitude: lon };
  const forward = wgs84ToGcj02(lat, lon);
  return {
    latitude: lat - (forward.latitude - lat),
    longitude: lon - (forward.longitude - lon),
  };
}

function outOfChina(lat: number, lon: number): boolean {
  return lon < 72.004 || lon > 137.8347 || lat < 0.8293 || lat > 55.8271;
}

function transformLat(x: number, y: number): number {
  let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin((y / 3.0) * Math.PI)) * 2.0) / 3.0;
  ret += ((160.0 * Math.sin((y / 12.0) * Math.PI) + 320 * Math.sin((y * Math.PI) / 30.0)) * 2.0) / 3.0;
  return ret;
}

function transformLon(x: number, y: number): number {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin((x / 3.0) * Math.PI)) * 2.0) / 3.0;
  ret += ((150.0 * Math.sin((x / 12.0) * Math.PI) + 300.0 * Math.sin((x / 30.0) * Math.PI)) * 2.0) / 3.0;
  return ret;
}

/**
 * 用 open-meteo 的 `timezone=auto` 由坐标推断时区。
 *
 * 2026-11-05 修复：失败返回**空串**，不再猜 `Asia/Shanghai`。
 * 旧实现把「外网抖动」直接变成「你在北京时间」——用户在美国、欧洲、日韩时
 * 整轮时间全错，而且错值会进 30 分钟 GEO_CACHE 反复污染。失败就该是「不知道」，
 * 由上层（设备直报时区 → 用户档案 → 服务器时区）决定用哪个，而不是在这里编。
 */
async function fetchTimezone(latitude: number, longitude: number): Promise<string> {
  const tzUrl = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m&timezone=auto&forecast_days=1`;
  const tzData = (await fetchJson(tzUrl, { headers: { Accept: "application/json" } })) as {
    timezone?: string;
  } | null;
  return tzData?.timezone?.trim() || "";
}

function buildLabel(parts: { district?: string; city?: string; region?: string; country?: string }): string {
  // 相邻去重：逆地理源经常返回 district=city=region（如「北京市 · 北京市」）
  return [parts.district, parts.city, parts.region, parts.country]
    .map((p) => (p ?? "").trim())
    .filter((p, i, arr) => p && p !== arr[i - 1])
    .join(" · ");
}

async function reverseFromBigDataCloud(
  latitude: number,
  longitude: number,
): Promise<ReverseGeocodeHit | null> {
  const url = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${latitude}&longitude=${longitude}&localityLanguage=zh`;
  const data = (await fetchJson(url, { headers: { Accept: "application/json" } })) as Record<
    string,
    unknown
  > | null;
  if (!data) return null;

  const district = String(data.locality ?? "").trim();
  const city = String(data.city ?? "").trim();
  const region = String(data.principalSubdivision ?? "").trim();
  const country = String(data.countryName ?? "").trim();
  if (!city && !district && !region) return null;

  const timezone = await fetchTimezone(latitude, longitude);
  return {
    city,
    district,
    region,
    country,
    timezone,
    label: buildLabel({ district, city, region, country }),
    source: "bigdatacloud",
  };
}

async function reverseFromAmap(latitude: number, longitude: number): Promise<ReverseGeocodeHit | null> {
  const key = process.env.AMAP_WEB_KEY?.trim();
  if (!key) return null;

  const gcj = wgs84ToGcj02(latitude, longitude);
  // extensions=all：只有 all 才返回 pois/aois（最近地标）与完整 formatted_address；
  // base 只有省市区，用户问「我在哪」只能答到行政区。
  const url = `https://restapi.amap.com/v3/geocode/regeo?key=${encodeURIComponent(key)}&location=${gcj.longitude},${gcj.latitude}&extensions=all&output=JSON`;
  const data = (await fetchJson(url)) as {
    status?: string;
    regeocode?: {
      formatted_address?: string | string[];
      addressComponent?: Record<string, unknown>;
      pois?: Array<{ name?: string; distance?: string | number; type?: string }>;
      aois?: Array<{ name?: string; distance?: string | number; type?: string }>;
    };
  } | null;
  if (!data || data.status !== "1" || !data.regeocode) return null;

  const comp = (data.regeocode.addressComponent ?? {}) as Record<string, unknown>;
  const pick = (v: unknown): string => {
    if (Array.isArray(v)) return String(v[0] ?? "").trim();
    if (v && typeof v === "object") return "";
    return String(v ?? "").trim();
  };

  const district = pick(comp.district) || pick(comp.township);
  const city = pick(comp.city) || pick(comp.district);
  const region = pick(comp.province);
  const country = pick(comp.country) || "中国";
  if (!city && !district && !region) return null;

  const township = pick(comp.township);
  const streetNumberRaw = comp.streetNumber;
  const streetNumberObj =
    streetNumberRaw && typeof streetNumberRaw === "object"
      ? (streetNumberRaw as Record<string, unknown>)
      : {};
  const street = pick(streetNumberObj.street);
  const streetNumber = pick(streetNumberObj.number);

  // 最近地标：AOI（小区/园区/学校，位置稳定）优先，其次最近 POI（店铺/门牌点）。
  // 高德的 pois/aois 已按距离升序，取第一条即可；distance 是米。
  const nearest = (list?: Array<{ name?: string; distance?: string | number; type?: string }>) => {
    const first = list?.[0];
    const name = pick(first?.name);
    if (!name) return null;
    const distance = Number(first?.distance);
    const type = pick(first?.type);
    return {
      name,
      distanceMeters: Number.isFinite(distance) ? distance : undefined,
      type: type || undefined,
    };
  };
  const nearestAoi = nearest(data.regeocode.aois);
  const nearestPoi = nearest(data.regeocode.pois);
  const landmark = nearestAoi ?? nearestPoi;

  const timezone = await fetchTimezone(latitude, longitude);
  return {
    city,
    district,
    region,
    country,
    timezone,
    label: buildLabel({ district, city, region, country }),
    source: "amap",
    address: pick(data.regeocode.formatted_address) || undefined,
    township: township || undefined,
    street: street || undefined,
    streetNumber: streetNumber || undefined,
    poi: landmark?.name,
    poiType: landmark?.type,
    aoi: nearestAoi?.name,
    aoiType: nearestAoi?.type,
    poiDistanceMeters: landmark?.distanceMeters,
  };
}

/** 根据 GPS 经纬度反查地址（国内准确；不依赖 IP）。命中进程内缓存时零网络。 */
export async function reverseGeocodeCoordinates(
  latitude: number,
  longitude: number,
): Promise<ReverseGeocodeHit | null> {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

  const key = geoCacheKey(latitude, longitude);
  const cached = geoCache.get(key);
  if (cached && Date.now() - cached.at <= GEO_CACHE_TTL_MS) return cached.hit;

  const inflight = geoInflight.get(key);
  if (inflight) return inflight;

  const task = (async (): Promise<ReverseGeocodeHit | null> => {
    const amap = await reverseFromAmap(latitude, longitude);
    if (amap) return amap;
    return reverseFromBigDataCloud(latitude, longitude);
  })()
    .then((hit) => {
      if (hit) {
        if (geoCache.size >= GEO_CACHE_MAX) {
          const oldest = geoCache.keys().next().value;
          if (oldest !== undefined) geoCache.delete(oldest);
        }
        geoCache.set(key, { at: Date.now(), hit });
      }
      return hit;
    })
    .finally(() => {
      geoInflight.delete(key);
    });

  geoInflight.set(key, task);
  return task;
}
