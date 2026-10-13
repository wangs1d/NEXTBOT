/**
 * 行程页「真实地图」验收探针
 *
 * 验证 server/web/travel-map/desktop.html 的地图链路：
 *  1) MapLibre 底图（Carto 暗色，经本机 /travel-basemap 代理）能否渲染出瓦片；
 *  2) 当天行程 POI 是否按真实经纬度落点（marker 数量 = 有条数的站）；
 *  3) /travel-route 真实路网几何是否画成白线，且首次打开为「依次连接」动画；
 *  4) 图例是否给出真实距离/时长与数据来源（缺失段须显式标注，不得静默丢段）。
 *
 * 用法：先确保本机 server 在 3000 端口（tsx watch 已起），再
 *   node scripts/probe-travel-map-real.mjs
 * 截图落在 shots/ 下。
 */
import { chromium } from "playwright";

const BASE = process.env.PAI_BASE || "http://127.0.0.1:3000";

/** 真实经纬度的杭州西湖环线（设计稿同款地名，坐标取自公开 OSM 数据） */
const PAYLOAD = {
  destination: "杭州",
  dataQuality: "knowledge",
  title: "行迹 · 杭州 2 日",
  days: [
    {
      label: "09/12",
      subtitle: "西湖环湖线",
      entries: [
        { name: "湖滨出发", type: "hotel", time: "08:30", duration: 15,
          latitude: 30.2530, longitude: 120.1630, description: "寄存行李，沿北山街步行出发" },
        { name: "断桥残雪", type: "attraction", time: "09:00", duration: 45,
          latitude: 30.2586, longitude: 120.1503, description: "清晨湖面最静" },
        { name: "孤山 · 西泠印社", type: "attraction", time: "10:00", duration: 70,
          latitude: 30.2545, longitude: 120.1420, description: "沿白堤走到孤山" },
        { name: "楼外楼", type: "restaurant", time: "12:15", duration: 80,
          latitude: 30.2553, longitude: 120.1388, priceInfo: "人均 180", description: "西湖醋鱼、东坡肉" },
        { name: "花港观鱼", type: "attraction", time: "14:00", duration: 65,
          latitude: 30.2360, longitude: 120.1380, description: "在水上看雷峰塔" },
        { name: "雷峰塔", type: "attraction", time: "16:00", duration: 70,
          latitude: 30.2319, longitude: 120.1483, description: "傍晚光线最好",
          // 媒体字段用服务端媒体库的真实形状（视频＝B站实拍 + 本地化缩略图，
          // 留言＝对应视频的观众评论）。这里固定几条，验证桌面页的渲染出口。
          videos: [
            { platform: "哔哩哔哩", title: "雷峰塔旅游攻略", durationSeconds: 755,
              thumbnailUrl: "/travel/media/assets/poi-3bef7119bdb4/92961fe090eeb0b6.jpg",
              playPageUrl: "https://www.bilibili.com/video/av115829832161100" },
            { platform: "哔哩哔哩", title: "雷峰塔倒下后，白娘子还在吗？【杭州雷峰塔】", durationSeconds: 739,
              thumbnailUrl: "/travel/media/assets/poi-3bef7119bdb4/2b1828d5d4797c22.jpg",
              playPageUrl: "https://www.bilibili.com/video/av116338416747244" },
            { platform: "哔哩哔哩", title: "拒绝废话2分钟带你走进杭州雷峰塔", durationSeconds: 137,
              thumbnailUrl: "/travel/media/assets/poi-3bef7119bdb4/bc738a82be538adc.jpg",
              playPageUrl: "https://www.bilibili.com/video/av803849115" },
          ],
          reviews: [
            { author: "jklkhhh", text: "看完了 更不想去了。",
              url: "https://www.bilibili.com/video/av115829832161100" },
            { author: "jintengcheng", text: "岳阳楼历史上重修5次，每次样式都不一样。也没人会认为不是古样式。",
              url: "https://www.bilibili.com/video/av115829832161100" },
          ] },
        { name: "河坊街", type: "restaurant", time: "18:30", duration: 100,
          latitude: 30.2380, longitude: 120.1720, description: "灯笼老街，晚餐与夜游" },
      ],
    },
  ],
};

