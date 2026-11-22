import type { ToolRegistry } from "./tool-registry.js";
import {
  buildClothingAdvice,
  geocodeCity,
  WeatherService,
  rainWindowSuffixText,
} from "../services/weather-service.js";
import type { WeatherDailyForecastItem, WeatherTomorrow } from "../services/weather-service.js";
import { resolveUserGeo } from "../services/user-location-service.js";
import { reverseGeocodeCoordinates } from "../services/reverse-geocode-service.js";

/**
 * label 相邻去重（2026-10-08）：逆地理返回的 district/city/region 经常重复
 * （如「東城區 · 北京市 · 北京市 · 中华人民共和国」），观感差。
 */
function dedupLabel(parts: Array<string | undefined | null>): string {
  return parts
    .map((p) => (p ?? "").trim())
    .filter((p, i, arr) => p && p !== arr[i - 1])
    .join(" · ");
}

/** 位置龄期标注：仅回落到「最近已知位置」时出现，避免把旧定位当实时透出。 */
function locationAgeNote(ageMs: number | null): string {
  if (ageMs == null) return "";
  const min = Math.max(1, Math.round(ageMs / 60_000));
  return min < 60 ? `（约 ${min} 分钟前的定位）` : `（约 ${(min / 60).toFixed(1)} 小时前的定位）`;
}

/**
 * 从用户本轮原句确定性解析「问的是哪一天的天气」（2026-11-21 根治）。
 *
 * 背景：旧实现把「查哪天」交给模型填 focus/days，模型漏传或走复合路径丢参数时，
 * 回执退化成今天+明天两套，卡片取今日、正文取明日，出现同一条回复两个温度区间打架。
 * 用户原句（context.userText）才是权威意图源——服务端自己解析并覆盖模型参数，
 * 模型漏传/复合丢参数都不再能让回执退回两套。
 *
 * 只识别确定的相对日与多日需求量；识别不出返回 null，调用方退回模型参数兜底。
 * 纯函数、不读时钟（项目铁律：服务端禁 Date.now()/无参 new Date()）。
 */
export type WeatherDayIntent =
  | { kind: "single"; dayIndex: number; label: string }
  | { kind: "multi"; days: number };

export function parseWeatherDayIntent(userText: string | undefined | null): WeatherDayIntent | null {
  const t = (userText ?? "").replace(/\s+/g, "");
  if (!t) return null;
  // 单日相对词：顺序有关——先长词后短词，避免「大后天」被「后天」截走。
  if (/大后天/.test(t)) return { kind: "single", dayIndex: 3, label: "大后天" };
  if (/后天/.test(t)) return { kind: "single", dayIndex: 2, label: "后天" };
  if (/明天|明日|明早|明晚|明夜|明儿/.test(t)) return { kind: "single", dayIndex: 1, label: "明天" };
  if (/今天|今日|今晚|今早|今夜|今儿|此刻|现在|当前/.test(t)) return { kind: "single", dayIndex: 0, label: "今天" };
  // 多日需求：这周/一周/N 天预报。
  if (/这周|本周|一周|整周|整个星期|未来几天/.test(t)) return { kind: "multi", days: 7 };
  const nDays = t.match(/未来?(\d{1,2})天|(\d{1,2})天(?:预报|天气)/);
  if (nDays) {
    const n = Number(nDays[1] ?? nDays[2]);
    if (n >= 2 && n <= 16) return { kind: "multi", days: n };
  }
  return null;
}

