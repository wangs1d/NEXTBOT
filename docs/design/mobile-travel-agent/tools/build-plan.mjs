/* ============================================================================
   ⚠️ 这是唯一允许的载荷来源脚本，务必先读本注释 ⚠️

   ⛔ 生成/验证载荷一律不得手搓（禁止用图片占位、禁止编造坐标与行程）。
   ✅ 唯一数据源 = 服务端真实行程仓库（Agent 生成后落盘）：
        GET /travel/plans            → 列出全部真实行程
        GET /travel/plans/:planId    → 单份真实行程（days[].items[]）
      或直接读磁盘 server/data/travel-plans/{planId}.json

   本脚本做两件事（都只读真实数据，不造数据）：
     1. 生成 docs/design/mobile-travel-agent/plan-data.js
        → 把真实行程转成设计稿 schema（window.PA_TRAVEL_DEMO_PLAN），
          供 mobile-home.html / mobile-detail.html 视觉评审。
     2. 打印移动端实拍用的真实 URL
        → 服务端页直接吃真实仓库，无需灌数：
            http://127.0.0.1:3000/travel-map/mobile?planId=<planId>

   用法：
     node docs/design/mobile-travel-agent/tools/build-plan.mjs            # 取最新一份真实行程
     node docs/design/mobile-travel-agent/tools/build-plan.mjs plan-xxx   # 指定 planId
   前置：本机 server 在 127.0.0.1:3000 运行（npm run dev / dev:desktop 均可）
   ========================================================================== */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const designDir = resolve(here, "..");
const root = resolve(here, "../../../..");
const API = process.env.PA_API_BASE || "http://127.0.0.1:3000";

const KIND = { attraction: "sight", restaurant: "food", hotel: "stay", transport: "ride" };
const TAG = { attraction: "景点", restaurant: "餐饮", hotel: "住宿", transport: "交通" };
const MODE = [[/步行|walk/i, "walk"], [/骑行|单车|bike|cycle/i, "bike"], [/游船|渡船|坐船|船|boat|ferry/i, "boat"],
  [/徒步|hike|trek/i, "hike"], [/车|drive|taxi|grab|car|bus|城际|包车|网约/i, "taxi"]];
const normMode = (m) => (MODE.find(([re]) => re.test(String(m || ""))) || [null, "taxi"])[1];
const hhmm2min = (t) => {
  const m = /(?:T|\s|^)(\d{1,2}):(\d{2})/.exec(String(t || ""));
  return m ? (+m[1]) * 60 + (+m[2]) : null;
};
const distText = (km) => (km == null ? "" : km < 1 ? Math.round(km * 1000) + "m" : Number(km).toFixed(1) + "km");

// 1) 取真实行程
const wid = process.argv[2];
let plan;
if (wid) {
  const j = await (await fetch(`${API}/travel/plans/${encodeURIComponent(wid)}`)).json();
  plan = j.plan || j;
} else {
  const list = (await (await fetch(`${API}/travel/plans`)).json()).plans || [];
  if (!list.length) throw new Error("真实行程仓库为空：先在应用里让 Agent 生成一份行程");
  const newest = list.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0];
  const j = await (await fetch(`${API}/travel/plans/${encodeURIComponent(newest.planId)}`)).json();
  plan = j.plan || j;
}
if (!plan || !plan.days || !plan.days.length) throw new Error("行程数据为空或结构不符");
if (!plan.days[0].items && !plan.days[0].entries) throw new Error("既非仓库形态(items)也非载荷形态(entries)");

// 2) 真实坐标 → 设计稿 SVG 回退用的归一化 xy（有真实 loc 时地图走 MapLibre，xy 仅兜底）
const pts = [];
plan.days.forEach((d) => (d.items || d.entries || []).forEach((it) => {
  if (it.latitude != null && it.longitude != null) pts.push([Number(it.longitude), Number(it.latitude)]);
}));
const bbox = pts.length
  ? pts.reduce((a, [x, y]) => [Math.min(a[0], x), Math.min(a[1], y), Math.max(a[2], x), Math.max(a[3], y)],
      [Infinity, Infinity, -Infinity, -Infinity])
  : null;
const toXY = (lng, lat) => {
  if (!bbox || bbox[2] - bbox[0] === 0 && bbox[3] - bbox[1] === 0) return [210, 280];
  const pad = 60, W = 420 - pad * 2, H = 560 - pad * 2;
  const sx = bbox[2] - bbox[0] || 1e-6, sy = bbox[3] - bbox[1] || 1e-6;
  return [Math.round(pad + ((lng - bbox[0]) / sx) * W), Math.round(pad + (1 - (lat - bbox[1]) / sy) * H)];
};

