// overwork-trigger 单测：
// 1. 休息提醒时间语义——「下一个未过的晚间时刻」（凌晨触发不再排到 42 小时后）
// 2. 就寝基线 → 提醒时刻（就寝前 1h，clamp 20:00-次日 01:00）
// 3. reason 分叉——深夜活跃不再伪造「连续工作」叙事，summary/templateData 如实
import assert from "node:assert/strict";
import test from "node:test";

import {
  buildOverworkIntent,
  nextEveningRunAt,
  restTargetHourFromBedtime,
} from "../src/proactivity/triggers/overwork-trigger.js";

/** 本地时间构造（今天/指定偏移天 的 时:分） */
function atHour(hour: number, minute = 0, dayOffset = 0): Date {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, minute, 0, 0);
  return d;
}

test("nextEveningRunAt：凌晨触发排今晚（不是 +1 天的 42 小时后）", () => {
  // 实盘 bug：10-04 01:47 触发却排到 10-05 20:00（42h 后），文案还说「今晚」
  const runAt = nextEveningRunAt(atHour(1, 47));
  assert.ok(runAt.includes("T20:00:00"));
  const day = Number(runAt.slice(8, 10));
  assert.equal(day, atHour(1, 47).getDate()); // 就是触发当天晚上
});

test("nextEveningRunAt：晚间已过 20:00 → 排明晚", () => {
  const runAt = nextEveningRunAt(atHour(23, 1));
  assert.ok(runAt.includes("T20:00:00"));
  assert.equal(Number(runAt.slice(8, 10)), atHour(23, 1, 1).getDate());
});

test("nextEveningRunAt：目标小时带小数/跨午夜（就寝 1:30 → 00:30）", () => {
  const runAt = nextEveningRunAt(atHour(23, 1), 24.5);
  assert.ok(runAt.includes("T00:30:00"));
  assert.equal(Number(runAt.slice(8, 10)), atHour(23, 1, 1).getDate()); // 今天 00:30 已过 → 明天
});

test("restTargetHourFromBedtime：就寝前 1h，clamp 20:00-次日 01:00；无基线返回 null", () => {
  assert.equal(restTargetHourFromBedtime(null), null); // 没学会作息 → 不猜时间
  assert.equal(restTargetHourFromBedtime(undefined), null);
  assert.equal(restTargetHourFromBedtime(22.5), 21.5); // 22:30 睡 → 21:30 提醒
  assert.equal(restTargetHourFromBedtime(25.5), 24.5); // 凌晨 1:30 睡 → 00:30
  assert.equal(restTargetHourFromBedtime(28), 25); // 睡得再晚也不超过次日 01:00
  assert.equal(restTargetHourFromBedtime(15), 20); // 就寝样本污染（下午）→ 兜底 20:00
});

test("buildOverworkIntent：作息未学会——不排提醒、不猜时间", () => {
  const intent = buildOverworkIntent(
    "actor-1",
    { continuousWorkHours: 0, lateNightActiveCount: 3, reason: "late_night_active", learnedBedtimeHour: null },
    atHour(1, 47),
  );
  assert.equal(intent.kind, "overwork_care");
  assert.ok(intent.summary.includes("深夜活跃 3 次"));
  assert.ok(!intent.summary.includes("连续工作"));
  assert.ok(!intent.summary.includes("排了休息提醒")); // 没学会作息就没排，summary 不撒谎
  const tools = intent.actArgs.map((s) => s.tool);
  assert.deepEqual(tools, ["media.search", "media.play"]); // 无 calendar 步骤
  assert.equal((intent.templateData as { reason?: string }).reason, "late_night_active");
  assert.equal((intent.templateData as { count?: number }).count, 3);
  assert.equal((intent.templateData as { hours?: number }).hours, undefined);
});

test("buildOverworkIntent：深夜活跃 + 有作息基线——提醒排在就寝前 1h（今晚）", () => {
  const intent = buildOverworkIntent(
    "actor-1",
    { continuousWorkHours: 0, lateNightActiveCount: 3, reason: "late_night_active", learnedBedtimeHour: 23.5 },
    atHour(1, 47),
  );
  const calendarStep = intent.actArgs.find((s) => s.tool === "calendar.create_task");
  assert.ok(calendarStep, "有作息基线必排提醒");
  const runAt = String((calendarStep.args as Record<string, unknown>).runAt);
  // 就寝 23:30 → 提醒 22:30；01:47 触发时今天 22:30 未过 → 今晚
  assert.ok(runAt.includes("T22:30:00"));
  assert.equal(Number(runAt.slice(8, 10)), atHour(1, 47).getDate());
  assert.ok(intent.summary.includes("今晚"));
});

test("buildOverworkIntent：连续工作触发——summary 带真实时长，就寝基线决定提醒时刻", () => {
  const intent = buildOverworkIntent(
    "actor-1",
    { continuousWorkHours: 3.5, lateNightActiveCount: 0, reason: "continuous_work", learnedBedtimeHour: 25.5 },
    atHour(13, 12),
  );
  assert.ok(intent.summary.includes("连续工作了约 3.5 小时"));
  // 就寝 01:30 → 提醒 00:30；13:12 触发时今天 00:30 已过 → 明天 00:30
  const calendarStep = intent.actArgs.find((s) => s.tool === "calendar.create_task");
  const runAt = String((calendarStep!.args as Record<string, unknown>).runAt);
  assert.ok(runAt.includes("T00:30:00"));
  assert.equal(Number(runAt.slice(8, 10)), atHour(13, 12, 1).getDate());
  assert.ok(intent.summary.includes("明晚"));
  assert.equal((intent.templateData as { hours?: number }).hours, 3.5);
});

test("buildOverworkIntent：旧信号缺 reason 时按工作时长推导", () => {
  const intent = buildOverworkIntent("actor-1", { continuousWorkHours: 3.5, lateNightActiveCount: 0 }, atHour(10, 0));
  assert.equal((intent.templateData as { reason?: string }).reason, "continuous_work");
  const lateNight = buildOverworkIntent("actor-1", { continuousWorkHours: 0, lateNightActiveCount: 3 }, atHour(1, 0));
  assert.equal((lateNight.templateData as { reason?: string }).reason, "late_night_active");
});
