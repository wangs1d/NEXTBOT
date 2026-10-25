import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 行程 HTTP 路由域（routes/http/travel-plan.ts）测试。
 *
 * 用真实 fastify 实例 + inject（不起监听端口）：
 * - PATCH/DELETE 按索引编辑行程条目（含越界 400）
 * - comment「提意见换一个」：替换 POI / 缺 service 503 / 无候选 404
 * - booking 预订报价（酒店×晚数 + 会员/平台折扣）
 * - share 分享码往返（生成 → 读取 → 同 plan 复用）
 *
 * 运行：npx tsx --test test/travel-plan-routes.test.ts
 */

// 环境变量须在模块导入前设置（travel-plan-store / travel-share-store 单例构造时读取）
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "travel-plan-routes-test-"));
process.env.TRAVEL_PLAN_STORE_DIR = path.join(tmpDir, "plans");
process.env.TRAVEL_SHARE_STORE_FILE = path.join(tmpDir, "share-codes.json");

const { travelPlanStore } = await import(
  "../src/skills/travel-planning/travel-plan-store.js"
);
type StoredTravelPlan = import("../src/skills/travel-planning/travel-plan-store.js").StoredTravelPlan;
const { travelShareStore } = await import("../src/skills/travel-planning/travel-share-store.js");
const { registerTravelPlanRoutes } = await import("../src/routes/http/travel-plan.js");
const { default: Fastify } = await import("fastify");
import type { PlanningService } from "../src/skills/travel-planning/travel-planning-service.js";

// ────────────────────────────────────────────────────────────
// 夹具：两日行程（酒店/景点/餐厅），落盘进 store
// ────────────────────────────────────────────────────────────

function buildPlan(): StoredTravelPlan {
  const item = (over: Partial<StoredTravelPlan["days"][number]["items"][number]> = {}) => ({
    type: "attraction",
    name: "默认景点",
    startTime: "2026-08-30T09:00:00",
    latitude: 3.12,
    longitude: 73.22,
    address: "默认地址",
    priceInfo: "¥100",
    description: "默认描述",
    ...over,
  });
  return {
    planId: "plan-routes-test-1",
    destination: "马尔代夫",
    title: "马尔代夫2日游",
    startDate: "2026-08-30",
    endDate: "2026-08-31",
    createdAt: Date.now(),
    days: [
      {
        date: "2026-08-30",
        items: [
          item({ type: "hotel", name: "海景酒店A", priceInfo: "¥1880" }),
          item({ type: "attraction", name: "环礁浮潜点", priceInfo: "免费" }),
          item({ type: "restaurant", name: "海景餐厅A", priceInfo: "¥280" }),
        ],
      },
      {
        date: "2026-08-31",
        items: [
          item({ type: "hotel", name: "潟湖别墅B", startTime: "2026-08-31T14:00:00" }),
          item({ type: "restaurant", name: "沙滩餐厅B" }),
        ],
      },
    ],
  };
}

travelPlanStore.save(buildPlan());

/** 备选 POI（findAlternativePoi 的桩返回值） */
const alternativePoi = {
  id: "poi-alt-1",
  name: "珊瑚礁餐厅C",
  latitude: 3.13,
  longitude: 73.23,
  address: "珊瑚礁路1号",
  type: "restaurant",
  tags: ["seafood", "海鲜"],
  images: ["https://example.com/coral.jpg"],
};

/** 桩 PlanningService：只实现路由域用到的公开方法 */
function makeStubService(options: { alternative?: typeof alternativePoi | null } = {}): PlanningService {
  return {
    findAlternativePoi: async (_type, _lat, _lng, excludeName) => {
      if (options.alternative === null) return null; // 显式注入 null：模拟「附近无候选」
      if (excludeName !== "海景餐厅A") return null;
      return options.alternative ?? alternativePoi;
    },
    describePoi: (poi: { name: string }, type: string) => `${poi.name}（${type}）规划引擎描述`,
    searchPois: async () => [
      {
        name: "备选景点D",
        type: "attraction",
        latitude: 3.14,
        longitude: 73.24,
        address: "备选路2号",
        priceInfo: "¥80",
        tags: ["公园"],
      },
    ],
    // 编辑路由在坐标变更/替换/删除后会调用局部重排（P0）；桩用 no-op 保持断言口径
    retimeDayAfterEdit: async () => ({ dayEndMin: 0 }),
  } as unknown as PlanningService;
}

