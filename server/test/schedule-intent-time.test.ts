// 提醒时间解析契约（2026-10-13 根修「18:00 说 7点半 → 次日 07:30」）：
// - 裸「X点半/X点」（1–11 点、无时段词、无明天/后天）早于当前 → 就近未来 +12h 解释；
// - 时段词（晚上/下午）对阿拉伯数字形态同样生效；
// - 显式 早上/上午/凌晨 与 明天/后天 保持字面语义；
// - 高置信一次性事项（快递/开会等）不再被重复确认闸门拦下（直接创建）。
import assert from "node:assert/strict";
import test from "node:test";

import {
  ScheduleIntentService,
  parseScheduleTimeFromPrompt,
} from "../src/services/schedule-intent-service.js";

/** 固定时钟：北京时间 2026-10-13 18:00（周二，UTC 10:00）。 */
const AT_18 = new Date("2026-10-13T10:00:00.000Z");
/** 固定时钟：北京时间 2026-10-13 09:00（UTC 01:00）。 */
const AT_09 = new Date("2026-10-13T01:00:00.000Z");

/** 断言解析结果等于北京时间的某天某时某分。 */
function assertLocalIso(actual: Date | null, iso: string, label: string): void {
  assert.ok(actual, `${label}: 应解析出时间`);
  assert.equal(actual!.toISOString(), iso, label);
}

test("裸 7点半 在 18:00 解析为当天 19:30（就近未来，不再跳到次日）", () => {
  assertLocalIso(
    parseScheduleTimeFromPrompt("设置7点半提醒我取快递", "Asia/Shanghai", AT_18),
    "2026-10-13T11:30:00.000Z",
    "18:00 说 7点半 → 当天 19:30",
  );
});

test("裸 7点半 在 09:00 解析为当天 19:30（已过时刻的就近未来解释）", () => {
  assertLocalIso(
    parseScheduleTimeFromPrompt("7点半提醒我取快递", "Asia/Shanghai", AT_09),
    "2026-10-13T11:30:00.000Z",
    "09:00 说 7点半 → 当天 19:30",
  );
});

test("数字形态「晚上7点半」按时段词映射为 19:30", () => {
  assertLocalIso(
    parseScheduleTimeFromPrompt("晚上7点半提醒我取快递", "Asia/Shanghai", AT_09),
    "2026-10-13T11:30:00.000Z",
    "晚上7点半（数字）→ 19:30",
  );
});

test("数字形态「下午3点」按时段词映射为 15:00", () => {
  assertLocalIso(
    parseScheduleTimeFromPrompt("下午3点提醒我开会", "Asia/Shanghai", AT_09),
    "2026-10-13T07:00:00.000Z",
    "下午3点（数字）→ 15:00",
  );
});

test("显式「早上7点半」在 18:00 保持字面语义 → 次日 07:30", () => {
  assertLocalIso(
    parseScheduleTimeFromPrompt("早上7点半提醒我晨跑", "Asia/Shanghai", AT_18),
    "2026-10-13T23:30:00.000Z",
    "18:00 说 早上7点半 → 次日 07:30",
  );
});

test("「明天7点半」在 18:00 保持次日 07:30（日期偏移优先）", () => {
  assertLocalIso(
    parseScheduleTimeFromPrompt("明天7点半提醒我交报告", "Asia/Shanghai", AT_18),
    "2026-10-13T23:30:00.000Z",
    "明天7点半 → 次日 07:30",
  );
});

test("「晚上7点半」在 20:00 已过 → 次日 19:30", () => {
  const at20 = new Date("2026-10-13T12:00:00.000Z");
  assertLocalIso(
    parseScheduleTimeFromPrompt("晚上7点半提醒我取快递", "Asia/Shanghai", at20),
    "2026-10-14T11:30:00.000Z",
    "20:00 说 晚上7点半 → 次日 19:30",
  );
});

test("「今晚7点半」在 09:00 解析为当天 19:30（今晚按晚上算）", () => {
  assertLocalIso(
    parseScheduleTimeFromPrompt("今晚7点半提醒我取快递", "Asia/Shanghai", AT_09),
    "2026-10-13T11:30:00.000Z",
    "今晚7点半 → 当天 19:30",
  );
});

test("「明晚7点半」在 18:00 解析为次日 19:30", () => {
  assertLocalIso(
    parseScheduleTimeFromPrompt("明晚7点半提醒我取快递", "Asia/Shanghai", AT_18),
    "2026-10-14T11:30:00.000Z",
    "明晚7点半 → 次日 19:30",
  );
});

test("相对时间不受就近未来回退影响", () => {
  assertLocalIso(
    parseScheduleTimeFromPrompt("30分钟后提醒我喝水", "Asia/Shanghai", AT_18),
    "2026-10-13T10:30:00.000Z",
    "30分钟后 → 18:30",
  );
});

test("高置信一次性事项（取快递）直接创建，不再卡重复确认", async () => {
  const service = new ScheduleIntentService(null);
  const parsed = await service.parseForCreate(
    "test-session",
    "设置7点半提醒我取快递",
    { userTimezone: "Asia/Shanghai", now: AT_18 },
  );
  assert.equal(parsed.matched, true, "快递属高置信一次性 → matched=true 直接创建");
  if (parsed.matched) {
    assert.equal(parsed.draft.recurrence, "none");
    assert.equal(parsed.draft.runAt, "2026-10-13T11:30:00.000Z");
  }
});

test("日常习惯类（吃药）仍走重复确认，不擅自定终身", async () => {
  const service = new ScheduleIntentService(null);
  const parsed = await service.parseForCreate(
    "test-session",
    "设置8点提醒我吃药",
    { userTimezone: "Asia/Shanghai", now: AT_18 },
  );
  assert.equal(parsed.matched, false);
  if (!parsed.matched && "needsRecurrenceConfirm" in parsed) {
    assert.equal(parsed.needsRecurrenceConfirm, true);
  }
});
