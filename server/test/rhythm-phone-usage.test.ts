/**
 * PRD §7「作息采集进画像」服务端测试。
 *
 * 锁死的语义：
 *  (a) 手机桶能判出「入睡样本 + 醒来样本」，且同一天压过桌面 sleep-window 判定
 *      （桌面源保留为兜底，手机没上报的日子仍要有作息）；
 *  (b) 新维度 wake / commute 拿到中位数与置信度（§7.6：连续 5 天 ≥0.6）；
 *  (c) 工作日与周末分组各算各的（混算会被周末补觉抹平）；
 *  (d) 端上没报过桶时这个传感器什么都不产出（不虚增画像、不报 stalled）；
 *  (e) 自述问卷值可进同一条链路，但置信度压在冷启动闸（0.5）以下（§7.4）。
 *
 * 全部用合成桶，时钟固定，不依赖任何真实手机数据。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { LifeRhythmEngine } from "../src/rhythm/engine.js";
import { RhythmProfileStore } from "../src/rhythm/profile-store.js";
import { PhoneUsageSensor } from "../src/rhythm/sensors/phone-usage-sensor.js";
import { SleepWindowSensor } from "../src/rhythm/sensors/sleep-window-sensor.js";
import { commuteMinutesOf } from "../src/rhythm/dimensions/commute-model.js";

import type { PhoneBucketRawRow, PhoneBucketReader } from "../src/rhythm/sensors/phone-usage-sensor.js";
import type { RhythmSensor } from "../src/rhythm/types.js";

const ACTOR = "actor-phone-rhythm";
const BUCKET_MIN = 15 * 60 * 1000;
/** 分析时刻：11-23（周一）凌晨 3 点，夜间分析的常规触发点 */
const NOW = new Date(2026, 10, 23, 3, 0, 0);

/** 本地日 + 小时 → 桶起点 ms（用本地时间构造，避开 UTC 偏移把样本挪到别的日子） */
function at(day: number, hour: number, minute = 0): number {
  const d = new Date(2026, 10, day, Math.floor(hour), Math.round((hour % 1) * 60) + minute);
  return d.getTime();
}

function dayKey(day: number): string {
  return `2026-11-${String(day).padStart(2, "0")}`;
}

type NightPlan = {
  /** 当晚 22 点后活跃到几点（含该桶）；入睡判定点 = 它 + 15 分钟 */
  eveningActiveUntil: number;
  /** 熬到次日凌晨几点（周末夜用）；undefined = 不过零点 */
  overnightActiveUntil?: number;
  /** 次日清晨首次解锁的本地小时 */
  wakeHour: number;
};

/**
 * 造 15 天（2026-11-09 周一 ~ 11-23 周一凌晨 3 点）的满铺 15 分钟桶：
 *  - 工作日夜：活跃到 22:45（入睡点 23:00），次日 07:00 首次解锁，白天一条完整通勤链；
 *  - 周末夜（周六/周日为上床日）：活跃到次日 00:15（入睡点 00:30），上午 10:00 才起，整天在家；
 *  - 11-23 只有凌晨的桶：这一夜判得出入睡、判不出醒来（早晨还没过）。
 */
function buildBuckets(): PhoneBucketRawRow[] {
  const rows: PhoneBucketRawRow[] = [];
  for (let day = 9; day <= 23; day++) {
    const lastHour = day === 23 ? 3 : 24; // 分析时刻 11-23 03:00
    const wokeFrom = planFor(day - 1); // 今早结束的那一晚
    const ownNight = planFor(day); // 今晚（可能只生成到傍晚的桶）
    const commuting = isWeekday(day);
    for (let slot = 0; slot * 0.25 < lastHour; slot++) {
      const hour = slot * 0.25;
      const row: PhoneBucketRawRow = {
        bucket: at(day, hour),
        unlocks: 0,
        screenOnMin: 0,
        inCallMin: 0,
        charging: false,
        dnd: false,
        placeKind: "home",
      };
      if (hour < 6) {
        // 凌晨的桶属于前一晚：只在"周末夜熬过来的那段"里有活动，其余全静默
        const tail = planFor(day - 1).overnightActiveUntil;
        if (tail !== undefined && hour <= tail) {
          row.unlocks = 1;
          row.screenOnMin = 10;
        } else if (hour >= 1 && hour <= 3) {
          row.charging = true; // 睡着时在充电：入睡判定的佐证
        }
      } else if (hour < wokeFrom.wakeHour) {
        // 还没起：静默（这段静默正是"首次解锁 = 起床"的依据）
      } else if (hour < 22) {
        row.unlocks = 1;
        row.screenOnMin = 8;
        row.placeKind = placeOfDay(hour, commuting);
        if (commuting && hour >= 18.5) row.charging = true;
        if (commuting && hour >= 14 && hour < 15) {
          row.inCallMin = 12; // 下午一通长电话：占用 = 弱负接受度信号
          row.unlocks = 0;
          row.screenOnMin = 14;
        }
      } else if (hour <= ownNight.eveningActiveUntil) {
        row.unlocks = 2;
        row.screenOnMin = 12;
      }
      rows.push(row);
    }
  }
  return rows;
}

