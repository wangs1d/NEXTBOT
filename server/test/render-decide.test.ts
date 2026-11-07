/**
 * 渲染决策层验收：形态在正确上下文触发，且不泄漏裸 JSON。
 *
 * 锁定 decideRender 的三条硬规则：
 *   R1 业务卡只从真实回执产出（失败不出卡：空态警示卡 2026-11-06 整体退役）；
 *   R2 fold 只在没有结构化卡且主题判得出来时出现；
 *   R3 结构化面在场时正文只是前导，任何块都和它的路由声明成对出现。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { decideRender } from "../src/render/decide.js";
import { applyBodyForm } from "../src/render/body.js";
import { applyCards, collectCardPayloads } from "../src/render/cards.js";
import { getToolResultProcessor } from "../src/services/tool-result-processor.js";
import type { RenderInput } from "../src/render/types.js";

/** 把协议块与路由声明剥掉，只剩用户在气泡里真正看到的文字。 */
function visibleText(marked: string): string {
  let out = marked;
  const blocks = [
    /\[AGENT_RESULT_CARD_START\]\s*[\s\S]*?\s*\[AGENT_RESULT_CARD_END\]/g,
    /\[CONTENT_SUMMARY_V2_START\]\s*[\s\S]*?\s*\[CONTENT_SUMMARY_V2_END\]/g,
    /\[DATA_BRIEF_START\][\s\S]*?\[DATA_BRIEF_END\]/g,
    /\[IMAGE_RESULT_START\][\s\S]*?\[IMAGE_RESULT_END\]/g,
    /\[VIDEO_MEDIA_START\][\s\S]*?\[VIDEO_MEDIA_END\]/g,
    /\[CHAT_MEDIA_START\][\s\S]*?\[CHAT_MEDIA_END\]/g,
    /\[NEXT_UP_START\][\s\S]*?\[NEXT_UP_END\]/g,
  ];
  for (const re of blocks) out = out.replace(re, "");
  return out
    .replace(/\[RENDER_AS:[a-z_]+\]\n?/g, "")
    .replace(/\[RENDER_HINT:[a-z_]+\]\n?/g, "")
    .replace(/<details_card[^>]*\/>/g, "")
    .trim();
}

