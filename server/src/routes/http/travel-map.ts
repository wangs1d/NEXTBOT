import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { travelTileCache } from "../../services/travel-tile-cache.js";

/**
 * 行程规划浏览器页面路由（「行程卡 → 进入界面」链路）。
 *
 * 页面本体是自包含 HTML（server/web/travel-map/）：
 * - desktop.html → 桌面版「行迹」（左栏 tab + 旅程带 + Now 卡 + 示意地图 + 今日安排；
 *   行程独立窗口的页面，见 client/flutter_app 的 travel_plan_window.dart）
 * - mobile.html  → 手机竖屏版（一屏一站 + 按需呼出地图 + 站点详情）
 * 行程数据经 POST /travel-plans 存入进程内存，页面以 ?id=xxx 同源取回后
 * 调 window.__travelPanel.loadPlan 渲染（两版桥 API 同名）。数据不落盘、
 * 随进程生命周期存亡。
 *
 * ═══════════════════════════════════════════════════════════════════
 * ⚠️ 铁律（用户 2026-10-13 明确要求）：桌面端入口永远是 desktop.html。
 * 任何调试/排查/临时改动，都不许把桌面入口（/travel-map/desktop、
 * 桌面 UA 的 /travel-map 分流、Dart 独立窗口宿主页）改成手机端入口
 * （mobile.html / /travel-map/mobile）。调试手机版请直接访问
 * /travel-map/mobile，或用 ?mobile=1 显式覆盖——改入口本身一律禁止。
 * 契约由 test/travel-map-routes.test.ts 钉死，改动会挂测试。
 * ═══════════════════════════════════════════════════════════════════
 *
 * 进入方式：GET /travel-map 按 User-Agent 分流（手机 UA → mobile.html），
 * 两版共用同一份载荷与同一套 BroadcastChannel 标签页复用约定。
 * 应用侧：TravelPlanBrowserLauncher（client/flutter_app）先 POST 载荷再打开
 * /travel-map?id=xxx（Android/iOS 走应用内浏览器、桌面走系统浏览器）；
 * server 不可达时桌面侧自行降级到独立子进程窗口。
 */

const webRoot = join(import.meta.dirname ?? ".", "../../../web/travel-map");

/** 内存行程载荷：id → { payload, createdAt } */
interface StoredPlan {
  payload: unknown;
  createdAt: number;
}
const plans = new Map<string, StoredPlan>();

/** 容量与时效约束：最多 32 份、每份 24h 过期（懒清理） */
const MAX_PLANS = 32;
const PLAN_TTL_MS = 24 * 60 * 60 * 1000;

function prunePlans(): void {
  const now = Date.now();
  for (const [id, item] of plans) {
    if (now - item.createdAt > PLAN_TTL_MS) plans.delete(id);
  }
  while (plans.size > MAX_PLANS) {
    // 淘汰最旧的一份
    let oldestId = "";
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [id, item] of plans) {
      if (item.createdAt < oldestAt) {
        oldestAt = item.createdAt;
        oldestId = id;
      }
    }
    if (!oldestId) break;
    plans.delete(oldestId);
  }
}

/** MapLibre 本地内联（与客户端 travel_map_assets.dart 同款替换规则） */
const MAPLIBRE_CSS_TAG =
  '<link href="https://cdn.jsdelivr.net/npm/maplibre-gl@4.7.1/dist/maplibre-gl.css" rel="stylesheet" />';
const MAPLIBRE_JS_TAG =
  '<script src="https://cdn.jsdelivr.net/npm/maplibre-gl@4.7.1/dist/maplibre-gl.js"></script>';

/** 手机 UA 判定：决定 /travel-map 走竖屏版还是桌面版 */
const MOBILE_UA_RE =
  /Android|webOS|iPhone|iPod|iPad|BlackBerry|IEMobile|Opera Mini|Mobile Safari|HarmonyOS|Windows Phone/i;

/**
 * 分流判定：?mobile=1 / ?desktop=1 显式覆盖（调试与宿主指定），否则看 UA。
 *
 * ⚠️ 铁律：这里的默认分支不许倒置或删除——桌面 UA 必须落到 desktop.html。
 * 调试时想看手机版，用 ?mobile=1 或 /travel-map/mobile，不要动这段逻辑。
 */
