/**
 * BubbleTracker 单测（方案 C：同 block 身份原地升级，2026-11-23）：
 * - 流式块与定稿块共用 id 分配（assistant-$traceId-bN，按位置对应）
 * - 按最终文本建泡，id 递增 b1/b2，避开 interim- 保留前缀
 * - 空白段跳过；无泡时回退基础 id
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

test("done 重排沿用流式块 id：前 N 个 id 按位置一一对应", () => {
  const t = new BubbleTracker(BASE);
  t.appendStreamBlock("先流一段。", true);
  t.appendStreamBlock("再流一段。", true);
  // 定稿块数与流式一致 → id 完全继承，客户端只 patch 文本
  t.setFinalBubbles(["先流一段（定稿）。", "再流一段。"]);
  assert.deepEqual(t.snapshot, [
    { id: `${BASE}-b1`, text: "先流一段（定稿）。" },
    { id: `${BASE}-b2`, text: "再流一段。" },
  ]);
  // 定稿多出尾部块 → 前 N 个 id 不变，新块追加
  t.setFinalBubbles(["先流一段（定稿）。", "再流一段。", "新增尾段。"]);
  assert.deepEqual(
    t.snapshot.map((b) => b.id),
    [`${BASE}-b1`, `${BASE}-b2`, `${BASE}-b3`],
  );
});

test("按最终文本建泡：id 递增 b1/b2，outboundDoneMessageId 指向末泡", () => {
  const t = new BubbleTracker(BASE);
  t.setFinalBubbles(["哎，在呢。", "有什么事？"]);
  assert.equal(t.hasBubbles, true);
  assert.deepEqual(t.snapshot, [
    { id: `${BASE}-b1`, text: "哎，在呢。" },
    { id: `${BASE}-b2`, text: "有什么事？" },
  ]);
  assert.equal(t.outboundDoneMessageId, `${BASE}-b2`);
  assert.ok(!t.snapshot[0].id.startsWith("interim-"), "避开 interim- 保留前缀");
});

test("空白段跳过；全空白时回退基础 id", () => {
  const t = new BubbleTracker(BASE);
  t.setFinalBubbles(["  第一泡。 ", "\n\n", ""]);
  assert.deepEqual(t.snapshot, [{ id: `${BASE}-b1`, text: "第一泡。" }]);

  t.setFinalBubbles(["   ", ""]);
  assert.equal(t.hasBubbles, false);
  assert.deepEqual(t.snapshot, []);
  assert.equal(t.outboundDoneMessageId, BASE);
});

test("snapshot 是拷贝：外部改动不影响内部记账", () => {
  const t = new BubbleTracker(BASE);
  t.setFinalBubbles(["在呢。"]);
  const snap = t.snapshot;
  snap[0].text = "篡改";
  assert.equal(t.snapshot[0].text, "在呢。");
});