/** 上床日为 day 的那一晚长什么样（11-09 周一 … 11-15 周日 两周循环） */
function planFor(day: number): NightPlan {
  const weekday = new Date(2026, 10, day).getDay();
  const weekendNight = weekday === 6 || weekday === 0;
  const wakeDay = new Date(2026, 10, day + 1).getDay();
  const wakeHour = wakeDay === 6 || wakeDay === 0 ? 10 : 7;
  return weekendNight
    ? { eveningActiveUntil: 23.75, overnightActiveUntil: 0.25, wakeHour }
    : { eveningActiveUntil: 22.75, wakeHour };
}

/** 日历日本身是工作日还是周末（决定白天有没有通勤跳变） */
function isWeekday(day: number): boolean {
  const weekday = new Date(2026, 10, day).getDay();
  return weekday >= 1 && weekday <= 5;
}

/** 工作日一条完整通勤链：08:15 离家 → 09:00 到公司 → 18:30 离司 → 19:00 到家 */
function placeOfDay(hour: number, commute: boolean): string {
  if (!commute) return "home";
  if (hour < 8.25) return "home";
  if (hour < 9) return "other";
  if (hour < 18.5) return "work";
  if (hour < 19) return "other";
  return "home";
}


function readerWith(rows: PhoneBucketRawRow[]): PhoneBucketReader {
  return {
    list: (_actor, from, to) =>
      rows.filter((r) => r.bucket >= from.getTime() && r.bucket <= to.getTime()),
  };
}

