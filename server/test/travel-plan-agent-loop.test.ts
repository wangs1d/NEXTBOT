import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 行程 Agent 能力路由测试（进度 / 实时信号 / 时间锚点）。
 *
 * 覆盖：
 * - PATCH/GET /travel/plans/:planId/progress：进度上报与读取（设备状态，
 *   不自增编辑乐观锁版本）
 * - GET /travel/plans/:planId/signal：behind 判定（当天行程 + 进度站点
 *   时段已过）与无信号路径
 * - POST days/:i/items 显式 startTime → 条目带 anchor=true（时间锚点）
 *
 * 运行：npx tsx --test test/travel-plan-agent-loop.test.ts
 */

// 环境变量须在模块导入前设置（store 单例构造时读取）
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "travel-agent-loop-test-"));
process.env.TRAVEL_PLAN_STORE_DIR = path.join(tmpDir, "plans");
process.env.TRAVEL_SHARE_STORE_FILE = path.join(tmpDir, "share-codes.json");

const { travelPlanStore } = await import(
  "../src/skills/travel-planning/travel-plan-store.js"
);
type StoredTravelPlan = import("../src/skills/travel-planning/travel-plan-store.js").StoredTravelPlan;
const { registerTravelPlanRoutes } = await import("../src/routes/http/travel-plan.js");
const { default: Fastify } = await import("fastify");
import type { PlanningService } from "../src/skills/travel-planning/travel-planning-service.js";

const two = (v: number): string => v.toString().padStart(2, "0");
const now = new Date();
const today = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;

function buildPlan(): StoredTravelPlan {
  const item = (over: Partial<StoredTravelPlan["days"][number]["items"][number]> = {}) => ({
    type: "attraction",
    name: "默认景点",
    startTime: `${today}T09:00:00`,
    latitude: 3.12,
    longitude: 73.22,
    address: "默认地址",
    priceInfo: "¥100",
    description: "默认描述",
    ...over,
  });
  return {
    planId: "plan-agent-loop-1",
    destination: "兴义",
    title: "万峰林2日游",
    startDate: today,
    endDate: today,
    center: { latitude: 25.08, longitude: 104.9 },
    createdAt: Date.now(),
    days: [
      {
        date: today,
        items: [
          item({ type: "hotel", name: "峰林民宿", startTime: `${today}T08:00:00` }),
          item({ name: "万峰林景区", startTime: `${today}T00:00:00`, visitDuration: 60 }),
          item({ type: "restaurant", name: "蛋炒饭一条街", startTime: `${today}T12:30:00` }),
        ],
      },
    ],
  };
}

travelPlanStore.save(buildPlan());

/** 最小桩：只带 signalWeather（返回非雨天），重排 no-op */
function makeStubService(): PlanningService {
  return {
    signalWeather: async () => ({ summaryLine: "晴 22°C", rainy: false }),
    searchPois: async () => [
      {
        name: "马岭河峡谷",
        type: "attraction",
        latitude: 3.14,
        longitude: 73.24,
        address: "峡谷路1号",
        priceInfo: "¥80",
        tags: ["公园"],
      },
    ],
    retimeDayAfterEdit: async () => ({ dayEndMin: 0 }),
    describePoi: (poi: { name: string }, type: string) => `${poi.name}（${type}）描述`,
  } as unknown as PlanningService;
}

const app = Fastify({ logger: false });
registerTravelPlanRoutes(app, { travelPlanningService: makeStubService() });

// ────────────────────────────────────────────────────────────
// 行程进度
// ────────────────────────────────────────────────────────────

test("PATCH progress：上报进度并落盘，不自增编辑乐观锁版本", async () => {
  const before = travelPlanStore.get("plan-agent-loop-1")!.version ?? 0;
  const res = await app.inject({
    method: "PATCH",
    url: "/travel/plans/plan-agent-loop-1/progress",
    payload: { day: 0, stop: 2 },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { ok: boolean; progress: { day: number; stop: number } };
  assert.equal(body.ok, true);
  assert.equal(body.progress.day, 0);
  assert.equal(body.progress.stop, 2);
  const after = travelPlanStore.get("plan-agent-loop-1")!;
  assert.equal(after.progress?.stop, 2);
  assert.equal(after.version ?? 0, before, "进度更新不应自增版本");
});

test("GET progress：往返读取；未知行程 404", async () => {
  const res = await app.inject({ method: "GET", url: "/travel/plans/plan-agent-loop-1/progress" });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { ok: boolean; progress: { stop: number } | null };
  assert.equal(body.ok, true);
  assert.equal(body.progress?.stop, 2);

  const missing = await app.inject({ method: "GET", url: "/travel/plans/plan-nope/progress" });
  assert.equal(missing.statusCode, 404);
});

// ────────────────────────────────────────────────────────────
// 实时信号
// ────────────────────────────────────────────────────────────

test("GET signal：进度站点的建议时段已过 → behind", async () => {
  // 进度指向 stop=1（万峰林景区 startTime=T00:00、visitDuration=60 → 结束于
  // 01:00），已远超当前时刻 + 20 分钟宽限 → behind
  await app.inject({
    method: "PATCH",
    url: "/travel/plans/plan-agent-loop-1/progress",
    payload: { day: 0, stop: 1 },
  });
  const res = await app.inject({ method: "GET", url: "/travel/plans/plan-agent-loop-1/signal" });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { ok: boolean; event: string | null; mood: string | null };
  assert.equal(body.ok, true);
  assert.equal(body.event, "behind");
  assert.equal(body.mood, "追赶中");
});

test("GET signal：进度不在当天 / 无进度 → 无事件", async () => {
  // 进度指向不存在的 day → 当天匹配失败 → event=null
  await app.inject({
    method: "PATCH",
    url: "/travel/plans/plan-agent-loop-1/progress",
    payload: { day: 5, stop: 0 },
  });
  const res = await app.inject({ method: "GET", url: "/travel/plans/plan-agent-loop-1/signal" });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { ok: boolean; event: string | null };
  assert.equal(body.event, null);
});

// ────────────────────────────────────────────────────────────
// 时间锚点
// ────────────────────────────────────────────────────────────

test("POST days/:i/items 显式 startTime → 条目带 anchor=true", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/travel/plans/plan-agent-loop-1/days/0/items",
    headers: { "if-match": String(travelPlanStore.get("plan-agent-loop-1")!.version ?? 0) },
    payload: { type: "attraction", name: "马岭河峡谷", startTime: "15:30" },
  });
  assert.equal(res.statusCode, 200);
  const plan = res.json() as StoredTravelPlan;
  const added = plan.days[0]!.items.at(-1)!;
  assert.equal(added.name, "马岭河峡谷");
  assert.equal(added.anchor, true);
  // 未显式指定 startTime 的既有条目不受影响
  assert.equal(plan.days[0]!.items[1]!.anchor ?? false, false);
});
