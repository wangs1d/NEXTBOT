/**
 * BubbleTracker 单测（真·分绿泡 WS 组装层，2026-09-28）：
 * - chunk→气泡 messageId 分配（assistant-$traceId-bN，避开 interim- 保留前缀）
 * - new/continue 语义：new 开新泡、continue/直推段追加末泡、无泡时兜底开泡
 * - done 载荷字段：hasBubbles / outboundDoneMessageId / snapshot
 * - 未激活时全量回退原协议
 */
import assert from "node:assert/strict";
import test from "node:test";

import { BubbleTracker } from "../src/agent/bubble-tracker.js";

const BASE = "assistant-user-msg-123";

test("未激活：所有 chunk 走原协议 messageId，无 bubbleIndex", () => {
  const t = new BubbleTracker(false, BASE);
  const a = t.assign("你好。", { bubble: "new" });
  const b = t.assign("在呢。");
  assert.equal(a.messageId, BASE);
  assert.equal(a.bubbleIndex, undefined);
  assert.equal(b.messageId, BASE);
  assert.equal(t.hasBubbles, false);
  assert.equal(t.outboundDoneMessageId, BASE);
  assert.deepEqual(t.snapshot, []);
});

test("激活：new 开新泡，id 递增 b1/b2，bubbleIndex 对齐", () => {
  const t = new BubbleTracker(true, BASE);
  const a = t.assign("哎，在呢。", { bubble: "new" });
  const b = t.assign("有什么事？", { bubble: "new" });
  assert.equal(a.messageId, `${BASE}-b1`);
  assert.equal(a.bubbleIndex, 1);
  assert.equal(b.messageId, `${BASE}-b2`);
  assert.equal(b.bubbleIndex, 2);
  assert.ok(!a.messageId.startsWith("interim-"), "避开 interim- 保留前缀");
});

test("工具轮回归（2026-11-06 截图事故）：无预文的工具轮照常逐泡，不存在冻结态", () => {
  // 事故复现路径：模型先调工具（无过程话），工具后才开始流式输出。
  // 旧冻结态下第一个 chunk 会对空泡数组取 [-1] TypeError，整轮退化单泡。
  const t = new BubbleTracker(true, BASE);
  const a = t.assign("定好了，到点叫你。", { bubble: "new" });
  const b = t.assign("不过你平时都是凌晨零点四十几才睡，这算是提前打烊？", {
    bubble: "new",
  });
  assert.equal(a.messageId, `${BASE}-b1`);
  assert.equal(b.messageId, `${BASE}-b2`, "工具后正文必须开新泡，不得并回首泡");
  assert.deepEqual(t.snapshot, [
    { id: `${BASE}-b1`, text: "定好了，到点叫你。" },
    {
      id: `${BASE}-b2`,
      text: "不过你平时都是凌晨零点四十几才睡，这算是提前打烊？",
    },
  ]);
  assert.equal(t.outboundDoneMessageId, `${BASE}-b2`);
});

test("激活：无 meta 直推段追加到当前末泡；尚无泡时兜底开第一泡", () => {
  const t = new BubbleTracker(true, BASE);
  const first = t.assign("兜底直推全文。");
  assert.equal(first.messageId, `${BASE}-b1`, "无泡时直推段开第一泡");
  t.assign("第一泡。", { bubble: "new" });
  const cont = t.assign("收口残差");
  assert.equal(cont.messageId, `${BASE}-b2`, "continue 追加当前末泡");
  const snap = t.snapshot;
  assert.equal(snap.length, 2);
  assert.equal(snap[0].text, "兜底直推全文。");
  assert.equal(snap[1].text, "第一泡。收口残差");
});

test("done 载荷字段：outboundDoneMessageId 指向末泡，snapshot 为对账数组", () => {
  const t = new BubbleTracker(true, BASE);
  t.assign("在呢。", { bubble: "new" });
  t.assign("怎么了？", { bubble: "new" });
  assert.equal(t.outboundDoneMessageId, `${BASE}-b2`);
  assert.deepEqual(t.snapshot, [
    { id: `${BASE}-b1`, text: "在呢。" },
    { id: `${BASE}-b2`, text: "怎么了？" },
  ]);
  // snapshot 是拷贝：外部改动不影响内部记账
  const snap = t.snapshot;
  snap[0].text = "篡改";
  assert.equal(t.snapshot[0].text, "在呢。");
});

// ── 说话算话分歧裁决（2026-09-28 根修）──

test("分歧裁决：残差小 → feed 补推；普通分泡轮大残差 → discard 弃重写", () => {
  const t = new BubbleTracker(true, BASE);
  // 小残差（确定性收口差异）照旧补推
  assert.equal(t.resolveDivergence(10, 200), "feed");
  // 大残差（≥40%，重写/重跑换说法）→ 说话算话，弃重写、不塌缩
  assert.equal(t.resolveDivergence(100, 200), "discard");
  assert.equal(t.resolveDivergence(81, 200), "discard");
  // 恰好压线（40% 整）也算大残差
  assert.equal(t.resolveDivergence(80, 200), "discard");
  // 零残差无意义，恒 feed
  assert.equal(t.resolveDivergence(0, 200), "feed");
});

test("分歧裁决：确认轮例外 → replace 保留收口塌缩", () => {
  const t = new BubbleTracker(true, BASE);
  t.confirmationAnchored = true;
  assert.equal(t.resolveDivergence(100, 200), "replace", "确认轮大残差仍塌缩");
  assert.equal(t.resolveDivergence(10, 200), "feed", "确认轮小残差照旧补推");
});

test("分歧裁决：确认轮标记不影响 snapshot/outbound 字段", () => {
  const t = new BubbleTracker(true, BASE);
  t.assign("订好了。", { bubble: "new" });
  t.confirmationAnchored = true;
  assert.equal(t.outboundDoneMessageId, `${BASE}-b1`);
  assert.equal(t.snapshot.length, 1);
});
