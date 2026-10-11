/**
 * meta_narration 出口闸单测（2026-10-10 P0-2）。
 *
 * 真机实证（马尔代夫规划轮）：模型把注入的任务上下文复述进正文——整段
 * （用户已通过 profile_update 记录固定称呼"王哥"；…前置任务：…本轮主任务：…）
 * 原样流给用户且重复落库两遍。记忆写入侧 ltm-write-gate 早有同款词表闸，
 * 回复出口此前没有（「只建了一半」的闸家族）。修复：reply-style-guard 剥离
 * 元叙述括号段，先于句级手术。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { enforceReplyStyle, detectReplyStyleViolations } from "../src/agent/execution/reply-style-guard.js";

// 真机原文（data/chat-threads.json 马尔代夫轮），含重复出现两遍的完整自述段
const META_BLOCK =
  "（用户已通过 profile_update 记录固定称呼\"王哥\"；本轮用户从多次重复\"搜马尔代夫照片\"切换为正式请求\"规划马尔代夫一周游行程\"。前置任务：马尔代夫搜图+刘浩存照片处理方式均已搁置/被新指令取代。本轮主任务：交付一份马尔代夫一周游规划初稿，包含时间节奏、岛屿选择、玩法、预算、注意事项等。基于已联网检索的 2026 年最新岛屿信息和成本数据，我需要做的是把信息组织成清晰的方案呈现给王哥，并就关键参数（出发时间、出发地、人数/构成、预算档位）向他追问。）";

test("真机原文：整段元叙述被剥离，正文保留（含嵌套括号与重复两遍）", () => {
  const raw = `${META_BLOCK}\n\n好，资料拉到了。王哥这是正经事，我先出方案，参数再问你。\n\n${META_BLOCK}`;
  const result = enforceReplyStyle(raw, "chat");

  assert.ok(result.violations.includes("meta_narration"), `violations=${result.violations}`);
  assert.equal(result.changed, true);
  assert.equal(result.text.includes("profile_update"), false);
  assert.equal(result.text.includes("本轮主任务"), false);
  assert.equal(result.text.includes("前置任务"), false);
  // 正文一个字节不动
  assert.ok(result.text.includes("好，资料拉到了。"));
  assert.ok(result.text.includes("参数再问你。"));
});

test("整段都是元叙述（剥完为空）→ 永不变差回退原文", () => {
  const result = enforceReplyStyle(META_BLOCK, "chat");
  assert.ok(result.violations.includes("meta_narration"));
  assert.equal(result.changed, false);
  assert.equal(result.text, META_BLOCK);
});

test("正常括号注零接触：短括注 / 不含元词的长括注不动刀", () => {
  const replies = [
    "马尔代夫一周游初稿如下，关键参数（出发时间、出发地、人数/构成、预算档位）你定了我就排。",
    "预算分三档（轻松型、标准型、豪华型），每档包含的岛屿数量不同。",
    "浮潜装备（面镜、脚蹼、救生衣）酒店一般免费借。",
  ];
  for (const text of replies) {
    const result = enforceReplyStyle(text, "chat");
    assert.equal(result.changed, false, `误伤正常括号注: ${text} → ${result.violations}`);
    assert.deepEqual(result.violations, []);
  }
});

test("未闭合括号不误判：正文含半个（ 不触发剥离", () => {
  const text = "这事儿吧（我觉得可以再聊，先不急。";
  const result = enforceReplyStyle(text, "chat");
  assert.equal(result.changed, false);
  assert.deepEqual(result.violations, []);
});

test("协议块保真：元叙述剥离后 NEXT_UP 块原样拼回", () => {
  const raw = `${META_BLOCK}\n\n行程初稿我排好了，稍后发你。\n\n[NEXT_UP_START]\n定出发日期\n选预算档位\n[NEXT_UP_END]`;
  const result = enforceReplyStyle(raw, "chat");
  assert.ok(result.violations.includes("meta_narration"));
  assert.equal(result.changed, true);
  assert.ok(result.text.includes("[NEXT_UP_START]"));
  assert.ok(result.text.includes("选预算档位"));
  assert.equal(result.text.includes("本轮主任务"), false);
});

test("复检通道：detectReplyStyleViolations 也能报出 meta_narration", () => {
  const violations = detectReplyStyleViolations(`正常话。${META_BLOCK}`, "chat");
  assert.ok(violations.includes("meta_narration"));
});

test("词表覆盖：路由/优先级/活跃目标等其他注入上下文形态同样被剥离", () => {
  const variants = [
    "（turnIntent=travel_planning routeConfidence=0.72 visibleTools=32）",
    "（该轮次活跃目标：交付行程初稿，优先级=high）",
    "（路由：task lane，预算 spent=0）",
  ];
  for (const meta of variants) {
    const raw = `${meta}\n\n方案来了，你看看。`;
    const result = enforceReplyStyle(raw, "chat");
    assert.ok(
      result.violations.includes("meta_narration"),
      `变体未检出: ${meta} → ${result.violations}`,
    );
    assert.equal(result.changed, true);
    assert.ok(result.text.includes("方案来了，你看看。"));
  }
});
