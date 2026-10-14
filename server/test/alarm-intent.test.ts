// 闹钟意图接线单测 —— 判定 / RRULE 映射 / 日程→真闹钟补建（P0 闭环，2026-10-13）
// 运行：npx tsx --test test/alarm-intent.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import test from "node:test";
import assert from "node:assert/strict";

import { isAlarmLikeReminderText, repeatRuleFromRecurrence } from "../src/services/alarm-clock/alarm-intent.js";
import { createLinkedAlarmIfAlarmLike } from "../src/tools/calendar-tools.js";
import { AlarmClockService } from "../src/services/alarm-clock/alarm-clock-service.js";
import type { WsConnectionRegistry } from "../src/services/ws-connection-registry.js";

function makeService(): AlarmClockService {
  const sent: string[] = [];
  const wsRegistry = {
    trySend(_actorId: string, data: string) {
      sent.push(data);
      return true;
    },
    trySendToDeviceClasses() {
      return false;
    },
    trySendToActiveDevice() {
      return false;
    },
    trySendToDeviceClassOrder(_a: string, data: string) {
      return this.trySend(_a, data);
    },
  } as unknown as WsConnectionRegistry;
  // 每个用例独立 dataDir：AlarmStore 落盘共享会跨用例命中 ±60s 语义去重
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "alarm-intent-svc-"));
  return new AlarmClockService({ wsRegistry, dataDir });
}

test("意图判定：闹钟/叫醒类命中，普通提醒与裸「叫我」不命中", () => {
  for (const t of ["明早7点叫我起床", "每天6点半闹钟", "周三早上叫醒我", "工作日定时叫我去晨跑", "明早7点起床"]) {
    assert.equal(isAlarmLikeReminderText(t), true, t);
  }
  for (const t of ["下午3点提醒我拿快递", "明天9点开会", "提醒我吃药", "下午3点叫我开会"]) {
    assert.equal(isAlarmLikeReminderText(t), false, t);
  }
});

test("重复规则映射：daily/weekly → RRULE；yearly 不支持；none → null", () => {
  assert.equal(repeatRuleFromRecurrence("daily").rule, "RRULE:FREQ=DAILY");
  assert.equal(repeatRuleFromRecurrence("daily").ok, true);
  assert.equal(repeatRuleFromRecurrence("weekly").rule, "RRULE:FREQ=WEEKLY");
  assert.equal(repeatRuleFromRecurrence("weekly").ok, true);
  assert.equal(repeatRuleFromRecurrence("none").rule, null);
  assert.equal(repeatRuleFromRecurrence("none").ok, true);
  assert.equal(repeatRuleFromRecurrence("yearly").ok, false);
});

test("接线：闹钟类提醒补建真闹钟（kind=alarm，alarm.sync 已下发）", () => {
  const service = makeService();
  const fireAt = new Date(Date.now() + 14 * 3600 * 1000).toISOString();
  const alarm = createLinkedAlarmIfAlarmLike(() => service, {
    text: "明早7点叫我起床",
    label: "起床",
    runAt: fireAt,
    recurrence: "none",
    actorId: "sess-1",
  });
  assert.ok(alarm, "应补建真闹钟");
  const stored = service.getAlarm(alarm.alarmId);
  assert.ok(stored);
  assert.equal(stored.kind, "alarm");
  assert.equal(stored.status, "active");
  assert.equal(stored.label, "起床");
  assert.equal(new Date(stored.fireAt).getTime(), new Date(fireAt).getTime());
});

test("接线：重复创建幂等（同 label 同 fireAt ±60s 只建一条）", () => {
  const service = makeService();
  const fireAt = new Date(Date.now() + 14 * 3600 * 1000).toISOString();
  const first = createLinkedAlarmIfAlarmLike(() => service, {
    text: "明早7点叫我起床",
    label: "起床",
    runAt: fireAt,
    recurrence: "daily",
    actorId: "sess-1",
  });
  const second = createLinkedAlarmIfAlarmLike(() => service, {
    text: "明早7点叫我起床",
    label: "起床",
    runAt: fireAt,
    recurrence: "daily",
    actorId: "sess-1",
  });
  assert.ok(first && second);
  assert.equal(first.alarmId, second.alarmId, "第二次应命中去重返回既有闹钟");
  const stored = service.getAlarm(first.alarmId);
  assert.equal(stored?.repeat.rule, "RRULE:FREQ=DAILY");
});

test("接线：非闹钟类/时间已过/yearly/服务缺失 → 返回 null 不建闹钟", () => {
  const service = makeService();
  const future = new Date(Date.now() + 3600 * 1000).toISOString();
  const past = new Date(Date.now() - 3600 * 1000).toISOString();
  assert.equal(
    createLinkedAlarmIfAlarmLike(() => service, {
      text: "下午3点提醒我拿快递", label: "拿快递", runAt: future, recurrence: "none", actorId: "s",
    }),
    null,
  );
  assert.equal(
    createLinkedAlarmIfAlarmLike(() => service, {
      text: "明早7点叫我起床", label: "起床", runAt: past, recurrence: "none", actorId: "s",
    }),
    null,
  );
  assert.equal(
    createLinkedAlarmIfAlarmLike(() => service, {
      text: "每年生日叫我起床", label: "起床", runAt: future, recurrence: "yearly", actorId: "s",
    }),
    null,
  );
  assert.equal(
    createLinkedAlarmIfAlarmLike(undefined, {
      text: "明早7点叫我起床", label: "起床", runAt: future, recurrence: "none", actorId: "s",
    }),
    null,
  );
});
