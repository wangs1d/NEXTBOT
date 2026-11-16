import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ReminderRedeliveryService,
  reminderDedupKey,
} from "../src/services/reminder-redelivery-service.js";

const RUN_AT = "2026-11-12T12:45:00.000Z";

function makeService(overrides: Partial<ConstructorParameters<typeof ReminderRedeliveryService>[0]> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "redelivery-"));
  const sent: Array<{ actorId: string; payload: Record<string, unknown> }> = [];
  const pushes: Array<{ actorId: string; body: string }> = [];
  let mobileOnline = false;
  const svc = new ReminderRedeliveryService({
    storePath: join(dir, "missed-reminders.json"),
    isMobileOnline: () => mobileOnline,
    trySendToDeviceClasses: (actorId, json, classes) => {
      if (classes[0] !== "mobile" || !mobileOnline) return false;
      sent.push({ actorId, payload: JSON.parse(json) });
      return true;
    },
    ...overrides,
  });
  return {
    svc,
    dir,
    sent,
    pushes,
    setMobileOnline: (v: boolean) => {
      mobileOnline = v;
    },
  };
}

test("手机离线时入队，重连后立即直投且带 firedAt 原定时刻", async () => {
  const t = makeService();
  t.setMobileOnline(false);
  const r1 = await t.svc.enqueue({ actorId: "a@x.com", taskId: "t1", runAt: RUN_AT, title: "该睡觉啦", message: "该睡觉啦", preReminder: false });
  assert.equal(r1, "enqueued");

  // 手机仍未上线：flush 不投
  assert.equal(t.svc.flushForActor("a@x.com"), 0);

  // 手机重连：立即直投，事件形态与 delivery-service 一致，气泡按原时间落屏
  t.setMobileOnline(true);
  const n = t.svc.flushForActor("a@x.com");
  assert.equal(n, 1);
  assert.equal(t.sent.length, 1);
  const payload = t.sent[0]!.payload.payload as Record<string, unknown>;
  assert.equal(t.sent[0]!.payload.type, "agent.proactive_message");
  assert.equal(payload.kind, "schedule_reminder");
  assert.equal(payload.firedAt, Date.parse(RUN_AT));
  assert.equal(payload.text, "该睡觉啦");
  assert.equal(payload.display, "popup");
  // 投递成功即出队
  assert.equal(t.svc.stats().total, 0);
});

test("幂等：同 taskId+runAt 重复提交合并为一笔", async () => {
  const t = makeService();
  await t.svc.enqueue({ actorId: "a@x.com", taskId: "t1", runAt: RUN_AT, title: "", message: "m", preReminder: false });
  const r2 = await t.svc.enqueue({ actorId: "a@x.com", taskId: "t1", runAt: RUN_AT, title: "", message: "m", preReminder: false });
  assert.equal(r2, "duplicate");
  assert.equal(t.svc.stats().total, 1);
  // 预告段（:pre）与到点触发是两笔
  const r3 = await t.svc.enqueue({ actorId: "a@x.com", taskId: "t1", runAt: RUN_AT, title: "", message: "m", preReminder: true });
  assert.equal(r3, "enqueued");
  assert.equal(t.svc.stats().total, 2);
});

test("系统推送通道可用时直接升级推送，不入队", async () => {
  const pushes: Array<{ actorId: string; body: string }> = [];
  const t = makeService({
    mobilePush: {
      hasChannel: () => true,
      push: async (input) => {
        pushes.push({ actorId: input.actorId, body: input.body });
        return { ok: true, provider: "huawei" };
      },
    },
  });
  const r = await t.svc.enqueue({ actorId: "a@x.com", taskId: "t1", runAt: RUN_AT, title: "该睡觉啦", message: "该睡觉啦", preReminder: false });
  assert.equal(r, "pushed");
  assert.equal(pushes.length, 1);
  assert.equal(t.svc.stats().total, 0);
});

test("推送失败回落入队等重连", async () => {
  const t = makeService({
    mobilePush: {
      hasChannel: () => true,
      push: async () => ({ ok: false, provider: "huawei", reason: "token_expired" }),
    },
  });
  const r = await t.svc.enqueue({ actorId: "a@x.com", taskId: "t1", runAt: RUN_AT, title: "", message: "m", preReminder: false });
  assert.equal(r, "enqueued");
  assert.equal(t.svc.stats().total, 1);
});

test("持久化：重启后从磁盘恢复待补投队列", async () => {
  const t = makeService();
  await t.svc.enqueue({ actorId: "a@x.com", taskId: "t1", runAt: RUN_AT, title: "", message: "m1", preReminder: false });
  t.svc.flush();
  assert.ok(existsSync(join(t.dir, "missed-reminders.json")));

  // 新实例（模拟重启）从同一 storePath 恢复
  const svc2 = new ReminderRedeliveryService({
    storePath: join(t.dir, "missed-reminders.json"),
    isMobileOnline: () => true,
    trySendToDeviceClasses: (actorId, json, classes) => {
      if (classes[0] !== "mobile") return false;
      t.sent.push({ actorId, payload: JSON.parse(json) });
      return true;
    },
  });
  assert.equal(svc2.stats().total, 1);
  assert.equal(svc2.flushForActor("a@x.com"), 1);
  assert.equal(svc2.stats().total, 0);
});

test("队列封顶：每 actor 超限丢最旧的触发时刻", async () => {
  const t = makeService({ maxPerActor: 3 });
  const base = Date.parse(RUN_AT);
  for (let i = 0; i < 5; i++) {
    await t.svc.enqueue({
      actorId: "a@x.com",
      taskId: `t${i}`,
      runAt: new Date(base + i * 60_000).toISOString(),
      title: "",
      message: `m${i}`,
      preReminder: false,
    });
  }
  assert.equal(t.svc.stats().total, 3);
  // 最旧的两笔（t0/t1）被丢，剩 t2/t3/t4
  const remaining = t.svc.listForActor("a@x.com").map((e) => e.taskId).sort();
  assert.deepEqual(remaining, ["t2", "t3", "t4"]);
});

test("dedupKey：预告段与到点触发互不吞并", () => {
  assert.notEqual(reminderDedupKey("t", RUN_AT, false), reminderDedupKey("t", RUN_AT, true));
});
