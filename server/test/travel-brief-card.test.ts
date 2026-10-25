import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 简报卡确定性附卡链（travel 主线 F1）。
 *
 * 覆盖的是「真实轮次漏卡」那一类：卡不是模型转发出来的，是 done 阶段按冷层
 * 存档直出的，所以断言点全在链路上——有行程卡才附、只附一张、版式落在行程卡
 * 之后、按钮回传文本能被下一轮规划重新抽成槽位（点了没反应 = 白做）。
 */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "travel-brief-card-test-"));
process.env.TRAVEL_PLAN_STORE_DIR = tmpDir;

const { travelPlanStore } = await import(
  "../src/skills/travel-planning/travel-plan-store.js"
);
const {
  attachTravelBriefCard,
  buildTravelBriefCardBlock,
  containsTravelBriefCard,
} = await import("../src/services/deterministic-card-chain.js");
const { normalizeReplyCardLayout } = await import("../src/services/reply-envelope.js");
const { extractWishlist, extractFoodWishlist } = await import(
  "../src/skills/travel-planning/intent-parser.js"
);

const ITINERARY_CARD =
  "[AGENT_RESULT_CARD_START]\n" +
  JSON.stringify({ title: "成都3日游", cardType: "travel_itinerary", items: [] }) +
  "\n[AGENT_RESULT_CARD_END]";

function plan(overrides: Record<string, unknown> = {}) {
  return {
    planId: "plan-brief-1",
    destination: "成都",
    title: "成都3日游",
    startDate: "2026-11-02",
    endDate: "2026-11-04",
    createdAt: Date.now(),
    days: [
      {
        date: "2026-11-02",
        items: [
          {
            type: "attraction",
            name: "武侯祠",
            startTime: "2026-11-02T09:30:00",
            latitude: 30.6,
            longitude: 104.0,
            address: "武侯区",
            priceInfo: "",
            description: "",
          },
        ],
      },
    ],
    pois: [
      { name: "武侯祠", type: "attraction", latitude: 30.6, longitude: 104.0, rating: 4.7 },
      { name: "宽窄巷子", type: "attraction", latitude: 30.6, longitude: 104.05, rating: 4.6 },
      { name: "陈麻婆豆腐", type: "restaurant", latitude: 30.65, longitude: 104.06, rating: 4.5 },
    ],
    ...overrides,
  } as never;
}

function parseCard(block: string): Record<string, any> {
  const start = block.indexOf("[AGENT_RESULT_CARD_START]") + "[AGENT_RESULT_CARD_START]".length;
  const end = block.indexOf("[AGENT_RESULT_CARD_END]");
  return JSON.parse(block.slice(start, end).trim());
}

// ==================== 附卡条件 ====================

test("没有行程卡就不附简报卡（没版本可摊开）", () => {
  const out = attachTravelBriefCard("今天先聊聊成都好吃", plan() as never);
  assert.equal(out, "今天先聊聊成都好吃");
});

test("有行程卡才附简报卡，且落在正文末尾", () => {
  travelPlanStore.save(plan() as never);
  const out = attachTravelBriefCard("行程排好了。\n\n" + ITINERARY_CARD, {
    planId: "plan-brief-1",
  });
  assert.ok(containsTravelBriefCard(out), "简报卡应已附上");
  assert.ok(out.indexOf(ITINERARY_CARD) < out.lastIndexOf("[AGENT_RESULT_CARD_START]"));
});

test("同一轮只附一张简报卡", () => {
  travelPlanStore.save(plan({ planId: "plan-brief-dup" }) as never);
  const once = attachTravelBriefCard(ITINERARY_CARD, { planId: "plan-brief-dup" });
  const twice = attachTravelBriefCard(once, { planId: "plan-brief-dup" });
  assert.equal(twice.match(/"cardKind":"travel_brief"/g)?.length, 1);
});

test("回执里没有 planId 时，用冷层回捞带来的全量存档建卡", () => {
  const out = attachTravelBriefCard(ITINERARY_CARD, plan({ planId: "plan-brief-inline" }) as never);
  assert.ok(containsTravelBriefCard(out));
});

// ==================== 卡面内容 ====================

test("卡面摊开非亲口说的假设，并如实交代核实冲突与未落位心愿点", () => {
  const block = buildTravelBriefCardBlock(
    plan({
      slots: {
        hotelFocus: "station",
        sources: { destination: "user", hotelFocus: "destination" },
      },
      wishlistMissed: ["建设里小巷子"],
      verification: {
        issues: [
          {
            level: "block",
            kind: "closed_day",
            day: 0,
            stop: 0,
            name: "武侯祠",
            message: "武侯祠周一闭馆，Day1 正好是周一",
          },
        ],
        summary: "1 处硬冲突",
        checkedAt: "2026-10-24",
      },
    }) as never,
  );
  assert.ok(block);
  const card = parseCard(block!);
  const text = card.items.map((i: { text: string }) => i.text).join("\n");
  assert.match(text, /住宿落位：离车站近/);
  assert.match(text, /周一闭馆/);
  assert.match(text, /建设里小巷子/);
  assert.equal(card.cardType, "", "通用渲染路径：cardType 留空");
  assert.equal(card.cardKind, "travel_brief");
});

test("候选按钮取池子里没排上的真地点：景点排进行程、餐厅排进吃饭", () => {
  const block = buildTravelBriefCardBlock(plan() as never);
  assert.ok(block);
  const actions = parseCard(block!).actions as Array<{ id: string; label: string; payload: any }>;
  const wishlist = actions.find((a) => a.id.startsWith("wishlist:"));
  const food = actions.find((a) => a.id.startsWith("foodWishlist:"));
  assert.ok(wishlist && /宽窄巷子/.test(wishlist.label), "高分未排点应成为一键心愿");
  assert.ok(food && /陈麻婆豆腐/.test(food.label), "餐厅候选走吃饭槽位");
});

test("按钮文案下一轮能被同一套槽位抽取认出来（点了要真的改得动）", () => {
  const block = buildTravelBriefCardBlock(plan() as never);
  const actions = parseCard(block!).actions as Array<{ id: string; label: string }>;
  const spot = actions.find((a) => a.id.startsWith("wishlist:"))!;
  const food = actions.find((a) => a.id.startsWith("foodWishlist:"))!;
  // 按钮 label 就是回传的「用户消息」，规划轮从原文抽槽位（intent-parser 兜底路径）
  assert.deepEqual(extractWishlist(spot.label, "成都"), ["宽窄巷子"]);
  assert.deepEqual(extractFoodWishlist(food.label), ["陈麻婆豆腐"]);
});

// ==================== 版式 ====================

test("版式收口：散文在前 → 行程卡 → 简报卡", () => {
  travelPlanStore.save(plan({ planId: "plan-brief-layout" }) as never);
  const raw = attachTravelBriefCard("行程排好了。\n\n" + ITINERARY_CARD, {
    planId: "plan-brief-layout",
  });
  const laid = normalizeReplyCardLayout(raw);
  const travelIdx = laid.indexOf('"cardType":"travel_itinerary"');
  const briefIdx = laid.indexOf('"cardKind":"travel_brief"');
  assert.ok(travelIdx > laid.indexOf("行程排好了"), "散文仍在卡片之前");
  assert.ok(briefIdx > travelIdx, "简报卡跟在行程卡后面");
});