function wantsMobileView(req: FastifyRequest): boolean {
  const q = req.query as { mobile?: string; desktop?: string };
  if (q.mobile === "1") return true;
  if (q.desktop === "1") return false;
  return MOBILE_UA_RE.test(String(req.headers["user-agent"] ?? ""));
}

function buildPageHtml(fileName: string): string {
  let html = readFileSync(join(webRoot, fileName), "utf8");
  const cssPath = join(webRoot, "vendor", "maplibre-gl.css");
  const jsPath = join(webRoot, "vendor", "maplibre-gl.js");
  if (existsSync(cssPath) && existsSync(jsPath) && html.includes(MAPLIBRE_JS_TAG)) {
    // 内联 script 的安全转义：内容里出现 "</script" 会提前终止脚本块
    const css = readFileSync(cssPath, "utf8").replaceAll("</style", "<\\/style");
    const js = readFileSync(jsPath, "utf8").replaceAll("</script", "<\\/script");
    html = html
      .replace(MAPLIBRE_CSS_TAG, `<style>\n${css}\n</style>`)
      .replace(MAPLIBRE_JS_TAG, `<script>\n${js}\n</script>`);
  }
  return html;
}

/** 从载荷提取中心 + POI 坐标，fire-and-forget 建目的地离线包（失败静默） */
function warmTilesForPayload(payload: unknown): void {
  try {
    const p = payload as {
      destination?: string;
      center?: { latitude?: number; longitude?: number };
      days?: Array<{ entries?: Array<{ latitude?: number; longitude?: number }> }>;
    };
    const center =
      p.center && Number.isFinite(p.center.latitude) && Number.isFinite(p.center.longitude)
        ? { latitude: Number(p.center.latitude), longitude: Number(p.center.longitude) }
        : undefined;
    const pois = (p.days ?? [])
      .flatMap((d) => d.entries ?? [])
      .filter((e) => Number.isFinite(e.latitude) && Number.isFinite(e.longitude))
      .map((e) => ({ latitude: Number(e.latitude), longitude: Number(e.longitude) }));
    if (!center && pois.length === 0) return;
    const points = center ? [center, ...pois] : pois;

    // 先做轻量预热（中心 + POI 周边，快）保证首屏不空白；
    // 再后台建完整离线包（按行程范围整块覆盖 + 完整度结论，慢）保证离线可用。
    void travelTileCache
      .warmDestination(center ?? pois[0]!, pois)
      .then((r) => console.log(`[TravelMap] 瓦片预热完成: 新拉取${r.fetched} 已缓存${r.hitCache} 失败${r.failed}`))
      .catch(() => { /* 预热失败不影响主流程 */ });
    if (p.destination) {
      void travelTileCache
        .packDestination(p.destination, points)
        .then((pack) =>
          console.log(
            `[TravelMap] 离线包「${pack.destination}」: 共${pack.total} 已有${pack.ready} 新拉${pack.fetched} 失败${pack.failed}` +
              ` → ${pack.complete ? "离线可用" : "有缺口（断网时这些格子空白）"}`,
          ),
        )
        .catch(() => { /* 建包失败不影响主流程 */ });
    }
  } catch { /* 载荷形状异常时静默跳过 */ }
}

// ═══════════════════════════════════════════════════════════════════
// 真实路网路线规划（行程页「路线地图」的数据源）
//
// 与旧的 panel.html 同路数：走 OSRM 开放路网（免费、无需 key）。区别在
// 「按段规划 + 段内自动选 profile」——景点之间的移动方式本就不同，全天一条
// 驾车路线既不合理也不好看：
//   段直线 < 1.5km → 步行路网（routing.openstreetmap.de/routed-foot）
//   段直线 < 4km   → 骑行路网（…/routed-bike）
//   其余           → 驾车路网（TRAVEL_ROUTE_API_BASE 可覆盖，默认公共 demo）
// 可用 ?profile=walk|bike|drive 强制统一 profile（调试/宿主指定）。
//
// 容错：任一段失败只丢该段几何（前端降级直线，不整屏空白）；网络类失败整组
// 熔断 10 分钟，避免离线时每个请求都白等一轮超时。成功结果按「profile+坐标」
// 24h 内存缓存——切天、重开行程页都不再打外网。
// ═══════════════════════════════════════════════════════════════════

