// 通知闭环 M1（2026-11-23）单测：领域动作「按下去业务状态真的变了」。
//
// 覆盖：
//   1. 台账 resolve → 待取件计数立刻减少（动态页 / 小组件 / 早安共用 summary 口径）
//   2. 领域选项映射：带 ref 才出按钮，没 ref 丢弃（不放按了没用的按钮）
//   3. 执行器：已取件 / 已处理 / 日程完成 / 日程推迟 + 归属校验
//   4. 日程服务 completeTask / snoozeTask 的状态机
//   5. 账单快递汇报自带两键（有取件码才给「已取件」）
//   6. 手机静默理由（通话中 / 勿扰 / 过期失效）
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ActionIntentService } from "../src/proactivity/action-intent-service.js";
import { ActionIntentStore } from "../src/proactivity/action-intent-store.js";
import { registerNotificationActionExecutors } from "../src/proactivity/notification-action-executors.js";
import { buildNotifyActions, NOTIFY_ACTION } from "../src/proactivity/notification-actions.js";
import type { ProactiveProposal } from "../src/proactivity/pipeline-types.js";
import { PresenceService } from "../src/proactivity/presence-service.js";
import { BillParcelLedger } from "../src/services/bill-parcel-ledger.js";
import { BillParcelReactiveReporter } from "../src/services/bill-parcel-reporter.js";

const SECRET = "test-secret-for-notification-closure-0123456789";