export function registerWeatherTools(registry: ToolRegistry, weather: WeatherService): void {
  registry.register("weather.get_local", async (input, context) => {
    // 时区默认交给接口按坐标推导（auto）：服务端不用本机时区、不用出口 IP 的时区冒充
    // 用户所在时区——只有用户/客户端明确说了时区才覆盖。
    let timezone = String(input.timezone ?? "").trim() || "auto";
    let city = input.city != null ? String(input.city).trim() : "";
    let lat = input.latitude != null ? Number(input.latitude) : NaN;
    let lon = input.longitude != null ? Number(input.longitude) : NaN;
    let label = input.locationLabel != null ? String(input.locationLabel).trim() : "";
    // 位置来源可观测（2026-10-08）：定位答错的排查日志——真机测试时看这行
    // 就知道 agent 为什么答这个城市（实时GPS/兜底解析/用户显式城市）。
    let locSource = city ? "explicit-city" : "unresolved";
    /** 位置龄期（毫秒）：仅 last-known 一级有值，用于如实标注「N 分钟前的定位」 */
    let locationAgeMs: number | null = null;

    if ((!Number.isFinite(lat) || !Number.isFinite(lon)) && !city) {
      // 用户未明确城市名：天气必须取「用户真实所在地」，禁止用训练数据臆测城市。
      // 1) 优先按需实时位置：复用 LocationCoordinator 新鲜缓存（天气面板上报的定位），
      //    否则向客户端下发 agent.location_request 请求实时 GPS
      //    （仅 Agent 调用天气工具时产生一次 GPS 开销，不随每条消息携带）。
      // 2) 兜底消息自带 GPS（经逆地理得到干净 label + 时区）。
      const live = await context.requestLocation?.("weather.get_local");
      if (live && Number.isFinite(live.latitude) && Number.isFinite(live.longitude)) {
        locSource = "live-gps";
        lat = live.latitude;
        lon = live.longitude;
        if (!label) {
          label = dedupLabel([live.district, live.city, live.region, live.country]);
        }
        // 客户端按需回包是纯坐标（省一次手机↔服务端逆地理往返，GPS 秒回）：
        // label 缺失时在服务端逆地理补齐城市名，否则卡片标题会退化成「31.23, 121.47」。
        // 时区不从这里取：逆地理的时区源失败时会猜 Asia/Shanghai，而 getBrief 的
        // auto 直接由同一组坐标推导，不需要这层可能出错的猜测。
        if (!label) {
          const rev = await reverseGeocodeCoordinates(lat, lon);
          if (rev) label = rev.label;
        }
      }

      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        const geo = await resolveUserGeo({
          clientIp: context.clientIp,
          clientLocation: context.clientLocation,
        });
        if (geo?.latitude != null && geo?.longitude != null) {
          locSource = "resolved-geo";
          lat = geo.latitude;
          lon = geo.longitude;
          if (!label) label = dedupLabel([geo.district, geo.city, geo.region, geo.country]);
        } else if (geo?.city) {
          locSource = "resolved-geo-city";
          city = geo.city;
          if (!label) label = dedupLabel([geo.city, geo.region, geo.country]);
        }
      }

      // 最后一级：最近一次已知位置（内存缓存 → 本地位置历史，跨重启仍可用）。
      // 实时 GPS 拉不到不等于没有位置——旧坐标照样能出真实天气，但必须标龄期，
      // 不能把 25 分钟前的定位当实时透出。
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        const known = context.getLastKnownLocation?.();
        if (known && Number.isFinite(known.latitude) && Number.isFinite(known.longitude)) {
          locSource = "last-known";
          lat = known.latitude;
          lon = known.longitude;
          locationAgeMs = known.ageMs;
          if (!label) {
            label =
              dedupLabel([known.district, known.city, known.region, known.country]) ||
              known.label ||
              "";
          }
        }
      }
    }

    if ((!Number.isFinite(lat) || !Number.isFinite(lon)) && city) {
      const g = await geocodeCity(city);
      if (!g) {
        return { ok: false, error: `无法解析城市：${city}` };
      }
      lat = g.latitude;
      lon = g.longitude;
      label = [g.name, g.admin1, g.country].filter(Boolean).join(" · ");
    }

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return {
        ok: false,
        error:
          "没有拿到真实定位，也没有可解析的城市名。必须请用户提供城市或开启定位；禁止猜测用户所在城市或编造天气。",
      };
    }

    console.log(
      `[weather.get_local] 位置来源=${locSource} 坐标=${lat.toFixed(4)},${lon.toFixed(4)} label=${label || "-"} city=${city || "-"}`,
    );
    // 查询范围由「用户原话」决定（2026-11-21 根治，权威意图源 = context.userText）：
    // 服务端确定性解析问的是哪天，覆盖模型填的 days/focus。模型漏传、复合路径丢参数
    // 都不再能让回执退回「今天+明天」两套——那正是卡片/正文温度打架的根因。
    // 模型参数仅作兜底：原话解析不出时（如主动任务无 userText、或只说「天气」）才采用。
    const intent = parseWeatherDayIntent(context.userText);

    let days: number;
    let focusDay: "" | "tomorrow" = "";
    let singleDayIndex = -1; // 后天及更远（≥2）的单日聚焦索引；0/1 走各自已有路径
    if (intent?.kind === "single") {
      // 原话明确某一天：单日聚焦，回执只放那天的数据。
      //   今天 → days=1，summaryLine 天然只有今日段（无明日），走默认回执即可；
      //   明天 → days≥2 走 buildTomorrowFocusResult，只留明日（已上线验证，字节不动）；
      //   后天/大后天 → 走通用单日回执，只留那天（避免默认回执里今日/明日/后天三套打架）。
      days = intent.dayIndex === 0 ? 1 : Math.max(2, intent.dayIndex + 1);
      if (intent.dayIndex === 1) focusDay = "tomorrow";
      if (intent.dayIndex >= 2) singleDayIndex = intent.dayIndex;
    } else if (intent?.kind === "multi") {
      days = intent.days;
    } else {
      // 兜底：原话解析不出（主动任务无 userText / 模型自报）时也默认单日——
      // 不再默认「今天+明天」两套，彻底堵死卡片/正文各取一天打架的最后一个口子。
      // 模型显式传值仍被尊重（days=N / focus=tomorrow），但「没给范围」一律当查一次。
      const daysInput = Number(input.days);
      days = Number.isFinite(daysInput) ? Math.max(1, Math.min(Math.trunc(daysInput), 16)) : 1;
      const focusInput = String(input.focus ?? "").trim();
      if (focusInput === "today") days = 1;
      if (focusInput === "tomorrow") {
        days = Math.max(2, days);
        focusDay = "tomorrow";
      }
    }
    const brief = await weather.getBrief(lat, lon, timezone, label || undefined, days);
    const locLabel = [brief.locationLabel, locationAgeNote(locationAgeMs)]
      .filter((s): s is string => !!s && String(s).trim().length > 0)
      .join(" ");

    // 明日聚焦：回执只放明天，卡片与正文都从回执来，不可能出现两套温度。
    if (focusDay === "tomorrow" && brief.tomorrow) {
      return buildTomorrowFocusResult(brief.tomorrow, {
        locationLabel: locLabel,
        windKmh: brief.windKmh,
      });
    }
    // 后天及更远单日聚焦：只放那天，同样杜绝多套温度并存。
    if (singleDayIndex >= 2 && brief.daily?.[singleDayIndex]) {
      return buildSingleDayFocusResult(brief.daily[singleDayIndex], singleDayIndex, locLabel);
    }

    return {
      ok: true,
      summary: brief.summaryLine,
      clothingAdvice: brief.clothingAdvice,
      currentTempC: brief.currentTempC,
      apparentTempC: brief.apparentTempC,
      // 用户定稿（2026-11-04）：区间数字必须带 ° 符号（手机/电脑同一张卡）
      todayRangeC: `${brief.todayMinC.toFixed(0)}°–${brief.todayMaxC.toFixed(0)}°`,
      weatherText: brief.weatherText,
      humidityPct: brief.humidityPct,
      windKmh: brief.windKmh,
      // 今天当日的降水概率上限（不是整段预报的最大值）
      peakRainPct: brief.peakRainPct,
      // 降水集中的钟点段（卡片与正文都要带，整天概率不足以决定几点出门）
      ...(brief.rainWindow ? { todayRainPeriod: rainWindowSuffixText(brief.rainWindow) } : {}),
      // 明日降水概率：卡片分两行显示，避免「明天有雨」被读成「今天有雨」
      ...(brief.tomorrow ? { tomorrowRainPct: brief.tomorrow.rainPct } : {}),
      ...(brief.tomorrow?.rainWindow
        ? { tomorrowRainPeriod: rainWindowSuffixText(brief.tomorrow.rainWindow) }
        : {}),
      locationLabel: locLabel,
      // 多日逐日预报（index 0 = 今天；仅当请求 >2 天时携带，避免单日轮次撑大返回）
      ...(days > 2 && brief.daily && brief.daily.length > 0
        ? { dailyForecast: brief.daily.map(withDayLabel) }
        : {}),
    };
  });
}