interface RouteLatLng {
  lat: number;
  lng: number;
}

type RouteProfile = "walk" | "bike" | "drive";

interface RouteLegResult {
  index: number;
  mode: RouteProfile;
  distanceKm: number;
  durationMin: number;
  /** GeoJSON LineString 坐标：[lng, lat] */
  coordinates: Array<[number, number]>;
}

/** OSRM URL 里的 profile 段名（自定义实例的路径约定，与业务 mode 名不同） */
const ROUTE_PROFILE_PATH: Record<RouteProfile, string> = {
  walk: "foot",
  bike: "bike",
  drive: "driving",
};

const ROUTE_UPSTREAM: Record<RouteProfile, string> = {
  walk: "https://routing.openstreetmap.de/routed-foot",
  bike: "https://routing.openstreetmap.de/routed-bike",
  drive: "https://router.project-osrm.org",
};

const ROUTE_LEG_CACHE = new Map<
  string,
  { at: number; leg: Omit<RouteLegResult, "index"> }
>();
const ROUTE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const ROUTE_CIRCUIT_MS = 10 * 60 * 1000;
/** 熔断到期时刻（0 = 通路） */
let routeCircuitOpenUntil = 0;

function routeUpstreamOf(profile: RouteProfile): string {
  if (profile === "drive") {
    return (process.env.TRAVEL_ROUTE_API_BASE || ROUTE_UPSTREAM.drive).replace(/\/+$/, "");
  }
  return ROUTE_UPSTREAM[profile];
}

function routeHaversineKm(a: RouteLatLng, b: RouteLatLng): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** 解析 `lat,lng;lat,lng;…`（上限 24 点，挡住异常长查询） */
function parseRouteStops(raw: string): RouteLatLng[] {
  const out: RouteLatLng[] = [];
  for (const part of raw.split(";")) {
    const [latS, lngS] = part.split(",");
    const lat = Number(latS);
    const lng = Number(lngS);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
    out.push({ lat, lng });
    if (out.length >= 24) break;
  }
  return out;
}

/** 段移动方式推断：短距离本就该走路，长距离用市区车速估驾车 */
function pickRouteProfile(a: RouteLatLng, b: RouteLatLng): RouteProfile {
  const km = routeHaversineKm(a, b);
  if (km < 1.5) return "walk";
  if (km < 4) return "bike";
  return "drive";
}

/** 单段真实路网几何（失败返回 null，由调用方决定降级） */
async function fetchRouteLeg(
  from: RouteLatLng,
  to: RouteLatLng,
  profile: RouteProfile,
): Promise<Omit<RouteLegResult, "index"> | null> {
  const key = `${profile}|${from.lat.toFixed(4)},${from.lng.toFixed(4)}|${to.lat.toFixed(4)},${to.lng.toFixed(4)}`;
  const now = Date.now();
  const hit = ROUTE_LEG_CACHE.get(key);
  if (hit && now - hit.at < ROUTE_CACHE_TTL_MS) return hit.leg;

  if (now < routeCircuitOpenUntil) return null;

  const base = routeUpstreamOf(profile);
  const url =
    `${base}/route/v1/${ROUTE_PROFILE_PATH[profile]}/${from.lng},${from.lat};${to.lng},${to.lat}` +
    `?overview=simplified&geometries=geojson&steps=false&alternatives=false`;

  let leg: Omit<RouteLegResult, "index"> | null = null;
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const json = (await res.json()) as {
        routes?: Array<{
          distance?: number;
          duration?: number;
          geometry?: { coordinates?: unknown };
        }>;
      };
      const r = json.routes?.[0];
      const raw = r?.geometry?.coordinates;
      if (r && Array.isArray(raw)) {
        const coords = raw.filter(
          (c): c is [number, number] =>
            Array.isArray(c) &&
            c.length >= 2 &&
            Number.isFinite(c[0] as number) &&
            Number.isFinite(c[1] as number),
        );
        if (coords.length >= 2) {
          leg = {
            mode: profile,
            distanceKm: Math.round(((r.distance ?? 0) / 1000) * 10) / 10,
            durationMin: Math.max(1, Math.round((r.duration ?? 0) / 60)),
            coordinates: coords,
          };
        }
      }
    } else if (res.status >= 500 || res.status === 429) {
      // 上游过载/限流：短暂熔断，别把这一批剩下的段全打上去
      routeCircuitOpenUntil = now + ROUTE_CIRCUIT_MS;
    }
  } catch {
    // 网络不可达/超时：熔断（离线环境下列表页仍可用直线降级）
    routeCircuitOpenUntil = now + ROUTE_CIRCUIT_MS;
  }

  if (leg) {
    ROUTE_LEG_CACHE.set(key, { at: now, leg });
    if (ROUTE_LEG_CACHE.size > 512) {
      const oldest = ROUTE_LEG_CACHE.keys().next().value;
      if (oldest != null) ROUTE_LEG_CACHE.delete(oldest);
    }
  }
  return leg;
}

