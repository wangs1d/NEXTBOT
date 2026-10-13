/**
 * 发言模型单测（2026-10-09 重复回复根源修复）。
 *
 * 每个用例对应 utterance-assembler.ts 文件头的一条不变量；
 * 场景文本取自真机事故（「以后叫我王爷」两条重复确认）。
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  UtteranceAssembler,
  isAckLike,
  isProcessTalk,
  isSemanticallyEquivalent,
  normalizeForCompare,
} from "../src/agent/utterance-assembler.js";
import { isBookkeepingOnlyToolSet } from "../src/agent/synthesis-strategy.js";

const TRACE = "turn-1759999999-abc";

test("I1 一 turn 一发言：两次波次输出只产生一条发言身份", () => {
  const u = new UtteranceAssembler({ utteranceId: TRACE });
  u.noteEmitted("好的王爷，记下了。");
  u.noteToolStart("profile.update");
  u.noteToolExecuted("profile.update");
  u.noteEmitted("好的王爷，已经记上啦。👍");

  const s = u.settle();
  assert.equal(s.utteranceId, TRACE);
  assert.equal(s.segments.length, 2);
  // 两段同属一条发言：序号唯一且连续
  assert.deepEqual(
    s.segments.map((x) => x.index),
    [1, 2],
  );
});

test("I2 多波同源：过程话与结论都登记在同一发言内（不新开身份）", () => {
  const u = new UtteranceAssembler({ utteranceId: TRACE });
  u.noteEmitted("我帮您查一下。");
  u.noteToolStart("search_web");
  u.noteEmitted("今天兴义晴，25 度。");

  const s = u.settle();
  assert.equal(u.preambleText, "我帮您查一下。");
  assert.equal(u.conclusionText, "今天兴义晴，25 度。");
  assert.equal(s.kept.length, 2);
  assert.equal(u.utteranceId, TRACE);
});

test("I3 记账轮：过程话无实质内容 → 裁掉，只留结论（王爷事故根修）", () => {
  const u = new UtteranceAssembler({ utteranceId: TRACE });
  u.noteEmitted("好的王爷，记下了。");
  u.noteToolStart("profile.update");
  u.noteToolExecuted("profile.update");
  u.noteEmitted("好的王爷，已经记上啦。👍");

  const s = u.settle();
  assert.equal(s.bookkeepingOnly, true);
  assert.equal(s.collapse, true);
  assert.equal(s.collapseReason, "preamble_non_substantive_in_bookkeeping");
  assert.equal(s.kept.length, 1);
  assert.equal(s.kept[0].text, "好的王爷，已经记上啦。👍");
  assert.deepEqual(s.droppedSegmentIndexes, [1]);
});

test("I4 分段不改变身份：保留过程话时仍是同一条发言（检索轮保住节奏）", () => {
  const u = new UtteranceAssembler({ utteranceId: TRACE });
  u.noteEmitted("我帮您查一下。");
  u.noteToolStart("search_web");
  u.noteEmitted("今天兴义晴，25 度。");

  const s = u.settle();
  assert.equal(s.bookkeepingOnly, false);
  assert.equal(s.collapse, false);
  assert.equal(s.collapseReason, "none");
  assert.equal(s.kept.length, 2);
  assert.deepEqual(s.droppedSegmentIndexes, []);
});

test("语义等价（非记账轮也应裁）：过程话与结论归一后完全重合", () => {
  const u = new UtteranceAssembler({ utteranceId: TRACE });
  u.noteEmitted("好的，记下了。");
  u.noteToolStart("search_web");
  u.noteEmitted("好的，记下了！");

  const s = u.settle();
  assert.equal(s.collapse, true);
  assert.equal(s.collapseReason, "preamble_equals_conclusion");
  assert.equal(s.kept.length, 1);
});

test("边界：只有过程话、没有结论时不得塌缩（否则用户会看不到任何回复）", () => {
  const u = new UtteranceAssembler({ utteranceId: TRACE });
  u.noteEmitted("好的王爷，记下了。");

  const s = u.settle();
  assert.equal(s.collapse, false);
  assert.equal(s.kept.length, 1);
  assert.equal(s.kept[0].text, "好的王爷，记下了。");
});

test("边界：结论由收口链一次性写入（未经分段器）时用 finalText 兜底成结论段", () => {
  const u = new UtteranceAssembler({ utteranceId: TRACE });
  u.noteEmitted("好的王爷，记下了。");
  u.noteToolStart("profile.update");

  const s = u.settle("好的王爷，已经记上啦。");
  assert.equal(s.segments.length, 2);
  assert.equal(u.conclusionText, "好的王爷，已经记上啦。");
  assert.equal(s.collapse, true);
  assert.equal(s.kept.length, 1);
});

test("回归（2026-10-11）：无工具纯聊天轮不得塌缩——已流分段就是发言本体", () => {
  // 事故形态：纯聊天轮没有任何工具，全部流式分段被记成 preamble，
  // settle(finalText) 又把 finalText 兜底成结论段 → 两者内容天然等价
  // → 整轮塌缩单泡，真·分绿泡在无工具轮全部失效（客户端删光已分泡，
  // 只落一条带分段的 finalText）。
  const u = new UtteranceAssembler({ utteranceId: TRACE });
  u.noteEmitted("我没说你配，是你自己先把话堵死了。");
  u.noteEmitted("但这不叫不配，叫难。");
  u.noteEmitted("想听真话还是想哄你的？");

  const s = u.settle("我没说你配，是你自己先把话堵死了。\n\n但这不叫不配，叫难。\n\n想听真话还是想哄你的？");
  assert.equal(s.segments.length, 3); // 不补登重复结论段
  assert.equal(s.collapse, false);
  assert.equal(s.collapseReason, "none");
  assert.equal(s.kept.length, 3);
  assert.deepEqual(s.droppedSegmentIndexes, []);
});

test("无工具且全程无分段（缓冲/扣流轮）：finalText 兜底成唯一结论段、不塌缩", () => {
  const u = new UtteranceAssembler({ utteranceId: TRACE });
  const s = u.settle("整段回复未经流式分段直接写入。");
  assert.equal(s.segments.length, 1);
  assert.equal(u.conclusionText, "整段回复未经流式分段直接写入。");
  assert.equal(s.collapse, false);
  assert.equal(s.kept.length, 1);
});

test("记账轮判定：全部记账工具才算记账轮，混入任一检索工具即非记账", () => {
  assert.equal(isBookkeepingOnlyToolSet(["profile.update"]), true);
  assert.equal(isBookkeepingOnlyToolSet(["profile.update", "memory.forget"]), true);
  assert.equal(isBookkeepingOnlyToolSet(["profile.update", "search_web"]), false);
  assert.equal(isBookkeepingOnlyToolSet([]), false);
});

test("确认/过程话句式判定：真确认命中，实质内容不命中", () => {
  assert.equal(isAckLike("好的王爷，记下了。"), true);
  assert.equal(isAckLike("已经记上啦"), true);
  assert.equal(isAckLike("嗯"), true);
  assert.equal(isAckLike("今天兴义晴，25 度。"), false);
  assert.equal(isAckLike("查到了三家火锅店，第一家评分 4.8，人均 88。"), false);
  assert.equal(isProcessTalk("我帮您查一下。"), true);
  assert.equal(isProcessTalk("让我确认一下"), true);
  assert.equal(isProcessTalk("我改了你的日程，明天上午 10 点开会。"), false);
});

test("归一比较：标点/空白/emoji 差异不算差异", () => {
  assert.equal(normalizeForCompare("好的，记下了。👍"), normalizeForCompare("好的记下了"));
  assert.equal(isSemanticallyEquivalent("好的，记下了。", "好的 记下了！"), true);
  assert.equal(isSemanticallyEquivalent("好的，记下了。", "好的，已经记上啦。"), false);
});

test("观测描述可读（回归取证用）", () => {
  const u = new UtteranceAssembler({ utteranceId: TRACE });
  u.noteEmitted("好的王爷，记下了。");
  u.noteToolStart("profile.update");
  u.noteEmitted("好的王爷，已经记上啦。");
  const line = u.describeSettlement(u.settle());
  assert.match(line, /collapse=true/);
  assert.match(line, /reason=preamble_non_substantive_in_bookkeeping/);
  assert.match(line, /tools=profile\.update/);
});