function tmpLedger(): { ledger: BillParcelLedger; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "nb-closure-"));
  const ledger = new BillParcelLedger({ dataPath: dir });
  return { ledger, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function addParcel(ledger: BillParcelLedger, actorId: string, pickupCode: string | null) {
  return ledger.add({
    category: "parcel",
    source: "sms",
    actorId,
    title: "菜鸟驿站到件",
    amount: null,
    billType: null,
    trackingNo: null,
    pickupCode,
    carrier: "菜鸟",
    excerpt: "【菜鸟】您的包裹已到东门驿站",
  })[0];
}

function proposal(over: Partial<ProactiveProposal> = {}): ProactiveProposal {
  return {
    proposalId: "p1",
    actorId: "user-a",
    kind: "action.bill_parcel",
    tier: "must",
    importance: "high",
    dedupKey: "k1",
    title: "收到快递通知",
    summary: "菜鸟驿站到件",
    evidence: [],
    createdAt: Date.now(),
    source: "test",
    ...over,
  };
}

function makeIntents(): ActionIntentService {
  return new ActionIntentService({ store: new ActionIntentStore(), secret: SECRET });
}

/** 登记一条带这些动作的意图，返回 actionId → token */
function issue(svc: ActionIntentService, actorId: string, p: ProactiveProposal): Map<string, string> {
  const intent = svc.register({
    actorId,
    kind: p.kind,
    title: p.title,
    body: p.summary,
    actions: buildNotifyActions(p),
    deliveryId: "d1",
  });
  return new Map(svc.renderForClient(intent).actions.map((a) => [a.actionId, a.token]));
}

test("台账 resolve 后待取件计数与最近待取件同步消失", () => {
  const { ledger, cleanup } = tmpLedger();
  try {
    const e = addParcel(ledger, "user-a", "3-2-1108");
    assert.equal(ledger.summary({ actorId: "user-a" }).parcels.awaitingPickup, 1);
    const resolved = ledger.resolve(e.id, "user-a");
    assert.ok(resolved?.resolvedAt);
    const s = ledger.summary({ actorId: "user-a" });
    assert.equal(s.parcels.awaitingPickup, 0);
    assert.equal(s.parcels.latestPickup, null);
    // 总件数不变：已取件仍是历史
    assert.equal(s.parcels.count, 1);
  } finally {
    cleanup();
  }
});

test("台账 resolve：归属不符拒绝、重复调用幂等", () => {
  const { ledger, cleanup } = tmpLedger();
  try {
    const e = addParcel(ledger, "user-a", "3-2-1108");
    assert.equal(ledger.resolve(e.id, "user-b"), null);
    const first = ledger.resolve(e.id, "user-a", 1000);
    const second = ledger.resolve(e.id, "user-a", 2000);
    assert.equal(first?.resolvedAt, 1000);
    assert.equal(second?.resolvedAt, 1000);
  } finally {
    cleanup();
  }
});

test("领域选项映射：带 ref 出按钮，缺 ref 丢弃", () => {
  const withRef = buildNotifyActions(
    proposal({
      notifyOptions: [
        { action: "parcel_picked", label: "已取件", ref: "parcel:abc" },
        { action: "snooze", label: "晚点提醒我", delayMs: 60_000 },
      ],
    }),
  );
  assert.deepEqual(
    withRef.map((a) => a.actionId),
    [NOTIFY_ACTION.parcelPicked, NOTIFY_ACTION.snooze],
  );
  assert.equal(withRef[0].payload?.ref, "parcel:abc");

  const noRef = buildNotifyActions(
    proposal({
      notifyOptions: [
        { action: "schedule_complete", label: "完成" },
        { action: "acknowledge", label: "知道了" },
      ],
    }),
  );
  assert.deepEqual(noRef.map((a) => a.actionId), [NOTIFY_ACTION.acknowledge]);
});

test("执行器：已取件真的写回台账，并记一次正反馈", async () => {
  const { ledger, cleanup } = tmpLedger();
  try {
    const e = addParcel(ledger, "user-a", "3-2-1108");
    const svc = makeIntents();
    const outcomes: Array<[string, string]> = [];
    registerNotificationActionExecutors(svc, {
      pipeline: {
        recordOutcome: (id, o) => {
          outcomes.push([id, o]);
          return true;
        },
        requeueProposal: () => true,
        resolveConfirmationByKind: () => ({ ok: true, message: "" }),
      },
      ledger,
      schedule: null,
    });
    const tokens = issue(
      svc,
      "user-a",
      proposal({ notifyOptions: [{ action: "parcel_picked", label: "已取件", ref: e.id }] }),
    );
    const res = await svc.execute(tokens.get(NOTIFY_ACTION.parcelPicked)!);
    assert.ok(res.ok);
    assert.equal(ledger.summary({ actorId: "user-a" }).parcels.awaitingPickup, 0);
    assert.deepEqual(outcomes, [["d1", "accepted"]]);
  } finally {
    cleanup();
  }
});

test("执行器：台账未装配时如实失败，不假装成功", async () => {
  const svc = makeIntents();
  registerNotificationActionExecutors(svc, { pipeline: null, ledger: null, schedule: null });
  const tokens = issue(
    svc,
    "user-a",
    proposal({ notifyOptions: [{ action: "bill_settled", label: "已处理", ref: "bill:x" }] }),
  );
  const res = await svc.execute(tokens.get(NOTIFY_ACTION.billSettled)!);
  assert.equal(res.ok, false);
});

test("执行器：日程完成 / 推迟走日程服务，且校验归属", async () => {
  const calls: string[] = [];
  const schedule = {
    getTask: (id: string) =>
      id === "t-mine"
        ? { taskId: id, sessionId: "user-a", title: "牙医" }
        : id === "t-other"
          ? { taskId: id, sessionId: "user-b", title: "别人的" }
          : undefined,
    completeTask: async (id: string) => {
      calls.push(`complete:${id}`);
      return { changed: true };
    },
    snoozeTask: async (id: string, minutes: number) => {
      calls.push(`snooze:${id}:${minutes}`);
      return { nextRunAt: new Date(2026, 10, 24, 15, 15).toISOString() };
    },
  };
  const svc = makeIntents();
  registerNotificationActionExecutors(svc, { pipeline: null, ledger: null, schedule });

  const mine = issue(
    svc,
    "user-a",
    proposal({
      kind: "schedule_reminder",
      notifyOptions: [
        { action: "schedule_complete", label: "完成", ref: "t-mine" },
        { action: "schedule_snooze", label: "15 分钟后", ref: "t-mine" },
      ],
    }),
  );
  const done = await svc.execute(mine.get(NOTIFY_ACTION.scheduleComplete)!);
  assert.ok(done.ok);

  // 同一意图的两个按钮互斥：完成后再点推迟只返回上次结果，不再执行
  const again = await svc.execute(mine.get(NOTIFY_ACTION.scheduleSnooze)!);
  assert.ok(again.ok && again.alreadyExecuted);

  const snoozeOnly = issue(
    svc,
    "user-a",
    proposal({ kind: "schedule_reminder", notifyOptions: [{ action: "schedule_snooze", label: "15 分钟后", ref: "t-mine" }] }),
  );
  const snoozed = await svc.execute(snoozeOnly.get(NOTIFY_ACTION.scheduleSnooze)!);
  assert.ok(snoozed.ok);
  if (snoozed.ok) assert.match(snoozed.result.message, /15:15/);

  const other = issue(
    svc,
    "user-a",
    proposal({ kind: "schedule_reminder", notifyOptions: [{ action: "schedule_complete", label: "完成", ref: "t-other" }] }),
  );
  const denied = await svc.execute(other.get(NOTIFY_ACTION.scheduleComplete)!);
  assert.equal(denied.ok, false);

  assert.deepEqual(calls, ["complete:t-mine", "snooze:t-mine:15"]);
});

test("账单快递汇报：有取件码给「已取件 + 晚点提醒我」，没码只给「知道了」，账单给「已处理 + 明天提醒」", () => {
  const { ledger, cleanup } = tmpLedger();
  try {
    const submitted: ProactiveProposal[] = [];
    let now = 1_000_000_000;
    const reporter = new BillParcelReactiveReporter({ now: () => now, submit: (p) => submitted.push(p) });

    const withCode = addParcel(ledger, "user-a", "3-2-1108");
    reporter.report({ actorId: "user-a", source: "sms", entries: [withCode] } as never);
    assert.deepEqual(
      submitted[0].notifyOptions?.map((o) => [o.action, o.ref ?? null]),
      [["parcel_picked", withCode.id], ["snooze", null]],
    );

    now += 60 * 60 * 1000; // 过快递冷却
    const noCode = addParcel(ledger, "user-a", null);
    reporter.report({ actorId: "user-a", source: "sms", entries: [noCode] } as never);
    assert.deepEqual(submitted[1].notifyOptions?.map((o) => o.action), ["acknowledge"]);

    const bill = ledger.add({
      category: "bill",
      source: "sms",
      actorId: "user-a",
      title: "招行信用卡还款提醒",
      amount: 1200,
      billType: "还款",
      trackingNo: null,
      pickupCode: null,
      carrier: null,
      excerpt: "本期应还 1200 元",
    })[0];
    reporter.report({ actorId: "user-a", source: "sms", entries: [bill] } as never);
    assert.deepEqual(
      submitted[2].notifyOptions?.map((o) => [o.action, o.ref ?? null]),
      [["bill_settled", bill.id], ["snooze", null]],
    );
  } finally {
    cleanup();
  }
});

test("手机静默理由：通话优先于勿扰，解锁在用刷新活动，过期即失效", () => {
  const presence = new PresenceService();
  const t0 = 10_000_000;
  presence.markConnected("user-a", t0 - 60 * 60 * 1000);
  assert.equal(presence.phoneQuietReason("user-a", t0), null);

  presence.notePhoneState(
    "user-a",
    { interactive: false, screenOn: true, inCall: true, dnd: true, charging: false },
    t0,
  );
  assert.equal(presence.phoneQuietReason("user-a", t0), "in_call");

  presence.notePhoneState(
    "user-a",
    { interactive: true, screenOn: true, inCall: false, dnd: true, charging: false },
    t0 + 1000,
  );
  assert.equal(presence.phoneQuietReason("user-a", t0 + 1000), "dnd");
  // 解锁在用 = 一次活动 → active
  assert.equal(presence.getPresence("user-a", t0 + 2000), "active");

  // 30 分钟没刷新：状态作废，不再挡消息
  assert.equal(presence.phoneQuietReason("user-a", t0 + 1000 + PresenceService.PHONE_STATE_TTL_MS + 1), null);
});

test("跨端消除回调：只在首次真执行成功时触发（幂等命中 / 执行失败都不触发）", async () => {
  const svc = makeIntents();
  const fired: string[] = [];
  svc.setOnExecuted(({ intent, actionId }) => fired.push(`${intent.intentId}:${actionId}`));
  svc.registerExecutor(NOTIFY_ACTION.acknowledge, () => ({ ok: true, message: "好" }));
  svc.registerExecutor(NOTIFY_ACTION.dismiss, () => ({ ok: false, message: "失败" }));

  const okIntent = svc.register({
    actorId: "user-a",
    kind: "t",
    title: "t",
    body: "b",
    actions: [{ actionId: NOTIFY_ACTION.acknowledge, label: "知道了", kind: "execute" }],
  });
  const okToken = svc.renderForClient(okIntent).actions[0].token;
  await svc.execute(okToken);
  await svc.execute(okToken); // 幂等命中
  assert.deepEqual(fired, [`${okIntent.intentId}:${NOTIFY_ACTION.acknowledge}`]);

  const badIntent = svc.register({
    actorId: "user-a",
    kind: "t",
    title: "t",
    body: "b",
    actions: [{ actionId: NOTIFY_ACTION.dismiss, label: "不用了", kind: "execute" }],
  });
  await svc.execute(svc.renderForClient(badIntent).actions[0].token);
  assert.equal(fired.length, 1);

  // 回调抛错不影响执行结果
  svc.setOnExecuted(() => {
    throw new Error("boom");
  });
  const third = svc.register({ actorId: "user-a", kind: "t", title: "t", body: "b", actions: [{ actionId: NOTIFY_ACTION.acknowledge, label: "知道了", kind: "execute" }] });
  const res = await svc.execute(svc.renderForClient(third).actions[0].token);
  assert.ok(res.ok);
});