function buildApp(service?: PlanningService) {
  const app = Fastify({ logger: false });
  registerTravelPlanRoutes(app, service ? { travelPlanningService: service } : {});
  return app;
}

const app = buildApp(makeStubService());
const appNoService = buildApp();

// ────────────────────────────────────────────────────────────
// 编辑：PATCH / DELETE
// ────────────────────────────────────────────────────────────

test("PATCH 替换条目：指定字段覆盖、其余保留，并落盘（响应顶层即 plan）", async () => {
  const res = await app.inject({
    method: "PATCH",
    url: "/travel/plans/plan-routes-test-1/days/0/items/1",
    payload: { name: "月亮沙滩", priceInfo: "¥60", latitude: 3.15 },
  });
  assert.equal(res.statusCode, 200);
  const plan = res.json() as StoredTravelPlan;
  const patched = plan.days[0]!.items[1]!;
  assert.equal(patched.name, "月亮沙滩");
  assert.equal(patched.priceInfo, "¥60");
  assert.equal(patched.latitude, 3.15);
  // 未提供的字段保留原值
  assert.equal(patched.startTime, "2026-08-30T09:00:00");
  assert.equal(patched.type, "attraction");
  assert.equal(patched.address, "默认地址");
  // 已落盘（重新从 store 读取可见）
  assert.equal(travelPlanStore.get("plan-routes-test-1")?.days[0]?.items[1]?.name, "月亮沙滩");
});

test("PATCH 索引越界返回 400，非法 body 返回 400", async () => {
  const res = await app.inject({
    method: "PATCH",
    url: "/travel/plans/plan-routes-test-1/days/9/items/0",
    payload: { name: "越界" },
  });
  assert.equal(res.statusCode, 400);
  const resItem = await app.inject({
    method: "PATCH",
    url: "/travel/plans/plan-routes-test-1/days/0/items/99",
    payload: { name: "越界" },
  });
  assert.equal(resItem.statusCode, 400);
  const resBody = await app.inject({
    method: "PATCH",
    url: "/travel/plans/plan-routes-test-1/days/0/items/0",
    payload: { name: "" },
  });
  assert.equal(resBody.statusCode, 400);
});

test("DELETE 删除条目：条目移除、同日其余保留（响应顶层即 plan）", async () => {
  const res = await app.inject({
    method: "DELETE",
    url: "/travel/plans/plan-routes-test-1/days/1/items/1",
  });
  assert.equal(res.statusCode, 200);
  const plan = res.json() as StoredTravelPlan;
  assert.equal(plan.planId, "plan-routes-test-1");
  const items = plan.days[1]!.items;
  assert.equal(items.length, 1);
  assert.equal(items[0]!.name, "潟湖别墅B");
  assert.ok(!items.some((i) => i.name === "沙滩餐厅B"));
});

