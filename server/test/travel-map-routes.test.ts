import test from "node:test";
import assert from "node:assert/strict";

import Fastify from "fastify";

import { registerTravelMapRoutes } from "../src/routes/http/travel-map.js";

/**
 * 行程页面路由域（routes/http/travel-map.ts）测试。
 *
 * 三端页面各有一条入口，锁定「谁被谁加载」这条契约：
 *   - GET /travel-map/desktop → desktop.html（行迹桌面版，行程独立窗口的页面）
 *   - GET /travel-map/mobile  → mobile.html（手机竖屏版）
 *   - GET /travel-map         → 按 UA 分流（桌面 UA → desktop.html，手机 UA → mobile.html）
 *
 * 2026-10-11 事故背景：行程独立窗口此前加载裸 ?host=1（= 已删除的 panel.html 双栏页），
 * 与用户给的「行迹 · 桌面端」设计稿完全不是一版；本测试把「桌面窗口加载 desktop.html」
 * 这条契约钉死，避免再被改回。
 *
 * ⚠️ 铁律（用户 2026-10-13 明确要求）：任何调试/临时改动都不许把桌面端入口
 * 换成手机端入口（mobile.html / /travel-map/mobile）。桌面 UA → desktop.html、
 * /travel-map/desktop → desktop.html 是硬契约，下面用页面标识断言钉死，
 * 想调试手机版请用 /travel-map/mobile 或 ?mobile=1，不要动入口。
 */

function buildApp() {
  const app = Fastify();
  registerTravelMapRoutes(app);
  return app;
}

test("GET /travel-map/desktop → 行迹桌面页（含宿主桥与演示数据兜底）", async () => {
  const app = buildApp();
  const res = await app.inject({ method: "GET", url: "/travel-map/desktop" });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers["content-type"] as string, /text\/html/);
  assert.match(res.headers["cache-control"] as string, /max-age=86400/);
  const html = res.body;
  // 页面本体：设计稿标题 + 宿主桥 API + 演示数据兜底（无宿主载荷时也要能看）
  assert.ok(html.includes("行迹 · 桌面端"), "应带上设计稿的页面标识");
  assert.ok(html.includes("window.__travelPanel"), "必须暴露宿主桥（Dart 侧 loadPlan 注入）");
  assert.ok(html.includes("var DEMO="), "无载荷时用内置演示数据兜底");
  assert.ok(html.includes("loadPlan"), "必须实现 loadPlan");
  // 独立窗口的窗口控制走桥（无边框窗口的自绘标题栏）
  assert.ok(html.includes("windowDrag"), "自绘标题栏要能拖窗口");
  assert.ok(html.includes("notifyHost({event:'ready'})"), "页面就绪要通知宿主");
  await app.close();
});

test("GET /travel-map/mobile → 手机竖屏页", async () => {
  const app = buildApp();
  const res = await app.inject({ method: "GET", url: "/travel-map/mobile" });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers["content-type"] as string, /text\/html/);
  assert.ok(res.body.includes("window.__travelPanel"));
  assert.ok(!res.body.includes("var DEMO="), "手机页不是行迹桌面页");
  await app.close();
});

test("GET /travel-map 按 UA 分流：桌面 → 双栏页，手机 → 竖屏页（Vary 必带）", async () => {
  const app = buildApp();
  const desktop = await app.inject({
    method: "GET",
    url: "/travel-map",
    headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
  });
  const mobile = await app.inject({
    method: "GET",
    url: "/travel-map",
    headers: { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile Safari" },
  });
  assert.equal(desktop.statusCode, 200);
  assert.equal(mobile.statusCode, 200);
  // 同一 URL 两种页面 → 必须 Vary: User-Agent 且不进共享缓存
  assert.equal(desktop.headers["vary"], "User-Agent");
  assert.match(desktop.headers["cache-control"] as string, /private/);
  assert.notEqual(desktop.body, mobile.body);
  // ⚠️ 铁律断言：桌面 UA 拿到的必须是 desktop.html（行迹桌面版），不许被换成手机页
  assert.ok(desktop.body.includes("行迹 · 桌面端"), "桌面 UA 必须拿到 desktop.html（行迹桌面版）");
  assert.ok(desktop.body.includes("var DEMO="), "桌面 UA 的页面要带演示数据兜底（desktop.html 特征）");
  assert.ok(!mobile.body.includes("行迹 · 桌面端"), "手机 UA 拿到的是 mobile.html，不是桌面页");
  // 显式覆盖（宿主/调试用）
  const forcedDesktop = await app.inject({
    method: "GET",
    url: "/travel-map?desktop=1",
    headers: { "user-agent": "Mozilla/5.0 (iPhone) Mobile Safari" },
  });
  assert.equal(forcedDesktop.body, desktop.body);
  await app.close();
});

// ═══════════════════════════════════════════════════════════════════
// 路线地图的真实数据链路（2026-10-12：桌面行程页从「示意底图」换成
// MapLibre 真实底图 + /travel-route 真实路网）
// ═══════════════════════════════════════════════════════════════════

test("桌面页接入真实地图：MapLibre 资源 + 真实路线/标记/白线动画", async () => {
  const app = buildApp();
  const res = await app.inject({ method: "GET", url: "/travel-map/desktop" });
  const html = res.body;
  // 底图引擎与瓦片代理（本地 vendor 内联；CDN 标签缺失时不替换，直接报错更好）
  assert.ok(html.includes("maplibre-gl"), "必须引入 MapLibre（真实矢量底图）");
  assert.ok(html.includes("/travel-basemap/style/dark"), "底图样式走本机代理（磁盘缓存）");
  // 真实数据：POI 按经纬度落点 + 真实路网路线
  assert.ok(html.includes("maplibregl.Marker"), "站点必须按真实经纬度打点");
  assert.ok(html.includes("/travel-route?"), "路线几何取真实路网而非直线估算");
  assert.ok(html.includes("growLeg"), "首次打开要逐段生长（白线依次连接）");
  // 不能再回到「示意底图」：SVG 投影与水系底图是上一版实现
  assert.ok(!html.includes("mapBase"), "示意底图（mapBase）已下线");
  assert.ok(!html.includes("projectDay"), "SVG 投影（projectDay）已下线");
  assert.ok(!html.includes('id="mapSvg"'), "SVG 地图容器已下线");
  // 依序动画的判据：连线分「已连接/轨道」两态，只用白色
  assert.ok(html.includes("route-track") && html.includes("route-line"));
  await app.close();
});

test("GET /travel-route 参数校验：不足两点返回 400", async () => {
  const app = buildApp();
  const bad = await app.inject({ method: "GET", url: "/travel-route?stops=30.25,120.16" });
  assert.equal(bad.statusCode, 400);
  const empty = await app.inject({ method: "GET", url: "/travel-route" });
  assert.equal(empty.statusCode, 400);
  await app.close();
});

test("POST /travel-basemap/warm 只需要坐标；无形载荷返回 400", async () => {
  const app = buildApp();
  // 不带坐标 → 服务端直接返回（不发外网请求），测试保持离线可跑
  const ok = await app.inject({
    method: "POST",
    url: "/travel-basemap/warm",
    payload: { days: [] },
  });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().ok, true);
  const bad = await app.inject({
    method: "POST",
    url: "/travel-basemap/warm",
    headers: { "content-type": "application/json" },
    payload: "null",
  });
  assert.equal(bad.statusCode, 400);
  await app.close();
});
