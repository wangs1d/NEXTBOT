import assert from "node:assert/strict";
import test from "node:test";

import { dedupMediaCards, type MediaCardItem } from "../src/services/tool-result-processor.js";
import { buildRenderEnvelope } from "../src/render/protocol.js";

/**
 * 回归防线（2026-11-19 真机事故）：
 *
 * 「比价卡在京东登录了——二维码已经推到你聊天里」但手机端一张码都看不到。
 * 服务端确实截了码、落了盘、调了 pushMediaCards（云端 data/images 里有那张
 * 118×118 的二维码 PNG），卡片却在 done 定稿时被两处逻辑吞掉：
 *   1. dedupMediaCards 按 thumbnailUrl||mediaUrl 去重，结构化卡这两个字段都是空
 *      → key 为空 → 整张卡被 continue 丢弃；
 *   2. 客户端独立卡渲染只认信封 blocks，而 pushedCards 从未编进 blocks。
 * 这两个断言把「结构化卡不会因为『没有图片地址』而消失」钉死。
 */

const loginCard = {
  type: "card",
  cardType: "shopping_login",
  title: "请登录京东",
  items: [],
  extra: {
    shopping: {
      stage: "login",
      qrItems: [{ platform: "jd", platformLabel: "京东", qrImage: "/agent/images/u/1-a.png" }],
    },
  },
} as unknown as MediaCardItem;

const qrImageCard = {
  type: "image",
  title: "登录二维码",
  thumbnailUrl: "/agent/images/u/2-b.png",
  mediaUrl: "/agent/images/u/2-b.png",
  mediaType: "qr",
} as unknown as MediaCardItem;

test("dedupMediaCards：无图片地址的结构化卡不能被丢弃", () => {
  const out = dedupMediaCards([loginCard, qrImageCard]);
  assert.equal(out.length, 2);
  assert.equal((out[0] as { cardType?: string }).cardType, "shopping_login");
});

test("dedupMediaCards：同标题的重复结构化卡只留一张，不同卡一张不少", () => {
  const sameAgain = { ...loginCard } as MediaCardItem;
  const other = { ...(loginCard as object), title: "请登录淘宝" } as MediaCardItem;
  const out = dedupMediaCards([loginCard, sameAgain, other]);
  assert.equal(out.length, 2);
  assert.deepEqual(
    out.map((c) => c.title),
    ["请登录京东", "请登录淘宝"],
  );
});

test("buildRenderEnvelope：中途推送的结构化卡进 blocks（客户端独立卡渲染的唯一入口）", () => {
  const env = buildRenderEnvelope({
    finalText: "京东要扫码登录，扫完我继续比价。",
    pushedCards: [loginCard as unknown as Record<string, unknown>],
  });
  const cardBlocks = env.blocks.filter((b) => b.type === "card");
  assert.equal(cardBlocks.length, 1);
  assert.equal(
    (cardBlocks[0] as { cardType?: string }).cardType,
    "shopping_login",
  );
  // 卡片没有图片地址，绝不能混进 mediaCards（否则会被当图片项吞掉/画成空占位）
  assert.equal(env.legacy.mediaCards?.length ?? 0, 0);
  assert.equal(env.legacy.cards?.length ?? 0, 1);
});

test("buildRenderEnvelope：结构化卡与正文、图片卡可以共存且互不污染", () => {
  const env = buildRenderEnvelope({
    finalText: "验证页截图和登录卡都给你了。",
    mediaCards: [qrImageCard],
    pushedCards: [loginCard as unknown as Record<string, unknown>],
  });
  const types = env.blocks.map((b) => b.type);
  assert.ok(types.includes("card"));
  assert.ok(types.includes("text"));
  const cards = env.legacy.cards ?? [];
  assert.equal(cards.length, 1);
  const media = env.legacy.mediaCards ?? [];
  assert.equal(media.length, 1);
  assert.equal(media[0]!.mediaType, "qr");
});