const WEEKDAY_LABELS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/**
 * 明日聚焦回执（2026-11-05）：用户只问「明天天气」时，回执里只放明天的数据——
 * 不带当前实况/今日区间/湿度风速。正文与卡片都从回执来，今天的信息自然不会再说。
 * 字段用 tomorrow* 专属命名而非复用 today 语义字段，避免模型把明天的数读成今天的。
 */
function buildTomorrowFocusResult(
  t: WeatherTomorrow,
  ctx: { locationLabel: string; windKmh: number },
) {
  return {
    ok: true,
    focusDay: "tomorrow",
    summary: tomorrowFocusSummary(ctx.locationLabel, t),
    weatherText: t.weatherText,
    tomorrowRangeC: `${t.minC.toFixed(0)}°–${t.maxC.toFixed(0)}°`,
    ...(t.rainPct > 0 ? { tomorrowRainPct: t.rainPct } : {}),
    ...(t.rainWindow ? { tomorrowRainPeriod: rainWindowSuffixText(t.rainWindow) } : {}),
    clothingAdvice: buildClothingAdvice({
      currentTempC: (t.minC + t.maxC) / 2,
      todayMinC: t.minC,
      todayMaxC: t.maxC,
      peakRainPct: t.rainPct,
      weatherCode: t.weatherCode,
      windKmh: ctx.windKmh,
      ...(t.rainWindow ? { rainWindow: t.rainWindow } : {}),
    }),
    locationLabel: ctx.locationLabel,
  };
}

