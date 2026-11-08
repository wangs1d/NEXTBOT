import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildReminderPolicy } from "../src/services/schedule-reminder-policy.js";
import {
  ScheduleHabitStore,
  isPlausibleSleepStartHour,
  isPlausibleWakeHour,
  parseSleepRoutine,
} from "../src/services/schedule-habit-store.js";

/** 2099-01-10 10:00 北京时间（无 DST，墙钟换算稳定） */
const DENTIST_RUN_AT = "2099-01-10T02:00:00.000Z";
const CREATED_DAYS_AHEAD = "2099-01-07T18:00:00.000Z";

test("parseSleepRoutine：常见口语写法（点/半/冒号/中文数字/时段标记）", () => {
  assert.deepEqual(parseSleepRoutine("我一般1点半睡，早上8点起"), { sleepStartHour: 1.5, wakeHour: 8 });
  assert.deepEqual(parseSleepRoutine("晚上11点半睡，7点起床"), { sleepStartHour: 23.5, wakeHour: 7 });
  assert.deepEqual(parseSleepRoutine("23:30 睡觉，8:00 起床"), { sleepStartHour: 23.5, wakeHour: 8 });
  assert.deepEqual(parseSleepRoutine("凌晨1点睡，9点醒"), { sleepStartHour: 1, wakeHour: 9 });
  assert.deepEqual(parseSleepRoutine("我平时12点睡6点半起"), { sleepStartHour: 0, wakeHour: 6.5 });
  assert.deepEqual(parseSleepRoutine("一般十一点半睡，八点起"), { sleepStartHour: 23.5, wakeHour: 8 });
});

test("parseSleepRoutine：线索缺失/不相关文本一律不记（宁缺勿错）", () => {
  assert.equal(parseSleepRoutine("明天上午十点去看牙医"), null);
  assert.equal(parseSleepRoutine("我一般1点半睡"), null); // 只有入睡点
  assert.equal(parseSleepRoutine("7点起床"), null); // 只有起床点
  assert.equal(parseSleepRoutine("下午1点睡个午觉，3点起床"), null); // 午睡不是作息
  assert.equal(parseSleepRoutine(""), null);
});

test("isPlausible：入睡 18:00–24:00 / 00:00–08:00；起床 03:00–15:00", () => {
  assert.equal(isPlausibleSleepStartHour(1.5), true);
  assert.equal(isPlausibleSleepStartHour(23.5), true);
  assert.equal(isPlausibleSleepStartHour(12), false);
  assert.equal(isPlausibleWakeHour(8), true);
  assert.equal(isPlausibleWakeHour(6.5), true);
  assert.equal(isPlausibleWakeHour(20), false);
});

test("ScheduleHabitStore：set/get/clear + 落盘往返", async () => {
  const dir = await mkdtemp(join(tmpdir(), "schedule-habit-store-"));
  const file = join(dir, "sleep-routine.json");
  try {
    const store = new ScheduleHabitStore(file);
    assert.equal(store.get("u1"), null);
    const written = store.set("u1", { sleepStartHour: 1.5, wakeHour: 8 }, "explicit");
    assert.equal(written.source, "explicit");
    assert.equal(existsSync(file), true);

    const reloaded = new ScheduleHabitStore(file);
    reloaded.load();
    assert.deepEqual(reloaded.get("u1"), {
      sleepStartHour: 1.5,
      wakeHour: 8,
      source: "explicit",
      updatedAt: written.updatedAt,
    });

    assert.equal(reloaded.clear("u1"), true);
    assert.equal(reloaded.get("u1"), null);
    const afterClear = new ScheduleHabitStore(file);
    afterClear.load();
    assert.equal(afterClear.get("u1"), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("captureFromUserText：命中即写、重复值不重复写", async () => {
  const dir = await mkdtemp(join(tmpdir(), "schedule-habit-capture-"));
  const file = join(dir, "sleep-routine.json");
  try {
    const store = new ScheduleHabitStore(file);
    assert.equal(store.captureFromUserText("u1", "随便聊聊天气"), false);
    assert.equal(store.captureFromUserText("u1", "我一般1点半睡，早上8点起"), true);
    assert.equal(store.get("u1")?.source, "chat");
    // 同值重复轮：不重复落盘
    assert.equal(store.captureFromUserText("u1", "对，1点半睡，8点起"), false);
    // 改口：覆盖
    assert.equal(store.captureFromUserText("u1", "最近改成12点睡了，还是8点起"), true);
    assert.equal(store.get("u1")?.sleepStartHour, 0);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).actors.u1.sleepStartHour, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("策略层：用户自述作息（source=chat/explicit）1 条即启用个性化，样本不足仍回默认", () => {
  const base = {
    runAt: DENTIST_RUN_AT, // 10:00
    timezone: "Asia/Shanghai",
    description: "上午十点去看牙医",
    now: new Date(CREATED_DAYS_AHEAD),
  };
  // 自述作息：睡前备忘 = 00:30（入睡 1:30 前 1 小时）→ 570min；预算 6.5h → 劝早睡
  const self = buildReminderPolicy({
    ...base,
    habits: { sleepStartHour: 1.5, wakeHour: 8, sampleCount: 1, source: "chat" },
  });
  assert.ok(self);
  const night = self.preReminders.find((p) => p.stage === "night_before");
  assert.equal(night?.offsetMinutes, 570);
  // 2026-11-05 起床闹钟段停用后，收尾话术不再引用「到闹钟只睡得约 X」；
  // 个性化仍由上面的 570min（入睡点前 1 小时）体现，文案回到统一收尾。
  assert.match(night?.message ?? "", /【睡前备忘】.*到点会再提醒你/);

  // 无 source 且样本不足（2）→ 与无画像一致（默认 21:00 → 780）
  const untrusted = buildReminderPolicy({
    ...base,
    habits: { sleepStartHour: 1.5, wakeHour: 8, sampleCount: 2 },
  });
  assert.ok(untrusted);
  assert.equal(untrusted.remindBeforeMinutes[0], 780);
});
