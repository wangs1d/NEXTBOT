import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 画像驱动 POI 重排 + 旅行人格分型测试（travel 双端②③）：
 *
 * 1. getTravelProfile 聚合：poi_dislike/poi_dislike_name facts → dislikeTags/dislikeNames，
 *    travel_style → photoDriven/experienceDriven，无任何信号返回 {}
 * 2. 人格分型规则：photo_driven→shutter / experience_driven→explorer /
 *    负反馈证据≥3→curator / 有旅行事实→wanderer / 无事实→null（宁缺毋滥）
 * 3. rankPOIsByPreferences：dislikeNames 重罚下沉（不删除）、dislikeTags 轻罚、
 *    photoDriven 需真实机位/热度数据才加分、experienceDriven 词根加分
 * 4. paceCapFor 密度：人格 -1（shutter 除外）、下限 2、与 elderly/activities 叠加
 * 5. annotateProfileReasons：与排序同源的信号命中才写理由（宁缺毋滥）
 *
 * 运行：npx tsx --test test/travel-profile-persona.test.ts
 */

// 环境变量须在模块导入前设置（travel-poi-db / travel-plan-store 单例构造时读取；
// 评分函数测试不写库，但模块顶层单例仍会打开真实 data/travel-poi.db，必须隔离）
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "travel-profile-persona-test-"));
process.env.TRAVEL_POI_DB_DIR = path.join(tmpDir, "poi-db");
process.env.TRAVEL_PLAN_STORE_DIR = path.join(tmpDir, "plans");

const { PlanningService, paceCapFor } = await import(
  "../src/skills/travel-planning/travel-planning-service.js"
);
type TripPreferences = import("../src/skills/travel-planning/travel-planning-service.js").TripPreferences;
type RawPOI = import("../src/skills/travel-planning/poi-cache-manager.js").RawPOI;
const { UserPersonalizationService } = await import(
  "../src/services/user-personalization/user-personalization-service.js"
);
import type { UserFactStore } from "../src/services/user-personalization/user-profile-facts.js";

// ==================== getTravelProfile 聚合 + 人格分型 ====================

/** 构造无外部依赖的画像服务：fact store 直接塞 fallbackState（memory=null 读它） */
function makeProfileService(facts: UserFactStore["facts"]) {
  const svc = new UserPersonalizationService(null, null);
  (svc as unknown as { fallbackState: Map<string, unknown> }).fallbackState.set(
    `actor-x:user_profile_facts`, // USER_PROFILE_FACTS_KEY（私有常量，值稳定）
    { facts, updatedAt: new Date().toISOString() },
  );
  return svc;
}

function fact(key: string, value: string, evidenceCount = 1) {
  const now = new Date().toISOString();
  return {
    id: `travel:${key}:${key}-${value}`,
    category: "travel" as const,
    key,
    value,
    confidence: 0.62,
    evidenceCount,
    lastSeenAt: now,
    createdAt: now,
  };
}

test("profile: travel_style=photo_driven → photoDriven + shutter 分型", () => {
  const svc = makeProfileService([fact("travel_style", "photo_driven")]);
  const p = svc.getTravelProfile("actor-x");
  assert.equal(p.photoDriven, true);
  assert.equal(p.experienceDriven, undefined);
  assert.equal(p.persona?.id, "shutter");
  assert.ok(p.persona?.label.length);
});

test("profile: experience_driven → explorer；负反馈证据≥3 → curator（优先级低于显式 style）", () => {
  const svc = makeProfileService([
    fact("travel_style", "experience_driven"),
    fact("poi_dislike", "古镇", 2),
    fact("poi_dislike_name", "宽窄巷子", 2),
  ]);
  const p = svc.getTravelProfile("actor-x");
  assert.equal(p.experienceDriven, true);
  assert.equal(p.persona?.id, "explorer"); // style 显式分型 > 负反馈
  assert.deepEqual(p.dislikeTags, ["古镇"]);
  assert.deepEqual(p.dislikeNames, ["宽窄巷子"]);

  // 只有负反馈（无 style）：证据 2+2=4 ≥3 → curator
  const svc2 = makeProfileService([fact("poi_dislike", "寺庙", 2), fact("poi_dislike_name", "某寺", 2)]);
  assert.equal(svc2.getTravelProfile("actor-x").persona?.id, "curator");
});

