/**
 * 验证 2026-11-12 双卡修复：
 * 1) 提醒卡 full→cards-only 两阶段只出一张；
 * 2) 信封 blocks 只有一个 card 块；
 * 3) 带真实业务 id 的同型多卡仍各自保留（多卡能力不回退）。
 */
import { renderTurn } from "../server/src/render/turn.js";
import { buildReplyBlocks } from "../server/src/services/reply-envelope.js";
import { buildRenderEnvelope } from "../server/src/render/protocol.js";
import { effectStatusOf } from "../server/src/render/index.js";

const receipt = {
  ok: true, action: "create", taskId: "task-1",
  nextRunAt: "2026-11-13T01:00:00.000Z", timezone: "Asia/Shanghai",
  title: "开会", reminderMessage: "开会", whenSpoken: "明天", recurrence: "none",
};
const effects = [{ tool: "calendar", status: effectStatusOf(receipt), result: receipt }];

const full = renderTurn({ text: "好，明天 9 点提醒你开会", effects }, "full");
const nFull = (full.text.match(/\[AGENT_RESULT_CARD_START\]/g) || []).length;
const done = renderTurn({ text: full.text, effects }, "cards-only");
const nDone = (done.text.match(/\[AGENT_RESULT_CARD_START\]/g) || []).length;
const env = buildRenderEnvelope({ finalText: done.text, legacyBlocks: buildReplyBlocks(done.text) });
const nEnv = env.blocks.filter((b) => b.type === "card").length;
console.log(`提醒卡: full=${nFull} cards-only=${nDone} envelope=${nEnv}`);
if (nFull !== 1 || nDone !== 1 || nEnv !== 1) {
  console.error("FAIL: 提醒卡仍重复");
  process.exit(1);
}

// 多卡能力：同 cardType、不同 poiId 的两张卡都应保留
import { applyCards } from "../server/src/render/cards.js";
const twoCards = {
  cards: [
    { kind: "card", topic: "poi_pick", payload: { cardType: "poi_pick", items: [{ type: "text", text: "A 景点" }], extra: { poiId: "poi-a" } } },
    { kind: "card", topic: "poi_pick", payload: { cardType: "poi_pick", items: [{ type: "text", text: "B 景点" }], extra: { poiId: "poi-b" } } },
  ],
};
const multi = applyCards("正文", twoCards);
const nMulti = (multi.text.match(/\[AGENT_RESULT_CARD_START\]/g) || []).length;
console.log(`多卡能力: 不同 poiId 同型卡保留 ${nMulti} 张`);
if (nMulti !== 2) {
  console.error("FAIL: 多卡能力回退");
  process.exit(1);
}
console.log("ALL PASS");
