/**
 * 行程归档页预览种子（dev 工具）：从 travel-poi.db 读真实数据填充 3 份行程
 * （进行中=成都 / 即将出发=西安 / 往期回顾=三亚），覆盖「时间漏斗」三分组。
 *
 * 真实性边界：POI 名称/坐标/地址/图片全部来自 POI 库（Wikimedia 实拍图
 * 已落盘本地资产）；时刻与日期为演示编排。跑法：
 *   cd server && npx tsx scripts/seed-travel-preview.ts
 */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { travelPlanStore, type StoredTravelPlan } from "../src/skills/travel-planning/travel-plan-store.js";

const db = new DatabaseSync("data/travel-poi.db");

interface Poi {
  name: string;
  type: string;
  latitude: number;
  longitude: number;
  address: string;
  images: string[];
}

/** 读一个 POI（含真实图片资产 URL 列表）；查不到返回 null */
function readPoi(destination: string, name: string): Poi | null {
  const city = db.prepare("SELECT slug FROM cities WHERE destination = ?").get(destination) as
    | { slug: string }
    | undefined;
  if (!city) return null;
  const row = db
    .prepare("SELECT name, type, latitude, longitude, address FROM pois WHERE city_slug = ? AND name = ?")
    .get(city.slug, name) as
    | { name: string; type: string; latitude: number; longitude: number; address: string }
    | undefined;
  if (!row) return null;
  const imgs = db
    .prepare(
      "SELECT item_id FROM media WHERE poi_key = ? AND kind = 'image' ORDER BY created_at",
    )
    .all(`${row.type}:${row.name}`) as Array<{ item_id: string }>;
  return {
    name: row.name,
    type: row.type,
    latitude: row.latitude,
    longitude: row.longitude,
    address: row.address || `${row.name}附近`,
    images: imgs.map((i) => i.item_id),
  };
}