test("profile: 有旅行事实无强信号 → wanderer；完全无事实 → {}（宁缺毋滥）", () => {
  const svc = makeProfileService([fact("diet", "不吃辣")]);
  const p = svc.getTravelProfile("actor-x");
  assert.equal(p.persona?.id, "wanderer");
  assert.equal(p.photoDriven, undefined);

  const svcEmpty = makeProfileService([]);
  assert.deepEqual(svcEmpty.getTravelProfile("actor-y"), {});
});

// ==================== rankPOIsByPreferences 画像评分 ====================

type RankFn = PlanningService["rankPOIsByPreferences"];
const rank = PlanningService.prototype.rankPOIsByPreferences as unknown as RankFn;

function makeRankThis(_favorites: string[] = []) {
  // favoriteKeys 是原型 getter（直读 travelFavoritesStore，测试环境回退空集），继承即可
  return Object.create(PlanningService.prototype) as PlanningService;
}

function poi(over: Partial<RawPOI> & { name: string }): RawPOI {
  return {
    id: `id-${over.name}`,
    latitude: 30.6,
    longitude: 104.0,
    address: "",
    type: "attraction",
    ...over,
  } as RawPOI;
}

function pref(over: Partial<TripPreferences> = {}): TripPreferences {
  return {
    raw: [],
    seaside: false,
    pool: false,
    activities: false,
    kids: false,
    elderly: false,
    pace: "balanced",
    activityMix: "mixed",
    photoDriven: false,
    experienceDriven: false,
    ...over,
  } as TripPreferences;
}

test("rank: dislikeNames 重罚下沉但保留在列表（不删除），dislikeTags 轻罚同类衰减", () => {
  const attractions = [
    poi({ name: "宽窄巷子", rating: 4.5 }),
    poi({ name: "人民公园", rating: 4.5 }),
    poi({ name: "杜甫草堂", rating: 4.5, tags: ["古镇"] }),
  ];
  const out = rank.call(
    makeRankThis(),
    attractions,
    [], [],
    pref(),
    null,
    { dislikeNames: ["宽窄巷子"], dislikeTags: ["古镇"] },
  );
  // 名称重罚(-8)与标签轻罚(-1.5)都应把对应 POI 压到等分对手之后
  assert.equal(out.attractions[0]?.name, "人民公园");
  assert.equal(out.attractions[1]?.name, "杜甫草堂");
  assert.equal(out.attractions[2]?.name, "宽窄巷子");
  // 只排序不删除：负向 POI 仍在候选池
  assert.ok(out.attractions.some((p) => p.name === "宽窄巷子"));
});

test("rank: photoDriven 需真实机位/热度数据才加分；experienceDriven 词根命中加分", () => {
  const attractions = [
    poi({ name: "普通公园", rating: 4.5 }),
    poi({ name: "东郊记忆", rating: 4.5, photo: { score: 0.9, spot: "烟囱侧面" } }),
    poi({ name: "春熙路", rating: 4.5, socialHeat: { level: "hot" } }),
  ];
  const out = rank.call(
    makeRankThis(),
    attractions, [], [],
    pref({ photoDriven: true }),
    null,
  );
  // 无数据的普通公园必须垫底：出片加分不造假
  assert.equal(out.attractions[2]?.name, "普通公园");

  const exp = rank.call(
    makeRankThis(),
    [poi({ name: "博物馆", rating: 4.5 }), poi({ name: "攀岩馆", rating: 4.5, tags: ["户外"] })],
    [], [],
    pref({ experienceDriven: true }),
    null,
  );
  assert.equal(exp.attractions[0]?.name, "攀岩馆");
});

// ==================== paceCapFor 人格密度 ====================

test("paceCap: 非 shutter 人格 -1、shutter 不变、下限 2、与 elderly/activities 叠加", () => {
  const persona = (id: string) => ({ id, label: id, desc: "" });
  assert.equal(paceCapFor(pref()), 3); // balanced 基准
  assert.equal(paceCapFor(pref({ persona: persona("shutter") })), 3); // 出片家不减
  assert.equal(paceCapFor(pref({ persona: persona("explorer") })), 2);
  assert.equal(paceCapFor(pref({ persona: persona("curator") })), 2);
  assert.equal(paceCapFor(pref({ pace: "relaxed", persona: persona("explorer") })), 2); // 下限 2
  assert.equal(paceCapFor(pref({ pace: "intensive", persona: persona("shutter") })), 4);
  assert.equal(paceCapFor(pref({ activities: true, persona: persona("explorer") })), 3); // 4-1
  assert.equal(paceCapFor(pref({ elderly: true, persona: persona("explorer") })), 2); // 2-1→下限
});

// ==================== annotateProfileReasons 理由标注 ====================

