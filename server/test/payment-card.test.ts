/**
 * 收款卡（payment.create_order）+ 卡内支付确认 回归测试（2026-11-10）。
 *
 * 覆盖两条链路：
 *   1. 工具回执附卡：payment.create_order 的真实回执（金额/订单号/二维码
 *      dataURI）→ ShoppingPayCard 的 extra.shopping stage=pay 载荷（复用手机端
 *      支付卡组件，零客户端改动）；二维码以 dataURI 原样下发（手机卡内直接扫）。
 *   2. card.action → payment.pay.check：queryOrder 实数判定——SUCCESS 翻成
 *      「支付成功」（stage=shipment），未到账保持待支付卡面并如实说没查到。
 *      实数只认真值，绝不由卡面编造「已支付」。
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { WebSocket } from "ws";

import { buildToolCard } from "../src/services/tool-card-registry.js";
import { handleCardActionEvent } from "../src/ws/handlers/card-action.js";
import type { PaymentService } from "../src/services/payment-service.js";

const QR_DATA_URI =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUAAAAFCAYAAACNbyblAAAAHElEKWda";

function makeFakeSocket() {
  const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const socket = {
    send: (raw: string) => {
      sent.push(JSON.parse(raw) as { type: string; payload: Record<string, unknown> });
    },
  } as unknown as WebSocket;
  return { socket, sent };
}

test("payment.create_order 回执 → ShoppingPayCard 载荷（金额/订单号/二维码/确认动作）", () => {
  const card = buildToolCard("payment.create_order", {
    ok: true,
    outTradeNo: "NB20261110001",
    provider: "wechat",
    method: "native",
    amount: 128.5,
    description: "京东自营 纸巾 6 抽 24 包",
    qrCodeDataUrl: QR_DATA_URI,
    instruction: "请使用微信支付扫描二维码完成付款",
  });
  assert.ok(card, "应产出卡");
  assert.equal(card!.cardType, "shopping_pay");
  assert.equal(card!.title, "💳 支付确认");
  const shop = (card!.extra as Record<string, Record<string, unknown>>).shopping;
  assert.equal(shop.stage, "pay");
  assert.equal(shop.amount, "128.5");
  assert.equal(shop.orderNo, "NB20261110001");
  assert.equal(shop.platformLabel, "微信支付");
  assert.equal(shop.qrImage, QR_DATA_URI, "二维码 dataURI 原样下发（手机卡内直接扫）");
  const primary = card!.actions?.find((a) => a.cardAction === "payment.pay.check");
  assert.ok(primary, "应有「我已完成支付」卡内动作");
  assert.deepEqual(primary!.payload, { outTradeNo: "NB20261110001", provider: "wechat" });
});

test("缺订单号的回执不产卡（回退文本路由）", () => {
  const card = buildToolCard("payment.create_order", { ok: true, amount: 10 });
  assert.equal(card, null);
});

test("card.action payment.pay.check：已到账 → 卡面翻成支付成功（stage=shipment）", async () => {
  const fakePayment = {
    queryOrder: async () => ({
      ok: true,
      outTradeNo: "NB20261110001",
      provider: "wechat",
      tradeState: "SUCCESS",
      tradeStateDesc: "支付成功",
      amount: 128.5,
      description: "京东自营 纸巾 6 抽 24 包",
      payTime: "2026-11-10 16:30:00",
    }),
  } as unknown as PaymentService;
  const { socket, sent } = makeFakeSocket();
  const handled = await handleCardActionEvent(
    { socket, boundActorId: "u-pay", sendUnifiedError: () => {} },
    {
      messageId: "m-pay",
      cardId: "c-pay",
      actionId: "payment.pay.check",
      payload: { outTradeNo: "NB20261110001", provider: "wechat" },
    },
    { paymentService: fakePayment },
  );
  assert.equal(handled, true);
  const frame = sent[0];
  assert.ok(frame, "应回 card.update");
  assert.equal(frame.type, "card.update");
  assert.equal(frame.payload.ok, true);
  const card = frame.payload.card as {
    title: string;
    extra: { shopping: Record<string, unknown> };
  };
  assert.equal(card.title, "✅ 支付成功");
  assert.equal(card.extra.shopping.stage, "shipment");
});

test("card.action payment.pay.check：未到账 → 保持待支付卡面 + 如实说没查到", async () => {
  const fakePayment = {
    queryOrder: async () => ({
      ok: true,
      outTradeNo: "NB20261110001",
      provider: "wechat",
      tradeState: "NOTPAY",
      tradeStateDesc: "未支付",
      amount: 128.5,
      description: "京东自营 纸巾 6 抽 24 包",
    }),
  } as unknown as PaymentService;
  const { socket, sent } = makeFakeSocket();
  await handleCardActionEvent(
    { socket, boundActorId: "u-pay", sendUnifiedError: () => {} },
    {
      messageId: "m-pay",
      cardId: "c-pay",
      actionId: "payment.pay.check",
      payload: { outTradeNo: "NB20261110001", provider: "wechat" },
    },
    { paymentService: fakePayment },
  );
  const frame = sent[0];
  assert.ok(frame);
  const card = frame.payload.card as {
    title: string;
    footer: string;
    extra: { shopping: Record<string, unknown> };
  };
  assert.equal(card.title, "💳 待支付");
  assert.equal(card.extra.shopping.stage, "pay");
  assert.ok(card.footer.includes("还没查到到账"), "未到账必须如实说明，不得宣称已支付");
});
