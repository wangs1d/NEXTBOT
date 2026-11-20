// phone.call_user 接入期望效用决策闸门的单测。
import assert from "node:assert/strict";
import { test } from "node:test";

import { registerAgentPhoneTools } from "../src/tools/agent-phone-tools.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";
import type { VirtualPhoneService } from "../src/services/virtual-phone-service.js";
import { ReachDecisionService } from "../src/proactivity/reach-decision-service.js";
import type { ReachDecision } from "../src/proactivity/reach-decision.js";

function fakePhone() {
  const calls: Array<{ toUserId: string; transcript: string }> = [];
  const svc = {
    getPhoneForActor: () => "v-1",
    ensureNumber: async () => "v-1",
    callUser: async (p: { toUserId: string; transcript: string }) => {
      calls.push(p);
      return { ok: true as const, callId: "c1", pushed: true, toUserId: p.toUserId, fromPhone: "v-1" };
    },
  };
  return { svc: svc as unknown as VirtualPhoneService, calls };
}

let seq = 0;
function ctx(userText = "帮我安排点事") {
  seq += 1;
  return { sessionId: `phone-s${seq}`, chatUserMessageId: `round-${seq}`, userId: "u1", userText };
}

const INPUT = { toUserId: "callee-1", spokenMessage: "该吃药了", ringStyle: "reminder" };

function registryWith(decision?: ReachDecisionService) {
  const reg = new ToolRegistry();
  const phone = fakePhone();
  registerAgentPhoneTools(reg, phone.svc, decision);
  return { reg, phone };
}

function decisionStub(d: Partial<ReachDecision>): ReachDecisionService {
  const full: ReachDecision = {
    action: "send_now", channel: "phone", utility: 0.4, p: 0.8, value: 0.7, cost: 0.1,
    reason: "stub", perChannel: [], ...d,
  };
  return { decide: () => full } as unknown as ReachDecisionService;
}

test("未注入决策服务 → 来电照常发起（向后兼容）", async () => {
  const { reg, phone } = registryWith();
  const r = await reg.execute("phone.call_user", INPUT, ctx());
  assert.equal(r.result.ok, true);
  assert.equal(phone.calls.length, 1);
});

test("决策 drop/defer → 不呼出，返回结构化抑制原因", async () => {
  for (const action of ["drop", "defer"] as const) {
    const { reg, phone } = registryWith(
      decisionStub({ action, channel: null, reason: `${action}_reason` }),
    );
    const r = await reg.execute("phone.call_user", INPUT, ctx());
    assert.equal(r.result.ok, false);
    assert.equal(r.result.suppressedByReachDecision, true);
    assert.equal(r.result.action, action);
    assert.match(String(r.result.hint), /文本或普通语音消息/);
    assert.equal(phone.calls.length, 0);
  }
});

test("决策选了更轻通道 → 不呼出（来电必须真正挣得 phone）", async () => {
  for (const channel of ["chat", "voice.message", "voice.speak"] as const) {
    const { reg, phone } = registryWith(decisionStub({ action: "send_now", channel }));
    const r = await reg.execute("phone.call_user", INPUT, ctx());
    assert.equal(r.result.ok, false, `channel=${channel} 不应呼出`);
    assert.equal(phone.calls.length, 0);
  }
});

test("决策选中 phone → 正常呼出", async () => {
  const { reg, phone } = registryWith(
    decisionStub({ action: "send_now", channel: "phone", utility: 0.5 }),
  );
  const r = await reg.execute("phone.call_user", INPUT, ctx());
  assert.equal(r.result.ok, true);
  assert.equal(phone.calls.length, 1);
  assert.equal(phone.calls[0].toUserId, "callee-1");
});

test("用户显式要求打电话 → 绕过闸门，不触发决策", async () => {
  let called = false;
  const stub = decisionStub({ action: "drop", channel: null });
  (stub as unknown as { decide: () => ReachDecision }).decide = () => {
    called = true;
    return { action: "drop", channel: null, utility: -1, p: 0, value: 0, cost: 1, reason: "x", perChannel: [] };
  };
  const { reg, phone } = registryWith(stub);
  const r = await reg.execute("phone.call_user", INPUT, ctx("给我打个电话提醒我"));
  assert.equal(r.result.ok, true);
  assert.equal(called, false);
  assert.equal(phone.calls.length, 1);
});

test("决策按被叫用户取样（真正被打断的人），非主叫 Agent", async () => {
  let askedActor = "";
  const stub = decisionStub({ action: "send_now", channel: "phone" });
  (stub as unknown as { decide: (a: { actorId: string }) => ReachDecision }).decide = (ask) => {
    askedActor = ask.actorId;
    return {
      action: "send_now", channel: "phone", utility: 0.4, p: 0.8, value: 0.7, cost: 0.1,
      reason: "stub", perChannel: [],
    };
  };
  const { reg } = registryWith(stub);
  await reg.execute("phone.call_user", INPUT, ctx());
  assert.equal(askedActor, "callee-1");
});

test("空参数 → 直接报错，不触发决策", async () => {
  let called = false;
  const stub = decisionStub({});
  (stub as unknown as { decide: () => ReachDecision }).decide = () => {
    called = true;
    return { action: "send_now", channel: "phone", utility: 0, p: 0, value: 0, cost: 0, reason: "", perChannel: [] };
  };
  const { reg } = registryWith(stub);
  const r = await reg.execute("phone.call_user", { toUserId: "", spokenMessage: "x" }, ctx());
  assert.equal(r.ok, false); // handler throw → 外层执行失败
  assert.equal(called, false);
});

test("真实决策服务: 高负反馈 → 来电被抑制", async () => {
  const service = new ReachDecisionService({
    feedback: () => ({ positive: 0, negative: 12 }),
    nowFn: () => new Date(2026, 10, 19, 10, 0, 0),
  });
  const { reg, phone } = registryWith(service);
  const r = await reg.execute("phone.call_user", INPUT, ctx());
  assert.equal(r.result.ok, false);
  assert.equal(phone.calls.length, 0);
});

test("真实决策服务: critical 事关 + 高接受率 → 真正挣得 phone 通道", async () => {
  const service = new ReachDecisionService({
    feedback: () => ({ positive: 12, negative: 0 }),
    contextCost: () => 0,
    nowFn: () => new Date(2026, 10, 19, 10, 0, 0),
  });
  const { reg, phone } = registryWith(service);
  const r = await reg.execute("phone.call_user", { ...INPUT, importance: "critical" }, ctx());
  assert.equal(r.result.ok, true);
  assert.equal(r.result.channel ?? "phone", "phone");
  assert.equal(phone.calls.length, 1);
});

test("真实决策服务: medium 事关即使高接受率也只到语音播报，不给来电", async () => {
  const service = new ReachDecisionService({
    feedback: () => ({ positive: 12, negative: 0 }),
    contextCost: () => 0,
    nowFn: () => new Date(2026, 10, 19, 10, 0, 0),
  });
  const { reg, phone } = registryWith(service);
  const r = await reg.execute("phone.call_user", { ...INPUT, importance: "medium" }, ctx());
  assert.equal(r.result.ok, false);
  assert.equal(r.result.channel, "voice.speak");
  assert.equal(phone.calls.length, 0);
});
