/**
 * 天气取数（2026-11-14 起分层）：
 *   - 国内坐标：高德天气（中国气象局数据，实况 + 4 日预报）为主，逐小时降水概率/时区
 *     由 Open-Meteo 补；高德未配置/超时/海外坐标时整条链路回落 Open-Meteo。
 *   - 高德实况与手机自带天气同源，避免「手机报晴、这边报雾」「最高温差 2–3°C」。
 * @see https://open-meteo.com/
 * @see https://lbs.amap.com/api/webservice/guide/api/weatherinfo
 */

export type WeatherBrief = {
  source: "open-meteo" | "amap";
  latitude: number;
  longitude: number;
  /** 实际生效的时区：请求传 auto 时为接口按坐标推导出的 IANA 时区 */
  timezone: string;
  locationLabel: string;
  currentTempC: number;
  apparentTempC: number;
  humidityPct: number;
  windKmh: number;
  precipitationMm: number;
  weatherCode: number;
  weatherText: string;
  todayMinC: number;
  todayMaxC: number;
  /** 今天当日逐小时降水概率的最大值（不跨天，跨天的虚高会把今天报成有雨） */
  peakRainPct: number;
  /** 今天雨最集中的钟点段（概率未达标或无数据时省略） */
  rainWindow?: RainWindow;
  clothingAdvice: string;
  hourlyForecast: WeatherHourlyForecast[];
  /** 次日预报（结构化；Task 15 晚间 digest"明日预告"与次日预警检测用） */
  tomorrow?: WeatherTomorrow;
  /**
   * 多日逐日预报（2026-10-22 扩展：getBrief 支持 days 参数）。
   * index 0 = 今天，与请求的 forecast_days 对齐（1–16 天）。
   * 下游兼容：tomorrow 恒等于 daily[1]（存在时）。
   */
  daily?: WeatherDailyForecastItem[];
}

/** 单日逐日预报概要（daily 数组元素，无逐小时行——逐小时走 getMultiDayForecast） */
export type WeatherDailyForecastItem = {
  /** 形如 2026-10-22 */
  date: string;
  weatherCode: number;
  weatherText: string;
  minC: number;
  maxC: number;
  /** 当日最大降水概率（0-100） */
  rainPct: number;
};;

/** 次日预报摘要（来自 open-meteo daily 数组第 2 天） */
export type WeatherTomorrow = {
  weatherCode: number;
  weatherText: string;
  minC: number;
  maxC: number;
  /** 降水概率（0-100） */
  rainPct: number;
  /** 次日雨最集中的钟点段（未达标则省略） */
  rainWindow?: RainWindow;
};

export type WeatherHourlyForecast = {
  time: string;
  hour: string;
  temperatureC: number;
  precipitationProbabilityPct: number;
  weatherCode: number;
  weatherText: string;
};

const WMO_TEXT: Record<number, string> = {
  0: "晴",
  1: "大部晴朗",
  2: "多云",
  3: "阴",
  45: "雾",
  48: "雾凇",
  51: "小毛毛雨",
  53: "中毛毛雨",
  55: "大毛毛雨",
  56: "冻毛毛雨",
  57: "强冻毛毛雨",
  61: "小雨",
  63: "中雨",
  65: "大雨",
  66: "冻雨",
  67: "强冻雨",
  71: "小雪",
  73: "中雪",
  75: "大雪",
  77: "雪粒",
  80: "小阵雨",
  81: "阵雨",
  82: "强阵雨",
  85: "小阵雪",
  86: "阵雪",
  95: "雷暴",
  96: "雷暴伴冰雹",
  99: "强雷暴伴冰雹",
};

function wmoText(code: number): string {
  return WMO_TEXT[code] ?? `天气码 ${code}`;
}

/** 高德天气（国内官方源）的实况字段 */
type AmapLiveWeather = {
  weather?: string;
  temperature?: string;
  humidity?: string;
  windpower?: string;
  reporttime?: string;
};

/** 高德逐日预报字段（day/night 拆分，气温是字符串） */
type AmapCastWeather = {
  date?: string;
  dayweather?: string;
  nightweather?: string;
  daytemp?: string;
  nighttemp?: string;
  daytemp_float?: string;
  nighttemp_float?: string;
};

type AmapWeatherPayload = {
  status?: string;
  lives?: AmapLiveWeather[];
  forecasts?: Array<{ casts?: AmapCastWeather[] }>;
};

/**
 * 高德天气文本 → WMO 天气码（只用于穿衣/预警等既有逻辑，不让下游认中文）。
 * 顺序即优先级：雷 > 暴雨 > 中雨 > 冻雨/雨夹雪 > 大雪 > 中雪 > 小雪/阵雪 >
 * 阵雨 > 雨 > 雪 > 雾霾沙尘 > 阴 > 多云 > 晴。
 */
