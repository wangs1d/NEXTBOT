/**
 * 每轮位置感知钩子单测（2026-11-22 位置动态更新架构）。
 *
 * 锁死的语义：
 *   1. 快照新鲜（≤ 新鲜窗口）→ 不请求设备（每轮零开销）；
 *   2. 快照过期 + 有在线设备 → 预算内向设备要一次 fix 并写回快照；
 *   3. 无在线设备 → 不白等预算，如实返回既有位置与龄期；
 *   4. 超过最大可用龄期 → available=false（prompt 不得注入旧位置）；
 *   5. 预算超时 → 不抛异常，返回旧快照（请求在途，回包仍会更新快照）；
 *   6. 并发调用同一 actor → 共享一次设备请求（不 stampede）；
 *   7. 位置行格式化带龄期，旧位置明说「非实时」。
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ClientLocationWire } from "@nextbot/agent-protocol";

import { ActorContextService } from "../src/services/actor-context-service.js";
import type { LocationCoordinator } from "../src/services/location-coordinator.js";
import {
  TurnLocationHook,
  formatActorLocationBrief,
  isLocationAccuracyAcceptable,
} from "../src/services/turn-location-hook.js";

const NOW = Date.UTC(2026, 10, 22, 3, 0, 0);

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

type FakeCoordinator = {
  calls: Array<{ actorId: string; reason?: string; maxAgeMs?: number; maxAccuracyMeters?: number }>;
  hasSocket: (actorId: string) => boolean;
  requestLocation: (
    actorId: string,
    reason?: string,
    opts?: { maxAgeMs?: number; maxAccuracyMeters?: number },
  ) => Promise<ClientLocationWire | null>;
};

function fakeCoordinator(
  reply: ClientLocationWire | null,
  opts?: { online?: boolean; delayMs?: number },
): FakeCoordinator {
  const calls: FakeCoordinator["calls"] = [];
  return {
    calls,
    hasSocket: () => opts?.online ?? true,
    requestLocation: async (actorId, reason, reqOpts) => {
      calls.push({
        actorId,
        ...(reason ? { reason } : {}),
        ...(reqOpts?.maxAgeMs != null ? { maxAgeMs: reqOpts.maxAgeMs } : {}),
        ...(reqOpts?.maxAccuracyMeters != null
          ? { maxAccuracyMeters: reqOpts.maxAccuracyMeters }
          : {}),
      });
      if (opts?.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      return reply;
    },
  };
}

async function withContext<T>(
  fn: (ctx: ActorContextService) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "turn-location-hook-"));
  const ctx = new ActorContextService({
    persistPath: join(dir, "actor-context.json"),
    now: () => NOW,
    persistThrottleMs: 0,
  });
  try {
    return await fn(ctx);
  } finally {
    await ctx.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function wire(overrides: Partial<ClientLocationWire> = {}): ClientLocationWire {
  return {
    latitude: 29.6531,
    longitude: 106.5501,
    city: "重庆市",
    district: "渝中区",
    capturedAt: iso(NOW),
    ...overrides,
  };
}

function makeHook(
  ctx: ActorContextService,
  coordinator: FakeCoordinator,
  extra?: {
    budgetMs?: number;
    freshMs?: number;
    nowMs?: number;
    maxAgeMs?: number;
    maxAccuracyMeters?: number;
    precisionRetryMs?: number;
    reuseMaxAgeMs?: number;
  },
): TurnLocationHook {
  return new TurnLocationHook({
    context: ctx,
    coordinator: coordinator as unknown as LocationCoordinator,
    now: () => extra?.nowMs ?? NOW,
    enabled: true,
    freshMs: extra?.freshMs ?? 60_000,
    budgetMs: extra?.budgetMs ?? 2_000,
    ...(extra?.maxAgeMs != null ? { maxAgeMs: extra.maxAgeMs } : {}),
    ...(extra?.maxAccuracyMeters != null
      ? { maxAccuracyMeters: extra.maxAccuracyMeters }
      : {}),
    ...(extra?.precisionRetryMs != null ? { precisionRetryMs: extra.precisionRetryMs } : {}),
    ...(extra?.reuseMaxAgeMs != null ? { reuseMaxAgeMs: extra.reuseMaxAgeMs } : {}),
  });
}

test("快照在新鲜窗口内：不请求设备，直接可用", async () => {
  await withContext(async (ctx) => {
    ctx.updateLocation("u1", wire({ capturedAt: iso(NOW) }), "continuous");
    const coordinator = fakeCoordinator(wire({ latitude: 30 }));
    const hook = makeHook(ctx, coordinator, { nowMs: NOW + 20_000 });

    const state = await hook.run("u1", { reason: "chat" });

    assert.equal(state.available, true);
    assert.equal(state.source, "fresh");
    assert.equal(state.refreshed, false);
    assert.equal(coordinator.calls.length, 0, "新鲜快照不应再向设备要 fix");
  });
});

test("快照过期 + 设备在线：预算内刷新并写回快照", async () => {
  await withContext(async (ctx) => {
    ctx.updateLocation("u1", wire({ capturedAt: iso(NOW) }), "continuous");
    const later = NOW + 30 * 60_000;
    const fresh = wire({ latitude: 39.9042, longitude: 116.4074, city: "北京市", capturedAt: iso(later) });
    const coordinator = fakeCoordinator(fresh);
    const hook = makeHook(ctx, coordinator, { nowMs: later });

    const state = await hook.run("u1", { reason: "chat" });

    assert.equal(coordinator.calls.length, 1, "过期快照应请求一次");
    assert.equal(coordinator.calls[0].reason, "turn:chat");
    assert.equal(coordinator.calls[0].maxAgeMs, 60_000);
    assert.equal(coordinator.calls[0].maxAccuracyMeters, 15, "精度门槛随请求下发（15m）");
    assert.equal(state.available, true);
    assert.equal(state.refreshed, true);
    assert.equal(state.source, "refreshed");
    assert.equal(ctx.get("u1")?.location?.city, "北京市", "刷新结果应写回快照");
    assert.ok((ctx.locationAgeMs("u1") ?? Infinity) <= 1_000);
  });
});

test("设备离线：不请求、不等待，如实返回旧位置与龄期", async () => {
  await withContext(async (ctx) => {
    ctx.updateLocation("u1", wire({ capturedAt: iso(NOW) }), "continuous");
    const coordinator = fakeCoordinator(wire({ latitude: 30 }), { online: false });
    const hook = makeHook(ctx, coordinator, { nowMs: NOW + 20 * 60_000 });

    const state = await hook.run("u1", { reason: "task" });

    assert.equal(coordinator.calls.length, 0);
    assert.equal(state.available, true);
    assert.equal(state.source, "stale");
    assert.ok((state.ageMs ?? 0) >= 20 * 60_000);
  });
});

test("精准快照超出新鲜窗口但在复用窗口内：本轮不等待，后台刷新（先答后刷）", async () => {
  await withContext(async (ctx) => {
    ctx.updateLocation("u1", wire({ capturedAt: iso(NOW), accuracyMeters: 8 }), "continuous");
    const later = NOW + 90_000;
    const fresh = wire({
      latitude: 31.2304,
      longitude: 121.4737,
      city: "上海市",
      accuracyMeters: 6,
      capturedAt: iso(later),
    });
    const coordinator = fakeCoordinator(fresh, { delayMs: 20 });
    const hook = makeHook(ctx, coordinator, { nowMs: later, reuseMaxAgeMs: 120_000 });

    const state = await hook.run("u1", { reason: "chat" });

    assert.equal(state.available, true);
    assert.equal(state.refreshed, false, "精准快照在复用窗口内：本轮直接用，不等设备");
    assert.equal(state.source, "stale");
    assert.equal(coordinator.calls.length, 1, "刷新丢到后台，不阻塞本轮");

    // 后台回包照样写快照：下一轮吃到新值（旧实现丢掉了这个回包）。
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(ctx.get("u1")?.location?.city, "上海市");
  });
});

test("复用窗口可关（0）：每轮都现拉，拿到达标 fix 立即返回", async () => {
  await withContext(async (ctx) => {
    ctx.updateLocation("u1", wire({ capturedAt: iso(NOW), accuracyMeters: 8 }), "continuous");
    const later = NOW + 90_000;
    const fresh = wire({ city: "上海市", accuracyMeters: 6, capturedAt: iso(later) });
    const coordinator = fakeCoordinator(fresh);
    const hook = makeHook(ctx, coordinator, { nowMs: later, reuseMaxAgeMs: 0 });

    const state = await hook.run("u1");

    assert.equal(state.refreshed, true);
    assert.equal(state.source, "refreshed");
    assert.equal(ctx.get("u1")?.location?.city, "上海市");
  });
});

test("超过最大可用龄期：available=false（旧位置不得进 prompt）", async () => {
  await withContext(async (ctx) => {
    ctx.updateLocation("u1", wire({ capturedAt: iso(NOW) }), "continuous");
    const coordinator = fakeCoordinator(null, { online: false });
    // 快照写入后 5 小时再进入一轮：超过 2h 最大可用龄期。
    const hook = makeHook(ctx, coordinator, { nowMs: NOW + 5 * 60 * 60_000 });

    const state = await hook.run("u1");

    assert.equal(state.available, false);
    assert.equal(state.source, "none");
  });
});

test("预算超时：不抛异常，返回旧快照；请求不取消", async () => {
  await withContext(async (ctx) => {
    ctx.updateLocation("u1", wire({ capturedAt: iso(NOW) }), "continuous");
    const later = NOW + 10 * 60_000;
    const coordinator = fakeCoordinator(wire({ latitude: 30, capturedAt: iso(later) }), {
      delayMs: 200,
    });
    const hook = makeHook(ctx, coordinator, { budgetMs: 20, nowMs: later });

    const state = await hook.run("u1");

    assert.equal(state.available, true);
    assert.equal(state.refreshed, false);
    assert.equal(state.source, "stale");
    assert.equal(coordinator.calls.length, 1, "请求已发出，只是本轮不等它");
  });
});

test("并发调用同一 actor：共享一次设备请求", async () => {
  await withContext(async (ctx) => {
    ctx.updateLocation("u1", wire({ capturedAt: iso(NOW) }), "continuous");
    const later = NOW + 10 * 60_000;
    const coordinator = fakeCoordinator(wire({ latitude: 30, capturedAt: iso(later) }), {
      delayMs: 30,
    });
    const hook = makeHook(ctx, coordinator, { nowMs: later });

    const [a, b] = await Promise.all([hook.run("u1"), hook.run("u1", { reason: "proactive" })]);

    assert.equal(coordinator.calls.length, 1, "同一 actor 在途请求必须复用");
    assert.deepEqual(a, b);
  });
});

test("formatActorLocationBrief：精确地址优先，旧位置标注非实时", () => {
  const brief = formatActorLocationBrief(
    {
      latitude: 29.65,
      longitude: 106.55,
      address: "重庆市渝中区民族路 1 号",
      city: "重庆市",
      district: "渝中区",
      poi: "解放碑",
      poiDistanceMeters: 120,
      observedAt: NOW - 30 * 60_000,
      source: "continuous",
      placeKind: "unknown",
    },
    30 * 60_000,
  );
  assert.ok(brief?.includes("重庆市渝中区民族路 1 号"));
  assert.ok(brief?.includes("最近地标：解放碑（约 120 米）"));
  assert.ok(brief?.includes("30 分钟前"));
  assert.ok(brief?.includes("非实时"));

  const fresh = formatActorLocationBrief(
    {
      latitude: 29.65,
      longitude: 106.55,
      city: "重庆市",
      district: "渝中区",
      observedAt: NOW,
      source: "continuous",
      placeKind: "unknown",
    },
    10_000,
  );
  assert.equal(fresh, "用户当前所在地：渝中区 · 重庆市（定位：实时）");
});

test("预算 0（主动消息）：只发不等，立刻返回当前状态；限流窗口内不重复发请求", async () => {
  await withContext(async (ctx) => {
    ctx.updateLocation("u1", wire({ capturedAt: iso(NOW) }), "continuous");
    const later = NOW + 10 * 60_000;
    const coordinator = fakeCoordinator(wire({ latitude: 30, capturedAt: iso(later) }), {
      delayMs: 200,
    });
    const hook = makeHook(ctx, coordinator, { nowMs: later });

    const t0 = Date.now();
    const first = await hook.run("u1", { reason: "proactive", budgetMs: 0 });
    const elapsed = Date.now() - t0;

    assert.ok(elapsed < 100, `预算 0 不应等待设备（实际 ${elapsed}ms）`);
    assert.equal(first.source, "stale");
    assert.equal(coordinator.calls.length, 1, "后台应丢出一次刷新请求");

    await hook.run("u1", { reason: "proactive", budgetMs: 0 });
    assert.equal(coordinator.calls.length, 1, "限流窗口内不重复发后台请求");
  });
});

test("精度优先：快照够新但精度只有 60m → 仍向设备要一次高精度 fix", async () => {
  await withContext(async (ctx) => {
    ctx.updateLocation("u1", wire({ capturedAt: iso(NOW), accuracyMeters: 60 }), "continuous");
    const precise = wire({ latitude: 29.6532, capturedAt: iso(NOW + 20_000), accuracyMeters: 8 });
    const coordinator = fakeCoordinator(precise);
    const hook = makeHook(ctx, coordinator, { nowMs: NOW + 20_000, maxAccuracyMeters: 30 });

    const state = await hook.run("u1", { reason: "chat" });

    assert.equal(coordinator.calls.length, 1, "精度不达标即使新鲜也要现拉");
    assert.equal(coordinator.calls[0].maxAccuracyMeters, 30, "协调器缓存门槛同步收紧");
    assert.equal(state.precise, true);
    assert.equal(state.accuracyMeters, 8);
    assert.equal(ctx.get("u1")?.location?.accuracyMeters, 8, "更准的 fix 应写回快照");
  });
});

test("精度达标且够新：不请求设备", async () => {
  await withContext(async (ctx) => {
    ctx.updateLocation("u1", wire({ capturedAt: iso(NOW), accuracyMeters: 8 }), "continuous");
    const coordinator = fakeCoordinator(wire({ latitude: 30, accuracyMeters: 5 }));
    const hook = makeHook(ctx, coordinator, { nowMs: NOW + 20_000, maxAccuracyMeters: 30 });

    const state = await hook.run("u1");

    assert.equal(coordinator.calls.length, 0);
    assert.equal(state.precise, true);
    assert.equal(state.source, "fresh");
  });
});

test("精度未知（旧客户端未上报）：视为达标，不每轮空等", async () => {
  await withContext(async (ctx) => {
    ctx.updateLocation("u1", wire({ capturedAt: iso(NOW) }), "continuous");
    const coordinator = fakeCoordinator(wire({ latitude: 30, accuracyMeters: 5 }));
    const hook = makeHook(ctx, coordinator, { nowMs: NOW + 20_000, maxAccuracyMeters: 30 });

    const state = await hook.run("u1");

    assert.equal(coordinator.calls.length, 0);
    assert.equal(state.precise, true);
  });
});

test("高精度拿不到：冷却期内不再请求，冷却到期再试", async () => {
  await withContext(async (ctx) => {
    let nowMs = NOW;
    ctx.updateLocation("u1", wire({ capturedAt: iso(NOW), accuracyMeters: 55 }), "continuous");
    const coarse = wire({ latitude: 29.7, capturedAt: iso(NOW + 10_000), accuracyMeters: 50 });
    const coordinator = fakeCoordinator(coarse, { delayMs: 5 });
    const hook = new TurnLocationHook({
      context: ctx,
      coordinator: coordinator as unknown as LocationCoordinator,
      now: () => nowMs,
      enabled: true,
      freshMs: 60_000,
      budgetMs: 100,
      maxAccuracyMeters: 30,
      precisionRetryMs: 90_000,
    });

    nowMs = NOW + 10_000;
    const first = await hook.run("u1");
    assert.equal(coordinator.calls.length, 1);
    assert.equal(first.precise, false, "只拿到 50m，未达标");

    nowMs = NOW + 40_000;
    await hook.run("u1");
    assert.equal(coordinator.calls.length, 1, "冷却期内不再空等 GPS");

    nowMs = NOW + 120_000;
    await hook.run("u1");
    assert.equal(coordinator.calls.length, 2, "冷却到期后重新尝试");
  });
});

test("isLocationAccuracyAcceptable：未知放行、粗值拦截、门槛可配", () => {
  assert.equal(isLocationAccuracyAcceptable(undefined, 30), true);
  assert.equal(isLocationAccuracyAcceptable(null, 30), true);
  assert.equal(isLocationAccuracyAcceptable(0, 30), true);
  assert.equal(isLocationAccuracyAcceptable(8, 30), true);
  assert.equal(isLocationAccuracyAcceptable(60, 30), false);
  assert.equal(isLocationAccuracyAcceptable(60, 100), true);
});

test("同一采集时刻但更准：仍写入快照（并行引擎的择优不被 age 比较挡掉）", async () => {
  await withContext(async (ctx) => {
    ctx.updateLocation(
      "u1",
      wire({ capturedAt: iso(NOW), accuracyMeters: 40 }),
      "continuous",
    );
    assert.equal(ctx.get("u1")?.location?.accuracyMeters, 40);

    const hook = makeHook(ctx, fakeCoordinator(null), { nowMs: NOW });
    // 走 apply 的同刻分支：直接构造一次请求回包（借 coordinator 回同一个 capturedAt）。
    const coordinator = fakeCoordinator(
      wire({ capturedAt: iso(NOW), accuracyMeters: 8, city: "重庆市" }),
    );
    const hook2 = makeHook(ctx, coordinator, { nowMs: NOW + 5 * 60_000, freshMs: 1 });
    await hook2.run("u1");

    assert.equal(ctx.get("u1")?.location?.accuracyMeters, 8, "同刻更准的 fix 应覆盖粗 fix");
    void hook;
  });
});

test("peek：同步读取，不发请求", async () => {
  await withContext(async (ctx) => {
    ctx.updateLocation("u1", wire({ capturedAt: iso(NOW) }), "continuous");
    const coordinator = fakeCoordinator(wire({ latitude: 30 }));
    const hook = makeHook(ctx, coordinator, { nowMs: NOW + 5 * 60_000 });

    const state = hook.peek("u1");

    assert.equal(state.available, true);
    assert.equal(state.source, "stale");
    assert.equal(coordinator.calls.length, 0);
  });
});
