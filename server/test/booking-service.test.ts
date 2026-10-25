/**
 * 方案 A/B/C/D 单测：booking-service 统一预订编排。
 *
 * 覆盖：
 *   1. 网约车全链路：quote → book 两阶段 → status → cancel 两阶段（模拟 Provider）
 *   2. 安全护栏：单笔上限 / 单日累计上限 / token TTL 过期
 *   3. 家政：search → book → reschedule
 *   4. 订单存储：JSON 文件持久化往返 + 单日金额统计
 *
 * 测试封闭：内存 store（或临时目录）、注入时钟、无网络。
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
  newBookingOrderId,
  type BookingConfig,
  type StoredBookingOrder,
} from "../src/services/booking/index.js";
import { localDateKey } from "../src/services/booking/booking-order-store.js";
import { extractLedgerEntry } from "../src/services/consumption-ledger-listener.js";
import type {
  BookingDraft,
  BookingOption,
  BookingProvider,
  BookingProviderBookPayload,
  BookingProviderContext,
  BookingProviderRef,
  BookingProviderResult,
  BookingSearchQuery,
} from "../src/services/booking/booking-provider.js";
import type { ToolContext } from "../src/tools/tool-registry.js";

function makeContext(overrides?: Partial<ToolContext>): ToolContext {
  return { sessionId: "test-session-booking", userId: "test-user-booking", ...overrides };
}

interface BookingCtx {
  service: BookingService;
  setNow: (iso: string) => void;
  cleanup: () => Promise<void>;
}

async function withBooking(
  fn: (ctx: BookingCtx) => Promise<void>,
  configOverrides: Partial<BookingConfig> = {},
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "booking-service-"));
  let nowMs = Date.parse("2026-09-04T10:00:00Z");
  const service = new BookingService({
    providers: [
      new SimulatedRideProvider({ now: () => nowMs }),
      new SimulatedHomeServiceProvider(),
      new SimulatedRestaurantProvider(),
    ],
    store: new BookingOrderStore(null),
    config: { maxAmountCny: 1000, dailyBudgetCny: 500, confirmationTtlMs: 300_000, ...configOverrides },
    now: () => new Date(nowMs),
  });
  const setNow = (iso: string) => (nowMs = Date.parse(iso));
  try {
    await fn({ service, setNow, cleanup: async () => {} });
  } finally {
    service.dispose();
    await rm(dir, { recursive: true, force: true });
  }
}

// --------------------------------------------------------------------------- //

test("booking-service - 网约车全链路（quote → 两阶段 book → status → 两阶段 cancel）", async () => {
  await withBooking(async ({ service }) => {
    const ctx = makeContext();

    // 报价
    const quote = await service.search(ctx, "ride", { params: { pickup: "国贸", dropoff: "首都机场T3" } });
    assert.equal(quote.ok, true);
    const q = quote as {
      options: Array<{ id: string; simulated?: boolean }>; note?: string;
    };
    assert.ok(q.options.length >= 3);
    assert.equal(q.options.every((o) => o.simulated === true), true);
    assert.match(q.note ?? "", /模拟模式/);

    // 下单阶段一：摘要 + token + 模拟标记
    const stage1 = await service.book(ctx, "ride", {
      optionId: q.options[0].id,
      params: { pickup: "国贸", dropoff: "首都机场T3" },
      confirm: false,
    });
    assert.equal(stage1.ok, true);
    const s1 = stage1 as { needsConfirmation: boolean; confirmationToken: string; simulated: boolean; summary: string };
    assert.equal(s1.needsConfirmation, true);
    assert.ok(s1.confirmationToken);
    assert.equal(s1.simulated, true);
    assert.match(s1.summary, /网约车/);

    // 阶段二缺 token：服务端兜底自动消费同 actor+domain 的最新待确认记录（2026-10-18
    // live e2e 实证：工具历史折叠后 token 字符串从模型上下文消失，回抄必然断链）
    const noToken = await service.book(ctx, "ride", {
      optionId: q.options[0].id,
      params: { pickup: "国贸", dropoff: "首都机场T3" },
      confirm: true,
    });
    assert.equal(noToken.ok, true);
    assert.match((noToken as { orderId: string }).orderId, /^bkg_/);

    // 兜底路径 fail-closed：没有任何待确认记录时 confirm=true 拒绝并引导重走阶段一
    const noPending = await service.book(ctx, "ride", {
      optionId: q.options[0].id,
      params: { pickup: "国贸", dropoff: "首都机场T3" },
      confirm: true,
    });
    assert.equal(noPending.ok, false);
    if (!noPending.ok) assert.match(noPending.error, /confirm=false/);

    // 重新走阶段一 → 带 token 消费（原有精确路径不回归）
    const stage1b = await service.book(ctx, "ride", {
      optionId: q.options[0].id,
      params: { pickup: "国贸", dropoff: "首都机场T3" },
      confirm: false,
    });
    assert.equal(stage1b.ok, true);
    const s1b = stage1b as { needsConfirmation: boolean; confirmationToken: string; simulated: boolean; summary: string };
    assert.equal(s1b.needsConfirmation, true);
    assert.ok(s1b.confirmationToken);
    assert.equal(s1b.simulated, true);
    assert.match(s1b.summary, /网约车/);

    // 下单阶段二：本地订单 + 承诺板写入
    const stage2 = await service.book(ctx, "ride", {
      optionId: q.options[0].id,
      params: { pickup: "国贸", dropoff: "首都机场T3" },
      confirm: true,
      confirmationToken: s1b.confirmationToken,
    });
    assert.equal(stage2.ok, true);
    const s2 = stage2 as {
      orderId: string; simulated: boolean;
    };
    assert.match(s2.orderId, /^bkg_/);
    assert.equal(s2.simulated, true);

    // 状态查询：confirmed + 司机信息
    const status = await service.getStatus(ctx, "ride", s2.orderId);
    assert.equal(status.ok, true);
    const st = status as { order: { status: string }; tracking: Record<string, unknown> };
    assert.equal(st.order.status, "confirmed");
    assert.match(JSON.stringify(st.tracking ?? {}), /张师傅/);

    // 订单列表（不传 orderId）
    const list = await service.getStatus(ctx, "ride");
    assert.equal(list.ok, true);
    const ls = list as { orders: unknown[] };
    assert.ok(Array.isArray(ls.orders) && ls.orders.length >= 1);

    // 取消阶段一
    const cancel1 = await service.cancel(ctx, "ride", s2.orderId, false);
    assert.equal(cancel1.ok, true);
    const c1 = cancel1 as { needsConfirmation: boolean; confirmationToken: string };
    assert.equal(c1.needsConfirmation, true);
    assert.ok(c1.confirmationToken);

    // 取消阶段二
    const cancel2 = await service.cancel(ctx, "ride", s2.orderId, true, c1.confirmationToken, "不坐了");
    assert.equal(cancel2.ok, true);
    const c2 = cancel2 as { status: string };
    assert.equal(c2.status, "cancelled");
  });
});

test("booking-service - 单笔上限拦截", async () => {
  await withBooking(
    async ({ service }) => {
      const ctx = makeContext();
      // clean-basic = ¥120，上限 100 → 阶段一直接拒绝
      const stage1 = await service.book(ctx, "home_service", {
        optionId: "clean-basic",
        params: { serviceType: "cleaning", address: "朝阳区望京" },
        scheduleAt: "2026-09-10T14:00:00+08:00",
        confirm: false,
      });
      assert.equal(stage1.ok, false);
      if (!stage1.ok) {
        assert.match(stage1.error, /单笔上限/);
      }
    },
    { maxAmountCny: 100, dailyBudgetCny: 0 },
  );
});

test("booking-service - 单日累计上限拦截", async () => {
  await withBooking(
    async ({ service }) => {
      const ctx = makeContext();
      const params = { serviceType: "cleaning", address: "朝阳区望京" };
      const scheduleAt = "2026-09-10T14:00:00+08:00";

      // 第一单 ¥120 成功
      const first1 = await service.book(ctx, "home_service", { optionId: "clean-basic", params, scheduleAt, confirm: false });
      assert.equal(first1.ok, true);
      if (!first1.ok) return;
      const first2 = await service.book(ctx, "home_service", {
        optionId: "clean-basic", params, scheduleAt, confirm: true, confirmationToken: (first1 as { confirmationToken: string }).confirmationToken,
      });
      assert.equal(first2.ok, true);

      // 第二单 ¥120：120+120=240 > 200 → 拒绝
      const second = await service.book(ctx, "home_service", { optionId: "clean-basic", params, scheduleAt, confirm: false });
      assert.equal(second.ok, false);
      if (!second.ok) assert.match(second.error, /单日上限/);
    },
    { maxAmountCny: 1000, dailyBudgetCny: 200 },
  );
});

test("booking-service - 确认 token TTL 过期", async () => {
  await withBooking(
    async ({ service, setNow }) => {
      const ctx = makeContext();
      const stage1 = await service.book(ctx, "home_service", {
        optionId: "clean-basic",
        params: { serviceType: "cleaning", address: "望京" },
        scheduleAt: "2026-09-10T14:00:00+08:00",
        confirm: false,
      });
      assert.equal(stage1.ok, true);
      if (!stage1.ok) return;
      // 推进 5 分钟 + 1 秒
      setNow("2026-09-04T10:05:01Z");
      const stage2 = await service.book(ctx, "home_service", {
        optionId: "clean-basic",
        params: { serviceType: "cleaning", address: "望京" },
        scheduleAt: "2026-09-10T14:00:00+08:00",
        confirm: true,
        confirmationToken: (stage1 as { confirmationToken: string }).confirmationToken,
      });
      assert.equal(stage2.ok, false);
      if (!stage2.ok) assert.match(stage2.error, /过期/);
    },
    { maxAmountCny: 1000, dailyBudgetCny: 0, confirmationTtlMs: 300_000 },
  );
});

test("booking-service - 家政改期：订单时间同步", async () => {
  await withBooking(async ({ service }) => {
    const ctx = makeContext();
    const params = { serviceType: "cleaning", address: "望京SOHO" };
    const scheduleAt = "2026-09-10T14:00:00+08:00";
    const stage1 = await service.book(ctx, "home_service", { optionId: "clean-basic", params, scheduleAt, confirm: false });
    assert.equal(stage1.ok, true);
    if (!stage1.ok) return;
    const stage2 = await service.book(ctx, "home_service", {
      optionId: "clean-basic", params, scheduleAt, confirm: true, confirmationToken: (stage1 as { confirmationToken: string }).confirmationToken,
    });
    assert.equal(stage2.ok, true);
    if (!stage2.ok) return;

    const newSchedule = "2026-09-12T09:00:00+08:00";
    const rescheduled = await service.reschedule(ctx, "home_service", (stage2 as { orderId: string }).orderId, newSchedule);
    assert.equal(rescheduled.ok, true);

    const status = await service.getStatus(ctx, "home_service", (stage2 as { orderId: string }).orderId);
    assert.equal(status.ok, true);
    assert.equal((status as { order: { scheduleAt: string } }).order.scheduleAt, newSchedule);
  });
});

test("booking-service - 餐厅订座：过时用餐自动 completed", async () => {
  await withBooking(async ({ service }) => {
    const ctx = makeContext();
    const dineAt = "2026-01-01T19:00:00+08:00"; // 已过去的用餐时间 → provider 判定 completed
    const params = { query: "", cuisine: "火锅", covers: 2, dineAt }; // 130×2=260，不触发单日限额
    const stage1 = await service.book(ctx, "restaurant", { optionId: "rest-002", params, scheduleAt: dineAt, confirm: false });
    assert.equal(stage1.ok, true);
    if (!stage1.ok) return;
    const stage2 = await service.book(ctx, "restaurant", {
      optionId: "rest-002", params, scheduleAt: dineAt, confirm: true, confirmationToken: (stage1 as { confirmationToken: string }).confirmationToken,
    });
    assert.equal(stage2.ok, true);
    if (!stage2.ok) return;
    const orderId = (stage2 as { orderId: string }).orderId;

    const status = await service.getStatus(ctx, "restaurant", orderId);
    assert.equal(status.ok, true);
    assert.equal((status as { order: { status: string } }).order.status, "completed");
  });
});

test("booking-service - 订单存储：JSON 持久化往返 + 单日金额统计", async () => {
  const dir = await mkdtemp(join(tmpdir(), "booking-store-"));
  const file = join(dir, "orders.json");
  try {
    const store = new BookingOrderStore(file);
    const nowIso = new Date().toISOString();
    const order: StoredBookingOrder = {
      orderId: newBookingOrderId(),
      actorId: "user-a",
      domain: "ride",
      provider: "simulated",
      providerOrderId: "SIM-RIDE-1",
      title: "经济型（模拟估价 ¥45）",
      amountCny: 45,
      status: "confirmed",
      scheduleAt: null,
      deadline: null,
      params: { pickup: "国贸", dropoff: "首都机场T3" },
      paymentUrl: null,
      commitmentId: null,
      simulated: true,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    await store.create(order);
    await store.flush(); // 等待原子写落盘（Windows 下 rm 与写链有竞态）

    const reopened = new BookingOrderStore(file);
    const loaded = await reopened.get(order.orderId);
    assert.ok(loaded);
    assert.equal(loaded.amountCny, 45);
    assert.equal(loaded.params.dropoff, "首都机场T3");

    const sum = await reopened.sumAmountOnDate("user-a", nowIso.slice(0, 10));
    assert.equal(sum, 45);

    const updated = await reopened.update(order.orderId, { status: "cancelled" });
    assert.equal(updated?.status, "cancelled");
    await reopened.flush();
    // 取消后不计入单日金额
    const sumAfterCancel = await reopened.sumAmountOnDate("user-a", nowIso.slice(0, 10));
    assert.equal(sumAfterCancel, 0);

    // dateKey 覆盖 UTC 前缀：createdAt 的 UTC 日期是 09-04，落库打标后归属本地 09-05
    const tzOrder: StoredBookingOrder = {
      ...order,
      orderId: newBookingOrderId(),
      amountCny: 30,
      status: "confirmed",
      createdAt: "2026-09-04T20:00:00.000Z",
      updatedAt: "2026-09-04T20:00:00.000Z",
      dateKey: "2026-09-05",
    };
    await reopened.create(tzOrder);
    await reopened.flush();
    assert.equal(await reopened.sumAmountOnDate("user-a", "2026-09-05"), 30);
    assert.equal(await reopened.sumAmountOnDate("user-a", "2026-09-04"), 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------------------- //
// 优化回归：阶段二限额复查 / token 归还 / 落库兜底 / 模拟不入账 / 本地时区键
// --------------------------------------------------------------------------- //

test("booking-service - 多笔待确认并发确认不击穿单日限额", async () => {
  await withBooking(
    async ({ service }) => {
      const ctx = makeContext();
      const params = { serviceType: "cleaning", address: "望京" };
      const scheduleAt = "2026-09-10T14:00:00+08:00";

      // 两笔各 ¥120，阶段一都放行（单笔均低于上限）
      const t1 = await service.book(ctx, "home_service", { optionId: "clean-basic", params, scheduleAt, confirm: false });
      const t2 = await service.book(ctx, "home_service", { optionId: "clean-basic", params, scheduleAt, confirm: false });
      assert.equal(t1.ok, true);
      assert.equal(t2.ok, true);

      // 第一笔确认成功（¥120 落库）
      const first = await service.book(ctx, "home_service", {
        optionId: "clean-basic", params, scheduleAt, confirm: true, confirmationToken: (t1 as { confirmationToken: string }).confirmationToken,
      });
      assert.equal(first.ok, true);

      // 第二笔确认：120+120 > 200 → 阶段二复查拦截
      const second = await service.book(ctx, "home_service", {
        optionId: "clean-basic", params, scheduleAt, confirm: true, confirmationToken: (t2 as { confirmationToken: string }).confirmationToken,
      });
      assert.equal(second.ok, false);
      if (!second.ok) assert.match(second.error, /单日上限/);
    },
    { maxAmountCny: 1000, dailyBudgetCny: 200 },
  );
});

/** book 首次瞬时失败（retryable），其后成功的桩 Provider。 */
class FlakyRideProvider implements BookingProvider {
  readonly key = "flaky";
  readonly domain = "ride" as const;
  readonly label = "故障注入网约车";
  private failedOnce = false;