const AMAP_TEXT_CODE_RULES: ReadonlyArray<{ re: RegExp; code: number }> = [
  { re: /雷/, code: 95 },
  { re: /暴雨|大雨/, code: 65 },
  { re: /中雨/, code: 63 },
  { re: /冻雨|雨夹雪/, code: 66 },
  { re: /暴雪|大雪/, code: 75 },
  { re: /中雪/, code: 73 },
  { re: /阵雪|小雪/, code: 71 },
  { re: /阵雨/, code: 81 },
  { re: /雨/, code: 61 },
  { re: /雪/, code: 71 },
  { re: /雾|霾|浮尘|扬沙|沙尘/, code: 45 },
  { re: /阴/, code: 3 },
  { re: /多云/, code: 2 },
  { re: /晴/, code: 0 },
];

function amapTextToWeatherCode(...texts: Array<string | undefined>): number | null {
  const joined = texts
    .map((t) => (t ?? "").trim())
    .filter(Boolean)
    .join(" ");
  if (!joined) return null;
  for (const rule of AMAP_TEXT_CODE_RULES) {
    if (rule.re.test(joined)) return rule.code;
  }
  return null;
}

/** 「多云」+「小雨」→「多云转小雨」；相同或缺失时退化成单个现象 */
function combineAmapWeatherText(day?: string, night?: string): string {
  const d = (day ?? "").trim();
  const n = (night ?? "").trim();
  if (!d) return n;
  if (!n || n === d) return d;
  return `${d}转${n}`;
}

/** 高德返回值里空字段常是 [] 或对象，统一取字符串 */
function pickAmapString(value: unknown): string {
  let v = value;
  if (Array.isArray(v)) v = v[0];
  if (v == null || typeof v === "object") return "";
  return String(v).trim();
}

