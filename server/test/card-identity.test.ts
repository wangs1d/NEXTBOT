/**
 * 卡片身份模块验收（2026-11-12 双卡事故根修）。
 *
 * 锁定三件事：
 *   1. stableCardId：同载荷恒同 id（跨渲染/跨阶段/跨进程稳定）；
 *   2. 不同载荷 → 不同 id（同轮多卡能力的内容寻址保障）；
 *   3. VOLATILE_CARD_ID_RE：时间戳随机 id（历史格式）必判易变，
 *      内容寻址 id 必判稳定 —— 去重层据此决定是否参与身份。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { stableCardId, VOLATILE_CARD_ID_RE } from "../src/services/card-identity.js";
import { buildCardMarker, type ToolCardPayload } from "../src/services/tool-card-registry.js";
import { collectCardPayloads } from "../src/render/cards.js";

test("stableCardId：同载荷恒同 id（跨调用/跨阶段稳定）", () => {
  const payload = { cardType: "reminder_confirm", title: "已定好提醒", items: [{ type: "text", text: "明早 07:00 · 叫阿哲起床" }] };
  assert.equal(stableCardId(payload), stableCardId(payload));
  assert.equal(stableCardId(payload), stableCardId(JSON.parse(JSON.stringify(payload))), "序列化往返后仍同 id");
  assert.match(stableCardId(payload), /^card_[0-9a-f]{12}$/, "格式：card_<sha1 前 12 位>");
});

test("stableCardId：不同载荷 → 不同 id（多卡能力保障）", () => {
  const a = { cardType: "poi_pick", title: "A 景点", items: [{ type: "text", text: "A" }] };
  const b = { cardType: "poi_pick", title: "B 景点", items: [{ type: "text", text: "B" }] };
  assert.notEqual(stableCardId(a), stableCardId(b));
});

test("VOLATILE_CARD_ID_RE：时间戳随机 id 判易变，内容寻址 id 判稳定", () => {
  assert.match("card_1794417674821_btq342", VOLATILE_CARD_ID_RE, "旧时间戳格式必判易变");
  assert.doesNotMatch(stableCardId({ a: 1 }), VOLATILE_CARD_ID_RE, "内容寻址 id 必判稳定");
  assert.doesNotMatch("order-123", VOLATILE_CARD_ID_RE, "业务方自带 id 不误判");
});

test("buildCardMarker：同 payload 两次构建标记字节一致（附卡幂等的物理基础）", () => {
  const payload: ToolCardPayload = {
    title: "已定好提醒",
    items: [{ type: "text", text: "明早 07:00 · 叫阿哲起床" }],
    footer: "",
    cardType: "reminder_confirm",
    extra: { reminder: { status: "created", taskIds: ["task-1"] } },
  };
  const m1 = buildCardMarker(payload, "好嘞。");
  const m2 = buildCardMarker(payload, "好嘞。");
  assert.equal(m1, m2, "同一张卡两次构建 → 字节一致（cardId 稳定）");
  const [card1] = collectCardPayloads(m1);
  const [card2] = collectCardPayloads(m2);
  assert.equal(card1.cardId, card2.cardId);
  assert.notEqual(card1.cardId, undefined);
});
