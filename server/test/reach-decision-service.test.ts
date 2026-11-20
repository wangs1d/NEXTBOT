// ReachDecisionService 单测：把反馈计数 / 上下文采样 / 静默时段接进纯决策引擎
import assert from "node:assert/strict";
import { test } from "node:test";

import { ReachDecisionService, type ReachOutcomeCounts } from "../src/proactivity/reach-decision-service.js";

const DAY = 24 * 60 * 60 * 1000;
// 静默时段默认 23-7（本地时区）；选一个明确非静默的本地小时构造时钟
function localAt(hour: number): Date {
  const d = new Date(2026, 10, 19, hour, 0, 0);
  return d;
}

function svc(overrides: ConstructorParameters<typeof ReachDecisionService>[0] = {}) {
  return new ReachDecisionService({
    nowFn: () => localAt(10),
    ...overrides,
  });
}

test("无反馈注入 → p = 0.5 均匀先验", () => {
  const s = svc();
  assert.equal(s.acceptanceOf("a", "k"), 0.5);
  const d = s.decide({ actorId: "a", kind: "k", importance: "medium" });
  assert.equal(d.p, 0.5);
});

test("反馈注入: 正反馈拉高 p，负反馈拉低 p", () => {
  const positive: ReachOutcomeCounts = { positive: 9, negative: 1 };
  const negative: ReachOutcomeCounts = { positive: 1, negative: 9 };
  const sPos = svc({ feedback: () => positive });
  const sNeg = svc({ feedback: () => negative });
  assert.ok(sPos.acceptanceOf("a", "k") > 0.8);
  assert.ok(sNeg.acceptanceOf("a", "k") < 0.2);
  assert.ok(sPos.decide({ actorId: "a", kind: "k", importance: "medium" }).utility >
    sNeg.decide({ actorId: "a", kind: "k", importance: "medium" }).utility);
});

test("contextCost 采样注入 → 高打断成本触发 defer", () => {
  const s = svc({ contextCost: () => 8 }); // arbiter 0-10 尺度
  const d = s.decide({ actorId: "a", kind: "k", importance: "medium" });
  assert.equal(d.action, "defer");
  assert.match(d.reason, /high_context_cost/);
});

test("online=false → defer", () => {
  const s = svc({ online: () => false });
  const d = s.decide({ actorId: "a", kind: "k", importance: "medium" });
  assert.equal(d.action, "defer");
  assert.match(d.reason, /offline_defer/);
});

test("recentBurst 注入 → 突发熔断 batch", () => {
  const s = svc({ recentBurst: () => 5 });
  const d = s.decide({ actorId: "a", kind: "k", importance: "medium" });
  assert.equal(d.action, "batch");
  assert.match(d.reason, /burst_breaker/);
});

test("静默时段: nowFn 落在 23 点 → defer（非必达）", () => {
  const s = svc({ nowFn: () => localAt(23) });
  const d = s.decide({ actorId: "a", kind: "k", importance: "medium" });
  assert.equal(d.action, "defer");
  assert.match(d.reason, /quiet_hours_defer/);
});

test("静默时段下 critical 仍直通（必达旁路优先于静默）", () => {
  const s = svc({ nowFn: () => localAt(23) });
  const d = s.decide({ actorId: "a", kind: "k", importance: "critical" });
  assert.equal(d.action, "send_now");
  assert.match(d.reason, /must_bypass/);
});

test("urgency / beneficiary 覆盖进入价值分", () => {
  const s = svc();
  const base = s.decide({ actorId: "a", kind: "k", importance: "high" });
  const boosted = s.decide({
    actorId: "a",
    kind: "k",
    importance: "high",
    urgency: 1,
    beneficiary: 1,
  });
  assert.ok(boosted.value >= base.value);
});

test("explicit 请求语音条直通，忽略高上下文成本", () => {
  const s = svc({ contextCost: () => 9 });
  const d = s.decide({
    actorId: "a",
    kind: "k",
    importance: "low",
    explicit: true,
    requestedChannel: "voice.message",
  });
  assert.equal(d.action, "send_now");
  assert.equal(d.channel, "voice.message");
});
