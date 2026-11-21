/**
 * 语音条三连故障回归（2026-11-21 真机「用语音和我说晚安 → 54 秒 + 没有气泡」）。
 *
 * 锁定三条根因不再复发：
 *   1. 时长：TtsService 逐帧解出的真实 durationS 必须胜过「文件大小 ÷ 固定码率」，
 *      旧实现把 13 秒音频按 4000 B/s 粗估成 54 秒。
 *   2. 可见性：voice.send_message / voice.speak 必须直接暴露给 LLM；若被复合工具
 *      收编隐藏，模型会落到默认 speak（无 UI），表现为「调了工具但没气泡」。
 *   3. 回执：语音工具回执不得把可复述的秒数/「已发送」话术喂回模型，否则模型
 *      在正文编造「语音发过去了，五十四秒」。
 */
process.env.AGENT_TOOL_SEARCH_ENABLED = "on";
process.env.AGENT_NEURAL_EMBED_ENABLED = "off";
process.env.AGENT_NEURAL_RERANK_ENABLED = "off";
process.env.AGENT_NEURAL_INTENT_ENABLED = "off";

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const { VoiceMessageService } = await import("../src/services/voice-message-service.js");
const { getBuiltinAgentChatTools } = await import(
  "../src/external-model/openai-compatible-tool-loop.js"
);

/** 用假的 TtsService 驱动 composeAndStore，只关心它上报的 durationMs。 */
function fakeTts(durationS: number, bytes: number, bitrateKbps: number) {
  return {
    synthesizeMp3Buffer: async () => ({
      ok: true as const,
      format: "mp3" as const,
      provider: "breeze",
      buffer: Buffer.alloc(bytes, 1),
      quality: {
        score: 100,
        degraded: false,
        warnings: [],
        metrics: { durationS, bitrateKbps },
      },
    }),
  };
}

test("时长：用逐帧真实 durationS，不再按固定码率把 13s 虚报成 54s", async () => {
  const dir = mkdtempSync(join(tmpdir(), "voice-msg-dur-"));
  try {
    const svc = new VoiceMessageService(dir);
    svc.setTtsService(fakeTts(13.5, 216_000, 128) as never);
    const r = await svc.composeAndStore("晚安", "u1");
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.durationMs, 13_500, "应使用 inspectMp3 解出的真实 13.5s");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("时长：无真实时长时按质量报告的 bitrateKbps 估算，不用固定 4000 B/s", async () => {
  const dir = mkdtempSync(join(tmpdir(), "voice-msg-dur-"));
  try {
    const svc = new VoiceMessageService(dir);
    // 无 durationS，128kbps → 16000 B/s；216000B → 13.5s（旧逻辑会算成 54s）
    svc.setTtsService(fakeTts(0, 216_000, 128) as never);
    const r = await svc.composeAndStore("晚安", "u1");
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.durationMs, 13_500);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("可见性：voice.send_message 与 voice.speak 都直接暴露给 LLM", () => {
  const names = new Set(
    getBuiltinAgentChatTools()
      .filter((t) => t.type === "function")
      .map((t) => t.function.name),
  );
  assert.ok(names.has("voice.send_message"), "发气泡工具必须对模型可见");
  assert.ok(names.has("voice.speak"), "播报工具必须对模型可见");
});

test("回执摘要：不得把秒数或「已发送」话术喂回模型复述", async () => {
  const { registerAgentVoiceTools } = await import("../src/tools/agent-voice-tools.js");
  const { ToolRegistry } = await import("../src/tools/tool-registry.js");
  const registry = new ToolRegistry();
  registerAgentVoiceTools(registry, {
    sendMessage: async () => ({
      ok: true,
      messageId: "m1",
      mediaUrl: "/agent/voice/messages/u1/m1.mp3",
      durationMs: 13_500,
      transcript: "晚安",
      pushed: true,
      provider: "breeze",
    }),
  } as never);
  const out = await registry.execute(
    "voice.send_message",
    { text: "晚安" },
    { actorId: "u1", sessionId: "u1", userId: "u1" },
  );
  const summary = String(out.result?.summary ?? "");
  assert.ok(!/\d+\s*"/.test(summary), `摘要不应含秒数：${summary}`);
  assert.ok(!summary.includes("已发送"), `摘要不应 instruct 复述「已发送」：${summary}`);
  assert.ok(summary.includes("禁止"), "摘要应明确禁止正文复述");
});