  availability(): { ok: true } {
    return { ok: true };
  }

  async search(_query: BookingSearchQuery, _ctx: BookingProviderContext) {
    const options: BookingOption[] = [{
      id: "eco",
      provider: this.key,
      title: "经济型（测试 ¥100）",
      amountCny: 100,
      currency: "CNY",
      simulated: true,
    }];
    return { ok: true as const, options };
  }

  async book(
    _draft: BookingDraft,
    _ctx: BookingProviderContext,
  ): Promise<BookingProviderResult<BookingProviderBookPayload>> {
    if (!this.failedOnce) {
      this.failedOnce = true;
      return { ok: false as const, error: "上游超时", retryable: true };
    }
    return { ok: true as const, providerOrderId: "FLAKY-1", status: "confirmed" as const };
  }

  async getStatus(_ref: BookingProviderRef, _ctx: BookingProviderContext) {
    return { ok: true as const, status: "confirmed" as const };
  }

  async cancel(_ref: BookingProviderRef, _reason: string | undefined, _ctx: BookingProviderContext) {
    return { ok: true as const };
  }
}

test("booking-service - 阶段二瞬时失败归还 token，可直接重试", async () => {
  const service = new BookingService({
    providers: [new FlakyRideProvider()],
    store: new BookingOrderStore(null),
    config: { maxAmountCny: 1000, dailyBudgetCny: 0 },
  });
  try {
    const ctx = makeContext();
    const params = { pickup: "国贸", dropoff: "首都机场T3" };
    const stage1 = await service.book(ctx, "ride", { optionId: "eco", params, confirm: false });
    assert.equal(stage1.ok, true);
    const token = (stage1 as { confirmationToken: string }).confirmationToken;

    // 首次阶段二：provider 瞬时失败
    const first = await service.book(ctx, "ride", { optionId: "eco", params, confirm: true, confirmationToken: token });
    assert.equal(first.ok, false);
    if (!first.ok) assert.equal(first.retryable, true);

    // 同一 token 直接重试成功（未烧掉）
    const second = await service.book(ctx, "ride", { optionId: "eco", params, confirm: true, confirmationToken: token });
    assert.equal(second.ok, true);
  } finally {
    service.dispose();
  }
});

