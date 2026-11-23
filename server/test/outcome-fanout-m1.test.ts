// 主动触达结果统一回灌（2026-11-23 M1，需求 §4.6）：
// 一次 recordOutcome → 一条 proactive.outcome hook → 三个学习器各拿各的，
// 且只认用户真表过态的 outcome。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { FrequencyGovernor } from "../src/proactivity/frequency-governor.js";
import { OutcomeStore } from "../src/proactivity/outcome-store.js";
import { ProactiveDeliveryService } from "../src/proactivity/delivery-service.js";
import { PresenceService } from "../src/proactivity/presence-service.js";
import { ProactivePipeline } from "../src/proactivity/proactive-pipeline.js";
import type { ProactiveProposal } from "../src/proactivity/pipeline-types.js";
import { subscribeProactiveOutcomeFanout } from "../src/proactivity/outcome-fanout.js";
import { HookBus, emitHook, setHookBus } from "../src/services/hooks/index.js";
import type { ReminderFeedbackOutcome } from "../src/rhythm/types.js";

type Seen = {
  calibrated: string[];
  contacts: Array<{ actorId: string; outcome: string; atMs: number }>;
  slots: Array<{ actorId: string; taskId: string; outcome: string; atMs: number }>;
};

function freshSeen(): Seen {
  return { calibrated: [], contacts: [], slots: [] };
}

/** 订阅到一次性总线上，返回退订函数 */
function attach(seen: Seen, opts: { throwOnCalibrate?: boolean } = {}): () => void {
  const bus = new HookBus();
  setHookBus(bus);
  return subscribeProactiveOutcomeFanout(bus, {
    calibrate: (outcome) => {
      if (opts.throwOnCalibrate) throw new Error("calibrator 挂了");
      seen.calibrated.push(outcome);
    },
    contactOutcome: (actorId, outcome, at) =>
      seen.contacts.push({ actorId, outcome, atMs: at.getTime() }),
    reminderSlot: (actorId, taskId, outcome, at) =>
      seen.slots.push({ actorId, taskId, outcome, atMs: at.getTime() }),
  });
}

function emit(outcome: string, extra: Record<string, unknown> = {}): void {
  emitHook("proactive.outcome", { deliveryId: "d1", kind: "schedule_upcoming", outcome, at: Date.now(), ...extra }, { actorId: "user-a" });
}

test("fanout: 用户真表过态的 outcome 三路透达，带 ref 才落到提醒槽位", () => {
  const seen = freshSeen();
  const off = attach(seen);
  try {
    emit("accepted");
    assert.deepEqual(seen.calibrated, ["accepted"]);
    assert.equal(seen.contacts.length, 1);
    assert.equal(seen.contacts[0].actorId, "user-a");
    assert.equal(seen.slots.length, 0, "没有业务实体 ref，不该归到任何提醒槽位");

    emit("snoozed", { ref: "task-9" });
    assert.deepEqual(seen.calibrated, ["accepted", "snoozed"]);
    assert.equal(seen.slots.length, 1);
    assert.deepEqual(seen.slots[0], {
      actorId: "user-a",
      taskId: "task-9",
      outcome: "snoozed",
      atMs: seen.contacts[1].atMs,
    });
  } finally {
    off();
  }
});

test("fanout: delivered/viewed 是展示事实，不进任何学习器", () => {
  const seen = freshSeen();
  const off = attach(seen);
  try {
    emit("delivered", { ref: "task-9" });
    emit("viewed");
    emit("opened");
    assert.deepEqual(seen.calibrated, []);
    assert.deepEqual(seen.contacts, []);
    assert.deepEqual(seen.slots, []);
  } finally {
    off();
  }
});

test("fanout: 一个学习器抛错不连坐其余两路", () => {
  const seen = freshSeen();
  const off = attach(seen, { throwOnCalibrate: true });
  try {
    emit("dismissed", { ref: "task-1" });
    assert.equal(seen.contacts.length, 1);
    assert.equal(seen.slots.length, 1);
  } finally {
    off();
  }
});

test("fanout: 退订后不再回灌", () => {
  const seen = freshSeen();
  const off = attach(seen);
  off();
  emit("accepted");
  assert.deepEqual(seen.calibrated, []);
});

// ─── 真管道出口：recordOutcome 是唯一写入口，ref 随事件带出 ───

const NOON = new Date(2026, 7, 30, 12, 0, 0).getTime();

function pipelineHarness(): {
  pipeline: ProactivePipeline;
  delivered: Array<{ actorId: string; json: string }>;
  dir: string;
  presence: PresenceService;
} {
  const dir = mkdtempSync(join(tmpdir(), "outcome-fanout-"));
  const presence = new PresenceService();
  const delivered: Array<{ actorId: string; json: string }> = [];
  const pipeline = new ProactivePipeline({
    dataPath: dir,
    governor: new FrequencyGovernor({ ignoreEnv: true, dailyBudget: 6 }),
    suppression: { isSuppressed: () => ({ suppressed: false, reason: "" }) },
    presence,
    delivery: new ProactiveDeliveryService({
      trySend: (actorId, json) => {
        delivered.push({ actorId, json });
        return true;
      },
    }),
    outcomes: new OutcomeStore(join(dir, "outcomes.json")),
    speak: () => {},
    nowFn: () => NOON,
  });
  return { pipeline, delivered, dir, presence };
}

test("pipeline: recordOutcome 落库即发 hook，ref/actorId/kind 一并带出", () => {
  const seen = freshSeen();
  const off = attach(seen);
  const h = pipelineHarness();
  try {
    h.presence.markConnected("user-a", NOON - 5 * 60_000);
    const proposal: ProactiveProposal = {
      proposalId: "p_fanout",
      actorId: "user-a",
      kind: "schedule_upcoming",
      tier: "must",
      importance: "high",
      dedupKey: "k-fanout",
      title: "评审",
      summary: "马上评审",
      evidence: ["evidence-1"],
      directText: "15分钟后评审",
      createdAt: NOON,
      source: "test",
    };
    h.pipeline.submitProposal(proposal);
    const deliveryId = JSON.parse(h.delivered[0].json).payload.deliveryId as string;
    assert.ok(deliveryId);
    // 投递本身记的 delivered 不该惊动学习器
    assert.deepEqual(seen.calibrated, []);

    assert.equal(h.pipeline.recordOutcome(deliveryId, "dismissed", { ref: "task-42" }), true);
    assert.deepEqual(seen.calibrated, ["dismissed"]);
    assert.deepEqual(seen.contacts, [
      { actorId: "user-a", outcome: "dismissed", atMs: seen.contacts[0].atMs },
    ]);
    assert.equal(seen.slots[0].taskId, "task-42");
    assert.equal(seen.slots[0].outcome, "dismissed" as ReminderFeedbackOutcome);
  } finally {
    off();
    rmSync(h.dir, { recursive: true, force: true });
  }
});
