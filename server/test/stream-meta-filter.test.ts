import test from "node:test";
import assert from "node:assert/strict";
import {
  createStreamMetaSentenceFilter,
  stripMetaSentences,
} from "../src/external-model/stream-chat-helpers.js";

test("createStreamMetaSentenceFilter drops sentences that contain multiple meta terms", () => {
  const feed = createStreamMetaSentenceFilter();
  // 流式模拟：分两批喂入，前一句含元术语、后一句正常
  const out1 = feed("上一轮转入规划任务，执行脑已接手处理中。");
  assert.equal(out1, "", "整段元描述句应被丢弃");
  const out2 = feed("好的，那你什么时候出发？");
  assert.equal(out2, "好的，那你什么时候出发？", "正常句子应原样输出");
});

test("createStreamMetaSentenceFilter keeps sentences that incidentally contain a single meta term", () => {
  const feed = createStreamMetaSentenceFilter();
  const out = feed("转交给我来办，机票价格查到了，1200元。");
  assert.equal(
    out,
    "转交给我来办，机票价格查到了，1200元。",
    "仅含 1 个元术语不算元描述整句，应保留",
  );
});

test("createStreamMetaSentenceFilter buffers when sentence has no terminator yet", () => {
  const feed = createStreamMetaSentenceFilter();
  const mid = feed("上一轮转入规划任务，执");
  assert.equal(mid, "", "无句末标点应继续累积，不输出");
  const tail = feed("行脑已接手处理中。");
  assert.equal(tail, "", "整句命中元描述，最终丢弃");
});

test("createStreamMetaSentenceFilter handles mixed normal + meta sentences", () => {
  const feed = createStreamMetaSentenceFilter();
  const out = feed(
    "巴厘岛是印尼比较经典的玩法。" + "上一轮转入规划任务，执行脑已接手处理中。" + "你想哪天出发？",
  );
  assert.equal(
    out,
    "巴厘岛是印尼比较经典的玩法。你想哪天出发？",
    "正常句保留、元描述整句丢弃",
  );
});

// ────────────────────────────────────────────────────────────────────
// 元决策自述（2026-10-11「问时间」4 泡事故）：模型把「该不该调工具」的
// 权衡写进 content，随工具波前导话透出，被分泡器切成 4 条气泡。
// ────────────────────────────────────────────────────────────────────

/** 真机原文（4 泡）：自述 ×3 + 结论 + 加一句。 */
const REAL_CASE =
  "（用户问现在几点，根据规范必须调用 clock.getcurrenttime，禁止臆测。）\n\n" +
  '系统已注入当前时间提示"2026-10-11 周日 03:37 凌晨"，但强制规则要求必须调用工具以拿到本地精确时间和时区/城市。\n\n' +
  "直接调用。王哥，现在是 2026/10/11 周日 凌晨 3:36，贵州兴义这边的时间。\n\n" +
  "这么晚还没睡?";

function assertRealCaseCleaned(text: string, label: string): void {
  assert.equal(/规范|强制规则|系统已注入|必须调用|直接调用/.test(text), false, `${label}：自述段必须全部剥掉`);
  assert.ok(text.includes("王哥，现在是"), `${label}：结论句必须保留`);
  assert.ok(text.includes("这么晚还没睡"), `${label}：末尾正常句必须保留`);
  assert.equal(text.includes("）"), false, `${label}：不得残留孤立闭括号`);
}

test("stripMetaSentences 剥掉真机 4 泡自述，只留结论与正常句", () => {
  assertRealCaseCleaned(stripMetaSentences(REAL_CASE), "整串");
});

test("createStreamMetaSentenceFilter 逐 chunk 喂入同样剥掉自述（流式路径）", () => {
  const feed = createStreamMetaSentenceFilter();
  let out = "";
  for (let i = 0; i < REAL_CASE.length; i += 4) {
    out += feed(REAL_CASE.slice(i, i + 4));
  }
  assertRealCaseCleaned(out, "流式");
});

test("元决策自述：单句单命中即删（不必凑 2 个元术语）", () => {
  assert.equal(stripMetaSentences("根据规范必须调用工具。"), "");
  assert.equal(stripMetaSentences("系统已注入当前时间提示，无需反问。"), "");
  assert.equal(stripMetaSentences("直接调用。"), "");
});

test("误删防护：技术语境的「调用」正文必须保留", () => {
  // 软判据只吃「光秃秃的动作宣告」，带内容的技术句放行
  assert.equal(
    stripMetaSentences("直接调用这个接口就行。"),
    "直接调用这个接口就行。",
  );
  // 硬判据命中「必须调用」但句内有代码语境词（函数）→ 豁免放行
  assert.equal(
    stripMetaSentences("这个函数必须调用两次才能生效。"),
    "这个函数必须调用两次才能生效。",
  );
  assert.equal(
    stripMetaSentences("详见 https://example.com/docs，必须调用 init 初始化。"),
    "详见 https://example.com/docs，必须调用 init 初始化。",
  );
});

test("stripMetaSentences 对无元句的正常回复逐字不变（零接触）", () => {
  const clean = "巴厘岛是印尼比较经典的玩法。你想哪天出发？";
  assert.equal(stripMetaSentences(clean), clean);
  assert.equal(stripMetaSentences("在呢，几点啦？"), "在呢，几点啦？");
});
