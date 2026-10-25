import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 行程预算守门测试（travel 双端⑥，travel-budget-guard-service）：
 *
 * 1. checkBudget 判定：无行程/无预算档/不在行程日期/未超支 → null；
 *    当日旅行消费（travel+ride 域）超档 → alert（日上限/第几天/金额正确）
 * 2. 非旅行域订单（restaurant/home_service）不计入
 *
 * 运行：npx tsx --test test/travel-budget-guard.test.ts
 */

// 环境变量须在模块导入前设置（travel-plan-store 单例构造时读取）
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "travel-budget-guard-test-"));
process.env.TRAVEL_PLAN_STORE_DIR = path.join(tmpDir, "plans");

const { TravelBudgetGuardService, BUDGET_DAILY_CAP_CNY } = await import(
  "../src/services/travel-budget-guard-service.js"
);
const { travelPlanStore } = await import(
  "../src/skills/travel-planning/travel-plan-store.js"
);
type StoredTravelPlan = import("../src/skills/travel-planning/travel-plan-store.js").StoredTravelPlan;
const { BookingOrderStore } = await import(
  "../src/services/booking/booking-order-store.js"
);
const { newBookingOrderId, localDateKey } = await import(
  "../src/services/booking/booking-order-store.js"
);

// ==================== checkBudget 判定 ====================

/** 今日与明日/昨日的本地日期键（行程区间构造用） */
const today = localDateKey(new Date());
const d = (offset: number) => localDateKey(new Date(Date.now() + offset * 86_400_000));

function makeGuard(orders: Array<Partial<import("../src/services/booking/booking-order-store.js").StoredBookingOrder>>) {
  const store = new BookingOrderStore(null);
  for (const o of orders) {
    void store.create({
      orderId: newBookingOrderId(),
      actorId: "actor-a",
      domain: "travel",
      provider: "stub",
      providerOrderId: null,
      title: "订单",
      amountCny: 0,
      status: "confirmed",
      scheduleAt: null,
      deadline: null,
      params: {},
      paymentUrl: null,
      commitmentId: null,
      simulated: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      dateKey: today,
      ...o,
    } as import("../src/services/booking/booking-order-store.js").StoredBookingOrder);
  }
  return new TravelBudgetGuardService({
    travelPlanStore,
    bookingOrderStore: store,
  });
}

let planSeq = 0;
function savePlan(planId: string, over: Partial<StoredTravelPlan> = {}): StoredTravelPlan {
  const plan = {
    planId,
    sessionId: "actor-a",
    destination: "成都",
    title: "成都3日游",
    startDate: d(0),
    endDate: d(2),
    // 唯一递增 createdAt：findActivePlan 按「最新保存」取进行中行程，同毫秒会取错
    createdAt: Date.now() + ++planSeq,
    days: [{ date: d(0), items: [] }],
    ...over,
  } as StoredTravelPlan;
  travelPlanStore.save(plan);
  return plan;
}

test("budget: 无行程/无预算档/不在行程日期/未超支 → 全部 null", async () => {
  const guard = makeGuard([]);
  assert.equal(await guard.checkBudget("actor-none"), null); // 无行程

  savePlan("bg-1"); // 无 budgetTier
  assert.equal(await guard.checkBudget("actor-a"), null); // 无档位不硬算

  savePlan("bg-2", { budgetTier: "mid", startDate: d(1), endDate: d(2) });
  assert.equal(await guard.checkBudget("actor-a"), null); // 行程明天才开始

  savePlan("bg-3", { budgetTier: "mid" }); // 日上限 800
  const guardSpend = makeGuard([{ amountCny: 500 }]);
  assert.equal(await guardSpend.checkBudget("actor-a"), null); // 未超支
});

test("budget: travel 域订单超档 → alert（跨单合计，第几天正确）", async () => {
  savePlan("bg-4", { budgetTier: "mid", startDate: d(-1), endDate: d(1) }); // 今天第 2 天
  const guard = makeGuard([
    { amountCny: 420, domain: "travel" },
    { amountCny: 480, domain: "ride" }, // ride 也计入旅行消费
  ]);
  const alert = await guard.checkBudget("actor-a");
  assert.ok(alert);
  assert.equal(alert.destination, "成都");
  assert.equal(alert.dayIndex, 2);
  assert.equal(alert.totalDays, 3);
  assert.equal(alert.dailyCap, BUDGET_DAILY_CAP_CNY.mid);
  assert.equal(alert.spentToday, 900);
  assert.ok(alert.ratio >= 1);
});

test("budget: 非旅行域不计入；cancelled 不计入；其他 actor 不串账", async () => {
  savePlan("bg-5", { budgetTier: "low" }); // 日上限 300
  const guard = makeGuard([
    { amountCny: 500, domain: "restaurant" }, // 日常餐饮不算旅行预算
    { amountCny: 900, domain: "travel", status: "cancelled" },
    { amountCny: 800, domain: "home_service" },
    { amountCny: 350, actorId: "actor-b", domain: "travel" }, // 别人的订单
  ]);
  assert.equal(await guard.checkBudget("actor-a"), null);
});

