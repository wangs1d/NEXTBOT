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
  // 显式覆盖（宿主/调试用）
  const forcedDesktop = await app.inject({
    method: "GET",
    url: "/travel-map?desktop=1",
    headers: { "user-agent": "Mozilla/5.0 (iPhone) Mobile Safari" },
  });
  assert.equal(forcedDesktop.body, desktop.body);
  await app.close();
});
