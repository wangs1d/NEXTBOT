import assert from "node:assert/strict";
import { test } from "node:test";

import {
  handlePetReactionEvent,
  type PetReactionChatLike,
} from "../src/ws/handlers/pet-reaction.js";

/** 收集 ack 的假 socket */
function makeSocket() {
  const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
  return {
    sent,
    socket: {
      send(data: string) {
        sent.push(JSON.parse(data));
      },
    },
  };
}

function makeChat(reply: string | Error, spy?: Record<string, unknown>): PetReactionChatLike {
  return {
    isEnabled: () => true,
    async streamCompletion(_sessionId, userTurn, _onDelta, _tools, streamOpts) {
      if (spy) {
        spy.userText = userTurn.text;
        spy.systemPrompt = streamOpts?.systemPromptOverride ?? "";
        spy.ephemeralTurn = streamOpts?.ephemeralTurn;
        spy.maxOutputTokens = streamOpts?.maxOutputTokens;
      }
      if (reply instanceof Error) throw reply;
      return reply;
    },
  };
}

test("未建立会话时直接 ack session_required", async () => {
  const { sent, socket } = makeSocket();
  await handlePetReactionEvent({ socket, boundActorId: "" }, { trigger: "tap" }, { chat: makeChat("hi") });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "pet.reaction.ack");
  assert.equal(sent[0].payload.ok, false);
  assert.equal(sent[0].payload.reason, "session_required");
});

test("未装配 LLM 通道时降级为 chat_unavailable（零配置不抛错）", async () => {
  const { sent, socket } = makeSocket();
  await handlePetReactionEvent({ socket, boundActorId: "actor-null-chat" }, { trigger: "tap" }, { chat: null });
  assert.equal(sent[0].payload.ok, false);
  assert.equal(sent[0].payload.reason, "chat_unavailable");
});

test("成功路径：LLM 文本清洗后原样回传，并透传 requestId", async () => {
  const { sent, socket } = makeSocket();
  const spy: Record<string, unknown> = {};
  await handlePetReactionEvent(
    { socket, boundActorId: "actor-success" },
    { trigger: "offwork_card", requestId: "pl-1", stats: { focusMinutes: 200, sessions: 4, streakDays: 6, offworkTime: "18:30" } },
    { chat: makeChat("  「准点下班，今天稳」  ", spy) },
  );
  const ack = sent[0].payload;
  assert.equal(ack.ok, true);
  assert.equal(ack.text, "准点下班，今天稳");
  assert.equal(ack.requestId, "pl-1");
  // 一次性调用：ephemeral + 关思考 + 小预算
  assert.equal(spy.ephemeralTurn, true);
  assert.equal(spy.maxOutputTokens, 64);
  // 打卡场景 prompt 包含"下班打卡"，且数据进了 user 文本
  assert.ok(String(spy.systemPrompt).includes("下班打卡"));
  assert.ok(String(spy.userText).includes("\"focusMinutes\":200"));
});

test("同 actor 连续请求触发节流", async () => {
  const { sent, socket } = makeSocket();
  await handlePetReactionEvent({ socket, boundActorId: "actor-throttle" }, { trigger: "tap" }, { chat: makeChat("第一句") });
  await handlePetReactionEvent({ socket, boundActorId: "actor-throttle" }, { trigger: "tap" }, { chat: makeChat("第二句") });
  assert.equal(sent[0].payload.ok, true);
  assert.equal(sent[1].payload.ok, false);
  assert.equal(sent[1].payload.reason, "throttled");
});

test("LLM 抛错时 ack generation_failed，不冒泡", async () => {
  const { sent, socket } = makeSocket();
  await handlePetReactionEvent(
    { socket, boundActorId: "actor-fail" },
    { trigger: "health_reminder", healthKind: "water" },
    { chat: makeChat(new Error("provider down")) },
  );
  assert.equal(sent[0].payload.ok, false);
  assert.equal(sent[0].payload.reason, "generation_failed");
});

test("健康提醒 prompt 走关心短句分支", async () => {
  const { sent, socket } = makeSocket();
  const spy: Record<string, unknown> = {};
  await handlePetReactionEvent(
    { socket, boundActorId: "actor-health" },
    { trigger: "health_reminder", healthKind: "sedentary" },
    { chat: makeChat("起来走走", spy) },
  );
  assert.equal(sent[0].payload.ok, true);
  assert.ok(String(spy.systemPrompt).includes("健康提醒"));
  assert.ok(String(spy.userText).includes("sedentary"));
});
