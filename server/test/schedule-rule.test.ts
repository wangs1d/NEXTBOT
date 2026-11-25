// 统一重复规则引擎（RRULE 子集）：构建 / 展开 / 下一次 / 展示。
// 2026-11-25 架构收敛：替代「枚举展开器 + cron 枚举」两套并存实现。
import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRule,
  describeRule,
  expandRuleOccurrences,
  nextRuleOccurrenceMs,
  parseRule,
} from "../src/services/schedule-rule.js";

const TZ = "Asia/Shanghai";
/** 本地 2026-11-25 07:00（周三）。 */
const ANCHOR = "2026-11-24T23:00:00.000Z";
const DAY = 86_400_000;
const from = new Date("2026-11-24T16:00:00.000Z").getTime(); // 本地 11-25 00:00

test("buildRule：枚举与 cron 都归一成 RRULE", () => {
  assert.equal(buildRule({ recurrence: "daily", runAt: ANCHOR, timezone: TZ }), "FREQ=DAILY;INTERVAL=1");
  assert.equal(
    buildRule({ recurrence: "weekly", runAt: ANCHOR, timezone: TZ }),
    "FREQ=WEEKLY;INTERVAL=1;BYDAY=WE",
  );
  assert.equal(
    buildRule({
      recurrence: "cron",
      cronExpression: "0 9 * * 1,2,3,4,5",
      runAt: ANCHOR,
      timezone: TZ,
    }),
    "FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,TU,WE,TH,FR",
  );
  assert.equal(
    buildRule({ recurrence: "cron", cronExpression: "0 9 * * *", runAt: ANCHOR, timezone: TZ }),
    "FREQ=DAILY;INTERVAL=1",
  );
  assert.equal(
    buildRule({ recurrence: "cron", cronExpression: "0 9 1 * *", runAt: ANCHOR, timezone: TZ }),
    "FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=1",
  );
  // 步长 cron 用单条 RRULE 说不清 → null（调用方保留 cronExpression 走旧路径）
  assert.equal(
    buildRule({ recurrence: "cron", cronExpression: "*/5 * * * *", runAt: ANCHOR, timezone: TZ }),
    null,
  );
  assert.equal(buildRule({ recurrence: "none", runAt: ANCHOR, timezone: TZ }), null);
});

test("parseRule：拒绝带序号的 BYDAY，避免算错日期", () => {
  assert.equal(parseRule("RRULE:FREQ=MONTHLY;BYDAY=2TU"), null);
  assert.equal(parseRule("FREQ=WEEKLY;BYDAY=MO,WE")?.byDay.join(","), "1,3");
  assert.equal(parseRule("FREQ=DAILY;COUNT=3;UNTIL=20261231T000000Z"), null); // 互斥
});

test("展开工作日规则：30 天窗口内只出周一到周五", () => {
  const rule = buildRule({
    recurrence: "cron",
    cronExpression: "0 9 * * 1,2,3,4,5",
    runAt: ANCHOR,
    timezone: TZ,
  })!;
  const list = expandRuleOccurrences({
    rule,
    anchorIso: ANCHOR,
    timezone: TZ,
    fromMs: from,
    toMs: from + 30 * DAY,
  });
  assert.ok(list.length >= 20);
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short" });
  assert.equal(
    list.some((o) => ["Sat", "Sun"].includes(fmt.format(new Date(o.at)))),
    false,
  );
  // 首条就是锚点当天（本地 11-25 07:00 之外，9 点版本用 07:00 作 anchor，这里只用时分）
  assert.equal(new Date(list[0]!.at).getUTCHours(), 23); // 本地 07:00 = UTC 前一日 23:00
});

test("展开 daily：窗口内每天一条，且不含窗口外的", () => {
  const rule = buildRule({ recurrence: "daily", runAt: ANCHOR, timezone: TZ })!;
  const list = expandRuleOccurrences({
    rule,
    anchorIso: ANCHOR,
    timezone: TZ,
    fromMs: from,
    toMs: from + 10 * DAY,
  });
  assert.equal(list.length, 10);
  for (let i = 1; i < list.length; i += 1) {
    assert.equal(list[i]!.at - list[i - 1]!.at, DAY);
  }
});

test("exdates 跳过某一次、overrides 把某一次移到别的时刻", () => {
  const rule = buildRule({ recurrence: "daily", runAt: ANCHOR, timezone: TZ })!;
  const base = expandRuleOccurrences({
    rule,
    anchorIso: ANCHOR,
    timezone: TZ,
    fromMs: from,
    toMs: from + 3 * DAY,
  });
  assert.equal(base.length, 3);
  const secondIso = new Date(base[1]!.at).toISOString();
  const movedTo = new Date(base[1]!.at + 2 * 3600_000).toISOString();

  const skipped = expandRuleOccurrences({
    rule,
    anchorIso: ANCHOR,
    timezone: TZ,
    fromMs: from,
    toMs: from + 3 * DAY,
    exdates: [secondIso],
  });
  assert.equal(skipped.length, 2);

  const moved = expandRuleOccurrences({
    rule,
    anchorIso: ANCHOR,
    timezone: TZ,
    fromMs: from,
    toMs: from + 3 * DAY,
    overrides: [{ originalAt: secondIso, at: movedTo }],
  });
  assert.equal(moved.length, 3);
  assert.ok(moved.some((o) => o.at === new Date(movedTo).getTime()));
});

test("nextRuleOccurrenceMs：严格下一次（不含已过时刻）", () => {
  const rule = buildRule({ recurrence: "daily", runAt: ANCHOR, timezone: TZ })!;
  const next = nextRuleOccurrenceMs({
    rule,
    anchorIso: ANCHOR,
    timezone: TZ,
    afterMs: new Date(ANCHOR).getTime(),
  });
  assert.equal(next, new Date(ANCHOR).getTime() + DAY);
});

test("describeRule：从规则反推人话", () => {
  assert.equal(describeRule("FREQ=DAILY;INTERVAL=1"), "每天");
  assert.equal(
    describeRule("FREQ=DAILY;INTERVAL=1;BYDAY=SU,MO,TU,WE,TH,FR,SA"),
    "每天",
  );
  assert.equal(
    describeRule("FREQ=DAILY;INTERVAL=1;BYDAY=SU,TU,WE,TH,FR,SA"),
    "每天除周一",
  );
  assert.equal(describeRule("FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,TU,WE,TH,FR"), "每个工作日");
  assert.equal(describeRule("FREQ=WEEKLY;INTERVAL=1;BYDAY=WE"), "每周三");
  assert.equal(
    describeRule("FREQ=WEEKLY;INTERVAL=1;BYDAY=SU,TU,WE,TH,FR,SA"),
    "每天除周一",
  );
  assert.equal(describeRule("FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,TU,WE,TH,FR,SA,SU"), "每天");
  assert.equal(describeRule("FREQ=WEEKLY;INTERVAL=2;BYDAY=WE"), "隔周三");
  assert.equal(describeRule("FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=15"), "每月 15 日");
  assert.equal(describeRule("FREQ=YEARLY;INTERVAL=1;BYMONTH=3;BYMONTHDAY=15"), "每年 3 月 15 日");
  assert.equal(describeRule(null), "单次提醒");
});
