// 冷启动放行 + 语音突发熔断：用同一套期望效用算法防止语音条连发。
import assert from "node:assert/strict";
import { test } from "node:test";

import { evaluateReach } from "../src/proactivity/reach-decision.js";
import { ReachDecisionService } from "../src/proactivity/reach-decision-service.js";

const NOW = new Date(2026, 10, 19, 10, 0, 0);
const CLEAN_CTX = { contextCost: 0, quietHours: false, online: true, recentBurst: 0 };

function ask(overrides: Partial<Parameters<ReachDecisionService["decide"]>[0]> = {}) {
  return {
    actorId: "u1",
    kind: "agent_voice_message",
    importance: "medium" as const,
    requestedChannel: "voice.message" as const,
    respectRequestedChannel: true,
    ...overrides,
  };
}

test("冷启动(p=0.5)：尊重选定通道 → 语音条放行，不再误降 chat", () => {
  const d = evaluateReach({
    actorId: "u1",
    kind: "k",
    importance: "medium",
    requestedChannel: "voice.message",
    respectRequestedChannel: true,
    value: { stakes: 0.5, urgency: 0.4, beneficiary: 0.9 },
    context: CLEAN_CTX,
    acceptance: 0.5,
    now: NOW,
  });
  assert.equal(d.action, "send_now");
  assert.equal(d.channel, "voice.message");
  assert.match(d.reason, /requested_channel_positive_U/);
});

test("负反馈压低 p → U 转负 → 抑制（算法本身负责降温）", () => {
  for (const p of [0.3, 0.2]) {
    const d = evaluateReach({
      actorId: "u1",
      kind: "k",
      importance: "medium",
      requestedChannel: "voice.message",
      respectRequestedChannel: true,
      value: { stakes: 0.5, urgency: 0.4, beneficiary: 0.9 },
      context: CLEAN_CTX,
      acceptance: p,
      now: NOW,
    });
    assert.equal(d.action, "drop", `p=${p} 应抑制`);
    assert.equal(d.channel, null);
    assert.match(d.reason, /requested_channel_negative_U/);
  }
});

test("守卫仍生效：静默/高成本/离线/突发 即使 p=0.95 也拦下", () => {
  const cases = [
    [{ ...CLEAN_CTX, quietHours: true }, "quiet_hours_defer", "defer"],
    [{ ...CLEAN_CTX, contextCost: 8 }, "high_context_cost", "defer"],
    [{ ...CLEAN_CTX, online: false }, "offline_defer", "defer"],
    [{ ...CLEAN_CTX, recentBurst: 5 }, "burst_breaker", "batch"],
  ] as const;
  for (const [context, reason, action] of cases) {
    const d = evaluateReach({
      actorId: "u1",
      kind: "k",
      importance: "medium",
      requestedChannel: "voice.message",
      respectRequestedChannel: true,
      value: { stakes: 0.5, urgency: 0.4, beneficiary: 0.9 },
      context,
      acceptance: 0.95,
      now: NOW,
    });
    assert.equal(d.action, action, `reason=${reason}`);
    assert.match(d.reason, new RegExp(reason));
  }
});

test("未开启 respectRequestedChannel → 保持旧行为（冷启动降到 chat）", () => {
  const d = evaluateReach({
    actorId: "u1",
    kind: "k",
    importance: "medium",
    requestedChannel: "voice.message",
    value: { stakes: 0.5, urgency: 0.4, beneficiary: 0.9 },
    context: CLEAN_CTX,
    acceptance: 0.5,
    now: NOW,
  });
  assert.equal(d.channel, "chat");
});

test("服务层：记录语音投递 → recentBurst 上升 → 窗口内第 6 次被突发熔断拦下", () => {
  const svc = new ReachDecisionService({
    feedback: () => ({ positive: 0, negative: 0 }), // p=0.5
    contextCost: () => 0,
    nowFn: () => NOW,
  });
  for (let i = 0; i < 4; i++) {
    svc.recordVoiceDelivery("u1", NOW.getTime() - i * 60_000);
  }
  assert.equal(svc.recentVoiceSends("u1"), 4);
  // 窗口内已有 4 次：第 5 次仍在阈值内放行（recentBurst=4 < 5）
  const fifth = svc.decide(ask());
  assert.equal(fifth.action, "send_now");
  assert.equal(fifth.channel, "voice.message");
  // 第 5 次成功后再问第 6 次：recentBurst=5 → 突发熔断 batch
  svc.recordVoiceDelivery("u1");
  const sixth = svc.decide(ask());
  assert.equal(sixth.action, "batch", "5 次已发 + 本次 → 突发熔断");
  assert.equal(sixth.channel, null);
  assert.match(sixth.reason, /burst_breaker\(5\)/);
});

test("服务层：突发窗口外的旧投递不计入", () => {
  const svc = new ReachDecisionService({ nowFn: () => NOW });
  svc.recordVoiceDelivery("u1", NOW.getTime() - 31 * 60_000);
  assert.equal(svc.recentVoiceSends("u1"), 0);
  const d = svc.decide(ask());
  assert.equal(d.action, "send_now");
  assert.equal(d.channel, "voice.message");
});

test("服务层：交接 respectRequestedChannel 到引擎", () => {
  const svc = new ReachDecisionService({ nowFn: () => NOW });
  const withFlag = svc.decide(ask());
  assert.equal(withFlag.channel, "voice.message");
  const withoutFlag = svc.decide(ask({ respectRequestedChannel: undefined }));
  assert.equal(withoutFlag.channel, "chat");
});