function amapNumber(...values: Array<string | undefined>): number | null {
  for (const value of values) {
    const text = (value ?? "").trim();
    // 空串不能当 0：高德缺字段时返回 "" / []，Number("") === 0 会把「没数据」写成 0°C
    if (!text) continue;
    const n = Number(text);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/** 高德天气只覆盖国内；海外坐标直接走 Open-Meteo */
function isInsideChinaBounds(latitude: number, longitude: number): boolean {
  return longitude >= 72.004 && longitude <= 137.8347 && latitude >= 0.8293 && latitude <= 55.8271;
}

/** 降水集中时段：雨最集中的钟点段，只有整天概率时用户无法决定几点出门 */
export type RainWindow = {
  /** 峰值所在时段名，如「上午」（跨度跨段时看 label） */
  period: string;
  /** 起始小时（含，0-23） */
  startHour: number;
  /** 结束小时（不含，1-24） */
  endHour: number;
  peakPct: number;
  /** 展示串：单段如「上午 9–12 点」，跨段如「早上到下午 6–15 点」 */
  label: string;
  /** true = 当日这段雨已经过去（今天下过了，不是还要下） */
  alreadyPassed: boolean;
};

const RAIN_PERIODS: { name: string; from: number; to: number }[] = [
  { name: "凌晨", from: 0, to: 6 },
  { name: "早上", from: 6, to: 9 },
  { name: "上午", from: 9, to: 12 },
  { name: "中午", from: 12, to: 14 },
  { name: "下午", from: 14, to: 18 },
  { name: "晚上", from: 18, to: 22 },
  { name: "深夜", from: 22, to: 24 },
];

function rainPeriodOf(hour: number): string {
  const hit = RAIN_PERIODS.find((p) => hour >= p.from && hour < p.to);
  return hit?.name ?? "白天";
}

/** 当日逐小时降水概率达标（≥thresholdPct）的小时 */
export function qualifyingRainHours(
  probs: (number | null | undefined)[],
  thresholdPct = 40,
): number[] {
  const hours: number[] = [];
  for (let h = 0; h < 24; h++) {
    const p = probs[h];
    if (p != null && Number(p) >= thresholdPct) hours.push(h);
  }
  return hours;
}

/**
 * 从当日 24 个逐小时降水概率里取「雨最集中的那一段」。
 * 达标线 40% 与穿衣建议的 rainy 判定同源；不到 40% 不编时段（低概率不值得承诺钟点）。
 * nowHourOfDay（今天）只看还没到的钟点；全过了则标 alreadyPassed，避免下完雨还催带伞。
 */
export function extractRainWindow(input: {
  probsByHour: (number | null | undefined)[];
  nowHourOfDay?: number | null;
  thresholdPct?: number;
}): RainWindow | null {
  const threshold = input.thresholdPct ?? 40;
  const all = qualifyingRainHours(input.probsByHour, threshold);
  if (all.length === 0) return null;

  let hours = all;
  let alreadyPassed = false;
  if (typeof input.nowHourOfDay === "number") {
    const upcoming = all.filter((h) => h >= input.nowHourOfDay!);
    if (upcoming.length > 0) hours = upcoming;
    else {
      hours = all;
      alreadyPassed = true;
    }
  }

  // 连续成段，取峰值最高的那一段（同分取更早，出门决策更关心第一场的雨）
  const runs: number[][] = [];
  for (const h of hours) {
    const last = runs[runs.length - 1];
    if (last && h === last[last.length - 1] + 1) last.push(h);
    else runs.push([h]);
  }
  let best = runs[0];
  let bestPeak = -1;
  let bestPeakHour = runs[0][0];
  for (const run of runs) {
    for (const h of run) {
      const p = Number(input.probsByHour[h] ?? 0);
      if (p > bestPeak) {
        bestPeak = p;
        bestPeakHour = h;
        best = run;
      }
    }
  }

  const startHour = best[0];
  const endHour = best[best.length - 1] + 1;
  const period = rainPeriodOf(bestPeakHour);
  // 时段名跟跨度走：只贴峰值那一段的名字会藏掉雨的收尾时间
  const startPeriod = rainPeriodOf(startHour);
  const endPeriod = rainPeriodOf(endHour - 1);
  const periodText = startPeriod === endPeriod ? startPeriod : `${startPeriod}到${endPeriod}`;
  const rangeText = `${startHour}–${endHour} 点`;
  return {
    period,
    startHour,
    endHour,
    peakPct: bestPeak,
    label: `${periodText} ${rangeText}`,
    alreadyPassed,
  };
}

/** 播报用后缀：无达标时段返回空串，避免低概率时硬编一个时间窗 */
export function rainWindowSuffixText(window: RainWindow | null): string {
  if (!window) return "";
  return window.alreadyPassed ? `${window.label}已下过` : `${window.label}最明显`;
}

export function buildClothingAdvice(b: {
  currentTempC: number;
  todayMinC: number;
  todayMaxC: number;
  peakRainPct: number;
  weatherCode: number;
  windKmh: number;
  /**
   * 当日降水集中时段；提供时以它决定带伞措辞与是否还该带，不提供时按 peakRainPct 判。
   */
  rainWindow?: RainWindow;
}): string {
  const t = b.currentTempC;
  const feelsCold = Math.min(b.todayMinC, t);
  const codeRainy = [61, 63, 65, 80, 81, 82, 95, 96, 99].includes(b.weatherCode);
  const rainy = b.rainWindow ? !b.rainWindow.alreadyPassed || codeRainy : b.peakRainPct >= 40 || codeRainy;
  const snowy = [71, 73, 75, 77, 85, 86].includes(b.weatherCode);

  const layers: string[] = [];
  if (feelsCold < -5) {
    layers.push("厚羽绒服或棉服");
  } else if (feelsCold < 5) {
    layers.push("羽绒服、呢大衣或厚外套");
  } else if (feelsCold < 12) {
    layers.push("夹克、风衣或针织开衫");
  } else if (feelsCold < 20) {
    layers.push("薄外套或长袖叠穿");
  } else if (t < 28) {
    layers.push("长袖单穿或薄长袖");
  } else {
    layers.push("短袖、透气衣物");
  }

  if (t >= 28) {
    layers.push("注意防暑与补水");
  }
  if (b.windKmh >= 28) {
    layers.push("风力较大，可加防风外层");
  }
  if (rainy) {
    layers.push(
      b.rainWindow && !b.rainWindow.alreadyPassed
        ? `携带雨具（${rainWindowSuffixText(b.rainWindow)}）`
        : "携带雨具（伞或雨衣）",
    );
  }
  if (snowy) {
    layers.push("防滑鞋、保暖手套与帽子");
  }
  if (b.todayMaxC - b.todayMinC >= 10) {
    layers.push("昼夜温差大，建议洋葱式穿脱");
  }

  return layers.join("；");
}

type GeocodeHit = {
  name: string;
  latitude: number;
  longitude: number;
  country?: string;
  admin1?: string;
};

export async function geocodeCity(name: string): Promise<GeocodeHit | null> {
  const trimmed = name.trim();
  if (!trimmed) return null;

  // 1) 高德 Web 服务优先（2026-11-13）：Open-Meteo 地理编码的中文检索不可靠——
  //    裸词「北海」首命中马来西亚槟城同名镇、「兴义市」直接查空；且 geocoding-api
  //    域名国内网络不稳（实测 fetch failed）。高德对中文城市名一次命中，且 key 已配
  //    （AMAP_WEB_KEY，与 geo-tools 同源）。坐标为 GCJ-02，城市级天气对几百米偏差
  //    不敏感，不再做 WGS-84 换算。
  const amapKey = (process.env.AMAP_WEB_KEY ?? "").trim();
  if (amapKey) {
    try {
      const url = `https://restapi.amap.com/v3/geocode/geo?key=${encodeURIComponent(
        amapKey,
      )}&address=${encodeURIComponent(trimmed)}`;
      const res = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) {
        const data = (await res.json()) as {
          status?: string;
          geocodes?: Array<{
            formatted_address?: string;
            country?: string;
            province?: string | string[];
            city?: string | string[];
            location?: string;
          }>;
        };
        const hit = data.status === "1" ? data.geocodes?.[0] : undefined;
        const [lng, lat] = (hit?.location ?? "").split(",").map(Number);
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
          const pick = (v: string | string[] | undefined): string =>
            Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
          const province = pick(hit?.province);
          const city = pick(hit?.city) || province;
          return {
            name: city || hit?.formatted_address || trimmed,
            latitude: lat,
            longitude: lng,
            country: hit?.country,
            admin1: province,
          };
        }
      }
    } catch {
      // 高德失败（网络/超时/额度）→ 继续走 Open-Meteo 兜底，不直接判死。
    }
  }

  // 2) Open-Meteo 兜底（未配置 AMAP_WEB_KEY 或高德失败时仍可用）
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(
    trimmed,
  )}&count=1&language=zh&format=json`;
  const res = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) return null;
  const data = (await res.json()) as { results?: GeocodeHit[] };
  const hit = data.results?.[0];
  if (!hit?.latitude || !hit?.longitude) return null;
  return hit;
}

export class WeatherService {
  /**
   * 短时结果缓存（2026-11-01）：天气是慢工具（Open-Meteo 实测 5s+），而同一轮
   * 对话里「确认/追问/再问一次」以及同一城市的卡片渲染会重复打同一个请求。
   * 命中缓存直接返回，不再重复付上游延迟。默认 TTL 5 分钟（WEATHER_CACHE_TTL_MS 可调，
   * 0 关闭），key = 坐标/时区/天数/城市名。
   */
  private readonly briefCache = new Map<string, { at: number; brief: WeatherBrief }>();
  private readonly briefCacheTtlMs = (() => {
    const n = Number.parseInt(process.env.WEATHER_CACHE_TTL_MS ?? "", 10);
    return Number.isFinite(n) && n >= 0 ? n : 300_000;
  })();

  /** 坐标 → 高德行政区编码（adcode）缓存：同一位置 30 分钟内不必反复逆地理 */
  private readonly amapAdcodeCache = new Map<string, { at: number; adcode: string }>();

  private async resolveAmapAdcode(latitude: number, longitude: number): Promise<string | null> {
    const key = (process.env.AMAP_WEB_KEY ?? "").trim();
    if (!key) return null;
    const cacheKey = `${latitude.toFixed(3)},${longitude.toFixed(3)}`;
    const cached = this.amapAdcodeCache.get(cacheKey);
    if (cached && Date.now() - cached.at <= 30 * 60_000) return cached.adcode;

    const url = `https://restapi.amap.com/v3/geocode/regeo?key=${encodeURIComponent(
      key,
    )}&location=${longitude},${latitude}&extensions=base`;
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      status?: string;
      regeocode?: { addressComponent?: { adcode?: string | string[] } };
    };
    const adcode = pickAmapString(data.regeocode?.addressComponent?.adcode);
    if (data.status !== "1" || !adcode) return null;

    if (this.amapAdcodeCache.size >= 256) {
      const oldest = this.amapAdcodeCache.keys().next().value as string | undefined;
      if (oldest !== undefined) this.amapAdcodeCache.delete(oldest);
    }
    this.amapAdcodeCache.set(cacheKey, { at: Date.now(), adcode });
    return adcode;
  }

  /**
   * 高德天气：实况（extensions=base）+ 4 日预报（extensions=all）并行取。
   * 任何一步失败都返回 null，由调用方回落 Open-Meteo（不用残缺数据拼天气）。
   */
  private async fetchAmapWeather(
    latitude: number,
    longitude: number,
    options: { withLive?: boolean } = {},
  ): Promise<{ live?: AmapLiveWeather; casts: AmapCastWeather[] } | null> {
    const key = (process.env.AMAP_WEB_KEY ?? "").trim();
    if (!key || !isInsideChinaBounds(latitude, longitude)) return null;

    const adcode = await this.resolveAmapAdcode(latitude, longitude);
    if (!adcode) return null;

    const base = `https://restapi.amap.com/v3/weather/weatherInfo?key=${encodeURIComponent(
      key,
    )}&city=${encodeURIComponent(adcode)}`;
    const requestInit: RequestInit = {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
    };
    // 只需要逐日预报的场景（行程规划）不额外拉实况，省一次上游请求
    const livePromise =
      options.withLive === false
        ? Promise.resolve(null)
        : fetch(`${base}&extensions=base`, requestInit);
    const [liveRes, allRes] = await Promise.all([
      livePromise,
      fetch(`${base}&extensions=all`, requestInit),
    ]);
    const liveData = liveRes?.ok ? ((await liveRes.json()) as AmapWeatherPayload) : null;
    const allData = allRes.ok ? ((await allRes.json()) as AmapWeatherPayload) : null;

    const live = liveData?.status === "1" ? liveData.lives?.[0] : undefined;
    const casts = allData?.status === "1" ? (allData.forecasts?.[0]?.casts ?? []) : [];
    if (!live && casts.length === 0) return null;
    return { ...(live ? { live } : {}), casts };
  }

  async getBrief(
    latitude: number,
    longitude: number,
    timezone = "auto",
    locationLabel?: string,
    /** 请求天数（1–16，Open-Meteo forecast_days 免费硬上限 16）；默认 2 = 今天+明天，保持旧行为 */
    days = 2,
  ): Promise<WeatherBrief> {
    const forecastDays = Math.max(1, Math.min(Math.trunc(days) || 2, 16));
    const tzParam = (timezone || "").trim() || "auto";
    const cacheKey = `${latitude.toFixed(3)}|${longitude.toFixed(3)}|${tzParam}|${forecastDays}|${locationLabel ?? ""}`;
    if (this.briefCacheTtlMs > 0) {
      const hit = this.briefCache.get(cacheKey);
      if (hit && Date.now() - hit.at <= this.briefCacheTtlMs) {
        return structuredClone(hit.brief);
      }
    }
    const params = new URLSearchParams({
      latitude: String(latitude),
      longitude: String(longitude),
      timezone: tzParam,
      current: [
        "temperature_2m",
        "relative_humidity_2m",
        "apparent_temperature",
        "weather_code",
        "wind_speed_10m",
        "precipitation",
      ].join(","),
      hourly: ["temperature_2m", "precipitation_probability", "weather_code"].join(","),
      daily: ["weather_code", "temperature_2m_max", "temperature_2m_min", "precipitation_probability_max"].join(","),
      forecast_days: String(forecastDays),
    });
    const url = `https://api.open-meteo.com/v1/forecast?${params.toString()}`;
    // 高德与 Open-Meteo 并行：高德只做增强，失败/超时不拖慢也不阻断主链路。
    const amapPromise = this.fetchAmapWeather(latitude, longitude).catch(() => null);
    const res = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      throw new Error(`天气接口错误: ${res.status}`);
    }
    const raw = (await res.json()) as {
      timezone?: string;
      utc_offset_seconds?: number;
      current?: {
        temperature_2m?: number;
        relative_humidity_2m?: number;
        apparent_temperature?: number;
        weather_code?: number;
        wind_speed_10m?: number;
        precipitation?: number;
      };
      hourly?: {
time?: (string | null)[];
        temperature_2m?: (number | null)[];
        precipitation_probability?: (number | null)[];
        weather_code?: (number | null)[];
      };
      daily?: {
        time?: (string | null)[];
        weather_code?: (number | null)[];
        temperature_2m_max?: (number | null)[];
        temperature_2m_min?: (number | null)[];
        precipitation_probability_max?: (number | null)[];
      };
    };

    const cur = raw.current ?? {};
    const code = Number(cur.weather_code ?? 0);
    let tMax = Number(raw.daily?.temperature_2m_max?.[0] ?? cur.temperature_2m ?? 0);
    let tMin = Number(raw.daily?.temperature_2m_min?.[0] ?? cur.temperature_2m ?? 0);
    // 降水概率与时段都只取「今天」那一天：跨天取 max 会把后天的雨报成今天有雨。
    const todayKey = raw.daily?.time?.[0];
    const tomorrowKey = raw.daily?.time?.[1];
    const hourlyTimes = raw.hourly?.time ?? [];
    const hourlyProbs = raw.hourly?.precipitation_probability ?? [];
    const todayProbsByHour: (number | null)[] = Array.from({ length: 24 }, () => null);
    const tomorrowProbsByHour: (number | null)[] = Array.from({ length: 24 }, () => null);
    for (let i = 0; i < hourlyTimes.length; i++) {
      const t = hourlyTimes[i];
      const p = hourlyProbs[i];
      if (p == null || !t) continue;
      const hour = Number(t.slice(11, 13));
      if (!Number.isInteger(hour) || hour < 0 || hour > 23) continue;
      const day = t.slice(0, 10);
      if ((!todayKey || day === todayKey) && todayProbsByHour[hour] == null) todayProbsByHour[hour] = p;
      if (tomorrowKey && day === tomorrowKey && tomorrowProbsByHour[hour] == null) {
        tomorrowProbsByHour[hour] = p;
      }
    }
    const todayProbs = todayProbsByHour.filter((p): p is number => p != null);
    const peakRainPct =
      todayProbs.length > 0
        ? Math.max(...todayProbs)
        : Number(raw.daily?.precipitation_probability_max?.[0] ?? 0);

    const resolvedTimezone = raw.timezone?.trim() || tzParam;
    const utcOffsetSeconds = Number(raw.utc_offset_seconds ?? 0);
    // 该坐标的「现在」：接口返回的 time 是当地墙钟，比较已过去的钟点必须用同一个时区，
    // 用服务器本地时间会比出 8 小时偏差，把还没下的雨说成「已下过」。
    const localNow = new Date(Date.now() + utcOffsetSeconds * 1000);
    const localNowDateKey = localNow.toISOString().slice(0, 10);
    const rainWindow = extractRainWindow({
      probsByHour: todayProbsByHour,
      nowHourOfDay: todayKey === localNowDateKey ? localNow.getUTCHours() : null,
    });
    const hourlyForecast = buildHourlyForecast(raw.hourly, utcOffsetSeconds);

    // ── 高德（国内官方源）覆盖：实况现象/实况气温/今日气温/逐日预报 ──
    // 逐小时降水概率、体感、风速仍用 Open-Meteo（高德不提供这些颗粒度）；
    // 高德为空/失败时逐项保持 Open-Meteo，不拼残缺数据。
    const amap = await amapPromise;
    const amapLive = amap?.live;
    const amapCasts = amap?.casts ?? [];
    const amapLiveText = (amapLive?.weather ?? "").trim();
    const amapLiveTemp = amapNumber(amapLive?.temperature);
    const amapLiveHumidity = amapNumber(amapLive?.humidity);
    const amapTodayCast =
      amapCasts.find((c) => (c.date ?? "").trim() === (todayKey ?? "")) ?? amapCasts[0];
    const amapTodayMax = amapNumber(amapTodayCast?.daytemp_float, amapTodayCast?.daytemp);
    const amapTodayMin = amapNumber(amapTodayCast?.nighttemp_float, amapTodayCast?.nighttemp);
    const usingAmap = Boolean(amapLiveText || amapCasts.length > 0);
    if (amapTodayMax != null) tMax = amapTodayMax;
    if (amapTodayMin != null) tMin = amapTodayMin;

    const currentTempC = amapLiveTemp ?? Number(cur.temperature_2m ?? 0);
    const humidityPct = amapLiveHumidity ?? Number(cur.relative_humidity_2m ?? 0);
    const weatherCode = amapLiveText ? (amapTextToWeatherCode(amapLiveText) ?? code) : code;
    const weatherText = amapLiveText || wmoText(code);

    // 多日逐日预报（index 0 = 今天；days>1 时 daily[1] 即明天）
    const dailyDates = raw.daily?.time ?? [];
    const dailyItems: WeatherDailyForecastItem[] = [];
    for (let d = 0; d < dailyDates.length; d++) {
      const date = dailyDates[d];
      const dMax = raw.daily?.temperature_2m_max?.[d];
      const dMin = raw.daily?.temperature_2m_min?.[d];
      if (!date || dMax == null || dMin == null) continue;
      const dCode = Number(raw.daily?.weather_code?.[d] ?? 0);
      dailyItems.push({
        date,
        weatherCode: dCode,
        weatherText: wmoText(dCode),
        minC: Number(dMin),
        maxC: Number(dMax),
        rainPct: Number(raw.daily?.precipitation_probability_max?.[d] ?? 0),
      });
    }
    // 高德 4 日逐日预报覆盖同一天：现象/最高最低温以官方为准，降水概率仍取 Open-Meteo
    if (amapCasts.length > 0) {
      const byDate = new Map(dailyItems.map((item) => [item.date, item]));
      for (const cast of amapCasts) {
        const date = (cast.date ?? "").trim();
        if (!date) continue;
        const min = amapNumber(cast.nighttemp_float, cast.nighttemp);
        const max = amapNumber(cast.daytemp_float, cast.daytemp);
        if (min == null || max == null) continue;
        const text = combineAmapWeatherText(cast.dayweather, cast.nightweather);
        const castCode = amapTextToWeatherCode(cast.dayweather, cast.nightweather);
        const existing = byDate.get(date);
        if (existing) {
          existing.minC = min;
          existing.maxC = max;
          if (text) existing.weatherText = text;
          if (castCode != null) existing.weatherCode = castCode;
        } else {
          const item: WeatherDailyForecastItem = {
            date,
            weatherCode: castCode ?? 0,
            weatherText: text || wmoText(castCode ?? 0),
            minC: min,
            maxC: max,
            rainPct: 0,
          };
          dailyItems.push(item);
          byDate.set(date, item);
        }
      }
      dailyItems.sort((a, b) => a.date.localeCompare(b.date));
      const mergedToday = todayKey ? byDate.get(todayKey) : undefined;
      if (mergedToday) {
        tMin = mergedToday.minC;
        tMax = mergedToday.maxC;
      }
    }

    const brief: WeatherBrief = {
      source: usingAmap ? "amap" : "open-meteo",
      latitude,
      longitude,
      timezone: resolvedTimezone,
      // 逆地理失败时不放坐标兜底（2026-10-08 用户要求）：坐标对用户无意义还暴露隐私，
      // 没有城市名就让 summary/卡片标题直接以天气开头，不带位置前缀。
      locationLabel: locationLabel ?? "",
      currentTempC,
      apparentTempC: Number(cur.apparent_temperature ?? currentTempC),
      humidityPct,
      windKmh: Number(cur.wind_speed_10m ?? 0),
      precipitationMm: Number(cur.precipitation ?? 0),
      weatherCode,
      weatherText,
      todayMinC: tMin,
      todayMaxC: tMax,
      peakRainPct,
      ...(rainWindow ? { rainWindow } : {}),
      clothingAdvice: buildClothingAdvice({
        currentTempC,
        todayMinC: tMin,
        todayMaxC: tMax,
        peakRainPct,
        weatherCode,
        windKmh: Number(cur.wind_speed_10m ?? 0),
        ...(rainWindow ? { rainWindow } : {}),
      }),
      hourlyForecast,
    };
    if (dailyItems.length > 0) {
      brief.daily = dailyItems;
    }

    // 结构化次日预报（Task 15 晚间 digest"明日预告"与次日预警检测）——
    // 只留结构化字段，不再拼成整句文案（2026-11-26 用户定稿：服务端不出固定模板）。
    const tomorrow = dailyItems[1];
    if (tomorrow) {
      const tomorrowRainWindow = extractRainWindow({ probsByHour: tomorrowProbsByHour });
      brief.tomorrow = {
        weatherCode: tomorrow.weatherCode,
        weatherText: tomorrow.weatherText,
        minC: tomorrow.minC,
        maxC: tomorrow.maxC,
        rainPct: tomorrow.rainPct,
        ...(tomorrowRainWindow ? { rainWindow: tomorrowRainWindow } : {}),
      };
    }

    if (this.briefCacheTtlMs > 0) {
      // 缓存副本，调用方修改返回值不会污染缓存；容量封顶防长跑进程无界增长
      if (this.briefCache.size >= 64) {
        const oldestKey = this.briefCache.keys().next().value as string | undefined;
        if (oldestKey !== undefined) this.briefCache.delete(oldestKey);
      }
      this.briefCache.set(cacheKey, { at: Date.now(), brief: structuredClone(brief) });
    }
    return brief;
  }

  /**
   * 逐日预报（多日行程「每天按当天天气排程」用，2026-10-15）。
   * 传 startDate/endDate 时按行程窗口请求（Open-Meteo start_date/end_date，
   * 免费无 Key 上限 16 天外）；否则 forecast_days=N 从今天起算（上限 7）。
   */
  async getMultiDayForecast(
    latitude: number,
    longitude: number,
    days: number,
    timezone = "auto",
    startDate?: string,
  ): Promise<MultiDayForecast> {
    const n = Math.max(1, Math.min(days, 7));
    const params = new URLSearchParams({
      latitude: String(latitude),
      longitude: String(longitude),
      timezone: (timezone || "").trim() || "auto",
      hourly: ["temperature_2m", "precipitation_probability", "weather_code"].join(","),
      daily: ["weather_code", "temperature_2m_max", "temperature_2m_min", "precipitation_probability_max"].join(","),
    });
    if (startDate && /^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
      const end = new Date(new Date(`${startDate}T00:00:00Z`).getTime() + (Math.max(1, days) - 1) * 86400000)
        .toISOString()
        .split("T")[0];
      params.set("start_date", startDate);
      params.set("end_date", end ?? startDate);
    } else {
      params.set("forecast_days", String(n));
    }
    const url = `https://api.open-meteo.com/v1/forecast?${params.toString()}`;
    // 行程逐日同样以高德官方预报为准（只拉逐日，不拉实况）；失败回落 Open-Meteo。
    const amapPromise = this.fetchAmapWeather(latitude, longitude, { withLive: false }).catch(() => null);
    const res = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      throw new Error(`天气接口错误: ${res.status}`);
    }
    const raw = (await res.json()) as {
      hourly?: {
        time?: (string | null)[];
        temperature_2m?: (number | null)[];
        precipitation_probability?: (number | null)[];
        weather_code?: (number | null)[];
      };
      daily?: {
        time?: (string | null)[];
        weather_code?: (number | null)[];
        temperature_2m_max?: (number | null)[];
        temperature_2m_min?: (number | null)[];
        precipitation_probability_max?: (number | null)[];
      };
    };

    // 逐小时行按日历日分组（time 形如 "2026-10-15T09:00"）
    const byDate = new Map<string, WeatherHourlyForecast[]>();
    const times = raw.hourly?.time ?? [];
    for (let i = 0; i < times.length; i++) {
      const t = times[i];
      if (!t) continue;
      const date = t.slice(0, 10);
      const hour = t.slice(11, 16) || "";
      const temp = raw.hourly?.temperature_2m?.[i];
      if (temp == null) continue;
      const code = Number(raw.hourly?.weather_code?.[i] ?? 0);
      const prob = raw.hourly?.precipitation_probability?.[i];
      let rows = byDate.get(date);
      if (!rows) {
        rows = [];
        byDate.set(date, rows);
      }
      rows.push({
        time: t,
        hour,
        temperatureC: Number(temp),
        precipitationProbabilityPct: typeof prob === "number" ? prob : 0,
        weatherCode: code,
        weatherText: wmoText(code),
      });
    }

    const dailyDates = raw.daily?.time ?? [];
    const out: DayForecast[] = [];
    for (let d = 0; d < dailyDates.length; d++) {
      const date = dailyDates[d];
      if (!date) continue;
      const code = Number(raw.daily?.weather_code?.[d] ?? 0);
      out.push({
        date,
        weatherCode: code,
        weatherText: wmoText(code),
        minC: Number(raw.daily?.temperature_2m_min?.[d] ?? 0),
        maxC: Number(raw.daily?.temperature_2m_max?.[d] ?? 0),
        rainPct: Number(raw.daily?.precipitation_probability_max?.[d] ?? 0),
        hourly: byDate.get(date) ?? [],
      });
    }
    // 高德 4 日预报覆盖同一天的现象/气温（降水概率与逐小时仍由 Open-Meteo 提供）
    const amapCasts = (await amapPromise)?.casts ?? [];
    if (amapCasts.length > 0) {
      const byDayDate = new Map(out.map((day) => [day.date, day]));
      for (const cast of amapCasts) {
        const date = (cast.date ?? "").trim();
        if (!date) continue;
        const day = byDayDate.get(date);
        if (!day) continue;
        const min = amapNumber(cast.nighttemp_float, cast.nighttemp);
        const max = amapNumber(cast.daytemp_float, cast.daytemp);
        if (min != null) day.minC = min;
        if (max != null) day.maxC = max;
        const text = combineAmapWeatherText(cast.dayweather, cast.nightweather);
        if (text) day.weatherText = text;
        const castCode = amapTextToWeatherCode(cast.dayweather, cast.nightweather);
        if (castCode != null) day.weatherCode = castCode;
      }
    }
    return { days: out };
  }
}

