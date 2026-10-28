/**
 * 旅游 POI / 地理编码数据源启动自检（2026-10-27，根治「静默降级」类事故）。
 *
 * 根因复盘（10-15 → 10-27 事故链，为什么「之前是好的，现在问题扎堆」）：
 *   1. 10-15 大重构删除 Overpass、把国际 POI 实时性全部押在 Foursquare 上，
 *      但 FSQ_API_KEY 至今为空（当日档案原话「仅待用户配置对应API密钥即可上线
 *      实测」）——国际实时发现从那天起就没活过，所有国际行程一直在降级路径硬撑；
 *   2. 地理编码侧 Nominatim 大陆网络不可达，高德兜底会拿国内同名地点冒充国际
 *      地名（巴厘岛=西安小区）→ 10-26 污染事故；
 *   3. 10-26 出发地自动定位只做了被动读缓存，客户端没上报过就一直反问；
 *   4. 以上每次降级全是静默的：无 key 跳过、失败返回空、无任何启动期告警，
 *      问题积累一周到用户侧集中爆发。
 * 根治：启动时并行探活全部外部源 + 校验配置，一张健康表当场输出；缺配置/
 *   不可达大声告警并给修复指引。本模块只观测不干预请求链路行为。
 */

import { isFoursquareConfigured } from "./foursquare-service.js";

type SourceStatus = "ok" | "degraded" | "down" | "unconfigured";

interface SourceCheck {
  name: string;
  role: string;
  status: SourceStatus;
  detail: string;
  fix?: string;
}

const PROBE_TIMEOUT_MS = 6_000;

async function probe(url: string, headers: Record<string, string> = {}): Promise<{ ok: boolean; http: number; note: string }> {
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "NextBot/1.0 (travel source health check)", ...headers },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return { ok: res.ok, http: res.status, note: `${Date.now() - t0}ms` };
  } catch (err) {
    return { ok: false, http: 0, note: err instanceof Error ? err.message : String(err) };
  }
}

async function runTravelSourceHealthCheck(): Promise<SourceCheck[]> {
  const checks = await Promise.all([
    (async (): Promise<SourceCheck> => {
      const key = (process.env.AMAP_WEB_KEY || "").trim();
      if (!key) {
        return { name: "高德 AMap", role: "国内 POI + 国内地理编码", status: "unconfigured", detail: "未配置 AMAP_WEB_KEY", fix: "server/.env.local 填 AMAP_WEB_KEY" };
      }
      const r = await probe(`https://restapi.amap.com/v3/geocode/geo?key=${key}&address=北京`);
      return { name: "高德 AMap", role: "国内 POI + 国内地理编码", status: r.ok ? "ok" : "down", detail: r.ok ? `HTTP ${r.http} ${r.note}` : `HTTP ${r.http} ${r.note}` };
    })(),
    (async (): Promise<SourceCheck> => {
      if (!isFoursquareConfigured()) {
        return {
          name: "Foursquare",
          role: "国际 POI 主源（含酒店/餐厅）",
          status: "unconfigured",
          detail: "FSQ_API_KEY 为空——10-15 上线以来一直未配置，国际实时发现从未生效",
          fix: "https://developer.foursquare.com 免费注册取 key → server/.env 填 FSQ_API_KEY= → 重启",
        };
      }
      const r = await probe("https://api.foursquare.com/v3/places/search?ll=35.68,139.65&limit=1", { Accept: "application/json", Authorization: (process.env.FSQ_API_KEY || "").trim() });
      return { name: "Foursquare", role: "国际 POI 主源（含酒店/餐厅）", status: r.http === 401 || r.http === 403 ? "down" : r.ok ? "ok" : "degraded", detail: `HTTP ${r.http} ${r.note}${r.http === 401 ? "（key 无效或超额）" : ""}` };
    })(),
    (async (): Promise<SourceCheck> => {
      // wikimedia 对大陆网络时通时断（2026-10-27 实测：上午通、午间超时、傍晚通），
      // 与运行链路一致地重试一次，避免把网络波动误报成源挂了
      let r = await probe("https://query.wikidata.org/sparql?format=json&query=" + encodeURIComponent("ASK {}"), { Accept: "application/sparql-results+json" });
      if (!r.ok) {
        await new Promise((res) => setTimeout(res, 1_200));
        r = await probe("https://query.wikidata.org/sparql?format=json&query=" + encodeURIComponent("ASK {}"), { Accept: "application/sparql-results+json" });
      }
      return { name: "Wikidata", role: "国际景点免 key 实时发现", status: r.ok ? "ok" : "down", detail: r.ok ? `HTTP ${r.http} ${r.note}` : `波动不可达（${r.note}）——运行链路会重试并自动降级知识库` };
    })(),
    (async (): Promise<SourceCheck> => {
      const r = await probe("https://overpass-api.de/api/status");
      return { name: "OSM Overpass", role: "国际 POI 免 key 兜底（酒店/餐厅）", status: r.ok ? "ok" : "down", detail: r.ok ? `HTTP ${r.http} ${r.note}` : `不可达（${r.note}）——大陆网络常态，熔断后自动降级` };
    })(),
    (async (): Promise<SourceCheck> => {
      const r = await probe("https://nominatim.openstreetmap.org/search?q=bali&format=json&limit=1");
      return { name: "Nominatim", role: "国际地理编码（未知国际地名）", status: r.ok ? "ok" : "down", detail: r.ok ? `HTTP ${r.http} ${r.note}` : `不可达（${r.note}）——未知国际地名地理编码仅剩坐标表与 Photon` };
    })(),
  ]);
  return checks;
}

function renderSourceHealthReport(checks: SourceCheck[]): string {
  const icon: Record<SourceStatus, string> = { ok: "✅", degraded: "⚠️ ", down: "❌", unconfigured: "🟡" };
  const lines = checks.map((c) => `  ${icon[c.status]} ${c.name.padEnd(12)} ${c.role} — ${c.detail}`);
  const fixes = checks.filter((c) => c.fix);
  if (fixes.length > 0) {
    lines.push("  修复指引:");
    for (const c of fixes) lines.push(`   → ${c.name}: ${c.fix}`);
  }
  return lines.join("\n");
}

/** 启动期执行：打一张表，缺配置的情况升级为 console.warn 告警（不阻塞启动） */
export async function logTravelSourceHealth(): Promise<void> {
  try {
    const checks = await runTravelSourceHealthCheck();
    const bad = checks.filter((c) => c.status !== "ok");
    if (bad.length === 0) {
      console.log(`[travel-source-health] 数据源全部健康:\n${renderSourceHealthReport(checks)}`);
      return;
    }
    const intlDead = bad.some((c) => c.name === "Foursquare" && c.status === "unconfigured") &&
      bad.some((c) => c.name === "Wikidata" && c.status === "down");
    console.warn(
      `[travel-source-health] ${checks.length - bad.length}/${checks.length} 数据源健康，${bad.length} 项降级:\n${renderSourceHealthReport(checks)}` +
        (intlDead ? "\n[travel-source-health] ⚠️ 国际实时 POI 链路整体失效，国际行程将降级知识库/报错——按上方修复指引配置后重启！" : ""),
    );
  } catch (err) {
    console.warn(`[travel-source-health] 自检失败（不影响服务）: ${err instanceof Error ? err.message : String(err)}`);
  }
}