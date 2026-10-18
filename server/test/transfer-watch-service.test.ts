/**
 * 接驳提醒调度器测试（travel-upgrade-plan P2，transfer-watch-service）：
 * - 动态提前量窗口：train 30min / flight 45min / departure 90min
 * - 容忍期与窗口外静默、每段每相位只问一次、确认/拒绝后不再问
 * - 无票面时刻段降级为行程首日 08:00 提醒
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  TransferWatchService,
  TRAIN_LEAD_MIN,
  FLIGHT_LEAD_MIN,
  DEPARTURE_LEAD_MIN,
  type TransferReminderPayload,
} from "../src/services/transfer-watch-service.js";

/** 构造调度器与收集器：now 固定注入，onReminder 收集 payload */
function makeService(
  plans: Array<Record<string, unknown>>,
  now: Date,
): { svc: TransferWatchService; got: TransferReminderPayload[] } {
  const got: TransferReminderPayload[] = [];
  const svc = new TransferWatchService({
    listPlans: () => plans as never,
    onReminder: (p) => {
      got.push(p);
    },
    setPickupState: () => true,
  });
  return { svc, got };
}

const BASE = new Date("2026-10-18T12:00:00");

function isoPlus(min: number): string {
  return new Date(BASE.getTime() + min * 60_000).toISOString();
}

test("tick: 高铁到站前 30 分钟触发 pre_arrival，文案含分钟数与起终点", async () => {
  const { svc, got } = makeService(
    [
      {
        planId: "p1",
        sessionId: "s1",
        destination: "成都",
        transferSegments: [
          { type: "train", role: "arrival", no: "G1234", from: "出发地", to: "成都", arrTime: isoPlus(TRAIN_LEAD_MIN) },
        ],
      },
    ],
    BASE,
  );
  await svc.tick(BASE);
  assert.equal(got.length, 1);
  assert.equal(got[0].phase, "pre_arrival");
  assert.equal(got[0].sessionId, "s1");
  assert.equal(got[0].segment.no, "G1234");
  assert.equal(got[0].minutesUntil, TRAIN_LEAD_MIN);
  assert.ok(got[0].message.includes("高铁 G1234"));
  assert.ok(got[0].message.includes("30 分钟"));
});

test("tick: 航班 45 分钟 / 返程出发 90 分钟各用各的提前量", async () => {
  const { svc, got } = makeService(
    [
      {
        planId: "p2",
        destination: "三亚",
        transferSegments: [
          { type: "flight", role: "arrival", no: "CA1832", from: "出发地", to: "三亚", arrTime: isoPlus(FLIGHT_LEAD_MIN) },
          { type: "train", role: "departure", no: "D2298", from: "三亚", to: "出发地", depTime: isoPlus(DEPARTURE_LEAD_MIN) },
        ],
      },
    ],
    BASE,
  );
  await svc.tick(BASE);
  assert.equal(got.length, 2);
  const flight = got.find((p) => p.segment.no === "CA1832")!;
  const depart = got.find((p) => p.segment.no === "D2298")!;
  assert.equal(flight.phase, "pre_arrival");
  assert.equal(depart.phase, "pre_departure");
  assert.ok(depart.message.includes("90 分钟"));
});

test("tick: 窗口外不触发（过早 / 已过期超容忍）", async () => {
  const { svc, got } = makeService(
    [
      {
        planId: "p3",
        destination: "北京",
        transferSegments: [
          // 太早：还剩 90 分钟（> 30）
          { type: "train", role: "arrival", no: "G1", from: "x", to: "北京", arrTime: isoPlus(90) },
          // 窗口已过太久：剩 15 分钟（< 30 - 10 容忍）
          { type: "train", role: "arrival", no: "G2", from: "x", to: "北京", arrTime: isoPlus(15) },
        ],
      },
    ],
    BASE,
  );
  await svc.tick(BASE);
  assert.equal(got.length, 0);
});

test("tick: 容忍期内（窗口过后 10 分钟内）仍可发", async () => {
  const { svc, got } = makeService(
    [
      {
        planId: "p4",
        destination: "北京",
        transferSegments: [
          { type: "train", role: "arrival", no: "G3", from: "x", to: "北京", arrTime: isoPlus(TRAIN_LEAD_MIN - 8) },
        ],
      },
    ],
    BASE,
  );
  await svc.tick(BASE);
  assert.equal(got.length, 1);
});

test("tick: 同段同相位只问一次（sent 去重）", async () => {
  const { svc, got } = makeService(
    [
      {
        planId: "p5",
        destination: "成都",
        transferSegments: [
          { type: "train", role: "arrival", no: "G5", from: "x", to: "成都", arrTime: isoPlus(29) },
        ],
      },
    ],
    BASE,
  );
  await svc.tick(BASE);
  await svc.tick(BASE);
  assert.equal(got.length, 1);
});