/** 单日预报概要 + 当日逐小时行（供折叠为时段语境） */
export type DayForecast = {
  date: string;
  weatherCode: number;
  weatherText: string;
  minC: number;
  maxC: number;
  /** 当日最大降水概率（0-100） */
  rainPct: number;
  hourly: WeatherHourlyForecast[];
};

export type MultiDayForecast = { days: DayForecast[] };

/**
 * 恶劣天气预警检测（Task 15 生活节律：确定性规则，零 LLM）。
 * 输入当日或次日的天气要素，返回预警标签列表（空数组 = 无预警）：
 *   - 强降雨/雷暴/冻雨/大雪：WMO 天气码 + 文本兜底匹配
 *   - 高温：最高温 ≥ 35°C（高温橙色预警量级）
 *   - 严寒：最低温 ≤ -8°C（寒潮量级）
 *   - 大风：风速 ≥ 40km/h（大风蓝色预警量级）
 */
export function detectSevereWeatherAlerts(input: {
  weatherCode?: number;
  weatherText?: string;
  maxC?: number;
  minC?: number;
  rainPct?: number;
  windKmh?: number;
}): string[] {
  const alerts: string[] = [];
  const code = input.weatherCode ?? 0;
  const text = input.weatherText ?? "";

  // 强降雨（大雨/强阵雨）与暴雨（WMO 无独立暴雨码，强阵雨即暴雨量级）
  if ([65, 82].includes(code) || /大雨|暴雨|强阵雨/.test(text)) alerts.push("强降雨");
  // 雷暴（伴冰雹）
  if ([95, 96, 99].includes(code) || /雷暴/.test(text)) alerts.push("雷暴");
  // 冻雨
  if ([56, 57, 66, 67].includes(code) || /冻雨/.test(text)) alerts.push("冻雨");
  // 大雪/暴雪
  if ([75, 77].includes(code) || /大雪|暴雪/.test(text)) alerts.push("大雪");
  // 高温
  if (typeof input.maxC === "number" && input.maxC >= 35) alerts.push("高温");
  // 严寒/寒潮
  if (typeof input.minC === "number" && input.minC <= -8) alerts.push("寒潮");
  // 大风
  if (typeof input.windKmh === "number" && input.windKmh >= 40) alerts.push("大风");

  return alerts;
}