function two(v: number): string {
  return v.toString().padStart(2, "0");
}
function dateStr(d: Date): string {
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

/** 目的地代表封面：取该地标首张真实图 */
function coverOf(poi: Poi | null): string {
  return poi?.images[0] ?? "";
}

function item(poi: Poi, startTime: string): StoredTravelPlan["days"][number]["items"][number] {
  return {
    type: poi.type,
    name: poi.name,
    startTime,
    latitude: poi.latitude,
    longitude: poi.longitude,
    address: poi.address,
    priceInfo: "",
    description: "",
    ...(poi.images.length ? { images: poi.images.slice(0, 3) } : {}),
  };
}

/** 按天编排：[[时刻, POI 名]] × 天数 → days（POI 查不到的条目跳过，宁缺毋滥） */
function buildDays(
  destination: string,
  start: Date,
  schedule: Array<Array<[string, string]>>,
): { days: StoredTravelPlan["days"]; missing: string[] } {
  const days: StoredTravelPlan["days"] = [];
  const missing: string[] = [];
  schedule.forEach((dayItems, di) => {
    const date = new Date(start);
    date.setDate(date.getDate() + di);
    const items = dayItems
      .map(([time, name]) => {
        const poi = readPoi(destination, name);
        if (!poi) {
          missing.push(name);
          return null;
        }
        return item(poi, time);
      })
      .filter((x): x is NonNullable<typeof x> => x != null);
    days.push({ date: dateStr(date), items });
  });
  return { days, missing };
}

const today = new Date();
const addDays = (n: number) => {
  const d = new Date(today);
  d.setDate(d.getDate() + n);
  return d;
};

// ── 进行中：成都（今天第 2 天，昨日 4 站已走完） ──────────────────────
const chengduStart = addDays(-1);
const chengduPoi = readPoi("成都", "大熊猫繁育研究基地");
const chengdu = buildDays("成都", chengduStart, [
  [
    ["09:30", "宽窄巷子"],
    ["14:00", "武侯祠"],
    ["16:30", "锦里古街"],
  ],
  [
    ["09:00", "大熊猫繁育研究基地"],
    ["14:30", "文殊院"],
    ["18:00", "春熙路"],
  ],
  [
    ["10:00", "杜甫草堂"],
    ["14:00", "青羊宫"],
  ],
]);
// 已走完 Day1 全部 + Day2 当前站（大熊猫基地）
const chengduPlan: StoredTravelPlan = {
  planId: "plan-preview-chengdu",
  dataQuality: "real",
  destination: "成都",
  title: "成都慢游三日",
  startDate: dateStr(chengduStart),
  endDate: dateStr(addDays(1)),
  center: { latitude: 30.6586, longitude: 104.0647 },
  intro: "熊猫基地、宽窄巷子与武侯祠的市区慢游路线。",
  preferences: ["美食", "文化", "亲子"],
  totalCost: 3600,
  progress: { day: 1, stop: 0, updatedAt: Date.now() },
  coverImage: coverOf(chengduPoi),
  days: chengdu.days,
};

// ── 即将出发：西安（+17 天出发） ─────────────────────────────────────
const xianStart = addDays(17);
const xianPoi = readPoi("西安", "秦始皇兵马俑博物馆");
const xian = buildDays("西安", xianStart, [
  [
    ["10:00", "西安城墙"],
    ["14:00", "碑林博物馆"],
    ["18:30", "回民街"],
  ],
  [
    ["09:00", "秦始皇兵马俑博物馆"],
    ["14:30", "华清宫"],
  ],
  [
    ["09:30", "陕西历史博物馆"],
    ["14:00", "大雁塔"],
  ],
]);
const xianPlan: StoredTravelPlan = {
  planId: "plan-preview-xian",
  dataQuality: "real",
  destination: "西安",
  title: "西安古都三日",
  startDate: dateStr(xianStart),
  endDate: dateStr(addDays(19)),
  center: { latitude: 34.3416, longitude: 108.9398 },
  intro: "城墙、兵马俑与陕历博的关中古都线。",
  preferences: ["历史", "文化"],
  totalCost: 4200,
  coverImage: coverOf(xianPoi),
  days: xian.days,
};

// ── 往期回顾：三亚（60 天前已结束） ─────────────────────────────────
const sanyaStart = addDays(-60);
const sanyaPoi = readPoi("三亚", "蜈支洲岛");
const sanya = buildDays("三亚", sanyaStart, [
  [
    ["15:00", "亚龙湾"],
    ["18:30", "第一市场"],
  ],
  [
    ["09:00", "蜈支洲岛"],
    ["18:00", "后海村"],
  ],
  [
    ["09:30", "南山文化旅游区"],
  ],
]);
const sanyaPlan: StoredTravelPlan = {
  planId: "plan-preview-sanya",
  dataQuality: "real",
  destination: "三亚",
  title: "三亚海岛四日",
  startDate: dateStr(sanyaStart),
  endDate: dateStr(addDays(-57)),
  center: { latitude: 18.2528, longitude: 109.5119 },
  intro: "亚龙湾玩水、蜈支洲岛浮潜的夏日海岛行。",
  preferences: ["海岛", "亲子"],
  totalCost: 12800,
  coverImage: coverOf(sanyaPoi),
  days: sanya.days,
};

// ── 清演示数据 + 写入 ────────────────────────────────────────────────
const storeDir = process.env.TRAVEL_PLAN_STORE_DIR || path.join(process.cwd(), "data", "travel-plans");
for (const f of fs.readdirSync(storeDir)) {
  if (f.startsWith("plan-preview-")) {
    fs.rmSync(path.join(storeDir, f));
    console.log("removed demo:", f);
  }
}

for (const plan of [chengduPlan, xianPlan, sanyaPlan]) {
  travelPlanStore.save(plan);
  const stops = plan.days.reduce((n, d) => n + d.items.length, 0);
  console.log(`seeded ${plan.planId} · ${plan.title} · ${plan.days.length} 天 ${stops} 站 · cover ${plan.coverImage ? "✓" : "✗"}`);
}
console.log("missing POIs:", [...chengdu.missing, ...xian.missing, ...sanya.missing].join(", ") || "none");
