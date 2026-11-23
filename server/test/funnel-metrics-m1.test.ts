// 主动触达漏斗聚合（需求 §12.2）单测：五级口径、掉队原因、窗口与 actor 过滤。
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildFunnel, dayKey } from "../src/proactivity/funnel-metrics.js";
import type { ArbitrationDecision, ProactiveProposal } from "../src/proactivity/pipeline-types.js";
import type { OutcomeRecord } from "../src/proactivity/outcome-store.js";
import type { SilenceLogEntry } from "../src/proactivity/silence-log.js";

const NOW = new Date(2026, 10, 23, 12, 0, 0).getTime();
const DAY = 24 * 60 * 60_000;

function decision(
  overrides: Partial<ProactiveProposal>,
  verdict: ArbitrationDecision["verdict"],
  reasonChain: string[] = [],
): ArbitrationDecision {
  return {
    proposal: {
      proposalId: `p_${Math.random().toString(36).slice(2, 7)}`,
      actorId: "user-a",
      kind: "schedule_upcoming",
      tier: "must",
      importance: "high",
      dedupKey: "k",
      title: "评审",
      summary: "马上评审",
      evidence: [],
      createdAt: NOW,
      source: "test",
      ...overrides,
    } as ProactiveProposal,
    verdict,
    reasonChain,
  };
}

function outcome(overrides: Partial<OutcomeRecord> = {}): OutcomeRecord {
  return {
    deliveryId: `d_${Math.random().toString(36).slice(2, 7)}`,
    actorId: "user-a",
    kind: "schedule_upcoming",
    channel: "in_app",
    outcome: "delivered",
    at: NOW,
    createdAt: NOW,
    ...overrides,
  };
}

function silence(overrides: Partial<SilenceLogEntry> = {}): SilenceLogEntry {
  return {
    at: NOW,
    actorId: "user-a",
    kind: "greeting",
    title: "打个招呼",
    scope: "action",
    netUtility: -0.2,
    riskScore: 0,
    valueScore: 0.1,
    reason: "net_utility_negative(U=-0.20)",
    ...overrides,
  };
}

test("漏斗: 候选→入slot→送达→接触→动作逐级收敛，掉队有原因", () => {
  const view = buildFunnel({
    decisions: [
      decision({}, "delivered"),
      decision({ kind: "weather" }, "deferred"),
      decision({ kind: "greeting" }, "silenced", ["utility_evaluated", "net_utility_negative(U=-0.4)"]),
      decision({ kind: "greeting" }, "throttled", ["daily_budget_exhausted(7/7)"]),
    ],
    outcomes: [
      outcome({ outcome: "accepted", createdAt: NOW }),
      outcome({ outcome: "delivered", channel: "mobile_push", createdAt: NOW - 2 * DAY }),
    ],
    now: NOW,
    days: 7,
  });
  assert.deepEqual(
    {
      candidate: view.total.candidate,
      slotted: view.total.slotted,
      delivered: view.total.delivered,
      opened: view.total.opened,
      acted: view.total.acted,
    },
    { candidate: 4, slotted: 2, delivered: 2, opened: 1, acted: 1 },
  );
  assert.equal(view.total.dropReasons["silenced(net_utility_negative)"], 1);
  assert.equal(view.total.dropReasons["throttled(daily_budget_exhausted)"], 1);
  // 送达后没动静的记成 no_contact（mobile_push 那条只有 delivered 态）
  assert.equal(view.total.dropReasons["no_contact"], 1);
  assert.equal(view.northStar.effective, 1);
  assert.equal(view.northStar.actors, 1);
  assert.equal(view.northStar.perActor, 1);
});

test("漏斗: 触点维度只在送达之后成立,按 channel 分桶", () => {
  const view = buildFunnel({
    decisions: [],
    outcomes: [
      outcome({ channel: "in_app", outcome: "viewed" }),
      outcome({ channel: "in_app", outcome: "replied" }),
      outcome({ channel: "mobile_push", outcome: "dismissed" }),
    ],
    now: NOW,
  });
  const bySlot = Object.fromEntries(view.bySlot.map((s) => [s.key, s]));
  assert.equal(bySlot["in_app"].delivered, 2);
  assert.equal(bySlot["in_app"].opened, 2);
  assert.equal(bySlot["in_app"].acted, 1);
  assert.equal(bySlot["mobile_push"].acted, 0);
  assert.equal(bySlot["mobile_push"].opened, 1, "dismissed 也算有过接触");
});

test("漏斗: 窗口外的记录不进视图,actor 过滤生效", () => {
  const view = buildFunnel({
    decisions: [decision({ createdAt: NOW - 30 * DAY }, "delivered")],
    outcomes: [
      outcome({ createdAt: NOW - 30 * DAY }),
      outcome({ actorId: "user-b", outcome: "accepted" }),
    ],
    actorId: "user-a",
    now: NOW,
    days: 7,
  });
  assert.equal(view.total.candidate, 0);
  assert.equal(view.total.delivered, 0);
  assert.deepEqual(view.byDay, []);
});

test("漏斗: 按天分桶用送达日,不是最后表态日", () => {
  // 昨天 16:00 送达、今天 12:00 回复——这条属于昨天那一天，今天的桶里不该出现
  const sentAt = NOW - 20 * 60 * 60_000;
  const view = buildFunnel({
    decisions: [],
    outcomes: [outcome({ createdAt: sentAt, at: NOW, outcome: "accepted" })],
    now: NOW,
    days: 7,
  });
  const rows = Object.fromEntries(view.byDay.map((d) => [d.key, d]));
  assert.equal(rows[dayKey(sentAt)]?.acted, 1);
  assert.equal(rows[dayKey(NOW)], undefined);
});

test("漏斗: hub 行动级沉默只补原因,不重复计候选", () => {
  const view = buildFunnel({
    decisions: [decision({}, "delivered")],
    outcomes: [],
    silences: [silence(), silence({ scope: "proposal" }), silence({ at: NOW - 30 * DAY })],
    now: NOW,
    days: 7,
  });
  assert.equal(view.total.candidate, 1);
  assert.equal(view.total.dropReasons["action(net_utility_negative)"], 1);
  assert.equal(view.total.dropReasons["proposal(net_utility_negative)"], undefined);
  assert.equal(Object.keys(view.total.dropReasons).length, 1);
});
