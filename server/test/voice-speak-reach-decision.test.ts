// voice.speak 接入期望效用决策闸门的单测。
import assert from "node:assert/strict";
import { test } from "node:test";

import { registerAgentVoiceTools } from "../src/tools/agent-voice-tools.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";
import type { VoiceCapabilityService } from "../src/services/voice-capability-service.js";
import { ReachDecisionService } from "../src/proactivity/reach-decision-service.js";
import type { ReachDecision } from "../src/proactivity/reach-decision.js";

const CTX = { sessionId: "speak-s1", userId: "u1", userText: "帮我记个事" } as const;

function fakeVoice() {
  const spoken: Array<{ text: string; priority: string; mode: string }> = [];
  const svc = {
    speak: async (p: { text: string; priority: string; mode: string }) => {
      spoken.push({ text: p.text, priority: p.priority, mode: p.mode });
      return { ok: true as const, voiceId: "v1", pushed: true };
    },
    sendMessage: async () => ({ ok: true as const, messageId: "m1", durationMs: 1000, pushed: true }),
  };
  return { svc: svc as unknown as VoiceCapabilityService, spoken };
}

function registryWith(decision?: ReachDecisionService) {
  const reg = new ToolRegistry();
  const voice = fakeVoice();
  registerAgentVoiceTools(reg, voice.svc, decision);
  return { reg, voice };
}

function decisionStub(d: Partial<ReachDecision> & { captured?: ReachDecision[] }): ReachDecisionService {
  const full: ReachDecision = {
    action: "send_now", channel: "voice.speak", utility: 0.3, p: 0.7, value: 0.5, cost: 0.1,
    reason: "stub", perChannel: [], ...d,
  };
  return { decide: () => full } as unknown as ReachDecisionService;
}

test("未注入决策服务 → 播报照常执行（向后兼容）", async () => {
  const { reg, voice } = registryWith();
  const r = await reg.execute("voice.speak", { text: "记得喝水" }, CTX);
  assert.equal(r.result.ok, true);
  assert.equal(voice.spoken.length, 1);
});

test("决策 drop → 不播报，返回结构化抑制原因", async () => {
  const { reg, voice } = registryWith(
    decisionStub({ action: "drop", channel: null, reason: "net_utility_negative" }),
  );
  const r = await reg.execute("voice.speak", { text: "记得喝水" }, CTX);
  assert.equal(r.result.ok, false);
  assert.equal(r.result.suppressedByReachDecision, true);
  assert.equal(r.result.action, "drop");
  assert.equal(voice.spoken.length, 0);
});

test("决策选 chat/voice.message → 不播报（更轻通道就够）", async () => {
  const { reg, voice } = registryWith(
    decisionStub({ action: "send_now", channel: "voice.message", reason: "admitted(voice.message)" }),
  );
  const r = await reg.execute("voice.speak", { text: "记得喝水" }, CTX);
  assert.equal(r.result.ok, false);
  assert.equal(r.result.channel, "voice.message");
  assert.equal(voice.spoken.length, 0);
});

test("决策选中 voice.speak 或更重的 phone → 播报放行", async () => {
  for (const channel of ["voice.speak", "phone"] as const) {
    const { reg, voice } = registryWith(decisionStub({ action: "send_now", channel }));
    const r = await reg.execute("voice.speak", { text: "记得喝水" }, CTX);
    assert.equal(r.result.ok, true, `channel=${channel} 应放行`);
    assert.equal(voice.spoken.length, 1);
  }
});

test("用户显式要求播报 → 绕过闸门，不触发决策", async () => {
  let called = false;
  const stub = decisionStub({ action: "drop", channel: null });
  (stub as unknown as { decide: () => ReachDecision }).decide = () => {
    called = true;
    return { action: "drop", channel: null, utility: -1, p: 0, value: 0, cost: 1, reason: "x", perChannel: [] };
  };
  const { reg, voice } = registryWith(stub);
  const r = await reg.execute("voice.speak", { text: "喝水" }, { ...CTX, userText: "帮我播报一下" });
  assert.equal(r.result.ok, true);
  assert.equal(called, false);
  assert.equal(voice.spoken.length, 1);
});

test("空文本 → 直接报错，不触发决策", async () => {
  let called = false;
  const stub = decisionStub({});
  (stub as unknown as { decide: () => ReachDecision }).decide = () => {
    called = true;
    return { action: "send_now", channel: "voice.speak", utility: 0, p: 0, value: 0, cost: 0, reason: "", perChannel: [] };
  };
  const { reg } = registryWith(stub);
  const r = await reg.execute("voice.speak", { text: "  " }, CTX);
  assert.equal(r.result.ok, false);
  assert.equal(called, false);
});

test("真实决策服务: 高负反馈 → 播报被抑制；高正反馈 → 放行", async () => {
  const bad = new ReachDecisionService({
    feedback: () => ({ positive: 0, negative: 12 }),
    nowFn: () => new Date(2026, 10, 19, 10, 0, 0),
  });
  const a = registryWith(bad);
  assert.equal((await a.reg.execute("voice.speak", { text: "x" }, CTX)).result.ok, false);
  assert.equal(a.voice.spoken.length, 0);

  const good = new ReachDecisionService({
    feedback: () => ({ positive: 12, negative: 0 }),
    contextCost: () => 0,
    nowFn: () => new Date(2026, 10, 19, 10, 0, 0),
  });
  const b = registryWith(good);
  assert.equal((await b.reg.execute("voice.speak", { text: "x" }, CTX)).result.ok, true);
  assert.equal(b.voice.spoken.length, 1);
});
