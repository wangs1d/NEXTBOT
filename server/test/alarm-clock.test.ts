// 闹钟调度服务单测 —— RRULE 展开 / 贪睡顺延 / 触发回执幂等 / 智能路由
// （离线兜底推送已删除，2026-11-25）
// 运行：npx tsx --test test/alarm-clock.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import test from "node:test";
import assert from "node:assert/strict";

import { nextRruleOccurrenceMs } from "../src/services/alarm-clock/alarm-rrule.js";
import { AlarmClockService } from "../src/services/alarm-clock/alarm-clock-service.js";
import type { WsLike } from "../src/services/ws-connection-registry.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "alarm-clock-test-"));

test("RRULE：FREQ=DAILY 逐日推进", () => {
  const anchor = new Date(2026, 9, 8, 7, 30, 0).getTime(); // 2026-10-08 07:30
  const after = new Date(2026, 9, 8, 8, 0, 0).getTime();
  const next = nextRruleOccurrenceMs({ rule: "RRULE:FREQ=DAILY", until: null, count: null }, anchor, after);
  assert.equal(new Date(next!).getDate(), 9);
  assert.equal(new Date(next!).getHours(), 7);
  assert.equal(new Date(next!).getMinutes(), 30);
});

test("RRULE：WEEKLY BYDAY=MO,WE,FR 只落命中日", () => {
  // 2026-10-08 是周四 → 下一跳应为周五 10-09
  const anchor = new Date(2026, 9, 8, 7, 30, 0).getTime();
  const after = new Date(2026, 9, 8, 8, 0, 0).getTime();
  const next = nextRruleOccurrenceMs(
    { rule: "RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR", until: null, count: null },
    anchor,
    after,
  );
  assert.equal(new Date(next!).getDay(), 5); // Friday
  assert.equal(new Date(next!).getDate(), 9);
});

test("RRULE：COUNT 耗尽后返回 null", () => {
  const anchor = new Date(2026, 9, 8, 7, 30, 0).getTime();
  const after = new Date(2026, 9, 12, 8, 0, 0).getTime(); // 已发生 4 次（8/9/10/11... 锚点+3）
  const next = nextRruleOccurrenceMs(
    { rule: "RRULE:FREQ=DAILY;COUNT=3", until: null, count: null },
    anchor,
    after,
  );
  assert.equal(next, null);
});

test("RRULE：UNTIL 截断", () => {
  const anchor = new Date(2026, 9, 8, 7, 30, 0).getTime();
  const after = new Date(2026, 9, 20, 8, 0, 0).getTime();
  const next = nextRruleOccurrenceMs(
    { rule: "RRULE:FREQ=DAILY;UNTIL=20261015T073000", until: null, count: null },
    anchor,
    after,
  );
  assert.equal(next, null);
});

test("服务端调度：到点触发 → advanceAfterFire 推进下一跳 → 回执幂等", async () => {
  const sockets: Array<{ sent: string[] }> = [];
  const wsRegistry = {
    trySend(actorId: string, data: string) {
      sockets.push({ sent: [actorId, data] });
      return true;
    },
    trySendToDeviceClasses() {
      return false;
    },
    trySendToActiveDevice() {
      return false;
    },
    trySendToDeviceClassOrder(_a: string, data: string) {
      // mobile/desktop 路由桩：真实语义 = 单端独占送达，此处透传给 trySend 记账
      return this.trySend(_a, data);
    },
  } as unknown as import("../src/services/ws-connection-registry.js").WsConnectionRegistry;

  const service = new AlarmClockService({
    wsRegistry,
    dataDir: tmpDir,
    env: process.env,
  });

  const fireAt = new Date(Date.now() - 60_000).toISOString(); // 1 分钟前 → 立即可触发
  const { alarm, duplicate } = service.createAlarm({
    actorId: "actor_test",
    label: "起床",
    kind: "alarm",
    fireAt,
    repeatRule: "RRULE:FREQ=DAILY",
    source: "user",
  });
  assert.equal(duplicate, false);

  // 语义去重：同 label 同 fireAt ±60s → duplicate
  const again = service.createAlarm({
    actorId: "actor_test",
    label: "起床",
    kind: "alarm",
    fireAt,
    source: "agent",
  });
  assert.equal(again.duplicate, true);
  assert.equal(again.alarm.id, alarm.id);

  await service["tick"](); // 触发
  const triggerMsgs = sockets.filter((s) => s.sent[1].includes("alarm.trigger"));
  assert.equal(triggerMsgs.length, 1, "到点应下发一条 alarm.trigger");

  const fresh = service.getAlarm(alarm.id)!;
  assert.equal(fresh.status, "active", "重复闹钟触发后推进到下一跳");
  assert.ok(new Date(fresh.nextFireAt!).getTime() > Date.now());

  // 回执幂等：ringing 是首次接受；acked 是合法的进展更新（不判重）；再次 acked 才是重复
  const firedAtMs = new Date(fresh.lastFiredAt!).getTime();
  const r1 = service.reportTriggerCallback(alarm.id, { firedAtMs, via: "local", outcome: "ringing" });
  const r2 = service.reportTriggerCallback(alarm.id, { firedAtMs, via: "local", outcome: "acked" });
  const r3 = service.reportTriggerCallback(alarm.id, { firedAtMs, via: "local", outcome: "acked" });
  assert.equal(r1.accepted, true);
  assert.equal(r2.accepted, true, "ringing→acked 是进展更新，应接受");
  assert.equal(r3.duplicate, true, "同一跳重复 acked 应判重");

  // 贪睡：顺延 10 分钟 → nextFireAt 后移、snoozeCount+1
  const snoozed = service.snoozeAlarm(alarm.id, 10)!;
  assert.equal(snoozed.snoozeCount, 1);
  assert.ok(new Date(snoozed.nextFireAt!).getTime() >= Date.now() + 9 * 60_000);

  // 取消 → canceled 且同步 delete
  sockets.length = 0;
  const canceled = service.cancelAlarm(alarm.id)!;
  assert.equal(canceled.status, "canceled");
  assert.ok(sockets.some((s) => s.sent[1].includes('"op":"delete"')));

  service.stop();
});

