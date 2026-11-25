/**
 * BubbleTracker 单测（2026-11-25 车道架构）：
 * - 唯一写入路径是流式：appendStreamBlock 开新块/续写，id 递增 b1/b2，
 *   避开 interim- 保留前缀
 * - done 对账数组 = 账本照实快照（流式块即最终呈现，无重排/重建路径）
 * - 撤回清账 reset：回到单条车道语义，seq 归零
 * - snapshot 为拷贝，外部改动不影响内部记账
 */
import assert from "node:assert/strict";
import test from "node:test";

import { BubbleTracker } from "../src/agent/bubble-tracker.js";

const BASE = "assistant-user-msg-123";

test("流式块：new 开新块、continue 并回末块，返回同源块 id", () => {
  const t = new BubbleTracker(BASE);
  assert.equal(t.appendStreamBlock("哎，", true), `${BASE}-b1`);
  assert.equal(t.appendStreamBlock("在呢。", false), `${BASE}-b1`);
  assert.equal(t.appendStreamBlock("有什么事？", true), `${BASE}-b2`);
  assert.deepEqual(t.snapshot, [
    { id: `${BASE}-b1`, text: "哎，在呢。" },
    { id: `${BASE}-b2`, text: "有什么事？" },
  ]);
});

test("done 对账数组 = 流式账本照实快照（无重排路径）", () => {
  const t = new BubbleTracker(BASE);
  t.appendStreamBlock("先流一段。", true);
  t.appendStreamBlock("再流一段。", true);
  assert.equal(t.hasBubbles, true);
  assert.deepEqual(t.snapshot, [
    { id: `${BASE}-b1`, text: "先流一段。" },
    { id: `${BASE}-b2`, text: "再流一段。" },
  ]);
  assert.equal(t.outboundDoneMessageId, `${BASE}-b2`);
  assert.ok(!t.snapshot[0].id.startsWith("interim-"), "避开 interim- 保留前缀");
  assert.equal(t.streamedText, "先流一段。\n再流一段。");
});

test("兜底补漏并回末泡：appendStreamBlock(text,false) 追加定稿文本", () => {
  const t = new BubbleTracker(BASE);
  t.appendStreamBlock("先流一段。", true);
  t.appendStreamBlock("补漏尾段。", false);
  assert.deepEqual(t.snapshot, [{ id: `${BASE}-b1`, text: "先流一段。补漏尾段。" }]);
});

test("无泡时回退基础 id", () => {
  const t = new BubbleTracker(BASE);
  assert.equal(t.hasBubbles, false);
  assert.equal(t.outboundDoneMessageId, BASE);
  assert.equal(t.streamedText, "");
});

test("reset 清账：回到单条车道语义，seq 归零", () => {
  const t = new BubbleTracker(BASE);
  t.appendStreamBlock("一段。", true);
  t.appendStreamBlock("二段。", true);
  t.reset();
  assert.equal(t.hasBubbles, false);
  assert.deepEqual(t.snapshot, []);
  assert.equal(t.outboundDoneMessageId, BASE);
  // seq 归零：重新计块从 b1 起，不与撤回前的块错位
  assert.equal(t.appendStreamBlock("重来。", true), `${BASE}-b1`);
});

test("snapshot 是拷贝：外部改动不影响内部记账", () => {
  const t = new BubbleTracker(BASE);
  t.appendStreamBlock("在呢。", true);
  const snap = t.snapshot;
  snap[0].text = "篡改";
  assert.equal(t.snapshot[0].text, "在呢。");
});
