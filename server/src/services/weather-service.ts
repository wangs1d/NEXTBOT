/**
 * 使用 Open-Meteo 免费接口（无需 API Key）：预报 + 地理编码。
 * @see https://open-meteo.com/
 */

export type WeatherBrief = {
  source: "open-meteo";
  latitude: number;
  longitude: number;
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
  peakRainPct: number;
  clothingAdvice: string;
  hourlyForecast: WeatherHourlyForecast[];
  summaryLine: string;
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

export function buildClothingAdvice(b: {
  currentTempC: number;
  todayMinC: number;
  todayMaxC: number;
  peakRainPct: number;
  weatherCode: number;
  windKmh: number;
}): string {
  const t = b.currentTempC;
  const feelsCold = Math.min(b.todayMinC, t);
  const rainy = b.peakRainPct >= 40 || [61, 63, 65, 80, 81, 82, 95, 96, 99].includes(b.weatherCode);
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
    layers.push("携带雨具（伞或雨衣）");
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
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(
    name.trim(),
  )}&count=1&language=zh&format=json`;
  const res = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) return null;
  const data = (await res.json()) as { results?: GeocodeHit[] };
  const hit = data.results?.[0];
  if (!hit?.latitude || !hit?.longitude) return null;
  return hit;
}

export class WeatherService {
  async getBrief(
    latitude: number,
    longitude: number,
    timezone: string,
    locationLabel?: string,
    /** 请求天数（1–16，Open-Meteo forecast_days 免费硬上限 16）；默认 2 = 今天+明天，保持旧行为 */
    days = 2,
  ): Promise<WeatherBrief> {
    const forecastDays = Math.max(1, Math.min(Math.trunc(days) || 2, 16));
    const params = new URLSearchParams({
      latitude: String(latitude),
      longitude: String(longitude),
      timezone,
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
    const res = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      throw new Error(`天气接口错误: ${res.status}`);
    }
    const raw = (await res.json()) as {
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
    const tMax = Number(raw.daily?.temperature_2m_max?.[0] ?? cur.temperature_2m ?? 0);
    const tMin = Number(raw.daily?.temperature_2m_min?.[0] ?? cur.temperature_2m ?? 0);
    const probs = raw.hourly?.precipitation_probability?.filter((x): x is number => x != null) ?? [];
    const peakRainPct = probs.length > 0 ? Math.max(...probs) : Number(raw.daily?.precipitation_probability_max?.[0] ?? 0);

    const currentTempC = Number(cur.temperature_2m ?? 0);
const hourlyForecast = buildHourlyForecast(raw.hourly);
    const brief: WeatherBrief = {
      source: "open-meteo",
      latitude,
      longitude,
      timezone,
      // 逆地理失败时不放坐标兜底（2026-10-08 用户要求）：坐标对用户无意义还暴露隐私，
      // 没有城市名就让 summary/卡片标题直接以天气开头，不带位置前缀。
      locationLabel: locationLabel ?? "",
      currentTempC,
      apparentTempC: Number(cur.apparent_temperature ?? currentTempC),
      humidityPct: Number(cur.relative_humidity_2m ?? 0),
      windKmh: Number(cur.wind_speed_10m ?? 0),
      precipitationMm: Number(cur.precipitation ?? 0),
      weatherCode: code,
      weatherText: wmoText(code),
      todayMinC: tMin,
      todayMaxC: tMax,
      peakRainPct,
      clothingAdvice: buildClothingAdvice({
        currentTempC,
        todayMinC: tMin,
        todayMaxC: tMax,
        peakRainPct,
        weatherCode: code,
        windKmh: Number(cur.wind_speed_10m ?? 0),
      }),
      hourlyForecast,
      summaryLine: "",
    };

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
    if (dailyItems.length > 0) {
      brief.daily = dailyItems;
    }

    // 明天一句话摘要（用户常问"明天天气"）
    const tomorrow = dailyItems[1];
    let tomorrowSummary = "";
    if (tomorrow) {
      const rainInfo = tomorrow.rainPct > 0 ? `，降水概率 ${tomorrow.rainPct}%` : "";
      tomorrowSummary = ` 明日${tomorrow.weatherText}，${tomorrow.minC.toFixed(0)}–${tomorrow.maxC.toFixed(0)}°C${rainInfo}。`;
      // 结构化次日预报（Task 15 晚间 digest"明日预告"与次日预警检测）
      brief.tomorrow = {
        weatherCode: tomorrow.weatherCode,
        weatherText: tomorrow.weatherText,
        minC: tomorrow.minC,
        maxC: tomorrow.maxC,
        rainPct: tomorrow.rainPct,
      };
    }

    brief.summaryLine = `${brief.locationLabel ? `${brief.locationLabel} ` : ""}当前约 ${currentTempC.toFixed(0)}°C（体感 ${brief.apparentTempC.toFixed(0)}°C），${brief.weatherText}；今日约 ${tMin.toFixed(0)}–${tMax.toFixed(0)}°C。${tomorrowSummary}`.trim();
    return brief;
  }

  /**
   * 逐日预报（多日行程「每天按当天天气排程」用，2026-10-15）。
   * Open-Meteo 一次请求 forecast_days=N（免费无 Key，上限 7），返回逐日
   * daily 概要 + 当日逐小时行（供折叠为上午/下午/晚间三段语境）。
   */
  async getMultiDayForecast(
    latitude: number,
    longitude: number,
    days: number,
    timezone = "auto",
  ): Promise<MultiDayForecast> {
    const n = Math.max(1, Math.min(days, 7));
    const params = new URLSearchParams({
      latitude: String(latitude),
      longitude: String(longitude),
      timezone,
      hourly: ["temperature_2m", "precipitation_probability", "weather_code"].join(","),
      daily: ["weather_code", "temperature_2m_max", "temperature_2m_min", "precipitation_probability_max"].join(","),
      forecast_days: String(n),
    });
    const url = `https://api.open-meteo.com/v1/forecast?${params.toString()}`;
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

function buildHourlyForecast(raw: {
  time?: (string | null)[];
  temperature_2m?: (number | null)[];
  precipitation_probability?: (number | null)[];
  weather_code?: (number | null)[];
} | undefined): WeatherHourlyForecast[] {
  const times = raw?.time ?? [];
  const temps = raw?.temperature_2m ?? [];
  if (times.length === 0 || temps.length === 0) return [];

  const now = Date.now();
  let start = times.findIndex((time) => time != null && new Date(time).getTime() >= now);
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