// 兜底推送测试已删除（2026-11-25 用户定调：移除「手机端未响应」系统级兜底推送，
// fireFallbackPush / scheduleFallback / mobilePush 通道随之下线）。

test("智能路由：提醒只发最近活跃端 / 位置未知才 fan-out / 闹钟 mobile 优先", async () => {
  const calls: Array<{ fn: string; arg?: string }> = [];
  const wsRegistry = {
    trySend(_a: string, data: string) {
      calls.push({ fn: "trySend", arg: data.slice(0, 24) });
      return true;
    },
    trySendToDeviceClasses() {
      return false;
    },
    trySendToActiveDevice(_a: string, data: string, withinMs: number) {
      calls.push({ fn: "trySendToActiveDevice", arg: `${data.slice(0, 20)}|w=${withinMs}` });
      return withinMs > 0; // 模拟窗口内有活跃端
    },
    trySendToDeviceClassOrder(_a: string, data: string, order: string[]) {
      calls.push({ fn: "trySendToDeviceClassOrder", arg: order.join(">") });
      return order.length > 0;
    },
  } as unknown as import("../src/services/ws-connection-registry.js").WsConnectionRegistry;

  const service = new AlarmClockService({
    wsRegistry,
    dataDir: tmpDir,
    env: process.env,
  });

  // 1) 提醒：有活跃端 → 只发活跃端，不 fan-out（createAlarm 的 alarm.sync 本就是 fan-out，
  //    不属于触发投递断言范围，故先建再清）
  service.createAlarm({
    actorId: "actor_route",
    label: "喝水",
    kind: "reminder",
    fireAt: new Date(Date.now() + 60_000).toISOString(),
    source: "user",
  });
  service.updateAlarm(service.listAlarms("actor_route")[0].id, {
    fireAt: new Date(Date.now() - 60_000).toISOString(),
  });
  calls.length = 0;
  await service["tick"]();
  assert.ok(calls.some((c) => c.fn === "trySendToActiveDevice"), "提醒应先尝试活跃端路由");
  assert.ok(!calls.some((c) => c.fn === "trySend"), "活跃端命中时不应 fan-out 两端");

  // 2) 闹钟：mobile 优先独占（同理：建/改时的 sync 消息先排除）
  service.createAlarm({
    actorId: "actor_route",
    label: "起床",
    kind: "alarm",
    fireAt: new Date(Date.now() + 60_000).toISOString(),
    source: "user",
  });
  service.updateAlarm(service.listAlarms("actor_route", "active").at(-1)!.id, {
    fireAt: new Date(Date.now() - 60_000).toISOString(),
  });
  calls.length = 0;
  await service["tick"]();
  const order = calls.find((c) => c.fn === "trySendToDeviceClassOrder")?.arg ?? "";
  assert.equal(order.includes("mobile"), true, "闹钟应走 mobile 优先路由");
  assert.ok(!calls.some((c) => c.fn === "trySend"), "闹钟路由成功时不应 fan-out");

  service.stop();
});
