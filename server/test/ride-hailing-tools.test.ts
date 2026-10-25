/**
 * 方案 B/C/D 单测：预订类能力模块 ToolRegistry 全链路（round trip）。
 *
 * 覆盖：
 *   1. ride_hailing.*：报价（位置联动 pickup 自动解析）→ 两阶段下单 →
 *      状态查询 → 两阶段取消；confirm=true 缺 token 拒绝
 *   2. home_service.*：搜索 → 下单 → 改期 → 取消（经 registry）
 *   3. restaurant.*：搜索（附近推荐提示）→ 两阶段订座
 *   4. 外层契约：handler 返回 { ok:false } 时 registry 外层仍 ok=true，
 *      业务成败看 result.ok（与 shopping-order 模块一致）
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  BookingOrderStore,
  BookingService,
  SimulatedHomeServiceProvider,
  SimulatedRestaurantProvider,
  SimulatedRideProvider,
} from "../src/services/booking/index.js";
import { ToolRegistry, type ToolContext } from "../src/tools/tool-registry.js";
import { registerRideHailingTools, RIDE_HAILING_CHAT_TOOLS } from "../src/tools/capability-modules/ride-hailing/index.js";
import { registerHomeServicesTools, HOME_SERVICES_CHAT_TOOLS } from "../src/tools/capability-modules/home-services/index.js";
import {
  registerRestaurantBookingTools,
  RESTAURANT_BOOKING_CHAT_TOOLS,
} from "../src/tools/capability-modules/restaurant-booking/index.js";

function makeContext(overrides?: Partial<ToolContext>): ToolContext {
  return {
    sessionId: "test-session-ride",
    userId: "test-user-ride",
    clientLocation: {
      latitude: 39.9087,
      longitude: 116.3975,
      city: "北京市",
      district: "东城区",
      label: "北京市 · 东城区",
    },
    ...overrides,
  };
}

async function withRegistry(
  fn: (registry: ToolRegistry) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "ride-tools-"));
  const service = new BookingService({
    providers: [
      new SimulatedRideProvider(),
      new SimulatedHomeServiceProvider(),
      new SimulatedRestaurantProvider(),
    ],
    store: new BookingOrderStore(null),
    config: { maxAmountCny: 1000, dailyBudgetCny: 500 },
  });
  const registry = new ToolRegistry();
  registerRideHailingTools(registry, { bookingService: service });
  registerHomeServicesTools(registry, { bookingService: service });
  registerRestaurantBookingTools(registry, { bookingService: service });
  try {
    await fn(registry);
  } finally {
    service.dispose();
    await rm(dir, { recursive: true, force: true });
  }
}

test("ride-hailing tools - 位置联动报价 + 两阶段下单 + 状态 + 取消", async () => {
  await withRegistry(async (registry) => {
    const ctx = makeContext();

    // 报价：pickup 缺省 → 自动取 clientLocation
    const quote = await registry.execute("ride_hailing.quote", { dropoff: "首都机场T3" }, ctx);
    assert.equal(quote.ok, true);
    assert.equal(quote.result.ok, true);
    assert.match(String(quote.result.pickupNote ?? ""), /当前位置/);
    const options = quote.result.options as Array<{ id: string }>;
    assert.ok(options.length >= 3);

    // 下单阶段一
    const stage1 = await registry.execute(
      "ride_hailing.book",
      { dropoff: "首都机场T3", optionId: options[0].id },
      ctx,
    );
    assert.equal(stage1.ok, true);
    assert.equal(stage1.result.ok, true);
    const token = stage1.result.confirmationToken as string;
    assert.ok(token);
    assert.equal(stage1.result.simulated, true);

    // confirm=true 缺 token → 拒绝
    const noToken = await registry.execute(
      "ride_hailing.book",
      { dropoff: "首都机场T3", optionId: options[0].id, confirm: true },
      ctx,
    );
    assert.equal(noToken.ok, true);
    assert.equal(noToken.result.ok, false);
    assert.match(String(noToken.result.error), /confirmationToken/);

    // 下单阶段二
    const stage2 = await registry.execute(
      "ride_hailing.book",
      { dropoff: "首都机场T3", optionId: options[0].id, confirm: true, confirmationToken: token },
      ctx,
    );
    assert.equal(stage2.ok, true);
    assert.equal(stage2.result.ok, true);
    const orderId = stage2.result.orderId as string;
    assert.match(orderId, /^bkg_/);

    // 状态查询
    const status = await registry.execute("ride_hailing.status", { orderId }, ctx);
    assert.equal(status.ok, true);
    assert.equal(status.result.ok, true);
    assert.equal((status.result.order as { status: string }).status, "confirmed");

    // 状态列表（不传 orderId）
    const list = await registry.execute("ride_hailing.status", {}, ctx);
    assert.equal(list.ok, true);
    assert.equal(list.result.ok, true);

    // 取消两阶段
    const cancel1 = await registry.execute("ride_hailing.cancel", { orderId }, ctx);
    assert.equal(cancel1.ok, true);
    assert.equal(cancel1.result.ok, true);
    const cancelToken = cancel1.result.confirmationToken as string;
    const cancel2 = await registry.execute(
      "ride_hailing.cancel",
      { orderId, confirm: true, confirmationToken: cancelToken, reason: "行程有变" },
      ctx,
    );
    assert.equal(cancel2.ok, true);
    assert.equal(cancel2.result.ok, true);
    assert.equal(cancel2.result.status, "cancelled");
  });
});

test("home-service tools - 搜索/下单/改期/取消", async () => {
  await withRegistry(async (registry) => {
    const ctx = makeContext();
    const scheduleAt = "2026-09-10T14:00:00+08:00";

    const search = await registry.execute(
      "home_service.search",
      { serviceType: "cleaning", address: "望京SOHO T1", scheduleAt },
      ctx,
    );
    assert.equal(search.ok, true);
    assert.equal(search.result.ok, true);

    const stage1 = await registry.execute(
      "home_service.book",
      { serviceType: "cleaning", optionId: "clean-deep", address: "望京SOHO T1", scheduleAt },
      ctx,
    );
    assert.equal(stage1.ok, true);
    assert.equal(stage1.result.ok, true);
    const token = stage1.result.confirmationToken as string;

    const stage2 = await registry.execute(
      "home_service.book",
      { serviceType: "cleaning", optionId: "clean-deep", address: "望京SOHO T1", scheduleAt, confirm: true, confirmationToken: token },
      ctx,
    );
    assert.equal(stage2.ok, true);
    assert.equal(stage2.result.ok, true);
    const orderId = stage2.result.orderId as string;

    const reschedule = await registry.execute(
      "home_service.reschedule",
      { orderId, scheduleAt: "2026-09-12T09:00:00+08:00" },
      ctx,
    );
    assert.equal(reschedule.ok, true);
    assert.equal(reschedule.result.ok, true);

    const cancel1 = await registry.execute("home_service.cancel", { orderId }, ctx);
    assert.equal(cancel1.ok, true);
    assert.equal(cancel1.result.ok, true);
    const cancel2 = await registry.execute(
      "home_service.cancel",
      { orderId, confirm: true, confirmationToken: cancel1.result.confirmationToken as string },
      ctx,
    );
    assert.equal(cancel2.ok, true);
    assert.equal(cancel2.result.ok, true);
  });
});

test("restaurant tools - 附近推荐 + 两阶段订座", async () => {
  await withRegistry(async (registry) => {
    const ctx = makeContext();
    const dineAt = "2026-09-05T19:00:00+08:00";

    // 无关键词/菜系时结合定位提示「附近推荐」
    const search = await registry.execute(
      "restaurant.search",
      { covers: 4, dineAt },
      ctx,
    );
    assert.equal(search.ok, true);
    assert.equal(search.result.ok, true);
    assert.match(String(search.result.locationHint ?? ""), /附近/);

    const stage1 = await registry.execute(
      "restaurant.book",
      { optionId: "rest-002", covers: 2, dineAt },
      ctx,
    );
    assert.equal(stage1.ok, true);
    assert.equal(stage1.result.ok, true);
    const stage2 = await registry.execute(
      "restaurant.book",
      { optionId: "rest-002", covers: 2, dineAt, confirm: true, confirmationToken: stage1.result.confirmationToken as string },
      ctx,
    );
    assert.equal(stage2.ok, true);
    assert.equal(stage2.result.ok, true);
    assert.match(stage2.result.orderId as string, /^bkg_/);
  });
});

test("booking modules - 工具 schema 均为点号命名空间且含两阶段参数", async () => {
  await withRegistry(async () => {
    for (const tools of [RIDE_HAILING_CHAT_TOOLS, HOME_SERVICES_CHAT_TOOLS, RESTAURANT_BOOKING_CHAT_TOOLS]) {
      for (const tool of tools) {
        if (tool.type !== "function" || !tool.function) continue;
        assert.match(tool.function.name, /^(ride_hailing|home_service|restaurant)\./);
        if (/\.book$|\.cancel$/.test(tool.function.name)) {
          const props = ((tool.function.parameters as { properties: Record<string, unknown> })?.properties) ?? {};
          assert.ok(props.confirm, `${tool.function.name} 缺 confirm 参数`);
          assert.ok(props.confirmationToken, `${tool.function.name} 缺 confirmationToken 参数`);
        }
      }
    }
  });
});

test("ride-hailing tools - 阶段二确认不再触发定位请求", async () => {
  await withRegistry(async (registry) => {
    let locationCalls = 0;
    const ctx = makeContext({
      clientLocation: undefined,
      requestLocation: async () => {
        locationCalls++;
        return null;
      },
    });

    // quote + 阶段一各解析一次起点（无 GPS、requestLocation 返回 null → 兜底「当前位置」）
    const quote = await registry.execute("ride_hailing.quote", { dropoff: "首都机场T3" }, ctx);
    assert.equal(quote.result.ok, true);
    const stage1 = await registry.execute(
      "ride_hailing.book",
      { dropoff: "首都机场T3", optionId: (quote.result.options as Array<{ id: string }>)[0].id },
      ctx,
    );
    assert.equal(stage1.result.ok, true);
    assert.equal(locationCalls, 2);

    // 阶段二：token 草稿已带起点，不再请求定位
    const stage2 = await registry.execute(
      "ride_hailing.book",
      { dropoff: "首都机场T3", optionId: "eco", confirm: true, confirmationToken: stage1.result.confirmationToken as string },
      ctx,
    );
    assert.equal(stage2.result.ok, true);
    assert.equal(locationCalls, 2);
  });
});

test("restaurant tools - 带关键词搜索不请求定位", async () => {
  await withRegistry(async (registry) => {
    let locationCalls = 0;
    const ctx = makeContext({
      clientLocation: undefined,
      requestLocation: async () => {
        locationCalls++;
        return { latitude: 39.9087, longitude: 116.3975, label: "北京市 · 东城区" };
      },
    });

    const withQuery = await registry.execute("restaurant.search", { query: "外婆家", covers: 2 }, ctx);
    assert.equal(withQuery.result.ok, true);
    assert.equal(locationCalls, 0);
    assert.equal(withQuery.result.locationHint, undefined);

    // 无关键词/菜系（附近推荐场景）才请求一次定位
    const nearby = await registry.execute("restaurant.search", { covers: 2 }, ctx);
    assert.equal(nearby.result.ok, true);
    assert.equal(locationCalls, 1);
    assert.match(String(nearby.result.locationHint ?? ""), /附近/);
  });
});
