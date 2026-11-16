/// 行程轮 lead text 确定性收口（2026-11-12 用户定稿「简短介绍就行」）。
///
/// 背景：行程卡前的散文简介此前只有 prompt 软约束，模型超发时用户在
/// 行程卡前收到一整段长文（真机实测）。clampTravelLeadText 在卡片版式
/// 归一化之后做确定性截断：带卡回复的散文只留前两句（≤120 字），卡片块
/// 原样保留、相对顺序不变；无卡文本原样返回（漏卡态内容不被截丢）。
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  clampTravelLeadText,
} from "../src/services/deterministic-card-chain.js";

const CARD_A =
  '[AGENT_RESULT_CARD_START]\n{"cardType":"travel_guide_select","title":"必玩候选"}\n[AGENT_RESULT_CARD_END]';
const CARD_ITINERARY =
  '[AGENT_RESULT_CARD_START]\n{"cardType":"travel_itinerary","title":"成都 4 日"}\n[AGENT_RESULT_CARD_END]';

test("无卡文本原样返回（漏卡态内容不被截丢）", () => {
  const long = "这是一段没有任何卡片的长文。".repeat(40);
  assert.equal(clampTravelLeadText(long), long);
  assert.equal(clampTravelLeadText(""), "");
});

test("短散文（≤120 字）不动", () => {
  const text = `成，行程排好了。\n\n${CARD_ITINERARY}`;
  assert.equal(clampTravelLeadText(text), text);
});

test("长散文收口为前两句，卡片原样保留", () => {
  const prose =
    "好的，我已经把你的成都之行完整排出来了。整体按人少慢游的节奏走，避开了热门 TOP3 景点。" +
    "第一天落地之后先去酒店放行李，下午逛宽窄巷子感受市井气息，晚上吃一顿地道的火锅。" +
    "第二天的重点是熊猫基地，记得早去。后面的行程把青城山和市井美食动线串了起来。" +
    "逐站的门票、开放时间和动线都核实过一遍，预算也按两人口径算好了。";
  const text = `${prose}\n\n${CARD_ITINERARY}`;
  const out = clampTravelLeadText(text);
  assert.ok(out.includes(CARD_ITINERARY), "行程卡必须原样保留");
  assert.ok(!out.includes("青城山"), "第三句起的内容应被收口掉");
  const proseOut = out.replace(
    /\[AGENT_RESULT_CARD_START\][\s\S]*?\[AGENT_RESULT_CARD_END\]/g,
    "",
  ).trim();
  assert.ok(proseOut.length <= 120, `收口后散文应 ≤120 字，实际 ${proseOut.length}`);
  assert.match(proseOut, /[。！？!?]$/, "收口尾应是完整句读或省略号");
});

test("多段散文只留第一段（收口版），其余丢弃", () => {
  const text = [
    "好的，我已经把你的成都之行完整排出来了，整体按人少慢游的节奏走，避开了热门 TOP3 景点，逐站动线都核实过一遍。" +
      "第一天落地先放行李，下午逛宽窄巷子，晚上吃一顿地道火锅，第二天的重点是熊猫基地，记得赶早。",
    CARD_A,
    "中间又插了一段补充说明，也写得很长很长很长，同样应该被收口掉才对，这里再补一些字数凑足阈值。",
    CARD_ITINERARY,
  ].join("\n\n");
  const out = clampTravelLeadText(text);
  assert.ok(out.includes(CARD_A));
  assert.ok(out.includes(CARD_ITINERARY));
  assert.ok(!out.includes("中间又插了一段"), "后续散文段应丢弃");
  const proseCount = out
    .split(/\[AGENT_RESULT_CARD_START\][\s\S]*?\[AGENT_RESULT_CARD_END\]/)
    .filter((s) => s.trim().length > 0).length;
  assert.equal(proseCount, 1, "只应剩一段散文");
});

test("卡片相对顺序保持不变", () => {
  const text = ["很长的开场白，啰啰嗦嗦一大段，超过了收口阈值的长度限制要求。", CARD_A, "又一长段。".repeat(30), CARD_ITINERARY].join("\n\n");
  const out = clampTravelLeadText(text);
  assert.ok(out.indexOf(CARD_A) < out.indexOf(CARD_ITINERARY));
});

test("散文全部为空白（只有卡）原样返回", () => {
  const text = `${CARD_A}\n\n${CARD_ITINERARY}`;
  assert.equal(clampTravelLeadText(text), text);
});
