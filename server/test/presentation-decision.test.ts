/**
 * 车道 × 渲染出口 的真实联调回归（2026-11-23 截图事故 → 2026-11-25 车道架构）。
 *
 * 旧事故形态：同一条回复上半部分是流式原文气泡，下半部分是 done 重排出的
 * 列表卡——同一段内容渲染两遍。根因是 done 阶段二次裁决呈现权（塌缩重建）。
 *
 * 现在的架构（2026-11-25 车道架构）：车道在 T0 定死，done 不再重判。
 * - 气泡车道走 renderTurn "cards-only"：正文形态不被接管（切卡/引用/折叠/
 *   结构化重排都会改写已流式正文 = 翻案），回执卡照常附加（卡是新内容，
 *   与已流式散文共存是既有交付契约，不是重复渲染）。
 * - 单条车道仍走 "full"：done 一次交付，形态接管全部有效。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { renderTurn } from "../src/render/turn.js";

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

const SEARCH_EFFECTS = [
  {
    tool: "web.search",
    status: "ok",
    result: {
      items: [
        { title: "特斯拉 FSD V15 开始推送", snippet: "首批面向 EAP 成员，美国先行" },
      ],
    },
  },
];

test("气泡车道（cards-only）：正文形态不被接管，列表保持 markdown 原样落泡", () => {
  const rendered = renderTurn(
    {
      text: FSD_REPLY,
      toolName: "web.search",
      userText: "特斯拉FSD15开放了是吧？",
      effects: SEARCH_EFFECTS,
    },
    "cards-only",
  );
  const meta = rendered.envelope.meta;
  assert.equal(meta.bodyRewritten, false, "气泡车道绝不允许 done 翻案（bodyRewritten 恒 false）");
  assert.equal(rendered.text, FSD_REPLY, "正文逐字保持流式原文：不切卡、不折叠、不追加卡标记");
  assert.ok(
    !meta.blockTypes.includes("card"),
    "正文形态转换（列表切卡）属于接管，气泡车道禁止",
  );
});

test("气泡车道：引用块不抽卡，引用随散文按 markdown 原样落泡", () => {
  const text = "> 今天的会议改到下午三点。\n\n收到，我记下了。";
  const rendered = renderTurn({ text }, "cards-only");
  assert.equal(rendered.text, text, "引用块整段保留，不做形态重排");
  assert.equal(rendered.envelope.meta.bodyRewritten, false);
});

test("单条车道（full）：形态接管与 bodyRewritten 标记保持原语义", () => {
  const rendered = renderTurn({
    text: FSD_REPLY,
    toolName: "web.search",
    userText: "特斯拉FSD15开放了是吧？",
    effects: SEARCH_EFFECTS,
  });
  assert.equal(rendered.envelope.meta.bodyRewritten, true, "full 模式保持切卡标记");
  assert.ok(rendered.envelope.meta.blockTypes.includes("card"));
});

test("气泡车道：普通闲聊 prose 原样通过（无形态、无卡）", () => {
  const text = "在呢。刚看你说要早点出门，闹钟帮你往前调了十分钟。";
  const rendered = renderTurn({ text }, "cards-only");
  assert.equal(rendered.text, text);
  assert.equal(rendered.envelope.meta.bodyRewritten, false);
  assert.ok(!rendered.envelope.meta.blockTypes.includes("card"));
});
