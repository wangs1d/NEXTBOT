/**
 * 发言模型链路集成测试（2026-10-09 重复回复根源修复）。
 *
 * 用**真实模块**按 WS handler 的装配顺序跑一遍轮次：
 *   StreamSegmenter(bubbleMode) → BubbleTracker(分泡 messageId) → UtteranceAssembler(发言结算)
 * 覆盖三类轮次，断言用户可见的消息条目数与塌缩裁决：
 *   1. 记账轮（事故形态）：前导话 + 结论 → 塌缩为一条
 *   2. 检索轮：前导话 + 结论 → 同一条发言的两个分段（保留节奏，不丢内容）
 *   3. 单波直答：只有一个分段
 */
import test from "node:test";
import assert from "node:assert/strict";

import { StreamSegmenter } from "../src/agent/stream-segmenter.js";
import { BubbleTracker } from "../src/agent/bubble-tracker.js";
import { UtteranceAssembler } from "../src/agent/utterance-assembler.js";

interface EmittedSegment {
  messageId: string;
  bubbleIndex?: number;
  text: string;
}

/** 按 handler 的接线方式跑一轮：分段器出站 → 分泡 id → 发言记账。 */
function buildTurn(trace: string) {
  const baseMessageId = `assistant-${trace}`;
  const bubbleTracker = new BubbleTracker(false, baseMessageId);
  const utterance = new UtteranceAssembler({ utteranceId: trace });
  const emitted: EmittedSegment[] = [];
  // 停顿档位清零：只验证身份与结算，不睡真实节奏
  const segmenter = new StreamSegmenter(
    (segment, _phase, meta) => {
      const outbound = bubbleTracker.assign(segment, meta);
      utterance.noteEmitted(segment);
      emitted.push({ messageId: outbound.messageId, bubbleIndex: outbound.bubbleIndex, text: segment });
    },
    { pauseMs: 0, bubbleGapMinMs: 0, bubbleGapMaxMs: 0, interimReplyGapMs: 0 },
  );
  // 分泡门禁（对话面 + 非语音 + AGENT_BUBBLE_SPLIT 默认开）
  bubbleTracker.active = true;
  segmenter.enableBubbleMode();

  return {
    bubbleTracker,
    utterance,
    emitted,
    feed: (text: string) => segmenter.feed(text),
    /** 与 handler 同款边界屏障：等已喂入内容出站后再打工具边界标记 */
    pending: () => segmenter.awaitPending(),
    flush: () => segmenter.flushFinal(),
    /** 模拟 done 载荷：是否触发客户端塌缩（finalTextReplacesStream）。 */
    doneWouldCollapse: (collapse: boolean) => collapse && bubbleTracker.hasBubbles,
    snapshot: () => bubbleTracker.snapshot,
  };
}

test("记账轮（王爷事故形态）：前导话 + 结论 → 塌缩为一条发言", async () => {
  const turn = buildTurn("turn-accident");

  turn.feed("好的王爷，记下了。");
  await turn.pending();
  turn.utterance.noteToolStart("profile.update");
  turn.utterance.noteToolExecuted("profile.update");
  turn.feed("好的王爷，已经记上啦。👍");
  await turn.flush();

  // 出站了两个分段（两条气泡 id）
  const ids = [...new Set(turn.emitted.map((e) => e.messageId))];
  assert.equal(ids.length, 2);
  // 但它们是**同一条发言**
  assert.equal(turn.utterance.utteranceId, "turn-accident");
  const settlement = turn.utterance.settle();
  assert.equal(settlement.bookkeepingOnly, true);
  assert.equal(settlement.collapse, true);
  assert.equal(settlement.collapseReason, "preamble_non_substantive_in_bookkeeping");
  assert.equal(settlement.kept.length, 1);
  assert.match(settlement.kept[0].text, /已经记上啦/);
  // done 载荷据此下发 finalTextReplacesStream + bubbles 清单 → 客户端删除过程话泡
  assert.equal(turn.doneWouldCollapse(settlement.collapse), true);
  assert.equal(turn.snapshot().length, 2);
});

test("检索轮：前导话 + 结论 → 同一条发言的两个分段（节奏与内容都保留）", async () => {
  const turn = buildTurn("turn-search");

  turn.feed("我帮您查一下。");
  await turn.pending();
  turn.utterance.noteToolStart("search_web");
  turn.utterance.noteToolExecuted("search_web");
  turn.feed("今天兴义晴，25 度，风不大。");
  await turn.flush();

  const ids = [...new Set(turn.emitted.map((e) => e.messageId))];
  assert.ok(ids.length >= 1);
  const settlement = turn.utterance.settle();
  assert.equal(settlement.bookkeepingOnly, false);
  assert.equal(settlement.collapse, false);
  assert.equal(settlement.collapseReason, "none");
  // 两段都保留（客户端按同发言归组渲染为一条消息的多个泡）
  assert.equal(settlement.kept.length, settlement.segments.length);
  // 不触发塌缩
  assert.equal(turn.doneWouldCollapse(settlement.collapse), false);
});

test("单波直答：只有一个分段，不塌缩", async () => {
  const turn = buildTurn("turn-simple");

  turn.feed("在呢，你说。");
  await turn.flush();

  const ids = [...new Set(turn.emitted.map((e) => e.messageId))];
  assert.equal(ids.length, 1);
  const settlement = turn.utterance.settle();
  assert.equal(settlement.collapse, false);
  assert.equal(settlement.segments.length, 1);
});

test("I1/I4 集成：一轮内所有分段共享同一个发言身份", async () => {
  const turn = buildTurn("turn-identity");

  turn.feed("好的，我看下。");
  await turn.pending();
  turn.utterance.noteToolStart("search_web");
  turn.feed("第一条。");
  turn.feed("第二条。");
  await turn.flush();

  assert.ok(turn.emitted.length >= 2);
  for (const e of turn.emitted) {
    // 分泡 id 形如 assistant-<trace>-bN：trace 恒为本轮发言 id
    assert.match(e.messageId, /^assistant-turn-identity(-b\d+)?$/);
  }
  assert.equal(turn.utterance.utteranceId, "turn-identity");
});
