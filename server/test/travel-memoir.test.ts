import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 行后旅行回忆录测试（travel 双端⑦）：
 *
 * 1. recordVisit：到访足迹落盘 + 同站去重
 * 2. TravelMemoirService.build：足迹合并（visited/arrivedAt）、照片计数、
 *    订单过滤（travel/ride 域、非取消、行程区间内）、账本支出分类聚合
 * 3. 路由：GET /travel-map/memoir 出长页；/travel-map/memoir/data 聚合下发；
 *    导航 arrive → 足迹自动落盘
 *
 * 运行：npx tsx --test test/travel-memoir.test.ts
 */

// 环境变量须在模块导入前设置（travel-plan-store/poi-cache 单例构造时读取）
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "travel-memoir-test-"));
process.env.TRAVEL_PLAN_STORE_DIR = path.join(tmpDir, "plans");
process.env.TRAVEL_POI_DB_DIR = path.join(tmpDir, "poi");

const { travelPlanStore } = await import(
  "../src/skills/travel-planning/travel-plan-store.js"
);
type StoredTravelPlan = import("../src/skills/travel-planning/travel-plan-store.js").StoredTravelPlan;
const { TravelMemoirService } = await import(
  "../src/services/travel-memoir-service.js"
);
const { travelMemoir } = await import("../src/services/travel-memoir-service.js");
const { BookingOrderStore, newBookingOrderId, localDateKey } = await import(
  "../src/services/booking/booking-order-store.js"
);
const { FinanceDeepService } = await import(
  "../src/services/finance-deep-service.js"
);
const Fastify = (await import("fastify")).default;
const { registerTravelMapRoutes } = await import("../src/routes/http/travel-map.js");

const today = localDateKey(new Date());
const d = (offset: number) => localDateKey(new Date(Date.now() + offset * 86_400_000));

let planSeq = 0;
function savePlan(over: Partial<StoredTravelPlan> = {}): StoredTravelPlan {
  const plan = {
    planId: `memoir-${++planSeq}`,
    sessionId: "actor-a",
    destination: "成都",
    title: "成都3日游",
    startDate: d(-2),
    endDate: d(0),
    intro: "一休闲一辣的吃逛之旅",
    createdAt: Date.now() + planSeq,
    days: [
      {
        date: d(-2),
        items: [
          {
            type: "attraction", name: "宽窄巷子", startTime: "09:00",
            latitude: 30.66, longitude: 104.05, address: "青羊区宽窄巷子",
            priceInfo: "免费", description: "", images: ["http://local/img/a1.jpg"],
          },
          {
            type: "restaurant", name: "马路边边", startTime: "12:00",
            latitude: 30.66, longitude: 104.06, address: "致民路",
            priceInfo: "人均 80 元", description: "", images: [],
          },
        ],
      },
      {
        date: d(-1),
        items: [
          {
            type: "attraction", name: "大熊猫基地", startTime: "08:30",
            latitude: 30.73, longitude: 104.14, address: "外北熊猫大道",
            priceInfo: "门票 55 元", description: "", images: [],
          },
        ],
      },
    ],
    ...over,
  } as StoredTravelPlan;
  travelPlanStore.save(plan);
  return plan;
}