/** 有界并发（OSRM 公共节点对突发并发不友好，3 路足够把 12 段压进数秒） */
async function routeMapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}

export function registerTravelMapRoutes(app: FastifyInstance): void {
  /** GET /travel-map — 行程规划页面（自包含 HTML；按 UA 分流手机竖屏版/桌面双栏版） */
  app.get("/travel-map", async (req, reply) => {
    // HTML 为纯静态自包含资源（行程数据走 /travel-plans/:id 异步取），
    // 长缓存后二次打开零 HTML 等待；版本更新靠内容变更 + 常规刷新兜底。
    // 同一 URL 按 UA 返回不同页面 → 必须 Vary: User-Agent 且不进共享缓存。
    reply.header("Vary", "User-Agent");
    reply.header("Cache-Control", "private, max-age=86400");
    reply.type("text/html; charset=utf-8");
    return buildPageHtml(wantsMobileView(req) ? "mobile.html" : "desktop.html");
  });

  /** GET /travel-map/mobile — 强制手机竖屏版（调试 / 宿主显式指定用） */
  app.get("/travel-map/mobile", async (_req, reply) => {
    reply.header("Cache-Control", "private, max-age=86400");
    reply.type("text/html; charset=utf-8");
    return buildPageHtml("mobile.html");
  });

  /**
   * GET /travel-map/desktop — 桌面「行迹」行程面板（行程独立窗口的页面）。
   *
   * 由 client/flutter_app 的行程独立窗口宿主加载（`?host=1`，数据经 Dart 桥
   * `window.__travelPanel.loadPlan` 注入）；页面自身也带设计稿演示数据，
   * 浏览器直接打开即可看到完整界面。
   *
   * ⚠️ 铁律：这条路由是桌面应用（独立窗口/应用内面板）的页面入口，
   * 必须始终返回 desktop.html（「行迹」桌面版）。任何情况下——包括
   * 调试、联调手机版、临时验证——都不许改成 mobile.html 或 UA 分流。
   * 手机版有专门入口 /travel-map/mobile，请用那个。
   *
   * 注：旧的桌面双栏页 panel.html 已于 2026-10-11 删除（行程统一走本页，
   * 其 MapLibre 实时路线规划能力当前无调用方，需要时再从 git 历史取回）。
   */
  app.get("/travel-map/desktop", async (_req, reply) => {
    reply.header("Cache-Control", "private, max-age=86400");
    reply.type("text/html; charset=utf-8");
    return buildPageHtml("desktop.html");
  });

  /** GET /travel-map/switch — 标签页复用引导页：广播新行程 id 给已开页面换载 */
  app.get("/travel-map/switch", async (req, reply) => {
    const q = req.query as { id?: string; planId?: string };
    // 真实仓库 planId 形如 plan-1790585256591（保留下划线/连字符）；内存载荷 id 为纯十六进制
    const realId = (q.planId ?? "").replace(/[^A-Za-z0-9_-]/g, "");
    const memId = (q.id ?? "").replace(/[^A-Za-z0-9]/g, "");
    const id = realId || memId;
    if (!id) return reply.code(400).type("text/plain").send("missing id");
    // 无已开页面时的落点：真实仓库带 planId=，内存载荷带 id=
    const fallback = realId
      ? `/travel-map?planId=${encodeURIComponent(id)}`
      : `/travel-map?id=${id}`;
    reply.header("Cache-Control", "no-store");
    reply.type("text/html; charset=utf-8");
    // 已开的行程页监听同一 BroadcastChannel：认领后本引导页自动关闭，
    // 无已开页面（首次打开）时 400ms 后整页跳转正常行程页
    return `<!doctype html><meta charset="utf-8"><title>行程切换…</title><body>
<script>
(function(){
  var id=${JSON.stringify(id)};
  var claimed=false;
  try{
    var bc=new BroadcastChannel('pai-travel-plan');
    bc.onmessage=function(e){
      if(e.data&&e.data.type==='claimed'&&e.data.id===id)claimed=true;
    };
    bc.postMessage({type:'switch',id:id});
  }catch(e){}
  setTimeout(function(){
    if(claimed){document.title='✓ 已切换';try{window.close()}catch(e){}}
    else{location.replace(${JSON.stringify(fallback)});}
  },450);
})();
</script></body>`;
  });

  // ══════════ 底图本地代理（瓦片/样式/字形经磁盘缓存，规划完成即预热）══════════

  /** 请求来源绝对地址（worker 内无法解析相对路径，改写 URL 必须带 origin） */
  const originOf = (req: FastifyRequest): string =>
    `${req.protocol}://${req.headers.host ?? "127.0.0.1:3000"}`;

  /** GET /travel-basemap/style/dark — Carto 暗色矢量样式（内部 URL 已改写为本地代理） */
  app.get("/travel-basemap/style/dark", async (req, reply) => {
    const style = await travelTileCache.darkStyleProxied(originOf(req));
    if (!style.ok) return reply.code(502).send({ error: "style upstream unavailable" });
    reply.header("Cache-Control", "no-cache");
    reply.type("application/json");
    return style.body;
  });

  /** GET /travel-basemap/fetch?u= — 白名单上游资源代理（磁盘缓存 + SWR）。
   *  变体路由 fetch.json / fetch.png：MapLibre 会把 sprite 的扩展名插到 query
   *  之前（/fetch.json?u=...），这里把后缀补回上游 URL。
   *  `@2x` 变体同理由 MapLibre 插在扩展名前（/fetch@2x.json?u=...）：缺这两条
   *  路由时高分屏 sprite 会 404（控制台噪音 + symbol 图层无图标）。 */
  const fetchHandler = (ext: string) => async (req: FastifyRequest, reply: FastifyReply) => {
    const q = req.query as { u?: string; z?: string; x?: string; y?: string };
    let u = q.u ?? "";
    if (!u) return reply.code(400).type("text/plain").send("missing u");
    if (ext && !/\.(json|png|webp)$/.test(u)) u += ext;
    // 兜底：若客户端未替换 {z}/{x}/{y} 令牌（留在 query 里），在此替换
    if (/\{z\}/.test(u)) {
      const z = q.z ?? "", x = q.x ?? "", y = q.y ?? "";
      if (z && x && y) u = u.replace(/\{z\}/g, z).replace(/\{x\}/g, x).replace(/\{y\}/g, y);
    }
    const res = await travelTileCache.fetch(u);
    if (!res.ok) return reply.code(res.status).type("text/plain").send(res.body.toString());
    reply.header("X-Tile-Cache", res.fromCache ? "hit" : "miss");
    // TileJSON 内容改写：tiles.json 里的 tiles[] 是上游绝对地址，不改写会让
    // MapLibre worker 绕过代理直连 CDN（国内网络下挂起 → 地图永远渲染不出）
    if (/\.json(\?|$)/.test(u) && res.contentType.includes("json")) {
      // JSON 清单（style/tiles.json）内容会随改写行为升级：浏览器侧必须可失效，
      // 服务端磁盘缓存兜底速度（ms 级）
      reply.header("Cache-Control", "no-cache");
      reply.type("application/json");
      return reply.send(travelTileCache.rewriteWhitelistedUrls(res.body.toString("utf-8"), originOf(req)));
    }
    // 瓦片/精灵/字形二进制不可变：浏览器 + 服务端双层长缓存
    reply.header("Cache-Control", "public, max-age=86400");
    reply.type(res.contentType);
    return reply.send(res.body);
  };
  app.get("/travel-basemap/fetch", fetchHandler(""));
  app.get("/travel-basemap/fetch.json", fetchHandler(".json"));
  app.get("/travel-basemap/fetch.png", fetchHandler(".png"));
  app.get("/travel-basemap/fetch@2x.json", fetchHandler("@2x.json"));
  app.get("/travel-basemap/fetch@2x.png", fetchHandler("@2x.png"));

  /** GET /travel-basemap/stats — 瓦片缓存诊断 */
  app.get("/travel-basemap/stats", async () => travelTileCache.stats());

  /**
   * GET /travel-basemap/offline — 已建的目的地离线包列表（覆盖范围 + 完整度）
   * POST /travel-basemap/offline — 为目的地建/补离线包
   *
   * 离线包 = 按行程范围把底图瓦片备齐（概览层整块覆盖 + POI 周边细节层），
   * 并给出「是否断网可用」的结论。瓦片本体仍在主缓存目录，清单只记覆盖与完整度。
   * body 兼容行程载荷（{destination, center, days[].entries[]}）与显式 {points:[]}。
   */
  app.get("/travel-basemap/offline", async () => ({ packs: travelTileCache.listPacks() }));

  app.post("/travel-basemap/offline", async (req: FastifyRequest, reply) => {
    const body = req.body as unknown;
    if (!body || typeof body !== "object") {
      return reply.code(400).send({ error: "payload must be a JSON object" });
    }
    const p = body as {
      destination?: string;
      points?: Array<{ latitude?: number; longitude?: number }>;
      center?: { latitude?: number; longitude?: number };
      days?: Array<{ entries?: Array<{ latitude?: number; longitude?: number }> }>;
    };
    const destination = typeof p.destination === "string" ? p.destination.trim() : "";
    if (!destination) return reply.code(400).send({ error: "destination is required" });

    const points: Array<{ latitude: number; longitude: number }> = [];
    const push = (latitude?: number, longitude?: number): void => {
      const lat = Number(latitude);
      const lng = Number(longitude);
      if (Number.isFinite(lat) && Number.isFinite(lng) && !(lat === 0 && lng === 0)) {
        points.push({ latitude: lat, longitude: lng });
      }
    };
    for (const pt of p.points ?? []) push(pt.latitude, pt.longitude);
    push(p.center?.latitude, p.center?.longitude);
    for (const d of p.days ?? []) for (const e of d.entries ?? []) push(e.latitude, e.longitude);

    if (points.length === 0) {
      return reply.code(400).send({ error: "need at least one valid coordinate" });
    }
    const pack = await travelTileCache.packDestination(destination, points);
    return reply.send({ ok: pack.complete, pack });
  });

  /**
   * POST /travel-basemap/warm — 行程页在「今日」视图时提前把底图备好。
   *
   * 地图视图容器在展开前尺寸为 0，MapLibre 无法初始化，所以首次点开「路线」
   * 会有几秒纯黑（首拉矢量样式 + sprite + 首屏瓦片）。这里让页面一拿到载荷
   * 就把目的地中心与 POI 交给服务端，在后台走磁盘缓存预热；用户点开地图时
   * 瓦片已在本地，几乎瞬开。fire-and-forget：不等预热结果就返回。
   */
  app.post("/travel-basemap/warm", async (req: FastifyRequest, reply) => {
    const body = req.body as unknown;
    if (!body || typeof body !== "object") {
      return reply.code(400).send({ error: "payload must be a JSON object" });
    }
    warmTilesForPayload(body);
    return reply.send({ ok: true });
  });

  /**
   * GET /travel-route?stops=lat,lng;lat,lng[&profile=walk|bike|drive]
   * — 逐段真实路网规划，返回 GeoJSON 线段（`legs[].coordinates` 为 [lng,lat]）。
   *
   * 行程页「路线地图」按返回的段依次连接；`resolved < total` 时前端对缺失段
   * 降级直线（不静默丢段）。服务不可达时返回 ok:false + 空 legs。
   */
  app.get("/travel-route", async (req, reply) => {
    const q = req.query as { stops?: string; profile?: string };
    const stops = parseRouteStops(q.stops ?? "");
    if (stops.length < 2) {
      return reply.code(400).send({ error: "need at least 2 stops (lat,lng;lat,lng)" });
    }
    const forced: RouteProfile | null =
      q.profile === "walk" || q.profile === "bike" || q.profile === "drive" ? q.profile : null;

    const pairs = stops.slice(0, -1).map((from, i) => ({
      from,
      to: stops[i + 1]!,
      profile: forced ?? pickRouteProfile(from, stops[i + 1]!),
    }));

    const legs = await routeMapLimit(pairs, 3, async (p, i) => {
      const leg = await fetchRouteLeg(p.from, p.to, p.profile);
      return leg ? { index: i, ...leg } : null;
    });
    const resolved = legs.filter((l): l is RouteLegResult => l !== null);

    // 结果按坐标缓存得比页面短一点：路线本身可缓存，但别让 CDN/中间层长期持有
    reply.header("Cache-Control", "private, max-age=300");
    return reply.send({
      ok: resolved.length > 0,
      source: "osrm",
      total: pairs.length,
      resolved: resolved.length,
      legs: resolved,
    });
  });

  /** POST /travel-plans — 桌面应用下发行程载荷，返回取数 id；顺带预热目的地瓦片 */
  app.post("/travel-plans", async (req: FastifyRequest, reply) => {
    const body = req.body as unknown;
    if (!body || typeof body !== "object") {
      return reply.code(400).send({ error: "payload must be a JSON object" });
    }
    prunePlans();
    const id = randomUUID().replace(/-/g, "").slice(0, 16);
    plans.set(id, { payload: body, createdAt: Date.now() });
    warmTilesForPayload(body);
    return reply.send({ id, url: `/travel-map?id=${id}` });
  });

  /** GET /travel-plans/:id — 页面同源取回行程载荷 */
  app.get("/travel-plans/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const item = plans.get(id);
    if (!item) {
      return reply.code(404).send({ error: "plan not found or expired" });
    }
    reply.header("Cache-Control", "no-store");
    return reply.send(item.payload);
  });
}

