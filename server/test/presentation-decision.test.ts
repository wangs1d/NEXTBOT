/**
 * 呈现裁决 × 渲染出口 的真实联调回归（2026-11-23 截图事故）。
 *
 * 事故形态：同一条回复上半部分是流式原文气泡，下半部分是 done 重排出的
 * 列表卡——同一段内容渲染两遍。根因是「分泡判断」与「渲染通道」各自决策、
 * 在客户端叠加输出。本测试直接跑真实 renderTurn + decideFinalPlan，锁住
 * 「信息类回复必须收成单条」这一不变量。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { renderTurn } from "../src/render/turn.js";
import {
  decideFinalPlan,
  decideStreamPlan,
  type PresentationPlan,
} from "../src/agent/bubble-policy.js";

const FSD_REPLY = [
  "先不用急着下这个结论，我查一下。大哥，算是开放了，但这次还只是小范围开闸，不是全面放开。",
  "",
  "- **11月21日**，特斯拉开始推送 FSD V15 监督版，首批只给早期体验计划（EAP）成员，在美国",
  "- 马斯克说**大规模推送要等到12月**，跟假日更新一起",
  "- 只支持 **HW4** 车型，HW3 的老车升不了",
  "- 官方说安全关键场景的处理能力提升约 **25倍**，新增了实时可视化",
  "",
  "所以，你要是问的是“现在能不能用”，那得看你开的是哪款车、有没有 EAP 名额。",
].join("\n");

const chatStream: PresentationPlan = decideStreamPlan({
  segmentable: true,
  voiceMode: false,
});

function finalPlanFor(text: string, extra: Record<string, unknown> = {}) {
  const rendered = renderTurn({ text, ...extra });
  const meta = rendered.envelope.meta;
  return {
    meta,
    plan: decideFinalPlan({
      stream: chatStream,
      hasBubbles: true,
      utteranceCollapse: false,
      streamResetSent: false,
      sceneSingleBubble: false,
      bodyRewritten: meta.bodyRewritten,
      presentationBlocks:
        meta.forms.length > 0 ||
        meta.blockTypes.some((t) => t !== "text" && t !== "followups"),
    }),
  };
}

test("截图同形态：短列表回复被切成卡 → 收成单条并整段替换流式气泡", () => {
  const { meta, plan } = finalPlanFor(FSD_REPLY, {
    toolName: "web.search",
    userText: "特斯拉FSD15开放了是吧？",
  });
  assert.equal(meta.bodyRewritten, true, "渲染出口必须标记正文被重排");
  assert.ok(meta.blockTypes.includes("card"), "信封里必须有列表卡");
  assert.equal(plan.owner, "single", "信息类回复不得继续分泡");
  assert.equal(plan.replacesStream, true, "必须让客户端删泡、用 finalText 收口");
  assert.equal(plan.reason, "body-rewritten");
});

test("闲聊短句仍按分泡走，不被渲染裁决误伤", () => {
  const { meta, plan } = finalPlanFor("在呢。好的。");
  assert.equal(meta.bodyRewritten, false);
  assert.equal(plan.owner, "bubbles");
  assert.equal(plan.replacesStream, false);
});

test("引用块回复：抽成引用卡后同样收成单条", () => {
  const { meta, plan } = finalPlanFor("> 今天的会议改到下午三点。\n\n收到，我记下了。");
  assert.equal(meta.bodyRewritten, true);
  assert.equal(plan.owner, "single");
  assert.equal(plan.replacesStream, true);
});