test("乐观锁往返：编辑响应回带的 version 可直接用于下一次编辑（桌面连改两站不 409）", async () => {
  // 桌面页就地编辑是「拿上一份响应里的 version 发下一次请求」——若 save 只把
  // 自增后的版本写进克隆、不回写响应载荷，第二次请求就永远基于旧版本 → 必 409
  travelPlanStore.save({ ...buildPlan(), planId: "plan-lock-chain", createdAt: Date.now() });
  const v0 = travelPlanStore.get("plan-lock-chain")!.version;
  const first = await app.inject({
    method: "DELETE",
    url: "/travel/plans/plan-lock-chain/days/0/items/0",
    headers: { "x-plan-version": String(v0) },
  });
  assert.equal(first.statusCode, 200);
  const v1 = (first.json() as StoredTravelPlan).version;
  assert.equal(v1, (v0 ?? 0) + 1, "响应必须回带自增后的版本，而不是请求基于的那一版");
  const second = await app.inject({
    method: "DELETE",
    url: "/travel/plans/plan-lock-chain/days/0/items/0",
    headers: { "x-plan-version": String(v1) },
  });
  assert.equal(second.statusCode, 200);
  assert.deepEqual(
    (second.json() as StoredTravelPlan).days[0]!.items.map((i) => i.name),
    ["海景餐厅A"],
  );
  // 真正过期的版本仍然要挡（乐观锁本身没被削弱）
  const stale = await app.inject({
    method: "DELETE",
    url: "/travel/plans/plan-lock-chain/days/0/items/0",
    headers: { "x-plan-version": String(v0) },
  });
  assert.equal(stale.statusCode, 409);
});

test("GET 完整行程：存在返回 plan，不存在返回 404", async () => {
  const ok = await app.inject({ method: "GET", url: "/travel/plans/plan-routes-test-1" });
  assert.equal(ok.statusCode, 200);
  assert.equal((ok.json() as { plan: StoredTravelPlan }).plan.destination, "马尔代夫");
  const missing = await app.inject({ method: "GET", url: "/travel/plans/plan-not-exist" });
  assert.equal(missing.statusCode, 404);
});

// ────────────────────────────────────────────────────────────
// comment「提意见换一个」
// ────────────────────────────────────────────────────────────

test("comment 缺 service 时返回 503", async () => {
  const res = await appNoService.inject({
    method: "POST",
    url: "/travel/plans/plan-routes-test-1/days/0/items/2/comment",
    payload: { comment: "太贵了，换一家" },
  });
  assert.equal(res.statusCode, 503);
});

test("comment 替换为同类 POI：保留 startTime、重新计价、清空旧媒体（响应顶层即 plan）", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/travel/plans/plan-routes-test-1/days/0/items/2/comment",
    payload: { comment: "想吃海鲜，换一家" },
  });
  assert.equal(res.statusCode, 200);
  const plan = res.json() as StoredTravelPlan;
  assert.equal(plan.planId, "plan-routes-test-1");
  const replaced = plan.days[0]!.items[2]!;
  assert.equal(replaced.name, "珊瑚礁餐厅C");
  assert.equal(replaced.address, "珊瑚礁路1号");
  assert.equal(replaced.startTime, "2026-08-30T09:00:00"); // 保留原时间
  assert.ok(replaced.priceInfo.length > 0); // PricingService 重新计价
  assert.deepEqual(replaced.images, ["https://example.com/coral.jpg"]);
  assert.deepEqual(replaced.reviews, []);
});

test("comment 无替代候选时返回 404，条目保持不变", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/travel/plans/plan-routes-test-1/days/0/items/1/comment",
    payload: { comment: "换一个景点" },
  });
  assert.equal(res.statusCode, 404);
  assert.equal(
    travelPlanStore.get("plan-routes-test-1")?.days[0]?.items[1]?.name,
    "月亮沙滩",
  );
});

// ────────────────────────────────────────────────────────────
// POI 搜索（单项编辑器）
// ────────────────────────────────────────────────────────────

