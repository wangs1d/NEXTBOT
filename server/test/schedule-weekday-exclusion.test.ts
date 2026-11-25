// 「除周一」丢失修复（2026-11-24）：
// 用户「每天早上除了周一都去游泳」此前被 inferRecurrenceFromUserText 判成 daily，
// 周一照样提醒——recurrence 枚举没有「除某天」，必须落 cron（`0 7 * * 0,2,3,4,5,6`），
// 并且闹钟联动要能把它映射成 RRULE.BYDAY，否则「除周一 + 闹钟」直接不建钟。
import assert from "node:assert/strict";
import test from "node:test";

import {
  ScheduleIntentService,
  buildWeeklyCronExcluding,
  isWorkdayRecurrence,
  parseWeekdayExclusions,
} from "../src/services/schedule-intent-service.js";
import { repeatRuleFromRecurrence } from "../src/services/alarm-clock/alarm-intent.js";

/** 固定时钟：北京时间 2026-11-25 09:00（周三）。 */
const AT_09 = new Date("2026-11-25T01:00:00.000Z");

test("识别明确的排除语义：除周一 / 周一不去 / 周一休息 / 除周一和周三", () => {
  assert.deepEqual(parseWeekdayExclusions("每天早上除了周一都去游泳"), [1]);
  assert.deepEqual(parseWeekdayExclusions("每天七点提醒我吃药，周一不去"), [1]);
  assert.deepEqual(parseWeekdayExclusions("每天七点提醒我吃药，周一休息"), [1]);
  assert.deepEqual(parseWeekdayExclusions("除了周一和周三，其他天都提醒我"), [1, 3]);
  assert.deepEqual(parseWeekdayExclusions("周一到周五提醒我打卡，周六周日不用"), [0, 6]);
});

test("只是提到某天不算排除（不能把「周一有个会」当成周一不提醒）", () => {
  assert.deepEqual(parseWeekdayExclusions("周一有个会提醒我"), []);
  assert.deepEqual(parseWeekdayExclusions("每天早上七点提醒我去游泳"), []);
});

test("cron 编织取用户本地时分，星期段是剩余的天", () => {
  // runAt = 北京时间 2026-11-25 07:00
  const iso = "2026-11-24T23:00:00.000Z";
  assert.equal(buildWeeklyCronExcluding(iso, "Asia/Shanghai", [1]), "0 7 * * 0,2,3,4,5,6");
  assert.equal(buildWeeklyCronExcluding(iso, "Asia/Shanghai", [0, 6]), "0 7 * * 1,2,3,4,5");
  // 全部排除 → null（调用方保持原 recurrence，不造永不触发的任务）
  assert.equal(buildWeeklyCronExcluding(iso, "Asia/Shanghai", [0, 1, 2, 3, 4, 5, 6]), null);
});

test("「每天早上七点除了周一」解析成 cron，而不是降级成 daily", async () => {
  const service = new ScheduleIntentService(null);
  const draft = await service.parse("s-weekday", "每天早上七点除了周一提醒我去游泳", {
    userTimezone: "Asia/Shanghai",
    now: AT_09,
  });
  assert.ok(draft);
  assert.equal(draft!.recurrence, "cron");
  assert.equal(draft!.cronExpression, "0 7 * * 0,2,3,4,5,6");
  assert.equal(draft!.runAt, "2026-11-25T23:00:00.000Z"); // 本地 11-26 07:00
});

test("没说排除日时仍走 daily（不能误伤普通每天提醒）", async () => {
  const service = new ScheduleIntentService(null);
  const draft = await service.parse("s-weekday", "每天早上七点提醒我去游泳", {
    userTimezone: "Asia/Shanghai",
    now: AT_09,
  });
  assert.ok(draft);
  assert.equal(draft!.recurrence, "daily");
  assert.equal(draft!.cronExpression, undefined);
});

test("cron 重复能映射成闹钟 RRULE，周一不响", () => {
  const { rule, ok } = repeatRuleFromRecurrence("cron", "0 7 * * 0,2,3,4,5,6");
  assert.equal(ok, true);
  assert.equal(rule, "RRULE:FREQ=WEEKLY;BYDAY=SU,TU,WE,TH,FR,SA");
});

test("一天多次的 cron 不给闹钟（单 fireAt 表达不了，回退纯提醒）", () => {
  assert.equal(repeatRuleFromRecurrence("cron", "0 */2 * * 0,2,3,4,5,6").ok, false);
  assert.equal(repeatRuleFromRecurrence("cron", "0 7 1 * *").ok, false);
  assert.equal(repeatRuleFromRecurrence("cron").ok, false);
});

// ── P0：工作日类表达（2026-11-25）──────────────────────────────────
test("每个工作日 / 周一到周五 / 工作日 → cron BYDAY 1-5", async () => {
  const service = new ScheduleIntentService(null);
  const cases: Array<[string, string]> = [
    ["每个工作日早上九点提醒我打卡", "0 9 * * 1,2,3,4,5"],
    ["工作日早上九点提醒我打卡", "0 9 * * 1,2,3,4,5"],
    ["周一到周五早上九点提醒我打卡", "0 9 * * 1,2,3,4,5"],
    ["周一至周五早上九点提醒我打卡", "0 9 * * 1,2,3,4,5"],
    ["每周一到周五早上九点提醒我打卡", "0 9 * * 1,2,3,4,5"],
  ];
  for (const [text, expectCron] of cases) {
    const draft = await service.parse("s-workday", text, {
      userTimezone: "Asia/Shanghai",
      now: AT_09,
    });
    assert.ok(draft, text);
    assert.equal(draft!.recurrence, "cron", text);
    assert.equal(draft!.cronExpression, expectCron, text);
  }
});

test("周一到周日的整周表达不被当成工作日", async () => {
  assert.equal(isWorkdayRecurrence("周一到周日早上九点提醒我"), false);
  assert.equal(isWorkdayRecurrence("每周三早上九点提醒我"), false);
  assert.deepEqual(parseWeekdayExclusions("周一到周五提醒我打卡，周六周日不用"), [0, 6]);
});