async function withEngine(
  sensors: RhythmSensor[],
  fn: (engine: LifeRhythmEngine, store: RhythmProfileStore) => Promise<void> | void,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "rhythm-phone-"));
  const profileStore = new RhythmProfileStore(join(dir, "profiles"));
  await profileStore.load();
  const engine = new LifeRhythmEngine({ profileStore });
  for (const sensor of sensors) engine.registerSensor(sensor);
  try {
    await fn(engine, profileStore);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ── (a) 手机桶出入睡/醒来样本，且压过桌面判定 ──────────────

test("手机桶判出入睡与醒来样本；同一天手机样本优先于桌面 sleep-window", async () => {
  const sensor = new PhoneUsageSensor(readerWith(buildBuckets()), { now: () => NOW });
  const obs = await sensor.collect(ACTOR, new Date(at(9, 0)));

  const sleepSamples = obs.filter((o) => o.dimension === "sleep" && o.kind === "sleep_sample");
  const wakeSamples = obs.filter((o) => o.dimension === "wake" && o.kind === "wake_sample");
  assert.ok(sleepSamples.length >= 10, `期望 ≥10 个完整夜，实际 ${sleepSamples.length}`);
  assert.ok(wakeSamples.length >= 10, `期望 ≥10 个清晨样本，实际 ${wakeSamples.length}`);
  // 工作日夜：活跃到 22:45 → 入睡 23:00
  const mon = sleepSamples.find((o) => o.at.startsWith(dayKey(9)));
  assert.ok(mon, "11-09（周一）应有入睡样本");
  assert.equal(Math.round(mon!.value * 60) / 60, 23);
  // 次日 07:00 首次解锁 → 醒来样本落在 11-10，且与入睡配对成完整夜
  const tuesdayWake = wakeSamples.find((o) => o.at.startsWith(dayKey(10)));
  assert.ok(tuesdayWake, "11-10（周二）应有醒来样本");
  assert.equal(Math.round(tuesdayWake!.value * 60) / 60, 7);
  assert.equal(mon!.value2 !== undefined, true, "完整夜的 sleep 样本要带上醒来时刻");
  // 每一条观察都自报手机来源，优先级由模型器裁决
  assert.ok(sleepSamples.every((o) => o.source === "phone-usage"));
  // 分析当天（11-23）的早晨还没过：不能凭空造一个醒来样本
  assert.equal(wakeSamples.some((o) => o.at.startsWith(dayKey(23))), false);
});

test("手机优先，桌面兜底：同日手机样本覆盖桌面判定，手机没数据的日子保留桌面样本", async () => {
  const desktopSource = {
    // 桌面判定故意与手机不一致（20 点睡 / 6 点起），用来验证谁作数
    getRecentSleepWindowSamples: () => [
      { date: dayKey(9), startHour: 20, endHour: 6 },
      { date: dayKey(10), startHour: 20.5, endHour: 6.5 },
      // 手机还没报出完整夜的一晚（今晨的桶尚未上报）：桌面样本必须留着
      // （§7.3「保留桌面判定作为补充」）
      { date: dayKey(22), startHour: 22, endHour: 7.5 },
    ],
  };
  const desktop = new SleepWindowSensor();
  desktop.bindSource(desktopSource);
  // 桌面传感器先注册：优先权不能靠注册顺序，只能靠来源优先级
  const phone = new PhoneUsageSensor(readerWith(buildBuckets()), { now: () => NOW });

  await withEngine([desktop, phone], async (engine) => {
    const update = await engine.runAnalysis(ACTOR, { now: NOW });
    assert.ok(update);
    const dims = update!.profile.dimensions;
    const nov9 = dims.sleep.samples.find((s) => s.date === dayKey(9));
    const nov22 = dims.sleep.samples.find((s) => s.date === dayKey(22));
    assert.ok(nov9 && nov22, "两个来源的日期都要有样本");
    // 手机压过桌面
    assert.equal(nov9!.startHour, 23);
    assert.equal(nov9!.source, "phone-usage");
    // 桌面兜底
    assert.equal(nov22!.startHour, 22);
    assert.equal(nov22!.source, "sleep-window");
    // wake 同理：11-10 早晨手机说 7 点，桌面的 sleep 样本尾巴（6 点）不得覆盖
    const wake10 = dims.wake.samples.find((s) => s.date === dayKey(10));
    assert.equal(wake10!.hour, 7);
    assert.equal(wake10!.source, "phone-usage");
    // 只有桌面来源的那一晚（11-22 上床）仍要兜出一条 wake（归 11-23 上午）
    const wakeFromDesktop = dims.wake.samples.find((s) => s.source === "sleep-window");
    assert.ok(wakeFromDesktop, "桌面 sleep 样本要能兜出 wake 样本");
    assert.equal(wakeFromDesktop!.date, dayKey(23));
    assert.equal(wakeFromDesktop!.hour, 7.5);
  });
});

// ── (b) wake / commute 维度出值与置信度 ──────────────

test("新维度 wake 与 commute：中位数出值、置信度达标（§7.6 手机用户 5 天 ≥0.6）", async () => {
  const phone = new PhoneUsageSensor(readerWith(buildBuckets()), { now: () => NOW });
  await withEngine([phone], async (engine) => {
    const update = await engine.runAnalysis(ACTOR, { now: NOW });
    const dims = update!.profile.dimensions;

    assert.equal(dims.wake.sampleCount >= 5, true);
    // 11 个工作日清晨里混合了 7 点与 10 点，总体中位数取到早上那批
    assert.ok(dims.wake.wakeHour !== null && dims.wake.wakeHour >= 7 && dims.wake.wakeHour <= 10);
    const wakeConfidence = engine.dimensionConfidence(ACTOR, "wake");
    assert.ok(wakeConfidence >= 0.6, `wake 置信度应 ≥0.6，实际 ${wakeConfidence}`);
    assert.equal(wakeConfidence, Math.min(1, dims.wake.sampleCount / 7));

    assert.equal(dims.commute.overall.days >= 5, true);
    assert.equal(dims.commute.overall.leaveHomeHour, 8.25);
    assert.equal(dims.commute.overall.arriveWorkHour, 9);
    assert.equal(dims.commute.overall.leaveWorkHour, 18.5);
    const commuteConfidence = engine.dimensionConfidence(ACTOR, "commute");
    assert.ok(commuteConfidence >= 0.6, `commute 置信度应 ≥0.6，实际 ${commuteConfidence}`);
    // 手机样本占比要能被档案页读出来（"这份作息是谁给的"）
    assert.equal(dims.wake.phoneSampleRatio, 1);
    assert.equal(dims.sleep.phoneSampleRatio, 1);
  });
});

test("commuteMinutesOf → 触点计划的出门/下班两个 slot（分钟数按工作日组取）", async () => {
  const phone = new PhoneUsageSensor(readerWith(buildBuckets()), { now: () => NOW });
  await withEngine([phone], async (engine) => {
    await engine.runAnalysis(ACTOR, { now: NOW });
    const wednesday = engine.commuteMinutesOf(ACTOR, new Date(2026, 10, 18, 9, 0)); // 周三
    assert.deepEqual(wednesday, { leaveHome: Math.round(8.25 * 60), leaveWork: Math.round(18.5 * 60) });
    // 画像缺失的 actor 不给时刻（planner 据此不生成这两个 slot，宁缺勿假）
    assert.deepEqual(engine.commuteMinutesOf("nobody", new Date(2026, 10, 18, 9, 0)), {
      leaveHome: null,
      leaveWork: null,
    });
  });
});

// ── (c) 工作日 / 周末分组 ──────────────

test("工作日与周末分组各算各的：wake 差 3 小时、sleep 入睡差 1.5 小时", async () => {
  const phone = new PhoneUsageSensor(readerWith(buildBuckets()), { now: () => NOW });
  await withEngine([phone], async (engine) => {
    const update = await engine.runAnalysis(ACTOR, { now: NOW });
    const dims = update!.profile.dimensions;
    assert.equal(dims.wake.byDaypart.weekday.wakeHour, 7);
    assert.equal(dims.wake.byDaypart.weekend.wakeHour, 10);
    assert.equal(dims.wake.byDaypart.weekday.sampleCount, 10);
    assert.equal(dims.wake.byDaypart.weekend.sampleCount, 4);
    // 入睡：工作日夜 23:00，周末夜跨零点 00:30（分组内做跨午夜修正，不与工作日混算）
    assert.equal(dims.sleep.byDaypart.weekday.windowStartHour, 23);
    assert.equal(dims.sleep.byDaypart.weekend.windowStartHour, 0.5);
    // 总体口径仍在看全体（老消费方不受分组影响）
    assert.ok(dims.sleep.windowStartHour !== null);
    // 通勤只有工作日有围栏跳变，周末组自然为空（不是"0 点出门"这种假值）
    assert.equal(dims.commute.byDaypart.weekday.days >= 8, true);
    assert.equal(dims.commute.byDaypart.weekend.days, 0);
    assert.equal(dims.commute.byDaypart.weekend.leaveHomeHour, null);
    // 逐星期分布
    assert.equal(dims.commute.leaveHomeByWeekday[3], 8.25);
    assert.equal(dims.commute.leaveHomeByWeekday[0], null);
    // 分组口径落到模型器之外的同一个函数：周末日期退回总体中位数
    const weekendFallback = commuteMinutesOf(dims.commute, new Date(2026, 10, 21, 9, 0));
    assert.equal(weekendFallback.leaveHome, 495);
  });
});

test("focus 直方图按分组累计，phone_unlock 走弱交互权重", async () => {
  const phone = new PhoneUsageSensor(readerWith(buildBuckets()), { now: () => NOW });
  await withEngine([phone], async (engine) => {
    const update = await engine.runAnalysis(ACTOR, { now: NOW });
    const focus = update!.profile.dimensions.focus;
    assert.ok(focus.totalWeight > 0);
    assert.equal(focus.byDaypart.weekday.hourHistogram.length, 24);
    assert.equal(focus.byDaypart.weekend.hourHistogram.length, 24);
    // 工作日的白天（9-17 在司）有活跃，周末组几乎只有清晨与晚间
    assert.ok((focus.byDaypart.weekday.hourHistogram[10] ?? 0) > 0);
    assert.ok((focus.byDaypart.weekend.hourHistogram[12] ?? 0) <= (focus.byDaypart.weekday.hourHistogram[12] ?? 0));
  });
});

// ── (d) 没上报桶 → 什么都不产出 ──────────────

test("端上没报过桶：传感器零观察，wake/commute 置信度 0，不误报采样链断供", async () => {
  const empty = new PhoneUsageSensor(readerWith([]), { now: () => NOW });
  assert.equal(empty.expectsObservations, false, "合法空返回不能标 expectsObservations");
  const obs = await empty.collect(ACTOR, new Date(at(9, 0)));
  assert.deepEqual(obs, []);

  await withEngine([empty], async (engine) => {
    const update = await engine.runAnalysis(ACTOR, { now: NOW });
    const dims = update!.profile.dimensions;
    assert.equal(dims.wake.sampleCount, 0);
    assert.equal(dims.wake.wakeHour, null);
    assert.equal(dims.commute.overall.days, 0);
    assert.equal(engine.dimensionConfidence(ACTOR, "wake"), 0);
    assert.equal(engine.dimensionConfidence(ACTOR, "commute"), 0);
    // 整体置信度为 0 → 触点计划按冷启动走默认钟（闸值 0.5）
    assert.equal(engine.rhythmConfidence(ACTOR), 0);
    assert.equal(engine.health().sensors.find((s) => s.sensorId === "phone-usage")?.stalled, false);
  });
});

// ── (e) 自述问卷值：可用但置信度低于统计（§7.4） ──────────────

test("只有自述问卷值时 wake 出值但置信度压在冷启动闸以下；有统计后被顶掉", async () => {
  const selfOnly = new PhoneUsageSensor(readerWith([]), {
    now: () => NOW,
    selfReport: () => ({ wakeHour: 7.5, bedtimeHour: 24, commuteMinutes: 40, date: dayKey(20) }),
  });
  await withEngine([selfOnly], async (engine) => {
    const update = await engine.runAnalysis(ACTOR, { now: NOW });
    const wake = update!.profile.dimensions.wake;
    assert.equal(wake.sampleCount, 1);
    // 样本不足 3 天不出中位数，置信度必须为 0（问卷只解决"知道有这么个钟"）
    assert.equal(engine.dimensionConfidence(ACTOR, "wake"), 0);
    assert.ok(engine.rhythmConfidence(ACTOR) < 0.5, "纯自述不能把触点计划切出冷启动");
  });

  // 统计样本长出来后：同一天手机 7:00 顶掉自述的 7:50
  const both = new PhoneUsageSensor(readerWith(buildBuckets()), {
    now: () => NOW,
    selfReport: () => ({ wakeHour: 7.75, bedtimeHour: 24, date: dayKey(10) }),
  });
  await withEngine([both], async (engine) => {
    const update = await engine.runAnalysis(ACTOR, { now: NOW });
    const dims = update!.profile.dimensions;
    const wake10 = dims.wake.samples.find((s) => s.date === dayKey(10));
    assert.equal(wake10!.hour, 7, "同日统计样本要顶掉自述值");
    assert.equal(wake10!.source, "phone-usage");
    assert.ok(engine.rhythmConfidence(ACTOR) >= 0.5, "统计到位后整体置信度过冷启动闸");
  });
});

test("画像落盘回读：分组读数与通勤中位数不丢（旧文件缺字段也不炸）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rhythm-phone-persist-"));
  const path = join(dir, "profiles");
  const store = new RhythmProfileStore(path);
  await store.load();
  const engine = new LifeRhythmEngine({ profileStore: store });
  engine.registerSensor(new PhoneUsageSensor(readerWith(buildBuckets()), { now: () => NOW }));
  await engine.runAnalysis(ACTOR, { now: NOW });

  const reopened = new RhythmProfileStore(path);
  await reopened.load();
  const profile = reopened.get(ACTOR)!;
  assert.equal(profile.dimensions.wake.byDaypart.weekend.wakeHour, 10);
  assert.equal(profile.dimensions.wake.byDaypart.weekday.wakeHour, 7);
  assert.equal(profile.dimensions.commute.overall.leaveHomeHour, 8.25);
  // 手机只出活跃/醒来事实，不替桌面「最后活跃」判晚归：overtime 仍归 0 天，
  // 但分组结构要在（缺字段不能把画像读崩）
  assert.equal(profile.dimensions.overtime.byDaypart.weekday.days, 0);
  assert.equal(profile.dimensions.overtime.byDaypart.weekend.days, 0);
  assert.equal(profile.dimensions.receptivity.byDaypartHour.weekday.length, 24);
  await rm(dir, { recursive: true, force: true });
});