// 3) 转设计稿 schema（与 mobile-home.html 顶部注释一致）
const days = plan.days.map((d, di) => {
  const items = d.items || d.entries || [];
  const stops = items.map((it, ii) => {
    const loc = it.latitude != null && it.longitude != null
      ? { lat: Number(it.latitude), lng: Number(it.longitude) } : null;
    const tp = it.transportFromPrev;
    const km = tp && tp.distanceKm != null ? Number(tp.distanceKm) : null;
    const type = String(it.type || "attraction");
    return {
      id: "d" + di + "s" + ii,
      name: String(it.name || "行程安排"),
      kind: KIND[type] || "sight",
      tag: TAG[type] || "安排",
      img: (it.images || []).filter(Boolean)[0] || "",
      start: hhmm2min(it.startTime),
      duration: Number(it.visitDuration) || 45,
      loc,
      xy: loc ? toXY(loc.lng, loc.lat) : null,
      note: String(it.description || it.priceInfo || ""),
      leg: tp ? { mode: normMode(tp.mode), minutes: Number(tp.durationMin) || 0, dist: distText(km) } : null,
      detail: {
        desc: String(it.description || ""),
        hl: it.highlights || [],
        tips: it.tips || [],
        ticket: String(it.priceInfo || ""),
        hours: String(it.hours || ""),
        addr: String(it.address || "")
      }
    };
  });
  return {
    name: String(d.subtitle || d.name || d.date || ("Day " + (di + 1))),
    date: String(d.date || ""),
    stops,
    alts: []
  };
});

// 4) 站点无自带图时，取服务端真实实拍补全（/travel-poi/details，真实图源 + 维基简介）
const liveCache = new Map();
async function liveFor(name, lat, lng) {
  const key = name + "@" + lat + "," + lng;
  if (liveCache.has(key)) return liveCache.get(key);
  const qs = new URLSearchParams({ name });
  if (lat != null && lng != null) { qs.set("lat", String(lat)); qs.set("lng", String(lng)); }
  let v = null;
  try {
    const r = await fetch(`${API}/travel-poi/details?${qs}`, { headers: { Accept: "application/json" } });
    if (r.ok) {
      const j = await r.json();
      const ph = j.photos && j.photos.length ? (j.photos[0].thumb || j.photos[0].full) : null;
      const wiki = j.wiki && j.wiki.extract ? String(j.wiki.extract) : null;
      if (ph || wiki) v = { img: ph, desc: wiki };
    }
  } catch { /* 取不到：保持无图 */ }
  liveCache.set(key, v);
  return v;
}
const needLive = [];
days.forEach((d) => d.stops.forEach((s) => { if (!s.img) needLive.push(s); }));
let filled = 0;
for (let i = 0; i < needLive.length; i += 4) {          // 小并发，别把图源打挂
  await Promise.all(needLive.slice(i, i + 4).map(async (s) => {
    const live = await liveFor(s.name, s.loc && s.loc.lat, s.loc && s.loc.lng);
    if (!live) return;
    if (live.img) { s.img = live.img; filled++; }
    if (live.desc && !s.detail.desc) { s.detail.desc = live.desc; s.note = live.desc; }
  }));
}

const out = {
  city: String(plan.destination || ""),
  day: 0,
  mood: "刚刚好",
  quality: String(plan.dataQuality || "real"),
  center: plan.center || null,
  coverImage: String(plan.coverImage || ""),
  days
};

const header = `/* ============================================================================
   真实行程演示数据（由 tools/build-plan.mjs 从服务端真实仓库生成，请勿手改）
   源：GET /travel/plans/${plan.planId}（${out.city} · ${plan.title || ""}）· dataQuality=${out.quality}
   生成时间：${new Date().toISOString()}
   —— 图片/坐标/时长全部来自 Agent 生成的真实行程，非占位素材。
   ========================================================================== */
`;
const body = `(function () {
  window.PA_TRAVEL_DEMO_PLAN = ${JSON.stringify(out, null, 2)};

  window.addEventListener("load", function () {
    if (/[?&]empty=1/.test(location.search)) return;
    if (typeof window.PA_TRAVEL_SET_PLAN === "function") {
      window.PA_TRAVEL_SET_PLAN(window.PA_TRAVEL_DEMO_PLAN, "已同步最新一轮规划，<b>时间锚点保持不动</b>，跟着走就行。");
    } else if (typeof window.renderAll === "function") {
      window.PLAN = window.PA_TRAVEL_DEMO_PLAN;
    }
  });
})();
`;

mkdirSync(designDir, { recursive: true });
writeFileSync(resolve(designDir, "plan-data.js"), header + body, "utf8");
console.log(`plan-data.js 已生成：${out.city} · ${plan.title || ""} · ${days.length} 天 · ${days.reduce((n, d) => n + d.stops.length, 0)} 站`);
console.log(`  站点带实拍图：${days.reduce((n, d) => n + d.stops.filter((s) => s.img).length, 0)} 站（其中 ${filled} 站由 /travel-poi/details 实时补全）`);
console.log(`移动端真实数据实拍地址：${API}/travel-map/mobile?planId=${plan.planId}`);
console.log(`  桌面双栏（本仓未接 planId，仅供对照）：${API}/travel-map?id=<载荷id>`);
console.log(`  根目录：${root}`);