/**
 * 后天及更远单日聚焦回执（2026-11-21）：只放用户问的那一天，字段用中性 focus* 命名。
 * 卡片构建器优先认 focusRangeC/focusDayLabel，正文也只读这些字段，不会掺今日/明日。
 */
function buildSingleDayFocusResult(
  item: WeatherDailyForecastItem,
  dayIndex: number,
  locationLabel: string,
) {
  const dayLabel = withDayLabel(item, dayIndex).dayLabel;
  const rainInfo = item.rainPct > 0 ? `，降水概率 ${item.rainPct}%` : "";
  return {
    ok: true,
    focusDay: "single",
    focusDayLabel: dayLabel,
    summary: `${locationLabel ? `${locationLabel} ` : ""}${dayLabel}${item.weatherText}，${item.minC.toFixed(0)}–${item.maxC.toFixed(0)}°C${rainInfo}。`,
    weatherText: item.weatherText,
    focusRangeC: `${item.minC.toFixed(0)}°–${item.maxC.toFixed(0)}°`,
    ...(item.rainPct > 0 ? { focusRainPct: item.rainPct } : {}),
    locationLabel,
  };
}

/** 明日聚焦一句话摘要（口径与 getBrief 的 tomorrowSummary 段一致，前置地点） */
function tomorrowFocusSummary(locationLabel: string, t: WeatherTomorrow): string {
  const rainInfo =
    t.rainPct > 0
      ? `，降水概率 ${t.rainPct}%${t.rainWindow ? `（${t.rainWindow.label}）` : ""}`
      : "";
  return `${locationLabel ? `${locationLabel} ` : ""}明日${t.weatherText}，${t.minC.toFixed(0)}–${t.maxC.toFixed(0)}°C${rainInfo}。`;
}

/** 给逐日条目加人类可读标签：前 3 天固定今天/明天/后天，其余标周几（确定性 UTC 计算，无 Date.now） */
function withDayLabel(item: WeatherDailyForecastItem, index: number): WeatherDailyForecastItem & { dayLabel: string } {
  const fixed = ["今天", "明天", "后天"][index];
  if (fixed) return { ...item, dayLabel: fixed };
  const weekday = new Date(`${item.date}T00:00:00Z`).getUTCDay();
  return { ...item, dayLabel: WEEKDAY_LABELS[weekday] ?? item.date };
}
