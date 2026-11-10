/**
 * 需求确认卡（travel_requirement）渲染决策测试。
 *
 * 背景：追问能力的载体是「工具回执声明 needInput → 渲染层出可点选卡」，
 * 代码不做任何"用户这句话是不是开放意图"的语义判定。这里验证的正是
 * 这条声明→卡的直通链路，以及同轮多卡不再被 cardType 一刀切去重。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { decideToolCards } from "../src/render/scenes/tool-cards.scene.js";
import type { TurnEffect } from "../src/render/types.js";

const NEED_DAYS_RESULT: Record<string, unknown> = {
  ok: false,
  needInput: [
    {
      key: "days",
      title: "打算玩几天？",
      hint: "天数决定每天排几个站、住几晚、预算按几晚算",
      options: [
        { value: "2", label: "2 天" },
        { value: "3", label: "3 天" },
      ],
    },
  ],
  error: "缺少行程天数：先向用户确认玩几天（或几号到几号），拿到天数后再调用本工具。",
};

test("工具声明 needInput → 出需求确认卡，卡身份按缺口集合生成", () => {
  const effects: TurnEffect[] = [
    { tool: "travel.plan-itinerary", status: "failed", result: NEED_DAYS_RESULT },
  ];
  const cards = decideToolCards(effects, 0);
  const req = cards.find((c) => c.topic === "travel_requirement");
  assert.ok(req, "声明了 needInput 就必须出需求确认卡");
  const payload = req.payload as Record<string, unknown>;
  assert.equal(payload.cardType, "travel_requirement");
  assert.equal(payload.cardId, "req_days", "卡身份 = req_ + 缺口 key 集合");
  const items = payload.items as Array<Record<string, unknown>>;
  assert.ok(items.length > 0, "items 非空（通用兜底卡渲染的前置条件）");
  assert.equal(items[0].side, "days");
  const questions = (payload.extra as Record<string, unknown>).questions;
  assert.ok(Array.isArray(questions) && questions.length === 1);
});

test("没有 needInput 声明就不出需求确认卡（不臆造追问）", () => {
  const effects: TurnEffect[] = [
    {
      tool: "travel.plan-itinerary",
      status: "failed",
      result: { ok: false, error: "目的地「XX」的实时数据暂不可用" },
    },
  ];
  const cards = decideToolCards(effects, 0);
  assert.equal(
    cards.find((c) => c.topic === "travel_requirement"),
    undefined,
    "纯失败回执不产追问卡",
  );
});

test("needInput 卡在多卡序列中只出现一次（同一轮多次声明不重复）", () => {
  const effects: TurnEffect[] = [
    { tool: "travel.plan-itinerary", status: "failed", result: NEED_DAYS_RESULT },
    { tool: "travel.plan-itinerary", status: "failed", result: NEED_DAYS_RESULT },
  ];
  const cards = decideToolCards(effects, 0);
  const reqCards = cards.filter((c) => c.topic === "travel_requirement");
  assert.equal(reqCards.length, 1, "find 只取首个声明，不重复出卡");
});
