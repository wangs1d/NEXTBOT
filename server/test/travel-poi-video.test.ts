import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * POI 打卡视频回填测试（travel 视频下放）：
 *
 * 1. pickTopVideo 从严过滤：域名白名单 / 标题必须含 POI 名 / 打分取 top1 / 空候选 null
 * 2. setStopVideos：落盘 + 每站只留 1 条
 * 3. backfillForPlan：只补景点、已有视频跳过、POI 级缓存复用（跨行程不重搜）、
 *    无关召回不落盘（过滤后无候选 → 站点不带 videos）
 *
 * 运行：npx tsx --test test/travel-poi-video.test.ts
 */

// 环境变量须在模块导入前设置（travel-plan-store 单例构造时读取）
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "travel-poi-video-test-"));
process.env.TRAVEL_PLAN_STORE_DIR = path.join(tmpDir, "plans");
process.env.TRAVEL_POI_DB_DIR = path.join(tmpDir, "poi");

const { travelPlanStore } = await import(
  "../src/skills/travel-planning/travel-plan-store.js"
);
type StoredTravelPlan = import("../src/skills/travel-planning/travel-plan-store.js").StoredTravelPlan;
const { pickTopVideo, normalizeVideoText, TravelPoiVideoService } = await import(
  "../src/services/travel-poi-video-service.js"
);
type VideoCandidate = import("../src/services/travel-poi-video-service.js").VideoCandidate;

// ==================== pickTopVideo ====================

test("video: normalizeVideoText 剥括号/标点/空白并小写", () => {
  assert.equal(normalizeVideoText("宽窄巷子（网红打卡地） 完整攻略!"), "宽窄巷子完整攻略");
  assert.equal(normalizeVideoText("【成都】大熊猫基地 Vlog"), "成都大熊猫基地vlog");
});

test("video: 白名单外域名剔除；标题不含 POI 名剔除；命中取 top1", () => {
  const items: VideoCandidate[] = [
    // 无关标题（不含 POI 名）→ 剔除
    { title: "成都美食推荐十家店", pageUrl: "https://www.bilibili.com/video/BV1xx" },
    // 非白名单域 → 剔除
    { title: "宽窄巷子旅游攻略", pageUrl: "https://example.com/video/1" },
    // POI 名出现靠后 + 无目的地 → 低分
    { title: "成都游玩必去 宽窄巷子", pageUrl: "https://www.bilibili.com/video/BV2" },
    // POI 名出现最早 + 含目的地 + 攻略词 → 最高分
    { title: "成都宽窄巷子超全攻略", pageUrl: "https://www.bilibili.com/video/BV3" },
    // B站 API 源（高分候选前的干扰项：标题相关但出现位置靠中）
    { title: "打卡宽窄巷子的一天", pageUrl: "https://www.bilibili.com/video/BV4", source: "bilibili-api" },
  ];
  const top = pickTopVideo(items, "宽窄巷子", "成都");
  assert.ok(top);
  assert.equal(top.url, "https://www.bilibili.com/video/BV3");
  assert.equal(top.source, "bilibili");
  // 每次只回 1 条
  const few = pickTopVideo([items[4]!], "宽窄巷子", "成都");
  assert.ok(few);
  assert.equal(few.title, "打卡宽窄巷子的一天");
});

test("video: 全部候选不相关/空 → null（宁缺毋滥）", () => {
  assert.equal(pickTopVideo([], "宽窄巷子", "成都"), null);
  assert.equal(
    pickTopVideo(
      [{ title: "成都火锅探店", pageUrl: "https://www.douyin.com/video/1" }],
      "宽窄巷子",
      "成都",
    ),
    null,
  );
  assert.equal(
    pickTopVideo(
      [{ title: "宽窄巷子攻略", pageUrl: "https://mp.weixin.qq.com/s/1" }], // 白名单外
      "宽窄巷子",
      "成都",
    ),
    null,
  );
});

// ==================== setStopVideos / backfillForPlan ====================