type ReasonFn = PlanningService["annotateProfileReasons"];
const annotate = PlanningService.prototype.annotateProfileReasons as unknown as ReasonFn;

/** 最小 CacheEntry['data'] 形状：只含 attractions 桶（findCachedSocialMeta 按 poiId 回查） */
function makeData(attractions: RawPOI[]) {
  return { attractions, hotels: [], restaurants: [] } as unknown as Parameters<ReasonFn>[1];
}

test("annotate: 出片向有实测机位→机位理由；仅热度→打卡地理由；体验向词根→体验理由", () => {
  const cachePois = [poi({ name: "东郊记忆", photo: { score: 0.9, spot: "烟囱侧面" } })];
  const days = [
    {
      date: "2026-10-18",
      items: [
        { itemId: "i1", type: "attraction" as const, name: "东郊记忆", description: "", startTime: "09:00", latitude: 30.6, longitude: 104.0, rating: 4.5, priceInfo: "", address: "", phone: "", openingHours: "", tags: [], images: [], poiId: "id-东郊记忆" },
        { itemId: "i2", type: "attraction" as const, name: "春熙路", description: "", startTime: "11:00", latitude: 30.6, longitude: 104.0, rating: 4.5, priceInfo: "", address: "", phone: "", openingHours: "", tags: [], images: [], poiId: "id-春熙路" },
      ],
    },
  ];
  annotate.call(
    Object.create(PlanningService.prototype) as PlanningService,
    days as never,
    makeData(cachePois),
    pref({ photoDriven: true }),
  );
  assert.equal((days[0]!.items[0] as { recommendReason?: string }).recommendReason, "按你的出片偏好挑的，有实测机位");
  // 热度 hot 无机位 → 打卡地话术
  const days2 = [
    {
      date: "2026-10-18",
      items: [
        { itemId: "i3", type: "attraction" as const, name: "春熙路", description: "", startTime: "09:00", latitude: 30.6, longitude: 104.0, rating: 4.5, priceInfo: "", address: "", phone: "", openingHours: "", tags: [], images: [], poiId: "id-春熙路" },
      ],
    },
  ];
  annotate.call(
    Object.create(PlanningService.prototype) as PlanningService,
    days2 as never,
    makeData([poi({ name: "春熙路", socialHeat: { level: "hot" } })]),
    pref({ photoDriven: true }),
  );
  assert.equal((days2[0]!.items[0] as { recommendReason?: string }).recommendReason, "按你的出片偏好挑的热门打卡地");

  // 体验向：词根命中才写
  const days3 = [
    {
      date: "2026-10-18",
      items: [
        { itemId: "i4", type: "attraction" as const, name: "青城后山", description: "", startTime: "09:00", latitude: 30.9, longitude: 103.5, rating: 4.5, priceInfo: "", address: "", phone: "", openingHours: "", tags: ["户外"], images: [] },
      ],
    },
  ];
  annotate.call(
    Object.create(PlanningService.prototype) as PlanningService,
    days3 as never,
    makeData([]),
    pref({ experienceDriven: true }),
  );
  assert.equal((days3[0]!.items[0] as { recommendReason?: string }).recommendReason, "按你的口味挑的体验型玩法");
});

test("annotate: 无画像信号/无数据命中不写理由（宁缺毋滥），非 attraction 不写", () => {
  const days = [
    {
      date: "2026-10-18",
      items: [
        { itemId: "h1", type: "attraction" as const, name: "普通公园", description: "", startTime: "09:00", latitude: 30.6, longitude: 104.0, rating: 4.5, priceInfo: "", address: "", phone: "", openingHours: "", tags: [], images: [] },
        { itemId: "r1", type: "restaurant" as const, name: "火锅店", description: "", startTime: "12:00", latitude: 30.6, longitude: 104.0, rating: 4.5, priceInfo: "", address: "", phone: "", openingHours: "", tags: [], images: [] },
      ],
    },
  ];
  const svcThis = Object.create(PlanningService.prototype) as PlanningService;
  // 出片向但 POI 无机位/热度数据 → 不写
  annotate.call(svcThis, days as never, makeData([]), pref({ photoDriven: true }));
  assert.equal((days[0]!.items[0] as { recommendReason?: string }).recommendReason, undefined);
  // 餐厅条目一律不写（即便命中体验词）
  annotate.call(svcThis, days as never, makeData([]), pref({ experienceDriven: true }));
  assert.equal((days[0]!.items[1] as { recommendReason?: string }).recommendReason, undefined);
});
