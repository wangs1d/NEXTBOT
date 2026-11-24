import test from "node:test";
import assert from "node:assert/strict";

import {
  pushReminderDirectly,
  reminderStableMessageId,
} from "../src/services/reminder-redelivery-service.js";

const RUN_AT = "2026-11-24T02:30:00.000Z";

function makeDeps(result: { ok: boolean; provider?: string; reason?: string }) {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    deps: {
      push: async (input: Record<string, unknown>) => {
        calls.push(input);
        return result;
      },
      now: () => Date.parse(RUN_AT),
    },
  };
}

test("到点提醒手机不在场 → 直接系统推送，一次即止", async () => {
  const t = makeDeps({ ok: true, provider: "huawei" });
  const ok = await pushReminderDirectly(t.deps, {
    actorId: "a@x.com",
    taskId: "t1",
    runAt: RUN_AT,
    title: "该睡觉啦",
    message: "该睡觉啦",
    preReminder: false,
  });
  assert.equal(ok, true);
  assert.equal(t.calls.length, 1);
  assert.equal(t.calls[0]!.body, "该睡觉啦");
  assert.equal(t.calls[0]!.importance, "high");
  assert.equal(t.calls[0]!.kind, "schedule_reminder");
});

test("推送失败即丢弃：不重试、不二次调用", async () => {
  const t = makeDeps({ ok: false, provider: "huawei", reason: "token_expired" });
  const ok = await pushReminderDirectly(t.deps, {
    actorId: "a@x.com",
    taskId: "t2",
    runAt: RUN_AT,
    title: "",
    message: "m",
    preReminder: false,
  });
  assert.equal(ok, false);
  assert.equal(t.calls.length, 1, "失败后不再投递第二次");
});

test("预告段走 medium 重要性", async () => {
  const t = makeDeps({ ok: true });
  await pushReminderDirectly(t.deps, {
    actorId: "a@x.com",
    taskId: "t3",
    runAt: RUN_AT,
    title: "出发",
    message: "该出门了",
    preReminder: true,
  });
  assert.equal(t.calls[0]!.importance, "medium");
});

test("稳定 messageId 与触发身份绑定，预告段单独一路", () => {
  assert.equal(
    reminderStableMessageId("t", RUN_AT, false),
    "reminder-t:" + RUN_AT,
  );
  assert.notEqual(
    reminderStableMessageId("t", RUN_AT, false),
    reminderStableMessageId("t", RUN_AT, true),
  );
});
