import test from "node:test";
import assert from "node:assert/strict";

import { createStreamMarkerGuard } from "../src/utils/stream-marker-guard.js";

/**
 * 流式标记防泄漏 guard 单测：L2 激活后模型会在正文输出展示形式标记，
 * 流式 chunk 出口必须保证标记/卡片 JSON 不闪现在用户打字机气泡上。
 */

test("整行 RENDER_HINT 标记被扣下，不透出", () => {
  const g = createStreamMarkerGuard();
  const out = g.feed("[RENDER_HINT:structured]\n## 标题\n正文内容。");
  assert.ok(!out.includes("RENDER_HINT"));
  assert.ok(out.includes("## 标题"));
  assert.ok(out.includes("正文内容。"));
});

test("跨 chunk 断裂的标记行被扣住，补全后仍不透出", () => {
  const g = createStreamMarkerGuard();
  const a = g.feed("好的，安排如下：\n[RENDER_HI");
  const b = g.feed("NT:structured]\n第一步先备份。");
  assert.ok(!a.includes("[RENDER_HI"), `chunk1 泄漏：${a}`);
  assert.ok(!b.includes("RENDER_HINT"), `chunk2 泄漏：${b}`);
  assert.ok(b.includes("第一步先备份。"));
});

test("卡片 JSON 块整体丢弃（含跨 chunk 断裂）", () => {
  const g = createStreamMarkerGuard();
  const a = g.feed("结论在卡片里：\n[AGENT_RESULT_CARD_START]\n{\"cardType\":\"steps\",");
  const b = g.feed("\"title\":\"步骤\",\"items\":[{\"type\":\"num\",\"text\":\"1\"}]}\n[AGENT_RESULT_CARD_END]\n\n需要调整吗？");
  const c = g.flush();
  const all = a + b + c;
  assert.ok(!all.includes("cardType"), `泄漏卡片 JSON：${all}`);
  assert.ok(!all.includes("AGENT_RESULT_CARD"), `泄漏标记：${all}`);
  assert.ok(all.includes("结论在卡片里"));
  assert.ok(all.includes("需要调整吗？"));
});

test("未闭合的卡片块在流结束时全部丢弃", () => {
  const g = createStreamMarkerGuard();
  const a = g.feed("看卡：\n[AGENT_RESULT_CARD_START]\n{\"broken\": tru");
  const rest = g.flush();
  const all = a + rest;
  assert.ok(!all.includes("broken"), `半截 JSON 泄漏：${all}`);
  assert.ok(!all.includes("AGENT_RESULT_CARD_START"));
});

test("普通方括号文本不被误杀", () => {
  const g = createStreamMarkerGuard();
  const out = g.feed("参考 [1] 和 [2] 的说明，另见[链接](https://example.com)。\n完");
  const rest = g.flush();
  const all = out + rest;
  assert.ok(all.includes("参考 [1] 和 [2] 的说明"));
  assert.ok(all.includes("另见[链接](https://example.com)。"));
});

test("行内嵌标记 token 被剥离，正文保留", () => {
  const g = createStreamMarkerGuard();
  const out = g.feed("开头 [RENDER_HINT:brief] 这是正文。");
  const rest = g.flush();
  const all = out + rest;
  assert.ok(!all.includes("RENDER_HINT"), `行内标记泄漏：${all}`);
  assert.ok(all.includes("开头"));
  assert.ok(all.includes("这是正文。"));
});

test("纯正常流式文本零损失", () => {
  const g = createStreamMarkerGuard();
  const chunks = ["你", "好呀", "，今天天气", "不错。\n", "适合出门。"];
  let all = "";
  for (const c of chunks) all += g.feed(c);
  all += g.flush();
  assert.equal(all.replace(/\n/g, ""), "你好呀，今天天气不错。适合出门。");
});

test("NEXT_UP 事故回归：START 与正文同行时不泄漏块内建议（2026-09-22 睡前提醒）", () => {
  const g = createStreamMarkerGuard();
  const full =
    "说好了，01:00 准时喊你——还有八分钟，够你把手头这点事收个尾。到点我会直接叫你『该睡觉啦』，别装没听见。[NEXT_UP_START]\n" +
    "提前五分钟再提醒一次\n" +
    "明早八点叫我起床\n" +
    "[NEXT_UP_END]";
  // 按真实流式节奏切成小 chunk
  let all = "";
  for (let i = 0; i < full.length; i += 7) all += g.feed(full.slice(i, i + 7));
  all += g.flush();
  assert.ok(all.includes("别装没听见。"), `正文丢失：${all}`);
  assert.ok(!all.includes("提前五分钟再提醒一次"), `建议条目泄漏：${all}`);
  assert.ok(!all.includes("明早八点叫我起床"), `建议条目泄漏：${all}`);
  assert.ok(!all.includes("NEXT_UP"), `标记泄漏：${all}`);
});