/** create 永远失败的存储桩（模拟磁盘故障）。 */
class FailingStore extends BookingOrderStore {
  override async create(_order: StoredBookingOrder): Promise<StoredBookingOrder> {
    throw new Error("disk full");
  }
}

test("booking-service - 阶段二落库失败不假失败（返回部分成功）", async () => {
  const service = new BookingService({
    providers: [new SimulatedRideProvider()],
    store: new FailingStore(null),
    config: { maxAmountCny: 1000, dailyBudgetCny: 0 },
  });
  try {
    const ctx = makeContext();
    const params = { pickup: "国贸", dropoff: "首都机场T3" };
    const stage1 = await service.book(ctx, "ride", { optionId: "eco", params, confirm: false });
    assert.equal(stage1.ok, true);
    const stage2 = await service.book(ctx, "ride", {
      optionId: "eco", params, confirm: true, confirmationToken: (stage1 as { confirmationToken: string }).confirmationToken,
    });
    // 平台订单已创建：必须返回成功 + 落库告警，而不是 ok:false 诱导用户重复下单
    assert.equal(stage2.ok, true);
    if (!stage2.ok) return;
    assert.match(String(stage2.persistenceWarning), /落库失败/);
  } finally {
    service.dispose();
  }
});

test("booking-service - 模拟订单不入消费账本", () => {
  const simulatedRide = extractLedgerEntry({
    tool: "ride_hailing.book",
    input: { dropoff: "首都机场T3" },
    result: { ok: true, amountCny: 45, simulated: true, summary: "模拟下单" },
  });
  assert.equal(simulatedRide, null);

  const realRide = extractLedgerEntry({
    tool: "ride_hailing.book",
    input: { dropoff: "首都机场T3" },
    result: { ok: true, amountCny: 45, simulated: false, summary: "真实下单" },
  });
  assert.ok(realRide);
  assert.equal(realRide.amount, 45);
  assert.equal(realRide.category, "交通");

  const simulatedHome = extractLedgerEntry({
    tool: "home_service.book",
    input: {},
    result: { ok: true, amountCny: 120, simulated: true },
  });
  assert.equal(simulatedHome, null);

  const simulatedRest = extractLedgerEntry({
    tool: "restaurant.book",
    input: {},
    result: { ok: true, amountCny: 260, simulated: true },
  });
  assert.equal(simulatedRest, null);
});

test("booking-service - localDateKey 与 store 统计窗口一致", () => {
  const iso = new Date("2026-09-04T20:00:00.000Z"); // UTC 09-04，UTC+8 本地 09-05 凌晨 4 点
  const key = localDateKey(iso);
  const offset = iso.getTimezoneOffset();
  if (offset === -480) {
    // UTC+8 环境：本地日期应为 09-05
    assert.equal(key, "2026-09-05");
  } else {
    // 其他时区：至少与 createdAt 的 UTC 前缀语义分离（key 由本地时区推导）
    assert.equal(key, new Date(iso.getTime() - offset * 60_000).toISOString().slice(0, 10));
  }
});