const shots = [];
function log(...a) { console.log(...a); }

const browser = await chromium.launch({
  args: ["--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1140, height: 740 }, deviceScaleFactor: 1.5 });

page.on("pageerror", (e) => log("[pageerror]", e.message));
page.on("console", (m) => {
  const t = m.text();
  if (/\[map\]|\[travel|Failed|error/i.test(t)) log("[console]", m.type(), t.slice(0, 200));
});

await page.goto(`${BASE}/travel-map/desktop?host=1`, { waitUntil: "load", timeout: 30000 });
await page.waitForFunction(() => !!window.__travelPanel, null, { timeout: 20000 });

// 关掉字体外链等待；直接注入真实载荷（等价宿主桥 loadPlan）
await page.evaluate((p) => window.__travelPanel.loadPlan(p), PAYLOAD);
await page.waitForTimeout(400);

const loadingGone = await page.evaluate(() =>
  document.getElementById("tbCity").textContent + " | " + document.getElementById("goBtn").textContent);
log("载荷注入后顶栏:", loadingGone);

// 站点媒体渲染：切到带视频/留言的那一站并截图（Now 卡右侧应出现视频缩略图与观众留言）
await page.evaluate(() => window.__travelPanel.openStop("d1e5"));
await page.waitForTimeout(700);
await page.screenshot({ path: "shots/travel-media-now.png" });
shots.push("shots/travel-media-now.png");
const mediaDiag = await page.evaluate(() => {
  const box = document.getElementById("nowMedia");
  return {
    station: document.getElementById("nowName").textContent,
    videoCards: box ? box.querySelectorAll("[data-video]").length : 0,
    reviewRows: box ? box.querySelectorAll("[data-review]").length : 0,
    firstVideoTitle: box?.querySelector(".mv-t")?.textContent ?? null,
    thumbLoaded: box?.querySelector(".mv-thumb")?.getAttribute("style")?.slice(0, 70) ?? null,
  };
});
log("媒体渲染:", JSON.stringify(mediaDiag));

// 切到路线地图
await page.click('.side-ic[data-view="map"]');
await page.waitForTimeout(1200);
await page.screenshot({ path: "shots/travel-map-anim.png" });
shots.push("shots/travel-map-anim.png");

// 等地图 + 路线 + 动画跑完
await page.waitForFunction(
  () => window.mapState && window.mapState.ready && window.mapState.markers.length > 0,
  null, { timeout: 40000 },
).catch(() => log("!! 地图就绪/marker 等待超时"));
await page.waitForTimeout(1600);
await page.screenshot({ path: "shots/travel-map-anim2.png" });
shots.push("shots/travel-map-anim2.png");
await page.waitForTimeout(4000);
await page.screenshot({ path: "shots/travel-map-done.png" });
shots.push("shots/travel-map-done.png");

const diag = await page.evaluate(() => {
  const ms = window.mapState || {};
  const canvas = document.querySelector("#map canvas");
  let routeFeatures = null;
  try {
    routeFeatures = ms.map.getSource("travel-route")._data.features.map((f) => ({
      state: f.properties.state, real: f.properties.real, mode: f.properties.mode,
      pts: f.geometry.coordinates.length,
    }));
  } catch (e) { /* ignore */ }
  const c = ms.map ? ms.map.getCenter() : null;
  return {
    mapReady: !!ms.ready,
    markers: (ms.markers || []).length,
    played: Object.keys(ms.played || {}),
    legend: (document.getElementById("mapLegend") || {}).textContent,
    mark: (document.getElementById("mapMark") || {}).textContent,
    center: c ? [Math.round(c.lng * 1e4) / 1e4, Math.round(c.lat * 1e4) / 1e4] : null,
    canvas: canvas ? `${canvas.width}x${canvas.height}` : null,
    routeFeatures,
  };
});
log("诊断:", JSON.stringify(diag, null, 2));

// ══════════════ 换目的地：底图必须跟着换 ══════════════
// 用户问题「对应地点的底图呢」的覆盖面 = 任意目的地都要成立，所以再验两地：
//  ① 另一座城市（兴义，带真实坐标）→ 底图/水印/路线都应换过去；
//  ② 只有中心、没有站点坐标的载荷 → 底图仍须落在目的地（不能停在默认点）。
const XINGYI = {
  destination: "兴义",
  center: { latitude: 25.092, longitude: 104.896 },
  days: [{
    label: "10/02", subtitle: "峰林峡谷线",
    entries: [
      { name: "桔山广场", type: "hotel", time: "08:30", duration: 15, latitude: 25.108, longitude: 104.906 },
      { name: "马岭河峡谷", type: "attraction", time: "09:20", duration: 150, latitude: 25.013, longitude: 104.936 },
      { name: "万峰林", type: "attraction", time: "13:30", duration: 180, latitude: 24.9877, longitude: 104.897 },
      { name: "贵州醇景区", type: "attraction", time: "17:00", duration: 90, latitude: 25.070, longitude: 104.890 },
    ],
  }],
};

await page.evaluate((p) => window.__travelPanel.loadPlan(p), XINGYI);
await page.waitForTimeout(6000);
await page.screenshot({ path: "shots/travel-map-xingyi.png" });
shots.push("shots/travel-map-xingyi.png");
const xy = await page.evaluate(() => {
  const ms = window.mapState || {};
  const c = ms.map ? ms.map.getCenter() : null;
  return {
    mark: (document.getElementById("mapMark") || {}).textContent,
    markers: (ms.markers || []).length,
    legend: (document.getElementById("mapLegend") || {}).textContent,
    center: c ? [Math.round(c.lng * 1e3) / 1e3, Math.round(c.lat * 1e3) / 1e3] : null,
  };
});
log("兴义:", JSON.stringify(xy));
// 视野必须落在兴义一带（而不是杭州，也不是默认点）
if (!xy.center || Math.abs(xy.center[0] - 104.9) > 0.6 || Math.abs(xy.center[1] - 25.05) > 0.6) {
  log("!! 换目的地后视野没跟上:", JSON.stringify(xy.center));
}
if (!/兴义/.test(xy.mark || "")) log("!! 地图水印没跟着换:", xy.mark);

const DALI = {
  destination: "大理",
  center: { latitude: 25.6065, longitude: 100.2676 },
  days: [{
    label: "10/03", subtitle: "洱海环线",
    entries: [
      { name: "洱海公园", type: "attraction", time: "09:00", duration: 90 },
      { name: "大理古城", type: "attraction", time: "14:00", duration: 120 },
    ],
  }],
};
await page.evaluate((p) => window.__travelPanel.loadPlan(p), DALI);
await page.waitForTimeout(2600);
await page.screenshot({ path: "shots/travel-map-no-coords.png" });
shots.push("shots/travel-map-no-coords.png");
const dl = await page.evaluate(() => {
  const ms = window.mapState || {};
  const c = ms.map ? ms.map.getCenter() : null;
  return {
    mark: (document.getElementById("mapMark") || {}).textContent,
    markers: (ms.markers || []).length,
    center: c ? [Math.round(c.lng * 1e3) / 1e3, Math.round(c.lat * 1e3) / 1e3] : null,
  };
});
log("无坐标载荷:", JSON.stringify(dl));
if (!dl.center || Math.abs(dl.center[0] - 100.2676) > 0.6 || Math.abs(dl.center[1] - 25.6065) > 0.6) {
  log("!! 无坐标时没用载荷 center 定位:", JSON.stringify(dl.center));
}

await browser.close();
log("截图:", shots.join(", "));
