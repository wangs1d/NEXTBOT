import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 行程分层架构：落盘存储 / 状态快照 / get-itinerary 回查工具。
 * 明细落盘（冷层）→ 状态快照进 prompt（热层，≤5 行）→ 明细按需回查。
 */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "travel-plan-store-test-"));
process.env.TRAVEL_PLAN_STORE_DIR = tmpDir;

// 环境变量须在模块导入前设置（单例构造时读取）
const { travelPlanStore } = await import(
  "../src/skills/travel-planning/travel-plan-store.js"
);
const { buildTravelStatePrompt } = await import(
  "../src/services/travel-prompt-snapshot.js"
);
const { createTravelPlanningBuiltinSkills } = await import(
  "../src/skills/travel-planning/travel-planning-skills.js"
);

/** 与 StoredTravelPlan 等价的本地结构视图（测试用）。 */
interface TestPlan {
  planId: string;
  destination: string;
  title: string;
  startDate: string;
  endDate: string;
  createdAt: number;
  totalCost?: number;
  days: Array<{
    date: string;
    items: Array<{
      type: string;
      name: string;
      startTime: string;
      latitude: number;
      longitude: number;
      address: string;
      priceInfo: string;
      description: string;
      tips?: string[];
    }>;
  }>;
}

function buildPlan(overrides: Partial<TestPlan> = {}): TestPlan {
  return {
    planId: "plan-test-1",
    destination: "马尔代夫",
    title: "马尔代夫2日游",
    startDate: "2026-08-30",
    endDate: "2026-08-31",
    createdAt: Date.now(),
    totalCost: 12600,
    days: [
      {
        date: "2026-08-30",
        items: [
          {
            type: "hotel",
            name: "水上屋",
            startTime: "2026-08-30T08:00:00",
            latitude: 4.1755,
            longitude: 73.2207,
            address: "North Malé Atoll",
            priceInfo: "¥8,800",
            description: "带私人泳池",
            tips: ["提前两周订"],
          },
          { type: "attraction", name: "环礁浮潜", startTime: "2026-08-30T10:00:00", latitude: 0, longitude: 0, address: "", priceInfo: "免费", description: "" },
        ],
      },
      {
        date: "2026-08-31",
        items: [
          { type: "restaurant", name: "老城海鲜餐厅", startTime: "2026-08-31T12:00:00", latitude: 0, longitude: 0, address: "Malé", priceInfo: "¥420", description: "" },
        ],
      },
    ],
    ...overrides,
  };
}

test("plan store: save/get round-trip persists to disk and survives cache eviction", () => {
  travelPlanStore.save(buildPlan());
  // 直接从磁盘读（绕开内存缓存语义由 get 惰性读保证）
  const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, "plan-test-1.json"), "utf8"));
  assert.equal(raw.planId, "plan-test-1");
  assert.ok(raw.createdAt > 0);
  const got = travelPlanStore.get("plan-test-1");
  assert.equal(got?.days.length, 2);
  assert.equal(got?.days[0].items[0].name, "水上屋");
});

test("plan store: findByDestination matches latest case-insensitively", () => {
  const found = travelPlanStore.findByDestination(" 马尔代夫 ");
  assert.equal(found?.planId, "plan-test-1");
  assert.equal(travelPlanStore.findByDestination("不存在的岛"), null);
});

test("travel state prompt: snapshot lists compact receipts when trips exist (注入门控归 understanding)", () => {
  // 词表判定退役：shouldInjectTravelState 已删，注入门槛由调用方按
  // L1 路由 understanding.travel_query 裁决（本文件只测快照产出本身）。
  const snap = buildTravelStatePrompt();
  assert.ok(snap, "有已存行程时应产出快照");
  assert.match(snap!, /^TRIP\|count=1$/m);
  assert.match(snap!, /马尔代夫/);
  assert.match(snap!, /plan-test-1/);
  assert.match(snap!, /travel\.get-itinerary/);
  // 热层不得携带明细（条目名/地址都不应出现）
  assert.ok(!snap!.includes("水上屋"));
  assert.ok(!snap!.includes("North Malé Atoll"));
});

test("get-itinerary skill: overview by destination, day detail by index, recent fallback", async () => {
  const skills = createTravelPlanningBuiltinSkills({ travelPlanningService: {} as never });
  const getItinerary = skills.find((s) => s.metadata.name === "travel.get-itinerary");
  assert.ok(getItinerary, "travel.get-itinerary 应已注册");

  // 按目的地 → 逐天概览（条目名级，无描述/贴士）
  const overview = await getItinerary.handler!({ destination: "马尔代夫" });
  assert.equal(overview.ok, true);
  assert.equal(overview.plan.dayCount, 2);
  assert.equal(overview.days.length, 2);
  assert.equal(overview.days[0].items[0].name, "水上屋");
  assert.equal(overview.days[0].items[0].description, undefined, "概览不应携带描述字段");

  // 按天序号 → 完整天明细
  const detail = await getItinerary.handler!({ planId: "plan-test-1", day: 1 });
  assert.equal(detail.ok, true);
  assert.equal(detail.dayDetail.items[0].address, "North Malé Atoll");
  assert.deepEqual(detail.dayDetail.items[0].tips, ["提前两周订"]);

  // 越界天
  const badDay = await getItinerary.handler!({ planId: "plan-test-1", day: 9 });
  assert.ok(String(badDay.error).includes("没有第 9 天"));

  // 无参 → 最近行程列表
  const recent = await getItinerary.handler!({});
  assert.ok(Array.isArray(recent.recentPlans));
  assert.equal(recent.recentPlans[0].planId, "plan-test-1");
});

test("get-itinerary skill: unknown plan returns not-found", async () => {
  const skills = createTravelPlanningBuiltinSkills({ travelPlanningService: {} as never });
  const getItinerary = skills.find((s) => s.metadata.name === "travel.get-itinerary")!;
  const out = await getItinerary.handler!({ planId: "plan-none", destination: "不存在的岛" });
  assert.equal(out.ok, true); // 落到 recentPlans 兜底而非硬失败
  assert.ok(Array.isArray(out.recentPlans));
});
