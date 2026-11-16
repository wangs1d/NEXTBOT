/**
 * 天气城市地理编码修复验证（2026-11-13）：
 * 1) geocodeCity("北海") 必须命中广西北海市（修复前 Open-Meteo 命中马来西亚同名镇/查空）；
 * 2) 完整走 weather.getBrief(city=北海, days=7) 模拟「未来一周」回执。
 * 运行：cd server && node --env-file=.env --import tsx ../scratch/verify-weather-geocode.ts
 */
import { geocodeCity, WeatherService } from "../server/src/services/weather-service.js";

async function main() {
  const amapKey = (process.env.AMAP_WEB_KEY ?? "").trim();
  console.log("AMAP_WEB_KEY:", amapKey ? `${amapKey.slice(0, 6)}...（已配置）` : "（未配置，将走 Open-Meteo 兜底）");

  for (const city of ["北海", "兴义市", "贵阳", "上海"]) {
    const t0 = Date.now();
    const g = await geocodeCity(city);
    console.log(
      `[geocodeCity] ${city} → ${g ? `${g.name} (${g.admin1 ?? "-"}, ${g.country ?? "-"}) ${g.latitude.toFixed(4)},${g.longitude.toFixed(4)}` : "null"} (${Date.now() - t0}ms)`,
    );
  }

  const g = await geocodeCity("北海");
  if (!g) throw new Error("geocodeCity(北海) 失败");
  if (Math.abs(g.latitude - 21.48) > 0.5 || Math.abs(g.longitude - 109.12) > 0.5) {
    throw new Error(`北海坐标疑似错命中：${g.latitude},${g.longitude}`);
  }

  const weather = new WeatherService();
  const t0 = Date.now();
  const brief = await weather.getBrief(
    g.latitude,
    g.longitude,
    "auto",
    [g.name, g.admin1, g.country].filter(Boolean).join(" · "),
    7,
  );
  console.log(`\ngetBrief(北海, days=7) 耗时 ${Date.now() - t0}ms`);
  console.log("summary:", brief.summaryLine);
  console.log("dailyForecast.length:", brief.daily?.length);
  for (const d of brief.daily ?? []) {
    console.log(
      `  ${d.dayLabel} ${d.date} ${d.weatherText} ${d.minC.toFixed(0)}–${d.maxC.toFixed(0)}°C 降水 ${d.rainPct}%`,
    );
  }
  if (!brief.daily || brief.daily.length < 7) throw new Error("未来一周逐日数据不足 7 天");
  console.log("\n✅ 全部通过：北海地理编码正确，未来 7 天逐日回执完整");
}

main().catch((e) => {
  console.error("❌ 验证失败:", e.message);
  process.exit(1);
});
