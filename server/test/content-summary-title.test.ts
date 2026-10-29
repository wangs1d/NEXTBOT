/**
 * 折叠卡标题文案：卡面标题取内容主题（科技新闻/财经资讯…），
 * 不再从正文首行取——长结构化回复的首行常是「王哥，我扒了一圈…给你按块捋一下——」
 * 这类口语开场，印在卡面上很难看。
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  createContentSummary,
  inferTaskSubject,
} from "../src/services/content-summary-service.js";

function longStructured(firstLine: string, heading: string): string {
  return [
    firstLine,
    "",
    `## ${heading}`,
    "人工智能芯片厂商本周集中发布新品，几家头部公司都在强调推理成本和端侧部署，" +
      "发布会现场给出的数据是同等算力下成本下降三成，但第三方评测的结论要保守一些，" +
      "实际部署还要看软件栈的成熟度，尤其是算子覆盖和量化精度损失这两个老问题。",
    "",
    "## 财经向",
    "内存价格明年还要涨，渠道商已经开始囤货；几家大厂的资本开支计划也在往上调，" +
      "上游设备厂商的订单排期已经排到了后年，短期看不到松动的迹象。",
    "",
    "## 实用提示",
    "这些消息大多没标具体发布时间，按来源和内容判断是这两天的；" +
      "想深挖某一条，可以再去把那篇原文扒出来，注意核对原始出处。",
  ].join("\n");
}

test("卡面标题取内容主题，不取正文首行的口语开场", () => {
  const summary = createContentSummary(
    longStructured(
      "王哥，我扒了一圈今天的公开报道，给你按块捋一下——",
      "科技 · 最抢眼的",
    ),
    { forceSummary: true },
  );
  assert.ok(summary, "长结构化内容应生成摘要卡");
  assert.equal(summary!.title, "科技新闻");
  assert.equal(summary!.cardLabel, "科技新闻");
});

test("首行是正经标题时，卡面也用内容主题", () => {
  const summary = createContentSummary(
    longStructured("马尔代夫七日行程安排", "行程"),
    { forceSummary: true },
  );
  assert.ok(summary, "长结构化内容应生成摘要卡");
  assert.equal(summary!.title, "旅游计划");
});

test("inferTaskSubject：按内容关键词给主题，不看导语措辞", () => {
  assert.equal(
    inferTaskSubject("帮你把这份健康指南整理好了：\n\n## 饮食\n每天保证一斤蔬菜。"),
    "健康资讯",
  );
});

test("判不出主题时不再拿类目名兜底，也不出折叠卡", () => {
  assert.equal(inferTaskSubject("今天是几号，几点了。"), "");
  const neutral = [
    "好了，都办完了。",
    "",
    "## 第一块",
    "上面提到的那些事前后发生了好几次，每次的处理方式都不太一样，中间隔了一段时间才慢慢稳定下来，" +
      "现在回头看当时的做法，有些地方其实还可以再稳妥一些，只是当时没有更好的选择。",
    "",
    "## 第二块",
    "后面那部分拖得比较久，主要是等对方回话，来回沟通了几轮才确定下来，期间也改过两次说法，" +
      "最后定下来的版本和最初想的不太一样，但至少各方都能接受。",
    "",
    "## 第三块",
    "剩下的就简单了，按之前说好的照做就行，中间没有出现意外，收尾的时候确认了一遍就结束了。",
  ].join("\n");
  const summary = createContentSummary(neutral, { forceSummary: true });
  assert.equal(summary, null, "无主题的长文不折叠");
});