function makeOrders(
  rows: Array<Partial<import("../src/services/booking/booking-order-store.js").StoredBookingOrder>>,
): BookingOrderStore {
  const store = new BookingOrderStore(null);
  for (const o of rows) {
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
  return store;
}

function makeFinance(): FinanceDeepService {
  // 账本数据根目录落在临时目录，测试间互不串账
  const root = fs.mkdtempSync(path.join(tmpDir, "finance-"));
  return new FinanceDeepService(root, () => new Date());
}

// ==================== recordVisit ====================

test("memoir: recordVisit 落盘足迹 + 同站去重", () => {
  const plan = savePlan({ planId: "memoir-visit" });
  assert.ok(travelPlanStore.recordVisit("memoir-visit", { day: 0, stop: 0, name: "宽窄巷子", arrivedAt: 1000 }));
  assert.ok(travelPlanStore.recordVisit("memoir-visit", { day: 1, stop: 0, name: "大熊猫基地", arrivedAt: 2000 }));
  // 同站重复到达只保留首次
  assert.ok(travelPlanStore.recordVisit("memoir-visit", { day: 0, stop: 0, name: "宽窄巷子", arrivedAt: 3000 }));
  const got = travelPlanStore.get("memoir-visit");
  assert.equal(got?.visits?.length, 2);
  assert.equal(got?.visits?.[0]?.arrivedAt, 1000);
  assert.equal(plan.planId, "memoir-visit");
});

// ==================== TravelMemoirService.build ====================

test("memoir: build 聚合足迹/照片/订单过滤/账本分类", async () => {
  savePlan({ planId: "memoir-build" });
  travelPlanStore.recordVisit("memoir-build", { day: 0, stop: 0, name: "宽窄巷子", arrivedAt: 1111 });
  const orders = makeOrders([
    { title: "宽窄巷子讲解服务", amountCny: 60, domain: "travel", dateKey: d(-2) },
    { title: "打车去基地", amountCny: 40, domain: "ride", dateKey: d(-1) },
    { title: "日常外卖", amountCny: 30, domain: "restaurant", dateKey: d(-2) }, // 日常域不算
    { title: "已取消的门票", amountCny: 55, domain: "travel", status: "cancelled", dateKey: d(-1) },
    { title: "行程前的机票", amountCny: 500, domain: "travel", dateKey: d(-9) }, // 区间外
    { title: "别人的订单", amountCny: 999, actorId: "actor-b", dateKey: d(-2) },
  ]);
  const finance = makeFinance();
  await finance.importTransactions("actor-a", [
    { id: "t1", date: `${d(-2)}T12:00:00`, amount: 88, type: "expense", category: "餐饮" },
    { id: "t2", date: `${d(-1)}T15:00:00`, amount: 55, type: "expense", category: "交通" },
    { id: "t3", date: `${d(-9)}T15:00:00`, amount: 5000, type: "expense", category: "购物" }, // 区间外
    { id: "t4", date: `${d(-2)}T10:00:00`, amount: 300, type: "income", category: "工资" }, // 收入不算
  ]);
  const svc = new TravelMemoirService({
    travelPlanStore,
    bookingOrderStore: orders,
    financeDeepService: finance,
  });
  const m = await svc.build("memoir-build");
  assert.ok(m);
  assert.equal(m.destination, "成都");
  assert.equal(m.intro, "一休闲一辣的吃逛之旅");
  // 足迹合并：3 站中第 1 站有真实到访
  assert.equal(m.stats.totalStops, 3);
  assert.equal(m.stats.visitedCount, 1);
  assert.equal(m.days[0]?.stops[0]?.visited, true);
  assert.equal(m.days[0]?.stops[0]?.arrivedAt, 1111);
  assert.equal(m.days[0]?.stops[1]?.visited, false);
  // 照片计数只算真实 URL
  assert.equal(m.stats.photoCount, 1);
  // 订单过滤：travel+ride 且在区间内且非取消 → 2 笔 100 元
  assert.equal(m.orders.length, 2);
  assert.equal(m.stats.orderTotal, 100);
  // 账本：区间内支出 2 笔 143 元，分类降序
  assert.ok(m.ledger);
  assert.equal(m.ledger.totalExpense, 143);
  assert.equal(m.ledger.count, 2);
  assert.equal(m.ledger.byCategory[0]?.category, "餐饮");
  // 坐标禁令：聚合输出不含经纬度字段
  assert.ok(!JSON.stringify(m).includes("latitude"));
});

test("memoir: 无行程 → null；无订单/账本源 → 对应块为空", async () => {
  const svc = new TravelMemoirService({ travelPlanStore });
  assert.equal(await svc.build("no-such-plan"), null);
  savePlan({ planId: "memoir-bare" });
  const m = await svc.build("memoir-bare");
  assert.ok(m);
  assert.deepEqual(m.orders, []);
  assert.equal(m.ledger, null);
  assert.equal(m.stats.orderTotal, 0);
});

// ==================== 路由 ====================

test("memoir: GET /travel-map/memoir 出长页；data 端点聚合下发 + 404", async () => {
  const app = Fastify();
  registerTravelMapRoutes(app);
  const page = await app.inject({ method: "GET", url: "/travel-map/memoir" });
  assert.equal(page.statusCode, 200);
  assert.match(page.headers["content-type"] as string, /text\/html/);
  assert.ok(page.body.includes("旅行回忆录"), "页面应带回忆录标识");
  assert.ok(page.body.includes("TRAVEL MEMOIR"), "页面应带长页结构");

  const miss = await app.inject({ method: "GET", url: "/travel-map/memoir/data?planId=no-such" });
  assert.equal(miss.statusCode, 404);
  const noParam = await app.inject({ method: "GET", url: "/travel-map/memoir/data" });
  assert.equal(noParam.statusCode, 400);

  // 装配最小依赖（单例 configure；订单/账本缺省 → 对应块为空）
  savePlan({ planId: "memoir-route" });
  travelMemoir.configure({ travelPlanStore });
  const ok = await app.inject({ method: "GET", url: "/travel-map/memoir/data?planId=memoir-route" });
  assert.equal(ok.statusCode, 200);
  const body = JSON.parse(ok.body) as { planId: string; destination: string };
  assert.equal(body.planId, "memoir-route");
  assert.equal(body.destination, "成都");
  await app.close();
});

test("memoir: 导航 arrive → 足迹自动落盘", async () => {
  const app = Fastify();
  registerTravelMapRoutes(app);
  const plan = savePlan({ planId: "memoir-nav" });
  const mk = await app.inject({
    method: "POST",
    url: "/travel-map/nav/session",
    payload: { planId: "memoir-nav", stops: [{ name: "宽窄巷子", lat: 30.66, lng: 104.05 }] },
  });
  assert.equal(mk.statusCode, 200);
  const arrived = await app.inject({
    method: "POST",
    url: "/travel-map/nav/arrive",
    payload: { planId: "memoir-nav" },
  });
  assert.equal(arrived.statusCode, 200);
  const got = travelPlanStore.get(plan.planId);
  assert.equal(got?.visits?.length, 1);
  assert.equal(got?.visits?.[0]?.name, "宽窄巷子");
  assert.equal(got?.visits?.[0]?.day, 0);
  await app.close();
});
