import assert from "node:assert/strict";
import test from "node:test";
import { buildToolCard } from "../src/services/tool-card-registry.js";
import { BookingService } from "../src/services/booking/booking-service.js";
import { SimulatedRideProvider } from "../src/services/booking/providers/simulated-ride-provider.js";
import { handleCardActionEvent } from "../src/ws/handlers/card-action.js";

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
    provider: "simulated",
    providerLabel: "模拟网约车",
    rideRequest: { pickup: "当前位置", dropoff: "国贸" },
    options: [{ id: "r1", provider: "sim", title: "经济型（预估 ¥45）", amountCny: 45, currency: "CNY", simulated: true }],
  });
  assert.ok(card);
  assert.equal(card!.cardType, "ride_quote");
  assert.ok(card!.items[0].text.includes("¥45"));
  assert.ok(card!.items[0].text.includes("模拟报价"));
  // 每档车型带独立的卡内选择动作（起终点/车型原样回传）
  const ride = (card!.extra as Record<string, unknown>).ride as Record<string, unknown>;
  const options = ride.options as Array<Record<string, unknown>>;
  assert.equal(options.length, 1);
  assert.equal(options[0].optionId, "r1");
  assert.equal(options[0].price, "¥45");
  assert.equal(options[0].name, "经济型");
  const action = options[0].action as Record<string, unknown>;
  assert.equal(action.cardAction, "ride.book.prepare");
  const payload = action.payload as Record<string, unknown>;
  assert.equal(payload.optionId, "r1");
  assert.equal(payload.dropoff, "国贸");
  assert.equal(payload.pickup, "当前位置");
  assert.equal(buildToolCard("restaurant.search", { ok: true, options: [] }), null);
});

test("ride_hailing.quote 多档价格各自独立，不共用同一个金额", () => {
  const card = buildToolCard("ride_hailing.quote", {
    ok: true,
    provider: "didi",
    providerLabel: "滴滴出行（官方 MCP）",
    rideRequest: { pickup: "成都东站", dropoff: "太古里" },
    options: [
      { id: "didi:t:3", provider: "didi", title: "经济型（预估 ¥58）", amountCny: 58 },
      { id: "didi:t:5", provider: "didi", title: "舒适型（预估 ¥76）", amountCny: 76 },
      { id: "didi:t:7", provider: "didi", title: "商务型（预估 ¥105）", amountCny: 105 },
    ],
  });
  assert.ok(card);
  const options = ((card!.extra as Record<string, unknown>).ride as Record<string, unknown>)
    .options as Array<Record<string, unknown>>;
  assert.deepEqual(options.map((o) => o.price), ["¥58", "¥76", "¥105"]);
  assert.deepEqual(options.map((o) => o.name), ["经济型", "舒适型", "商务型"]);
});

test("ride_hailing.book 阶段一 → 统一确认卡（ride.book.confirm + 令牌）", () => {
  const card = buildToolCard("ride_hailing.book", {
    ok: true,
    needsConfirmation: true,
    summary: "即将预订「网约车」",
    confirmationToken: "tok_1",
    expiresInMs: 300000,
    provider: "didi",
    providerLabel: "滴滴出行（官方 MCP）",
    optionId: "didi:t:3",
    optionTitle: "经济型（预估 ¥58）",
    amountCny: 58,
    dropoff: "太古里",
    pickup: "成都东站",
    simulated: false,
  });
  assert.ok(card);
  assert.equal(card!.cardType, "shopping_confirm");
  const shopping = (card!.extra as Record<string, unknown>).shopping as Record<string, unknown>;
  assert.equal(shopping.stage, "confirm");
  const rows = shopping.rows as Array<Record<string, string>>;
  assert.ok(rows.some((r) => r.k === "车型" && r.v === "经济型"));
  assert.ok(rows.some((r) => r.k === "上车点" && r.v === "成都东站"));
  assert.equal(shopping.total, "¥58");
  const buttons = shopping.buttons as Array<Record<string, unknown>>;
  assert.equal(buttons[0].cardAction, "ride.book.confirm");
  const actions = shopping.actions as Record<string, unknown>;
  assert.equal(actions.confirmationToken, "tok_1");
  assert.equal(actions.optionId, "didi:t:3");
});

test("ride_hailing.book 阶段二有支付链接 → 统一支付卡；无链接 → 订单回执", () => {
  const paid = buildToolCard("ride_hailing.book", {
    ok: true,
    orderId: "bkg_1",
    provider: "didi",
    amountCny: 42,
    paymentUrl: "https://pay.example.com/1",
    simulated: false,
  });
  assert.ok(paid);
  assert.equal(paid!.cardType, "shopping_pay");
  assert.equal(((paid!.extra as Record<string, unknown>).shopping as Record<string, unknown>).amount, "42");

  const normal = buildToolCard("ride_hailing.book", {
    ok: true,
    orderId: "bkg_2",
    provider: "didi",
    amountCny: 58,
    simulated: false,
    tracking: { driver: "张师傅", plate: "川A·12345", etaMinutes: 4 },
  });
  assert.ok(normal);
  assert.equal(normal!.cardType, "order");
  assert.ok(normal!.items.some((i) => i.text.includes("张师傅")));
});

test("card.action：叫车选择 → 确认 → 下单，全程只换卡不发消息", async () => {
  const service = new BookingService({ providers: [new SimulatedRideProvider()] });
  const sent: Array<Record<string, unknown>> = [];
  const socket = { send: (raw: string) => sent.push(JSON.parse(raw)) } as never;
  const ctx = { socket, boundActorId: "actor-1", sendUnifiedError: () => {} };
  const deps = { bookingService: service };

  await handleCardActionEvent(
    ctx,
    {
      messageId: "m-1",
      cardId: "c-1",
      actionId: "ride.book.prepare",
      payload: { optionId: "eco", dropoff: "国贸", pickup: "当前位置", provider: "simulated" },
    },
    deps,
  );
  const stage1 = (sent[0] as { payload: { card: Record<string, unknown> } }).payload.card;
  assert.equal(stage1.cardType, "shopping_confirm");
  const shopping = (stage1.extra as Record<string, unknown>).shopping as Record<string, unknown>;
  const actions = shopping.actions as Record<string, unknown>;
  assert.equal(actions.optionId, "eco");
  assert.ok(typeof actions.confirmationToken === "string");

  sent.length = 0;
  await handleCardActionEvent(
    ctx,
    {
      messageId: "m-1",
      cardId: "c-1",
      actionId: "ride.book.confirm",
      payload: {
        optionId: "eco",
        dropoff: "国贸",
        provider: "simulated",
        confirmationToken: actions.confirmationToken,
      },
    },
    deps,
  );
  const stage2 = (sent[0] as { payload: { card: Record<string, unknown> } }).payload.card;
  assert.equal(stage2.cardType, "order");
  assert.ok((stage2.items as Array<{ text: string }>).some((i) => i.text.startsWith("订单：")));

  service.dispose();
});
