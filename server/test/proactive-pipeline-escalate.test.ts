// ProactivePipeline critical 升级链钩子单测：
// critical 直投成功 → escalate(p, deliveryId) 恰好一次；非 critical / 投递失败不触发。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ProactiveDeliveryService } from "../src/proactivity/delivery-service.js";
import { FrequencyGovernor } from "../src/proactivity/frequency-governor.js";
import type { ProactiveProposal } from "../src/proactivity/pipeline-types.js";
import { ProactivePipeline } from "../src/proactivity/proactive-pipeline.js";
import { OutcomeStore } from "../src/proactivity/outcome-store.js";
import { PresenceService } from "../src/proactivity/presence-service.js";
import { WsConnectionRegistry } from "../src/services/ws-connection-registry.js";

const NOON = new Date(2026, 8, 5, 12, 0, 0).getTime();

function proposal(overrides: Partial<ProactiveProposal> = {}): ProactiveProposal {
  return {
    proposalId: "p_test",
    actorId: "user-a",
    kind: "schedule_reminder",
    tier: "must",
    importance: "high",
    dedupKey: "k1",
    title: "评审",
    summary: "马上评审",
    evidence: ["evidence-1"],
    directText: "15分钟后评审",
    createdAt: NOON,
    source: "test",
    ...overrides,
  };
}

function makeHarness() {
  const dir = mkdtempSync(join(tmpdir(), "pipeline-escalate-"));
  const registry = new WsConnectionRegistry();
  const presence = new PresenceService();
  const escalations: Array<{ proposal: ProactiveProposal; deliveryId: string }> = [];
  const delivered: string[] = [];
  const governor = new FrequencyGovernor({ ignoreEnv: true, });
  const pipeline = new ProactivePipeline({
    dataPath: dir,
    governor,
    suppression: { isSuppressed: () => ({ suppressed: false, reason: "" }) },
    presence,
    delivery: new ProactiveDeliveryService({
      trySend: (actorId, json) => {
        delivered.push(json);
        void actorId;
        return true;
      },
    }),
    outcomes: new OutcomeStore(join(dir, "outcomes.json")),
    nowFn: () => NOON,
    escalate: (p, deliveryId) => {
      escalations.push({ proposal: p, deliveryId });
    },
  });
  void registry;
  return { pipeline, presence, escalations, delivered, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("escalate: critical 直投成功 → 升级钩子触发一次（带 deliveryId）", () => {
  const h = makeHarness();
  try {
    h.presence.markConnected("user-a", NOON - 5 * 60_000);
    const d = h.pipeline.submitProposal(proposal({ importance: "critical", dedupKey: "k-critical" }));
    assert.equal(d.verdict, "delivered");
    assert.equal(h.delivered.length, 1);
    assert.equal(h.escalations.length, 1);
    assert.equal(h.escalations[0].proposal.kind, "schedule_reminder");
    assert.ok(h.escalations[0].deliveryId.startsWith("d_"), "应携带投递层生成的 deliveryId");
  } finally {
    h.cleanup();
  }
});

test("escalate: 非 critical 提案不触发升级链", () => {
  const h = makeHarness();
  try {
    h.presence.markConnected("user-a", NOON - 5 * 60_000);
    const d = h.pipeline.submitProposal(proposal({ importance: "high", dedupKey: "k-high" }));
    assert.equal(d.verdict, "delivered");
    assert.equal(h.delivered.length, 1);
    assert.equal(h.escalations.length, 0);
  } finally {
    h.cleanup();
  }
});

test("escalate: 投递失败（两端离线）不触发升级链", () => {
  const h = makeHarness();
  try {
    // 未 markConnected：两端离线 → 投递失败转挂起，不该升级（还没送达）
    const d = h.pipeline.submitProposal(proposal({ importance: "critical", dedupKey: "k-offline" }));
    assert.equal(d.verdict, "deferred");
    assert.equal(h.escalations.length, 0);
  } finally {
    h.cleanup();
  }
});
