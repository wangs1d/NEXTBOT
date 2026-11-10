// 闹钟意图接线单测 —— alarmIntent 模型决策 / RRULE 映射 / 日程→真闹钟补建
// 2026-11-09 用户定调：废除正则文本匹配，是否建真闹钟唯一判定 = 模型传入的
// alarmIntent，且只覆盖「睡觉叫醒」一种情形。
// 运行：npx tsx --test test/alarm-intent.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import test from "node:test";
import assert from "node:assert/strict";

import { repeatRuleFromRecurrence } from "../src/services/alarm-clock/alarm-intent.js";
import { createLinkedAlarmIfRequested } from "../src/tools/calendar-tools.js";
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
  const service = new AlarmClockService({ wsRegistry, dataDir });
  (service as unknown as { __sent: string[] }).__sent = sent;
  return service;
}

test("重复规则映射：daily/weekly → RRULE；yearly 不支持；none → null", () => {
  assert.equal(repeatRuleFromRecurrence("daily").rule, "RRULE:FREQ=DAILY");
  assert.equal(repeatRuleFromRecurrence("daily").ok, true);
  assert.equal(repeatRuleFromRecurrence("weekly").rule, "RRULE:FREQ=WEEKLY");
  assert.equal(repeatRuleFromRecurrence("weekly").ok, true);
  assert.equal(repeatRuleFromRecurrence("none").rule, null);
  assert.equal(repeatRuleFromRecurrence("none").ok, true);
  assert.equal(repeatRuleFromRecurrence("yearly").ok, false);
});

test("接线：alarmIntent=true（睡觉叫醒）补建真闹钟（kind=alarm，alarm.sync 已下发）", () => {
  const service = makeService();
  const fireAt = new Date(Date.now() + 14 * 3600 * 1000).toISOString();
  const alarm = createLinkedAlarmIfRequested(() => service, {
    alarmIntent: true,
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
  // 2026-11-09：叫醒类闹钟必须声明语音模式，否则服务端不会生成话术 / 预合成音频
  assert.equal(stored.wakeMode?.level, "voice_talk");
});

test("接线：语音叫醒话术与音频随 alarm.sync 下发（无 TTS 时按文本兜底）", () => {
  const service = makeService();
  const sent = (service as unknown as { __sent: string[] }).__sent;
  const fireAt = new Date(Date.now() + 14 * 3600 * 1000).toISOString();
  const alarm = createLinkedAlarmIfRequested(() => service, {
    alarmIntent: true,
    label: "起床",
    runAt: fireAt,
    recurrence: "none",
    actorId: "sess-voice",
  });
  assert.ok(alarm);
  const syncs = sent
    .map((raw) => JSON.parse(raw) as { type: string; payload?: { alarm?: Record<string, unknown>; op?: string } })
    .filter((m) => m.type === "alarm.sync" && m.payload?.op === "upsert");
  assert.ok(syncs.length >= 2, "应先发一条排调度、再补发一条带语音的同步");
  const last = syncs[syncs.length - 1].payload!.alarm!;
  assert.equal(last.voiceReady, false, "测试未注入 TTS，音频为空但契约字段必须在");
  assert.ok("ttsBase64" in last, "alarm.sync 展开对象必须带 ttsBase64 键");
  assert.match(String(last.voiceText ?? ""), /该起床啦/, "LLM/合成缺失时用确定性兜底话术");
  assert.equal(service.getVoiceClip(alarm.alarmId)?.tts, null);
});

test("接线：重复创建幂等（同 label 同 fireAt ±60s 只建一条）", () => {
  const service = makeService();
  const fireAt = new Date(Date.now() + 14 * 3600 * 1000).toISOString();
  const first = createLinkedAlarmIfRequested(() => service, {
    alarmIntent: true,
    label: "起床",
    runAt: fireAt,
    recurrence: "daily",
    actorId: "sess-1",
  });
  const second = createLinkedAlarmIfRequested(() => service, {
    alarmIntent: true,
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

test("决策权在模型字段：alarmIntent 缺省/false 一律不建，文本内容不再参与判定", () => {
  const service = makeService();
  const future = new Date(Date.now() + 3600 * 1000).toISOString();
  // 即使文本满是起床/闹钟字样，模型没传 alarmIntent = 用户没要睡觉叫醒
  assert.equal(
    createLinkedAlarmIfRequested(() => service, {
      alarmIntent: false,
      label: "起床",
      runAt: future,
      recurrence: "none",
      actorId: "s",
    }),
    null,
    "alarmIntent=false 不得建闹钟",
  );
  // 反向证明判定来自模型字段而非正则：文本毫无闹钟字样也照建
  const built = createLinkedAlarmIfRequested(() => service, {
    alarmIntent: true,
    label: "起床",
    runAt: future,
    recurrence: "none",
    actorId: "s-model",
  });
  assert.ok(built, "alarmIntent=true 是唯一开关，文本内容不参与判定");
  service.stop();
});

test("接线：时间已过/yearly/服务缺失 → 返回 null 不建闹钟", () => {
  const service = makeService();
  const future = new Date(Date.now() + 3600 * 1000).toISOString();
  const past = new Date(Date.now() - 3600 * 1000).toISOString();
  assert.equal(
    createLinkedAlarmIfRequested(() => service, {
      alarmIntent: true, label: "起床", runAt: past, recurrence: "none", actorId: "s",
    }),
    null,
    "过去时刻不建",
  );
  assert.equal(
    createLinkedAlarmIfRequested(() => service, {
      alarmIntent: true, label: "起床", runAt: future, recurrence: "yearly", actorId: "s",
    }),
    null,
    "yearly 不在 RRULE 子集内",
  );
  assert.equal(
    createLinkedAlarmIfRequested(undefined, {
      alarmIntent: true, label: "起床", runAt: future, recurrence: "none", actorId: "s",
    }),
    null,
    "服务未装配",
  );
});
