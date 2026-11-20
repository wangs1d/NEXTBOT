// voice.send_message 接入期望效用决策闸门的单测：
// 用真实 ToolRegistry + 假 VoiceCapabilityService，验证"显式绕过 / 主动被抑制 / 高价值放行"
import assert from "node:assert/strict";
import { test } from "node:test";

import { registerAgentVoiceTools } from "../src/tools/agent-voice-tools.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";
import type { VoiceCapabilityService } from "../src/services/voice-capability-service.js";
import { ReachDecisionService } from "../src/proactivity/reach-decision-service.js";
import type { ReachDecision } from "../src/proactivity/reach-decision.js";

const CTX = {
  sessionId: "s1",
  userId: "u1",
  userText: "帮我总结一下今天",
} as const;

function fakeVoice() {
  const sent: Array<{ text: string }> = [];
  const svc = {
    sendMessage: async (p: { text: string }) => {
      sent.push({ text: p.text });
      return {
        ok: true as const,
        messageId: "m1",
        mediaUrl: "/x.mp3",
        durationMs: 3000,
        transcript: p.text,
        pushed: true,
      };
    },
    speak: async () => ({ ok: true as const, voiceId: "v1", pushed: true }),
  };
  return { svc: svc as unknown as VoiceCapabilityService, sent };
}

function registryWith(decision?: ReachDecisionService) {
  const reg = new ToolRegistry();
  const voice = fakeVoice();
  registerAgentVoiceTools(reg, voice.svc, decision);
  return { reg, voice };
}

/** 构造一个返回固定决策的假服务（只实现 decide）。 */
function decisionStub(d: Partial<ReachDecision>): ReachDecisionService {
  const full: ReachDecision = {
    action: "send_now",
    channel: "voice.message",
    utility: 0.3,
    p: 0.7,
    value: 0.5,
    cost: 0.1,
    reason: "stub",
    perChannel: [],
    ...d,
  };
  return { decide: () => full } as unknown as ReachDecisionService;
}

test("未注入决策服务 → 语音条照常发送（向后兼容）", async () => {
  const { reg, voice } = registryWith();
  const r = await reg.execute("voice.send_message", { text: "你好" }, CTX);
  assert.equal(r.result.ok, true);
  assert.equal(r.result.pushed, true);
  assert.equal(voice.sent.length, 1);
});

test("决策 drop → 不发语音条，返回结构化抑制原因", async () => {
  const { reg, voice } = registryWith(
    decisionStub({ action: "drop", channel: null, utility: -0.2, reason: "net_utility_negative" }),
  );
  const r = await reg.execute("voice.send_message", { text: "你好" }, CTX);
  assert.equal(r.result.ok, false);
  assert.equal(r.result.suppressedByReachDecision, true);
  assert.equal(r.result.action, "drop");
  assert.match(String(r.result.summary), /文本回复/);
  assert.equal(voice.sent.length, 0);
});

test("决策 send_now 但选了 chat → 仍不发语音条（'文本就够了'）", async () => {
  const { reg, voice } = registryWith(
    decisionStub({ action: "send_now", channel: "chat", reason: "admitted(chat)" }),
  );
  const r = await reg.execute("voice.send_message", { text: "你好" }, CTX);
  assert.equal(r.result.ok, false);
  assert.equal(r.result.channel, "chat");
  assert.equal(voice.sent.length, 0);
});

test("决策认可语音通道 → 正常发送", async () => {
  const { reg, voice } = registryWith(
    decisionStub({ action: "send_now", channel: "voice.message", utility: 0.3 }),
  );
  const r = await reg.execute("voice.send_message", { text: "你好" }, CTX);
  assert.equal(r.result.ok, true);
  assert.equal(voice.sent.length, 1);
});

test("用户显式要求发语音 → 绕过决策闸门（即使决策本会 drop）", async () => {
  const dropDecision = decisionStub({ action: "drop", channel: null });
  let called = false;
  (dropDecision as unknown as { decide: () => ReachDecision }).decide = () => {
    called = true;
    return {
      action: "drop", channel: null, utility: -1, p: 0, value: 0, cost: 1, reason: "x", perChannel: [],
    };
  };
  const { reg, voice } = registryWith(dropDecision);
  const r = await reg.execute(
    "voice.send_message",
    { text: "你好" },
    { ...CTX, userText: "给我发条语音消息" },
  );
  assert.equal(r.result.ok, true);
  assert.equal(voice.sent.length, 1);
  assert.equal(called, false, "显式请求不应触发决策调用");
});

test("空文本 → 直接报错，不触发决策", async () => {
  let called = false;
  const d = decisionStub({});
  (d as unknown as { decide: () => ReachDecision }).decide = () => {
    called = true;
    return { action: "send_now", channel: "voice.message", utility: 0, p: 0, value: 0, cost: 0, reason: "", perChannel: [] };
  };
  const { reg } = registryWith(d);
  const r = await reg.execute("voice.send_message", { text: "  " }, CTX);
  assert.equal(r.result.ok, false);
  assert.equal(called, false);
});

test("真实决策服务: 高负反馈(接受率低) → 语音条被抑制", async () => {
  const service = new ReachDecisionService({
    feedback: () => ({ positive: 0, negative: 9 }), // p≈0.09
    nowFn: () => new Date(2026, 10, 19, 10, 0, 0),
  });
  const { reg, voice } = registryWith(service);
  const r = await reg.execute("voice.send_message", { text: "你好" }, CTX);
  assert.equal(r.result.ok, false);
  assert.equal(r.result.suppressedByReachDecision, true);
  assert.equal(voice.sent.length, 0);
});

test("真实决策服务: 高正反馈(接受率高) + 空闲上下文 → 语音条放行", async () => {
  const service = new ReachDecisionService({
    feedback: () => ({ positive: 9, negative: 0 }), // p≈0.91
    contextCost: () => 0,
    nowFn: () => new Date(2026, 10, 19, 10, 0, 0),
  });
  const { reg, voice } = registryWith(service);
  const r = await reg.execute("voice.send_message", { text: "你好" }, CTX);
  assert.equal(r.result.ok, true);
  assert.equal(voice.sent.length, 1);
});
