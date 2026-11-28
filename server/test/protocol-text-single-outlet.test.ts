/**
 * 协议文本不得透出到可见正文（2026-11-26 事故根修）。
 *
 * 事故：充分性探测轮模型没按指令把 NEED_MORE_TOOLS 落在首行，而是先写了一句
 * 工具旁白——「先补查询：web_search quote XAUUSD、web_search quote XAGUSD。」
 * 汇总通道既没走波内净化链、又把原始 accumulation 当定稿，标记与旁白原样进了
 * 气泡和落库正文。
 *
 * 锁定契约：
 *   1. 裸控制 token 的名单只有一处；整串与流式（含跨 chunk 半截）删的结果逐字一致。
 *   2. 工具调用旁白按**形态**判（小写 ASCII 标识符 + 动作线索），带数据的句子不误删。
 *   3. createStreamTextPurifier 是所有通道共用的唯一出口：feed 拼接 + flush = 放出文本，
 *      正常正文（含 markdown 表格、方括号文案）一个字节不少。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  NEED_MORE_TOOLS_MARKER,
  createStreamProtocolTokenScrubber,
  createStreamTextPurifier,
  stripInternalControlTags,
  stripInternalProtocolTokens,
  stripMetaSentences,
  type StreamTextTransform,
} from "../src/external-model/stream-chat-helpers.js";

const LEAKED_HEAD =
  "先补查询：web_search quote XAUUSD、web_search quote XAGUSD。\n" + NEED_MORE_TOOLS_MARKER;

function slice(text: string, size: number): string[] {
  return text.match(new RegExp(`[\\s\\S]{1,${size}}`, "g")) ?? [];
}

/** 全量喂完再 flush，返回放出的文本（= 用户看到的那一份）。 */
function runThrough(t: StreamTextTransform, text: string, size: number): string {
  let out = "";
  for (const c of slice(text, size)) out += t(c);
  return out + t.flush();
}

/* ── 1. 裸控制 token ───────────────────────────────────────────────────── */

test("整串：独占行的标记连行删净，行内标记连同空括号删掉", () => {
  assert.equal(
    stripInternalProtocolTokens(`好的，我再看一眼。\n${NEED_MORE_TOOLS_MARKER}\n`),
    "好的，我再看一眼。\n",
  );
  assert.equal(
    stripInternalProtocolTokens(`先看（${NEED_MORE_TOOLS_MARKER}）这里。`),
    "先看这里。",
  );
  assert.equal(stripInternalProtocolTokens(NEED_MORE_TOOLS_MARKER), "");
});

test("整串：不误删正常正文（前缀形态、含大写的行情文本原样保留）", () => {
  const normal = "黄金 NEED_MORE 不是标记；XAUUSD 现价 3985 美元。";
  assert.equal(stripInternalProtocolTokens(normal), normal);
  // 控制标签整串链同样带上 token 剥离（fallback 走的是这条）
  assert.equal(stripInternalControlTags(`正文。\n${NEED_MORE_TOOLS_MARKER}`), "正文。\n");
});

for (const size of [1, 2, 3, 7, 40]) {
  test(`流式：标记任意切片都不透出（chunk=${size}）`, () => {
    const scrub = createStreamProtocolTokenScrubber();
    // 本层只删协议文本，旁白句归元话语过滤器（见下面的唯一出口用例）
    assert.equal(
      runThrough(scrub, LEAKED_HEAD, size),
      "先补查询：web_search quote XAUUSD、web_search quote XAGUSD。\n",
      `chunk=${size}`,
    );
    // 标记夹在正文中间（既不是首行也不是独占行）：标记删净、正文字符一个不少。
    // 切片边界会让标记两侧的空格各留一份（协议文本实际是独占一行的形态），
    // 所以断言按「去空白后逐字相等 + 折叠空格后逐字相等」两条来卡。
    const scrub2 = createStreamProtocolTokenScrubber();
    const inline = runThrough(scrub2, `现价 ${NEED_MORE_TOOLS_MARKER} 我再看`, size);
    assert.equal(inline.replace(/\s+/g, ""), "现价我再看", `chunk=${size} 正文丢失`);
    assert.equal(inline.replace(/[ \t]{2,}/g, " "), "现价 我再看", `chunk=${size}`);
  });
}