test("poi-search 返回备选 POI 列表（含 priceInfo）", async () => {
  const res = await app.inject({
    method: "GET",
    url: "/travel/poi-search?destination=马尔代夫&type=attraction",
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { ok: boolean; pois: Array<{ name: string; priceInfo: string }> };
  assert.equal(body.ok, true);
  assert.equal(body.pois.length, 1);
  assert.equal(body.pois[0]!.name, "备选景点D");
  assert.ok(body.pois[0]!.priceInfo.length > 0);
});

// ────────────────────────────────────────────────────────────
// 预订报价
// ────────────────────────────────────────────────────────────

test("booking 按酒店×晚数/门票×1/餐厅×1 报价，会员+平台折扣生效", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/travel/plans/plan-routes-test-1/booking",
    payload: {
      memberTier: "gold",
      boundPlatforms: ["ctrip", { platform: "agoda", accountLevel: "gold", displayName: "Agoda" }],
    },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as {
    ok: boolean;
    items: Array<{ name: string; type: string; unitPrice: number; count: number; originalPrice: number; finalPrice: number; discounts: Record<string, unknown> }>;
    totalOriginal: number;
    totalFinal: number;
    totalSaved: number;
  };
  assert.equal(body.ok, true);
  // 夹具（经 DELETE/comment 后）：2 天 → 酒店 2 处 × 2 晚，景点 1 × 1，餐厅 1 × 1
  const hotels = body.items.filter((i) => i.type === "hotel");
  assert.equal(hotels.length, 2);
  assert.ok(hotels.every((h) => h.count === 2));
  assert.equal(body.items.filter((i) => i.type === "attraction").length, 1);
  assert.equal(body.items.filter((i) => i.type === "restaurant").length, 1);
  // 逐项明细与总额自洽
  const sumOriginal = body.items.reduce((acc, i) => acc + i.originalPrice, 0);
  const sumFinal = body.items.reduce((acc, i) => acc + i.finalPrice, 0);
  assert.equal(body.totalOriginal, sumOriginal);
  assert.equal(body.totalFinal, sumFinal);
  assert.equal(body.totalSaved, body.totalOriginal - body.totalFinal);
  // 金卡 + 绑定平台 → 折扣真实生效（finalPrice < originalPrice，明细含会员/平台项）
  assert.ok(body.totalFinal < body.totalOriginal);
  const hotelQuote = hotels[0]!;
  // discounts 为标签数组（前端直接展示），明细在 discountDetail
  assert.ok(Array.isArray(hotelQuote.discounts));
  assert.ok(hotelQuote.discounts.some((l: string) => l.includes("金卡")));
  assert.ok("member" in (hotelQuote.discountDetail ?? {}));
  assert.ok(Array.isArray(hotelQuote.discountDetail?.platformBenefits));
  // unitPrice 为折后单价
  assert.ok(hotels.every((h: { unitPrice: number }) => h.unitPrice * h.count === h.finalPrice));
});

test("booking 无会员无平台时 finalPrice == originalPrice", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/travel/plans/plan-routes-test-1/booking",
    payload: {},
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { totalOriginal: number; totalFinal: number; totalSaved: number };
  assert.equal(body.totalFinal, body.totalOriginal);
  assert.equal(body.totalSaved, 0);
});

// ────────────────────────────────────────────────────────────
// 分享码往返
// ────────────────────────────────────────────────────────────

test("share 往返：生成 8 位码 → 按码读回完整 plan → 同 plan 复用同码", async () => {
  const created = await app.inject({ method: "POST", url: "/travel/plans/plan-routes-test-1/share" });
  assert.equal(created.statusCode, 200);
  const { shareCode } = created.json() as { ok: boolean; shareCode: string };
  assert.match(shareCode, /^[A-HJ-KM-NP-Z2-9]{8}$/);

  const read = await app.inject({ method: "GET", url: `/travel/share/${shareCode}` });
  assert.equal(read.statusCode, 200);
  const body = read.json() as { ok: boolean; plan: StoredTravelPlan };
  assert.equal(body.plan.planId, "plan-routes-test-1");
  assert.equal(body.plan.destination, "马尔代夫");

  // 重复分享复用已有码
  const again = await app.inject({ method: "POST", url: "/travel/plans/plan-routes-test-1/share" });
  assert.equal((again.json() as { shareCode: string }).shareCode, shareCode);

  // 码已持久化（新 store 实例也能解析：模拟重启）
  assert.equal(travelShareStore.resolve(shareCode.toLowerCase()), "plan-routes-test-1");

  // 非法码 400，未知码 404
  assert.equal((await app.inject({ method: "GET", url: "/travel/share/!!" })).statusCode, 400);
  assert.equal((await app.inject({ method: "GET", url: "/travel/share/AAAA2222" })).statusCode, 404);
});