// ═══════════════════════════════════════════════════════════════════
// POI 实况补全：地点实拍照片 / 联系电话 / 官网 / 营业时间。
//
// 数据源（全部真实公开数据，无需 API Key；经本机网络连通性实测选择）：
// - 必应图片 async 接口 → 该地点的真实照片（国内可达）
// - Overpass API（OSM）→ 真实电话/官网/营业时间（kumi.systems 优先、
//   overpass-api.de / osm.ch 兜底；主站对高频请求返回 429。镜像选择见 fetchOverpass
//   注释——2026-10-12 移除了实测挂死的 maps.mail.ru）
// 维基百科/Nominatim 在当前网络环境不可达，不使用。各源独立容错，
// 服务端内存缓存 24h。
// ═══════════════════════════════════════════════════════════════════

interface PoiLiveDetails {
  photos?: Array<{ thumb: string; full: string }>;
  contact?: { phone?: string; website?: string; hours?: string; address?: string };
  errors?: string[];
}

const poiCache = new Map<string, { at: number; data: PoiLiveDetails }>();
const POI_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

async function fetchText(url: string, init: RequestInit = {}, timeoutMs = 9000): Promise<string> {
  const res = await fetch(url, {
    ...init,
    headers: { "User-Agent": BROWSER_UA, ...(init.headers as Record<string, string>) },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/** 必应图片：抓取该地点名称的真实照片直链（murl 字段） */
async function fetchBingPhotos(name: string): Promise<PoiLiveDetails["photos"]> {
  const html = await fetchText(
    `https://cn.bing.com/images/async?q=${encodeURIComponent(name)}&first=0&count=8&mmasync=1`,
  );
  const decoded = html.replace(/&quot;/g, '"');
  const urls = [...decoded.matchAll(/"murl":"(https?:\/\/[^"]+)"/g)].map((m) => m[1]);
  const unique = [...new Set(urls)].slice(0, 6);
  if (!unique.length) return undefined;
  return unique.map((full) => ({ thumb: full, full }));
}

interface OverpassElement {
  type: string;
  tags?: Record<string, string>;
  center?: { lat: number; lon: number };
}

/**
 * Overpass 多镜像容错（GET 方式）。**顺序**回退，故首个镜像的「最坏耗时」= 每次调用
 * 的固定罚金。
 *
 * 2026-10-12：原首位是 maps.mail.ru（理由「主站高频限流」），但它从本网连得上却不
 * 回包——实测同一 Overpass 查询 http=000 / 22.0s 挂死，而 kumi.systems 2.2s、
 * osm.ch 2.0s 均 200。顺序回退下把死镜像放首位 = 每个 POI 的实地标注（电话/官网/
 * 营业时间）都要先白等 25s 再降级。改为「先放实测健康且非主站限流」的 kumi，
 * 主站与另一健康镜像顺位兜底；mail.ru 已移除。
 */
async function fetchOverpass(query: string): Promise<OverpassElement[]> {
  const mirrors = [
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass-api.de/api/interpreter",
    "https://overpass.osm.ch/api/interpreter",
  ];
  let lastErr: unknown = null;
  for (const mirror of mirrors) {
    try {
      const text = await fetchText(`${mirror}?data=${encodeURIComponent(query)}`, {}, 25000);
      const data = JSON.parse(text) as { elements?: OverpassElement[] };
      return data.elements ?? [];
    } catch (e: unknown) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("overpass failed");
}

/** OSM 实地标注 → 电话/官网/营业时间（宽查询拉取周边命名要素，代码侧名称匹配） */
async function fetchOsmContact(
  name: string,
  lat: number,
  lng: number,
): Promise<PoiLiveDetails["contact"]> {
  const query =
    `[out:json][timeout:25];(node(around:1200,${lat},${lng})["name"];way(around:1200,${lat},${lng})["name"];);` +
    `out tags center 1200;`;
  const elements = await fetchOverpass(query);
  const norm = (s: string) => s.replace(/\s+/g, "").toLowerCase();
  const target = norm(name);

  let best: { tags: Record<string, string>; score: number } | null = null;
  for (const el of elements) {
    const tags = el.tags ?? {};
    const elName = norm(tags.name ?? "");
    if (!elName) continue;
    let score = 0;
    if (elName === target) score = 100;
    else if (elName.includes(target) || target.includes(elName)) score = 60;
    else continue;
    // 信息越全越优先
    if (tags.phone || tags["contact:phone"]) score += 10;
    if (tags.website || tags["contact:website"]) score += 8;
    if (tags.opening_hours) score += 5;
    if (!best || score > best.score) best = { tags, score };
  }
  if (!best) return undefined;
  const t = best.tags;
  const contact: PoiLiveDetails["contact"] = {};
  const phone = t.phone ?? t["contact:phone"];
  const website = t.website ?? t["contact:website"];
  if (phone) contact.phone = phone;
  if (website) contact.website = website;
  if (t.opening_hours) contact.hours = t.opening_hours;
  const addrParts = [t["addr:street"], t["addr:housenumber"], t["addr:city"]].filter(Boolean);
  if (addrParts.length) contact.address = addrParts.join(" ");
  return Object.keys(contact).length ? contact : undefined;
}

export function registerPoiDetailsRoute(app: FastifyInstance): void {
  app.get("/travel-poi/details", async (req, reply) => {
    const q = req.query as { name?: string; lat?: string; lng?: string };
    const name = (q.name ?? "").trim();
    const lat = Number(q.lat);
    const lng = Number(q.lng);
    if (!name) return reply.code(400).send({ error: "name is required" });

    const cacheKey = `${name}@${Number.isFinite(lat) ? lat.toFixed(4) : ""},${Number.isFinite(lng) ? lng.toFixed(4) : ""}`;
    const hit = poiCache.get(cacheKey);
    const now = Date.now();
    if (hit && now - hit.at < POI_CACHE_TTL_MS) {
      return reply.send(hit.data);
    }

    const result: PoiLiveDetails = {};
    const errors: string[] = [];
    const tasks = [
      fetchBingPhotos(name)
        .then((photos) => {
          result.photos = photos;
        })
        .catch((e: unknown) => {
          errors.push(`photos: ${e instanceof Error ? e.message : e}`);
        }),
      Number.isFinite(lat) && Number.isFinite(lng)
        ? fetchOsmContact(name, lat, lng)
            .then((contact) => {
              result.contact = contact;
            })
            .catch((e: unknown) => {
              errors.push(`osm: ${e instanceof Error ? e.message : e}`);
            })
        : Promise.resolve(),
    ];
    await Promise.all(tasks);
    if (errors.length) result.errors = errors;

    poiCache.set(cacheKey, { at: now, data: result });
    if (poiCache.size > 128) {
      const oldest = poiCache.keys().next().value;
      if (oldest != null) poiCache.delete(oldest);
    }
    return reply.send(result);
  });
}