test("流式：正常正文逐字不少，flush 不重放", () => {
  const prose = "黄金这波走得稳，XAUUSD 现价 3985.6 美元，环比 +1.2%。\n建议观望。";
  for (const size of [1, 3, 7, 40]) {
    const scrub = createStreamProtocolTokenScrubber();
    assert.equal(runThrough(scrub, prose, size), prose, `chunk=${size}`);
  }
  const once = createStreamProtocolTokenScrubber();
  assert.equal(once("一句话就完了。"), "一句话就完了。");
  assert.equal(once.flush(), "", "直通后 flush 不得重发");
});

/* ── 2. 工具调用旁白 ───────────────────────────────────────────────────── */

test("旁白整句删：标识符 + 动作线索（名字写错也拦得住）", () => {
  assert.equal(
    stripMetaSentences("先补查询：web_search quote XAUUSD、web_search quote XAGUSD。").trim(),
    "",
    "registry 里是 search_web，模型写成 web_search 也要拦（判据是形态不是名单）",
  );
  assert.equal(stripMetaSentences("我先调用 market.quote 拿一下报价。").trim(), "");
  assert.equal(stripMetaSentences("换个关键词再查一次 search_web。").trim(), "");
});

test("旁白判据不误删带数据的正文", () => {
  const keep = [
    "黄金 XAUUSD 现价 3985 美元，web_search 的结果里最高 3992。",
    "我用 search_web 查询到的最新数据是 3985.6 美元，环比上涨 1.2%。",
    "配置项写在 config.chat_threads.json 里，改完重启生效。",
    "详见 https://example.com/a/b 这份说明。",
  ];
  for (const line of keep) {
    assert.equal(stripMetaSentences(line), line, `不该删：${line}`);
  }
});

/* ── 3. 唯一出口 ───────────────────────────────────────────────────────── */

test("唯一出口：探测轮旁白 + 标记全拦下，只留真实正文", () => {
  const answer = "先看眼黄金：现价 3985.6 美元，日内 +1.2%。";
  for (const size of [1, 3, 7, 40]) {
    const purified = runThrough(createStreamTextPurifier(), `${LEAKED_HEAD}\n${answer}`, size);
    assert.ok(!purified.includes(NEED_MORE_TOOLS_MARKER), `chunk=${size} 标记透出`);
    assert.ok(!purified.includes("web_search"), `chunk=${size} 旁白透出`);
    assert.equal(purified.trim(), answer, `chunk=${size} 正文被吃掉了`);
  }
});

test("唯一出口：控制标签 + 内部帧 + 标记混排，只留正文", () => {
  const raw =
    "[话题切换，只答这个]\n<system>\n[trajectory-slicing]\n说明行。\n</system>\n" +
    "兴义明天小雨，16~22℃，带把伞。\n" +
    NEED_MORE_TOOLS_MARKER;
  for (const size of [1, 5, 40]) {
    const purified = runThrough(createStreamTextPurifier(), raw, size);
    assert.equal(purified.trim(), "兴义明天小雨，16~22℃，带把伞。", `chunk=${size}`);
  }
});

test("唯一出口：markdown 表格与清单逐字不少（净化不得碰结构）", () => {
  const table =
    "行情如下：\n\n| 品种 | 现价 | 涨跌 |\n| --- | --- | --- |\n| XAUUSD | 3985.6 | +1.2% |\n\n建议观望。";
  for (const size of [1, 3, 7, 40]) {
    assert.equal(
      runThrough(createStreamTextPurifier(), table, size),
      table,
      `chunk=${size} 表格被净化链改动`,
    );
  }
});

test("唯一出口：feed 累计即定稿，flush 之后不再有任何补充", () => {
  const text = "已查到 3 家火锅店：[评分 4.8] 黔味老灶、[人均 ¥78] 巷子口。";
  const purifier = createStreamTextPurifier();
  let streamed = "";
  for (const c of slice(text, 4)) streamed += purifier(c);
  streamed += purifier.flush();
  assert.equal(streamed, text);
  assert.equal(purifier.flush(), "", "二次 flush 必须为空（否则 done 会补出重复段）");
});
