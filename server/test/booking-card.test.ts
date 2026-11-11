import assert from "node:assert/strict";
import test from "node:test";
import { buildToolCard } from "../src/services/tool-card-registry.js";

test("travel_booking.search 回执 → 通用报价卡（价格/来源/估算标注）", () => {
  const card = buildToolCard("travel_booking.search", {
    ok: true,
    provider: "flyai",
    providerLabel: "飞猪",
    options: [
      { id: "o1", provider: "flyai", title: "MU5107 经济舱", amountCny: 980, currency: "CNY", extra: { priceSource: "api" } },
      { id: "o2", provider: "flyai", title: "HU7802 经济舱", amountCny: 860, currency: "CNY", extra: { priceSource: "estimated" } },
    ],
    note: "以上为北京→上海 11-11 航班",
  });
  assert.ok(card);
  assert.equal(card!.cardType, "");
  assert.equal(card!.items.length, 2);
  assert.ok(card!.items[0].text.includes("¥980"));
  assert.ok(card!.items[0].text.includes("实时接口"));
  assert.ok(card!.items[1].text.includes("估算"));
  assert.ok(card!.footer.includes("以平台实价为准"));
});

test("模拟报价必须带标记；空选项不产卡", () => {
  const card = buildToolCard("ride_hailing.quote", {
    ok: true,
    providerLabel: "模拟网约车",
    options: [{ id: "r1", provider: "sim", title: "经济型", amountCny: 45, currency: "CNY", simulated: true }],
  });
  assert.ok(card);
  assert.ok(card!.items[0].text.includes("模拟报价"));
  assert.equal(buildToolCard("restaurant.search", { ok: true, options: [] }), null);
});