test("NEXT_UP 单行完整块（START/END 同行）只留块外文本", () => {
  const g = createStreamMarkerGuard();
  const out = g.feed("正文甲[NEXT_UP_START]条目一\n条目二[NEXT_UP_END]正文乙");
  const rest = g.flush();
  const all = out + rest;
  assert.ok(!all.includes("条目一") && !all.includes("条目二"), `块内泄漏：${all}`);
  assert.ok(all.includes("正文甲"));
  assert.ok(all.includes("正文乙"));
});

test("NEXT_UP 协议块（标记独占一行）照旧整体扣下", () => {
  const g = createStreamMarkerGuard();
  const out = g.feed("正文。\n[NEXT_UP_START]\n条目一\n条目二\n[NEXT_UP_END]");
  const rest = g.flush();
  const all = out + rest;
  assert.ok(!all.includes("条目一") && !all.includes("条目二"), `块内泄漏：${all}`);
  assert.ok(all.includes("正文。"));
});

test("NEXT_UP 行内 END 后的正文照发（与 extraction 的 replace 语义一致）", () => {
  const g = createStreamMarkerGuard();
  const out = g.feed("[NEXT_UP_START]\n条目一[NEXT_UP_END]收尾一句。");
  const rest = g.flush();
  const all = out + rest;
  assert.ok(!all.includes("条目一"), `块内泄漏：${all}`);
  assert.ok(all.includes("收尾一句。"));
});

// ───────────────────────────────────────────────────────────────────────────
// sawStructuredBlock：「会出卡片的轮次不流式」的扣流信号（2026-10-08）
// ───────────────────────────────────────────────────────────────────────────

test("sawStructuredBlock：卡片块出现即置位（含未闭合块）", () => {
  const g = createStreamMarkerGuard();
  assert.equal(g.sawStructuredBlock, false);
  g.feed("结论在卡里：\n[AGENT_RESULT_CARD_START]\n{\"title\":\"x\"}");
  assert.equal(g.sawStructuredBlock, true);
});

test("sawStructuredBlock：行内嵌结构化标记也置位", () => {
  const g = createStreamMarkerGuard();
  g.feed("前文 [DATA_BRIEF_START] {...} [DATA_BRIEF_END] 后文");
  assert.equal(g.sawStructuredBlock, true);
});

test("sawStructuredBlock：RENDER_HINT/NEXT_UP 不算结构化产出（不触发扣流）", () => {
  const g = createStreamMarkerGuard();
  g.feed("[RENDER_HINT:structured]\n建议如下[NEXT_UP_START]查天气[NEXT_UP_END]完。");
  assert.equal(g.sawStructuredBlock, false);
});

// ── 2026-10-11 变体声明（模型把格式写歪：括号在冒号前闭合）──────────────

test("变体声明 [RENDER_HINT]:brief 行内嵌时被剥离，正文照发", () => {
  const g = createStreamMarkerGuard();
  const out = g.feed("马上帮你搜～[RENDER_HINT]:brief\n");
  assert.equal(out, "马上帮你搜～\n");
});

test("变体声明 [RENDER_AS]:brief 独占一行被整行扣下", () => {
  const g = createStreamMarkerGuard();
  const out = g.feed("前文。\n[RENDER_AS]:brief\n后文。");
  assert.equal(out, "前文。\n后文。");
});

test("变体声明跨 chunk（残段扣留后补全）同样剥离", () => {
  const g = createStreamMarkerGuard();
  const a = g.feed("开头。[RENDER_AS");
  const b = g.feed("]:brief\n正文继续。");
  assert.equal(`${a}${b}`.replace(/\n+/g, "\n"), "开头。\n正文继续。");
});

test("普通方括号文本（非标记变体）不受影响", () => {
  const g = createStreamMarkerGuard();
  const out = g.feed("参见 [附录A] 与 [注1]:内容\n");
  assert.equal(out, "参见 [附录A] 与 [注1]:内容\n");
});

// ── 2026-10-24 漏下划线变体（真机截图：[NEXT_UPSTART] 整块漏进气泡）────────

test("漏下划线变体 [NEXT_UPSTART]…[NEXT_UPEND] 整块扣下，不出流", () => {
  const g = createStreamMarkerGuard();
  const out = g.feed("日期你定。\n[NEXT_UPSTART]\n按两个人重算预算\n把行程改成3天\n[NEXT_UPEND]\n");
  assert.equal(out, "日期你定。\n");
});

test("漏下划线变体行内嵌：START 前正文照发，块内容扣下", () => {
  const g = createStreamMarkerGuard();
  const out = g.feed("先给结论。[NEXT_UPSTART]改3天[NEXT_UPEND]\n");
  assert.equal(out, "先给结论。\n");
});

test("漏下划线变体单行完整块：块外两段拼接", () => {
  const g = createStreamMarkerGuard();
  const out = g.feed("前文[NEXT_UPSTART]建议[NEXT_UPEND]后文\n");
  assert.equal(out, "前文后文\n");
});
