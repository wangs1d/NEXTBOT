/**
 * 呈现裁决 × 渲染出口 的真实联调回归（2026-11-23 截图事故）。
 *
 * 事故形态：同一条回复上半部分是流式原文气泡，下半部分是 done 重排出的
 * 列表卡——同一段内容渲染两遍。根因是「边收边判要不要开泡」与「整段到了才
 * 判要不要渲染」两个判断碰撞。
 *
 * 现在的架构：chunk 不再外发成泡，整轮结束后用真实 renderTurn 的结果做一次
 * 裁决——信息类收成单条渲染消息，闲聊才在出口拆泡。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { renderTurn } from "../src/render/turn.js";
import {
  decidePresentation,
  splitReplyBubbles,
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

function planFor(text: string, extra: Record<string, unknown> = {}) {
  const rendered = renderTurn({ text, ...extra });
  const meta = rendered.envelope.meta;
  return {
    meta,
    plan: decidePresentation({
      voiceMode: false,
      segmentable: true,
      utteranceCollapse: false,
      sceneSingleBubble: false,
      bodyRewritten: meta.bodyRewritten,
      presentationBlocks:
        meta.forms.length > 0 ||
        meta.blockTypes.some((t) => t !== "text" && t !== "followups"),
    }),
  };
}

test("截图同形态：短列表回复被切成卡 → 整轮单条渲染", () => {
  const { meta, plan } = planFor(FSD_REPLY, {
    toolName: "web.search",
    userText: "特斯拉FSD15开放了是吧？",
  });
  assert.equal(meta.bodyRewritten, true, "渲染出口必须标记正文被重排");
  assert.ok(meta.blockTypes.includes("card"), "信封里必须有列表卡");
  assert.equal(plan.owner, "single", "信息类回复不得分泡");
  assert.equal(plan.reason, "body-rewritten");
});

test("闲聊短句仍分泡，且出口能拆出完整气泡", async () => {
  const { meta, plan } = planFor("在呢。好的。");
  assert.equal(meta.bodyRewritten, false);
  assert.equal(plan.owner, "bubbles");
  const bubbles = await splitReplyBubbles("在呢。好的。");
  assert.ok(bubbles.length >= 1);
  assert.equal(bubbles.join(""), "在呢。好的。");
});

test("引用块回复：抽成引用卡后同样单条渲染", () => {
  const { meta, plan } = planFor("> 今天的会议改到下午三点。\n\n收到，我记下了。");
  assert.equal(meta.bodyRewritten, true);
  assert.equal(plan.owner, "single");
});