function buildHourlyForecast(
  raw: {
    time?: (string | null)[];
    temperature_2m?: (number | null)[];
    precipitation_probability?: (number | null)[];
    weather_code?: (number | null)[];
  } | undefined,
  locationUtcOffsetSeconds: number,
): WeatherHourlyForecast[] {
  const times = raw?.time ?? [];
  const temps = raw?.temperature_2m ?? [];
  if (times.length === 0 || temps.length === 0) return [];

  const now = Date.now();
  // 接口给的 time 是「那个坐标的本地时间」且不带偏移（形如 2026-10-28T09:00）。
  // 必须用响应里的 utc_offset_seconds 还原真实时刻；直接 new Date(time) 会按
  // 服务器本地时区解析，服务器跑 UTC 时逐小时面板整体错开 8 小时。
  const toInstantMs = (time: string) => {
    const withSeconds = time.length === 16 ? `${time}:00` : time;
    const asUtc = Date.parse(withSeconds.endsWith("Z") ? withSeconds : `${withSeconds}Z`);
    return asUtc - locationUtcOffsetSeconds * 1000;
  };
  let start = times.findIndex((time) => {
    if (time == null) return false;
    const instant = toInstantMs(time);
    return Number.isFinite(instant) && instant >= now;
  });
  if (start < 0) start = 0;

  const forecast: WeatherHourlyForecast[] = [];
  for (let i = start; i < times.length && forecast.length < 6; i += 3) {
    const temp = temps[i];
    if (temp == null) continue;
    const time = times[i];
    if (time == null) continue;
    const hour = time.slice(11, 13).replace(/^0/, "") || "0";
    const weatherCode = Number(raw?.weather_code?.[i] ?? 0);
    forecast.push({
      time,
      hour,
      temperatureC: Number(temp),
      precipitationProbabilityPct: Number(raw?.precipitation_probability?.[i] ?? 0),
      weatherCode,
      weatherText: wmoText(weatherCode),
    });
  }
  return forecast;
}