test("tick: pickupConfirmed / pickupDismissed 的段永不再问", async () => {
  const { svc, got } = makeService(
    [
      {
        planId: "p6",
        destination: "成都",
        transferSegments: [
          { type: "train", role: "arrival", no: "G6", from: "x", to: "成都", arrTime: isoPlus(28), pickupConfirmed: true },
          { type: "train", role: "arrival", no: "G7", from: "x", to: "成都", arrTime: isoPlus(28), pickupDismissed: true },
        ],
      },
    ],
    BASE,
  );
  await svc.tick(BASE);
  assert.equal(got.length, 0);
});

test("tick: 无时刻段降级为行程首日 08:00 missing_time；无 startDate 不触发", async () => {
  const past = makeService(
    [
      {
        planId: "p7",
        destination: "昆明",
        startDate: "2026-10-18",
        transferSegments: [{ type: "flight", role: "arrival", no: "MU5137", from: "出发地", to: "昆明" }],
      },
    ],
    BASE,
  );
  await past.svc.tick(BASE);
  assert.equal(past.got.length, 1);
  assert.equal(past.got[0].phase, "missing_time");
  assert.ok(past.got[0].message.includes("还不知道具体时刻"));

  const future = makeService(
    [
      {
        planId: "p8",
        destination: "昆明",
        startDate: "2026-10-19",
        transferSegments: [{ type: "flight", role: "arrival", no: "MU5137", from: "出发地", to: "昆明" }],
      },
    ],
    BASE,
  );
  await future.svc.tick(BASE);
  assert.equal(future.got.length, 0);

  const noDate = makeService(
    [
      {
        planId: "p9",
        destination: "昆明",
        transferSegments: [{ type: "flight", role: "arrival", no: "MU5137", from: "出发地", to: "昆明" }],
      },
    ],
    BASE,
  );
  await noDate.svc.tick(BASE);
  assert.equal(noDate.got.length, 0);
});

test("applyPickupAnswer: 透传 setPickupState（accepted→confirmed）", () => {
  const calls: Array<[string, string, string]> = [];
  const svc = new TransferWatchService({
    listPlans: () => [],
    onReminder: () => {},
    setPickupState: (planId, no, state) => {
      calls.push([planId, no, state]);
      return true;
    },
  });
  assert.equal(svc.applyPickupAnswer("p1", "G1", true), true);
  assert.equal(svc.applyPickupAnswer("p1", "G2", false), true);
  assert.deepEqual(calls, [
    ["p1", "G1", "confirmed"],
    ["p1", "G2", "dismissed"],
  ]);
});

// ── 返程出发提醒 · UserTimingService 动态反算（2026-10-18 travel 双端④）──

function makeDepartureService(
  depTime: string,
  now: Date,
  wakeHour?: number | null,
): { svc: TransferWatchService; got: TransferReminderPayload[] } {
  const got: TransferReminderPayload[] = [];
  const svc = new TransferWatchService({
    listPlans: () =>
      [
        {
          planId: "pd",
          sessionId: "s-actor",
          destination: "三亚",
          transferSegments: [
            { type: "train", role: "departure", no: "D2298", from: "三亚站", to: "出发地", depTime },
          ],
        },
      ] as never,
    onReminder: (p) => {
      got.push(p);
    },
    setPickupState: () => true,
    ...(wakeHour === undefined ? {} : { getWakeHour: () => wakeHour }),
    now: () => now,
  });
  return { svc, got };
}

test("departure: 提醒点落在起床前 → 顶到起床后 30 分钟，文案切时间紧版", async () => {
  // 学到起床 8:00；车 9:00 发 → base 7:30 在起床前，顶到 8:30（提前量 30 分钟）
  const { svc, got } = makeDepartureService("2026-10-19T09:00:00", new Date("2026-10-19T08:30:00"), 8.0);
  await svc.tick();
  assert.equal(got.length, 1);
  assert.equal(got[0].phase, "pre_departure");
  assert.equal(got[0].minutesUntil, 30);
  assert.ok(got[0].message.includes("很快就要发车"));
  assert.ok(!got[0].message.includes("90 分钟"));
});

test("departure: 提醒点在起床后（白天返程）→ 固定 90 分钟提前量不变", async () => {
  // 起床 8:00；车 10:00 发 → base 8:30 恰在起床后 30 分钟，不受影响
  const { svc, got } = makeDepartureService("2026-10-19T10:00:00", new Date("2026-10-19T08:30:00"), 8.0);
  await svc.tick();
  assert.equal(got.length, 1);
  assert.equal(got[0].minutesUntil, DEPARTURE_LEAD_MIN);
  assert.ok(got[0].message.includes("90 分钟"));
});

test("departure: 作息未学出 → 回退固定 90 分钟提前量", async () => {
  const { svc, got } = makeDepartureService("2026-10-19T09:00:00", new Date("2026-10-19T07:30:00"), null);
  await svc.tick();
  assert.equal(got.length, 1);
  assert.equal(got[0].minutesUntil, DEPARTURE_LEAD_MIN);
});
