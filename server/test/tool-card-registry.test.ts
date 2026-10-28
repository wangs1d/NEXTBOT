/**
 * tool-card-registry 单元测试：结构异常/空数据/已含标记时的确定性回退。
 * 端到端行为（LLM 纯叙述 + toolResult → 直出卡）由 reply-format-golden 覆盖。
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildToolCard,
  tryAttachToolResultCard,
  attachWeatherResultCardFromExecuted,
} from "../src/services/tool-card-registry.js";

test("weather: full fields → weather card payload", () => {
  const p = buildToolCard("weather.get_local", {
    summary: "明天晴转多云",
    weatherText: "晴转多云",
    todayRangeC: "18–26",
    humidityPct: 62,
    windKmh: 8,
    peakRainPct: 10,
    clothingAdvice: "带薄外套",
    locationLabel: "上海",
  });
  assert.ok(p);
  assert.equal(p.cardType, "weather");
  assert.equal(p.title, "明天晴转多云");
  assert.equal(p.items.length, 5);
  assert.equal(p.footer, "带薄外套");
});

test("weather: missing weather fields → null（回退文本路由）", () => {
  assert.equal(buildToolCard("weather.get_local", { ok: true }), null);
  assert.equal(buildToolCard("weather.get_local", { weatherText: "" }), null);
});

test("wallet: balance → wallet card；缺余额 → null", () => {
  const p = buildToolCard("wallet.get_balance", { balance: 1000, currency: "CNY" });
  assert.ok(p);
  assert.equal(p.cardType, "wallet");
  assert.equal(p.items[0]?.text, "1000 CNY");
  assert.equal(buildToolCard("wallet.get_balance", { balance: "很多" }), null);
});

test("calendar: tasks → schedule card，时间截取格式化（跨时区稳定）", () => {
  const p = buildToolCard("calendar.list_tasks", {
    count: 2,
    tasks: [
      { title: "牙医复诊", nextRunAt: "2026-09-10T09:30:00" },
      { title: "给妈妈打电话", nextRunAt: "2026-09-11T20:00:00" },
    ],
  });
  assert.ok(p);
  assert.equal(p.cardType, "schedule");
  assert.deepEqual(p.items.map((i) => i.text), [
    "09-10 09:30 牙医复诊",
    "09-11 20:00 给妈妈打电话",
  ]);
});

test("calendar: 空 tasks → null", () => {
  assert.equal(buildToolCard("calendar.list_tasks", { tasks: [] }), null);
  assert.equal(buildToolCard("calendar.list_tasks", {}), null);
});

test("unregistered tool → null", () => {
  assert.equal(buildToolCard("notes.save", { ok: true }), null);
  assert.equal(buildToolCard("", { ok: true }), null);
});

test("shopping.pay.submit: ok → 支付确认按钮卡（actions 非空）", () => {
  const p = buildToolCard("shopping.pay.submit", {
    ok: true,
    summary: "已在内置浏览器打开收银台",
    orderId: "so_123",
    platform: "蜜雪冰城",
    amountCny: 9.9,
    paymentUrl: "https://cashier.alipay.com/x",
    browserMode: "shared",
  });
  assert.ok(p);
  assert.equal(p.cardType, "order");
  assert.equal(p.actions?.length, 2);
  assert.equal(p.actions?.[0]?.id, "shopping_pay_done");
  assert.equal(p.actions?.[0]?.label, "我已完成支付，帮我确认");
  assert.deepEqual(p.actions?.[0]?.payload, { localOrderId: "so_123", platform: "蜜雪冰城" });
  assert.equal(p.actions?.[1]?.label, "稍后再说");
  assert.ok(p.items.some((i) => i.text.includes("¥9.9")));

  // 失败/缺单号 → null（回退文本路由，不打扰用户）
  assert.equal(buildToolCard("shopping.pay.submit", { ok: false, error: "x" }), null);
  assert.equal(buildToolCard("shopping.pay.submit", { ok: true }), null);
});

test("tryAttach: 前导正文 + 卡标记；异常输入 → null", () => {
  const out = tryAttachToolResultCard("查好了。", "wallet.get_balance", {
    balance: 42,
    currency: "CNY",
  });
  assert.ok(out);
  assert.ok(out.startsWith("查好了。"));
  assert.ok(out.includes("[AGENT_RESULT_CARD_START]"));

  assert.equal(tryAttachToolResultCard("x", "notes.save", { ok: true }), null);
  assert.equal(tryAttachToolResultCard("x", "wallet.get_balance", undefined), null);
  assert.equal(tryAttachToolResultCard("x", "wallet.get_balance", "not-object"), null);
  assert.equal(
    tryAttachToolResultCard("x", "weather.get_local", { ok: true }),
    null,
    "builder 建卡失败（字段缺失）→ null 回退",
  );
});

test("tryAttach: 正文已含结构化标记 → null（防双重包裹）", () => {
  const marked = "前导。[AGENT_RESULT_CARD_START]\n{}\n[AGENT_RESULT_CARD_END]";
  assert.equal(
    tryAttachToolResultCard(marked, "wallet.get_balance", { balance: 1 }),
    null,
  );
});

test("attachWeatherFromExecuted: tool-loop 天气回执 → weather 卡", () => {
  const out = attachWeatherResultCardFromExecuted(
    "王哥，明天有毛毛雨，出门带把伞。",
    [
      {
        toolName: "weather.get_local",
        result: {
          ok: true,
          summary: "明天兴义有毛毛雨",
          weatherText: "毛毛雨",
          todayRangeC: "19–25",
          humidityPct: 88,
          peakRainPct: 92,
          todayRainPeriod: "上午 9–12 点最明显",
          clothingAdvice: "出门带把伞，薄外套够了",
          locationLabel: "贵州 · 兴义",
        },
      },
    ],
  );
  assert.ok(out.startsWith("王哥，明天有毛毛雨，出门带把伞。"));
  assert.ok(out.includes("[AGENT_RESULT_CARD_START]"));
  assert.ok(out.includes('"cardType":"weather"'));
  // 整天概率 + 具体钟点段：只写「92%」用户不知道该几点躲雨
  assert.ok(out.includes("今天降水 92%（上午 9–12 点最明显）"), out);
});

test("天气卡：回执没有时段时退回整天口径，不编时间窗", () => {
  const out = attachWeatherResultCardFromExecuted("看过了。", [
    {
      toolName: "weather.get_local",
      result: { weatherText: "多云", todayRangeC: "18–24", peakRainPct: 35 },
    },
  ]);
  assert.ok(out.includes("今天降水 35%"), out);
  assert.ok(!out.includes("今天降水 35%（"), "没测出的时段不能凭空补一个");
});

test("attachWeatherFromExecuted: 多地调用 → 合并为一张多地卡", () => {
  const out = attachWeatherResultCardFromExecuted("两地都看过了。", [
    {
      toolName: "weather.get_local",
      result: { weatherText: "晴", todayRangeC: "20–28", locationLabel: "上海" },
    },
    {
      toolName: "weather.get_local",
      result: {
        weatherText: "小雨",
        todayRangeC: "18–24",
        peakRainPct: 70,
        clothingAdvice: "带伞",
        locationLabel: "杭州",
      },
    },
  ]);
  assert.ok(out.includes("[AGENT_RESULT_CARD_START]"));
  assert.ok(out.includes('"cardType":"weather"'));
  assert.ok(out.includes("上海 晴"));
  assert.ok(out.includes("杭州 小雨"));
  assert.ok(out.includes("带伞"));
});

test("attachWeatherFromExecuted: 无天气回执/正文已带标记 → 原文返回", () => {
  assert.equal(
    attachWeatherResultCardFromExecuted("普通回复。", [
      { toolName: "search_web", result: { items: [] } },
    ]),
    "普通回复。",
  );
  const marked =
    "已带卡。[AGENT_RESULT_CARD_START]\n{}\n[AGENT_RESULT_CARD_END]";
  assert.equal(
    attachWeatherResultCardFromExecuted(marked, [
      {
        toolName: "weather.get_local",
        result: { weatherText: "晴" },
      },
    ]),
    marked,
  );
});
