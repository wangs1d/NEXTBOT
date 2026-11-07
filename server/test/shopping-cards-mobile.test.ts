/**
 * 手机端购物卡载荷（2026-11-06 设计稿）：服务端把工具回执确定性翻成
 * 五类卡载荷，客户端只负责画。这里锁住「载荷字段 ↔ 设计屏」的对应关系，
 * 以及两条不能破的底线：
 *   1. 确认卡必须有绝对到期时刻（客户端倒计时不能按渲染时刻起算）；
 *   2. 物流卡只渲染回执真有的信息，平台没给承运商就不出现运单号。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { buildToolCard } from "../src/services/tool-card-registry.js";

type ShoppingExtra = Record<string, unknown>;

function shoppingOf(card: { extra?: Record<string, unknown> } | null): ShoppingExtra {
  assert.ok(card, "应出卡");
  assert.ok(card.extra, "应带 extra");
  return card.extra!.shopping as ShoppingExtra;
}

test("比价回执 → 候选轮播载荷：一屏多卡、标出最合适那款", () => {
  const card = buildToolCard("shopping.compare.prices", {
    ok: true,
    query: "空气净化器",
    bestIndex: 1,
    groups: [
      {
        matchType: "exact",
        specTokens: ["标准版"],
        offers: [
          {
            platform: "jd",
            title: "米家空气净化器 4 Lite",
            priceCny: 699,
            shop: "京东自营",
            imageUrl: "https://img.example.com/a.jpg",
          },
        ],
      },
      {
        matchType: "exact",
        offers: [
          { platform: "jd", title: "米家空气净化器 5", priceCny: 1099, shop: "京东自营" },
        ],
      },
    ],
  });

  assert.equal(card?.cardType, "price_compare", "卡型保持，旧客户端不受影响");
  const shopping = shoppingOf(card);
  assert.equal(shopping.stage, "candidates");
  assert.equal(shopping.bestIndex, 1);
  const items = shopping.items as Array<Record<string, unknown>>;
  assert.equal(items.length, 2);
  assert.equal(items[1].price, 1099);
  assert.equal(items[0].image, "https://img.example.com/a.jpg");
  assert.ok(String(shopping.title).includes("2选一"), "标题带候选数，便于一眼看懂");
});

test("下单阶段一 → 确认卡载荷：摘要 + 绝对到期时刻 + 只提交不扣款的说明", () => {
  const expiresAt = Date.parse("2026-11-06T07:41:00.000Z");
  const card = buildToolCard("shopping.order.place", {
    ok: true,
    needsConfirmation: true,
    confirmationToken: "tok_123",
    platform: "jd",
    itemTitle: "米家空气净化器 5",
    unitPrice: 1099,
    quantity: 1,
    totalPrice: 1099,
    addressSummary: "杭州市西湖区文一西路 969 号",
    expiresInMs: 300000,
    expiresAt,
  });

  assert.equal(card?.cardType, "shopping_confirm");
  const shopping = shoppingOf(card);
  assert.equal(shopping.stage, "confirm");
  assert.equal(shopping.expiresAt, new Date(expiresAt).toISOString());
  assert.equal(shopping.total, "¥1099");
  const rows = shopping.rows as Array<{ k: string; v: string }>;
  assert.ok(rows.some((r) => r.k === "商品" && r.v.includes("米家")));
  assert.ok(rows.some((r) => r.k === "收货" && r.v.includes("西湖区")));
  assert.ok(String(shopping.note).includes("只提交订单"), "必须写明不自动扣款");
});

test("下单阶段二（已提交）不出确认卡，避免重复让用户点头", () => {
  const card = buildToolCard("shopping.order.place", {
    ok: true,
    needsConfirmation: false,
    localOrderId: "so_1",
    orderId: "JD20261106001",
    platform: "jd",
  });
  assert.equal(card, null);
});

test("订单状态 → 物流卡载荷：按状态机推进，缺承运商就不出现运单号", () => {
  const card = buildToolCard("shopping.order.status", {
    ok: true,
    platform: "jd",
    orders: [
      {
        orderId: "JD20261106001",
        status: "shipped",
        itemTitle: "米家空气净化器 5",
        totalPrice: 1099,
        createdAt: "2026-11-06T06:36:00.000Z",
      },
    ],
  });

  assert.equal(card?.cardType, "shopping_shipment");
  const shopping = shoppingOf(card);
  assert.equal(shopping.stage, "shipment");
  assert.equal(shopping.statusLabel, "运输中");
  const nodes = shopping.nodes as Array<{ label: string; state: string; detail?: string }>;
  assert.deepEqual(
    nodes.map((n) => n.label),
    ["已下单", "已支付", "已发货", "已签收"],
  );
  assert.equal(nodes[0].state, "done");
  assert.equal(nodes[2].state, "now", "shipped 时「已发货」是当前节点");
  assert.equal(nodes[3].state, "todo");
  assert.ok(
    nodes.every((n) => !String(n.detail ?? "").includes("SF")),
    "回执没有运单号，不许编造承运商/单号",
  );
});

test("支付回执 → 支付卡载荷：金额与订单号在 extra，按钮留在 actions 给购物卡自绘", () => {
  const card = buildToolCard("shopping.pay.submit", {
    ok: true,
    orderId: "JD20261106001",
    platform: "jd",
    amountCny: 1099,
    itemTitle: "米家空气净化器 5",
  });

  assert.equal(card?.cardType, "shopping_pay");
  const shopping = shoppingOf(card);
  assert.equal(shopping.stage, "pay");
  assert.equal(shopping.amount, "1099");
  assert.equal(shopping.orderNo, "JD20261106001");
  assert.ok(Array.isArray(card?.actions) && card!.actions!.length === 2);
});