function assertNoBareJson(marked: string, label: string): void {
  const visible = visibleText(marked);
  assert.ok(!/\{[\s\S]*?"[a-zA-Z]+"\s*:/.test(visible), `${label}：可见正文出现裸 JSON：${visible.slice(0, 200)}`);
  assert.ok(!/\[(?:AGENT_RESULT_CARD|CONTENT_SUMMARY_V2|DATA_BRIEF|IMAGE_RESULT|VIDEO_MEDIA)_(?:START|END)\]/.test(visible), `${label}：可见正文残留未成对的块标记`);
}

/** 跑一次完整出口（正文形态 + 卡），与 processAssistantText 内部同序。 */
function renderOut(input: RenderInput, opts?: { userText?: string; toolName?: string }): string {
  const decision = decideRender(input);
  const body = applyBodyForm(input.text, decision, opts);
  return applyCards(body, decision).text;
}

function process(text: string, opts?: Parameters<ReturnType<typeof getToolResultProcessor>["processAssistantText"]>[1]): string {
  return getToolResultProcessor().processAssistantText(text, opts);
}

// ─────────────────────────────────────────────────────────────────────────────
// R1：业务卡只从真实回执产出
// ─────────────────────────────────────────────────────────────────────────────

test("天气上下文：weather.get_local 真实回执 → weather 卡，正文只作前导", () => {
  const out = process("明天有雨，出门带伞。", {
    toolName: "weather.get_local",
    toolResult: {
      ok: true,
      summary: "明天中雨",
      weatherText: "中雨",
      todayRangeC: "18–24",
      humidityPct: 88,
      windKmh: 12,
      peakRainPct: 70,
      todayRainPeriod: "下午两点到五点",
      locationLabel: "上海",
      clothingAdvice: "带伞，穿防水外套",
    },
  });
  const cards = collectCardPayloads(out);
  assert.equal(cards.length, 1, `应只出 1 张卡：${out.slice(0, 300)}`);
  assert.equal(cards[0].cardType, "weather");
  const items = cards[0].items as Array<{ text: string }>;
  assert.ok(items.some((i) => i.text.includes("中雨")), "卡内应有天气实况");
  assert.ok(
    items.some((i) => i.text.includes("下午两点到五点")),
    `降水概率应落到钟点段，实际条目：${items.map((i) => i.text).join(" / ")}`,
  );
  assert.ok(out.startsWith("明天有雨，出门带伞。"), "正文前导保留");
  assert.ok(!out.includes("[CONTENT_SUMMARY_V2_START]"), "有天气卡时不应再折叠正文");
  assertNoBareJson(out, "weather");
});

test("没有工具回执的散文：不出任何业务卡", () => {
  const out = process("今天风挺大的，出门记得把外套扣好，别着凉。", { userText: "今天天气怎么样" });
  assert.ok(!out.includes("[AGENT_RESULT_CARD_START]"), `无回执不应出卡：${out.slice(0, 200)}`);
  assertNoBareJson(out, "prose");
});

test("失败空态警示卡整体退役：任何工具失败都不出卡，失败说明由正文承担", () => {
  for (const tool of [
    "shopping.order.place",
    "shopping.compare.prices",
    "shopping.recommend",
    "weather.get_local",
  ]) {
    const decision = decideRender({
      text: "这次没成。",
      effects: [{ tool, status: "error" }],
    });
    assert.equal(
      decision.cards.length,
      0,
      `${tool} 失败不应出任何卡（空态卡 2026-11-06 整体退役）`,
    );
    const out = applyCards(applyBodyForm("这次没成。", decision), decision).text;
    assert.ok(!out.includes("[AGENT_RESULT_CARD_START]"), `${tool} 失败不应落卡块`);
  }
});

test("媒体与搜索同时在场：只出媒体主形态，不再叠一张文字搜索卡", () => {
  const decision = decideRender({
    text: "照片都找出来了。",
    mediaCardCount: 3,
    effects: [
      { tool: "search_images", status: "ok", result: { images: [{ url: "https://e.com/a.jpg" }] } },
      { tool: "search_web", status: "ok", result: { items: [{ title: "t", url: "https://e.com/p" }] } },
    ],
  });
  const topics = decision.cards.map((c) => c.topic);
  assert.deepEqual(topics, ["media"], `应只留媒体主形态，实际：${topics.join(",")}`);
  assert.equal(decision.body.form, "plain", "有结构化面时正文只作前导");
});

// ─────────────────────────────────────────────────────────────────────────────
// R2：fold 只在无卡且主题判得出来时出现
// ─────────────────────────────────────────────────────────────────────────────

const LONG_DOC = [
  "## 饮食",
  "每天保证一斤蔬菜、半斤水果，主食里加一点粗粮。蛋白质优先选鱼虾和豆制品，红肉控制在每周三次以内。晚饭尽量在七点前吃完，睡前三小时不要再进食，晚上饿了可以喝一杯温牛奶，但不要吃甜食，避免血糖波动影响睡眠质量。",
  "## 运动",
  "每周至少完成三次有氧，每次三十分钟以上，快走和游泳都可以。力量训练每周两次，重点放在下肢和核心，避免连续两天练同一部位。运动前要充分热身，运动后做十分钟的拉伸，这样既能减少受伤概率，也能缓解第二天的肌肉酸痛。",
  "## 睡眠",
  "固定作息时间，周末补觉不要超过一小时。睡前一小时远离手机，卧室温度保持在二十度左右更容易入睡。如果躺下二十分钟还没有睡意，可以起来看一会儿纸质书，等有困意再回到床上，不要在床上刷手机。",
  "## 复查",
  "每半年做一次体检，重点关注血脂和尿酸指标，如果有异常遵医嘱增加复查频率。体检前三天保持平时的饮食习惯，不要刻意清淡，也不要饮酒，这样结果才更接近真实水平。",
  "## 心态",
  "压力大的时候先做几次深呼吸，把注意力放回当下。可以每周给自己安排一段完全放空的缓冲时间，散散步、听听音乐都可以，长期紧绷的状态对血糖和血压都不友好。",
  "## 饮水",
  "每天把饮水量稳定在一千五百毫升到两千毫升之间，早上起床先喝一杯温水，白天分次小口喝，不要等口渴了才补。咖啡和浓茶尽量放在上午，下午换成淡茶或白水，这样夜里的睡眠不会被利尿作用打断。运动出汗多的时候，可以在水里加一点点盐，或者喝无糖的电解质水，别用含糖饮料代替。",
  "## 用眼",
  "看屏幕每四十分钟就抬头看远处两分钟，让睫状肌真正放松下来。室内光线要均匀，不要让台灯直接照在屏幕上产生反光。眼睛干涩的时候，先眨眼湿润，再用人工泪液，不要长期依赖清凉型眼药水。晚上关灯后尽量不看手机，实在要看就把亮度调到最低，并且开启护眼模式。每用眼一小时，可以用温热的毛巾敷一敷眼睛，促进睑板腺分泌，缓解干涩和酸胀。如果长时间对着屏幕夜里总觉得眼睛发胀，可以适当把字体调大一点，减少眼睛的调节负担。",
].join("\n");

test("长结构化文档 + 主题可判 → 折叠摘要卡", () => {
  const decision = decideRender({ text: LONG_DOC, userText: "帮我整理这份健康指南" });
  assert.equal(decision.body.form, "fold");
  assert.equal(decision.body.subject, "健康资讯");
  const out = renderOut({ text: LONG_DOC, userText: "帮我整理这份健康指南" });
  assert.ok(out.includes("[CONTENT_SUMMARY_V2_START]"));
  assertNoBareJson(out, "fold");
});

// 无场景关键词的中性长文：主题表判不出来，就只能给富文本，不能挂类目名硬折叠
const NEUTRAL_DOC = Array.from(
  { length: 12 },
  (_, i) =>
    `## 第${i + 1}部分 标题\n这一段是正文内容，展开讲一些细节，用来把整体篇幅撑过折叠门槛。行文尽量自然，包含具体的例子与说明，前后也做了必要的铺垫和收尾，方便读者顺着读下来。`,
).join("\n");

test("长结构化文档 + 主题判不出来 → 富文本正文，不挂类目名折叠卡", () => {
  const decision = decideRender({ text: NEUTRAL_DOC, userText: "帮我整理一下" });
  assert.notEqual(decision.body.form, "fold", "主题判不出来时不应折叠");
  const out = renderOut({ text: NEUTRAL_DOC, userText: "帮我整理一下" });
  assert.ok(!out.includes("[CONTENT_SUMMARY_V2_START]"));
  assertNoBareJson(out, "subject-less");
});

test("有业务卡的轮次：正文不进 fold（卡与折叠卡互相盖住）", () => {
  const decision = decideRender({
    text: LONG_DOC,
    userText: "帮我整理这份健康指南",
    effects: [{ tool: "weather.get_local", status: "ok", result: { weatherText: "晴", todayRangeC: "18–24" } }],
  });
  assert.equal(decision.body.form, "plain");
});

// ─────────────────────────────────────────────────────────────────────────────
// R3：任何形态都不泄漏裸 JSON
// ─────────────────────────────────────────────────────────────────────────────

test("各形态出口：块与路由声明成对出现，可见正文无 JSON", () => {
  const cases: Array<{ name: string; out: string }> = [
    {
      name: "weather",
      out: process("带伞。", {
        toolName: "weather.get_local",
        toolResult: { weatherText: "中雨", todayRangeC: "18–24", peakRainPct: 70, locationLabel: "上海" },
      }),
    },
    {
      name: "search（不出卡，正文原样）",
      out: process("翻了三篇。", {
        toolName: "search_web",
        toolResult: { items: [{ title: "攻略", url: "https://e.com/1", snippet: "s" }] },
      }),
    },
    {
      name: "KPI 数字密集正文（data_brief 已退役，不出卡）",
      out: process("今天A股收盘，创业板指报 2876.54 点（+2.01%），两市全天成交额 1.2万亿，北向资金净流入 85.6亿。", {
        userText: "今天行情怎么样",
      }),
    },
    {
      name: "fold",
      out: renderOut({ text: LONG_DOC, userText: "帮我整理这份健康指南" }, { userText: "帮我整理这份健康指南" }),
    },
    {
      name: "markdown",
      out: renderOut({ text: NEUTRAL_DOC, userText: "帮我整理一下" }, { userText: "帮我整理一下" }),
    },
    {
      name: "quote",
      out: process("这本书里有句话特别好：\n> 种一棵树最好的时间是十年前，其次是现在。\n给你", {
        userText: "有什么好书摘推荐",
      }),
    },
  ];
  for (const c of cases) {
    assert.ok(c.out.length > 0, `${c.name}：出口不应为空`);
    assertNoBareJson(c.out, c.name);
  }
});