let planSeq = 0;
function savePlan(): StoredTravelPlan {
  const plan = {
    planId: `vid-${++planSeq}`,
    sessionId: "actor-a",
    destination: "成都",
    title: "成都3日游",
    startDate: "2026-10-17",
    endDate: "2026-10-19",
    createdAt: Date.now() + planSeq,
    days: [
      {
        date: "2026-10-17",
        items: [
          { type: "attraction", name: "宽窄巷子", startTime: "09:00", latitude: 30.66, longitude: 104.05, address: "", priceInfo: "", description: "" },
          { type: "restaurant", name: "马路边边", startTime: "12:00", latitude: 30.66, longitude: 104.06, address: "", priceInfo: "", description: "" },
          { type: "attraction", name: "人民公园", startTime: "14:00", latitude: 30.66, longitude: 104.05, address: "", priceInfo: "", description: "", videos: [{ url: "https://www.bilibili.com/video/BV0", title: "已有视频", source: "bilibili" }] },
        ],
      },
    ],
  } as StoredTravelPlan;
  travelPlanStore.save(plan);
  return plan;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("video: backfillForPlan 只补景点/跳过已有/命中落盘/无关不落盘", async () => {
  const plan = savePlan();
  const searched: string[] = [];
  const svc = new TravelPoiVideoService(
    {
      searchVideos: async (q) => {
        searched.push(q);
        if (q.includes("人民公园")) return { items: [] }; // 已有视频的站根本不该搜到这
        if (q.includes("宽窄巷子")) {
          return {
            items: [
              { title: "完全无关的视频", pageUrl: "https://www.bilibili.com/video/BVx" },
              { title: "成都宽窄巷子打卡vlog", pageUrl: "https://www.bilibili.com/video/BVy" },
            ],
          };
        }
        return { items: [{ title: "马路边边串串", pageUrl: "https://www.bilibili.com/video/BVz" }] }; // 餐厅不该搜
      },
    },
    travelPlanStore,
  );
  svc.backfillForPlan(plan);
  await sleep(60);

  const got = travelPlanStore.get(plan.planId)!;
  // 宽窄巷子：命中 1 条（无关那条被门禁剔除）
  assert.equal(got.days[0]?.items[0]?.videos?.length, 1);
  assert.equal(got.days[0]?.items[0]?.videos?.[0]?.url, "https://www.bilibili.com/video/BVy");
  // 餐厅不搜、已有视频的站不搜 → 全程只搜了宽窄巷子一次
  assert.deepEqual(searched, ["成都 宽窄巷子"]);
});

test("video: POI 级缓存跨行程复用（同 POI 不重搜）", async () => {
  savePlan(); // vid-2（宽窄巷子第一次搜发生在上一用例，缓存已热）
  let calls = 0;
  const svc = new TravelPoiVideoService(
    {
      searchVideos: async (q) => {
        calls++;
        return { items: [{ title: `成都${q}攻略`, pageUrl: "https://www.bilibili.com/video/BVnew" }] };
      },
    },
    travelPlanStore,
  );
  svc.backfillForPlan(travelPlanStore.get("vid-2")!);
  await sleep(60);
  // 宽窄巷子在进程缓存里（上一用例搜过），本行程不再发起网络搜索
  assert.equal(calls, 0);
  const got = travelPlanStore.get("vid-2")!;
  assert.equal(got.days[0]?.items[0]?.videos?.length, 1);
  // 命中的是缓存里那条（上一用例的 BVy），不是本次新搜
  assert.equal(got.days[0]?.items[0]?.videos?.[0]?.url, "https://www.bilibili.com/video/BVy");
});

test("video: setStopVideos 每站只留 1 条；越界站点返回 false", () => {
  const plan = savePlan(); // vid-3
  assert.ok(travelPlanStore.setStopVideos(plan.planId, 0, 0, [
    { url: "https://a.bilibili.com/video/1", title: "第一条", source: "bilibili" },
    { url: "https://a.bilibili.com/video/2", title: "第二条", source: "bilibili" },
  ]));
  const got = travelPlanStore.get(plan.planId)!;
  assert.equal(got.days[0]?.items[0]?.videos?.length, 1);
  assert.equal(got.days[0]?.items[0]?.videos?.[0]?.url, "https://a.bilibili.com/video/1");
  assert.equal(travelPlanStore.setStopVideos(plan.planId, 9, 0, []), false);
});
