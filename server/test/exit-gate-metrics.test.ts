/**
 * 出口闸触发率看板单元测试：计数、分母、快照排序与落盘结构。
 */
import assert from "node:assert/strict";
import { test } from "node:test";



const { recordExitGateFire, recordTurnFinished, snapshotExitGateMetrics } = await import(
  "../src/external-model/exit-gate-metrics.js"
);

test("闸触发率看板：计数、独立会话数、触发率计算", () => {
  recordTurnFinished();
  recordTurnFinished();
  recordTurnFinished();
  recordTurnFinished();
  recordExitGateFire("queued_without_content", "s1");
  recordExitGateFire("queued_without_content", "s1");
  recordExitGateFire("queued_without_content", "s2");
  recordExitGateFire("explicit_action_no_attempt", "s3");

  const snap = snapshotExitGateMetrics();
  assert.equal(snap.turnsFinished >= 4, true, "分母应累计轮数");
  assert.equal(snap.totalFires >= 4, true, "分子应累计触发");

  const queued = snap.byReason.find((r) => r.reason === "queued_without_content");
  assert.ok(queued, "应含 queued_without_content");
  assert.ok(queued!.count >= 3, `计数应 ≥3，实际 ${queued!.count}`);
  assert.equal(queued!.sessions >= 2, true, "独立会话数应 ≥2");
  assert.ok(queued!.rateOfTurns !== "-", "有分母时应给出触发率");

  // 排序：计数多的在前
  const counts = snap.byReason.map((r) => r.count);
  for (let i = 1; i < counts.length; i++) {
    assert.ok(counts[i - 1] >= counts[i], "byReason 应按计数降序");
  }
});
