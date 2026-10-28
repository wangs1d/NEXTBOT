import type { ToolRegistry } from "./tool-registry.js";
import { geocodeCity, WeatherService, rainWindowSuffixText } from "../services/weather-service.js";
import type { WeatherDailyForecastItem } from "../services/weather-service.js";
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
    // days：用户问多日（"这周""后天""去玩三天"）时由模型传 1–16；缺省 2 = 今天+明天。
    const daysInput = Number(input.days);
    const days = Number.isFinite(daysInput) ? Math.max(1, Math.min(Math.trunc(daysInput), 16)) : 2;
    const brief = await weather.getBrief(lat, lon, timezone, label || undefined, days);
    return {
      ok: true,
      summary: brief.summaryLine,
      clothingAdvice: brief.clothingAdvice,
      currentTempC: brief.currentTempC,
      apparentTempC: brief.apparentTempC,
      todayRangeC: `${brief.todayMinC.toFixed(0)}–${brief.todayMaxC.toFixed(0)}`,
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
      locationLabel: brief.locationLabel,
      // 多日逐日预报（index 0 = 今天；仅当请求 >2 天时携带，避免单日轮次撑大返回）
      ...(days > 2 && brief.daily && brief.daily.length > 0
        ? { dailyForecast: brief.daily.map(withDayLabel) }
        : {}),
    };
  });
}

const WEEKDAY_LABELS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** 给逐日条目加人类可读标签：前 3 天固定今天/明天/后天，其余标周几（确定性 UTC 计算，无 Date.now） */
function withDayLabel(item: WeatherDailyForecastItem, index: number): WeatherDailyForecastItem & { dayLabel: string } {
  const fixed = ["今天", "明天", "后天"][index];
  if (fixed) return { ...item, dayLabel: fixed };
  const weekday = new Date(`${item.date}T00:00:00Z`).getUTCDay();
  return { ...item, dayLabel: WEEKDAY_LABELS[weekday] ?? item.date };
}