// ────────────────────────────────────────────────────────────
// 未装配 service 的降级 / 端点自述
// ────────────────────────────────────────────────────────────

test("缺 service 时数据端点 503，_meta 仍可用", async () => {
  const list = await appNoService.inject({ method: "GET", url: "/travel/plans" });
  assert.equal(list.statusCode, 503);
  const detail = await appNoService.inject({ method: "GET", url: "/travel/plans/plan-routes-test-1" });
  assert.equal(detail.statusCode, 503);
  const booking = await appNoService.inject({
    method: "POST",
    url: "/travel/plans/plan-routes-test-1/booking",
    payload: {},
  });
  assert.equal(booking.statusCode, 503);
  const share = await appNoService.inject({ method: "POST", url: "/travel/plans/plan-routes-test-1/share" });
  assert.equal(share.statusCode, 503);
  const meta = await appNoService.inject({ method: "GET", url: "/travel/plans/_meta" });
  assert.equal(meta.statusCode, 200);
  const metaBody = meta.json() as { domain: string; endpoints: string[] };
  assert.equal(metaBody.domain, "travel-plan");
  assert.ok(metaBody.endpoints.length >= 9);
});

// ────────────────────────────────────────────────────────────
// 归档页摘要扩展（stopCount / progress）与整体删除
// ────────────────────────────────────────────────────────────

test("列表摘要携带 stopCount 与 progress（归档页免二次请求）", async () => {
  travelPlanStore.updateProgress("plan-routes-test-1", 1, 1);
  const res = await app.inject({ method: "GET", url: "/travel/plans" });
  assert.equal(res.statusCode, 200);
  const body = res.json() as {
    ok: boolean;
    plans: Array<{ planId: string; dayCount: number; stopCount: number; progress?: { day: number; stop: number } }>;
  };
  const plan = body.plans.find((p) => p.planId === "plan-routes-test-1");
  assert.ok(plan);
  // 前文用例已从 Day1 删除一条条目：Day1 剩两项 + Day2 两项 = 4
  assert.equal(plan!.stopCount, 4);
  assert.equal(plan!.dayCount, 2);
  assert.deepEqual(plan!.progress, { day: 1, stop: 1 });
});

test("DELETE 整份行程：落盘/内存/分享码映射清理，二次删除 404", async () => {
  // 先生成分享码，验证删除时被一并清理
  const share = await app.inject({ method: "POST", url: "/travel/plans/plan-routes-test-1/share" });
  const { shareCode } = share.json() as { shareCode: string };
  assert.ok(shareCode);

  const res = await app.inject({ method: "DELETE", url: "/travel/plans/plan-routes-test-1" });
  assert.equal(res.statusCode, 200);
  assert.equal((res.json() as { ok: boolean }).ok, true);

  // 完整行程 404、列表不含、store 无痕、分享码失效
  assert.equal((await app.inject({ method: "GET", url: "/travel/plans/plan-routes-test-1" })).statusCode, 404);
  const list = await app.inject({ method: "GET", url: "/travel/plans" });
  const plans = (list.json() as { plans: Array<{ planId: string }> }).plans;
  assert.ok(!plans.some((p) => p.planId === "plan-routes-test-1"));
  assert.equal(travelPlanStore.get("plan-routes-test-1"), null);
  assert.equal(travelShareStore.resolve(shareCode), null);

  // 二次删除 404
  const again = await app.inject({ method: "DELETE", url: "/travel/plans/plan-routes-test-1" });
  assert.equal(again.statusCode, 404);
});
