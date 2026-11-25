// 主动回合发射器（2026-11-25 表达层）：一次内容 → 一次 done，分泡/卡片由同一信封投影。
import assert from "node:assert/strict";
import { test } from "node:test";

import { bubbleTextsOf, publishAssistantTurn } from "../src/agent/assistant-turn-publisher.js";

function emit(finalText: string) {
  const frames: Array<Record<string, any>> = [];
  const result = publishAssistantTurn(
    (json) => {
      frames.push(JSON.parse(json) as Record<string, any>);
      return true;
    },
    {
      sessionId: "u1",
      traceId: "t1",
      finalText,
      proactive: { deliveryId: "d1", title: "管家", why: "想让你知道", kind: "agent_pulse" },
    },
  );
  return { frames, result };
}

test("分泡：多句 → 一次 done 带 bubbles，id 与末泡同源；不再伪流式发 chunk", () => {
  const { frames, result } = emit("第一句。第二句。第三句。");
  assert.equal(frames.length, 1, "主动内容已写成稿：只发终态 done");
  const done = frames[0]!;
  assert.equal(done.type, "chat.assistant_done");
  assert.equal(done.payload.bubbles.length, 2);
  assert.deepEqual(
    done.payload.bubbles.map((b: { id: string }) => b.id),
    ["assistant-t1-b1", "assistant-t1-b2"],
  );
  assert.equal(done.payload.bubbles.map((b: { text: string }) => b.text).join(""), "第一句。第二句。第三句。");
  assert.equal(done.payload.messageId, "assistant-t1-b2", "done 指向末泡");
  assert.equal(done.payload.proactive.deliveryId, "d1");
  assert.equal(done.payload.proactive.why, "想让你知道");
  assert.equal(result.bubbles, 2);
});

test("单句：不拆泡，done 直接带 finalText", () => {
  const { frames } = emit("航班改到 10:30 了，要我现在提醒你出门吗？");
  assert.equal(frames.length, 1);
  assert.equal(frames[0]!.payload.bubbles, undefined);
  assert.equal(
    frames[0]!.payload.finalText,
    "航班改到 10:30 了，要我现在提醒你出门吗？",
  );
});

test("卡片轮：单条收口，卡进结构化字段，正文不再露 JSON 墙", () => {
  const card = '{"cardType":"travel_itinerary","title":"行程"}';
  const { frames, result } = emit(`帮你排好了。\n[AGENT_RESULT_CARD_START]${card}[AGENT_RESULT_CARD_END]`);
  const done = frames[0]!;
  assert.equal(frames.length, 1);
  assert.equal(done.payload.bubbles, undefined, "有卡不拆泡");
  assert.equal(done.payload.cards.length, 1);
  assert.equal(done.payload.renderBlocks != null || done.payload.cards != null, true);
  assert.equal(result.bubbles, 0);
});

test("分泡上限与不丢字：超过三句也只切三泡，文本顺序不变", () => {
  const text = "一。二。三。四。五。";
  const bubbles = bubbleTextsOf(text);
  assert.equal(bubbles.length, 3);
  assert.equal(bubbles.join(""), text);
});
