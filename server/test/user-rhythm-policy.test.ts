/**
 * 用户节奏因子（UserRhythmStore + 分级提醒策略 rhythm 输入）单测。
 *
 * 覆盖：
 *   1. store：explicit 单条生效并覆盖 observed；observed 需 ≥2 样本滚动均值
 *   2. clamp：出域值夹回 [10,180]，非法值拒收
 *   3. 策略层：rhythm.departurePrepMin 替换默认 prep（出发段偏移随之变化）；
 *     无 rhythm 回退默认
 *   4. purgeActor：隐私级联清空
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  UserRhythmStore,
  PREP_MIN_FLOOR,
  PREP_MIN_CEILING,
} from "../src/services/user-rhythm-store.js";
import {
  assessScheduleEventFactors,
  buildReminderPolicy,
} from "../src/services/schedule-reminder-policy.js";

function makeStore(): { store: UserRhythmStore; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "user-rhythm-"));
  const path = join(dir, "user-rhythm.json");
  return { store: new UserRhythmStore({ persistPath: path }), path };
}

const RUN_AT = "2099-02-01T02:00:00.000Z"; // 本地 10:00（UTC+8），远离早晚极端

test("user-rhythm：explicit 单条生效、覆盖 observed；observed 需 ≥2 样本", () => {
  const { store } = makeStore();
  assert.deepEqual(store.hintsFor("u1").departurePrepMin, null, "无档案 → null（策略走默认）");

  // observed 1 次：不足以信托
  store.observeDepartureMinutes("u1", 25);
  assert.equal(store.hintsFor("u1").departurePrepMin, null);

  // observed 2 次：滚动均值生效
  store.observeDepartureMinutes("u1", 35);
  assert.equal(store.hintsFor("u1").departurePrepMin, 30);
  assert.equal(store.hintsFor("u1").source, "observed");

  // explicit 权威：单条生效并压制 observed（后续观察不再覆盖）
  store.setDeparturePrepMin("u1", 20);
  assert.equal(store.hintsFor("u1").departurePrepMin, 20);
  assert.equal(store.hintsFor("u1").source, "explicit");
  store.observeDepartureMinutes("u1", 90);
  assert.equal(store.hintsFor("u1").departurePrepMin, 20, "explicit 优先，观察不覆盖");
});

test("user-rhythm：clamp 与非法值拒收", () => {
  const { store } = makeStore();
  assert.equal(store.setDeparturePrepMin("u1", 3), PREP_MIN_FLOOR);
  assert.equal(store.setDeparturePrepMin("u1", 999), PREP_MIN_CEILING);
  assert.equal(store.setDeparturePrepMin("u1", -5), null);
  assert.equal(store.setDeparturePrepMin("u1", Number.NaN), null);
});

test("user-rhythm：purgeActor 清空档案（隐私级联）", () => {
  const { store } = makeStore();
  store.setDeparturePrepMin("u1", 20);
  assert.equal(store.purgeActor("u1"), true);
  assert.equal(store.hintsFor("u1").departurePrepMin, null);
  assert.equal(store.purgeActor("u1"), false);
});

test("policy：rhythm.departurePrepMin 替换默认 prep，出发段偏移随之变化", () => {
  const base = {
    runAt: RUN_AT,
    timezone: "Asia/Shanghai",
    description: "周六上午十点去协和医院看牙医",
    reminderMessage: "该去看牙医啦",
  };

  // 无 rhythm：默认 high 事件 prep=60
  const defFactors = assessScheduleEventFactors({ ...base });
  assert.equal(defFactors.prepMinutes, 60);

  // rhythm 生效：prep=25 → neededLead = travel + 25
  const rhythm = { departurePrepMin: 25, source: "explicit" as const };
  const custom = assessScheduleEventFactors({ ...base, rhythm });
  assert.equal(custom.prepMinutes, 25);

  // 落到分段计划：prep 进的是「起床闹钟」段（neededLead = travel + prep），
  // 出发段只含路程不变
  const planDefault = buildReminderPolicy({ ...base });
  const planCustom = buildReminderPolicy({ ...base, rhythm });
  assert.ok(planDefault && planCustom);
  const wakeDefault = planDefault.preReminders.find((p) => p.stage === "wake_alarm");
  const wakeCustom = planCustom.preReminders.find((p) => p.stage === "wake_alarm");
  assert.ok(wakeDefault && wakeCustom, "早晨 + 高代价事项应有起床闹钟段");
  assert.equal(
    wakeCustom.offsetMinutes,
    wakeDefault.offsetMinutes - (60 - 25),
    "起床闹钟随用户节奏提前量收缩 35 分钟",
  );
  const departDefault = planDefault.preReminders.find((p) => p.stage === "depart");
  const departCustom = planCustom.preReminders.find((p) => p.stage === "depart");
  if (departDefault && departCustom) {
    assert.equal(departCustom.offsetMinutes, departDefault.offsetMinutes, "出发段只含路程，不受 prep 影响");
  }

  // 非法 rhythm 值回退默认
  const invalid = assessScheduleEventFactors({ ...base, rhythm: { departurePrepMin: -1 } });
  assert.equal(invalid.prepMinutes, 60);
});

test("user-rhythm：JSON 落盘往返（重启后因子仍在）", () => {
  const { store, path } = makeStore();
  store.setDeparturePrepMin("u1", 20);
  const reopened = new UserRhythmStore({ persistPath: path });
  assert.equal(reopened.hintsFor("u1").departurePrepMin, 20);
  assert.equal(reopened.hintsFor("u1").source, "explicit");
  const raw = JSON.parse(readFileSync(path, "utf8")) as { actors: Record<string, unknown> };
  assert.ok(raw.actors?.u1);
  rmSync(path, { force: true });
});

test("parsePrepMinutesFromFact：画像自述桥接判据（字段域 + 分钟值解析）", async () => {
  const { parsePrepMinutesFromFact } = await import("../src/services/user-rhythm-store.js");
  assert.equal(parsePrepMinutesFromFact("出门准备", "20分钟"), 20);
  assert.equal(parsePrepMinutesFromFact("出门准备", "半小时"), 30);
  assert.equal(parsePrepMinutesFromFact("出门准备", "1.5小时"), null, "小时级不涉出门节奏，拒收");
  assert.equal(parsePrepMinutesFromFact("收拾时间", "15分"), 15);
  assert.equal(parsePrepMinutesFromFact("职业", "20分钟"), null, "字段不在域内不解析");
  assert.equal(parsePrepMinutesFromFact("出门准备", "看情况"), null);
  assert.equal(parsePrepMinutesFromFact("出门准备", "5分钟"), PREP_MIN_FLOOR, "出域夹回下限");
});
